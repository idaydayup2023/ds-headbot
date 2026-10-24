# DSH runtime upgrades

The DSH version card starts a detached, manually requested upgrade. Headbot passes `HEADBOT_DSH_WEB_UPGRADE=1` to the installation's `bin/update.sh`. That script may then proceed while the management page has active connections: it will restart DSH, briefly interrupt browser requests, and restore the same page when the service returns. The page polls every 2.5 seconds while upgrading, retries after a connection drop, and displays the installed version only after the updater confirms it.

The updater script must retain its active-connection deferral for scheduled or otherwise background invocations. Only the exact value `HEADBOT_DSH_WEB_UPGRADE=1` should bypass that check. The backup, health check, and rollback steps must remain in place for either invocation mode.

On Agent-Mac, the updater script is installed at `~/Applications/DeepSeekHarness/bin/update.sh`, outside the versioned DSH directories. Host-specific edits and validation records belong in `~/Library/Application Support/DeepSeekHarnessMaintenance/` so a future change to the installation layout can be reviewed before repeating them.
