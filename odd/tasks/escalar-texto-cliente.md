# escalar-texto-cliente (WAINBOX-57, WAINBOX-58)

## Objective

An `escalar` that proposes a message for the customer keeps that text in its own field
(`respuesta`), apart from the question to the owner (`instrucciones`) and the evidence
(`evidencia`). Approving it, from the board or by answering the WhatsApp notice, sends
exactly that field and nothing else. The owner's notice shows the whole text (split into
several messages when long) and one plain question in the owner's language, and the
approval is bound to the version the notice showed.

## Scope

- `wa-scope caso propuesta --tipo escalar --respuesta <customer text> --instrucciones
  <question> [--evidencia <report>]`: the contract already stores the three fields; the
  harness says which goes where. No parsing of free text, no migration: an old escalar
  without `respuesta` sends nothing when approved.
- WhatsApp: `si N` on an escalar with `respuesta` approves that version and delivers the
  field through `entrega_del_dueno`; without it, today's path (back to the agent).
- Board: the card carries the customer text (`proposal.texto`, only `respuesta`) and the
  question (`proposal.pregunta`); `enviar` is offered and accepted for an escalar with a
  `respuesta` (wa-scope `acciones_de`, `acciones.mjs`, `activity.html`); the edit box is
  prefilled with the customer text, never the instructions.
- Notice (`texto_de_escalado`): header, the full customer text, one fixed question line.
  Longer than one message: split at whitespace into parts under the limit, sent in order
  with ids `<req>`, `<req>-p2`...; the row is `enviado` only when every part went out, and
  quoting any part answers that notice.

## Tasks

- [x] E1 Tests (RED): board and WhatsApp approval send `respuesta` byte for byte with both
  live shapes; old shape sends nothing; long text arrives whole in parts; a stale version
  is refused with the `cambio` message; card fields and actions.
- [x] E2 wa-scope: approval paths, card, notice and split sending (GREEN).
- [ ] E3 Board: `acciones.mjs` enviar and `activity.html` card and actions (GREEN).
- [ ] E4 Harness: the three-field contract for `escalar`.
- [ ] E5 `npm run check` without shots, reduced shots of the board, PR.

## Acceptance

- The text sent equals the `respuesta` field; "Verificado", "No verificado" and the
  instruction quotes never travel.
- An escalar without `respuesta` sends nothing to the customer when approved.
- A long customer text arrives complete in the notice.
- Approving after the text changed is refused with a clear message.
- Fake data only (public repo).

## Checks

- `scripts/check-casos`, `node test/worker.test.mjs`, `scripts/check-harness`,
  `scripts/check-prompts`, `scripts/check-voseo`, `scripts/check-datos-reales`, the rest of
  the `check` chain without `npm run shots`, and reduced shots of `activity.html`.
