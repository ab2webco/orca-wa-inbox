# A group voice note that fails to transcribe is never closed in silence (WAINBOX-67)

Status: in progress (2026-10-22). Branch `fix/group-audio-transcription`.

## Objective

A group member's voice note got no reply and nobody was told: the local transcription
failed once (`transcribe_failed`, transient), the failure was stored and never retried, and
in a group the empty-text fallback (`doubtful`, "audio sin transcribir: <code>") is skipped,
so Jev saw an empty message, said skip, and no case opened. That breaks WAINBOX-62.

## Scope

- `bin/wa-scope` `veredicto_de`: a group audio without transcription (`sin_transcribir`)
  is classified `doubtful` with "audio sin transcribir: <code>", like a direct chat.
  Other empty group lines keep today's path.
- `transcripcion` table: `intentos` and `reintento_ts`. A transient code
  (`transcribe_failed`, `timeout`, `fallo`) schedules a retry with backoff; after the last
  retry it is final. Permanent codes are never retried.
- `tick_reconcilia`: retries due transcriptions of open cases, within the per-tick audio
  cap. A success updates the row (the case thread shows the text) and re-runs the floor
  and Jev on it (`reevalua_audio`).

## Tasks

- [x] T1 RED/GREEN: group audio with failed transcription opens a doubtful case, never
  `nothing`; direct-chat behaviour unchanged.
- [x] T2 RED/GREEN: a transient failure is retried on a later tick (after its backoff) and
  the text reaches the case; a permanent code is never retried; retries are bounded.

## Acceptance

- Tests with a fake transcriber in `scripts/check-casos` cover the four acceptance points
  of WAINBOX-67.
- `npm run check` without shots passes (no panel changes, so no shots).

## Checks

- `scripts/check-casos` (focused sections, then full).
- Full check without shots.
