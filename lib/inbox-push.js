import { createHash, createHmac, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { request as httpRequest } from 'node:http'
import { parse as parseYaml } from 'yaml'

// Inbox push (INBOX-PUSH-001): when a message is durably delivered to an online team, the
// receiving team's lead Bot session is woken up immediately instead of waiting for its own
// polling. The push is an optimization only: the journal stays the single source of truth,
// delivery of a message never depends on it, and every outcome (pushed / failed / skipped)
// is recorded through the existing audit transaction chain.
//
// Defaults, all injectable for tests:
//   session  — the team record's explicit `pushSessionId` wins; otherwise the first entry of
//              `mainBotIds` in the instance's `bot/state.json` (zero-configuration installs).
//   auth     — the launch URL captured from the team banner (it carries the launch token) mints
//              the signed session cookie; if it is gone the target instance's own
//              `client-connection/browser-session` secret self-signs one.
//   timing   — one attempt, 3s budget, no retry: a failed push only leaves an audit event and
//              the recipient's own polling still collects the message.

export const PUSH_TEXT_LIMIT = 4000
export const PUSH_TIMEOUT_MS = 3000

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function buildPushText(message) {
  const from = message.from ?? {}
  const body = typeof message.text === 'string' ? message.text : ''
  const clipped = body.length > PUSH_TEXT_LIMIT
    ? `${body.slice(0, PUSH_TEXT_LIMIT)}\n…〔截断，全文 ${body.length} 字符，回放 headbot_receive_messages 取〕`
    : body
  const attachments = (message.attachments ?? []).map(item => `${item.id}/${item.name}`).join('; ')
  const attachmentLine = attachments ? `\n附件: ${attachments}（headbot_download_attachment 取）` : ''
  return `【headbot收件箱·直推】seq=${message.seq} from=${from.id ?? '?'}(${from.name ?? '?'}) 时间=${message.timestamp ?? ''}\n`
    + `主题: ${message.subject || '(无主题)'}${attachmentLine}\n`
    + `正文:\n${clipped}\n`
    + '— 回放 headbot_receive_messages 取全文；附件用 headbot_download_attachment'
}

function safeReason(error) {
  const reason = String(error?.message ?? error ?? 'unknown')
    .replace(/(token|secret|cookie)[=:]\S*/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
  return reason.slice(0, 200)
}

export class InboxPusher {
  // appendEvent must serialize through the communications lock so the journal keeps one
  // consistent hash chain; the pusher itself never holds that lock while doing network work.
  constructor({ appendEvent, resolveSession, deliver, logger = () => {} }) {
    if (typeof appendEvent !== 'function' || typeof resolveSession !== 'function' || typeof deliver !== 'function') {
      throw new Error('inbox pusher requires appendEvent, resolveSession and deliver')
    }
    this.appendEvent = appendEvent
    this.resolveSession = resolveSession
    this.deliver = deliver
    this.logger = logger
    this.inFlight = new Set()
  }

  // Fire-and-forget: called from inside the send() transaction, never awaited by the caller,
  // never allowed to throw back into the delivery path.
  notify(message) {
    const task = (async () => {
      try {
        await this.run(message)
      } catch (error) {
        this.logger(`inbox push internal error: ${safeReason(error)}`)
      }
    })()
    const tracked = task.finally(() => this.inFlight.delete(tracked))
    this.inFlight.add(tracked)
    return tracked
  }

  // Settle every push started so far; used by tests and by a graceful shutdown.
  async drain() {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight])
  }

  async run(message) {
    const to = message.to
    let target
    try {
      target = await this.resolveSession(to, message)
    } catch (error) {
      return this.audit('message.push-failed', to, { reason: `resolve-error: ${safeReason(error)}` })
    }
    if (!target?.sessionId) return this.audit('message.push-skipped', to, { reason: 'no-session' })
    try {
      await this.deliver(target, buildPushText(message), message)
      // Never name a payload key `seq` (or protocol/id/timestamp/type/previousHash): the append
      // spread would overwrite the chain coordinate itself. messageSeq keeps the link informative.
      return this.audit('message.pushed', to, { sessionId: target.sessionId, messageSeq: message.seq, requestId: message.requestId })
    } catch (error) {
      return this.audit('message.push-failed', to, { reason: safeReason(error) })
    }
  }

  async audit(type, to, extra) {
    try {
      await this.appendEvent(type, { to, ...extra })
    } catch (error) {
      // A journal failure of the push marker must never escalate: the message itself is durable.
      this.logger(`inbox push audit append failed (${type}): ${safeReason(error)}`)
    }
  }
}

export function teamHome(manager, id) {
  return id === 'default' ? manager.parentHome : path.join(manager.root, 'teams', id, 'home')
}

// Q1: an explicit team field wins; otherwise read the instance's own Bot state so a fresh
// deployment pushes to the lead Bot without any configuration, and survives session rebuilds.
export function createSessionResolver({ manager }) {
  return async (to) => {
    if (!to?.id) return null
    const id = to.id
    if (id !== 'default' && manager.getTeam) {
      let record
      try {
        record = await manager.getTeam(id)
      } catch (error) {
        if (error?.statusCode === 404) return null // team removed between delivery and push
        throw error
      }
      if (!record) return null
      // The explicit field lives on the raw team record (present() is a whitelist projection,
      // so it survives there the way feishu.botId does); when set it wins over auto-resolution.
      const raw = manager.findTeam ? manager.findTeam(id) : undefined
      if (validSessionId(raw?.pushSessionId) || validSessionId(record.pushSessionId)) {
        return pushTarget(raw?.pushSessionId ?? record.pushSessionId, id, record.port, teamHome(manager, id))
      }
      return readLeadSession(teamHome(manager, id), id, record.port)
    }
    const controller = manager.controller
    if (validSessionId(controller?.pushSessionId)) return pushTarget(controller.pushSessionId, id, manager.parentPort, manager.parentHome)
    return readLeadSession(manager.parentHome, id, manager.parentPort)
  }
}

function validSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value)
}

function pushTarget(sessionId, id, port, home) {
  return { sessionId, id, port: Number(port) || undefined, home }
}

async function readLeadSession(home, id, port) {
  if (!home) return null
  let state
  try {
    state = JSON.parse(await readFile(path.join(home, 'bot', 'state.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  const sessionId = Array.isArray(state?.mainBotIds) ? state.mainBotIds[0] : undefined
  return validSessionId(sessionId) ? pushTarget(sessionId, id, port, home) : null
}

// Q2: prefer the launch URL the manager captured from the team banner (it carries the launch
// token and mints a cookie for exactly the authority the target will verify), then fall back to
// a cookie self-signed with the target's own browser-session secret.
export function createDeliverer({ manager, timeoutMs = PUSH_TIMEOUT_MS, logger = () => {} }) {
  return async (target, text) => {
    if (!validSessionId(target?.sessionId)) throw new Error('push target has no usable session id')
    const failures = []
    const launchUrl = launchUrlFor(manager, target)
    if (launchUrl) {
      try {
        return await postPrompt({ url: promptUrlFromLaunchUrl(launchUrl), cookie: await mintCookie(launchUrl, timeoutMs), sessionId: target.sessionId, text, timeoutMs })
      } catch (error) {
        failures.push(error)
        logger(`inbox push via launch URL failed for ${target.id}: ${safeReason(error)}`)
      }
    }
    const authority = target.port ? `127.0.0.1:${target.port}` : undefined
    if (!authority) throw failures.at(-1) ?? new Error(`no push route for team "${target.id}": no launch URL and no local port`)
    try {
      const secret = await readBrowserSessionSecret(target.home)
      return await postPrompt({ url: `http://${authority}/api/session/prompt`, cookie: signCookie(authority, secret), sessionId: target.sessionId, text, timeoutMs })
    } catch (error) {
      failures.push(error)
      throw failures.at(-1) ?? error
    }
  }
}

function launchUrlFor(manager, target) {
  if (!manager) return undefined
  if (target.id === 'default') return manager.controllerRuntime?.launchUrl
  return manager.runtime?.get(target.id)?.launchUrl
}

export function promptUrlFromLaunchUrl(launchUrl) {
  const url = new URL(launchUrl)
  const mount = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
  return `http://${url.host}${mount}api/session/prompt`
}

async function mintCookie(launchUrl, timeoutMs) {
  const response = await fetch(launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) }).catch(error => {
    throw new Error(`launch URL cookie mint failed: ${error?.name ?? 'Error'} ${error?.message ?? ''}`.trim())
  })
  const cookies = (typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []) ?? []
  const pairs = cookies.map(cookie => cookie.split(';')[0]).filter(pair => pair.includes('='))
  if (!pairs.length) throw new Error(`launch URL returned no session cookie (HTTP ${response.status})`)
  return pairs.join('; ')
}

// The secret is read from the target instance's own credential file and only ever used to sign;
// it is never returned to a caller, logged, or written into an audit event.
async function readBrowserSessionSecret(home) {
  if (!home) throw new Error('no credential home to sign the push cookie')
  let document
  try {
    document = parseYaml(await readFile(path.join(home, '.credentials.yaml'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('target instance has no credential file to sign the push cookie')
    throw new Error('unable to read the target credential file for the push cookie')
  }
  const record = document?.records?.['client-connection/browser-session']
  const secret = record?.payload?.secret
  if (record?.kind !== 'grant' || typeof secret !== 'string' || !/^[A-Za-z0-9_-]+$/.test(secret)) {
    throw new Error('target instance has no browser-session credential to sign the push cookie')
  }
  return secret
}

const b64url = value => Buffer.from(value).toString('base64url')

export function signCookie(authority, secretB64url) {
  if (typeof secretB64url !== 'string' || !/^[A-Za-z0-9_-]+$/.test(secretB64url)) throw new Error('browser-session secret unavailable')
  const secret = Buffer.from(secretB64url, 'base64url')
  if (secret.length !== 32) throw new Error('browser-session secret has an unexpected length')
  const now = Date.now()
  const body = b64url(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 3_600_000 }))
  const signature = createHmac('sha256', secret).update(body).digest('base64url')
  return `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}=v1.${body}.${signature}`
}

export function pushEnvelope(sessionId, text) {
  return {
    type: 'client-request',
    rpcId: randomUUID(),
    method: 'session/prompt',
    payload: { args: { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] } } },
  }
}

function postPrompt({ url, cookie, sessionId, text, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(pushEnvelope(sessionId, text))
    const request = httpRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie } }, response => {
      let collected = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { collected += chunk })
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`push HTTP ${response.statusCode} ${collected.slice(0, 120)}`))
        if (!collected.includes('"ok":true') || !collected.includes('"accepted":true')) return reject(new Error(`push not accepted: ${collected.slice(0, 120)}`))
        resolve(collected.slice(0, 200))
      })
      response.on('error', reject)
    })
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`push timeout after ${timeoutMs}ms`)))
    request.on('error', reject)
    request.end(body)
  })
}
