import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  CONTROLLER_ID,
  CONTROLLER_INSTANCE_ID,
  CONTROLLER_TOKEN,
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
import { ignoreFailureOnce, infoLine, warnLine } from '../observe.js'

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
    await this.loadRuntimePids()
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

  // Communication roster: the controller plus every managed team, minus the caller itself.
  async listCommunicationPeers(excludeInstanceId) {
    await this.initialize()
    return [this.presentController(), ...this.teams.map(team => this.present(team))]
      .filter(instance => instance.instanceId !== excludeInstanceId)
      .map(({ id, name, status }) => ({ id, name, status }))
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
    if (team) return this.identity(team)
    const controllerToken = this.controller.communicationToken
    if (typeof controllerToken === 'string' && CONTROLLER_TOKEN.test(controllerToken) && timingSafeEqual(token, Buffer.from(controllerToken))) return this.controllerIdentity()
    return undefined
  },

  identity(team) {
    return { id: team.id, name: team.name, instanceId: team.instanceId }
  },

  // Reachability for the audited broker and its inbox push: the process lifecycle is the only
  // liveness source, so a recipient counts as reachable while its instance is running. No
  // separate probe, no HTTP round trip — an offline answer must be cheap and immediate.
  isCommunicationTargetOnline(id) {
    if (id === CONTROLLER_ID) return this.controllerRuntime?.phase === 'running'
    return this.runtime.get(id)?.phase === 'running'
  },

  // The protected controller instance is a participant of its own audited circle:
  // its bots raise tickets and receive escalations exactly like any managed team.
  controllerIdentity() {
    return { id: CONTROLLER_ID, name: this.controller.name, instanceId: CONTROLLER_INSTANCE_ID }
  },

  async save() {
    this.writeQueue = this.writeQueue.catch((error) => ignoreFailureOnce(this.logger, 'manager/state', 'previous teams save', error)).then(async () => {
      const document = JSON.stringify({ version: 2, teams: this.teams }, null, 2) + '\n'
      const temporary = `${this.stateFile}.${process.pid}.tmp`
      await writeFile(temporary, document, { mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, this.stateFile)
    })
    return this.writeQueue
  },

  // Runtime adoption ledger (audit finding P1-1): detached team children outlive the controller,
  // so the pid+generation that spawn produced is persisted here and startTeam adopts the process
  // back after a controller restart instead of colliding with it on the port.
  async loadRuntimePids() {
    this.runtimePids = {}
    try {
      const document = JSON.parse(await readFile(this.runtimePidFile, 'utf8'))
      if (!document || typeof document !== 'object' || Array.isArray(document)) return
      for (const [id, entry] of Object.entries(document)) {
        if (!entry || typeof entry !== 'object') continue
        if (!Number.isSafeInteger(entry.pid) || entry.pid <= 0) continue
        if (!Number.isSafeInteger(entry.port) || entry.port < 1 || entry.port > 65535) continue
        if (entry.generation !== undefined && typeof entry.generation !== 'string') continue
        this.runtimePids[id] = { pid: entry.pid, port: entry.port, generation: entry.generation, startedAt: entry.startedAt }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.warn(`runtime-pids.json unreadable, starting without adoption data: ${error.message}`)
    }
  },

  // Persistence is best-effort on purpose: the spawn already succeeded, so losing the ledger entry
  // must never fail the start; it only costs the adoption chance after the next controller restart.
  async recordRuntimePid(team, runtime) {
    if (!Number.isSafeInteger(runtime.pid) || runtime.pid <= 0) return
    this.runtimePids[team.id] = { pid: runtime.pid, port: team.port, generation: runtime.generation, startedAt: new Date().toISOString() }
    try {
      await writePrivateJson(this.runtimePidFile, this.runtimePids)
    } catch (error) {
      this.warn(`unable to persist the runtime pid for ${team.id}: ${error.message}`)
    }
  },

  async clearRuntimePid(id) {
    if (!(id in this.runtimePids)) return
    delete this.runtimePids[id]
    try {
      await writePrivateJson(this.runtimePidFile, this.runtimePids)
    } catch (error) {
      this.warn(`unable to clear the runtime pid for ${id}: ${error.message}`)
    }
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
        // Files written before the controller joined the audited circle carry no identity fields;
        // ensureControllerIdentity mints them and the persistence below upgrades the file in place.
        instanceId: CONTROLLER_INSTANCE_ID,
        communicationToken: typeof document.communicationToken === 'string' && CONTROLLER_TOKEN.test(document.communicationToken) ? document.communicationToken : undefined,
      }
      this.controllerRuntime.feishuStatus = this.controller.feishu.enabled ? 'unknown' : 'disabled'
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('unable to load default-instance metadata; preserve the file and inspect it before repair')
      await this.saveControllerSettings()
    }
  },

  // The controller authenticates to its own audited broker with a 256-bit credential kept in
  // controller.json next to the team state; missing identity fields (older files) are minted on
  // first load and written back at 0600. The token is never printed, only persisted.
  async saveControllerSettings() {
    this.controller.instanceId = CONTROLLER_INSTANCE_ID
    if (typeof this.controller.communicationToken !== 'string' || !CONTROLLER_TOKEN.test(this.controller.communicationToken)) this.controller.communicationToken = randomBytes(32).toString('hex')
    const document = {
      version: 1,
      name: this.controller.name,
      instanceId: CONTROLLER_INSTANCE_ID,
      communicationToken: this.controller.communicationToken,
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
    const identities = new Set([CONTROLLER_INSTANCE_ID])
    const tokens = new Set(typeof this.controller?.communicationToken === 'string' ? [this.controller.communicationToken] : [])
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
    this.mutationQueue = result.catch((error) => ignoreFailureOnce(this.logger, 'manager/state', 'previous queued mutation', error))
    return result
  },

  warn(message) {
    warnLine(this.logger, `[ds-headbot] ${message}`)
  },

  info(message) {
    infoLine(this.logger, `[ds-headbot] ${message}`)
  },
}
