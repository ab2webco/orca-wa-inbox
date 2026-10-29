# Case agent sends files (always owner-approved, behind a setting)

## Objective
The case agent can attach a file (reports etc.) to a case reply. Every file send is held for the
owner's approval, in every chat (the owner's own chat included). A setting turns the capability on:
global value with a per-chat override, default OFF.

## Scope
- `caso avance --file` and `caso resultado --file` (also for `--chat <other>`; gate on the TARGET chat).
- `responder` proposal with a file: approval level forced to `ask` regardless of `quality=agent`.
- Setting `send_files` wired end to end like `first_reply_mode` (config.html -> storage.json -> main.mjs sync
  -> chat_scope column with ALTER -> wa_settings.py PANEL_*/CONFIG_*), default off.
- Shared `validar_adjunto` (move to `wa_store`), used by `wa-scope` and `wa-send`.
- Approval bound to the file bytes: store sha256 in the `adjunto` meta, re-check before sending, refuse on mismatch.
- Held card shows file name and size.
- Harness: mention `--file` in the case file only when the chat has it on; new `E_` code in COMMANDS.md; SKILL.md.

## Design decisions (from advisor)
1. A file never takes the "retenido" path (dropped/rewritten): it becomes a `borrador` waiting for the owner with
   `frenado=["rule: file"]`; the agent hint says "waiting for approval, do not resend". Check how updates_max/E_PACING count a waiting draft.
2. No owner-chat exemption (unlike wa-send line ~1128). Always approved.
3. Hash check before send.

## Checklist
- [x] T1 RED tests: setting off refused; on -> draft not sent; owner chat still held; file changed after approval refused; approval -> sent once (RED observed: `wa-scope set --send-files` unknown, `caso avance --file` unknown; commit 7b87f31)
- [x] T2 shared validar_adjunto in wa_store + sha256 in adjunto meta + sender re-check (`wa-send --file-sha256`, re-hash in `--approve` -> `send-file-changed`; check-casos caso-adjuntos green)
- [x] T3 setting send_files (global + per chat, default off, ALTER) incl. panel UI (panels RED 6 fails -> green)
- [x] T4 caso avance/resultado --file (+ --chat target gate), responder proposal forces ask; board Enviar / `si N` / tick send the signed file as draft + `--approve` (worker RED 4 fails -> green)
- [x] T5 harness docs/skill + E_FILES_OFF / E_BAD_FILE; held card and case card show the file (panels RED 3 fails -> green)
- [x] T6 screenshots (reduced: WA_INBOX_SOLO/TEMA/ANCHO/IDIOMA) of settings panel and held card, 1440 and 390, light and dark, es; build:sidecar run (only a comment changed, bundle identical). The board shot caught the held list hiding `caso-<id>-avance-<n>`: fixed in 652a730

## Acceptance
All tests green (python + node), no debug output, no `any`, Spanish code comments / English agent-facing text, conventional commits, no AI attribution.

## Checks
Run the repo's test scripts (see package.json) from this worktree only.

## Decisions taken while implementing
- A waiting file update (`caso_avance.estado = espera`) counts toward `updates_max` and pacing (it goes out if approved).
- A file update is drafted without `--send` (`rule: file` noted), so the owner's own chat is held too; it never takes the retenido path.
- The tick reconciles waiting updates with the outbox: sent -> enviado; cancelled/rejected -> omitido.
- Only case updates WITH a file reach the held list; a case reply is approved on its card, which shows the file name and size.
- Editing a file reply on the board keeps the file but re-hashes it at edit time.

## Known gaps
- `caso resultado --estado necesita --file` is accepted but not covered by a test.
- An owner-signed file reply delivered by the tick logs `approved on the board` even if he signed by WhatsApp.
