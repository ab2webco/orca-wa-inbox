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
