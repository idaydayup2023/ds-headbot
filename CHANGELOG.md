# Changelog

All notable changes to DS Headbot are recorded here.

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
