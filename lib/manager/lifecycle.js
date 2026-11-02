import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stringify } from 'yaml'
import { seedTeamOnboarding } from '../onboarding.js'
import {
  newRuntime,
  validateFeishuSettings,
  validateId,
  validateName,
  validPort,
  childEnvironment,
  copyIfAbsent,
  cloneCredentialsWithoutBrowserGrant,
  cloneModelPatch,
  assertPortFree,
  httpError,
  safeError,
  redactTokens,
  stripAnsi,
  waitForListener,
  terminate,
  signalProcessTree,
  waitForClose,
  packageRoot,
  teamPluginFile,
  FEISHU_PLUGIN_NAME,
} from './shared.js'

export const lifecycleMethods = {
  async createTeam(input) {
    await this.initialize()
    return this.withMutation(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'team must be an object')
      const id = validateId(input.id)
      if (id === 'default') throw httpError(409, 'the default DSH controller instance is reserved')
      if (this.findTeam(id)) throw httpError(409, `team id "${id}" already exists`)
      const team = {
        id,
        name: validateName(input.name),
        port: validPort(input.port, 'port'),
        autoStart: input.autoStart !== false,
        botInstalled: false,
        feishuInstalled: false,
        feishu: { enabled: false, appId: '', botId: '' },
        modelId: this.controller.modelId,
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
  },

  async updateTeam(id, input) {
    await this.initialize()
    if (id === 'default') return this.updateController(input)
    return this.withMutation(async () => {
      const team = this.findTeam(id)
      if (!team) throw httpError(404, `team "${id}" not found`)
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'update must be an object')
      const runtime = this.runtime.get(id)
      if (runtime?.deleting) throw httpError(409, 'this team is being deleted')
      const previous = { name: team.name, port: team.port, autoStart: team.autoStart, feishu: team.feishu }
      const previousSecret = this.feishuSecrets[id]
      const previousFeishuStatus = runtime?.feishuStatus
      const previousFeishuAgentStatus = runtime?.feishuAgentStatus
      const previousFeishuStatusUpdatedAt = runtime?.feishuStatusUpdatedAt
      const previousAgentStatusUpdatedAt = runtime?.agentStatusUpdatedAt
      const next = { ...previous }
      let selectedModel
      if (input.modelId !== undefined) {
        selectedModel = this.requireModel(input.modelId)
        if (selectedModel.id === team.modelId) selectedModel = undefined
      }
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
          if (this.controller.feishu.enabled && this.controller.feishu.appId === submitted.appId) throw httpError(409, 'Feishu App ID is already assigned to the default DSH instance')
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
        if (input.feishu !== undefined && runtime) {
          runtime.feishuStatus = team.feishu.enabled ? 'stopped' : 'disabled'
          runtime.feishuAgentStatus = team.feishu.enabled ? 'stopped' : 'disabled'
          runtime.feishuStatusUpdatedAt = undefined
          runtime.agentStatusUpdatedAt = undefined
        }
      } catch (error) {
        Object.assign(team, previous)
        if (runtime && previousFeishuStatus !== undefined) runtime.feishuStatus = previousFeishuStatus
        if (runtime && previousFeishuAgentStatus !== undefined) runtime.feishuAgentStatus = previousFeishuAgentStatus
        if (runtime) {
          runtime.feishuStatusUpdatedAt = previousFeishuStatusUpdatedAt
          runtime.agentStatusUpdatedAt = previousAgentStatusUpdatedAt
        }
        if (previousSecret === undefined) delete this.feishuSecrets[id]
        else this.feishuSecrets[id] = previousSecret
        if (input.feishu !== undefined) await this.saveFeishuSecrets().catch(() => {})
        throw error
      }
      if (selectedModel) await this.applyTeamModel(team, selectedModel)
      return this.present(team)
    })
  },

  async deleteTeam(id) {
    await this.initialize()
    if (id === 'default') throw httpError(409, 'the default DSH controller instance cannot be deleted')
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
  },

  async startTeam(id) {
    await this.initialize()
    if (id === 'default') throw httpError(409, 'the default DSH controller is always running; start and stop operations are unavailable')
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
    runtime.generation = randomUUID()
    runtime.feishuStatusUpdatedAt = undefined
    runtime.agentStatusUpdatedAt = undefined
    runtime.feishuStatus = team.feishu.enabled ? 'connecting' : 'disabled'
    runtime.feishuAgentStatus = team.feishu.enabled ? 'restoring' : 'disabled'
    runtime.phase = team.botInstalled ? 'starting' : 'provisioning'
    runtime.message = ''
    runtime.launchUrl = undefined
    runtime.task = this.startRoutine(team, runtime).finally(() => { runtime.task = undefined })
    return runtime.task
  },

  async stopTeam(id) {
    await this.initialize()
    if (id === 'default') throw httpError(409, 'the default DSH controller instance cannot be stopped')
    const team = this.findTeam(id)
    if (!team) throw httpError(404, `team "${id}" not found`)
    const runtime = this.runtime.get(id)
    if (!runtime) {
      this.runtime.set(id, { ...newRuntime(), phase: 'stopped' })
      return
    }
    runtime.stopRequested = true
    runtime.explicitStop = true
    runtime.generation = undefined
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
    runtime.feishuAgentStatus = team.feishu.enabled ? 'stopped' : 'disabled'
    runtime.feishuStatusUpdatedAt = undefined
    runtime.agentStatusUpdatedAt = undefined
  },

  async restartTeam(id) {
    if (id === 'default') return this.restartController()
    if (this.runtime.get(id)?.updating) throw httpError(409, 'wait for the DS Bot update to finish before restarting this team')
    await this.stopTeam(id)
    const runtime = this.runtime.get(id)
    if (!runtime || runtime.deleting) throw httpError(409, 'this team is being deleted')
    runtime.stopRequested = false
    runtime.explicitStop = false
    return this.startTeam(id)
  },

  async updateBot(id) {
    if (id === 'default') return this.updateControllerBot()
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
    return this.startTeam(id)
  },

  async close() {
    this.closing = true
    clearInterval(this.controllerRuntime.feishuMonitor)
    this.controllerRuntime.feishuMonitor = undefined
    const ids = [...this.runtime.keys()]
    await Promise.all(ids.map(id => this.stopTeam(id).catch(error => this.warn(`stop ${id}: ${safeError(error)}`))))
  },

  async startRoutine(team, runtime) {
    try {
      await this.provisionHome(team)
      if (team.modelId) await this.ensureInstanceModel(team)
      if (runtime.stopRequested || this.closing) return
      if (!team.botInstalled) {
        runtime.phase = 'provisioning'
        for (const packageRef of [this.botPackage, ...this.teamPlugins]) {
          await this.runDsh(['plugin', '--profile', 'web', 'add', packageRef], team, runtime)
          if (runtime.stopRequested || this.closing) return
        }
        team.botInstalled = true
        await this.save()
      }
      if (team.feishu.enabled && !await this.isTeamFeishuInstalled(team)) {
        runtime.phase = 'provisioning'
        const archive = await this.packFeishuPlugin()
        await this.runDsh(['plugin', '--profile', 'web', 'add', archive], team, runtime)
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
      this.prepareModelEnvironment(env, team.modelId)
      if (team.feishu.enabled) {
        const appSecret = this.feishuSecrets[team.id]
        if (!appSecret) throw new Error('Feishu is enabled but its App Secret is missing; edit the team settings')
        const agentId = runtime.feishuAgentId || await this.resolveFeishuTargetSession(team)
        runtime.feishuAgentId = agentId
        env.HEADBOT_FEISHU_AGENT_ID = agentId
        env.HEADBOT_RUNTIME_GENERATION = runtime.generation
        env.FEISHU_APP_ID = team.feishu.appId
        env.FEISHU_APP_SECRET = appSecret
      }
      const trustedHostArgs = this.publicHosts.flatMap(host => ['--trusted-host', host])
      const { command, args } = this.commandFor(['--profile', 'web', '--patch', path.join(teamRoot, 'communications.patch.yml'), '--no-open', '--host', '127.0.0.1', '--port', String(team.port), '--public-url', this.teamUrl(team), ...trustedHostArgs])
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
        runtime.generation = undefined
        runtime.feishuStatus = team.feishu.enabled ? 'failed' : 'disabled'
        runtime.feishuAgentStatus = team.feishu.enabled ? 'failed' : 'disabled'
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
      runtime.generation = undefined
      runtime.feishuStatusUpdatedAt = undefined
      runtime.agentStatusUpdatedAt = undefined
      runtime.phase = runtime.stopRequested ? 'stopped' : 'failed'
      runtime.feishuStatus = team.feishu.enabled ? (runtime.stopRequested ? 'stopped' : 'failed') : 'disabled'
      runtime.feishuAgentStatus = team.feishu.enabled ? (runtime.stopRequested ? 'stopped' : 'failed') : 'disabled'
      runtime.message = runtime.stopRequested ? '' : this.teamError(error, team)
      this.warn(`start ${team.id}: ${this.teamError(error, team)}`)
    }
  },

  async provisionHome(team) {
    const teamRoot = path.join(this.root, 'teams', team.id)
    const home = path.join(teamRoot, 'home')
    await mkdir(path.join(home, 'logs'), { recursive: true, mode: 0o700 })
    await mkdir(path.join(home, 'bot', 'workspace'), { recursive: true, mode: 0o700 })
    await mkdir(path.join(teamRoot, 'workspace'), { recursive: true, mode: 0o700 })
    try {
      await seedTeamOnboarding(path.join(home, 'bot', 'workspace'), { packageRoot })
    } catch (error) {
      this.warn(`team ${team.id}: onboarding seed failed: ${safeError(error)}`)
    }
    await chmod(teamRoot, 0o700).catch(() => {})
    await chmod(home, 0o700).catch(() => {})
    const patch = [
      { insert: [{ id: 'ds-headbot-communications', name: teamPluginFile }] },
    ]
    if (team.feishu.enabled) {
      const agentId = await this.resolveFeishuTargetSession(team)
      const runtime = this.runtime.get(team.id)
      if (runtime) runtime.feishuAgentId = agentId
      patch.push({
        id: FEISHU_PLUGIN_NAME,
        name: FEISHU_PLUGIN_NAME,
        disabled: false,
        config: {
          appId: 'env:FEISHU_APP_ID',
          appSecret: 'env:FEISHU_APP_SECRET',
          domain: 'feishu',
          mode: 'agent',
          agentId,
          replyToSource: true,
          dmMode: 'open',
          requireMention: true,
          commands: true,
          tools: true,
        },
      })
    } else if (await this.isTeamFeishuInstalled(team)) {
      patch.push({ id: FEISHU_PLUGIN_NAME, name: FEISHU_PLUGIN_NAME, disabled: true })
    }
    if (await this.isLegacyFeishuInstalled(path.join(home, 'profiles', 'web'))) {
      patch.push({ id: 'feishu-bot', name: '@zyfgood/dsh-feishu-bot', disabled: true })
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
  },

  async runDsh(args, team, runtime) {
    const home = team.id === 'default' ? this.parentHome : path.join(this.root, 'teams', team.id, 'home')
    const cwd = team.id === 'default' ? this.parentHome : path.join(this.root, 'teams', team.id)
    const env = childEnvironment(home)
    const { command, args: commandArgs } = this.commandFor(args)
    await new Promise((resolve, reject) => {
      const child = spawn(command, commandArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
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
        else reject(new Error(`dsh ${args[0]} exited (${exitCode ?? exitSignal ?? 'unknown'}): ${safeError(this.redactModelSecrets(this.redactFeishuSecret(output, team)))}`))
      })
    })
  },

  commandFor(args) {
    const executable = this.dshCommand
    if (/\.(?:mjs|cjs|js)$/.test(executable)) return { command: process.execPath, args: [executable, ...args] }
    return { command: executable, args }
  },

  consumeOutput(team, runtime, chunk) {
    const text = chunk.toString('utf8')
    runtime.outputBuffer = (runtime.outputBuffer || '') + text
    const lines = runtime.outputBuffer.split(/\r?\n/)
    runtime.outputBuffer = lines.pop() || ''
    if (runtime.outputBuffer.length > 16_384) runtime.outputBuffer = runtime.outputBuffer.slice(-4096)
    for (const line of lines) {
      const clean = this.redactModelSecrets(this.redactFeishuSecret(stripAnsi(line), team))
      if (team.feishu.enabled && (!runtime.feishuStatusUpdatedAt || Date.now() - runtime.feishuStatusUpdatedAt > 10_000)) {
        if (/feishu:\s*长连接(?:已就绪|已重连)/i.test(clean)) {
          runtime.feishuStatus = 'connected'
          runtime.feishuStatusUpdatedAt = Date.now()
        } else if (/feishu:\s*(?:连接长连接失败|长连接(?:断开|错误)|connection error)/i.test(clean)) {
          runtime.feishuStatus = 'retrying'
          runtime.feishuStatusUpdatedAt = Date.now()
        }
      }
      const match = clean.match(/dsh web:\s*(https?:\/\/\S+)/i)
      if (match) {
        try {
          const candidate = new URL(match[1])
          const expectedPath = `/${this.teamsPath}/${team.id}/`
          if (candidate.protocol === 'http:' && this.publicHosts.includes(candidate.hostname.toLowerCase()) && candidate.port === '' && candidate.pathname.startsWith(expectedPath) && candidate.searchParams.has('token')) {
            runtime.launchUrl = candidate.toString()
          }
        } catch {}
      }
      const log = path.join(this.logRoot, `${team.id}-${team.instanceId}.log`)
      void appendFile(log, `${redactTokens(clean)}\n`, { mode: 0o600 })
        .then(() => chmod(log, 0o600))
        .catch(error => this.warn(`write ${team.id} log: ${safeError(error)}`))
    }
  },

  onExit(team, runtime, code, signal) {
    runtime.generation = undefined
    runtime.child = undefined
    runtime.pid = undefined
    runtime.childExit = undefined
    runtime.childDone = undefined
    runtime.launchUrl = undefined
    if (runtime.stopRequested || runtime.explicitStop || this.closing) {
      runtime.phase = 'stopped'
      runtime.message = ''
      runtime.feishuStatus = team.feishu.enabled ? 'stopped' : 'disabled'
      runtime.feishuAgentStatus = team.feishu.enabled ? 'stopped' : 'disabled'
      return
    }
    runtime.phase = 'failed'
    runtime.feishuStatus = team.feishu.enabled ? 'offline' : 'disabled'
    runtime.feishuAgentStatus = team.feishu.enabled ? 'offline' : 'disabled'
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
  },

  async ensurePortAvailable(port, teamId) {
    if ([80, 443, this.ingressPort, this.parentPort].includes(port)) {
      throw httpError(409, `port ${port} is reserved by Headbot or the controller`)
    }
    for (const other of this.teams) {
      if (other.id !== teamId && other.port === port) throw httpError(409, `port ${port} is already assigned to team "${other.id}"`)
    }
    await assertPortFree(port)
  },

  async startEnabledTeams() {
    await this.initialize()
    this.watchControllerFeishuTarget()
    if (this.controller.feishu.enabled && !await this.isControllerFeishuInstalled()) {
      const secret = this.feishuSecrets.default
      if (secret) {
        try {
          this.controllerRuntime.phase = 'provisioning'
          this.controllerRuntime.message = '正在迁移主实例的飞书插件'
          const record = this.controllerRecord()
          const archive = await this.packFeishuPlugin()
          await this.runDsh(['plugin', '--profile', 'web', 'add', archive], record, this.controllerRuntime)
          this.controller.feishuAgentId = await this.resolveFeishuTargetSession(record)
          this.controller.feishuInstalled = true
          await this.writeControllerFeishuPatch(this.controller.feishu, this.controller.feishuAgentId)
          await this.writeControllerFeishuEnvironment(this.controller.feishu, secret)
          await this.saveControllerSettings()
          this.controllerRuntime.phase = 'running'
          await this.scheduleControllerRestart('已切换到 ds-headbot-feishu，正在重启主 DSH')
          return
        } catch (error) {
          this.controllerRuntime.phase = 'running'
          this.controllerRuntime.message = `主实例飞书插件迁移失败：${this.teamError(error, this.controllerRecord())}`
          this.warn(this.controllerRuntime.message)
        }
      }
    }
    for (const team of this.teams) {
      if (team.autoStart) {
        void this.startTeam(team.id).catch(error => this.warn(`start ${team.id}: ${safeError(error)}`))
      }
    }
  },

  async reportTeamStatus(actor, input) {
    await this.initialize()
    const team = this.findTeam(actor.id)
    if (!team || team.instanceId !== actor.instanceId) throw httpError(401, 'team identity has been revoked')
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'runtime status must be an object')
    const runtime = this.runtime.get(team.id)
    if (!runtime || !runtime.child || typeof input.generation !== 'string' || input.generation !== runtime.generation) {
      return { accepted: false }
    }
    const feishuStates = new Set(['unknown', 'connecting', 'connected', 'retrying', 'offline', 'failed'])
    const agentStates = new Set(['restoring', 'online', 'offline', 'failed'])
    if (!feishuStates.has(input.feishuStatus) || !agentStates.has(input.agentStatus)) throw httpError(400, 'invalid runtime status')
    if (team.feishu.enabled) {
      runtime.feishuStatus = input.feishuStatus
      runtime.feishuAgentStatus = input.agentStatus
      runtime.feishuStatusUpdatedAt = Date.now()
      runtime.agentStatusUpdatedAt = Date.now()
    }
    return { accepted: true }
  },

  async getBotVersions() {
    await this.initialize()
    const instances = [
      { id: 'default', name: this.controller.name, home: this.parentHome, status: this.controllerRuntime.phase || 'running' },
      ...this.teams.map(team => ({
        id: team.id,
        name: team.name,
        home: path.join(this.root, 'teams', team.id, 'home'),
        status: this.runtime.get(team.id)?.phase || 'stopped',
      })),
    ]
    return Promise.all(instances.map(async instance => {
      const manifest = path.join(instance.home, 'profiles', 'web', 'node_modules', this.botPackage, 'package.json')
      let currentVersion = null
      try {
        const pkg = JSON.parse(await readFile(manifest, 'utf8'))
        if (pkg.name === this.botPackage && typeof pkg.version === 'string') currentVersion = pkg.version
      } catch (error) {
        if (error.code !== 'ENOENT') this.warn(`read ${instance.id} DS Bot version: ${safeError(error)}`)
      }
      return { id: instance.id, name: instance.name, currentVersion, status: instance.status }
    }))
  },

  redactFeishuSecret(value, team) {
    const secret = this.feishuSecrets[team.id]
    return secret ? String(value).split(secret).join('[redacted Feishu secret]') : String(value)
  },

  redactModelSecrets(value) {
    let text = String(value)
    for (const model of this.models) {
      const secrets = [this.modelSecrets[model.id], model.apiKeyEnv && process.env[model.apiKeyEnv], model.legacyApiKeyEnv && process.env[model.legacyApiKeyEnv]]
      for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted model API key]')
    }
    return text
  },

  teamError(value, team) {
    return safeError(this.redactModelSecrets(this.redactFeishuSecret(value instanceof Error ? value.message : value, team)))
  },
}
