# Changelog

All notable changes to DS Headbot are recorded here.

## Unreleased

## [0.3.5] - 2026-10-20

### Added

- Show current and latest DSH and DS Bot versions in the management page, with explicit manual update controls.
- Add one DS Bot update action that upgrades every managed instance sequentially; remove per-instance update buttons.

### Fixed

- Stop updating DS Bot automatically when instances start or restart.

## [0.3.4] - 2026-10-18

### Fixed

- Resume the selected persisted DSH Agent session when a Feishu-enabled team starts, keeping the existing Agent available after host restarts without sending a model prompt.
- Report live Feishu WebSocket and selected Agent availability from each team process to the authenticated manager endpoint; show the two states separately and update them when either changes.
- Retry Agent session restoration with bounded backoff and show restoration failures instead of leaving Feishu and Agent status in an unconfirmed state.

## [0.3.3] - 2026-10-18

### Fixed

- Keep instance **打开** links on the browser's current hostname and HTTPS port instead of sending LAN users to a fixed canonical address.
- Trust every configured public host alias in managed DSH instances and rewrite absolute redirects to the authority used by the browser, including WebSocket handshakes.
- Show the current browser origin in the manager and generate Caddy routes for all configured hosts and an optional HTTPS port.

### Added

- Configure additional accepted addresses with `publicHosts` or `HEADBOT_PUBLIC_HOSTS`; `publicHost` remains the canonical advertised address.

## [0.3.2] - 2026-10-17

### Fixed

- Read Feishu connection, disconnect, reconnect, and connection-error events from DSH plugin output so the management status follows the latest logged event.
- Use one mutually exclusive radio group to enable or disable Feishu; keep removal of a saved App Secret as a separate action.
- Align team name and port inputs on one row, at a consistent width and spacing.

## [0.3.1] - 2026-10-17

### Fixed

- Show an unconfirmed Feishu connection as **状态待确认** instead of the misleading **正在连接** state.
- Keep the team table compact by removing App ID and Bot ID from each Feishu status line.
- Spread instance editing controls across a full-width editor panel with responsive field groups.

## [0.3.0] - 2026-10-17

### Added

- Show the DSH Web controller as a protected default instance in the team list, with editable display name and Feishu settings, restart, and DS Bot update actions. Its port and autostart are fixed; stop, port change, and delete operations are rejected by the API.
- Support Feishu bot configuration for the default instance, storing credentials in owner-only Headbot data and the DSH user's private environment file.

### Fixed

- Keep team editor inputs mounted during the four-second status poll so periodic refreshes no longer steal keyboard focus.

## [0.2.9] - 2026-10-17

### Added

- Configure a separate Feishu App ID and App Secret for each team instance, then route Feishu messages and replies through the selected DS Bot.
- Show the Feishu connection state on each team card and prevent one Feishu App ID from being attached to multiple enabled teams.
- Keep Feishu App Secrets in an owner-only credential file outside project checkouts and team configuration; never return or write secret values to generated DSH patches.
- Refresh a team's Feishu binding when its selected DS Bot moves to a new DSH session.

## [0.2.8] - 2026-10-17

### Fixed

- Correct updater event-handler syntax so the plugin loads in DSH.
- Validate every packaged JavaScript and module file before installation, preventing malformed release code from replacing a working manager.

## [0.2.7] - 2026-10-17

### Fixed

- Launch the detached updater from its packaged `release-updater.js` entrypoint; the previously referenced `release-worker.js` file was not included in the package.
- Mark an updater attempt as failed if its detached process exits unsuccessfully, instead of leaving the manager stuck in a downloading state.

## [0.2.6] - 2026-10-17

### Fixed

- Check DSH health on its direct local Web API route after an upgrade, independent of the public `/dsh/` path prefix, preventing a healthy upgrade from being misclassified and rolled back.

## [0.2.5] - 2026-10-17

### Added

- Show the installed DS Headbot version and check the latest stable GitHub release from the management page.
- Highlight a one-click Headbot upgrade when a newer release is available; install it into the DSH Web profile and restart the controller on macOS LaunchAgent deployments.

### Changed

- Move the team instance card above the team creation card.
- Keep downloaded source, packed upgrade artifacts, and a rollback package under the DSH user's Headbot data directory, outside project checkouts.

## [0.2.4] - 2026-10-17

### Added

- Edit team display names and ports in the instance list; port changes stop and restart active teams, with recovery to the original settings if the new port fails to start.
- A sequential **全部更新 DS Bot** action for all managed instances.
- Check `ds-bot@latest` before starting an already provisioned team; if the package registry is unavailable, keep the installed version running and report the update failure.

### Changed

- Rename the team creation section to **创建团队**.
- New teams continue to install the current `ds-bot` release on first start.

## [0.2.3] - 2026-10-17

### Fixed

- Resolve relative transfer files from the DS Bot workspace, while retaining access to files in the legacy Headbot workspace.
- Save received attachments in the DS Bot workspace inbox and add a live verification case using that workspace.

## [0.2.2] - 2026-10-17

### Fixed

- Capture the creation form before awaiting the API request. Browsers clear `event.currentTarget` after dispatch, which caused a misleading error after a successful instance creation.
- Added a regression check reproducing the browser event lifetime and verifying the form reset and list refresh.

## [0.2.1] - 2026-10-17

### Fixed

- Preserve the semicolon after the scoped Cookie Path attribute, so browsers accept controller/team sign-in cookies with the correct path.
- Retry temporary non-ready HTTP responses while DSH is mounting routes, instead of leaving a healthy restarted instance in `starting`.
- Added regression checks for both production findings and stricter cookie parsing in the live verification script.

## [0.2.0] - 2026-10-17

### Added

- Runtime instance deletion with process shutdown, archived data, credential revocation, and protection against identity reuse.
- The `ds-headbot-communications` DSH tool plugin and the versioned `headbot-team/v1` broker protocol for messages and binary attachments.
- Offline inboxes, replay cursors, retry request IDs, workspace file boundaries, per-instance identities, and transfer limits.
- Durable communication auditing with full message text, attachment copies, SHA-256 checks, chained event hashes, and a checkpoint. Audit failures block transfer.
- A controller audit interface with team filtering, message review, attachment downloads, pagination, and complete archive export.
- Lifecycle, HTTP, client-tool, state-migration, isolation, persistence, and audit-failure checks.

### Changed

- Team processes work in a dedicated `workspace` directory separate from DSH settings and credentials.
- Team state migrates to schema 2 after saving a schema 1 backup. Version 0.1 cannot open schema 2; rollback instructions cover complete snapshots.
- Concurrent initialization and invalid instance updates preserve valid state.
- New instances also inherit model provider/default entries from the controller's Web profile patch once; `teamPlugins` can install required environment plugins without copying controller state.
- Audit checkpoints and attachment directory entries are flushed before acknowledging the operation.
- Added a reusable live DSH verification script; two real instances passed the Agent-Mac isolated lifecycle, path authentication and audited file exchange checks.

### Deployment notes

- Restart managed instances after upgrading the controller to load the communication plugin.
- Communication uses polling tools; it does not automatically start a bot/model turn.
- Shared-user processes are not a security sandbox. The audit requirement is enforced for the provided communication channel.

## [0.1.0] - 2026-10-17

### Added

- Initial DSH Web profile bundle plugin and upper-level manager for ds-bot.
- Team management for multiple independent DSH + ds-bot runtime instances under one DSH installation.
- Separate DSH homes, profiles, processes, loopback ports, logs, and persistent team state.
- One HTTPS hostname with path-based routing for the controller, manager, and team instances; HTTP port 80 redirects to HTTPS port 443 through Caddy.
- Manager actions to add, start, stop, restart, and update ds-bot instances, with optional automatic startup.
- One-time seeding of team model settings and credentials from the controller, excluding its browser-session signing grant.
- Rollback guidance that preserves team data outside project checkouts.

### Deployment notes

- Targets the DSH `web` profile and its `--public-url` prefix-stripping behavior.
- Live integration with DSH and Caddy on the Agent host has not yet been verified.
