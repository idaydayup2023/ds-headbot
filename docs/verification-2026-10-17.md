# DS Headbot 0.2.0 verification record

Date: 2026-10-17. Base: `main` commit `15ba8205a12f0613d9c2a9667be727ef7a338319`.

## Feature inventory before this change

Version 0.1 had runtime creation, start, stop, restart, auto-start and DS Bot update operations. It had no instance DELETE API/button, no team messaging/file protocol, and no communication audit module. The manager page refreshed team state every four seconds.

## Local checks

Node 25.8.1; `npm install --ignore-scripts --no-package-lock`; `npm test`.

Eight checks pass:

1. Create, start, stop, restart and delete a simulated DSH instance; preserve archived files, revoke its token, and allow a new identity on the same ID/port.
2. Send to an offline team; preserve binary attachment bytes across broker restart; replay with cursors; safely retry with a request ID; isolate other teams and reused IDs.
3. Block sending, inbox receipt and attachment delivery when audit writes fail; detect changed journal content, truncated history and changed attachment bytes.
4. Reject filename traversal, invalid base64 and oversized attachments.
5. Back up and migrate schema 1; preserve schema 2 identities across reload; reject corrupted identities without rewriting them.
6. Exercise real HTTP routes and the communication plugin tools: controller/session admission, team-token isolation, source symlink rejection, file send/read/download, reviewer download, export and revocation.
7. Compile the manager page script and check deletion/audit controls.
8. Seed profile model endpoints/defaults once, exclude controller/UI entries, preserve independent team edits and reject invalid extra package references.

`git diff --check`, JavaScript syntax checks, and `npm pack --dry-run` also pass. The package includes both plugins, the audit module, protocol/recovery documentation and the reusable installed-DSH check script.

The management UI was also opened in the in-app browser with two test instances and a sample audit transfer. Instance controls, message detail, attachment links and hashes were visible. Audit polling pauses while a record is expanded so it does not close the record during review. The preview used fixtures, not production data.

## Agent host compatibility

Agent has DSH `0.2.1-alpha.5` with Node 24.21.0. Its current production Web profile contains DS Bot 0.1.7 and does not yet contain DS Headbot.

Ran `scripts/verify-installed-dsh.mjs` with the installed DSH package path. It loaded the real Cordis, system-prompt and tool registry and successfully registered:

- `headbot_list_teams`
- `headbot_send_message`
- `headbot_receive_messages`
- `headbot_download_attachment`

Model requests: 0. This check did not change production profiles, processes, ingress, certificates or ports. Its source and output were recorded on Agent under `~/Library/Application Support/DeepSeekHarness/maintenance/headbot-check.erV4uC/` (`compatibility.json` and `compatibility.stderr`).

## Real isolated integration and PR review

The subsequent PR review identified missing inheritance of Spark endpoints stored in `profiles/web/cordis.patch.yml`. This is fixed by selectively copying model entries once. Required environment plugins can be installed through `teamPlugins`; the Agent deployment supplies its existing fake-IP-safe fetch package. Checkpoint and object directory entries are also synchronized to disk.

On Agent-Mac, an isolated home under `~/Library/Application Support/DeepSeekHarnessMaintenance/headbot-20261017/stage-home` used the existing DSH executable, controller port 13080 and ingress 3181. `scripts/verify-live-headbot.mjs` passed with two real DSH + DS Bot instances:

- simultaneous independent processes, scoped login cookies and relative-path client assets;
- creation, stop, start, restart and deletion with preserved archives;
- four tools registered through the installed Cordis/tool runtime, offline text and binary file transfer, recipient download and matching SHA-256;
- reviewer file bytes, full text audit events and verified export;
- controller 401 admission and cross-origin 403 rejection.

No model requests were made. The tools were invoked through their real registered definitions by the verification runner; a model deciding to use those tools and automated inbox-triggered bot turns are not claimed. Test instances were deleted, retaining their archives. Detailed output is `stage-verification.json` in the maintenance directory. Production deployment, public Caddy TLS and browser acceptance are recorded separately on Agent after merging; the protocol's polling and shared-user isolation boundaries are described in the README and protocol document.
