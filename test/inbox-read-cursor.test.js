// INBOX-READ-CURSOR-001（0.4.28 批 · 案②）：收件箱服务端权威读位。
// 根因样本（盘上账实，11-19 直读 audit.jsonl）：subtrans seq 396 delivered=true 对侧初轮不见——
// 八个互踩游标（0/64/129/262/367/378/400/432）+ 升序 limit 截断，发件排在窗口外几十分钟。
// 修复形制：游标只有服务端一份真相（advance:true 盖章推出、重启从账本重建）；显式 after 降只读回放。
// 本文件全部走内存/临时目录 broker，不碰真机、不发真请求。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { AuditedCommunications } from '../lib/communications.js'
import { handleApiRequest } from '../index.js'
import { add, fixture, online, quiet } from './helpers.js'

async function pair(t) {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta')
  online(manager, 'beta')
  const a = manager.identity(manager.findTeam('alpha'))
  const b = manager.identity(manager.findTeam('beta'))
  return { manager, a, b, broker: new AuditedCommunications(manager.root, manager) }
}

async function sendAll(broker, a, ...texts) {
  for (const text of texts) await broker.send(a, { to: 'beta', requestId: randomUUID(), text })
}

// 锁①：服务端读=盖章即推进——同一批绝不二次返回，新件按批续读，盖章带 advance:true+nextCursor。
test('INBOX-READ-CURSOR-001 ①: a server-mode fetch seals its batch and never returns it again', async t => {
  const { a, b, broker } = await pair(t)
  await sendAll(broker, a, '甲', '乙')
  const first = await broker.inbox(b)
  assert.equal(first.readMode, 'server')
  assert.deepEqual(first.messages.map(message => message.text), ['甲', '乙'])
  const second = await broker.inbox(b)
  assert.deepEqual(second.messages, [], '锁定案①: 盖章后重读不得二次返回（旧形制=每次全量重放）')
  assert.equal(second.readMode, 'server')
  await sendAll(broker, a, '丙')
  const third = await broker.inbox(b)
  assert.deepEqual(third.messages.map(message => message.text), ['丙'], '读位之后只来新批')
  const stamps = (await broker.exportAudit()).events.filter(event => event.type === 'messages.received')
  assert.equal(stamps.at(-1).advance, true)
  assert.equal(stamps.at(-1).nextCursor, third.nextCursor)
})

// 锁②：重启游标不丢——游标不是运行时状态，是账本盖章的重建函数（实时/重建同一规则）。
test('INBOX-READ-CURSOR-001 ②: the cursor survives a restart because it is rebuilt from the journal', async t => {
  const { manager, a, b } = await pair(t)
  let broker = new AuditedCommunications(manager.root, manager)
  await sendAll(broker, a, '甲', '乙')
  assert.equal((await broker.inbox(b)).messages.length, 2)
  broker = new AuditedCommunications(manager.root, manager)
  assert.deepEqual((await broker.inbox(b)).messages, [], '锁定案②: 重启后读位从账本重建，已盖章的件不再重发')
  await sendAll(broker, a, '丙')
  broker = new AuditedCommunications(manager.root, manager)
  assert.deepEqual((await broker.inbox(b)).messages.map(message => message.text), ['丙'], '重启后照常只续读新批')
})

// 锁③：显式 after=只读回放——站长重放与旧格式盖章（无 advance 字段）都不许动读位。
// （communications.test.js 的 40 枚旧格式盖章回归案是同一规则的另一半守卫。）
test('INBOX-READ-CURSOR-001 ③: explicit after is read-only replay and never moves the read cursor', async t => {
  const { manager, a, b } = await pair(t)
  const broker = new AuditedCommunications(manager.root, manager)
  await sendAll(broker, a, '甲', '乙')
  const replay = await broker.inbox(b, 0)
  assert.equal(replay.readMode, 'replay')
  assert.deepEqual(replay.messages.map(message => message.text), ['甲', '乙'], '回放照常返回窗口内全部')
  const stamps = (await broker.exportAudit()).events.filter(event => event.type === 'messages.received')
  assert.equal(stamps.at(-1).advance, false, '回放照常盖章留审计痕迹，但标 advance:false')
  await broker.append('messages.received', { actor: b, messageIds: replay.messages.map(message => message.messageId), fromCursor: 99 })
  const reloaded = new AuditedCommunications(manager.root, manager)
  const server = await reloaded.inbox(b)
  assert.deepEqual(server.messages.map(message => message.text), ['甲', '乙'], '锁定案③: 回放与旧格式盖章都不推游标——服务端读位仍在 0')
  assert.deepEqual((await reloaded.inbox(b)).messages, [], '服务端读自己的盖章才推进')
})

// 锁④：双路轮询互不吞件——站长重放吞不掉 Bot 的读位（锁③），Bot 的服务端读也吞不掉
// 站长的历史重放；同队共享一个读位是本案的设计（服务端真相唯一）。
test('INBOX-READ-CURSOR-001 ④: a station-master replay and a bot poll never swallow each other', async t => {
  const { a, b, broker } = await pair(t)
  await sendAll(broker, a, '一', '二', '三')
  const bot = await broker.inbox(b)
  assert.deepEqual(bot.messages.map(message => message.text), ['一', '二', '三'])
  const station = await broker.inbox(b, 0)
  assert.deepEqual(station.messages.map(message => message.text), ['一', '二', '三'], '锁定案④: Bot 已盖章不影响站长全量重放')
  assert.deepEqual((await broker.inbox(b)).messages, [], '同队共享服务端读位（设计语义，显式锁定）')
  await sendAll(broker, a, '四')
  assert.deepEqual((await broker.inbox(b)).messages.map(message => message.text), ['四'], '站长的回放盖章没吞掉 Bot 的新件读位')
  assert.deepEqual((await broker.inbox(b, 0)).messages.map(message => message.text), ['一', '二', '三', '四'], 'Bot 的推进盖章也没吞掉站长的历史')
})

// 锁⑤：HTTP 路由接线——查询不带 after 时必须传 undefined（走服务端读位）。
// 旧接线 `?? 0` 恒传 0=每次 HTTP 轮询都是全量回放，修复会在传输层静默失效——这一刀就是拦这个。
test('INBOX-READ-CURSOR-001 ⑤: the route only forwards after when the query carries it', async t => {
  void t
  const calls = []
  const communications = { inbox: async (actor, after, limit) => { calls.push({ after, limit }); return { protocol: 'headbot-team/v1', messages: [], nextCursor: 0, readMode: after === undefined ? 'server' : 'replay' } } }
  const capture = () => ({ statusCode: 0, body: '', headers: {}, setHeader(key, value) { this.headers[key] = value }, writeHead(code) { this.statusCode = code }, end(body) { this.statusCode ||= 200; this.body = body } })
  const actor = { id: 'beta', instanceId: 'instance-x' }
  const plain = capture()
  await handleApiRequest({ method: 'GET', url: '/api/ds-headbot/v1/comms/v1/inbox' }, plain, {}, communications, {}, quiet, actor)
  assert.equal(calls[0].after, undefined, '锁定案⑤: HTTP 无 after=服务端读位模式，不得再硬塞 0')
  assert.deepEqual(JSON.parse(plain.body).readMode, 'server')
  const replay = capture()
  await handleApiRequest({ method: 'GET', url: '/api/ds-headbot/v1/comms/v1/inbox?after=400&limit=5' }, replay, {}, communications, {}, quiet, actor)
  assert.equal(calls[1].after, '400', '显式 after 原样转发=只读回放')
  assert.equal(calls[1].limit, '5')
  assert.deepEqual(JSON.parse(replay.body).readMode, 'replay')
})
