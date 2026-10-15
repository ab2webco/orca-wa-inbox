# Make better use of Baileys

## Objective

The owner's ❤️ reaction was stored as an empty message and the agent answered that it
arrived empty (fixed on fix/linea-desvinculada). The owner asked for a thorough review of how
the sidecar uses Baileys 7.0.0-rc14 (the current npm `latest`) and to use it better.

## Audit (2026-10-13, read-only, Baileys source checked)

A. Message types that still became an empty body: group call offer, polls (V1/V2/V3/V5),
   location, live location, contact(s), video note (`ptvMessage`), event, button and
   interactive replies, album container, group invite, FutureProof wrappers (animated
   sticker, group mention, associated child, poll V4). `contextoDe` lost the quote of any
   type other than text and the five media.
B. Reliability: `markOnlineOnConnect` defaults to true (the owner shows online whenever the
   sidecar runs; may suppress phone notifications); `fetchLatestBaileysVersion` on every
   start without a timeout; no `cachedGroupMetadata`; no `shouldIgnoreJid` for newsletters
   and broadcast; 428/503 closes reported as `desconocido`; 1:1 disappearing chats get a
   permanent reply.
C. Features: delivery/read status of our sends; owner reactions as signals; quoting the
   client's message; typing presence; editing/deleting our sent message; marking read.
   Quoting, typing, editing and marking read change what clients see: owner decision.

## Checklist

- [x] A1 Readable bodies for the other message types, generic FutureProof unwrap, video note
  as video, call offer and album container dropped, quote kept for any type
  (sidecar-mensajes: RED 132/142, GREEN 142/142; almacen 353, pairing 120, bundle 11/11).
- [x] B Reliability items that change nothing clients see: the WhatsApp Web version fetch
  has an 8 s limit and falls back to Baileys' own; newsletters and broadcast are ignored at
  the socket (`shouldIgnoreJid`); 428 and 503 closes are named `socket-caido`
  (sidecar-pairing: RED missing export, GREEN 128/128; bundle 11/11).
- [x] N1 Address book names (nombres-de-libreta): group members are LIDs and almost none
  ever wrote to the owner, so names from his phone were dropped (`nombrarChat` only updated
  existing chats). New `contacto` table (by phone and LID, source libreta > verificado >
  apodo, a lower source never overwrites a higher one), `contacts.update` listened, and the
  Python side (`NombresDeLibreta`) names message authors, senders and group members as the
  owner saved them, through the LID-phone pair (almacen RED no such table, GREEN 357/357;
  check-clis RED missing class, GREEN 550).
- [x] B1 `markOnlineOnConnect: false`, approved by the owner on 2026-10-13: Baileys
  announces 'unavailable' on connect (lib/Socket/chats.js), receiving is unchanged
  (sidecar-pairing: RED 128/129, GREEN 129/129; bundle 11/11).
- [x] C1 Delivery and read status of our sends, stored on the outbox: done as
  `odd/tasks/estado-envios.md` (v4.30.9).
- [ ] C2-C6 Owner decisions, not started.

## Checks

`node test/sidecar-mensajes.test.mjs`, `node test/almacen.test.mjs`,
`node test/sidecar-pairing.test.mjs`, `npm run build:sidecar`, `node test/sidecar-build.test.mjs`,
then the release check set.
