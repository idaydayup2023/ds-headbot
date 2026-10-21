import assert from 'node:assert/strict'
import test from 'node:test'
import { mapFeishuConnectionState } from '../lib/status.js'
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
