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
const FEISHU_PLUGIN_PACKAGE = '@zyfgood/dsh-feishu-bot@0.8.6'
const FEISHU_PLUGIN_NAME = '@zyfgood/dsh-feishu-bot'
const SESSION_GRANT = 'client-connection/browser-session'

export class HeadbotManager {
  constructor(config = {}, options = {}) {
    this.config = config
    this.parentHome = resolveUserPath(options.parentHome || config.dshHome || path.join(homedir(), '.dsh'))
    this.root = resolveUserPath(config.dataDir || path.join(this.parentHome, 'headbot'))
    this.stateFile = path.join(this.root, 'teams.json')
    this.feishuSecretFile = path.join(this.root, 'feishu-secrets.json')
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
    this.teamPlugins = config.teamPlugins ?? []
    if (!Array.isArray(this.teamPlugins) || this.teamPlugins.length > 20 || this.teamPlugins.some(item => typeof item !== 'string' || !item.trim() || item.startsWith('-'))) {
      throw new Error('teamPlugins must be an array of at most 20 package references')
    }
    this.inheritModelSettings = config.inheritModelSettings !== false
    this.teams = []
    this.feishuSecrets = {}
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
    await this.loadFeishuSecrets()
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
        feishuInstalled: false,
        feishu: { enabled: false, appId: '', botId: '' },
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
      const previous = { name: team.name, port: team.port, autoStart: team.autoStart, feishu: team.feishu }
      const previousSecret = this.feishuSecrets[id]
      const previousFeishuStatus = runtime?.feishuStatus
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
      if (input.feishu !== undefined) {
        const submitted = validateFeishuSettings(input.feishu)
        const suppliedSecret = input.feishu.appSecret
        let nextSecret = previousSecret
        if (suppliedSecret !== undefined && suppliedSecret !== '' && suppliedSecret !== null) {
          if (typeof suppliedSecret !== 'string' || suppliedSecret.length > 512 || suppliedSecret.trim() !== suppliedSecret || /\s/.test(suppliedSecret)) {
            throw httpError(400, 'Feishu App Secret must be a non-empty string of at most 512 characters')
          }
          nextSecret = suppliedSecret
        }
        if (input.feishu.clearAppSecret !== undefined && typeof input.feishu.clearAppSecret !== 'boolean') {
          throw httpError(400, 'clearAppSecret must be a boolean')
        }
        if (input.feishu.clearAppSecret === true) nextSecret = undefined
        const feishuChanged = submitted.enabled !== team.feishu.enabled
          || submitted.appId !== team.feishu.appId
          || submitted.botId !== team.feishu.botId
          || nextSecret !== previousSecret
        if (feishuChanged && (runtime?.child || runtime?.command || runtime?.task)) {
          throw httpError(409, 'stop the team before changing its Feishu settings')
        }
        if (submitted.enabled) {
          if (!nextSecret) throw httpError(400, 'enter the Feishu App Secret before enabling this integration')
          const duplicate = this.teams.find(other => other.id !== id && other.feishu.enabled && other.feishu.appId === submitted.appId)
          if (duplicate) throw httpError(409, `Feishu App ID is already assigned to team "${duplicate.id}"`)
          const bots = await this.getTeamBots(id)
          if (!bots.some(bot => bot.id === submitted.botId)) throw httpError(400, 'choose a Bot that exists in this team')
        }
        next.feishu = submitted
        if (nextSecret === undefined) delete this.feishuSecrets[id]
        else this.feishuSecrets[id] = nextSecret
      }
      Object.assign(team, next)
      try {
        if (input.feishu !== undefined) await this.saveFeishuSecrets()
        await this.save()
        if (input.feishu !== undefined && runtime) runtime.feishuStatus = team.feishu.enabled ? 'stopped' : 'disabled'
      } catch (error) {
        Object.assign(team, previous)
        if (runtime && previousFeishuStatus !== undefined) runtime.feishuStatus = previousFeishuStatus
        if (previousSecret === undefined) delete this.feishuSecrets[id]
        else this.feishuSecrets[id] = previousSecret
        if (input.feishu !== undefined) await this.saveFeishuSecrets().catch(() => {})
        throw error
      }
      return this.present(team)
    })
  }

  async getTeamBots(id) {
    await this.initialize()
    const team = this.findTeam(id)
    if (!team) throw httpError(404, `team "${id}" not found`)
    const stateFile = path.join(this.root, 'teams', id, 'home', 'bot', 'state.json')
    let state
    try {
      state = JSON.parse(await readFile(stateFile, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw new Error('unable to read this team’s DS Bot list')
    }
    const bots = state?.bots && typeof state.bots === 'object' && !Array.isArray(state.bots) ? state.bots : {}
    return Object.entries(bots)
      .filter(([id, bot]) => typeof id === 'string' && bot && typeof bot.name === 'string')
      .map(([botId, bot]) => ({ id: botId, name: bot.name, role: typeof bot.role === 'string' ? bot.role : '' }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }

  async resolveFeishuTargetSession(team) {
    const stateFile = path.join(this.root, 'teams', team.id, 'home', 'bot', 'state.json')
    let state
    try {
      state = JSON.parse(await readFile(stateFile, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') throw httpError(409, 'open the team once in DSH so its DS Bot list is initialized')
      throw new Error('unable to read the selected DS Bot state')
    }
    const bot = state?.bots?.[team.feishu.botId]
    if (!bot) throw httpError(409, 'the selected DS Bot no longer exists; choose another Bot in team settings')
    const sessionId = typeof bot.sessionId === 'string' && bot.sessionId ? bot.sessionId : team.feishu.botId
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId)) throw new Error('the selected DS Bot has an invalid DSH session ID')
    return sessionId
  }

  watchFeishuTarget(team, runtime) {
    clearInterval(runtime.feishuMonitor)
    runtime.feishuMonitor = undefined
    runtime.feishuRebinding = false
    if (!team.feishu.enabled || !runtime.feishuAgentId) return
    runtime.feishuMonitor = setInterval(async () => {
      if (!runtime.child || runtime.phase !== 'running' || runtime.feishuRebinding) return
      try {
        const currentSession = await this.resolveFeishuTargetSession(team)
        if (currentSession === runtime.feishuAgentId) return
        runtime.feishuRebinding = true
        runtime.message = 'DS Bot 会话已切换，正在刷新飞书绑定…'
        void this.restartTeam(team.id)
          .catch(error => this.warn(`refresh Feishu binding ${team.id}: ${safeError(error)}`))
          .finally(() => { runtime.feishuRebinding = false })
      } catch (error) {
        this.warn(`check Feishu binding ${team.id}: ${safeError(error)}`)
      }
    }, 30_000)
    runtime.feishuMonitor.unref?.()
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
      const previousSecret = this.feishuSecrets[id]
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
        delete this.feishuSecrets[id]
        await this.saveFeishuSecrets()
        await this.save()
        this.runtime.delete(id)
        return { id, instanceId: team.instanceId, archivePath, dataPreserved: true }
      } catch (error) {
        this.teams = previous
        if (previousSecret === undefined) delete this.feishuSecrets[id]
        else this.feishuSecrets[id] = previousSecret
        await this.saveFeishuSecrets().catch(() => {})
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
    runtime.feishuStatus = team.feishu.enabled ? 'connecting' : 'disabled'
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
    clearInterval(runtime.feishuMonitor)
    runtime.feishuMonitor = undefined
    if (runtime.command) {
      signalProcessTree(runtime.command, 'SIGTERM')
      await waitForClose(runtime.command, runtime.commandDone)
    }
    if (runtime.child) await terminate(runtime.child)
    if (runtime.task) await runtime.task
    runtime.phase = 'stopped'
    runtime.message = ''
    runtime.launchUrl = undefined
    runtime.feishuStatus = team.feishu.enabled ? 'stopped' : 'disabled'
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
      runtime.message = this.teamError(error, team)
      throw error
    } finally {
      runtime.updating = false
    }
    runtime.stopRequested = false
    runtime.explicitStop = false
    runtime.skipNextBotUpdate = true
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
        for (const packageRef of [this.botPackage, ...this.teamPlugins]) {
          await this.runDsh(['plugin', '--profile', 'web', 'add', packageRef], team, runtime)
          if (runtime.stopRequested || this.closing) return
        }
        team.botInstalled = true
        await this.save()
      } else if (runtime.skipNextBotUpdate) {
        runtime.skipNextBotUpdate = false
      } else {
        runtime.phase = 'updating'
        try {
          await this.runDsh(['plugin', '--profile', 'web', 'update', '--latest', this.botPackage], team, runtime)
          runtime.message = ''
        } catch (error) {
          runtime.message = `自动更新 DS Bot 失败，沿用已安装版本：${this.teamError(error, team)}`
          this.warn(`team ${team.id}: ${runtime.message}`)
        }
      }
      if (team.feishu.enabled && !team.feishuInstalled) {
        runtime.phase = 'provisioning'
        await this.runDsh(['plugin', '--profile', 'web', 'add', FEISHU_PLUGIN_PACKAGE], team, runtime)
        team.feishuInstalled = true
        await this.save()
      }
      if (runtime.stopRequested || this.closing) return
      await this.ensurePortAvailable(team.port, team.id)
      runtime.phase = 'starting'
      const teamRoot = path.join(this.root, 'teams', team.id)
      const teamHome = path.join(teamRoot, 'home')
      const botFilesRoot = path.join(teamHome, 'bot', 'workspace')
      const env = { ...childEnvironment(path.join(teamRoot, 'home')),
        HEADBOT_TEAM_ID: team.id,
        HEADBOT_TEAM_TOKEN: team.communicationToken,
        HEADBOT_BROKER_URL: `http://127.0.0.1:${this.parentPort}/api/ds-headbot/v1/comms/v1`,
        HEADBOT_TEAM_FILES_ROOT: path.join(teamRoot, 'workspace'),
        HEADBOT_TEAM_BOT_FILES_ROOT: botFilesRoot,
      }
      if (team.feishu.enabled) {
        const appSecret = this.feishuSecrets[team.id]
        if (!appSecret) throw new Error('Feishu is enabled but its App Secret is missing; edit the team settings')
        env.FEISHU_APP_ID = team.feishu.appId
        env.FEISHU_APP_SECRET = appSecret
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
        this.watchFeishuTarget(team, runtime)
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
            this.watchFeishuTarget(team, runtime)
          } else {
            runtime.message = 'DSH is still running, but its web listener has not become available after 10 minutes.'
          }
        })
      }
    } catch (error) {
      runtime.phase = runtime.stopRequested ? 'stopped' : 'failed'
      runtime.feishuStatus = team.feishu.enabled ? (runtime.stopRequested ? 'stopped' : 'failed') : 'disabled'
      runtime.message = runtime.stopRequested ? '' : this.teamError(error, team)
      this.warn(`start ${team.id}: ${this.teamError(error, team)}`)
    }
  }

  async provisionHome(team) {
    const teamRoot = path.join(this.root, 'teams', team.id)
    const home = path.join(teamRoot, 'home')
    await mkdir(path.join(home, 'logs'), { recursive: true, mode: 0o700 })
    await mkdir(path.join(home, 'bot', 'workspace'), { recursive: true, mode: 0o700 })
    await mkdir(path.join(teamRoot, 'workspace'), { recursive: true, mode: 0o700 })
    await chmod(teamRoot, 0o700).catch(() => {})
    await chmod(home, 0o700).catch(() => {})
    const patch = [
      { insert: [{ id: 'ds-headbot-communications', name: fileURLToPath(new URL('./team-plugin.js', import.meta.url)) }] },
    ]
    if (team.feishu.enabled) {
      const agentId = await this.resolveFeishuTargetSession(team)
      const runtime = this.runtime.get(team.id)
      if (runtime) runtime.feishuAgentId = agentId
      patch.push({
        id: 'feishu-bot',
        name: FEISHU_PLUGIN_NAME,
        config: {
          appId: 'env:FEISHU_APP_ID',
          appSecret: 'env:FEISHU_APP_SECRET',
          domain: 'feishu',
          mode: 'agent',
          agentId,
          dmMode: 'open',
          requireMention: true,
          commands: true,
          tools: true,
        },
      })
    } else if (team.feishuInstalled) {
      patch.push({ id: 'feishu-bot', name: FEISHU_PLUGIN_NAME, disabled: true })
    }
    await writeFile(path.join(teamRoot, 'communications.patch.yml'), stringify(patch), { mode: 0o600 })
    if (!this.inheritModelSettings || team.settingsSeeded) return

    const settingsPath = path.join(this.parentHome, 'settings.yaml')
    await copyIfAbsent(settingsPath, path.join(home, 'settings.yaml'), 0o600)
    const credentialPath = path.join(this.parentHome, '.credentials.yaml')
    await cloneCredentialsWithoutBrowserGrant(credentialPath, path.join(home, '.credentials.yaml'))
    // Provider endpoints/defaults can live in the Web profile patch instead of
    // settings.yaml. Copy only model entries, never the controller or its bots.
    await cloneModelPatch(this.parentHome, home)
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
        else reject(new Error(`dsh ${args[0]} exited (${exitCode ?? exitSignal ?? 'unknown'}): ${safeError(this.redactFeishuSecret(output, team))}`))
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
      const clean = this.redactFeishuSecret(stripAnsi(line), team)
      if (team.feishu.enabled) {
        if (clean.includes('feishu: 长连接已就绪')) runtime.feishuStatus = 'connected'
        else if (clean.includes('feishu: 连接长连接失败')) runtime.feishuStatus = 'retrying'
      }
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

  redactFeishuSecret(value, team) {
    const secret = this.feishuSecrets[team.id]
    return secret ? String(value).split(secret).join('[redacted Feishu secret]') : String(value)
  }

  teamError(value, team) {
    return safeError(this.redactFeishuSecret(value instanceof Error ? value.message : value, team))
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
    runtime.feishuStatus = team.feishu.enabled ? 'offline' : 'disabled'
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
      feishu: {
        enabled: team.feishu.enabled,
        appId: team.feishu.appId,
        botId: team.feishu.botId,
        hasSecret: Boolean(this.feishuSecrets[team.id]),
        status: team.feishu.enabled ? runtime.feishuStatus : 'disabled',
      },
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

  async loadFeishuSecrets() {
    try {
      const document = JSON.parse(await readFile(this.feishuSecretFile, 'utf8'))
      if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('invalid Feishu credential document')
      for (const [id, secret] of Object.entries(document)) {
        validateId(id)
        if (typeof secret !== 'string' || !secret || secret.length > 512) throw new Error('invalid Feishu credential entry')
      }
      this.feishuSecrets = document
      await chmod(this.feishuSecretFile, 0o600)
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw new Error('unable to load the protected Feishu credential file; preserve the file and inspect it before repair')
    }
  }

  async saveFeishuSecrets() {
    const temporary = `${this.feishuSecretFile}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(this.feishuSecrets, null, 2) + '\n', { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, this.feishuSecretFile)
    await chmod(this.feishuSecretFile, 0o600)
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
    feishuStatus: 'stopped',
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
    feishuInstalled: team.feishuInstalled === true,
    feishu: validateStoredFeishuSettings(team.feishu),
    settingsSeeded: team.settingsSeeded === true,
    createdAt: typeof team.createdAt === 'string' ? team.createdAt : new Date(0).toISOString(),
    instanceId: identityValid ? team.instanceId : randomUUID(),
    communicationToken: tokenValid ? team.communicationToken : randomBytes(32).toString('hex'),
  }
}

function validateStoredFeishuSettings(value) {
  if (value === undefined) return { enabled: false, appId: '', botId: '' }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('teams.json contains invalid Feishu settings')
  const enabled = value.enabled === true
  const appId = typeof value.appId === 'string' ? value.appId : ''
  const botId = typeof value.botId === 'string' ? value.botId : ''
  if (appId && !/^cli_[A-Za-z0-9_-]{3,120}$/.test(appId)) throw new Error('teams.json contains an invalid Feishu App ID')
  if (botId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(botId)) throw new Error('teams.json contains an invalid Feishu target Bot ID')
  if (enabled && (!appId || !botId)) throw new Error('teams.json enables Feishu without an App ID or target Bot')
  return { enabled, appId, botId }
}

function validateFeishuSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, 'feishu settings must be an object')
  if (typeof value.enabled !== 'boolean') throw httpError(400, 'Feishu enabled must be a boolean')
  const appId = typeof value.appId === 'string' ? value.appId.trim() : ''
  const botId = typeof value.botId === 'string' ? value.botId.trim() : ''
  if (appId && !/^cli_[A-Za-z0-9_-]{3,120}$/.test(appId)) throw httpError(400, 'Feishu App ID must start with cli_ and contain only letters, digits, _ or -')
  if (botId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(botId)) throw httpError(400, 'invalid target Bot ID')
  if (value.enabled && (!appId || !botId)) throw httpError(400, 'enter a Feishu App ID and choose a DS Bot before enabling Feishu')
  return { enabled: value.enabled, appId, botId }
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
  for (const key of Object.keys(env)) if (key.startsWith('DSH_') || key.startsWith('HEADBOT_TEAM_') || key.startsWith('FEISHU_') || key === 'HEADBOT_BROKER_URL') delete env[key]
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

async function cloneModelPatch(parentHome, home) {
  const source = path.join(parentHome, 'profiles', 'web', 'cordis.patch.yml')
  let raw
  try { raw = await readFile(source, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  const patches = parse(raw)
  if (!Array.isArray(patches)) throw new Error('parent Web profile patch must be an array')
  const models = patches.filter(entry => entry && typeof entry.id === 'string' && (entry.id === 'agent-default-model' || entry.id.startsWith('llm-')))
  if (!models.length) return
  const directory = path.join(home, 'profiles', 'web')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(path.join(directory, 'cordis.patch.yml'), stringify(models), { flag: 'wx', mode: 0o600 }).catch(error => {
    if (error.code !== 'EEXIST') throw error
  })
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
        if ([200, 301, 302, 303, 307, 308, 401].includes(response.statusCode)) resolve(true)
        else if (Date.now() >= deadline) resolve(false)
        else setTimeout(poll, 350)
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

