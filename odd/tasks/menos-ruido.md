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
- [ ] M3 Trivial messages do not launch an agent.
- [ ] M4 Held progress message rewritten, not dropped.
- [ ] M5 scope.db retention.
- [ ] M6 Failed notice retried on its own line.

## Acceptance criteria

Each item has a test observed RED then GREEN; no change to what clients receive except
M4 (a rewritten progress message instead of none); the release check set is green;
screens touched by M1 are photographed (reduced set).

## Checks

`scripts/check-casos`, `scripts/check-clis`, `scripts/check-lid`, the node suites
(`panels`, `worker`, `almacen`, `envio`, `manifest`, `resolver`, `userdata`,
`sidecar-*`).
