# One-line recap in the "finished" summary

## Objective

The hourly summary of finished agents says where and how many times
(`orca-oss · mobile-plugin-panels x1`) but not what was done. Owner decision (option A): the
agent that finished writes ONE short line saying what it did, and the summary shows it next
to the project.

## Scope

- `wa-scope recap "<line>" [--worktree <path>] [--json]`: validates the line (one line,
  trimmed, 1..120 characters, never truncated, not secret-shaped), resolves the folder (the
  current one by default) to the Orca `worktreeId` through `worktrees_de_orca`, and stores
  the latest line per worktree with its time in the panel storage key `orcaRecaps`
  (`{worktreeId: {"texto", "at"}}`, `at` in ms; entries older than 7 days are swept on write).
  Error codes (contract, documented in `--help`): `recap-empty`, `recap-multiline`,
  `recap-too-long`, `recap-secret` (exit 1), `recap-no-worktree`, `recap-not-saved` (exit 3).
- Digest (`orca_terminados`, `texto_terminados`, `orca_resumen_terminados`): each accumulated
  turn keeps its `worktreeId` and `at` (JSON in the row's `version` column, unused by `orca`
  rows). The line of its worktree counts for the turn when it was written from
  `RECAP_TOLERANCIA_S` (120 s) before the turn's `at` until the summary is built. Per project
  line the latest one shows: `- <project> x<n> — <recap>`. Lines without a recap are
  unchanged; the 10-project cap, "and N more" and the secret fallback hold; the recap is
  validated again on read.
- New template key `proyecto_recap` in ES, EN and PT.
- Skill `harness/skills-globales/whatsapp-avisos/SKILL.md`: inside "Notify him", the rule to
  run `"$WA/wa-scope" recap "<line>" --json` before stopping a long task. No section renamed.
- `scripts/check-harness` fails if that section stops naming `wa-scope recap`.
- Out of scope: the panel (no UI change), waiting/blocked/automation notices, agents that do
  not read the skill (they leave no recap, their line stays as today).

## Checklist

- [x] R1 `wa-scope recap`: validation, error codes, path to worktreeId, latest-per-worktree
  store, `--json` and plain output (check-casos R3 section: 16 new checks, RED then GREEN).
- [x] R2 Digest shows the recap per project line (window, latest wins, secret fallback, cap,
  ES/EN/PT) (check-casos R3).
- [x] R3 Skill rule + `check-harness` guard (RED observed: guard failed before the rule,
  GREEN after).
- [x] R4 Task file and final checks (check-casos full: 2391/2395; the 4 R2 clock-window failures seen at first were then fixed by anchoring the
  test clock; final full run 2395/2395).

## Acceptance criteria

- A recap written inside the turn window appears on its project line; without one the line
  is identical to before.
- A line over 120 characters, with a newline, empty or secret-shaped is rejected with its
  code and nothing is stored.
- Two recaps of the same worktree: only the latest is stored and shown.
- A recap written before the tolerance, or after the digest time, does not show.
- Not verified live in Orca: only the tests exercise the digest.

## Checks

- `python3 scripts/check-casos` (R3 section and the existing R2 digest tests)
- `scripts/check-harness`, `scripts/check-voseo`, `scripts/check-prompts`,
  `scripts/check-datos-reales`, `scripts/check-clis`
