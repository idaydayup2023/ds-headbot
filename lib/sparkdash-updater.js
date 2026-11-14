// SPARKDASH-UI-001: version card + audited upgrade flow for the local sparkDash dashboard.
// Upstream (MiaAI-Lab/sparkDash) publishes no releases or tags, so this card speaks commit-level
// truth only: upstream HEAD via `git ls-remote` versus the local checkout commit, and "up to date"
// is claimed ONLY when the two 40-char SHAs are byte-identical (green copy: "HEAD 一致"). There is
// deliberately no semver path — no tag means no version equality may ever be fabricated.
// The local deployment shape (checkout path, pull/npm ci/restart commands) belongs to the model
// dispatcher's SPARKDASH-LOCAL-001 runbook. Until that plan arrives the upgrade stays fail-closed
// behind a missing-plan gate, and the card honestly reports 未部署/待实况单 when the checkout is absent.
// The dirty-worktree gate blocks any upgrade while `git status --porcelain` is non-empty — the
// spark0-era nodes.sh/start.sh double-edit lesson, aligned with the LiteLLM patch gate's fail-closed
// spirit: dirty means stop and report to a human, never force through. Every request and result
// lands in an append-only audit journal next to the state file.
import { spawn as spawnProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SPARKDASH_REPO = process.env.SPARKDASH_REPO_URL || 'https://github.com/MiaAI-Lab/sparkDash.git'
const SPARKDASH_BRANCH = process.env.SPARKDASH_BRANCH || 'main'
const WORKER_PATH = fileURLToPath(import.meta.url)
const CACHE_MS = 10 * 60 * 1000
const BUSY_STATES = new Set(['installing', 'restarting'])
const SHA_RE = /^[0-9a-f]{40}$/

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode })
}

function safeMessage(error) {
  return String(error?.message ?? error ?? 'unknown error').slice(0, 500)
}

function normalizeSha(value) {
  const sha = String(value ?? '').trim().toLowerCase()
  return SHA_RE.test(sha) ? sha : null
}

function shortSha(sha) {
  return sha ? sha.slice(0, 7) : '—'
}

function parseCommitCount(output) {
  const match = /\b(\d+)\b/.exec(String(output ?? ''))
  if (!match) throw new Error('无法解析 commit 计数输出')
  return Number(match[1])
}

// `git ls-remote <url> HEAD` answers with "sha\tHEAD" plus "sha\trefs/heads/<branch>" lines.
// Prefer the line naming our tracked branch so a renamed default HEAD cannot silently redirect the card.
export function parseLsRemoteHead(output, branch = SPARKDASH_BRANCH) {
  const entries = String(output ?? '').split(/\r?\n/).filter(Boolean).map(line => {
    const [sha, ref] = line.split(/\s+/)
    return { sha: normalizeSha(sha), ref: String(ref ?? '').trim() }
  }).filter(entry => entry.sha)
  const named = entries.find(entry => entry.ref === `refs/heads/${branch}`)
  if (named) return named.sha
  const head = entries.find(entry => entry.ref === 'HEAD')
  if (head) return head.sha
  throw new Error('git ls-remote 未返回可解析的上游 HEAD')
}

// REPO-WATCH ledger consumption (model dispatcher writes one reading per day). Contract is loose
// on purpose: the newest non-empty line must contain a 40-char commit; the exact ledger format is
// confirmed with the dispatcher (SPARKDASH-LOCAL-001 前置件) and only the parse anchor lives here.
export async function readLedgerReading(ledgerFile) {
  if (!ledgerFile) return { present: false, note: '台账未接入：待模型调度 REPO-WATCH 台账路径配置（以 UI 实测为准）' }
  let text
  try {
    text = await readFile(ledgerFile, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { present: false, note: `台账文件不存在（${path.basename(ledgerFile)}）：以 UI 实测 ls-remote 为准` }
    return { present: false, note: `台账读取失败：${safeMessage(error)}；以 UI 实测为准` }
  }
  const lastLine = text.split(/\r?\n/).filter(line => line.trim()).at(-1) || ''
  const match = /\b[0-9a-f]{40}\b/i.exec(lastLine)
  if (!match) return { present: true, head: null, raw: lastLine.slice(0, 200), note: '台账最新行未含 40 位 commit：以 UI 实测为准并核对台账格式' }
  return { present: true, head: match[0].toLowerCase(), raw: lastLine.slice(0, 200), note: '' }
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

function validStep(step) {
  return Boolean(step) && Array.isArray(step.command) && step.command.length > 0 && step.command.every(arg => typeof arg === 'string')
}

export function parseUpgradePlan(raw) {
  if (!raw) return null
  let value = raw
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw) } catch { return null }
  }
  if (!value || typeof value !== 'object' || !Array.isArray(value.steps) || value.steps.length === 0) return null
  if (!value.steps.every(validStep)) return null
  if (value.rollback !== undefined && (!Array.isArray(value.rollback) || !value.rollback.every(validStep))) return null
  if (value.verify !== undefined && (!Array.isArray(value.verify) || !value.verify.every(validStep))) return null
  return value
}

export class SparkdashUpdater {
  constructor({ manager, logger, runImpl = runFile, spawnImpl = spawnProcess, config = {} } = {}) {
    if (!manager?.root) throw new Error('a Headbot manager with root is required')
    this.manager = manager
    this.logger = logger
    this.runImpl = runImpl
    this.spawnImpl = spawnImpl
    this.repoUrl = config.repoUrl || process.env.SPARKDASH_REPO_URL || SPARKDASH_REPO
    this.branch = config.branch || process.env.SPARKDASH_BRANCH || SPARKDASH_BRANCH
    if (!/^[A-Za-z0-9._/-]+$/.test(this.branch)) throw new Error('sparkDash branch is invalid')
    // null until the model dispatcher's SPARKDASH-LOCAL-001 runbook fixes the checkout path;
    // a missing checkout degrades to an honest 未部署 card, never a fake green.
    this.localDir = config.localDir || process.env.SPARKDASH_LOCAL_DIR || null
    this.ledgerFile = config.ledgerFile || process.env.SPARKDASH_REPO_WATCH_LEDGER || null
    this.plan = config.upgradePlan
      ? parseUpgradePlan(config.upgradePlan)
      : parseUpgradePlan(process.env.SPARKDASH_UPGRADE_PLAN)
    this.stateFile = path.join(manager.root, 'sparkdash-update-state.json')
    this.auditFile = path.join(manager.root, 'sparkdash-upgrade-audit.jsonl')
    this.logFile = path.join(manager.root, 'sparkdash-update.log')
    this.backupRoot = path.join(manager.root, 'updates')
    this.cache = new Map()
    this.checking = new Map()
  }

  async git(args, { cwd = this.localDir, timeoutMs = 30_000 } = {}) {
    const result = await this.runImpl('git', args, { cwd, timeoutMs })
    return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  }

  async fetchUpstreamHead() {
    const output = await this.git(['ls-remote', this.repoUrl, 'HEAD'], { cwd: undefined, timeoutMs: 30_000 })
    return parseLsRemoteHead(output, this.branch)
  }

  async fetchUpstreamHeadCached(force) {
    const key = 'sparkdash-upstream'
    const cached = this.cache.get(key)
    if (!force && cached && Date.now() - cached.checkedAt < CACHE_MS) return cached.head
    let pending = this.checking.get(key)
    if (!pending) {
      pending = this.fetchUpstreamHead().then(head => {
        this.cache.set(key, { head, checkedAt: Date.now() })
        return head
      }).finally(() => this.checking.delete(key))
      this.checking.set(key, pending)
    }
    return pending
  }

  async readLocal() {
    if (!this.localDir) return { deployed: false }
    let commit
    try {
      const output = await this.git(['rev-parse', 'HEAD'], { timeoutMs: 15_000 })
      commit = normalizeSha(output.split(/\s+/).find(token => SHA_RE.test(token.toLowerCase())) || '')
    } catch (error) {
      return { deployed: false, error: safeMessage(error) }
    }
    if (!commit) return { deployed: false, error: 'git rev-parse HEAD 未返回合法 commit' }
    let branch = ''
    try {
      branch = (await this.git(['branch', '--show-current'], { timeoutMs: 15_000 })).trim().split(/\r?\n/).at(-1)?.trim() || ''
    } catch {}
    // The dirty gate is fail-closed: an unreadable worktree counts as dirty until proven clean.
    let dirty = true
    let dirtyLines = []
    let dirtyError = ''
    try {
      const output = await this.git(['status', '--porcelain'], { timeoutMs: 30_000 })
      dirtyLines = output.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean)
      dirty = dirtyLines.length > 0
    } catch (error) {
      dirtyError = safeMessage(error)
    }
    return { deployed: true, commit, branch, dirty, dirtyCount: dirtyLines.length, dirtySample: dirtyLines.slice(0, 5), dirtyError }
  }

  async countCommits(localSha, upstreamSha) {
    const notes = []
    let behind = null
    let ahead = null
    try {
      behind = parseCommitCount(await this.git(['rev-list', '--count', `${localSha}..${upstreamSha}`], { timeoutMs: 30_000 }))
      ahead = parseCommitCount(await this.git(['rev-list', '--count', `${upstreamSha}..${localSha}`], { timeoutMs: 30_000 }))
    } catch (error) {
      notes.push(`behind 计数待 fetch 落地（上游 commit 不在本地对象库）：${safeMessage(error)}`)
    }
    return { behind, ahead, notes }
  }

  buildGate(local) {
    if (!this.localDir || !local.deployed) {
      return {
        passed: false,
        blockedBy: 'missing-checkout',
        reasons: [local.error
          ? `sparkDash 本地代码面无法读取：${local.error}`
          : `sparkDash 本地未部署（或路径未配置）：待模型调度 SPARKDASH-LOCAL-001 实况单，升级入口保持关闭`],
      }
    }
    if (local.dirty) {
      const detail = local.dirtyError
        ? `工作区状态无法确认（fail-closed）：${local.dirtyError}`
        : `检测到 ${local.dirtyCount} 处未提交改动：${(local.dirtySample || []).join(' ｜ ')}`
      return { passed: false, blockedBy: 'dirty-worktree', reasons: [`本地脏改闸门阻断升级，请先人工处置（提交或撤销）后再试。${detail}`] }
    }
    if (!this.plan) {
      return { passed: false, blockedBy: 'missing-plan', reasons: ['升级触发腿未接入：待 SPARKDASH-LOCAL-001 实况单命令序列（git fetch/pull → npm ci → 服务重启）配置后开放'] }
    }
    return { passed: true, reasons: [] }
  }

  async check({ force = false } = {}) {
    const upstream = await this.fetchUpstreamHeadCached(force).then(head => ({ head })).catch(error => ({ error: safeMessage(error) }))
    const upstreamHead = upstream.head || null
    const local = await this.readLocal()
    const notes = []
    let behind = null
    let ahead = null
    let upToDate = false
    if (upstreamHead && local.deployed && local.commit) {
      upToDate = local.commit === upstreamHead
      if (!upToDate) {
        const counted = await this.countCommits(local.commit, upstreamHead)
        behind = counted.behind
        ahead = counted.ahead
        notes.push(...counted.notes)
      }
    }
    const ledger = await readLedgerReading(this.ledgerFile)
    if (ledger.note) notes.push(ledger.note)
    if (ledger.present && ledger.head && upstreamHead && ledger.head !== upstreamHead) {
      notes.push(`台账读数 ${shortSha(ledger.head)} 与实测 ${shortSha(upstreamHead)} 不一致：以实测为准，请核对 REPO-WATCH 台账`)
    }
    if (ahead !== null && ahead > 0) notes.push(`本地领先上游 ${ahead} commits（本地有未推送提交）`)
    const gate = this.buildGate(local)
    let updateState = await this.readState()
    if (updateState && BUSY_STATES.has(updateState.state) && local.deployed && local.commit === updateState.targetCommit) {
      updateState = { ...updateState, state: 'completed', message: `已升级 sparkDash 到 ${shortSha(local.commit)}`, completedAt: new Date().toISOString() }
      await this.writeState(updateState)
    }
    const state = updateState?.state || 'idle'
    const busy = BUSY_STATES.has(state)
    const updateAvailable = Boolean(upstreamHead && local.deployed && local.commit && !upToDate && behind !== 0)
    let upgradeError = null
    if (!updateAvailable) upgradeError = null
    else if (busy) upgradeError = '升级已在进行中'
    else if (!gate.passed) upgradeError = `升级闸门未通过：${gate.reasons.join('；')}`
    return {
      repo: this.repoUrl,
      branch: this.branch,
      upstreamHead,
      upstreamError: upstream.error || null,
      upstreamCheckedAt: this.cache.get('sparkdash-upstream') ? new Date(this.cache.get('sparkdash-upstream').checkedAt).toISOString() : null,
      local: local.deployed ? { commit: local.commit, branch: local.branch || null, dirty: local.dirty, dirtyCount: local.dirtyCount } : null,
      localError: local.error || null,
      deployed: Boolean(local.deployed),
      upToDate,
      behind,
      ahead,
      ledger: ledger.present ? { head: ledger.head, raw: ledger.raw } : null,
      notes,
      gate,
      planLoaded: Boolean(this.plan),
      state,
      message: updateState?.message || '',
      targetCommit: updateState?.targetCommit || null,
      updateAvailable,
      canUpgrade: Boolean(updateAvailable && !busy && gate.passed),
      upgradeError,
    }
  }

  async startUpgrade(input = {}, actor = undefined) {
    if (input.acknowledgeOutage !== true) throw httpError(400, '升级需要二次确认：请先确认已知晓 sparkDash 服务将在重启期间短暂断流')
    if (typeof input.targetCommit !== 'string' || !input.targetCommit.trim()) throw httpError(400, '缺少目标 commit')
    const status = await this.check({ force: true })
    if (!status.deployed) throw httpError(503, 'sparkDash 本地未部署：待 SPARKDASH-LOCAL-001 实况单后开放升级')
    if (status.upstreamError) throw httpError(503, `上游 HEAD 探测失败：${status.upstreamError}`)
    if (normalizeSha(input.targetCommit) !== status.upstreamHead) throw httpError(409, '目标 commit 与上游 HEAD 不一致，请重新检查后再确认')
    if (BUSY_STATES.has(status.state)) throw httpError(409, 'sparkDash 升级已在进行中')
    if (!status.updateAvailable) throw httpError(409, status.upToDate ? '本地已是上游 HEAD（HEAD 一致），无需升级' : '当前无可升级差异')
    if (!status.gate.passed) {
      await this.appendAudit({ action: 'upgrade-blocked', actor: actor?.id || 'admin-page', from: status.local?.commit, to: status.upstreamHead, result: 'blocked', gate: { blockedBy: status.gate.blockedBy || 'gate', reasons: status.gate.reasons } })
      throw httpError(409, `升级闸门未通过，升级已阻断：${status.gate.reasons.join('；')}`)
    }
    const config = {
      repoUrl: this.repoUrl,
      branch: this.branch,
      localDir: this.localDir,
      plan: this.plan,
      beforeCommit: status.local.commit,
      targetCommit: status.upstreamHead,
      stateFile: this.stateFile,
      auditFile: this.auditFile,
      logFile: this.logFile,
      backupDir: path.join(this.backupRoot, `sparkdash-${status.upstreamHead.slice(0, 7)}-${Date.now()}`),
    }
    await this.appendAudit({ action: 'upgrade-request', actor: actor?.id || 'admin-page', from: status.local.commit, to: status.upstreamHead, result: 'started', gate: { passed: true } })
    await this.writeState({ state: 'installing', targetCommit: status.upstreamHead, startedAt: new Date().toISOString(), message: `正在升级 sparkDash 到 ${shortSha(status.upstreamHead)}（重启期间服务短暂断流）` })
    let child
    try {
      child = this.spawnImpl(process.execPath, [WORKER_PATH, JSON.stringify(config)], {
        cwd: this.localDir,
        env: { ...process.env },
        detached: true,
        stdio: 'ignore',
      })
      child.once('error', error => { void this.markFailure(status.upstreamHead, safeMessage(error)) })
      child.once('exit', (code, signal) => {
        if (code !== 0) void this.markFailure(status.upstreamHead, `升级后台任务异常退出（${code ?? signal ?? 'unknown'}）`)
      })
      child.unref()
    } catch (error) {
      await this.writeState({ state: 'failed', targetCommit: status.upstreamHead, message: safeMessage(error), failedAt: new Date().toISOString() })
      await this.appendAudit({ action: 'upgrade-failed', from: status.local.commit, to: status.upstreamHead, result: 'failed', reason: safeMessage(error), rolledBack: false })
      throw httpError(500, `无法启动 sparkDash 升级：${safeMessage(error)}`)
    }
    this.logger?.info?.(`[ds-headbot] started sparkDash update to ${status.upstreamHead}`)
    return { state: 'installing', targetCommit: status.upstreamHead, message: '正在按实况单执行：fetch/快进 → npm ci → 重启服务；进度见审计日志' }
  }

  async markFailure(targetCommit, message) {
    try {
      const state = await this.readState()
      if (state?.targetCommit !== targetCommit || !BUSY_STATES.has(state.state)) return
      await this.writeState({ ...state, state: 'failed', message: safeMessage(message), failedAt: new Date().toISOString() })
      await this.appendAudit({ action: 'upgrade-failed', to: targetCommit, result: 'failed', reason: safeMessage(message), rolledBack: false })
    } catch (error) {
      this.logger?.error?.(`[ds-headbot] unable to record sparkDash updater failure: ${safeMessage(error)}`)
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

// The detached worker owns pull → npm ci → restart steps from the runbook plan so the request path
// never blocks. Before touching anything it re-checks the dirty gate (fail-closed, closes the
// check→exec window); on any failure it rolls back with plan.rollback (default git checkout to the
// pre-upgrade commit) and records the outcome in the audit journal.
export async function performSparkdashUpgrade(config, dependencies = {}) {
  const runCommand = dependencies.runCommand || runFile
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
  const setState = (state, message) => writeWorkerState(config.stateFile, { state, targetCommit: config.targetCommit, message })
  const runStep = async step => {
    await runCommand(step.command[0], step.command.slice(1), { cwd: step.cwd || config.localDir, timeoutMs: Number(step.timeoutMs) || 5 * 60_000 })
  }
  const readHead = async () => {
    const output = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: config.localDir, timeoutMs: 15_000 })
    return String(output.stdout ?? '').trim().split(/\s+/).find(token => /^[0-9a-f]{40}$/i.test(token))?.toLowerCase() || null
  }
  const startedAt = now()
  const plan = config.plan || {}
  // touched flips once the first runbook step runs: a failure before that point never modified the
  // worktree, so claiming (or attempting) a rollback there would be dishonest.
  let touched = false
  try {
    await mkdir(config.backupDir, { recursive: true, mode: 0o700 })
    await writeFile(path.join(config.backupDir, 'before.json'), `${JSON.stringify({ beforeCommit: config.beforeCommit, targetCommit: config.targetCommit, repo: config.repoUrl, branch: config.branch, at: now() }, null, 2)}\n`, { mode: 0o600 })
    await setState('installing', '执行前复检：工作区脏改闸门（fail-closed）')
    const dirty = await runCommand('git', ['status', '--porcelain'], { cwd: config.localDir, timeoutMs: 30_000 })
    if (String(dirty.stdout ?? '').split(/\r?\n/).filter(line => line.trim()).length > 0) {
      throw new Error('执行前复检发现未提交改动，升级已阻断（请先人工处置）')
    }
    await log(`upgrade start: ${config.beforeCommit} -> ${config.targetCommit} (repo ${config.repoUrl}@${config.branch})`)
    const steps = Array.isArray(plan.steps) ? plan.steps : []
    if (steps.length === 0) throw new Error('实况单未声明任何升级步骤')
    for (const [index, step] of steps.entries()) {
      await setState(index === 0 ? 'installing' : 'restarting', `实况单步骤 ${index + 1}/${steps.length}：${step.command.join(' ')}`)
      touched = true
      await runStep(step)
      await log(`step ${index + 1}/${steps.length} ok: ${step.command.join(' ')}`)
    }
    const head = await readHead()
    if (head !== config.targetCommit) throw new Error(`HEAD 回读不符：期望 ${config.targetCommit}，实际 ${head ?? '无法读取'}`)
    await log(`verify ok: HEAD read-back ${head}`)
    if (Array.isArray(plan.verify) && plan.verify.length > 0) {
      for (const step of plan.verify) {
        await runStep(step)
        await log(`verify step ok: ${step.command.join(' ')}`)
      }
    } else {
      await log('实况单未声明升级后探针（已完成 HEAD 回读）')
    }
    await setState('completed', `已升级 sparkDash 到 ${shortSha(config.targetCommit)}`)
    await audit({ action: 'upgrade-completed', from: config.beforeCommit, to: config.targetCommit, result: 'completed', startedAt })
  } catch (error) {
    const reason = safeMessage(error)
    await log(`upgrade failed: ${reason}; ${touched ? `rolling back to ${config.beforeCommit}` : 'aborted before any runbook step (nothing to roll back)'}`)
    let rolledBack = !touched
    let rollbackReason = ''
    if (touched) {
      const rollbackSteps = Array.isArray(plan.rollback) && plan.rollback.length > 0
        ? plan.rollback
        : [{ command: ['git', 'checkout', config.beforeCommit] }]
      try {
        for (const step of rollbackSteps) await runStep(step)
        const head = await readHead()
        if (head !== config.beforeCommit) throw new Error(`回退后 HEAD 回读不符：期望 ${config.beforeCommit}，实际 ${head ?? '无法读取'}`)
        rolledBack = true
        await log(`rollback ok: checkout ${config.beforeCommit}（detached HEAD 状态下请人工归位分支）`)
      } catch (rollbackError) {
        rollbackReason = safeMessage(rollbackError)
        await log(`rollback failed: ${rollbackReason}`)
      }
    }
    const tail = touched
      ? (rolledBack ? `；已回退到 ${shortSha(config.beforeCommit)}` : `；自动回退失败：${rollbackReason}`)
      : '；未执行任何步骤，工作区未变更'
    await setState('failed', `升级失败：${reason}${tail}`)
    await audit({ action: 'upgrade-failed', from: config.beforeCommit, to: config.targetCommit, result: 'failed', reason, rolledBack, rollbackReason: rollbackReason || null, startedAt })
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.argv[2]) {
  let config
  try { config = JSON.parse(process.argv[2]) } catch { throw new Error('invalid sparkDash update worker configuration') }
  void performSparkdashUpgrade(config)
}
