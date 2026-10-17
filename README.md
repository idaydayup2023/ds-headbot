# DS Headbot

DS Headbot is a DeepSeek Harness bundle for operating separate DSH Web + DS Bot instances from one DSH installation. Each team has its own DSH home, DS Bot state, process, and loopback service port. The instances use the same installed DSH executable, so a DSH upgrade can be applied to all teams by restarting them.

The public entry uses one LAN hostname or IP:

| URL | Purpose |
| --- | --- |
| `http://<host>/` | Redirects to HTTPS and the Headbot manager |
| `https://<host>/dsh/` | Controller DSH Web UI |
| `https://<host>/dsh/manage/` | Team manager |
| `https://<host>/teams/<team-id>/` | A team's DSH + DS Bot UI |

HTTP on port 80 redirects to HTTPS on port 443. Caddy terminates TLS and forwards to Headbot's loopback ingress on port 3180. Headbot then routes requests to the controller and team ports, strips each path prefix, preserves the browser `Host`, forwards WebSocket upgrades, scopes each DSH cookie to its path, and marks the cookie `Secure`.

## Install the bundle

Install it into the Web profile:

```sh
dsh plugin --profile web add github:idaydayup2023/ds-headbot
```

Set the public host in the environment used to launch DSH and Caddy. For this LAN setup, that may be the Agent Mac's reserved address, such as `192.168.1.5`:

```sh
export HEADBOT_PUBLIC_HOST=192.168.1.5
```

If DSH runs as a macOS LaunchAgent, add the variable to that launcher's environment. The value must match the `publicHost` option in the `ds-headbot` bundle configuration and the Caddy service environment.
The parent DSH service environment must also include `dsh` and `pnpm` on `PATH`, or set `dshCommand` to the absolute DSH executable path.

Start the controller DSH on loopback with its public path and trusted LAN authority:

```sh
dsh --profile web \
  --host 127.0.0.1 \
  --port 3080 \
  --no-open \
  --public-url "https://${HEADBOT_PUBLIC_HOST}/dsh/" \
  --trusted-host "$HEADBOT_PUBLIC_HOST"
```

The controller's printed token URL is the initial sign-in link. Open it once in a browser; after that the browser can use `https://<host>/` or `/dsh/manage/`. The manager API calls DSH's Connection admission check, so unauthenticated or cross-origin state-changing requests are rejected. The static manager page itself contains no team data.

## Enable the LAN HTTPS entry

Use [`deploy/Caddyfile`](deploy/Caddyfile) as the Caddy configuration for the Agent Mac. Caddy owns ports 80 and 443; DSH and Headbot remain unprivileged and bind to loopback. Run Caddy as a service that can bind those ports and set `HEADBOT_PUBLIC_HOST` in that service's environment.

This template uses Caddy's internal CA, which is suitable for a private LAN but is not trusted by client devices automatically. Trust the CA on the Agent Mac and install the generated root certificate on each browser device that should open Headbot. [Caddy's documentation](https://caddyserver.com/docs/caddyfile/directives/tls) explains the root certificate and `caddy trust` setup. Alternatively, replace `tls internal` with a certificate/key pair trusted by those devices.

The generated Caddyfile is also downloadable from the manager page. The plugin does not overwrite the system Caddy configuration or restart a system service.

## Add and operate teams

Open `https://<host>/dsh/manage/`, create a team with a lowercase identifier, display name, and unique port. On the first start, Headbot:

1. creates `<DSH_HOME>/headbot/teams/<id>/home` for the isolated DSH data home;
2. copies the controller's `settings.yaml` and stored credentials when present, removing the controller's browser-session signing grant from the copied credentials;
3. installs `ds-bot` into that team's `web` profile; and
4. launches the same DSH executable on `127.0.0.1:<team-port>` with `--public-url https://<host>/teams/<id>/` and `--trusted-host <host>`.

The copied model settings and credentials are a one-time starting point. After provisioning, each team's files can be changed independently in its own DSH home. Sessions, DS Bot team configuration, installed profile packages, logs, and subsequent edits stay in that team's directory. Data remains after stopping or removing this bundle. Nothing is written into a project checkout.

Use the manager to start, stop, restart, or update DS Bot for a team. The update action runs `dsh plugin --profile web update --latest ds-bot` against that team's isolated DSH home and then restarts it. A team with auto-start enabled resumes when the controller DSH starts.

## Configuration

The bundle defaults to controller path `dsh`, team path `teams`, ingress port `3180`, and the npm package `ds-bot`. The public hostname/IP comes from `publicHost` or `HEADBOT_PUBLIC_HOST`; the DSH executable can be overridden with `dshCommand` or `HEADBOT_DSH_COMMAND` when the controller is launched by a service manager whose `PATH` does not include DSH.

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

## Current boundary

- This bundle targets the DSH `web` profile and current `--public-url` prefix-stripping deployment contract.
- HTTPS certificate lifecycle is delegated to Caddy; `tls internal` requires trusting its CA on each client device.
- Team DSH homes are isolated directories but run as the same macOS user. They are not an OS-level security boundary.
- The controller's DSH session cookie and each team's DSH cookie are scoped to separate URL paths. Do not expose the child loopback ports to the LAN.
