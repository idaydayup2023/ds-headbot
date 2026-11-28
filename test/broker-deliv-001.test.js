import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { AuditedCommunications } from '../lib/communications.js'
import { add, fixture, online } from './helpers.js'

// BROKER-DELIV-001（吞件案定位线落地）：离线不再直丢＋在线态双证。活体样本：ai-writer
// 13:25:05 出站成功、入站自 07:24 未断流，13:5x 三投仍被按 offline 直丢（seq 2365/2366/2367）。

test('BROKER-DELIV-001 dual source: broker traffic itself marks a team reachable despite the process ledger', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta')
  const a = manager.identity(manager.findTeam('alpha')), b = manager.identity(manager.findTeam('beta'))
  const broker = new AuditedCommunications(manager.root, manager)
  await broker.ensureVerified() // 索引重建落定后再注入（生产形制：活动由 append 盖章）
  assert.equal(manager.isCommunicationTargetOnline('beta'), false) // 进程账说离线
  // 收件方自己的 broker 活动（出站/入站盖章）是等权活性证据，压得住滞后的进程记录。
  broker.lastActivity.set(b.instanceId, Date.now())
  const sent = await broker.send(a, { to: 'beta', requestId: randomUUID(), text: '双证在线' })
  assert.equal(sent.delivered, true)
  // 两证皆静默超过窗口，才回到排队答案。
  broker.lastActivity.set(b.instanceId, Date.now() - broker.activityTtlMs - 1000)
  const queued = await broker.send(a, { to: 'beta', requestId: randomUUID(), text: '静默超时' })
  assert.equal(queued.delivered, false)
  assert.equal(queued.queued, true)
})

test('BROKER-DELIV-001 rebuild: a restarted broker rehydrates the queue from the journal and delivers on the next poll', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta')
  const a = manager.identity(manager.findTeam('alpha')), b = manager.identity(manager.findTeam('beta'))
  const broker = new AuditedCommunications(manager.root, manager)
  const sealed = await broker.send(a, { to: 'beta', requestId: randomUUID(), text: '重启也不丢' })
  assert.equal(sealed.queued, true)
  const reloaded = new AuditedCommunications(manager.root, manager)
  await reloaded.ensureVerified() // 重建先行：队列自账本重放进来
  assert.equal(reloaded.pendingByRecipient.get(b.instanceId)?.length, 1)
  online(manager, 'beta')
  await reloaded.inbox(b) // 第一拍触发 flush
  const inbox = await reloaded.inbox(b) // 第二拍读到重放投递
  assert.equal(inbox.messages.length, 1)
  assert.equal(inbox.messages[0].text, '重启也不丢')
  assert.equal(reloaded.pendingByRecipient.get(b.instanceId)?.length ?? 0, 0)
  assert.deepEqual((await reloaded.inbox(b)).messages, [])
})

test('BROKER-DELIV-001 capacity: over-capacity queues refuse loudly instead of overflowing silently', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta')
  const a = manager.identity(manager.findTeam('alpha'))
  const broker = new AuditedCommunications(manager.root, manager)
  broker.offlineQueueMax = 1
  const first = await broker.send(a, { to: 'beta', requestId: randomUUID(), text: '第一枚' })
  const second = await broker.send(a, { to: 'beta', requestId: randomUUID(), text: '第二枚' })
  assert.equal(first.queued, true)
  assert.equal(second.queued, undefined)
  assert.equal(second.message.type, 'message.offline-rejected')
  const audit = await broker.exportAudit()
  assert.deepEqual(audit.events.map(event => event.type), ['message.offline-queued', 'message.offline-rejected'])
})

test('BROKER-DELIV-001 FIFO and isolation: one recipient flushes in order, another poll never drains it', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta'); await add(manager, 'gamma')
  const a = manager.identity(manager.findTeam('alpha'))
  const b = manager.identity(manager.findTeam('beta'))
  const g = manager.identity(manager.findTeam('gamma'))
  const broker = new AuditedCommunications(manager.root, manager)
  for (const text of ['一', '二', '三']) await broker.send(a, { to: 'beta', requestId: randomUUID(), text })
  // gamma 在线轮询不得碰 beta 的队列（跨收件人零渗漏）。
  online(manager, 'gamma')
  await broker.inbox(g)
  assert.equal(broker.pendingByRecipient.get(b.instanceId)?.length, 3)
  online(manager, 'beta')
  await broker.inbox(b)
  const inbox = await broker.inbox(b)
  assert.deepEqual(inbox.messages.map(message => message.text), ['一', '二', '三'])
})
