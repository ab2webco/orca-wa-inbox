# estado-flota (WAINBOX-55)

## Objective

When the owner writes `estado` to the approval number, the reply also carries a short
summary of every accepted project's Orca game fleet (`orca game fleet --json`), read-only.
Layer 1 of the WhatsApp to Orca game bridge.

## Scope

- `texto_de_flota(con)` next to `texto_de_estado`; its section is appended to the
  `estado` reply only when it is not None.
- One `game fleet` call per accepted project path (`proyectos_del_dueno`), with that
  path as cwd and without the terminal env (`ORCA_TERMINAL_HANDLE`, `ORCA_WORKTREE_ID`,
  `ORCA_PANE_KEY`, `ORCA_TAB_ID`), so Orca resolves the project from cwd.
- Short per-call timeout and a total budget. No CLI, no `game` subcommand, `ok:false`,
  non-JSON or a timeout on the first call: no fleet section, reply byte-identical.
- Projects with no members are skipped; no member anywhere: no section.
- Per project: name, running/cap, counts; per member: phase, ticket, PR. Bounded rows.
- Only the owner on the approval number (unchanged gate). Nothing is launched or stopped.

## Tasks

- [x] F1 Tests (RED): fleet with members, empty, CLI missing, timeout, non-owner, terminal
  env stripped, per-project cwd.
- [x] F2 `orca_json` takes optional cwd/plazo/env; `texto_de_flota` and the `es`/`en`
  texts; `estado` appends the section (GREEN).
- [x] F3 `npm run check` without shots green; PR opened.

## Acceptance

- Tests cover: game available with members, game available but empty, CLI missing, CLI
  timeout, a non-owner sender.
- Fake data only (public repo).
- `npm run check` green (no panel changes, so no shots).

## Checks

- `scripts/check-casos`, `scripts/check-voseo`, `scripts/check-datos-reales`, and the rest
  of the `check` chain without `npm run shots`.
