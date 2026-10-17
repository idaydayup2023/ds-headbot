import { spawn } from 'node:child_process'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { access, appendFile, chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createServer as netCreateServer } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/
const DEFAULT_BOT_PACKAGE = 'ds-bot'
const SESSION_GRANT = 'client-connection/browser-session'

export class HeadbotManager {
  constructor(config = {}, options = {}) {
    this.config = config
    this.parentHome = resolveUserPath(options.parentHome || config.dshHome || path.join(homedir(), '.dsh'))
    this.root = resolveUserPath(config.dataDir || path.join(this.parentHome, 'headbot'))
    this.stateFile = path.join(this.root, 'teams.json')
    this.logRoot = path.join(this.root, 'logs')
    this.parentPort = Number(options.parentPort)
    if (!Number.isInteger(this.parentPort) || this.parentPort < 1 || this.parentPort > 65535) {
      throw new Error('the controller webServer must expose a valid TCP port')
    }
    this.parentHost = options.parentHost || '127.0.0.1'
    this.logger = options.logger
    this.publicHost = validatePublicHost(options.publicHost || config.publicHost || process.env.HEADBOT_PUBLIC_HOST || 'localhost')
    this.controllerPath = validatePathSegment(config.controllerPath || 'dsh', 'controllerPath')
    this.teamsPath = validatePathSegment(config.teamsPath || 'teams', 'teamsPath')
    if (this.controllerPath === this.teamsPath) throw new Error('controllerPath and teamsPath must be different')
    this.ingressPort = validPort(config.ingressPort ?? 3180, 'ingressPort')
    if (this.ingressPort === this.parentPort) throw new Error('ingressPort must differ from the controller DSH port')
    this.dshCommand = config.dshCommand || process.env.HEADBOT_DSH_COMMAND || 'dsh'
    this.botPackage = config.botPackage || DEFAULT_BOT_PACKAGE
    this.inheritModelSettings = config.inheritModelSettings !== false
    this.teams = []
    this.runtime = new Map()
    this.loaded = false
    this.initializing = undefined
    this.writeQueue = Promise.resolve()
    this.mutationQueue = Promise.resolve()
    this.closing = false
  }

  async initialize() {
    if (this.loaded) return
    if (this.initializing) return this.initializing
    this.initializing = this.initializeState().finally(() => { this.initializing = undefined })
    return this.initializing
  }

  async initializeState() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await mkdir(this.logRoot, { recursive: true, mode: 0o700 })
    await chmod(this.root, 0o700)
    await chmod(this.logRoot, 0o700)
    try {
      const document = JSON.parse(await readFile(this.stateFile, 'utf8'))
      if (![1, 2].includes(document.version) || !Array.isArray(document.teams)) {
        throw new Error('unsupported teams.json format; preserve the file and inspect it before repair')
      }
      if (document.version === 1) await copyIfAbsent(this.stateFile, path.join(this.root, 'teams.v1.backup.json'), 0o600)
      this.teams = document.teams.map(team => validateStoredTeam(team, document.version === 2))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      this.teams = []
    }
    this.assertUniqueConfig()
    // Persist identities when opening state written by version 0.1.
    await this.save()
    this.loaded = true
  }

  async listTeams() {
    await this.initialize()
    return this.teams.map(team => this.present(team))
  }

  async getTeam(id) {
    await this.initialize()
    const team = this.findTeam(id)
    if (!team) throw httpError(404, `team "${id}" not found`)
    return this.present(team)
  }

  async createTeam(input) {
    await this.initialize()
    return this.withMutation(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'team must be an object')
      const id = validateId(input.id)
      if (this.findTeam(id)) throw httpError(409, `team id "${id}" already exists`)
      const team = {
        id,
        name: validateName(input.name),
        port: validPort(input.port, 'port'),
        autoStart: input.autoStart !== false,
        botInstalled: false,
        settingsSeeded: false,
        createdAt: new Date().toISOString(),
        instanceId: randomUUID(),
        communicationToken: randomBytes(32).toString('hex'),
      }
      await this.ensurePortAvailable(team.port, id)
      this.teams.push(team)
      try {
        await this.save()
      } catch (error) {
        this.teams = this.teams.filter(item => item !== team)
        throw error
      }
      return this.present(team)
    })
  }

  async updateTeam(id, input) {
    await this.initialize()
    return this.withMutation(async () => {
      const team = this.findTeam(id)
      if (!team) throw httpError(404, `team "${id}" not found`)
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'update must be an object')
      const runtime = this.runtime.get(id)
      if (runtime?.deleting) throw httpError(409, 'this team is being deleted')
      const previous = { name: team.name, port: team.port, autoStart: team.autoStart }
      const next = { ...previous }
      if (input.port !== undefined && Number(input.port) !== team.port) {
        if (runtime?.child || runtime?.command || runtime?.task) throw httpError(409, 'stop the team before changing its port')
        const newPort = validPort(input.port, 'port')
        await this.ensurePortAvailable(newPort, id)
        next.port = newPort
      }
      if (input.name !== undefined) next.name = validateName(input.name)
      if (input.autoStart !== undefined) {
        if (typeof input.autoStart !== 'boolean') throw httpError(400, 'autoStart must be a boolean')
        next.autoStart = input.autoStart
      }
      Object.assign(team, next)
      try {
        await this.save()
      } catch (error) {
        Object.assign(team, previous)
        throw error
      }
      return this.present(team)
    })
  }

  async startEnabledTeams() {
    await this.initialize()
    for (const team of this.teams) {
      if (team.autoStart) {
        void this.startTeam(team.id).catch(error => this.warn(`start ${team.id}: ${safeError(error)}`))
      }
    }
  }

  async authenticateTeam(authorization) {
    await this.initialize()
    if (typeof authorization !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(authorization)) return undefined
    const token = Buffer.from(authorization.slice(7))
    const team = this.teams.find(item => timingSafeEqual(token, Buffer.from(item.communicationToken)))
    return team ? this.identity(team) : undefined
  }

  identity(team) {
    return { id: team.id, name: team.name, instanceId: team.instanceId }
  }

  async deleteTeam(id) {
    await this.initialize()
    return this.withMutation(async () => {
      const team = this.findTeam(id)
      if (!team) throw httpError(404, `team "${id}" not found`)
      const runtime = this.runtime.get(id) ?? newRuntime()
      if (runtime.updating) throw httpError(409, 'wait for the DS Bot update before deleting this team')
      this.runtime.set(id, runtime)
      runtime.deleting = true
      let archivePath
      let moved = false
      const previous = this.teams
      try {
        await this.stopTeam(id)
        const archiveRoot = path.join(this.root, 'archives')
        await mkdir(archiveRoot, { recursive: true, mode: 0o700 })
        await chmod(archiveRoot, 0o700)
        const destination = path.join(archiveRoot, `${id}-${team.instanceId}-${Date.now()}`)
        try {
          await rename(path.join(this.root, 'teams', id), destination)
          moved = true
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
          await mkdir(destination, { mode: 0o700 })
        }
        archivePath = destination
        await writeFile(path.join(destination, 'instance.json'), JSON.stringify({ version: 2, team }, null, 2) + '\n', { mode: 0o600 })
        await chmod(path.join(destination, 'instance.json'), 0o600)
        this.teams = previous.filter(item => item !== team)
        await this.save()
        this.runtime.delete(id)
        return { id, instanceId: team.instanceId, archivePath, dataPreserved: true }
      } catch (error) {
        this.teams = previous
        if (moved && archivePath) await rename(archivePath, path.join(this.root, 'teams', id))
        throw error
      } finally {
        runtime.deleting = false
      }
    })
  }

  async startTeam(id) {
    await this.initialize()
    const team = this.findTeam(id)
    if (!team) throw httpError(404, `team "${id}" not found`)
    let runtime = this.runtime.get(id)
    if (!runtime) {
      runtime = newRuntime()
      this.runtime.set(id, runtime)
    }
    if (runtime.deleting) throw httpError(409, 'this team is being deleted')
    if (runtime.updating) throw httpError(409, 'wait for the DS Bot update to finish before starting this team')
    if (runtime.command) throw httpError(409, 'a DSH plugin operation is already running for this team')
    if (runtime.child && runtime.phase !== 'stopped') return
    if (runtime.task) return runtime.task
    runtime.stopRequested = false
    runtime.explicitStop = false
    runtime.phase = team.botInstalled ? 'starting' : 'provisioning'
    runtime.message = ''
    runtime.launchUrl = undefined
    runtime.task = this.startRoutine(team, runtime).finally(() => { runtime.task = undefined })
    return runtime.task
  }

  async stopTeam(id) {
    await this.initialize()
    const team = this.findTeam(id)
    if (!team) throw httpError(404, `team "${id}" not found`)
    const runtime = this.runtime.get(id)
    if (!runtime) {
      this.runtime.set(id, { ...newRuntime(), phase: 'stopped' })
      return
    }
    runtime.stopRequested = true
    runtime.explicitStop = true
    runtime.phase = runtime.deleting ? 'deleting' : 'stopping'
    clearTimeout(runtime.restartTimer)
    if (runtime.command) {
      signalProcessTree(runtime.command, 'SIGTERM')
      await waitForClose(runtime.command, runtime.commandDone)
    }
    if (runtime.child) await terminate(runtime.child)
    if (runtime.task) await runtime.task
    runtime.phase = 'stopped'
    runtime.message = ''
    runtime.launchUrl = undefined
  }

  async restartTeam(id) {
    if (this.runtime.get(id)?.updating) throw httpError(409, 'wait for the DS Bot update to finish before restarting this team')
    await this.stopTeam(id)
    const runtime = this.runtime.get(id)
    if (!runtime || runtime.deleting) throw httpError(409, 'this team is being deleted')
    runtime.stopRequested = false
    runtime.explicitStop = false
    return this.startTeam(id)
  }

  async updateBot(id) {
    await this.initialize()
    const team = this.findTeam(id)
    if (!team) throw httpError(404, `team "${id}" not found`)
    let runtime = this.runtime.get(id)
    if (runtime?.deleting) throw httpError(409, 'this team is being deleted')
    if (runtime?.updating) throw httpError(409, 'a DS Bot update is already running for this team')
    if (!runtime) {
      runtime = newRuntime()
      this.runtime.set(id, runtime)
    }
    runtime.updating = true
    try {
      await this.stopTeam(id)
      await this.provisionHome(team)
      runtime.phase = 'updating'
      runtime.message = ''
      const args = team.botInstalled
        ? ['plugin', '--profile', 'web', 'update', '--latest', this.botPackage]
        : ['plugin', '--profile', 'web', 'add', this.botPackage]
      await this.runDsh(args, team, runtime)
      team.botInstalled = true
      await this.save()
    } catch (error) {
      runtime.phase = 'failed'
      runtime.message = safeError(error)
      throw error
    } finally {
      runtime.updating = false
    }
    runtime.stopRequested = false
    runtime.explicitStop = false
    return this.startTeam(id)
  }

  async close() {
    this.closing = true
    const ids = [...this.runtime.keys()]
    await Promise.all(ids.map(id => this.stopTeam(id).catch(error => this.warn(`stop ${id}: ${safeError(error)}`))))
  }

  async startRoutine(team, runtime) {
    try {
      await this.provisionHome(team)
      if (runtime.stopRequested || this.closing) return
      if (!team.botInstalled) {
        runtime.phase = 'provisioning'
        await this.runDsh(['plugin', '--profile', 'web', 'add', this.botPackage], team, runtime)
        team.botInstalled = true
        await this.save()
      }
      if (runtime.stopRequested || this.closing) return
      await this.ensurePortAvailable(team.port, team.id)
      runtime.phase = 'starting'
      const teamRoot = path.join(this.root, 'teams', team.id)
      const env = { ...childEnvironment(path.join(teamRoot, 'home')),
        HEADBOT_TEAM_ID: team.id,
        HEADBOT_TEAM_TOKEN: team.communicationToken,
        HEADBOT_BROKER_URL: `http://127.0.0.1:${this.parentPort}/api/ds-headbot/v1/comms/v1`,
        HEADBOT_TEAM_FILES_ROOT: path.join(teamRoot, 'workspace'),
      }
      const { command, args } = this.commandFor(['--profile', 'web', '--patch', path.join(teamRoot, 'communications.patch.yml'), '--no-open', '--host', '127.0.0.1', '--port', String(team.port), '--public-url', this.teamUrl(team), '--trusted-host', this.publicHost])
      const child = spawn(command, args, { cwd: path.join(teamRoot, 'workspace'), env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
      runtime.child = child
      runtime.pid = child.pid
      runtime.childExit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
      runtime.childDone = new Promise(resolve => child.once('close', resolve))
      child.stdout.on('data', chunk => this.consumeOutput(team, runtime, chunk))
      child.stderr.on('data', chunk => this.consumeOutput(team, runtime, chunk))
      child.once('close', () => this.consumeOutput(team, runtime, Buffer.from('\n')))
      child.once('error', error => {
        runtime.message = safeError(error)
        runtime.phase = 'failed'
        runtime.child = undefined
        runtime.pid = undefined
        runtime.childDone = undefined
      })
      child.once('exit', (code, signal) => this.onExit(team, runtime, code, signal))
      const ready = await waitForListener(team.port, runtime, 75_000)
      if (ready && runtime.child && !runtime.stopRequested) {
        runtime.phase = 'running'
        runtime.message = ''
        runtime.restartCount = 0
      } else if (runtime.child && !runtime.stopRequested) {
        const child = runtime.child
        runtime.phase = 'starting'
        runtime.message = 'DSH process is alive; waiting for its web listener.'
        void waitForListener(team.port, runtime, 10 * 60_000, child).then(lateReady => {
          if (runtime.child !== child || runtime.stopRequested || runtime.phase !== 'starting') return
          if (lateReady) {
            runtime.phase = 'running'
            runtime.message = ''
            runtime.restartCount = 0
          } else {
            runtime.message = 'DSH is still running, but its web listener has not become available after 10 minutes.'
          }
        })
      }
    } catch (error) {
      runtime.phase = runtime.stopRequested ? 'stopped' : 'failed'
      runtime.message = runtime.stopRequested ? '' : safeError(error)
      this.warn(`start ${team.id}: ${safeError(error)}`)
    }
  }

  async provisionHome(team) {
    const teamRoot = path.join(this.root, 'teams', team.id)
    const home = path.join(teamRoot, 'home')
    await mkdir(path.join(home, 'logs'), { recursive: true, mode: 0o700 })
    await mkdir(path.join(teamRoot, 'workspace'), { recursive: true, mode: 0o700 })
    await chmod(teamRoot, 0o700).catch(() => {})
    await chmod(home, 0o700).catch(() => {})
    await writeFile(path.join(teamRoot, 'communications.patch.yml'), stringify([
      { insert: [{ id: 'ds-headbot-communications', name: fileURLToPath(new URL('./team-plugin.js', import.meta.url)) }] },
    ]), { mode: 0o600 })
    if (!this.inheritModelSettings || team.settingsSeeded) return

    const settingsPath = path.join(this.parentHome, 'settings.yaml')
    await copyIfAbsent(settingsPath, path.join(home, 'settings.yaml'), 0o600)
    const credentialPath = path.join(this.parentHome, '.credentials.yaml')
    await cloneCredentialsWithoutBrowserGrant(credentialPath, path.join(home, '.credentials.yaml'))
    team.settingsSeeded = true
    await this.save()
  }

  async runDsh(args, team, runtime) {
    const env = childEnvironment(path.join(this.root, 'teams', team.id, 'home'))
    const { command, args: commandArgs } = this.commandFor(args)
    await new Promise((resolve, reject) => {
      const child = spawn(command, commandArgs, { cwd: path.join(this.root, 'teams', team.id), env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
      runtime.command = child
      runtime.commandDone = new Promise(resolve => child.once('close', resolve))
      let output = ''
      let settled = false
      let timedOut = false
      let killTimer
      const timeout = setTimeout(() => {
        timedOut = true
        signalProcessTree(child, 'SIGTERM')
        killTimer = setTimeout(() => signalProcessTree(child, 'SIGKILL'), 10_000)
        killTimer.unref?.()
      }, 10 * 60_000)
      const collect = chunk => {
        this.consumeOutput(team, runtime, chunk)
        output = (output + chunk.toString('utf8')).slice(-8000)
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      child.once('close', () => this.consumeOutput(team, runtime, Buffer.from('\n')))
      child.once('error', error => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        clearTimeout(killTimer)
        runtime.command = undefined
        runtime.commandDone = undefined
        reject(error)
      })
      let exitCode
      let exitSignal
      child.once('exit', (code, signal) => {
        exitCode = code
        exitSignal = signal
      })
      child.once('close', () => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        clearTimeout(killTimer)
        runtime.command = undefined
        runtime.commandDone = undefined
        if (timedOut) reject(new Error(`dsh ${args[0]} timed out after 10 minutes`))
        else if (exitCode === 0) resolve()
        else reject(new Error(`dsh ${args[0]} exited (${exitCode ?? exitSignal ?? 'unknown'}): ${safeError(output)}`))
      })
    })
  }

  commandFor(args) {
    const executable = this.dshCommand
    if (/\.(?:mjs|cjs|js)$/.test(executable)) return { command: process.execPath, args: [executable, ...args] }
    return { command: executable, args }
  }

  consumeOutput(team, runtime, chunk) {
    const text = chunk.toString('utf8')
    runtime.outputBuffer = (runtime.outputBuffer || '') + text
    const lines = runtime.outputBuffer.split(/\r?\n/)
    runtime.outputBuffer = lines.pop() || ''
    if (runtime.outputBuffer.length > 16_384) runtime.outputBuffer = runtime.outputBuffer.slice(-4096)
    for (const line of lines) {
      const clean = stripAnsi(line)
      const match = clean.match(/dsh web:\s*(https?:\/\/\S+)/i)
      if (match) {
        try {
          const candidate = new URL(match[1])
          const expectedPath = `/${this.teamsPath}/${team.id}/`
          if (candidate.protocol === 'https:' && candidate.hostname === this.publicHost && candidate.port === '' && candidate.pathname.startsWith(expectedPath) && candidate.searchParams.has('token')) {
            runtime.launchUrl = candidate.toString()
          }
        } catch {}
      }
      const log = path.join(this.logRoot, `${team.id}-${team.instanceId}.log`)
      void appendFile(log, `${redactTokens(clean)}\n`, { mode: 0o600 })
        .then(() => chmod(log, 0o600))
        .catch(error => this.warn(`write ${team.id} log: ${safeError(error)}`))
    }
  }

  onExit(team, runtime, code, signal) {
    runtime.child = undefined
    runtime.pid = undefined
    runtime.childExit = undefined
    runtime.childDone = undefined
    runtime.launchUrl = undefined
    if (runtime.stopRequested || runtime.explicitStop || this.closing) {
      runtime.phase = 'stopped'
      runtime.message = ''
      return
    }
    runtime.phase = 'failed'
    runtime.message = `DSH exited (${code ?? signal ?? 'unknown'}). See the team log in the Headbot data folder.`
    this.warn(`team ${team.id} exited (${code ?? signal ?? 'unknown'})`)
    if (team.autoStart) {
      runtime.restartCount += 1
      const delay = Math.min(60_000, 1000 * (2 ** Math.min(runtime.restartCount - 1, 6)))
      runtime.restartTimer = setTimeout(() => {
        runtime.restartTimer = undefined
        if (!this.closing && !runtime.explicitStop) void this.startTeam(team.id)
      }, delay)
    }
  }

  async ensurePortAvailable(port, teamId) {
    if ([80, 443, this.ingressPort, this.parentPort].includes(port)) {
      throw httpError(409, `port ${port} is reserved by Headbot or the controller`)
    }
    for (const other of this.teams) {
      if (other.id !== teamId && other.port === port) throw httpError(409, `port ${port} is already assigned to team "${other.id}"`)
    }
    await assertPortFree(port)
  }

  teamUrl(team) {
    return `https://${this.publicHost}/${this.teamsPath}/${team.id}/`
  }

  present(team) {
    const runtime = this.runtime.get(team.id) ?? newRuntime()
    return {
      id: team.id,
      instanceId: team.instanceId,
      name: team.name,
      port: team.port,
      autoStart: team.autoStart,
      botInstalled: team.botInstalled,
      status: runtime.deleting ? 'deleting' : runtime.phase,
      message: runtime.message,
      pid: runtime.pid,
      url: this.teamUrl(team),
      launchUrl: runtime.launchUrl,
      restartCount: runtime.restartCount,
    }
  }

  findTeam(id) {
    return this.teams.find(team => team.id === id)
  }

  assertUniqueConfig() {
    const seen = new Set()
    const ids = new Set()
    const identities = new Set()
    const tokens = new Set()
    for (const team of this.teams) {
      validateStoredTeam(team, true)
      if (ids.has(team.id)) throw new Error(`teams.json repeats team id ${team.id}`)
      if (identities.has(team.instanceId) || tokens.has(team.communicationToken)) throw new Error('teams.json repeats a communication identity')
      if (seen.has(team.port)) throw new Error(`teams.json assigns port ${team.port} more than once`)
      if ([80, 443, this.ingressPort, this.parentPort].includes(team.port)) throw new Error(`teams.json assigns reserved port ${team.port}`)
      seen.add(team.port)
      ids.add(team.id)
      identities.add(team.instanceId)
      tokens.add(team.communicationToken)
    }
  }

  async save() {
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      const document = JSON.stringify({ version: 2, teams: this.teams }, null, 2) + '\n'
      const temporary = `${this.stateFile}.${process.pid}.tmp`
      await writeFile(temporary, document, { mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, this.stateFile)
    })
    return this.writeQueue
  }

  withMutation(operation) {
    const result = this.mutationQueue.then(operation)
    this.mutationQueue = result.catch(() => {})
    return result
  }

  warn(message) {
    if (this.logger?.warn) this.logger.warn(`[ds-headbot] ${message}`)
    else console.warn(`[ds-headbot] ${message}`)
  }
}

function newRuntime() {
  return {
    phase: 'stopped',
    message: '',
    launchUrl: undefined,
    pid: undefined,
    child: undefined,
    command: undefined,
    task: undefined,
    restartTimer: undefined,
    restartCount: 0,
    stopRequested: false,
    explicitStop: false,
  }
}

function validateStoredTeam(team, requireIdentity = false) {
  if (!team || typeof team !== 'object') throw new Error('teams.json contains an invalid team entry')
  const identityValid = typeof team.instanceId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(team.instanceId)
  const tokenValid = typeof team.communicationToken === 'string' && /^[a-f0-9]{64}$/.test(team.communicationToken)
  if (requireIdentity && (!identityValid || !tokenValid)) throw new Error('teams.json contains an invalid communication identity; preserve and repair the state')
  return {
    id: validateId(team.id),
    name: validateName(team.name),
    port: validPort(team.port, 'port'),
    autoStart: team.autoStart !== false,
    botInstalled: team.botInstalled === true,
    settingsSeeded: team.settingsSeeded === true,
    createdAt: typeof team.createdAt === 'string' ? team.createdAt : new Date(0).toISOString(),
    instanceId: identityValid ? team.instanceId : randomUUID(),
    communicationToken: tokenValid ? team.communicationToken : randomBytes(32).toString('hex'),
  }
}

function validateId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw httpError(400, 'team id must be a lowercase URL-safe slug (letters, digits, hyphens)')
  return value
}

function validateName(value) {
  if (typeof value !== 'string') throw httpError(400, 'team name is required')
  const name = value.trim()
  if (!name || name.length > 80) throw httpError(400, 'team name must be between 1 and 80 characters')
  return name
}

function validPort(value, label) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw httpError(400, `${label} must be an integer from 1024 to 65535`)
  return port
}

function validatePathSegment(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error(`${label} must be a lowercase URL-safe path segment`)
  return value
}

function validatePublicHost(value) {
  if (typeof value !== 'string' || value.length > 253 || !/^[A-Za-z0-9.-]+$/.test(value) || value.startsWith('.') || value.endsWith('.') || value.includes('..')) {
    throw new Error('publicHost must be a DNS name or IPv4 address; IPv6 is not supported by this version')
  }
  const host = value.toLowerCase()
  const numeric = /^[0-9.]+$/.test(host)
  if (numeric) {
    const octets = host.split('.')
    if (octets.length !== 4 || octets.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
      throw new Error('publicHost contains an invalid IPv4 address')
    }
  } else if (host.split('.').some(label => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error('publicHost contains an invalid DNS label')
  }
  return host
}

function resolveUserPath(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return path.resolve(homedir(), value.slice(2))
  return path.resolve(value)
}

function childEnvironment(home) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('DSH_') || key.startsWith('HEADBOT_TEAM_') || key === 'HEADBOT_BROKER_URL') delete env[key]
  env.DSH_HOME = home
  return env
}

async function copyIfAbsent(source, destination, mode) {
  try {
    await access(source)
    await copyFile(source, destination, constants.COPYFILE_EXCL)
    await chmod(destination, mode)
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'EEXIST') throw error
  }
}

async function cloneCredentialsWithoutBrowserGrant(source, destination) {
  let raw
  try {
    raw = await readFile(source, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  const document = parse(raw)
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('parent .credentials.yaml is not a valid DSH credential document')
  }
  if (document.records && typeof document.records === 'object') delete document.records[SESSION_GRANT]
  await writeFile(destination, stringify(document), { mode: 0o600, flag: 'wx' }).catch(error => {
    if (error.code !== 'EEXIST') throw error
  })
  await chmod(destination, 0o600).catch(() => {})
}

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const server = netCreateServer()
    server.once('error', error => reject(error.code === 'EADDRINUSE' ? httpError(409, `port ${port} is already in use`) : error))
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()))
  })
}

function httpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function safeError(value) {
  return redactTokens(String(value).replace(/\s+/g, ' ').slice(0, 1000))
}

function redactTokens(value) {
  return value.replace(/([?&]token=)[^&\s"']+/gi, '$1[redacted]')
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '')
}

function waitForListener(port, runtime, timeoutMs, expectedChild = runtime.child) {
  const deadline = Date.now() + timeoutMs
  return new Promise(resolve => {
    const poll = () => {
      if (runtime.stopRequested || !expectedChild || runtime.child !== expectedChild || expectedChild.exitCode !== null) return resolve(false)
      const request = httpRequest({ hostname: '127.0.0.1', port, path: '/', method: 'GET', timeout: 750 }, response => {
        response.resume()
        resolve([200, 301, 302, 401].includes(response.statusCode))
      })
      request.on('error', () => Date.now() >= deadline ? resolve(false) : setTimeout(poll, 350))
      request.on('timeout', () => request.destroy())
      request.end()
    }
    poll()
  })
}

function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  signalProcessTree(child, 'SIGTERM')
  return waitForClose(child, new Promise(resolve => child.once('close', resolve)))
}

function signalProcessTree(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {}
  }
  try { child.kill(signal) } catch {}
}

function waitForClose(child, done) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => signalProcessTree(child, 'SIGKILL'), 10_000)
    void Promise.resolve(done).then(finish, finish)
  })
}

