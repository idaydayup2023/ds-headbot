// ADMIT-MIGRATE-0429: the admin API route authenticates through whichever Connection face the
// host generation exposes — old hosts keep requestRejection, new hosts (post v0.2.2-rc.2
// connection-page-peer migration) expose admit(), and a host exposing neither relies on the
// webServer's own admission gate (the 11-26 manager-page outage: calling the deleted member threw
// and the webserver answered every admin call with an empty 400). These cases weld the helper's
// three-layer semantics plus the handler wiring from source truth.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectionRejection } from '../index.js'

const here = path.dirname(fileURLToPath(import.meta.url))

test('old host: requestRejection is called verbatim (401 stays 401, pass stays undefined)', () => {
  const seen = []
  const old = { requestRejection: (req) => { seen.push(req); return seen.length === 1 ? 401 : undefined } }
  assert.equal(connectionRejection(old, { url: '/a' }), 401)
  assert.equal(connectionRejection(old, { url: '/b' }), undefined)
  assert.deepEqual(seen, [{ url: '/a' }, { url: '/b' }], 'the request object reaches the host face untouched')
})

test('new host: admit decides — rejection numbers surface, admitted peers pass', () => {
  let mode = 'deny403'
  const next = { admit: () => mode === 'deny403' ? { rejection: 403 } : mode === 'deny503' ? { rejection: 503 } : { peer: { id: 'p1' } } }
  assert.equal(connectionRejection(next, {}), 403)
  mode = 'deny503'
  assert.equal(connectionRejection(next, {}), 503, 'the 503 authentication-unavailable verdict survives')
  mode = 'pass'
  assert.equal(connectionRejection(next, {}), undefined, 'an admitted peer means pass')
})

test('host without either face passes instead of crashing (webServer admission already gated)', () => {
  assert.equal(connectionRejection({}, {}), undefined)
  assert.equal(connectionRejection(undefined, {}), undefined)
  // A member that exists but is not a callable face is treated as absence, never invoked.
  assert.equal(connectionRejection({ requestRejection: 'gone', admit: null }, {}), undefined)
})

test('old face wins when a transitional host exposes both members', () => {
  const calls = []
  const both = { requestRejection: () => { calls.push('old'); return 401 }, admit: () => { calls.push('new'); return { rejection: 403 } } }
  assert.equal(connectionRejection(both, {}), 401)
  assert.deepEqual(calls, ['old'], 'only the old face runs — never both verdicts mixed')
})

test('handler wiring (source truth): the route goes through connectionRejection, never the deleted member', async () => {
  const source = await readFile(path.join(here, '..', 'index.js'), 'utf8')
  assert.match(source, /connectionRejection\(ctx\.connection, req\)/, 'the API route authenticates via the three-layer helper')
  assert.equal(source.includes('ctx.connection.requestRejection('), false, 'no direct call to the member DSH removed')
  assert.match(source, /rejection === 503 \? 'authentication unavailable'/, 'the 503 verdict carries its own honest body text')
})
