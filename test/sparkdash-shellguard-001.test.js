// owner: 系统工程师 | purpose: lock tests for SPARKDASH-SHELLGUARD-001 (fail-closed on word-split paths)
// SPARKDASH-SHELLGUARD-001 acceptance: a string runbook step that would hand /bin/sh a bare
// space-carrying absolute path (the retired 2026-11-18 start.sh band: the CLI died as ENOENT on
// `/Users/…/Application` because the shell split `…/Application Support/…` before argv) must be
// refused — at the card gate AND in the worker preflight, before any git/write touches the
// worktree — while every legitimate step form (arrays, quoted paths, \-escaped paths, the B④
// `git -C /path <subcommand>` shape) runs untouched. The real checkout is never touched here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SparkdashUpdater, performSparkdashUpgrade, parseUpgradePlan, findSplitPath, findUnsafeShellSteps } from '../lib/sparkdash-updater.js'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

async function tempDir(name) {
  return mkdtemp(path.join(os.tmpdir(), `sparkdash-shellguard-${name}-`))
}

async function workerConfig(root, plan, extra = {}) {
  return {
    repoUrl: 'https://github.example/sparkDash.git',
    branch: 'main',
    localDir: '/fake/sparkdash-checkout',
    plan,
    beforeCommit: A,
    targetCommit: B,
    transactionId: 'tx-shellguard-001',
    stateFile: path.join(root, 'sparkdash-update-state.json'),
    auditFile: path.join(root, 'sparkdash-upgrade-audit.jsonl'),
    logFile: path.join(root, 'sparkdash-update.log'),
    backupDir: path.join(root, 'updates', 'sparkdash-shellguard'),
    ...extra,
  }
}

// Minimal worker runner: git bookkeeping legs answer from the scenario, every other command
// (array steps and /bin/sh alike) is only recorded — a guard test reads the tape to prove what
// never ran.
function workerRunner({ finalHead = B } = {}) {
  const calls = []
  let rolled = false
  return Object.assign(async (command, args) => {
    calls.push([command, ...args])
    if (command === 'git' && args[0] === 'status') return { stdout: '', stderr: '' }
    if (command === 'git' && args[0] === 'rev-list' && args[1] === '--count') return { stdout: '0\n', stderr: '' }
    if (command === 'git' && args[0] === 'merge-base') return { stdout: '', stderr: '' }
    if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${rolled ? A : finalHead}\n`, stderr: '' }
    if (command === 'git' && args[0] === 'checkout') { rolled = true; return { stdout: '', stderr: '' } }
    return { stdout: '', stderr: '' }
  }, { calls })
}

function makeGateUpdater(plan) {
  const updater = new SparkdashUpdater({
    manager: { root: '/fake/root' },
    logger: undefined,
    runImpl: async () => ({ stdout: '', stderr: '' }),
    spawnImpl: () => ({ once() {}, unref() {} }),
    existsImpl: () => true,
    config: { localDir: '/fake/sparkdash-checkout', upgradePlan: plan },
  })
  return updater
}

async function readState(root) {
  return JSON.parse(await readFile(path.join(root, 'sparkdash-update-state.json'), 'utf8'))
}

async function readAudit(root) {
  const text = await readFile(path.join(root, 'sparkdash-upgrade-audit.jsonl'), 'utf8')
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

// —— 焊① 检测器源形制：切词签名必红，合法形制必绿 ——

test('SHELLGUARD weld ①: the field crash line shape is flagged, quoted/escaped forms are not', () => {
  // the retired start.sh leg, verbatim in shape — this exact family produced the 6 切词 deaths
  assert.ok(findSplitPath('dsh --profile web --patch /Users/daibo/Library/Application Support/DeepSeekHarnessMaintenance/headbot-20261017-retry2/production.patch.yml --host 127.0.0.1'), 'the 6/6 field crash signature must be flagged')
  assert.ok(findSplitPath('dsh --patch ~/Library/Application Support/x/patch.yml'), 'the ~-form splits the same way')
  // quoting in any of the three accepted forms makes the path one token — the guard must keep those
  assert.equal(findSplitPath("dsh --patch '/Users/daibo/Library/Application Support/x/patch.yml' --no-open"), null)
  assert.equal(findSplitPath('dsh --patch "/Users/daibo/Library/Application Support/x/patch.yml" --no-open'), null)
  assert.equal(findSplitPath('dsh --patch /Users/daibo/Library/Application\\ Support/x/patch.yml --no-open'), null)
  // B④ 剧本主形制：`git -C <path> <subcommand>` 与 origin/main 续段绝不可误杀
  assert.equal(findSplitPath('git -C /Users/daibo/ai/sparkDash fetch origin main'), null)
  assert.equal(findSplitPath('launchctl kickstart -k gui/$(id -u)/com.daibo.sparkdash'), null)
  assert.equal(findSplitPath('test "$(git -C ~/ai/sparkDash rev-parse HEAD)" = deadbeef'), null)
  assert.equal(findSplitPath('cd /Users/daibo/My Docs && npm ci'), null, 'an operator after the path is a real boundary, not a split')
  // 引号未闭合是畸形行，fail-closed 一并拒
  assert.ok(findSplitPath("npm --prefix '/Users/daibo/My App ci"), 'an unbalanced quote must fail closed too')
})

test('SHELLGUARD weld ①b: findUnsafeShellSteps walks steps/verify/rollback', () => {
  const unsafe = findUnsafeShellSteps({
    steps: [{ command: ['git', 'status'] }, 'echo /Users/daibo/My Docs/here'],
    verify: ['test -x /usr/bin/true'],
    rollback: ['git checkout /Users/daibo/My Docs/there'],
  })
  assert.equal(unsafe.length, 2)
  assert.deepEqual(unsafe.map(item => `${item.section}[${item.index}]`), ['steps[1]', 'rollback[0]'])
  assert.match(unsafe[0].suspect, /My Docs/)
  assert.equal(findUnsafeShellSteps({ steps: [{ command: ['git', 'status'] }] }).length, 0)
  assert.equal(findUnsafeShellSteps(undefined).length, 0)
})

// —— 焊② 卡面门：unsafe-plan 阻断 + 文案 ——

test('SHELLGUARD weld ②: the gate blocks an unsafe plan with the 数组 steps copy and lets safe plans through', () => {
  const unsafe = makeGateUpdater({ steps: ['git -C /Users/daibo/My Docs/sparkDash fetch origin main'] })
  const gate = unsafe.buildGate({ deployed: true })
  assert.equal(gate.passed, false)
  assert.equal(gate.blockedBy, 'unsafe-plan')
  assert.ok(gate.reasons.some(reason => /My Docs/.test(reason)), 'the suspect fragment must ride in the reason')
  assert.ok(gate.reasons.some(reason => /runbook 一律数组 steps/.test(reason)), 'the remediation copy must point at array steps')
  assert.ok(gate.reasons.some(reason => /切词/.test(reason)))

  const safe = makeGateUpdater({ steps: [{ command: ['git', 'fetch', 'origin'] }], verify: ['test -x /usr/bin/true'] })
  assert.equal(safe.buildGate({ deployed: true }).passed, true)

  // 卡面文案源形制：missing-plan 一行也必须把数组口径写给 runbook 作者
  const missing = makeGateUpdater(undefined)
  const missingGate = missing.buildGate({ deployed: true })
  assert.equal(missingGate.blockedBy, 'missing-plan')
  assert.ok(missingGate.reasons.some(reason => /数组/.test(reason) && /command/.test(reason)), 'the missing-plan copy must teach the array form too')
})

// —— 焊③ worker preflight：先于一切 git/写，工作区零动、零回退谎称 ——

test('SHELLGUARD weld ③: the worker refuses an unsafe plan before touching anything (no git call, no rollback)', async () => {
  const root = await tempDir('preflight')
  const runner = workerRunner()
  await performSparkdashUpgrade(await workerConfig(root, {
    steps: ['git -C /Users/daibo/My Docs/sparkDash fetch origin main'],
    rollback: ['git checkout <previous_sha>'],
  }), { runCommand: runner })
  process.exitCode = 0
  assert.deepEqual(runner.calls, [], 'the preflight must fire before the first git/write')
  const state = await readState(root)
  assert.equal(state.state, 'failed')
  assert.match(state.message, /切词/)
  assert.match(state.message, /未执行任何步骤，工作区未变更/)
  assert.ok(!/已回退/.test(state.message), 'nothing was touched, so no rollback may be claimed')
  const audit = await readAudit(root)
  const failure = audit.find(entry => entry.action === 'upgrade-failed')
  assert.equal(failure.rolledBack, true)
  assert.equal(failure.stashed, false)
})

test('SHELLGUARD weld ③b: the runStep depth guard fires when placeholder filling creates the split path', async () => {
  const root = await tempDir('depth')
  const runner = workerRunner()
  // the raw step is clean (<target_sha> is no path); the filled line is what faces /bin/sh,
  // so the last line of defense has its own reachable path and its own red here
  await performSparkdashUpgrade(await workerConfig(root, {
    steps: ['git checkout <target_sha>'],
  }, { targetCommit: '/Users/daibo/My Docs/release' }), { runCommand: runner })
  process.exitCode = 0
  const shCalls = runner.calls.filter(call => call[0] === '/bin/sh')
  assert.deepEqual(shCalls, [], 'the filled split line must never reach /bin/sh')
  // the loop had entered (touched) so the default rollback checkout may run — that is existing
  // UPGRADE-002 semantics; what the depth guard owes is that the split line never faces sh.
  const state = await readState(root)
  assert.equal(state.state, 'failed')
  assert.match(state.message, /My Docs/)
  assert.match(state.message, /切词/)
})

// —— 焊④ 合法形制零伤害：数组含空格路径直传、B④ 字符串原样跑 ——

test('SHELLGUARD weld ④: array steps with space-carrying paths run untouched and B④ string plans still flow via sh', async () => {
  const root = await tempDir('arrays-ok')
  const runner = workerRunner()
  await performSparkdashUpgrade(await workerConfig(root, {
    steps: [
      { command: ['git', '-C', '/Users/daibo/My Docs/sparkDash', 'fetch', 'origin'] },
      { command: ['npm', '--prefix', '/Users/daibo/My Docs/sparkDash', 'ci'] },
      'launchctl kickstart -k gui/$(id -u)/com.daibo.sparkdash',
    ],
    verify: [{ command: ['/usr/bin/true'] }],
  }), { runCommand: runner })
  const arrays = runner.calls.filter(call => call[0] === 'git' && call[1] === '-C')
  assert.equal(arrays.length, 1)
  assert.equal(arrays[0][2], '/Users/daibo/My Docs/sparkDash', 'the space-carrying path must arrive as ONE intact argv token')
  const shCalls = runner.calls.filter(call => call[0] === '/bin/sh' && call[1] === '-c')
  assert.ok(shCalls.some(call => call[2] === 'launchctl kickstart -k gui/$(id -u)/com.daibo.sparkdash'), 'legitimate string steps still run through sh as B④ wrote them')
  const state = await readState(root)
  assert.equal(state.state, 'completed')

  // B④ 剧本原件回归：守卫不得啃掉任何合法字符串形制
  const rootB4 = await tempDir('b4-ok')
  const runnerB4 = workerRunner()
  const B4_PLAN = {
    steps: [
      'git -C ~/ai/sparkDash fetch origin main',
      'git -C ~/ai/sparkDash merge --ff-only origin/main',
      'npm --prefix ~/ai/sparkDash ci',
      'launchctl kickstart -k gui/$(id -u)/com.daibo.sparkdash',
    ],
    verify: ['test "$(git -C ~/ai/sparkDash rev-parse HEAD)" = <target_sha>'],
    rollback: ['git -C ~/ai/sparkDash checkout <previous_sha>'],
  }
  assert.ok(parseUpgradePlan(B4_PLAN), 'the B④ shape must still parse verbatim')
  await performSparkdashUpgrade(await workerConfig(rootB4, B4_PLAN), { runCommand: runnerB4 })
  const stateB4 = await readState(rootB4)
  assert.equal(stateB4.state, 'completed', 'the B④ runbook must be untouched by the guard')
})

// —— 焊⑤ 源形制：卡面与报错的"数组 steps"口径焊进源码文本 ——

test('SHELLGUARD weld ⑤: the 数组 steps guidance is welded into the shipped source text', async () => {
  const source = await readFile(new URL('../lib/sparkdash-updater.js', import.meta.url), 'utf8')
  assert.ok(/runbook 步骤一律用数组形制/.test(source), 'the missing-plan card copy must carry the array-form guidance')
  assert.ok(/runbook 一律数组 steps/.test(source), 'the unsafe-plan copy must say 数组 steps twice (gate + worker)')
  const gateCount = (source.match(/runbook 一律数组 steps/g) || []).length
  assert.ok(gateCount >= 2, 'both the gate reason and the worker error must repeat the guidance')
})
