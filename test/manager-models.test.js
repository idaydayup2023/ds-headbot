import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { HeadbotManager } from '../lib/manager.js'
import { parse } from 'yaml'
import { add, fixture } from './helpers.js'

test('new teams inherit profile model endpoints once without nesting the controller', async t => {
  const { manager } = await fixture(t)
  manager.inheritModelSettings = true
  await mkdir(path.join(manager.parentHome, 'profiles/web'), { recursive: true })
  await writeFile(path.join(manager.parentHome, 'profiles/web/cordis.patch.yml'), `- id: llm-pi-ai\n  config:\n    providers:\n      spark:\n        baseURL: http://192.168.1.9:8888/v1\n- id: agent-default-model\n  config:\n    provider: spark\n    model: example\n- id: ds-headbot\n  config:\n    ingressPort: 3180\n- id: ui-chat\n  config: {}\n`)
  await add(manager, 'models')
  const team = manager.findTeam('models')
  await manager.provisionHome(team)
  const patch = path.join(manager.root, 'teams/models/home/profiles/web/cordis.patch.yml')
  const entries = parse(await readFile(patch, 'utf8'))
  assert.deepEqual(entries.map(entry => entry.id), ['llm-pi-ai', 'agent-default-model'])
  assert.equal(entries[0].config.providers.spark.baseURL, 'http://192.168.1.9:8888/v1')
  await writeFile(patch, '- id: agent-default-model\n  config: {model: independently-edited}\n')
  await manager.provisionHome(team)
  assert.equal(parse(await readFile(patch, 'utf8'))[0].config.model, 'independently-edited')
  assert.throws(() => new HeadbotManager({ teamPlugins: ['--unsafe'] }, { parentPort: 3080 }), /teamPlugins/)
})
