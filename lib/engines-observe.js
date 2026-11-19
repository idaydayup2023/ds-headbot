// ENGINE-QUEUE-001 (0.4.28 批 · 案⑦): 引擎队列深度判据与它的读数面。
//
// 为什么要有这件事：两枚活体标本都被读成"引擎跑死了"，而它们都不是。我亲自扫网关自己的请求
// 账（request_meta.jsonl 全档 36 902 行，2026-11-19 直读）得到的形制是：92 枚
// `No deployments available` 的 duration_ms **全等于 0**，而那些时刻三台引擎的
// running=0 / waiting=0 —— 只看队列深度的判据恰好在"路由在拒工"的那一刻读成"空闲健康"。
// 所以这里的判据把引擎仪表与**瞬拒率**成对给出，队列深度单独一枚不成立。
//
// 分工（模型调度点名"别双打"）：冻结（gen Δ=0）的**告警权威源=jamwatch v3**（模型调度域）。
// 本模块只报数 + 带 `frozenSince` 标注，不发第二枚告警。

export const ENGINE_GAUGES = {
  running: 'tensorfold:requests_running',
  waiting: 'tensorfold:requests_waiting',
  generationTokens: 'tensorfold:generation_tokens_running',
  numRunning: 'tensorfold:num_requests_running',
  numWaiting: 'tensorfold:num_requests_waiting',
}

// 三台引擎直连 /metrics 实测 17.5–21.1 ms（带钥），3 s 已是 150 倍余量；网关 /health 那条慢腿
// （带钥 ~60 s，案④ 刚治过）与此完全两路，不得共用预算。
export const DEFAULT_ENGINE_PROBE_TIMEOUT_MS = 3_000
export const DEFAULT_ENGINE_CACHE_MS = 10_000
export const DEFAULT_META_TAIL_BYTES = 256 * 1024
// 相邻两拍的间隔超过这个数就不算"连续拍"：判据靠连续性说话，采样断了必须重置而不是硬连。
export const DEFAULT_SAMPLE_STALE_MS = 120_000

// 判据阈值（口径唯一出处，观察线不得各自解释；全部可 config 覆）。
export const INSTANT_REJECT_MAX_MS = 50
export const QUEUE_WARN_WAITING = 2
export const QUEUE_JAM_WAITING = 5
export const FROZEN_CONSECUTIVE_SAMPLES = 3

const GAUGE_BY_NAME = new Map(Object.entries(ENGINE_GAUGES).map(([field, name]) => [name, field]))

// Prometheus 文本里同一枚 gauge 可能带标签重复出现；取最后一次出现，非有限数或负数视为缺失。
export function parseEngineGauges(text) {
  const gauges = { running: null, waiting: null, generationTokens: null, numRunning: null, numWaiting: null }
  if (typeof text !== 'string') return gauges
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const split = trimmed.indexOf(' ')
    if (split <= 0) continue
    const name = trimmed.slice(0, split).replace(/\{[^}]*\}$/, '')
    const field = GAUGE_BY_NAME.get(name)
    if (!field) continue
    const value = Number(trimmed.slice(split + 1).trim())
    gauges[field] = Number.isFinite(value) && value >= 0 ? value : null
  }
  return gauges
}

function consecutive(list, { staleMs }) {
  // 只保留可用于连续性判断的拍：三个读数齐为数字、且与前一拍的间隔在 staleMs 内。
  const usable = []
  for (const sample of list) {
    if (!sample || typeof sample.ts !== 'number') continue
    if (![sample.running, sample.waiting, sample.generationTokens].every(value => typeof value === 'number')) continue
    if (usable.length && sample.ts - usable.at(-1).ts > staleMs) usable.length = 0
    usable.push(sample)
  }
  return usable
}

// 冻结：gen 不推进 **且 running>0** 连续 ≥N 拍。必须带 running>0 这条件——今晨 .159 的
// 空载时刻 running=0、gen 恒 0，缺此条件会把"没活干"误判成"卡死"。
export function detectFrozen(samples, { needed = FROZEN_CONSECUTIVE_SAMPLES, staleMs = DEFAULT_SAMPLE_STALE_MS } = {}) {
  const usable = consecutive(samples, { staleMs })
  if (usable.length < needed) return null
  const window = usable.slice(-needed)
  let since = null
  for (let index = 1; index < window.length; index += 1) {
    const before = window[index - 1]
    const now = window[index]
    const held = now.generationTokens === before.generationTokens && now.running > 0
    if (!held) return null
    since ??= before.ts
  }
  return { since, samples: window.length, at: window.at(-1).ts }
}

// 瞬拒率：status=failure 且 duration_ms<上限 的占比。形制靶=那 92 枚零时长
// `No deployments available`；反过来长尾（p90=215s/max=273s）不得被算进来，故阈值很小。
export function summarizeInstantRejections(lines, { maxDurationMs = INSTANT_REJECT_MAX_MS } = {}) {
  const summary = { available: true, rows: 0, failures: 0, instantRejects: 0, share: null, malformed: 0, maxDurationMs }
  for (const line of lines ?? []) {
    const trimmed = typeof line === 'string' ? line.trim() : ''
    if (!trimmed) continue
    let row
    try {
      row = JSON.parse(trimmed)
    } catch {
      summary.malformed += 1
      continue
    }
    if (!row || typeof row !== 'object') { summary.malformed += 1; continue }
    summary.rows += 1
    if (row.status !== 'failure') continue
    summary.failures += 1
    const duration = row.duration_ms
    if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 && duration < maxDurationMs) summary.instantRejects += 1
  }
  summary.share = summary.failures ? Number((summary.instantRejects / summary.failures).toFixed(4)) : null
  return summary
}

// 队列三档：ok 全腿 waiting≤1；warn 任一腿 ≥QUEUE_WARN_WAITING；jam 任一腿 ≥QUEUE_JAM_WAITING
// **连续两拍**（单拍毛刺不算 jam，避免一次采样抖动就报拥塞）。
export function deriveQueue(samplesPerEngine, { warnAt = QUEUE_WARN_WAITING, jamAt = QUEUE_JAM_WAITING, staleMs = DEFAULT_SAMPLE_STALE_MS } = {}) {
  const perEngine = {}
  let max = 0
  let leg = null
  let jamLeg = null
  for (const [id, samples] of Object.entries(samplesPerEngine ?? {})) {
    const usable = consecutive(samples, { staleMs })
    const current = usable.at(-1)
    const waiting = current?.waiting ?? null
    perEngine[id] = waiting
    if (typeof waiting !== 'number') continue
    if (waiting > max) { max = waiting; leg = id }
    if (waiting >= jamAt && usable.length >= 2 && typeof usable.at(-2)?.waiting === 'number' && usable.at(-2).waiting >= jamAt) jamLeg ??= id
  }
  const queue = jamLeg ? 'jam' : max >= warnAt ? 'warn' : 'ok'
  return { queue, queueDepth: { max, leg, perEngine } }
}

// 饱和位：逐腿 max_parallel_requests 全未设（模型调度域事实），所以**没有静态上限可对**，
// 只报观测到的并发位并如实标 noDeclaredCap——不去编一个阈值冒充判据。
export function deriveSaturation(samplesPerEngine) {
  let max = null
  let leg = null
  for (const [id, samples] of Object.entries(samplesPerEngine ?? {})) {
    const current = consecutive(samples, { staleMs: DEFAULT_SAMPLE_STALE_MS }).at(-1)
    const running = current?.running
    if (typeof running !== 'number') continue
    if (max === null || running > max) { max = running; leg = id }
  }
  return { maxRunning: max, leg, noDeclaredCap: true }
}
