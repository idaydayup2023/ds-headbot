// ENGINE-QUEUE-001（0.4.28 批 · 案⑦）：引擎队列深度判据与 in-flight 上限的读数面。
// 三台引擎、网关、litellm 全部被假端点替身——本文件不碰真机、不发真请求、不读真凭据。
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  DEFAULT_SAMPLE_STALE_MS,
  deriveQueue,
  deriveSaturation,
  detectFrozen,
  parseEngineGauges,
  summarizeInstantRejections,
} from '../lib/engines-observe.js'
import { normalizeEngines } from '../lib/manager/engines.js'
import { fixture, quiet } from './helpers.js'

// 锁 ①：gauge 解析——带标签、重复出现取后值、脏行/负数/缺项一律 null（不许把"读不到"当 0）。
test('ENGINE-QUEUE-001 ①: engine gauges parse labels, last-write-wins and missing readings stay null', () => {
  const text = [
    '# HELP tensorfold:requests_running In flight',
    'tensorfold:requests_running{model="x"} 3',
    'tensorfold:requests_waiting 2',
    'tensorfold:requests_waiting 4',
    'tensorfold:generation_tokens_running 1227',
    'tensorfold:num_requests_running 4',
    'tensorfold:num_requests_waiting 4',
    'unrelated_metric 99',
    'tensorfold:requests_completed -5',
    'garbage line without a value',
  ].join('\n')
  assert.deepEqual(parseEngineGauges(text), { running: 3, waiting: 4, generationTokens: 1227, numRunning: 4, numWaiting: 4 })
  assert.deepEqual(parseEngineGauges(''), { running: null, waiting: null, generationTokens: null, numRunning: null, numWaiting: null })
  assert.deepEqual(parseEngineGauges(undefined).running, null)
})

// 锁 ②：队列三档 + "jam 必须连续两拍" + 断档不得硬连成连续。
test('ENGINE-QUEUE-001 ②: queue reads ok/warn/jam and jam needs two consecutive samples', () => {
  const at = 1_000_000
  const sample = (waiting, ts = at, running = 0, generationTokens = 0) => ({ ts, running, waiting, generationTokens })
  assert.equal(deriveQueue({ a: [sample(1)] }).queue, 'ok')
  assert.equal(deriveQueue({ a: [sample(2)] }).queue, 'warn')
  assert.equal(deriveQueue({ a: [sample(5)] }).queue, 'warn', '单拍毛刺不得直接判 jam')
  assert.equal(deriveQueue({ a: [sample(5, at - 60_000), sample(5, at)] }).queue, 'jam')
  const broken = deriveQueue({ a: [sample(5, at - 600_000), sample(5, at)] })
  assert.equal(broken.queue, 'warn', '相邻拍间隔超 staleMs 即断链，不得凑成连续两拍')
  assert.deepEqual(deriveQueue({ a: [sample(1)], b: [sample(7, at), sample(7, at - 60_000)] }).queueDepth.perEngine, { a: 1, b: 7 })
  assert.deepEqual(deriveQueue({ a: [sample(3)] }).queueDepth, { max: 3, leg: 'a', perEngine: { a: 3 } })
  // 阈值可覆写必须真接得上（不是纯函数缺省值在兜）。
  assert.equal(deriveQueue({ a: [sample(3)] }, { warnAt: 4 }).queue, 'ok')
  assert.equal(deriveQueue({ a: [sample(9, at), sample(9, at - 1000)] }, { jamAt: 10 }).queue, 'warn')
})

// 锁 ③：冻结判据必须带 running>0——今晨 .159 空载时 running=0、gen 恒 0，缺此条件即误判卡死。
test('ENGINE-QUEUE-001 ③: frozen needs gen stalled WITH running>0 across consecutive samples', () => {
  const at = 2_000_000
  const step = 60_000
  const row = (index, running, generationTokens) => ({ ts: at - (2 - index) * step, running, waiting: 0, generationTokens })
  const stalled = [row(0, 2, 1227), row(1, 2, 1227), row(2, 2, 1227)]
  assert.deepEqual(detectFrozen(stalled), { since: at - 2 * step, samples: 3, at })
  assert.equal(detectFrozen([row(0, 0, 0), row(1, 0, 0), row(2, 0, 0)]), null, '空载（running=0）不得判冻结')
  assert.equal(detectFrozen([row(0, 2, 100), row(1, 2, 200), row(2, 2, 300)]), null, 'gen 在推进就不是冻结')
  assert.equal(detectFrozen([row(1, 2, 1227), row(2, 2, 1227)]), null, '不足 N 拍不下结论')
  assert.equal(detectFrozen([row(0, 2, 1227), row(1, 2, 1227), { ...row(2, 2, 1227), ts: at + 10 * 60 * 60_000 }]), null, '断档后不得硬连成三拍')
  // 饱和位只报数不编阈值：逐腿无 max_parallel_requests 可对外。
  assert.deepEqual(deriveSaturation({ a: [row(0, 4, 10)], b: [row(0, 1, 10)] }), { maxRunning: 4, leg: 'a', noDeclaredCap: true })
  assert.deepEqual(deriveSaturation({}), { maxRunning: null, leg: null, noDeclaredCap: true })
})

// 锁 ④：瞬拒率——靶形制是 92 枚零时长 No deployments available；长尾（215s/273s）不得算进来。
test('ENGINE-QUEUE-001 ④: instant-rejection rate counts zero-duration refusals and not the long tail', () => {
  const rows = []
  for (let index = 0; index < 92; index += 1) rows.push(JSON.stringify({ status: 'failure', duration_ms: 0, error: 'No deployments available for selected model, Try again in 60' }))
  for (const duration of [214_900, 273_200, 215_000]) rows.push(JSON.stringify({ status: 'failure', duration_ms: duration, error: 'litellm.InternalServerError' }))
  for (let index = 0; index < 20; index += 1) rows.push(JSON.stringify({ status: 'success', duration_ms: index, stream: index % 2 === 0 }))
  rows.push('{not json', '', '   ')
  const summary = summarizeInstantRejections(rows)
  assert.equal(summary.failures, 95)
  assert.equal(summary.instantRejects, 92, '长尾 215-273s 的失败不得当瞬拒')
  assert.equal(summary.share, 0.9684)
  assert.equal(summary.rows, 115, 'rows=92 瞬拒+3 长尾+20 成功，脏行不进 rows')
  assert.equal(summary.malformed, 1)
  assert.deepEqual(
    { ...summarizeInstantRejections([JSON.stringify({ status: 'success', duration_ms: 1 })]) }
      .valueOf(),
    { available: true, rows: 1, failures: 0, instantRejects: 0, share: null, malformed: 0, maxDurationMs: 50 },
  )
  assert.equal(summarizeInstantRejections([JSON.stringify({ status: 'failure', duration_ms: 40 })], { maxDurationMs: 30 }).instantRejects, 0, '阈值可覆写接得上')
})

function engineFixtureRows({ waiting = 0, running = 1, generationTokens = 100 } = {}) {
  return `tensorfold:requests_running ${running}\ntensorfold:requests_waiting ${waiting}\ntensorfold:generation_tokens_running ${generationTokens}\ntensorfold:num_requests_running ${running}\ntensorfold:num_requests_waiting ${waiting}\n`
}

function wireEngines(manager, { rows, keyFile, metaFile, now }) {
  manager.engineKeyFile = keyFile
  manager.engineMetaFile = metaFile
  manager.engineNow = now ?? (() => Date.now())
  const calls = []
  manager.fetchImpl = async (url, options = {}) => {
    calls.push({ url, headers: options.headers ?? {}, hasSignal: Boolean(options.signal) })
    const response = rows[String(url)]
    if (response instanceof Error) throw response
    if (typeof response === 'number') return { ok: false, status: response, text: async () => '' }
    return { ok: true, status: 200, text: async () => response ?? engineFixtureRows() }
  }
  return calls
}

// 锁 ⑤：读数腿本体——抢开只打一次网络（in-flight 合并）、TTL 内复用、force 绕缓存、
// 探针全断时判据如实 unknown 而不是冒充健康，且任何探针失败都不许抛到调用方。
test('ENGINE-QUEUE-001 ⑤: the reading leg coalesces, caches, honours force and never throws on a dead probe', async t => {
  const { manager, root } = await fixture(t)
  const keyFile = path.join(root, 'engine.key')
  const metaFile = path.join(root, 'request_meta.jsonl')
  await writeFile(keyFile, 'sekret\n')
  await writeFile(metaFile, [
    JSON.stringify({ status: 'failure', duration_ms: 0, error: 'No deployments available' }),
    JSON.stringify({ status: 'failure', duration_ms: 0, error: 'No deployments available' }),
    JSON.stringify({ status: 'failure', duration_ms: 214_900 }),
  ].join('\n'))
  const clock = { now: 5_000_000 }
  const urls = manager.engines.map(engine => `${engine.url}/metrics`)
  const calls = wireEngines(manager, {
    rows: { [urls[0]]: engineFixtureRows({ waiting: 3, running: 2, generationTokens: 777 }), [urls[1]]: engineFixtureRows({ waiting: 0 }), [urls[2]]: new Error('ECONNREFUSED') },
    keyFile,
    metaFile,
    now: () => clock.now,
  })

  const first = await manager.observeEngines()
  assert.equal(calls.length, 3, '三腿各打一次')
  assert.equal(first.criteria.queue, 'warn', 'waiting=3 应读到 warn')
  assert.equal(first.criteria.queueDepth.max, 3)
  assert.equal(first.engines.filter(engine => engine.ok).length, 2, '探针断一枚如实标出')
  assert.equal(first.engines[2].ok, false)
  assert.match(first.engines[2].error, /ECONNREFUSED/)
  assert.equal(first.reachable, 2)
  assert.equal(first.keyAvailable, true, '钥文件在位')
  assert.equal(calls[0].headers.Authorization, 'Bearer sekret', '带钥形制=Authorization: Bearer')
  assert.equal(calls[0].hasSignal, true, '每腿必须有超时预算，不得发无预算请求')
  assert.deepEqual(first.criteria.instantRejects.instantRejects, 2)
  assert.equal(first.criteria.instantRejects.available, true)

  const raced = await Promise.all([manager.observeEngines({ force: true }), manager.observeEngines({ force: true })])
  assert.equal(calls.length, 6, '锁定案⑤: 抢开的两拍共用一次探针，不得各打一遍')
  assert.equal(raced[0].criteria.queue, raced[1].criteria.queue)

  clock.now += 1_000
  const cached = await manager.observeEngines()
  assert.equal(calls.length, 6, '锁定案⑤: TTL 内复用报告，不再打网络')
  assert.equal(cached.cached, true)

  clock.now += manager.engineCacheMs + 1
  const forced = await manager.observeEngines({ force: true })
  assert.equal(calls.length, 9, 'force 必须绕开缓存')
  assert.equal(forced.cached, false)

  // 全部探针断：判据必须 unknown，且不得抛。
  for (const url of urls) calls.length && (manager.fetchImpl = async () => { throw new Error('all legs down') })
  clock.now += manager.engineCacheMs + 1
  const dead = await manager.observeEngines()
  assert.equal(dead.reachable, 0)
  assert.equal(dead.criteria.queue, 'unknown', '一台都探不到时不得冒充判据')
  assert.ok(dead.engines.every(engine => engine.ok === false))

  // 无钥：401 也必须被吞成读数，而不是抛。
  manager.engineKeyValue = undefined
  manager.engineKeyFile = path.join(root, 'nope.key')
  const noKey = await manager.observeEngines({ force: true })
  assert.equal(noKey.keyAvailable, false)
  assert.ok(noKey.engines.every(engine => engine.ok === false))

  // 空 config：engines=[] 时不编数，直接 unknown。
  manager.engines = []
  manager.engineReport = undefined
  const none = await manager.observeEngines({ force: true })
  assert.equal(none.criteria.queue, 'unknown')
  assert.equal(none.configuredEngines, 0)
  assert.equal(quiet ? 1 : 0, 1)
})

// 锁 ⑤b：config/env 覆写面与非法输入的拒收形制（判据阈值接不上=白锁）。
test('ENGINE-QUEUE-001 ⑤b: engine list normalizes and rejects malformed declarations', () => {
  assert.deepEqual(normalizeEngines(['http://10.0.0.1:8888', { id: 'named', url: 'https://10.0.0.2:8888/' }]), [
    { id: '10.0.0.1', url: 'http://10.0.0.1:8888', index: 0 },
    { id: 'named', url: 'https://10.0.0.2:8888', index: 1 },
  ])
  assert.throws(() => normalizeEngines(['ftp://10.0.0.1:8888']), /http\(s\)/)
  assert.throws(() => normalizeEngines(['http://user:pw@10.0.0.1:8888']), /credentials/)
  assert.throws(() => normalizeEngines(['http://10.0.0.1:8888/metrics']), /bare origin/)
  assert.throws(() => normalizeEngines('http://10.0.0.1:8888'), /array/)
  assert.equal(normalizeEngines([]).length, 0)
  assert.ok(normalizeEngines(undefined).length === 3, '缺省三腿在册（本机形制）')
  assert.ok(DEFAULT_SAMPLE_STALE_MS > 0)
})
