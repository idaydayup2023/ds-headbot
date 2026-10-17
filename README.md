# DS Headbot

Current release: **0.2.1**. This patch fixes browser login cookie scoping and startup readiness discovered during Agent-Mac production acceptance.

DS Headbot is a **DeepSeek Harness (DSH) bundle plugin** and the **upper-level manager for ds-bot**. Install it once in a DSH `web` profile to create and manage multiple independent DSH + ds-bot runtime instances from one shared DSH installation.

Each team receives its own DSH home, `web` profile state, ds-bot configuration, workspace, process, and loopback service port. DS Headbot provides one management page to create, start, stop, restart, delete, or update each instance while the controller stays running. The DSH executable is shared, while team data and runtime state remain separate and outside project checkouts. Its bundled communication plugin lets bot teams exchange messages and files through a central audit module.

## Access model

All instances are available under one LAN hostname or IP through HTTPS path routing:

| URL | Purpose |
| --- | --- |
| `http://<host>/` | Redirects to HTTPS and opens the Headbot manager |
| `https://<host>/dsh/` | Controller DSH Web UI |
| `https://<host>/dsh/manage/` | DS Headbot team manager |
| `https://<host>/teams/<team-id>/` | One team's DSH + ds-bot instance |

Port 80 redirects to HTTPS on port 443. Caddy terminates TLS and forwards to Headbot's loopback ingress on port 3180. Headbot routes requests to the controller and team ports, strips each path prefix, preserves the browser `Host`, forwards WebSocket upgrades, and scopes each DSH cookie to its path.

## Install the DSH plugin

Install DS Headbot into the DSH Web profile:

```sh
dsh plugin --profile web add github:idaydayup2023/ds-headbot
```

The package declares its DSH bundle through `dsh.bundle.patch` in `package.json`; DSH applies this patch to register the manager plugin in the Web profile.

Set the public host in the environment used to launch DSH and Caddy. For this LAN setup, that may be the Agent Mac's reserved address, such as `192.168.1.5`:

```sh
export HEADBOT_PUBLIC_HOST=192.168.1.5
```

If DSH runs as a macOS LaunchAgent, add the variable to that launcher's environment. The value must match the `publicHost` option in the `ds-headbot` bundle configuration and the Caddy service environment. The parent DSH service environment must also include `dsh` and `pnpm` on `PATH`, or set `dshCommand` to the absolute DSH executable path.

Start the controller DSH on loopback with its public path and trusted LAN authority:

```sh
dsh --profile web \
  --host 127.0.0.1 \
  --port 3080 \
  --no-open \
  --public-url "https://$HEADBOT_PUBLIC_HOST/dsh/" \
  --trusted-host "$HEADBOT_PUBLIC_HOST"
```

The controller's printed token URL is the initial sign-in link. Open it once in a browser; after that, use `https://<host>/` or `/dsh/manage/`. The manager API uses DSH's Connection admission check, so unauthenticated or cross-origin state-changing requests are rejected. The static manager page itself contains no team data.

## Enable the LAN HTTPS entry

Use [`deploy/Caddyfile`](deploy/Caddyfile) as the Caddy configuration for the Agent Mac. Caddy owns ports 80 and 443; DSH and Headbot bind to loopback. Run Caddy as a service that can bind those ports and set `HEADBOT_PUBLIC_HOST` in that service's environment.

This template uses Caddy's internal CA, which is suitable for a private LAN but is not trusted by client devices automatically. Trust the CA on the Agent Mac and install the generated root certificate on each browser device that should open Headbot. [Caddy's documentation](https://caddyserver.com/docs/caddyfile/directives/tls) explains the root certificate and `caddy trust` setup. Alternatively, replace `tls internal` with a certificate/key pair trusted by those devices.

The manager page can download the generated Caddyfile. The plugin does not overwrite the system Caddy configuration or restart a system service.

## Add and manage instances

Open `https://<host>/dsh/manage/`, then create a team with a lowercase identifier, display name, and unique port. On its first start, Headbot:

1. creates `<DSH_HOME>/headbot/teams/<id>/home` as the team's isolated DSH data home;
2. copies the controller's `settings.yaml`, model entries (`llm-*` and `agent-default-model`) from its Web profile patch, and stored credentials when present, removing the controller's browser-session signing grant;
3. installs `ds-bot` and any configured `teamPlugins` into that team's DSH `web` profile; and
4. launches a separate DSH process on `127.0.0.1:<team-port>` with the team's public URL and trusted host.

The copied model settings and credentials are a one-time starting point. After provisioning, each team's files can be changed independently in its own DSH home. Sessions, ds-bot configuration, installed profile packages, logs, and later edits stay in that team's directory. Data remains after stopping or removing this bundle. Nothing is written into a project checkout.

Use `teamPlugins` for required environment plugins, such as a locally maintained network fetch fix: `teamPlugins: ["/absolute/path/network-fix.tgz"]`. These packages are installed when provisioning a new instance. Controller plugins and bot state are not copied wholesale. Later changes to this list do not automatically alter already provisioned teams; install the needed package into their Web profiles during a maintenance window.

Use the manager to start, stop, restart, or update ds-bot for a team. Updating runs `dsh plugin --profile web update --latest ds-bot` against that team's isolated DSH home and then restarts the instance. Teams with auto-start enabled resume when the controller DSH starts.

Deleting an instance stops its process, cancels automatic restarts, revokes its communication credential, removes its active definition, and moves its files to `<DSH_HOME>/headbot/archives/<team-id>-<instance-id>-<time>/`. The archive includes an owner-only `instance.json` definition for recovery. Runtime logs are retained under `logs/<team-id>-<instance-id>.log`. The UI requests confirmation and preserves the data. Recreating the same team ID creates a new identity and an empty inbox. Historical communication and attachment copies remain available to the controller's audit reviewer. For recovery, stop the controller, back up its data, restore the archived directory to `teams/<id>`, and restore its `instance.json` team entry to schema 2 `teams.json`, checking ID and port conflicts before restarting.

## Team communication and audit

Every managed instance loads the `ds-headbot-communications` DSH tool plugin through a generated patch. The patch references the controller's installed package, so no extra DSH installation or nested Headbot controller is needed. Restart instances after upgrading Headbot to load the new plugin code. The instance working directory is `<DSH_HOME>/headbot/teams/<id>/workspace`; DSH settings and credentials remain in the sibling `home` directory. Existing files previously created at the team directory root remain there; move working files into `workspace` when adopting version 0.2.

| Bot tool | Behavior |
| --- | --- |
| `headbot_list_teams` | Discover recipient IDs and their current status |
| `headbot_send_message` | Send text and files from the instance workspace |
| `headbot_receive_messages` | Read the durable inbox using a replay cursor |
| `headbot_download_attachment` | Verify and save a received file under `workspace/inbox` |

Messages are available immediately after durable audit storage, including when the receiving team is stopped. The receiving bot reads them with its inbox tool; this release does not automatically trigger a model run. Each instance gets a random credential; the broker derives the sender from it, and team credentials cannot access instance management or the controller's audit API.

The manager page includes **团队通信审计**. Reviewers can filter by team, read full message text, download the exact archived attachment bytes, inspect SHA-256 values, and export the complete audit archive. Send, inbox read, attachment receipt, and reviewer download events are retained. An audit write failure blocks the corresponding transfer. The journal uses a hash chain and a checkpoint, and every read or write verifies them; attachment bytes are also verified before delivery.

The protocol and HTTP contract are documented in [Team communication protocol](docs/communication-protocol.md). Defaults: 64 KiB of text, 8 attachments, 10 MiB per file, and 20 MiB of files per transfer. `communicationLimits` may lower these bounds.

Audit files live under `<DSH_HOME>/headbot/communications/`, outside the plugin package and project checkouts. Back up the whole Headbot data directory, including `teams.json`, `communications/audit.jsonl`, `communications/checkpoint.json`, and `communications/objects/`. The API has no audit deletion operation. If integrity verification fails, preserve the files and investigate or restore a consistent backup before resuming transfers; deleting the journal to clear the error destroys the audit history.

## Configuration

The bundle defaults to controller path `dsh`, team path `teams`, ingress port `3180`, and package `ds-bot`. The public hostname/IP comes from `publicHost` or `HEADBOT_PUBLIC_HOST`; set `dshCommand` or `HEADBOT_DSH_COMMAND` if the controller service's `PATH` does not include DSH.

If changing the bundle's `config` in a Cordis patch, restate every field because a matching patch replaces the whole config object:

```yaml
- id: ds-headbot
  config:
    publicHost: 192.168.1.5
    ingressPort: 3180
    controllerPath: dsh
    teamsPath: teams
    dshCommand: dsh
    botPackage: ds-bot
    inheritModelSettings: true
    teamPlugins: []
```

An optional `dshHome` setting can point Headbot at a non-default controller DSH home. Team data remains under `<dshHome>/headbot/`.

Keep team ports distinct from the controller port, ingress port, 80, and 443. Headbot validates team IDs and ports, stores definitions in `teams.json` with owner-only permissions, and refuses duplicate or reserved ports.

## Rollback

To roll back the bundle, stop the controller DSH and remove or disable `ds-headbot` from the Web profile. Restore the prior Caddy configuration and reload Caddy. Team state lives under `$DSH_HOME/headbot/`; removing the bundle does not delete it. Reinstalling the bundle restores the manager definitions and can restart enabled teams.

Version 0.2 upgrades `teams.json` to schema 2 and saves the original schema 1 file as `teams.v1.backup.json`. Version 0.1 refuses schema 2 instead of silently discarding communication identities. Before reverting to 0.1, stop the controller and preserve a complete schema 2 data snapshot; restore the pre-upgrade snapshot for the old version. Keep the schema 2 snapshot for upgrading again, because it contains the identities associated with subsequent audit history. Do not mix `teams.json` from one snapshot with another snapshot's communication archive.

## Scope and deployment status

- DS Headbot is a DSH Web profile plugin and the management layer for multiple DSH + ds-bot instances.
- Team DSH homes are separate directories but run as the same macOS user; they are not an OS-level security boundary.
- All exchanges made through the communication plugin pass through the audit module. A same-user process with unrestricted filesystem or network tools can still use other channels; enforcing auditing against those channels requires additional OS/container isolation. The local hash chain detects corruption and changes against its checkpoint, but an administrator who can rewrite both files is outside this trust boundary.
- HTTPS certificate lifecycle is delegated to Caddy. With `tls internal`, each client device must trust Caddy's CA.
- This release targets the DSH `web` profile and its `--public-url` prefix-stripping deployment contract.
- Two real DSH + ds-bot instances were verified in an isolated Agent-Mac home, including path login, client assets, lifecycle, communication tools and audit exports. Production deployment and TLS acceptance are recorded separately on the host.

In a source checkout, run `npm install --ignore-scripts` and `npm test` for the lifecycle, HTTP admission, tool communication, attachment, migration, and audit fault checks. These checks use a simulated DSH process and do not call a model.

To check a future DSH upgrade, run `node scripts/verify-installed-dsh.mjs /path/to/dsh-installation`. This loads the installed Cordis and DSH tool registry in an isolated process and verifies registration of all four communication tools, without modifying an existing profile or calling a model. See [verification record](docs/verification-2026-10-17.md) for the current results.

For an authorized live lifecycle check, run `node scripts/verify-live-headbot.mjs /path/to/config.json` on the controller host. The configuration names `home`, `log` (controller startup log), `installation`, `ingressPort`, `controllerPort`, `publicHost` and optional `output`/`expectedTeamPlugins`. It authenticates with the current launch URL internally, creates two uniquely named temporary teams, checks their pages and tools, then deletes only those definitions. Their archived files and audit records remain for inspection. It never prints credentials or calls a model. Verify the public TLS entry and browser separately.
