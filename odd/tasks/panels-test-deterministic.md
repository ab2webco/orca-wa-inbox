# Deterministic config.html timing tests in panels.test (WAINBOX-65)

## Objective

`test/panels.test.mjs` fails at random in config.html timing tests (Jev mirror
note, U4 scope repaint, elegirChat list): about 2 failures per run on a quiet
machine, up to 21 under load, on main too. Replace fixed waits with waits for
the condition so the suite is deterministic.

## Scope

- Only the test harness (`test/panels.test.mjs`). No panel behaviour changes
  unless a test exposes a real panel bug.

## Checklist

- [x] T1 Baseline: record which tests fail on main and why (fixed waits that
  race the panel's chained storage reads).
- [x] T2 Settle helper: `montar` and `espera` wait until the panel has no
  request in flight and has gone quiet, instead of a fixed 60 ms.
- [x] T3 Replace the remaining fixed waits in the flaky regions with waits for
  the asserted condition.
- [x] T4 Prove it: 10 consecutive green runs of `node test/panels.test.mjs`,
  plus runs under parallel load.

## Acceptance criteria

- 10 consecutive green runs under normal load.
- No test asserts less than before (same assertions, only the waits change).

## Checks

- `node test/panels.test.mjs` x10
- `npm run check` without shots (`scripts/check-panels` etc.)

## Evidence

- T1 RED (2026-10-22): 4 copies of the unmodified file in parallel: 1783/1784,
  1777/1780, 1781/1784, and one run crashed at test 1627
  (`fila` undefined in the line-pairing section, config.html). Failures change
  every run, in config.html and activity.html alike. No panel was ever closed:
  hundreds of jsdom windows kept polling every 12 s for the whole run.
- T2/T3 GREEN: the fixed file under the same load: 1785/1785.
- First verification pass: 4 parallel green, then one sequential run failed in
  a Jev case this change had converted (the tombstone is written after the
  "did not answer" text). Fixed by waiting for both, then settling.
- T4 GREEN at dae98da: 10 consecutive runs, all 1785/1785.
- 4 parallel runs at dae98da: one failure in the per-line settings section
  (a fixed 500 ms after a save). The 300-500 ms waits after clicks became
  `espera()` (settle) in 1f9b836.
- Final at 1f9b836: 10 consecutive runs 1785/1785 (about 242 s each), then
  4 parallel runs 1785/1785.
- Not run: shots. No panel HTML/CSS changed, only the test harness.
