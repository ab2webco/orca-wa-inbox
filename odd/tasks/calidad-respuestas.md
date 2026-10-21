# Reply quality and reuse before dispatch (WAINBOX-63, WAINBOX-61)

## Objective

The case agent represents the business on WhatsApp. Its replies must read like an expert
customer-service representative wrote them: natural, not stiff, always professional (63).
And it must not send the same read-only `trabajar` again when the team already verified
the answer a few hours ago (61).

## Facts (code map, 2026-10-21)

- The fixed floor is `bin/wa_reglas.py`. Its `excepciones()` output is STORED on the case
  (`caso_anota_salida`) and never erased, so a quality code must not go through it: it is
  judged fresh on each text.
- A proposal's reply is judged by `frenos_de_regla` (rule approval, the tick's revision loop
  `tick_revision_regla`, `RONDAS_DE_REVISION` then the owner). Every text that leaves goes
  through `wa-send` (`revision_piso`), including `caso avance`.
- Per chat levels: `quality` defaults to `agent` (rewrite). `nivel_de_motivo` returns `ask`
  for an unknown code, so each new code must map to `quality`.
- The board translates hold codes in `activity.html` (`MOTIVO_KEY`, es/en/pt).
- The case file (`archivo_de_caso`) already carries the chat's memory: earlier cases, their
  summary and the reply sent. It does not carry what the project agents verified.
- `relacionado` is only the chat's previous case, not "same topic".

## Scope

- Q1 `wa_reglas.calidad(texto, internos)`: deterministic, no model. Codes `stray_quotes`,
  `internal_marker`, `internal_name`, `too_long`, `several_addressees`.
- Q2 Wire it to every outbound path with the chat's `quality` level: `frenos_de_regla` and
  `wa-send`. The owner's chat and an operator's direct chat stay exempt (only the secret
  check runs there). Registry names from one helper both tools call.
- Q3 Board strings for the new codes (es/en/pt).
- Q4 The standard in the harness (AGENTS.md, whatsapp-soporte skill), guarded by
  check-harness; the plugin's own customer texts pass the guard.
- K1 What the team already verified: fresh `resuelto` reports of this chat's earlier cases
  (24 h), with their time, in the case file and in the project agent's brief.
- K2 A `trabajar` on a topic with a fresh verified result is refused (`E_KNOWN`): reply
  with it, or dispatch only what is new with `--nuevo`. Stale or different topic still
  dispatches. The owner's own order and an operator's case are exempt.

## Checklist

- [x] Q1 Guard function, one test per rule. RED: check-calidad `AttributeError: module 'wa_reglas' has no attribute 'calidad'`. GREEN: 43/43.
- [x] Q2 Wired to proposals and wa-send, with levels and exemptions. RED: 5 FALLA (frenos_de_regla returned [] [], aprobar by rule signed, unmapped codes asked the owner), then `revision_piso()` took no `internos`. GREEN: 57/57.
- [x] Q3 Board strings. RED: 5 FALLA (no MOTIVO_KEY entry). GREEN: 69/69 with es/en/pt strings and the event codes.
- [x] Q4 Harness standard and plugin texts sample. RED: check-harness 14 missing phrases (7 rules x AGENTS.md and the skill). GREEN: check-harness 119 checks; check-calidad 74/74 with the plugin's ack, greeting and closing texts clean.
- [x] K1 Already verified, with time, in the case file and the brief. RED: check-calidad K1 (no section). GREEN: 89/89.
- [x] K2 Refuse a repeated dispatch; `--nuevo`. RED: no E_KNOWN, `--nuevo` unrecognized; check-harness 6 missing phrases. GREEN: check-calidad 89/89 (fresh refuses, stale/other topic/necesita dispatch, owner exempt), check-harness 125.

## Acceptance

- Each quality rule has a passing test; the plugin's own texts pass it.
- A follow-up on a topic with a fresh verified result yields a reply proposal, not a new
  dispatch; a stale or different topic still dispatches.
- No regression in `check-casos`, `check-harness`, `check-clis`, panels.

## Checks

`scripts/check-calidad` (new, in `npm run check`), then the full `npm run check` without
shots; reduced shots of the activity panel only.
