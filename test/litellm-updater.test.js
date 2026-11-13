// LITELLM-UPGRADE-UI-001 acceptance: mock upstream + mock pip/launchd exercise the whole
// 有新版 → 闸门 → 双确认 → 执行 → 三验/回滚 chain, plus the audit trail. The real gateway,
// venv and launchd are never touched here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LitellmGatewayUpdater, runPatchGate, compareCoreVersions, performLitellmUpgrade } from '../lib/litellm-updater.js'

async function tempDir(name) {
  return mkdtemp(path.join(os.tmpdir(), `litellm-upgrade-${name}-`))
}

function makeUpdater(overrides = {}) {
  const root = overrides.root
  return new LitellmGatewayUpdater({
    manager: { root, parentHome: path.join(root, 'parent') },
    logger: undefined,
    fetchImpl: overrides.fetchImpl,
    spawnImpl: overrides.spawnImpl || (() => ({ once() {}, unref() {} })),
    runImpl: overrides.runImpl || (async () => ({ stdout: 'LiteLLM: 1.106.2', stderr: '' })),
    config: {
      gatewayUrl: 'http://gateway.test',
      patchManifest: overrides.patchManifest,
      launchdLabel: 'com.test.litellm',
      ...overrides.config,
    },
  })
}

function githubRelease(status = 200, body = { tag_name: 'v1.107.0-stable', html_url: 'https://github.example/release', draft: false, prerelease: false }) {
  return async url => {
    if (String(url).includes('/releases/latest')) {
      if (status !== 200) return { ok: false, status }
      return { ok: true, status, json: async () => body }
    }
    return { ok: true, status: 200, json: async () => [body] }
  }
}

function md5(text) {
  return createHash('md5').update(text).digest('hex')
}

test('compareCoreVersions ignores distribution suffixes', () => {
  assert.equal(compareCoreVersions('1.107.0-stable', '1.106.2'), 1)
  assert.equal(compareCoreVersions('1.106.2', '1.106.2-patch.1'), 0)
  assert.equal(compareCoreVersions('1.106.10', '1.106.9'), 1)
})

test('check surfaces upstream version, update availability and the fail-closed gate', async () => {
  const root = await tempDir('check')
  const updater = makeUpdater({ root, fetchImpl: githubRelease(), patchManifest: path.join(root, 'missing.manifest.json') })
  const status = await updater.check()
  assert.equal(status.currentVersion, '1.106.2')
  assert.equal(status.latestVersion, '1.107.0-stable')
  assert.equal(status.updateAvailable, true)
  assert.equal(status.canUpgrade, false, 'a missing baseline archive must keep the button disabled')
  assert.equal(status.gate.blockedBy, 'missing-archive')
  assert.match(status.gate.reasons[0], /升级已阻断/)
  assert.equal(status.state, 'idle')
})

test('check degrades honestly on GitHub rate limit', async () => {
  const root = await tempDir('ratelimit')
  const updater = makeUpdater({ root, fetchImpl: githubRelease(403), patchManifest: path.join(root, 'missing.manifest.json') })
  const status = await updater.check()
  assert.equal(status.latestVersion, null)
  assert.equal(status.updateAvailable, false)
  assert.match(status.checkError, /限流/)
})

test('patch gate passes a matching baseline and blocks drifted files or missing checks', async () => {
  const root = await tempDir('gate')
  const target = path.join(root, 'site-packages', 'least_busy.py')
  await mkdir(path.dirname(target), { recursive: true })
  const payload = 'def log_success_event(): ...'
  await writeFile(target, payload)
  const manifestFile = path.join(root, 'manifest.json')
  const manifest = {
    name: 'LITELLM-BALANCE-001',
    sitePackages: path.join(root, 'site-packages'),
    files: [{ path: 'least_busy.py', patchedMd5: md5(payload) }],
    checks: [
      { name: 'dry-run', command: ['/usr/bin/true'] },
      { name: 'behavior', command: ['/usr/bin/true'] },
    ],
  }
  await writeFile(manifestFile, JSON.stringify(manifest))
  const passed = await runPatchGate(manifestFile)
  assert.equal(passed.passed, true)

  await writeFile(target, payload + '\n# upstream drift\n')
  const drifted = await runPatchGate(manifestFile)
  assert.equal(drifted.passed, false)
  assert.match(drifted.reasons.join('；'), /补丁失效/)

  await writeFile(target, payload)
  await writeFile(manifestFile, JSON.stringify({ ...manifest, checks: manifest.checks.slice(0, 1) }))
  const thinChecks = await runPatchGate(manifestFile)
  assert.equal(thinChecks.passed, false)
  assert.match(thinChecks.reasons.join('；'), /干跑\/行为测/)

  await writeFile(manifestFile, JSON.stringify({ noPatch: true, reason: 'patch not applied yet' }))
  const declared = await runPatchGate(manifestFile)
  assert.equal(declared.passed, true)
  assert.equal(declared.declared, 'no-local-patch')
})

test('startUpgrade requires the outage acknowledgement, the exact target, and a passing gate', async () => {
  const root = await tempDir('guards')
  const updater = makeUpdater({ root, fetchImpl: githubRelease(), patchManifest: path.join(root, 'missing.manifest.json') })
  // 平台无关：launchd 重启能力在 CI(linux) 上恒假，本案测的是双确认/目标对表/闸门三道闸，覆写之
  updater.canRestart = () => true
  await assert.rejects(() => updater.startUpgrade({ targetVersion: '1.107.0-stable' }), /二次确认/)
  await assert.rejects(() => updater.startUpgrade({ acknowledgeOutage: true, targetVersion: '1.107.0' }), /目标版本/)
  await assert.rejects(() => updater.startUpgrade({ acknowledgeOutage: true, targetVersion: '1.107.0-stable' }), /补丁闸门未通过/)
  const audit = await updater.recentAudit(10)
  assert.equal(audit[0].action, 'upgrade-blocked')
  assert.equal(audit[0].result, 'blocked')
})

test('worker installs, restarts, verifies the triple and lands a completed audit row', async () => {
  const root = await tempDir('worker-ok')
  const calls = []
  const stateFile = path.join(root, 'state.json')
  const auditFile = path.join(root, 'audit.jsonl')
  const logFile = path.join(root, 'update.log')
  const config = {
    litellmBin: '/venv/bin/litellm', pipBin: '/venv/bin/pip', launchdLabel: 'com.test.litellm', uid: 501,
    gatewayUrl: 'http://gateway.test', manifestFile: path.join(root, 'manifest.json'),
    targetVersion: '1.107.0-stable', currentVersion: '1.106.2', stateFile, auditFile, logFile,
    backupDir: path.join(root, 'backup'),
  }
  const runCommand = async (command, args) => {
    calls.push([command, ...args])
    if (args[0] === '--version') return { stdout: `LiteLLM: ${config.targetVersion}`, stderr: '' }
    return { stdout: 'Successfully installed litellm', stderr: '' }
  }
  const fetchImpl = async () => ({ status: 200 })
  const patchGate = async () => ({ passed: true, reasons: [], details: [] })
  await performLitellmUpgrade(config, { runCommand, fetchImpl, patchGate })
  const state = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(state.state, 'completed')
  assert.deepEqual(calls[0], ['/venv/bin/pip', 'freeze'])
  assert.deepEqual(calls[1], ['/venv/bin/pip', 'install', '--upgrade', 'litellm==1.107.0-stable'])
  assert.deepEqual(calls[2], ['/bin/launchctl', 'kickstart', '-k', 'gui/501/com.test.litellm'])
  assert.match(await readFile(path.join(config.backupDir, 'pip-freeze-before.txt'), 'utf8'), /Successfully installed/)
  const auditLines = (await readFile(auditFile, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  assert.equal(auditLines.at(-1).action, 'upgrade-completed')
  assert.equal(auditLines.at(-1).to, '1.107.0-stable')
})

test('worker rolls back to the pinned old version when the patch re-check fails', async () => {
  const root = await tempDir('worker-rollback')
  const calls = []
  let installed = '1.106.2'
  const config = {
    litellmBin: '/venv/bin/litellm', pipBin: '/venv/bin/pip', launchdLabel: 'com.test.litellm', uid: 501,
    gatewayUrl: 'http://gateway.test', manifestFile: path.join(root, 'manifest.json'),
    targetVersion: '1.107.0-stable', currentVersion: '1.106.2',
    stateFile: path.join(root, 'state.json'), auditFile: path.join(root, 'audit.jsonl'), logFile: path.join(root, 'update.log'),
    backupDir: path.join(root, 'backup'),
  }
  const runCommand = async (command, args) => {
    calls.push([command, ...args])
    if (args[0] === '--version') return { stdout: `LiteLLM: ${installed}`, stderr: '' }
    if (args[0] === 'install') installed = /litellm==(.+)$/.exec(args.at(-1))[1]
    return { stdout: 'ok', stderr: '' }
  }
  const patchGate = async () => ({ passed: false, reasons: ['补丁失效（目标文件与基线不符）：/x'], details: [] })
  await performLitellmUpgrade(config, { runCommand, fetchImpl: async () => ({ status: 200 }), patchGate })
  process.exitCode = 0
  assert.equal(installed, '1.106.2', 'rollback must restore the pinned old version')
  const installs = calls.filter(call => call[1] === 'install')
  assert.deepEqual(installs[0].at(-1), 'litellm==1.107.0-stable')
  assert.deepEqual(installs[1].at(-1), 'litellm==1.106.2')
  const state = JSON.parse(await readFile(config.stateFile, 'utf8'))
  assert.equal(state.state, 'failed')
  assert.match(state.message, /已回退到 1.106.2/)
  const auditLines = (await readFile(config.auditFile, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  assert.equal(auditLines.at(-1).rolledBack, true)
  assert.match(auditLines.at(-1).reason, /补丁三连复核/)
})

test('worker failure also rolls back when the gateway never comes back healthy', async () => {
  const root = await tempDir('worker-gateway-down')
  let installed = '1.106.2'
  const config = {
    litellmBin: '/venv/bin/litellm', pipBin: '/venv/bin/pip', launchdLabel: 'com.test.litellm', uid: 501,
    gatewayUrl: 'http://gateway.test', manifestFile: path.join(root, 'manifest.json'),
    targetVersion: '1.107.0-stable', currentVersion: '1.106.2',
    stateFile: path.join(root, 'state.json'), auditFile: path.join(root, 'audit.jsonl'), logFile: path.join(root, 'update.log'),
    backupDir: path.join(root, 'backup'), healthDeadlineMs: 2500,
  }
  const runCommand = async (command, args) => {
    if (args[0] === '--version') return { stdout: `LiteLLM: ${installed}`, stderr: '' }
    if (args[0] === 'install') installed = /litellm==(.+)$/.exec(args.at(-1))[1]
    return { stdout: 'ok', stderr: '' }
  }
  // The gateway stays unhealthy while the new version is installed; rollback restores health.
  const fetchImpl = async () => ({ status: installed === '1.107.0-stable' ? 503 : 200 })
  await performLitellmUpgrade(config, { runCommand, fetchImpl, patchGate: async () => ({ passed: true, reasons: [], details: [] }) })
  process.exitCode = 0
  assert.equal(installed, '1.106.2')
  const auditLines = (await readFile(config.auditFile, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  assert.equal(auditLines.at(-1).action, 'upgrade-failed')
  assert.equal(auditLines.at(-1).rolledBack, true)
})
