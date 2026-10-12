# Finished agents as one summary per interval

## Objective

The owner got one WhatsApp message "Orca: el agente claude en <repo> termino." every time an
agent returned to `done`, even when the agent did not need him: dozens a day, often identical
(two panes of the same repo give the same text). Only what needs him must arrive at once
(`espera`, `fallo`, unchanged). "Finished" (`termino`) arrives as ONE summary every N minutes,
configurable, only if something finished in it. Owner-approved: configurable, with a default
(60 min).

## Scope

- New global-per-line setting `orca_finished_digest_min`: whole minutes, default 60, range
  0..1440, `0` = the old behaviour (one notice per finish, after the existing debounce
  `orca_finished_delay_s`). Only meaningful with `orca_notice_finished` on. Travels in the
  `orcaNotices` panel key as `finishedDigestMinutes`.
- `wa-scope tick`: with the summary on, each finished turn is recorded as an `aviso` row in the
  new state `acumulado` (key = pane + `at`, the same `req_id` as the loose notice; `texto` holds
  only the sanitized project name). When a new window opens, ONE summary is queued for
  everything recorded in the earlier windows and the rows become `resumido`.
- Summary text (template only, ES/EN/PT): a header with the total and one line per project,
  `- <repo · name> x<count>`, most turns first, at most 10 projects and then `- and N more`.
  Names go through `donde_de` / `limpio_orca` (same as the loose notice); an unknown or
  secret-shaped name is counted under "other agents". Never agent type, prompts, assistant
  messages, tool input, paths or terminal output.
- config.html: one number field next to the finished switch, with a help line (0 = one message
  per finish), shown only with the finished switch on, ES/EN/PT, validated 0..1440.
- Out of scope: waiting/blocked, failed automations, the quiet-hours summary and the grouped
  message of the cap (unchanged).

## Decisions to show the owner

- Windows are aligned to the local clock (`(now + utc offset) // (N * 60)`): with 60 the
  summary leaves at the top of the hour, with the finishes of the hour that just closed. What
  finishes inside the current window waits for the next one.
- Summary id: `aviso-o-terminados-<hash(line, "<N>:<window>")>`, deterministic per window and
  per line, so a retry or two ticks never send it twice. The rows move to `resumido` in the same
  transaction as the summary. A finish already reported never comes back (the row stays, so
  `ya_avisado` holds).
- `TERMINO_VIGENTE_S` (15 min) in digest mode: the tick records a finish within a minute of it
  happening, so the limit only matters when the tick did not run (machine asleep). Recording
  accepts a turn up to `max(15 min, interval)` old, because the summary covers the interval: a
  turn inside it that the tick missed still belongs to it. With the summary off the limit is
  15 min exactly as before. Staleness inside the accumulator is bounded by the interval (plus
  quiet hours or a full cap).
- Quiet hours: the summary does not go through `retenido` (the quiet-hours summary counts those
  rows as one agent each by class). It waits as `acumulado` and leaves at the first tick after
  the quiet hours end, as its own message (the quiet-hours summary keeps counting only what it
  held). Not duplicated.
- Hourly cap: the summary counts as one notice. With the hour full it waits (not `excedido`,
  for the same reason) and leaves when the hour has room.
- Switching to `0` with rows waiting: they leave at once as one summary, then every finish is
  loose again. Switching the finished notice off, or changing the approval number, discards
  what was waiting (`fallido`), like the held rows.
- Existing installs: the key is missing from stored `orcaNotices`, so the default (60) applies
  and the panel paints 60: owners with the finished switch on move to the summary at the next
  tick. `0` brings the old behaviour back.

## Checklist

- [x] R1 Setting `orca_finished_digest_min` (0..1440, default 60) in `bin/wa_settings.py`
      (`CONFIG_NUMERICOS`, `CONFIG_RANGOS`, `PANEL_ORCA_CAMPOS` -> `finishedDigestMinutes`) and
      `bin/wa-scope` (`DEFAULT_CONFIG`, `ajustes_orca` -> `resumen_min`).
      RED: `scripts/check-clis` with the new cases: "525 comprobaciones", 9 failures (default
      None, `1441` / `una hora` / `-5` accepted, `sync` mirror without the field, panel value
      not winning over the CLI). GREEN: "8 CLI arrancan, 542 comprobaciones de ajustes".
- [x] R2 Digest logic in the tick (`orca_terminados`, `orca_resumen_terminados`,
      `texto_terminados`, `ventana_digest`, `desde_digest`) and the ES/EN/PT templates.
      33 checks in the `R2:` block of `scripts/check-casos`: not sent inside the window, one
      row per turn, no double count of pane + `at`, a re-finish is another turn, ONE summary on
      the next window with the count per project, text without agent/path/note, closed rows,
      deterministic id, no repeat, no empty summary, nothing reported twice, vigencia with 120
      and 10 minutes, quiet hours (held as `acumulado`, one summary after, the quiet summary
      only counts its own), cap (waits, then leaves, counts as a notice), switch to 0, switch
      off, other number, secret-shaped and unknown names, 14 projects, EN and PT, the window
      mark kept and removed (its key is per line, `desde_digest`). The O4 and P1 checks that expect one notice per finish now set the interval to 0.
      RED: 9 `FALLA` then `AttributeError: ... no attribute 'ventana_digest'` (the loose notices
      still went out, nothing was recorded). GREEN: `scripts/check-casos` 2378/2378.
- [x] R3 config.html: `orca-digest` field (0..1440, 60 by default) with `orca-digest-help`, shown
      only with the finished switch on, ES/EN/PT, validated before saving, painted from
      `orcaNotices.finishedDigestMinutes`, saved in the same key.
      RED: `test/panels.test.mjs` 1 `FALLA` (field missing) then `TypeError: Cannot read
      properties of null (reading 'hidden')`. GREEN: 1705/1705 (field, hidden with the switch
      off, shown with it on, saved as text, `-1` / `1441` / letters / empty rejected with the
      message, `0` and `1440` saved, painted from storage, ES/EN/PT, PT not the English text).
      Screenshots (reduced, looked at): es dark 1440, es light 320, en light 390, pt dark 768:
      the field sits under the debounce, the help line below it, no overflow, no JS errors.
      Kept outside the repo in `~/Projects/.capturas-resumen-terminados/`.
- [x] R4 Docs: this file and the pointer in `odd/tasks/avisos-orca.md` (settings design line).
      The README does not document the notice settings, so it is unchanged.
- [ ] R5 Live test (needs the owner's Orca and a release): finish a few turns in two projects,
      wait for the next window: ONE message with `- <repo> x<n>` lines; quiet hours around now:
      nothing arrives, one message after; `0` in the panel: one message per finish again.

## Acceptance

- With the default, finishing N turns inside a window sends nothing; the next window sends one
  message with the count per project; a window without finishes sends nothing.
- Waiting/blocked and failed automations still arrive at once.
- `0` restores one message per finish. The field is validated in the panel, in `wa-scope config`
  and when read from the panel store.
- Quiet hours and the hourly cap hold the summary without duplicating it.

## Checks

`scripts/check-casos`, `scripts/check-clis`, `test/panels.test.mjs`, `test/worker.test.mjs`
(unchanged: the worker only reads `waiting`), `scripts/check-panels`, `scripts/check-voseo`,
`scripts/check-datos-reales`, `scripts/check-prompts`, `scripts/check-harness`,
`test/manifest.test.mjs`, `test/resolver.test.mjs`.
