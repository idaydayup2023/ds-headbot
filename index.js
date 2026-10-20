import { createRequire } from 'node:module'
import { HeadbotManager } from './lib/manager.js'
import { startIngress } from './lib/ingress.js'
import { renderManagerPage } from './lib/page.js'
import { AuditedCommunications } from './lib/communications.js'
import { HeadbotReleaseUpdater } from './lib/release-updater.js'
import { HeadbotRuntimeUpdater } from './lib/runtime-updater.js'

const require = createRequire(import.meta.url)
export const version = require('./package.json').version

export const name = 'ds-headbot'
export const inject = ['connection', 'webServer']

const API_PATH = '/api/ds-headbot/v1'
const PAGE_PATH = '/manage'

export function apply(ctx, config = {}) {
  const publicHost = config.publicHost || process.env.HEADBOT_PUBLIC_HOST || 'localhost'
  const manager = new HeadbotManager(config, {
    publicHost,
    parentHome: process.env.DSH_HOME,
    parentPort: ctx.webServer.port,
    parentHost: ctx.webServer.host,
    logger: ctx.logger,
  })
  const releaseUpdater = new HeadbotReleaseUpdater({
    currentVersion: version,
    manager,
    logger: ctx.logger,
    restartCommand: config.restartCommand,
    restartArgs: config.restartArgs,
    launchdLabel: config.launchdLabel,
    pnpmCommand: config.pnpmCommand,
    dshCommand: manager.dshCommand,
  })
  const runtimeUpdater = new HeadbotRuntimeUpdater({ manager, logger: ctx.logger, dshCommand: manager.dshCommand })
  const runtimeConfig = { ...config, publicHost: manager.publicHost, publicHosts: manager.publicHosts, version }
  const communications = new AuditedCommunications(manager.root, manager, config.communicationLimits)

  ctx.effect(() => {
    const pageRoute = ctx.webServer.register({
      kind: 'prefix',
      path: PAGE_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' })
          res.end()
          return
        }
        const body = renderManagerPage(runtimeConfig)
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        })
        res.end(req.method === 'HEAD' ? undefined : body)
      },
    })

    const apiRoute = ctx.webServer.register({
      kind: 'prefix',
      path: API_PATH,
      handler: async (req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://headbot.local').pathname
        if (pathname.startsWith(`${API_PATH}/comms/v1/`)) {
          try {
            const actor = await manager.authenticateTeam(req.headers.authorization)
            if (!actor) return json(res, 401, { error: 'invalid or revoked team credential' })
            return await handleApiRequest(req, res, manager, communications, runtimeConfig, ctx.logger, actor, releaseUpdater, runtimeUpdater)
          } catch (error) {
            return json(res, error.statusCode ?? 503, { error: error.message })
          }
        }
        const rejection = ctx.connection.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection, { 'Cache-Control': 'no-store' })
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        await handleApiRequest(req, res, manager, communications, runtimeConfig, ctx.logger, undefined, releaseUpdater, runtimeUpdater)
      },
    })

    const ingress = startIngress({
      host: '127.0.0.1',
      port: Number(config.ingressPort ?? 3180),
      controllerPath: config.controllerPath ?? 'dsh',
      teamsPath: config.teamsPath ?? 'teams',
      parentHost: ctx.webServer.host,
      parentPort: ctx.webServer.port,
      manager,
      publicHost: manager.publicHost,
      publicHosts: manager.publicHosts,
      logger: ctx.logger,
    })

    void ingress.ready.then(() => manager.startEnabledTeams()).catch(error => {
      if (ctx.logger?.error) ctx.logger.error(`[ds-headbot] ingress could not start: ${error.message}`)
      else console.error(`[ds-headbot] ingress could not start: ${error.message}`)
    })

    return async () => {
      pageRoute()
      apiRoute()
      await ingress.close()
      await manager.close()
    }
  }, 'ds-headbot: manager and team processes')
}

export async function handleApiRequest(req, res, manager, communications, runtimeConfig, logger, actor, releaseUpdater, runtimeUpdater) {
  const url = new URL(req.url ?? '/', 'http://headbot.local')
  const route = url.pathname.slice(API_PATH.length) || '/'
  const method = req.method ?? 'GET'
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')

  try {
    if (method === 'GET' && route === '/release') {
      if (!releaseUpdater) return json(res, 503, { error: 'release updater unavailable' })
      return json(res, 200, await releaseUpdater.check({ force: url.searchParams.get('refresh') === '1' }))
    }
    if (method === 'POST' && route === '/release/upgrade') {
      if (!releaseUpdater) return json(res, 503, { error: 'release updater unavailable' })
      return json(res, 202, await releaseUpdater.startUpgrade())
    }
    if (method === 'GET' && route === '/runtime-versions') {
      if (!runtimeUpdater) return json(res, 503, { error: 'runtime version updater unavailable' })
      return json(res, 200, await runtimeUpdater.check({ force: url.searchParams.get('refresh') === '1' }))
    }
    if (method === 'POST' && route === '/runtime-versions/dsh/upgrade') {
      if (!runtimeUpdater) return json(res, 503, { error: 'runtime version updater unavailable' })
      return json(res, 202, await runtimeUpdater.startDshUpgrade())
    }
    if (actor) {
      if (method === 'GET' && route === '/comms/v1/teams') return json(res, 200, await communications.directory(actor))
      if (method === 'POST' && route === '/comms/v1/messages') return json(res, 201, await communications.send(actor, await readJson(req, communications.bodyLimit)))
      if (method === 'GET' && route === '/comms/v1/inbox') return json(res, 200, await communications.inbox(actor, url.searchParams.get('after') ?? 0, url.searchParams.get('limit') ?? 20))
      if (method === 'POST' && route === '/comms/v1/status') return json(res, 200, await manager.reportTeamStatus(actor, await readJson(req, 4096)))
      const download = route.match(/^\/comms\/v1\/messages\/([a-f0-9-]{36})\/attachments\/([a-f0-9-]{36})$/)
      if (method === 'GET' && download) {
        const { attachment, bytes } = await communications.attachment(actor, download[1], download[2])
        return json(res, 200, { attachment, contentBase64: bytes.toString('base64') })
      }
      return json(res, 404, { error: 'not found' })
    }
    if (method === 'GET' && route === '/audit') return json(res, 200, await communications.audit({ team: url.searchParams.get('team') ?? '', before: url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER, limit: url.searchParams.get('limit') ?? 50 }))
    if (method === 'GET' && route === '/audit/export') {
      res.setHeader('Content-Disposition', 'attachment; filename="headbot-audit.json"')
      return json(res, 200, await communications.exportAudit())
    }
    const reviewFile = route.match(/^\/audit\/messages\/([a-f0-9-]{36})\/attachments\/([a-f0-9-]{36})$/)
    if (method === 'GET' && reviewFile) {
      const { attachment, bytes } = await communications.attachment({ id: 'controller-browser' }, reviewFile[1], reviewFile[2], true)
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, 'Content-Disposition': `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(attachment.name)}` })
      return res.end(bytes)
    }
    if (method === 'GET' && route === '/teams') {
      return json(res, 200, { teams: await manager.listInstances() })
    }
    if (method === 'GET' && route === '/models') {
      return json(res, 200, { models: await manager.listModels() })
    }
    if (method === 'POST' && route === '/models') {
      const model = await manager.createModel(await readJson(req))
      return json(res, 201, { model })
    }
    const modelRoute = route.match(/^\/models\/([a-z0-9][a-z0-9-]{0,47})$/)
    if (method === 'PATCH' && modelRoute) {
      const model = await manager.updateModel(modelRoute[1], await readJson(req))
      return json(res, 200, { model })
    }
    if (method === 'DELETE' && modelRoute) {
      return json(res, 200, { deleted: await manager.deleteModel(modelRoute[1]) })
    }
    const teamBots = route.match(/^\/teams\/([a-z0-9][a-z0-9-]{0,47})\/bots$/)
    if (method === 'GET' && teamBots) {
      return json(res, 200, { bots: await manager.getTeamBots(teamBots[1]) })
    }
    if (method === 'POST' && route === '/teams') {
      const body = await readJson(req)
      const team = await manager.createTeam(body)
      void manager.startTeam(team.id).catch(error => logger?.warn?.(`[ds-headbot] start ${team.id}: ${error.message}`))
      return json(res, 202, { team: await manager.getTeam(team.id) })
    }

    const action = route.match(/^\/teams\/([a-z0-9][a-z0-9-]{0,47})\/(start|stop|restart|update-bot)$/)
    if (method === 'POST' && action) {
      const [, id, operation] = action
      if (id === 'default' && (operation === 'start' || operation === 'stop')) {
        return json(res, 409, { error: 'the default DSH controller is always running; start and stop operations are unavailable' })
      }
      if (id === 'default' && operation === 'restart') {
        return json(res, 202, { team: await manager.restartTeam(id) })
      }
      if (operation === 'start') void manager.startTeam(id).catch(error => logger?.warn?.(`[ds-headbot] start ${id}: ${error.message}`))
      if (operation === 'stop') void manager.stopTeam(id).catch(error => logger?.warn?.(`[ds-headbot] stop ${id}: ${error.message}`))
      if (operation === 'restart') void manager.restartTeam(id).catch(error => logger?.warn?.(`[ds-headbot] restart ${id}: ${error.message}`))
      if (operation === 'update-bot') void manager.updateBot(id).catch(error => logger?.warn?.(`[ds-headbot] update ${id}: ${error.message}`))
      return json(res, 202, { team: await manager.getTeam(id) })
    }

    const update = route.match(/^\/teams\/([a-z0-9][a-z0-9-]{0,47})$/)
    if (method === 'DELETE' && update) return json(res, 200, { deleted: await manager.deleteTeam(update[1]) })
    if (method === 'PATCH' && update) {
      const body = await readJson(req)
      const team = await manager.updateTeam(update[1], body)
      return json(res, 200, { team })
    }

    if (method === 'GET' && route === '/config/caddy') {
      const caddyfile = renderCaddyfile(runtimeConfig)
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="Caddyfile"',
      })
      res.end(caddyfile)
      return
    }

    json(res, 404, { error: 'not found' })
  } catch (error) {
    const status = error.statusCode ?? 500
    json(res, status, { error: error.message ?? String(error) })
  }
}

async function readJson(req, maxBytes = 16 * 1024) {
  const chunks = await new Promise((resolve, reject) => {
    const chunks = []
    let size = 0, exceeded = false
    req.on('data', chunk => {
      if (exceeded) return
      size += chunk.length
      if (size > maxBytes) {
        exceeded = true
        chunks.length = 0
        reject(Object.assign(new Error('request body is too large'), { statusCode: 413 }))
      } else chunks.push(chunk)
    })
    req.once('end', () => { if (!exceeded) resolve(chunks) })
    req.once('error', reject)
    req.once('aborted', () => reject(Object.assign(new Error('request was aborted'), { statusCode: 400 })))
  })
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('invalid JSON')
    error.statusCode = 400
    throw error
  }
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function renderCaddyfile(config) {
  const host = String(config.publicHost || process.env.HEADBOT_PUBLIC_HOST || 'localhost')
  const extras = config.publicHosts ?? process.env.HEADBOT_PUBLIC_HOSTS?.split(',').map(value => value.trim()).filter(Boolean) ?? []
  if (!Array.isArray(extras) || extras.length > 15) throw new Error('publicHosts must be an array of at most 15 hostnames or IP addresses')
  const hosts = [...new Set([host, ...extras])]
  for (const candidate of hosts) {
    if (!/^[A-Za-z0-9.-]+$/.test(candidate) && !/^\[[0-9a-fA-F:]+\]$/.test(candidate)) {
      throw new Error('publicHosts must contain only hostnames or IP addresses')
    }
  }
  const ingressPort = Number(config.ingressPort ?? 3180)
  const httpsPort = Number(config.httpsPort ?? 443)
  if (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535 || httpsPort === 80) throw new Error('httpsPort must be a valid HTTPS port')
  const httpsSuffix = httpsPort === 443 ? '' : `:${httpsPort}`
  const redirects = hosts.map((candidate, index) => `  @public${index} host ${candidate}\n  redir @public${index} https://${candidate}${httpsSuffix}{uri} 308`).join('\n')
  const siteAddresses = hosts.map(candidate => `https://${candidate}${httpsSuffix}`).join(', ')
  return `# Generated by ds-headbot. Keep this file outside project directories.\n# The controller's canonical publicHost is advertised; publicHosts are accepted aliases.\n\n:80 {\n${redirects}\n}\n\n${siteAddresses} {\n  tls internal\n  reverse_proxy 127.0.0.1:${ingressPort}\n}\n`
}
