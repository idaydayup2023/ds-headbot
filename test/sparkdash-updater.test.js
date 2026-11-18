// SPARKDASH-UI-001 acceptance: mock git (ls-remote / rev-parse / status / rev-list) and a mock
// runbook plan exercise the whole commit-对表 → 脏改闸门 → 双确认 → 执行/回滚 chain plus the audit
// journal. The real checkout, upstream and services are never touched here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SparkdashUpdater, performSparkdashUpgrade, parseLsRemoteHead, parseUpgradePlan, readLedgerReading } from '../lib/sparkdash-updater.js'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

async function tempDir(name) {
  return mkdtemp(path.join(os.tmpdir(), `sparkdash-update-${name}-`))
}

function makeGit(scenario) {
  const calls = []
  const impl = async (command, args, opts = {}) => {
    calls.push([command, ...args])
    if (command !== 'git') throw new Error(`unexpected command ${command}`)
    if (args[0] === 'ls-remote') {
      if (scenario.lsRemoteThrows) throw new Error(scenario.lsRemoteThrows)
      if (String(args[2] || '').startsWith('refs/tags')) {
        return { stdout: scenario.upstreamTags ?? (scenario.upstreamTag ? `${scenario.upstream}\trefs/tags/${scenario.upstreamTag}\n` : ''), stderr: '' }
      }
      return { stdout: `${scenario.upstream}\tHEAD\n${scenario.upstream}\trefs/heads/${scenario.branch || 'main'}\n`, stderr: '' }
    }
    if (args[0] === 'merge-base') {
      // `git merge-base --is-ancestor <upstreamHead> <head>`: ancestor → exit 0, anything else is
      // a git failure. Only consulted when local-patched HEADs need decoration.
      if (scenario.ancestor) return { stdout: '', stderr: '' }
      throw new Error('fatal: not a valid object name --is-ancestor')
    }
    if (args[0] === 'log') {
      // `git log -1 --format=%s <upstreamHead>` — the release-commit-subject mapping leg (the live
      // 2026-11-15 case: upstream never tagged v2.90.0, the version lives in the subject only).
      if (String(args[1] || '') === '-1' && scenario.releaseTitle) return { stdout: `${scenario.releaseTitle}\n`, stderr: '' }
      throw new Error('fatal: bad object')
    }
    if (args[0] === 'rev-parse') {
      if (scenario.revParseThrows) throw new Error(scenario.revParseThrows)
      return { stdout: `${scenario.head}\n`, stderr: '' }
    }
    if (args[0] === 'branch') return { stdout: `${scenario.localBranch ?? 'main'}\n`, stderr: '' }
    if (args[0] === 'status') {
      if (scenario.statusThrows) throw new Error(scenario.statusThrows)
      return { stdout: scenario.porcelain ?? '', stderr: '' }
    }
    if (args[0] === 'rev-list') {
      if (scenario.revListThrows) throw new Error(scenario.revListThrows)
      const range = String(args[2] || '')
      const [from] = range.split('..')
      const value = from === scenario.head ? (scenario.behind ?? '0') : (scenario.ahead ?? '0')
      return { stdout: `${value}\n`, stderr: '' }
    }
    throw new Error(`unexpected git ${args.join(' ')}`)
  }
  impl.calls = calls
  return impl
}

function makeUpdater(scenario, overrides = {}) {
  const root = overrides.root
  const spawned = []
  const updater = new SparkdashUpdater({
    manager: { root },
    logger: undefined,
    runImpl: overrides.runImpl || makeGit(scenario || {}),
    spawnImpl: overrides.spawnImpl || ((command, args) => { spawned.push(args); return { once() {}, unref() {} } }),
    // Scenarios describe what git answers; the disk is mocked to match them (the ENOENT
    // regression case below overrides existsImpl with the real predicate).
    existsImpl: overrides.existsImpl || (() => true),
    config: {
      localDir: '/fake/sparkdash-checkout',
      ...overrides.config,
    },
  })
  updater.spawned = spawned
  return updater
}

const PLAN = {
  steps: [
    { command: ['git', 'fetch', 'origin'] },
    { command: ['git', 'merge', '--ff-only', 'origin/main'] },
    { command: ['npm', 'ci'] },
    { command: ['/bin/launchctl', 'kickstart', '-k', 'gui/500/com.test.sparkdash'] },
  ],
  verify: [{ command: ['/usr/bin/true'] }],
}

function upgradeBody(targetCommit = B, ack = true) {
  const body = { targetCommit }
  if (ack) body.acknowledgeOutage = true
  return body
}

async function readAudit(root) {
  try {
    const text = await readFile(path.join(root, 'sparkdash-upgrade-audit.jsonl'), 'utf8')
    return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

test('parseLsRemoteHead prefers the tracked branch line over a bare HEAD', () => {
  assert.equal(parseLsRemoteHead(`${A}\tHEAD\n${B}\trefs/heads/main\n`), B)
  assert.equal(parseLsRemoteHead(`${A}\tHEAD\n`), A)
  assert.throws(() => parseLsRemoteHead('garbage'), /未返回可解析/)
})

test('parseUpgradePlan rejects malformed runbooks', () => {
  assert.equal(parseUpgradePlan(undefined), null)
  assert.equal(parseUpgradePlan('not json'), null)
  assert.equal(parseUpgradePlan({ steps: [] }), null)
  assert.equal(parseUpgradePlan({ steps: [{ command: 'git pull' }] }), null)
  assert.equal(parseUpgradePlan({ steps: [{ command: ['git', 'pull'] }], rollback: [{ command: [] }] }), null)
  assert.ok(parseUpgradePlan(JSON.stringify(PLAN)))
})

test('check reports behind N commits and opens the gate once the runbook plan is loaded', async () => {
  const root = await tempDir('behind')
  const updater = makeUpdater({ head: A, upstream: B, behind: '3', ahead: '0' }, { root, config: { localDir: '/fake/sparkdash-checkout', upgradePlan: PLAN } })
  const status = await updater.check()
  assert.equal(status.deployed, true)
  assert.equal(status.upstreamHead, B)
  assert.equal(status.local.commit, A)
  assert.equal(status.upToDate, false)
  assert.equal(status.behind, 3)
  assert.equal(status.updateAvailable, true)
  assert.equal(status.gate.passed, true)
  assert.equal(status.canUpgrade, true, 'clean worktree + plan → the button may open')
})

test('without the runbook plan the upgrade stays fail-closed behind missing-plan', async () => {
  const root = await tempDir('noplan')
  const updater = makeUpdater({ head: A, upstream: B, behind: '1' }, { root })
  const status = await updater.check()
  assert.equal(status.updateAvailable, true)
  assert.equal(status.canUpgrade, false)
  assert.equal(status.gate.blockedBy, 'missing-plan')
  assert.equal(status.planLoaded, false)
  await assert.rejects(updater.startUpgrade(upgradeBody()), error => error.statusCode === 409 && /闸门未通过/.test(error.message))
  const audit = await readAudit(root)
  assert.deepEqual(audit.map(e => [e.action, e.gate?.blockedBy]), [['upgrade-blocked', 'missing-plan']])
})

test('identical SHAs read "HEAD 一致" — never a semver-fabricated green', async () => {
  const root = await tempDir('uptodate')
  const updater = makeUpdater({ head: A, upstream: A }, { root, config: { localDir: '/fake/sparkdash-checkout', upgradePlan: PLAN } })
  const status = await updater.check()
  assert.equal(status.upToDate, true)
  assert.equal(status.behind, null)
  assert.equal(status.updateAvailable, false)
  assert.equal(status.canUpgrade, false)
})

// UPGRADE-002 改变了本案的语义：脏改不再阻断升级（worker 侧自动 stash/pop），卡面闸放行并把
// 「将自动暂存」如实写进 notes。fail-closed 的职责移到 worker 复检腿（git status 不可读即败）。
test('dirty worktree no longer gates the upgrade; the card declares the auto-stash in notes', async () => {
  const root = await tempDir('dirty')
  const updater = makeUpdater({ head: A, upstream: B, behind: '2', porcelain: ' M nodes.sh\n?? start.sh\n' }, { root, config: { localDir: '/fake/sparkdash-checkout', upgradePlan: PLAN } })
  const status = await updater.check()
  assert.equal(status.local.dirty, true)
  assert.equal(status.local.dirtyCount, 2, 'the dirty facts stay honestly reported on the card')
  assert.equal(status.gate.passed, true, 'UPGRADE-002: dirty worktrees are auto-stashed by the worker, not blocked')
  assert.equal(status.canUpgrade, true)
  assert.ok((status.notes || []).some(note => note.includes('自动暂存') && note.includes('2')), 'notes must declare the pending auto-stash with the entry count')
  await updater.startUpgrade(upgradeBody())
  assert.equal(updater.spawned.length, 1, 'the upgrade launches instead of a 409 block')

  const rootBlind = await tempDir('dirty-blind')
  const blind = makeUpdater({ head: A, upstream: B, behind: '2', statusThrows: 'fatal: not a git repository' }, { root: rootBlind, config: { localDir: '/fake/sparkdash-checkout', upgradePlan: PLAN } })
  const blindStatus = await blind.check()
  assert.equal(blindStatus.local.dirty, true, 'an unreadable worktree still counts as dirty (fail-closed reporting)')
  assert.ok((blindStatus.notes || []).some(note => note.includes('无法确认') && note.includes('阻断')), 'the card honestly declares the unreadable worktree and its fail-closed fate')
})

test('missing checkout reports 未部署 honestly and refuses upgrades with 503', async () => {
  const root = await tempDir('missing')
  const unconfigured = makeUpdater({ upstream: B }, { root, config: { localDir: null } })
  const status = await unconfigured.check()
  assert.equal(status.deployed, false)
  assert.equal(status.gate.blockedBy, 'missing-checkout')
  assert.match(status.gate.reasons[0], /SPARKDASH-LOCAL-001/)
  assert.equal(status.canUpgrade, false)
  await assert.rejects(unconfigured.startUpgrade(upgradeBody()), error => error.statusCode === 503 && /未部署/.test(error.message))

  const notRepo = makeUpdater({ head: A, upstream: B, revParseThrows: 'fatal: not a git repository' }, { root, config: { localDir: '/fake/gone', upgradePlan: PLAN } })
  const broken = await notRepo.check()
  assert.equal(broken.deployed, false)
  assert.match(broken.localError, /not a git repository/)
})

// UI-002 实景回归炮（总务 15:1x 逮到的装窗前现势态）：localDir 已注入但目录尚不存在，
// 上游探针不得吃 localDir 当 cwd（spawn 不存在目录报的就是 spawn git ENOENT），本地读解
// 也不得撞进空目录——upstreamHead 照读，gate 理由回归干净的「未部署」文案而非 ENOENT。
test('pre-install window: configured-but-missing localDir still reads upstream HEAD and keeps the gate copy clean', async () => {
  const root = await tempDir('preinstall')
  const missingDir = '/fake/sparkdash-not-installed-yet'
  const probes = []
  const runImpl = async (command, args, opts) => {
    probes.push({ args: [...args], cwd: opts?.cwd })
    if (command !== 'git') throw new Error(`unexpected command ${command}`)
    if (args[0] === 'ls-remote') return { stdout: args[2] && String(args[2]).startsWith('refs/tags') ? `${B}\trefs/tags/v2.90.0\n` : `${B}\trefs/heads/main\n`, stderr: '' }
    // Every local probe would die exactly like the real window: spawn into a void cwd.
    throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' })
  }
  const updater = makeUpdater(null, {
    root,
    runImpl,
    existsImpl: target => target !== missingDir,
    config: { localDir: missingDir, upgradePlan: PLAN },
  })
  const status = await updater.check()
  // ① 上游照读：探针与缺失的 checkout 解耦，且 provably 钉在中性 cwd 上。
  assert.equal(status.upstreamHead, B, 'upstreamHead 照读——ls-remote 不得吃缺失的 localDir 当 cwd')
  assert.equal(status.upstreamError, null)
  assert.deepEqual(probes.map(p => p.args[0]), ['ls-remote', 'ls-remote'], '目录不存在时只许上游 ls-remote 双探针（HEAD+tags），本地 git 探针一枚不发')
  assert.deepEqual(probes.map(p => p.args[2]), ['HEAD', 'refs/tags/*'])
  for (const probe of probes) assert.equal(probe.cwd, process.cwd(), '上游探针钉中性 cwd')
  assert.equal(status.upstreamTagVersion, 'v2.90.0', 'tag 语义映射不依赖本地 checkout')
  // ② gate 回归干净「未部署」文案，ENOENT 假象绝迹。
  assert.equal(status.deployed, false)
  assert.equal(status.localError, null)
  assert.equal(status.canUpgrade, false)
  assert.equal(status.gate.blockedBy, 'missing-checkout')
  assert.match(status.gate.reasons.join(' '), /未部署/)
  assert.doesNotMatch(status.gate.reasons.join(' '), /ENOENT/)
})

test('double confirmation: 400 without ack or target, 409 when the target commit drifted', async () => {
  const root = await tempDir('confirm')
  const updater = makeUpdater({ head: A, upstream: B, behind: '1' }, { root, config: { localDir: '/fake/sparkdash-checkout', upgradePlan: PLAN } })
  await assert.rejects(updater.startUpgrade({ targetCommit: B }), error => error.statusCode === 400 && /二次确认/.test(error.message))
  await assert.rejects(updater.startUpgrade({ acknowledgeOutage: true }), error => error.statusCode === 400 && /缺少目标 commit/.test(error.message))
  await assert.rejects(updater.startUpgrade(upgradeBody(A)), error => error.statusCode === 409 && /与上游 HEAD 不一致/.test(error.message))
  await assert.rejects(updater.startUpgrade(upgradeBody('not-a-sha')), error => error.statusCode === 409)
  // a target that matches HEAD itself is "already up to date", not a valid upgrade
  const sameRoot = await tempDir('confirm-same')
  const same = makeUpdater({ head: A, upstream: A }, { root: sameRoot, config: { localDir: '/fake/sparkdash-checkout', upgradePlan: PLAN } })
  await assert.rejects(same.startUpgrade(upgradeBody(A)), error => error.statusCode === 409 && /HEAD 一致/.test(error.message))
})

test('accepted upgrade spawns the detached worker, writes state and audits the request', async () => {
  const root = await tempDir('start')
  const updater = makeUpdater({ head: A, upstream: B, behind: '1' }, { root, config: { localDir: '/fake/sparkdash-checkout', upgradePlan: PLAN } })
  const result = await updater.startUpgrade(upgradeBody(), { id: 'admin-page' })
  assert.equal(result.state, 'installing')
  assert.equal(result.targetCommit, B)
  assert.equal(updater.spawned.length, 1)
  assert.match(updater.spawned[0][0], /sparkdash-updater\.js$/)
  const workerConfig = JSON.parse(updater.spawned[0][1])
  assert.equal(workerConfig.beforeCommit, A)
  assert.equal(workerConfig.targetCommit, B)
  assert.deepEqual(workerConfig.plan, PLAN)
  const state = JSON.parse(await readFile(path.join(root, 'sparkdash-update-state.json'), 'utf8'))
  assert.equal(state.state, 'installing')
  const audit = await readAudit(root)
  assert.deepEqual(audit.map(e => e.action), ['upgrade-request'])
  // busy guard on a second click
  await assert.rejects(updater.startUpgrade(upgradeBody()), error => error.statusCode === 409 && /进行中/.test(error.message))
})

test('busy installing state flips to completed once the checkout reaches the target commit', async () => {
  const root = await tempDir('flip')
  const updater = makeUpdater({ head: B, upstream: B }, { root, config: { localDir: '/fake/sparkdash-checkout', upgradePlan: PLAN } })
  await updater.writeState({ state: 'installing', targetCommit: B, startedAt: new Date().toISOString(), message: 'x' })
  const status = await updater.check()
  assert.equal(status.state, 'completed')
  assert.match(status.message, /已升级 sparkDash/)
})

test('upstream probe failure and unfetched behind stay honest readings, never fake greens', async () => {
  const root = await tempDir('probe')
  const down = makeUpdater({ head: A, upstream: B, lsRemoteThrows: 'fatal: unable to access' }, { root })
  const status = await down.check()
  assert.equal(status.upstreamHead, null)
  assert.equal(status.updateAvailable, false)
  assert.match(status.upstreamError, /unable to access/)

  const rootUnfetched = await tempDir('unfetched')
  const unfetched = makeUpdater({ head: A, upstream: B, revListThrows: 'fatal: bad object' }, { root: rootUnfetched, config: { localDir: '/fake/sparkdash-checkout', upgradePlan: PLAN } })
  const behindBlind = await unfetched.check()
  assert.equal(behindBlind.behind, null)
  assert.ok(behindBlind.notes.some(note => /behind 计数待 fetch/.test(note)))
  assert.equal(behindBlind.updateAvailable, true, 'a known-newer upstream is still an upgrade even without the count')
})

test('REPO-WATCH ledger cross-check: mismatch defers to the live ls-remote reading with a note', async () => {
  const root = await tempDir('ledger')
  const ledgerFile = path.join(root, 'repo-watch.jsonl')
  await writeFile(ledgerFile, `2026-11-13T10:30:00Z ls-remote ${A}\n2026-11-14T10:30:00Z ls-remote ${A}\n`)
  const stale = makeUpdater({ head: 'c'.repeat(40), upstream: B, behind: '2' }, { root, config: { localDir: '/fake/sparkdash-checkout', ledgerFile } })
  const staleStatus = await stale.check()
  assert.equal(staleStatus.ledger.head, A)
  assert.ok(staleStatus.notes.some(note => /以实测为准/.test(note)))

  const aligned = makeUpdater({ head: 'c'.repeat(40), upstream: B, behind: '2' }, { root, config: { localDir: '/fake/sparkdash-checkout', ledgerFile: path.join(root, 'ledger-aligned') } })
  await writeFile(path.join(root, 'ledger-aligned'), `2026-11-14T10:30:00Z ls-remote ${B}\n`)
  const alignedStatus = await aligned.check()
  assert.equal(alignedStatus.ledger.head, B)
  assert.ok(!alignedStatus.notes.some(note => /不一致/.test(note)))

  const missing = await readLedgerReading(path.join(root, 'no-such-ledger'))
  assert.equal(missing.present, false)
  assert.match(missing.note, /以 UI 实测/)
})

test('ledger reader is repo-aware over the human 台账.md (B⑤): baseline-table row wins, litellm/short SHAs ignored', async () => {
  const root = await tempDir('ledger-repo')
  const ledgerFile = path.join(root, '台账.md')
  const LITELLM_SHA = 'c'.repeat(40)
  const SPARK_SHA = 'e'.repeat(40)
  await writeFile(ledgerFile, [
    '| # | 仓库 | HEAD sha | 末 commit 时刻 | 落位 |',
    '|---|---|---|---|---|',
    `| 1 | MiaAI-Lab/sparkDash | \`${SPARK_SHA}\` | 2026-11-12T02:00:19+02:00 | spark0 |`,
    `| BerriAI/litellm | \`${LITELLM_SHA}\` | venv pip 1.106.2 | litellm_load |`,
    '| 2026-11-14 午 | litellm 上游 MOVED：abc1234→def5678；余四仓 SAME（sparkDash 24daeb57 双源同刻验） | 例行 | 注记 |',
  ].join('\n'))
  const reading = await readLedgerReading(ledgerFile, 'https://github.com/MiaAI-Lab/sparkDash.git')
  assert.equal(reading.head, SPARK_SHA, 'the sparkDash baseline row must win over the newer litellm row')
  assert.match(reading.raw, /sparkDash/)
  // even when the newest row lacks a full sparkDash SHA the baseline row keeps the cross-check alive
  const updater = makeUpdater({ head: 'a'.repeat(40), upstream: SPARK_SHA, behind: '1' }, { root, config: { localDir: '/fake/sparkdash-checkout', ledgerFile } })
  const status = await updater.check()
  assert.equal(status.ledger.head, SPARK_SHA)
  assert.ok(!status.notes.some(note => /不一致/.test(note)), 'aligned readings must not add a mismatch note')
})

test('string runbook steps (B④ 照抄即用) run via /bin/sh with <target_sha>/<previous_sha> filled', async () => {
  const root = await tempDir('string-plan')
  const B4_PLAN = {
    steps: [
      'git -C ~/ai/sparkDash fetch origin main',
      'git -C ~/ai/sparkDash merge --ff-only origin/main',
      'npm --prefix ~/ai/sparkDash ci',
      'launchctl kickstart -k gui/$(id -u)/com.daibo.sparkdash',
    ],
    verify: ['test "$(git -C ~/ai/sparkDash rev-parse HEAD)" = <target_sha>'],
    rollback: ['git -C ~/ai/sparkDash checkout <previous_sha>', 'launchctl kickstart -k gui/$(id -u)/com.daibo.sparkdash'],
  }
  assert.ok(parseUpgradePlan(B4_PLAN), 'the B④ shape must parse verbatim')
  assert.equal(parseUpgradePlan({ steps: ['   '] }), null, 'a blank shell line is still invalid')
  const runner = workerRunner({ finalHead: B, rollbackHead: A })
  await performSparkdashUpgrade(await workerConfig(root, B4_PLAN), { runCommand: runner })
  const shCalls = runner.calls.filter(call => call[0] === '/bin/sh' && call[1] === '-c')
  assert.ok(shCalls.some(call => call[2].includes('npm --prefix ~/ai/sparkDash ci')))
  assert.ok(shCalls.some(call => call[2] === `test "$(git -C ~/ai/sparkDash rev-parse HEAD)" = ${B}`), '<target_sha> must be filled with the pinned target')
  const state = JSON.parse(await readFile(path.join(root, 'sparkdash-update-state.json'), 'utf8'))
  assert.equal(state.state, 'completed')
})

function workerRunner({ stepFailAt = -1, finalHead, rollbackHead, dirtyBefore = '', behind = '0', ahead = '0', ancestor = true, rebaseFails = false, stashList = '', popFails = false, patchShas = '' } = {}) {
  const calls = []
  let rolled = false
  let stashedOnce = false
  let stepIndex = 0
  return Object.assign(async (command, args) => {
    calls.push([command, ...args])
    if (command === 'git' && args[0] === 'status') return { stdout: dirtyBefore, stderr: '' }
    // SPARKDASH-UPGRADE-002 legs: auto-stash / ahead-detection / ancestor gate / auto-rebase.
    if (command === 'git' && args[0] === 'stash' && args[1] === 'push') { stashedOnce = true; return { stdout: '', stderr: '' } }
    if (command === 'git' && args[0] === 'stash' && args[1] === 'list') return { stdout: stashList, stderr: '' }
    if (command === 'git' && args[0] === 'stash' && args[1] === 'pop') {
      if (popFails) throw new Error('git stash pop exited with code 1: CONFLICT (content): merge conflict')
      stashedOnce = false
      return { stdout: '', stderr: '' }
    }
    if (command === 'git' && args[0] === 'rev-list' && args[1] === '--count') {
      const range = String(args[2] || '')
      return { stdout: `${range.startsWith('HEAD..') ? behind : ahead}\n`, stderr: '' }
    }
    if (command === 'git' && args[0] === 'rev-list') return { stdout: `${patchShas}\n`, stderr: '' }
    if (command === 'git' && args[0] === 'merge-base') {
      if (!ancestor) throw new Error('fatal: merge-base --is-ancestor exited with code 1')
      return { stdout: '', stderr: '' }
    }
    if (command === 'git' && args[0] === 'rebase') {
      if (args[1] === '--abort') return { stdout: '', stderr: '' }
      if (rebaseFails) throw new Error('git rebase exited with code 1: could not apply local patch')
      return { stdout: '', stderr: '' }
    }
    if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${rolled ? rollbackHead : finalHead}\n`, stderr: '' }
    if (command === 'git' && args[0] === 'checkout') { rolled = true; return { stdout: '', stderr: '' } }
    // The UPGRADE-002 preflight fetch (`fetch origin <branch>`) never consumes stepFailAt slots:
    // the runbook step counter stays reserved for the plan's own steps.
    if (command === 'git' && args[0] === 'fetch' && args.length === 3) return { stdout: '', stderr: '' }
    if (command === 'git' && (args[0] === 'fetch' || args[0] === 'merge')) {
      if (stepIndex === stepFailAt) throw new Error(`step failed: git ${args.join(' ')}`)
      stepIndex += 1
      return { stdout: '', stderr: '' }
    }
    if (command === 'npm' && args[0] === 'ci') {
      if (stepIndex === stepFailAt) throw new Error('npm ci exited with code 1')
      stepIndex += 1
      return { stdout: '', stderr: '' }
    }
    if (command === '/bin/launchctl' || command === '/usr/bin/true' || command === '/bin/sh') return { stdout: '', stderr: '' }
    throw new Error(`unexpected ${command} ${args.join(' ')}`)
  }, { calls })
}

async function workerConfig(root, plan = PLAN) {
  return {
    repoUrl: 'https://github.example/sparkDash.git',
    branch: 'main',
    localDir: '/fake/sparkdash-checkout',
    plan,
    beforeCommit: A,
    targetCommit: B,
    transactionId: 'tx-test-001',
    stateFile: path.join(root, 'sparkdash-update-state.json'),
    auditFile: path.join(root, 'sparkdash-upgrade-audit.jsonl'),
    logFile: path.join(root, 'sparkdash-update.log'),
    backupDir: path.join(root, 'updates', 'sparkdash-test'),
  }
}

test('worker runs the runbook steps, verifies the HEAD read-back and completes with audit', async () => {
  const root = await tempDir('worker-ok')
  const runner = workerRunner({ finalHead: B })
  await performSparkdashUpgrade(await workerConfig(root), { runCommand: runner })
  assert.ok(runner.calls.some(call => call.join(' ') === 'git fetch origin'))
  assert.ok(runner.calls.some(call => call.join(' ') === 'npm ci'))
  assert.ok(runner.calls.some(call => call[0] === '/bin/launchctl'))
  const state = JSON.parse(await readFile(path.join(root, 'sparkdash-update-state.json'), 'utf8'))
  assert.equal(state.state, 'completed')
  const audit = await readAudit(root)
  assert.deepEqual(audit.map(e => e.action), ['upgrade-completed'])
  assert.equal(audit[0].to, B)
  const before = JSON.parse(await readFile(path.join(root, 'updates', 'sparkdash-test', 'before.json'), 'utf8'))
  assert.equal(before.beforeCommit, A)
  assert.equal(before.targetCommit, B)
})

test('worker failing mid-runbook rolls back with git checkout and audits the failure', async () => {
  const root = await tempDir('worker-fail')
  const runner = workerRunner({ stepFailAt: 2, finalHead: B, rollbackHead: A })
  await performSparkdashUpgrade(await workerConfig(root), { runCommand: runner })
  assert.ok(!runner.calls.some(call => call[0] === '/bin/launchctl'), 'the restart step must not run after npm ci failed')
  const checkout = runner.calls.find(call => call[0] === 'git' && call[1] === 'checkout')
  assert.deepEqual(checkout, ['git', 'checkout', A])
  const state = JSON.parse(await readFile(path.join(root, 'sparkdash-update-state.json'), 'utf8'))
  assert.equal(state.state, 'failed')
  assert.match(state.message, /已回退/)
  const audit = await readAudit(root)
  assert.equal(audit[0].action, 'upgrade-failed')
  assert.equal(audit[0].rolledBack, true)
  process.exitCode = 0
})

// SPARKDASH-UPGRADE-002 semantics change: a dirty worktree no longer blocks the worker — the
// dirty entries ride an auto-stash tagged with the transaction id. The old fail-closed re-check
// case becomes the auto-stash round-trip case (full ① leg matrix lives in the UPGRADE-002 block).
test('worker auto-stashes a dirty worktree (tx-tagged) instead of blocking, then completes', async () => {
  const root = await tempDir('worker-dirty')
  const runner = workerRunner({ finalHead: B, dirtyBefore: ' M src/app.jsx\n', stashList: 'stash@{0}	On main: auto-upgrade tx-test-001 (1 entries)' })
  await performSparkdashUpgrade(await workerConfig(root), { runCommand: runner })
  assert.ok(runner.calls.some(call => call.join(' ') === 'git stash push --include-untracked -m auto-upgrade tx-test-001 (1 entries)'), 'dirty entries must ride an auto-stash tagged with the transaction id')
  assert.ok(runner.calls.some(call => call[1] === 'fetch' || call[0] === 'npm'), 'the runbook may run once the worktree is clean via auto-stash')
  const state = JSON.parse(await readFile(path.join(root, 'sparkdash-update-state.json'), 'utf8'))
  assert.equal(state.state, 'completed')
  const audit = await readAudit(root)
  assert.equal(audit[0].action, 'upgrade-completed')
  assert.equal(audit[0].stashed, true)
  process.exitCode = 0
})

test('worker HEAD read-back gate fails when HEAD does not descend from the target, not a completed lie', async () => {
  const root = await tempDir('worker-head')
  const runner = workerRunner({ finalHead: 'd'.repeat(40), rollbackHead: A, ancestor: false })
  await performSparkdashUpgrade(await workerConfig(root), { runCommand: runner })
  const audit = await readAudit(root)
  assert.equal(audit[0].action, 'upgrade-failed')
  assert.match(audit[0].reason, /HEAD 回读门未过/)
  assert.equal(audit[0].rolledBack, true)
  process.exitCode = 0
})

// UI-006（2026-11-15 用户令）：SparkDash 卡面版本=tag 版本号（现势 v2.90.0）。本地 clone 的 tag 集
// 可能滞后（现势家场：本地 tags 止于 v2.32.0，而 HEAD 是 v2.90.0+1 家装提交），故映射以**上游
// refs/tags/* + 本地祖先关系**定夺，本地 describe 不采信：
// ① HEAD 恰为上游某 tag 的目标 sha → tag 名逐字；② 家装提交骑在上游发布 commit 之上（ahead>0 且
// is-ancestor 过）→ git describe 风格装饰形 v2.90.0-1-gxxxxxxx；③ 都不成立 → null，卡面诚实
// 「未标记 commit xxxxxxx」。版本永不造假。
test('UI-006 tag version: upstream tag mapping + ancestry decoration, honest untagged', async () => {
  const root = await tempDir('tags')
  const tagged = makeUpdater({ head: A, upstream: B, behind: '1', upstreamTags: `${B}\trefs/tags/v2.90.0\n${A}\trefs/tags/v2.89.0\n` }, { root, config: { localDir: '/fake/sparkdash-checkout', upgradePlan: PLAN } })
  const status = await tagged.check()
  assert.equal(status.localTagVersion, 'v2.89.0', 'HEAD 恰为上游 tag 目标 sha → tag 名逐字（不依赖本地 clone tag 集）')
  assert.equal(status.upstreamTagVersion, 'v2.90.0', '上游 tag=ls-remote refs/tags/* 对 HEAD 的映射')

  const decoRoot = await tempDir('tags-deco')
  const deco = makeUpdater({ head: A, upstream: B, behind: '0', ahead: '1', ancestor: true, upstreamTag: 'v2.90.0' }, { root: decoRoot, config: { localDir: '/fake/sparkdash-checkout', upgradePlan: PLAN } })
  const decoStatus = await deco.check()
  assert.equal(decoStatus.localTagVersion, `v2.90.0-1-g${A.slice(0, 7)}`, '家装提交骑在发布 commit 之上 → describe 风格装饰形如实透出（现势 d77d1a3 案）')

  // 现势家场实案：上游从未打 v2.90.0 tag（ls-remote 全集仅 media-showcase/v2.31.0/v2.32.0，API 三路
  // 互证），版本只写在 HEAD commit 标题里 → 标题映射点亮 v2.90.0 并装饰本地家装提交，notes 留证据行。
  const titleRoot = await tempDir('tags-title')
  const title = makeUpdater({ head: A, upstream: B, behind: '0', ahead: '1', ancestor: true, releaseTitle: 'Release v2.90.0 and highlight it in README' }, { root: titleRoot, config: { localDir: '/fake/sparkdash-checkout', upgradePlan: PLAN } })
  const titleStatus = await title.check()
  assert.equal(titleStatus.upstreamTagVersion, 'v2.90.0', '无 tag 时版本取自发布 commit 标题（上游自己声明，非造假）')
  assert.equal(titleStatus.localTagVersion, `v2.90.0-1-g${A.slice(0, 7)}`, '卡面读数：标题映射 base + 家装提交装饰')
  assert.ok((titleStatus.notes || []).some(note => note.includes('上游未对') && note.includes('打 tag')), 'notes 如实留「tag 缺失、版本源自标题」证据行')

  const sameRoot = await tempDir('tags-same')
  const same = makeUpdater({ head: B, upstream: B, upstreamTag: 'v2.90.0' }, { root: sameRoot, config: { localDir: '/fake/sparkdash-checkout', upgradePlan: PLAN } })
  const sameStatus = await same.check()
  assert.equal(sameStatus.upToDate, true)
  assert.equal(sameStatus.localTagVersion, 'v2.90.0', 'HEAD 逐字等值时继承上游 tag（同一发布映射）')

  const bareRoot = await tempDir('tags-bare')
  const bare = makeUpdater({ head: A, upstream: B, behind: '1' }, { root: bareRoot, config: { localDir: '/fake/sparkdash-checkout', upgradePlan: PLAN } })
  const bareStatus = await bare.check()
  assert.equal(bareStatus.localTagVersion, null, '无 tag 不造假版本')
  assert.equal(bareStatus.upstreamTagVersion, null)
})

// ─── SPARKDASH-UPGRADE-002（2026-11-18 用户亲批根治案）锁定块 ───────────────────────────
// 升级腿三处改造的锁定案：①脏改自动 stash/pop（stash 件带事务 id 可追溯归位，pop 冲突停人工
// 裁决+审计详情）②ahead 本地补丁自动 rebase（替代 ff-only 炸 Diverging，冲突 abort 复原走败退）
// ③回读门严等→ancestor（补丁在头不再假败，补丁 SHA 入审计）。验收母本=11-18 人肉归置全流程。
const C = 'c'.repeat(40)

test('UPGRADE-002 ①a: completed run auto-pops the tx-tagged stash (round trip)', async () => {
  const root = await tempDir('u2-pop-ok')
  const runner = workerRunner({ finalHead: B, dirtyBefore: ' M config/settings.json\n', stashList: 'stash@{0}	On main: auto-upgrade tx-test-001 (1 entries)' })
  await performSparkdashUpgrade(await workerConfig(root), { runCommand: runner })
  assert.ok(runner.calls.some(call => call.join(' ') === 'git stash pop stash@{0}'), 'the tx-tagged entry found by stash list must be popped on success')
  const state = JSON.parse(await readFile(path.join(root, 'sparkdash-update-state.json'), 'utf8'))
  assert.equal(state.state, 'completed')
  assert.ok(!state.message.includes('人工裁决'), 'a clean pop leaves no human-adjudication flag')
  const audit = await readAudit(root)
  assert.equal(audit[0].action, 'upgrade-completed')
  assert.equal(audit[0].stashed, true)
  assert.equal(audit[0].stashPopNote, null)
  assert.equal(audit[0].transactionId, 'tx-test-001')
})

test('UPGRADE-002 ①b: a conflicting auto-pop keeps completed but files an audit adjudication line', async () => {
  const root = await tempDir('u2-pop-conflict')
  const runner = workerRunner({ finalHead: B, dirtyBefore: ' M config/settings.json\n', stashList: 'stash@{0}	On main: auto-upgrade tx-test-001 (1 entries)', popFails: true })
  await performSparkdashUpgrade(await workerConfig(root), { runCommand: runner })
  const state = JSON.parse(await readFile(path.join(root, 'sparkdash-update-state.json'), 'utf8'))
  assert.equal(state.state, 'completed', 'the upgrade itself landed — a pop conflict must not flip it')
  assert.match(state.message, /停在人工裁决/)
  const audit = await readAudit(root)
  assert.deepEqual(audit.map(e => e.action), ['stash-pop-conflict', 'upgrade-completed'])
  assert.equal(audit[0].stashRef, 'stash@{0}')
  assert.equal(audit[0].transactionId, 'tx-test-001')
  assert.match(audit[0].detail, /CONFLICT/)
})

test('UPGRADE-002 ①c: a clean worktree never touches the stash stack', async () => {
  const root = await tempDir('u2-clean')
  const runner = workerRunner({ finalHead: B })
  await performSparkdashUpgrade(await workerConfig(root), { runCommand: runner })
  assert.ok(!runner.calls.some(call => call[0] === 'git' && call[1] === 'stash'), 'no dirty entries, no stash push/pop/list')
  const audit = await readAudit(root)
  assert.equal(audit[0].action, 'upgrade-completed')
  assert.equal(audit[0].stashed, false)
})

test('UPGRADE-002 ②a: diverging ahead-patch is auto-rebased onto the target before the runbook', async () => {
  const root = await tempDir('u2-rebase-ok')
  const runner = workerRunner({ finalHead: C, rollbackHead: A, behind: '2', ahead: '1', ancestor: true, patchShas: C })
  await performSparkdashUpgrade(await workerConfig(root), { runCommand: runner })
  assert.ok(runner.calls.some(call => call.join(' ') === `git rebase ${B}`), 'ahead commits must be replayed via git rebase <target>')
  const state = JSON.parse(await readFile(path.join(root, 'sparkdash-update-state.json'), 'utf8'))
  assert.equal(state.state, 'completed')
  assert.match(state.message, /本地补丁保留在顶/)
  const audit = await readAudit(root)
  assert.deepEqual(audit[0].patchShas, [C], 'the audit line records the surviving local patch SHAs')
})

test('UPGRADE-002 ②b: a rebase conflict aborts, rolls back honestly and keeps the stash traceable', async () => {
  const root = await tempDir('u2-rebase-fail')
  const runner = workerRunner({ finalHead: A, rollbackHead: A, behind: '2', ahead: '1', ancestor: true, rebaseFails: true, dirtyBefore: ' M config/settings.json\n', stashList: 'stash@{0}	On main: auto-upgrade tx-test-001 (1 entries)' })
  await performSparkdashUpgrade(await workerConfig(root), { runCommand: runner })
  assert.ok(runner.calls.some(call => call.join(' ') === 'git rebase --abort'), 'the failed rebase must be aborted to restore the worktree')
  assert.ok(!runner.calls.some(call => call[0] === 'git' && call[1] === 'checkout'), 'after an aborted rebase a checkout would only fake a detached HEAD')
  const state = JSON.parse(await readFile(path.join(root, 'sparkdash-update-state.json'), 'utf8'))
  assert.equal(state.state, 'failed')
  assert.match(state.message, /rebase 失败/)
  assert.match(state.message, /git stash pop stash@\{0\}/, 'the failed run must hand the human the exact restore command for the stashed edits')
  const audit = await readAudit(root)
  assert.equal(audit[0].action, 'upgrade-failed')
  assert.equal(audit[0].rolledBack, true)
  assert.equal(audit[0].stashRef, 'stash@{0}')
  assert.equal(audit[0].transactionId, 'tx-test-001')
  process.exitCode = 0
})

test('UPGRADE-002 ②c: a pure-behind checkout never rebases (ff runbook regression)', async () => {
  const root = await tempDir('u2-ff-only')
  const runner = workerRunner({ finalHead: B, behind: '2', ahead: '0' })
  await performSparkdashUpgrade(await workerConfig(root), { runCommand: runner })
  assert.ok(!runner.calls.some(call => call[0] === 'git' && call[1] === 'rebase'), 'no ahead commits means the runbook ff path runs untouched')
  const audit = await readAudit(root)
  assert.equal(audit[0].action, 'upgrade-completed')
  assert.deepEqual(audit[0].patchShas, [])
})

test('UPGRADE-002 ③: a local patch on top passes the ancestor read-back gate (no false failure)', async () => {
  const root = await tempDir('u2-ancestor-gate')
  const runner = workerRunner({ finalHead: C, ancestor: true, ahead: '1', patchShas: C })
  await performSparkdashUpgrade(await workerConfig(root), { runCommand: runner })
  assert.ok(runner.calls.some(call => call.join(' ') === `git merge-base --is-ancestor ${B} ${C}`), 'the gate is descent, not strict equality: patch-on-top must pass')
  const state = JSON.parse(await readFile(path.join(root, 'sparkdash-update-state.json'), 'utf8'))
  assert.equal(state.state, 'completed', 'the 0.4.26-era strict-equality gate would have falsely failed this exact shape')
  const audit = await readAudit(root)
  assert.deepEqual(audit[0].patchShas, [C])
})
