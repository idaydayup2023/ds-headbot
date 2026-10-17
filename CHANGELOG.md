# Changelog

All notable changes to DS Headbot are recorded here.

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
