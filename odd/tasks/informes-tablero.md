# Reports tab and a bounded board (T9 + board period)

## Objective

The board grows without limit and there are no numbers about how support is going. Add a
period selector shared by the board and a new "Reports" tab, bound every board column to the
viewport with its own scroll, and build seven report blocks from data the plugin already
stores (capture.db messages, scope.db cases, case events and dispatches). Owner-approved on
2026-10-04 (T9 of kanban-casos).

## Scope

1. Period selector: Today · 7 days · 30 days · All. Default 7 days. One value shared by the
   board and Reports, remembered per panel.
2. Board:
   - Active stages (everything before Respondido, plus Su decision and Bloqueado) always show
     every card, whatever the period. The period applies to Respondido and Cerrado, by the
     time the case entered that stage.
   - Each column has a max height bound to the viewport and scrolls inside; the page no
     longer grows with the cards.
   - Respondido and Cerrado show the latest 20 cards, then a "Show N more" button that
     reveals 20 more each time.
   - The stage chips and the counts follow what the period shows.
3. Reports tab, next to Board, with the same period and a comparison against the previous
   period of the same length (an up or down percentage), where the metric allows it:
   1. Live summary: open cases, waiting for the owner's decision, waiting for the customer
      (`necesita`), blocked, and conversations the agent acts on.
   2. Traffic: heatmap of received messages by day and hour (Today and 7 days: one row per
      date; 30 days and All: one row per weekday, summed), and a second heatmap of resolved
      cases.
   3. Times, each with a headline value and daily bars (Today: by hour; All: by week):
      first response, resolution, customer wait.
   4. Volume by day: conversations with activity, messages received, messages sent, cases
      created and resolved.
   5. SLA: a first-response target in minutes, configurable in Settings (default 15, nothing
      hard-coded), the hit rate, the number of misses and the list of missed cases (case,
      chat, first response time, project).
   6. By project and agent: cases per project with their outcome (resuelto, necesita,
      bloqueado), how many Jev held, and how many needed the owner's decision.
   7. CSV download of the period's cases (id, chat, created, first response, resolution,
      stage, project, SLA met). If the panel host blocks downloads, do not ship a dead button:
      stop and report.
4. Definitions (write them in the code and in the Reports tab as a short info text):
   - First response: from the case's first customer message to the first outgoing message
     in that chat after it (acknowledgement, agent first message or reply).
   - Resolution: from case creation to its first entry into Respondido or Cerrado.
   - Customer wait: for each customer message (a burst of consecutive customer messages
     counts once) in a chat in scope, the time until the next outgoing message; the median
     for the period.
   - Resolved: a case that entered Respondido or Cerrado inside the period.
5. Data path: the panel cannot read the databases. The same tool that writes the board
   (`wa-scope`, on the 2-minute triage run) computes the aggregates for the four periods
   (plus the previous periods for the comparison) and writes them to one storage key,
   bounded in size (aggregates and case ids only, no message bodies). Nothing leaves the
   machine.
6. ES/EN/PT. Charts are plain SVG/CSS in the panel, no chart library. Both themes.

## Checklist

- [ ] I1 Period selector shared by board and Reports, remembered; board filters Respondido
      and Cerrado by stage-entry time; chips and counts follow it.
- [ ] I2 Board columns bounded to the viewport with inner scroll; "Show N more" in
      Respondido and Cerrado (20 at a time).
- [ ] I3 Stats computation in wa-scope: the four periods plus previous periods, the
      definitions above, bounded storage key, written with the board.
- [ ] I4 SLA target setting (global, panel key, validation, default 15) in Settings.
  - [x] I4.1 Backend: `sla_first_reply_minutes` (global, default 15, whole minutes 1..1440)
        in `bin/wa_settings.py`, flat panel key `slaMinutes` (sync mirrors it back; a dirty
        panel value is ignored, a valid one wins over the CLI). RED: default `None` and 0,
        1441 and "media hora" accepted, `slaMinutes` missing after sync (10 failures in
        `revisa_ajustes`); GREEN: check-clis 285 settings checks.
  - [ ] I4.2 UI: the field in config.html (pending, UI stage).
- [ ] I5 Reports tab: blocks 1–6 with comparisons, empty states, info texts, ES/EN/PT.
- [ ] I6 CSV download (or a report of why the host blocks it).
- [ ] I7 Screenshots of the board and Reports at 1440/768/390/320, light and dark, ES and EN,
      looked at; `npm run check` green.

## Acceptance

- With many finished cases the board page height stays bound to the viewport, and each
  column scrolls on its own.
- Open cases never disappear because of the period.
- Every report number is reproducible from the databases with the documented definition
  (tests pin each one on fake data).
- No hard-coded thresholds: the SLA target is a setting.

## Checks

- `scripts/check-casos` (stats computation), `test/panels.test.mjs` (board period, scroll,
  show more, Reports rendering), `npm run check` (all suites and screenshots).
