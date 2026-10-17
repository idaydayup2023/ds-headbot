import { spawn as spawnProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY = 'idaydayup2023/ds-headbot'
const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`
const WORKER_PATH = fileURLToPath(new URL('./release-updater.js', import.meta.url))
const CACHE_MS = 10 * 60 * 1000
const MAX_SOURCE_BYTES = 20 * 1024 * 1024

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}

function parseVersion(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(value ?? ''))
  if (!match) throw new Error(`invalid stable release version: ${value}`)
  return match.slice(1).map(Number)
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode })
}

function safeMessage(error) {
  return String(error?.message ?? error ?? 'unknown error').slice(0, 500)
}

function defaultRestart(config) {
  if (config.restartCommand) {
    if (typeof config.restartCommand !== 'string' || !config.restartCommand.trim()) throw new Error('restartCommand must be a non-empty string')
    if (config.restartArgs !== undefined && (!Array.isArray(config.restartArgs) || config.restartArgs.some(arg => typeof arg !== 'string'))) {
      throw new Error('restartArgs must be an array of strings')
    }
    return { command: config.restartCommand, args: config.restartArgs ?? [] }
  }
  if (process.platform === 'darwin' && typeof process.getuid === 'function') {
    const uid = process.getuid()
    const label = config.launchdLabel || 'com.deepseek.dsh'
    if (!/^[A-Za-z0-9.-]+$/.test(label)) throw new Error('launchdLabel is invalid')
    return { command: '/bin/launchctl', args: ['kickstart', '-k', `gui/${uid}/${label}`] }
  }
  return undefined
}

async function atomicWriteJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
}

export class HeadbotReleaseUpdater {
  constructor({ currentVersion, manager, logger, fetchImpl = globalThis.fetch, spawnImpl = spawnProcess, restartCommand, restartArgs, launchdLabel, pnpmCommand = 'pnpm', dshCommand } = {}) {
    parseVersion(currentVersion)
    if (!manager?.root || !manager?.parentHome) throw new Error('a Headbot manager with root and parentHome is required')
    if (typeof fetchImpl !== 'function') throw new Error('fetch is not available for release checks')
    this.currentVersion = String(currentVersion).replace(/^v/, '')
    this.manager = manager
    this.logger = logger
    this.fetchImpl = fetchImpl
    this.spawnImpl = spawnImpl
    this.restart = defaultRestart({ restartCommand, restartArgs, launchdLabel })
    this.pnpmCommand = pnpmCommand
    this.dshCommand = dshCommand || manager.dshCommand || 'dsh'
    this.cache = undefined
    this.checking = undefined
    this.stateFile = path.join(manager.root, 'headbot-update-state.json')
  }

  async check({ force = false } = {}) {
    const now = Date.now()
    let release
    let checkError
    if (!force && this.cache && now - this.cache.checkedAt < CACHE_MS) {
      release = this.cache.release
    } else {
      try {
        if (!this.checking) this.checking = this.fetchLatest()
        release = await this.checking
        this.cache = { checkedAt: Date.now(), release }
      } catch (error) {
        checkError = safeMessage(error)
      } finally {
        this.checking = undefined
      }
    }

    const updateState = await this.readState()
    let state = updateState?.state || 'idle'
    let message = updateState?.message || ''
    if (updateState?.targetVersion === this.currentVersion && ['downloading', 'installing', 'restarting'].includes(state)) {
      state = 'completed'
      message = `已升级到 ${this.currentVersion}`
      await this.writeState({ ...updateState, state, message, completedAt: new Date().toISOString() })
    }
    const latestVersion = release?.version
    return {
      currentVersion: this.currentVersion,
      latestVersion: latestVersion || null,
      updateAvailable: latestVersion ? compareVersions(latestVersion, this.currentVersion) > 0 : false,
      releaseUrl: release?.url || null,
      checkedAt: this.cache ? new Date(this.cache.checkedAt).toISOString() : null,
      state,
      message,
      checkError: checkError || null,
    }
  }

  async fetchLatest() {
    const response = await this.fetchImpl(RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `ds-headbot/${this.currentVersion}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`GitHub release check returned HTTP ${response.status}`)
    const release = await response.json()
    if (release?.draft || release?.prerelease) throw new Error('GitHub did not return a stable published release')
    const version = String(release?.tag_name || '').replace(/^v/, '')
    parseVersion(version)
    return { version, tag: `v${version}`, url: `https://github.com/${REPOSITORY}/releases/tag/v${version}` }
  }

  async startUpgrade() {
    const status = await this.check({ force: true })
    if (status.checkError) throw httpError(503, `检查 Headbot 新版本失败：${status.checkError}`)
    if (!status.updateAvailable) throw httpError(409, '当前已经是最新版本')
    if (['downloading', 'installing', 'restarting'].includes(status.state)) throw httpError(409, 'Headbot 升级已在进行中')
    if (status.state === 'restart-required') throw httpError(409, '新版本已安装，请先重启 DSH')

    const release = this.cache?.release
    if (!release || release.version !== status.latestVersion) throw httpError(503, '最新版本信息已失效，请重新检查')
    const workerConfig = {
      targetVersion: release.version,
      tag: release.tag,
      parentHome: this.manager.parentHome,
      managerRoot: this.manager.root,
      profile: 'web',
      dshCommand: this.dshCommand,
      pnpmCommand: this.pnpmCommand,
      restart: this.restart,
      parentPort: this.manager.parentPort,
    }
    await this.writeState({ state: 'downloading', targetVersion: release.version, startedAt: new Date().toISOString(), message: '正在准备升级包' })
    let child
    try {
      child = this.spawnImpl(process.execPath, [WORKER_PATH, JSON.stringify(workerConfig)], {
        cwd: this.manager.parentHome,
        env: { ...process.env, DSH_HOME: this.manager.parentHome },
        detached: true,
        stdio: 'ignore',
      })
      child.once('error', error => {
        void this.writeState({ state: 'failed', targetVersion: release.version, message: safeMessage(error), failedAt: new Date().toISOString() })
      })
      child.unref()
    } catch (error) {
      await this.writeState({ state: 'failed', targetVersion: release.version, message: safeMessage(error), failedAt: new Date().toISOString() })
      throw httpError(500, `无法启动 Headbot 升级：${safeMessage(error)}`)
    }
    this.logger?.info?.(`[ds-headbot] started self-update to ${release.version}`)
    return { ...status, state: 'downloading', message: '正在下载更新包；安装后 DSH 会自动重启' }
  }

  async readState() {
    try { return JSON.parse(await readFile(this.stateFile, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
  }

  writeState(value) {
    return atomicWriteJson(this.stateFile, value)
  }
}

function execFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = [], stderr = []
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code, signal) => {
      const result = { code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }
      if (code === 0) resolve(result)
      else reject(Object.assign(new Error((result.stderr || result.stdout || `${command} exited ${code ?? signal}`).trim().slice(-3000)), { result }))
    })
  })
}

async function readPackageVersion(file) {
  const packageJson = JSON.parse(await readFile(file, 'utf8'))
  if (packageJson.name !== 'ds-headbot') throw new Error(`expected ds-headbot package at ${file}`)
  return String(packageJson.version)
}

async function writeWorkerState(file, targetVersion, state, message = '') {
  await atomicWriteJson(file, { state, targetVersion, message: String(message).slice(0, 500), updatedAt: new Date().toISOString() })
}

async function waitForController(config, fetchImpl, installedPackage) {
  const deadline = Date.now() + 90_000
  // parentPort addresses the DSH Web server directly, before the public ingress
  // applies its controller path prefix (for example, /dsh).
  const healthUrl = `http://127.0.0.1:${config.parentPort}/api/ds-headbot/v1/release`
  while (Date.now() < deadline) {
    try {
      const installedVersion = await readPackageVersion(path.join(installedPackage, 'package.json'))
      if (installedVersion === config.targetVersion) {
        const response = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(2000) })
        if (response.status === 401 || response.status === 403) return true
        if (response.ok) {
          const status = await response.json().catch(() => ({}))
          if (status.currentVersion === config.targetVersion) return true
        }
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('等待 Headbot 管理接口恢复超时')
}

export async function performHeadbotUpdate(config, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch
  const runCommand = dependencies.runCommand || execFile
  const healthCheck = dependencies.healthCheck || (() => waitForController(config, fetchImpl, path.join(config.parentHome, 'profiles', config.profile || 'web', 'node_modules', 'ds-headbot')))
  const tarCommand = dependencies.tarCommand || '/usr/bin/tar'
  const profile = config.profile || 'web'
  const profileDir = path.join(config.parentHome, 'profiles', profile)
  const installedPackage = path.join(profileDir, 'node_modules', 'ds-headbot')
  const updatesDir = path.join(config.managerRoot, 'updates')
  const updateDir = path.join(updatesDir, `${config.targetVersion}-${Date.now()}`)
  const stateFile = path.join(config.managerRoot, 'headbot-update-state.json')
  const sourceDir = path.join(updateDir, 'source')
  const backupDir = path.join(updateDir, 'rollback')
  const downloadedSource = path.join(updateDir, 'source.tar.gz')
  let rollbackPackage
  let newPackageInstalled = false
  let restartStarted = false
  let oldVersion

  try {
    parseVersion(config.targetVersion)
    if (config.tag !== `v${config.targetVersion}`) throw new Error('release tag does not match target version')
    await mkdir(sourceDir, { recursive: true, mode: 0o700 })
    await mkdir(backupDir, { recursive: true, mode: 0o700 })
    await writeWorkerState(stateFile, config.targetVersion, 'downloading', '正在下载 GitHub 发布源码')

    const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/tarball/${config.tag}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `ds-headbot-updater/${config.targetVersion}` },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`下载 GitHub 发布源码失败：HTTP ${response.status}`)
    const sourceBytes = Buffer.from(await response.arrayBuffer())
    if (!sourceBytes.length || sourceBytes.length > MAX_SOURCE_BYTES) throw new Error('GitHub 源码包大小超出允许范围')
    await writeFile(downloadedSource, sourceBytes, { mode: 0o600 })
    const listing = await runCommand(tarCommand, ['-tzf', downloadedSource])
    const entries = listing.stdout.split(/\r?\n/).filter(Boolean)
    const archiveRoot = entries[0]?.split('/')[0]
    if (!archiveRoot || entries.some(entry => entry.startsWith('/') || entry.split('/').includes('..') || entry.split('/')[0] !== archiveRoot)) {
      throw new Error('GitHub 源码包包含无效路径')
    }
    await runCommand(tarCommand, ['-xzf', downloadedSource, '-C', sourceDir])
    const roots = (await readdir(sourceDir, { withFileTypes: true })).filter(entry => entry.isDirectory())
    if (roots.length !== 1) throw new Error('GitHub 源码包目录结构无效')
    const packageDir = path.join(sourceDir, roots[0].name)
    const candidateManifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'))
    if (candidateManifest.name !== 'ds-headbot') throw new Error('源码包不是 ds-headbot 插件')
    const lifecycleScripts = ['preinstall', 'install', 'postinstall', 'prepack', 'postpack', 'prepare', 'prepublish', 'prepublishOnly']
    const activeLifecycleScripts = lifecycleScripts.filter(name => candidateManifest.scripts?.[name])
    if (activeLifecycleScripts.length) throw new Error(`插件声明了未允许的安装脚本：${activeLifecycleScripts.join(', ')}`)
    const candidateVersion = String(candidateManifest.version)
    parseVersion(candidateVersion)
    if (candidateVersion !== config.targetVersion) throw new Error(`发布标签版本 ${config.targetVersion} 与源码包版本 ${candidateVersion} 不一致`)
    await runCommand(process.execPath, ['--check', path.join(packageDir, 'index.js')], { cwd: packageDir })

    await runCommand(config.pnpmCommand || 'pnpm', ['pack', '--pack-destination', updateDir], { cwd: packageDir })
    const candidatePackage = path.join(updateDir, `ds-headbot-${config.targetVersion}.tgz`)
    await readFile(candidatePackage)

    oldVersion = await readPackageVersion(path.join(installedPackage, 'package.json'))
    await runCommand(config.pnpmCommand || 'pnpm', ['pack', '--pack-destination', backupDir], { cwd: installedPackage })
    rollbackPackage = path.join(backupDir, `ds-headbot-${oldVersion}.tgz`)
    await readFile(rollbackPackage)
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      try { await copyFile(path.join(profileDir, name), path.join(backupDir, name)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }

    await writeWorkerState(stateFile, config.targetVersion, 'installing', `正在安装 ds-headbot ${config.targetVersion}`)
    newPackageInstalled = true
    await runCommand(config.dshCommand || 'dsh', ['plugin', '--profile', profile, 'add', candidatePackage], {
      cwd: config.parentHome,
      env: { ...process.env, DSH_HOME: config.parentHome },
    })
    const installedVersion = await readPackageVersion(path.join(installedPackage, 'package.json'))
    if (installedVersion !== config.targetVersion) throw new Error(`安装后版本不符：${installedVersion}`)

    if (!config.restart?.command || !Array.isArray(config.restart.args)) {
      await writeWorkerState(stateFile, config.targetVersion, 'restart-required', `ds-headbot ${config.targetVersion} 已安装；当前平台未配置 DSH 自动重启`)
      return { state: 'restart-required', version: config.targetVersion, rollbackPackage }
    }
    await writeWorkerState(stateFile, config.targetVersion, 'restarting', `正在重启 DSH 并加载 ds-headbot ${config.targetVersion}`)
    restartStarted = true
    await runCommand(config.restart.command, config.restart.args, { cwd: config.parentHome })
    await healthCheck(config)
    await writeWorkerState(stateFile, config.targetVersion, 'completed', `已升级到 ${config.targetVersion}`)
    return { state: 'completed', version: config.targetVersion, rollbackPackage }
  } catch (error) {
    let rollbackMessage = ''
    if (newPackageInstalled && rollbackPackage) {
      try {
        await runCommand(config.dshCommand || 'dsh', ['plugin', '--profile', profile, 'add', rollbackPackage], {
          cwd: config.parentHome,
          env: { ...process.env, DSH_HOME: config.parentHome },
        })
        if (restartStarted && config.restart?.command) await runCommand(config.restart.command, config.restart.args, { cwd: config.parentHome })
        rollbackMessage = `；已回退到 ds-headbot ${oldVersion}`
      } catch (rollbackError) {
        rollbackMessage = `；自动回退失败：${safeMessage(rollbackError)}`
      }
    }
    const message = `${safeMessage(error)}${rollbackMessage}`
    await writeWorkerState(stateFile, config.targetVersion, 'failed', message)
    throw new Error(message)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let config
  try { config = JSON.parse(process.argv[2] || '{}') } catch { console.error('Invalid Headbot updater configuration'); process.exitCode = 2 }
  if (config) {
    performHeadbotUpdate(config).then(result => {
      console.log(`Headbot update ${result.state}: ${result.version}`)
    }).catch(error => {
      console.error(`Headbot update failed: ${safeMessage(error)}`)
      process.exitCode = 1
    })
  }
}
