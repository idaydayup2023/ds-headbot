import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { HeadbotManager } from '../lib/manager.js'
import { AuditedCommunications } from '../lib/communications.js'
import { apply as applyHeadbot } from '../index.js'
import { apply as applyTeam } from '../lib/team-plugin.js'
import { renderManagerPage } from '../lib/page.js'
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
  await writeFile(fake, `import http from 'node:http';import {readFileSync,realpathSync,existsSync} from 'node:fs';
const args=process.argv.slice(2);if(args[0]==='plugin')process.exit(0);
const value=key=>args[args.indexOf(key)+1];
if(!readFileSync(value('--patch'),'utf8').includes('team-plugin.js'))process.exit(2);
if(!process.env.HEADBOT_TEAM_TOKEN||process.cwd()!==realpathSync(process.env.HEADBOT_TEAM_FILES_ROOT))process.exit(3);
const readyAt=Date.now()+(existsSync(${JSON.stringify(path.join(root, 'transient-404'))})?800:0);
http.createServer((_req,res)=>{res.statusCode=Date.now()<readyAt?404:200;res.end('ok')}).listen(Number(value('--port')),'127.0.0.1');
console.log('dsh web: '+value('--public-url')+'?token=test-secret');`)
  const manager = new HeadbotManager({ dataDir: path.join(root, 'headbot'), dshHome: path.join(root, 'home'), dshCommand: fake, inheritModelSettings: false, ingressPort: await port() }, { parentPort: await port(), logger: quiet })
  t.after(() => manager.close())
  return { root, manager, fake }
}

async function add(manager, id) {
  return manager.createTeam({ id, name: id.toUpperCase(), port: await port(), autoStart: false })
}

test('runtime create/start/stop/restart/delete archives data and revokes identity', async t => {
  const { manager } = await fixture(t)
  await Promise.all([manager.listTeams(), manager.listTeams()])
  const first = await add(manager, 'alpha')
  const token = manager.findTeam('alpha').communicationToken
  assert.equal((await manager.authenticateTeam('Bearer ' + token)).instanceId, first.instanceId)
  assert.equal(JSON.stringify(first).includes(token), false)
  await assert.rejects(manager.updateTeam('alpha', { port: await port(), name: '' }), { statusCode: 400 })
  assert.equal((await manager.getTeam('alpha')).port, first.port)
  await manager.startTeam('alpha')
  const running = await manager.getTeam('alpha')
  assert.equal(running.status, 'running', running.message)
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

test('manager page exposes deletion and audit controls with valid script syntax', () => {
  const html = renderManagerPage({ publicHost: 'localhost', controllerPath: 'dsh' })
  assert.match(html, /删除实例/)
  assert.match(html, /团队通信审计/)
  assert.match(html, /导出完整审计档案/)
  // Compile the browser program without executing DOM effects.
  new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1])
})

test('browser creation retains its form after event.currentTarget is cleared', async () => {
  const elements = new Map(), handlers = new Map()
  let resets = 0, submitted
  const element = () => ({style:{}, textContent:'', value:'', addEventListener(){}, append(){}, replaceChildren(){}, querySelector(){return null}})
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
  assert.equal(resets,1)
  assert.equal(form.elements.port.value,'3101')
  assert.equal(submitted.id,'browser-test')
  assert.equal(elements.get('#error').textContent,'')
})
