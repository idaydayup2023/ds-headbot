import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AGENT_RUNTIME_STATES, FEISHU_RUNTIME_STATES } from '../lib/manager/shared.js'
import { mapFeishuConnectionState } from '../plugins/ds-headbot-feishu/lib/status.js'
import { fixture } from './helpers.js'

const STATUS_ENV = 'HEADBOT_FEISHU_STATUS'
const AGENT_ENV = 'HEADBOT_FEISHU_AGENT_STATUS'
const AT_ENV = 'HEADBOT_FEISHU_STATUS_AT'

// The manager test process is shared: every test that touches the published environment must
// hand it back exactly as it found it.
function withEnvironment(t, values) {
  const previous = { [STATUS_ENV]: process.env[STATUS_ENV], [AGENT_ENV]: process.env[AGENT_ENV], [AT_ENV]: process.env[AT_ENV] }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

function enabledController(manager) {
  manager.controller.feishu = { enabled: true, appId: 'cli_test', botId: 'agent-test' }
}

function publish(t, status, agent, at = Date.now()) {
  withEnvironment(t, { [STATUS_ENV]: status, [AGENT_ENV]: agent, [AT_ENV]: String(at) })
}

test('the default instance reflects the in-process plugin heartbeat into controllerRuntime', async t => {
  const { manager } = await fixture(t)
  enabledController(manager)
  const at = Date.now()
  publish(t, 'connected', 'online', at)
  manager.reflectControllerFeishuStatus()
  assert.equal(manager.controllerRuntime.feishuStatus, 'connected')
  assert.equal(manager.controllerRuntime.feishuAgentStatus, 'online')
  assert.equal(manager.controllerRuntime.feishuStatusUpdatedAt, at, 'the heartbeat stamp is taken from the plugin, not reflection time')
  assert.equal(manager.controllerRuntime.agentStatusUpdatedAt, at)
})

test('a missing, malformed or lapsed heartbeat never overwrites the last known state', async t => {
  const { manager } = await fixture(t)
  enabledController(manager)
  const cases = [
    { [STATUS_ENV]: 'connected-extra', [AGENT_ENV]: 'online', [AT_ENV]: String(Date.now()) },
    { [STATUS_ENV]: 'connected', [AGENT_ENV]: 'sleepwalking', [AT_ENV]: String(Date.now()) },
    { [STATUS_ENV]: 'connected', [AGENT_ENV]: 'online', [AT_ENV]: undefined },
    { [STATUS_ENV]: 'connected', [AGENT_ENV]: 'online', [AT_ENV]: 'not-a-number' },
    { [STATUS_ENV]: 'connected', [AGENT_ENV]: 'online', [AT_ENV]: String(Date.now() - 60_000) },
  ]
  for (const values of cases) {
    manager.controllerRuntime.feishuStatus = 'unknown'
    manager.controllerRuntime.feishuAgentStatus = 'offline'
    manager.controllerRuntime.feishuStatusUpdatedAt = undefined
    manager.controllerRuntime.agentStatusUpdatedAt = undefined
    withEnvironment(t, values)
    manager.reflectControllerFeishuStatus()
    assert.equal(manager.controllerRuntime.feishuStatus, 'unknown', `rejected: ${JSON.stringify(values)}`)
    assert.equal(manager.controllerRuntime.feishuAgentStatus, 'offline', `rejected: ${JSON.stringify(values)}`)
    assert.equal(manager.controllerRuntime.feishuStatusUpdatedAt, undefined)
  }
})

test('the default card shows the same states the team rows show', async t => {
  const { manager } = await fixture(t)
  // Boot: enabled, nothing reported yet → both badges read unknown.
  enabledController(manager)
  manager.controllerRuntime.feishuStatus = 'unknown'
  manager.controllerRuntime.feishuStatusUpdatedAt = undefined
  manager.controllerRuntime.agentStatusUpdatedAt = undefined
  let card = manager.presentController().feishu
  assert.equal(card.status, 'unknown')
  assert.equal(card.agentStatus, 'unknown')

  // Live heartbeat → both badges mirror the plugin.
  enabledController(manager)
  publish(t, 'connected', 'online')
  manager.reflectControllerFeishuStatus()
  card = manager.presentController().feishu
  assert.equal(card.status, 'connected')
  assert.equal(card.agentStatus, 'online')

  // Heartbeat lapses (plugin gone mid-process) → back to unknown, never a frozen connected.
  manager.controllerRuntime.feishuStatusUpdatedAt = Date.now() - 30_000
  manager.controllerRuntime.agentStatusUpdatedAt = Date.now() - 30_000
  card = manager.presentController().feishu
  assert.equal(card.status, 'unknown')
  assert.equal(card.agentStatus, 'unknown')

  // Disabled → disabled regardless of the environment.
  manager.controller.feishu = { enabled: false, appId: 'cli_test', botId: 'agent-test' }
  card = manager.presentController().feishu
  assert.equal(card.status, 'disabled')
  assert.equal(card.agentStatus, 'disabled')
})

test('the monitor starts only for an enabled default Feishu and reflects within its cadence', async t => {
  const { manager } = await fixture(t)
  // Disabled → no timer at all.
  manager.controller.feishu = { enabled: false, appId: '', botId: '' }
  manager.watchControllerFeishuStatus()
  assert.equal(manager.controllerRuntime.feishuStatusMonitor, undefined)

  enabledController(manager)
  publish(t, 'connected', 'online')
  manager.watchControllerFeishuStatus()
  assert.ok(manager.controllerRuntime.feishuStatusMonitor, 'enabled watch arms a monitor')
  const deadline = Date.now() + 6_000
  while (manager.controllerRuntime.feishuStatus !== 'connected' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(manager.controllerRuntime.feishuStatus, 'connected', 'the monitor reflects the plugin heartbeat on its own')
})

test('the monitor stops while closing', async t => {
  const { manager } = await fixture(t)
  enabledController(manager)
  manager.controllerRuntime.feishuStatus = 'unknown'
  manager.controllerRuntime.feishuStatusUpdatedAt = undefined
  publish(t, 'connected', 'online')
  manager.closing = true
  manager.watchControllerFeishuStatus()
  assert.ok(manager.controllerRuntime.feishuStatusMonitor)
  await new Promise(resolve => setTimeout(resolve, 3_400))
  assert.equal(manager.controllerRuntime.feishuStatus, 'unknown', 'a closing manager does not adopt new plugin state')
  manager.closing = false
})

test('the save flow seeds a re-enable exactly like a team spawn', async t => {
  const source = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'manager', 'controller.js'), 'utf8')
  const seed = source.match(/if \(feishuChanged \|\| modelChanged\) \{([\s\S]*?)\n      \}\n      return this\.presentController/)
  assert.ok(seed, 'the save seed block exists')
  assert.match(seed[1], /feishuStatus = next\.feishu\.enabled \? 'connecting' : 'disabled'/)
  assert.match(seed[1], /feishuAgentStatus = next\.feishu\.enabled \? 'restoring' : 'disabled'/)
  assert.match(seed[1], /feishuStatusUpdatedAt = undefined/)
  assert.match(seed[1], /agentStatusUpdatedAt = undefined/)
})

test('welds: boot arms the monitor and close clears it', async t => {
  const source = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'manager', 'lifecycle.js'), 'utf8')
  const start = source.match(/async startEnabledTeams\(\) \{[\s\S]*?\n  \},/)
  assert.ok(start, 'startEnabledTeams exists')
  assert.match(start[0], /this\.watchControllerFeishuTarget\(\)\s*\n\s*this\.watchControllerFeishuStatus\(\)/, 'boot arms the status monitor beside the binding monitor')
  const close = source.match(/async close\(\) \{[\s\S]*?\n  \},/)
  assert.ok(close, 'close exists')
  assert.match(close[0], /clearInterval\(this\.controllerRuntime\.feishuStatusMonitor\)/, 'close clears the status monitor')
})

test('weld: one status vocabulary across the plugin mapper and the manager intake', async t => {
  for (const state of ['idle', 'connecting', 'connected', 'reconnecting', 'failed', undefined]) {
    assert.ok(FEISHU_RUNTIME_STATES.has(mapFeishuConnectionState(state)), `mapFeishuConnectionState('${state}') stays inside the shared vocabulary`)
  }
  assert.ok(FEISHU_RUNTIME_STATES.has('unknown') && FEISHU_RUNTIME_STATES.has('retrying') && FEISHU_RUNTIME_STATES.has('offline'))
  for (const state of ['restoring', 'online', 'offline', 'failed']) {
    assert.ok(AGENT_RUNTIME_STATES.has(state), `agent state ${state} is shared`)
  }
})
