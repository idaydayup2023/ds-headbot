# Changelog

All notable changes to DS Headbot are recorded here.

## [Unreleased]

## [0.4.25] - 2026-11-16

Model single-source release: the IMG-VISION-001 post-mortem lines up all three drift legs, teams now truly inherit the parent model settings, and the adoption path leaves a visible on-disk line.

### Fixed

- **MODELS-INPUT-001 · catalog modalities survived nowhere (IMG-VISION-001 leg ③):** a model entry's `input` modalities were stripped twice on the way to a team — `validateStoredModel` had no `input` in its whitelist, so a stored catalog lost the declaration at load, and the generated provider entries never carried it either — leaving vision-capable models refused locally by ds-llm-pi-ai before any request left the machine. The whitelist now passes `input` through (array of known modality words; unknown words drop the field instead of poisoning the entry) and the generated provider model entries carry it. Tests: validator pass-through + junk-modality drop, generated-entry assertions, catalog round-trip through the load-side validator.
- **F1-ADOPT-LOG · observability lines never reached disk (audit lesson P3):** the runtime-adoption line `[ds-headbot] adopted the still-serving …` was invisible not because the optional chain swallowed it — `this.logger?.info?.(…)` existed and fired — but because the Cordis logger inside the DSH host has no on-disk exporter at all: its only built-in sink is the in-memory diagnostic ring. `lib/observe.js` now owns the double channel — `warnLine`/`infoLine` pass every line through to the host logger **and** print it to stdout/stderr, which launchd redirects into `server.log` — and each leg cannot break the observed path. The manager's `warn()`/new `info()` and the four updater start lines stop relying on the unreachable logger tier. Tests: a live controller-restart adoption asserts the ledger line on both channels; the observe double-write case asserts the print even when the host logger exists.
- **Migration leg retired DSH's own materialized files (live-drill follow-up):** the start-time migration renamed *any* regular file at the team's `profiles/web/cordis.patch.yml` to a `.model-inherited-*.bak` — but DSH re-materializes its own profile-root files on every team spawn (a bare default-model pick, an empty commented stub), so each restart left one junk `.bak` per team while retiring nothing that actually carried model definitions. The retirement is now gated on content: files that parse to an empty or `agent-default-model`-only entry list stay in place, anything carrying a model definition — or unparseable — still retires conservatively to a `.bak`. Tests: the stub/bare-pick shapes survive two ensure passes, a stub that later grows a model entry is retired on sight, and removing the gate reddens both new cases.

### Changed

- **PROV-INHERIT-001 · team model settings are inherited, not copied (IMG-VISION-001 legs ①②):** provisioning used to seed one frozen copy of the parent's model entries (`flag wx` — never updated) and every team start regenerated a lossy providers block, so team copies drifted from the parent forever and hand-edits were washed on restart. Teams now read the single source live: the manager maintains `teams/<id>/home/cordis.patch.yml` as a symlink onto the controller's Web profile patch (DSH's home-level user-patch layer, read fresh from disk at every process start), the team's own default-model pick travels in a generated `model-selection.patch.yml` passed as the last `--patch`, and a hand-placed `model-override.patch.yml` outranks everything. `cloneModelPatch` is gone; `ensureInstanceModel` no longer regenerates a providers copy.
- **Upgrade path:** the start-time ensure leg migrates pre-0.4.25 teams in place — a full copy found under the team's `profiles/web` layer is retired to `cordis.patch.yml.model-inherited-<timestamp>.bak` (never silently deleted; recover your hand edits by moving them into `model-override.patch.yml`) — and the home-level link is created. A hand-written regular `home/cordis.patch.yml` predating the upgrade is honoured as an explicit local override and left untouched. Tests: six-case matrix (single-source-on-create, live drift with vision modalities, legacy-copy migration to `.bak`, honoured home-level override, team selection overlay content, override-after-selection layering) plus three counter-proof blades.

## [0.4.24] - 2026-11-15

Third-party audit remediation release (用户 2026-11-15 交付的 0.4.22 审计单，五枚发现逐条亲验后整改；核验结论 F1 部分真 / F2 真 / F3 真 / F4 真 / F5 真).

### Fixed

- **F1 · runtime adoption across controller restarts (P1-1):** detached team children used to be managed from memory only — a controller restart lost the handles, `autoStart` would spawn a second process against the occupied port (refused by the pre-spawn port guard, leaving the team honestly `failed` with an unservable orphan still running), and `waitForListener` probed the port alone, so the live orphan's traffic could be attributed to a crashed fresh child. The manager now persists a `runtime-pids.json` ledger (mode 0600, atomic write) of `{ pid, generation, port, … }` at spawn, and `startTeam` first **adopts** a surviving ledger process — `kill(pid,0)` liveness, command-line identity (team root + `--port N`), and a live port probe must all agree — resuming monitoring without a second spawn; only when adoption fails does it spawn. An adopted runtime reports status through the normal generation path, `stopTeam` from a fresh controller really kills a ledger orphan (process-group terminate), and a monitored child that stops serving flips to `failed` with an explicit "Adopted runtime … stopped serving" note plus autoStart re-arm. Tests: adoption case, double-spawn case (ledger removed → honest `failed` + port-in-use message + zero fake ledger + orphan left alive), false-running case (SIGKILL the adopted child → `failed` with reason + ledger cleared), and a decoy-listener race case.
- **F2 · inbox-push failure reasons scrubbed of credentials (P1-2):** `safeReason` only masked `token`/`secret`/`cookie` keys, so a model key carried in an endpoint query string or an `Authorization: Bearer …` header could land verbatim in the push failure audit line. It now strips URL query/fragment first, masks `key`/`authorization`/`password` (in addition to the originals) inside query strings and key=value pairs, and redacts Bearer values. Tests assert a leaky URL survives scrubbed.

### Changed

- **F3 · audit journal sealed-segment rotation (P2):** the communications journal (also the durable delivery queue) was pure append forever — no cap, and the README advised backing the whole directory up every time. The active segment rotates at `communicationLimits.journalRotateBytes` (default 8 MiB, ceiling 512 MiB) onto `audit.000001.jsonl`, `audit.000002.jsonl`, … : sealed segments are never rewritten or deleted, checkpoints carry the `segment` coordinate, every read verifies the whole chain across segments, and index entries name their segment so offset replays keep resolving. Undelivered messages pin their segment — rotation defers until delivery drains, keeping replay offsets valid; new segment files are created lazily on first append. `exportAudit` and the reviewer API keep their external shape (segment order is visible in the on-disk filenames). Tests: rotation + cross-segment export + offset replay, the delivery pin, checkpoint rewind/missing-segment fail-closed, and sealed-segment immutability under continued appends.
- **F4 · swallowed errors leave one warn line (P3):** all 35 empty `catch {}` / `.catch(() => {})` sites in `lib/` now emit a single `[ds-headbot] <module>: ignored best-effort …` warn through the module logger (console fallback), keeping best-effort semantics — queue-keepalive and poll-loop sites dedupe per distinct failure so retries never spam. New `lib/observe.js` helpers are tested for the line format, the never-throw contract, the console fallback, once-per-distinct-failure dedupe, and queue recovery after a swallowed journaled failure.
- **F5 · README brought current and welded shut (P3):** the README was pinned at 0.4.9 and said nothing about the LiteLLM/SparkDash cards, the strict card face, the GitHub token legs, inbox push, or journal rotation. All are documented now (including the per-card token environment fallbacks and the by-segment backup recipe), and a new lock test fails the suite whenever the README version line drifts from `package.json` or the 0.4.24 coverage probes disappear — the fifteen-release doc drift cannot recur.

### Changed

- **UI-008 strict card face (用户 2026-11-15 原令, 0.4.22 漏网收口):** the five version cards now render nothing beyond the component name, the single 安装版本 line and the buttons. The block lines (`#headbot-block`, `#dsbot-block`, `#dsh-block`, `#litellm-block`, `#sparkdash-block`) and the BALANCE-001 `#litellm-patch-pending` row are removed from the DOM entirely — check errors (the live trigger was a LiteLLM card printing "版本检查失败：GitHub API 限流…"), gate reasons, upstream probe failures and request-failure messages never reach the card face; those readouts live only in the API/audit data plane and the browser console (`window.console?.warn`, optional-chained so the sandboxed test harness stays safe). A failed check leaves the card sitting quietly on its version line; the upgrade button, when rendered, stays clickable and the backend still answers with the verbatim reason on the API. Tests add a prose-injection case (rate-limit copy fed to all five endpoints → zero card occurrence) and a hard-request-failure case (endpoint throws → version line honestly reads 安装版本：无法读取, no other prose).

### Fixed

- **GitHub checks carry an optional token (总务照准 backlog → 本版实现):** anonymous `api.github.com` calls hit the 60/h shared-egress rate limit (HTTP 403), which pinned `updateAvailable` to false (upgrade button never appeared) and made `POST /release/upgrade` 503 at its pre-check. `HeadbotReleaseUpdater`, `HeadbotRuntimeUpdater` (DSH releases leg) and `LitellmGatewayUpdater` now attach `Authorization: Bearer <token>` when a token is configured (config `githubToken` / `litellmUpdate.githubToken`, or env `GITHUB_TOKEN` / `HEADBOT_UPGRADE_GITHUB_TOKEN` / `DSH_UPGRADE_GITHUB_TOKEN` / `LITELLM_UPGRADE_GITHUB_TOKEN`), and stay byte-for-byte anonymous without one (no regression). The token value only ever comes from the config file or the process env — never hard-coded, never logged, never in argv/state/audit. New tests assert the header rides when configured and is absent otherwise.

## [0.4.22] - 2026-11-15

### Added

- SparkDash release-version mapping for tag-less upstreams (2026-11-15 活体实证): MiaAI-Lab/sparkDash publishes no release tags beyond v2.32.0 — `git ls-remote refs/tags/*` returns exactly media-showcase/v2.31.0/v2.32.0, GitHub `git/refs/tags` agrees, and releases/latest still reads v2.32.0 (2026-10-10) — while the v2.90.0 release lives only in the upstream HEAD commit subject ("Release v2.90.0 and highlight it in README", 24daeb57). upstreamTagVersion now falls back to `/^Release vX.Y.Z/` on that subject (upstream's own declaration — not a fabrication), which also feeds the ancestry decoration so the local-patched HEAD reads `v2.90.0-1-gd77d1a3`; an evidence note lands in status.notes (API-only, card face stays prose-free). Once upstream tags the commit, the ls-remote tag mapping wins automatically.

### Changed

- UI-007 (user directive 2026-11-15 06:4x, two items): every state.message-class copy is removed from the five version cards — no 已升级到…/正在安装…/升级进行中/上次升级失败/重启提示/批量进度 rows any more; the busy state is expressed by the button label 升级中 alone. The hidden block line now carries only check/probe errors and the reasons the API returns on a blocked or failed request (error reasons, not status prose — the UI-006 verbatim gate-reason leg is untouched). And each card is compressed into a single row — 组件名 + 安装版本：xxxx + buttons (升级/打开) on one flex line — with the block/patch-pending lines hanging below, hidden by default.

## [0.4.21] - 2026-11-15

### Fixed

- SparkDash card tag version no longer trusts the local clone's tag set. The first live run showed the flaw the 0.4.20 describe-based read could not survive: the local checkout carries tags only up to v2.32.0 while HEAD is one local-patch commit on top of the upstream v2.90.0 release commit, so a local `git describe --tags` printed the honest-looking but wrong `v2.32.0-447-g…`. The tag version is now resolved against the upstream `refs/tags/*` set plus local ancestry: a tag ON the commit reads verbatim regardless of local tag freshness, a local-patched HEAD riding on the upstream release commit reads as the git-describe style `v2.90.0-1-gd77d1a3`, and anything else stays an honest 未标记 commit short-sha — a version is never fabricated.

## [0.4.20] - 2026-11-15

### Changed

- UI-006: the five version cards follow the 2026-11-15 user directive verbatim. Component names are the five canonical strings (DS HeadBot / DS Bot / DeepSeek Harness / LiteLLM / SparkDash) with the legacy label spellings retired; each card face carries exactly one version line (安装版本：…) — SparkDash, which has no release channel, shows its git tag version via upstream `refs/tags/*` matching the local HEAD (with an honest 未标记 commit fallback when no tag covers it). The upgrade button now has a real DOM lifecycle instead of `hidden` toggling: no node at all while nothing is newer, `升级到 <target>` when a newer version exists, `升级中` (disabled, 防重提) while busy, node removed after success. Pressing it executes the upgrade directly — the UI-004 front-end confirm dialogs are retired — while every backend gate (litellm patch gate, triple verification, dirty-worktree plan, targetCommit==HEAD) stays in force and its 409 reason is reported verbatim on the card block line, the button remaining clickable for retry. LiteLLM and SparkDash gain 打开 buttons pointing at http://192.168.1.5:8888/ui and http://192.168.1.5:5555 respectively.

## [0.4.19] - 2026-11-14

### Fixed

- LiteLLM upgrade card follows the 2026-11-14 install migration: the default venv anchor moved from `…/DeepSeekHarnessMaintenance/litellm-20261022/venv` (physically deleted) to `~/ai/litellm/venv`, with the uv installer landing on `~/ai/litellm/bin/uv` as before. Anchoring the old path made the version read-back die with `spawn …/venv/bin/litellm ENOENT`, blanking `currentVersion` and freezing the upgrade button. A regression case pins the defaults to the new home and forbids any stale maintenance anchor.

## [0.4.18] - 2026-11-14

### Fixed

- UI-004: the HeadBot / DS Bot / DSH upgrade dialogs no longer keep their confirm buttons grey forever. The 0.4.16 dialogs shipped those buttons with the HTML `disabled` attribute while the render functions only toggled `hidden`, so in a real browser no user could confirm an upgrade (litellm/sparkdash escaped only via their ack-checkbox / commit-input activation legs). The render functions now sync `disabled=!ready` alongside `hidden`, matching the litellm dialog shape; server-side gates are untouched. The mock test harness now seeds disabled/hidden from the real rendered HTML and short-circuits click dispatch on disabled like a browser, so this class of bug can no longer hide from the test suite.

## [0.4.17] - 2026-11-14

### Fixed

- UI-003: the LiteLLM upgrade worker now works on uv-created venvs. The 16:15 live run failed at its very first step with `spawn …/venv/bin/pip ENOENT` — the venv has no pip at all (pyvenv.cfg `uv = 0.13.1`). The installer is generalized from a pip binary path to plain command arrays defaulting to the uv beside the venv (`uv pip install/freeze --python <venv>/bin/python`, installCmd carrying a `<target>` placeholder, config.installerCmd overriding both); the automatic rollback reuses the same installer with the pinned current version. A pre-spawn existence preflight smokes every distinct installer head with `--version` before anything else runs, and a failure before any mutation now records an honest 无需回退（零变更）state plus a `noChanges` audit row instead of thrashing a second rollback spawn into the same ENOENT wall. Gates unchanged: triple confirmation, patch gate and post-upgrade verification stay in force.

## [0.4.16] - 2026-11-14

### Added

- UI-002: the five version cards (DS HeadBot / DS Bot / DSH / LiteLLM / sparkDash) keep exactly three elements on the card face — current version, latest version, upgrade button. All status copy, gate reasons, notes and audit details moved into the upgrade dialog, which is now always clickable: a fail-closed gate renders as an honest explanation of what blocks the upgrade instead of a dead greyed-out button, while the server-side triple gate and the double confirmation stay in force. window.confirm is fully replaced by the two-step dialog; the LiteLLM dialog additionally shows a BALANCE-001 patch-pending line (gate details now carry md5Declared) so an upgrade to an unpatched build is visible before approval.

### Fixed

- sparkDash pre-install window (localDir configured, checkout not yet installed): the upstream ls-remote probe no longer runs with the missing checkout as cwd — the git() default argument re-filled localDir for an explicit undefined and spawn reported a misleading "spawn git ENOENT" — and the local read treats an absent directory as honest 未部署 instead of probing git into a void cwd. upstreamHead keeps reading correctly and the gate reason returns to the clean 未部署 wording (regression cannon in the test suite).

## [0.4.15] - 2026-11-14

### Fixed

- The sparkDash runbook plan now accepts the model dispatcher B④ shape verbatim: steps/verify/rollback entries may be shell one-liners (executed via /bin/sh so ~ expansion, $(id -u) and quoting work as written) with <target_sha>/<previous_sha> placeholders filled from the pinned before/target pair. The REPO-WATCH ledger reader became repo-aware over the human 台账.md: it takes the newest line naming the repo with a full 40-char SHA (baseline-table row), ignores litellm rows and short SHAs in daily-report lines, and still defers to the live ls-remote probe with a note when nothing parses.

## [0.4.14] - 2026-11-14

### Added

- Add a commit-level version card and audited upgrade flow for the local sparkDash dashboard (SPARKDASH-UI-001). Upstream `MiaAI-Lab/sparkDash` publishes no releases or tags, so the fifth card compares commits only — `git ls-remote` upstream HEAD against the local checkout — and claims "HEAD 一致" only on byte-identical SHAs, never a fabricated semver equality; behind counts report "待 fetch 落地" when the upstream commit is not yet in the local object store. All gates fail closed: an absent checkout honestly reads 未部署/待实况单, any uncommitted change (or an unreadable worktree) blocks the upgrade and reports to a human, and the upgrade stays shut until the runbook plan (pull → npm ci → restart) is configured. Upgrades run only behind a double confirmation that acknowledges the restart outage and re-types the full 40-character target commit; the worker re-checks the dirty gate before touching anything, verifies the HEAD read-back, rolls back to the pre-upgrade commit on failure, and appends every attempt to `sparkdash-upgrade-audit.jsonl`. The model dispatcher's REPO-WATCH ledger reading is cross-checked, with the live probe winning on disagreement plus a note.

## [0.4.13] - 2026-11-14

### Added

- Add an audited LiteLLM version card and upgrade flow for the shared 8888 inference gateway (LITELLM-UPGRADE-UI-001): the manager page now shows the installed venv version against the upstream `BerriAI/litellm` release (rate-limited reads are reported honestly), and upgrades run only behind a double confirmation that re-types the target version and acknowledges the restart outage. A patch-manifest gate fails closed — an absent or drifted manifest blocks the run unless an explicit zero-patch declaration is on file — so an upgrade can never silently eat local patches. The worker backs up `pip freeze`, installs the pinned version without stopping the gateway, restarts via `launchctl kickstart`, verifies version/health/patch in three checks, auto-rolls back to the pinned version on failure, and appends every attempt to `litellm-upgrade-audit.jsonl` with progress in `litellm-update.log`.

## [0.4.12] - 2026-11-11

### Fixed

- Carry a catalog model's `maxTokens` through to the generated Web profile patch: `writeInstanceModelConfig` used to emit bare `{ id }` entries, so every assigned model silently fell back to the client default budget. The catalog validator now preserves a positive-integer `maxTokens`, the controller model import reads it back from the patch entry, and it is part of the runtime signature so catalog edits propagate to assigned teams.

## [0.4.10] - 2026-11-11

### Added

- Let the protected controller instance (the guarantee group, `default`) join its own audited team-communication circle as a first-class participant: it now carries a `0600` private bearer credential in `controller.json` (minted and persisted automatically for older files), appears in every roster, receives escalations from teams and can reply to them.
- Give controller bots the same four `headbot_*` communication tools as managed teams through a shared registration module, wired in process to the audit broker with no HTTP hop, no environment-variable credential, and a file sandbox pinned to the controller's own bot workspace only.

## [0.4.9] - 2026-11-02

### Added

- Run the root test suite and the Feishu bridge build and test on every push and pull request, and commit a root lockfile so that install is reproducible.

### Changed

- Split manager internals by domain — state and secrets, process lifecycle, models, Feishu provisioning, and controller restart — while keeping the public `HeadbotManager` API.
- Stop loading the full audit journal into memory on startup and on each write. Hash-chain checks and the existing audit, export, inbox, and idempotent-send behavior stay the same.

## [0.4.8] - 2026-10-28

### Added

- Seed team help-seeking institution on every team provisioning/start: `docs/team-help-protocol.md` is copied into each team's bot workspace as `跨团队求助协议.md`, and an `AGENTS.md` onboarding section (marker `ds-headbot:team-onboarding:v1`, appended once, existing content preserved) teaches the four `headbot_*` communication tools, the P0/P1/P2 help-ticket format, requestId retry discipline, and the escalation path — so any fresh deployment natively knows how to ask sibling teams for help. Seeding is idempotent, never clobbers team-modified files, and failures only warn without blocking team startup.

### Fixed

- Release updater test pinned a stale `0.4.5` version literal; now asserts stable semver shape instead.

## [0.4.7] - 2026-10-28

### Changed

- Move team creation into the team instances card, revealed by a button beside refresh.
- Paginate team communication audit records with 10 entries per page.

## [0.4.6] - 2026-10-28

### Changed

- Check the latest published DeepSeek Harness GitHub release across all release channels, and pass the discovered version to the manual updater instead of following npm's `next` tag.

## [0.4.5] - 2026-10-28

### Fixed

- Use the controller LaunchAgent plist path when applying a default-instance model change, avoiding the macOS `launchctl bootout` I/O error that left the manager stuck restarting.

## [0.4.4] - 2026-10-26

### Added

- Add the `feishu_update_card` tool so a Bot can replace an app-sent shared Feishu card by `message_id` instead of sending a duplicate message.
- Require `config.update_multi: true` on replacement cards and explain the original-card, permission, and age requirements in the Feishu plugin documentation.
- Bump the bundled `ds-headbot-feishu` plugin to 0.1.2 so enabled instances reinstall the card-update tool.

## [0.4.3] - 2026-10-24

### Fixed

- Keep the management page open during a manual DSH upgrade, retry status checks through the service restart, and display the confirmed installed version when complete.
- Mark web-triggered DSH upgrades explicitly so the updater can bypass only its active-connection deferral; background updates keep the idle check.

## [0.4.2] - 2026-10-24

### Changed

- Remove the Caddy configuration download and serve the manager and all instances over HTTP on port 80.
- Generate HTTP-only instance links and preserve DSH sessions by removing Secure from cookies at the HTTP ingress.

## [0.4.1] - 2026-10-21

### Changed

- Bundle the Headbot-maintained `ds-headbot-feishu` plugin and route Feishu input into the selected DS Bot's native DSH session.
- Keep the original Feishu text as a readable user message and move the structured source envelope into a DSH context message hidden from Chat, while preserving the chat, message, sender, and reply-route metadata for the model.
- Serialize work across every Feishu chat targeting the same Bot session.
- Thread each normal Bot response back to the triggering Feishu message while preserving the Bot's existing identity, model, memory, tools, and team configuration.
- Restore and report the selected Bot session on instance startup, monitor session-ID changes, and migrate enabled profiles away from the upstream package.
- Forward the Feishu WebSocket lifecycle to Headbot status reporting from within the instance process.
- Restore the selected DS Bot session only after the DSH agent and session-persistence services are ready.
- Install the Feishu bridge from a packaged archive so isolated profiles resolve DSH peer dependencies, and repair prior links to the controller source tree.
- Bump the bundled `ds-headbot-feishu` plugin to 0.1.1 so existing enabled instances reinstall the updated message presentation.

## [0.4.0] - 2026-10-20

### Added

- Add a model directory for OpenAI-compatible local and hosted endpoints, including optional API keys.
- Allow each instance to assign one model to all of its Bots and apply the choice to their persisted DSH Sessions when that instance restarts.
- Store model credentials in an owner-only file and keep API key values out of the management API, rendered list, and captured DSH logs.

### Changed

- Seed the model directory from the existing controller default model and let new teams inherit the selected default model.

## [0.3.7] - 2026-10-20

### Changed

- Remove routine up-to-date and completed messages below the version controls, use the concise **全部更新** button label, and remove the management-page subtitle.

## [0.3.6] - 2026-10-20

### Changed

- Arrange the version cards in three columns in the order DS Headbot, DS Bot, and DeepSeek Harness.
- Show one shared current DS Bot version instead of a per-instance version list, and remove the fixed default-instance note from its row.

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
