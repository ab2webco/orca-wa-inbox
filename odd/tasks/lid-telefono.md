# Phone number next to a LID chat

## Objective

WhatsApp now keys direct chats by an internal id (`<digits>@lid`) and no longer shows the
phone number. The user cannot tell which chat is which, nor find one by the number saved in
their phone. Show the phone number when it is known and let the conversation search match
it.

## Facts

- Baileys emits `contacts.upsert` from the phone's address book (app-state `contactAction`)
  as `{ id: <pn>@s.whatsapp.net, name, lid: <digits>@lid }` (sidecar bundle, v6.7.24).
  `ingerirContactos` (sidecar/src/ingesta.js) already names both chats since v4.11.4.
- Messages can also carry the pairing (`senderPn`/`participantPn`, or the alt fields in
  `key`) depending on the Baileys version; verify in the bundle before relying on it.

## Scope

1. Store the LID↔phone pairing per line when Baileys provides it (a small table or a column
   on `chat`, with a migration in the store's existing migration mechanism). Bookkeeping
   only: a jid and a number, never a message body.
2. The panel's conversation list shows the phone (formatted `+57 300 000 0000` style,
   generic for any country code) next to a LID chat's name when known, and the search
   matches digits of the phone ("300 0000" finds it).
3. `wa-scope`/`wa-read chats --json` expose the phone for agents.
4. No real numbers in the repo: use the allowlisted fake values in
   scripts/check-datos-reales.

## Checklist

- [x] L1 Pairing stored from contacts (and messages if available) — test/almacen.test.mjs.
      Proof: RED `no such table: lid_telefono`, then GREEN 270/270 (14 new checks in
      "ingesta: el telefono de cada LID": contacts, received direct/group messages,
      history `pnJid`/`lidJid`, own messages ignored, old store gets the table).
- [x] L2 Exposed by `wa-read chats` — check-clis.
      Proof: `revisa_telefono_de_lid` RED (`phone` missing in wa-read and in the
      panel's synced list), then GREEN "8 CLI arrancan, 224 comprobaciones". Covers
      LID with pairing, LID without, phone direct, group, and a store without the table.
- [x] L3 Panel shows and searches the phone — test/panels.test.mjs + screenshots
      1440/768/390/320 both themes.
      Proof: RED 18 failures (976/994), then GREEN 994/994 (ES and EN: phone next to
      the name, unnamed LID named by its phone, +1/+506 formats, search by "300 777",
      by digits and by the full number, identity line). Screenshots
      `config-combo-telefono` (search "+57 300") looked at in ES at 1440/768/390/320,
      light and dark, and EN at 1440/320 light and dark.
- [x] L4 `npm run check` green.
      Proof: exit 0 (with WA_INBOX_CAPTURAS in a private folder): check-clis 224,
      check-closing 36/36, check-casos 957/957, manifest 110/110, resolver 29/29,
      userdata 15/15, sidecar-build 5/5, pairing 88/88, mensajes 99/99, almacen
      270/270, envio 90/90, panels 994/994, worker 395/395, 1144 screenshots without
      overflow or JS errors.
