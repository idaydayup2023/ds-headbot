// Best-effort steps stay best-effort, but they no longer vanish: every swallowed error now
// leaves exactly one warn line naming its module (third-party audit finding P3, 0.4.24).
// These helpers never throw — an observability line must never break the path it observes.

// The DSH host's Cordis logger has no on-disk exporter: its only built-in sink is the
// in-memory diagnostic ring (lib/index.js LoggerService), so lines sent there never reach
// server.log. stdout/stderr — redirected by launchd into server.log — are the only
// human-visible channel, so every line is passed through to the logger and always printed.
export function warnLine(logger, line) {
  try { logger?.warn?.(line) } catch {
    // A hostile or broken logger must not escalate a swallowed error into a real failure.
  }
  try { console.warn(line) } catch {
    // Neither may an observability line break the path it observes.
  }
}

export function infoLine(logger, line) {
  try { logger?.info?.(line) } catch {}
  try { console.info(line) } catch {}
}

export function ignoreFailure(logger, module, what, error) {
  const detail = error?.message ?? String(error)
  warnLine(logger, `[ds-headbot] ${module}: ignored best-effort ${what} failure: ${detail}`)
}

export const ignore = (logger, module, what) => async (error) => ignoreFailure(logger, module, what, error)

// Poll loops retry the same best-effort probe second after second; one clue per distinct
// failure is the point of the line, so repeats of the same module/what/detail are silent.
const seen = new Map()

export function ignoreFailureOnce(logger, module, what, error) {
  const detail = error?.message ?? String(error)
  const key = `${module}\0${what}\0${detail}`
  if (seen.has(key)) return
  if (seen.size > 200) seen.clear() // bounded memory; re-waring an old distinct failure is harmless
  seen.set(key, true)
  warnLine(logger, `[ds-headbot] ${module}: ignored best-effort ${what} failure: ${detail}`)
}
