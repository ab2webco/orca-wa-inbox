# Held updates and missing acknowledgements: the customer always hears back

## Objective

In a live support group (Responder, `first_reply_mode = model_with_ack_fallback`, ack on),
customers got no message at all while the agent worked a case: every progress update the
agent wrote was held, and the fixed acknowledgement never went out. The owner had to answer
by hand. The owner's rule: the plugin and the agents answer the customer; the owner should
not have to.

Observed causes (read-only review of the live install):

1. A group message that is not a mention or a reply (`kind = grupo`) never gets the
   first-message treatment, even when Jev classes it as a request and it opens a case:
   `auto_de_jev` only acks `directo`, `respuesta` and `mencion`. So no fallback
   acknowledgement is registered for the case.
2. With the fallback (`respaldo`), `acuse_sobra` drops the acknowledgement when the case is
   already in `trabajo`/`listo`/`respondido` or waits for the owner, even if nothing reached
   the customer.
3. A held update (`caso avance`) is dropped silently: the instructions say "A held update is
   dropped, not sent", so the agent never rewrites it.
4. False holds:
   - The fixed floor reads "hoy" and "esta mañana" as a promised date in plain statements
     ("ese paso hoy solo existe para...", "los leads de hoy").
   - Jev's draft review flags plain acknowledgements ("recibido, voy a revisar esa
     conversación") as `promises_a_date` and `states_status_not_verified`.

## Scope

- A1. Group requests get the first message: in a `responder` group, a message that opens a
  new case and that Jev classes as a request (`CLASES_PEDIDO`, no risk flags, no exception)
  is treated like a direct message for the first reply: the chat's `first_reply_mode`
  applies (agent first message, plus the fixed acknowledgement as fallback in
  `model_with_ack_fallback`; the fixed acknowledgement in `ack`). Group chatter that opens
  no case is unchanged.
- A2. The fallback acknowledgement goes out whenever nothing reached the customer: with
  `respaldo`, the stage (`trabajo`, `listo`, waiting for the owner) no longer drops it;
  only something actually sent or on its way (`caso_ya_escribio`) does. Everything else in
  `auto_omite` (exceptions, risk flags, owner/Super admin, closed case, mode off) still
  applies.
- A3. A held update is rewritten once: the instructions (dispatch brief, triage prompt,
  `whatsapp-soporte` skill, `COMMANDS.md`) tell the agent that a held update comes back
  with its reasons and must be rewritten once without the flagged claim; if the rewrite is
  held too, drop it. The `caso avance` JSON already returns `estado` and `motivo`; it also
  returns a plain `hint` when held. A rewrite does not count toward `updates_max`.
- A4. The fixed floor: "hoy"/"today"/"hoje" and "esta mañana"/"this morning"/"esta manhã"
  count as a commitment only in a sentence that also promises an action (a future or a
  delivery verb: voy a/vamos a/va a, te (lo) mando/envío/entrego/paso/confirmo/tengo,
  queda/quedará, will/'ll, vou/vamos). All other date markers are unchanged.
- A5. Jev's draft review: the `promises_a_date` and `states_status_not_verified`
  questions say that acknowledging receipt, saying the assistant will look into it or will
  report what it finds (with no date or time), or that the case was escalated, is neither.
  A promise with a date, a time or a deadline is still flagged.

- A6. The chat's instructions are binding and visible: today they reach both the case file
  (triage agent) and the dispatch brief (project agent) in full, but as one bullet inside
  the header ("- Owner's instructions for the chat: ..."), with no statement of weight. Move
  them to their own section, `## The owner's instructions for this chat (follow them)`,
  right after the header, in both files, saying they govern how to handle and answer in
  this chat and that only the hard rules (never wa-send, nothing destructive, the plugin's
  review and approvals) take precedence over them. Same for the tone.
- A7. The project agent works from its project's knowledge: the dispatch brief says the
  work was sent to this project because it knows it; read and use the project's own
  context first (its CLAUDE.md/AGENTS.md, docs, memory, code, data access) before
  concluding; the case agent's interpretation is a hint, not a fact; and do not report
  `bloqueado` for a question the project's own context answers.

Out of scope: the levels of a chat's approval rules; Jev's thresholds; anything that sends
money, credential or destructive content.

## Checklist

- [x] A1 group request gets the first-message treatment (RED → GREEN)
- [x] A2 fallback acknowledgement when nothing reached the customer (RED → GREEN)
- [x] A3 held update rewritten once: hint + instructions + harness check (RED → GREEN)
- [x] A4 fixed floor "hoy"/"esta mañana" only with a promise verb (RED → GREEN)
- [x] A5 Jev draft questions + live probe on held texts before/after
- [x] A6 chat instructions as their own binding section in both briefs (RED → GREEN)
- [x] A7 dispatch brief: use the project's own knowledge first (RED → GREEN)
- [x] Reduced shots only if a panel string changes
- [x] Release

## Acceptance criteria

- A group request in Responder with `model_with_ack_fallback` registers the fallback
  acknowledgement; group chatter does not.
- A case in `trabajo` with every update held gets the fixed acknowledgement after
  `ack_fallback_minutes`; a case with an update sent does not.
- "ese paso hoy solo existe" passes the floor; "te lo mando hoy" is still a commitment.
- `caso avance` held returns a `hint` to rewrite; a second held text is dropped.
- Live probe: the held acknowledgements from the review pass Jev's draft review after A5,
  and a draft with "te lo tengo el viernes" is still flagged.

## Checks

- `scripts/check-casos`, `scripts/check-harness`, `scripts/check-reglas` (or the suite that
  covers `wa_reglas`), `scripts/check-jev` if present.
