import assert from 'node:assert/strict'
import { access, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import { add, fixture } from './helpers.js'
import { linkModelPatch } from '../lib/manager/shared.js'

// PROV-INHERIT-001: team model settings are inherited live from the parent profile patch
// through DSH's home-level user-patch layer ($DSH_HOME/cordis.patch.yml), a symlink the
// manager maintains; the team's own default-model pick travels in a generated selection
// overlay, and a hand-placed override file outranks everything as the last --patch.

const PARENT = `- id: llm-pi-ai
  config:
    providers:
      spark:
        baseURL: http://192.168.1.9:8888/v1
        models:
          - id: qwen-vision
            input: [text, image]
      glm:
        baseURL: http://192.168.1.9:8889/v1
        models:
          - id: glm-5.3-flash
            input: [text, image]
- id: agent-default-model
  config:
    provider: spark
    model: qwen-vision
- id: ds-headbot
  config:
    ingressPort: 3180
- id: ui-chat
  config: {}
`

async function seedParent(manager, body = PARENT) {
  await mkdir(path.join(manager.parentHome, 'profiles/web'), { recursive: true })
  const file = path.join(manager.parentHome, 'profiles/web/cordis.patch.yml')
  await writeFile(file, body)
  return file
}

const teamHome = (manager, id) => path.join(manager.root, 'teams', id, 'home')

// fake-dsh records every team spawn as its argv, one launch per "---"-separated run
async function lastSpawnPatches(root) {
  const log = await readFile(path.join(root, 'spawn-args.log'), 'utf8')
  const args = log.split('---\n').filter(Boolean).at(-1).trim().split('\n')
  const patches = []
  for (let i = 0; i < args.length; i += 1) if (args[i] === '--patch') patches.push(args[i + 1])
  return patches
}

test('inherit case 1: a new team reads the single source through the home-level symlink, the profile layer stays empty', async t => {
  const { manager } = await fixture(t)
  manager.inheritModelSettings = true
  const parent = await seedParent(manager)
  await add(manager, 'single')
  await manager.provisionHome(manager.findTeam('single'))
  const home = teamHome(manager, 'single')
  const link = path.join(home, 'cordis.patch.yml')
  assert.ok((await lstat(link)).isSymbolicLink(), 'the home-level patch is a symlink to the parent, not a copy')
  assert.equal(await realpath(link), await realpath(parent))
  await assert.rejects(access(path.join(home, 'profiles/web/cordis.patch.yml')), { code: 'ENOENT' }, 'the team profile layer carries no model/controller copy')
  // reading through the link yields the whole parent file; the ds-headbot entry is inert in a
  // team process because the team home has no ds-headbot plugin tree to apply it
  assert.deepEqual(parse(await readFile(link, 'utf8')).map(entry => entry.id), ['llm-pi-ai', 'agent-default-model', 'ds-headbot', 'ui-chat'])
})

test('inherit case 2: parent model edits reach the team with no re-seeding — drift is physically gone', async t => {
  const { manager } = await fixture(t)
  manager.inheritModelSettings = true
  const parent = await seedParent(manager)
  await add(manager, 'drift')
  await manager.provisionHome(manager.findTeam('drift'))
  const link = path.join(teamHome(manager, 'drift'), 'cordis.patch.yml')
  // the parent evolves while the team is frozen in the old design: a new GLM-class entry
  // declaring vision (the IMG-VISION-001 class of fix) must be visible without any team action
  await writeFile(parent, PARENT.replace('          - id: qwen-vision\n            input: [text, image]', '          - id: qwen-vision\n            input: [text, image]\n          - id: glm-vision\n            input: [text, image]'))
  const providers = parse(await readFile(link, 'utf8')).find(entry => entry.id === 'llm-pi-ai').config.providers
  assert.deepEqual(providers.spark.models.map(model => model.id), ['qwen-vision', 'glm-vision'], 'the team reads what the parent now says')
  assert.deepEqual(providers.spark.models.at(-1).input, ['text', 'image'], 'modalities declared by the parent survive onto the team')
})

test('inherit case 3: the start-time ensure leg migrates a legacy frozen copy to a .bak and links the home root', async t => {
  const { manager } = await fixture(t)
  manager.inheritModelSettings = true
  await seedParent(manager)
  await add(manager, 'legacy')
  const team = manager.findTeam('legacy')
  await manager.provisionHome(team)
  // simulate a pre-inheritance team: a stale full copy sits under profiles/web
  const profileDir = path.join(teamHome(manager, 'legacy'), 'profiles/web')
  await writeFile(path.join(profileDir, 'cordis.patch.yml'), '- id: llm-pi-ai\n  config:\n    providers:\n      legacy:\n        baseURL: http://stale.example/v1\n')
  await manager.applyTeamModel(team, manager.models.find(model => model.id === 'spark'))
  await manager.ensureInstanceModel(team) // the start-time ensure leg, run before every spawn (lifecycle.js:343)
  assert.ok((await lstat(path.join(teamHome(manager, 'legacy'), 'cordis.patch.yml'))).isSymbolicLink(), 'the home root is linked to the single source')
  const entries = await readdir(profileDir)
  assert.ok(!entries.includes('cordis.patch.yml'), 'the frozen copy is gone from the profile layer')
  const backups = entries.filter(name => name.startsWith('cordis.patch.yml.model-inherited-') && name.endsWith('.bak'))
  assert.equal(backups.length, 1, 'the retired copy is kept as a .bak, never silently deleted')
  assert.match(await readFile(path.join(profileDir, backups[0]), 'utf8'), /stale\.example/)
})

test('inherit case 4: a hand-written home-level patch file is an explicit local override and is honoured as-is', async t => {
  const { manager } = await fixture(t)
  manager.inheritModelSettings = true
  await seedParent(manager)
  await add(manager, 'own')
  const home = teamHome(manager, 'own')
  await mkdir(home, { recursive: true })
  const own = path.join(home, 'cordis.patch.yml')
  await writeFile(own, '- id: ui-chat\n  config:\n    transcriptView: compact\n')
  assert.equal(await linkModelPatch(manager.parentHome, home), false, 'the hand-written file is recognised as an explicit override')
  assert.ok((await lstat(own)).isFile(), 'it stays a regular file — never replaced by the inherited link')
  assert.match(await readFile(own, 'utf8'), /transcriptView: compact/)
})

test('inherit case 5: the team pick travels in the generated selection overlay, not the parent pick', async t => {
  const { manager, root } = await fixture(t)
  manager.inheritModelSettings = true
  await seedParent(manager) // the parent selects spark/qwen-vision; the team will pick glm
  await manager.createModel({ id: 'glm', name: 'GLM', baseURL: 'http://192.168.1.9:8889/v1', modelId: 'glm-5.3-flash', input: ['text', 'image'] })
  await add(manager, 'pick')
  const team = manager.findTeam('pick')
  await manager.applyTeamModel(team, manager.models.find(model => model.id === 'glm'))
  await manager.startTeam('pick')
  assert.equal((await manager.getTeam('pick')).status, 'running')
  const selection = path.join(manager.root, 'teams/pick/model-selection.patch.yml')
  assert.ok((await lastSpawnPatches(root)).includes(selection), 'the spawn carries the team selection overlay')
  assert.deepEqual(parse(await readFile(selection, 'utf8')), [{ id: 'agent-default-model', config: { provider: 'glm', model: 'glm-5.3-flash' } }], 'the overlay states the team account, not the parent pick')
  await manager.stopTeam('pick')
})

test('inherit case 6: a hand-placed model-override overlay is passed last, after the team selection (last wins)', async t => {
  const { manager, root } = await fixture(t)
  manager.inheritModelSettings = true
  await seedParent(manager)
  await manager.createModel({ id: 'glm', name: 'GLM', baseURL: 'http://192.168.1.9:8889/v1', modelId: 'glm-5.3-flash', input: ['text', 'image'] })
  await add(manager, 'over')
  const team = manager.findTeam('over')
  await manager.applyTeamModel(team, manager.models.find(model => model.id === 'glm'))
  const override = path.join(manager.root, 'teams/over/model-override.patch.yml')
  await writeFile(override, '- id: agent-default-model\n  config:\n    provider: glm\n    model: glm-5.3-flash\n')
  await manager.startTeam('over')
  const selection = path.join(manager.root, 'teams/over/model-selection.patch.yml')
  assert.deepEqual(await lastSpawnPatches(root), [
    path.join(manager.root, 'teams/over/communications.patch.yml'),
    selection,
    override,
  ], 'overlay order: communications < team selection < explicit override — last wins')
  // ds-headbot neither generates nor reclaims the override file; the team stays on it after a stop
  await manager.stopTeam('over')
  assert.match(await readFile(override, 'utf8'), /glm-5.3-flash/)
})

test('inherit case 7: DSH-materialized profile-layer files (bare pick, empty stub) are not model copies and are never retired', async t => {
  const { manager } = await fixture(t)
  manager.inheritModelSettings = true
  await seedParent(manager)
  await add(manager, 'stub')
  const team = manager.findTeam('stub')
  await manager.provisionHome(team)
  await manager.applyTeamModel(team, manager.models.find(model => model.id === 'spark'))
  const profileDir = path.join(teamHome(manager, 'stub'), 'profiles/web')
  // DSH re-materializes these on every spawn: a bare default-model pick (the 133-byte shape)
  // and an empty stub with only the root comment (the 217-byte shape of a fresh team)
  await writeFile(path.join(profileDir, 'cordis.patch.yml'), '- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    provider: spark\n    model: qwen-vision\n')
  await manager.ensureInstanceModel(team)
  let entries = await readdir(profileDir)
  assert.equal(entries.filter(name => name.startsWith('cordis.patch.yml.model-inherited-')).length, 0, 'a bare default-model pick is DSH-owned materialization, not a frozen copy')
  assert.match(await readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8'), /qwen-vision/, 'the pick file stays in place')
  await writeFile(path.join(profileDir, 'cordis.patch.yml'), '# root comment\n[]\n')
  await manager.ensureInstanceModel(team)
  entries = await readdir(profileDir)
  assert.equal(entries.filter(name => name.startsWith('cordis.patch.yml.model-inherited-')).length, 0, 'an empty stub is not a model copy either')
  assert.ok((await lstat(path.join(teamHome(manager, 'stub'), 'cordis.patch.yml'))).isSymbolicLink(), 'the inheritance symlink survives untouched')
})

test('inherit case 8: a stub that later gains a model entry is still retired by the next ensure pass', async t => {
  const { manager } = await fixture(t)
  manager.inheritModelSettings = true
  await seedParent(manager)
  await add(manager, 'grow')
  const team = manager.findTeam('grow')
  await manager.provisionHome(team)
  await manager.applyTeamModel(team, manager.models.find(model => model.id === 'spark'))
  const profileDir = path.join(teamHome(manager, 'grow'), 'profiles/web')
  await writeFile(path.join(profileDir, 'cordis.patch.yml'), '[]\n')
  await manager.ensureInstanceModel(team)
  await writeFile(path.join(profileDir, 'cordis.patch.yml'), '- id: llm-pi-ai\n  config:\n    providers:\n      stale:\n        baseURL: http://grown.example/v1\n')
  await manager.ensureInstanceModel(team)
  const entries = await readdir(profileDir)
  assert.ok(!entries.includes('cordis.patch.yml'), 'the grown model copy is retired on sight')
  assert.equal(entries.filter(name => name.startsWith('cordis.patch.yml.model-inherited-') && name.endsWith('.bak')).length, 1)
  assert.ok((await lstat(path.join(teamHome(manager, 'grow'), 'cordis.patch.yml'))).isSymbolicLink())
})
