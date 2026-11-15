// Best-effort steps stay best-effort, but they no longer vanish: every swallowed error now
// leaves exactly one warn line naming its module (third-party audit finding P3, 0.4.24).
// These helpers never throw — an observability line must never break the path it observes.

function report(logger, line) {
  try {
    if (logger?.warn) logger.warn(line)
    else console.warn(line)
  } catch {
    // A hostile or broken logger must not escalate a swallowed error into a real failure.
  }
}

export function ignoreFailure(logger, module, what, error) {
  const detail = error?.message ?? String(error)
  report(logger, `[ds-headbot] ${module}: ignored best-effort ${what} failure: ${detail}`)
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
  report(logger, `[ds-headbot] ${module}: ignored best-effort ${what} failure: ${detail}`)
}
