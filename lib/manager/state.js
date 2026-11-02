import { timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  newRuntime,
  validateStoredTeam,
  validateStoredFeishuSettings,
  validateId,
  validateName,
  writePrivateJson,
  copyIfAbsent,
  validateModelId,
  httpError,
} from './shared.js'

export const stateMethods = {
  async initialize() {
    if (this.loaded) return
    if (this.initializing) return this.initializing
    this.initializing = this.initializeState().finally(() => { this.initializing = undefined })
    return this.initializing
  },

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
  },

  async listTeams() {
    await this.initialize()
    return this.teams.map(team => this.present(team))
  },

  async listInstances() {
    await this.initialize()
    return [this.presentController(), ...this.teams.map(team => this.present(team))]
  },

  async getTeam(id) {
    await this.initialize()
    if (id === 'default') return this.presentController()
    const team = this.findTeam(id)
    if (!team) throw httpError(404, `team "${id}" not found`)
    return this.present(team)
  },

  async authenticateTeam(authorization) {
    await this.initialize()
    if (typeof authorization !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(authorization)) return undefined
    const token = Buffer.from(authorization.slice(7))
    const team = this.teams.find(item => timingSafeEqual(token, Buffer.from(item.communicationToken)))
    return team ? this.identity(team) : undefined
  },

  identity(team) {
    return { id: team.id, name: team.name, instanceId: team.instanceId }
  },

  async save() {
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      const document = JSON.stringify({ version: 2, teams: this.teams }, null, 2) + '\n'
      const temporary = `${this.stateFile}.${process.pid}.tmp`
      await writeFile(temporary, document, { mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, this.stateFile)
    })
    return this.writeQueue
  },

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
  },

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
  },

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
  },

  async saveFeishuSecrets() {
    const temporary = `${this.feishuSecretFile}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(this.feishuSecrets, null, 2) + '\n', { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, this.feishuSecretFile)
    await chmod(this.feishuSecretFile, 0o600)
  },

  findTeam(id) {
    return this.teams.find(team => team.id === id)
  },

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
  },

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
  },

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
  },

  teamUrl(team) {
    return `http://${this.publicHost}/${this.teamsPath}/${team.id}/`
  },

  withMutation(operation) {
    const result = this.mutationQueue.then(operation)
    this.mutationQueue = result.catch(() => {})
    return result
  },

  warn(message) {
    if (this.logger?.warn) this.logger.warn(`[ds-headbot] ${message}`)
    else console.warn(`[ds-headbot] ${message}`)
  },
}
