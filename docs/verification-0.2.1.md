# 0.2.1 production acceptance fixes

Date: 2026-10-17. Base: merged PR #2 (`2e54b7e`).

Production acceptance of 0.2.0 found two issues that the simulated/isolated checks had not exposed:

1. Replacing `Path=/;` consumed the following semicolon. A browser treated the following Expires text as part of the path and did not send the cookie to management APIs. Preserve the delimiter with a lookahead; check the parsed attributes for both controller and team mounts.
2. DSH binds its listener before all routes are mounted. A temporary HTTP 404 made the readiness check return false immediately, including the later check, leaving a healthy restarted team marked `starting`. Retry non-ready responses until the actual deadline or cancellation.

Ten local automated checks pass, including an HTTP ingress test parsing all cookie attributes and a simulated DSH that serves HTTP 404 for its first 800 milliseconds. The live verification script now rejects malformed cookie paths before creating teams. No model calls are needed for these checks.

The initial production run's failed result and archived temporary teams are retained on Agent under `DeepSeekHarnessMaintenance/headbot-20261017-retry2/production-verification-0.2.0-failed.json` and the controller Headbot archives. A single audited test message was sent before the readiness timeout; it is retained, not discarded. Following merge/install, rerun the live workflow and browser acceptance and record the final package and evidence on Agent.

Deployment also exposed a macOS constraint: SSH cannot display the system certificate-trust authorization window. The revised host deployment validates HTTPS against the generated CA, exports its public root, and handles client trust separately. Deployment runs in the background to survive terminal closure. The original data backup and the interrupted first attempt were preserved; recovery was completed and verified before retrying.
