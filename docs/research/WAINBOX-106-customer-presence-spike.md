# WAINBOX-106: Can a case show the customer as "online" while the line stays offline?

- Ticket: WAINBOX-106 (Spike, S, one-day time box). Parent: WAINBOX-91. Related: WAINBOX-72.
- Source: WAINBOX-69 §7, K15 (`docs/research/wainbox-69-baileys-audit.md:288-290`, `:314`).
- Date: 2026-11-11
- Code examined: `main` at `f559478`; `@whiskeysockets/baileys` **7.0.0-rc14**, the exact pin in
  `scripts/deps.package.json:7`. The tarball came from `npm pack` and was read without running
  anything. Every line cited below is from that tarball.
- **Approver: pending (the owner).** Q1 ("may the line show as online?") is an owner decision.
  This spike recommends; it does not decide.
- **Live measurement: not run.** See §4. This document is a source and documentation study.
  TC-1 and TC-2 are still open and are written out in §5 so they can be run in under an hour.

## 1. Short answer

**Recommendation: drop.** Do not open a build item now (TC-5: no follow-up item).

Reasons:

1. **Our code does not decide this. WhatsApp's server does.** Baileys emits `presence.update`
   for every `presence` or `chatstate` node the server sends. It does not check whether we are
   online (§2.1). So the question can't be settled by reading code, and nothing public states
   that the server delivers presence to a client that is `unavailable`.
2. **The one rule WhatsApp documents is reciprocal.** *"If you don't share your last seen or
   online, you can't see other users' last seen or online."* ([WhatsApp Help][wa-privacy]).
   So showing a customer's "online" status depends on the line sharing its own online status
   in principle. That is exactly what Q1's default rules out.
3. **Going `available` has four costs we can see in the code** (§3). The worst for a support
   line is that the line's phone stops getting push notifications while the client is
   online (`README.md:801`).
4. **Coverage would be partial anyway.** Customers who set "last seen and online" to
   *Nobody* send no presence at all. Under *Everyone*, only people they have "called and
   messaged before, or … saved as a contact" can see it ([WhatsApp Help][wa-privacy]).
   Subscribing to every open case's contact is the bot pattern the audit flags (K15 risk
   column, `wainbox-69-baileys-audit.md:314`).

**When to reopen:** run TC-1 (§5) on a test line. If it shows `composing` and `available`
arriving while the line is `unavailable` and keeps its default privacy, reopen K15 as
"build behind a setting", with no change to the line's own presence. If it doesn't, the
answer is final under Q1's default.

## 2. What the code shows

### 2.1 The receive path has no online gate

- `presenceSubscribe(toJid)` sends `<presence type="subscribe" to=…>`. For user JIDs it attaches a
  `tctoken` when one is stored (`lib/Socket/chats.js:645-661`).
- Incoming `presence` **and** `chatstate` nodes both go to one handler
  (`lib/Socket/chats.js:1031-1032`).
- `handlePresenceUpdate` (`lib/Socket/chats.js:662-693`) does this:
  - `presence` node → `lastKnownPresence: 'available' | 'unavailable'`, plus `lastSeen` (unless
    `last="deny"`) and `groupOnlineCount`;
  - `chatstate` node → `composing`, `recording` (`composing` with `media="audio"`), and
    `paused`, which is **reported as `available`**;
  - then `ev.emit('presence.update', …)`.
  It never reads our own presence state. Our presence state only feeds `sendActiveReceipts`
  (§3), and receiving does not use that flag.
- `PresenceData` = `{ lastKnownPresence, lastSeen?, groupOnlineCount? }`
  (`lib/Types/Chat.d.ts:20-24`). There is no timestamp. The README says presence expires after
  about 10 s (`README.md:793`), so a "typing" badge would need its own timeout.

**Conclusion:** if WhatsApp's server sends the nodes, Baileys delivers them. Whether it sends
them to an `unavailable` client is a server-side policy that nothing in the package documents.

### 2.2 The subscription may need a tctoken

`buildTcTokenFromJid` (`lib/Utils/tc-token-utils.js:99-124`) attaches the contact's stored
privacy token only if one exists and has not expired. The window is a rolling ~28 days:
`TC_TOKEN_BUCKET_DURATION` 7 days × 4 buckets (`:23-24`). If there is none, the subscribe goes
out bare. This matches WhatsApp's "only those you've messaged before" rule. *Inference, not
verified:* a subscription to a customer the line has not talked to in about four weeks may
return nothing. Cases are usually recent, so this matters less, but TC-1 should test it.

### 2.3 Our line today

- We connect with `markOnlineOnConnect: false` (`sidecar/src/index.js:345`). On `open`, Baileys
  sends `unavailable` (`lib/Socket/chats.js:1065`).
- The repo has no `presenceSubscribe` or `presence.update` anywhere (grep on `sidecar/src`).
  The audit already lists the event as unused (`wainbox-69-baileys-audit.md:71`).

## 3. Side effects of `sendPresenceUpdate('available')` (from the code and README)

| # | Effect | Source | Matters because |
|---|--------|--------|-----------------|
| S1 | Our `connection.update` emits `isOnline: true` | `lib/Socket/chats.js:611` | harmless by itself |
| S2 | Baileys calls `sendUnifiedSession()` | `lib/Socket/chats.js:612-614` | extra session signal to WhatsApp; effect undocumented |
| S3 | Delivery receipts switch from `inactive` to normal | `lib/Socket/messages-recv.js:1413-1415`, `:1662-1665` | the customer's ticks change to "delivered to an active client". WAINBOX-72 already weighs this |
| S4 | The line's phone stops getting push notifications while a desktop client is active | `README.md:279-282`, `README.md:801` | an agent who relies on the phone misses new chats |
| S5 | Customers who may see the line's online status see it as "online" | `WAPresence` docstring, `lib/Types/Chat.d.ts:16-17`; [WhatsApp Help][wa-privacy] | Q1's default: not acceptable |
| S6 | It lasts only ~10 s, so staying online needs a repeating timer | `README.md:793` | S3–S5 then last for the whole session, not one moment |

Read receipts (blue ticks) are separate. They come from `readMessages` and the line's
read-receipt privacy, not from presence. The code shows no direct read-receipt effect.

## 4. Why no live measurement

The ticket asks for TC-1/TC-2 on a test line with two phones. This dispatch ran on a host with
no paired test line and no phones. It was briefed as research only, with one doc and no code.
So, per the DoD, the measurements stay **not observed**, and this doc does not state them as fact.
The recommendation does not depend on them under Q1's default: if presence needs `available`,
the answer is drop (ticket Q1). If it doesn't, §1 says when to reopen.

## 5. TC-1 / TC-2 procedure for whoever has the test line

A throwaway script **outside the plugin tree**, not committed. Use fake test numbers only, for
example the test contact `+57 300 000 0000`. Never use a customer chat.

1. Connect a **test** line with `markOnlineOnConnect: false`. Log every `presence.update` and
   every raw `CB:presence` / `CB:chatstate` node with a timestamp.
2. Make sure the test line and the test contact have messaged each other in the last 28 days
   (tctoken present, §2.2). Repeat once with a contact that has never messaged the line.
3. Run `presenceSubscribe(testContactJid)`, then re-subscribe every ~60 s. The re-subscribe
   interval is an assumption; record what was used.
4. **TC-1 (unavailable):** on the contact's phone, open the chat, type, stop, then close the app.
   Record which of `available` / `composing` / `paused→available` / `unavailable` arrive.
5. Run the same with the line's "last seen and online" privacy set to *Nobody*. This tests the
   reciprocity rule directly.
6. **TC-2 (available):** `sendPresenceUpdate('available')` on a 10 s timer, then repeat step 4.
   On the phones, note S3 (ticks), S4 (the line phone's notifications for a new message) and S5
   (the contact sees "online").
7. Send `unavailable` at the end (ticket risk) and confirm notifications come back.
8. TC-4: if neither state yields events, record "none" and keep the recommendation as drop.

Write the raw event log (fake numbers only) into a short follow-up section here.

## 6. Note on the deliverable location

The ticket says to append the write-up to `docs/research/wainbox-69-baileys-audit.md`. The lead's
brief limited this dispatch to one new file under `docs/research/`, so it lives here. A one-line
pointer from the audit's K15 row can be added when the PR is reviewed.

## Sources

- Baileys 7.0.0-rc14 package (npm tarball, read only): `lib/Socket/chats.js`,
  `lib/Socket/messages-recv.js`, `lib/Types/Chat.d.ts`, `lib/Utils/tc-token-utils.js`, `README.md`,
  at the lines cited above.
- This repo: `sidecar/src/index.js:345`, `scripts/deps.package.json:7`,
  `docs/research/wainbox-69-baileys-audit.md:71,130,178,288-290,314`.
- [WhatsApp Help Center, "How to change your privacy settings"][wa-privacy]. The last seen /
  online audiences and the reciprocity rule.
- [Baileys docs (Mintlify), Presence][mintlify-presence]. `presenceSubscribe` is needed before
  `presence.update` fires. It says nothing about the receiver's own presence.
- [WhiskeySockets/Baileys issue #2271][gh-2271]. A v7 RC config with `markOnlineOnConnect: false`.
  No presence finding; listed only as the closest public report found. Public searches found
  no report that confirms or denies delivery while `unavailable`.

[wa-privacy]: https://faq.whatsapp.com/en/android/23225461
[mintlify-presence]: https://www.mintlify.com/whiskeysockets/Baileys/chats/presence
[gh-2271]: https://github.com/WhiskeySockets/Baileys/issues/2271
