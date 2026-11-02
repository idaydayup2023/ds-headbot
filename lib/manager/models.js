import { chmod, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse, stringify } from 'yaml'
import {
  writePrivateFile,
  writePrivateJson,
  readDefaultModelDefinition,
  readDefaultModelRef,
  readCommonBotModelRef,
  validateModelInput,
  validateStoredModel,
  validateModelId,
  validateModelSecret,
  readModelSecretInput,
  modelKeyEnv,
  modelRef,
  modelRuntimeSignature,
  uniquePatch,
  captureFiles,
  restoreFiles,
  httpError,
  safeError,
} from './shared.js'

export const modelMethods = {
  async listModels() {
    await this.initialize()
    return this.models.map(model => this.presentModel(model))
  },

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
  },

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
  },

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
  },

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
  },

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
  },

  async saveModels() {
    await writePrivateJson(this.modelFile, { version: 1, models: this.models })
  },

  async saveModelSecrets() {
    await writePrivateJson(this.modelSecretFile, this.modelSecrets)
  },

  findModel(id) {
    return this.models.find(model => model.id === id)
  },

  requireModel(id) {
    if (typeof id !== 'string' || !this.findModel(id)) throw httpError(400, 'choose a model from the saved model list')
    return this.findModel(id)
  },

  presentModel(model) {
    return {
      id: model.id,
      name: model.name,
      baseURL: model.baseURL,
      modelId: model.modelId,
      hasApiKey: Boolean(this.modelSecrets[model.id] || (model.apiKeyEnv && process.env[model.apiKeyEnv])),
    }
  },

  controllerModelFiles() {
    return [
      path.join(this.parentHome, 'profiles', 'web', 'cordis.patch.yml'),
      path.join(this.parentHome, '.env'),
      this.controllerModelTransitionFile,
    ]
  },

  async applyControllerModelFiles(model) {
    await this.writeInstanceModelConfig(this.parentHome, model)
  },

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
  },

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
  },

  async ensureInstanceModel(team) {
    const model = this.requireModel(team.modelId)
    const home = path.join(this.root, 'teams', team.id, 'home')
    await this.writeInstanceModelConfig(home, model)
    await this.writeBotModelState(home, model)
  },

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
  },

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
  },

  prepareModelEnvironment(env, modelId) {
    const selected = this.models.find(item => item.id === modelId)
    const key = selected && (this.modelSecrets[selected.id] || (selected.apiKeyEnv ? env[selected.apiKeyEnv] : undefined))
    for (const item of this.models) {
      if (item.apiKeyEnv) delete env[item.apiKeyEnv]
      if (item.legacyApiKeyEnv) delete env[item.legacyApiKeyEnv]
    }
    for (const keyName of Object.keys(env)) if (keyName.startsWith('HEADBOT_MODEL_')) delete env[keyName]
    if (selected && key) env[selected.apiKeyEnv] = key
  },
}
