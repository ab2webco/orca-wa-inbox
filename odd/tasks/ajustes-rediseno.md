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
- [x] **R3b** Decision gate with before/after of all seven tabs. Owner: "changes",
      restructure, not restyle (Su aprobacion is a long stack of blocks with a Guardar each).
- [x] **R5** Structure by views:
      - A tab with two or more blocks gets a sub-navigation built from those blocks. It is a
        left rail from 1024px and a sideways-scrolling row below that, and one block shows
        at a time. Same ids and handlers; only which block shows changes.
      - One save model: each view's Guardar lives in a `.barra-guardar` pinned to the bottom,
        which says "Cambios sin guardar" after a user edit. Reading values in does not mark it.
      - Conversaciones: the list is the main view. Add and edit open `#scope-form` as a side
        panel (full width on a phone), closed by the close button, Escape, the backdrop or
        Cancelar edicion.
      - Estado is a dashboard of cards.
      - "Encender Jev" in Lo que falta opens the Jev view.
      - Test adaptation (the only edit to an existing test): "ajustes sin lectura" asserted
        that Numeros and Avisos de Orca are both visible at once in Su aprobacion. With one
        view at a time that cannot hold by design, so the test now opens each card's view
        before looking, as the owner would. Its assertions are unchanged.
- [ ] **R5b** Decision gate with round 2; wait for the owner.
- [ ] **R4** Shots of every tab at 1440/768/390/320, light and dark, via `WA_INBOX_SOLO=config`.
