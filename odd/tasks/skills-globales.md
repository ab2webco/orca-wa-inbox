# Installable skills: `whatsapp-avisos` (T24)

Status: done, verified (2026-10-05). Branch `feat/skill-avisos-global`, from
`fix/approve-solo-dueno` (the approve gate and `wa-read wait --chat`).

## Objective

An agent working in ANY project can notify the owner on WhatsApp and wait for his reply.
The plugin ships a `whatsapp-avisos` skill and a "Skills" tab in its settings that installs
it globally (`~/.claude/skills`) or into a project the owner already accepted.

## Scope

This build follows the lead's narrower brief, not every point of T24 in
`kanban-casos.md`:

- The skill notifies only the owner. Messages to team members or groups, and the
  "Solo avisos" mode, stay in T23/T24 follow-ups.
- The plugin writes the file itself, with the same section-ownership merge as the harness.
  It does not use `npx skills add`: the worker already writes the harness this way, and a
  network CLI is not needed for one local file.
- Targets: global, or a project from the accepted catalog. Agents other than Claude Code
  (`.agents/skills`, codex) are not offered yet.

## Checklist

- [x] S1 `wa-scope owner --json`: the owner's chat for an agent, from the settings (the
      approval number, else the line's chat with itself), with whether it is authorized.
      Never a typed number. Test: `scripts/check-clis` (`revisa_chat_del_dueno`).
- [x] S2 The skill `harness/skills-globales/whatsapp-avisos/SKILL.md` (English): bin-path
      and `$APPDATA` fallback, `wa-scope owner`, notify, ask and wait, timeout, the rules.
      Not seeded into the plugin's own workspace. Test: `scripts/check-harness`.
- [x] S3 `skills.mjs`: catalog, status (not installed / installed / outdated / edited /
      foreign file), install, update and remove, with the section-ownership merge and a
      manifest in the tools' state folder. Runs as a subprocess. Test:
      `test/worker.test.mjs` with a temp HOME.
- [x] S4 Worker: panel actions `skills-estado`, `skill-instalar`, `skill-quitar` on the
      scope channel; the project path comes from the accepted catalog, never from the
      panel; installed copies update on every activation. Test: `test/worker.test.mjs`.
- [x] S5 Panel: "Skills" tab in `config.html`, ES/EN/PT ("usted" in Spanish), state per
      target, Install globally / in a project, Update, Remove, and a confirmation before
      removing a file with the owner's edits. Test: `test/panels.test.mjs`.
- [x] S6 Screenshots of the new tab (1440 and 390, dark and light) and the final check.

## Acceptance criteria

- Installing writes `SKILL.md` only where the owner chose; removing deletes only a file the
  plugin wrote, and a file with the owner's edits is removed only after he confirms it.
- A section the owner edited survives an update, from the panel and on plugin activation.
- A file the plugin did not write is never overwritten.
- No real data, no hard-coded number or path in the skill.
- `npm run check` exits 0.

## Evidence

- S1: RED: `check-clis` failed 5 checks (`wa-scope owner` exits 2, unknown command).
  GREEN: `8 CLI arrancan, 396 comprobaciones`. Commits d311ecc, 9c5dfac.
- S2: RED: `check-harness` reported the missing skill, header and phrases. GREEN: 79
  checks. Commit ef6a6ea.
- S3: RED: the S3 block crashed on the missing `skills.mjs`. GREEN: 19/19 in the block.
  Commit 5487eea.
- S4: RED: "al activarse, el worker pone al dia la copia instalada" failed. GREEN: 10/10;
  full `test/worker.test.mjs` 442/442. Commit 58e3292.
- S5: RED: "hay siete pestanas" and "cada control vive en su pestana" failed. GREEN:
  `test/panels.test.mjs` 1413/1413. Commit 425f9cd.
- S6: shots `config-tab-skills` and `config-skills-confirmar` (es, en; dark, light; 1440,
  768, 390, 320) in `~/Projects/.capturas-skills`. Reviewed: es dark and light at 1440 and
  390 for both. The spacing between the actions and the path at 390 was fixed (99a52f3).
- Final check: `npm run check` (dark, 390, es) exit 0, 93 shots in
  `~/Projects/.capturas-skills-smoke`, no overflow, no JS errors.
- Open: the T24 points this build leaves out (team members and groups, "Solo avisos",
  `npx skills add`, codex and `.agents/skills`), listed under Scope.
