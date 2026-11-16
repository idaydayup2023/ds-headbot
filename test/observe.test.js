import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ignore, ignoreFailure, ignoreFailureOnce, infoLine } from '../lib/observe.js'
import { AuditedCommunications } from '../lib/communications.js'
import { add, fixture } from './helpers.js'

test('a swallowed error leaves exactly one warn line naming its module', () => {
  const lines = []
  ignoreFailure({ warn: line => lines.push(line) }, 'manager/state', 'teams save', new Error('disk gone'))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^\[ds-headbot\] manager\/state: ignored best-effort teams save failure: disk gone$/)
  // The clue must never escalate: a logger that throws is swallowed like everything else.
  assert.doesNotThrow(() => ignoreFailure({ warn() { throw new Error('logger on fire') } }, 'x', 'y', new Error('z')))
})

test('the console fallback keeps the clue when no logger is wired', t => {
  const warn = t.mock.method(console, 'warn', () => {})
  ignoreFailure(undefined, 'ingress', 'Location header rewrite', { message: 'Invalid URL' })
  assert.equal(warn.mock.callCount(), 1)
  assert.match(warn.mock.calls[0].arguments[0], /^\[ds-headbot\] ingress: ignored best-effort Location header rewrite failure: Invalid URL$/)
})

// F1-ADOPT-LOG: the DSH host's Cordis logger only fills an in-memory ring (no on-disk
// exporter), so a line that merely travels there is invisible in server.log. Every
// observability line must be passed through AND printed; stdout/stderr is what launchd captures.
test('the double channel prints through even when the host logger exists', t => {
  const lines = []
  const warn = t.mock.method(console, 'warn', () => {})
  ignoreFailure({ warn: line => lines.push(line) }, 'manager/lifecycle', 'best effort step', new Error('quiet'))
  assert.equal(lines.length, 1, 'the host logger still receives its line')
  assert.equal(warn.mock.callCount(), 1, 'the same line is printed for the on-disk record')
  assert.match(warn.mock.calls[0].arguments[0], /^\[ds-headbot\] manager\/lifecycle: ignored best-effort best effort step failure: quiet$/)
  const infos = []
  const info = t.mock.method(console, 'info', () => {})
  infoLine({ info: line => infos.push(line) }, '[ds-headbot] adopted the still-serving alpha runtime (pid 4242)')
  assert.deepEqual(infos, ['[ds-headbot] adopted the still-serving alpha runtime (pid 4242)'])
  assert.equal(info.mock.callCount(), 1, 'info lines reach stdout too')
})

test('poll-loop swears warn once per distinct failure, never per poll', () => {
  const lines = []
  const logger = { warn: line => lines.push(line) }
  for (let i = 0; i < 5; i++) ignoreFailureOnce(logger, 'runtime-updater', 'version probe while waiting for restart', new Error('ENOENT current/VERSION'))
  assert.equal(lines.length, 1, 'five identical polls produced one clue')
  ignoreFailureOnce(logger, 'runtime-updater', 'version probe while waiting for restart', new Error('EACCES current/VERSION'))
  assert.equal(lines.length, 2, 'a new distinct failure is a new clue')
})

test('ignore() turns a rejection into a swallowed warn for promise chains', async () => {
  const lines = []
  const settled = Promise.reject(new Error('launchd is shy')).catch(ignore({ warn: line => lines.push(line) }, 'manager/controller', 'helper removal cleanup'))
  assert.equal(await settled, undefined, 'the chain swallows instead of rejecting')
  assert.match(lines[0], /^\[ds-headbot\] manager\/controller: ignored best-effort helper removal cleanup failure: launchd is shy$/)
})

test('a failing journaled operation warns through the manager logger and the queue recovers', async t => {
  const { manager } = await fixture(t)
  await add(manager, 'alpha')
  const lines = []
  manager.logger = { warn: line => lines.push(line) }
  const broker = new AuditedCommunications(manager.root, manager)
  await assert.rejects(broker.lock(() => { throw new Error('journal boom') }), /journal boom/, 'the caller still sees the failure')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^\[ds-headbot\] communications: ignored best-effort previous queued journal operation failure: journal boom$/)
  assert.equal(await broker.lock(() => 'recovered'), 'recovered', 'the queue keeps running after a swallowed failure')
})
