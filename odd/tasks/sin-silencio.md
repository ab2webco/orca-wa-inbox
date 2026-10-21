# The customer is never left in silence (WAINBOX-62, WAINBOX-60)

## Objective

A customer message with content always gets an answer, an acknowledgement or an owner
decision. Urgency or a follow-up is never a pleasantry. A refused first message falls back
to the plain acknowledgement. A blocked result from the project agent becomes one plain
decision question for the owner and an honest draft for the customer.

## Facts (code map, 2026-10-21)

- `urgency_pressure` is a Jev flag at 0.5, and it is not in `BANDERAS_SIN_RIESGO`. So it counts as
  risk in `auto_de_jev` (no ack), `auto_omite` (ack omitted) and `avance_frena`
  (E_EXCEPTION). That is the `E_EXCEPTION (urgency_pressure)` seen live.
- Jev's `skip` comes only from `salta_bajo` scores. Urgency has none, so "please, urgently"
  classed as `pleasantry` is skipped and closed as `jev_skip`. After a final reply, the
  same skip also closes the respondido case as attended (`MOTIVOS_GRACIAS`).
- `cmd_caso_avance` raises E_EXCEPTION on a risk flag, and nothing else goes out in `model`
  mode.
- `caso mover <id> cerrado --actor agente` closes any case, even one with content that was
  never answered.
- `caso resultado --estado bloqueado` moves the case to bloqueado and sends the owner the raw
  English summary (`aviso_de_bloqueo`). The case agent never sees it, so there is no decision
  question and no customer draft.

## Scope

- U1 Urgency, pressure and follow-ups are never pleasantries: they are never skipped,
  urgency is no risk for the ack or for updates, and a pressing message gets the ack.
- U2 A first message or update refused with E_EXCEPTION falls back to the plain ack (once,
  only if nothing has gone out yet). The ack carries no claim, so the risk flags do not stop
  it. The owner's own case, a credential, and a chat that is not in responder still stop it.
- U3 The case agent (or a worker) cannot close a customer case that has content when no
  reply has gone out and the owner was never asked: E_UNANSWERED tells it to propose a reply,
  or to ask the owner with the reply it proposes.
- B1 A blocked result from the project agent goes to the case agent, not to a raw notice.
  The agent runs `caso bloqueo` with one question, its options and a customer draft. The case
  moves to decision as an owner question (`escalar`). The draft is checked for internal
  names: projects, paths, hosts, IPs and accounts.
- B2 The owner's answer moves the case on. An option number re-dispatches the work with
  that decision, and `enviar` sends the draft. Any other text goes back to the agent.

Out of scope: panel changes (the case shows in the Decision column as it is today).

## Checklist

- [x] U1 Urgency is never a pleasantry. RED: `sin-silencio U1` 0/7, then 7/8 (Jev criterion). GREEN: 8/8; U1 plus the Jev sections 179/179.
- [x] U2 A refused first message falls back to the ack. RED: `sin-silencio U2` 2/6 (no ack left, nothing sent, no follow-up). GREEN: 6/6; with the first-message, ack, avisos-retenidos and menos-ruido sections 165/165.
- [x] U3 No silent close of a customer case with content. RED: `sin-silencio U3` 3/7 (agent and worker closed it). GREEN: 7/7; check-harness 105, check-voseo green.
- [x] B1 A blocked result becomes an owner question and a customer draft. RED: `sin-silencio B1` 4/16 (no `caso bloqueo`, raw notice, no agent instructions). GREEN: 16/16; all sin-silencio sections 37/37.
- [x] B2 The owner's answer re-dispatches or sends. RED: `sin-silencio B2` 2/6 (the answer went to the agent). GREEN: 6/6; B1 and B2 22/22.

## Acceptance criteria

- An urgency message gets an acknowledgement or a reply; it is never closed as a pleasantry,
  and it does not close the previous respondido case.
- A refused update falls back to the acknowledgement, and the 30-minute follow-up applies.
- Closing a customer case with content without a reply or an owner question is refused.
- A blocked result produces the owner question and the customer draft; internal names never
  reach the draft.
- The owner's answer re-dispatches the work or sends the draft.

## Checks

Strict TDD. check-casos (new sections `sin-silencio`), check-voseo, check-harness,
check-prompts, the whole `npm run check` chain without shots. No panel is touched, so no
screenshots.
