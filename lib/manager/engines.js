// ENGINE-QUEUE-001: manager-side wiring of the engine criteria readings. The judgement rules
// themselves are pure functions in lib/engines-observe.js (so they can be locked by tests); this
// file only owns the probes, their budget, the sample history the criteria need, and the last-known
// report. Every probe is read-only against the engines' /metrics and one journal tail — it never
// writes to the engine side, never restarts anything, and never throws at the caller: a broken
// observation must not break the management page that reads it.
import path from 'node:path'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  DEFAULT_ENGINE_CACHE_MS,
  DEFAULT_ENGINE_PROBE_TIMEOUT_MS,
  DEFAULT_META_TAIL_BYTES,
  DEFAULT_SAMPLE_STALE_MS,
  FROZEN_CONSECUTIVE_SAMPLES,
  INSTANT_REJECT_MAX_MS,
  QUEUE_JAM_WAITING,
  QUEUE_WARN_WAITING,
  deriveQueue,
  deriveSaturation,
  detectFrozen,
  parseEngineGauges,
  summarizeInstantRejections,
} from '../engines-observe.js'
import { ignoreFailureOnce } from '../observe.js'

// 本机三台引擎直连（实测带钥 200 / 17.5–21.1 ms / 五枚 gauge 俱在）。config.engines 或
// HEADBOT_ENGINES 可整体覆写；置空则判据如实报 unknown，不编数。
export const DEFAULT_ENGINE_URLS = ['http://192.168.2.9:8888', 'http://192.168.2.159:8888', 'http://192.168.2.204:8888']
export const DEFAULT_ENGINE_KEY_FILE = 'litellm_load/engine.key'
export const DEFAULT_ENGINE_META_FILE = path.join(homedir(), 'ai', 'litellm', 'qwen-8888', 'request_meta.jsonl')
const MAX_ENGINES = 16
const HISTORY_LENGTH = 6

function normalizeEngine(entry, index) {
  const raw = typeof entry === 'string' ? { url: entry } : (entry ?? {})
  const url = new URL(String(raw.url ?? ''))
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`engine "${raw.url}" must be an http(s) URL`)
  if (url.username || url.password) throw new Error(`engine "${raw.url}" must not carry credentials`)
  if (url.search !== '' || (url.pathname !== '/' && url.pathname !== '')) throw new Error(`engine "${raw.url}" must be a bare origin`)
  const id = String(raw.id ?? url.hostname).trim()
  if (!id || id.length > 64) throw new Error(`engine "${raw.url}" needs a usable id`)
  return { id, url: url.origin, index }
}

export function normalizeEngines(configured) {
  const list = configured ?? DEFAULT_ENGINE_URLS
  if (!Array.isArray(list)) throw new Error('engines must be an array of URLs or {id,url} objects')
  if (list.length > MAX_ENGINES) throw new Error(`engines must declare at most ${MAX_ENGINES} entries`)
  return list.map((entry, index) => normalizeEngine(entry, index))
}

export const enginesMethods = {
  // TTL cache + in-flight coalescing（案④ 同形制）：卡面/巡检抢开只打一次网络。
  async observeEngines({ force = false } = {}) {
    const now = this.engineNow()
    if (!force && this.engineReport && now - this.engineReport.at < this.engineCacheMs) {
      return { ...this.engineReport, cached: true }
    }
    if (this.enginePending) return this.enginePending
    this.enginePending = this.collectEngines(now).finally(() => { this.enginePending = undefined })
    return this.enginePending
  },

  async collectEngines(now) {
    const key = await this.readEngineKey()
    const probed = await Promise.all(this.engines.map(async engine => this.probeEngine(engine, key)))
    for (const probe of probed) {
      if (!probe.ok) continue
      const history = this.engineSamples.get(probe.id) ?? []
      // 只把成功的拍送进历史：一次探针失败既不该被读成"没冻结"也不该被读成"冻结"，
      // 连续性判断交给 staleMs 断档重置（见 engines-observe.js 的 consecutive）。
      history.push({ ts: now, running: probe.gauges.running, waiting: probe.gauges.waiting, generationTokens: probe.gauges.generationTokens })
      this.engineSamples.set(probe.id, history.slice(-HISTORY_LENGTH))
    }
    // lastGood+stale：出窗的陈拍不送进判据——"三分钟前的 waiting"不得被读成"现在的 waiting"。
    // 原始历史仍留着（连续性判断归纯函数的 staleMs 断档重置）。
    const staleMs = this.engineThresholds.staleMs
    const samplesPerEngine = {}
    for (const [id, history] of this.engineSamples) samplesPerEngine[id] = history.filter(sample => now - sample.ts <= staleMs)
    const reachable = probed.filter(probe => probe.ok).length
    const frozen = []
    for (const [id, history] of Object.entries(samplesPerEngine)) {
      const verdict = detectFrozen(history, { needed: this.engineThresholds.frozenSamples, staleMs: this.engineThresholds.staleMs })
      if (verdict) frozen.push({ id, ...verdict })
    }
    // 阈值名在此显式映射给纯函数（warnWaiting→warnAt 等）：让 config 覆写真的接得上，
    // 不靠纯函数自己的缺省值兜着——那样覆写会静默失效。
    const queueCriteria = deriveQueue(samplesPerEngine, {
      warnAt: this.engineThresholds.warnWaiting,
      jamAt: this.engineThresholds.jamWaiting,
      staleMs: this.engineThresholds.staleMs,
    })
    const report = {
      at: now,
      cached: false,
      engines: probed.map(({ probeFnMs, ...rest }) => ({
        ...rest,
        // 探针断的拍不抛：该腿判据值来自 lastGood，stale 如实标注（读数腿断了要让观察线看见）。
        stale: !rest.ok,
        lastGoodTs: this.engineSamples.get(rest.id)?.at(-1)?.ts ?? null,
      })),
      criteria: {
        // 一台都探不到时不得冒充判据：如实 unknown，让观察线看得见"读数腿断了"。
        queue: reachable ? queueCriteria.queue : 'unknown',
        queueDepth: queueCriteria.queueDepth,
        saturation: deriveSaturation(samplesPerEngine),
        frozen,
        // 冻结告警权威源=jamwatch v3（模型调度域）；这里 frozenSince 是数据不是警报。
        frozenAuthority: 'jamwatch v3 (model dispatcher)',
        instantRejects: await this.readEngineMetaSummary(),
      },
      thresholds: { ...this.engineThresholds },
      keyAvailable: key !== null,
      configuredEngines: this.engines.length,
      reachable,
    }
    this.engineReport = report
    return { ...report }
  },

  async probeEngine(engine, key) {
    const startedAt = this.engineNow()
    const headers = {}
    if (key) headers.Authorization = `Bearer ${key}`
    try {
      const response = await this.fetchImpl(`${engine.url}/metrics`, { headers, signal: AbortSignal.timeout(this.engineProbeTimeoutMs) })
      if (!response?.ok) {
        return { id: engine.id, url: engine.url, ok: false, error: `http ${response?.status ?? '?'}`, gauges: {}, probeFnMs: this.engineNow() - startedAt }
      }
      const gauges = parseEngineGauges(String(await response.text()))
      return { id: engine.id, url: engine.url, ok: true, gauges, probeFnMs: this.engineNow() - startedAt }
    } catch (error) {
      ignoreFailureOnce(this.logger, 'engines', `probe ${engine.id}`, error)
      return { id: engine.id, url: engine.url, ok: false, error: String(error?.message ?? error).slice(0, 160), gauges: {}, probeFnMs: this.engineNow() - startedAt }
    }
  },

  async readEngineKey() {
    if (this.engineKeyValue !== undefined) return this.engineKeyValue
    let handle
    try {
      // 本运行时 node 的 FileHandle 无 readBuffer（原型方法表亲验），只有 read——用 read。
      handle = await open(this.engineKeyFile, 'r')
      const buffer = Buffer.alloc(256)
      const { bytesRead } = await handle.read(buffer, 0, 256, 0)
      const value = buffer.toString('utf8', 0, bytesRead).trim()
      this.engineKeyValue = value || null
    } catch (error) {
      ignoreFailureOnce(this.logger, 'engines', `read engine key ${this.engineKeyFile}`, error)
      this.engineKeyValue = null
    } finally {
      await handle?.close().catch(() => {})
    }
    return this.engineKeyValue
  },

  // 瞬拒率取数腿：只读 request_meta.jsonl 的尾部若干字节（跨域只读，经总务 11-19 裁可），
  // 不改写不外发；读不到就如实 unavailable，判据其余部分照常。
  async readEngineMetaSummary() {
    if (!this.engineMetaFile) return { available: false, reason: 'meta file not configured' }
    let handle
    try {
      handle = await open(this.engineMetaFile, 'r')
      const { size } = await handle.stat()
      const bytes = Math.min(size, this.engineMetaTailBytes)
      const buffer = Buffer.alloc(bytes)
      const { bytesRead } = await handle.read(buffer, 0, bytes, Math.max(0, size - bytes))
      const text = buffer.toString('utf8', 0, bytesRead)
      const lines = (size > bytes ? text.slice(text.indexOf('\n') + 1) : text).split('\n')
      return summarizeInstantRejections(lines, { maxDurationMs: this.engineThresholds.instantRejectMaxMs })
    } catch (error) {
      ignoreFailureOnce(this.logger, 'engines', `read meta tail ${this.engineMetaFile}`, error)
      return { available: false, reason: String(error?.code ?? error?.message ?? error).slice(0, 120) }
    } finally {
      await handle?.close().catch(() => {})
    }
  },
}

export function engineDefaults(config = {}, manager = {}) {
  const env = process.env
  const numbers = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : undefined)
  const configured = config.engines ?? env.HEADBOT_ENGINES?.split(',').map(item => item.trim()).filter(Boolean)
  return {
    engines: normalizeEngines(configured === undefined || configured === '' ? undefined : configured),
    engineProbeTimeoutMs: numbers(config.engineProbeTimeoutMs) ?? numbers(env.HEADBOT_ENGINE_PROBE_TIMEOUT_MS) ?? DEFAULT_ENGINE_PROBE_TIMEOUT_MS,
    engineCacheMs: numbers(config.engineCacheMs) ?? numbers(env.HEADBOT_ENGINE_CACHE_MS) ?? DEFAULT_ENGINE_CACHE_MS,
    engineMetaTailBytes: numbers(config.engineMetaTailBytes) ?? numbers(env.HEADBOT_ENGINE_META_TAIL_BYTES) ?? DEFAULT_META_TAIL_BYTES,
    engineKeyFile: config.engineKeyFile || env.HEADBOT_ENGINE_KEY_FILE || path.join(manager.parentHome ?? '', 'bot', 'workspace', DEFAULT_ENGINE_KEY_FILE),
    engineMetaFile: config.engineMetaFile === '' ? null : (config.engineMetaFile || env.HEADBOT_ENGINE_META_FILE || DEFAULT_ENGINE_META_FILE),
    engineThresholds: {
      instantRejectMaxMs: numbers(config.engineInstantRejectMaxMs) ?? INSTANT_REJECT_MAX_MS,
      warnWaiting: numbers(config.engineQueueWarn) ?? QUEUE_WARN_WAITING,
      jamWaiting: numbers(config.engineQueueJam) ?? QUEUE_JAM_WAITING,
      frozenSamples: numbers(config.engineFrozenSamples) ?? FROZEN_CONSECUTIVE_SAMPLES,
      staleMs: numbers(config.engineSampleStaleMs) ?? DEFAULT_SAMPLE_STALE_MS,
    },
    engineNow: config.engineNow ?? (() => Date.now()),
  }
}
