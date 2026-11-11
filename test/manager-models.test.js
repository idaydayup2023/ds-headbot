import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { HeadbotManager } from '../lib/manager.js'
import { parse } from 'yaml'
import { add, fixture } from './helpers.js'
import { validateStoredModel } from '../lib/manager/shared.js'

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

test('catalog maxTokens survives the validator and lands in the generated provider entry (MODELS-CAPS-001)', async t => {
  const { manager } = await fixture(t)
  await manager.createModel({ id: 'caps', name: 'Caps', baseURL: 'http://127.0.0.1:9/v1', modelId: 'caps-1', compat: { maxTokensField: 'max_tokens' }, maxTokens: 32768 })
  await manager.createModel({ id: 'nocaps', name: 'NoCaps', baseURL: 'http://127.0.0.1:10/v1', modelId: 'nocaps-1' })
  assert.equal(manager.models.find(model => model.id === 'caps').maxTokens, 32768)
  const home = path.join(manager.root, 'teams', 'caps-team', 'home')
  await manager.writeInstanceModelConfig(home, manager.models.find(model => model.id === 'caps'))
  await manager.writeInstanceModelConfig(home, manager.models.find(model => model.id === 'nocaps'))
  const providers = parse(await readFile(path.join(home, 'profiles/web/cordis.patch.yml'), 'utf8')).find(entry => entry.id === 'llm-pi-ai').config.providers
  assert.deepEqual(providers.caps.models, [{ id: 'caps-1', maxTokens: 32768 }])
  assert.equal(providers.caps.compat.maxTokensField, 'max_tokens')
  assert.deepEqual(providers.nocaps.models, [{ id: 'nocaps-1' }])
  // the stored document round-trips through the same validator the manager loads with (models.js:180)
  const stored = JSON.parse(await readFile(path.join(manager.root, 'models.json'), 'utf8'))
  assert.equal(stored.models.find(model => model.id === 'caps').maxTokens, 32768)
  assert.equal(validateStoredModel(stored.models.find(model => model.id === 'caps')).maxTokens, 32768)
  assert.throws(() => validateStoredModel({ id: 'bad', name: 'Bad', baseURL: 'http://127.0.0.1:11/v1', modelId: 'bad-1', maxTokens: 1.5 }), /maxTokens/)
  assert.throws(() => validateStoredModel({ id: 'bad', name: 'Bad', baseURL: 'http://127.0.0.1:11/v1', modelId: 'bad-1', maxTokens: 0 }), /maxTokens/)
})
