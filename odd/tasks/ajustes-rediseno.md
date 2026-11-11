# ajustes-rediseno (WAINBOX-122)

The settings page (`config.html`) reads as generated: every section is the same tracked
uppercase label over a gray paragraph, explanations run three lines under every field, the
"Automatico" mode is a red-outlined pill on every row, and Editar/Quitar are underlined text
links. The owner wants it to look designed. Skills applied: Hallmark (redesign, app-screen
scope; wins on layout) and taste-skill (copy and density).

## Objective

One shared visual system for every tab, with no behavior change: same settings, same saved
fields, same calls, same validations. Visual and copy only.

## Constraints

- Only `config.html` (markup, its CSS, the rendering JS) plus its tests and shots.
- Host theme tokens only (the allowlist has no green or amber); light and dark.
- The existing i18n mechanism; every new string in es, en and pt. Spanish keeps ustedeo.
- Fake data only.
- Tests that pin wiring (`#scope-wrap tbody tr`, `data-edit`, `data-rm`, ids) keep passing
  unedited: the redesign must not need a test rewritten to pass.

## The system

- **Headings.** Section titles in sentence case, the body face, foreground, 14px/600. No
  tracked capitals (Hallmark Floor 9). Sub-groups inside a form get an `h3`.
- **Copy.** Each control carries one short visible line at most. The long explanation keeps
  its words and moves behind a `details.como` disclosure ("Como funciona").
- **Segmented controls.** A muted track with the chosen option raised on the page background,
  instead of a row of separate pills with a filled primary.
- **Mode badge.** Calm and ordered by how much the agent may do: off muted, read-only outlined,
  ask-first on `--accent`, automatic on `--primary`. Red (`--destructive`) is for danger only.
- **Row actions.** Real small buttons (`button.btn-fila`), not underlined text links.
- **Forms.** Labels in the foreground, hints muted and short; free-text inputs that hold a
  sentence capped at a readable width instead of stretching the panel.
- **Primary action.** The save row closes its form, under a rule (`.actions.pie`).

## Tasks

- [x] **R1** Conversaciones first: tests for the system above on this tab, RED, then green.
- [x] **R2** First gate (Conversaciones only): the owner asked to see every tab first.
- [x] **R3** Prototype of the same system on Estado, Proyectos, Su aprobacion, Agente,
      Skills, Avanzado, on the real page (owner: improve the current page, keep every
      control). Long static help over 90 characters goes behind "Como funciona"; a section
      whose intro moved there gets a short lead (`*Short` strings, es/en/pt).
- [ ] **R3b** Decision gate with before/after of all seven tabs; wait for the owner.
- [ ] **R4** Shots of every tab at 1440/768/390/320, light and dark, via `WA_INBOX_SOLO=config`.
