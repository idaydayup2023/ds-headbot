// UPGRADE-WINDOW-GATE-001 (总务 11-26 裁 A 案): the admin-page upgrade buttons are entry-gated —
// only a 总务-dropped key file (headbot/upgrade-window.json) opens them, everything else rejects
// with 409 BEFORE any probe/spawn and leaves one `upgrade-blocked-by-window` line in the shared
// upgrade-window-audit.jsonl. These cases weld the shared semantics plus the four-leg wiring
// (headbot release / DSH runtime / litellm / sparkDash). No network, no real gateway, no launchd.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { checkUpgradeWindow, windowAuditFileFor, windowKeyFileFor } from '../lib/upgrade-window.js'
import { HeadbotReleaseUpdater } from '../lib/release-updater.js'
import { HeadbotRuntimeUpdater } from '../lib/runtime-updater.js'
import { LitellmGatewayUpdater } from '../lib/litellm-updater.js'
import { SparkdashUpdater } from '../lib/sparkdash-updater.js'

async function tempRoot(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `upgrade-window-${name}-`))
  return { root, manager: { root, parentHome: path.join(root, 'parent') } }
}

async function dropKey(root, key) {
  await writeFile(windowKeyFileFor({ root }), JSON.stringify(key))
}

function futureDate() {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString()
}

function noNetwork() {
  return async () => {
    throw new Error('network must not be touched outside the window')
  }
}

// —— shared helper semantics ——————————————————————————————————————————————

test('window gate: valid welded key passes the gate (v-prefix tolerant)', async () => {
  const { root } = await tempRoot('pass')
  await dropKey(root, { windowId: 'w1', openedAt: new Date().toISOString(), expiresAt: futureDate(), actor: '总务', targetVersion: 'v1.111.0' })
  const result = await checkUpgradeWindow({ windowKeyFile: windowKeyFileFor({ root }), requestedTarget: '1.111.0', sameTarget: (a, b) => a.replace(/^v/, '') === b.replace(/^v/, '') })
  assert.equal(result.ok, true)
  assert.equal(result.windowId, 'w1')
  assert.equal(result.openedBy, '总务')
})

test('window gate: missing key rejects as window-key-missing (the normal state)', async () => {
  const { root } = await tempRoot('missing')
  const result = await checkUpgradeWindow({ windowKeyFile: windowKeyFileFor({ root }), requestedTarget: '1.111.0' })
  assert.deepEqual(result, { ok: false, reason: 'window-key-missing' })
})

test('window gate: expired key rejects as window-expired', async () => {
  const { root } = await tempRoot('expired')
  await dropKey(root, { windowId: 'w2', expiresAt: new Date(Date.now() - 1000).toISOString(), targetVersion: '1.111.0' })
  const result = await checkUpgradeWindow({ windowKeyFile: windowKeyFileFor({ root }), requestedTarget: '1.111.0' })
  assert.equal(result.reason, 'window-expired')
})

test('window gate: key welded to another target rejects as target-version-mismatch', async () => {
  const { root } = await tempRoot('mismatch')
  await dropKey(root, { windowId: 'w3', expiresAt: futureDate(), targetVersion: '1.112.0' })
  const result = await checkUpgradeWindow({ windowKeyFile: windowKeyFileFor({ root }), requestedTarget: '1.111.0' })
  assert.equal(result.reason, 'target-version-mismatch')
})

test('window gate: key without targetVersion rejects welded legs, passes target-less legs', async () => {
  const { root } = await tempRoot('no-target')
  await dropKey(root, { windowId: 'w4', expiresAt: futureDate() })
  const welded = await checkUpgradeWindow({ windowKeyFile: windowKeyFileFor({ root }), requestedTarget: '1.111.0', requireTarget: true })
  assert.equal(welded.reason, 'window-key-missing-targetVersion')
  const targetLess = await checkUpgradeWindow({ windowKeyFile: windowKeyFileFor({ root }), requireTarget: false })
  assert.equal(targetLess.ok, true)
})

test('window gate: unparseable key fails closed as window-key-unreadable', async () => {
  const { root } = await tempRoot('unreadable')
  await writeFile(windowKeyFileFor({ root }), '{ not json')
  const result = await checkUpgradeWindow({ windowKeyFile: windowKeyFileFor({ root }), requireTarget: false })
  assert.equal(result.ok, false)
  assert.match(result.reason, /^window-key-unreadable/)
})

test('window gate: a target the weld cannot even compare fails closed, never throws', async () => {
  const { root } = await tempRoot('uncomparable')
  await dropKey(root, { windowId: 'w6', expiresAt: futureDate(), targetVersion: 'b'.repeat(40) })
  const result = await checkUpgradeWindow({
    windowKeyFile: windowKeyFileFor({ root }),
    requestedTarget: 'not-a-sha',
    requireTarget: true,
    sameTarget: (a, b) => {
      if (!/^[0-9a-f]{40}$/.test(b)) throw new Error('malformed sha')
      return a === b
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'target-version-mismatch')
})

// —— four-leg wiring: every entry rejects BEFORE any probe and journals its line ——————

async function readAuditLines(manager) {
  const text = await readFile(windowAuditFileFor(manager), 'utf8')
  return text.trim().split('\n').map(line => JSON.parse(line))
}

test('litellm leg: click without a window is 409, journaled, and never probes', async () => {
  const { root, manager } = await tempRoot('leg-litellm')
  const updater = new LitellmGatewayUpdater({ manager, fetchImpl: noNetwork(), spawnImpl: () => { throw new Error('no spawn') }, runImpl: async () => { throw new Error('no run') }, config: {} })
  updater.canRestart = () => true
  await assert.rejects(() => updater.startUpgrade({ acknowledgeOutage: true, targetVersion: '1.111.0' }, { id: 'admin-page' }), error => error.statusCode === 409 && /窗门阻断/.test(error.message))
  const lines = await readAuditLines(manager)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].leg, 'litellm')
  assert.equal(lines[0].action, 'upgrade-blocked-by-window')
  assert.equal(lines[0].actor, 'admin-page')
  assert.equal(lines[0].to, '1.111.0')
  assert.equal(lines[0].window.reason, 'window-key-missing')
})

test('litellm leg: window welded to another version rejects before any GitHub call', async () => {
  const { root, manager } = await tempRoot('leg-litellm-weld')
  await dropKey(root, { windowId: 'w5', expiresAt: futureDate(), actor: '总务', targetVersion: '1.112.0' })
  const updater = new LitellmGatewayUpdater({ manager, fetchImpl: noNetwork(), spawnImpl: () => { throw new Error('no spawn') }, runImpl: async () => { throw new Error('no run') }, config: {} })
  updater.canRestart = () => true
  await assert.rejects(() => updater.startUpgrade({ acknowledgeOutage: true, targetVersion: '1.111.0' }), error => error.statusCode === 409)
  const lines = await readAuditLines(manager)
  assert.equal(lines[0].window.reason, 'target-version-mismatch')
})

test('sparkdash leg: click without a window is 409 and never runs git', async () => {
  const { root, manager } = await tempRoot('leg-sparkdash')
  const updater = new SparkdashUpdater({ manager, runImpl: async () => { throw new Error('no git') }, config: {} })
  await assert.rejects(() => updater.startUpgrade({ acknowledgeOutage: true, targetCommit: 'a'.repeat(40) }, { id: 'admin-page' }), error => error.statusCode === 409)
  const lines = await readAuditLines(manager)
  assert.equal(lines[0].leg, 'sparkdash')
  assert.equal(lines[0].to, 'a'.repeat(40))
  assert.equal(lines[0].window.reason, 'window-key-missing')
})

test('headbot release leg: click without a window is 409 and never calls GitHub', async () => {
  const { root, manager } = await tempRoot('leg-headbot')
  const updater = new HeadbotReleaseUpdater({ currentVersion: '0.4.28', manager, fetchImpl: noNetwork() })
  await assert.rejects(() => updater.startUpgrade(), error => error.statusCode === 409)
  const lines = await readAuditLines(manager)
  assert.equal(lines[0].leg, 'headbot')
  assert.equal(lines[0].action, 'upgrade-blocked-by-window')
})

test('dsh runtime leg: click without a window is 409 and never spawns', async () => {
  const { root, manager } = await tempRoot('leg-dsh')
  const updater = new HeadbotRuntimeUpdater({ manager, fetchImpl: noNetwork(), spawnImpl: () => { throw new Error('no spawn') } })
  await assert.rejects(() => updater.startDshUpgrade(), error => error.statusCode === 409)
  const lines = await readAuditLines(manager)
  assert.equal(lines[0].leg, 'dsh')
  assert.equal(lines[0].action, 'upgrade-blocked-by-window')
})
