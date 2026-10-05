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
     in that chat after it and before the chat's next case starts (acknowledgement, agent
     first message or reply).
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

- [x] I1 Period selector shared by board and Reports, remembered; board filters Respondido
      and Cerrado by stage-entry time; chips and counts follow it.
      Panel: `#period` (Hoy · 7 dias · 30 dias · Todo, 7 dias de fabrica) above the board,
      remembered in the plugin storage key `boardPeriod` (read once on open, written on
      click; the sandboxed iframe has no storage of its own, and the poll never overrides
      a choice). Open stages always show every card; Respondido and Cerrado keep the cards
      whose `stage_at` (fallback `updated_at`) is at or after the period's local midnight,
      newest entry first. Their counts come from `period_counts[period]` (fallback: what the
      period shows); "Todo" uses `counts`. The period, its start and the show-more state are
      in `firmaTablero`, so a repaint only happens when they change.
      Board key additions (`build_board(con, ahora=None)` in `bin/wa-scope`): every card
      carries `stage_at` (its LAST entry into its current stage, from the whole history,
      before the 20-event trim); `period_counts` = `{today|7d|30d|all: {respondido,
      cerrado}}` counted by that time with the report periods' limits; closed cards travel
      for 30 days instead of 7 (the 50-card cap stays). RED: check-casos `TypeError:
      build_board() got an unexpected keyword argument 'ahora'`; panels: `#period` missing
      (`TypeError ... reading 'click'` after 4 FALLA). GREEN: check-casos 1169/1169 (4 new
      board checks; the card contract keys now include `stage_at`); panels 1068/1068 (21 new
      in "I1", and the old "counts" check now reads Cerrado from `period_counts`).
- [x] I2 Board columns bounded to the viewport with inner scroll; "Show N more" in
      Respondido and Cerrado (20 at a time).
      `.board-cols` has `max-height: var(--alto-tablero)`, which `ajustarAlto` sets to the
      window height left below the columns (minimum 320 px) on every paint and resize,
      without touching the board DOM; columns stretch up to it and `.col-body` scrolls
      inside (`flex: 1 1 auto; min-height: 0; overflow-y: auto`). Empty columns stay folded.
      Respondido and Cerrado show the latest 20 (by stage entry) and a "Mostrar N mas"
      button (`.col-mas`, with an aria-label naming the stage) adds 20; changing the period
      goes back to 20. The list view (the natural one up to 768 px) applies the same 20 at a
      time but keeps flowing with the page: at 390/320 a bounded list under the header,
      tabs and bar would leave a few rows of space. The show-more state is in
      `firmaTablero`, and the button keeps the first click (pinned with `clicReal`). RED:
      "Cerrado muestra los 20 ultimos" got all 45, no button (`TypeError ... reading
      'click'`). GREEN: panels 1088/1088 (20 new in "I2").
- [x] I3 Stats computation in wa-scope: the four periods plus previous periods, the
      definitions above, bounded storage key, written with the board.
      `build_reports` in `bin/wa-scope`, written by `push_to_plugin` on every `sync` (the
      worker's periodic run) in the same storage write as `board`, under the key `reports`
      (shape below). A failure there is logged and keeps the previous value; the sync goes
      on. Pinned in `scripts/check-casos` "los informes del tablero" on hand-built fake data
      (Bogota and New York zones, fixed "now"): every metric, period limits and previous
      periods, no data, a case never answered (miss after the target, pending before),
      an outgoing message older than the request (not its response), a stage entry before
      creation (resolution 0), reopened case counted once, bursts, revoked messages,
      local-midnight boundaries, zero baseline (no percentage), DST (01:30 EST to 03:30 EDT
      is one hour; heatmap hour 01), another line's messages and cases, chats off or not
      registered, the SLA target read from the setting, the 500-row cap, and `sync`
      writing the key. RED: `AttributeError: ... has no attribute 'build_reports'`; then
      `reports` missing from storage after `sync`; GREEN: 49/49 in the section, whole
      check-casos 1165/1165 (1116 before).
      Performance (synthetic 50k messages in 60 in-scope chats over 90 days, 2,000 cases,
      8,000 events, 500 dispatches; Apple Silicon): `build_reports` 300-330 ms (SQL ~200 ms:
      hour buckets 46, day-chat pairs 41, bursts 76), against `build_board` 15 ms. The
      default retention (`capture_max` 20,000) keeps real stores below that. Key size in
      that worst case: ~240 KB as stored (indented), ~150 KB compact; half of it is the
      500 case rows.
- [x] I4 SLA target setting (global, panel key, validation, default 15) in Settings.
  - [x] I4.1 Backend: `sla_first_reply_minutes` (global, default 15, whole minutes 1..1440)
        in `bin/wa_settings.py`, flat panel key `slaMinutes` (sync mirrors it back; a dirty
        panel value is ignored, a valid one wins over the CLI). RED: default `None` and 0,
        1441 and "media hora" accepted, `slaMinutes` missing after sync (10 failures in
        `revisa_ajustes`); GREEN: check-clis 285 settings checks.
  - [x] I4.2 UI: a "Informes" card in Settings > Su aprobacion, right after the automatic
        replies (the first contact it measures): `#sla-minutes` (number, 1..1440, step 1,
        15 when nothing is saved), its hint, and its own Guardar (`#save-sla`) through the
        same `guardarTarjeta` path as its siblings (flat key `slaMinutes`, as text, re-read
        after writing). It is read with the other keys of that tab when the tab opens, not
        on every poll. Out of range, decimals or text are not saved and the card says the
        range; a host that rejects the write does not say saved. ES/EN/PT. RED: `#sla-minutes`
        missing (4 FALLA, then `TypeError ... reading 'focus'`). GREEN: panels 1104/1104
        (16 new in "I4").
- [x] I5 Reports tab: blocks 1–6 with comparisons, empty states, info texts, ES/EN/PT.
      `activity.html`: tabs Tablero | Informes (tablist with arrow keys) and the shared
      period on the same row. `reports` is read only while the Reports tab is visible (it
      is the biggest key); a host rejection keeps what is shown. Blocks, in the spec's order,
      each with its definition written under it: Ahora (5 tiles), Trafico (two heatmaps,
      rows per date or per weekday, 24 local hours, five steps of ONE blue ramp from the
      validated dataviz palette with a visible zero cell, a title per cell, the scale and
      the peak hour in words), Tiempos (median, "de N casos/esperas", comparison, CSS bars per
      hour/day/week with a title per bucket and an aria-label per chart; customer wait also
      says how many are still unanswered), Volumen (5 tiles with comparison and two
      two-series charts with legends), Meta del primer contacto (rate, points against the
      previous period, met/missed/pending in words and in a 2 px-gapped bar, the misses table
      and "y N mas"), Por proyecto (table; "Sin proyecto" last). A comparison shows only
      when the key brings one: arrow + percent (or points) + "vs. periodo anterior"; better
      and worse also get a readable text colour, never colour alone. Numbers use the
      panel's locale (`Intl`, so es-419 writes 12,345 and pt-BR 12.345). Empty states: no
      key, an unknown version, and a period with no data (each block says so; no 0 s, no
      empty charts). The Reports DOM is rebuilt only when what it shows changes, and its
      repaints go through `alSoltar`, so a click is never lost (pinned with `clicReal`).
      Fake key for tests and screenshots: `test/informes-ejemplo.mjs`.
      RED: no tabs (`FALLA dos pestanas`, then `TypeError ... reading 'getAttribute'`).
      GREEN: panels 1148/1148 (43 new in "I5"; the old "no tabs" check now pins that the
      only tabs are Tablero and Informes).
- [x] I6 CSV download (or a report of why the host blocks it).
      The host blocks downloads: the panel is a srcdoc iframe with `sandbox="allow-scripts"`
      only (orca-oss v1.4.160-lab.91.rc, `src/renderer/src/components/right-sidebar/
      PluginPanel.tsx:296`, pinned by `PluginPanel.test.tsx:202`), no `allow-downloads`,
      and the bridge has no download or clipboard method (`plugin-host-method-bindings.ts`).
      Probed in Playwright Chromium with that exact sandbox and the host CSP: a Blob
      `<a download>` produced 0 downloads, and `navigator.clipboard.writeText` failed with
      "blocked because of a permissions policy"; `document.execCommand('copy')` on a
      selected field, inside the owner's click, did copy. So there is no download button:
      the Reports tab has a 7th block, "Casos del periodo", with **Copiar CSV**. It copies
      the period's rows (`cases` created in [from, to]; Todo = all) with the spec's columns
      (id, chat, created, first response s, resolution s, stage, project, met target),
      header and values in the panel's language, fields quoted when they carry a comma,
      quote or line break, and a leading `'` on anything that starts like a formula (`= + -
      @`, the text is from customers). Lines end in LF: a `<textarea>` normalizes line breaks
      to LF, and spreadsheets read it the same. It says "Copiado: N casos", or "No se pudo
      copiar" when the browser refuses (never claims success), keeps the focus on the
      button, and says how many old cases the 500-row cap left out. With no cases in the
      period there is no button, only the sentence. Verified end to end in Chromium: the
      real `activity.html` inside a scripts-only sandboxed srcdoc iframe with the host CSP,
      a real click, and the clipboard read back from the parent page: header plus the 3
      rows of the period. Not verified inside the Orca app itself (Electron), which I did
      not run. RED: no `#reports-csv` (`TypeError ... reading 'click'`). GREEN: panels
      1167/1167 (19 new in "I6").
- [x] I7 Screenshots of the board and Reports at 1440/768/390/320, light and dark, ES and EN,
      looked at; `npm run check` green.
      New states in `test/shots.mjs`, every width, theme and language: `tablero-muchas`
      (69 cases, 26 Respondido and 34 Cerrado, scrolled to the finished columns),
      `tablero-muchas-cerrado` (only Cerrado, scrolled to its "Mostrar 14 mas"),
      `tablero-muchas-columnas` (the board view chosen at 390/320), `informes`,
      `informes-vacio` and `config-sla`; `informes-hoy` and `informes-sin-clave` at
      1440/320. Looked at (read the PNG): Reports 1440 dark ES, 1440 light EN, 768 dark ES,
      390 light ES, 320 dark EN, Hoy 1440 light ES, empty 1440 dark ES, no key 1440 light ES;
      board many-cards 1440 dark ES (first and scrolled), Cerrado-only 1440 light ES, 390
      light ES (list) and the board view at 390 light ES; Settings SLA card 390 light ES.
      Fixed after looking: the three times wrapped 2 + 1 at 768 (now three columns from
      200 px), the scale label sat on the tallest bar (now in its own strip), tables were cut
      at 390/320 (now one card per row with the column names), tiles were one per row at
      320 (now two). The heatmap ramp reads in both themes, including the zero cell.
      Board columns stay inside the 900 px window (the page is the window's height with 60
      finished cards) and each scrolls on its own. `npm run check`: exit 0 (every suite,
      1376 screenshots, no overflow, no JS errors, no selects); after the last CSS fixes,
      panels 1167/1167 and shots 1376 again, exit 0.
      Correction (review of c160deb): the tick above claimed more than was looked at. The
      many-cards board had been read only at 1440 and 390, Cerrado-only only at 1440 light,
      and the SLA card only at 390 light. They were read after the review fixes (R11 below).

## Review fixes (after c160deb)

Twelve defects confirmed by independent verifiers on c160deb. Each has its RED observed
before its fix (check-casos and panels tests, or the screenshot harness) and its GREEN after.

- [x] R1 A case closed without a reply took the reply to the chat's NEXT case as its first
      response (7500 s, an SLA miss). `primeras_respuestas` now bounds the outgoing message
      to before the first customer message of the chat's next case (`lead()` over the cases
      of the chat); a closed case with nothing in that window has no first response and no
      SLA status. The definition says so in the code, this spec and the Reports info text
      (ES/EN/PT). RED (check-casos "cerrado sin respuesta"): `[(2, 300, 'met'), (1, 7500,
      'missed')]`, sla `met 1 missed 1 rate 50.0`, first response `3900 n 2`. GREEN: case 1
      `(None, None)`, rate 100.0, first response 300 with n 1.
- [x] R2 "Su decision" missed cases the owner signed when the tick completed the send
      (decision -> respondido by `automatizacion`). It now also counts an owner event in
      decision with detail `aprobada <ver>`; a `regla` signature does not count. RED:
      7d `[(3, 1)]` (cases, owner_decision); GREEN: `[(3, 2)]`.
- [x] R3 The same project showed in two rows of "Por proyecto" (routed case vs. a case whose
      route had no project but whose chat did). `casos_del_informe` resolves the project as
      `proyecto_del_caso` dispatches it (route, then the chat's project), names it from the
      accepted catalog, and groups by id; only without either does the dispatch's name
      count (with its catalog id when the catalog has that name). RED: `[(None, 'Alfa Demo',
      2, 2), ('alfa-demo', 'Alfa Demo', 1, 1)]`; GREEN: `[('alfa-demo', 'Alfa Demo', 3, 3)]`.
- [x] R4 Week labels on the "Todo" axes overflowed the Tiempos charts and the page (807 >
      768 ES, 848 > 768 and 361 > 320 PT). The axis now prints the short date ("13 jul"; the
      week stays in each bar's title and the chart's name) and every mark ends in an
      ellipsis instead of leaving the card. New harness states `informes-30d` and
      `informes-todo` at every width, and pt-BR for the Reports states (`idiomas`). RED: the
      new states against c160deb's panel reported exactly those six overflows; panels
      "Todo: el eje dice la fecha corta" FALLA (`Semana del 13 jul...`). GREEN: no overflow
      in 1452 shots; looked at `informes-todo` es light 768, pt dark 768, pt light 320.
- [x] R5 Two-series bars could not be paired at 24/30 buckets (1 px inside a bucket, 2 px
      between). The two bars of a bucket now touch (one two-colour block) and each takes at
      most 38 % of the bucket, so a quarter of its width separates it from the next. RED:
      panels "volumen: los graficos de dos series separan cada cubeta" FALLA (no `.dos`);
      the verifiers read evenly spaced bars in the 1440 Hoy PNG. GREEN: looked at Volumen in
      `informes-hoy` es light 1440 and `informes-30d` es light 1440 and es dark 320: each
      blue/orange pair reads as one bucket.
- [x] R6 PT heatmap rows read "seg., …" without the day number. Rows are now built from
      parts, weekday without its dot or comma plus the day ("seg 28", "lun 28", "Mon 28").
      RED: `["seg., 28", ...]` and EN `["28 Mon", ...]`; GREEN: `["seg 28", ...]`; looked at
      `informes` pt light 1440 (the peak line, "qua 30 10:00", now matches a row).
- [x] R7 A period with nothing finished and nothing open showed "Todavia no hay casos" and
      hid the bar, and the saved period kept it that way. The empty state now follows the
      all-time counts; a period with nothing says so ("Ningun caso abierto ni terminado en
      este periodo...", ES/EN/PT) and keeps the bar. RED: `#board-empty` visible with the
      false text, bar hidden (3 FALLA); GREEN; new state `tablero-periodo-vacio`, looked at
      es light 1440 and en dark 320.
- [x] R8 `reports.cases[]` carried the case title (from the customer's masked text) for up
      to 500 cases, and the panel never used it. Dropped from `cases` (kept in the misses
      list, which the panel shows); contract above updated. RED: check-casos "csv: las
      filas no llevan el titulo" FALLA; GREEN.
- [x] R9 A non-object last entry in `reports.cases` threw in `bloqueCsv` and left the tab
      half drawn, and the signature was saved before painting so it stayed that way.
      `bloqueCsv` reads the last OBJECT row, and `firmaInformes` is set only after
      `pintarInformes` returns. RED: `TypeError: Cannot read properties of null (reading
      'created') at bloqueCsv` (it killed the test run); GREEN: all 7 blocks.
- [x] R10 The `reports` key had no line, so after a re-link the panel showed the previous
      line's report. `build_reports` writes `account`, and `renderInformes` treats a key
      that fails `deEstaLinea` as missing (no data), like the board's cards. RED:
      check-casos `account None`; panels "el informe de otra linea no se pinta" FALLA (it
      showed the blocks); GREEN.
- [x] R11 I7 claimed screens that had not been read. Read after the fixes, from the final
      `npm run check` run: board many-cards 1440 dark ES, 768 light and dark ES, 320 light
      and dark ES; Cerrado-only 1440 dark ES, 768/390/320 light and dark ES; Settings SLA
      card 1440 light and dark ES, 768 light and dark ES, 390 dark ES, 320 light and dark ES,
      320 light EN; Reports 1440 dark ES, 390 light ES, 320 dark EN. Nothing broken in them.
- [x] R12 The "Copiar CSV" result arrived in a live region created already filled, and a
      failure used `role=status`. The region now exists, empty, with the block; the click
      only changes its text (emptied first, so the same result twice is announced too) and
      a failure is `role=alert`, like `mensajeNodo`. The message is no longer in the
      repaint signature, so it does not rebuild the block or move the focus. RED: a new
      node already filled, and `role=status` on failure (2 FALLA); GREEN. Not tried with a
      real screen reader.

Checks after the fixes: check-casos 1175/1175 (6 new), panels 1184/1184 (17 new), `npm run
check` exit 0 with 1452 screenshots, no overflow, no JS errors. Before the fixes, one
check-casos run also failed "y su avance despues cuenta como el segundo: espera el ritmo"
(first-message Beta, not this feature) while `bin/wa-scope` was being edited under it; it
passed in the full run.

## Storage key `reports` (v 1), for the UI stage

Written by `wa-scope sync` next to `board`. All times are seconds; all timestamps are ISO
8601 with the machine's offset; hours are the machine's LOCAL hours. A metric with no data
is `null` (never 0 seconds); a comparison without a base (no previous period, or a previous
value of 0 or null) is `null`, so the panel shows no percentage.

```
{
  "v": 1,
  "account": str,                        // the line the report is for (cuenta_activa); the
                                         // panel shows a key of another line as no data
  "updated_at": ISO,
  "sla_minutes": int,                    // the target in force (setting sla_first_reply_minutes)
  "live": {                              // now, not period-dependent
    "open": int,                         // cases not in respondido or cerrado
    "decision": int,                     // waiting for the owner's decision
    "waiting_customer": int,             // latest dispatch waits for the customer (necesita)
    "blocked": int,
    "conversations": int                 // chats of the active line with mode != off
  },
  "periods": {
    "today" | "7d" | "30d" | "all": {
      "from": ISO | null,                // local midnight; null for "all"
      "to": ISO,                         // now
      "prev_from": ISO | null, "prev_to": ISO | null,   // same length just before; null for "all"
                                         // (today compares with yesterday up to the same clock time)
      "bucket": "hour" | "day" | "week", // bars: today by hour, 7d/30d by date, all by week
      "rows": "date" | "weekday",        // heatmaps: today/7d one row per date, 30d/all per weekday
      "first_response": T, "resolution": T,
      "customer_wait": T + {"unanswered": int},   // bursts still without an outgoing message
      "volume": {
        "totals": V, "prev": V | null,
        "delta_pct": {chats, received, sent, created, resolved: int | null} | null,
        "bars": [V + {"k": bucket key}]
      },
      "traffic": {
        "received": [{"k": "YYYY-MM-DD" | 1..7 (ISO weekday, 1 = Monday), "h": [24 ints]}],
        "resolved": [same shape]          // cases by the hour of their first resolution
      },
      "sla": {
        "met": int, "missed": int, "pending": int,
        "rate": float | null,            // percent of met over met + missed, 1 decimal
        "prev_rate": float | null,
        "delta_pts": float | null,       // rate - prev_rate, in points (not a percentage)
        "misses": [{"case_id", "title", "chat", "first_response_s": int | null, "project": str | null}],
                                         // newest first, at most 50; null first response = never answered
        "misses_more": int               // misses beyond the 50 listed
      },
      "projects": [{"id": str | null, "name": str | null, "cases": int,
                    "resuelto": int, "necesita": int, "bloqueado": int,   // latest dispatch outcome
                    "jev_held": int, "owner_decision": int}]
                                         // cases created in the period; most cases first,
                                         // "no project" (id and name null) last; at most 50
    }
  },
  "cases": [{"case_id", "chat", "created": ISO, "first_response_s": int | null,
             "resolution_s": int | null, "stage", "project": str | null,
             "sla": "met" | "missed" | "pending" | null}],
                                         // every case of the active line, newest first, at most
                                         // 500; the CSV of a period = rows with created in [from, to].
                                         // No title: it comes from the customer's text and
                                         // the panel never shows it here
  "cases_more": int                      // rows left out by the cap
}
T = {"value": median seconds | null, "n": int, "prev": seconds | null,
     "prev_n": int | null (null = no previous period), "delta_pct": int | null,
     "bars": [{"k": bucket key, "value": median | null, "n": int}]}
V = {"chats": distinct chats with messages, "received": int, "sent": int,
     "created": cases created, "resolved": cases first resolved}
bucket keys: hour "YYYY-MM-DD HH" (00 to the current hour), day "YYYY-MM-DD",
week = its Monday "YYYY-MM-DD" (from the first week with data, at most 104 weeks).
```

Membership: first response and SLA count the cases CREATED in the period; resolution and
"resolved" count the cases FIRST resolved in it; customer wait counts the bursts that
STARTED in it. Messages are those of the active line, in chats with mode != off, without
revoked ones; cases are those of the active line. A case closed without any response, or
without customer messages in the store, is outside the SLA; the outgoing message that
answers a case is the first one before the chat's next case starts. "Jev held" = a send
held by Jev or a "Jev asked to revise" event; "owner decision" = left `decision` by the
owner's hand, signed there by the owner (`aprobada <ver>`, even when the tick completes
the send), or still waiting there. A case's project is resolved as the dispatch does it:
the case's route, else its chat's project, named from the accepted catalog; only without
either does the dispatch's recorded name count (with its catalog id when it has one).

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
