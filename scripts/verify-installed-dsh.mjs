// Usage: node scripts/verify-installed-dsh.mjs /path/to/dsh-installation
// Loads only Cordis, system-prompt, tools and this plugin; never calls a model.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as teamPlugin from '../lib/team-plugin.js'

const installation = process.argv[2]
if (!installation) throw new Error('provide the installed DSH root containing node_modules')
const moduleUrl = name => pathToFileURL(path.resolve(installation, 'node_modules', '@deepseek-ai', name, 'lib/index.js')).href
const { Context } = await import(moduleUrl('cordis'))
const { default: SystemPrompt } = await import(moduleUrl('dsh-system-prompt'))
const { default: ToolRuntime } = await import(moduleUrl('dsh-tools'))
const version = JSON.parse(await readFile(path.resolve(installation, 'node_modules/@deepseek-ai/dsh-tools/package.json'), 'utf8')).version
const workspace = await mkdtemp(path.join(tmpdir(), 'headbot-compat-'))
Object.assign(process.env, { HEADBOT_TEAM_ID: 'compatibility-check', HEADBOT_TEAM_TOKEN: '0'.repeat(64), HEADBOT_BROKER_URL: 'http://127.0.0.1:9/api/ds-headbot/v1/comms/v1', HEADBOT_TEAM_FILES_ROOT: workspace })
try {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(teamPlugin, {})
  const names = ctx.tools.schemas().map(tool => tool.name).sort()
  assert.deepEqual(names, ['headbot_download_attachment', 'headbot_list_teams', 'headbot_receive_messages', 'headbot_send_message'])
  console.log(JSON.stringify({ result: 'passed', dshToolsVersion: version, tools: names, modelRequests: 0 }, null, 2))
} finally {
  await rm(workspace, { recursive: true, force: true })
}
