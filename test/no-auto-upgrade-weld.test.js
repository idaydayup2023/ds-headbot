// NO-AUTO-UPGRADE-001 焊死（0.4.28 批 · 案⑤，总务裁"源码真值+行为负腿两路"）。
// 0.4.26 批已焊五枚（sole route caller / sole spawn site / argv 守卫源形制 / setInterval 零 /
// check 不自发 spawn）于 headbot.test.js。本件加四把 bolts：全仓调用面清点、单飞+无自动重试
// 行为面、worker 守卫的行为负腿（此前只有源形制一枚）、config 面 token 焊。
// 不碰真机、不发真网络、不 spawn 真进程——spawn/fetch 全替身，worker 腿走隔离子进程。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { HeadbotReleaseUpdater } from '../lib/release-updater.js'

const repoRoot = path.join(import.meta.dirname, '..')

async function chainSources() {
  // 本案的链=Headbot release 安装面：路由 + release-updater + manager 挂接层。
  // sparkdash-updater 的 `auto-upgrade <txId>` 是 git-stash 标签命名，不在安装开关面。
  const managerFiles = (await readdir(path.join(repoRoot, 'lib', 'manager'))).filter(name => name.endsWith('.js')).map(name => `lib/manager/${name}`)
  const sources = {}
  for (const file of ['index.js', 'lib/release-updater.js', ...managerFiles]) sources[file] = await readFile(path.join(repoRoot, file), 'utf8')
  return sources
}

// 焊①：全链调用面清点——release 安装入口的调用者只有 POST /release/upgrade 那一枚。
test('NO-AUTO-UPGRADE-001 weld ①: an inventory of every startUpgrade reference across the chain', async () => {
  const sources = await chainSources()
  const routeCalls = []
  for (const [file, source] of Object.entries(sources)) for (const _match of source.matchAll(/(\w+)\.startUpgrade\(/g)) routeCalls.push([file, _match[1]])
  assert.deepEqual(routeCalls.filter(([file, receiver]) => receiver === 'releaseUpdater'), [['index.js', 'releaseUpdater']],
    '锁定焊①: releaseUpdater.startUpgrade 全链只有一枚调用者')
  const indexSource = sources['index.js']
  assert.match(indexSource, /method === 'POST' && route === '\/release\/upgrade'[\s\S]{0,220}releaseUpdater\.startUpgrade\(\)/,
    '那唯一一枚就在 POST /release/upgrade 后面（GET /release 只许 check）')
  for (const [file, source] of Object.entries(sources)) {
    if (file === 'index.js') continue
    assert.equal((source.match(/\.startUpgrade\(/g) || []).length, 0, `锁定焊①: ${file} 内不得出现任何 .startUpgrade( 调用（内部自触发=自动升级的胚胎）`)
  }
  assert.equal((sources['lib/release-updater.js'].match(/setInterval\(/g) || []).length, 0, '升级器不得挂任何 interval 定时器')
})

function stubUpdater(root, { tag = 'v0.9.9' } = {}) {
  const calls = []
  const updater = new HeadbotReleaseUpdater({
    currentVersion: '0.2.5',
    manager: { root: path.join(root, 'headbot'), parentHome: path.join(root, 'dsh'), dshCommand: 'dsh', parentPort: 3080, controllerPath: 'dsh' },
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { tag_name: tag, draft: false, prerelease: false } } }),
    spawnImpl(execPath, args, options) {
      const child = { listeners: {}, once(event, listener) { (this.listeners[event] ??= []).push(listener); return this }, unref() { return this } }
      calls.push({ execPath, args, options, child })
      return child
    },
  })
  return { updater, calls }
}

// 焊②：单飞与无自动重试（行为面）——startUpgrade 一次恰 spawn 一枚 worker；升级在途时二次
// 调用吃 409 且 spawn 不增；worker 挂掉后静置只留原样（不自动重来——重试只能是用户再点）。
test('NO-AUTO-UPGRADE-001 weld ②: one worker per click, a second click while in flight is refused, no auto-retry after a dead worker', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'headbot-weld-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { updater, calls } = stubUpdater(root)
  await updater.startUpgrade()
  assert.equal(calls.length, 1, 'positive control: 点一次恰 spawn 一枚——计数器是活的')
  assert.equal(calls[0].execPath, process.execPath)
  assert.match(calls[0].args[0], /release-updater\.js$/, 'worker=自指 spawn（argv[1] 守卫的另一半）')
  assert.ok(calls[0].options.detached, 'worker 必须 detached（升级不随控制器陪葬）')
  await assert.rejects(updater.startUpgrade(), { statusCode: 409 }, '锁定焊②: 升级在途时二次调用必须 409，不得双开 worker')
  assert.equal(calls.length, 1, '被拒的二次调用没有 spawn 第二枚')
  calls[0].child.listeners.exit[0](1, null) // worker 死了
  await new Promise(resolve => setTimeout(resolve, 50)) // 给任何自动重试腿起跳的机会
  assert.equal(calls.length, 1, '锁定焊②: worker 挂掉只留原样——重试是人的决定，不是定时器的')
})

// 焊③：worker 守卫的行为负腿——argv[1] 守卫此前只有源形制一枚；这里真起一个隔离子进程 import
// 本模块：守卫健在时 import 必须静默 exit 0（performHeadbotUpdate 一步都不跑）。
// 守卫被拆/放宽 → 子进程直入升级体（config={} 在 path.join 处 TypeError，非零退出+吐错误）→ 红。
test('NO-AUTO-UPGRADE-001 weld ③: importing the updater as a module never boots the worker body', async () => {
  const modulePath = path.join(repoRoot, 'lib', 'release-updater.js')
  const source = await readFile(modulePath, 'utf8')
  assert.match(source, /if \(process\.argv\[1\] && path\.resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)\)/,
    '源形制双保险：worker 体只认自指 main')
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(modulePath).href)}).then(() => process.exit(0))`], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child hung — importing the updater must be instant and silent')) }, 10_000)
    child.on('error', reject)
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
  assert.equal(output.code, 0, `锁定焊③: 普通 import 必须 exit 0（got ${output.code} / stderr=${output.stderr.slice(0, 200)}）`)
  assert.equal(output.stdout, '', 'import 不得打印升级体的任何字')
  assert.equal(output.stderr, '', 'import 不得打印错误（升级体一步都没跑）')
})

// 焊④：config 面 token 焊——链上不得存在任何"自动升级"开关名（今天的形制：开了版也没有
// 东西可开；将来若有人加开关，这个 token 案先红，逼它走显式审查而不是静默长出来）。
test('NO-AUTO-UPGRADE-001 weld ④: no auto-upgrade switch exists anywhere on the chain', async () => {
  const sources = await chainSources()
  const tokens = /autoUpgrade|auto-upgrade|scheduleUpgrade|cronUpgrade|autoUpdate/i
  for (const [file, source] of Object.entries(sources)) {
    const hit = source.match(tokens)
    assert.equal(hit, null, `锁定焊④: ${file} 出现自动升级 token "${hit?.[0]}"——自动升级开关不得静默长出来`)
  }
})
