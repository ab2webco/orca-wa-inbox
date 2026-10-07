# A reply (or a job's result) that goes to another chat

## Objective

The owner, or a Super admin of a conversation, asks the agent in his own chat "draw a
conclusion about X" and then "report it to the client in group <name>" (or just "report it
to the client"). Today the agent refuses: `caso propuesta` has no destination and a
`responder` proposal always goes to the case's own chat. The Super admin role (v4.18.1,
superadmin-ordena) could therefore never report anything elsewhere.

## Decision (owner)

- Only when the requester counts as the owner (`caso_pide_como_dueno`: the owner, or every
  writer is a Super admin of THAT conversation) can a proposal name another chat as its
  destination. A customer never can.
- The destination must be on the SAME line as the case and authorized in `responder`.
  Otherwise the CLI refuses with a code the agent can explain.
- The destination is part of the proposal (and of its version): the owner approves the text
  AND where it goes. The rule never signs it alone: it always waits for the owner, who sees
  the destination in the approval notice on WhatsApp (`si N`) or on the board.
- Once approved it goes out directly to the destination (`wa-send --send`): the fixed floor
  and Jev review it with the DESTINATION's levels, as any reply to a client. A held text
  follows the existing rules (back to the agent to rewrite, or the owner decides on the
  board, where his second approval sends the held draft with `--approve`).
- The case stays in the requester's chat. After it goes out, the requester gets one short
  confirmation in the case's chat: "Sent to <chat>."
- Work too: `caso propuesta --tipo trabajar --chat <dest>` keeps the destination, and the
  worker's `caso resultado` reply proposal carries it.
- The agent does not guess the client's chat: `wa-scope caso destinos <id>` lists the chats
  of the same line in `responder` that have the case's project. One -> use it; several ->
  ask the owner which; none -> say so and ask which chat.

## Scope

CLI first (`bin/wa-scope`): `caso propuesta --chat`, `caso ver`/`listar` show the
destination, `caso destinos`, `--help` with the refusal codes. Then the rule, the notice,
the delivery paths (tick, `si N`, the board's Enviar in `acciones.mjs`), the confirmation,
the board card, and the harness docs. No other case-management feature.

Refusal codes of `caso propuesta --chat` (exit 2, JSON on stderr):

| Code | When |
|---|---|
| `E_ARGS` | `--chat` with `escalar` or `descartar` |
| `E_DEST_ROLE` | the requester is not the owner nor a Super admin of the conversation |
| `E_DEST_NOT_FOUND` | no chat of this line matches |
| `E_DEST_AMBIGUOUS` | the reference names more than one chat; the candidates are in the detail |
| `E_DEST_LINE` | the chat exists only on another line |
| `E_DEST_MODE` | the chat is not in `responder` on this line |

## Checklist

- [x] R1 CLI `caso propuesta --chat <jid|phone|name>` (responder and trabajar): validation
      and codes above, `chat` stored in the proposal (part of the version; the case's own
      chat is no destination), `caso ver`/`listar` (json `destino` with `chat_jid`,
      `chat_name` and `retenido`, text `-> <name>`), `--help`. Tests: `scripts/check-casos`.
      Proof: RED, every `--chat` call refused by argparse (usage error), 4/19 green;
      GREEN 19/19.
- [x] R2 The rule never signs a reply to another chat (`other_chat`, waits for the owner),
      the destination's levels apply (no owner-chat bypass), the tick only takes it while
      the destination is `responder`, and the approval notice says where it goes (es/en).
      Tests: `scripts/check-casos`. Proof: RED 1/7 (the tick signed and SENT the reply,
      to the case's own chat); GREEN 7/7.
- [x] R3 Delivery to the destination: the tick (owner-signed), `si N` and the board's Enviar
      send to the destination with `--send` (floor + Jev); a held draft is sent by the
      owner's next approval on the board with `--approve`; one confirmation to the case's
      chat after it goes out. Tests: `scripts/check-casos`, `test/worker.test.mjs`.
      Proof: RED check-casos 2/10 (nothing reached the destination), worker 584/589 (the
      board sent to the case's chat with draft + `--approve`, and Edit dropped the
      destination); GREEN 10/10 and worker 589/589.
- [x] R4 Work: `--chat` on `trabajar`, kept by `caso resultado`'s `resuelto` reply proposal
      (a `necesita` question goes to whoever asked, in the case's chat), the brief tells the
      worker where its reply goes, and the case file keeps the destination for a redo.
      Tests: `scripts/check-casos`. Proof: RED 2/6 (the result lost the destination and
      went out at once to the case's chat); GREEN 7/7 (the case-file line went RED by
      mutation first).
- [x] R5 `wa-scope caso destinos <id> [--json]`: the chats of the line in `responder`
      sharing the case's project, with the reason. Tests: `scripts/check-casos`.
      Proof: RED `invalid choice: 'destinos'` (E_ARGS); GREEN 9/9 (one, several, none,
      the owner's project, text mode, E_DEST_ROLE for a customer).
- [x] R6 Board card: `proposal.destino` and the panel shows "Va a: <chat>" / "Goes to:
      <chat>" (pt "Vai para") when it differs, and the history says `other_chat` in words.
      Tests: `scripts/check-casos`, `test/panels.test.mjs`, reduced shots. Proof: RED
      check-casos 1/2, panels 1612/1618; GREEN 2/2, panels 1618/1618. Shots
      `tablero-otro-chat` and `tablero-otro-chat-detalle` (es, dark, 390): no overflow, no
      JS errors; both opened and looked at (a long group name wraps, the arrow line sits
      above the text).
- [ ] R7 Harness: AGENTS.md, the whatsapp-soporte skill and COMMANDS.md say how to use the
      destination and `caso destinos`; never refuse the owner/Super admin; a customer cannot.
      Tests: `scripts/check-harness`, `scripts/check-prompts`.

## Acceptance criteria

- An owner/Super admin case can propose a reply or a job whose reply goes to another
  `responder` chat of the same line; a customer case gets `E_DEST_ROLE`.
- Nothing goes to another chat without the owner's approval of that version.
- The board and the WhatsApp notice name the destination before approving.
- The requester's chat gets one confirmation after the send.

## Checks

`scripts/check-casos`, `scripts/check-clis`, `scripts/check-harness`, `scripts/check-prompts`,
`scripts/check-voseo`, `scripts/check-datos-reales`, `node test/panels.test.mjs`,
`node test/worker.test.mjs`, reduced shots of the board card.
