import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture } from './helpers.js'

test('controller restart requires restartCommand outside a LaunchAgent host', async t => {
  if (process.platform === 'darwin') return
  const { manager } = await fixture(t)
  assert.equal(typeof manager.restartController, 'function')
  assert.equal(typeof manager.scheduleControllerRestart, 'function')
  assert.equal(typeof manager.updateController, 'function')
  await assert.rejects(manager.performControllerRestart(), /restartCommand/)
})
