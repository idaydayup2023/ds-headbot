import path from 'node:path'
import { homedir } from 'node:os'
import {
  CONTROLLER_INSTANCE_ID,
  newRuntime,
  validPort,
  validatePathSegment,
  validatePublicHost,
  resolveUserPath,
} from './manager/shared.js'

import { stateMethods } from './manager/state.js'
import { lifecycleMethods } from './manager/lifecycle.js'
import { modelMethods } from './manager/models.js'
import { feishuMethods } from './manager/feishu.js'
import { controllerMethods } from './manager/controller.js'

const DEFAULT_BOT_PACKAGE = 'ds-bot'

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
    this.controller = { name: '默认实例', feishuInstalled: false, feishuAgentId: undefined, feishu: { enabled: false, appId: '', botId: '' }, instanceId: CONTROLLER_INSTANCE_ID, communicationToken: undefined }
    this.controllerRuntime = { ...newRuntime(), phase: 'running', feishuStatus: 'unknown' }
    this.loaded = false
    this.initializing = undefined
    this.writeQueue = Promise.resolve()
    this.mutationQueue = Promise.resolve()
    this.closing = false
  }
}

Object.assign(HeadbotManager.prototype, stateMethods, lifecycleMethods, modelMethods, feishuMethods, controllerMethods)
