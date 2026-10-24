import { spawn as spawnProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { access, chmod, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DSH_PACKAGE_URL = 'https://registry.npmjs.org/@deepseek-ai%2fdsh'
const BOT_PACKAGE_URL = 'https://registry.npmjs.org/ds-bot/latest'
const WORKER_PATH = fileURLToPath(import.meta.url)
const CACHE_MS = 10 * 60 * 1000
const BUSY_STATES = new Set(['installing', 'restarting'])

function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value ?? ''))
  if (!match) throw new Error(`invalid package version: ${value}`)
  return { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') }
}

export function compareRuntimeVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < a.core.length; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1
  }
  if (!a.prerelease && !b.prerelease) return 0
  if (!a.prerelease) return 1
  if (!b.prerelease) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index++) {
    if (a.prerelease[index] === undefined) return -1
    if (b.prerelease[index] === undefined) return 1
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === rightPart) continue
    const leftNumber = /^(0|[1-9]\d*)$/.test(leftPart) ? Number(leftPart) : undefined
    const rightNumber = /^(0|[1-9]\d*)$/.test(rightPart) ? Number(rightPart) : undefined
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber > rightNumber ? 1 : -1
    if (leftNumber !== undefined) return -1
    if (rightNumber !== undefined) return 1
    return leftPart > rightPart ? 1 : -1
  }
  return 0
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode })
}

function safeMessage(error) {
  return String(error?.message ?? error ?? 'unknown error').slice(0, 500)
}

function atomicWriteJson(file, value) {
  return mkdir(path.dirname(file), { recursive: true, mode: 0o700 }).then(async () => {
    const temporary = `${file}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, file)
  })
}

function runFile(command, args, { env = process.env, cwd, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    let size = 0
    const collect = target => chunk => {
      if (size >= 16_384) return
      const limited = chunk.subarray(0, Math.max(0, 16_384 - size))
      target.push(limited)
      size += limited.length
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    timer.unref?.()
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }
      if (code === 0) resolve(result)
      else reject(new Error((result.stderr || result.stdout || `${command} exited ${code ?? signal}`).trim().slice(-1200)))
    })
  })
}

function findOnPath(command, pathValue = process.env.PATH || '') {
  if (path.isAbsolute(command)) return command
  if (command.includes(path.sep)) return path.resolve(command)
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue
    const candidate = path.join(directory, command)
    try {
      requireExecutable(candidate)
      return candidate
    } catch {}
  }
  return undefined
}

function requireExecutable(file) {
  const stats = statSync(file)
  if (!stats.isFile() || (process.platform !== 'win32' && (stats.mode & 0o111) === 0)) throw new Error('not executable')
}

function findManagedInstall(manager) {
  const override = process.env.HEADBOT_DSH_INSTALL_ROOT
  if (override) {
    const currentRoot = path.resolve(override)
    return validateInstallRoot(currentRoot)
  }
  const executable = findOnPath(manager.dshCommand || 'dsh')
  if (!executable) throw new Error('无法定位当前 DSH 可执行文件')
  const binDirectory = path.dirname(executable)
  if (path.basename(binDirectory) !== '.bin' || path.basename(path.dirname(binDirectory)) !== 'node_modules') {
    throw new Error('当前 DSH 安装不在可安全切换的 versions/current 目录中')
  }
  return validateInstallRoot(path.resolve(binDirectory, '..', '..'))
}

function validateInstallRoot(currentRoot) {
  if (path.basename(currentRoot) !== 'current') throw new Error('DSH 安装根目录必须以 current 目录链接结尾')
  const appRoot = path.dirname(currentRoot)
  if (path.basename(appRoot) !== 'DeepSeekHarness') throw new Error('未识别的 DeepSeek Harness 安装目录')
  return { currentRoot, appRoot }
}

function extractVersion(output) {
  const match = String(output).match(/\b(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?\b/)
  if (!match) throw new Error('无法从 dsh --version 输出读取版本号')
  return match[0]
}

export class HeadbotRuntimeUpdater {
  constructor({ manager, logger, fetchImpl = globalThis.fetch, spawnImpl = spawnProcess, dshCommand } = {}) {
    if (!manager?.root || !manager?.parentHome) throw new Error('a Headbot manager with root and parentHome is required')
    if (typeof fetchImpl !== 'function') throw new Error('fetch is not available for version checks')
    this.manager = manager
    this.logger = logger
    this.fetchImpl = fetchImpl
    this.spawnImpl = spawnImpl
    this.dshCommand = dshCommand || manager.dshCommand || 'dsh'
    this.stateFile = path.join(manager.root, 'dsh-update-state.json')
    this.cache = new Map()
    this.checking = new Map()
  }

  async check({ force = false } = {}) {
    const [dsh, dsBot] = await Promise.all([this.getDshStatus(force), this.getBotStatus(force)])
    let updateState = await this.readState()
    if (updateState && dsh.currentVersion === updateState.targetVersion && BUSY_STATES.has(updateState.state)) {
      updateState = { ...updateState, state: 'completed', message: `已升级到 ${dsh.currentVersion}`, completedAt: new Date().toISOString() }
      await this.writeState(updateState)
    }
    dsh.state = updateState?.state || 'idle'
    dsh.message = updateState?.message || ''
    if (BUSY_STATES.has(dsh.state)) dsh.updateAvailable = false
    return { dsh, dsBot }
  }

  async getDshStatus(force) {
    let currentVersion = null
    let currentError = null
    try {
      const { command, args } = this.manager.commandFor(['--version'])
      const output = await runFile(command, args, { cwd: this.manager.parentHome, timeoutMs: 10_000 })
      currentVersion = extractVersion(`${output.stdout}\n${output.stderr}`)
    } catch (error) { currentError = safeMessage(error) }
    let latestVersion = null
    let checkError = null
    try { latestVersion = await this.registryVersion('dsh', force) } catch (error) { checkError = safeMessage(error) }
    let canUpdate = false
    let updateError = null
    try { findManagedInstall({ ...this.manager, dshCommand: this.dshCommand }); canUpdate = true } catch (error) { updateError = safeMessage(error) }
    return {
      currentVersion,
      latestVersion,
      updateAvailable: Boolean(currentVersion && latestVersion && compareRuntimeVersions(latestVersion, currentVersion) > 0),
      releaseUrl: latestVersion ? `https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v${latestVersion}` : null,
      checkError: checkError || currentError || null,
      canUpdate,
      updateError,
    }
  }

  async getBotStatus(force) {
    let latestVersion = null
    let checkError = null
    try { latestVersion = await this.registryVersion('ds-bot', force) } catch (error) { checkError = safeMessage(error) }
    let instances = []
    let currentError = null
    try { instances = await this.manager.getBotVersions() } catch (error) { currentError = safeMessage(error) }
    return {
      latestVersion,
      instances,
      updateAvailable: Boolean(latestVersion && instances.some(instance => !instance.currentVersion || compareRuntimeVersions(latestVersion, instance.currentVersion) > 0)),
      checkError: checkError || currentError || null,
    }
  }

  async registryVersion(packageName, force) {
    const cached = this.cache.get(packageName)
    if (!force && cached && Date.now() - cached.checkedAt < CACHE_MS) return cached.version
    let pending = this.checking.get(packageName)
    if (!pending) {
      pending = this.fetchRegistryVersion(packageName).then(version => {
        this.cache.set(packageName, { version, checkedAt: Date.now() })
        return version
      }).finally(() => this.checking.delete(packageName))
      this.checking.set(packageName, pending)
    }
    return pending
  }

  async fetchRegistryVersion(packageName) {
    const endpoint = packageName === 'dsh' ? DSH_PACKAGE_URL : BOT_PACKAGE_URL
    const response = await this.fetchImpl(endpoint, {
      headers: { Accept: 'application/vnd.npm.install-v1+json', 'User-Agent': 'ds-headbot/runtime-version-check' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`)
    const metadata = await response.json()
    const version = packageName === 'dsh' ? metadata?.['dist-tags']?.next : metadata?.version
    parseVersion(version)
    return version
  }

  async startDshUpgrade() {
    const status = await this.check({ force: true })
    const dsh = status.dsh
    if (dsh.checkError) throw httpError(503, `检查 DSH 最新版本失败：${dsh.checkError}`)
    if (!dsh.canUpdate) throw httpError(501, dsh.updateError || '当前 DSH 安装不支持通过管理页安全升级')
    if (!dsh.updateAvailable) throw httpError(409, '当前 DSH 已是最新版本')
    if (BUSY_STATES.has(dsh.state)) throw httpError(409, 'DSH 升级已在进行中')
    let install
    try { install = findManagedInstall({ ...this.manager, dshCommand: this.dshCommand }) } catch (error) { throw httpError(501, safeMessage(error)) }
    const updateScript = path.join(install.appRoot, 'bin', 'update.sh')
    try { await access(updateScript) } catch { throw httpError(501, '找不到 DSH 的安全升级脚本；请在管理页先配置可回退的版本安装') }
    const state = {
      state: 'installing',
      targetVersion: dsh.latestVersion,
      startedAt: new Date().toISOString(),
      message: '正在准备 DSH 更新；现有数据会先备份，失败时会回退',
    }
    await this.writeState(state)
    const config = {
      appRoot: install.appRoot,
      currentRoot: install.currentRoot,
      dataHome: this.manager.parentHome,
      expectedVersion: dsh.latestVersion,
      stateFile: this.stateFile,
      updateScript,
      manualWebUpgrade: true,
    }
    let child
    try {
      child = this.spawnImpl(process.execPath, [WORKER_PATH, JSON.stringify(config)], {
        cwd: this.manager.parentHome,
        env: { ...process.env, DSH_HOME: this.manager.parentHome },
        detached: true,
        stdio: 'ignore',
      })
      child.once('error', error => this.markFailure(dsh.latestVersion, safeMessage(error)))
      child.once('exit', (code, signal) => {
        if (code !== 0) this.markFailure(dsh.latestVersion, `DSH 升级后台任务异常退出（${code ?? signal ?? 'unknown'}）`)
      })
      child.unref()
    } catch (error) {
      await this.writeState({ ...state, state: 'failed', message: safeMessage(error), failedAt: new Date().toISOString() })
      throw httpError(500, `无法启动 DSH 升级：${safeMessage(error)}`)
    }
    this.logger?.info?.(`[ds-headbot] started DSH update to ${dsh.latestVersion}`)
    return { ...dsh, state: 'installing', message: '正在准备 DSH 更新；现有数据会先备份，失败时会回退' }
  }

  async markFailure(targetVersion, message) {
    try {
      const state = await this.readState()
      if (state?.targetVersion !== targetVersion || !BUSY_STATES.has(state.state)) return
      await this.writeState({ ...state, state: 'failed', message: safeMessage(message), failedAt: new Date().toISOString() })
    } catch (error) {
      this.logger?.error?.(`[ds-headbot] unable to record DSH updater failure: ${safeMessage(error)}`)
    }
  }

  async readState() {
    try { return JSON.parse(await readFile(this.stateFile, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
  }

  writeState(value) {
    return atomicWriteJson(this.stateFile, value)
  }
}

async function readInstalledVersion(currentRoot) {
  const executable = path.join(currentRoot, 'node_modules', '.bin', 'dsh')
  const output = await runFile(executable, ['--version'], { timeoutMs: 10_000 })
  return extractVersion(`${output.stdout}\n${output.stderr}`)
}

async function runDshUpdateWorker(config) {
  const state = { state: 'installing', targetVersion: config.expectedVersion, startedAt: new Date().toISOString(), message: '正在安装 DSH 更新' }
  try {
    await atomicWriteJson(config.stateFile, state)
    const currentLink = await lstat(config.currentRoot)
    if (!currentLink.isSymbolicLink()) throw new Error('current 不是可回退的版本链接')
    const currentRealPath = await realpath(config.currentRoot)
    if (!currentRealPath.startsWith(`${path.join(config.appRoot, 'versions')}${path.sep}`)) throw new Error('current 版本链接指向 DeepSeek Harness 版本目录之外')
    const updateScriptRealPath = await realpath(config.updateScript)
    if (!updateScriptRealPath.startsWith(`${config.appRoot}${path.sep}`)) throw new Error('DSH 更新脚本不在安装目录中')
    const marker = path.join(config.appRoot, 'state', 'last-check-epoch')
    await mkdir(path.dirname(marker), { recursive: true, mode: 0o700 })
    await writeFile(marker, '0\n', { mode: 0o600 })
    const child = spawnProcess('/bin/sh', [config.updateScript], {
      cwd: config.appRoot,
      env: {
        ...process.env,
        DSH_HOME: config.dataHome,
        HEADBOT_DSH_WEB_UPGRADE: config.manualWebUpgrade ? '1' : '0',
      },
      stdio: 'ignore',
    })
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    if (code !== 0) throw new Error(`DSH update script exited with ${code}`)
    await atomicWriteJson(config.stateFile, { ...state, state: 'restarting', message: '正在重启 DSH 并验证目标版本' })
    const deadline = Date.now() + 120_000
    let activeVersion = null
    while (Date.now() < deadline) {
      try { activeVersion = await readInstalledVersion(config.currentRoot) } catch {}
      if (activeVersion === config.expectedVersion) {
        await atomicWriteJson(config.stateFile, { ...state, state: 'completed', message: `已升级到 ${activeVersion}`, completedAt: new Date().toISOString() })
        return
      }
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    const message = activeVersion ? `升级脚本结束后仍为 DSH ${activeVersion}；可能因活跃连接延后，请查看 update.log` : '升级后无法读取 DSH 版本；请检查服务日志并使用备份回退'
    await atomicWriteJson(config.stateFile, { ...state, state: 'deferred', message, activeVersion, failedAt: new Date().toISOString() })
  } catch (error) {
    await atomicWriteJson(config.stateFile, { ...state, state: 'failed', message: safeMessage(error), failedAt: new Date().toISOString() })
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.argv[2]) {
  let config
  try { config = JSON.parse(process.argv[2]) } catch { throw new Error('invalid DSH update worker configuration') }
  void runDshUpdateWorker(config)
}
