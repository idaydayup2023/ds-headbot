import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename } from 'node:fs/promises'
import path from 'node:path'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ZERO = '0'.repeat(64)
export const PROTOCOL = 'headbot-team/v1'
export const LIMITS = Object.freeze({ textBytes: 65536, attachmentBytes: 10 * 1024 * 1024, transferBytes: 20 * 1024 * 1024, attachments: 8 })

// The journal is the delivery queue: an item cannot be received before its audit
// event has been durably appended. No unaudited inbox or peer route exists.
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
    this.events = []
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

  async load() {
    await mkdir(this.objects, { recursive: true, mode: 0o700 })
    await chmod(this.root, 0o700)
    await chmod(this.objects, 0o700)
    const raw = await readFile(this.journal, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    if (raw && !raw.endsWith('\n')) throw failure(503, 'audit journal is incomplete; preserve and repair it before transferring data')
    const events = []
    let previous = ZERO
    for (const line of raw.split('\n').filter(Boolean)) {
      let event
      try { event = JSON.parse(line) } catch { throw failure(503, 'audit journal contains invalid JSON') }
      const { hash, ...unsigned } = event
      if (event.seq !== events.length + 1 || event.previousHash !== previous || hash !== digest(unsigned)) {
        throw failure(503, 'audit integrity check failed; transfers are blocked')
      }
      events.push(event)
      previous = hash
    }
    const checkpoint = await readFile(this.checkpoint, 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return { seq: 0, hash: ZERO }
      throw error
    })
    if (!Number.isSafeInteger(checkpoint.seq) || checkpoint.seq < 0 || checkpoint.hash !== (checkpoint.seq === 0 ? ZERO : events[checkpoint.seq - 1]?.hash)) {
      throw failure(503, 'audit checkpoint does not match the journal; transfers are blocked')
    }
    // Also reject rollback during the lifetime of this controller.
    const known = this.events.at(-1)
    if (known && events[known.seq - 1]?.hash !== known.hash) throw failure(503, 'audit journal was replaced or truncated')
    this.events = events
    return events
  }

  async append(type, data) {
    const previous = this.events.at(-1)
    const unsigned = { protocol: PROTOCOL, seq: (previous?.seq ?? 0) + 1, id: randomUUID(), timestamp: new Date().toISOString(), type, ...data, previousHash: previous?.hash ?? ZERO }
    const event = { ...unsigned, hash: digest(unsigned) }
    const file = await open(this.journal, 'a', 0o600)
    try {
      await file.chmod(0o600)
      await file.writeFile(JSON.stringify(event) + '\n')
      await file.sync()
    } finally { await file.close() }
    this.events.push(event)
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
    return this.transaction(actor, async () => ({ protocol: PROTOCOL, self: actor.id, limits: this.limits, teams: (await this.manager.listTeams()).filter(team => team.instanceId !== actor.instanceId).map(({ id, name, status }) => ({ id, name, status })) }))
  }

  async send(actor, input) {
    return this.transaction(actor, async () => {
      await this.load()
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
      const existing = this.events.find(event => event.type === 'message.sent' && event.from.instanceId === actor.instanceId && event.requestId === requestId)
      if (existing) {
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
      const messages = (await this.load()).filter(event => event.type === 'message.sent' && event.to.instanceId === actor.instanceId && event.seq > after).slice(0, limit)
      if (messages.length) await this.append('messages.received', { actor, messageIds: messages.map(message => message.messageId), fromCursor: after })
      return { protocol: PROTOCOL, messages, nextCursor: messages.at(-1)?.seq ?? after }
    })
  }

  async attachment(actor, messageId, attachmentId, reviewer = false) {
    return this.transaction(reviewer ? undefined : actor, async () => {
      await this.load()
      const message = this.events.find(event => event.type === 'message.sent' && event.messageId === messageId)
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
      const all = await this.load()
      const events = all.filter(event => event.seq < before && (!team || [event.from?.id, event.to?.id, event.actor?.id].includes(team))).slice(-limit).reverse()
      return { protocol: PROTOCOL, integrity: 'verified', events, nextBefore: events.at(-1)?.seq ?? null }
    })
  }

  async exportAudit() {
    return this.lock(async () => {
      const events = await this.load()
      return { protocol: PROTOCOL, integrity: 'verified', checkpoint: { seq: events.at(-1)?.seq ?? 0, hash: events.at(-1)?.hash ?? ZERO }, events }
    })
  }
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
