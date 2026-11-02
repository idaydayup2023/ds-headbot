import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { AuditedCommunications } from '../lib/communications.js'
import { add, fixture } from './helpers.js'

test('offline messages, binary attachments, safe retries and replay survive controller restart', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta'); await add(manager, 'gamma')
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
  await assert.rejects(reloaded.attachment(c, sent.message.messageId, file.id), { statusCode: 404 })
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
