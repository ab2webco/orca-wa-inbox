# Number check before sending: WAINBOX-79

## Objective

A send queued to a phone number the line has never talked to is checked with Baileys
`onWhatsApp` first. A number that is not on WhatsApp closes as `rechazado` with the stable
code `numero-sin-whatsapp`, and `wa-send` says so with its own code, instead of a generic
library error or a message that goes nowhere.
Source: `docs/research/wainbox-69-baileys-audit.md` R6.

## Boundary

`sidecar/src/envio.js`, `sidecar/src/index.js` (one call site), `sidecar/sidecar.cjs`
(rebuilt), `bin/wa-send`, `scripts/check-clis`, `test/envio.test.mjs`. No panel change, so
no shots.

## Requirements

- FR-1 Only a new phone chat is checked: a `<digits>@s.whatsapp.net` jid with no message in
  the store for that line and no `enviado` row in the outbox. Groups, LIDs and chats with
  history are not checked (no extra query per reply).
- FR-2 `onWhatsApp` returns a list without an `exists: true` entry (Baileys drops the
  numbers that are not on WhatsApp): the row closes as `rechazado` with
  `numero-sin-whatsapp`, and nothing goes out.
- FR-3 The number exists: the send goes out to the queued jid, as before.
- FR-4 The check cannot answer (throws, returns `undefined`, or the socket has no
  `onWhatsApp`): the send is attempted. A false "not on WhatsApp" would block a legitimate
  message; a failed check is not evidence.
- FR-5 `wa-send` maps the code to `send-not-on-whatsapp` with a sentence that says what to do.
  `scripts/check-clis` compares the sidecar code with the one `wa-send` translates.
- FR-6 No customer data: the reason is the code only, never the number.

## Test cases

- TC-1 new number, not on WhatsApp → `rechazado`/`numero-sin-whatsapp`, not sent (FR-2)
- TC-2 new number on WhatsApp → `enviado` (FR-3)
- TC-3 check throws / `undefined` / missing → `enviado` (FR-4)
- TC-4 group, LID, chat with an incoming message, chat with a sent row → no check (FR-1)
- TC-5 `wa-send` real process → first stderr line `wa-send: send-not-on-whatsapp` (FR-5)
- TC-6 `check-clis`: same code in sidecar and `wa-send` (FR-5)

## Checklist

- [x] RED tests first: `test/envio.test.mjs`
- [x] Sidecar: `numeroNuevo`, `existe` hook in `atenderSalida`, `index.js` wiring
- [x] `wa-send`: `send-not-on-whatsapp`
- [x] `scripts/check-clis`: code comparison
- [x] `npm run check` without shots, on the owner's Mac, rebased on `main` 01eaf18:
  `check-casos` 2840/2840 and the other 21 steps pass. The `database is locked` seen on the
  iMac (Linux) did not reproduce here.
