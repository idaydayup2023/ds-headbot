import { randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, copyFile, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createServer as netCreateServer } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
export const packageRoot = path.resolve(moduleDir, '../..')
export const teamPluginFile = path.join(moduleDir, '..', 'team-plugin.js')
export const feishuPluginDirectory = path.join(packageRoot, 'plugins', 'ds-headbot-feishu')

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/
export const CONTROLLER_ID = 'default'
export const CONTROLLER_INSTANCE_ID = 'controller'
export const CONTROLLER_TOKEN = /^[a-f0-9]{64}$/
export const FEISHU_PLUGIN_NAME = 'ds-headbot-feishu'
const SESSION_GRANT = 'client-connection/browser-session'

export function newRuntime() {
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

export function validateStoredTeam(team, requireIdentity = false) {
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

export function validateStoredFeishuSettings(value) {
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

export function validateFeishuSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, 'feishu settings must be an object')
  if (typeof value.enabled !== 'boolean') throw httpError(400, 'Feishu enabled must be a boolean')
  const appId = typeof value.appId === 'string' ? value.appId.trim() : ''
  const botId = typeof value.botId === 'string' ? value.botId.trim() : ''
  if (appId && !/^cli_[A-Za-z0-9_-]{3,120}$/.test(appId)) throw httpError(400, 'Feishu App ID must start with cli_ and contain only letters, digits, _ or -')
  if (botId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(botId)) throw httpError(400, 'invalid target Bot ID')
  if (value.enabled && (!appId || !botId)) throw httpError(400, 'enter a Feishu App ID and choose a DS Bot before enabling Feishu')
  return { enabled: value.enabled, appId, botId }
}

export function validateId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw httpError(400, 'team id must be a lowercase URL-safe slug (letters, digits, hyphens)')
  return value
}

export function validateName(value) {
  if (typeof value !== 'string') throw httpError(400, 'team name is required')
  const name = value.trim()
  if (!name || name.length > 80) throw httpError(400, 'team name must be between 1 and 80 characters')
  return name
}

export function validPort(value, label) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw httpError(400, `${label} must be an integer from 1024 to 65535`)
  return port
}

export function validatePathSegment(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error(`${label} must be a lowercase URL-safe path segment`)
  return value
}

export function validatePublicHost(value) {
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

export function resolveUserPath(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return path.resolve(homedir(), value.slice(2))
  return path.resolve(value)
}

export function childEnvironment(home) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('DSH_') || key.startsWith('HEADBOT_TEAM_') || key.startsWith('HEADBOT_DEFAULT_FEISHU_') || key.startsWith('FEISHU_') || key === 'HEADBOT_BROKER_URL') delete env[key]
  env.DSH_HOME = home
  return env
}

export async function writePrivateFile(file, content) {
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

export async function writePrivateJson(file, value) {
  await writePrivateFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

export async function copyIfAbsent(source, destination, mode) {
  try {
    await access(source)
    await copyFile(source, destination, constants.COPYFILE_EXCL)
    await chmod(destination, mode)
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'EEXIST') throw error
  }
}

export async function cloneCredentialsWithoutBrowserGrant(source, destination) {
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

export async function cloneModelPatch(parentHome, home) {
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

export async function readDefaultModelDefinition(home) {
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

export async function readDefaultModelRef(home) {
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

export async function readCommonBotModelRef(file) {
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

export function validateModelInput(input) {
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

export function validateStoredModel(value) {
  const model = validateModelInput(value)
  return model
}

export function validateModelId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw httpError(400, 'model id must be a lowercase URL-safe slug')
  return value
}

export function validateRemoteModelId(value) {
  if (typeof value !== 'string') throw httpError(400, 'model id is required')
  const modelId = value.trim()
  if (!modelId || modelId.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(modelId)) throw httpError(400, 'model id may contain letters, digits, dot, underscore, colon, slash, plus, and hyphen')
  return modelId
}

export function validateModelBaseURL(value) {
  if (typeof value !== 'string' || value.trim() !== value || !value || value.length > 2048) throw httpError(400, 'model endpoint URL is required')
  let url
  try { url = new URL(value) } catch { throw httpError(400, 'model endpoint URL is invalid') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw httpError(400, 'model endpoint must be an HTTP(S) URL without credentials, query, or fragment')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

export function validateModelEnvironmentName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) throw httpError(400, 'model API key environment name is invalid')
  return value
}

export function validateModelSecret(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.trim() !== value || /[\s\x00-\x1f\x7f]/.test(value)) throw httpError(400, 'API key must be a non-empty token of at most 4096 characters without whitespace')
  return value
}

export function readModelSecretInput(input, { optional = false } = {}) {
  if (input.apiKey === undefined || input.apiKey === null || input.apiKey === '') return undefined
  if (typeof input.apiKey !== 'string') throw httpError(400, 'API key must be text')
  try { return validateModelSecret(input.apiKey) } catch (error) {
    if (optional) throw error
    throw error
  }
}

export function modelKeyEnv(id) {
  return `HEADBOT_MODEL_${id.toUpperCase().replace(/-/g, '_')}_API_KEY`
}

export function modelRef(model) {
  return `${model.id}/${model.modelId}`
}

export function modelRuntimeSignature(model) {
  return JSON.stringify({ id: model.id, name: model.name, baseURL: model.baseURL, modelId: model.modelId, api: model.api, apiKeyEnv: model.apiKeyEnv, compat: model.compat })
}

export function uniquePatch(entries, id) {
  const matches = entries.filter(entry => entry && entry.id === id)
  if (matches.length > 1) throw new Error(`Web profile patch contains multiple ${id} entries; preserve it and resolve duplicates first`)
  return matches[0]
}

export async function captureFiles(files) {
  return Promise.all(files.map(async file => {
    try { return { file, data: await readFile(file) } } catch (error) {
      if (error.code === 'ENOENT') return { file, data: undefined }
      throw error
    }
  }))
}

export async function restoreFiles(snapshot) {
  for (const item of snapshot ?? []) {
    if (item.data === undefined) await unlink(item.file).catch(error => { if (error.code !== 'ENOENT') throw error })
    else await writePrivateFile(item.file, item.data)
  }
}

export async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const server = netCreateServer()
    server.once('error', error => reject(error.code === 'EADDRINUSE' ? httpError(409, `port ${port} is already in use`) : error))
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()))
  })
}

export function httpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

export function safeError(value) {
  return redactTokens(String(value).replace(/\s+/g, ' ').slice(0, 1000))
}

export function redactTokens(value) {
  return value.replace(/([?&]token=)[^&\s"']+/gi, '$1[redacted]')
}

export function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '')
}

export function waitForListener(port, runtime, timeoutMs, expectedChild = runtime.child) {
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

export function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  signalProcessTree(child, 'SIGTERM')
  return waitForClose(child, new Promise(resolve => child.once('close', resolve)))
}

export function signalProcessTree(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {}
  }
  try { child.kill(signal) } catch {}
}

export function waitForClose(child, done) {
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

