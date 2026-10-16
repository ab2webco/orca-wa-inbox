# Follow-up of every answered case

## Objective

Today a case that got a reply stays in `respondido` forever. Nothing checks whether we still
owe the customer something, whether the customer answered our question, or whether the
case can be closed. Make every sent reply say what it waits for, and give each case a
scheduled review that acts on it, so no customer is left waiting and every case ends with
a clear mark.

## Facts (code map, 2026-10-15)

- `respondido` leaves only when the customer writes again within `case_window_hours` (12),
  or by hand. There is no automatic close. `gracias_sin_pregunta` keeps the case
  `respondido`.
- `avisa_meta_vencida` (goal `sla_first_reply_minutes` = 15) watches only cases with no
  reply at all; an acknowledgement stops it, so a promise ("lo reviso y te cuento") that
  is never kept goes unseen.
- `contexto_del_chat` already knows when our last message asked a question
  (`pregunta_pendiente`, 24 h).
- `tick_preguntas_proyecto` is the existing pattern for escalating an unanswered question
  after N hours.
- `caso_recordatorio` gives the timer, the once-only state handling and the board label
  (`reminder`), but its actions are only to notify the owner or wake the agent.
- The chat's `hours` and `timezone` are stored but nothing reads them. The plugin's quiet
  hours (`en_silencio`) are global.

## Scope

- S1 What a sent reply waits for: `nosotros`, `cliente` or `nada`. The agent states it
  when it proposes or reports. When it does not, the plugin infers it: an acknowledgement
  or progress update means `nosotros`, a reply with a question means `cliente`, anything
  else means `nada`. It is stored on the case with the time of its review.
- S2 Scheduled review in the tick, next to `tick_preguntas_proyecto`:
  - `nosotros`: if no final reply went out within `follow_up_us_minutes` (default 30),
    the case goes back to the agent with the promise quoted. A second miss tells the
    owner.
  - `cliente`: no answer within `follow_up_customer_hours` (default 24) gets one
    follow-up written by the agent through the normal review, never in quiet hours.
    No answer within `follow_up_close_hours` (default 72) closes the case as "no answer
    from the customer".
  - `nada`: nothing new within `follow_up_done_hours` (default 48) closes the case as
    "attended, needs no more replies".
  - A customer message cancels the pending review (the normal flow takes over).
- S3 A customer's thanks or "it works" after a final reply closes the case as "attended,
  needs no more replies" instead of leaving it `respondido`.
- S4 The board card shows what the case waits for and when it is reviewed, and the
  closing mark.
- S5 Settings: the four values above, with validation, in the settings panel.

Out of scope: per-chat business hours (the stored `hours` stays unused).

## Checklist

- [x] S1 What a sent reply waits for. RED: check-casos `seguimiento S1` failed (`caso propuesta --espera` unrecognized, no `caso_seguimiento`). GREEN: 15/15; full check-casos 2508/2508.
- [x] S2 Scheduled review. RED: `seguimiento S2` 12 FALLA, then E_STAGE (no review, no cancel, no `seguimientos` count). GREEN: 24/24.
- [ ] S3 Thanks after a final reply closes the case.
- [ ] S4 Board shows the wait and the mark.
- [ ] S5 Settings.

## Acceptance criteria

- An acknowledgement with no final reply after 30 minutes sends the case back to the agent
  once, then tells the owner.
- A question to the customer with no answer gets one follow-up at 24 h and is closed at
  72 h with its mark.
- A final reply with nothing new is closed at 48 h with its mark.
- A customer message before the review cancels it.
- "Gracias, ya funciona" after a final reply closes the case.
- The board shows the wait and the review time.

## Checks

Strict TDD. check-casos, panels, worker, check-clis, check-voseo, check-datos-reales;
screenshots of the board card at 1440, 768, 390 and 320 in both themes (reduced set for the
release).
