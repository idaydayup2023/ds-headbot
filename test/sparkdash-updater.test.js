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
      return { stdout: `${scenario.upstream}\tHEAD\n${scenario.upstream}\trefs/heads/${scenario.branch || 'main'}\n`, stderr: '' }
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

test('dirty worktree blocks the upgrade, lands in audit, and stays fail-closed when unreadable', async () => {
  const root = await tempDir('dirty')
  const updater = makeUpdater({ head: A, upstream: B, behind: '2', porcelain: ' M nodes.sh\n?? start.sh\n' }, { root, config: { localDir: '/fake/sparkdash-checkout', upgradePlan: PLAN } })
  const status = await updater.check()
  assert.equal(status.local.dirty, true)
  assert.equal(status.local.dirtyCount, 2)
  assert.equal(status.gate.blockedBy, 'dirty-worktree')
  assert.equal(status.canUpgrade, false)
  await assert.rejects(updater.startUpgrade(upgradeBody()), error => error.statusCode === 409 && /脏改闸门/.test(error.message))
  const audit = await readAudit(root)
  assert.equal(audit[0].action, 'upgrade-blocked')
  assert.equal(audit[0].gate.blockedBy, 'dirty-worktree')
  assert.match(audit[0].gate.reasons[0], /nodes\.sh/)

  const rootBlind = await tempDir('dirty-blind')
  const blind = makeUpdater({ head: A, upstream: B, behind: '2', statusThrows: 'fatal: not a git repository' }, { root: rootBlind, config: { localDir: '/fake/sparkdash-checkout', upgradePlan: PLAN } })
  const blindStatus = await blind.check()
  assert.equal(blindStatus.gate.blockedBy, 'dirty-worktree', 'an unreadable worktree counts as dirty (fail-closed)')
  assert.equal(blindStatus.canUpgrade, false)
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

function workerRunner({ stepFailAt = -1, finalHead, rollbackHead, dirtyBefore = '' } = {}) {
  const calls = []
  let rolled = false
  let stepIndex = 0
  return Object.assign(async (command, args) => {
    calls.push([command, ...args])
    if (command === 'git' && args[0] === 'status') return { stdout: dirtyBefore, stderr: '' }
    if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${rolled ? rollbackHead : finalHead}\n`, stderr: '' }
    if (command === 'git' && args[0] === 'checkout') { rolled = true; return { stdout: '', stderr: '' } }
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
    if (command === '/bin/launchctl' || command === '/usr/bin/true') return { stdout: '', stderr: '' }
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

test('worker re-checks the dirty gate before touching anything (check→exec window)', async () => {
  const root = await tempDir('worker-dirty')
  const runner = workerRunner({ finalHead: B, dirtyBefore: ' M src/app.jsx\n' })
  await performSparkdashUpgrade(await workerConfig(root), { runCommand: runner })
  assert.ok(!runner.calls.some(call => call[1] === 'fetch' || call[0] === 'npm'), 'no runbook step may run on a dirty worktree')
  const state = JSON.parse(await readFile(path.join(root, 'sparkdash-update-state.json'), 'utf8'))
  assert.equal(state.state, 'failed')
  assert.match(state.message, /未提交改动/)
  process.exitCode = 0
})

test('worker HEAD read-back mismatch counts as failure, not a completed lie', async () => {
  const root = await tempDir('worker-head')
  const runner = workerRunner({ finalHead: 'd'.repeat(40), rollbackHead: A })
  await performSparkdashUpgrade(await workerConfig(root), { runCommand: runner })
  const audit = await readAudit(root)
  assert.equal(audit[0].action, 'upgrade-failed')
  assert.match(audit[0].reason, /HEAD 回读不符/)
  assert.equal(audit[0].rolledBack, true)
  process.exitCode = 0
})
