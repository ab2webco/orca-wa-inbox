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
- [ ] T1 RED tests: setting off refused; on -> draft not sent; owner chat still held; file changed after approval refused; approval -> sent once
- [ ] T2 shared validar_adjunto in wa_store + sha256 in adjunto meta + sender re-check
- [ ] T3 setting send_files (global + per chat, default off, ALTER) incl. panel UI
- [ ] T4 caso avance/resultado --file (+ --chat target gate), responder proposal forces ask
- [ ] T5 harness docs/skill + E_ code; held card shows file
- [ ] T6 screenshots (reduced: WA_INBOX_SOLO/TEMA/ANCHO/IDIOMA) of settings panel and held card; build:sidecar if sidecar/src touched

## Acceptance
All tests green (python + node), no debug output, no `any`, Spanish code comments / English agent-facing text, conventional commits, no AI attribution.

## Checks
Run the repo's test scripts (see package.json) from this worktree only.
