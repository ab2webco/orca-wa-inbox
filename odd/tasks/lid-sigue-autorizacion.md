# The authorization follows a direct chat that WhatsApp moved to its LID

## Objective

WhatsApp moves 1:1 conversations from `<phone>@s.whatsapp.net` to `<digits>@lid` (and
sometimes back). The owner's authorization (`chat_scope` and the panel's `scope[jid]`, keyed
by `(account, chat_jid)`) stayed on the old form while new messages arrived under the other
one, so an authorized chat silently stopped being handled (seen on a partner's install: about
12 days unnoticed). The plugin already stores the verified LID-phone pairs per line
(`lid_telefono`, odd/tasks/lid-telefono.md) but only used them to show the phone.

## Decision (owner, 2026-10-05)

Automatic, with a notice. When a DIRECT chat authorized under one form has a verified pair in
`lid_telefono` FOR THE SAME LINE and the conversation now lives under the other form, the
authorization follows to the current jid by itself and the owner gets ONE WhatsApp notice.
Groups never migrate. A pair is never inferred from digits or names: only a `lid_telefono`
row of that account.

## Scope

1. `wa-scope` (ingest, so sync and tick too), once per run: move the whole entry (every
   `chat_scope` column, in the database and in the panel scope) to the current jid, with an
   audit row (`lid_migracion`: from, to, account, at, origin). Idempotent; one automatic move
   per pair, so a flip-flop never ping-pongs. Both forms authorized: no merge, a conflict.
2. Messages of the gap: inside `case_window_hours` they are ingested normally; older ones are
   not answered automatically (a per-chat ingest baseline), and the notice says how many and
   since when. Nothing is sent to the contact by the migration.
3. One notice per migration through the approval-number queue (`aviso`), ES/EN/PT, chat name
   on one line, no credential.
4. Ghost: an authorized direct entry with no chat row, or silent for more than `inbox_days`
   while a twin (pair or same name) is active: one notice, and the doctor lists it.
5. `wa-scope doctor [--json]`: each authorized entry of the active line with its jid, paired
   form, last incoming/seen per form, status (ok | migrated | ghost | conflict) and the audit
   trail.
6. Panel: the conversation list shows one row per person (the live jid, with the phone), and
   picking or editing a direct conversation saves it under the current jid; wa-scope finishes
   a move the panel made (the old database row goes, audited as `panel`).

## Checklist

- [x] S1 RED: `scripts/check-lid` (migration, reverse, no pair, other line, group, conflict,
      idempotence, gap inside/outside the window, single-form chat unchanged, panel move).
      Proof: 10/38 green, 28 failures (`ingest` saw 0 messages of the authorized person:
      `vistos 0`; no `lid_migracion`; `doctor` an invalid choice). The 10 green were the
      "nothing moves" assertions, which v4.16.1 already met.
- [x] S2 GREEN: `sigue_lid` at the start of `cmd_ingest` (so sync and tick too), the
      `lid_migracion` audit table, the per-chat ingest baseline (`bases_lid`) and the
      notices (`aviso` tipo `alcance`, es/en/pt, name on one line via `recorta`, no secret).
      Proof: `scripts/check-lid` 39/39 (with the one-line-name check, which went RED first
      because the notice took the old form's name). `scripts/check-casos` 1313/1313 green
      unchanged.
- [x] S3 `wa-scope doctor [--json]` in `scripts/check-clis` (`revisa_doctor_lid`: no store,
      before and after the move, text mode). RED for `doctor` is the S1 one (the command
      did not exist); a mutation (status `migrated` -> `ok`) makes check-clis fail.
      Proof: "8 CLI arrancan, 331 comprobaciones".
- [x] S4 Panel: `test/panels.test.mjs` RED 1290/1300 (two rows for the same person, the
      edit saved on the old jid, the live row not shown as authorized), GREEN 1300/1300.
- [x] S5 Screenshots `config-combo-gemelos` and `config-conversacion-gemela` (32 PNG, no
      overflow, no JS errors). Opened: combo es light 1440/768/390, es dark 768/320, en
      light 1440, en dark 320; edit es dark 1440/390, es light 768/320, en dark 320.
- [ ] S6 `npm run check` green.

## Notes

- The sidecar never stores the body of a chat that is not authorized, so the messages of
  the gap usually are NOT in capture.db. The notice says so ("what arrived under the new id
  since <date> was not stored") with the date of the old form's last activity; only stored
  messages are counted and ingested.
- Owner numbers and the approval number never migrate automatically (the approval channel
  would point to a jid no longer in scope); they can still be reported as a ghost.
- Ghost threshold: the existing `inbox_days` (what the inbox can still show), no new key.
- Open cases and other per-chat rows (caso, work, juicio) stay on the old jid.

## Acceptance

- An authorized phone jid whose messages now arrive under its paired LID is handled under
  the LID after one run, with one notice and one panel row; the reverse direction too.
- No pair, a pair of another line, or a group: no migration. Both forms authorized: conflict,
  no merge. A second run changes nothing.
- A chat that never changed form behaves exactly as v4.16.1.

## Checks

`scripts/check-lid`, `scripts/check-clis`, `node test/panels.test.mjs`, `npm run check`.
