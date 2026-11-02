import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { HeadbotManager } from '../lib/manager.js'
import { fixture, port, quiet } from './helpers.js'

test('v1 state is backed up and identities persist; corrupted v2 state is not silently rotated', async t => {
  const { manager } = await fixture(t)
  await mkdir(manager.root, { recursive: true })
  const legacy = { version: 1, teams: [{ id: 'legacy', name: 'Legacy', port: await port(), autoStart: false }] }
  await writeFile(manager.stateFile, JSON.stringify(legacy))
  await manager.initialize()
  const token = manager.findTeam('legacy').communicationToken
  assert.deepEqual(JSON.parse(await readFile(path.join(manager.root, 'teams.v1.backup.json'), 'utf8')), legacy)
  const current = JSON.parse(await readFile(manager.stateFile, 'utf8'))
  assert.equal(current.version, 2)
  const next = new HeadbotManager(manager.config, { parentPort: manager.parentPort, logger: quiet })
  await next.initialize()
  assert.equal(next.findTeam('legacy').communicationToken, token)
  delete current.teams[0].communicationToken
  await writeFile(manager.stateFile, JSON.stringify(current))
  const broken = new HeadbotManager(manager.config, { parentPort: manager.parentPort, logger: quiet })
  await assert.rejects(broken.initialize(), /invalid communication identity/)
  assert.equal(JSON.parse(await readFile(manager.stateFile, 'utf8')).teams[0].communicationToken, undefined)
})
