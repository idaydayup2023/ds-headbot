import { HeadbotManager } from './lib/manager.js'
import { startIngress } from './lib/ingress.js'
import { renderManagerPage } from './lib/page.js'

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
  const runtimeConfig = { ...config, publicHost: manager.publicHost }

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
        const rejection = ctx.connection.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection, { 'Cache-Control': 'no-store' })
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        await handleApiRequest(req, res, manager, runtimeConfig, ctx.logger)
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

async function handleApiRequest(req, res, manager, runtimeConfig, logger) {
  const url = new URL(req.url ?? '/', 'http://headbot.local')
  const route = url.pathname.slice(API_PATH.length) || '/'
  const method = req.method ?? 'GET'
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')

  try {
    if (method === 'GET' && route === '/teams') {
      return json(res, 200, { teams: await manager.listTeams() })
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
      if (operation === 'start') void manager.startTeam(id).catch(error => logger?.warn?.(`[ds-headbot] start ${id}: ${error.message}`))
      if (operation === 'stop') void manager.stopTeam(id).catch(error => logger?.warn?.(`[ds-headbot] stop ${id}: ${error.message}`))
      if (operation === 'restart') void manager.restartTeam(id).catch(error => logger?.warn?.(`[ds-headbot] restart ${id}: ${error.message}`))
      if (operation === 'update-bot') void manager.updateBot(id).catch(error => logger?.warn?.(`[ds-headbot] update ${id}: ${error.message}`))
      return json(res, 202, { team: await manager.getTeam(id) })
    }

    const update = route.match(/^\/teams\/([a-z0-9][a-z0-9-]{0,47})$/)
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
    const status = error.statusCode ?? 400
    json(res, status, { error: error.message ?? String(error) })
  }
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 16 * 1024) {
      const error = new Error('request body is too large')
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
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
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function renderCaddyfile(config) {
  const host = String(config.publicHost || process.env.HEADBOT_PUBLIC_HOST || 'localhost')
  if (!/^[A-Za-z0-9.-]+$/.test(host) && !/^\[[0-9a-fA-F:]+\]$/.test(host)) {
    throw new Error('publicHost must be a hostname or IP address')
  }
  const ingressPort = Number(config.ingressPort ?? 3180)
  return `# Generated by ds-headbot. Keep this file outside project directories.\n# Set HEADBOT_PUBLIC_HOST to the same value as ds-headbot.publicHost.\n\n:80 {\n  redir https://${host}{uri} 308\n}\n\nhttps://${host} {\n  tls internal\n  reverse_proxy 127.0.0.1:${ingressPort}\n}\n`
}
