import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { add, fixture, port, quiet } from './helpers.js'
import { HeadbotManager } from '../lib/manager.js'
import { waitForListener } from '../lib/manager/shared.js'

// Simulate a controller restart: a fresh manager over the same on-disk state, holding no handles.
async function revivedManager(root, fake, adoptProbeMs) {
  return new HeadbotManager(
    { dataDir: path.join(root, 'headbot'), dshHome: path.join(root, 'home'), dshCommand: fake, inheritModelSettings: false, ingressPort: await port() },
    { parentPort: await port(), logger: quiet, ...(adoptProbeMs ? { adoptProbeMs } : {}) },
  )
}

async function until(check, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  return false
}

test('runtime create/edit/start/stop/restart/delete archives data and revokes identity', async t => {
  const { manager, pluginLog } = await fixture(t)
  await Promise.all([manager.listTeams(), manager.listTeams()])
  const first = await add(manager, 'alpha')
  const token = manager.findTeam('alpha').communicationToken
  assert.equal((await manager.authenticateTeam('Bearer ' + token)).instanceId, first.instanceId)
  assert.equal(JSON.stringify(first).includes(token), false)
  const changedPort = await port()
  const edited = await manager.updateTeam('alpha', { port: changedPort, name: 'Alpha Research' })
  assert.equal(edited.name, 'Alpha Research')
  assert.equal(edited.port, changedPort)
  await assert.rejects(manager.updateTeam('alpha', { port: await port(), name: '' }), { statusCode: 400 })
  assert.equal((await manager.getTeam('alpha')).port, changedPort)
  await manager.startTeam('alpha')
  const running = await manager.getTeam('alpha')
  assert.equal(running.status, 'running', running.message)
  await manager.stopTeam('alpha')
  await manager.startTeam('alpha')
  assert.match(await readFile(pluginLog, 'utf8'), /plugin --profile web add ds-bot/)
  await manager.stopTeam('alpha')
  assert.equal((await manager.getTeam('alpha')).status, 'stopped')
  await manager.restartTeam('alpha')
  assert.equal((await manager.getTeam('alpha')).status, 'running')
  const workspace = path.join(manager.root, 'teams/alpha/workspace')
  await writeFile(path.join(workspace, 'report.txt'), 'preserved report')
  const deletion = await manager.deleteTeam('alpha')
  assert.equal(await readFile(path.join(deletion.archivePath, 'workspace/report.txt'), 'utf8'), 'preserved report')
  assert.equal(await manager.authenticateTeam('Bearer ' + token), undefined)
  await assert.rejects(manager.getTeam('alpha'), { statusCode: 404 })
  const second = await manager.createTeam({ id: 'alpha', name: 'New Alpha', port: first.port, autoStart: false })
  assert.notEqual(second.instanceId, first.instanceId)
  assert.notEqual(manager.findTeam('alpha').communicationToken, token)
  assert.equal((await manager.listTeams()).length, 1)
})

test('startup retries temporary HTTP 404 responses until DSH routes are ready', async t => {
  const {manager, root} = await fixture(t)
  await writeFile(path.join(root, 'transient-404'), '')
  await add(manager, 'warming')
  await manager.startTeam('warming')
  assert.equal((await manager.getTeam('warming')).status, 'running')
})

// --- Runtime adoption (audit finding P1-1) ------------------------------------------------------------

test('controller restart adopts the still-serving detached child from the persisted ledger without a second spawn', async t => {
  const { root, manager, fake } = await fixture(t)
  await manager.createTeam({ id: 'alpha', name: 'ALPHA', port: await port(), autoStart: true })
  await manager.startTeam('alpha')
  assert.equal((await manager.getTeam('alpha')).status, 'running', manager.runtime.get('alpha').message)
  const ledger = JSON.parse(await readFile(path.join(root, 'headbot', 'runtime-pids.json'), 'utf8'))
  assert.ok(Number.isSafeInteger(ledger.alpha.pid) && ledger.alpha.pid > 0, 'pid persisted')
  assert.equal(ledger.alpha.port, manager.findTeam('alpha').port)
  assert.equal(typeof ledger.alpha.generation, 'string', 'generation persisted')
  const revived = await revivedManager(root, fake)
  t.after(() => revived.close())
  await revived.initialize()
  assert.equal(revived.runtimePids.alpha.pid, ledger.alpha.pid, 'ledger reloaded by the restarted controller')
  await revived.startTeam('alpha')
  assert.equal((await revived.getTeam('alpha')).status, 'running', revived.runtime.get('alpha').message)
  const adopted = revived.runtime.get('alpha')
  assert.equal(adopted.pid, ledger.alpha.pid, 'the same serving process was adopted')
  assert.equal(adopted.child, undefined, 'no second process was spawned')
  assert.equal(adopted.generation, ledger.alpha.generation, 'the persisted generation is carried over')
})

test('a lost ledger cannot double-spawn over a live orphan: the port guard keeps exactly one server', async t => {
  const { root, manager, fake } = await fixture(t)
  await manager.createTeam({ id: 'beta', name: 'BETA', port: await port(), autoStart: true })
  await manager.startTeam('beta')
  const ledgerPath = path.join(root, 'headbot', 'runtime-pids.json')
  const pid = JSON.parse(await readFile(ledgerPath, 'utf8')).beta.pid
  await rm(ledgerPath, { force: true }) // state as written before adoption existed / ledger deleted
  const revived = await revivedManager(root, fake)
  t.after(() => revived.close())
  await revived.startTeam('beta')
  assert.equal(revived.runtime.get('beta').phase, 'failed', 'no adoption data, no spawn over a live port')
  assert.match(revived.runtime.get('beta').message, /already in use/)
  assert.equal(revived.runtime.get('beta').child, undefined, 'nothing was spawned')
  assert.equal(revived.runtimePids.beta, undefined, 'no bogus ledger entry was written')
  process.kill(pid, 0) // the single original server is alive and untouched
  assert.equal((await manager.getTeam('beta')).status, 'running')
})

test('adopted runtime fails instead of pretending to run when the adopted process dies', async t => {
  const { root, manager, fake } = await fixture(t)
  await manager.createTeam({ id: 'gamma', name: 'GAMMA', port: await port(), autoStart: true })
  await manager.startTeam('gamma')
  const ledgerPath = path.join(root, 'headbot', 'runtime-pids.json')
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'))
  // Stop the auto-restart loops on both sides so the killed child stays dead and observable.
  manager.findTeam('gamma').autoStart = false
  await manager.updateTeam('gamma', { autoStart: false })
  const revived = await revivedManager(root, fake, 150)
  t.after(() => revived.close())
  await revived.startTeam('gamma')
  assert.equal(revived.runtime.get('gamma').phase, 'running', 'adopted first')
  process.kill(ledger.gamma.pid, 'SIGKILL')
  const failed = await until(async () => revived.runtime.get('gamma').phase === 'failed')
  assert.ok(failed, 'the lost adopted process is reported failed, not left falsely running')
  assert.match(revived.runtime.get('gamma').message, /Adopted runtime .* stopped serving/)
  assert.equal(revived.runtime.get('gamma').pid, undefined)
  const after = JSON.parse(await readFile(ledgerPath, 'utf8'))
  assert.equal(after.gamma, undefined, 'the stale ledger entry was cleared')
})

test('waitForListener refuses to report ready for a dead child even while a decoy answers on the port', async () => {
  // The decisive race: the request goes out while the child is alive, the child dies mid-flight,
  // and the answer that lands belongs to the decoy on the port — accepting it would be the
  // false-running bug. The runtime fixture must carry the child handle or the poll guard refuses
  // before any request leaves (which would make this test green for the wrong reason).
  let releaseDecoy
  let decoyArrived
  const arrived = new Promise(resolve => { decoyArrived = resolve })
  const decoy = createServer(async (_req, res) => {
    decoyArrived()
    await new Promise(resolve => { releaseDecoy = resolve })
    res.statusCode = 200
    res.end('ok')
  })
  await new Promise(resolve => decoy.listen(0, '127.0.0.1', resolve))
  const p = decoy.address().port
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(7), 5000)'])
  try {
    const probe = waitForListener(p, { stopRequested: false, child }, 2_000)
    await arrived // the poll request is provably in flight inside the decoy
    child.kill()
    await new Promise(resolve => child.once('exit', resolve))
    releaseDecoy() // the decoy answers only after the child is provably dead
    assert.equal(await probe, false, 'an old server answering the port must never mark a dead child running')
  } finally {
    releaseDecoy?.()
    child.kill()
    await new Promise(resolve => { child.once('exit', resolve); if (child.exitCode !== null || child.signalCode !== null) resolve() })
    decoy.closeAllConnections?.()
    await new Promise(resolve => decoy.close(resolve))
  }
  // and the same probe still accepts a live server for a live handle
  const live = spawn(process.execPath, ['-e', `require('node:http').createServer((_q,r)=>{r.end("ok")}).listen(${p},'127.0.0.1')`])
  try {
    assert.equal(await waitForListener(p, { stopRequested: false, child: live }, 3_000), true)
  } finally {
    live.kill()
    await new Promise(resolve => live.once('exit', resolve))
  }
})

// F1-ADOPT-LOG (audit lesson P3): the adoption line must be visible on disk. Passing it only
// to the host logger lands it in the Cordis in-memory ring, never in server.log — so the line
// travels the double channel: host logger pass-through plus a real stdout print.
test('the adoption path leaves a visible ledger line on both channels (F1-ADOPT-LOG)', async t => {
  const { root, manager, fake } = await fixture(t)
  await manager.createTeam({ id: 'delta', name: 'DELTA', port: await port(), autoStart: true })
  await manager.startTeam('delta')
  const ledger = JSON.parse(await readFile(path.join(root, 'headbot', 'runtime-pids.json'), 'utf8'))
  const lines = []
  const info = t.mock.method(console, 'info', () => {})
  const revived = new HeadbotManager(
    { dataDir: path.join(root, 'headbot'), dshHome: path.join(root, 'home'), dshCommand: fake, inheritModelSettings: false, ingressPort: await port() },
    { parentPort: await port(), logger: { warn() {}, error() {}, info: line => lines.push(line) } },
  )
  t.after(() => revived.close())
  await revived.initialize()
  await revived.startTeam('delta')
  assert.equal(revived.runtime.get('delta').pid, ledger.delta.pid, 'the still-serving process was adopted')
  assert.match(lines.join('\n'), /^\[ds-headbot\] adopted the still-serving delta runtime \(pid \d+\)$/, 'the adoption line reaches the host logger')
  const printed = info.mock.calls.map(call => call.arguments[0])
  assert.match(printed.join('\n'), /^\[ds-headbot\] adopted the still-serving delta runtime \(pid \d+\)$/, 'and is printed — stdout is what launchd captures into server.log')
})

// TEAM-EXIT-LOG-001: birth, death, error and respawn lines of a team process must all reach
// the double channel (host logger + stdout → server.log). Without them a crash+respawn window
// (the 40048→48493 case) leaves zero trace on disk.
test('team process birth, exit and auto-start respawn each leave a ledger line (TEAM-EXIT-LOG-001)', async t => {
  const { manager } = await fixture(t)
  const lines = []
  manager.logger = { warn() {}, error() {}, info: line => lines.push(line) }
  const printed = t.mock.method(console, 'info', () => {})
  t.after(() => {
    // disarm any pending respawn so teardown (and the process) can settle, even on failure
    const tail = manager.runtime.get('gamma')
    if (tail) { tail.explicitStop = true; clearTimeout(tail.restartTimer) }
  })
  const hasLine = pattern => lines.some(line => pattern.test(line))
  const hasPrint = pattern => printed.mock.calls.some(call => pattern.test(String(call.arguments[0])))
  await manager.createTeam({ id: 'gamma', name: 'GAMMA', port: await port(), autoStart: true })
  await manager.startTeam('gamma')
  const spawnedPid = manager.runtime.get('gamma').pid
  assert.ok(hasLine(new RegExp(`^\\[ds-headbot\\] spawned gamma runtime \\(pid ${spawnedPid}, port \\d+\\)$`)), 'the birth line reaches the host logger')
  assert.ok(hasPrint(new RegExp(`^\\[ds-headbot\\] spawned gamma runtime \\(pid ${spawnedPid}, port \\d+\\)$`)), 'and is printed — stdout is what launchd captures into server.log')
  // crash the fake child: exit line + respawn decision line must follow
  manager.runtime.get('gamma').child.kill('SIGKILL')
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.ok(hasLine(new RegExp(`^\\[ds-headbot\\] team gamma runtime exited \\(pid ${spawnedPid}, code n/a, signal SIGKILL\\)$`)), 'the death line names pid and signal')
  assert.ok(hasLine(/^\[ds-headbot\] respawning gamma in \d+ms \(attempt 1\)$/), 'the respawn decision is logged too')
  assert.ok(hasPrint(/^\[ds-headbot\] respawning gamma in \d+ms \(attempt 1\)$/), 'both travel the stdout channel as well')
  // let the respawn fire and confirm a fresh birth line
  await new Promise(resolve => setTimeout(resolve, 1200))
  const secondPid = manager.runtime.get('gamma').pid
  assert.ok(secondPid && secondPid !== spawnedPid, 'the team did respawn')
  assert.ok(hasLine(new RegExp(`^\\[ds-headbot\\] spawned gamma runtime \\(pid ${secondPid}, port \\d+\\)$`)), 'the respawned process gets its own birth line')
  manager.runtime.get('gamma').child.kill('SIGKILL')
  await new Promise(resolve => setTimeout(resolve, 200)) // let the second exit land before teardown
})

test('a process-layer child error without an exit event still leaves a ledger line (TEAM-EXIT-LOG-001)', async t => {
  const { manager } = await fixture(t)
  const lines = []
  manager.logger = { warn() {}, error() {}, info: line => lines.push(line) }
  t.mock.method(console, 'info', () => {})
  await manager.createTeam({ id: 'epsilon', name: 'EPSILON', port: await port(), autoStart: false })
  await manager.startTeam('epsilon')
  const child = manager.runtime.get('epsilon').child
  t.after(() => { child.kill('SIGKILL') }) // even on assertion failure the stdio pipes must close
  const pid = manager.runtime.get('epsilon').pid
  child.emit('error', new Error('spawned died quietly'))
  const errorPattern = new RegExp(`^\\[ds-headbot\\] team epsilon runtime process error \\(pid ${pid}\\): Error: spawned died quietly$`)
  assert.ok(lines.some(line => errorPattern.test(line)), `the silent-error leg is no longer silent (lines=${JSON.stringify(lines)})`)
  // the error leg only clears bookkeeping; close the stdio pipes so teardown can settle
  child.kill('SIGKILL')
  await new Promise(resolve => setTimeout(resolve, 200))
})

// --- DSBOT-UPDATE-VERIFY-001 ----------------------------------------------------------------------------
// The dsh CLI exits 0 even when the package manager silently keeps an older ds-bot
// version (pnpm consistency pin, production incident 2026-11-17). updateBot must read
// the on-disk package version back and anchor it to the registry latest before it
// believes the install — botInstalled may never be set true on an unverified package.
async function seedBotPackage(manager, id, version) {
  const dir = path.join(manager.root, 'teams', id, 'home', 'profiles', 'web', 'node_modules', 'ds-bot')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'ds-bot', version }))
}

function registryLatest(manager, version) {
  manager.fetchImpl = async () => ({ ok: true, json: async () => ({ version }) })
}

test('updateBot fails a zero-exit update whose package version never moved (DSBOT-UPDATE-VERIFY-001)', async t => {
  const { manager, pluginLog } = await fixture(t)
  await add(manager, 'pinned')
  await seedBotPackage(manager, 'pinned', '0.3.6')
  await manager.startTeam('pinned')
  assert.equal(manager.findTeam('pinned').botInstalled, true, 'start provisioned the install')
  registryLatest(manager, '0.3.8')
  await assert.rejects(manager.updateBot('pinned'), { message: /still at 0\.3\.6 after the update while the latest version is 0\.3\.8/ })
  // TEAM-UPGRADE-001: the failed upgrade no longer leaves the team down — the still-good old
  // package goes back to serving while the message keeps the failure for the card.
  assert.equal((await manager.getTeam('pinned')).status, 'running', 'the old package keeps serving after a failed update')
  assert.match(manager.runtime.get('pinned').message, /0\.3\.6/, 'the failed message must carry both versions')
  assert.equal(manager.findTeam('pinned').botInstalled, true, 'the install flag survives because the package was installed before the failed update')
  assert.match(await readFile(pluginLog, 'utf8'), /plugin --profile web update --latest ds-bot --config\.minimumReleaseAgeExclude=ds-bot@\*/, 'the dsh leg ran and exited 0')
})

test('updateBot completes and starts the team when the package version matches the registry latest', async t => {
  const { manager, pluginLog } = await fixture(t)
  await add(manager, 'current')
  await seedBotPackage(manager, 'current', '0.3.8')
  registryLatest(manager, '0.3.8')
  await manager.updateBot('current')
  assert.equal(manager.findTeam('current').botInstalled, true)
  const running = await manager.getTeam('current')
  assert.equal(running.status, 'running', running.message)
  assert.match(await readFile(pluginLog, 'utf8'), /plugin --profile web add ds-bot/)
  // second round: the update branch must not false-fail on the legitimate `update --latest` no-op
  await manager.updateBot('current')
  assert.match(await readFile(pluginLog, 'utf8'), /plugin --profile web update --latest ds-bot/)
  assert.equal((await manager.getTeam('current')).status, 'running')
})

test('updateBot fails when the package is absent from the profile despite a zero-exit add', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'ghost')
  registryLatest(manager, '0.3.8')
  await assert.rejects(manager.updateBot('ghost'), { message: /not present in the profile/ })
  assert.equal(manager.findTeam('ghost').botInstalled, false)
  assert.equal(manager.runtime.get('ghost').phase, 'failed')
})

test('updateBot fails verification when the registry latest cannot be resolved', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'offline')
  await seedBotPackage(manager, 'offline', '0.3.8')
  manager.fetchImpl = async () => { throw new Error('registry offline') }
  await assert.rejects(manager.updateBot('offline'), { message: /cannot resolve the latest ds-bot version/ })
  assert.equal(manager.findTeam('offline').botInstalled, false)
  assert.equal(manager.runtime.get('offline').phase, 'failed')
  assert.match(manager.runtime.get('offline').message, /registry offline/)
})
