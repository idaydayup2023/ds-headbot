// UPGRADE-WINDOW-GATE-001 (总务 11-26 裁 A 案): admin-page upgrade buttons execute only inside an
// adjudicated upgrade window. The single pass credential is a key file the 总务 drops from their
// side — { windowId, openedAt, expiresAt, actor, targetVersion } — normally absent, which makes
// every stray click a recorded rejection. All four admin upgrade legs (headbot release, DSH
// runtime, litellm gateway, sparkDash) call the gate BEFORE any version spawn, GitHub call or
// child process, so a blocked click never touches the execution chain; every rejection leaves one
// `upgrade-blocked-by-window` line in the shared audit journal for the 总务 observation ledger.
// The gate manages entry only — the per-leg patch gates and worker chains stay untouched.
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export const WINDOW_KEY_NAME = 'upgrade-window.json'
export const WINDOW_AUDIT_NAME = 'upgrade-window-audit.jsonl'

export function windowKeyFileFor(manager, config) {
  return config?.upgradeWindowFile || path.join(manager.root, WINDOW_KEY_NAME)
}

export function windowAuditFileFor(manager, config) {
  return config?.upgradeWindowAuditFile || path.join(manager.root, WINDOW_AUDIT_NAME)
}

function safeMessage(error) {
  return String(error?.message ?? error)
}

// Read and time-check the key. Fail-closed on doubt: a missing file is the normal (outside any
// window) state, an unparseable or expiry-less key is treated as no credential at all.
export async function readUpgradeWindow(windowKeyFile) {
  let key
  try {
    key = JSON.parse(await readFile(windowKeyFile, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, reason: 'window-key-missing' }
    return { ok: false, reason: `window-key-unreadable（${safeMessage(error)}）` }
  }
  if (!key || typeof key !== 'object' || Array.isArray(key)) return { ok: false, reason: 'window-key-unreadable（不是对象）' }
  const expiresAt = Date.parse(String(key.expiresAt ?? ''))
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'window-key-missing-expiresAt' }
  if (Date.now() > expiresAt) return { ok: false, reason: 'window-expired' }
  return {
    ok: true,
    windowId: key.windowId ?? null,
    openedBy: key.actor ?? null,
    expiresAt: key.expiresAt,
    targetVersion: typeof key.targetVersion === 'string' ? key.targetVersion.trim() : '',
  }
}

// Version-welded legs (litellm, sparkDash) additionally demand that the key names exactly the
// requested target; target-less legs (headbot release, DSH runtime — the target is whatever the
// upstream says) only require an unexpired window. sameTarget lets a leg compare canonically
// (versions with/without the v prefix, short vs full shas).
export async function checkUpgradeWindow({ windowKeyFile, requestedTarget = null, requireTarget = true, sameTarget = (a, b) => a === b }) {
  const key = await readUpgradeWindow(windowKeyFile)
  if (!key.ok) return key
  if (requireTarget) {
    if (!key.targetVersion) return { ok: false, reason: 'window-key-missing-targetVersion' }
    if (requestedTarget === null || requestedTarget === undefined) return { ok: false, reason: 'target-version-mismatch' }
    // A comparison that cannot run (malformed target against a sha weld, for example) fails closed
    // into the same recorded rejection — the gate never lets a throw escape toward the caller.
    let same = false
    try {
      same = Boolean(sameTarget(key.targetVersion, String(requestedTarget)))
    } catch {
      same = false
    }
    if (!same) return { ok: false, reason: 'target-version-mismatch' }
  }
  return key
}

// One line per blocked/passing click into the shared journal — actor, time, leg, target and reason
// are exactly the 总务 observation-ledger fields. Rejections never block on journal trouble beyond
// the append itself; the gate's answer stays 409 either way.
export async function appendWindowAudit(windowAuditFile, event) {
  await mkdir(path.dirname(windowAuditFile), { recursive: true, mode: 0o700 })
  await appendFile(windowAuditFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 })
}
