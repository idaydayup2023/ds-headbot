import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { access, appendFile, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createServer as netCreateServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'

const controllerModelTransitionWorker = String.raw`
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const payload = JSON.parse(Buffer.from(process.argv.at(-1), 'base64url').toString('utf8'));
const domain = 'gui/' + payload.uid;
const statusFile = payload.dataRoot + '/controller-model-transition.json';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function writeStatus(status, message) {
  const value = { status, modelRef: payload.modelRef, updatedAt: new Date().toISOString(), ...(message ? { message: String(message).slice(0, 1000) } : {}) };
  const temporary = statusFile + '.' + process.pid + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, statusFile);
  await fs.chmod(statusFile, 0o600);
}
async function waitForLockRelease() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try { await fs.access(payload.lockFile); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await delay(150);
  }
  throw new Error('DS Bot did not release bot/state.lock after the DSH LaunchAgent stopped');
}
async function bootstrap() {
  await run('/bin/launchctl', ['bootstrap', domain, payload.launchdPlist], { timeout: 30000 });
}
async function main() {
  let stopped = false;
  let original;
  let stateChanged = false;
  try {
    await delay(250);
    await run('/bin/launchctl', ['bootout', domain, payload.launchdPlist], { timeout: 30000 });
    stopped = true;
    await waitForLockRelease();
    try { original = await fs.readFile(payload.stateFile); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (original !== undefined) {
      const state = JSON.parse(original.toString('utf8'));
      if (!state || state.version !== 1 || !state.bots || typeof state.bots !== 'object' || Array.isArray(state.bots)) {
        throw new Error('DS Bot state has an unsupported format; no model changes were written');
      }
      for (const bot of Object.values(state.bots)) {
        if (!bot || typeof bot !== 'object' || Array.isArray(bot)) continue;
        bot.model = payload.modelRef;
        delete bot.appliedModel;
        delete bot.appliedEffort;
        delete bot.effort;
      }
      const temporary = payload.stateFile + '.' + process.pid + '.tmp';
      await fs.writeFile(temporary, JSON.stringify(state) + '\n', { mode: 0o600 });
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, payload.stateFile);
      await fs.chmod(payload.stateFile, 0o600);
      stateChanged = true;
    }
    await writeStatus('applied');
    await bootstrap();
    stopped = false;
    await writeStatus('complete');
  } catch (error) {
    if (stopped && stateChanged && original !== undefined) {
      try {
        const temporary = payload.stateFile + '.' + process.pid + '.rollback';
        await fs.writeFile(temporary, original, { mode: 0o600 });
        await fs.chmod(temporary, 0o600);
        await fs.rename(temporary, payload.stateFile);
        await fs.chmod(payload.stateFile, 0o600);
      } catch {}
    }
    await writeStatus('failed', error?.message || String(error)).catch(() => {});
    if (stopped) await bootstrap().catch(() => {});
  } finally {
    await run('/bin/launchctl', ['remove', payload.helperLabel], { timeout: 10000 }).catch(() => {});
  }
}
void main();
`

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/
const DEFAULT_BOT_PACKAGE = 'ds-bot'
const FEISHU_PLUGIN_NAME = 'ds-headbot-feishu'
const SESSION_GRANT = 'client-connection/browser-session'

function upsertDisabledPatch(patches, id, name) {
  const matches = patches.map((entry, index) => entry && entry.id === id ? index : -1).filter(index => index >= 0)
  if (matches.length > 1) throw new Error(`profile patch contains multiple ${id} entries`)
  const index = matches[0] ?? -1
  const patch = index >= 0 ? patches[index] : { id, name }
  patch.name = name
  patch.disabled = true
  if (index < 0) patches.push(patch)
}

async function hashPackageDirectory(directory) {
  const hash = createHash('sha256')
  async function visit(current, relative = '') {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const file = path.join(current, entry.name)
      const name = path.join(relative, entry.name)
      if (entry.isDirectory()) await visit(file, name)
      else if (entry.isFile()) {
        hash.update(name.replaceAll(path.sep, '/') + '\0')
        hash.update(await readFile(file))
      }
    }
  }
  await visit(directory)
  return hash.digest('hex')
}

function runPack(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000) })
    child.once('error', reject)
    child.once('close', code => code === 0
      ? resolve()
      : reject(new Error(`packing ds-headbot-feishu failed with exit code ${code ?? 'unknown'}${stderr.trim() ? `: ${stderr.trim()}` : ''}`)))
  })
}

export class HeadbotManager {
  constructor(config = {}, options = {}) {
    this.config = config
    this.parentHome = resolveUserPath(options.parentHome || config.dshHome || path.join(homedir(), '.dsh'))
    this.root = resolveUserPath(config.dataDir || path.join(this.parentHome, 'headbot'))
    this.stateFile = path.join(this.root, 'teams.json')
    this.feishuSecretFile = path.join(this.root, 'feishu-secrets.json')
    this.modelFile = path.join(this.root, 'models.json')
    this.modelSecretFile = path.join(this.root, 'model-secrets.json')
    this.controllerModelTransitionFile = path.join(this.root, 'controller-model-transition.json')
    this.controllerFile = path.join(this.root, 'controller.json')
    this.logRoot = path.join(this.root, 'logs')
    this.parentPort = Number(options.parentPort)
    if (!Number.isInteger(this.parentPort) || this.parentPort < 1 || this.parentPort > 65535) {
      throw new Error('the controller webServer must expose a valid TCP port')
    }
    this.parentHost = options.parentHost || '127.0.0.1'
    this.logger = options.logger
    this.publicHost = validatePublicHost(options.publicHost || config.publicHost || process.env.HEADBOT_PUBLIC_HOST || 'localhost')
    const configuredPublicHosts = options.publicHosts ?? config.publicHosts ?? process.env.HEADBOT_PUBLIC_HOSTS?.split(',').map(host => host.trim()).filter(Boolean) ?? []
    if (!Array.isArray(configuredPublicHosts) || configuredPublicHosts.length > 15) {
      throw new Error('publicHosts must be an array of at most 15 DNS names or IPv4 addresses')
    }
    this.publicHosts = [...new Set([this.publicHost, ...configuredPublicHosts.map(validatePublicHost)])]
    this.controllerPath = validatePathSegment(config.controllerPath || 'dsh', 'controllerPath')
    this.teamsPath = validatePathSegment(config.teamsPath || 'teams', 'teamsPath')
    if (this.controllerPath === this.teamsPath) throw new Error('controllerPath and teamsPath must be different')
    this.ingressPort = validPort(config.ingressPort ?? 3180, 'ingressPort')
    if (this.ingressPort === this.parentPort) throw new Error('ingressPort must differ from the controller DSH port')
    this.dshCommand = config.dshCommand || process.env.HEADBOT_DSH_COMMAND || 'dsh'
    this.botPackage = config.botPackage || DEFAULT_BOT_PACKAGE
    this.restartCommand = config.restartCommand
    this.restartArgs = config.restartArgs
    this.launchdLabel = config.launchdLabel || 'com.deepseek.dsh'
    this.launchdPlist = config.launchdPlist
      ? resolveUserPath(config.launchdPlist)
      : path.join(homedir(), 'Library', 'LaunchAgents', `${this.launchdLabel}.plist`)
    this.teamPlugins = config.teamPlugins ?? []
    if (!Array.isArray(this.teamPlugins) || this.teamPlugins.length > 20 || this.teamPlugins.some(item => typeof item !== 'string' || !item.trim() || item.startsWith('-'))) {
      throw new Error('teamPlugins must be an array of at most 20 package references')
    }
    this.inheritModelSettings = config.inheritModelSettings !== false
    this.teams = []
    this.feishuSecrets = {}
    this.models = []
    this.modelSecrets = {}
    this.runtime = new Map()
    this.controller = { name: '默认实例', feishuInstalled: false, feishuAgentId: undefined, feishu: { enabled: false, appId: '', botId: '' } }
    this.controllerRuntime = { ...newRuntime(), phase: 'running', feishuStatus: 'unknown' }
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
    await this.loadControllerSettings()
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
    await this.loadModelCatalog()
    await this.migrateModelAssignments()
    await this.loadControllerModelTransitionStatus()
    // Persist identities when opening state written by version 0.1.
    await this.save()
    await this.saveControllerSettings()
    this.loaded = true
  }

  async listTeams() {
    await this.initialize()
    return this.teams.map(team => this.present(team))
  }

  async listInstances() {
    await this.initialize()
    return [this.presentController(), ...this.teams.map(team => this.present(team))]
  }

  async listModels() {
    await this.initialize()
    return this.models.map(model => this.presentModel(model))
  }

  async createModel(input) {
    await this.initialize()
    return this.withMutation(async () => {
      const model = validateModelInput(input)
      if (this.models.length >= 100) throw httpError(409, 'the model catalog supports up to 100 entries')
      if (this.models.some(item => item.id === model.id)) throw httpError(409, `model id "${model.id}" already exists`)
      const secret = readModelSecretInput(input)
      if (secret !== undefined) {
        this.modelSecrets[model.id] = secret
        model.apiKeyEnv = modelKeyEnv(model.id)
      }
      this.models.push(model)
      try {
        await this.saveModels()
        await this.saveModelSecrets()
      } catch (error) {
        this.models = this.models.filter(item => item !== model)
        if (secret !== undefined) delete this.modelSecrets[model.id]
        await this.saveModels().catch(() => {})
        await this.saveModelSecrets().catch(() => {})
        throw error
      }
      return this.presentModel(model)
    })
  }

  async updateModel(id, input) {
    await this.initialize()
    return this.withMutation(async () => {
      const index = this.models.findIndex(item => item.id === id)
      if (index < 0) throw httpError(404, `model "${id}" not found`)
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'model update must be an object')
      if (input.id !== undefined && input.id !== id) throw httpError(400, 'model id cannot be changed; create another model entry')
      const previous = this.models[index]
      const previousSecret = this.modelSecrets[id]
      const next = validateModelInput({ ...previous, ...input, id })
      const secret = readModelSecretInput(input, { optional: true })
      if (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean') throw httpError(400, 'clearApiKey must be a boolean')
      if (input.clearApiKey === true) {
        delete this.modelSecrets[id]
        if (next.apiKeyEnv !== modelKeyEnv(id)) next.legacyApiKeyEnv = next.apiKeyEnv
        next.apiKeyEnv = modelKeyEnv(id)
      } else if (secret !== undefined) {
        this.modelSecrets[id] = secret
        if (next.apiKeyEnv !== modelKeyEnv(id)) next.legacyApiKeyEnv = next.apiKeyEnv
        next.apiKeyEnv = modelKeyEnv(id)
      }
      const runtimeChanged = modelRuntimeSignature(previous) !== modelRuntimeSignature(next)
        || previousSecret !== this.modelSecrets[id]
      this.models[index] = next
      try {
        await this.saveModels()
        await this.saveModelSecrets()
      } catch (error) {
        this.models[index] = previous
        if (previousSecret === undefined) delete this.modelSecrets[id]
        else this.modelSecrets[id] = previousSecret
        await this.saveModels().catch(() => {})
        await this.saveModelSecrets().catch(() => {})
        throw error
      }

      const affectedTeams = runtimeChanged ? this.teams.filter(team => team.modelId === id) : []
      const controllerAffected = runtimeChanged && this.controller.modelId === id
      const appliedTeams = []
      const controllerSnapshot = controllerAffected ? await captureFiles(this.controllerModelFiles()) : undefined
      let controllerApplied = false
      try {
        for (const team of affectedTeams) {
          appliedTeams.push(await this.applyTeamModel(team, next, { force: true, returnSnapshot: true }))
        }
        if (controllerAffected) {
          controllerApplied = true
          await this.applyControllerModelFiles(next)
          await this.writeControllerModelEnvironment(next)
          await this.saveControllerSettings()
          await this.scheduleControllerRestart('模型配置已更新，正在重启主 DSH 使其生效')
        }
      } catch (error) {
        this.models[index] = previous
        if (previousSecret === undefined) delete this.modelSecrets[id]
        else this.modelSecrets[id] = previousSecret
        await this.saveModels().catch(rollbackError => this.warn(`restore model catalog: ${safeError(rollbackError)}`))
        await this.saveModelSecrets().catch(rollbackError => this.warn(`restore model secrets: ${safeError(rollbackError)}`))
        if (controllerApplied) {
          await restoreFiles(controllerSnapshot).catch(rollbackError => this.warn(`restore controller model files: ${safeError(rollbackError)}`))
        }
        for (const applied of appliedTeams.reverse()) {
          const { team, snapshot, previousModelId, wasRunning } = applied
          try {
            if (this.runtime.get(team.id)?.child) await this.stopTeam(team.id)
            team.modelId = previousModelId
            await restoreFiles(snapshot)
            await this.save()
            if (wasRunning) {
              await this.startTeam(team.id)
              if (this.runtime.get(team.id)?.phase !== 'running') throw new Error(this.runtime.get(team.id)?.message || 'team did not return to running state')
            }
          } catch (rollbackError) {
            this.warn(`restore ${team.id} model: ${safeError(rollbackError)}`)
          }
        }
        throw error
      }
      return this.presentModel(next)
    })
  }

  async deleteModel(id) {
    await this.initialize()
    return this.withMutation(async () => {
      const index = this.models.findIndex(item => item.id === id)
      if (index < 0) throw httpError(404, `model "${id}" not found`)
      if (this.controller.modelId === id || this.teams.some(team => team.modelId === id)) {
        throw httpError(409, 'switch every assigned instance to another model before deleting this entry')
      }
      const [model] = this.models.splice(index, 1)
      const secret = this.modelSecrets[id]
      delete this.modelSecrets[id]
      try {
        await this.saveModels()
        await this.saveModelSecrets()
      } catch (error) {
        this.models.splice(index, 0, model)
        if (secret !== undefined) this.modelSecrets[id] = secret
        await this.saveModels().catch(() => {})
        await this.saveModelSecrets().catch(() => {})
        throw error
      }
      return { id }
    })
  }

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
  }

  async getTeam(id) {
    await this.initialize()
    if (id === 'default') return this.presentController()
    const team = this.findTeam(id)
    if (!team) throw httpError(404, `team "${id}" not found`)
    return this.present(team)
  }

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
  }

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
  }

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
  }

  async updateController(input) {
    return this.withMutation(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'update must be an object')
      if (input.feishu !== undefined && (this.controllerRuntime.updating || this.controllerRuntime.phase === 'restarting')) throw httpError(409, 'wait for the default DSH operation to finish before changing Feishu settings')
      const modelChanged = input.modelId !== undefined && input.modelId !== this.controller.modelId
      if (modelChanged && (this.controllerRuntime.updating || this.controllerRuntime.phase === 'restarting')) throw httpError(409, 'wait for the default DSH operation to finish before changing its model')
      const selectedModel = modelChanged ? this.requireModel(input.modelId) : undefined
      if (modelChanged) await this.assertControllerModelTransitionReady()
      if (input.port !== undefined && Number(input.port) !== this.parentPort) throw httpError(409, 'the default DSH controller port is fixed')
      if (input.autoStart !== undefined && input.autoStart !== true) throw httpError(409, 'the default DSH controller always starts with DSH')

      const previous = this.controller
      const previousSecret = this.feishuSecrets.default
      const next = { ...previous, feishu: { ...previous.feishu } }
      if (modelChanged) next.modelId = selectedModel.id
      if (input.name !== undefined) next.name = validateName(input.name)
      let nextSecret = previousSecret
      let feishuChanged = false
      let installedDuringUpdate = false
      if (input.feishu !== undefined) {
        const submitted = validateFeishuSettings(input.feishu)
        const suppliedSecret = input.feishu.appSecret
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
        feishuChanged = submitted.enabled !== previous.feishu.enabled
          || submitted.appId !== previous.feishu.appId
          || submitted.botId !== previous.feishu.botId
          || nextSecret !== previousSecret
        if (submitted.enabled) {
          if (!nextSecret) throw httpError(400, 'enter the Feishu App Secret before enabling this integration')
          const duplicate = this.teams.find(team => team.feishu.enabled && team.feishu.appId === submitted.appId)
          if (duplicate) throw httpError(409, `Feishu App ID is already assigned to team "${duplicate.id}"`)
          const bots = await this.getTeamBots('default')
          if (!bots.some(bot => bot.id === submitted.botId)) throw httpError(400, 'choose a Bot that exists in the default DSH instance')
        }
        next.feishu = submitted
      }

      if (feishuChanged && next.feishu.enabled && !await this.isControllerFeishuInstalled()) {
        const record = this.controllerRecord(next)
        this.controllerRuntime.phase = 'provisioning'
        try {
          const archive = await this.packFeishuPlugin()
          await this.runDsh(['plugin', '--profile', 'web', 'add', archive], record, this.controllerRuntime)
          next.feishuInstalled = true
          installedDuringUpdate = true
        } catch (error) {
          this.controllerRuntime.phase = 'running'
          this.controllerRuntime.message = `飞书插件安装失败：${this.teamError(error, record)}`
          throw error
        }
      }

      const modelSnapshot = modelChanged ? await captureFiles(this.controllerModelFiles()) : undefined

      this.controller = next
      if (input.feishu !== undefined) {
        if (nextSecret === undefined) delete this.feishuSecrets.default
        else this.feishuSecrets.default = nextSecret
      }
      try {
        if (feishuChanged) {
          next.feishuAgentId = next.feishu.enabled
            ? await this.resolveFeishuTargetSession(this.controllerRecord(next))
            : undefined
          await this.writeControllerFeishuPatch(next.feishu, next.feishuAgentId)
          await this.writeControllerFeishuEnvironment(next.feishu, nextSecret)
        }
        if (modelChanged) {
          await this.applyControllerModelFiles(selectedModel)
          await this.writeControllerModelEnvironment(selectedModel)
          await this.writeControllerModelTransitionStatus({
            status: 'pending',
            modelRef: modelRef(selectedModel),
            updatedAt: new Date().toISOString(),
            message: '等待默认 DSH 停止后更新 Bot 模型并恢复服务',
          })
        }
        if (input.feishu !== undefined) await this.saveFeishuSecrets()
        await this.saveControllerSettings()
      } catch (error) {
        this.controller = installedDuringUpdate ? { ...previous, feishuInstalled: true } : previous
        if (previousSecret === undefined) delete this.feishuSecrets.default
        else this.feishuSecrets.default = previousSecret
        if (input.feishu !== undefined) await this.saveFeishuSecrets().catch(() => {})
        await this.saveControllerSettings().catch(() => {})
        if (modelChanged) {
          await restoreFiles(modelSnapshot).catch(rollbackError => this.warn(`restore default model files: ${safeError(rollbackError)}`))
          await this.saveControllerSettings().catch(rollbackError => this.warn(`restore default model assignment: ${safeError(rollbackError)}`))
        }
        if (feishuChanged) {
          try {
            previous.feishuAgentId = previous.feishu.enabled
              ? await this.resolveFeishuTargetSession(this.controllerRecord(previous))
              : undefined
            await this.writeControllerFeishuPatch(previous.feishu, previous.feishuAgentId)
            await this.writeControllerFeishuEnvironment(previous.feishu, previousSecret)
          } catch (rollbackError) {
            this.warn(`restore default Feishu settings: ${safeError(rollbackError)}`)
          }
        }
        this.controllerRuntime.phase = 'running'
        this.controllerRuntime.message = ''
        throw error
      }
      if (feishuChanged || modelChanged) {
        this.controllerRuntime.feishuStatus = next.feishu.enabled ? 'connecting' : 'disabled'
        await this.scheduleControllerRestart(
          modelChanged ? '模型设置已保存，正在安全重启主 DSH 并更新全部 Bot' : '飞书设置已保存，正在重启主 DSH 使其生效',
          modelChanged ? { botModelRef: modelRef(selectedModel) } : undefined,
        )
      }
      return this.presentController()
    })
  }

  controllerRecord(settings = this.controller) {
    return {
      id: 'default', instanceId: 'controller', name: settings.name, port: this.parentPort,
      autoStart: true, feishuInstalled: settings.feishuInstalled, feishu: settings.feishu,
    }
  }

  async scheduleControllerRestart(message = '正在重启主 DSH', options = undefined) {
    const runtime = this.controllerRuntime
    if (runtime.restartScheduled || runtime.phase === 'restarting') return
    runtime.phase = 'restarting'
    runtime.message = message
    runtime.restartScheduled = true
    const timer = setTimeout(() => {
      runtime.restartScheduled = false
      void this.performControllerRestart(options).catch(error => {
        runtime.phase = 'running'
        runtime.message = `DSH 自动重启失败：${safeError(error)}`
        this.warn(runtime.message)
      })
    }, 350)
    timer.unref?.()
  }

  async restartController() {
    await this.initialize()
    if (this.controllerRuntime.updating || this.controllerRuntime.phase === 'provisioning') throw httpError(409, 'wait for the current default-instance operation to finish')
    await this.scheduleControllerRestart('正在重启主 DSH；其他团队实例会随管理器自动恢复')
    return this.presentController()
  }

  async performControllerRestart(options = undefined) {
    if (options?.botModelRef) {
      await this.startControllerModelTransition(options.botModelRef)
      return
    }
    let command
    let args
    if (this.restartCommand !== undefined) {
      if (typeof this.restartCommand !== 'string' || !this.restartCommand.trim()) throw new Error('restartCommand must be a non-empty string')
      if (this.restartArgs !== undefined && (!Array.isArray(this.restartArgs) || this.restartArgs.some(arg => typeof arg !== 'string'))) throw new Error('restartArgs must be an array of strings')
      command = this.restartCommand
      args = this.restartArgs ?? []
    } else if (process.platform === 'darwin' && typeof process.getuid === 'function') {
      if (!/^[A-Za-z0-9.-]+$/.test(this.launchdLabel)) throw new Error('launchdLabel is invalid')
      command = '/bin/launchctl'
      args = ['kickstart', '-k', `gui/${process.getuid()}/${this.launchdLabel}`]
    } else {
      throw new Error('configure restartCommand to restart the default DSH instance')
    }
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: 'ignore' })
      child.once('error', reject)
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`restart command exited with ${code ?? 'unknown'}`)))
    })
  }

  async updateControllerBot() {
    const runtime = this.controllerRuntime
    if (runtime.updating || runtime.restartScheduled || runtime.phase === 'restarting') throw httpError(409, 'wait for the current default-instance operation to finish')
    runtime.updating = true
    runtime.phase = 'updating'
    runtime.message = '正在更新主 DSH Web 配置中的 DS Bot'
    try {
      await this.initialize()
      const installedPackage = path.join(this.parentHome, 'profiles', 'web', 'node_modules', this.botPackage, 'package.json')
      let installed = true
      try { await access(installedPackage) } catch (error) { if (error.code === 'ENOENT') installed = false; else throw error }
      const args = installed
        ? ['plugin', '--profile', 'web', 'update', '--latest', this.botPackage]
        : ['plugin', '--profile', 'web', 'add', this.botPackage]
      await this.runDsh(args, this.controllerRecord(), runtime)
      runtime.updating = false
      await this.scheduleControllerRestart('DS Bot 已更新，正在重启主 DSH')
      return this.presentController()
    } catch (error) {
      runtime.updating = false
      runtime.phase = 'running'
      runtime.message = `DS Bot 更新失败：${this.teamError(error, this.controllerRecord())}`
      throw error
    }
  }

  async isControllerFeishuInstalled() {
    return this.isPackagedFeishuPluginInstalled(this.parentHome)
  }

  feishuPluginPath() {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'ds-headbot-feishu')
  }

  async isPackagedFeishuPluginInstalled(home) {
    const packageJson = path.join(home, 'profiles', 'web', 'node_modules', FEISHU_PLUGIN_NAME, 'package.json')
    try {
      const installed = JSON.parse(await readFile(packageJson, 'utf8'))
      const source = JSON.parse(await readFile(path.join(this.feishuPluginPath(), 'package.json'), 'utf8'))
      if (installed.name !== FEISHU_PLUGIN_NAME || installed.version !== source.version) return false
      const [installedDirectory, sourceDirectory] = await Promise.all([
        realpath(path.dirname(packageJson)),
        realpath(this.feishuPluginPath()),
      ])
      // A pnpm link to the controller's source tree cannot resolve peer dependencies
      // from an isolated team profile. A packaged dependency is installed in that profile.
      return installedDirectory !== sourceDirectory
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  }

  async packFeishuPlugin() {
    const source = this.feishuPluginPath()
    const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'))
    if (manifest.name !== FEISHU_PLUGIN_NAME || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
      throw new Error('ds-headbot-feishu package metadata is invalid')
    }
    const digest = await hashPackageDirectory(source)
    const packagesDirectory = path.join(this.root, 'packages')
    await mkdir(packagesDirectory, { recursive: true, mode: 0o700 })
    const archive = path.join(packagesDirectory, `${manifest.name}-${manifest.version}-${digest.slice(0, 16)}.tgz`)
    try {
      await access(archive)
      return archive
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }

    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'headbot-feishu-pack-'))
    try {
      const bundledNpm = path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
      let command = 'npm'
      let args = ['pack', source, '--pack-destination', temporaryDirectory, '--ignore-scripts', '--silent']
      try {
        await access(bundledNpm)
        command = process.execPath
        args = [bundledNpm, ...args]
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      await runPack(command, args, source)
      const packedArchive = path.join(temporaryDirectory, `${manifest.name}-${manifest.version}.tgz`)
      await access(packedArchive)
      await rename(packedArchive, archive)
      await chmod(archive, 0o600)
      return archive
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }

  watchControllerFeishuTarget() {
    clearInterval(this.controllerRuntime.feishuMonitor)
    this.controllerRuntime.feishuMonitor = undefined
    if (!this.controller.feishu.enabled) return
    this.controllerRuntime.feishuMonitor = setInterval(async () => {
      if (this.closing || !this.controller.feishu.enabled || this.controllerRuntime.restartScheduled || this.controllerRuntime.updating || ['provisioning', 'updating', 'restarting'].includes(this.controllerRuntime.phase)) return
      try {
        const agentId = await this.resolveFeishuTargetSession(this.controllerRecord())
        if (agentId === this.controller.feishuAgentId) return
        this.controller.feishuAgentId = agentId
        await this.writeControllerFeishuPatch(this.controller.feishu, agentId)
        await this.saveControllerSettings()
        this.controllerRuntime.feishuStatus = 'connecting'
        await this.scheduleControllerRestart('默认 Bot 会话已变化，正在刷新飞书绑定')
      } catch (error) {
        this.warn(`check default Feishu binding: ${safeError(error)}`)
      }
    }, 30_000)
    this.controllerRuntime.feishuMonitor.unref?.()
  }

  async isTeamFeishuInstalled(team) {
    return this.isPackagedFeishuPluginInstalled(path.join(this.root, 'teams', team.id, 'home'))
  }

  async writeControllerFeishuPatch(settings, agentId) {
    const directory = path.join(this.parentHome, 'profiles', 'web')
    const file = path.join(directory, 'cordis.patch.yml')
    let patches = []
    try {
      patches = parse(await readFile(file, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (!Array.isArray(patches)) throw new Error('parent Web profile patch must be an array')
    const matches = patches.map((entry, index) => entry && entry.id === FEISHU_PLUGIN_NAME ? index : -1).filter(index => index >= 0)
    if (matches.length > 1) throw new Error(`the parent Web profile patch contains multiple ${FEISHU_PLUGIN_NAME} entries; preserve it and resolve them before configuring Feishu`)
    const index = matches[0] ?? -1
    const pluginInstalled = await this.isControllerFeishuInstalled()
    if (!settings.enabled && !pluginInstalled && index < 0) {
      if (await this.isLegacyFeishuInstalled(directory)) upsertDisabledPatch(patches, 'feishu-bot', '@zyfgood/dsh-feishu-bot')
      else return
    }
    const patch = index >= 0 ? patches[index] : { id: FEISHU_PLUGIN_NAME, name: FEISHU_PLUGIN_NAME }
    if (settings.enabled) {
      patch.name = FEISHU_PLUGIN_NAME
      patch.disabled = false
      patch.config = {
        ...(patch.config && typeof patch.config === 'object' ? patch.config : {}),
        appId: 'env:HEADBOT_DEFAULT_FEISHU_APP_ID',
        appSecret: 'env:HEADBOT_DEFAULT_FEISHU_APP_SECRET',
        domain: 'feishu', mode: 'agent', agentId, replyToSource: true,
        dmMode: 'open', requireMention: true, commands: true, tools: true,
      }
    } else {
      patch.disabled = true
    }
    if (pluginInstalled || settings.enabled || index >= 0) {
      if (index < 0) patches.push(patch)
    }
    if (await this.isLegacyFeishuInstalled(directory)) {
      upsertDisabledPatch(patches, 'feishu-bot', '@zyfgood/dsh-feishu-bot')
    }
    if (!pluginInstalled && !settings.enabled && index < 0 && patches.length === 0) return
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writePrivateFile(file, stringify(patches))
  }

  async isLegacyFeishuInstalled(profileHome) {
    try {
      await access(path.join(profileHome, 'node_modules', '@zyfgood', 'dsh-feishu-bot', 'package.json'))
      return true
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  }

  async writeControllerFeishuEnvironment(settings, secret) {
    const file = path.join(this.parentHome, '.env')
    const start = '# BEGIN DS-Headbot default Feishu settings'
    const end = '# END DS-Headbot default Feishu settings'
    let content = ''
    try { content = await readFile(file, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    const lines = content.split(/\r?\n/)
    const begin = lines.indexOf(start)
    const finish = lines.indexOf(end)
    if ((begin < 0) !== (finish < 0) || (begin >= 0 && finish < begin)) throw new Error('the DSH .env file has an incomplete Headbot Feishu block; preserve it and inspect before editing')
    if (begin >= 0) lines.splice(begin, finish - begin + 1)
    let next = lines.join('\n').replace(/\n*$/, '')
    if (settings.enabled) {
      const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`
      const block = [start,
        `HEADBOT_DEFAULT_FEISHU_APP_ID=${quote(settings.appId)}`,
        `HEADBOT_DEFAULT_FEISHU_APP_SECRET=${quote(secret)}`,
        end].join('\n')
      next = `${next ? `${next}\n` : ''}${block}\n`
    } else if (next) next += '\n'
    await writePrivateFile(file, next)
  }

  async getTeamBots(id) {
    await this.initialize()
    if (id === 'default') return this.readBots(path.join(this.parentHome, 'bot', 'state.json'))
    const team = this.findTeam(id)
    if (!team) throw httpError(404, `team "${id}" not found`)
    const stateFile = path.join(this.root, 'teams', id, 'home', 'bot', 'state.json')
    return this.readBots(stateFile)
  }

  async readBots(stateFile) {
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
    const stateFile = team.id === 'default'
      ? path.join(this.parentHome, 'bot', 'state.json')
      : path.join(this.root, 'teams', team.id, 'home', 'bot', 'state.json')
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
  }

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
  }

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
  }

  async restartTeam(id) {
    if (id === 'default') return this.restartController()
    if (this.runtime.get(id)?.updating) throw httpError(409, 'wait for the DS Bot update to finish before restarting this team')
    await this.stopTeam(id)
    const runtime = this.runtime.get(id)
    if (!runtime || runtime.deleting) throw httpError(409, 'this team is being deleted')
    runtime.stopRequested = false
    runtime.explicitStop = false
    return this.startTeam(id)
  }

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
  }

  async close() {
    this.closing = true
    clearInterval(this.controllerRuntime.feishuMonitor)
    this.controllerRuntime.feishuMonitor = undefined
    const ids = [...this.runtime.keys()]
    await Promise.all(ids.map(id => this.stopTeam(id).catch(error => this.warn(`stop ${id}: ${safeError(error)}`))))
  }

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
  }

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
  }

  redactFeishuSecret(value, team) {
    const secret = this.feishuSecrets[team.id]
    return secret ? String(value).split(secret).join('[redacted Feishu secret]') : String(value)
  }

  redactModelSecrets(value) {
    let text = String(value)
    for (const model of this.models) {
      const secrets = [this.modelSecrets[model.id], model.apiKeyEnv && process.env[model.apiKeyEnv], model.legacyApiKeyEnv && process.env[model.legacyApiKeyEnv]]
      for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted model API key]')
    }
    return text
  }

  teamError(value, team) {
    return safeError(this.redactModelSecrets(this.redactFeishuSecret(value instanceof Error ? value.message : value, team)))
  }

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
    return `http://${this.publicHost}/${this.teamsPath}/${team.id}/`
  }

  presentController() {
    const runtime = this.controllerRuntime
    return {
      id: 'default',
      instanceId: 'controller',
      kind: 'controller',
      protected: true,
      name: this.controller.name,
      modelId: this.controller.modelId,
      modelName: this.models.find(model => model.id === this.controller.modelId)?.name,
      port: this.parentPort,
      autoStart: true,
      botInstalled: true,
      feishu: {
        enabled: this.controller.feishu.enabled,
        appId: this.controller.feishu.appId,
        botId: this.controller.feishu.botId,
        hasSecret: Boolean(this.feishuSecrets.default),
        status: this.controller.feishu.enabled ? (runtime.feishuStatus || 'unknown') : 'disabled',
      },
      status: runtime.phase || 'running',
      message: runtime.message,
      pid: undefined,
      url: `http://${this.publicHost}/${this.controllerPath}/`,
      launchUrl: `http://${this.publicHost}/${this.controllerPath}/`,
      restartCount: 0,
    }
  }

  present(team) {
    const runtime = this.runtime.get(team.id) ?? newRuntime()
    const feishuStatusFresh = runtime.feishuStatusUpdatedAt && Date.now() - runtime.feishuStatusUpdatedAt <= 10_000
    const agentStatusFresh = runtime.agentStatusUpdatedAt && Date.now() - runtime.agentStatusUpdatedAt <= 10_000
    return {
      id: team.id,
      instanceId: team.instanceId,
      name: team.name,
      port: team.port,
      modelId: team.modelId,
      modelName: this.models.find(model => model.id === team.modelId)?.name,
      autoStart: team.autoStart,
      botInstalled: team.botInstalled,
      feishu: {
        enabled: team.feishu.enabled,
        appId: team.feishu.appId,
        botId: team.feishu.botId,
        hasSecret: Boolean(this.feishuSecrets[team.id]),
        status: team.feishu.enabled ? (runtime.phase === 'running' && !feishuStatusFresh ? 'unknown' : runtime.feishuStatus) : 'disabled',
        agentStatus: team.feishu.enabled ? (runtime.phase === 'running' && !agentStatusFresh ? 'unknown' : (runtime.feishuAgentStatus || 'offline')) : 'disabled',
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
      if (team.id === 'default') throw new Error('team id "default" is reserved for the protected DSH controller instance')
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

  async loadControllerSettings() {
    try {
      const document = JSON.parse(await readFile(this.controllerFile, 'utf8'))
      if (document.version !== 1) throw new Error('unsupported controller metadata version')
      this.controller = {
        name: validateName(document.name),
        modelId: document.modelId === undefined || document.modelId === null ? undefined : validateModelId(document.modelId),
        feishuInstalled: document.feishuInstalled === true,
        feishuAgentId: typeof document.feishuAgentId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(document.feishuAgentId) ? document.feishuAgentId : undefined,
        feishu: validateStoredFeishuSettings(document.feishu),
      }
      this.controllerRuntime.feishuStatus = this.controller.feishu.enabled ? 'unknown' : 'disabled'
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('unable to load default-instance metadata; preserve the file and inspect it before repair')
      await this.saveControllerSettings()
    }
  }

  async saveControllerSettings() {
    const document = {
      version: 1,
      name: this.controller.name,
      ...(this.controller.modelId ? { modelId: this.controller.modelId } : {}),
      feishuInstalled: this.controller.feishuInstalled,
      feishuAgentId: this.controller.feishuAgentId || null,
      feishu: this.controller.feishu,
    }
    await writePrivateJson(this.controllerFile, document)
  }

  async loadModelCatalog() {
    try {
      const document = JSON.parse(await readFile(this.modelSecretFile, 'utf8'))
      if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('invalid model secret document')
      for (const [id, secret] of Object.entries(document)) {
        validateModelId(id)
        validateModelSecret(secret)
      }
      this.modelSecrets = document
      await chmod(this.modelSecretFile, 0o600)
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('unable to load the protected model credential file; preserve it and inspect it before repair')
    }
    try {
      const document = JSON.parse(await readFile(this.modelFile, 'utf8'))
      if (document.version !== 1 || !Array.isArray(document.models) || document.models.length > 100) throw new Error('unsupported model catalog format')
      this.models = document.models.map(validateStoredModel)
      await chmod(this.modelFile, 0o600)
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('unable to load the model catalog; preserve it and inspect it before repair')
      const seeded = await readDefaultModelDefinition(this.parentHome)
      this.models = seeded ? [seeded] : []
      await this.saveModels()
    }
    const ids = new Set()
    for (const model of this.models) {
      if (ids.has(model.id)) throw new Error(`model catalog repeats model id ${model.id}`)
      ids.add(model.id)
    }
  }

  async migrateModelAssignments() {
    let changed = false
    if (!this.controller.modelId) {
      const botRef = await readCommonBotModelRef(path.join(this.parentHome, 'bot', 'state.json'))
      const configured = await readDefaultModelDefinition(this.parentHome)
      if (botRef !== null) {
        const ref = botRef || (configured ? modelRef(configured) : await readDefaultModelRef(this.parentHome))
        const match = this.models.find(model => modelRef(model) === ref && (botRef || !configured || model.baseURL === configured.baseURL))
        if (match) { this.controller.modelId = match.id; changed = true }
      }
    }
    for (const team of this.teams) {
      if (team.modelId) continue
      const home = path.join(this.root, 'teams', team.id, 'home')
      const botRef = await readCommonBotModelRef(path.join(home, 'bot', 'state.json'))
      if (botRef === null) continue
      const configured = await readDefaultModelDefinition(home)
      const ref = botRef || (configured ? modelRef(configured) : await readDefaultModelRef(home))
      const match = this.models.find(model => modelRef(model) === ref && (botRef || !configured || model.baseURL === configured.baseURL))
      if (match) { team.modelId = match.id; changed = true }
    }
    if (changed) {
      await this.save()
      await this.saveControllerSettings()
    }
  }

  async saveModels() {
    await writePrivateJson(this.modelFile, { version: 1, models: this.models })
  }

  async saveModelSecrets() {
    await writePrivateJson(this.modelSecretFile, this.modelSecrets)
  }

  async saveFeishuSecrets() {
    const temporary = `${this.feishuSecretFile}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(this.feishuSecrets, null, 2) + '\n', { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, this.feishuSecretFile)
    await chmod(this.feishuSecretFile, 0o600)
  }

  findModel(id) {
    return this.models.find(model => model.id === id)
  }

  requireModel(id) {
    if (typeof id !== 'string' || !this.findModel(id)) throw httpError(400, 'choose a model from the saved model list')
    return this.findModel(id)
  }

  presentModel(model) {
    return {
      id: model.id,
      name: model.name,
      baseURL: model.baseURL,
      modelId: model.modelId,
      hasApiKey: Boolean(this.modelSecrets[model.id] || (model.apiKeyEnv && process.env[model.apiKeyEnv])),
    }
  }

  controllerModelFiles() {
    return [
      path.join(this.parentHome, 'profiles', 'web', 'cordis.patch.yml'),
      path.join(this.parentHome, '.env'),
      this.controllerModelTransitionFile,
    ]
  }

  async applyControllerModelFiles(model) {
    await this.writeInstanceModelConfig(this.parentHome, model)
  }

  async assertControllerModelTransitionReady() {
    if (process.platform !== 'darwin' || typeof process.getuid !== 'function' || this.restartCommand !== undefined) {
      throw httpError(409, 'safely changing the default instance model requires its macOS LaunchAgent; configure a LaunchAgent-based controller before retrying')
    }
    if (!/^[A-Za-z0-9.-]+$/.test(this.launchdLabel)) throw httpError(500, 'launchdLabel is invalid')
    try { await access(this.launchdPlist) } catch (error) {
      if (error.code === 'ENOENT') throw httpError(409, `the default DSH LaunchAgent plist was not found at ${this.launchdPlist}`)
      throw error
    }
  }

  async writeControllerModelTransitionStatus(status) {
    await writePrivateJson(this.controllerModelTransitionFile, status)
  }

  async loadControllerModelTransitionStatus() {
    try {
      const status = JSON.parse(await readFile(this.controllerModelTransitionFile, 'utf8'))
      if (status?.status === 'failed') {
        this.controllerRuntime.message = `默认实例模型切换失败：${safeError(status.message || '未知错误')}`
      } else if (status?.status === 'pending') {
        this.controllerRuntime.message = '默认实例模型切换尚未完成；请检查 DSH 服务与模型切换日志后再重试'
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.warn(`read controller model transition status: ${safeError(error)}`)
    }
  }

  async startControllerModelTransition(ref) {
    await this.assertControllerModelTransitionReady()
    const helperLabel = `com.ds-headbot.model-transition.${randomUUID()}`
    const payload = Buffer.from(JSON.stringify({
      dataRoot: this.root,
      stateFile: path.join(this.parentHome, 'bot', 'state.json'),
      lockFile: path.join(this.parentHome, 'bot', 'state.lock'),
      modelRef: ref,
      launchdLabel: this.launchdLabel,
      launchdPlist: this.launchdPlist,
      uid: process.getuid(),
      helperLabel,
    })).toString('base64url')
    const worker = spawn('/bin/launchctl', [
      'submit', '-l', helperLabel, '--', process.execPath, '-e', controllerModelTransitionWorker, payload,
    ], { stdio: 'ignore' })
    await new Promise((resolve, reject) => {
      worker.once('spawn', resolve)
      worker.once('error', reject)
    })
    await new Promise((resolve, reject) => {
      worker.once('error', reject)
      worker.once('close', code => code === 0 ? resolve() : reject(new Error(`launchctl submit exited with ${code ?? 'unknown'}`)))
    })
  }

  async writeControllerModelEnvironment(model) {
    const file = path.join(this.parentHome, '.env')
    const begin = '# BEGIN DS-Headbot model credentials'
    const end = '# END DS-Headbot model credentials'
    let content = ''
    try { content = await readFile(file, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    const lines = content.split(/\r?\n/)
    const from = lines.indexOf(begin)
    const to = lines.indexOf(end)
    if ((from < 0) !== (to < 0) || (from >= 0 && to < from)) throw new Error('the DSH .env file has an incomplete Headbot model block; preserve it and inspect before editing')
    if (from >= 0) lines.splice(from, to - from + 1)
    let next = lines.join('\n').replace(/\n*$/, '')
    const secret = this.modelSecrets[model.id]
    if (secret) {
      const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`
      next = `${next ? `${next}\n` : ''}${begin}\n${model.apiKeyEnv}=${quote(secret)}\n${end}\n`
    } else if (next) next += '\n'
    await writePrivateFile(file, next)
  }

  async applyTeamModel(team, model, { force = false, returnSnapshot = false } = {}) {
    const runtime = this.runtime.get(team.id)
    if (runtime?.deleting || runtime?.updating || runtime?.command || runtime?.task) {
      throw httpError(409, `wait for the current operation on ${team.name} before changing its model`)
    }
    if (!force && team.modelId === model.id) return this.present(team)
    const home = path.join(this.root, 'teams', team.id, 'home')
    const files = [path.join(home, 'profiles', 'web', 'cordis.patch.yml'), path.join(home, 'bot', 'state.json')]
    const snapshot = await captureFiles(files)
    const previousModelId = team.modelId
    const wasRunning = Boolean(runtime?.child || (team.autoStart && runtime?.phase === 'failed'))
    if (wasRunning) await this.stopTeam(team.id)
    try {
      await this.writeInstanceModelConfig(home, model)
      await this.writeBotModelState(home, model)
      team.modelId = model.id
      await this.save()
      if (wasRunning) {
        await this.startTeam(team.id)
        const current = this.runtime.get(team.id)
        if (current?.phase !== 'running') throw new Error(current?.message || `team ${team.id} did not return to running state`)
      }
      return returnSnapshot ? { team, snapshot, previousModelId, wasRunning } : this.present(team)
    } catch (error) {
      if (this.runtime.get(team.id)?.child) await this.stopTeam(team.id).catch(() => {})
      team.modelId = previousModelId
      await restoreFiles(snapshot).catch(rollbackError => this.warn(`restore ${team.id} model files: ${safeError(rollbackError)}`))
      await this.save().catch(rollbackError => this.warn(`restore ${team.id} model assignment: ${safeError(rollbackError)}`))
      if (wasRunning) {
        await this.startTeam(team.id)
        if (this.runtime.get(team.id)?.phase !== 'running') this.warn(`team ${team.id} did not return to running state after model rollback`)
      }
      throw error
    }
  }

  async ensureInstanceModel(team) {
    const model = this.requireModel(team.modelId)
    const home = path.join(this.root, 'teams', team.id, 'home')
    await this.writeInstanceModelConfig(home, model)
    await this.writeBotModelState(home, model)
  }

  async writeInstanceModelConfig(home, model) {
    const directory = path.join(home, 'profiles', 'web')
    const file = path.join(directory, 'cordis.patch.yml')
    let entries = []
    try { entries = parse(await readFile(file, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (entries === undefined || entries === null) entries = []
    if (!Array.isArray(entries)) throw new Error('Web profile patch must be an array before assigning a model')
    const llm = uniquePatch(entries, 'llm-pi-ai')
    const defaultModel = uniquePatch(entries, 'agent-default-model')
    const providerPatch = llm ?? { id: 'llm-pi-ai', config: { providers: {} } }
    if (!providerPatch.config || typeof providerPatch.config !== 'object' || Array.isArray(providerPatch.config)) providerPatch.config = {}
    if (!providerPatch.config.providers || typeof providerPatch.config.providers !== 'object' || Array.isArray(providerPatch.config.providers)) providerPatch.config.providers = {}
    const oldProvider = providerPatch.config.providers[model.id] && typeof providerPatch.config.providers[model.id] === 'object'
      ? providerPatch.config.providers[model.id] : {}
    const oldModels = Array.isArray(oldProvider.models) ? oldProvider.models.filter(item => item && item.id !== model.modelId) : []
    providerPatch.config.providers[model.id] = {
      ...oldProvider,
      displayName: model.name,
      apiKeyEnv: model.apiKeyEnv,
      api: 'openai-completions',
      baseURL: model.baseURL,
      ...(model.compat ? { compat: model.compat } : {}),
      models: [...oldModels, { id: model.modelId }],
    }
    if (!llm) entries.push(providerPatch)
    const defaultPatch = defaultModel ?? { id: 'agent-default-model', config: {} }
    if (!defaultPatch.config || typeof defaultPatch.config !== 'object' || Array.isArray(defaultPatch.config)) defaultPatch.config = {}
    defaultPatch.config.provider = model.id
    defaultPatch.config.model = model.modelId
    if (!defaultModel) entries.push(defaultPatch)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writePrivateFile(file, stringify(entries))
  }

  async writeBotModelState(home, model) {
    const file = path.join(home, 'bot', 'state.json')
    let state
    try { state = JSON.parse(await readFile(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return false; throw new Error('unable to read this instance DS Bot state before changing its model') }
    if (!state || typeof state !== 'object' || Array.isArray(state) || !state.bots || typeof state.bots !== 'object' || Array.isArray(state.bots)) {
      throw new Error('this instance DS Bot state has an unsupported format; preserve it before changing its model')
    }
    const ref = modelRef(model)
    for (const bot of Object.values(state.bots)) {
      if (!bot || typeof bot !== 'object' || Array.isArray(bot)) continue
      bot.model = ref
      delete bot.appliedModel
      delete bot.appliedEffort
      delete bot.effort
    }
    await writePrivateJson(file, state)
    return true
  }

  prepareModelEnvironment(env, modelId) {
    const selected = this.models.find(item => item.id === modelId)
    const key = selected && (this.modelSecrets[selected.id] || (selected.apiKeyEnv ? env[selected.apiKeyEnv] : undefined))
    for (const item of this.models) {
      if (item.apiKeyEnv) delete env[item.apiKeyEnv]
      if (item.legacyApiKeyEnv) delete env[item.legacyApiKeyEnv]
    }
    for (const keyName of Object.keys(env)) if (keyName.startsWith('HEADBOT_MODEL_')) delete env[keyName]
    if (selected && key) env[selected.apiKeyEnv] = key
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
    feishuAgentStatus: 'stopped',
    generation: undefined,
    feishuStatusUpdatedAt: undefined,
    agentStatusUpdatedAt: undefined,
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
    modelId: team.modelId === undefined || team.modelId === null ? undefined : validateModelId(team.modelId),
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
  for (const key of Object.keys(env)) if (key.startsWith('DSH_') || key.startsWith('HEADBOT_TEAM_') || key.startsWith('HEADBOT_DEFAULT_FEISHU_') || key.startsWith('FEISHU_') || key === 'HEADBOT_BROKER_URL') delete env[key]
  env.DSH_HOME = home
  return env
}

async function writePrivateFile(file, content) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    const current = await lstat(file)
    if (current.isSymbolicLink()) throw new Error(`refusing to replace symbolic link ${file}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, content, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, file)
  await chmod(file, 0o600)
}

async function writePrivateJson(file, value) {
  await writePrivateFile(file, `${JSON.stringify(value, null, 2)}\n`)
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

async function readDefaultModelDefinition(home) {
  const file = path.join(home, 'profiles', 'web', 'cordis.patch.yml')
  let entries
  try { entries = parse(await readFile(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
  if (!Array.isArray(entries)) throw new Error('controller Web profile patch must be an array before importing its current model')
  const selected = uniquePatch(entries, 'agent-default-model')
  const providerPatch = uniquePatch(entries, 'llm-pi-ai')
  const providerId = selected?.config?.provider
  const modelId = selected?.config?.model
  const provider = providerPatch?.config?.providers?.[providerId]
  if (typeof providerId !== 'string' || typeof modelId !== 'string' || !provider || typeof provider !== 'object' || typeof provider.baseURL !== 'string') return undefined
  return validateStoredModel({
    id: providerId,
    name: provider.displayName || `${providerId} ${modelId}`,
    baseURL: provider.baseURL,
    modelId,
    apiKeyEnv: provider.apiKeyEnv || modelKeyEnv(providerId),
    compat: provider.compat,
  })
}

async function readDefaultModelRef(home) {
  try {
    const entries = parse(await readFile(path.join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'))
    if (!Array.isArray(entries)) return undefined
    const selected = uniquePatch(entries, 'agent-default-model')
    const provider = selected?.config?.provider
    const model = selected?.config?.model
    return typeof provider === 'string' && typeof model === 'string' ? `${provider}/${model}` : undefined
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

async function readCommonBotModelRef(file) {
  try {
    const state = JSON.parse(await readFile(file, 'utf8'))
    const bots = Object.values(state?.bots ?? {})
    if (!bots.length) return undefined
    const selections = bots.map(bot => bot?.model ?? bot?.appliedModel)
    if (selections.some(ref => typeof ref !== 'string')) return null
    const refs = [...new Set(selections)]
    return refs.length === 1 ? refs[0] : null
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw new Error('unable to inspect a team’s DS Bot models during model migration')
  }
}

function validateModelInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'model must be an object')
  const id = validateModelId(input.id)
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > 80) throw httpError(400, 'model name must be between 1 and 80 characters')
  const modelId = validateRemoteModelId(input.modelId)
  const baseURL = validateModelBaseURL(input.baseURL)
  const apiKeyEnv = input.apiKeyEnv === undefined ? modelKeyEnv(id) : validateModelEnvironmentName(input.apiKeyEnv)
  const legacyApiKeyEnv = input.legacyApiKeyEnv === undefined ? undefined : validateModelEnvironmentName(input.legacyApiKeyEnv)
  let compat
  if (input.compat !== undefined && input.compat !== null) {
    if (!input.compat || typeof input.compat !== 'object' || Array.isArray(input.compat)) throw httpError(400, 'model compatibility settings must be an object')
    compat = {}
    if (input.compat.supportsDeveloperRole !== undefined) {
      if (typeof input.compat.supportsDeveloperRole !== 'boolean') throw httpError(400, 'supportsDeveloperRole must be a boolean')
      compat.supportsDeveloperRole = input.compat.supportsDeveloperRole
    }
    if (input.compat.maxTokensField !== undefined) {
      if (typeof input.compat.maxTokensField !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(input.compat.maxTokensField)) throw httpError(400, 'maxTokensField is invalid')
      compat.maxTokensField = input.compat.maxTokensField
    }
    if (Object.keys(compat).length === 0) compat = undefined
  }
  return { id, name, baseURL, modelId, api: 'openai-completions', apiKeyEnv, ...(legacyApiKeyEnv ? { legacyApiKeyEnv } : {}), ...(compat ? { compat } : {}) }
}

function validateStoredModel(value) {
  const model = validateModelInput(value)
  return model
}

function validateModelId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw httpError(400, 'model id must be a lowercase URL-safe slug')
  return value
}

function validateRemoteModelId(value) {
  if (typeof value !== 'string') throw httpError(400, 'model id is required')
  const modelId = value.trim()
  if (!modelId || modelId.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(modelId)) throw httpError(400, 'model id may contain letters, digits, dot, underscore, colon, slash, plus, and hyphen')
  return modelId
}

function validateModelBaseURL(value) {
  if (typeof value !== 'string' || value.trim() !== value || !value || value.length > 2048) throw httpError(400, 'model endpoint URL is required')
  let url
  try { url = new URL(value) } catch { throw httpError(400, 'model endpoint URL is invalid') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw httpError(400, 'model endpoint must be an HTTP(S) URL without credentials, query, or fragment')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

function validateModelEnvironmentName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) throw httpError(400, 'model API key environment name is invalid')
  return value
}

function validateModelSecret(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.trim() !== value || /[\s\x00-\x1f\x7f]/.test(value)) throw httpError(400, 'API key must be a non-empty token of at most 4096 characters without whitespace')
  return value
}

function readModelSecretInput(input, { optional = false } = {}) {
  if (input.apiKey === undefined || input.apiKey === null || input.apiKey === '') return undefined
  if (typeof input.apiKey !== 'string') throw httpError(400, 'API key must be text')
  try { return validateModelSecret(input.apiKey) } catch (error) {
    if (optional) throw error
    throw error
  }
}

function modelKeyEnv(id) {
  return `HEADBOT_MODEL_${id.toUpperCase().replace(/-/g, '_')}_API_KEY`
}

function modelRef(model) {
  return `${model.id}/${model.modelId}`
}

function modelRuntimeSignature(model) {
  return JSON.stringify({ id: model.id, name: model.name, baseURL: model.baseURL, modelId: model.modelId, api: model.api, apiKeyEnv: model.apiKeyEnv, compat: model.compat })
}

function uniquePatch(entries, id) {
  const matches = entries.filter(entry => entry && entry.id === id)
  if (matches.length > 1) throw new Error(`Web profile patch contains multiple ${id} entries; preserve it and resolve duplicates first`)
  return matches[0]
}

async function captureFiles(files) {
  return Promise.all(files.map(async file => {
    try { return { file, data: await readFile(file) } } catch (error) {
      if (error.code === 'ENOENT') return { file, data: undefined }
      throw error
    }
  }))
}

async function restoreFiles(snapshot) {
  for (const item of snapshot ?? []) {
    if (item.data === undefined) await unlink(item.file).catch(error => { if (error.code !== 'ENOENT') throw error })
    else await writePrivateFile(item.file, item.data)
  }
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

