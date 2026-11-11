import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { AuditedCommunications } from '../lib/communications.js'
import { InboxPusher, buildPushText, createSessionResolver, promptUrlFromLaunchUrl, signCookie, PUSH_TEXT_LIMIT } from '../lib/inbox-push.js'
import { add, fixture, online, quiet } from './helpers.js'

function wirePusher(broker, manager, deliver) {
  const pusher = new InboxPusher({
    appendEvent: (type, data) => broker.appendEvent(type, data),
    resolveSession: createSessionResolver({ manager }),
    deliver,
    logger: quiet,
  })
  broker.attachPusher(pusher)
  return pusher
}

async function seedLeadSession(manager, id, sessionId) {
  const home = path.join(manager.root, 'teams', id, 'home')
  await mkdir(path.join(home, 'bot'), { recursive: true })
  await writeFile(path.join(home, 'bot', 'state.json'), JSON.stringify({ mainBotIds: [sessionId] }))
}

test('offline recipient is answered by rule: no journal delivery, no queue, no backfill', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta')
  const a = manager.identity(manager.findTeam('alpha')), b = manager.identity(manager.findTeam('beta'))
  const broker = new AuditedCommunications(manager.root, manager)
  const bytes = Buffer.from('不得缓存')
  const sent = await broker.send(a, { to: 'beta', subject: '催办', requestId: randomUUID(), text: '离线即拒', attachments: [{ name: 'a.txt', contentBase64: bytes.toString('base64') }] })
  assert.equal(sent.delivered, false)
  assert.equal(sent.recipientOffline, true)
  assert.match(sent.notice, /团队 beta\(BETA\) 当前不在线，消息未缓存/)
  assert.equal(sent.message.type, 'message.offline-rejected')
  assert.equal(sent.message.fingerprint.length, 64)
  assert.deepEqual((await broker.inbox(b)).messages, [])
  // Coming back online never turns the refusal into a delivery.
  online(manager, 'beta')
  assert.deepEqual((await broker.inbox(b)).messages, [])
  const audit = await broker.exportAudit()
  assert.deepEqual(audit.events.map(event => event.type), ['message.offline-rejected'])
  assert.equal(audit.events[0].subject, '催办')
  assert.equal(audit.events[0].from.id, 'alpha')
  assert.equal(audit.integrity, 'verified')
  // No attachment object was archived for the refused request.
  await assert.rejects(broker.attachment(b, sent.message.messageId ?? 'x', 'x'), /not found|404|invalid/)
})

test('duplicate requestId keeps its offline verdict without double-booking the journal', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta')
  const a = manager.identity(manager.findTeam('alpha'))
  const broker = new AuditedCommunications(manager.root, manager)
  const input = { to: 'beta', requestId: randomUUID(), text: '同请求重放' }
  const first = await broker.send(a, input)
  const again = await broker.send(a, input)
  assert.equal(first.recipientOffline, true)
  assert.equal(again.recipientOffline, true)
  assert.equal(again.duplicate, true)
  assert.equal(again.message.seq, first.message.seq)
  await assert.rejects(broker.send(a, { ...input, text: '换内容' }), { statusCode: 409 })
  const audit = await broker.exportAudit()
  assert.deepEqual(audit.events.map(event => event.type), ['message.offline-rejected'])
})

test('a delivered send never waits for the push and audits message.pushed with the wake-up text', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta')
  online(manager, 'beta')
  await seedLeadSession(manager, 'beta', 'session-lead-9')
  const a = manager.identity(manager.findTeam('alpha'))
  const broker = new AuditedCommunications(manager.root, manager)
  let release
  const gate = new Promise(resolve => { release = resolve })
  const calls = []
  const pusher = wirePusher(broker, manager, async (target, text, message) => {
    calls.push({ target, text, message })
    await gate
    return 'accepted'
  })
  const sent = await broker.send(a, { to: 'beta', subject: '升级窗口', requestId: randomUUID(), text: '今夜 02:10 执行' })
  assert.equal(sent.delivered, true)
  // The push is still parked behind the gate: send() answered anyway, and the message is durable.
  for (let i = 0; i < 200 && !calls.length; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 1)
  assert.deepEqual((await broker.inbox(manager.identity(manager.findTeam('beta')))).messages.map(m => m.text), ['今夜 02:10 执行'])
  release()
  await pusher.drain()
  assert.equal(calls[0].target.sessionId, 'session-lead-9')
  assert.equal(calls[0].target.id, 'beta')
  assert.match(calls[0].text, new RegExp(`seq=${sent.message.seq}`))
  assert.match(calls[0].text, /主题: 升级窗口/)
  assert.match(calls[0].text, /回放 headbot_receive_messages 取全文/)
  const audit = await broker.exportAudit()
  // The inbox() read above legitimately left its messages.received marker between the two.
  assert.deepEqual(audit.events.map(event => event.type), ['message.sent', 'messages.received', 'message.pushed'])
  assert.equal(audit.events[2].to.id, 'beta')
  assert.equal(audit.events[2].sessionId, 'session-lead-9')
  assert.equal(audit.events[2].messageSeq, sent.message.seq)
  assert.equal(audit.integrity, 'verified')
})

test('push failures degrade to message.push-failed and never touch delivery', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta')
  online(manager, 'beta')
  await seedLeadSession(manager, 'beta', 'session-lead-9')
  const a = manager.identity(manager.findTeam('alpha'))
  const broker = new AuditedCommunications(manager.root, manager)
  const pusher = wirePusher(broker, manager, async () => { throw new Error('ECONNREFUSED 127.0.0.1:1') })
  const sent = await broker.send(a, { to: 'beta', requestId: randomUUID(), text: '假端口注入' })
  assert.equal(sent.delivered, true)
  await pusher.drain()
  const audit = await broker.exportAudit()
  assert.deepEqual(audit.events.map(event => event.type), ['message.sent', 'message.push-failed'])
  assert.match(audit.events[1].reason, /ECONNREFUSED/)
  assert.deepEqual((await broker.inbox(manager.identity(manager.findTeam('beta')))).messages.map(m => m.text), ['假端口注入'])
})

test('an unresolvable lead session skips the push with push-skipped(no-session), not a failure', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta')
  online(manager, 'beta')
  const a = manager.identity(manager.findTeam('alpha'))
  const broker = new AuditedCommunications(manager.root, manager)
  const pusher = wirePusher(broker, manager, async () => 'accepted')
  const sent = await broker.send(a, { to: 'beta', requestId: randomUUID(), text: '无人可叫醒' })
  assert.equal(sent.delivered, true)
  await pusher.drain()
  const audit = await broker.exportAudit()
  assert.deepEqual(audit.events.map(event => event.type), ['message.sent', 'message.push-skipped'])
  assert.equal(audit.events[1].reason, 'no-session')
})

test('explicit pushSessionId on the team record wins over mainBotIds auto-resolution', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta')
  online(manager, 'beta')
  await seedLeadSession(manager, 'beta', 'session-auto-1')
  manager.findTeam('beta').pushSessionId = 'session-explicit-2'
  const a = manager.identity(manager.findTeam('alpha'))
  const broker = new AuditedCommunications(manager.root, manager)
  const calls = []
  const pusher = wirePusher(broker, manager, async (target, text) => { calls.push(target.sessionId); return 'accepted' })
  await broker.send(a, { to: 'beta', requestId: randomUUID(), text: '显式优先' })
  await pusher.drain()
  assert.deepEqual(calls, ['session-explicit-2'])
})

test('push text clips long bodies at the limit and names the retrieval tools for attachments', async t => {
  const long = buildPushText({ seq: 7, from: { id: 'alpha', name: 'ALPHA' }, subject: '长文', text: '字'.repeat(PUSH_TEXT_LIMIT + 100), timestamp: '2026-11-11T12:00:00.000Z' })
  assert.ok(long.includes(`…〔截断，全文 ${PUSH_TEXT_LIMIT + 100} 字符，回放 headbot_receive_messages 取〕`))
  assert.ok(long.length < PUSH_TEXT_LIMIT + 500)
  const withFiles = buildPushText({ seq: 8, from: { id: 'alpha' }, subject: '附件', text: '短', attachments: [{ id: 'att-1', name: 'log.zip' }] })
  assert.match(withFiles, /附件: att-1\/log\.zip（headbot_download_attachment 取）/)
  assert.match(withFiles, /— 回放 headbot_receive_messages 取全文；附件用 headbot_download_attachment/)
})

test('push targets derive from the launch URL and the self-signed cookie carries the authority', async t => {
  assert.equal(promptUrlFromLaunchUrl('http://192.168.1.5:5555/dsh/?token=abc'), 'http://192.168.1.5:5555/dsh/api/session/prompt')
  assert.equal(promptUrlFromLaunchUrl('http://192.168.1.5:5555/'), 'http://192.168.1.5:5555/api/session/prompt')
  const secret = Buffer.alloc(32, 7).toString('base64url')
  const cookie = signCookie('127.0.0.1:4321', secret)
  assert.match(cookie, /^dsh-auth-[A-Za-z0-9_-]+=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  const body = JSON.parse(Buffer.from(cookie.split('.')[1], 'base64url').toString('utf8'))
  assert.equal(body.authority, '127.0.0.1:4321')
  assert.ok(body.expiresAt > body.issuedAt)
  assert.throws(() => signCookie('127.0.0.1:4321', 'not-base64url!!'))
  assert.throws(() => signCookie('127.0.0.1:4321', Buffer.alloc(16).toString('base64url')), /length/)
})
