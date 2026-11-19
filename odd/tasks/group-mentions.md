# Real @mentions in group replies (WAINBOX-124)

## Objective

When a reply in a WhatsApp group addresses a person, that person gets a real WhatsApp
mention: their name is highlighted and they are notified. Today the name goes out as plain
text and nobody is notified.

## Owner decision (2026-11-19)

- Explicit first: `wa-send --mention <who>` (repeatable). `who` is a name, a phone or a jid
  of a member of that group. Unknown or ambiguous is refused, never guessed.
- Fallback: an `@Name` (or `@<phone>`) written in the text becomes a mention only when it
  matches exactly one member of the group. Anything else stays plain text.
- Precision over coverage.

## Scope

- `bin/wa_menciones.py`: pure resolution (who → member) and text rewrite
  (`@Name` → `@<user part>`, list of jids).
- `bin/wa-send`: `--mention`, resolution against `grupo_miembro` members, rewrite before the
  row is written (drafts too), refusal codes, `menciones` column on `envio`, same-id check.
- Sidecar: `envio.menciones` column (migration), `contenidoDe` sends `mentions`,
  `mensajeDeEnvio` carries `contextInfo.mentionedJid`. Rebuild `sidecar.cjs`.
- The review floor and Jev read the text as the agent wrote it (before the rewrite).
- Docs: agent skills and COMMANDS.md describe `--mention` and the `@Name` rule.

Out of scope: new flags on `caso propuesta/resultado/avance`. The case agent writes
`@Name` or `@<phone>` (from `wa-read members`) in its text, and `wa-send` resolves it.

## Tasks

- [x] T1 `wa_menciones`: resolve and rewrite, with tests (`scripts/check-menciones`).
- [x] T2 Sidecar: `menciones` column, `contenidoDe` and `mensajeDeEnvio`, with tests.
- [x] T3 `wa-send --mention` and the text fallback end to end, with tests.
- [x] T4 Agent docs and the case-file instructions.
- [ ] T5 Full `npm run check`, then a live test in the owner's test group after install.

## Acceptance criteria

- A group reply with `--mention` notifies that member (live test).
- An ambiguous or unknown `--mention` is refused with a code and no personal data.
- `@Name` that matches one member becomes a mention; two matches or none stay text.
- A draft keeps its mentions through approval.
- `--mention` on a direct chat is refused.

## Checks

`npm run check` (includes `scripts/check-menciones`, `test/envio.test.mjs`,
`test/almacen.test.mjs`).
