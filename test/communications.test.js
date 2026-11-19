import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { AuditedCommunications } from '../lib/communications.js'
import { add, fixture, online } from './helpers.js'

test('delivered messages, binary attachments, safe retries and replay survive controller restart', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta'); await add(manager, 'gamma')
  online(manager, 'beta')
  const a = manager.identity(manager.findTeam('alpha')), b = manager.identity(manager.findTeam('beta')), c = manager.identity(manager.findTeam('gamma'))
  const broker = new AuditedCommunications(manager.root, manager)
  const bytes = Buffer.from([0, 255, 10, 89])
  const input = { to: 'beta', from: { id: 'spoofed' }, requestId: randomUUID(), subject: '资料', text: '离线团队也能接收', attachments: [{ name: '资料.bin', contentBase64: bytes.toString('base64') }] }
  const sent = await broker.send(a, input)
  assert.equal(sent.message.from.id, 'alpha')
  assert.equal((await broker.send(a, input)).duplicate, true)
  await assert.rejects(broker.send(a, { ...input, text: 'different' }), { statusCode: 409 })
  const reloaded = new AuditedCommunications(manager.root, manager)
  const inbox = await reloaded.inbox(b)
  assert.equal(inbox.messages.length, 1)
  assert.equal(inbox.messages[0].text, input.text)
  assert.deepEqual((await reloaded.inbox(b, inbox.nextCursor)).messages, [])
  const file = sent.message.attachments[0]
  assert.deepEqual((await reloaded.attachment(b, sent.message.messageId, file.id)).bytes, bytes)
  // ATTACH-404-001 锁定案①: a third party on a durable attachment is a permission answer (403),
  // never a "not found" answer — the object is present and indexed.
  await assert.rejects(reloaded.attachment(c, sent.message.messageId, file.id), { statusCode: 403, message: /not the recipient/ })
  const audit = await reloaded.exportAudit()
  assert.deepEqual(audit.events.map(event => event.type), ['message.sent', 'messages.received', 'attachment.received'])
  assert.equal(audit.events[0].attachments[0].sha256, file.sha256)
  assert.equal(audit.integrity, 'verified')
  await manager.deleteTeam('beta'); await add(manager, 'beta')
  await assert.rejects(reloaded.inbox(b), { statusCode: 401 })
  assert.deepEqual((await reloaded.inbox(manager.identity(manager.findTeam('beta')))).messages, [])
  assert.equal((await reloaded.audit({ team: 'beta' })).events.length, 3)
})

test('audit failures block send, receive and file delivery; tampering is detected', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta')
  online(manager, 'beta')
  const a = manager.identity(manager.findTeam('alpha')), b = manager.identity(manager.findTeam('beta'))
  const broker = new AuditedCommunications(manager.root, manager)
  const append = broker.append
  broker.append = async () => { throw new Error('simulated disk failure') }
  await assert.rejects(broker.send(a, { to: 'beta', text: 'must not arrive' }), /disk failure/)
  broker.append = append
  assert.deepEqual((await broker.inbox(b)).messages, [])
  const sent = await broker.send(a, { to: 'beta', text: 'audited', attachments: [{ name: 'file.txt', contentBase64: Buffer.from('content').toString('base64') }] })
  broker.append = async () => { throw new Error('simulated disk failure') }
  await assert.rejects(broker.inbox(b), /disk failure/)
  await assert.rejects(broker.attachment(b, sent.message.messageId, sent.message.attachments[0].id), /disk failure/)
  broker.append = append
  await writeFile(path.join(broker.objects, sent.message.attachments[0].id), 'modified')
  await assert.rejects(broker.attachment(b, sent.message.messageId, sent.message.attachments[0].id), /integrity/)
  const journal = await readFile(broker.journal, 'utf8')
  await writeFile(broker.journal, journal.replace('audited', 'changed'))
  await assert.rejects(broker.send(a, { to: 'beta', text: 'blocked' }), /integrity/)
  await writeFile(broker.journal, '')
  await assert.rejects(new AuditedCommunications(manager.root, manager).inbox(b), /checkpoint/)
})

test('attachment filename and transfer limits are enforced before delivery', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta')
  const broker = new AuditedCommunications(manager.root, manager, { attachmentBytes: 3, transferBytes: 4 })
  const a = manager.identity(manager.findTeam('alpha')), b = manager.identity(manager.findTeam('beta'))
  await assert.rejects(broker.send(a, { to: 'beta', attachments: [{ name: '../escape', contentBase64: 'YQ==' }] }), { statusCode: 400 })
  await assert.rejects(broker.send(a, { to: 'beta', attachments: [{ name: 'big', contentBase64: 'YWJjZA==' }] }), { statusCode: 413 })
  await assert.rejects(broker.send(a, { to: 'beta', attachments: [{ name: 'bad', contentBase64: 'abc!' }] }), { statusCode: 400 })
  assert.deepEqual((await broker.inbox(b)).messages, [])
})

test('audit reads stay correct as the journal grows without retaining every event', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta')
  online(manager, 'beta')
  const a = manager.identity(manager.findTeam('alpha')), b = manager.identity(manager.findTeam('beta'))
  const broker = new AuditedCommunications(manager.root, manager)
  const input = { to: 'beta', requestId: randomUUID(), text: '字'.repeat(20000) }
  const sent = await broker.send(a, input)
  assert.equal((await broker.send(a, input)).duplicate, true)
  for (let i = 0; i < 40; i++) await broker.append('messages.received', { actor: b, messageIds: [sent.message.messageId], fromCursor: i })
  assert.equal(broker.events, undefined)
  assert.equal(broker.messageIndex.length, 1)
  const exported = await broker.exportAudit()
  assert.equal(exported.integrity, 'verified')
  assert.equal(exported.events.length, 41)
  assert.equal(exported.events[0].text, input.text)
  assert.equal(broker.events, undefined)
  assert.ok(exported.events.length > broker.messageIndex.length)
  const page = await broker.audit({ limit: 2 })
  assert.equal(page.events.length, 2)
  assert.ok(page.events[0].seq > page.events[1].seq)
  const older = await broker.audit({ before: page.nextBefore, limit: 100 })
  assert.ok(older.events.every(event => event.seq < page.nextBefore))
  const reloaded = new AuditedCommunications(manager.root, manager)
  assert.equal(reloaded.events, undefined)
  const inbox = await reloaded.inbox(b)
  assert.equal(inbox.messages.length, 1)
  assert.equal(inbox.messages[0].text, input.text)
  assert.equal(reloaded.events, undefined)
  assert.equal(reloaded.messageIndex.length, 1)
})

// --- Sealed-segment rotation (audit finding P2) -----------------------------------------------------

async function readJournalCheckpoint(broker) {
  return JSON.parse(await readFile(broker.checkpoint, 'utf8'))
}

async function exists(file) {
  try { await readFile(file); return true } catch { return false }
}

test('rotation seals a size-full delivered segment and offsets keep resolving across the seal', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta')
  online(manager, 'beta')
  const a = manager.identity(manager.findTeam('alpha')), b = manager.identity(manager.findTeam('beta'))
  const broker = new AuditedCommunications(manager.root, manager, { journalRotateBytes: 2048 })
  const bytes = Buffer.from([1, 2, 3, 4, 5])
  const first = await broker.send(a, { to: 'beta', requestId: randomUUID(), text: '第一轮 ' + 'x'.repeat(300), attachments: [{ name: 'a.bin', contentBase64: bytes.toString('base64') }] })
  await broker.inbox(b)
  for (let i = 0; i < 8; i++) await broker.send(a, { to: 'beta', requestId: randomUUID(), text: `压力 ${i} ` + 'y'.repeat(300) })
  await broker.inbox(b)
  for (let i = 0; i < 8; i++) await broker.send(a, { to: 'beta', requestId: randomUUID(), text: `二轮 ${i} ` + 'z'.repeat(300) })
  await broker.inbox(b)
  const checkpoint = await readJournalCheckpoint(broker)
  assert.ok(checkpoint.segment >= 1, `expected a sealed rotation, got ${JSON.stringify(checkpoint)}`)
  assert.ok(await exists(broker.journalFile(1)), 'sealed segment file audit.000001.jsonl exists')
  // A restarted reader verifies the whole chain across segments and replays by offset.
  const reloaded = new AuditedCommunications(manager.root, manager, { journalRotateBytes: 2048 })
  const audit = await reloaded.exportAudit()
  assert.equal(audit.integrity, 'verified')
  assert.deepEqual(audit.events.map(e => e.seq), audit.events.map((_, i) => i + 1), 'seq is gapless across segments')
  const segments = new Set(reloaded.messageIndex.map(e => e.segment))
  assert.ok(segments.size >= 2, `index spans sealed and active segments, got ${[...segments]}`)
  const earliest = reloaded.messageIndex.find(e => e.seq === first.message.seq)
  const latest = reloaded.messageIndex.at(-1)
  for (const entry of [earliest, latest]) {
    const reread = await reloaded.readIndexedEvent(entry)
    assert.equal(reread.seq, entry.seq, 'offset read resolves inside the segment the entry names')
  }
  assert.deepEqual((await reloaded.attachment(b, first.message.messageId, first.message.attachments[0].id)).bytes, bytes)
})

test('undelivered messages pin their segment; rotation defers until delivery drains', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta')
  online(manager, 'beta')
  const a = manager.identity(manager.findTeam('alpha')), b = manager.identity(manager.findTeam('beta'))
  const broker = new AuditedCommunications(manager.root, manager, { journalRotateBytes: 2048 })
  for (let i = 0; i < 12; i++) await broker.send(a, { to: 'beta', requestId: randomUUID(), text: `积压 ${i} ` + 'q'.repeat(300) })
  assert.equal((await readJournalCheckpoint(broker)).segment, 0, 'undelivered backlog pins the active segment')
  assert.equal(await exists(broker.journalFile(1)), false, 'no sealed segment while messages are pending')
  await broker.inbox(b) // draining emits messages.received, which releases the pin
  const after = await readJournalCheckpoint(broker)
  assert.ok(after.segment >= 1, 'the sealed rotation lands right after delivery drains')
  await broker.send(a, { to: 'beta', requestId: randomUUID(), text: '新段首条 ' + 'p'.repeat(100) })
  assert.ok(await exists(broker.journalFile(1)), 'the next append lands in the freshly opened segment')
})

test('checkpoint records the segment and a rewound or missing segment fails closed', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta')
  online(manager, 'beta')
  const a = manager.identity(manager.findTeam('alpha')), b = manager.identity(manager.findTeam('beta'))
  const broker = new AuditedCommunications(manager.root, manager, { journalRotateBytes: 2048 })
  for (let i = 0; i < 8; i++) await broker.send(a, { to: 'beta', requestId: randomUUID(), text: `轮转 ${i} ` + 'w'.repeat(300) })
  await broker.inbox(b)
  const checkpoint = await readJournalCheckpoint(broker)
  assert.ok(checkpoint.segment >= 1)
  assert.ok(Number.isSafeInteger(checkpoint.seq) && typeof checkpoint.hash === 'string')
  await broker.send(a, { to: 'beta', requestId: randomUUID(), text: '段二数据 ' + 'r'.repeat(300) }) // give the newest segment content
  const live = await readJournalCheckpoint(broker)
  // Bad restore #1: rewind the checkpoint over a non-empty newest segment — its events then
  // outrun the checkpoint coordinate and the chain check fails closed.
  await writeFile(broker.checkpoint, JSON.stringify({ seq: live.seq, hash: live.hash, segment: live.segment - 1 }) + '\n')
  await assert.rejects(new AuditedCommunications(manager.root, manager).exportAudit(), /replaced or truncated|checkpoint/, 'a rewound checkpoint fails closed')
  // Bad restore #2: the newest segment file missing while the checkpoint still names it.
  await writeFile(broker.checkpoint, JSON.stringify(live) + '\n')
  await rm(broker.journalFile(live.segment), { force: true })
  await assert.rejects(new AuditedCommunications(manager.root, manager).exportAudit(), /replaced or truncated|checkpoint/, 'a missing sealed segment fails the chain closed')
})

test('sealed segments are immutable while new appends land in later segments', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta')
  online(manager, 'beta')
  const a = manager.identity(manager.findTeam('alpha')), b = manager.identity(manager.findTeam('beta'))
  const broker = new AuditedCommunications(manager.root, manager, { journalRotateBytes: 2048 })
  for (let i = 0; i < 8; i++) await broker.send(a, { to: 'beta', requestId: randomUUID(), text: `冻结 ${i} ` + 'v'.repeat(300) })
  await broker.inbox(b) // drains, seals segment 0
  for (let i = 0; i < 8; i++) await broker.send(a, { to: 'beta', requestId: randomUUID(), text: `在写 ${i} ` + 't'.repeat(300) })
  await broker.inbox(b) // drains, seals segment 1 — it is now frozen on disk
  assert.ok((await readJournalCheckpoint(broker)).segment >= 2, 'segment 1 is sealed, not just large')
  const sealedFile = broker.journalFile(1)
  const frozen = await readFile(sealedFile)
  for (let i = 0; i < 12; i++) await broker.send(a, { to: 'beta', requestId: randomUUID(), text: `续写 ${i} ` + 'u'.repeat(300) })
  await broker.inbox(b)
  assert.deepEqual(await readFile(sealedFile), frozen, 'the sealed segment never moved')
  const audit = await new AuditedCommunications(manager.root, manager, { journalRotateBytes: 2048 }).exportAudit()
  assert.equal(audit.integrity, 'verified')
  assert.ok(audit.events.length >= 22)
})

test('ATTACH-404-001: an unknown message is 404 while another instance message is 403, never both 404', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta')
  online(manager, 'beta')
  const a = manager.identity(manager.findTeam('alpha')), b = manager.identity(manager.findTeam('beta'))
  const controller = manager.controllerIdentity()
  const broker = new AuditedCommunications(manager.root, manager)
  const bytes = Buffer.from('mv 账副本 — 发往 controller 的真件')
  // The live shape: a team posts an attachment to the controller (系统保障组/default).
  const sent = await broker.send(a, { to: 'default', text: 'mv 账副本', requestId: randomUUID(), attachments: [{ name: 'mvlog.md', contentBase64: bytes.toString('base64') }] })
  const attachmentId = sent.message.attachments[0].id
  assert.equal(sent.message.to.instanceId, 'controller')
  // The recipient gets the bytes, with the integrity check intact.
  assert.deepEqual((await broker.attachment(controller, sent.message.messageId, attachmentId)).bytes, bytes)
  // 锁定案②: a genuinely unknown message id stays a 404 — the two answers must not collapse into one.
  await assert.rejects(broker.attachment(b, randomUUID(), attachmentId), { statusCode: 404, message: /attachment not found/ })
  // 锁定案① (same shape as the live incident): the object is on disk and indexed, so a team that is
  // not the recipient is told it is not the recipient — not that the attachment is missing.
  await assert.rejects(broker.attachment(b, sent.message.messageId, attachmentId), { statusCode: 403, message: /not the recipient/ })
  // The reviewer path still reaches it, and neither rejection left an audit claim behind.
  assert.deepEqual((await broker.attachment({ id: 'controller-browser' }, sent.message.messageId, attachmentId, true)).bytes, bytes)
  const audit = await broker.exportAudit()
  assert.deepEqual(audit.events.map(event => event.type), ['message.sent', 'attachment.received', 'attachment.reviewed'])
})
