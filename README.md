
# DS Headbot

Current release: **0.4.0**. The manager shows current and latest versions for DS Headbot, DSH, and DS Bot. DSH and DS Bot upgrades are manual from the version cards; DS Bot has one button to update every instance in sequence. This manager does not upgrade DSH or DS Bot automatically. Any separate host-level update scheduler is configured independently.

DS Headbot is a **DeepSeek Harness (DSH) bundle plugin** and the **upper-level manager for ds-bot**. Install it once in a DSH `web` profile to create and manage multiple independent DSH + ds-bot runtime instances from one shared DSH installation.

The controller's DSH Web service is also shown as the protected **default instance** (normally port 3080). It uses the DSH profile and data that already exist; Headbot does not launch a second copy. The default instance can be renamed, restarted, updated, and configured for Feishu, but its port and autostart are fixed and it cannot be stopped or deleted. Restarting it briefly interrupts Headbot and its managed processes; the controller resumes management when DSH returns, and child instances with autostart enabled start again.

Each additional team receives its own DSH home, `web` profile state, ds-bot configuration, workspace, process, and loopback service port. DS Headbot provides one management page to create, start, stop, restart, delete, or update those instances while the default controller stays running. The DSH executable is shared, while team data and runtime state remain separate and outside project checkouts. Its bundled communication plugin lets bot teams exchange messages and files through a central audit module.

## Access model

All instances are available through HTTPS path routing under one or more approved hostnames or IP addresses. The same routes work from a LAN address and a firewall-forwarded address; the manager's **打开** button keeps the address used to open the manager:

| URL | Purpose |
| --- | --- |
| `http://<host>[:port]/` | Redirects to HTTPS and opens the Headbot manager |
| `https://<host>[:port]/dsh/` | Controller DSH Web UI |
| `https://<host>[:port]/dsh/manage/` | DS Headbot team manager |
| `https://<host>[:port]/teams/<team-id>/` | One team's DSH + ds-bot instance |

Port 80 redirects to the configured HTTPS port (443 by default). Caddy terminates TLS and forwards to Headbot's loopback ingress on port 3180. Headbot routes requests to the controller and team ports, strips each path prefix, preserves the browser `Host`, forwards WebSocket upgrades, and scopes each DSH cookie to its path.

## Install the DSH plugin

Install DS Headbot into the DSH Web profile:

```sh
dsh plugin --profile web add github:idaydayup2023/ds-headbot
```

The package declares its DSH bundle through `dsh.bundle.patch` in `package.json`; DSH applies this patch to register the manager plugin in the Web profile.

Set the canonical public host and any additional browser-facing host aliases in the environment used to launch DSH and Caddy. `publicHost` is used for the DSH-advertised URL; `publicHosts` adds the other accepted authorities. For example:

```sh
export HEADBOT_PUBLIC_HOST=agent.lan
export HEADBOT_PUBLIC_HOSTS=agent.example.net
```

If DSH runs as a macOS LaunchAgent, add these variables to that launcher's environment. The values must match the `publicHost` and `publicHosts` options in the `ds-headbot` bundle configuration and the Caddy host routes. The parent DSH service environment must also include `dsh` and `pnpm` on `PATH`, or set `dshCommand` to the absolute DSH executable path.

Start the controller DSH on loopback with its public path and trusted LAN authority:

```sh
dsh --profile web \
  --host 127.0.0.1 \
  --port 3080 \
  --no-open \
  --public-url "https://$HEADBOT_PUBLIC_HOST/dsh/" \
  --trusted-host "$HEADBOT_PUBLIC_HOST" \
  --trusted-host agent.example.net
```

Repeat `--trusted-host` for every `publicHosts` alias. DSH treats `--public-url` as one advertised URL; each alias is admitted separately by the repeatable `--trusted-host` option. Headbot passes all configured authorities to each managed DSH process and rewrites absolute redirects to retain the browser's current authority.

The controller's printed token URL is the initial sign-in link. Open it once in a browser; after that, use `https://<host>/` or `/dsh/manage/`. The manager API uses DSH's Connection admission check, so unauthenticated or cross-origin state-changing requests are rejected. The static manager page itself contains no team data.

## Enable the LAN HTTPS entry

Use the Caddy configuration downloaded from the manager when serving multiple addresses or a non-default HTTPS port; it contains a route and certificate site for every configured host. [`deploy/Caddyfile`](deploy/Caddyfile) is a single-host starter template. Caddy owns the public ports; DSH and Headbot bind to loopback.

This template uses Caddy's internal CA, which is suitable for a private LAN but is not trusted by client devices automatically. Trust the CA on the Agent Mac and install the generated root certificate on each browser device that should open Headbot. [Caddy's documentation](https://caddyserver.com/docs/caddyfile/directives/tls) explains the root certificate and `caddy trust` setup. Alternatively, replace `tls internal` with a certificate/key pair trusted by those devices.

The manager page can download the generated Caddyfile using `publicHost`, `publicHosts`, and optional `httpsPort` configuration. The plugin does not overwrite the system Caddy configuration or restart a system service.

## Add and manage instances

Open `https://<host>/dsh/manage/`, then create a team with a lowercase identifier, display name, and unique port. The team list lets you edit its display name and port; changing a running team's port stops and restarts it on the new port while preserving its previous running state. On its first start, Headbot:

1. creates `<DSH_HOME>/headbot/teams/<id>/home` as the team's isolated DSH data home;
2. copies the controller's `settings.yaml`, model entries (`llm-*` and `agent-default-model`) from its Web profile patch, and stored credentials when present, removing the controller's browser-session signing grant;
3. installs `ds-bot` and any configured `teamPlugins` into that team's DSH `web` profile; and
4. launches a separate DSH process on `127.0.0.1:<team-port>` with the team's public URL and trusted host.

The copied model settings are an initial starting point. The **模型目录** card imports the controller's current default model (including an existing local endpoint such as `http://192.168.1.9:8888/v1`) and lets an administrator add OpenAI-compatible endpoints such as OpenRouter. Each model entry has a unique DSH provider ID, endpoint URL, model ID, display name, and optional API key. OpenRouter uses `https://openrouter.ai/api/v1`; see the [OpenRouter developer guide](https://openrouter.ai/developers) for its OpenAI-compatible API details.

Use **编辑** on an instance to assign a model to every Bot in that instance. Saving the choice updates the instance's DSH default and each existing Bot's model reference, then restarts that DSH process so ds-bot applies the selection to each Bot's persisted Session. A running child team restarts by itself; a stopped team uses the new model the next time it starts. Changing the protected default instance's model briefly disconnects the manager and restarts auto-start teams. On macOS, Headbot stops the controller LaunchAgent, waits for DS Bot to release its state lock, updates the Bot model references, and bootstraps the LaunchAgent again; this prevents the running DS Bot process from overwriting the change. The default instance must use the LaunchAgent named by `launchdLabel` (default `com.deepseek.dsh`); set `launchdPlist` if its plist is outside `~/Library/LaunchAgents/<label>.plist`. New teams inherit the default instance's model choice.

Model API keys are stored separately in `<DSH_HOME>/headbot/model-secrets.json` with owner-only permissions and are never returned by the management API. A child process receives only the selected model's key. For the default instance, Headbot keeps the selected key in a marked block in `<DSH_HOME>/.env`; its DSH launcher must source this file before starting DSH. Headbot preserves other `.env` lines and redacts model keys from captured DSH errors and logs. Teams still run under the same macOS account, so this is credential separation between instances rather than an operating-system security boundary.

Sessions, ds-bot configuration, installed profile packages, logs, and later edits stay in each team's directory. Data remains after stopping or removing this bundle. Nothing is written into a project checkout.

### Protected default instance

The first card is the controller already running in the DSH Web profile, usually on port 3080. Its display name and model assignment are stored in `<DSH_HOME>/headbot/controller.json`; it is not a child entry in `teams.json`. Headbot fixes its port to the controller's actual DSH Web port and forces autostart on. The page hides stop, port-edit, and delete controls, and the management API rejects those operations as well. The card still offers name and model editing, restart, and Feishu settings. DS Bot updates are managed from the shared DS Bot version card.

Restarting the default instance restarts the DSH LaunchAgent (`com.deepseek.dsh` by default), so the management page and its child processes disconnect briefly. When DSH starts again, Headbot resumes and starts child teams whose own autostart option is enabled. Custom service managers should set `restartCommand` and `restartArgs` as described below.

Use `teamPlugins` for required environment plugins, such as a locally maintained network fetch fix: `teamPlugins: ["/absolute/path/network-fix.tgz"]`. These packages are installed when provisioning a new instance. Controller plugins and bot state are not copied wholesale. Later changes to this list do not automatically alter already provisioned teams; install the needed package into their Web profiles during a maintenance window.

### Per-team Feishu bot

Select **编辑** on a team to configure a Feishu App ID, App Secret, and the DS Bot that should receive its messages. Choose exactly one of **启用飞书** and **关闭飞书**; deleting a saved App Secret is a separate action. Each enabled team must use its own Feishu App ID. Headbot installs `@zyfgood/dsh-feishu-bot@0.8.6` into that team's isolated DSH Web profile and configures its Feishu WebSocket connection. When a Feishu-enabled team starts, Headbot resumes the selected persisted DSH Agent session in place without sending a prompt, so Feishu can route messages immediately after a host restart. The team card shows separate live Feishu connection and Agent session states without exposing the App ID or Bot ID. Feishu does not need an inbound public callback URL or a new service port. The Agent Mac needs outbound access to Feishu.

Create and publish a Feishu self-built app with the bot capability, subscribe to `im.message.receive_v1`, and grant message receive and bot-send permissions. Enter its `cli_...` App ID and App Secret in the team editor, then choose a Bot from that team's saved DS Bot list. When the team is running, saving a changed Feishu configuration stops and restarts that team to load the new binding. The bridge sends Feishu messages to the selected Bot's current DSH session and replies to the originating Feishu chat. If DS Bot moves to a new session after a long conversation, Headbot detects the change and restarts that team to refresh the binding.

App Secrets are stored in `<DSH_HOME>/headbot/feishu-secrets.json` with owner-only permissions. The management API only returns whether a secret is stored; it never returns the value. Generated DSH patches contain only environment-variable references, and the secret is passed to the configured team's DSH process. The default instance also has a marked block in `<DSH_HOME>/.env` so the DSH LaunchAgent can load its Feishu credentials on startup; its launcher must source this file before starting DSH. Headbot preserves other `.env` lines. Removing a team removes its saved Feishu secret. This protects the value from project files and other macOS accounts, but teams run under the same macOS user and are not separate operating-system security boundaries; same-account processes and DSH tools may access account-owned data. Only enable Feishu for trusted teams. Feishu messages run with the selected Bot's DSH permissions; group messages require an @mention.

See the [Feishu bridge documentation](https://github.com/zyfgood/dsh-feishu-bot) and the [Feishu bot overview](https://open.feishu.cn/document/client-docs/bot-v3/bot-overview) for app setup details.

Use the manager to start, stop, or restart a team. The DS Bot version card checks the registry and offers one **全部更新到 vX.Y.Z** button that updates each instance sequentially, restarting it after the update; the protected default instance is updated last because it restarts the controller. Starting or restarting a team uses its currently installed DS Bot version and never performs an implicit update. DSH version checks use the `next` npm dist-tag and its manual upgrade button invokes the installation's backup-and-rollback update script. Teams with auto-start enabled resume when the controller DSH starts; version checks never trigger upgrades.

The **DS Headbot 版本** card checks the latest stable release from GitHub. When a newer version is available, **升级到 vX.Y.Z** becomes active. The updater downloads the tagged repository source, verifies that its package version matches the release tag, packs it locally, updates the controller's `web` profile, and keeps the prior package as a rollback artifact under the DSH user's Headbot data directory. On macOS it restarts the configured LaunchAgent (`com.deepseek.dsh` by default) so the new plugin is loaded. Other service managers can set `restartCommand` and `restartArgs` in the `ds-headbot` plugin config. Team workspaces and audit data remain in place. See [self-update and rollback](docs/self-update.md) for details.

Deleting an instance stops its process, cancels automatic restarts, revokes its communication credential, removes its active definition, and moves its files to `<DSH_HOME>/headbot/archives/<team-id>-<instance-id>-<time>/`. The archive includes an owner-only `instance.json` definition for recovery. Runtime logs are retained under `logs/<team-id>-<instance-id>.log`. The UI requests confirmation and preserves the data. Recreating the same team ID creates a new identity and an empty inbox. Historical communication and attachment copies remain available to the controller's audit reviewer. For recovery, stop the controller, back up its data, restore the archived directory to `teams/<id>`, and restore its `instance.json` team entry to schema 2 `teams.json`, checking ID and port conflicts before restarting.

## Team communication and audit

Every managed instance loads the `ds-headbot-communications` DSH tool plugin through a generated patch. The patch references the controller's installed package, so no extra DSH installation or nested Headbot controller is needed. Restart instances after upgrading Headbot to load the new plugin code. DSH launches from `<DSH_HOME>/headbot/teams/<id>/workspace`, while DS Bot uses `<DSH_HOME>/headbot/teams/<id>/home/bot/workspace`. File-send paths resolve relative to the DS Bot workspace first, then the earlier Headbot workspace; absolute paths are accepted only inside one of those two directories. Downloads go to the DS Bot workspace's `inbox`. DSH settings and credentials remain in the sibling `home` directory.

| Bot tool | Behavior |
| --- | --- |
| `headbot_list_teams` | Discover recipient IDs and their current status |
| `headbot_send_message` | Send text and files from the DS Bot workspace, with compatibility for the earlier Headbot workspace |
| `headbot_receive_messages` | Read the durable inbox using a replay cursor |
| `headbot_download_attachment` | Verify and save a received file under the DS Bot workspace's `inbox` |

Messages are available immediately after durable audit storage, including when the receiving team is stopped. The receiving bot reads them with its inbox tool; this release does not automatically trigger a model run. Each instance gets a random credential; the broker derives the sender from it, and team credentials cannot access instance management or the controller's audit API.

The manager page includes **团队通信审计**. Reviewers can filter by team, read full message text, download the exact archived attachment bytes, inspect SHA-256 values, and export the complete audit archive. Send, inbox read, attachment receipt, and reviewer download events are retained. An audit write failure blocks the corresponding transfer. The journal uses a hash chain and a checkpoint, and every read or write verifies them; attachment bytes are also verified before delivery.

The protocol and HTTP contract are documented in [Team communication protocol](docs/communication-protocol.md). Defaults: 64 KiB of text, 8 attachments, 10 MiB per file, and 20 MiB of files per transfer. `communicationLimits` may lower these bounds.

Audit files live under `<DSH_HOME>/headbot/communications/`, outside the plugin package and project checkouts. Back up the whole Headbot data directory, including `teams.json`, `feishu-secrets.json` (if present), `communications/audit.jsonl`, `communications/checkpoint.json`, and `communications/objects/`. Treat the Feishu credential file like a password vault. The API has no audit deletion operation. If integrity verification fails, preserve the files and investigate or restore a consistent backup before resuming transfers; deleting the journal to clear the error destroys the audit history.

## Configuration

The bundle defaults to controller path `dsh`, team path `teams`, ingress port `3180`, and package `ds-bot`. The public hostname/IP comes from `publicHost` or `HEADBOT_PUBLIC_HOST`; set `dshCommand` or `HEADBOT_DSH_COMMAND` if the controller service's `PATH` does not include DSH.

If changing the bundle's `config` in a Cordis patch, restate every field because a matching patch replaces the whole config object:

```yaml
- id: ds-headbot
  config:
    publicHost: agent.lan
    publicHosts:
      - agent.example.net
    httpsPort: 10443
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
