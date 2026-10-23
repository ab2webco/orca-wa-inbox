# A failed voice note keeps Orca's message and is retried once after the update (case 186, WAINBOX-56)

Status: done (2026-10-23). Branch `fix/transcribe-error-detail`.

## Objective

Forwarded voice notes do not transcribe on a Linux install. The plugin stores only the
short code (`transcribe_failed`) and drops the message that Orca's speech engine returned, so
nobody can tell why it failed. The failed row is also final forever: it was written by
4.30.11, which had no retry code, and the 4.31 migration adds `reintento_ts` as null.

## Scope

- `bin/wa-scope` `transcribe_archivo` also returns the engine's message (`razon` from
  `wa-transcribe`), with newlines removed and capped at 300 characters.
- `transcripcion.detalle` (new column, with a migration) stores it. The case thread shows
  it next to the code: `audio sin transcribir: <code> (<message>)`. Classification (Jev and
  the floor) still sees only the code.
- Each failure is written as one JSON line to the worker log on disk,
  `<state>/logs/worker-<account>.log` (same file, shape and rotation as `bitacora.mjs`).
- One-time re-queue on upgrade: the migration that adds `detalle` gives every final
  transient failure (`transcribe_failed`, `timeout`, `fallo`) one more attempt
  (`intentos = REINTENTOS_TRANSCRIBE + 1`, `reintento_ts = now`). The tick retries those
  rows even when their case is closed or never opened, inside the per-tick audio cap, and
  never reopens or re-judges a closed case. After that attempt the row is final again.
- Everything else unchanged.

## Tasks

- [x] T1 RED/GREEN: the engine's message is stored, shown in the thread, logged to disk, and
  kept out of classification.
- [x] T2 RED/GREEN: an install upgraded from 4.30.11 retries a final transient failure exactly
  once, even in a closed case; a permanent code is not retried.

## Acceptance

- Tests with the fake transcriber in `scripts/check-casos` cover T1 and T2.
- Full check without shots passes (no panel HTML/CSS change).

## Checks

- `scripts/check-casos` (focused sections, then full).
- Full check without shots.
