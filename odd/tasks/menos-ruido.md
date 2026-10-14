# Less noise, less waste (data review 2026-10-13)

## Objective

A read-only review of the owner's data (2026-10-01 to 10-13: 152 cases, 729 agent runs,
395 owner notices) found where the plugin interrupts the owner or spends work for nothing.
The owner approved applying the six fixes below on 2026-10-13 ("Si dale"). The seventh
(`markOnlineOnConnect: false`) went to feat/baileys-mensajes as B1.

## Scope

- M1 Digest of finished agents: 89% of owner notices were "finished". Default window
  60 minutes and an "end of day" option, instead of 15 minutes.
- M2 Commitment rule holds only real promises (the agent committing to do or deliver
  something by a time), not any mention of a date. It held 33 of 47 replies.
- M3 Trivial client messages ("gracias", "ok", a thumbs up) do not launch an agent.
- M4 A held progress message is rewritten instead of dropped (14 of 56 held, all
  cancelled).
- M5 Retention for the text tables of scope.db (today it grows forever).
- M6 A failed owner notice is retried on the line it belongs to.

Out of scope: the Informes redesign (not approved yet).

## Checklist

- [ ] M1 Finished-agent digest: 60-minute default, end-of-day option.
- [x] M2 Commitment rule only for real promises: a date, day or time counts with a promise
  verb, as a stated deadline (PLAZO) or as a sentence that is only the date; briefs keep
  any date. Jev's question says a past date is not a promise. Table RED 50/57, GREEN
  57/57; the 14 held progress messages and 3 held replies in the owner's data no longer
  match the fixed rule (read-only replay).
- [x] M3 Trivial messages do not launch an agent: with Jev on, Jev already decides
  (`jev_skip`); without a Jev verdict a burst that is only a thank-you or emojis, with no
  attachment and no question mark, closes with the new `cortesia` rule (board text in
  es/en/pt). "ok", "si", "dale", "listo" still reach the agent. Owner data: no short
  pleasantry case reached an agent, so this guards the Jev-off path. Subset RED 0/6 +
  label missing, GREEN 14/14.
- [x] M4 Held progress message rewritten, not dropped: the rewrite-once hint already existed
  (avisos-retenidos A3) and the owner's data shows agents rewrote; what was lost is the
  case where the first message and its rewrite were both held and the client got nothing
  (one live case: six holds). Now the line's fixed acknowledgement goes out once instead,
  also in `model`; nothing changes when something already reached the client. Subset RED
  84/86, GREEN 86/86.
- [x] M5 scope.db retention: once a day each line's tick empties the text of what is closed
  and older than that line's `capture_days` (case summary and reply, notices, updates,
  transcripts, Jev verdicts, agent briefs and reports); rows stay for the reports, open
  work is never touched. Same knob as the capture store, no new setting. RED 3/5, GREEN 5/5.
- [x] M6 Failed notice retried on its own line: the 15 `send-wrong-line` failures in the
  owner's data all predate linea-viva V6 (last on 2026-10-10 08:02; since then 20 notices
  left correctly through the other line). What remained: a `send-wrong-line` was final.
  Now it waits like an unauthorized chat, each tick picks the line again, and it goes out
  through the right line once the owner allows it there. V6 section RED 15/17, GREEN 17/17.

## Acceptance criteria

Each item has a test observed RED then GREEN; no change to what clients receive except
M4 (a rewritten progress message instead of none); the release check set is green;
screens touched by M1 are photographed (reduced set).

## Checks

`scripts/check-casos`, `scripts/check-clis`, `scripts/check-lid`, the node suites
(`panels`, `worker`, `almacen`, `envio`, `manifest`, `resolver`, `userdata`,
`sidecar-*`).
