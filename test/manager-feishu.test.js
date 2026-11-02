import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import { add, fixture } from './helpers.js'

test('Feishu bridge is packed for isolated profiles instead of treated as an installed source link', async t => {
  const { manager } = await fixture(t)
  const team = await add(manager, 'feishu')
  const profileHome = path.join(manager.root, 'teams/feishu/home')
  const profileModules = path.join(profileHome, 'profiles/web/node_modules')
  const installedPath = path.join(profileModules, 'ds-headbot-feishu')
  await mkdir(profileModules, { recursive: true })
  await symlink(manager.feishuPluginPath(), installedPath, 'dir')
  assert.equal(await manager.isTeamFeishuInstalled(team), false, 'a link to the controller package cannot provide isolated peer dependencies')

  const archive = await manager.packFeishuPlugin()
  const manifest = JSON.parse(await readFile(path.join(manager.feishuPluginPath(), 'package.json'), 'utf8'))
  assert.match(archive, new RegExp(`packages/ds-headbot-feishu-${manifest.version.replaceAll('.', '\\.')}-[a-f0-9]{16}\\.tgz$`))
  const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split('\n')
  assert.ok(members.includes('package/lib/index.js'))
  assert.ok(members.includes('package/package.json'))
  assert.equal(members.some(member => member.includes('node_modules')), false)

  const packagedDirectory = path.join(profileModules, '.pnpm/ds-headbot-feishu@0.1.2/node_modules/ds-headbot-feishu')
  await mkdir(packagedDirectory, { recursive: true })
  await writeFile(path.join(packagedDirectory, 'package.json'), await readFile(path.join(manager.feishuPluginPath(), 'package.json')))
  await unlink(installedPath)
  await symlink(packagedDirectory, installedPath, 'dir')
  assert.equal(await manager.isTeamFeishuInstalled(team), true, 'a package installed inside the team profile is accepted')
})

test('enabled Headbot Feishu config explicitly overrides the package disabled default', async t => {
  const { manager } = await fixture(t)
  const team = await add(manager, 'feishu-config')
  team.feishu = { enabled: true, appId: 'cli_test', botId: 'agent-test' }
  manager.resolveFeishuTargetSession = async () => 'session-test'

  await manager.provisionHome(team)

  const patch = parse(await readFile(path.join(manager.root, 'teams/feishu-config/communications.patch.yml'), 'utf8'))
  const plugin = patch.find(entry => entry.id === 'ds-headbot-feishu')
  assert.ok(plugin)
  assert.equal(plugin.disabled, false)
  assert.equal(plugin.config.agentId, 'session-test')
})
