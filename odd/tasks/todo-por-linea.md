# Every setting per line

## Objective

The owner's order (2026-10-06): every setting in the panel is independent for each
WhatsApp number. Picking a line at the top of the panel shows that line's value in every
card, and changing it never changes another line. `ajustes-por-linea.md` left eight cards
machine-wide; this feature closes that gap. It also adds a per-line switch to send
without the agent signature (the owner's request for one of his numbers).

## Scope

**One release (v4.25.0), owner's call: everything below ships together**
- `orcaNotices`: each line sends Orca notices to its own approval number, with its own switches.
- `signMessages` (new): sign with the agent name, on or off; when off the agent name is optional.
- `botClaudeAccount`, `transcribe`, `transcribeQuality`, `syncMinutes`, Jev on/off.

- `routes` and the projects catalog. Both mirror into scope.db tables that have no
  `account` column, so they need a migration.

**Stays on the computer, by its nature**
- Which skills are installed: Claude Code loads them from `~/.claude` for every
  session. What becomes per line is the line a skill notifies through.
- The Jev key (one service, one key). Whether Jev reviews a line is per line.
- Downloaded whisper models.

## Tasks

- [x] **P1** `orcaNotices` per line.
  - In `AJUSTES_DE_LINEA` (3 copies).
  - A secondary line never inherits it from the root: no own value means all off, so
    nobody gets the same notice twice.
  - `tick_orca` runs on every line's tick.
  - `orca-aviso` fans out to every line.
  - `id_orca` includes the line (non-main lines only).
  - `DESDE_CORRIDAS` is kept per line.
  - `textos_orca` uses the line's language.
  - `mirror_to_panel` and the sync mirror write into the line's own container.
  - The worker's gate checks whether any line has notices on.
- [x] **P2** `signMessages` per line.
  - Panel switch in the agent card; the name is required only while signing is on.
  - `wa-send` sends unsigned on a line that has signing off (no "no agent name" error there).
  - The checklist accepts no name when signing is off.
- [x] **P3** `botClaudeAccount` per line. `despacha` and `lanza_agente` read the case's line.
- [x] **P4** `transcribe`, `transcribeQuality` per line. Remove the machine notes.
- [x] **P5** `syncMinutes` per line.
  - One worker timer at the minimum across lines.
  - Each line syncs only when its own interval has elapsed.
  - The triage cron runs at the minimum.
- [x] **P6** Jev on/off per line.
  - The key and the mirror stay shared, and the mirror exists while any line is on.
  - `jev_juzga` and `revision_jev` skip a line that has Jev off.
- [x] **P7** Skills card: the notifying line is chosen per skill, and the card says installs are on this computer.
  - Model chosen: ONE choice for the computer, root key `skillsLine` (the line's account, or
    null for the main line). The catalog has one skill, so this is per skill today. A chosen
    line that is no longer linked falls back to the main line. `wa-scope owner` resolves that
    line's approval number and names it in `line`; the skill passes `--line "$LINE"` to every
    send and wait.
- [ ] **P8** Check, screenshots (es, dark, 390), release v4.25.0.
- [x] **P9** `routes` per line (scope.db `route` gets an `account` column) and the projects catalog per line (`project` table gets an `account` column; `PROJECTS.md` lists every line).

## Acceptance

- With two lines, switching any setting on line A leaves line B's stored value and behavior unchanged. Proven by tests per key.
- A line with signing off sends without "-- Name". A line with signing on still refuses to send without a name.
- No machine note remains on a card that is now per line.

## Checks

`npm run check`, with the reduced screenshot matrix.
