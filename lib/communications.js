import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, stat } from 'node:fs/promises'
import path from 'node:path'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ZERO = '0'.repeat(64)
export const PROTOCOL = 'headbot-team/v1'
export const LIMITS = Object.freeze({ textBytes: 65536, attachmentBytes: 10 * 1024 * 1024, transferBytes: 20 * 1024 * 1024, attachments: 8 })

// The journal is the delivery queue: an item cannot be received before its audit
// event has been durably appended. No unaudited inbox or peer route exists.
// Startup and send keep a verified tip plus a compact message.sent index. Event
// bodies stay in the journal and are read by offset, so the resident set does not
// track the full audit log. A hash-chain scan runs when the journal file identity
// changes, and again when audit or export reads the log.
export class AuditedCommunications {
  constructor(root, manager, limits = {}) {
    this.root = path.join(root, 'communications')
    this.objects = path.join(this.root, 'objects')
    this.journal = path.join(this.root, 'audit.jsonl')
    this.checkpoint = path.join(this.root, 'checkpoint.json')
    this.manager = manager
    this.limits = { ...LIMITS, ...limits }
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > LIMITS[key]) throw new Error(`communication limit ${key} must be from 1 to ${LIMITS[key]}`)
    }
    this.bodyLimit = Math.ceil(this.limits.transferBytes * 4 / 3) + this.limits.textBytes + 65536
    this.queue = Promise.resolve()
    this.tip = { seq: 0, hash: ZERO }
    this.verified = null
    this.opened = false
    this.messageIndex = []
    this.messageByRequest = new Map()
  }

  lock(operation) {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => {})
    return result
  }

  transaction(actor, operation) {
    return this.lock(() => actor ? this.manager.withMutation(async () => {
      const current = await this.manager.getTeam(actor.id)
      if (current.instanceId !== actor.instanceId) throw failure(401, 'team identity has been revoked')
      return operation()
    }) : operation())
  }

  async prepareDirectories() {
    await mkdir(this.objects, { recursive: true, mode: 0o700 })
    await chmod(this.root, 0o700)
    await chmod(this.objects, 0o700)
  }

  // Verify the hash chain when the on-disk journal is new or no longer matches
  // the file identity observed after the last successful scan or append.
  async ensureVerified() {
    await this.prepareDirectories()
    const current = await journalIdentity(this.journal)
    if (this.opened && sameIdentity(this.verified, current)) return
    await this.readVerifiedJournal()
  }

  async readVerifiedJournal(onEvent) {
    await this.prepareDirectories()
    const known = this.tip
    const checkpoint = await readCheckpoint(this.checkpoint)
    let seq = 0
    let previous = ZERO
    let tip = { seq: 0, hash: ZERO }
    let checkpointHash
    let knownHash
    const index = []
    const byRequest = new Map()
    const scanned = await scanJournal(this.journal, async (lineBuf, offset, length) => {
      let event
      try { event = JSON.parse(lineBuf.toString('utf8')) } catch { throw failure(503, 'audit journal contains invalid JSON') }
      const { hash, ...unsigned } = event
      seq += 1
      if (event.seq !== seq || event.previousHash !== previous || hash !== digest(unsigned)) {
        throw failure(503, 'audit integrity check failed; transfers are blocked')
      }
      if (event.seq === checkpoint.seq) checkpointHash = hash
      if (known.seq > 0 && event.seq === known.seq) knownHash = hash
      previous = hash
      tip = { seq: event.seq, hash }
      if (event.type === 'message.sent') {
        const entry = {
          seq: event.seq,
          offset,
          length,
          requestId: event.requestId,
          fromInstanceId: event.from?.instanceId,
          toInstanceId: event.to?.instanceId,
          messageId: event.messageId,
          fingerprint: event.fingerprint,
        }
        index.push(entry)
        const key = requestKey(entry.fromInstanceId, entry.requestId)
        if (!byRequest.has(key)) byRequest.set(key, entry)
      }
      if (onEvent) await onEvent(event)
    })
    if (!Number.isSafeInteger(checkpoint.seq) || checkpoint.seq < 0 || checkpoint.hash !== (checkpoint.seq === 0 ? ZERO : checkpointHash)) {
      throw failure(503, 'audit checkpoint does not match the journal; transfers are blocked')
    }
    if (known.seq > 0 && knownHash !== known.hash) throw failure(503, 'audit journal was replaced or truncated')
    const identity = await journalIdentity(this.journal)
    const stable = scanned.missing
      ? identity.missing
      : !identity.missing && identity.size === scanned.size && identity.mtimeNs === scanned.mtimeNs && identity.ino === scanned.ino && identity.dev === scanned.dev
    if (!stable) throw failure(503, 'audit journal was replaced or truncated')
    this.tip = tip
    this.messageIndex = index
    this.messageByRequest = byRequest
    this.verified = identity
    this.opened = true
    return tip
  }

  async readIndexedEvent(entry) {
    const handle = await open(this.journal, 'r')
    try {
      const buf = Buffer.alloc(entry.length)
      const { bytesRead } = await handle.read(buf, 0, entry.length, entry.offset)
      if (bytesRead !== entry.length) throw failure(503, 'audit journal is incomplete; preserve and repair it before transferring data')
      const text = buf.toString('utf8')
      if (!text.endsWith('\n')) throw failure(503, 'audit journal is incomplete; preserve and repair it before transferring data')
      let event
      try { event = JSON.parse(text.slice(0, -1)) } catch { throw failure(503, 'audit journal contains invalid JSON') }
      const { hash, ...unsigned } = event
      if (event.seq !== entry.seq || hash !== digest(unsigned)) throw failure(503, 'audit integrity check failed; transfers are blocked')
      return event
    } finally { await handle.close() }
  }

  async append(type, data) {
    const unsigned = { protocol: PROTOCOL, seq: this.tip.seq + 1, id: randomUUID(), timestamp: new Date().toISOString(), type, ...data, previousHash: this.tip.hash }
    const event = { ...unsigned, hash: digest(unsigned) }
    const line = JSON.stringify(event) + '\n'
    let offset = 0
    try { offset = (await stat(this.journal)).size } catch (error) { if (error.code !== 'ENOENT') throw error }
    const file = await open(this.journal, 'a', 0o600)
    try {
      await file.chmod(0o600)
      await file.writeFile(line)
      await file.sync()
    } finally { await file.close() }
    this.tip = { seq: event.seq, hash: event.hash }
    if (type === 'message.sent') {
      const entry = {
        seq: event.seq,
        offset,
        length: Buffer.byteLength(line),
        requestId: event.requestId,
        fromInstanceId: event.from?.instanceId,
        toInstanceId: event.to?.instanceId,
        messageId: event.messageId,
        fingerprint: event.fingerprint,
      }
      this.messageIndex.push(entry)
      const key = requestKey(entry.fromInstanceId, entry.requestId)
      if (!this.messageByRequest.has(key)) this.messageByRequest.set(key, entry)
    }
    this.verified = await journalIdentity(this.journal)
    this.opened = true
    const temporary = `${this.checkpoint}.${process.pid}.tmp`
    const checkpoint = await open(temporary, 'w', 0o600)
    try {
      await checkpoint.chmod(0o600)
      await checkpoint.writeFile(JSON.stringify({ seq: event.seq, hash: event.hash }) + '\n')
      await checkpoint.sync()
    } finally { await checkpoint.close() }
    await rename(temporary, this.checkpoint)
    await syncDirectory(this.root)
    return event
  }

  async directory(actor) {
    return this.transaction(actor, async () => ({ protocol: PROTOCOL, self: actor.id, limits: this.limits, teams: await this.manager.listCommunicationPeers(actor.instanceId) }))
  }

  async send(actor, input) {
    return this.transaction(actor, async () => {
      await this.ensureVerified()
      object(input)
      const target = await this.manager.getTeam(input.to)
      const recipient = { id: target.id, name: target.name, instanceId: target.instanceId }
      if (recipient.instanceId === actor.instanceId) throw failure(400, 'choose a different recipient team')
      const subject = text(input.subject ?? '', 512, 'subject')
      const body = text(input.text ?? '', this.limits.textBytes, 'text')
      const requestId = input.requestId ?? randomUUID()
      if (typeof requestId !== 'string' || !UUID.test(requestId)) throw failure(400, 'requestId must be a UUID')
      const files = input.attachments ?? []
      if (!Array.isArray(files) || files.length > this.limits.attachments) throw failure(400, `at most ${this.limits.attachments} attachments are allowed`)
      let total = 0
      const decoded = files.map(file => {
        object(file)
        const name = text(file.name, 240, 'attachment name')
        if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f\x7f]/.test(name)) throw failure(400, 'attachment name must be a plain filename')
        const mediaType = text(file.mediaType ?? 'application/octet-stream', 128, 'mediaType')
        if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mediaType)) throw failure(400, 'invalid mediaType')
        if (typeof file.contentBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64)) throw failure(400, 'attachment content must be standard base64')
        const bytes = Buffer.from(file.contentBase64, 'base64')
        total += bytes.length
        if (bytes.length > this.limits.attachmentBytes || total > this.limits.transferBytes) throw failure(413, 'attachment size limit exceeded')
        return { bytes, metadata: { id: randomUUID(), name, mediaType, size: bytes.length, sha256: digestBytes(bytes) } }
      })
      if (!body.trim() && !decoded.length) throw failure(400, 'a message needs text or an attachment')
      const fingerprint = digest({ to: recipient.instanceId, subject, text: body, attachments: decoded.map(file => { const { id, ...metadata } = file.metadata; return metadata }) })
      const existingEntry = this.messageByRequest.get(requestKey(actor.instanceId, requestId))
      if (existingEntry) {
        const existing = await this.readIndexedEvent(existingEntry)
        if (existing.fingerprint !== fingerprint) throw failure(409, 'requestId was already used for different content')
        return { protocol: PROTOCOL, message: existing, duplicate: true }
      }
      for (const file of decoded) {
        const destination = await open(path.join(this.objects, file.metadata.id), 'wx', 0o600)
        try { await destination.writeFile(file.bytes); await destination.sync() } finally { await destination.close() }
      }
      if (decoded.length) await syncDirectory(this.objects)
      // Retain objects if appending fails: a complete journal entry may already
      // be durable even if checkpoint persistence reported an error.
      const message = await this.append('message.sent', { messageId: randomUUID(), requestId, fingerprint, from: actor, to: recipient, subject, text: body, attachments: decoded.map(file => file.metadata) })
      return { protocol: PROTOCOL, message, duplicate: false }
    })
  }

  async inbox(actor, after = 0, limit = 20) {
    return this.transaction(actor, async () => {
      after = integer(after, 0, Number.MAX_SAFE_INTEGER, 'after')
      limit = integer(limit, 1, 100, 'limit')
      await this.ensureVerified()
      const messages = []
      for (const entry of this.messageIndex) {
        if (entry.toInstanceId !== actor.instanceId || entry.seq <= after) continue
        messages.push(await this.readIndexedEvent(entry))
        if (messages.length === limit) break
      }
      if (messages.length) await this.append('messages.received', { actor, messageIds: messages.map(message => message.messageId), fromCursor: after })
      return { protocol: PROTOCOL, messages, nextCursor: messages.at(-1)?.seq ?? after }
    })
  }

  async attachment(actor, messageId, attachmentId, reviewer = false) {
    return this.transaction(reviewer ? undefined : actor, async () => {
      await this.ensureVerified()
      const entry = this.messageIndex.find(item => item.messageId === messageId)
      const message = entry ? await this.readIndexedEvent(entry) : undefined
      if (!message || (!reviewer && message.to.instanceId !== actor.instanceId)) throw failure(404, 'attachment not found')
      const attachment = message.attachments.find(item => item.id === attachmentId)
      if (!attachment) throw failure(404, 'attachment not found')
      const bytes = await readFile(path.join(this.objects, attachment.id))
      if (bytes.length !== attachment.size || digestBytes(bytes) !== attachment.sha256) throw failure(503, 'archived attachment integrity check failed')
      await this.append(reviewer ? 'attachment.reviewed' : 'attachment.received', { actor, messageId, attachment })
      return { attachment, bytes }
    })
  }

  async audit({ team = '', before = Number.MAX_SAFE_INTEGER, limit = 50 } = {}) {
    return this.lock(async () => {
      before = integer(before, 1, Number.MAX_SAFE_INTEGER, 'before')
      limit = integer(limit, 1, 100, 'limit')
      const matched = []
      await this.readVerifiedJournal(event => {
        if (event.seq >= before) return
        if (team && ![event.from?.id, event.to?.id, event.actor?.id].includes(team)) return
        matched.push(event)
        if (matched.length > limit) matched.shift()
      })
      const events = matched.reverse()
      return { protocol: PROTOCOL, integrity: 'verified', events, nextBefore: events.at(-1)?.seq ?? null }
    })
  }

  async exportAudit() {
    return this.lock(async () => {
      const events = []
      const tip = await this.readVerifiedJournal(event => { events.push(event) })
      return { protocol: PROTOCOL, integrity: 'verified', checkpoint: { seq: tip.seq, hash: tip.hash }, events }
    })
  }
}

async function scanJournal(journalPath, onLine) {
  let handle
  try {
    handle = await open(journalPath, 'r')
  } catch (error) {
    if (error.code === 'ENOENT') return { size: 0, dev: undefined, ino: undefined, mtimeNs: undefined, missing: true }
    throw error
  }
  try {
    const info = await handle.stat({ bigint: true })
    const size = Number(info.size)
    if (size === 0) return { size: 0, dev: info.dev, ino: info.ino, mtimeNs: info.mtimeNs, missing: false }
    const last = Buffer.alloc(1)
    const lastRead = await handle.read(last, 0, 1, size - 1)
    if (lastRead.bytesRead !== 1 || last[0] !== 0x0a) throw failure(503, 'audit journal is incomplete; preserve and repair it before transferring data')
    const chunkSize = 64 * 1024
    let position = 0
    let pending = Buffer.alloc(0)
    let lineStart = 0
    while (position < size) {
      const toRead = Math.min(chunkSize, size - position)
      const buf = Buffer.alloc(toRead)
      const { bytesRead } = await handle.read(buf, 0, toRead, position)
      if (bytesRead !== toRead) throw failure(503, 'audit journal is incomplete; preserve and repair it before transferring data')
      position += bytesRead
      const data = pending.length ? Buffer.concat([pending, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead)
      let start = 0
      for (let index = 0; index < data.length; index++) {
        if (data[index] !== 0x0a) continue
        const lineBuf = data.subarray(start, index)
        const offset = lineStart
        const length = (index - start) + 1
        lineStart += length
        if (lineBuf.length) await onLine(lineBuf, offset, length)
        start = index + 1
      }
      pending = Buffer.from(data.subarray(start))
    }
    if (pending.length || lineStart !== size) throw failure(503, 'audit journal is incomplete; preserve and repair it before transferring data')
    return { size, dev: info.dev, ino: info.ino, mtimeNs: info.mtimeNs, missing: false }
  } finally { await handle.close() }
}

async function journalIdentity(journal) {
  try {
    const info = await stat(journal, { bigint: true })
    return { missing: false, dev: info.dev, ino: info.ino, size: Number(info.size), mtimeNs: info.mtimeNs }
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true }
    throw error
  }
}

function sameIdentity(left, right) {
  if (!left || !right) return false
  if (left.missing || right.missing) return Boolean(left.missing && right.missing)
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs
}

async function readCheckpoint(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return { seq: 0, hash: ZERO }
    throw error
  }
}

function requestKey(instanceId, requestId) {
  return `${instanceId}\0${requestId}`
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
async function syncDirectory(directory) {
  const handle = await open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
function digest(value) { return digestBytes(Buffer.from(JSON.stringify(canonical(value)))) }
function digestBytes(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function text(value, maxBytes, label) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maxBytes) throw failure(400, `${label} must be text of at most ${maxBytes} bytes`)
  return value
}
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(400, 'expected a JSON object') }
function integer(value, min, max, label) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(number) || number < min || number > max) throw failure(400, `invalid ${label}`)
  return number
}
export function failure(statusCode, message) { return Object.assign(new Error(message), { statusCode }) }
