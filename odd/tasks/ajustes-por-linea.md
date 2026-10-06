# Settings per line

## Objective

With two or more linked lines, the owner picks a line once at the top of the settings
panel, and every setting that can differ between lines becomes that line's own. A
personal line can have its own agent, tone, approval number and automatic replies. A new
line starts as a copy of the main line's settings and, from then on, changing one line
never changes another.

## Scope

**Per line.** Main line: storage root, as today. Other lines: the new panel-owned
container `ajustesPorLinea[cuenta]`.

- agentName, ownerName, tone
- owners, approvalNumber, approvalLang
- ackMode, ackText, ackQuietMinutes, greetingMode, greetingText, firstReply
- slaMinutes, projectQuestionHours
- inboxDays, transcribeLang

**Machine-wide, unchanged.** The panel marks these once, only where they appear, as
belonging to this computer:

- syncMinutes, transcribe, transcribeQuality
- Jev, orcaNotices (they still go out through the main line)
- botClaudeAccount (one case agent for the machine)
- Skills, the projects catalog, routes (the `route` table has no account column)

**Out of scope:**
- The Personal line type (part 2, S1–S7).
- A projects catalog per line. Each line already chooses projects per conversation.

## Tasks

- [x] **A1** `bin/wa_settings.py`: `AJUSTES_DE_LINEA` and the container `ajustesPorLinea`.
  - `vista_de_linea` overlays the line's own settings.
  - `settings_from_plugin`, `ajuste`, `duenos`, `numero_aprobacion` and `idioma_aprobacion` read the view of the line being served (env `WA_INBOX_LINEA` or `--line`).
  - `escribir_en_linea` never writes a per-line setting of another line to the root. A sync or tick of line 2 must not touch the main line's settings.
  - Python never rewrites `ajustesPorLinea` as a whole except through `plugin_store_modifica`, which keeps unknown keys.
- [x] **A2** `bin/wa-scope` and `bin/wa-send`: every consumer in the map reads the line's settings, including:
  - the agent signature
  - tone
  - ack and greeting
  - first reply
  - SLA
  - project question hours
  - owners
  - approval number and language
- [x] **A3** Approval notices for a case go from that case's line to that line's approval number. Orca notices stay on the main line.
- [x] **A4** `main.mjs`: the first time a non-main registry entry gets its `cuenta` (`alSaberCuenta`), and `ajustesPorLinea[cuenta]` does not exist yet, copy the current root values of `AJUSTES_DE_LINEA` into it. Do not copy again when that number is relinked.
- [ ] **A5** `config.html`: move the line selector to the top of the panel, above the tabs, shown only with two or more linked lines. `lineaVista` drives every tab.
  - For another line, per-line keys are read from and written to `ajustesPorLinea[cuenta]`. Write the whole container with read-modify-write, as `escribirAlcanceVisto` does.
  - Remove the "Aplica a sus N lineas" notes from per-line sections.
  - Machine-wide controls carry one note saying they apply to every line on this computer.
  - Fix `senders` and `groupMembers` to read `porLinea[cuenta]` when viewing another line.
  - Keep the loading state and targeted retry from v4.23.1 for every per-line read.
- [ ] **A6** Strings in ES, EN and PT. The panel's Spanish uses usted, with no voseo and no accents in the code.
- [ ] **A7** Screenshots (reduced matrix: es, dark, 390): the selector at the top, Agente on the main line, Agente on the second line, and Su aprobacion on the second line.

## Acceptance criteria

- With one line, panel, storage and CLI behavior are byte-for-byte unchanged. All existing tests stay green.
- With two lines:
  - Changing the agent name on line 2 changes only `ajustesPorLinea[line2].agentName`.
  - A case on line 2 is signed with line 2's name.
  - A case on line 1 keeps line 1's name.
- A line 2 sync or tick leaves the root `agentName`, `owners`, `approvalNumber` and the other per-line keys untouched.
- A new line starts with the main line's values. Editing the main line afterwards does not change the new line.
- Switching lines never shows the other line's values. Unanswered reads show the loading state, never stale values.

## Checks

`WA_INBOX_CAPTURAS=<dir> WA_INBOX_TEMA=dark WA_INBOX_ANCHO=390 WA_INBOX_IDIOMA=es PYTHONDONTWRITEBYTECODE=1 npm run check`
