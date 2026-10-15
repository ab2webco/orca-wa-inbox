# Delivery and read status of our sends (baileys-mensajes C1)

## Objective

Today an outbox row ends at `enviado` once WhatsApp returns the message id. That only proves
the server took it. Store whether it reached the client's phone and whether it was read, so
`wa-send` and the agent can tell a reply that was seen from one that never arrived.
Clients see nothing different: we only read receipts WhatsApp already sends.

## Facts (Baileys 7.0.0-rc14 source, lib/Socket/messages-recv.js `handleReceipt`)

- 1:1 receipts for our messages arrive as `messages.update` with `update.status`
  (`WebMessageInfo.Status`: 0 ERROR, 1 PENDING, 2 SERVER_ACK, 3 DELIVERY_ACK, 4 READ,
  5 PLAYED) and `messageTimestamp` = the receipt time in seconds.
- Group receipts arrive as `message-receipt.update`, one per participant, with
  `receipt.receiptTimestamp` (delivered) or `receipt.readTimestamp` (read or played).
- A refused send after the fact arrives as `messages.update` with status ERROR.
- The same event also carries edits and deletes (already handled) and receipts for incoming
  messages read on the owner's other devices; only rows of `envio` are touched, matched by
  account and stanza id, so those are ignored.
- The receipt key's chat can be the LID while the row has the phone jid: match on the stanza
  id, never on the chat.

## Scope

- `envio` gains `entrega` (null, `servidor`, `entregado`, `leido`, `reproducido`, `error`) and
  `entrega_at` (seconds). It only moves forward; `error` only replaces null or `servidor`.
- A receipt that arrives before the send is resolved (the race between `sendMessage`
  returning and the row being closed) is held in memory, bounded, and applied when the row
  gets its stanza id.
- In a group, the best status seen from any member is kept.
- `wa-send --json` for a sent request carries `entrega` and `entrega_at`; asking again with the
  same `--id` reports the current status without sending twice.

Out of scope: per-member status in groups, panel display, acting on the status.

## Checklist

- [x] E1 Sidecar reads the status from both events (`estadoDeEntrega` in mensajes.js; sidecar-mensajes RED missing export, GREEN 155/155).
- [x] E2 Store: `entrega` / `entrega_at` columns, forward-only `anotarEntrega`, early receipts
  held (500 at most) and applied on `resolverEnvio` (almacen RED `anotarEntrega is not a
  function`, GREEN 367/367; envio 138/138). SQLite's drop column breaks on a comma inside a
  schema comment, so the new comments have none.
- [x] E3 Sidecar wiring: `messages.update` and `message-receipt.update` feed the store
  through `ingerirEntrega` (almacen RED missing export, GREEN 370/370; bundle rebuilt,
  sidecar-build 11/11, sidecar-pairing 129/129).
- [x] E4 `wa-send --json` reports `entrega` and `entrega_at` of a sent request, the text line
  names it, and the help explains it (envio RED 139/142, GREEN 142/142; check-clis,
  check-voseo and check-datos-reales green).
- [ ] E5 Release checks and version.

## Acceptance criteria

- A delivered then read receipt leaves `entrega='leido'` with the read time; a late
  `entregado` after `leido` changes nothing.
- A receipt for a stanza id that is not ours changes no row.
- A receipt that arrives before `resolverEnvio` is not lost.
- Asking `wa-send` again with the same id shows the status and sends nothing.

## Checks

`node test/sidecar-mensajes.test.mjs`, `node test/almacen.test.mjs`,
`node test/envio.test.mjs`, `npm run build:sidecar`, `node test/sidecar-build.test.mjs`, then the
release check set.
