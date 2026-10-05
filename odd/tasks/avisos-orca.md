# Orca notices to the owner by WhatsApp (steps 1–3)

## Objective

The Orca mobile app cannot notify in the background (no APNs/FCM), so the owner misses that an
agent is stopped waiting for a permission or an answer. The plugin already receives every
agent's status through `agent.status.changed` and already has an owner-notice queue (`aviso`
table, deterministic `req_id`, sent by the 1-minute tick). Forward the notices that matter to the
owner's approval number by WhatsApp. Owner-approved on 2026-10-04.

## Scope

1. Settings (global, config.html, ES/EN/PT, validated in wa_settings.py, defaults off, nothing
   hard-coded):
   - one switch per notice type: agent waiting, agent finished, automation failed;
   - quiet hours (start and end, local time, optional; may cross midnight);
   - hourly cap (default 6, range 1–60).
   Without an approval number nothing is sent, and the panel says so next to the switches.
2. Agent waiting (`state: waiting`, any previous state):
   - the worker keeps the last state and the last time it saw `working` per `paneKey` in the
     plugin storage (the event fires on every emission, not only on change);
   - it ignores the plugin's own workspace (triage and case agents);
   - it spawns `wa-scope orca-aviso`, which checks the opt-in, quiet hours and the cap,
     resolves names with `orca worktree ps --json` (only repo, branch, display name and agent
     type; never `prompt`, `lastAssistantMessage`, `toolName` or `toolInput`), builds a fixed
     template in the approval language, enqueues with `aviso_encola` (type `orca`,
     deterministic `req_id` per pane, state and 5-minute window) and sends at once through
     `envia_avisos`.
3. Agent finished (`working` → `done`): only when the pane was `working` before; the tick sends
   it after a configurable debounce (default 25 s) if the pane did not return to `working`.
   A `done` with no `working` before (session start, resume, clear) never notifies.
4. Automation failed: the tick polls `orca automations runs --json` with a watermark kept in
   storage; a run with status `dispatch_failed` (or a command result with a non-zero exit or a
   timeout) is one notice with the automation title and the error, trimmed. The first poll
   only sets the watermark (no flood of old failures). The plugin's own automations are not
   in that list (checked live 2026-10-04).
5. Quiet hours: notices that fall inside are held and sent as one summary when the window
   ends. Over the hourly cap: one grouped message with the count.
6. Content rule: template text only. Never prompts, assistant messages, tool input, paths or
   terminal output. The secret check of wa-send stays active.
7. No `--approve` anywhere in this path: only `--send --id`.

## Checklist

- [x] O1 Settings (types, quiet hours, cap, debounce) in wa_settings.py with validation and
      tests, and in config.html (ES/EN/PT, both themes).
      RED: `scripts/check-clis` ~45 failures (new installs had no `orca_*` keys, `si`/`24:00`/
      `0`/`601` accepted, no `orcaNotices` mirror, panel garbage passed through);
      `test/panels.test.mjs` with the old config.html: 6 FALLA then a TypeError (no card).
      GREEN: check-clis "8 CLI arrancan, 445 comprobaciones de ajustes"; panels 1419/1419
      (27 new: defaults off, ranges 1-60 and 10-600, quiet pair, no-number warning, saved
      values painted, host rejection, ES/EN/PT). check-panels, check-voseo, check-datos-reales
      green. Screenshots: see O7.
- [ ] O2 Worker: `agent.status.changed` handler with persisted per-pane state, own-workspace
      filter, spawn of `wa-scope orca-aviso`; tests in the worker suite.
- [ ] O3 `wa-scope orca-aviso`: opt-in, quiet hours, cap, name resolution, template ES/EN/PT,
      enqueue and send; tests on fake data.
- [ ] O4 Finished notice with debounce in the tick.
- [ ] O5 Failed automations polled from the tick with a watermark.
- [ ] O6 Quiet-hours summary and the over-cap grouped message.
- [ ] O7 Regression: every existing flow still green (cases, approvals, owner notices,
      triage, first message, board, reports); `npm run check` green; screenshots of
      config.html at 1440/768/390/320, light and dark, ES and EN, looked at.
- [ ] O8 Live test: a real PermissionRequest in another project reaches the owner's
      approval number; a finished turn; quiet hours hold and summarise.

## Design (decided while building, 2026-10-05)

- Settings travel in ONE panel key, `orcaNotices` (like `firstReply`, one key per host message):
  `{waiting, finished, automationFailed, quietStart, quietEnd, hourlyCap, finishedDelaySeconds}`
  -> `orca_notice_waiting`, `orca_notice_finished`, `orca_notice_automation` (on/off, off),
  `orca_quiet_start`, `orca_quiet_end` (`HH:MM` or empty, empty), `orca_notice_hourly_cap`
  (1-60, 6), `orca_finished_delay_s` (10-600, 25). An empty quiet time is a real choice.
- Worker: per-pane state lives in memory and in the storage key `orcaPanes`
  (`{state, at, workingAt, finished, worktreeId, agentType}`), written only when the state
  changes (coalesced), pruned after 24 h. The own workspace is any worktree id whose path
  (without the `::workspace:<uuid>` suffix) is `.../plugin-workspaces/<publisher>.<id>`.
  The worker reads `orcaNotices` and spawns only when `waiting` is `on`.
- `aviso` rows of type `orca`; the kind is in the `req_id`
  (`aviso-o-espera-…`, `aviso-o-termino-…`, `aviso-o-fallo-…`, `aviso-o-resumen-…`,
  `aviso-o-grupo-…`). New states: `retenido` (quiet hours) and `excedido` (over the cap),
  closed as `resumido` / `agrupado` when the summary or the grouped message is queued.
  No schema change.
- Finished: a `done` arms the notice only when the previous state was `working` and the
  payload is not a `sessionBoundary`; the tick sends it after the delay, if the pane is
  still `done` and the `done` is less than 15 minutes old.
- Automations: watermark `orca_runs_desde` in the `settings` table (first poll only sets it;
  deleted while the switch is off or there is no approval number); a run counts if it was
  created after the watermark and in the last 30 minutes. The error is trimmed and any
  path-shaped token removed; a command failure says only the exit code or the timeout.

## Acceptance

- With every switch off (the default), nothing changes for anyone.
- A notice never carries a prompt, a message body or a path.
- The same waiting state never notifies twice; a session start never notifies "finished".
- No regression in the owner-notice queue, its expiry or the approval-number change.

## Checks

- `scripts/check-casos`, the worker suite, `test/panels.test.mjs`, `npm run check`.
