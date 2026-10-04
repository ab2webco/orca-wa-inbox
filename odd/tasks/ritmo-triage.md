# One pace for attention: the reading selector also sets the triage cron

## Objective

The panel's "How often it refreshes the conversations" selector (`syncMinutes`) only paced
the worker's WhatsApp re-read. The `WhatsApp: triage` automation kept its own cron (the
manifest's `*/5`, or whatever was edited by hand in Orca), so the panel said one pace and
Orca ran another. The owner wants one setting that controls how fast attention happens and
can be adjusted when needed.

## Scope

1. The worker keeps the plugin's `triage` automation (recognized by `pluginOrigin`, never by
   a fixed Orca id) on the cron that matches `syncMinutes`: `*/N * * * *` for N < 60,
   `0 * * * *` for 60. Default 5 min when unset (same as `SYNC_MS`).
2. Applied at start, on every health round (Orca recreates the automation with the
   manifest's cron after a re-approval), and within seconds of a change saved in the panel.
3. Only `orca automations edit <id> --trigger <cron>`; never another plugin's or the
   owner's automations; nothing when it already matches.
4. The worker writes the outcome in its heartbeat (`workerBeat.triage`: minutes, cron, ok,
   code), which the panel already polls (a separate key cost the host's message budget and
   broke the first-click test), and the panel shows it under the selector (ES/EN/PT): the pace Orca runs, or that it
   could not be set and is retried.
5. The selector's hint says it paces both the WhatsApp read and the triage.

## Checklist

- [x] R1 `cronDeMinutos` + `crearAjustadorRitmo` (test/worker.test.mjs). RED: missing
      export; GREEN 406/406.
- [x] R2 Worker wiring: start, health round, change in storage; pace in the heartbeat
      (test/worker.test.mjs). RED 4 failures; GREEN 410/410.
- [x] R3 Panel line and hint copy (test/panels.test.mjs) + screenshots 1440/768/390/320,
      light and dark. RED: no #triage-pace; GREEN 1018/1018. Shots `config-ritmo-triage` and
      `config-ritmo-triage-fallo` (32, no overflow); looked at ES dark 1440, ES light 320,
      failure ES dark 390 and EN light 768.
- [ ] R4 `npm run check` green.

## Acceptance

- Saving 2 min in the panel leaves `WhatsApp: triage` at `*/2 * * * *` in Orca within
  seconds, and the panel says so.
- After a re-approval that brings back `*/5`, the worker sets it back to the panel's value.
- A failure to edit is shown in the panel and logged; nothing else stops.
