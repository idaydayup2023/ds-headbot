# DS Headbot 0.2.0 verification record

Date: 2026-10-17. Base: `main` commit `15ba8205a12f0613d9c2a9667be727ef7a338319`.

## Feature inventory before this change

Version 0.1 had runtime creation, start, stop, restart, auto-start and DS Bot update operations. It had no instance DELETE API/button, no team messaging/file protocol, and no communication audit module. The manager page refreshed team state every four seconds.

## Local checks

Node 25.8.1; `npm install --ignore-scripts --no-package-lock`; `npm test`.

Seven checks pass:

1. Create, start, stop, restart and delete a simulated DSH instance; preserve archived files, revoke its token, and allow a new identity on the same ID/port.
2. Send to an offline team; preserve binary attachment bytes across broker restart; replay with cursors; safely retry with a request ID; isolate other teams and reused IDs.
3. Block sending, inbox receipt and attachment delivery when audit writes fail; detect changed journal content, truncated history and changed attachment bytes.
4. Reject filename traversal, invalid base64 and oversized attachments.
5. Back up and migrate schema 1; preserve schema 2 identities across reload; reject corrupted identities without rewriting them.
6. Exercise real HTTP routes and the communication plugin tools: controller/session admission, team-token isolation, source symlink rejection, file send/read/download, reviewer download, export and revocation.
7. Compile the manager page script and check deletion/audit controls.

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

## Remaining deployment verification

The full DSH + DS Bot + Caddy lifecycle has not been deployed or exercised on Agent. After installing the reviewed version, verify two real teams, their authenticated HTTPS paths, bot-visible tools, message/file exchange and the manager's audit UI. The local tests use a simulated DSH child process; the Agent check verifies real tool-registry compatibility only. The protocol's polling and shared-user isolation boundaries are described in the README and protocol document.
