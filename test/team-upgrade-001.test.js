import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { add, fixture } from './helpers.js'

// TEAM-UPGRADE-001 (production incident 2026-11-22, team 3132):
// pnpm's minimumReleaseAge supply-chain gate is enabled by default in this environment and
// silently keeps a package version published inside its window: `pnpm update --latest ds-bot`
// exited 0 on 0.3.8 while the registry latest was 0.3.9 (verified on the live machine; the
// only two observed antidotes are minimumReleaseAge=0 and a matching minimumReleaseAgeExclude
// entry, both of which teams had to apply by hand). updateBot therefore must (1) state the
// upgrade intent to the resolver explicitly, (2) report the kept version with its true
// mechanism, and (3) never leave an installed team stopped after a failed upgrade.

async function seedBotPackage(manager, id, version) {
  const dir = path.join(manager.root, 'teams', id, 'home', 'profiles', 'web', 'node_modules', 'ds-bot')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'ds-bot', version }))
}

function registryLatest(manager, version) {
  manager.fetchImpl = async () => ({ ok: true, json: async () => ({ version }) })
}

test('the update leg tells the package manager to ignore the release-age gate (TEAM-UPGRADE-001)', async t => {
  const { manager, pluginLog } = await fixture(t)
  await add(manager, 'gate')
  await seedBotPackage(manager, 'gate', '0.3.9')
  await manager.startTeam('gate')
  registryLatest(manager, '0.3.9')
  await manager.updateBot('gate')
  const log = await readFile(pluginLog, 'utf8')
  assert.match(log, /^plugin --profile web update --latest ds-bot --config\.minimumReleaseAgeExclude=ds-bot@\*$/m, 'the update leg carries the gate argument')
})

test('the fresh-install leg carries the same gate argument (TEAM-UPGRADE-001)', async t => {
  const { manager, pluginLog } = await fixture(t)
  await add(manager, 'fresh')
  await seedBotPackage(manager, 'fresh', '0.3.9')
  registryLatest(manager, '0.3.9')
  await manager.updateBot('fresh') // botInstalled false → add leg
  const log = await readFile(pluginLog, 'utf8')
  assert.match(log, /^plugin --profile web add ds-bot --config\.minimumReleaseAgeExclude=ds-bot@\*$/m, 'the add leg carries the gate argument')
})

test('a failed update brings the still-good old package back up instead of leaving the team down (TEAM-UPGRADE-001)', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'down')
  await seedBotPackage(manager, 'down', '0.3.8')
  await manager.startTeam('down')
  registryLatest(manager, '0.3.9')
  await assert.rejects(manager.updateBot('down'), { statusCode: 500 })
  const view = await manager.getTeam('down')
  assert.equal(view.status, 'running', 'the old version keeps serving after a failed upgrade')
  assert.match(manager.runtime.get('down').message, /still at 0\.3\.8/, 'the card message still tells the upgrade failure')
})

test('a never-installed team is not spun up in circles after its first failed install (TEAM-UPGRADE-001)', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'never')
  registryLatest(manager, '0.3.9') // no package on disk: the add leg cannot be believed
  await assert.rejects(manager.updateBot('never'), { message: /not present in the profile/ })
  assert.equal(manager.findTeam('never').botInstalled, false)
  assert.equal(manager.runtime.get('never').phase, 'failed', 'without an old package to fall back to, the failure stays visible')
})

test('the kept-version error names the real mechanism instead of blaming a silent keeper (TEAM-UPGRADE-001)', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'wording')
  await seedBotPackage(manager, 'wording', '0.3.6')
  await manager.startTeam('wording')
  registryLatest(manager, '0.3.8')
  await assert.rejects(manager.updateBot('wording'), {
    message: /kept the older version \(its release-age\/supply-chain gate or a resolution policy/,
  }, 'the error explains what can keep the version and what the update leg does about it')
})

test('both upgrade legs share the one gate argument from shared.js (TEAM-UPGRADE-001, source truth)', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const shared = await readFile(path.join(here, '..', 'lib', 'manager', 'shared.js'), 'utf8')
  const lifecycle = await readFile(path.join(here, '..', 'lib', 'manager', 'lifecycle.js'), 'utf8')
  const controller = await readFile(path.join(here, '..', 'lib', 'manager', 'controller.js'), 'utf8')
  assert.match(shared, /export const botUpgradeArgs = pkg => \[`--config\.minimumReleaseAgeExclude=\$\{pkg\}@\*`\]/, 'shared.js owns the exclude-form gate argument verbatim')
  assert.match(lifecycle, /'plugin', '--profile', 'web', 'update', '--latest', this\.botPackage, \.\.\.botUpgradeArgs\(this\.botPackage\)/, 'the team update leg spreads it')
  assert.match(lifecycle, /'plugin', '--profile', 'web', 'add', this\.botPackage, \.\.\.botUpgradeArgs\(this\.botPackage\)/, 'the team add leg spreads it')
  assert.match(controller, /'plugin', '--profile', 'web', 'update', '--latest', this\.botPackage, \.\.\.botUpgradeArgs\(this\.botPackage\)/, 'the controller update leg spreads it')
  assert.match(controller, /'plugin', '--profile', 'web', 'add', this\.botPackage, \.\.\.botUpgradeArgs\(this\.botPackage\)/, 'the controller add leg spreads it')
  assert.equal(lifecycle.includes('minimumReleaseAgeExclude='), false, 'no local copy of the gate argument may drift on the team side')
  assert.equal(controller.includes('minimumReleaseAgeExclude='), false, 'nor on the controller side')
})
