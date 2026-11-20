// SPARKDASH-UI-001: version card + audited upgrade flow for the local sparkDash dashboard.
// The card speaks commit-level truth: upstream HEAD via `git ls-remote` versus the local checkout
// commit, and "up to date" is claimed ONLY when the two 40-char SHAs are byte-identical. Since
// UI-006 the DISPLAY version is the release tag (upstream does publish tags, e.g. v2.90.0) mapped
// from the commit via ls-remote/describe semantics — but an untagged commit still shows an honest
// 未标记 short-sha; no version equality is ever fabricated.
// The local deployment shape (checkout path, pull/npm ci/restart commands) belongs to the model
// dispatcher's SPARKDASH-LOCAL-001 runbook. Until that plan arrives the upgrade stays fail-closed
// behind a missing-plan gate, and the card honestly reports 未部署/待实况单 when the checkout is absent.
// The dirty-worktree gate blocks any upgrade while `git status --porcelain` is non-empty — the
// spark0-era nodes.sh/start.sh double-edit lesson, aligned with the LiteLLM patch gate's fail-closed
// spirit: dirty means stop and report to a human, never force through. Every request and result
// lands in an append-only audit journal next to the state file.
import { spawn as spawnProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ignoreFailure, ignoreFailureOnce, infoLine } from './observe.js'
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

// UI-006 (2026-11-15 user order): the SparkDash card shows a TAG version (vX.Y.Z). Upstream does
// publish release tags (e.g. the v2.90.0 release commit), so the card maps a commit to its release
// tag (git describe --tags semantics). When HEAD carries no tag the card falls back to an honest
// 未标记 short-sha — a version is never fabricated.
export function parseReleaseTags(output, commit) {
  const target = normalizeSha(commit)
  if (!target) return null
  const candidates = []
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const [rawSha, rawRef] = line.split(/\s+/)
    const sha = normalizeSha(rawSha)
    const ref = String(rawRef ?? '').trim()
    if (!sha || sha !== target || !ref.startsWith('refs/tags/')) continue
    const name = ref.slice('refs/tags/'.length).replace(/\^\{\}$/, '')
    if (!/^v?\d+\.\d+\.\d+$/.test(name) || name.includes('/')) continue
    candidates.push(name)
  }
  if (candidates.length === 0) return null
  // Prefer the canonical v-prefixed name; highest semver wins among equals.
  candidates.sort((left, right) => {
    const a = left.replace(/^v/, '').split('.').map(Number)
    const b = right.replace(/^v/, '').split('.').map(Number)
    for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index]
    return Number(left.startsWith('v')) - Number(right.startsWith('v'))
  })
  return candidates.at(-1)
}

// REPO-WATCH ledger consumption (model dispatcher writes readings into 台账.md, see
// 本机部署基线单 B⑤). The ledger mixes human daily-report rows (short SHAs) with the baseline
// table whose rows carry full 40-char SHAs per repo. Contract, in priority order:
//   1. the newest line that names our repo AND carries a full 40-char commit (baseline-table row);
//   2. otherwise the newest non-empty line with a 40-char commit (loose machine-line format);
//   3. otherwise present-but-unparsed with a note — the live ls-remote probe always wins.
export async function readLedgerReading(ledgerFile, repoHint = '') {
  if (!ledgerFile) return { present: false, note: '台账未接入：待模型调度 REPO-WATCH 台账路径配置（以 UI 实测为准）' }
  let text
  try {
    text = await readFile(ledgerFile, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { present: false, note: `台账文件不存在（${path.basename(ledgerFile)}）：以 UI 实测 ls-remote 为准` }
    return { present: false, note: `台账读取失败：${safeMessage(error)}；以 UI 实测为准` }
  }
  const lines = text.split(/\r?\n/).filter(line => line.trim())
  const name = String(repoHint).replace(/\.git$/, '').split('/').pop() || ''
  if (name) {
    const named = [...lines].reverse().find(line => line.includes(name) && /\b[0-9a-f]{40}\b/i.test(line))
    if (named) return { present: true, head: /\b[0-9a-f]{40}\b/i.exec(named)[0].toLowerCase(), raw: named.slice(0, 200), note: '' }
  }
  const lastLine = lines.at(-1) || ''
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
  // Two step forms are accepted (runbook B④ 照抄即用): a shell one-liner string, or a
  // { command: [bin, ...args] } array. Trust model is identical — both run whatever the runbook
  // says — the string form just goes through /bin/sh so `~/…`, `$(id -u)` and quoting work as the
  // dispatcher wrote them.
  if (typeof step === 'string') return step.trim().length > 0 && step.length <= 2000
  return Boolean(step) && Array.isArray(step.command) && step.command.length > 0 && step.command.every(arg => typeof arg === 'string')
}

// SPARKDASH-SHELLGUARD-001: a string step runs through /bin/sh, so an absolute path that carries
// a space and is NOT quoted/escaped gets word-split before the CLI ever sees it (the retired
// 2026-11-18 start.sh band: `--patch /Users/…/Application Support/…` died as ENOENT on
// `/Users/…/Application`). The CLI itself has no way to defend — the split happens in the shell.
// Fail closed here instead: quote-aware masking first (quoted spans and \-escapes become inert
// tokens), then one rule over the surviving bare tokens —
//   R1  `/abs…` (or `~/…`) immediately followed by a token containing `/` — the crash signature
//       (6/6 field cases: `Application` + `Support/DeepSeekHarness…`). A continuation segment
//       without `/` cannot be told apart from the legitimate `git -C <path> <subcommand>` shape,
//       so it is deliberately not guessed; the card copy pushes every runbook to array steps.
// Operators, flags, $-expansions and inert (quoted/escaped) tokens never count as continuations.
const SHELL_CONTINUATIONS = new Set(['&&', '||', ';', '|', '&', '>', '>>', '<', '<<', '2>', '2>>', '1>', '2>&1', '(', ')', '{', '}', '=', '[', ']'])
const INERT = '\u0000'

function maskQuotedSpans(line) {
  let out = ''
  let i = 0
  let quotes = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === '\\') { out += INERT; i += 2; continue }
    if (ch === "'" || ch === '"') {
      const end = line.indexOf(ch, i + 1)
      const span = end === -1 ? line.length - i : end - i + 1
      quotes += end === -1 ? 1 : 2
      out += INERT.repeat(span)
      i = end === -1 ? line.length : end + 1
      continue
    }
    out += ch
    i += 1
  }
  return { masked: out, unbalanced: quotes % 2 === 1 }
}

/** Returns a suspect `"<split fragment> <continuation>"` string when the line carries a bare
 *  space-carrying absolute path (shell would word-split it), otherwise null. */
export function findSplitPath(line) {
  const { masked, unbalanced } = maskQuotedSpans(line)
  if (unbalanced) return `${line}（引号未闭合）`
  const tokens = masked.split(/\s+/).filter(Boolean)
  const inert = token => token.includes(INERT)
  for (let k = 0; k + 1 < tokens.length; k += 1) {
    const left = tokens[k]
    const right = tokens[k + 1]
    if (!(left.startsWith('/') || left.startsWith('~/')) || SHELL_CONTINUATIONS.has(left) || inert(left)) continue
    if (SHELL_CONTINUATIONS.has(right) || inert(right)) continue
    if (right.startsWith('-') || right.startsWith('$')) continue
    if (right.includes('/')) return `${left} ${right}`
  }
  return null
}

/** Lists every unsafe string step across steps/verify/rollback: { section, index, line, suspect }. */
export function findUnsafeShellSteps(plan) {
  const found = []
  if (!plan || typeof plan !== 'object') return found
  for (const section of ['steps', 'verify', 'rollback']) {
    const list = Array.isArray(plan[section]) ? plan[section] : []
    list.forEach((step, index) => {
      if (typeof step !== 'string') return
      const suspect = findSplitPath(step)
      if (suspect) found.push({ section, index, line: step, suspect })
    })
  }
  return found
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
  constructor({ manager, logger, runImpl = runFile, spawnImpl = spawnProcess, existsImpl = existsSync, config = {} } = {}) {
    if (!manager?.root) throw new Error('a Headbot manager with root is required')
    this.manager = manager
    this.logger = logger
    this.runImpl = runImpl
    this.spawnImpl = spawnImpl
    this.existsImpl = existsImpl
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
    // The upstream probe must never run with localDir as cwd: `spawn git` against a directory
    // that does not exist yet (the pre-install window before SPARKDASH-LOCAL-001 lands) fails
    // with ENOENT, which used to blank upstreamHead and pollute the gate reasons. ls-remote only
    // needs the repo URL, so pin a neutral cwd. (Note: `{ cwd: undefined }` would NOT work —
    // the git() default argument re-fills localDir for undefined.)
    const output = await this.git(['ls-remote', this.repoUrl, 'HEAD'], { cwd: process.cwd(), timeoutMs: 30_000 })
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

  async fetchUpstreamTags(commit) {
    // Same neutral-cwd discipline as fetchUpstreamHead: the probe must survive a missing/未部署
    // local checkout (spawn git there would produce a misleading `spawn git ENOENT`).
    const output = await this.git(['ls-remote', this.repoUrl, 'refs/tags/*'], { cwd: process.cwd(), timeoutMs: 30_000 })
    return parseReleaseTags(output, commit)
  }

  async fetchUpstreamTagsCached(commit, force) {
    if (!commit) return null
    const key = `sparkdash-upstream-tags-${commit}`
    const cached = this.cache.get(key)
    if (!force && cached && Date.now() - cached.checkedAt < CACHE_MS) return cached.tag
    let pending = this.checking.get(key)
    if (!pending) {
      pending = this.fetchUpstreamTags(commit).then(tag => {
        this.cache.set(key, { tag, checkedAt: Date.now() })
        return tag
      }).finally(() => this.checking.delete(key))
      this.checking.set(key, pending)
    }
    return pending
  }

  async releaseTitleVersion(commit) {
    // 2026-11-15 live evidence: MiaAI-Lab/sparkDash publishes no release tags beyond v2.32.0 —
    // the v2.90.0 release lives only in the HEAD commit SUBJECT ("Release v2.90.0 and highlight
    // it in README"). With ls-remote refs/tags/*, GitHub git/refs/tags and releases/latest all
    // cross-checked, reading the declared version from the release commit subject is the honest
    // semantic mapping the directive asks for (not a fabrication: upstream itself declared it);
    // the moment upstream tags the commit, the ls-remote tag mapping above wins automatically.
    if (!commit) return null
    try {
      const subject = (await this.git(['log', '-1', '--format=%s', commit], { timeoutMs: 15_000 })).trim()
      const match = /^Release\s+(v?\d+\.\d+\.\d+)\b/i.exec(subject)
      return match ? match[1] : null
    } catch {
      return null // commit not in the local object store (or unreadable) → no honest version
    }
  }

  async readLocalTag(commit, { upstreamHead, upstreamTagVersion, ahead, force } = {}) {
    if (!commit) return null
    // The local clone may not have fetched upstream's tag set (2026-11-15 live: local tags stop at
    // v2.32.0 while HEAD is v2.90.0+1家装提交), so a purely local `git describe` can misread stale
    // tags. Honest mapping instead resolves against the upstream refs/tags/* set:
    // ① a tag ON the commit (exact sha match upstream) → that tag;
    // ② local-patched HEAD riding on the upstream release commit (ahead>0 and upstream HEAD is an
    //    ancestor) → the git-describe style 装饰形 v2.90.0-1-gd77d1a3;
    // ③ anything else → null → 页面诚实「未标记 commit xxxxxxx」. A version is never fabricated.
    const exact = await this.fetchUpstreamTagsCached(commit, force).catch(() => null)
    if (exact) return exact
    if (commit === upstreamHead && upstreamTagVersion) return upstreamTagVersion
    if (ahead && ahead > 0 && upstreamTagVersion && upstreamHead) {
      try {
        await this.git(['merge-base', '--is-ancestor', upstreamHead, commit], { timeoutMs: 15_000 })
        return `${upstreamTagVersion}-${ahead}-g${String(commit).slice(0, 7)}`
      } catch {
        return null // upstream release commit is not on HEAD's ancestry — no honest tag to attach
      }
    }
    return null
  }

  async readLocal() {
    if (!this.localDir) return { deployed: false }
    // A configured-but-absent checkout (the pre-install window before SPARKDASH-LOCAL-001 lands)
    // is honest 未部署, not a git failure: probing git there spawns against a non-existent cwd
    // and surfaces a misleading `spawn git ENOENT` in localError and the gate reasons.
    if (!this.existsImpl(this.localDir)) return { deployed: false }
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
    } catch (error) { ignoreFailure(this.logger, 'sparkdash-updater', 'branch name probe', error) }
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
    // SPARKDASH-UPGRADE-002 ①: dirty worktrees no longer block the upgrade -- the worker
    // auto-stashes them (tagged with the upgrade transaction id) and auto-pops on success.
    // The dirty facts still ride along on status.local (dirty/dirtyCount) and the card notes.
    if (!this.plan) {
      return { passed: false, blockedBy: 'missing-plan', reasons: ['升级触发腿未接入：待 SPARKDASH-LOCAL-001 实况单命令序列（git fetch/pull → npm ci → 服务重启）配置后开放；runbook 步骤一律用数组形制 {"command":["git","-C","/路径 含空格/目录","fetch"]}——字符串步骤走 /bin/sh，含空格路径不加引号会被切词，本卡对这种步骤 fail-closed'] }
    }
    // SPARKDASH-SHELLGUARD-001: the runbook exists, but a string step carrying a bare
    // space-path would be word-split by /bin/sh before any CLI could see it — block the
    // upgrade at the gate (audit trail + honest card) instead of dying mid-flight.
    const unsafe = findUnsafeShellSteps(this.plan)
    if (unsafe.length > 0) {
      const reasons = unsafe.map(item => `字符串步骤含未加引号的空格绝对路径（会被 /bin/sh 切词）：${item.section}[${item.index}] "${item.suspect}"`)
      return { passed: false, blockedBy: 'unsafe-plan', reasons: [...reasons, '请改用数组 steps {"command":["git","checkout","/路径 含空格/x"]}（runbook 一律数组 steps）'] }
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
    let upstreamTagVersion = null
    let localTagVersion = null
    if (upstreamHead) {
      try { upstreamTagVersion = await this.fetchUpstreamTagsCached(upstreamHead, force) } catch (error) { notes.push(`上游 tag 解析失败：${safeMessage(error)}`) }
      if (!upstreamTagVersion && local.deployed) {
        upstreamTagVersion = await this.releaseTitleVersion(upstreamHead)
        if (upstreamTagVersion) notes.push(`上游未对 ${shortSha(upstreamHead)} 打 tag（ls-remote 实测），版本 ${upstreamTagVersion} 取自发布 commit 标题；上游打 tag 后自动切回 tag 映射`)
      }
    }
    if (local.deployed && local.commit) {
      // Same-release display consistency: an untagged-but-identical HEAD inherits the upstream tag.
      localTagVersion = await this.readLocalTag(local.commit, { upstreamHead, upstreamTagVersion, ahead, force })
    }
    const ledger = await readLedgerReading(this.ledgerFile, this.repoUrl)
    if (ledger.note) notes.push(ledger.note)
    if (ledger.present && ledger.head && upstreamHead && ledger.head !== upstreamHead) {
      notes.push(`台账读数 ${shortSha(ledger.head)} 与实测 ${shortSha(upstreamHead)} 不一致：以实测为准，请核对 REPO-WATCH 台账`)
    }
    if (ahead !== null && ahead > 0) notes.push(`本地领先上游 ${ahead} commits（本地有未推送提交）；升级时将自动 rebase 重挂到新 tip`)
    if (local.deployed && local.dirty) notes.push(local.dirtyCount
      ? `检测到 ${local.dirtyCount} 处未提交改动：升级时自动暂存（stash，带升级事务 id），成功后自动复位`
      : '工作区状态无法确认（fail-closed 记为脏）：升级时将复检，无法读取即阻断')
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
      upstreamTagVersion,
      localTagVersion,
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
    // SPARKDASH-UPGRADE-002: one transaction id threads request → worker → stash tag → audit,
    // so a failed upgrade's auto-stash stays traceable and restorable (总务追加要求).
    const transactionId = `upg-${status.upstreamHead.slice(0, 7)}-${Date.now()}`
    const config = {
      repoUrl: this.repoUrl,
      branch: this.branch,
      localDir: this.localDir,
      plan: this.plan,
      beforeCommit: status.local.commit,
      targetCommit: status.upstreamHead,
      transactionId,
      stateFile: this.stateFile,
      auditFile: this.auditFile,
      logFile: this.logFile,
      backupDir: path.join(this.backupRoot, `sparkdash-${status.upstreamHead.slice(0, 7)}-${Date.now()}`),
    }
    await this.appendAudit({ action: 'upgrade-request', actor: actor?.id || 'admin-page', from: status.local.commit, to: status.upstreamHead, result: 'started', gate: { passed: true }, transactionId })
    await this.writeState({ state: 'installing', targetCommit: status.upstreamHead, startedAt: new Date().toISOString(), transactionId, message: `正在升级 sparkDash 到 ${shortSha(status.upstreamHead)}（重启期间服务短暂断流）` })
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
    infoLine(this.logger, `[ds-headbot] started sparkDash update to ${status.upstreamHead}`)
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
  try { previous = JSON.parse(await readFile(file, 'utf8')) } catch (error) { ignoreFailure(undefined, 'sparkdash-updater', 'read previous worker state', error) }
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
    } catch (error) { ignoreFailureOnce(undefined, 'sparkdash-updater', 'worker log append', error) }
  }
  const audit = async event => {
    try {
      await mkdir(path.dirname(config.auditFile), { recursive: true, mode: 0o700 })
      await appendFile(config.auditFile, `${JSON.stringify({ at: now(), ...event })}\n`, { mode: 0o600 })
    } catch (error) { ignoreFailureOnce(undefined, 'sparkdash-updater', 'worker audit append', error) }
  }
  const setState = (state, message) => writeWorkerState(config.stateFile, { state, targetCommit: config.targetCommit, message })
  // A step returns the display line for the log. String steps run through /bin/sh and get the
  // <target_sha>/<previous_sha> placeholders filled from the pinned pair (B④ 剧本照抄即用).
  const runStep = async step => {
    if (typeof step === 'string') {
      const line = step.replaceAll('<target_sha>', config.targetCommit || '').replaceAll('<previous_sha>', config.beforeCommit || '')
      // SPARKDASH-SHELLGUARD-001 last line of defense (the gate normally stops the plan long
      // before here): check the real line about to face /bin/sh — placeholders filled — and never
      // hand it a bare space-carrying absolute path.
      const suspect = findSplitPath(line)
      if (suspect) throw new Error(`实况单字符串步骤含未加引号的空格绝对路径（会被 /bin/sh 切词）："${suspect}"——请改用数组 steps {"command":["git","checkout","/路径 含空格/x"]}（runbook 一律数组 steps）`)
      await runCommand('/bin/sh', ['-c', line], { cwd: config.localDir, timeoutMs: 5 * 60_000 })
      return line
    }
    await runCommand(step.command[0], step.command.slice(1), { cwd: step.cwd || config.localDir, timeoutMs: Number(step.timeoutMs) || 5 * 60_000 })
    return step.command.join(' ')
  }
  const readHead = async () => {
    const output = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: config.localDir, timeoutMs: 15_000 })
    return String(output.stdout ?? '').trim().split(/\s+/).find(token => /^[0-9a-f]{40}$/i.test(token))?.toLowerCase() || null
  }
  const startedAt = now()
  const plan = config.plan || {}
  const txId = config.transactionId || `upg-${shortSha(config.targetCommit)}-${Date.now()}`
  const stashTag = `auto-upgrade ${txId}`
  const runGit = (args, timeoutMs = 30_000) => runCommand('git', args, { cwd: config.localDir, timeoutMs })
  // touched flips once the first runbook step runs: a failure before that point never modified the
  // worktree, so claiming (or attempting) a rollback there would be dishonest.
  let touched = false
  // SPARKDASH-UPGRADE-002 state: stashed flips once dirty entries ride the stash stack;
  // rebaseAborted marks a failed auto-rebase that already restored the worktree itself.
  let stashed = false
  let rebaseAborted = false
  let patchShas = []
  const findStashRef = async () => {
    try {
      const list = await runGit(['stash', 'list', '--format=%gd\t%gs'])
      const entry = String(list.stdout ?? '').split(/\r?\n/).find(line => line.includes(txId))
      return entry ? entry.split('\t')[0].trim() : null
    } catch (error) {
      await log(`stash list 读取失败：${safeMessage(error)}`)
      return null
    }
  }
  try {
    // SPARKDASH-SHELLGUARD-001 preflight: scan every string step (steps/verify/rollback) BEFORE
    // the first git/write — a plan that would hand /bin/sh a bare space-carrying absolute path
    // dies here with touched=false, so the honest tail stays "未执行任何步骤，工作区未变更" and
    // no rollback is claimed (or attempted) for a worktree that was never modified.
    const unsafePlan = findUnsafeShellSteps(plan)
    if (unsafePlan.length > 0) {
      const detail = unsafePlan.map(item => `${item.section}[${item.index}] "${item.suspect}"`).join('；')
      throw new Error(`实况单含未加引号的空格绝对路径（会被 /bin/sh 切词）：${detail}——请改用数组 steps {"command":["git","checkout","/路径 含空格/x"]}（runbook 一律数组 steps）`)
    }
    await mkdir(config.backupDir, { recursive: true, mode: 0o700 })
    await writeFile(path.join(config.backupDir, 'before.json'), `${JSON.stringify({ beforeCommit: config.beforeCommit, targetCommit: config.targetCommit, transactionId: txId, repo: config.repoUrl, branch: config.branch, at: now() }, null, 2)}\n`, { mode: 0o600 })
    // ① 脏改自动处置（UPGRADE-002）：升级前自动 stash（条目信息带事务 id，失败可追溯归位），
    //    成功后自动 pop；git status 不可读仍按 fail-closed 阻断（runGit 抛错即败）。
    await setState('installing', '执行前复检：工作区脏改将自动暂存（auto stash，带升级事务 id）')
    const dirty = await runGit(['status', '--porcelain'])
    const dirtyLines = String(dirty.stdout ?? '').split(/\r?\n/).filter(line => line.trim())
    if (dirtyLines.length > 0) {
      await runGit(['stash', 'push', '--include-untracked', '-m', `${stashTag} (${dirtyLines.length} entries)`], 60_000)
      stashed = true
      await log(`auto-stash ok: ${dirtyLines.length} entries tagged "${stashTag}"`)
    }
    await log(`upgrade start: ${config.beforeCommit} -> ${config.targetCommit} (repo ${config.repoUrl}@${config.branch}) tx=${txId}`)
    // ② ahead 本地补丁支持（UPGRADE-002）：diverging 时自动把 ahead 的本地 commit rebase 到
    //    新 tip（替代 ff-only 炸 Diverging）；rebase 冲突 --abort 复原并走失败回滚路。
    await runGit(['fetch', 'origin', config.branch || 'main'], 5 * 60_000)
    const behind = parseCommitCount((await runGit(['rev-list', '--count', `HEAD..${config.targetCommit}`])).stdout)
    const ahead = parseCommitCount((await runGit(['rev-list', '--count', `${config.targetCommit}..HEAD`])).stdout)
    if (behind > 0 && ahead > 0) {
      await setState('installing', `检测到分叉（behind ${behind} / ahead ${ahead}）：本地补丁自动 rebase 到 ${shortSha(config.targetCommit)}`)
      touched = true
      try {
        await runGit(['rebase', config.targetCommit], 5 * 60_000)
        await log(`auto-rebase ok: ${ahead} local commit(s) replayed onto ${config.targetCommit}`)
      } catch (rebaseError) {
        try { await runGit(['rebase', '--abort']) } catch { /* best effort：abort 失败交给 rollback 腿兜底 */ }
        rebaseAborted = true
        throw new Error(`本地补丁自动 rebase 失败（冲突已 abort 复原）：${safeMessage(rebaseError)}`)
      }
    }
    const steps = Array.isArray(plan.steps) ? plan.steps : []
    if (steps.length === 0) throw new Error('实况单未声明任何升级步骤')
    for (const [index, step] of steps.entries()) {
      await setState(index === 0 ? 'installing' : 'restarting', `实况单步骤 ${index + 1}/${steps.length}：${typeof step === 'string' ? step : step.command.join(' ')}`)
      touched = true
      const line = await runStep(step)
      await log(`step ${index + 1}/${steps.length} ok: ${line}`)
    }
    // ③ 回读门改判定（UPGRADE-002）：严等 → ancestor——补丁常驻 HEAD 之上时，
    //    targetCommit 只要是 HEAD 祖先即真落位，ahead 补丁不再触发假败；补丁 SHA 入审计。
    const head = await readHead()
    if (!head) throw new Error(`HEAD 回读失败：无法读取当前 HEAD`)
    let headDescendsTarget = false
    try {
      await runGit(['merge-base', '--is-ancestor', config.targetCommit, head])
      headDescendsTarget = true
    } catch { headDescendsTarget = false }
    if (!headDescendsTarget) throw new Error(`HEAD 回读门未过：${head} 不以目标 ${config.targetCommit} 为祖先`)
    try {
      const patchList = await runGit(['rev-list', `${config.targetCommit}..${head}`])
      patchShas = String(patchList.stdout ?? '').split(/\s+/).filter(token => /^[0-9a-f]{40}$/i.test(token)).map(sha => sha.toLowerCase())
    } catch (error) { await log(`补丁清单读取失败（不阻断）：${safeMessage(error)}`) }
    await log(`verify ok: HEAD ${head} descends from ${config.targetCommit}; local patches: ${patchShas.map(shortSha).join(',') || 'none'}`)
    if (Array.isArray(plan.verify) && plan.verify.length > 0) {
      for (const step of plan.verify) {
        const line = await runStep(step)
        await log(`verify step ok: ${line}`)
      }
    } else {
      await log('实况单未声明升级后探针（已完成 HEAD 回读）')
    }
    // ④ 成功后自动 pop 复位脏改；pop 冲突不翻成败（升级已落位），停在人工裁决并写审计详情。
    let stashPopNote = ''
    if (stashed) {
      const ref = await findStashRef()
      if (!ref) {
        stashPopNote = `自动暂存条目未找到（tag ${txId}），脏改候人工处理`
        await log(`auto-stash pop missing: no stash entry tagged "${txId}"`)
      } else {
        try {
          await runGit(['stash', 'pop', ref], 60_000)
          await log(`auto-stash pop ok: ${ref}`)
        } catch (popError) {
          stashPopNote = `自动复位脏改遇冲突，停在人工裁决（${ref} 留在 stash 栈）：${safeMessage(popError)}`
          await audit({ action: 'stash-pop-conflict', transactionId: txId, stashRef: ref, detail: safeMessage(popError) })
          await log(`auto-stash pop conflict: ${stashPopNote}`)
        }
      }
    }
    await setState('completed', `已升级 sparkDash 到 ${shortSha(config.targetCommit)}${patchShas.length ? `（本地补丁保留在顶：${patchShas.map(shortSha).join(',')}）` : ''}${stashPopNote ? `；${stashPopNote}` : ''}`)
    await audit({ action: 'upgrade-completed', from: config.beforeCommit, to: config.targetCommit, result: 'completed', startedAt, transactionId: txId, stashed, stashPopNote: stashPopNote || null, patchShas })
  } catch (error) {
    const reason = safeMessage(error)
    await log(`upgrade failed: ${reason}; ${touched ? `rolling back to ${config.beforeCommit}` : 'aborted before any runbook step (nothing to roll back)'}`)
    let rolledBack = !touched
    let rollbackReason = ''
    if (touched && rebaseAborted) {
      // rebase --abort 已把工作区复原到 rebase 前形制，再 checkout 反而制造 detached 假象。
      rolledBack = true
      await log('rollback ok: rebase 已 abort，工作区复原至升级前形制（无需 checkout）')
    } else if (touched) {
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
    // 失败留栈的 auto-stash 必须可追溯归位（总务追加要求）：审计行记事务 id+stash ref+复位指令。
    const stashRef = stashed ? await findStashRef() : null
    await setState('failed', `升级失败：${reason}${tail}${stashRef ? `；自动暂存的脏改留在 stash 栈（${stashRef}），人工归位：git stash pop ${stashRef}` : ''}`)
    await audit({ action: 'upgrade-failed', from: config.beforeCommit, to: config.targetCommit, result: 'failed', reason, rolledBack, rollbackReason: rollbackReason || null, startedAt, transactionId: txId, stashed, stashRef })
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.argv[2]) {
  let config
  try { config = JSON.parse(process.argv[2]) } catch { throw new Error('invalid sparkDash update worker configuration') }
  void performSparkdashUpgrade(config)
}
