import http from 'node:http'
import net from 'node:net'

export function startIngress(options) {
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    void proxyRequest(req, res, options)
  })
  server.headersTimeout = 60_000
  server.requestTimeout = 0
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (req, socket, head) => {
    void proxyUpgrade(req, socket, head, options)
  })
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  })
  const ready = new Promise((resolve, reject) => {
    const onError = error => reject(error)
    server.once('error', onError)
    server.listen(options.port, options.host, () => {
      server.off('error', onError)
      resolve()
    })
  })

  return {
    ready,
    close: async () => {
      await ready.catch(() => {})
      const closed = new Promise(resolve => {
        if (!server.listening) return resolve()
        server.close(() => resolve())
      })
      server.closeAllConnections?.()
      for (const socket of sockets) socket.destroy()
      await closed
    },
  }
}

async function proxyRequest(req, res, options) {
  let url
  try {
    url = new URL(req.url || '/', 'http://headbot.local')
    if (url.origin !== 'http://headbot.local') return respond(res, 400, 'invalid request target')
  } catch {
    return respond(res, 400, 'invalid request target')
  }
  if (url.pathname === '/') {
    res.writeHead(302, { Location: `/${options.controllerPath}/manage/`, 'Cache-Control': 'no-store' })
    res.end()
    return
  }
  const target = await findTarget(url.pathname, options, res)
  if (!target) return
  if (target.redirect) {
    res.writeHead(308, { Location: `${target.redirect}${url.search}`, 'Cache-Control': 'no-store' })
    res.end()
    return
  }
  const upstreamPath = stripMount(url.pathname, target.mount) + url.search
  const headers = { ...req.headers, host: req.headers.host }
  const forwardedProto = Array.isArray(req.headers['x-forwarded-proto'])
    ? req.headers['x-forwarded-proto'][0]
    : req.headers['x-forwarded-proto']
  headers['x-forwarded-proto'] = forwardedProto || 'https'
  const upstream = http.request({
    hostname: target.host,
    port: target.port,
    method: req.method,
    path: upstreamPath,
    headers,
  }, upstreamResponse => {
    const responseHeaders = rewriteResponseHeaders(upstreamResponse.headers, target.mount, options.publicHost)
    res.writeHead(upstreamResponse.statusCode || 502, responseHeaders)
    upstreamResponse.pipe(res)
  })
  upstream.on('error', error => {
    options.logger?.warn?.(`[ds-headbot] proxy error: ${error.message}`)
    if (!res.headersSent) respond(res, 502, 'upstream is unavailable')
    else res.destroy(error)
  })
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy()
  })
  req.pipe(upstream)
}

async function findTarget(pathname, options, res) {
  const controllerMount = `/${options.controllerPath}`
  const teamsMount = `/${options.teamsPath}`
  if (pathname === controllerMount) return { redirect: `${controllerMount}/` }
  if (pathname.startsWith(`${controllerMount}/`)) {
    return { host: options.parentHost, port: options.parentPort, mount: controllerMount }
  }
  const teamMatch = pathname.match(new RegExp(`^${escapeRegex(teamsMount)}/([a-z0-9][a-z0-9-]{0,47})(?:/|$)`))
  if (teamMatch) {
    const id = teamMatch[1]
    const mount = `${teamsMount}/${id}`
    if (pathname === mount) return { redirect: `${mount}/` }
    let team
    try {
      team = await options.manager.getTeam(id)
    } catch (error) {
      respond(res, error.statusCode || 404, error.message)
      return null
    }
    if (!['running', 'starting'].includes(team.status)) {
      respond(res, 503, `team "${id}" is ${team.status}`)
      return null
    }
    return { host: '127.0.0.1', port: team.port, mount }
  }
  respond(res, 404, 'not found')
  return null
}

function stripMount(pathname, mount) {
  const remainder = pathname.slice(mount.length)
  return remainder || '/'
}

function rewriteResponseHeaders(input, mount, publicHost) {
  const headers = { ...input }
  const setCookie = headers['set-cookie']
  if (setCookie !== undefined) {
    headers['set-cookie'] = (Array.isArray(setCookie) ? setCookie : [setCookie]).map(cookie => {
      let rewritten = cookie.replace(/(;\s*Path=)\/(?=;|$)/i, `$1${mount}/`)
      if (!/;\s*Secure(?:;|$)/i.test(rewritten)) rewritten += '; Secure'
      return rewritten
    })
  }
  if (headers.location) headers.location = rewriteLocation(headers.location, mount, publicHost)
  return headers
}

function rewriteLocation(location, mount, publicHost) {
  if (location.startsWith('/') && !location.startsWith('//') && !location.startsWith(`${mount}/`) && location !== mount) {
    return `${mount}${location}`
  }
  try {
    const url = new URL(location)
    if (url.hostname === publicHost && url.pathname.startsWith('/') && !url.pathname.startsWith(`${mount}/`)) {
      url.pathname = `${mount}${url.pathname}`
      return url.toString()
    }
  } catch {}
  return location
}

async function proxyUpgrade(req, clientSocket, head, options) {
  let url
  try {
    url = new URL(req.url || '/', 'http://headbot.local')
    if (url.origin !== 'http://headbot.local') throw new Error('invalid request target')
  } catch {
    return endSocket(clientSocket, 400, 'invalid request target')
  }
  const lookupResponse = {
    status: 404,
    message: 'not found',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(message) { if (message) this.message = message },
  }
  const target = await findTarget(url.pathname, options, lookupResponse)
  if (!target || target.redirect) {
    if (target?.redirect) {
      return clientSocket.end(`HTTP/1.1 308 Permanent Redirect\r\nLocation: ${target.redirect}${url.search}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    return endSocket(clientSocket, lookupResponse.status, lookupResponse.message)
  }
  const forwardedProto = Array.isArray(req.headers['x-forwarded-proto'])
    ? req.headers['x-forwarded-proto'][0]
    : req.headers['x-forwarded-proto']
  const requestHeaders = { ...req.headers, host: req.headers.host, 'x-forwarded-proto': forwardedProto || 'https' }
  const upstream = http.request({
    hostname: target.host,
    port: target.port,
    method: req.method,
    path: stripMount(url.pathname, target.mount) + url.search,
    headers: requestHeaders,
  })
  upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
    let handshake = `HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n`
    const headers = rewriteResponseHeaders(response.headers, target.mount, options.publicHost)
    for (const [key, value] of Object.entries(headers)) {
      for (const item of Array.isArray(value) ? value : [value]) handshake += `${key}: ${item}\r\n`
    }
    clientSocket.write(`${handshake}\r\n`)
    if (head?.length) upstreamSocket.write(head)
    if (upstreamHead?.length) clientSocket.write(upstreamHead)
    upstreamSocket.pipe(clientSocket)
    clientSocket.pipe(upstreamSocket)
    clientSocket.once('close', () => upstreamSocket.destroy())
    upstreamSocket.once('close', () => clientSocket.destroy())
  })
  upstream.on('response', response => {
    const headers = rewriteResponseHeaders(response.headers, target.mount, options.publicHost)
    let message = `HTTP/1.1 ${response.statusCode || 502} ${response.statusMessage || 'Bad Gateway'}\r\n`
    for (const [key, value] of Object.entries(headers)) {
      for (const item of Array.isArray(value) ? value : [value]) message += `${key}: ${item}\r\n`
    }
    clientSocket.end(`${message}\r\n`)
    response.resume()
  })
  upstream.on('error', error => {
    options.logger?.warn?.(`[ds-headbot] WebSocket proxy error: ${error.message}`)
    if (!clientSocket.destroyed) endSocket(clientSocket, 502, 'upstream is unavailable')
  })
  clientSocket.once('close', () => upstream.destroy())
  upstream.end()
}

function respond(res, status, message) {
  if (res.headersSent) return res.destroy()
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(message),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(message)
}

function endSocket(socket, status, message) {
  const phrase = ({ 400: 'Bad Request', 404: 'Not Found', 502: 'Bad Gateway', 503: 'Service Unavailable' })[status] || 'Service Unavailable'
  socket.end(`HTTP/1.1 ${status} ${phrase}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`)
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
