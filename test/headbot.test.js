import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { HeadbotManager } from '../lib/manager.js'
import { AuditedCommunications } from '../lib/communications.js'
import { apply as applyHeadbot, handleApiRequest, version as headbotVersion } from '../index.js'
import { apply as applyTeam } from '../lib/team-plugin.js'
import { renderManagerPage } from '../lib/page.js'
import { HeadbotReleaseUpdater, compareVersions, performHeadbotUpdate } from '../lib/release-updater.js'
import { parse } from 'yaml'
import { startIngress } from '../lib/ingress.js'
import { runInNewContext } from 'node:vm'

const quiet = { warn() {}, error() {} }
const apiPath = '/api/ds-headbot/v1'

async function port() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const value = server.address().port
  await new Promise(resolve => server.close(resolve))
  return value
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'headbot-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fake = path.join(root, 'fake-dsh.mjs')
  const pluginLog = path.join(root, 'plugin-commands.log')
  await writeFile(fake, `import http from 'node:http';import {readFileSync,realpathSync,existsSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2);if(args[0]==='plugin'){appendFileSync(${JSON.stringify(pluginLog)},args.join(' ')+'\\n');process.exit(0)}
const value=key=>args[args.indexOf(key)+1];
if(!readFileSync(value('--patch'),'utf8').includes('team-plugin.js'))process.exit(2);
if(!process.env.HEADBOT_TEAM_TOKEN||process.cwd()!==realpathSync(process.env.HEADBOT_TEAM_FILES_ROOT))process.exit(3);
const readyAt=Date.now()+(existsSync(${JSON.stringify(path.join(root, 'transient-404'))})?800:0);
http.createServer((_req,res)=>{res.statusCode=Date.now()<readyAt?404:200;res.end('ok')}).listen(Number(value('--port')),'127.0.0.1');
console.log('dsh web: '+value('--public-url')+'?token=test-secret');`)
  const manager = new HeadbotManager({ dataDir: path.join(root, 'headbot'), dshHome: path.join(root, 'home'), dshCommand: fake, inheritModelSettings: false, ingressPort: await port() }, { parentPort: await port(), logger: quiet })
  t.after(() => manager.close())
  return { root, manager, fake, pluginLog }
}

async function add(manager, id) {
  return manager.createTeam({ id, name: id.toUpperCase(), port: await port(), autoStart: false })
}

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
  assert.match(await readFile(pluginLog, 'utf8'), /plugin --profile web update --latest ds-bot/)
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

test('offline messages, binary attachments, safe retries and replay survive controller restart', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta'); await add(manager, 'gamma')
  const a = manager.identity(manager.findTeam('alpha')), b = manager.identity(manager.findTeam('beta')), c = manager.identity(manager.findTeam('gamma'))
  const broker = new AuditedCommunications(manager.root, manager)
  const bytes = Buffer.from([0, 255, 10, 89])
  const input = { to: 'beta', from: { id: 'spoofed' }, requestId: randomUUID(), subject: '资料', text: '离线团队也能接收', attachments: [{ name: '资料.bin', contentBase64: bytes.toString('base64') }] }
  const sent = await broker.send(a, input)
  assert.equal(sent.message.from.id, 'alpha')
  assert.equal((await broker.send(a, input)).duplicate, true)
  await assert.rejects(broker.send(a, { ...input, text: 'different' }), { statusCode: 409 })
  const reloaded = new AuditedCommunications(manager.root, manager)
  const inbox = await reloaded.inbox(b)
  assert.equal(inbox.messages.length, 1)
  assert.equal(inbox.messages[0].text, input.text)
  assert.deepEqual((await reloaded.inbox(b, inbox.nextCursor)).messages, [])
  const file = sent.message.attachments[0]
  assert.deepEqual((await reloaded.attachment(b, sent.message.messageId, file.id)).bytes, bytes)
  await assert.rejects(reloaded.attachment(c, sent.message.messageId, file.id), { statusCode: 404 })
  const audit = await reloaded.exportAudit()
  assert.deepEqual(audit.events.map(event => event.type), ['message.sent', 'messages.received', 'attachment.received'])
  assert.equal(audit.events[0].attachments[0].sha256, file.sha256)
  assert.equal(audit.integrity, 'verified')
  await manager.deleteTeam('beta'); await add(manager, 'beta')
  await assert.rejects(reloaded.inbox(b), { statusCode: 401 })
  assert.deepEqual((await reloaded.inbox(manager.identity(manager.findTeam('beta')))).messages, [])
  assert.equal((await reloaded.audit({ team: 'beta' })).events.length, 3)
})

test('startup retries temporary HTTP 404 responses until DSH routes are ready', async t => {
  const {manager, root} = await fixture(t)
  await writeFile(path.join(root, 'transient-404'), '')
  await add(manager, 'warming')
  await manager.startTeam('warming')
  assert.equal((await manager.getTeam('warming')).status, 'running')
})

test('ingress scopes browser cookies while preserving attribute separators', async t => {
  const upstream = createServer((_req, res) => {
    res.writeHead(303, {Location:'./', 'Set-Cookie':'dsh-auth-example=signed; Max-Age=2592000; Path=/; Expires=Mon, 16 Nov 2026 03:18:29 GMT; HttpOnly; SameSite=Strict'})
    res.end()
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => {upstream.close(resolve); upstream.closeAllConnections()}))
  const ingressPort = await port()
  const ingress = startIngress({host:'127.0.0.1',port:ingressPort,parentHost:'127.0.0.1',parentPort:upstream.address().port,controllerPath:'dsh',teamsPath:'teams',publicHost:'localhost',manager:{async getTeam(){return {port:upstream.address().port,status:'running'}}}})
  await ingress.ready; t.after(() => ingress.close())
  for (const mount of ['/dsh', '/teams/example']) {
    const response=await fetch(`http://127.0.0.1:${ingressPort}${mount}/?token=example`, {redirect:'manual'})
    assert.equal(response.status,303)
    const attributes=response.headers.getSetCookie()[0].split(';').map(item=>item.trim())
    assert.ok(attributes.includes(`Path=${mount}/`), attributes.join(';'))
    assert.ok(attributes.includes('Expires=Mon, 16 Nov 2026 03:18:29 GMT'))
    for (const attr of ['HttpOnly', 'SameSite=Strict', 'Secure']) assert.ok(attributes.includes(attr))
  }
})

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

test('audit failures block send, receive and file delivery; tampering is detected', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta')
  const a = manager.identity(manager.findTeam('alpha')), b = manager.identity(manager.findTeam('beta'))
  const broker = new AuditedCommunications(manager.root, manager)
  const append = broker.append
  broker.append = async () => { throw new Error('simulated disk failure') }
  await assert.rejects(broker.send(a, { to: 'beta', text: 'must not arrive' }), /disk failure/)
  broker.append = append
  assert.deepEqual((await broker.inbox(b)).messages, [])
  const sent = await broker.send(a, { to: 'beta', text: 'audited', attachments: [{ name: 'file.txt', contentBase64: Buffer.from('content').toString('base64') }] })
  broker.append = async () => { throw new Error('simulated disk failure') }
  await assert.rejects(broker.inbox(b), /disk failure/)
  await assert.rejects(broker.attachment(b, sent.message.messageId, sent.message.attachments[0].id), /disk failure/)
  broker.append = append
  await writeFile(path.join(broker.objects, sent.message.attachments[0].id), 'modified')
  await assert.rejects(broker.attachment(b, sent.message.messageId, sent.message.attachments[0].id), /integrity/)
  const journal = await readFile(broker.journal, 'utf8')
  await writeFile(broker.journal, journal.replace('audited', 'changed'))
  await assert.rejects(broker.send(a, { to: 'beta', text: 'blocked' }), /integrity/)
  await writeFile(broker.journal, '')
  await assert.rejects(new AuditedCommunications(manager.root, manager).inbox(b), /checkpoint/)
})

test('attachment filename and transfer limits are enforced before delivery', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta')
  const broker = new AuditedCommunications(manager.root, manager, { attachmentBytes: 3, transferBytes: 4 })
  const a = manager.identity(manager.findTeam('alpha')), b = manager.identity(manager.findTeam('beta'))
  await assert.rejects(broker.send(a, { to: 'beta', attachments: [{ name: '../escape', contentBase64: 'YQ==' }] }), { statusCode: 400 })
  await assert.rejects(broker.send(a, { to: 'beta', attachments: [{ name: 'big', contentBase64: 'YWJjZA==' }] }), { statusCode: 413 })
  await assert.rejects(broker.send(a, { to: 'beta', attachments: [{ name: 'bad', contentBase64: 'abc!' }] }), { statusCode: 400 })
  assert.deepEqual((await broker.inbox(b)).messages, [])
})

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

test('HTTP admission separates browser management from team access and plugin tools exchange files', async t => {
  const { root, fake } = await fixture(t)
  const routes = []
  const server = createServer((req, res) => {
    const route = routes.find(route => new URL(req.url, 'http://local').pathname.startsWith(route.path))
    if (route) void route.handler(req, res)
    else { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  let dispose
  const dataDir = path.join(root, 'http-headbot')
  applyHeadbot({
    webServer: { host: '127.0.0.1', port: server.address().port, register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1) } },
    connection: { requestRejection(req) { return req.headers['x-controller-session'] === 'test' ? undefined : 401 } },
    logger: quiet, effect(callback) { dispose = callback() },
  }, { dataDir, dshHome: path.join(root, 'http-home'), dshCommand: fake, inheritModelSettings: false, ingressPort: await port(), communicationLimits: { textBytes: 128, attachmentBytes: 1024, transferBytes: 2048 } })
  t.after(() => dispose())
  const base = `http://127.0.0.1:${server.address().port}${apiPath}`
  const admin = { 'x-controller-session': 'test', 'Content-Type': 'application/json' }
  assert.equal((await fetch(base + '/teams')).status, 401)
  for (const id of ['alpha', 'beta']) {
    const response = await fetch(base + '/teams', { method: 'POST', headers: admin, body: JSON.stringify({ id, name: id, port: await port(), autoStart: false }) })
    assert.equal(response.status, 202)
  }
  const state = JSON.parse(await readFile(path.join(dataDir, 'teams.json'), 'utf8'))
  const a = state.teams.find(team => team.id === 'alpha'), b = state.teams.find(team => team.id === 'beta')
  assert.equal((await fetch(base + '/comms/v1/inbox')).status, 401)
  assert.equal((await fetch(base + '/comms/v1/messages', { method: 'POST', headers: { Authorization: 'Bearer ' + a.communicationToken }, body: 'x'.repeat(70000) })).status, 413)
  assert.equal((await fetch(base + '/audit', { headers: { Authorization: 'Bearer ' + a.communicationToken } })).status, 401)
  assert.equal((await fetch(base + '/teams/beta', { method: 'DELETE', headers: { Authorization: 'Bearer ' + a.communicationToken } })).status, 401)
  const envKeys = ['HEADBOT_TEAM_ID', 'HEADBOT_TEAM_TOKEN', 'HEADBOT_BROKER_URL', 'HEADBOT_TEAM_FILES_ROOT', 'HEADBOT_TEAM_BOT_FILES_ROOT']
  const old = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  t.after(() => { for (const key of envKeys) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key] })
  async function toolsFor(team) {
    const filesRoot = path.join(root, team.id + '-files')
    const botFilesRoot = path.join(root, team.id + '-bot-files')
    await mkdir(filesRoot)
    await mkdir(botFilesRoot)
    Object.assign(process.env, { HEADBOT_TEAM_ID: team.id, HEADBOT_TEAM_TOKEN: team.communicationToken, HEADBOT_BROKER_URL: base + '/comms/v1', HEADBOT_TEAM_FILES_ROOT: filesRoot, HEADBOT_TEAM_BOT_FILES_ROOT: botFilesRoot })
    const tools = new Map()
    applyTeam({ tools: { register(tool) { tools.set(tool.name, tool) } } })
    return { filesRoot, botFilesRoot, call: async (name, args = {}) => JSON.parse(await tools.get(name).execute(args, { signal: new AbortController().signal })) }
  }
  const alpha = await toolsFor(a), beta = await toolsFor(b)
  assert.equal((await alpha.call('headbot_list_teams')).teams[0].id, 'beta')
  await writeFile(path.join(alpha.botFilesRoot, 'report.txt'), 'bot workspace report')
  await writeFile(path.join(alpha.filesRoot, 'legacy.txt'), 'legacy workspace report')
  await writeFile(path.join(root, 'outside.txt'), 'private')
  await symlink(path.join(root, 'outside.txt'), path.join(alpha.filesRoot, 'escape.txt'))
  await assert.rejects(alpha.call('headbot_send_message', { to: 'beta', files: ['escape.txt'] }), /inside/)
  const sent = await alpha.call('headbot_send_message', { to: 'beta', text: 'please review', files: ['report.txt'] })
  const legacy = await alpha.call('headbot_send_message', { to: 'beta', text: 'legacy workspace compatibility', files: ['legacy.txt'] })
  const inbox = await beta.call('headbot_receive_messages')
  assert.equal(inbox.messages.length, 2)
  const downloaded = await beta.call('headbot_download_attachment', { messageId: sent.message.messageId, attachmentId: sent.message.attachments[0].id })
  assert.match(downloaded.path, /beta-bot-files\/inbox\//)
  assert.equal(await readFile(downloaded.path, 'utf8'), 'bot workspace report')
  assert.equal(legacy.message.attachments[0].sha256, createHash('sha256').update('legacy workspace report').digest('hex'))
  const reviewed = await fetch(base + '/audit/messages/' + sent.message.messageId + '/attachments/' + sent.message.attachments[0].id, { headers: admin })
  assert.equal(await reviewed.text(), 'bot workspace report')
  const exported = await fetch(base + '/audit/export', { headers: admin }).then(response => response.json())
  assert.deepEqual(exported.events.map(event => event.type), ['message.sent', 'message.sent', 'messages.received', 'attachment.received', 'attachment.reviewed'])
  const deletion = await fetch(base + '/teams/beta', { method: 'DELETE', headers: admin })
  assert.equal(deletion.status, 200)
  assert.equal((await fetch(base + '/comms/v1/inbox', { headers: { Authorization: 'Bearer ' + b.communicationToken } })).status, 401)
})

test('manager page shows the version updater and places teams before team creation', () => {
  const html = renderManagerPage({ publicHost: 'localhost', controllerPath: 'dsh', version: '0.2.5' })
  assert.match(html, /创建团队/)
  assert.doesNotMatch(html, /添加团队副本/)
  assert.match(html, /全部更新 DS Bot/)
  assert.match(html, /当前版本：v0\.2\.5/)
  assert.match(html, /id="latest-version"/)
  assert.match(html, /id="upgrade-headbot"/)
  assert.match(html, /button\.update-ready/)
  assert.ok(html.indexOf('<h2>团队实例</h2>') < html.indexOf('<h2>创建团队</h2>'))
  assert.match(html, /call\('\/release\/upgrade'/)
  assert.match(html, /团队名称/)
  assert.match(html, /独立服务端口/)
  assert.match(html, /edit\.textContent='编辑'/)
  assert.match(html, /save\.textContent='保存'/)
  assert.match(html, /cancel\.textContent='取消'/)
  assert.match(html, /editDraft\?\.id===team\.id/)
  assert.match(html, /删除实例/)
  assert.match(html, /团队通信审计/)
  assert.match(html, /导出完整审计档案/)
  // Compile the browser program without executing DOM effects.
  new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1])
})

test('release updater detects newer stable versions and launches a detached update worker', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'headbot-release-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(headbotVersion, '0.3.5')
  assert.equal(compareVersions('0.2.5', '0.2.4'), 1)
  assert.equal(compareVersions('v0.2.5', '0.2.5'), 0)
  assert.throws(() => compareVersions('latest', '0.2.5'), /invalid stable release version/)

  let requestedUrl, spawned, workerExit
  const manager = { root: path.join(root, 'headbot'), parentHome: path.join(root, 'dsh'), dshCommand: 'dsh', parentPort: 3080, controllerPath: 'dsh' }
  const updater = new HeadbotReleaseUpdater({
    currentVersion: '0.2.5', manager, restartCommand: '/bin/launchctl', restartArgs: ['kickstart', '-k', 'gui/501/com.deepseek.dsh'],
    fetchImpl: async url => {
      requestedUrl = url
      return { ok: true, status: 200, async json() { return { tag_name: 'v0.2.7', draft: false, prerelease: false } } }
    },
    spawnImpl(command, args, options) {
      spawned = { command, args, options }
      return { once(event, listener) { if (event === 'exit') workerExit = listener; return this }, unref() {} }
    },
  })
  const status = await updater.check({ force: true })
  assert.match(requestedUrl, /api\.github\.com\/repos\/idaydayup2023\/ds-headbot\/releases\/latest$/)
  assert.equal(status.currentVersion, '0.2.5')
  assert.equal(status.latestVersion, '0.2.7')
  assert.equal(status.updateAvailable, true)
  assert.equal(status.releaseUrl, 'https://github.com/idaydayup2023/ds-headbot/releases/tag/v0.2.7')

  const started = await updater.startUpgrade()
  assert.equal(started.state, 'downloading')
  assert.equal(spawned.command, process.execPath)
  assert.equal(path.basename(spawned.args[0]), 'release-updater.js')
  await access(spawned.args[0])
  const workerConfig = JSON.parse(spawned.args[1])
  assert.equal(workerConfig.tag, 'v0.2.7')
  assert.equal(workerConfig.targetVersion, '0.2.7')
  assert.equal(workerConfig.parentHome, manager.parentHome)
  assert.equal(spawned.options.detached, true)
  assert.equal((await updater.readState()).state, 'downloading')
  await workerExit(1, null)
  assert.equal((await updater.readState()).state, 'failed')
})

test('release API checks versions and queues the authenticated upgrade action', async () => {
  const calls = []
  const updater = {
    async check(options) { calls.push(['check', options]); return { currentVersion: '0.2.5', latestVersion: '0.2.7', updateAvailable: true } },
    async startUpgrade() { calls.push(['upgrade']); return { state: 'downloading', targetVersion: '0.2.7' } },
  }
  const capture = () => ({
    statusCode: 0, headers: {}, body: '',
    setHeader(name, value) { this.headers[name] = value },
    writeHead(statusCode, headers = {}) { this.statusCode = statusCode; Object.assign(this.headers, headers) },
    end(body = '') { this.body += body ?? '' },
  })
  const getResponse = capture()
  await handleApiRequest({ method: 'GET', url: `${apiPath}/release?refresh=1` }, getResponse, {}, {}, {}, quiet, undefined, updater)
  assert.equal(getResponse.statusCode, 200)
  assert.deepEqual(JSON.parse(getResponse.body), { currentVersion: '0.2.5', latestVersion: '0.2.7', updateAvailable: true })
  assert.deepEqual(calls[0], ['check', { force: true }])

  const postResponse = capture()
  await handleApiRequest({ method: 'POST', url: `${apiPath}/release/upgrade` }, postResponse, {}, {}, {}, quiet, undefined, updater)
  assert.equal(postResponse.statusCode, 202)
  assert.deepEqual(JSON.parse(postResponse.body), { state: 'downloading', targetVersion: '0.2.7' })
  assert.deepEqual(calls[1], ['upgrade'])
})

test('release worker verifies the tagged package, installs it, and retains a rollback package', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'headbot-release-worker-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const parentHome = path.join(root, 'dsh')
  const managerRoot = path.join(parentHome, 'headbot')
  const profileDir = path.join(parentHome, 'profiles/web')
  const installedPackage = path.join(profileDir, 'node_modules/ds-headbot')
  const sourceRoot = path.join(root, 'archive-root')
  await mkdir(installedPackage, { recursive: true })
  await mkdir(path.join(sourceRoot, 'lib'), { recursive: true })
  await writeFile(path.join(installedPackage, 'package.json'), JSON.stringify({ name: 'ds-headbot', version: '0.2.5' }))
  await writeFile(path.join(installedPackage, 'index.js'), 'export {}\n')
  await writeFile(path.join(sourceRoot, 'package.json'), JSON.stringify({ name: 'ds-headbot', version: '0.2.7', scripts: { test: 'node --test' } }))
  await writeFile(path.join(sourceRoot, 'index.js'), 'export {}\n')
  await writeFile(path.join(sourceRoot, 'lib/release-updater.js'), 'export const updater = true\n')
  const sourceTar = path.join(root, 'source.tar.gz')
  execFileSync('/usr/bin/tar', ['-czf', sourceTar, '-C', root, 'archive-root'])
  const sourceBytes = await readFile(sourceTar)
  const dshCalls = []
  const fetchUrls = []
  const checkedSources = []
  const runCommand = async (command, args, options = {}) => {
    if (command === '/usr/bin/tar') {
      return { stdout: execFileSync(command, args, { cwd: options.cwd }).toString(), stderr: '' }
    }
    if (args[0] === '--check') {
      checkedSources.push(path.relative(options.cwd, args[1]))
      return { stdout: '', stderr: '' }
    }
    if (args[0] === 'pack') {
      const manifest = JSON.parse(await readFile(path.join(options.cwd, 'package.json'), 'utf8'))
      const destination = args[args.indexOf('--pack-destination') + 1]
      await mkdir(destination, { recursive: true })
      await writeFile(path.join(destination, `ds-headbot-${manifest.version}.tgz`), `packed:${manifest.version}`)
      return { stdout: '', stderr: '' }
    }
    if (args.includes('add')) {
      dshCalls.push(args)
      const packagePath = args.at(-1)
      const nextVersion = packagePath.endsWith('ds-headbot-0.2.7.tgz') ? '0.2.7' : '0.2.5'
      await writeFile(path.join(installedPackage, 'package.json'), JSON.stringify({ name: 'ds-headbot', version: nextVersion }))
      return { stdout: '', stderr: '' }
    }
    if (command === '/usr/bin/true') return { stdout: '', stderr: '' }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }
  const result = await performHeadbotUpdate({
    targetVersion: '0.2.7', tag: 'v0.2.7', parentHome, managerRoot, profile: 'web', dshCommand: 'dsh', pnpmCommand: 'pnpm',
    restart: { command: '/usr/bin/true', args: [] }, controllerPath: 'dsh', parentPort: 3080,
  }, {
    fetchImpl: async url => {
      fetchUrls.push(String(url))
      if (String(url) === 'http://127.0.0.1:3080/api/ds-headbot/v1/release') return { ok: false, status: 401 }
      return { ok: true, status: 200, async arrayBuffer() { return sourceBytes } }
    },
    runCommand,
  })
  assert.equal(result.state, 'completed')
  assert.equal(await readFile(path.join(installedPackage, 'package.json'), 'utf8').then(value => JSON.parse(value).version), '0.2.7')
  assert.ok(await readFile(result.rollbackPackage))
  assert.ok(fetchUrls.includes('http://127.0.0.1:3080/api/ds-headbot/v1/release'))
  assert.ok(!fetchUrls.includes('http://127.0.0.1:3080/dsh/api/ds-headbot/v1/release'))
  assert.ok(checkedSources.includes('index.js'))
  assert.ok(checkedSources.includes('lib/release-updater.js'))
  assert.equal(dshCalls.length, 1)
  assert.equal((await readFile(path.join(managerRoot, 'headbot-update-state.json'), 'utf8').then(JSON.parse)).state, 'completed')
})

test('release worker rejects invalid syntax in a nested module before installation', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'headbot-release-syntax-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const parentHome = path.join(root, 'dsh')
  const managerRoot = path.join(parentHome, 'headbot')
  const installedPackage = path.join(parentHome, 'profiles/web/node_modules/ds-headbot')
  const sourceRoot = path.join(root, 'archive-root')
  await mkdir(installedPackage, { recursive: true })
  await mkdir(path.join(sourceRoot, 'lib'), { recursive: true })
  await writeFile(path.join(installedPackage, 'package.json'), JSON.stringify({ name: 'ds-headbot', version: '0.2.7' }))
  await writeFile(path.join(sourceRoot, 'package.json'), JSON.stringify({ name: 'ds-headbot', version: '0.2.8', type: 'module' }))
  await writeFile(path.join(sourceRoot, 'index.js'), 'export {}\n')
  await writeFile(path.join(sourceRoot, 'lib/release-updater.js'), 'export const = ;\n')
  const sourceTar = path.join(root, 'source.tar.gz')
  execFileSync('/usr/bin/tar', ['-czf', sourceTar, '-C', root, 'archive-root'])
  const sourceBytes = await readFile(sourceTar)
  let installCalls = 0
  const runCommand = async (command, args, options = {}) => {
    if (command === '/usr/bin/tar') {
      return { stdout: execFileSync(command, args, { cwd: options.cwd }).toString(), stderr: '' }
    }
    if (args[0] === '--check') {
      try {
        const stdout = execFileSync(command, args, { cwd: options.cwd }).toString()
        return { stdout, stderr: '' }
      } catch (error) {
        throw new Error(error.stderr?.toString() || error.message)
      }
    }
    if (args.includes('add')) installCalls++
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }
  await assert.rejects(performHeadbotUpdate({
    targetVersion: '0.2.8', tag: 'v0.2.8', parentHome, managerRoot, profile: 'web', dshCommand: 'dsh', pnpmCommand: 'pnpm',
  }, {
    fetchImpl: async () => ({ ok: true, status: 200, async arrayBuffer() { return sourceBytes } }),
    runCommand,
  }), /Unexpected token|SyntaxError/)
  assert.equal(installCalls, 0)
  const state = JSON.parse(await readFile(path.join(managerRoot, 'headbot-update-state.json'), 'utf8'))
  assert.equal(state.state, 'failed')
  assert.equal(state.targetVersion, '0.2.8')
})

test('browser creation retains its form after event.currentTarget is cleared', async () => {
  const elements = new Map(), handlers = new Map()
  let resets = 0, submitted
  const element = () => ({style:{}, textContent:'', value:'', href:'', hidden:false, disabled:false, classList:{remove(){},toggle(){}}, addEventListener(){}, append(){}, replaceChildren(){}, querySelector(){return null}})
  const form = {...element(), elements:{port:{value:'31091'}}, reset(){resets++}, addEventListener(type, handler){handlers.set(type,handler)}}
  elements.set('#add-form', form)
  const document = {querySelector(id){if(!elements.has(id))elements.set(id,element());return elements.get(id)},createElement:element}
  const source = renderManagerPage().match(/<script>([\s\S]*?)<\/script>/)[1]
  runInNewContext(source, {
    document, setInterval(){},
    FormData:class {constructor(target){assert.equal(target,form)}get(key){return {id:'browser-test',name:'Browser Test',port:'31091'}[key]}},
    async fetch(_url, options){if(options.method==='POST')submitted=JSON.parse(options.body);return {status:200,ok:true,async json(){return {teams:[],events:[]}}}},
  })
  const event = {currentTarget:form,preventDefault(){}}
  const pending = handlers.get('submit')(event)
  event.currentTarget = null
  await pending
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(resets,1)
  assert.equal(form.elements.port.value,'3101')
  assert.equal(submitted.id,'browser-test')
  assert.equal(elements.get('#error').textContent,'')
})

test('browser highlights a newer Headbot release and starts the upgrade on click', async () => {
  const elements = new Map(), handlers = new Map()
  let upgradeRequests = 0
  let updateState = 'idle'
  function element(key = 'created') {
    const classes = new Set()
    return {
      key, style: {}, textContent: '', value: '', disabled: false, hidden: false, href: '', children: [],
      classList: { toggle(name, force) { if (force) classes.add(name); else classes.delete(name) }, remove(name) { classes.delete(name) }, contains(name) { return classes.has(name) } },
      addEventListener(type, handler) { handlers.set(`${key}:${type}`, handler) },
      append(...children) { this.children.push(...children) }, replaceChildren(...children) { this.children = [...children] },
      querySelector() { return null },
    }
  }
  const document = {
    querySelector(key) { if (!elements.has(key)) elements.set(key, element(key)); return elements.get(key) },
    createElement(tag) { return element(tag) },
  }
  const source = renderManagerPage({ version: '0.2.5' }).match(/<script>([\s\S]*?)<\/script>/)[1]
  runInNewContext(source, {
    document, setInterval() {}, confirm() { return true },
    FormData: class { constructor() {} get() { return '' } },
    async fetch(url, options = {}) {
      if (url.endsWith('/release/upgrade')) {
        upgradeRequests++
        updateState = 'downloading'
        return { status: 202, ok: true, async json() { return { state: updateState } } }
      }
      const data = url.includes('/release')
        ? { currentVersion: '0.2.5', latestVersion: '0.2.7', updateAvailable: true, releaseUrl: 'https://github.com/idaydayup2023/ds-headbot/releases/tag/v0.2.7', state: updateState, message: '' }
        : url.includes('/audit') ? { events: [], nextBefore: null } : { teams: [] }
      return { status: 200, ok: true, async json() { return data } }
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  const upgradeButton = elements.get('#upgrade-headbot')
  assert.equal(upgradeButton.disabled, false)
  assert.equal(upgradeButton.textContent, '升级到 v0.2.7')
  assert.equal(upgradeButton.classList.contains('update-ready'), true)

  await handlers.get('#upgrade-headbot:click')({ currentTarget: upgradeButton })
  assert.equal(upgradeRequests, 1)
  assert.equal(upgradeButton.disabled, true)
  assert.equal(upgradeButton.textContent, '正在升级…')
})
