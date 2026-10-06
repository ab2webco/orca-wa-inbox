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
2. Agent waiting (`state: waiting`, any previous state; `blocked` too since the owner's
   decision of 2026-10-05, see O9):
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
- [x] O2 Worker: `agent.status.changed` handler with persisted per-pane state, own-workspace
      filter, spawn of `wa-scope orca-aviso`; tests in the worker suite.
      `avisos-orca.mjs` (pure `registrarEstado`, `esEspacioDelPlugin`, `crearAvisosOrca`) wired
      in `main.mjs`. RED: `test/worker.test.mjs` 431/439, the 8 checks through `activate()`
      failing (nothing in `orcaPanes`, no spawn). GREEN: 439/439 (27 new: transitions, repeat
      waiting, own workspace incl. `::workspace:` and Windows paths, sessionBoundary, done
      from waiting, pruning by age and cap, switch off = no spawn, exact argv, restart).
- [x] O3 `wa-scope orca-aviso`: opt-in, quiet hours, cap, name resolution, template ES/EN/PT,
      enqueue and send; tests on fake data.
      RED: the new `scripts/check-casos` section stopped at its first call, `invalid choice:
      'orca-aviso'`. GREEN: the section's 46 checks green (off by default and no number by the
      real CLI; text with repo, display name and agent type, no path or comment; dedupe per
      5-minute window; no names when unknown; a secret-shaped name dropped; EN and PT; no
      `approve` in any of these paths). `orca worktree ps` and `wa-send` are fakes
      (`orca_json`, `tick_envia` replaced in the loaded module).
- [x] O4 Finished notice with debounce in the tick. `orca_terminados` reads `orcaPanes`:
      sent only for `done` + `finished` older than the delay and newer than 15 min; not for a
      `done` without work, a pane back to `working`, or with the switch off; no repeat.
- [x] O5 Failed automations polled from the tick with a watermark. First poll only sets
      `orca_runs_desde`; `dispatch_failed` with its error (path removed), a command failure
      with its exit code only, a timeout; completed and skipped runs ignored; watermark
      deleted when the switch is off; no Orca call at all with everything off.
- [x] O6 Quiet-hours summary and the over-cap grouped message. `retenido` rows inside the
      window (crossing midnight covered), ONE summary after it ends (`resumido`); past the cap
      `excedido`, ONE grouped message once the hour has room (`agrupado`); neither repeats.
      O3-O6 share one commit: one test section and one code block in `wa-scope`.
- [x] O7 Regression: every existing flow still green (cases, approvals, owner notices,
      triage, first message, board, reports); `npm run check` green; screenshots of
      config.html at 1440/768/390/320, light and dark, ES and EN, looked at.
      `npm run check` (smoke: dark, 390, es) EXIT 0: check-casos 1657/1657, check-clis 445,
      panels 1419/1419, worker 439/439, 93 shots "sin desbordes, sin errores de JS".
      `WA_INBOX_SOLO=config-avisos-orca npm run shots` -> 40 PNG in ~/Projects/.capturas-avisos
      (all widths, both themes, es/en, pt for the "on" state; no overflow, no JS errors).
      Looked at, by the owner's rule only 1440 and 390: `config-avisos-orca` es dark 1440,
      es light 1440, es light 390, es dark 390; `config-avisos-orca-sin-numero` es light
      1440 and es dark 390. 768/320 and EN/PT were generated and machine-checked, not opened.
- [ ] O8 Live test: a real PermissionRequest in another project reaches the owner's
      approval number; a finished turn; quiet hours hold and summarise.
      Pending, needs the owner's Orca: (1) install this build, approval number chosen and its
      chat on Automatico; (2) in Ajustes > Su aprobacion turn on the three notices, Guardar;
      (3) in another project start Claude and make it ask for a permission: one WhatsApp
      line within seconds, with repo and branch, nothing of the prompt; (4) let a turn end:
      one "termino" line 25-85 s later (tick); (5) set quiet hours around now, repeat (3):
      nothing arrives; move the end time to the past: one summary at the next tick;
      (6) a failing command-only automation: one line with its title and exit code.

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

## Owner decision 2026-10-05: `blocked` notifies like `waiting`

- [x] O9 A pane entering Orca's `blocked` state sends one notice through the SAME switch
      (`orcaNotices.waiting`; one switch, the panel label now says "o se bloqueo" / "or is
      blocked" / "ou ficou bloqueado"), with its own text in ES/EN/PT ("esta bloqueado y lo
      necesita", "is blocked and needs you", "esta bloqueado e precisa de voce").
      - Same dedupe: `blocked` and `waiting` share the `espera` class of the `req_id`, so
        `waiting` -> `blocked` or `blocked` -> `waiting` on one pane inside the 5-minute window
        is ONE notice (the worker still spawns on the change; wa-scope answers `duplicate`).
      - Same quiet hours and hourly cap (it goes through `orca_encola`). The summary and the
        grouped message count both together as "agentes que lo necesitan" / "agents that need
        you" / "agentes que precisam de voce", no longer "waiting".
      - Decided: a `done` after `blocked` is NOT a finished turn, the same rule as after
        `waiting` (only `working` -> `done` counts; a denied permission leaves the agent done
        without finishing). `blocked` -> `working` -> `done` does count. Tested both.
      RED: worker 481/488 (blocked gave `avisar: null`, spawn carried `--state=waiting`);
      panels 1452/1455 (the label said only "waiting" in ES/EN/PT); check-casos section
      stopped at `--state: invalid choice: 'blocked'`. GREEN: worker 488/488, panels
      1455/1455, the check-casos quick run 897/897 with the section's 58 checks (12 new).
      One run of panels done concurrently with check-casos had a failure in the
      roles-por-numero section ("no ofrece admin"), unrelated to this change; it passed
      1455/1455 when re-run alone.

## Acceptance

- With every switch off (the default), nothing changes for anyone.
- A notice never carries a prompt, a message body or a path.
- The same waiting state never notifies twice; a session start never notifies "finished".
- No regression in the owner-notice queue, its expiry or the approval-number change.

## Checks

- `scripts/check-casos`, the worker suite, `test/panels.test.mjs`, `npm run check`.
