import assert from 'node:assert/strict'
import test from 'node:test'
import { mapFeishuConnectionState, writeConnectionStatusEnv, HEADBOT_FEISHU_STATUS_ENV, HEADBOT_FEISHU_STATUS_AT_ENV, HEADBOT_FEISHU_AGENT_STATUS_ENV } from '../lib/status.js'
import { inject as feishuServices } from '../lib/index.js'
import { inject as communicationsServices, runtimeStatusPayload } from '../../../lib/team-plugin.js'

test('maps the Feishu SDK WebSocket lifecycle into Headbot status values', () => {
  assert.equal(mapFeishuConnectionState('idle'), 'offline')
  assert.equal(mapFeishuConnectionState('connecting'), 'connecting')
  assert.equal(mapFeishuConnectionState('connected'), 'connected')
  assert.equal(mapFeishuConnectionState('reconnecting'), 'retrying')
  assert.equal(mapFeishuConnectionState('failed'), 'failed')
  assert.equal(mapFeishuConnectionState(undefined), 'unknown')
})

test('status reporting does not wait for Feishu transport injection', () => {
  assert.deepEqual(communicationsServices, ['tools', 'agents'])
})

test('Feishu bridge waits for agent and session persistence services before restoration', () => {
  assert.deepEqual(feishuServices, ['agents', 'sessionPersistence'])
})

test('runtime status payload reports Feishu and selected-agent state without optional services', () => {
  const agents = { get: (id) => id === 'session-online' ? { id } : undefined }
  assert.deepEqual(runtimeStatusPayload('connected', 'session-online', agents), {
    feishuStatus: 'connected', agentStatus: 'online',
  })
  assert.deepEqual(runtimeStatusPayload('unexpected', 'session-restoring', agents), {
    feishuStatus: 'unknown', agentStatus: 'restoring',
  })
  assert.deepEqual(runtimeStatusPayload('offline', undefined, agents), {
    feishuStatus: 'offline', agentStatus: 'offline',
  })
})

test('the published heartbeat carries both statuses plus a fresh stamp for the in-process controller', t => {
  const previous = [HEADBOT_FEISHU_STATUS_ENV, HEADBOT_FEISHU_STATUS_AT_ENV, HEADBOT_FEISHU_AGENT_STATUS_ENV].map(key => process.env[key])
  t.after(() => {
    ;[HEADBOT_FEISHU_STATUS_ENV, HEADBOT_FEISHU_STATUS_AT_ENV, HEADBOT_FEISHU_AGENT_STATUS_ENV].forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key]
      else process.env[key] = previous[index]
    })
  })
  const before = Date.now()
  writeConnectionStatusEnv('connected', 'online')
  assert.equal(process.env[HEADBOT_FEISHU_STATUS_ENV], 'connected')
  assert.equal(process.env[HEADBOT_FEISHU_AGENT_STATUS_ENV], 'online')
  const at = Number(process.env[HEADBOT_FEISHU_STATUS_AT_ENV])
  assert.ok(Number.isSafeInteger(at) && at >= before && at <= Date.now(), 'the heartbeat stamp is the current wall clock')
})
