# Only the owner approves a held send; an agent can ask the owner and wait

## Objective

1. `wa-send --approve <id>` puts a held draft on the wire, and its docs call it "an explicit
   act of the owner", but any agent session that can run the CLI could call it (seen
   2026-10-02: a project session approved its own held notices; kanban-casos T22 point 1).
   Only two callers are legitimate: the plugin worker when the owner clicks on the board
   (`acciones.mjs`, `entregar`), and `wa-scope` from the tick after the owner's WhatsApp
   reply (`entrega_del_dueno`). Approval must come from one of those, never from an agent.
2. T18 (Plane): a project agent that messages the owner needs to wait for his answer with
   `wa-read wait --chat <jid> [--after <stanza|timestamp>] [--timeout <s>] --json`.

## Design

- **Approver secret.** A random 256-bit hex key in `approver.key`, mode 0600, in the plugin's
  data dir next to `scope.db` (`~/.wa-inbox/`, `%APPDATA%/wa-inbox/` on Windows), the same
  place as the Jev mirror `jev.env`. One writer: `aprobador.mjs`, run by the worker as an
  unfenced subprocess (the worker itself cannot write disk), which reads it or creates it
  atomically. The Python side only reads it (`wa_settings.llave_aprobador`).
- The worker and `wa-scope` pass it to `wa-send --approve` ONLY in that child's environment,
  as `WA_INBOX_APPROVER`. It is never put in the tools' shared env, in harness files, in
  automation commands or in prompts.
- `wa-send --approve` refuses without the matching key: `send-approve-not-owner`, exit 3, one
  sentence saying approval comes from the board or the owner's WhatsApp reply. The check runs
  before anything else in `--approve`, so nothing about the draft leaks.
- **Audit.** `--approve` takes `--by board|whatsapp-reply`; the approval writes one
  `agent_action` row (`approved`, `<req_id> · approved on the board` / `... by the owner's
  WhatsApp reply`) when the draft actually moves to `pendiente`. Case events already record
  the approval itself (`aprobada <v>` by `dueno`, `... por WhatsApp`, or actor `regla`).
- **Unchanged:** sends to the owner's own chat and to the direct chat of an Operator or Super
  admin skip the hold and need no approval (regression test).
- **Honest scope:** this stops a mistaken or misdirected agent. Same-user code that reads the
  key file on purpose can still approve; the docs say so.

## Checklist

- [x] A1 RED/GREEN: `wa-send --approve` without the key, with a wrong key, or with the key
      but no key file is refused with `send-approve-not-owner` (exit 3), nothing is sent and
      the draft stays `borrador`; with the key it sends (test/envio.test.mjs).
      RED: 90/109, 19 failures; the key one: "sin la llave, --approve se niega con su codigo
      y sale 3 — 0" (an approve without any key exited 0 and the draft went out as
      `enviado`); `--by` unknown. GREEN: 109/109. The held-message texts no longer tell the
      agent to run `--approve` (two existing assertions updated to that spec).
- [x] A2 RED/GREEN: `aprobador.mjs` creates the key once (0600, 64 hex), returns the same key
      on later runs, and repairs a looser mode (test/envio.test.mjs).
      RED: the suite crashed with `Cannot find module .../aprobador.mjs`. GREEN: 5/5 in the
      `aprobador.mjs` block (also replaces a file that is not a key).
- [x] A3 RED/GREEN: the board path passes the key to the `--approve` child only, with
      `--by board`; the draft call and other tools never get it (test/worker.test.mjs).
      RED: 411/413, "la aprobacion dice que viene del tablero (--by board)" and "solo el
      hijo --approve recibe la llave" (`{"llave":null,"env":[null,null]}`). GREEN: 413/413;
      every `wa-scope` call the worker made carried no key.
- [x] A4 RED/GREEN: the tick's WhatsApp-reply path passes the key and `--by whatsapp-reply`;
      `si N` still sends (scripts/check-casos), and existing `--approve` tests pass the key
      the way the plugin does.
      RED (fast copy, 14 sections): 1065/1072, "`si N` aprueba la version avisada y la
      respuesta sale — decision", "por la misma peticion del caso", the audit row, and four
      more `si` cases. GREEN: 1072/1072. Tests get the key by running `aprobador.mjs` (in
      `linea_lista`, as the plugin does at start); the cancelled-draft test now asserts
      `send-cancelled` instead of any non-zero exit, so the gate cannot hide it.
- [x] A5 RED/GREEN: the panel translates `send-approve-not-owner` in ES/EN/PT
      (test/panels.test.mjs or check-panels).
      RED: 1390/1398 ("cada codigo estable tiene su texto — [send-approve-not-owner]", and
      the card showed the raw code in es-419, en-US and pt-BR). GREEN: 1398/1398 (`tablero`,
      `board`, `quadro`). Only an error string on an action that failed: no screen layout
      changed, so no new shots.
- [x] A6 RED/GREEN: audit row `approved` with who approved (test/envio.test.mjs).
      RED: "y la bitacora anota quien lo aprobo — []". GREEN: one `approved` row per real
      approval, `... approved on the board` / `... by the owner's WhatsApp reply`.
- [x] A7 RED/GREEN: no harness file, automation command, manifest command, prompt or
      generated resolver carries `WA_INBOX_APPROVER` or the key file name
      (scripts/check-harness).
      The guard scans harness/**, prompts/**, automations/*.json, orca-plugin.json,
      harness.mjs, agente.mjs, catalogo.mjs, scripts/resolver_formas.py AND the tools'
      `--help` (seeded into COMMANDS.md); it first proves it finds a planted file of each
      kind. RED: "el --help de una herramienta nombra la llave del aprobador" (the first
      wa-send docstring named the variable), plus the two doc checks below. GREEN: 74
      checks.
- [x] A8 Regression: an agent's send to the owner's chat goes out without any approval and
      without the key (test/envio.test.mjs). Guard test, green from its first run as
      expected: no key file, no `WA_INBOX_APPROVER`, both owner sends `enviado`.
- [x] A9 Docs: wa-send help/docstring, agent-facing harness docs and README say agents
      cannot approve, and why it is not a defence against malicious same-user code.
      RED/GREEN in scripts/check-harness: COMMANDS.md and the whatsapp-cli skill must say
      `cannot approve` and `send-approve-not-owner`. Held-message texts, `--drafts` and the
      activity `draft` row no longer name `--approve`. README (owner, Spanish) explains the
      gate and its honest limit; neither the help nor the README names the variable or
      the key file.
- [x] B1 RED/GREEN: `wa-read wait --chat <jid>` works like the positional form; neither or
      both is an argument error (scripts/check-clis).
      Found: `wa-read wait <chat>` already existed (f0978b8, cli-huecos C4: authorization,
      exit 5 `wait-timeout`, store polling). T18 added the `--chat` form. RED: "unrecognized
      arguments: --chat", "sin chat salio 2 ... que nombre --chat", help without `--chat`.
      GREEN after B1: only the B2/B3 failures left.
- [x] B2 RED/GREEN: `--after <stanza_id>` returned by `wa-send` works even before the
      sidecar stored the echo of that message (scripts/check-clis).
      RED: "salio 1 (no message 'S-PREG' in 'Yo Mismo' ...)". GREEN: falls back to the
      `envio` row of that chat (settled time) and waits.
- [x] B3 RED/GREEN: in the line's chat with itself (the owner's own chat), the owner's reply
      typed on the phone (`from_me`, not a send of the line) wakes `wait`; the line's own
      send does not (scripts/check-clis).
      RED: masked by B2 ("salio 1"). GREEN: woke on S-RESP only, not on the echo S-PREG.
      scripts/check-clis exit 0, 391 checks.
- [x] B4 Docs: `wa-read wait` help and the agent-facing docs describe "ask the owner and wait
      for the reply". `wa-read wait --help` (checked in check-clis: `--chat`, `owner`),
      wa-send's help, harness COMMANDS.md and the whatsapp-cli skill use `--chat`.
- [x] F1 Final check, once: `npm run check` with reduced screenshots (dark, 390, es).
      Exit 0: check-casos 1612/1612, envio 109/109, panels 1398/1398, worker 413/413,
      check-clis 391, check-harness 74, 91 shots in ~/Projects/.capturas-approve-smoke.
      Looked at `tablero-accion-error` and `tablero-poblado` (es, dark, 390): unchanged
      layout; the new string uses the same card-error slot. No panel screen changed, so no
      `npm run shots` at 1440/390 in both themes was needed.

## Open

- Held drafts that are NOT tied to a case (e.g. a project session's message held by the
  floor) have no approval path left except cancel: the board only approves cases, and the
  owner's own terminal is now refused like any agent. Owner decision needed: a board entry
  for those drafts, or accept that they are rewritten or cancelled.
- "Rule" sends do not go through `--approve`: the tick sends them with `--send` (floor and
  Jev still review). Their trail is the case event by actor `regla`; no `approved` row.
- `wa-scope caso aprobar --actor dueno` is still callable by any agent (it signs the
  version; the tick then sends through `--send`, so the floor and Jev still apply). Same
  class of problem as this task, outside its scope.
- Same-user code can read `approver.key` on purpose; documented as the honest limit.

## Acceptance criteria

- No agent-reachable path approves a held draft without the key; the board and the owner's
  WhatsApp reply still do.
- The refusal has a stable code that the panel translates in every language it ships.
- Every approval says who approved it.
- The owner's chat and an Operator/Super admin direct chat behave exactly as before.
- `wa-read wait --chat` returns the owner's reply, or exits 5 `wait-timeout`.

## Checks

- `node test/envio.test.mjs`, `node test/worker.test.mjs`, `node test/panels.test.mjs`
- `scripts/check-clis`, `scripts/check-harness`, `scripts/check-casos` (via a temporary
  `scripts/.casos-rapido` copy for the section being iterated, deleted afterwards)
- Final: `WA_INBOX_CAPTURAS=~/Projects/.capturas-approve-smoke WA_INBOX_TEMA=dark
  WA_INBOX_ANCHO=390 WA_INBOX_IDIOMA=es PYTHONDONTWRITEBYTECODE=1 npm run check`
