# DS Headbot

DS Headbot is a **DeepSeek Harness (DSH) bundle plugin** and the **upper-level manager for ds-bot**. Install it once in a DSH `web` profile to create and manage multiple independent DSH + ds-bot runtime instances from one shared DSH installation.

Each team receives its own DSH home, `web` profile state, ds-bot configuration, process, and loopback service port. DS Headbot provides one management page to add teams and start, stop, restart, or update each instance. The DSH executable is shared, while team data and runtime state remain separate and outside project checkouts.

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
2. copies the controller's `settings.yaml` and stored credentials when present, removing the controller's browser-session signing grant from the copied credentials;
3. installs `ds-bot` into that team's DSH `web` profile; and
4. launches a separate DSH process on `127.0.0.1:<team-port>` with the team's public URL and trusted host.

The copied model settings and credentials are a one-time starting point. After provisioning, each team's files can be changed independently in its own DSH home. Sessions, ds-bot configuration, installed profile packages, logs, and later edits stay in that team's directory. Data remains after stopping or removing this bundle. Nothing is written into a project checkout.

Use the manager to start, stop, restart, or update ds-bot for a team. Updating runs `dsh plugin --profile web update --latest ds-bot` against that team's isolated DSH home and then restarts the instance. Teams with auto-start enabled resume when the controller DSH starts.

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
```

An optional `dshHome` setting can point Headbot at a non-default controller DSH home. Team data remains under `<dshHome>/headbot/`.

Keep team ports distinct from the controller port, ingress port, 80, and 443. Headbot validates team IDs and ports, stores definitions in `teams.json` with owner-only permissions, and refuses duplicate or reserved ports.

## Rollback

To roll back the bundle, stop the controller DSH and remove or disable `ds-headbot` from the Web profile. Restore the prior Caddy configuration and reload Caddy. Team state lives under `$DSH_HOME/headbot/`; removing the bundle does not delete it. Reinstalling the bundle restores the manager definitions and can restart enabled teams.

## Scope and deployment status

- DS Headbot is a DSH Web profile plugin and the management layer for multiple DSH + ds-bot instances.
- Team DSH homes are separate directories but run as the same macOS user; they are not an OS-level security boundary.
- HTTPS certificate lifecycle is delegated to Caddy. With `tls internal`, each client device must trust Caddy's CA.
- This release targets the DSH `web` profile and its `--public-url` prefix-stripping deployment contract.
- Live DSH/Caddy integration should be verified on the target host after installation; the PR itself has not been deployed there.
