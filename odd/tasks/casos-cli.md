# Case management from WhatsApp: CLI parity with the board

## Objective

The owner manages his cases by talking to the agent on WhatsApp ("how is case 12 going?",
"close everything from group X", "remind me tomorrow at 9"). The agent only has the CLI, and
`wa-scope caso` today covers the case agent's own loop (classify, propose, move) but not what
the owner does on the board: search, filter, read a card's state in words, the reports, a
note, a reminder, a bulk close. This task gives the agent that parity, plus a few abilities
the board does not have yet (notes, reminders and snooze, bulk actions, every line at once).

## Decisions

- Every command is JSON-first (`--json`), text output short; refusals keep the existing
  contract: exit 2 and `{"error", "detail"}` on stderr with an `E_*` code.
- `caso listar` keeps returning a list of rows. By default the rows are SHORT (no proposal
  text, no route JSON) and in the board's order (`ORDEN_FILTRO`: decision first, then the
  flow, bloqueado last; newest first inside a stage), capped by `--limite` (default 50; the
  rest is said on stderr). `--completo` gives the full rows of before.
- Search matches like the board (`coincide` in activity.html): the case number (with or
  without `#`), or a substring of the title or the chat name, ignoring accents and case.
- Bulk actions are owner-level: `--actor dueno`, or `--actor agente` with `--pedido <id>`,
  the case where the owner (or a Super admin of that conversation) asked for it
  (`caso_pide_como_dueno`). Anything else is `E_NOT_OWNER`. Closing many (`cerrar`, or
  `mover ... cerrado`) is a dry run unless `--confirmar`, and only on the owner's own
  request: a Super admin asks like the owner except for the destructive.
- A note is an event that does not move the case, does not touch its approval and does not
  bump `updated_at` (so it does not change the grouping window).
- A reminder fires from the tick of its own line: one notice to the owner's approval number
  (the existing notice queue, `aviso`, tipo `recordatorio`) "Caso N: <title> — <text>", and
  with `--al-agente` the case is marked for the agent when its stage allows it. A snooze
  (`--hasta`) hides the case from the default listing and from the agent until then (a new
  message from the customer ends it), and fires a reminder at its end.
- `--todas-las-lineas` runs the read in one process per linked line and labels each row with
  its `account`. Writes never cross lines: a bulk action acts on the active line (or
  `--line`), and an id of another line is reported as not found.
- Closing a case in `trabajo` stops its project agent: the tick already did it within a
  minute (`tick_vigila`: terminal closed, dispatch `cancelado`). `caso mover` does not wait
  for Orca (the board gives a `caso` command 20 s); it says the next tick stops it.

## Scope

`bin/wa-scope` (the `caso` subcommands, the tick, the board's card events), the schema
migration (`caso.pospuesto_hasta`, table `caso_recordatorio`), `activity.html` (the history
lines for notes, edits and reminders, the reminder chip), the harness docs. No change to how
cases are created, judged or sent.

## Checklist

- [x] K1 Search: `caso buscar <texto>` and `caso listar --buscar <texto>`, matching like the
      board. Tests: `scripts/check-casos`. Proof: RED `invalid choice: 'buscar'` (E_ARGS);
      GREEN 8/8.
- [x] K2 `listar` filters and size: `--abiertos`, `--etapa` repeatable or comma list,
      `--desde today|7d|30d|<date>`, `--prioridad`, `--proyecto`, `--necesita-agente`,
      `--limite N`, short rows by default and `--completo`, board order by default.
      Tests: `scripts/check-casos`. Proof: RED 0/1 then `unrecognized arguments: --orden`;
      GREEN 18/18 (and the older listar sections 8/8, 7/7, 12/12, 76/76, 30/30, 28/28).
- [x] K3 `caso estado <id>`: the card's computed context (owner actions, dispatch,
      blocked_reason, no_agent_rule, read_only, project, destination, stage since) and the
      history in readable reasons. Tests: `scripts/check-casos`. Proof: RED `invalid choice:
      'estado'`; GREEN 10/10. The board's per-card computation moved to `tarjetas_de`, shared
      by `build_board` and `caso estado` (board sections 20/20, 15/15, 3/3, 76/76, 2/2).
- [x] K4 `caso informe [--periodo] [--csv]`: per-stage counts, waiting on customer, first
      reply and resolution times vs the target, SLA, from `build_reports`.
      Tests: `scripts/check-casos`. Proof: RED `invalid choice: 'informe'`; GREEN 7/7 (the
      board's reports section 262/262).
- [x] K5 `caso nota <id> <texto>`: an event in any stage, no move, no approval change; shown
      in `ver` (`notas`) and in the board history. Tests: `scripts/check-casos`,
      `test/panels.test.mjs`. Proof: RED `invalid choice: 'nota'`, panels 1618/1624 (the
      note read "updated"); GREEN 10/10, panels 1624/1624. Also in `estado` and in the case
      file the agent reads ("Notes on the case"); the card masks a credential.
- [x] K6 `--ahora` on `caso atender` and `caso autorizar`: also launches the case agent like
      the board (`lanza_agente`, origin `dueno`). Tests: `scripts/check-casos`. Proof: RED
      `unrecognized arguments: --ahora`; GREEN 5/5 (existing atender/autorizar sections 15/15,
      16/16).
- [x] K7 `caso editar <id> [--titulo] [--prioridad] [--clase]` in any stage, without moving
      or clearing the approval; `caso clasificar` in trabajo/listo/respondido touches instead
      of E_STAGE. Event recorded. Tests: `scripts/check-casos`, `test/panels.test.mjs`.
      Proof: RED `invalid choice: 'editar'`, panels 1624/1627 (an edit read "updated");
      GREEN 9/9, panels 1627/1627 (etapas 20/20, reclasificar 4/4, history 15/15).
- [x] K8 `caso retirar <id>`: clears the proposal and its approval, cancels its draft, the
      case goes back to clasificado (decision with a credential); closing a case in trabajo
      stops its project agent on the next tick. Tests: `scripts/check-casos`. Proof: RED
      `invalid choice: 'retirar'`; GREEN 9/9 (rancia 11/11, T8 76/76, etapas 20/20).
      Investigated: `mover ... cerrado` already stopped the project agent, on the next tick
      (`tick_vigila` closes the terminal and leaves the dispatch `cancelado`; covered by "T8:
      el despacho al proyecto"). Stopping it inside `mover` was rejected: Orca calls can take
      longer than the board's 20 s for a `caso` command. `mover` now says so
      (`despacho.stops: next_tick`).
- [x] K9 `caso lote <cerrar|mover|proyecto|prioridad>` over ids or listar filters,
      owner-level only, dry run for closing without `--confirmar`. Tests: `scripts/check-casos`.
      Proof: RED `invalid choice: 'lote'`; GREEN 14/14 (the requesting case never enters its
      own batch; a case that fails keeps its code and does not stop the rest). A Super admin's
      request may run a batch that does not close; closing in bulk is only the owner's
      (superadmin-ordena: "except the destructive"). Proof: RED 0/1, GREEN 16/16.
- [x] K10 `caso recordar <id> --cuando|--hasta [texto] [--al-agente] [--cancelar]`,
      `caso recordatorios`, `listar --con-recordatorio`, snooze hidden by default
      (`--pospuestos` shows it); migration; the tick fires due reminders. Tests:
      `scripts/check-casos`, `test/panels.test.mjs` (chip). Proof: RED `invalid choice:
      'recordar'`, panels 1628/1637 (no chip, history read "updated"); GREEN 27/27, panels
      1640/1640 (the 3 detail-line checks were written with their code, not seen RED);
      affected sections migracion 14/14, tablero 20/20, tick 24/24, needs-agent 9/9, base
      nueva 12/12, agrupacion 14/14, T14 78/78. Shots `tablero-recordatorio`,
      `tablero-nota-detalle` (es, dark, 390) looked at.
- [x] K11 `--todas-las-lineas` on listar, buscar and informe (and recordatorios). Tests:
      `scripts/check-casos`. Proof: RED `unrecognized arguments: --todas-las-lineas`; GREEN
      9/9 (a bulk close on the main line answers E_NOT_FOUND for the other line's case).
- [x] K12 Harness docs: AGENTS.md, COMMANDS.md, the whatsapp-cli and whatsapp-soporte skills
      teach when to use each command, never naming an agent. Tests: `scripts/check-harness`.
      Proof: RED 4 files missing the commands and rules; GREEN 93 checks (every flag in the
      docs exists in the real `--help`).
- [x] K13 (review, blocker) `caso lote --actor dueno` checks the approver key like `caso
      aprobar --actor dueno` (`trae_llave_aprobador`); without it, or with a wrong one,
      E_NOT_OWNER. Tests: `scripts/check-casos`. Proof: RED 1/5 (without the key the batch
      closed both cases); GREEN 5/5 (K9 16/16, K11 9/9 with the key as the plugin passes it).

## Acceptance criteria

- The agent can answer "how is case N going?" from `caso estado` alone.
- The agent can find a case by number, title word or chat name, accents and case ignored.
- Nothing closes in bulk without the owner's yes (`--confirmar` after a dry run), and only
  on the owner's or a Super admin's request.
- A reminder reaches the owner's approval number once, on its line, and can be listed and
  cancelled; a snoozed case leaves the default listing until it is due.
- Every existing suite stays green.

## Checks

`scripts/check-casos`, `scripts/check-clis`, `scripts/check-harness`, `scripts/check-prompts`,
`scripts/check-voseo`, `scripts/check-datos-reales`, `node test/panels.test.mjs`,
`node test/worker.test.mjs`, reduced shots of the board (es, dark, 390).

## Checks run (final state)

- `scripts/check-casos` full: 1944/1950. The 6 failures are not this feature's:
  - 4 in "avisos-orca" (`blocked`/`waiting` windows): they depend on the time of day (the
    run was at night, inside the notices' quiet hours). The base commit `259ab77` fails the
    same 4 at the same hour (1818/1822).
  - 2 in "todo por linea (P3)" (the bot account of each line's dispatch): intermittent. On
    the same tree, from the first section through P3 (1753/1753) and L3..P3 (73/73) pass.
- The 128 checks of this feature (sections `casos-cli K1`..`K11`) pass in every run.
- `scripts/check-clis` 8 CLIs, 494 checks; `scripts/check-harness` 93; `scripts/check-prompts`
  15; `scripts/check-voseo` 44 files; `scripts/check-datos-reales` (16 allowed test values,
  no real phone or jid).
- `node test/panels.test.mjs` 1640/1640; `node test/worker.test.mjs` 589/589 when run alone
  (586/589 while check-casos ran at the same time: the sidecar QR timing tests).
- Reduced shots (`WA_INBOX_SOLO=tablero`, es, dark, 390): 36, no overflow, no JS errors.
  Looked at: `tablero-recordatorio`, `tablero-nota-detalle` (new), `tablero-poblado`,
  `tablero-detalle`.
- Not run: `npm run check` and the full `npm run shots` (owner's rule).
