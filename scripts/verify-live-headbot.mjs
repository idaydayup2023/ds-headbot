// Run on the controller host: node scripts/verify-live-headbot.mjs config.json
// Config: {home, log, installation, ingressPort, controllerPort, publicHost, output}
// Creates two uniquely named temporary teams, preserves their audit/archive data,
// then removes only those definitions. No model requests or credentials printed.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const config = JSON.parse(await readFile(process.argv[2], 'utf8'))
const { home, installation, publicHost, ingressPort, controllerPort } = config
const prefix = '/dsh/api/ds-headbot/v1'
const suffix = randomUUID().slice(0, 8)
const ids = [`verify-a-${suffix}`, `verify-b-${suffix}`]
const created = []
const results = { startedAt: new Date().toISOString(), teams: ids, checks: [], modelRequests: 0 }
let cookie
function scopedCookies(response, mount) {
  const cookies = response.headers['set-cookie']
  assert.ok(cookies?.length, 'sign-in did not return a cookie')
  for (const cookie of cookies) {
    const attributes = cookie.split(';').map(item => item.trim())
    assert.ok(attributes.includes(`Path=${mount}/`), 'cookie path is not properly delimited')
    for (const required of ['Secure', 'HttpOnly', 'SameSite=Strict']) assert.ok(attributes.includes(required))
  }
  return cookies.map(item => item.split(';')[0]).join('; ')
}
function request(route, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request({ hostname: '127.0.0.1', port: ingressPort, path: route, method,
      headers: { Host: publicHost, Origin: `https://${publicHost}`, ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers }, timeout: 30000 }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks), json() { return JSON.parse(this.bytes) } }))
    })
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('request timeout'))); req.end(data)
  })
}
async function api(route, options, expected = 200) {
  const response = await request(prefix + route, options)
  assert.equal(response.status, expected, `HTTP ${response.status} on ${route}: ${response.bytes.toString().slice(0, 1000)}`)
  return response.json()
}
async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
async function waitTeam(id, expected) {
  const deadline = Date.now() + 180000
  do {
    const team = (await api('/teams')).teams.find(team => team.id === id)
    if (team?.status === expected) return team
    if (team?.status === 'failed') throw new Error(`team ${id} failed: ${team.message}`)
    await new Promise(resolve => setTimeout(resolve, 800))
  } while (Date.now() < deadline)
  throw new Error(`team ${id} did not reach ${expected}`)
}
const moduleUrl = name => pathToFileURL(path.join(installation, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href
const { Context } = await import(moduleUrl('cordis'))
const { default: SystemPrompt } = await import(moduleUrl('dsh-system-prompt'))
const { default: Tools } = await import(moduleUrl('dsh-tools'))
const teamPlugin = await import(pathToFileURL(path.join(home, 'profiles/web/node_modules/ds-headbot/lib/team-plugin.js')))
async function teamTools(id) {
  const { teams } = JSON.parse(await readFile(path.join(home, 'headbot/teams.json'), 'utf8'))
  const team = teams.find(team => team.id === id)
  const teamRoot = path.join(home, 'headbot/teams', id)
  Object.assign(process.env, { HEADBOT_TEAM_ID: id, HEADBOT_TEAM_TOKEN: team.communicationToken, HEADBOT_BROKER_URL: `http://127.0.0.1:${controllerPort}/api/ds-headbot/v1/comms/v1`, HEADBOT_TEAM_FILES_ROOT: path.join(teamRoot, 'workspace'), HEADBOT_TEAM_BOT_FILES_ROOT: path.join(teamRoot, 'home/bot/workspace') })
  const ctx = new Context(); await ctx.plugin(SystemPrompt, {}); await ctx.plugin(Tools, { mode: 'native' }); await ctx.plugin(teamPlugin, {})
  assert.equal(ctx.tools.schemas().length, 4)
  return async (name, args = {}) => JSON.parse(await ctx.tools.get(name).execute(args, { signal: new AbortController().signal }))
}
try {
  assert.equal((await request(prefix + '/teams')).status, 401)
  const raw = await readFile(config.log, 'utf8')
  const printed = [...raw.matchAll(/dsh web:\s*(https?:\/\/\S+)/g)].at(-1)?.[1]
  assert.ok(printed, 'controller launch URL missing')
  const launch = new URL(printed)
  const login = await request(launch.pathname + launch.search)
  assert.ok([302, 303].includes(login.status), `login HTTP ${login.status}`)
  cookie = scopedCookies(login, '/dsh')
  results.checks.push('unauthenticated admission and controller login with scoped cookie')
  assert.equal((await request(prefix + '/teams', { headers: { Origin: 'https://untrusted.invalid' } })).status, 403)
  assert.equal((await request('/dsh/manage/')).status, 200)
  for (const id of ids) {
    await api('/teams', { method: 'POST', body: { id, name: `Verification ${id}`, port: await freePort(), autoStart: false } }, 202)
    created.push(id)
  }
  const running = await Promise.all(ids.map(id => waitTeam(id, 'running')))
  assert.notEqual(running[0].pid, running[1].pid)
  for (const team of running) {
    assert.ok(team.launchUrl, 'team launch URL missing')
    const url = new URL(team.launchUrl)
    const login = await request(url.pathname + url.search, { headers: { Cookie: '' } })
    assert.ok([302, 303].includes(login.status), `login HTTP ${login.status}`)
    const teamCookie = scopedCookies(login, `/teams/${team.id}`)
    const page = await request(`/teams/${team.id}/`, { headers: { Cookie: teamCookie } })
    assert.equal(page.status, 200)
    assert.ok(page.bytes.toString().includes('<base href="./">'), 'DSH must resolve assets relative to the team mount')
    assert.ok(page.bytes.toString().includes('ds-bot/client.js'), 'ds-bot client module is missing')
    const bundle = page.bytes.toString().match(/href="(plugins[^"]+)"/)?.[1]?.replaceAll('&amp;', '&')
    assert.ok(bundle)
    assert.equal((await request(`/teams/${team.id}/${bundle}`, { headers: { Cookie: teamCookie } })).status, 200)
    const profile = JSON.parse(await readFile(path.join(home, 'headbot/teams', team.id, 'home/profiles/web/package.json'), 'utf8'))
    for (const dependency of config.expectedTeamPlugins ?? ['ds-bot']) assert.ok(profile.dependencies[dependency], `missing ${dependency}`)
  }
  results.checks.push('two simultaneous real DSH + ds-bot instances, network plugin, authenticated path routing')
  await api(`/teams/${ids[1]}/stop`, { method: 'POST', body: {} }, 202); await waitTeam(ids[1], 'stopped')
  const a = await teamTools(ids[0]), b = await teamTools(ids[1])
  assert.ok((await a('headbot_list_teams')).teams.some(team => team.id === ids[1]))
  const bytes = Buffer.from('Headbot production verification\n资料完整性验证\n')
  const botWorkspace = path.join(home, 'headbot/teams', ids[0], 'home/bot/workspace')
  await writeFile(path.join(botWorkspace, 'report.txt'), bytes, { mode: 0o600 })
  const sent = await a('headbot_send_message', { to: ids[1], subject: '部署验证', text: '审计消息与资料传输', files: ['report.txt'], requestId: randomUUID() })
  await api(`/teams/${ids[1]}/start`, { method: 'POST', body: {} }, 202); await waitTeam(ids[1], 'running')
  const inbox = await b('headbot_receive_messages')
  assert.equal(inbox.messages[0].messageId, sent.message.messageId)
  const file = sent.message.attachments[0]
  const downloaded = await b('headbot_download_attachment', { messageId: sent.message.messageId, attachmentId: file.id })
  assert.deepEqual(await readFile(downloaded.path), bytes)
  assert.equal(downloaded.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.ok(downloaded.path.startsWith(path.join(home, 'headbot/teams', ids[1], 'home/bot/workspace/inbox') + path.sep))
  results.checks.push('real DSH registered tools: DS Bot workspace file send, offline text/file receive and hash-verified download')
  await api(`/teams/${ids[0]}/restart`, { method: 'POST', body: {} }, 202); await waitTeam(ids[0], 'running')
  const review = await request(`${prefix}/audit/messages/${sent.message.messageId}/attachments/${file.id}`)
  assert.equal(review.status, 200); assert.deepEqual(review.bytes, bytes)
  const audit = await api('/audit/export')
  for (const type of ['message.sent', 'messages.received', 'attachment.received', 'attachment.reviewed']) assert.ok(audit.events.some(event => event.type === type))
  assert.equal(audit.integrity, 'verified')
  results.checks.push('restart, audit full text, reviewer attachment bytes and complete verified export')
  results.messageId = sent.message.messageId; results.attachmentSha256 = file.sha256
  results.result = 'passed'
} catch (error) {
  results.result = 'failed'; results.error = error.message.slice(0, 2000); process.exitCode = 1
} finally {
  results.archives = []
  for (const id of created) {
    try { results.archives.push((await api(`/teams/${id}`, { method: 'DELETE' })).deleted.archivePath) } catch (error) { results.cleanupError = error.message; process.exitCode = 1 }
  }
  results.finishedAt = new Date().toISOString()
  if (config.output) await writeFile(config.output, JSON.stringify(results, null, 2) + '\n', {mode:0o600})
  console.log(JSON.stringify(results, null, 2))
}
