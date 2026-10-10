# A line that stops being attended is caught, recovered and reported

## Objective

On 2026-10-09 the second line (the bot line) captured every message in real time but judged
none of them for six and a half hours. A group's bug report sat unanswered, and nobody was
told. Lines capture independently but share the attention machinery: one `tick`
automation, one `triage` automation, one worker, one global `tick_at`, and a tick summary
that says `busy` only when every line is busy. When Orca restarts in the middle of a run,
that run stays `dispatching` and Orca schedules nothing more for that automation for hours.
Nothing in the plugin noticed. Separately, Jev closed a client's bug report as `nothing`,
and approval notices to the owner failed with `send-wrong-line`.

The owner's requirement: each line is attended on its own, a stop is recovered without a
human, and when it cannot be recovered the owner is told.

## Evidence (live, 2026-10-09, identifiers omitted)

- Bot-line messages were judged within seconds until 11:14. After the Orca restart at
  12:46, none was judged until the next Orca restart at 19:05.
- The `tick` run scheduled at 12:38 and the `triage` run at 12:40 are stuck in `dispatching`,
  with `dispatchedAt` null and no terminal. The triage history is complete and shows no run
  between 12:40 and 16:54, despite a `*/2` cron. Every stuck `tick` run in the history comes
  8 to 17 minutes before an Orca daemon restart.
- Jev's verdict on the group's message: `attention_class: bug_report`, `skip: true`, so the
  message was closed as `nothing`.
- `aviso` rows fail with `send-wrong-line`: the notice leaves from the owner's personal line
  to the owner's own chat, which exists only on the bot line.

## Scope

1. Jev's `skip` never closes a message whose class asks for something (`CLASES_QUE_PIDEN` /
   `CLASES_PEDIDO`) from someone who is not the owner. Such a message goes on to the normal
   group and direct-chat checks.
2. Each line records its own tick time (`tick_at@<account>`); the global key stays for
   compatibility. `tick_se_encarga` and the triage precheck read the line's own time. The
   combined tick output lists which lines were busy.
3. A per-line health read for the worker and the panel. For each active line it gives:
   - the age of the line's last tick;
   - how many incoming messages in authorized, non-`off` chats are captured but have no case
     and no verdict, and how old the oldest is;
   - the sidecar's last beat.
4. The worker becomes the tick's backup, independent of Orca's scheduler. Every minute it
   reads the line health. For any line whose tick is older than 3 minutes, or that has an
   unjudged message older than 3 minutes:
   - the worker runs `wa-scope tick --json --line <account>` itself, with a hard timeout
     under 300 s;
   - it never runs two at once for the same line;
   - the tick's own lock keeps it from overlapping Orca's run.
5. Every failure of the worker's ingest or backup tick is appended to a per-line log on disk
   (`~/.wa-inbox/logs/`, size-capped). This keeps evidence for the next incident; today the
   worker's log is lost.
6. If a line is still unattended 10 minutes after the backup started, or an automation run
   has sat in `dispatching` for more than 10 minutes:
   - the owner gets one notice per incident on his approval chat, sent through a line that
     can reach it;
   - the panel shows the condition (ES/EN/PT);
   - a recovery is reported once.
7. Approval and block notices leave through a line where the owner's approval chat exists.
   The case's own line comes first, then the other active lines. The owner's reply (`si N`,
   etc.) is recognized on the line it arrives on.
8. The end-to-end failure audit (A0) may add tasks. Each added task names the failure it
   covers.

## Out of scope (owner decides later)

- Narrowing the `commitment` rule (weekdays, months and dates without a promise verb).

## Checklist

- [ ] A0 Audit every silent failure point in the chain:
      capture → ingest/Jev → case → agent → send → notice → follow-up.
      For each point, record what detects it today.
- [x] V1 Jev skip never closes a client's request-class message (scripts/check-casos).
      `skip_que_vale` in the verdict path and before caching. RED: 4 FALLA in "jev: el skip
      no cierra el pedido de un cliente (V1)" (group bug report: no case; cached verdict
      `nothing`; direct closed `cerrado`; `veredicto_de_jev` returned `cerrar`); the owner
      check already passed. GREEN: that section and everything before it, 291/291.
- [x] V2 Per-line `tick_at`, a per-line `tick_se_encarga`, and busy lines in the combined
      output (scripts/check-casos). RED: 4 FALLA in "el tick de cada linea (V2)" (no
      `tick_at@<account>`, no `lineas_ocupadas`, the second line's precheck said 1 with its
      own tick stale). GREEN: 352/352 through that section.
- [x] V3 Per-line health read (scripts/check-casos). `wa-scope lineas-salud --json`: one
      object `{at, lineas}`, each line with `cuenta`, `principal`, `tick_hace_s`,
      `sin_juzgar`, `sin_juzgar_hace_s`, `latido_hace_s`; read-only connection, no fan-out,
      exit 0. RED: `invalid choice: 'lineas-salud'`. GREEN: 374/374 through "la salud de cada
      linea (V3)".
- Install variants covered (any install, not only this owner's): Jev without a key and Jev
  turned off (V1 is a no-op, no request to Jev); `local` account without a store (one
  `tick_at` key, precheck as before); a single linked line (its key plus the global, tick
  output unchanged, one `lineas-salud` row); no store at all (`lineas: []`, no scope.db
  created). The test lock follows `tick_toma` on win32.
- [ ] V4 Worker backup tick per line, plus the persistent per-line failure log
      (test/worker.test.mjs).
- [ ] V5 Owner notice and panel state for a line still unattended, or a run stuck in
      `dispatching`, with screenshots (test/panels.test.mjs, reduced shots).
- [ ] V6 Notices leave through a line that reaches the approval chat; replies are
      recognized there (scripts/check-casos).
- [ ] V7 Checks green without the full screenshot matrix; version bump; PR ready.

## Acceptance

- With Orca's `tick` automation not running at all, a message in an authorized chat of any
  line is judged within about 4 minutes, and its reply or acknowledgement goes out.
- One line stuck or busy never hides it: the owner hears about it within about 13 minutes,
  and the panel says which line.
- A client's bug report in a `responder` group is never closed as `nothing` by Jev's skip.
- Notices to the owner reach him on the line where his chat exists; `send-wrong-line` no
  longer appears for them.

## Checks

- `PYTHONDONTWRITEBYTECODE=1` for every Python step.
- The `scripts/check-*` suites and the `test/*.test.mjs` suites listed in `package.json`,
  without `npm run shots`.
- Reduced shots for the panels V5 touches: `WA_INBOX_SOLO`, `WA_INBOX_TEMA`,
  `WA_INBOX_ANCHO`, `WA_INBOX_IDIOMA`.
