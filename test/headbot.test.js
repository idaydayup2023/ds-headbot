import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { HeadbotManager } from '../lib/manager.js'
import { AuditedCommunications } from '../lib/communications.js'
import { apply as applyHeadbot, handleApiRequest, version as headbotVersion } from '../index.js'
import { apply as applyTeam } from '../lib/team-plugin.js'
import { renderManagerPage } from '../lib/page.js'
import { HeadbotReleaseUpdater, compareVersions, performHeadbotUpdate } from '../lib/release-updater.js'
import { HeadbotRuntimeUpdater } from '../lib/runtime-updater.js'
import { startIngress } from '../lib/ingress.js'
import { runInNewContext } from 'node:vm'
import { add, fixture, online, port, quiet } from './helpers.js'

const apiPath = '/api/ds-headbot/v1'

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
    for (const attr of ['HttpOnly', 'SameSite=Strict']) assert.ok(attributes.includes(attr))
    assert.ok(!attributes.includes('Secure'))
  }
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
  }, { dataDir, dshHome: path.join(root, 'http-home'), dshCommand: fake, inheritModelSettings: false, ingressPort: await port(), communicationLimits: { textBytes: 128, attachmentBytes: 1024, transferBytes: 2048 },
    // BURST-PACING-001 ⑥: 本案断言"发送即留 push 审计行"的次序形制，与压入节奏正交——config 显式关节奏。
    inboxPushPaceMs: 0 })
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
  // Reachability rule (INBOX-PUSH-001): an offline team is answered "not online" without
  // queueing, so Beta has to genuinely run for the file exchange below to deliver.
  await fetch(`${base}/teams/beta/start`, { method: 'POST', headers: admin })
  let betaStatus
  for (let i = 0; i < 200; i++) {
    const listed = await fetch(base + '/teams', { headers: admin }).then(response => response.json())
    betaStatus = listed.teams.find(team => team.id === 'beta')?.status
    if (betaStatus === 'running') break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(betaStatus, 'running')
  // The protected controller joins every roster as the default participant.
  assert.deepEqual((await alpha.call('headbot_list_teams')).teams.map(team => team.id), ['default', 'beta'])
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
  // The real pusher is wired in applyHeadbot: Beta has no lead session seeded, so each delivered
  // message is followed by its push-skipped(no-session) marker — delivery semantics unaffected.
  assert.deepEqual(exported.events.map(event => event.type), ['message.sent', 'message.push-skipped', 'message.sent', 'message.push-skipped', 'messages.received', 'attachment.received', 'attachment.reviewed'])
  const deletion = await fetch(base + '/teams/beta', { method: 'DELETE', headers: admin })
  assert.equal(deletion.status, 200)
  assert.equal((await fetch(base + '/comms/v1/inbox', { headers: { Authorization: 'Bearer ' + b.communicationToken } })).status, 401)
})

test('manager page shows the version updater and places teams before team creation', () => {
  const html = renderManagerPage({ publicHost: 'localhost', controllerPath: 'dsh', version: '0.2.5' })
  assert.match(html, /创建团队/)
  assert.doesNotMatch(html, /添加团队副本/)
  assert.match(html, /label:'升级中'/)
  assert.match(html, /label:'升级到 v'\+\(dsBotLatest/)
  assert.match(html, /安装版本：v0\.2\.5/)
  assert.match(html, /id="headbot-version"/)
  assert.match(html, /id="upgrade-headbot-slot"/)
  assert.match(html, /button\.update-ready/)
  assert.ok(html.indexOf('<h2>团队实例</h2>') < html.indexOf('id="add-form"'))
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

test('manager page renders the teams card before the model catalog card (CARD-ORDER-001)', () => {
  const html = renderManagerPage({ publicHost: 'localhost', controllerPath: 'dsh', version: '0.4.26' })
  const teamsAt = html.indexOf('<h2>团队实例</h2>')
  const catalogAt = html.indexOf('<h2>模型目录</h2>')
  assert.ok(teamsAt > -1, '团队实例 heading exists')
  assert.ok(catalogAt > -1, '模型目录 heading exists')
  assert.ok(teamsAt < catalogAt, '团队实例 card must render before 模型目录 card')
  assert.equal((html.match(/<h2>团队实例<\/h2>/g) || []).length, 1, 'exactly one 团队实例 heading')
  assert.equal((html.match(/<h2>模型目录<\/h2>/g) || []).length, 1, 'exactly one 模型目录 heading')
  // Whole-section swap only: both card interiors and their anchors stay intact, in card order.
  for (const anchor of ['id="add-form"', 'id="teams"', 'id="model-catalog-card"', 'id="add-model"', 'id="model-list"']) {
    assert.ok(html.includes(anchor), `${anchor} must remain present`)
  }
  assert.ok(html.indexOf('id="add-form"') < catalogAt, 'teams form belongs to the teams card (before catalog)')
  assert.ok(html.indexOf('id="add-model"') > catalogAt, 'add-model belongs to the catalog card (after its heading)')
})

test('release updater detects newer stable versions and launches a detached update worker', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'headbot-release-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageManifest = JSON.parse(await readFile(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'))
  assert.equal(headbotVersion, packageManifest.version)
  assert.match(headbotVersion, /^\d+\.\d+\.\d+$/, 'headbotVersion must be a stable semver')
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

test('headbot install is reachable only through POST /release/upgrade and nothing schedules it (NO-AUTO-UPGRADE-001)', async t => {
  const indexSource = await readFile(path.join(import.meta.dirname, '..', 'index.js'), 'utf8')
  const updaterSource = await readFile(path.join(import.meta.dirname, '..', 'lib', 'release-updater.js'), 'utf8')
  // The POST route is the single caller of the upgrade entry point.
  assert.match(indexSource, /method === 'POST' && route === '\/release\/upgrade'[\s\S]{0,220}releaseUpdater\.startUpgrade\(\)/,
    'POST /release/upgrade is wired to startUpgrade')
  assert.equal((indexSource.match(/releaseUpdater\.startUpgrade\(/g) || []).length, 1,
    'startUpgrade has exactly one caller: the POST /release/upgrade route')
  // Install runs only inside the detached worker; the worker is spawned only from startUpgrade.
  assert.equal((updaterSource.match(/this\.spawnImpl\(/g) || []).length, 1, 'one spawn site in the updater — the worker launch inside startUpgrade')
  assert.equal((updaterSource.match(/\[WORKER_PATH,/g) || []).length, 1, 'the worker entry is launched from that site only')
  assert.match(updaterSource, /if \(process\.argv\[1\] && path\.resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)\)/,
    'performHeadbotUpdate is gated behind the worker main entry (only a spawn on itself runs it)')
  // Nothing schedules an upgrade: no timers anywhere in the updater.
  assert.equal((updaterSource.match(/setInterval\(/g) || []).length, 0, 'the updater arms no interval timers')
  assert.equal((indexSource.match(/releaseUpdater\.startUpgrade/g) || []).length, 1)
  // Behavioural leg: a fully successful check with a newer version on the shelf launches nothing.
  const root = await mkdtemp(path.join(tmpdir(), 'headbot-noauto-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let spawns = 0
  const updater = new HeadbotReleaseUpdater({
    currentVersion: '0.2.5',
    manager: { root: path.join(root, 'headbot'), parentHome: path.join(root, 'dsh'), dshCommand: 'dsh', parentPort: 3080, controllerPath: 'dsh' },
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { tag_name: 'v0.9.9', draft: false, prerelease: false } } }),
    spawnImpl() { spawns += 1; return { once() { return this }, unref() {} } },
  })
  const status = await updater.check({ force: true })
  assert.equal(status.updateAvailable, true, 'an upgrade is available yet untouched')
  await new Promise(resolve => setTimeout(resolve, 25)) // let any stray timer tick
  assert.equal(spawns, 0, 'no available-release check, cache refresh, or wait period ever installs on its own')
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
    document, window:{location:{origin:'https://localhost'}}, setInterval(){},
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

// UI-004: mock elements seed disabled/hidden from the REAL initial HTML markup — a button that
// ships `disabled` stays grey until the page script explicitly lifts it, and the click helper
// short-circuits on disabled exactly like a real browser. Without this seeding the 0.4.16
// "confirm button grey forever" bug was invisible to the cannon.
function htmlSeed(key) {
  const tag = new RegExp(`<(?:button|input)[^>]*id="${key.replace(/^#/, '')}"[^>]*>`).exec(renderManagerPage())
  return { disabled: Boolean(tag) && /\sdisabled\b/.test(tag[0]), hidden: Boolean(tag) && /\shidden\b/.test(tag[0]) }
}

// UI-008（用户 2026-11-15 严格卡面令）：卡面除「安装版本：xxxxx」+按钮外零动态文字输出——
// checkError/闸门理由/请求失败话术一律不落卡，只进审计与 API 数据面。断言口径：mock DOM 里
// （含动态创建的 children）任何节点的可见文本都不得含注入话术；版本行白名单不受影响。
function collectDomText(elements) {
  const seen = []
  const walk = node => {
    if (!node || typeof node !== 'object') return
    seen.push(String(node.textContent ?? ''))
    for (const child of node.children ?? []) walk(child)
  }
  for (const el of elements.values()) walk(el)
  return seen.join('\n')
}
function assertNoCardProse(elements, needles, label) {
  const blob = collectDomText(elements)
  for (const needle of needles) assert.ok(!blob.includes(needle), `${label}：「${needle}」不得出现在卡面任何节点`)
}

test('browser highlights a newer Headbot release and starts the upgrade on click', async () => {
  const elements = new Map(), handlers = new Map()
  let upgradeRequests = 0
  let updateState = 'idle'
  function element(key = 'created') {
    const classes = new Set()
    return {
      key, style: {}, textContent: '', value: '', ...htmlSeed(key), href: '', children: [],
      classList: { toggle(name, force) { if (force) classes.add(name); else classes.delete(name) }, remove(name) { classes.delete(name) }, contains(name) { return classes.has(name) } },
      addEventListener(type, handler) { handlers.set(`${this.id||key}:${type}`, handler) },
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
    document, window:{location:{origin:'https://localhost'}}, setInterval() {}, confirm() { return true },
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
  const slot = elements.get('#upgrade-headbot-slot')
  const upgradeButton = () => slot.children.find(child => child.id === 'upgrade-headbot')
  assert.ok(upgradeButton(), 'a newer release must render the button node')
  assert.equal(upgradeButton().disabled, false)
  assert.equal(upgradeButton().textContent, '升级到 v0.2.7')
  assert.equal(upgradeButton().classList.contains('update-ready'), true)

  const click = async id => { const btn = upgradeButton(); if (!btn || btn.disabled) return false; const h = handlers.get(`${id}:click`); if (!h) return false; await h({}); return true }
  // UI-006 one-step: the button press itself executes the upgrade — no confirm dialog exists any more.
  assert.equal(await click('upgrade-headbot'), true, 'the enabled button must accept the press')
  assert.equal(upgradeRequests, 1, 'the press itself is the execution (UI-006 one-step)')
  assert.equal(upgradeButton().disabled, true)
  assert.equal(upgradeButton().textContent, '升级中')
})

test('browser keeps DSH upgrade visible while the service restarts and reports completion', async () => {
  const elements = new Map(), handlers = new Map(), timers = new Map()
  let nextTimerId = 0, pollPromise, updateState = 'idle', restartReadThrew = false
  function element(key = 'created') {
    const classes = new Set()
    return {
      key, style: {}, textContent: '', value: '', ...htmlSeed(key), href: '', children: [],
      classList: { toggle(name, force) { if (force) classes.add(name); else classes.delete(name) }, remove(name) { classes.delete(name) }, contains(name) { return classes.has(name) } },
      addEventListener(type, handler) { handlers.set(`${this.id||key}:${type}`, handler) },
      append(...children) { this.children.push(...children) }, replaceChildren(...children) { this.children = [...children] },
      querySelector() { return null },
    }
  }
  const document = {
    querySelector(key) { if (!elements.has(key)) elements.set(key, element(key)); return elements.get(key) },
    createElement(tag) { return element(tag) },
  }
  const source = renderManagerPage().match(/<script>([\s\S]*?)<\/script>/)[1]
  runInNewContext(source, {
    document, window:{location:{origin:'http://localhost'}}, setInterval() {}, confirm() { return true },
    setTimeout(callback, delay) { const id=++nextTimerId;timers.set(id,{callback,delay});return id },
    clearTimeout(id) { timers.delete(id) },
    FormData: class { constructor() {} get() { return '' } },
    async fetch(url) {
      if (url.endsWith('/runtime-versions/dsh/upgrade')) {
        updateState = 'installing'
        return { status:202, ok:true, async json() { return { state:updateState } } }
      }
      if (url.includes('/runtime-versions')) {
        // Deterministic cut: the very first read after the service enters 'restarting' dies
        // mid-flight — no dependence on how many reads the dialog flow made beforehand.
        if (updateState === 'restarting' && !restartReadThrew) { restartReadThrew = true; throw new Error('connection reset during DSH restart') }
        const dsh = updateState === 'completed'
          ? { currentVersion:'0.2.1-rc.3', latestVersion:'0.2.1-rc.3', updateAvailable:false, canUpdate:true, state:updateState, message:'已升级到 0.2.1-rc.3' }
          : { currentVersion:'0.2.1-rc.2', latestVersion:'0.2.1-rc.3', updateAvailable:updateState==='idle', canUpdate:true, state:updateState, message:'正在安装 DSH 更新' }
        return { status:200, ok:true, async json() { return { dsh, dsBot:{ instances:[], latestVersion:'0.1.7', updateAvailable:false } } } }
      }
      const data = url.includes('/release')
        ? { currentVersion:'0.4.2', latestVersion:'0.4.2', updateAvailable:false, state:'idle' }
        : url.includes('/audit') ? { events:[], nextBefore:null }
        : url.includes('/models') ? { models:[] }
        : { teams:[] }
      return { status:200, ok:true, async json() { return data } }
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  const dshSlot = elements.get('#upgrade-dsh-slot')
  const dshButton = () => dshSlot.children.find(child => child.id === 'upgrade-dsh')
  const click = async id => { const btn = dshButton(); if (!btn || btn.disabled) return false; const h = handlers.get(`${id}:click`); if (!h) return false; await h({}); return true }
  assert.ok(dshButton(), 'an available DSH update must render the button node')
  assert.equal(dshButton().disabled, false)
  // UI-006 one-step: pressing 升级到 v0.2.1-rc.3 executes directly (no dialog leg any more).
  await click('upgrade-dsh')
  assert.equal(dshButton().textContent, '升级中')
  assert.ok([...timers.values()].some(timer => timer.delay === 2500), 'busy state schedules a quick status poll')

  updateState = 'restarting'
  const poll = [...timers.entries()].find(([,timer]) => timer.delay === 2500)
  timers.delete(poll[0])
  pollPromise = poll[1].callback()
  await new Promise(resolve => setImmediate(resolve))
  await pollPromise
  assertNoCardProse(elements, ['DSH 正在重启', '正在安装', 'connection reset', '版本检查失败'], 'UI-008：重启窗口期卡面零话术（busy 只由按钮表达）')
  assert.equal(dshButton().disabled, true, 'while restarting the button must stay rendered as 升级中')

  updateState = 'completed'
  const retry = [...timers.entries()].find(([,timer]) => timer.delay === 2500)
  assert.ok(retry, 'a dropped connection schedules a reconnect poll')
  timers.delete(retry[0])
  pollPromise = retry[1].callback()
  await new Promise(resolve => setImmediate(resolve))
  await pollPromise
  assert.equal(elements.get('#dsh-version').textContent, '安装版本：v0.2.1-rc.3')
  assertNoCardProse(elements, ['已升级到', '正在安装', 'connection reset'], 'UI-008：成功相与断线窗口卡面零话术')
  // UI-006 ③: success removes the node entirely — 不是 hidden，DOM 无节点.
  assert.equal(dshButton(), undefined, '升级成功后按钮节点必须从 DOM 移除')
})

// UI-006 (2026-11-15 用户令)：卡面只留组件名+「安装版本：xxxx」一行+升级钮；组件名五枚逐字；
// 升级钮全生命周期——无新版 DOM 无节点（hidden 初值即 true，脚本必须显式放行才现形，UI-004
// 同款教训由 htmlSeed 真值播种兜住）、有新版带目标版本号、升级中文案换「升级中」、成功后消失。
// 前端二次确认腿（UI-002/004 的二段弹框、ack 勾选、逐字粘 commit）全撤。
test('UI-006: card faces carry only the canonical name and one install-version line', () => {
  const html = renderManagerPage({ version: '0.4.15' })
  // ① 五枚组件名一字不差（含曾经的旧写法必须绝迹）
  for (const name of ['DS HeadBot', 'DS Bot', 'DeepSeek Harness', 'LiteLLM', 'SparkDash'])
    assert.ok(html.includes(`<h2>${name}</h2>`), `card title must be exactly ${name}`)
  for (const gone of ['DeepSeek Harness (DSH)', 'LiteLLM 推理网关', 'sparkDash 前端', 'sparkDash 本地'])
    assert.ok(!html.includes(gone), `${gone} must be gone from the card face`)
  // 卡面五行版本行=安装版本（只数渲染出的 span 文本，脚本串里的字面量不计）；旧的当前/最新双行绝迹
  assert.equal((html.match(/<span[^>]*>安装版本：/g) || []).length, 5, 'exactly five install-version lines, one per card')
  for (const gone of ['当前版本：', '最新版本：', '本地 commit：', '上游 HEAD：',
    'id="headbot-confirm"', 'id="dsh-confirm"', 'id="dsbot-confirm"', 'id="litellm-confirm"', 'id="sparkdash-confirm"',
    'id="litellm-ack"', 'id="sparkdash-ack"', 'id="sparkdash-confirm-input"', 'id="headbot-confirm-upgrade"', 'id="dsh-confirm-upgrade"', 'id="dsbot-confirm-upgrade"', 'id="litellm-confirm-upgrade"', 'id="sparkdash-confirm-upgrade"',
    'id="headbot-release-link"', 'id="dsh-release-link"', 'id="litellm-release-link"', 'id="sparkdash-commit-link"',
    'id="litellm-audit-details"', 'id="sparkdash-audit-details"'])
    assert.ok(!html.includes(gone), `${gone} must be retired with the confirm dialogs`)
  // ③ 两枚「打开」按钮（用户给定 URL 字面）
  assert.match(html, /id="litellm-open"[^>]*href="http:\/\/192\.168\.1\.5:8888\/ui"/)
  assert.match(html, /id="sparkdash-open"[^>]*href="http:\/\/192\.168\.1\.5:5555"/)
  // UI-007②：卡面压成一行——组件名 + 安装版本 + 按钮，同一 cardline 三元素。
  // UI-008（2026-11-15 严格卡面）：cardline 之外什么都不留——五枚 block 行与 BALANCE-001
  // pending 行整体撤出卡面，section 里只允许 cardline 一个容器（script/注释外零节点）。
  const bareHtml = html.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '')
  for (const [id, name] of [['headbot', 'DS HeadBot'], ['dsbot', 'DS Bot'], ['dsh', 'DeepSeek Harness'], ['litellm', 'LiteLLM'], ['sparkdash', 'SparkDash']]) {
    assert.match(bareHtml, new RegExp(`<section class="card version-card" id="${id}-version-card">\\s*<div class="cardline"><h2>${name}</h2><p class="small version-values"><span id="${id}-version">安装版本：[\\s\\S]*?<div class="actions">[\\s\\S]*?</div></div>\\s*</section>`), `${name} 卡面必须只有单行三元素（名+安装版本+按钮）`)
    assert.ok(!bareHtml.includes(`id="${id}-block"`), `${name} 的 block 行必须整体绝迹（UI-008：检查错误/闸门理由只进 API 面）`)
  }
  assert.ok(!bareHtml.includes('litellm-patch-pending'), 'BALANCE-001 pending 提示行必须撤出卡面（md5Declared 读数只留 gate.details API 面）')
  // UI-007①：state.message 类执行结果/进度话术绝不上卡面（busy 只有按钮文字「升级中」表达）
  for (const gone of ['已升级到', '正在安装', '正在逐个更新', '正在下载并安装', '正在准备升级', '升级进行中', '升级后 DSH', '安装完成，请重启', '上次升级失败', '上次升级未完成', 'DSH 正在重启', '批量更新中断', '所有实例的 DS Bot 已更新', '正在按实况单升级', '升级中…', '主 DSH 实例最后更新'])
    assert.ok(!html.includes(gone), `${gone} — state.message/status prose must never reach the card face`)
  // ④ 卡面 HTML 无静态升级钮——无新版=DOM 无节点（不是 hidden），钮只由脚本按 status 生灭
  for (const id of ['upgrade-headbot', 'upgrade-dsh', 'update-all', 'upgrade-litellm', 'upgrade-sparkdash']) {
    assert.ok(html.includes(`id="${id}-slot"`), `#${id}-slot must exist as the render anchor`)
    assert.ok(!html.includes(`<button id="${id}"`), `#${id} must not ship as a static node (无新版即无节点)`)
  }
  new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1])
})

test('UI-006: the upgrade button renders only while an update exists, labels the target, reads 升级中 while busy and vanishes after success', async () => {
  // 每个相位跑一遍独立页面实例：按钮节点必须完全由 status 驱动生灭（卡面 HTML 无静态钮，
  // 渲染逻辑写错则节点永不存在或永不消失，UI-004 同族坑由「节点在否」断言直接兜住）。
  const phases = {
    latest: { currentVersion: '1.106.2', latestVersion: '1.106.2', updateAvailable: false, canUpgrade: false, state: 'idle', gate: { passed: true, reasons: [], details: [] } },
    available: { currentVersion: '1.106.2', latestVersion: '1.109.1', updateAvailable: true, canUpgrade: true, state: 'idle', gate: { passed: true, reasons: [], details: [] } },
    busy: { currentVersion: '1.106.2', latestVersion: '1.109.1', updateAvailable: true, canUpgrade: false, state: 'installing', message: '正在安装', gate: { passed: true, reasons: [], details: [] } },
    success: { currentVersion: '1.109.1', latestVersion: '1.109.1', updateAvailable: false, canUpgrade: false, state: 'completed', message: '已升级到 LiteLLM 1.109.1', gate: { passed: true, reasons: [], details: [] } },
  }
  const source = renderManagerPage({ version: '0.4.19' }).match(/<script>([\s\S]*?)<\/script>/)[1]
  const observed = {}
  for (const [phase, litellm] of Object.entries(phases)) {
    const elements = new Map(), handlers = new Map()
    function element(key = 'created') {
      const classes = new Set()
      return {
        key, style: {}, textContent: '', value: '', ...htmlSeed(key), href: '', children: [],
        classList: { toggle(name, force) { if (force) classes.add(name); else classes.delete(name) }, remove(name) { classes.delete(name) }, contains(name) { return classes.has(name) } },
        addEventListener(type, handler) { handlers.set(`${this.id||key}:${type}`, handler) },
        append(...children) { this.children.push(...children) }, replaceChildren(...children) { this.children = [...children] },
        querySelector() { return null },
      }
    }
    const document = {
      querySelector(key) { if (!elements.has(key)) elements.set(key, element(key)); return elements.get(key) },
      createElement(tag) { return element(tag) },
    }
    runInNewContext(source, {
      document, window: { location: { origin: 'https://localhost' } }, setInterval() {}, setTimeout() { return 0 }, clearTimeout() {},
      FormData: class { constructor() {} get() { return '' } },
      async fetch(url) {
        let data = { teams: [] }
        if (url.includes('/litellm')) data = litellm
        else if (url.includes('/release')) data = { currentVersion: '0.4.19', latestVersion: '0.4.19', updateAvailable: false, state: 'idle' }
        else if (url.includes('/runtime-versions')) data = { dsh: { currentVersion: '0.2.2-rc.3', latestVersion: '0.2.2-rc.3', updateAvailable: false, canUpdate: true, state: 'idle' }, dsBot: { instances: [], latestVersion: '0.1.7', updateAvailable: false } }
        else if (url.includes('/models')) data = { models: [] }
        else if (url.includes('/audit')) data = { events: [] }
        return { status: 200, ok: true, async json() { return data } }
      },
    })
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    observed[phase] = { button: elements.get('#upgrade-litellm-slot').children.find(child => child.id === 'upgrade-litellm') || null, version: elements.get('#litellm-version'), elements }
  }
  // ① 无新版 → 按钮不渲染（DOM 无节点）；安装版本行如实
  assert.equal(observed.latest.version.textContent, '安装版本：1.106.2')
  assert.equal(observed.latest.button, null, 'no newer version → no button node in the DOM')
  // ② 有新版 → 渲染+带目标版本号+可点
  assert.ok(observed.available.button, 'a newer version must render the button node')
  assert.equal(observed.available.button.textContent, '升级到 1.109.1', 'the label must carry the target version')
  assert.equal(observed.available.button.disabled, false)
  assert.equal(observed.available.button.classList.contains('update-ready'), true)
  // ③ 升级中 → 「升级中」+禁点防重提+仍渲染；UI-007① busy 不另加状态行
  assert.ok(observed.busy.button, 'busy keeps the node rendered')
  assert.equal(observed.busy.button.textContent, '升级中')
  assert.equal(observed.busy.button.disabled, true)
  // UI-008：busy 相 state.message「正在安装」零出现（block 行已整体绝迹，卡面只余按钮+版本行）
  assertNoCardProse(observed.busy.elements, ['正在安装', 'state.message'], 'UI-008：busy 相卡面零话术')
  // ④ 成功 → 按钮节点从 DOM 移除，版本行翻到新装版，且「已升级到…」话术不上卡面
  assert.equal(observed.success.version.textContent, '安装版本：1.109.1')
  assert.equal(observed.success.button, null, 'after success the button node must be removed from the DOM')
  // UI-008：成功相「已升级到」话术零出现
  assertNoCardProse(observed.success.elements, ['已升级到'], 'UI-008：成功相卡面零话术')
})

// UI-006 边界 + UI-008 严格卡面：前端废确认 ≠ 后端放松。blocked 态按钮仍渲染且恒可点、按下必达
// 后端；闸门理由由 API 返回（409 error 体），但卡面一个字的理由都不落——只进 console/API 数据面。
test('UI-006/UI-008: a blocked upgrade stays clickable, the backend keeps the gate, and the reason stays off the card', async () => {
  const elements = new Map(), handlers = new Map()
  function element(key = 'created') {
    const classes = new Set()
    return {
      key, style: {}, textContent: '', value: '', checked: false, ...htmlSeed(key), href: '', children: [], open: false,
      classList: { toggle(name, force) { if (force) classes.add(name); else classes.delete(name) }, remove(name) { classes.delete(name) }, contains(name) { return classes.has(name) } },
      addEventListener(type, handler) { handlers.set(`${this.id||key}:${type}`, handler) },
      append(...children) { this.children.push(...children) }, replaceChildren(...children) { this.children = [...children] },
      querySelector() { return null },
    }
  }
  const document = {
    querySelector(key) { if (!elements.has(key)) elements.set(key, element(key)); return elements.get(key) },
    createElement(tag) { return element(tag) },
  }
  let gatePassed = false
  const litellmStatus = () => gatePassed
    ? { currentVersion: '1.106.2', latestVersion: '1.109.1', updateAvailable: true, canUpgrade: true, state: 'idle', gate: { passed: true, reasons: [], details: [{ target: '/venv/litellm/proxy/x.py', ok: true, md5Declared: false }] } }
    : { currentVersion: '1.106.2', latestVersion: '1.109.1', updateAvailable: true, canUpgrade: false, state: 'idle', gate: { passed: false, blockedBy: 'missing-archive', reasons: ['补丁基线档案缺失（manifest.json）：升级已阻断，请先由补丁维护方建档后重试'] } }
  let upgradePosts = 0, lastBody = null
  const source = renderManagerPage({ version: '0.4.19' }).match(/<script>([\s\S]*?)<\/script>/)[1]
  runInNewContext(source, {
    document, window: { location: { origin: 'https://localhost' } }, setInterval() {}, setTimeout() { return 0 }, clearTimeout() {},
    FormData: class { constructor() {} get() { return '' } },
    async fetch(url, options = {}) {
      let data = { teams: [] }
      if (url.includes('/litellm/upgrade')) { upgradePosts++; lastBody = JSON.parse(options.body || '{}'); return { status: 409, ok: false, async json() { return { error: '升级闸门未通过，升级已阻断：补丁基线档案缺失（manifest.json）' } } } }
      else if (url.includes('/litellm/audit')) data = { items: [], progress: '' }
      else if (url.includes('/litellm')) data = litellmStatus()
      else if (url.includes('/release')) data = { currentVersion: '0.4.19', latestVersion: '0.4.19', updateAvailable: false, state: 'idle' }
      else if (url.includes('/runtime-versions')) data = { dsh: { currentVersion: '0.2.2-rc.3', latestVersion: '0.2.2-rc.3', updateAvailable: false, canUpdate: true, state: 'idle' }, dsBot: { instances: [], latestVersion: '0.1.7', updateAvailable: false } }
      else if (url.includes('/models')) data = { models: [] }
      else if (url.includes('/audit')) data = { events: [] }
      if (url.includes('/litellm/upgrade')) return { status: 409, ok: false, async json() { return { error: '升级闸门未通过，升级已阻断：补丁基线档案缺失（manifest.json）' } } }
      return { status: 200, ok: true, async json() { return data } }
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  const click = async id => { const btn = litellmBtn(); if (!btn || btn.disabled) return false; const h = handlers.get(`${id}:click`); if (!h) return false; await h({}); return true }
  const litellmSlot = elements.get('#upgrade-litellm-slot')
  const litellmBtn = () => litellmSlot.children.find(child => child.id === 'upgrade-litellm')
  assert.ok(litellmBtn(), 'blocked still renders the button node (可点且告知)')
  assert.equal(litellmBtn().disabled, false, 'blocked must NOT grey the button out')
  await click('upgrade-litellm')
  assert.equal(upgradePosts, 1, 'one-step: the press reaches the backend, which owns the gate')
  assert.equal(litellmBtn().disabled, false, 'after the 409 the button must stay clickable (恒可点重试)')
  assertNoCardProse(elements, ['补丁基线档案缺失', '升级闸门未通过', '版本检查失败', 'manifest'], 'UI-008：闸门理由只留 API 面，卡面 409 后依旧静默')
  // 一步腿自证：ack 由页面代填（用户按下即授权），目标版本随体上送
  assert.equal(lastBody.acknowledgeOutage, true)
  assert.equal(lastBody.targetVersion, '1.109.1')
  // gate 转绿（模型调度填齐 manifest 后）：BALANCE-001 pending 行如实（md5Declared=false 触发）
  gatePassed = true
  const greenElements = new Map(), greenHandlers = new Map()
  function greenElement(key = 'created') {
    const classes = new Set()
    return {
      key, style: {}, textContent: '', value: '', checked: false, ...htmlSeed(key), href: '', children: [], open: false,
      classList: { toggle(name, force) { if (force) classes.add(name); else classes.delete(name) }, remove(name) { classes.delete(name) }, contains(name) { return classes.has(name) } },
      addEventListener(type, handler) { handlers.set(`${this.id||key}:${type}`, handler) },
      append(...children) { this.children.push(...children) }, replaceChildren(...children) { this.children = [...children] },
      querySelector() { return null },
    }
  }
  const greenDocument = {
    querySelector(key) { if (!greenElements.has(key)) greenElements.set(key, greenElement(key)); return greenElements.get(key) },
    createElement(tag) { return greenElement(tag) },
  }
  runInNewContext(source, {
    document: greenDocument, window: { location: { origin: 'https://localhost' } }, setInterval() {}, setTimeout() { return 0 }, clearTimeout() {},
    FormData: class { constructor() {} get() { return '' } },
    async fetch(url) {
      let data = { teams: [] }
      if (url.includes('/litellm')) data = litellmStatus()
      else if (url.includes('/release')) data = { currentVersion: '0.4.19', latestVersion: '0.4.19', updateAvailable: false, state: 'idle' }
      else if (url.includes('/runtime-versions')) data = { dsh: { currentVersion: '0.2.2-rc.3', latestVersion: '0.2.2-rc.3', updateAvailable: false, canUpdate: true, state: 'idle' }, dsBot: { instances: [], latestVersion: '0.1.7', updateAvailable: false } }
      else if (url.includes('/models')) data = { models: [] }
      else if (url.includes('/audit')) data = { events: [] }
      return { status: 200, ok: true, async json() { return data } }
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  // UI-008：gate 转绿后 md5Declared=false 的 BALANCE-001 候窗读数只留 API 数据面——
  // 卡面零 pending 话术；API 面字段仍在（巡检靠它），绝不造假。
  assertNoCardProse(greenElements, ['补丁尚未实装', 'BALANCE-001', '未含补丁', '三连闸'], 'UI-008：pending 提示撤出卡面')
  const greenApi = litellmStatus()
  assert.equal(greenApi.gate.details[0].md5Declared, false, 'md5Declared 候窗读数必须仍在 API 面供巡检')
  assert.equal(greenApi.gate.passed, true)
})

// UI-008（用户 2026-11-15 原令实物案）：用户活体抓到的正是这枚——LiteLLM 卡渲染
// 「版本检查失败：GitHub API 限流，请稍后手动刷新或配置 LITELLM_UPGRADE_GITHUB_TOKEN。」
// 新令：检查失败时卡面安静停着——五卡全部喂限流样 checkError/上游错/请求异常，卡面零出现；
// 白名单「安装版本：xxxxx」行与按钮不受影响。
test('UI-008: injected rate-limit check errors never reach the card face — the cards sit silent', async () => {
  const elements = new Map(), handlers = new Map()
  function element(key = 'created') {
    const classes = new Set()
    return {
      key, style: {}, textContent: '', value: '', checked: false, ...htmlSeed(key), href: '', children: [], open: false,
      classList: { toggle(name, force) { if (force) classes.add(name); else classes.delete(name) }, remove(name) { classes.delete(name) }, contains(name) { return classes.has(name) } },
      addEventListener(type, handler) { handlers.set(`${this.id||key}:${type}`, handler) },
      append(...children) { this.children.push(...children) }, replaceChildren(...children) { this.children = [...children] },
      querySelector() { return null },
    }
  }
  const document = {
    querySelector(key) { if (!elements.has(key)) elements.set(key, element(key)); return elements.get(key) },
    createElement(tag) { return element(tag) },
  }
  const RATE_COPY = 'GitHub API 限流，请稍后手动刷新或配置 LITELLM_UPGRADE_GITHUB_TOKEN'
  const source = renderManagerPage({ version: '0.4.22' }).match(/<script>([\s\S]*?)<\/script>/)[1]
  runInNewContext(source, {
    document, window: { location: { origin: 'https://localhost' } }, setInterval() {}, setTimeout() { return 0 }, clearTimeout() {},
    FormData: class { constructor() {} get() { return '' } },
    async fetch(url) {
      if (url.includes('/litellm')) return { status: 200, ok: true, async json() { return { currentVersion: '1.109.1', currentError: null, latestVersion: null, updateAvailable: false, state: 'idle', checkError: RATE_COPY, gate: { passed: true, reasons: [], details: [] }, canUpgrade: false } } }
      if (url.includes('/release')) return { status: 200, ok: true, async json() { return { currentVersion: '0.4.22', latestVersion: null, updateAvailable: false, state: 'completed', checkError: 'GitHub release check returned HTTP 403（限流）' } } }
      if (url.includes('/runtime-versions')) return { status: 200, ok: true, async json() { return { dsh: { currentVersion: '0.2.2-rc.3', latestVersion: null, updateAvailable: false, canUpdate: true, state: 'idle', checkError: 'GitHub releases returned HTTP 403 限流' }, dsBot: { latestVersion: null, instances: [{ id: 'default', name: '保障组', currentVersion: '0.3.6', status: 'running' }], updateAvailable: false, checkError: RATE_COPY } } } }
      if (url.includes('/sparkdash')) return { status: 200, ok: true, async json() { return { deployed: true, upstreamHead: '24daeb57390a33b414cec214200625b0a3dcb736', upstreamError: 'git ls-remote 失败：Could not resolve host（限流窗口）', upstreamTagVersion: 'v2.90.0', localTagVersion: 'v2.90.0-1-gd77d1a3', local: { commit: 'd77d1a3d8b81d6f7283d82fcf91c567b95af75d9', dirty: false, dirtyCount: 0 }, updateAvailable: false, state: 'idle', gate: { passed: true, reasons: [] } } } }
      if (url.includes('/models')) return { status: 200, ok: true, async json() { return { models: [] } } }
      if (url.includes('/audit')) return { status: 200, ok: true, async json() { return { events: [], nextBefore: null } } }
      return { status: 200, ok: true, async json() { return { teams: [] } } }
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  // ① 注入话术全灭：限流/403/上游探测失败/版本检查失败 一律不落卡面任何节点
  assertNoCardProse(elements, ['限流', 'HTTP 403', '请稍后手动刷新', '上游探测失败', '版本检查失败', 'Could not resolve host'], 'UI-008：检查失败话术注入案')
  // ② 白名单行不受牵连：五枚安装版本行照常如实（版本行是卡面唯一文本+按钮）
  assert.equal(elements.get('#headbot-version').textContent, '安装版本：v0.4.22')
  assert.equal(elements.get('#dsbot-version').textContent, '安装版本：v0.3.6')
  assert.equal(elements.get('#dsh-version').textContent, '安装版本：v0.2.2-rc.3')
  assert.equal(elements.get('#litellm-version').textContent, '安装版本：1.109.1')
  assert.equal(elements.get('#sparkdash-version').textContent, '安装版本：v2.90.0-1-gd77d1a3')
  // ③ 无新版=五 slot 无按钮节点（检查失败不造钮）
  for (const slotId of ['#upgrade-headbot-slot', '#update-all-slot', '#upgrade-dsh-slot', '#upgrade-litellm-slot', '#upgrade-sparkdash-slot'])
    assert.equal((elements.get(slotId)?.children ?? []).length, 0, `${slotId} 无新版即无节点`)
})

// UI-008 请求异常腿：端点整个抛错（网络断/服务挂）→ 版本行退「安装版本：无法读取」，卡面仍零话术。
test('UI-008: a hard request failure leaves the version line honest and the card otherwise silent', async () => {
  const elements = new Map(), handlers = new Map()
  function element(key = 'created') {
    const classes = new Set()
    return {
      key, style: {}, textContent: '', value: '', checked: false, ...htmlSeed(key), href: '', children: [], open: false,
      classList: { toggle(name, force) { if (force) classes.add(name); else classes.delete(name) }, remove(name) { classes.delete(name) }, contains(name) { return classes.has(name) } },
      addEventListener(type, handler) { handlers.set(`${this.id||key}:${type}`, handler) },
      append(...children) { this.children.push(...children) }, replaceChildren(...children) { this.children = [...children] },
      querySelector() { return null },
    }
  }
  const document = {
    querySelector(key) { if (!elements.has(key)) elements.set(key, element(key)); return elements.get(key) },
    createElement(tag) { return element(tag) },
  }
  const source = renderManagerPage({ version: '0.4.22' }).match(/<script>([\s\S]*?)<\/script>/)[1]
  runInNewContext(source, {
    document, window: { location: { origin: 'https://localhost' } }, setInterval() {}, setTimeout() { return 0 }, clearTimeout() {},
    FormData: class { constructor() {} get() { return '' } },
    async fetch(url) {
      if (url.includes('/release') || url.includes('/litellm') || url.includes('/sparkdash') || url.includes('/runtime-versions')) throw new Error('HTTP 503 检查 Headbot 新版本失败：GitHub release check returned HTTP 403')
      if (url.includes('/models')) return { status: 200, ok: true, async json() { return { models: [] } } }
      if (url.includes('/audit')) return { status: 200, ok: true, async json() { return { events: [], nextBefore: null } } }
      return { status: 200, ok: true, async json() { return { teams: [] } } }
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(elements.get('#headbot-version').textContent, '安装版本：无法读取')
  assert.equal(elements.get('#litellm-version').textContent, '安装版本：无法读取')
  assert.equal(elements.get('#sparkdash-version').textContent, '安装版本：无法读取')
  // 抛错原文（含 503/403 话术）不落卡面——console 之外零呈现
  assertNoCardProse(elements, ['HTTP 503', '检查 Headbot 新版本失败', 'HTTP 403', '无法读取：'], 'UI-008：请求异常话术注入案')
})

// UI-008 root-cause leg（总务照准 backlog 转正）：GitHub 检查腿有 token 则带 Authorization，
// 无 token 行为不回归（匿名照旧）。token 值纪律=只进配置/env，绝不入代码/日志/审计。
test('UI-008: the GitHub release checks attach the configured token and stay anonymous without one', async () => {
  const saved = { token: process.env.GITHUB_TOKEN, headbot: process.env.HEADBOT_UPGRADE_GITHUB_TOKEN, dsh: process.env.DSH_UPGRADE_GITHUB_TOKEN }
  delete process.env.GITHUB_TOKEN; delete process.env.HEADBOT_UPGRADE_GITHUB_TOKEN; delete process.env.DSH_UPGRADE_GITHUB_TOKEN
  try {
    const seenHeaders = []
    const manager = { root: '/tmp/headbot-token-test', parentHome: '/tmp/headbot-token-home' }
    const fetchImpl = async (url, options = {}) => {
      seenHeaders.push(options.headers ?? {})
      // releases/latest（headbot）吃对象体，DSH releases?per_page 腿吃数组体——按 URL 分流
      const body = String(url).includes('per_page')
        ? [{ tag_name: 'dsh-v9.9.9', published_at: '2026-11-15T00:00:00Z', draft: false }]
        : { tag_name: 'v9.9.9', published_at: '2026-11-15T00:00:00Z', draft: false, prerelease: false, target_commitish: 'main' }
      return { ok: true, status: 200, async json() { return body } }
    }
    const release = new HeadbotReleaseUpdater({ currentVersion: '0.4.22', manager, fetchImpl, githubToken: 'tok-release' })
    await release.fetchLatest()
    assert.equal(seenHeaders[0].Authorization, 'Bearer tok-release', '配置的 token 必须上请求头')
    const anon = new HeadbotReleaseUpdater({ currentVersion: '0.4.22', manager, fetchImpl })
    await anon.fetchLatest()
    assert.equal(seenHeaders[1].Authorization, undefined, '无 token 必须保持匿名原样（不回归）')
    const runtime = new HeadbotRuntimeUpdater({ manager, fetchImpl, githubToken: 'tok-runtime' })
    await runtime.fetchLatestDshRelease()
    assert.equal(seenHeaders[2].Authorization, 'Bearer tok-runtime', 'DSH releases 腿同样吃 token')
    // env 兜底：GITHUB_TOKEN 存在即生效（配置面缺位时）
    process.env.GITHUB_TOKEN = 'tok-env'
    const viaEnv = new HeadbotReleaseUpdater({ currentVersion: '0.4.22', manager, fetchImpl })
    await viaEnv.fetchLatest()
    assert.equal(seenHeaders[3].Authorization, 'Bearer tok-env', 'GITHUB_TOKEN env 兜底必须生效')
  } finally {
    for (const [key, value] of Object.entries({ GITHUB_TOKEN: saved.token, HEADBOT_UPGRADE_GITHUB_TOKEN: saved.headbot, DSH_UPGRADE_GITHUB_TOKEN: saved.dsh })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
})

test('manual DSH upgrade worker marks its updater invocation as user initiated', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'headbot-dsh-updater-')))
  t.after(() => rm(root, { recursive:true, force:true }))
  const appRoot = path.join(root, 'DeepSeekHarness')
  const versions = path.join(appRoot, 'versions')
  const currentRoot = path.join(appRoot, 'current')
  const updateScript = path.join(appRoot, 'bin/update.sh')
  const stateFile = path.join(root, 'headbot/dsh-update-state.json')
  const oldExecutable = path.join(versions, '0.2.1-rc.2/node_modules/.bin/dsh')
  await mkdir(path.dirname(oldExecutable), { recursive:true })
  await mkdir(path.dirname(updateScript), { recursive:true })
  await mkdir(path.dirname(stateFile), { recursive:true })
  await writeFile(oldExecutable, '#!/bin/sh\nprintf "0.2.1-rc.2\\n"\n', { mode:0o700 })
  await symlink(path.join(versions, '0.2.1-rc.2'), currentRoot)
  await writeFile(updateScript, `#!/bin/sh
set -eu
[ "$HEADBOT_DSH_WEB_UPGRADE" = "1" ]
printf '%s' "$HEADBOT_DSH_WEB_UPGRADE" > "$PWD/state/web-upgrade-mode"
NEW="$PWD/versions/0.2.1-rc.3/node_modules/.bin/dsh"
mkdir -p "$(dirname "$NEW")"
printf '#!/bin/sh\\nprintf "0.2.1-rc.3\\\\n"\\n' > "$NEW"
chmod +x "$NEW"
ln -sfn "$PWD/versions/0.2.1-rc.3" "$PWD/current"
`, { mode:0o700 })
  const config = { appRoot, currentRoot, dataHome:path.join(root, 'data'), expectedVersion:'0.2.1-rc.3', stateFile, updateScript, manualWebUpgrade:true }
  let workerError=''
  try { execFileSync(process.execPath, [path.join(process.cwd(), 'lib/runtime-updater.js'), JSON.stringify(config)], { stdio:'pipe' }) }
  catch(error) { workerError=error.stderr?.toString()||error.message }
  const state = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(state.state, 'completed', `${workerError} ${JSON.stringify(state)}`)
  assert.equal(await readFile(path.join(appRoot, 'state/web-upgrade-mode'), 'utf8'), '1')
  assert.equal(state.message, '已升级到 0.2.1-rc.3')
})

import { seedTeamOnboarding, PROTOCOL_FILE, AGENTS_FILE, ONBOARDING_MARKER } from '../lib/onboarding.js'
import { fileURLToPath } from 'node:url'

test('team onboarding seeds protocol and AGENTS.md idempotently', async t => {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const root = await mkdtemp(path.join(tmpdir(), 'onboard-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const botRoot = path.join(root, 'workspace')

  const first = await seedTeamOnboarding(botRoot, { packageRoot })
  assert.equal(first.protocolSeeded, true)
  assert.equal(first.agentsUpdated, true)
  const protocol = await readFile(path.join(botRoot, PROTOCOL_FILE), 'utf8')
  assert.match(protocol, /跨团队求助协议 v1/)
  assert.match(protocol, /headbot_send_message/)
  const agents = await readFile(path.join(botRoot, AGENTS_FILE), 'utf8')
  assert.ok(agents.includes(ONBOARDING_MARKER))

  // idempotent re-run changes nothing
  const second = await seedTeamOnboarding(botRoot, { packageRoot })
  assert.equal(second.protocolSeeded, false)
  assert.equal(second.agentsUpdated, false)
  assert.equal(await readFile(path.join(botRoot, AGENTS_FILE), 'utf8'), agents)

  // pre-existing AGENTS.md content is preserved and section appended once
  const root2 = await mkdtemp(path.join(tmpdir(), 'onboard-test-'))
  t.after(() => rm(root2, { recursive: true, force: true }))
  const botRoot2 = path.join(root2, 'workspace')
  await mkdir(botRoot2, { recursive: true })
  await writeFile(path.join(botRoot2, AGENTS_FILE), '# My custom notes\n')
  await writeFile(path.join(botRoot2, PROTOCOL_FILE), 'team edition')
  const third = await seedTeamOnboarding(botRoot2, { packageRoot })
  assert.equal(third.protocolSeeded, false, 'team-modified protocol is never clobbered')
  assert.equal(third.agentsUpdated, true)
  assert.equal(third.agentsExisted, true)
  const merged = await readFile(path.join(botRoot2, AGENTS_FILE), 'utf8')
  assert.ok(merged.startsWith('# My custom notes'))
  assert.equal(merged.match(new RegExp(ONBOARDING_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')).length, 1)
  assert.equal(await readFile(path.join(botRoot2, PROTOCOL_FILE), 'utf8'), 'team edition')
})

test('controller joins the audited circle with its own identity, roster and send rules', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha'); await add(manager, 'beta')
  online(manager, 'beta')
  const a = manager.identity(manager.findTeam('alpha')), b = manager.identity(manager.findTeam('beta'))
  const controller = manager.controllerIdentity()
  const broker = new AuditedCommunications(manager.root, manager)
  const token = manager.controller.communicationToken
  assert.match(token, /^[a-f0-9]{64}$/)
  assert.deepEqual(await manager.authenticateTeam('Bearer ' + token), controller)
  assert.equal(await manager.authenticateTeam('Bearer ' + '0'.repeat(64)), undefined)
  assert.equal(JSON.stringify(await manager.listTeams()).includes(token), false)
  assert.deepEqual((await broker.directory(a)).teams.map(team => team.id), ['default', 'beta'])
  assert.deepEqual((await broker.directory(controller)).teams.map(team => team.id), ['alpha', 'beta'])
  const bytes = Buffer.from('需要保障组处理')
  const sent = await broker.send(a, { to: 'default', subject: '升级', text: '团队求助', requestId: randomUUID(), attachments: [{ name: 'evidence.txt', contentBase64: bytes.toString('base64') }] })
  const received = await broker.inbox(controller)
  assert.equal(received.messages.length, 1)
  assert.equal(received.messages[0].from.id, 'alpha')
  assert.deepEqual((await broker.attachment(controller, sent.message.messageId, sent.message.attachments[0].id)).bytes, bytes)
  await broker.send(controller, { to: 'beta', text: '保障组回执', requestId: randomUUID() })
  assert.deepEqual((await broker.inbox(b)).messages.map(message => message.text), ['保障组回执'])
  await assert.rejects(broker.send(controller, { to: 'default', text: '自己发给自己', requestId: randomUUID() }), { statusCode: 400 })
  const audit = await broker.exportAudit()
  assert.equal(audit.integrity, 'verified')
  assert.ok(audit.events.some(event => event.type === 'message.sent' && event.to.instanceId === 'controller'))
})

test('legacy controller metadata self-heals a private communication identity on load', async t => {
  const { manager, root, fake } = await fixture(t)
  await manager.listTeams()
  const first = manager.controller.communicationToken
  assert.match(first, /^[a-f0-9]{64}$/)
  const document = JSON.parse(await readFile(manager.controllerFile, 'utf8'))
  assert.equal(document.communicationToken, first)
  assert.equal((await stat(manager.controllerFile)).mode & 0o777, 0o600)
  delete document.communicationToken
  delete document.instanceId
  await writeFile(manager.controllerFile, JSON.stringify(document))
  const reloaded = new HeadbotManager({ dataDir: manager.root, dshHome: path.join(root, 'home'), dshCommand: fake, inheritModelSettings: false, ingressPort: await port() }, { parentPort: await port(), logger: quiet })
  t.after(() => reloaded.close())
  await reloaded.listTeams()
  const healed = reloaded.controller.communicationToken
  assert.match(healed, /^[a-f0-9]{64}$/)
  assert.notEqual(healed, first)
  assert.equal(JSON.parse(await readFile(manager.controllerFile, 'utf8')).communicationToken, healed)
  assert.equal((await stat(manager.controllerFile)).mode & 0o777, 0o600)
  assert.equal((await reloaded.authenticateTeam('Bearer ' + healed)).instanceId, 'controller')
})

test('controller bots use the communication tools in process with the bot workspace as the only sandbox', async t => {
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
  const dataDir = path.join(root, 'ctl-headbot')
  const dshHome = path.join(root, 'ctl-home')
  const oldDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  t.after(() => { oldDshHome === undefined ? delete process.env.DSH_HOME : process.env.DSH_HOME = oldDshHome })
  const tools = new Map()
  applyHeadbot({
    webServer: { host: '127.0.0.1', port: server.address().port, register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1) } },
    connection: { requestRejection(req) { return req.headers['x-controller-session'] === 'test' ? undefined : 401 } },
    tools: { register(tool) { tools.set(tool.name, tool) } },
    logger: quiet, effect(callback) { dispose = callback() },
  }, { dataDir, dshHome, dshCommand: fake, inheritModelSettings: false, ingressPort: await port() })
  t.after(() => dispose())
  const base = `http://127.0.0.1:${server.address().port}${apiPath}`
  const admin = { 'x-controller-session': 'test', 'Content-Type': 'application/json' }
  const created = await fetch(base + '/teams', { method: 'POST', headers: admin, body: JSON.stringify({ id: 'alpha', name: 'Alpha', port: await port(), autoStart: false }) })
  assert.equal(created.status, 202)
  const state = JSON.parse(await readFile(path.join(dataDir, 'teams.json'), 'utf8'))
  const a = state.teams.find(team => team.id === 'alpha')
  // Reachability rule (INBOX-PUSH-001): an offline team is answered without queueing, so this
  // scenario must genuinely bring Alpha up — the fake dsh binary carries its phase to running.
  await fetch(`${base}/teams/alpha/start`, { method: 'POST', headers: admin })
  let alphaStatus
  for (let i = 0; i < 200; i++) {
    const listed = await fetch(base + '/teams', { headers: admin }).then(response => response.json())
    alphaStatus = listed.teams.find(team => team.id === 'alpha')?.status
    if (alphaStatus === 'running') break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(alphaStatus, 'running')
  const call = async (name, args = {}) => JSON.parse(await tools.get(name).execute(args, { signal: new AbortController().signal }))
  const botWorkspace = path.join(dshHome, 'bot', 'workspace')
  await mkdir(botWorkspace, { recursive: true })
  assert.deepEqual((await call('headbot_list_teams')).teams.map(team => team.id), ['alpha'])
  await writeFile(path.join(botWorkspace, 'ticket.log'), 'controller evidence')
  await call('headbot_send_message', { to: 'alpha', text: '来自保障组', files: ['ticket.log'] })
  const teamInbox = await fetch(base + '/comms/v1/inbox', { headers: { Authorization: 'Bearer ' + a.communicationToken } }).then(response => response.json())
  assert.deepEqual(teamInbox.messages.map(message => message.from.id), ['default'])
  const fileBytes = Buffer.from('需要基础设施支援')
  const inbound = await fetch(base + '/comms/v1/messages', { method: 'POST', headers: { Authorization: 'Bearer ' + a.communicationToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'default', text: '升级给保障组', requestId: randomUUID(), attachments: [{ name: 'need.txt', contentBase64: fileBytes.toString('base64') }] }) })
  assert.equal(inbound.status, 201)
  const inboundMessage = (await inbound.json()).message
  assert.deepEqual((await call('headbot_receive_messages')).messages.map(message => message.text), ['升级给保障组'])
  const downloaded = await call('headbot_download_attachment', { messageId: inboundMessage.messageId, attachmentId: inboundMessage.attachments[0].id })
  assert.equal(await readFile(downloaded.path, 'utf8'), '需要基础设施支援')
  assert.equal(path.dirname(path.dirname(downloaded.path)), botWorkspace)
  await writeFile(path.join(dataDir, 'feishu-secrets.json'), 'must-never-be-readable')
  await assert.rejects(call('headbot_send_message', { to: 'alpha', files: [path.join(dataDir, 'feishu-secrets.json')] }), /inside/)
  await symlink(path.join(dataDir, 'feishu-secrets.json'), path.join(botWorkspace, 'sneaky.txt'))
  await assert.rejects(call('headbot_send_message', { to: 'alpha', files: ['sneaky.txt'] }), /inside/)
  await assert.rejects(call('headbot_send_message', { to: 'default', text: '自己发给自己' }), /different recipient/)
  const controllerToken = JSON.parse(await readFile(path.join(dataDir, 'controller.json'), 'utf8')).communicationToken
  assert.match(controllerToken, /^[a-f0-9]{64}$/)
  assert.equal((await fetch(base + '/comms/v1/inbox', { headers: { Authorization: 'Bearer ' + controllerToken } })).status, 200)
  assert.equal((await fetch(base + '/comms/v1/teams', { headers: { Authorization: 'Bearer ' + controllerToken } })).status, 200)
  assert.equal((await fetch(base + '/audit', { headers: { Authorization: 'Bearer ' + controllerToken } })).status, 401)
})
