// BURST-PACING-001（0.4.28 批 · 案⑥，总务判词：11-17 gate3_burst 实测同刻压入 100% 集中单腿，
// least-busy 位同刻不可见；正身=ds-headbot 侧压入节奏，与 ⑦b FIFO 共件、litellm 权重免动）。
// 锁定面：相邻起跑至少隔 paceMs（首件零等待）、上限×节奏×FIFO 三闸并存、垃圾值回落、
// "是否发生"永不改（drain 全结算、审计行一枚不落——行为验收口径与 gate3_burst.sh 同形）。
// 时钟全假（注入 sleep/now），断言确定性、零真定时器等待。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_PACE_MS, InboxPusher } from '../lib/inbox-push.js'
import { quiet } from './helpers.js'

function wire({ paceMs, maxInFlight = 8, gated = false } = {}) {
  let clock = 0
  const now = () => clock
  const sleeps = []
  // 先让出事件循环（刚 release 的件在旧时刻记录起跑）再拨钟——同步拨钟会把 release 与
  // deliver 之间的微任务压到拨后，伪造出"同刻起跑"的假象。
  const sleep = async ms => { sleeps.push(ms); await new Promise(resolve => setImmediate(resolve)); clock += ms }
  const started = []
  const events = []
  const gates = []
  let active = 0
  let peak = 0
  const pusher = new InboxPusher({
    appendEvent: async (type, data) => { events.push({ type, ...data }) },
    resolveSession: async to => ({ sessionId: 'session-alpha', id: to.id, port: 1, home: '/tmp' }),
    deliver: async (target, text, message) => {
      started.push({ text: message.text, at: clock })
      active += 1
      peak = Math.max(peak, active)
      if (gated) await new Promise(resolve => gates.push(resolve))
      active -= 1
    },
    logger: quiet,
    paceMs,
    maxInFlight,
    sleep,
    now,
  })
  const messages = n => Array.from({ length: n }, (_, index) => ({ to: { id: 'alpha' }, seq: index + 1, requestId: `r${index}`, text: `m${index}` }))
  return { pusher, started, events, gates, sleeps, peak: () => peak, advance: ms => { clock += ms }, messages }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

// 锁①：burst 起跑被摊开——4 枚同刻 notify 不得同刻全部到达网关（gate3 的 100% 单腿形状），
// 相邻起跑恰隔 paceMs，审计行一枚不落。
test('BURST-PACING-001 ①: a burst starts spread by paceMs instead of landing in one instant', async t => {
  const w = wire({ paceMs: 150 })
  t.after(() => { for (const release of w.gates.splice(0)) release() })
  for (const message of w.messages(4)) w.pusher.notify(message)
  await w.pusher.drain()
  assert.deepEqual(w.started.map(item => item.at), [0, 150, 300, 450], '相邻起跑恰隔一个 pace，不共享同一时刻')
  assert.deepEqual(w.sleeps, [150, 150, 150], '节奏全靠排队等待，首件不付费')
  assert.deepEqual(w.events.map(event => event.type), Array(4).fill('message.pushed'))
  assert.deepEqual(w.events.map(event => event.messageSeq), [1, 2, 3, 4])
})

// 锁②：首件零等待——队列空闲后的单发不得为节奏付一分钱时延（推送是唤醒优化，不是投递）；
// 距上一枚起跑已超 pace 同样零等待；短窗内的续发才按"距上一枚起跑"补差。
test('BURST-PACING-001 ②: the first push after idle starts instantly, only consecutive starts pay the pace', async t => {
  const w = wire({ paceMs: 150 })
  w.pusher.notify(w.messages(1)[0])
  await w.pusher.drain()
  assert.deepEqual(w.sleeps, [], '从未起跑过：零等待')
  assert.equal(w.started[0].at, 0)
  w.advance(1000)
  const next = w.messages(1).map(item => ({ ...item, seq: 2, requestId: 'r-2', text: 'm-2' }))[0]
  w.pusher.notify(next)
  await w.pusher.drain()
  assert.deepEqual(w.sleeps, [], '距上一枚起跑已超 pace：仍零等待')
  assert.equal(w.started[1].at, 1000)
  w.advance(10) // 距上一枚起跑只有 10ms——短窗续发，补差 140
  w.pusher.notify({ to: { id: 'alpha' }, seq: 3, requestId: 'r-3', text: 'm-3' })
  await w.pusher.drain()
  assert.deepEqual(w.sleeps, [140], '补的是与上一枚起跑的差，不是重新等整个 pace')
  assert.equal(w.started[2].at, 1150)
})

// 锁③：config 面口径——缺省 150；0 是合法显式值（关闭节奏）；垃圾值（字符串/负数/非整数）
// 回落缺省，不得静默变成 0 之外的任何形状（与 maxInFlight 同纪律）。
test('BURST-PACING-001 ③: paceMs defaults to 150, 0 opts out explicitly, junk falls back to the default', () => {
  assert.equal(DEFAULT_PACE_MS, 150)
  const base = { appendEvent: async () => {}, resolveSession: async () => null, deliver: async () => {}, logger: quiet }
  assert.equal(new InboxPusher({ ...base, paceMs: 'abc' }).paceMs, DEFAULT_PACE_MS)
  assert.equal(new InboxPusher({ ...base, paceMs: -5 }).paceMs, DEFAULT_PACE_MS)
  assert.equal(new InboxPusher({ ...base, paceMs: 2.5 }).paceMs, DEFAULT_PACE_MS)
  assert.equal(new InboxPusher({ ...base, paceMs: undefined }).paceMs, DEFAULT_PACE_MS)
  assert.equal(new InboxPusher({ ...base, paceMs: 0 }).paceMs, 0)
})

// 锁④：上限×节奏×FIFO 三闸并存——空位交给排队首照 FIFO 次序，且交接也要隔 pace；
// 并发峰值不得越上限（⑦b 的闸不因节奏失效，节奏不因闸失义）。
test('BURST-PACING-001 ④: cap, pace and FIFO coexist — hand-offs go to the queue head, still paced', async t => {
  const w = wire({ paceMs: 100, maxInFlight: 2, gated: true })
  t.after(() => { for (const release of w.gates.splice(0)) release() })
  for (const message of w.messages(5)) w.pusher.notify(message)
  await tick()
  assert.deepEqual(w.started.map(item => item.text), ['m0', 'm1'], '上限=2：第 3 枚不得起跑')
  assert.deepEqual(w.started.map(item => item.at), [0, 100], '两枚起跑之间也隔 pace——同刻双开正是 gate3 的病灶')
  assert.equal(w.pusher.queueDepth(), 3)
  w.gates[0]()
  // 两拍：完成链（deliver→audit→finally）走完才轮到 dispatcher 的 sleep 排入 setImmediate，
  // 单拍会把交接断言抢在起跑之前。
  await tick()
  await tick()
  assert.deepEqual(w.started.map(item => item.text), ['m0', 'm1', 'm2'], '空位交给排队首（FIFO 交接）')
  assert.equal(w.started[2].at, 200, '交接也照节奏：距 m1 起跑再隔一个 pace')
  assert.equal(w.peak(), 2, '并发峰值从未越上限')
  // 收尾边 drain 边放闸：m3/m4 在 drain 期间才起跑并排新 gate，一次性放还会让它们永久待闸。
  const draining = w.pusher.drain().then(() => 'drained')
  for (let guard = 0; guard < 1000; guard += 1) {
    const outcome = await Promise.race([draining, tick().then(() => 'tick')])
    for (const release of w.gates.splice(0)) release()
    if (outcome === 'drained') break
  }
  await draining
  assert.deepEqual(w.started.map(item => item.text), ['m0', 'm1', 'm2', 'm3', 'm4'], '排队到终不丢不乱')
  assert.equal(w.peak(), 2)
  assert.equal(w.events.length, 5, '排队+节奏过的件审计行一枚不落')
})

// 锁⑤："是否发生"永不改——30 枚 burst（gate3 复现器的最大形状）在默认缺省节奏下 drain
// 全结算：30 枚 pushed、seq 序完整。行为验收器 gate3_burst.sh 的判据在压入面即此形状。
test('BURST-PACING-001 ⑤: a 30-message burst drains complete — pacing changes when, never whether', async t => {
  const w = wire({ paceMs: 50, maxInFlight: 8 })
  t.after(() => { for (const release of w.gates.splice(0)) release() })
  for (const message of w.messages(30)) w.pusher.notify(message)
  await w.pusher.drain()
  assert.equal(w.started.length, 30, '一枚不落')
  assert.deepEqual(w.events.map(event => event.type), Array(30).fill('message.pushed'))
  assert.deepEqual(w.events.map(event => event.messageSeq), Array.from({ length: 30 }, (_, index) => index + 1))
  const gaps = w.started.slice(1).map((item, index) => item.at - w.started[index].at)
  assert.ok(gaps.every(gap => gap >= 0 && gap <= 50), '任意相邻起跑不越一个 pace 窗（8 路并发下由起跑序摊开）')
})
