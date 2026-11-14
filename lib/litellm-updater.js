// LITELLM-UPGRADE-UI-001: version card + audited upgrade flow for the LiteLLM inference gateway.
// The gateway serves every team's inference on :8888, so the upgrade button is deliberately heavy:
// double confirmation with an explicit outage acknowledgement, a fail-closed local-patch gate
// (the LITELLM-BALANCE-001 baseline archive must exist and match or the upgrade is blocked),
// pip-freeze backup before install, post-upgrade triple verification (version read-back, gateway
// health, patch gate re-check) and an automatic version-pinned rollback when verification fails.
// Every request and result lands in an append-only audit journal next to the state file.
import { spawn as spawnProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LITELLM_REPO = process.env.LITELLM_UPGRADE_REPO || 'BerriAI/litellm'
const RELEASES_LATEST_URL = `https://api.github.com/repos/${LITELLM_REPO}/releases/latest`
const RELEASES_LIST_URL = `https://api.github.com/repos/${LITELLM_REPO}/releases?per_page=15`
const WORKER_PATH = fileURLToPath(import.meta.url)
const CACHE_MS = 10 * 60 * 1000
const BUSY_STATES = new Set(['installing', 'restarting'])

const DEFAULT_VENV_DIR = path.join(
  os.homedir(),
  'Library', 'Application Support', 'DeepSeekHarnessMaintenance', 'litellm-20261022', 'venv',
)
const DEFAULT_LAUNCHD_LABEL = 'com.daibo.litellm.qwen8888'
const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8888'
const DEFAULT_MANIFEST = 'LITELLM-BALANCE-001.manifest.json'

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode })
}

function safeMessage(error) {
  return String(error?.message ?? error ?? 'unknown error').slice(0, 500)
}

function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.]+)?(?:\+[0-9A-Za-z.]+)?$/.exec(String(value ?? '').replace(/^v/, ''))
  if (!match) throw new Error(`invalid LiteLLM version: ${value}`)
  return match[0]
}

// Compare only the X.Y.Z core: published LiteLLM tags carry suffixes (-stable, -patch.1) that are
// distribution metadata, not semver precedence. Same core means "already up to date".
export function compareCoreVersions(left, right) {
  const a = parseVersion(left).split(/[+-]/)[0].split('.').map(Number)
  const b = parseVersion(right).split(/[+-]/)[0].split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}

function extractVersion(output) {
  const match = String(output).match(/\b(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.]+)?\b/)
  if (!match) throw new Error('无法从 litellm --version 输出读取版本号')
  return match[0]
}

async function md5File(file) {
  const hash = createHash('md5')
  hash.update(await readFile(file))
  return hash.digest('hex')
}

function atomicWriteJson(file, value) {
  return mkdir(path.dirname(file), { recursive: true, mode: 0o700 }).then(async () => {
    const temporary = `${file}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, file)
  })
}

function runFile(command, args, { env = process.env, cwd, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    let size = 0
    const collect = target => chunk => {
      if (size >= 65_536) return
      const limited = chunk.subarray(0, Math.max(0, 65_536 - size))
      target.push(limited)
      size += limited.length
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    timer.unref?.()
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }
      if (code === 0) resolve(result)
      else reject(new Error((result.stderr || result.stdout || `${command} exited ${code ?? signal}`).trim().slice(-1200)))
    })
  })
}

// The gate is fail-closed: no manifest, an unparseable manifest, a drifted file or a failing
// check all block the upgrade. The manifest is maintained by the model dispatcher (patch owner)
// under litellm_load/litellm_patch/ and declares the patched files (md5 baseline) plus the
// dry-run and behaviour commands that must exit 0.
export async function runPatchGate(manifestFile, runImpl = runFile) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        passed: false,
        blockedBy: 'missing-archive',
        reasons: [`补丁基线档案缺失（${path.basename(manifestFile)}）：升级已阻断，请先由补丁维护方建档后重试`],
        details: [],
      }
    }
    return { passed: false, blockedBy: 'bad-archive', reasons: [`补丁基线档案无法解析：${safeMessage(error)}`], details: [] }
  }
  const reasons = []
  const details = []
  if (manifest.noPatch === true) {
    // Explicit zero-patch declaration by the patch owner: the gate passes with the declaration
    // on record. Silence is still fail-closed — only a signed-off manifest unlocks this path.
    return { passed: true, reasons: [], declared: 'no-local-patch', note: String(manifest.reason || ''), details: [] }
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) reasons.push('补丁基线档案未声明目标文件')
  for (const entry of manifest.files || []) {
    if (!entry || typeof entry.path !== 'string') { reasons.push('补丁档案条目缺少 path'); continue }
    const target = path.isAbsolute(entry.path) ? entry.path : path.join(String(manifest.sitePackages || ''), entry.path)
    let actual
    try {
      actual = await md5File(target)
    } catch {
      reasons.push(`补丁目标文件不存在：${target}`)
      details.push({ target, ok: false, reason: 'missing' })
      continue
    }
    if (entry.patchedMd5 && actual !== entry.patchedMd5) {
      reasons.push(`补丁失效（目标文件与基线不符）：${target}`)
      details.push({ target, ok: false, reason: 'md5-mismatch', expected: entry.patchedMd5, actual })
    } else {
      // md5Declared=false = the manifest declares no baseline md5 for this file (the honest
      // pending-window state, e.g. BALANCE-001 before its install window): the gate passes, but
      // the upgrade confirm dialog surfaces that the patch is not verified on disk yet.
      details.push({ target, ok: true, md5Declared: Boolean(entry.patchedMd5) })
    }
  }
  for (const check of manifest.checks || []) {
    if (!check || !Array.isArray(check.command) || check.command.length === 0 || !check.command.every(arg => typeof arg === 'string')) {
      reasons.push(`补丁档案探针命令无效：${check?.name || '(unnamed)'}`)
      continue
    }
    try {
      await runImpl(check.command[0], check.command.slice(1), { cwd: check.cwd || manifest.cwd, timeoutMs: Number(check.timeoutMs) || 120_000 })
      details.push({ check: String(check.name || 'check'), ok: true })
    } catch (error) {
      reasons.push(`补丁探针失败：${check.name || 'check'}（${safeMessage(error)}）`)
      details.push({ check: String(check.name || 'check'), ok: false })
    }
  }
  if (!manifest.checks || manifest.checks.length < 2) reasons.push('补丁基线档案缺少干跑/行为测探针（至少两条 checks）')
  return { passed: reasons.length === 0, reasons, details }
}

async function pollUntil(probe, { deadlineMs, intervalMs = 2000 }) {
  const deadline = Date.now() + deadlineMs
  let lastError
  for (;;) {
    try {
      const value = await probe()
      if (value === true) return
      lastError = new Error(String(value ?? 'probe returned false'))
    } catch (error) { lastError = error }
    if (Date.now() >= deadline) throw lastError || new Error('probe timed out')
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

export class LitellmGatewayUpdater {
  constructor({ manager, logger, fetchImpl = globalThis.fetch, spawnImpl = spawnProcess, runImpl = runFile, existsImpl = existsSync, config = {} } = {}) {
    if (!manager?.root || !manager?.parentHome) throw new Error('a Headbot manager with root and parentHome is required')
    if (typeof fetchImpl !== 'function') throw new Error('fetch is not available for LiteLLM version checks')
    this.manager = manager
    this.logger = logger
    this.fetchImpl = fetchImpl
    this.spawnImpl = spawnImpl
    this.runImpl = runImpl
    this.existsImpl = existsImpl
    this.venvDir = config.venvDir || process.env.LITELLM_VENV_DIR || DEFAULT_VENV_DIR
    this.litellmBin = path.join(this.venvDir, 'bin', 'litellm')
    this.pipBin = config.pipBin || path.join(this.venvDir, 'bin', 'pip')
    // UI-003: this machine's venv is uv-created (pyvenv.cfg `uv = 0.13.1`) and ships WITHOUT pip —
    // a pip spawn died with `spawn …/venv/bin/pip ENOENT` at the first worker step. The installer
    // is therefore a plain command array, defaulting to the uv sitting beside the venv
    // (…/litellm-20261022/bin/uv) and only falling back to the classic in-venv pip when uv is
    // absent. installCmd carries the <target> placeholder; freezeCmd must stay read-only.
    this.uvBin = config.uvBin || path.join(path.dirname(this.venvDir), 'bin', 'uv')
    const venvPython = path.join(this.venvDir, 'bin', 'python')
    if (Array.isArray(config.installerCmd?.install) && Array.isArray(config.installerCmd?.freeze)) {
      this.installCmd = [...config.installerCmd.install]
      this.freezeCmd = [...config.installerCmd.freeze]
    } else if (this.existsImpl(this.uvBin)) {
      this.installCmd = [this.uvBin, 'pip', 'install', '--python', venvPython, 'litellm==<target>']
      this.freezeCmd = [this.uvBin, 'pip', 'freeze', '--python', venvPython]
    } else {
      this.installCmd = [this.pipBin, 'install', '--upgrade', 'litellm==<target>']
      this.freezeCmd = [this.pipBin, 'freeze']
    }
    this.launchdLabel = config.launchdLabel || process.env.LITELLM_LAUNCHD_LABEL || DEFAULT_LAUNCHD_LABEL
    if (!/^[A-Za-z0-9.-]+$/.test(this.launchdLabel)) throw new Error('launchdLabel is invalid')
    this.gatewayUrl = String(config.gatewayUrl || process.env.LITELLM_GATEWAY_URL || DEFAULT_GATEWAY_URL).replace(/\/+$/, '')
    // The key never enters argv, state, audit or logs; the worker re-reads it from its own env.
    this.gatewayKey = config.gatewayKey ?? process.env.LITELLM_MASTER_KEY ?? ''
    this.patchDir = config.patchDir || path.join(manager.parentHome, 'bot', 'workspace', 'litellm_load', 'litellm_patch')
    this.manifestFile = config.patchManifest || path.join(this.patchDir, DEFAULT_MANIFEST)
    this.stateFile = path.join(manager.root, 'litellm-update-state.json')
    this.auditFile = path.join(manager.root, 'litellm-upgrade-audit.jsonl')
    this.logFile = path.join(manager.root, 'litellm-update.log')
    this.backupRoot = path.join(manager.root, 'updates')
    this.cache = new Map()
    this.checking = new Map()
  }

  async check({ force = false } = {}) {
    const [current, release] = await Promise.all([this.readCurrentVersion(), this.fetchLatestRelease(force).catch(error => ({ error: safeMessage(error) }))])
    const gate = await runPatchGate(this.manifestFile, this.runImpl)
    let updateState = await this.readState()
    if (updateState && BUSY_STATES.has(updateState.state) && current.version && current.version === updateState.targetVersion) {
      updateState = { ...updateState, state: 'completed', message: `已升级到 LiteLLM ${current.version}`, completedAt: new Date().toISOString() }
      await this.writeState(updateState)
    }
    const state = updateState?.state || 'idle'
    const busy = BUSY_STATES.has(state)
    const latestVersion = release?.version || null
    const updateAvailable = Boolean(current.version && latestVersion && compareCoreVersions(latestVersion, current.version) > 0)
    let upgradeError = null
    if (!updateAvailable) upgradeError = null
    else if (busy) upgradeError = '升级已在进行中'
    else if (!gate.passed) upgradeError = `补丁闸门未通过：${gate.reasons.join('；')}`
    else if (!this.canRestart()) upgradeError = '当前环境无法通过 launchd 重启网关，无法安全升级'
    return {
      currentVersion: current.version || null,
      currentError: current.error || null,
      latestVersion,
      releaseUrl: release?.url || null,
      checkedAt: this.cache.get('litellm-release') ? new Date(this.cache.get('litellm-release').checkedAt).toISOString() : null,
      checkError: release?.error || null,
      updateAvailable,
      state,
      message: updateState?.message || '',
      targetVersion: updateState?.targetVersion || null,
      gate,
      canUpgrade: Boolean(updateAvailable && !busy && gate.passed && this.canRestart()),
      upgradeError,
    }
  }

  canRestart() {
    return process.platform === 'darwin' && typeof process.getuid === 'function'
  }

  async readCurrentVersion() {
    try {
      const output = await this.runImpl(this.litellmBin, ['--version'], { timeoutMs: 30_000 })
      return { version: extractVersion(`${output.stdout}\n${output.stderr}`) }
    } catch (error) {
      return { version: null, error: safeMessage(error) }
    }
  }

  async fetchLatestRelease(force) {
    const key = 'litellm-release'
    const cached = this.cache.get(key)
    if (!force && cached && Date.now() - cached.checkedAt < CACHE_MS) return cached.release
    let pending = this.checking.get(key)
    if (!pending) {
      pending = this.fetchUpstreamRelease().then(release => {
        this.cache.set(key, { release, checkedAt: Date.now() })
        return release
      }).finally(() => this.checking.delete(key))
      this.checking.set(key, pending)
    }
    return pending
  }

  async fetchUpstreamRelease() {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'ds-headbot/litellm-version-check' }
    if (process.env.LITELLM_UPGRADE_GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.LITELLM_UPGRADE_GITHUB_TOKEN}`
    let response
    try {
      response = await this.fetchImpl(RELEASES_LATEST_URL, { headers, signal: AbortSignal.timeout(10_000) })
    } catch (error) {
      throw new Error(`GitHub 上游检查失败：${safeMessage(error)}`)
    }
    if (response.status === 403 || response.status === 429) throw new Error('GitHub API 限流，请稍后手动刷新或配置 LITELLM_UPGRADE_GITHUB_TOKEN')
    let candidate = null
    if (response.ok) {
      const release = await response.json().catch(() => null)
      if (release && !release.draft && !release.prerelease && typeof release.tag_name === 'string') candidate = release
    }
    if (!candidate) {
      // releases/latest is absent when the newest entries are drafts/prereleases; fall back to
      // the list and take the newest entry with a parseable stable tag.
      const listResponse = await this.fetchImpl(RELEASES_LIST_URL, { headers, signal: AbortSignal.timeout(10_000) })
      if (!listResponse.ok) {
        if (listResponse.status === 403 || listResponse.status === 429) throw new Error('GitHub API 限流，请稍后手动刷新或配置 LITELLM_UPGRADE_GITHUB_TOKEN')
        throw new Error(`GitHub releases 返回 HTTP ${listResponse.status}`)
      }
      const releases = await listResponse.json().catch(() => null)
      if (!Array.isArray(releases)) throw new Error('GitHub 返回了无效的 releases 列表')
      candidate = releases.find(release => release && !release.draft && !release.prerelease && typeof release.tag_name === 'string')
    }
    if (!candidate) throw new Error('GitHub 未返回可用的 LiteLLM 正式发布')
    return { version: parseVersion(candidate.tag_name), url: candidate.html_url || `https://github.com/${LITELLM_REPO}/releases` }
  }

  async startUpgrade(input = {}, actor = undefined) {
    if (!this.canRestart()) throw httpError(501, '当前平台不支持通过 launchd 安全重启网关，无法升级')
    if (input.acknowledgeOutage !== true) throw httpError(400, '升级需要二次确认：请先确认已知晓 8888 推理网关将短暂断流')
    if (typeof input.targetVersion !== 'string' || !input.targetVersion.trim()) throw httpError(400, '缺少目标版本')
    const status = await this.check({ force: true })
    if (status.checkError) throw httpError(503, `检查 LiteLLM 最新版本失败：${status.checkError}`)
    if (!status.currentVersion) throw httpError(503, `无法读取当前 LiteLLM 版本：${status.currentError || '未知原因'}`)
    if (parseVersion(input.targetVersion) !== status.latestVersion) throw httpError(409, '目标版本与最新版本不一致，请重新检查后再确认')
    if (BUSY_STATES.has(status.state)) throw httpError(409, 'LiteLLM 升级已在进行中')
    if (!status.updateAvailable) throw httpError(409, '当前已经是最新版本')
    if (!status.gate.passed) {
      await this.appendAudit({ action: 'upgrade-blocked', actor: actor?.id || 'admin-page', from: status.currentVersion, to: status.latestVersion, result: 'blocked', gate: { blockedBy: status.gate.blockedBy || 'gate', reasons: status.gate.reasons } })
      throw httpError(409, `本地补丁闸门未通过，升级已阻断：${status.gate.reasons.join('；')}`)
    }
    const backupDir = path.join(this.backupRoot, `litellm-${status.latestVersion}-${Date.now()}`)
    const config = {
      litellmBin: this.litellmBin,
      installCmd: [...this.installCmd],
      freezeCmd: [...this.freezeCmd],
      launchdLabel: this.launchdLabel,
      uid: process.getuid(),
      gatewayUrl: this.gatewayUrl,
      manifestFile: this.manifestFile,
      targetVersion: status.latestVersion,
      currentVersion: status.currentVersion,
      stateFile: this.stateFile,
      auditFile: this.auditFile,
      logFile: this.logFile,
      backupDir,
    }
    await this.appendAudit({ action: 'upgrade-request', actor: actor?.id || 'admin-page', from: status.currentVersion, to: status.latestVersion, result: 'started', gate: { passed: true } })
    await this.writeState({ state: 'installing', targetVersion: status.latestVersion, startedAt: new Date().toISOString(), message: `正在安装 LiteLLM ${status.latestVersion}（安装期间网关不中断）` })
    let child
    try {
      child = this.spawnImpl(process.execPath, [WORKER_PATH, JSON.stringify(config)], {
        cwd: this.manager.parentHome,
        env: { ...process.env },
        detached: true,
        stdio: 'ignore',
      })
      child.once('error', error => { void this.markFailure(status.latestVersion, safeMessage(error)) })
      child.once('exit', (code, signal) => {
        if (code !== 0) void this.markFailure(status.latestVersion, `升级后台任务异常退出（${code ?? signal ?? 'unknown'}）`)
      })
      child.unref()
    } catch (error) {
      await this.writeState({ state: 'failed', targetVersion: status.latestVersion, message: safeMessage(error), failedAt: new Date().toISOString() })
      await this.appendAudit({ action: 'upgrade-failed', from: status.currentVersion, to: status.latestVersion, result: 'failed', reason: safeMessage(error), rolledBack: false })
      throw httpError(500, `无法启动 LiteLLM 升级：${safeMessage(error)}`)
    }
    this.logger?.info?.(`[ds-headbot] started LiteLLM gateway update to ${status.latestVersion}`)
    return { state: 'installing', targetVersion: status.latestVersion, message: '正在安装并重启网关；升级期间推理请求可能短暂失败，进度见审计日志' }
  }

  async markFailure(targetVersion, message) {
    try {
      const state = await this.readState()
      if (state?.targetVersion !== targetVersion || !BUSY_STATES.has(state.state)) return
      await this.writeState({ ...state, state: 'failed', message: safeMessage(message), failedAt: new Date().toISOString() })
      await this.appendAudit({ action: 'upgrade-failed', to: targetVersion, from: state.currentVersion ?? null, result: 'failed', reason: safeMessage(message), rolledBack: false })
    } catch (error) {
      this.logger?.error?.(`[ds-headbot] unable to record LiteLLM updater failure: ${safeMessage(error)}`)
    }
  }

  async appendAudit(event) {
    await mkdir(path.dirname(this.auditFile), { recursive: true, mode: 0o700 })
    await appendFile(this.auditFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 })
  }

  async recentAudit(limit = 20) {
    const bounded = Math.min(Math.max(Number(limit) || 20, 1), 200)
    let text = ''
    try { text = await readFile(this.auditFile, 'utf8') } catch (error) { if (error.code === 'ENOENT') return []; throw error }
    return text.split(/\r?\n/).filter(Boolean).slice(-bounded).reverse()
      .map(line => { try { return JSON.parse(line) } catch { return { at: null, action: 'unparseable', result: 'unknown' } } })
  }

  async readProgressTail(bytes = 8192) {
    try {
      const buffer = await readFile(this.logFile)
      return buffer.subarray(Math.max(0, buffer.length - bytes)).toString('utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return ''
      throw error
    }
  }

  async readState() {
    try { return JSON.parse(await readFile(this.stateFile, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
  }

  writeState(value) {
    return atomicWriteJson(this.stateFile, value)
  }
}

async function writeWorkerState(file, patch) {
  let previous = {}
  try { previous = JSON.parse(await readFile(file, 'utf8')) } catch {}
  await atomicWriteJson(file, { ...previous, ...patch, updatedAt: new Date().toISOString() })
}

// The detached worker owns the whole install → restart → verify → (rollback) sequence so the
// request path never blocks on pip. Verification failure rolls back to the pinned old version.
export async function performLitellmUpgrade(config, dependencies = {}) {
  const runCommand = dependencies.runCommand || runFile
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch
  const gateRunner = dependencies.patchGate || runPatchGate
  const now = () => new Date().toISOString()
  const log = async line => {
    try {
      await mkdir(path.dirname(config.logFile), { recursive: true, mode: 0o700 })
      await appendFile(config.logFile, `[${now()}] ${line}\n`, { mode: 0o600 })
    } catch {}
  }
  const audit = async event => {
    try {
      await mkdir(path.dirname(config.auditFile), { recursive: true, mode: 0o700 })
      await appendFile(config.auditFile, `${JSON.stringify({ at: now(), ...event })}\n`, { mode: 0o600 })
    } catch {}
  }
  const setState = (state, message) => writeWorkerState(config.stateFile, { state, targetVersion: config.targetVersion, message })
  const restartGateway = () => runCommand('/bin/launchctl', ['kickstart', '-k', `gui/${config.uid}/${config.launchdLabel}`], { timeoutMs: 60_000 })
  const probeVersion = async expected => {
    const output = await runCommand(config.litellmBin, ['--version'], { timeoutMs: 30_000 })
    return extractVersion(`${output.stdout}\n${output.stderr}`) === expected
  }
  const probeGateway = async () => {
    const headers = {}
    const key = process.env.LITELLM_MASTER_KEY || ''
    if (key) headers.Authorization = `Bearer ${key}`
    const url = key ? `${config.gatewayUrl}/v1/models` : `${config.gatewayUrl}/health/liveliness`
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(5_000) })
    return response.status === 200
  }
  const startedAt = now()
  const healthDeadlineMs = Number(config.healthDeadlineMs) || 120_000
  // UI-003 compat: a worker configured by an older shape (pipBin only) is lifted to command arrays.
  if (!config.installCmd && config.pipBin) {
    config.installCmd = [config.pipBin, 'install', '--upgrade', 'litellm==<target>']
    config.freezeCmd = [config.pipBin, 'freeze']
  }
  // Run the generalized installer: <target> placeholder filled from the pinned version; a command
  // without the placeholder gets `litellm==<version>` appended as the final element.
  const installerRun = (argv, version, timeoutMs) => {
    const filled = argv.map(token => String(token).replace('<target>', version))
    if (!argv.some(token => String(token).includes('<target>'))) filled.push(`litellm==${version}`)
    return runCommand(filled[0], filled.slice(1), { timeoutMs })
  }
  // UI-003 pre-spawn existence preflight: every distinct installer head must answer --version,
  // otherwise we fail before touching anything (uv-created venvs have no pip: the ENOENT lesson).
  const preflightInstaller = async () => {
    const heads = [...new Set([config.freezeCmd?.[0], config.installCmd?.[0]].filter(Boolean))]
    if (!heads.length) throw new Error('installer command has no executable head element')
    for (const head of heads) {
      try { await runCommand(head, ['--version'], { timeoutMs: 30_000 }) }
      catch (error) { throw new Error(`安装命令预检失败：${head} 无法执行（--version 冒烟）：${safeMessage(error)}`) }
    }
  }
  let changesStarted = false
  try {
    await mkdir(config.backupDir, { recursive: true, mode: 0o700 })
    await setState('installing', `正在安装 LiteLLM ${config.targetVersion}（安装期间网关不中断）`)
    await log(`upgrade start: ${config.currentVersion} -> ${config.targetVersion}`)
    await preflightInstaller()
    await log('installer preflight ok')
    const freeze = await runCommand(config.freezeCmd[0], config.freezeCmd.slice(1), { timeoutMs: 120_000 })
    await writeFile(path.join(config.backupDir, 'pip-freeze-before.txt'), freeze.stdout, { mode: 0o600 })
    await log(`pip freeze snapshot saved: ${path.join(config.backupDir, 'pip-freeze-before.txt')}`)
    const install = await installerRun(config.installCmd, config.targetVersion, 20 * 60_000)
    changesStarted = true
    await log(`pip install done: ${String(install.stdout || '').split(/\r?\n/).slice(-3).join(' | ').slice(0, 400)}`)

    await setState('restarting', '正在重启网关（launchd kickstart）')
    await restartGateway()
    await log('gateway kickstart issued')

    await setState('restarting', '后置三验：版本回读 / 网关健康 / 补丁复核')
    await pollUntil(() => probeVersion(config.targetVersion), { deadlineMs: 90_000 })
    await log(`verify 1/3 ok: version read-back ${config.targetVersion}`)
    await pollUntil(probeGateway, { deadlineMs: healthDeadlineMs })
    await log('verify 2/3 ok: gateway health 200')
    const gate = await gateRunner(config.manifestFile, runCommand)
    if (!gate.passed) throw new Error(`补丁三连复核未通过：${gate.reasons.join('；')}`)
    await log('verify 3/3 ok: patch gate re-check passed')

    await setState('completed', `已升级到 LiteLLM ${config.targetVersion}`)
    await audit({ action: 'upgrade-completed', from: config.currentVersion, to: config.targetVersion, result: 'completed', startedAt })
  } catch (error) {
    const reason = safeMessage(error)
    if (!changesStarted) {
      // UI-003: nothing was mutated (the classic shape is the installer binary itself missing).
      // A rollback would only hit the same spawn wall a second time — record honestly instead.
      await log(`upgrade failed before any change: ${reason}; nothing to roll back`)
      await setState('failed', `升级失败：${reason}（发生在任何变更之前，无需回退，现装版本未动）`)
      await audit({ action: 'upgrade-failed', from: config.currentVersion, to: config.targetVersion, result: 'failed', reason, rolledBack: false, noChanges: true, startedAt })
      process.exitCode = 1
      return
    }
    await log(`upgrade failed: ${reason}; rolling back to ${config.currentVersion}`)
    let rolledBack = false
    let rollbackReason = ''
    try {
      await installerRun(config.installCmd, config.currentVersion, 20 * 60_000)
      await restartGateway()
      await pollUntil(() => probeVersion(config.currentVersion), { deadlineMs: 90_000 })
      await pollUntil(probeGateway, { deadlineMs: healthDeadlineMs })
      rolledBack = true
      await log(`rollback ok: gateway back on ${config.currentVersion}`)
    } catch (rollbackError) {
      rollbackReason = safeMessage(rollbackError)
      await log(`rollback failed: ${rollbackReason}`)
    }
    await setState('failed', `升级失败：${reason}${rolledBack ? `；已回退到 ${config.currentVersion}` : `；自动回退失败：${rollbackReason}`}`)
    await audit({ action: 'upgrade-failed', from: config.currentVersion, to: config.targetVersion, result: 'failed', reason, rolledBack, rollbackReason: rollbackReason || null, startedAt })
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.argv[2]) {
  let config
  try { config = JSON.parse(process.argv[2]) } catch { throw new Error('invalid LiteLLM update worker configuration') }
  void performLitellmUpgrade(config)
}
