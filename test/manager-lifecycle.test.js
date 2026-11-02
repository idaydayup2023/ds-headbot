import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { add, fixture, port } from './helpers.js'

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
