# WAINBOX-69 — Baileys capability audit and improvement backlog

Research only: no plugin code changed. Read on 2026-11-10 against the Baileys source that is
actually installed (`.orca-wa-inbox-deps/node_modules/@whiskeysockets/baileys`, sibling of the
plugin tree) and the sidecar in `sidecar/src/`. It builds on the earlier read-only review in
`odd/tasks/baileys-mensajes.md` (2026-10-13) and does not repeat what that review already fixed.

References:

- `index.js:N`, `mensajes.js:N`, `envio.js:N`, `ingesta.js:N` are files under `sidecar/src/`.
- `lib/...:N` is a file inside the installed Baileys package.

## 1. Version

| | Value | Evidence |
|---|---|---|
| Our pin | `@whiskeysockets/baileys` **7.0.0-rc14**, exact (no `^`) | `scripts/deps.package.json` (template that `scripts/setup.mjs` copies to `../.orca-wa-inbox-deps` and installs there) |
| Lockfile | 7.0.0-rc14 from the npm registry with a sha512 integrity hash; `libsignal` 6.0.0 (registry, integrity) pinned by `overrides`; `whatsapp-rust-bridge` 0.5.4 | `../.orca-wa-inbox-deps/package-lock.json`, which lives **outside the repo** |
| npm `latest` | 7.0.0-rc14 (published 2026-07-29); `legacy` = 6.7.24 | `npm view @whiskeysockets/baileys dist-tags` |
| GitHub latest release | v7.0.0-rc14 | `gh api repos/WhiskeySockets/Baileys/releases` |

`sidecar/package.json` has no dependencies. Baileys is bundled into `sidecar/sidecar.cjs` by
`sidecar/build.mjs` with esbuild, so the plugin tree never ships `node_modules`.

**We are on the latest release, so nothing released has broken us since our version.** What is
coming next:

- **`master`, 3 commits after rc14 (unreleased):** fix in the logging of an example; "advertise
  WIN_HYBRID instead of retired WIN32 web sub-platform" (#2741); a copyright year bump.
  - **#2741 does not affect us.** `lib/Utils/validate-connection.js:29-40` uses the WIN32/DARWIN
    sub-platform only when `syncFullHistory` is true **and** `browser[1] === 'Desktop'`. We pass
    `syncFullHistory: false` (`index.js:338`) and `Browsers.appropriate('Chrome')` (`index.js:635`),
    so we always send `WEB_BROWSER`, on Windows too.
- **`develop`, 17 commits ahead of `master` (the next release):** a concurrency audit in ten
  stages. Changes that matter to us:
  - a `LockManager` and a `transactWith` auth API;
  - a **SQLite auth store plus a migration utility**;
  - a fix for the retry-counter race;
  - query timeouts;
  - media downloads bound to the per-socket `media_conn` host;
  - a move to a pnpm monorepo with the Rust bridge inside.
  - Expect the next release to touch our `useMultiFileAuthState` + `makeCacheableSignalKeyStore`
    wiring (`index.js:631`, `index.js:690`).
- **Security:** GHSA-qvv5-jq5g-4cgg (critical, crafted `protocolMessage` spoofing messages,
  history sync and app state) was fixed in rc12. **rc14 includes the fix.**
- **What rc10–rc14 gave us** (their notes; already in our build): LID↔PN mappings from more
  sources, proper acks, album sending, `@all` mentions, reachout timelock (error 463) and
  new-chat message caps, usernames, v2 newsletter endpoints, member labels, memory-leak and
  deadlock fixes.

**License risk:** `libsignal` is GPL-3.0 (its `package.json`; the rc11 notes say the Baileys team
plans to replace it). esbuild bundles it into `sidecar/sidecar.cjs`, which the plugin
distributes. This needs a licensing decision; it is not a code defect (see R17).

## 2. Capability map

Status: **used**, **partial** (used, but part of it is dropped or wrong), **unused**.

### 2.1 Events (`lib/Types/Events.d.ts`)

| Event | Status | Where | Note |
|---|---|---|---|
| `connection.update` (`:14`) | partial | `index.js:701-787` | Reads `connection`, `lastDisconnect` and `qr`. **Ignores `reachoutTimeLock`**, which Baileys emits on this same event when the account is restricted (`lib/Socket/messages-recv.js:159-181`). |
| `creds.update` (`:16`) | used | `index.js:693` | Saves the credentials and refreshes the identity (the LID arrives here). |
| `messaging-history.set` (`:18`) | partial | `index.js:931-953` | Chats, contacts and `lidPnMappings` are read. `messages` are dropped **on purpose** (§5 scope). |
| `messaging-history.status` (`:31`) | unused | — | Sync progress; the panel cannot say "syncing history". |
| `chats.upsert` / `chats.update` (`:43`, `:45`) | used | `index.js:877-878` | |
| `chats.delete` (`:48`) | unused | — | A deleted chat stays in the list. |
| `chats.lock` (`:159`) | unused | — | |
| `lid-mapping.update` (`:46`) | used | `index.js:919` | |
| `presence.update` (`:50`) | unused | — | Needs `presenceSubscribe`. |
| `contacts.upsert` / `contacts.update` (`:56-57`) | used | `index.js:903`, `index.js:907` | |
| `contacts.set` | **dead listener** | `index.js:904` | **Not in the v7 event map.** It never fires; contacts arrive through `messaging-history.set` and `contacts.upsert`. |
| `messages.upsert` (`:78`) | used | `index.js:790-818` | Every content type except control messages (`mensajes.js:44-45`). |
| `messages.update` (`:64`) | used | `index.js:823-837` | Edits, revokes and delivery status (`mensajes.js:470-494`). |
| `messages.delete` (`:58`) | unused | — | Bulk delete ("clear chat"). |
| `messages.media-update` (`:65`) | partial | `index.js:612` | Only through `reuploadRequest: sock.updateMediaMessage` when a download fails. |
| `messages.reaction` (`:84`) | unused | — | Reactions inside `messages.upsert` are dropped as control (`mensajes.js:44`). WAINBOX-54 C2. |
| `message-receipt.update` (`:88`) | used | `index.js:840-849` | Group delivery and read status of our sends. |
| `groups.upsert` / `groups.update` (`:89-90`) | used | `index.js:954-978` | |
| `group-participants.update` (`:92`) | used | `index.js:979-986` | |
| `group.join-request` (`:100`) | unused | — | |
| `group.member-tag.update` (`:110`) | unused | — | Member labels, new in rc10. |
| `blocklist.set` / `blocklist.update` (`:117`, `:120`) | unused | — | |
| `call` (`:125`) | unused | — | A customer's call to the line is invisible. A group call offer that arrives as a message is dropped (`mensajes.js:45`). |
| `labels.edit` / `labels.association` (`:126-127`) | unused | — | WhatsApp Business labels. |
| `newsletter.*`, `newsletter-participants.update`, `newsletter-settings.update` (`:132-153`) | unused, by design | `index.js:350-352` | Newsletters and broadcast are ignored at the socket (`shouldIgnoreJid`). |
| `message-capping.update` (`:157`) | unused | — | The new-chat message cap, emitted at `lib/Socket/messages-recv.js:190`. |
| `settings.update` (`:163`) | unused | — | |

### 2.2 Message types (receive) — `mensajes.js`

| Type | Status | Where |
|---|---|---|
| Text, extended text | used | `mensajes.js:260-264` |
| Image, video, audio/voice note, document, sticker, video note (`ptvMessage`) | used: downloaded up to `MEDIA_MAX_BYTES` | `mensajes.js:14-23`, `mensajes.js:363`, `index.js:610-615` |
| Ephemeral, view-once (v1/v2/v2ext), document-with-caption, edited, FutureProof wrappers | used: unwrapped | `mensajes.js:34-35`, `mensajes.js:241` |
| Button, list, template and interactive replies | used: as text | `mensajes.js:268-276` |
| Polls (create V1/V2/V3/V5) | partial: the question and options as text; **votes dropped** | `mensajes.js:282-311`, `mensajes.js:44` (`pollUpdateMessage`) |
| Location, live location, contact(s), event, group invite | used: as a bracketed line | `mensajes.js:319-345` |
| Quotes and mentions (`contextInfo`) | used | `mensajes.js:220-238`, `mensajes.js:348-359` |
| Reactions, pins, keep-in-chat, album container, protocol messages | dropped as control | `mensajes.js:44-45` |
| Undecryptable (CIPHERTEXT stub, `message: null`) | **dropped with no trace** | `mensajes.js:415` (`esDeControl` → `null`) |

About the CIPHERTEXT case: Baileys 7 already upserts the stub and asks the phone for the real
content by itself (placeholder resend, `lib/Socket/messages-recv.js:1299-1340`). When the content
comes back, it arrives as a normal `messages.upsert`. When it does not come back, the message is
lost with no row and no counter. This is the current shape of WAINBOX-43 (its text describes an
older "stored as empty" behaviour).

### 2.3 Sending — `envio.js`

| Capability | Status | Where |
|---|---|---|
| Text | used | `envio.js:112` |
| Document with caption | used | `envio.js:113-115` |
| Image / video / audio / voice note as native media | **unused**: any file goes as a document | `envio.js:113` |
| Quote (`quoted`), mentions, reactions, edit, delete, polls, location, contacts | unused | — (WAINBOX-54 C3/C5) |
| Disappearing-chat timer (`ephemeralExpiration`, `lib/Types/Message.d.ts:248`) | unused | — (prior review, item B) |
| Retry resend (`getMessage`) | partial: text only; a document cannot be rebuilt | `envio.js:175-182` |
| Retry counter that survives reconnects | used | `envio.js:197-220`, `index.js:629` |
| Number check before sending (`onWhatsApp`, `lib/Socket/chats.d.ts:118`) | unused | — |

### 2.4 Socket API by area (`lib/Socket/*.d.ts`)

| Area | Baileys API | Status | Where we use it |
|---|---|---|---|
| Connection and auth | `makeWASocket`, `useMultiFileAuthState`, `makeCacheableSignalKeyStore`, `fetchLatestBaileysVersion`, `Browsers.appropriate` | used | `index.js:631-639`, `index.js:690`, `index.js:361-378` |
| Pairing | QR (`qrTimeout`), `requestPairingCode` (`chats.d.ts:111`) | partial: QR only | `index.js:337`, `index.js:703-709` |
| Presence | `sendPresenceUpdate` / `presenceSubscribe` (`chats.d.ts:39-40`) | partial: only `markOnlineOnConnect: false` | `index.js:345` (WAINBOX-54 C4) |
| Receipts | `readMessages` / `sendReceipts` (`messages-send.d.ts:16-18`) | unused | WAINBOX-54 C6 |
| History | `fetchMessageHistory` (`messages-recv.d.ts:11`), `requestPlaceholderResend` (`:12`) | unused (Baileys calls the resend itself) | — |
| App state | `resyncAppState` (`chats.d.ts:64`) | used | `index.js:755` |
| Chat actions | `chatModify`, `star`, archive, pin, mute (`chats.d.ts:65`, `:75`) | unused | — |
| Contacts | `addOrEditContact` / `removeContact` (`chats.d.ts:67-68`) | unused | — |
| Profile | `profilePictureUrl`, `fetchStatus`, `updateProfile*`, `getBusinessProfile` (`chats.d.ts:41-51`, `:63`) | unused | — |
| Privacy | `fetchPrivacySettings`, `update*Privacy`, `updateDefaultDisappearingMode`, `fetchDisappearingDuration` (`chats.d.ts:34`, `:44`, `:53-62`) | unused | — |
| Blocklist | `fetchBlocklist`, `updateBlockStatus` (`chats.d.ts:42`, `:52`) | unused | — |
| Labels (Business) | `addLabel`, `addChatLabel`, `removeChatLabel`, `addMessageLabel`, `removeMessageLabel` (`chats.d.ts:70-74`) | unused | — |
| Quick replies (Business) | `addOrEditQuickReply` / `removeQuickReply` (`chats.d.ts:79-80`) | unused | — |
| Restrictions | `fetchAccountReachoutTimelock`, `fetchNewChatMessageCap` (`chats.d.ts:122-123`) | unused | — |
| Groups | `groupFetchAllParticipating` (`groups.d.ts:44`) | used | `index.js:721` |
| Groups (other) | `groupMetadata`, create, leave, subject, participants, invite, settings, join approval (`groups.d.ts:6-43`) | unused | — |
| Group metadata cache | `cachedGroupMetadata` socket option (read at `lib/Socket/messages-send.js:501`) | **unused**: every group send asks the server for metadata | prior review, item B |
| Communities | `community*` (`communities.d.ts:5-57`) | unused | — |
| Newsletters | `newsletter*` (`newsletter.d.ts:4-26`) | unused, ignored at the socket | `index.js:350-352` |
| Business catalog | `getCatalog`, `getCollections`, `product*`, `getOrderDetails`, `updateBussinesProfile` (`business.d.ts:6-21`) | unused | — |
| Calls | `call` event, `rejectCall` (`business.d.ts:24`), `createCallLink` (`chats.d.ts:18`) | unused | — |
| Member labels | `updateMemberLabel` (`messages-send.d.ts:34`) | unused | — |
| LID | `lid-mapping.update`, `remoteJidAlt`/`participantAlt` | used | `index.js:919`, `mensajes.js:115-132` |

## 3. Improvement backlog (ranked)

How to read it:

- **Value:** what the owner or a customer gains.
- **Effort:** S (≤ 1 day), M (2–4 days), L (≥ 1 week).
- **Risk:** what could break or what a customer would notice.
- **Tag:**
  - **new** — no ticket covers it yet;
  - **refines #N** — gives an existing ticket its technical shape;
  - **child of #N** — splits an existing ticket;
  - **owner decision** — changes what customers see, so the owner has to approve the
    behaviour itself, not only the ticket.

| Rank | Item | Value | Effort | Risk | Deps | Tag |
|---|---|---|---|---|---|---|
| R1 | **Account restriction awareness.** Read `reachoutTimeLock` from `connection.update`, listen to `message-capping.update`, and query `fetchAccountReachoutTimelock` / `fetchNewChatMessageCap` on open. Report a restricted line in the panel and `wa-scope doctor`, and reject queued sends with the stable code `cuenta-restringida` instead of a generic Baileys error. | High: a restricted business line today looks healthy while sends fail | M | Low (read-only signals) | — | new; related #34, #52 |
| R2 | **Undecryptable messages leave a trace.** Record a CIPHERTEXT stub as a pending row ("could not be read yet"), counted in `store`. Replace it when the placeholder resend arrives with the same id. After a timeout, show it on the board as unreadable, never as empty. | High: messages lost with no trace on a second line | M | Medium (touches ingest and the scope rules) | — | refines #43 |
| R3 | **`cachedGroupMetadata` from the store.** Serve group metadata (participants plus addressing mode) from `grupo_miembro` so every group send stops querying the server. Fall back to the network on a miss. | Medium-high: fewer IQs on lines with hundreds of groups, less rate-limit and ban exposure | S | Medium (stale members → a new member does not get the message; mitigated by `group-participants.update`, already listened) | — | new |
| R4 | **Missed-call notice.** Listen to `call`. A customer's call to the line becomes a case event ("missed call from X"), so it is not lost. Rejecting the call automatically (`rejectCall`) is **not** part of it. | Medium | S | Low | — | new |
| R5 | **Reply inside disappearing chats with the chat's timer.** Read the chat's ephemeral setting (`contextInfo.expiration` on incoming messages, or `fetchDisappearingDuration`) and send with the same `ephemeralExpiration`. | Medium: respects the customer's privacy choice; today our reply is permanent | S | Low (matches what the phone does) | — | new; owner decision (light) |
| R6 | **Number check before queueing a send to a new number.** `onWhatsApp` in the sidecar, exposed through the outbox. A number that is not on WhatsApp is rejected with a clear code. | Medium | S | Low | — | new |
| R7 | **History-sync observability and dead-code cleanup.** Listen to `messaging-history.status` (progress shown in the panel), drop the dead `contacts.set` listener (`index.js:904`), and handle `chats.delete`. | Low-medium: the "list is empty" and "still syncing" states stop looking the same | S | Low | — | new |
| R8 | **Send images, audio and voice notes as native media.** Route by mimetype in `contenidoDe` (`envio.js:110-116`): `image`, `video`, `audio` with `ptt` for voice notes. Same approval and hash rules as documents. | Medium: a photo arrives as a photo, not as a file | M | Low | #68 (send files) | new; related #68 |
| R9 | **Owner and customer reactions as signals** (C2). Read `messages.reaction` and the dropped `reactionMessage`: a 👍 from the owner on a held draft = approve; a customer reaction is noted on the case. | Medium | S | Low (read-only) | — | child of #54; owner decision |
| R10 | **Mark read when a case is answered** (C6). `readMessages` on the case's messages after the reply goes out. | Medium | S | Medium: customers see blue ticks | — | child of #54; owner decision |
| R11 | **Typing indicator while the agent drafts** (C4). `sendPresenceUpdate('composing')` then `'paused'`. | Low-medium | S | Medium: shows the line online | — | child of #54; owner decision |
| R12 | **Quote the customer's message in the reply** (C3). `quoted` on `sendMessage`, from the case's source message. | Medium: clarity in busy groups | S | Low | — | child of #54; owner decision |
| R13 | **Backfill a chat when it is authorized.** `fetchMessageHistory` for the last N messages of a newly authorized chat only, so the agent sees context from before the authorization. | Medium | M | Medium (privacy: must go through the scope gate) | — | new; owner decision |
| R14 | **Mirror case state as WhatsApp Business labels.** `addChatLabel` / `labels.*` so the owner sees "pending" or "answered" in his phone's chat list. | Medium on business lines | M | Medium (writes to the owner's app state) | — | new; owner decision |
| R15 | **Poll vote aggregation.** Keep the poll creation's `messageSecret` and decrypt `pollUpdateMessage` votes (`getAggregateVotesInPollMessage`); show the tally on the case. | Low | M | Low | — | new |
| R16 | **Edit or delete a message the line sent** (C5). `sendMessage({ edit })` / `({ delete })` within WhatsApp's window, from the CLI, owner-approved. | Low-medium | M | High: customer-visible, time-limited | — | child of #54; owner decision |
| R17 | **Licensing review of the bundled `libsignal` (GPL-3.0).** Decide whether distributing `sidecar.cjs` is acceptable, or wait for the Rust replacement. | Compliance | S (research) | — | Baileys roadmap | new |
| R18 | **Move the auth state off `useMultiFileAuthState`** once Baileys releases the SQLite store from `develop`. Includes a tested migration with no relink. | Medium: fewer files, atomic writes | L | High: a bad migration forces a relink | the next Baileys release | new; blocked upstream |

**Not recommended for this plugin:** newsletters, communities, business catalog and products,
privacy and profile setters, call links, and quick replies. None of them serves the inbox and
case flow. Newsletters are ignored at the socket on purpose (`index.js:340-342`).

## 4. Existing tickets this touches

| Ticket | Relation |
|---|---|
| WAINBOX-54 — Baileys features C2–C6 | R9–R12 and R16 are its five items, one child each, so the owner can approve them one by one. |
| WAINBOX-43 — Undecryptable messages | R2 gives it its current technical shape: today the stub is dropped (`mensajes.js:415`), not stored empty. |
| WAINBOX-34 — Connected but deaf | R1 adds another "healthy but not working" state (restriction); R7's history status helps tell "syncing" from "deaf". |
| WAINBOX-52 — Line-down alert elsewhere | R1's restriction alert should use the same alternative channel. |
| WAINBOX-68 — Send files | R8 extends it to native media. |

## 5. Plane items created (approved by the lead on 2026-11-10)

All items are in Backlog and use the full refined body, written with the `plane-refinement`
skill. The project has no work item types, so the epic is a parent item titled `[Epic] …`.
Four labels were created: `area:sidecar`, `area:send`, `area:panel`, `owner-decision`.

| Backlog row | Plane item |
|---|---|
| Epic (C2–C6) | WAINBOX-54, retitled and given an epic body; its children are WAINBOX-70 to WAINBOX-74 |
| R9 C2 reactions | WAINBOX-70 |
| R10 C6 mark read | WAINBOX-71 |
| R11 C4 typing | WAINBOX-72 |
| R12 C3 quote | WAINBOX-73 |
| R16 C5 edit/delete | WAINBOX-74 |
| R1 restricted account | WAINBOX-75 (related to WAINBOX-34 and WAINBOX-52) |
| R3 group metadata cache | WAINBOX-76 |
| R4 missed call | WAINBOX-77 |
| R5 disappearing chats | WAINBOX-78 |
| R6 number check | WAINBOX-79 |
| R7 history sync | WAINBOX-80 |
| R8 native media | WAINBOX-81 (related to WAINBOX-68) |
| R13 chat backfill | WAINBOX-82 |
| R14 Business labels | WAINBOX-83 |
| R15 polls | WAINBOX-84 |
| R17 libsignal spike | WAINBOX-85 |
| R18 auth state | WAINBOX-86 |
| R2 undecryptable | WAINBOX-43, body rewritten |

## 6. How this was checked

- Version: `npm view @whiskeysockets/baileys dist-tags time`; `gh api .../releases`;
  `gh api .../compare/v7.0.0-rc14...master` and `.../compare/master...develop`;
  `gh api .../security-advisories`.
- Events: `lib/Types/Events.d.ts` (the `BaileysEventMap`), cross-checked against every
  `ev.emit(...)` in `lib/`.
- API: method declarations in `lib/Socket/*.d.ts`; behaviour read in
  `lib/Socket/messages-recv.js`, `lib/Socket/messages-send.js` and
  `lib/Utils/validate-connection.js`.
- Plugin: every `sock.*` and `sock.ev.on(...)` call in `sidecar/src/`.
- No live account was used and no message was sent.

## 7. Phase 2 — case handling and customer care

Research only, read on 2026-11-10. Two inputs: (a) the Baileys capabilities §2 lists as unused
but §3 did not rank, and (b) gaps in the plugin's case workflow. Items already open in WAINBOX
are skipped; when an item extends one, the ticket is named.

References added in this section:

- `wa-scope:N` is `bin/wa-scope` (the case schema lives there, `wa-scope:517-632`, not in
  `sidecar/src/almacen.js`, which is the capture store).
- `activity.html:N`, `acciones.mjs:N`, `bin/wa_jev.py:N` are plugin files.
- `lib/...:N` is the installed Baileys package, as in §1–§3.

### 7.1 What exists today (short)

| Area | Exists | Missing |
|---|---|---|
| SLA | `sla_first_reply_minutes`=15 (`wa-scope:2603`); Reports measure first reply, resolution and SLA pass/fail (`wa-scope:10509-10529`); WhatsApp alert when a case passes the goal (`avisa_meta_vencida`, `wa-scope:12667`) | Time in column; an alert for a case stuck in `decision`/`trabajo`/`listo`. The SLA stops at the first outgoing message, so the acknowledgement counts as the reply. Cards show `updated_at`, not time in column (`activity.html:3771`). |
| Follow-ups | `caso recordar` reminders and snooze (`wa-scope:4117`, `tick_recordatorios` `:4200`); automatic follow-up with four settings (`wa-scope:2608-2611`, `tick_seguimiento` `:4852`) | Reminder, snooze and priority are CLI-only: `CASO_ACCION` has none of them (`acciones.mjs:28-47`). |
| History | `caso.relacionado` (`wa-scope:551`); the case file carries up to 5 earlier cases of the **same chat** from 14 days (`casos_de_memoria`, `wa-scope:16455`) | Nothing groups cases by person (phone, LID, a group sender's DM). When a chat moves to its LID only `chat_scope` moves (`mueve_entrada`, `wa-scope:9286`); no step moves the old `caso` rows. No customer timeline on the board. |
| Templates | Fixed `ack_text`/`greeting_text` (`wa-scope:2580-2582`), per-chat override, `tone`, `instructions` | No store of reusable replies. Searched template/plantilla/canned/snippet/quick reply: only unrelated skill and harness templates match. |
| Handoff | `escalar` proposals and the money/credential/commitment floor stop in `decision` with a WhatsApp notice the owner can answer (`wa-scope:12610-12625`); chat modes off/observar/borrador/responder (`wa-scope:82`) | The customer asking for a person is not detected (no such Jev question, `bin/wa_jev.py:238-260`). No "a human took over" state: an owner reply from the phone only quiets the ack (`linea_escribio`, `wa-scope:7639`); the agent keeps drafting on the open case. |
| Satisfaction | Nothing; closing on "thanks" (`wa-scope:7378`) is the closest | Everything. |
| Out of hours | Per-chat `hours` ('L-V 08:00-18:00') and `timezone` are **stored but read by nothing** (`wa-scope:2031`, `:2321`); quiet hours only silence owner notices and follow-ups (`wa-scope:2620`, `:13816`) | Business hours, away reply, pausing the SLA clock. The ack is deliberately timeless and the fixed floor checks it (`wa-scope:2576-2579`, `scripts/check-casos`). |
| Priority | Case priority urgent…none (`wa-scope:183`), chip and `.urgente` style on cards (`activity.html:3467`, `:3783`); Jev `urgency_pressure` flag | No priority per chat or number; it starts as `none` at ingest (`wa-scope:7362`). The board orders open cases by `updated_at` only (`wa-scope:10229-10230`). No panel action to set it. |

Baileys facts this section relies on, checked in the installed 7.0.0-rc14:

- **Quick replies are write-only.** `addOrEditQuickReply` / `removeQuickReply` exist
  (`lib/Socket/chats.d.ts:79-80`, patch built at `lib/Utils/chat-utils.js:562-573`), but
  `processSyncAction` (`lib/Utils/chat-utils.js:660-850`) has no `quickReplyAction` branch.
  The owner's existing quick replies on the phone cannot be read, only overwritten.
- **Catalog orders arrive empty.** `textoDe` falls back to `descripcionDe`
  (`sidecar/src/mensajes.js:278`), which has no branch for `orderMessage` or
  `productMessage` and returns `''` (`mensajes.js:306-345`). A cart sent from a Business
  catalog becomes a row with no body. `getOrderDetails(orderId, token)` (`lib/Socket/business.d.ts:6`)
  can fetch the line items.
- **Business hours are readable.** `getBusinessProfile(jid)` parses `business_hours`
  (`lib/Socket/chats.js:363-365`), so a Business line's own hours, set in the WhatsApp Business
  app, can seed the out-of-hours rule.
- **`rejectCall(callId, callFrom)`** sends a `reject` stanza (`lib/Socket/messages-recv.js:366-386`);
  **`createCallLink('audio'|'video')`** returns a token (`lib/Socket/chats.js:585-602`).
- **`chatModify`** supports archive, pin, mute, star and markRead (`lib/Types/Chat.d.ts:63-103`);
  archive needs `lastMessages` (the chat's last key and timestamp), which the store has.
- **Location and contact cards are already readable** as text with coordinates and the first
  vCard phone (`mensajes.js:287-300`, `:319-334`). The gap is structure, not loss.
- **Presence:** `presenceSubscribe` exists (`chats.d.ts:40`). That WhatsApp only delivers a
  contact's presence while our client is "available" (we connect with `markOnlineOnConnect:
  false`, `index.js:345`) is **not verified here**; K15 starts with that check.

### 7.2 Ranked backlog

Same columns as §3, plus **Ban risk**: how much the change raises the chance that WhatsApp
restricts or bans the line. Unsolicited or automated outbound messages are what raises it;
reading, and replying once inside a conversation the customer started, do not.

| Rank | Item | Value | Effort | Risk | Ban risk | Tag |
|---|---|---|---|---|---|---|
| K1 | **A human took over / the customer asks for a person.** (i) Jev gets a question "the customer asks to talk to a person"; a yes escalates the case to `decision` with the usual notice. (ii) When the owner writes from the phone in a chat with an open case, the case gets a `humano` hold for N hours (setting): the agent stops drafting, the ack and follow-up stay quiet, the board shows "you are handling this". | High: the agent stops talking over the owner, and a frustrated customer reaches him | M | Low (the floor already holds sends; this only holds more) | None | new; owner decision (the hold length) |
| K2 | **Out-of-hours reply.** Read the per-chat `hours`/`timezone` that are already stored, with a line default from the Business profile's own hours (`getBusinessProfile`). Outside hours: the ack becomes an away text that names when the line opens again, the SLA clock pauses, and the case waits for opening time unless Jev flags urgency. | High: customers know when they will hear back; the SLA stops counting nights | M | Medium: the fixed floor requires a timeless ack today, so the away text needs its own floor check | Low: one reply per case, inside a conversation the customer opened | new; owner decision (away text) |
| K3 | **Catalog orders and product questions arrive with content.** Render `orderMessage` as `[order] N items, total` and `productMessage` as `[product] name, price`; optionally fetch the lines with `getOrderDetails`. | High on lines that sell from a catalog (today the order is an empty row); none elsewhere | S (render) / M (order lines) | Low (read-only) | None | new; related #43, #62 |
| K4 | **Customer history by person, not by chat.** Match earlier cases by phone and LID (the `lidPnMappings` the store already keeps), move `caso` rows when a chat moves to its LID, and show a customer timeline in the case detail. A group sender's DM cases are shown only to the owner, never in the group's case file. | High: the agent stops asking what the customer already told us | M | Medium: privacy between a group and a DM must go through the scope gate | None | new |
| K5 | **Priority by customer.** A `priority` per chat and per number (Settings), copied to the case at ingest; open cases sorted by priority, then age; a priority action on the card; an optional tighter SLA per priority. | Medium-high | S–M | Low | None | new |
| K6 | **Time in column and stuck alerts.** Show time in the current column on the card (`stage_at` is already sent), alert the owner when a case sits in `decision`, `trabajo` or `listo` beyond a setting, and add a second SLA figure, "first real answer", that ignores the ack. | Medium-high: what is stuck becomes visible | S | Low; alert noise, so stuck alerts go into one notice per tick | None | new; related #24 (digest) |
| K7 | **Remind, snooze and priority from the panel.** Add them to `CASO_ACCION` (`acciones.mjs:28-47`); the CLI commands already exist. | Medium | S | Low | None | new; pairs with K5 |
| K8 | **Spam: blocked numbers never open cases; block from a case.** Read `fetchBlocklist` on open and listen to `blocklist.set`/`blocklist.update`, so a blocked number never wakes the agent. An owner-only "block as spam" action calls `updateBlockStatus` after a confirmation. | Medium: no agent cost on spam | S (read) + S (action) | Medium for the action: a wrong block silences a customer | Lowers it (fewer replies to spam) | new; owner decision (the action) |
| K9 | **Reply templates.** A plugin-side store of approved snippets (hours, address, payment steps), editable in Settings; the agent cites a template id in its proposal so the owner sees reused text. Optional, later: mirror them to the phone's Business quick replies (write-only, see 7.1, so the plugin must own the list). | Medium: consistent answers, faster drafts | M | Medium: a stale price in a template; the money floor still applies to every send | None | new; owner decision (mirror to phone) |
| K10 | **Answer a call with a text.** On top of WAINBOX-77: optionally `rejectCall` and send one short text ("we answer here by chat"), or a call link from `createCallLink` when the owner wants to call back at a set time. | Medium on lines that get calls | S after #77 | Medium: rejecting is customer-visible | Medium: an automatic message to every caller, including spam callers; cap one per number per day | child of #77; owner decision |
| K11 | **Satisfaction check after close.** One question after a case closes as attended ("Was this solved? 1–5"), as text parsed by the agent (a poll needs WAINBOX-84's vote decryption). Stored in `caso_evento`, shown in Stats. | Medium | M | Low | **Medium-high**: an unsolicited message after the conversation ended is what gets reported. Only inside 24 h of the customer's last message, once per customer per 30 days, opt-in per chat | new; owner decision |
| K12 | **Tidy the owner's phone on close.** Archive the chat (`chatModify` archive) when its case closes, star the message that carries the final answer, optional mute for noisy groups. A new customer message unarchives it per the phone's "Keep chats archived" setting. | Medium for owners who live in the phone | M | Medium: writes to the owner's app state; surprising if it is not asked for | Low (normal app-state traffic); rate-limit bulk closes | new; owner decision; related #83 |
| K13 | **Who the customer is.** Profile picture and, for Business contacts, name, category and description (`getBusinessProfile`, `profilePictureUrl`, `fetchStatus`) on the case, fetched on open and cached with a TTL, never stored as files. | Low-medium | S | Low | Low if cached; one query per contact per day at most | new |
| K14 | **Structured location and contact cards.** A map link on the case for a location; for a shared contact, "authorize this number" so a referral becomes a chat in one step. | Low | S | Low | None | new |
| K15 | **Customer presence on the case** ("online", "typing"). Starts with a spike: does presence arrive while the line stays unavailable? If it needs the line online, it conflicts with WAINBOX-72's decision. | Low | S (spike) | Medium: may require showing the line online | Low-medium: subscribing to many contacts' presence is a bot pattern | new; owner decision |

**Not recommended:** browsing or sending the catalog (`getCatalog`, `getCollections`,
`product*`) and `updateBussinesProfile`; the agent quoting catalog prices would cross the money
floor on every reply. Call links on their own (only inside K10). Reading the phone's quick
replies is not possible (7.1).

**Suggested order:** K1, K2 and K3 first (largest customer-visible gains, two need owner
wording); K5–K7 together as one board slice; K4 after a short privacy note; K11 last and
only with the owner's explicit opt-in because of its ban risk.

## 8. Phase 2 Plane items (approved by the owner on 2026-11-11)

The owner approved all fifteen items. Each one was written with the `plane-refinement` skill and
says where to implement it: file:line anchors, helpers to reuse, the test files to extend, and
the `npm run check` / `WA_INBOX_SOLO=… npm run shots` commands that prove it. Every owner
decision is an Open question with its default. All items are in Backlog and use the existing
labels (`area:*`, `owner-decision`); no taxonomy or project feature was changed. The project still
has no cycles and no modules, so the estimate is a body section and module/cycle are N/A.

| Row | Plane item | Parent | Priority | Estimate | Relations |
|---|---|---|---|---|---|
| Epic | WAINBOX-91 | — | medium | sum | 14 children; related WAINBOX-101 |
| K1 Human takeover | WAINBOX-92 | WAINBOX-91 | high | M (5) | — |
| K2 Out-of-hours reply | WAINBOX-93 | WAINBOX-91 | medium | M (6) | related WAINBOX-97 |
| K3 Catalog orders | WAINBOX-94 | WAINBOX-91 | high | S (1) | related WAINBOX-43, WAINBOX-62 |
| K4 Customer history | WAINBOX-95 | WAINBOX-91 | medium | S (4) | — |
| K5 Customer priority | WAINBOX-96 | WAINBOX-91 | medium | S (3) | related WAINBOX-98 |
| K6 Stuck cases | WAINBOX-97 | WAINBOX-91 | medium | S (2) | related WAINBOX-24, WAINBOX-93 |
| K7 Case actions | WAINBOX-98 | WAINBOX-91 | medium | S (2) | related WAINBOX-96 |
| K8 Blocklist | WAINBOX-99 | WAINBOX-91 | medium | M (5) | blocks WAINBOX-103 |
| K9 Reply templates | WAINBOX-100 | WAINBOX-91 | medium | S (4) | — |
| K10 Call reply | WAINBOX-101 | WAINBOX-77 | medium | S (3) | blocked by WAINBOX-77; related WAINBOX-91 |
| K11 Satisfaction check | WAINBOX-102 | WAINBOX-91 | low | M (6) | related WAINBOX-84 |
| K12 Tidy on close | WAINBOX-103 | WAINBOX-91 | medium | M (5) | blocked by WAINBOX-99; related WAINBOX-83 |
| K13 Customer profile | WAINBOX-104 | WAINBOX-91 | low | M (5) | — |
| K14 Location and contact cards | WAINBOX-105 | WAINBOX-91 | low | S (2) | — |
| K15 Spike: presence | WAINBOX-106 | WAINBOX-91 | low | S (2) | related WAINBOX-72 |

Changes from §7 found while refining:

- **K8 adds the first sidecar command table (`orden`).** Today the only way to make the socket
  act is the `envio` send queue, whose drainer only calls `sendMessage`
  (`sidecar/src/envio.js:129`, `sidecar/src/index.js:1003-1024`). K12 reuses that table, so it is
  blocked by K8.
- **Baileys never emits `blocklist.set`** (declared at `lib/Types/Events.d.ts:117`, emitted
  nowhere). K8 reads the list with `fetchBlocklist()` on open and keeps it in step with
  `blocklist.update`.
- **Sizes by the rubric:** K4 and K9 score 4 (top of S), not the M that §7 guessed.
- **Priority** is justified at the end of each item's Estimate section.

**Lint (`plane-refinement --lint`, read back from Plane):** 16 items × 16 rows = 256 rows,
all PASS (module/cycle noted as N/A inside R14), 0 GAP. The first run found real gaps, and they
were fixed before this table:

- three FRs without a test case (WAINBOX-93 FR-7, WAINBOX-101 FR-6, WAINBOX-106 D-4);
- dependency lines that named the epic without its identifier;
- a title with internal jargon (WAINBOX-95).

During the batch, the Orca runtime dropped the connection three times. The batch could resume,
and before each retry the list was read back, so no duplicate was created.
