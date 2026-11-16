import assert from 'node:assert/strict'
import { access, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { HeadbotManager } from '../lib/manager.js'
import { parse } from 'yaml'
import { add, fixture } from './helpers.js'
import { validateStoredModel } from '../lib/manager/shared.js'

// PROV-INHERIT-001 rework of the old "seed once" case: inheritance is now live through
// DSH's home-level patch layer. Nothing is nested into the team's profile layer at all —
// the parent's ds-headbot entry stays inert in the team process because the team home has
// no ds-headbot plugin tree to apply it, which is the real anti-nesting base.
test('new teams inherit the parent model settings live through the home-level link without nesting the controller', async t => {
  const { manager } = await fixture(t)
  manager.inheritModelSettings = true
  await mkdir(path.join(manager.parentHome, 'profiles/web'), { recursive: true })
  const parent = path.join(manager.parentHome, 'profiles/web/cordis.patch.yml')
  await writeFile(parent, `- id: llm-pi-ai\n  config:\n    providers:\n      spark:\n        baseURL: http://192.168.1.9:8888/v1\n- id: agent-default-model\n  config:\n    provider: spark\n    model: example\n- id: ds-headbot\n  config:\n    ingressPort: 3180\n- id: ui-chat\n  config: {}\n`)
  await add(manager, 'models')
  const team = manager.findTeam('models')
  await manager.provisionHome(team)
  const home = path.join(manager.root, 'teams/models/home')
  const link = path.join(home, 'cordis.patch.yml')
  assert.ok((await lstat(link)).isSymbolicLink(), 'the team reads the parent through a home-level symlink, not a copy')
  assert.equal(await realpath(link), await realpath(parent))
  await assert.rejects(access(path.join(home, 'profiles/web/cordis.patch.yml')), { code: 'ENOENT' }, 'the team profile layer carries no model or controller copy')
  // inheritance is live: what the parent says is what the team resolves, no re-seeding involved
  await writeFile(parent, '- id: llm-pi-ai\n  config:\n    providers:\n      spark:\n        baseURL: http://192.168.1.9:9999/v1\n')
  const entries = parse(await readFile(link, 'utf8'))
  assert.deepEqual(entries.map(entry => entry.id), ['llm-pi-ai'])
  assert.equal(entries[0].config.providers.spark.baseURL, 'http://192.168.1.9:9999/v1')
  await manager.provisionHome(team) // idempotent seeding must not re-materialise a profile-layer copy
  assert.ok((await lstat(link)).isSymbolicLink())
  await assert.rejects(access(path.join(home, 'profiles/web/cordis.patch.yml')), { code: 'ENOENT' })
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

test('catalog input modalities survive the validator and land in the generated provider entry (MODELS-INPUT-001)', async t => {
  const { manager } = await fixture(t)
  await manager.createModel({ id: 'eyes', name: 'Eyes', baseURL: 'http://127.0.0.1:9/v1', modelId: 'eyes-1', input: ['text', 'image'] })
  await manager.createModel({ id: 'plain', name: 'Plain', baseURL: 'http://127.0.0.1:10/v1', modelId: 'plain-1' })
  await manager.createModel({ id: 'junk', name: 'Junk', baseURL: 'http://127.0.0.1:12/v1', modelId: 'junk-1', input: ['text', 'holo'] })
  assert.deepEqual(manager.models.find(model => model.id === 'eyes').input, ['text', 'image'])
  assert.equal(manager.models.find(model => model.id === 'plain').input, undefined)
  assert.equal(manager.models.find(model => model.id === 'junk').input, undefined, 'unknown modality words are dropped, not stored')
  const home = path.join(manager.root, 'teams', 'input-team', 'home')
  for (const id of ['eyes', 'plain', 'junk']) await manager.writeInstanceModelConfig(home, manager.models.find(model => model.id === id))
  const providers = parse(await readFile(path.join(home, 'profiles/web/cordis.patch.yml'), 'utf8')).find(entry => entry.id === 'llm-pi-ai').config.providers
  assert.deepEqual(providers.eyes.models, [{ id: 'eyes-1', input: ['text', 'image'] }])
  assert.deepEqual(providers.plain.models, [{ id: 'plain-1' }])
  assert.deepEqual(providers.junk.models, [{ id: 'junk-1' }])
  // the load-side validator keeps modalities too, so a stored catalog round-trips them (models.js:181)
  const stored = JSON.parse(await readFile(path.join(manager.root, 'models.json'), 'utf8'))
  assert.deepEqual(validateStoredModel(stored.models.find(model => model.id === 'eyes')).input, ['text', 'image'])
})
