# Self-update from the management page

The **DS Headbot 版本** card reports the version loaded by the current DSH Web profile and checks the latest stable GitHub release. A failed or timed-out check leaves the update action disabled. The release tag must be a stable `vMAJOR.MINOR.PATCH` version.

When an administrator chooses **升级到 vX.Y.Z**, Headbot runs a detached updater so the DSH controller can be restarted safely. The updater:

1. Downloads the source archive for the selected tag from the fixed `idaydayup2023/ds-headbot` repository.
2. Checks archive paths, package name, package version, and install lifecycle scripts.
3. Packs the release with pnpm and packs the currently installed version as a rollback copy.
4. Installs the new local package into the controller's `web` profile.
5. Restarts DSH and waits for its Headbot release route to respond. If install or restart verification fails, it attempts to reinstall the rollback package and restart DSH again.

Downloaded source archives, packed release and rollback packages, and update status are kept under `$DSH_HOME/headbot/updates/` and `$DSH_HOME/headbot/headbot-update-state.json`, outside project checkouts and team workspaces. Headbot updates do not rewrite team configuration or communication audit data.

On macOS, the updater restarts `gui/<uid>/com.deepseek.dsh` with `launchctl`; change `launchdLabel` in the plugin config if the service uses another label. Other service managers must be configured with `restartCommand` and `restartArgs`, for example a user-level systemd service. If no restart command exists, the package is installed but the page reports that DSH must be restarted.

To manually restore the last packed package, run `dsh plugin --profile web add <path-to-rollback-package>` and restart the DSH service. The `rollback` directory for each attempted version is retained for review.
