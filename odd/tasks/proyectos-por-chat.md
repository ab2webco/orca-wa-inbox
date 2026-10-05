# Several projects per chat, and roles by number (kanban T22.7 and T22.8)

## Objective

Today a chat holds exactly one project. The panel stores it in `scope[jid].workspace` (`main.mjs:33`, `config.html:3847,3857`) and the database stores it in `chat_scope.workspace` (`bin/wa-scope:234`). Every case falls back to that one project (`resolve_target` `bin/wa-scope:1882`, `proyecto_del_caso` `:7810`). Who the sender is has only two answers, owner or not (`wa_store.es_dueno` `bin/wa_store.py:553-558`, `caso_del_dueno` `bin/wa-scope:3021-3045`).

This feature delivers the owner-approved points 7 and 8 of T22 (`odd/tasks/kanban-casos.md:509-531`).

1. **Several projects per chat (point 8).** A chat holds a list of projects. Each case gets its project in this order:
   - a matching text rule (this already exists);
   - otherwise the case agent, which picks among the chat's projects by content and writes down why;
   - if it is still ambiguous, a short question ("is it about A or B?") to the person who wrote, or to the owner.

   The card shows the case's project, why it has it, and who chose it. The project can still be changed from the card.
2. **Roles by number (point 7).** Each number has one role:
   - **Super admin**: the global owners. Their role holds in every chat.
   - **Operador**: limited to that chat's projects. His work requests go to the project agent (T8), and the result comes back to his chat. Anything destructive or outside his projects goes to the owner. Replies to him skip the customer rules.
   - **Cliente**: the default.

   The role comes from the number, which the owner configures per conversation with autocomplete. It never comes from the text of a message. In a group the owner gets the participant list, with names from WhatsApp, and marks each person Operador or Super admin. A group role is valid only inside that group and for that group's projects.

Everything must be configurable and wired end to end (panel and logic), in ES, EN and PT and in both themes. It must stay backward compatible: a chat with one project behaves exactly as today. Customers never get data without the owner's authorization.

## Scope

### A. Several projects per chat

1. **Storage and migration**
   - Add a new JSON column `chat_scope.workspaces`, an ordered array of `project.id`.
   - Add it to the migration next to the T13 one (`bin/wa-scope:1296-1301`). The backfill is `workspaces = json_array(workspace)` where `workspace` is not null, else `[]`.
   - Add `workspaces` to `CHAT_SCOPE_COLS` (`:1363`).
   - Keep the `chat_scope.workspace` column. It is derived: the only id when the list has exactly one, else null. Every existing single-project reader then keeps its behaviour unchanged (see the "every place" list in the project map, items 1-17).
2. **Panel ↔ CLI**
   - The panel entry gains `scope[jid].workspaces: string[]`.
   - `merged_scope` (`:1118-1173`) resolves the list in this order:
     - the panel's `workspaces` when the key is present;
     - else the panel's `workspace` as a one-item list (an old panel);
     - else the database value.
     
     Each id passes `id_proyecto` (`:1188`).
   - `persistir_panel` (`:827-831`) writes both columns, and only when one of the keys is present. `push_to_plugin` (`:847`) sends both.
3. **CLI**
   - `wa-scope set` gains `--workspaces a,b` (`''` clears the list). Every id is validated against `proyectos_del_dueno` (`:1217`).
   - `--workspace <id>|''` (`:1547-1556`, argparse `:9507`) stays, meaning a one-item list.
   - `check` (`:1670`) and `voice` (`:2303`) also return `workspaces`.
4. **Resolution**
   - `resolve_target` (`:1860-1911`) keeps first-matching-rule-wins (`:1876-1880`).
   - Without a rule it falls back to the chat's project only when the chat has exactly one accepted project.
   - It always returns `candidates: [{id, name, note}]`, which are the chat's accepted projects in order.
   - When there are 2 or more candidates and no rule matched, it returns `workspace=null` with `workspace_why="the chat has N projects: the agent chooses by content"`.
   - `where` prints `candidates`.
5. **Case route**
   - `caso_enruta` (`:4453-4475`) also stores `workspace_name`, `workspace_path`, `workspace_why` and `by` (`rule` | `chat`). It stops dropping them (`:4461-4463`).
   - `por_dueno` keeps freezing the route (`:4466`). An agent's choice does not freeze it: a later message that matches a content rule still wins, because rules come first.
6. **The agent chooses**
   - `caso proyecto` (`cmd_caso_proyecto` `:2807-2829`, argparse `:9732-9736`) gains `--porque <text>`.
   - With `--actor agente`:
     - `--porque` is required;
     - the id must be one of the chat's `candidates`;
     - the call is refused with `E_OWNER` when `ruta.por_dueno` is set;
     - it writes `workspace_why=<porque>` and `by="agent"`, and it does not set `por_dueno`.
   - With `--actor dueno` it behaves as today, plus `by="owner"`.
   - The history event carries a `que` code with the choice and the reason.
7. **Asking "A or B?"**
   - Add a per-chat setting `projectQuestion: auto | writer | owner`, stored as panel key `projectQuestion` and column `chat_scope.pregunta_proyecto`. Its default is `auto`: `writer` when the sender's role is Operador or Super admin, `owner` for a Cliente (see Open question 1).
   - Add a global setting `projectQuestionHours`, default 24, in `wa_settings`.
   - New CLI `wa-scope caso pregunta-proyecto <id> --candidatos a,b --texto "<question>"`. It records `ruta.pregunta = {candidatos, a: writer|owner, quien: <sender_jid>, texto, at}`. The setting decides `a`: an agent cannot override `owner` with `writer`.
   - **To the writer:** the agent then proposes a `responder` whose text is the question. The proposal follows the chat's normal approval path, which is unchanged.
   - **To the owner:** the agent proposes `escalar --instrucciones "<question>"`, the existing notice path (`:6700-6715`). The owner's `N <text>` answer comes back as a correction (`:7011-7016`, shown in the case file at `:8563-8571`).
8. **Answer routing**
   - New `caso_espera_proyecto(con, chat, sender_jid)`. It returns the case in `respondido` that has an unanswered `ruta.pregunta` with `a=writer` and `quien == sender_jid`.
   - Ingest checks it before the continuity split (`:4808-4811`). On a match, the message joins that case, the case moves `respondido→recibido` (an allowed transition, `:116`), `necesita_agente=1` is set and the answer stanza is recorded in `ruta.pregunta`.
   - Messages from anyone else follow today's path.
   - The tick moves a question that has gone unanswered for more than `projectQuestionHours` to the owner, through `escala_al_dueno` (`:6680-6686`).
   - Setting the project from the card, or by `caso proyecto`, closes `ruta.pregunta`.
9. **What the agent sees**
   - `cabeza_del_caso` (`:8531`) writes `- Project: <name> (<id>) — <why> [by]` and `- Chat projects: <id> (<note>), …`.
   - `archivo_de_caso` (`:8603-8611`) gets a `## The project question` section with the candidates, the question and the answer.
   - The `PROJECTS.md` header (`harness.mjs:298-299`) describes `candidates`.
10. **The effective project is one rule, used everywhere.**
    - `proyecto_efectivo(con, caso)` = `ruta.workspace`. Else, when the route was set by the owner (`por_dueno`) with none, none: this fixes "Sin proyecto" on the card dispatching to the chat's project (`:2952`, `:7810`). Else the chat's single project. Else none.
    - These callers use it:
      - `proyecto_del_caso` (`:7806`);
      - `trabajo_espera_al_dueno` (`:2944-2955`), where `outside_project` becomes "the effective project is null, or not in the chat's accepted set, or `repo` does not name it";
      - the card JSON `project` (`:5147`), which gains `why`, `by` and `candidates`;
      - `casos_del_informe` (`:5695`; `build_reports` `:5788` passes only single-project chats).
    - The notice text at `:6461` becomes "outside the chat's projects" in every language of that table. A new reason `no_project` gets its own text.
11. **Panel (`config.html`)**
    - The single combobox `#workspace` (`:546-555`, `:3498`, `:3504-3526`) is replaced by a chip list fed by the same autocomplete. It keeps the order, the first chip is listed first, and removed ids are marked as today (`:3457-3473`).
    - Save (`:3843-3878`) writes `workspaces`.
    - Editing a chat (`:3741-3743`) and a new form (`:3781-3784`) load and reset the list.
    - The table column (`:3678-3683`) shows `A`, or `A +N` with the full list in the title.
    - Add the `projectQuestion` button group. There is no `<select>` (the T17 test).
    - Rewrite `scopeHelp`, `workspaceLabel` and `workspaceHint` (`:1095`, `:1182`, `:1187`).
    - Add PT strings explicitly, because `STRINGS.pt` falls back to EN (`:1805`).
12. **Board (`activity.html`)**
    - The project combo (`:2566-2620`) lists the chat's projects first, then the rest of the catalog.
    - The detail (`:3220-3228`) shows the reason and who chose. An open project question shows as "waiting for an answer: A or B".
    - The request stays a single `pedido.proyecto` (`:2492`, `acciones.mjs:325-335`).
13. **Harness**
    - Update `harness/AGENTS.md:68-77`, `harness/CLASSIFICATION.md:68-74` and `harness/skills/whatsapp-soporte/SKILL.md:160-178`: rule, then choose with `caso proyecto --actor agente --porque`, then `caso pregunta-proyecto`.
    - Sections the user has edited are left alone (`AGENTS.md:5-7`).
    - Add the new phrases to `scripts/check-harness:254-311`.

### B. Roles by number

14. **Group participants (sidecar)**
    - Today the participant list from `groupFetchAllParticipating` is dropped (`sidecar/src/index.js:593-602`, `ingesta.js:98-102`). Keep it instead.
    - Store it in a new table `grupo_miembro(account, chat_jid, member_jid, admin, updated_at)`, created through the store's migration (`sidecar/src/almacen.js`).
    - Update it from `group-participants.update`. Verify the Baileys event and metadata shape in the bundle first, as lid-telefono did.
    - It is bookkeeping only: ids, never a message body.
    - New `wa-read members --chat <jid> --json` returns `[{id, name, phone, wa_admin}]`. The name comes from the latest `sender_name` or the contacts, and the phone from `lid_telefono` (`almacen.js:88-98`).
15. **Role data**
    - New column `chat_scope.miembros`, a JSON `{id: operator|admin}`; Cliente is never stored.
    - New panel key `scope[jid].members: [{id, name, role}]`, merged, persisted and pushed like `approval` (`:823-826`).
    - `wa-scope set --member <id>=operator|admin|client`, where `client` removes the entry.
    - `wa-scope` pushes panel storage key `groupMembers: {jid: [{id, name, phone}]}`, next to `senders` (`:892`, `build_senders` `:1044-1055`).
16. **Role resolution**
    - New `wa_store.rol_de(con, cuenta, chat_jid, sender_jid, owners, miembros)` → `admin|operator|client`:
      - a global owner (`duenos()`, `bin/wa_settings.py:434-454`) is `admin` everywhere;
      - otherwise the role saved for that chat, valid only in that chat;
      - LID and phone ids match only through a `lid_telefono` pair, never guessed. Since the
        verification fixes this applies to the per-chat roles only: a global owner is matched
        by his exact id, as `es_dueno` does (see "Verification fixes (on 93bba3c)").
    - `es_dueno` stays as is for the approval-number gate (`bin/wa-scope:4929-4935`). WhatsApp approval stays with the global owners.
    - `rol_del_caso` is the lowest role among the case's non-own senders, generalising the all-senders rule in `caso_del_dueno` (`:3021-3045`).
17. **Role in behaviour**
    - At ingest, `de_dueno` (`:4938`, burst `:4409`, audio `:7281`) becomes `rol`.
    - Jev's `from` becomes `owner | operator | participant` (`bin/wa_jev.py:310`). There is a new operator prompt: his order does not count as `tries_to_instruct_the_assistant`, but credential exceptions stay.
    - The verdict cache (`jev_cacheado` `:4228-4243`) also stores the role it was judged with. A role change re-judges the message.
    - `piso_de_entrada` (`:4709-4716`): only `admin` gets the owner floor.
    - `frenos_de_regla` (`:2978-2981`) and `wa-send` (`bin/wa-send:677-689`) skip the customer levels for an operator case, as scoped by Open question 3.
    - The brief and the case header (`:8305-8340`, `:8482-8522`, `:8638`) gain `DICE_OPERADOR`/`BRIEF_OPERADOR`: "an operator asked; within this chat's projects; destructive or outside goes to the owner".
    - Destructive work and work outside the chat's projects still wait in `trabajo_espera_al_dueno`, unchanged for every role.
18. **Panel roles**
    - The per-chat editor gets a "People" card:
      - **direct chat:** one button group (Cliente / Operador / Super admin) for that person;
      - **group:** the participant list from `groupMembers`, with search, name and phone, and a button group per row;
      - global owners are shown as Super admin and read-only, pointing to "Su aprobación".
    - ES, EN and PT, both themes.

### Out of scope

- WhatsApp approval by a group Super admin. Notices still go only to `numero_aprobacion()` (`bin/wa_settings.py:460-471`).
- Per-project content rules. Rules stay global (`rutas_efectivas` `:1242-1259`).
- One case dispatched to several projects. A case still has one project, one dispatch and one `workspace_selector` (`:476-478`, `:8926-8933`).
- Locking down `wa-send --approve`, which any agent can still call. It is a separate T22 gap.

## Checklist

### A. Several projects per chat

- [x] **M1** — `chat_scope.workspaces` column, migration that backfills one-item lists, `CHAT_SCOPE_COLS`, `merged_scope`/`persistir_panel`/`push_to_plugin` handling of `workspaces`, derived `workspace`, `set --workspaces`, `check`/`voice` returning `workspaces`.
  - Tests in `scripts/check-clis` (around `:377-386`) and `scripts/check-casos`:
    - an old database and an old panel entry (only `workspace`) give `[id]`;
    - a panel `workspaces: []` clears the list;
    - a removed catalog id is kept and reported;
    - a two-item list gives `workspace=null`.
  - Evidence: `scripts/check-clis`, `revisa_varios_proyectos`. RED: 26 of 27 checks failed
    (no `workspaces` column, no list in `list`/`check`/`voice`/storage, `--workspaces`
    unknown to argparse). GREEN: its 22 M1 checks pass; `check-clis` 307 checks, exit 0;
    `check-casos` 1233/1233 with no existing assertion touched. The "reported" half of the
    removed id is `where`'s `missing` and lands with M2. Beyond the list above, the tests
    also pin the backward-compatibility guard: a list is trusted only when the `workspace`
    stored next to it is its derived value, so an older CLI that writes `workspace` in the
    database, or an older panel that edits `workspace` and leaves a stale `workspaces` in the
    entry, wins as a one-item list (`lista_de_proyectos`).
- [x] **M2** — `resolve_target`/`where` return `candidates`; the chat fallback applies only to single-project chats; `caso_enruta` stores `workspace_name/path/why/by`.
  - Tests:
    - the rule wins over the list;
    - two projects without a rule give null with the reason;
    - a single project behaves exactly as today (the existing `where` and `caso_enruta` tests stay green).
  - Evidence: `scripts/check-clis` (`revisa_varios_proyectos`, the `where` block) and
    `scripts/check-casos` ("proyectos-por-chat: la ruta del caso con varios proyectos (M2)").
    RED: 7 of 29 check-clis checks and 3 of 3 check-casos checks failed (no `candidates`,
    `by` or `missing`; two projects fell back to nothing without the reason; the case route
    kept only `workspace`). GREEN: check-clis 314 checks, exit 0; check-casos 1236/1236,
    exit 0, on the committed tree. `where` also returns `missing` (the ids of the list that
    the owner removed from the catalog), and a list of two with one removed id has one
    accepted project, which is then the chat's project.
- [x] **M3** — `caso proyecto --actor agente --porque`: it validates against the candidates, is refused on `por_dueno`, does not freeze routing, and records the history `que`.
  - Card JSON `project.{why,by,candidates}`.
  - `proyecto_efectivo` used by `proyecto_del_caso`, the card, the reports and `cabeza_del_caso`. Fix the owner's "Sin proyecto" that fell back to the chat's project.
  - Tests in `check-casos` (near `:3419-3437`, `:4720`).
  - Evidence: `scripts/check-casos`, "proyectos-por-chat: el agente elige el proyecto, y el
    proyecto efectivo (M3)". RED: 18 of 19 failed. `--porque` was unknown, the agent's
    call froze the route as the owner's, the card had no reason or candidates, the case
    file said only `- Project: Alfa Demo`, and the owner's "Sin proyecto" in a one-project
    chat counted as that project in the reports. GREEN: 19/19; check-casos 1255/1255 and
    check-clis 314 checks, both exit 0, on the committed tree.
  - Deviation, on purpose: `why`, `by` and `candidates` travel on the board, in
    `board.project_routes[<case_id>]`, and not on the card. Two existing assertions pin
    the card's key set (`LLAVES_TARJETA`, "la tarjeta trae exactamente las llaves del
    contrato") and `project == {"id", "name"}` ("la tarjeta lo trae con su nombre"), and
    both stay unchanged. A first try with a card key `project_route` broke the first one
    in the full run (1254/1255) and was moved to the board. See "Part A backend contract".
  - The one rule is `proyecto_de_ruta`, a pure function of the route, the chat entry and
    the catalog. `proyecto_efectivo` wraps it, and the card, `proyecto_del_caso`
    (dispatch), `cabeza_del_caso` and the reports use it. The reports run the same rule
    over `chat_proyecto`, which holds only one-project chats, plus `por_dueno`.
- [x] **M4** — `trabajo_espera_al_dueno` uses the chat's project set and the new `no_project` reason; notice texts at `:6461` in every language of that table.
  - Tests:
    - T22.9 no-click dispatches for a project in the chat's list;
    - it waits for a project outside the list, or with no project;
    - the existing single-project T22.9 tests are unchanged.
  - Evidence: `scripts/check-casos`, "proyectos-por-chat: el trabajo sin el clic con los
    proyectos del chat (M4)". RED: 8 of 9 failed. The table had no `no_project` and still
    said "del proyecto del chat"; two projects with no choice waited as `outside_project`;
    the agent's choice from the list did not leave without a click. Worst, the owner's
    "Sin proyecto" in a one-project chat was signed by the rule and dispatched to the
    chat's project. GREEN: 9/9; check-casos 1264/1264 and check-clis 314 checks, both
    exit 0, on the committed tree. The existing T22.9 section is unchanged and green.
- [x] **M5** — `projectQuestion` setting (column, panel key, `set --project-question`), `projectQuestionHours`, `caso pregunta-proyecto`, `caso_espera_proyecto` at ingest, the timeout to the owner in the tick, the case-file section, the question closed on a project choice.
  - Tests:
    - the writer's answer joins the case and reopens it;
    - another sender's message does not;
    - after the timeout an escalation notice is queued once;
    - the owner's `N <text>` reaches `historia_del_caso` (near `:7826`, `:7958`).
  - Evidence:
    - `scripts/check-clis` (`revisa_varios_proyectos`, the last block):
      - the `pregunta_proyecto` column and the `auto` default;
      - `set --project-question`, its choices and the panel key in both directions;
      - an invalid panel value counts as auto;
      - `project_question_hours`: 24 by default, zero refused, pushed to the panel, and
        the panel's value wins.

      RED: the run stopped with `no such column: pregunta_proyecto`. GREEN: 42 checks.
    - `scripts/check-casos`, "proyectos-por-chat: la pregunta A o B (M5)". RED: `caso
      pregunta-proyecto` was not a command. Seven checks failed, among them: no question on
      the card, the writer's answer did not reopen the case, and no section in the case
      file. Then the section stopped. GREEN: 26/26.
    - Full suites on the committed tree: check-casos 1290/1290 and check-clis 327 checks,
      both exit 0.
  - What the section pins, beyond the list above:
    - the refusals: one candidate, a project outside the chat, an empty text, and
      `E_OWNER` after the owner chose;
    - `auto` with a customer goes to the owner (and, since the verification fixes below,
      `auto` in a group goes to the owner even when the owner writes; only the owner's own
      chat asks the writer);
    - `writer` and `owner` win over `auto` in both directions;
    - the output's `next` tells the agent what to propose;
    - the card's `question` and the `project_question` event code;
    - choosing the project closes the question.
  - Under `auto`, a customer's "A or B?" never reaches the customer. The agent's `escalar`
    goes only to the approval number. A `responder` proposed while the question is with the
    owner is held for him, with the new reason `project_question` in `frenos_de_regla`.
    The test checks that nothing reaches the group's outbox. A mutation run with that
    hold removed made this check fail: the question went out to the group.
  - The timeout check: within `projectQuestionHours` nothing moves. After it, the case goes
    `respondido → recibido → clasificado → decision` with an `escalar` that carries the
    question, written by the automation, and the existing notice path sends it once. A
    second tick does not escalate again.
- [x] **M6** — `config.html` chip list, table column, `projectQuestion` group and ES/EN/PT texts; `activity.html` grouped combo, reason and question state.
  - Tests in `test/panels.test.mjs`: save, edit-load and reset, the no-`<select>` guard, PT strings present.
  - Fake fixtures only, in `test/shots.mjs` (`:171-175`): a two-project chat and a chat with an open question.
  - Screenshots at 1440/768/390/320, light and dark, ES and EN, PT at 1440/320.
  - Deviation, on purpose: the "chip list" is an ordered list of ROWS, each row the same
    project autocomplete, with a Quitar button per row and "+ Agregar otro proyecto" below.
    Existing assertions pin the single combobox and cannot change: after choosing, the field
    `#workspace-search` shows the chosen name ("elegido, el campo muestra el nombre del
    proyecto"); a new form shows "Sin proyecto" in that field; editing a chat whose project
    was removed shows `viejo-demo` in it; `#workspace` holds the chosen id; and the empty
    list offers `['', 'alfa-demo', 'beta-demo']`. A chip input empties its field after each
    choice, so it would break the first three. With rows, row 1 is exactly the old control,
    and every other row works the same way. Keyboard: arrows and Enter choose in each row,
    the add and remove buttons are native buttons, and Backspace in an empty extra row
    removes it and moves focus up. Each row offers the catalog minus the projects chosen in
    the other rows, plus its own removed id (marked as today). "Sin proyecto" is offered only
    in row 1 when it is the only row.
  - What was built:
    - `config.html`: rows `#workspace-search` / `#workspace` (row 1) and `#workspace-more`
      (rows 2..N, `#workspace-search-N`, hidden `#workspace-N`, `[data-wsrm=N]`), with
      `#workspace-add` and `#workspace-rm`. Save writes `workspaces` (in row order, no
      repeats) and the derived `workspace`, every time. `listaDeEntrada` reads an entry with
      the CLI's rule (`lista_de_proyectos`): the list counts only when no `workspace` key is
      present or the `workspace` equals the list's derived value, else `workspace` becomes a
      one-item list. Edit loads the rows and reset goes back to one empty row. The table
      column shows `A` or `A +N` (`+N` is `aria-hidden`); the full list is in the `title`,
      and an `.sr-only` "y tambien ..." carries it for screen readers. `projectQuestion`
      (`#chat-project-question`: auto / writer / owner) is a button group, shown only with
      two or more projects. Its value is kept and saved on every save (`auto` when unset or
      invalid). New card in Su aprobacion: `projectQuestionHours` (`#pq-hours`, a whole
      number of hours from 1, default 24), read when that tab opens, like `slaMinutes`. Texts
      rewritten or added in ES/EN/PT: `scopeHelp`, `workspaceLabel`, `workspaceHint`,
      `colProject`, `workspaceAdd/Row/Remove/More`, `pq*`.
    - `activity.html`: `board.project_routes[case_id]` is read with `rutaDe`. The detail adds
      to the project line who chose it and why: the agent's reason as written; a rule as
      "el mensaje dice <pattern>", parsed from wa-scope's English `why`; and the chat's
      project, the owner's choice, or "N proyectos: el agente elige". An open question shows
      as a `.det-pregunta` box ("Esperando respuesta: ¿A o B?"), saying who was asked
      (writer, owner, or owner after the timeout) and the question text. An answered
      question says the agent chooses now; a closed one is not shown. A card with an open
      question gets a `.card-pregunta` line. Cambiar proyecto lists "Sin proyecto", then the
      chat's projects in order (group "Proyectos de esta conversacion"), then the rest of the
      catalog (group "Otros proyectos"), with `role=group` and `aria-label`. Without
      `project_routes` it is the old flat list. The request is still one `pedido.proyecto`.
      New wait reasons `no_project` and `project_question`, events `project_question`
      (writer / owner), `project_answer`, and `project [id, agent]`; `motOutside` now reads
      "fuera de los proyectos del chat". All in ES/EN/PT. `project_routes` travels inside
      `board`, so `firmaTablero` already covers it and every repaint goes through the
      existing `repintar` / `alSoltar` path.
  - Evidence: `test/panels.test.mjs`, the eight "proyectos-por-chat (M6)" sections (80
    checks). RED: 15/80 passed. There were no extra rows, add button, project question
    group, hours field or strings; the table showed `—` for list-only entries; the board
    had no reason, groups, question or new reasons. GREEN: 80/80. Full `node
    test/panels.test.mjs`: 1271/1271 (the 1191 existing checks unchanged). `check-panels`,
    `check-voseo` and `check-datos-reales` pass.
  - Screenshots (`test/shots.mjs`, fake data): `config-proyectos-varios` (the table with
    `Alfa Demo +1` / `Beta Demo +2` and the editor with two rows, one long name, and the
    project question group), `config-pregunta-horas`, `tablero-proyecto-agente` (agent's
    reason plus the grouped combo open), and `tablero-pregunta-abierta`. Each was looked at
    at 1440/768/390/320, light and dark, ES, EN and PT. One fix came from looking: at 320 a
    long project name in the board combo was squeezed to one word per line by its id, so
    under 420 px the id now goes below the name, as in `config.html`. A long name cut off
    by a row's field is readable in full in its `title`.
- [x] **M7** — Harness text (AGENTS.md, CLASSIFICATION.md, SKILL.md, the PROJECTS.md header) and the `check-harness` phrases.
  - What changed:
    - `harness/AGENTS.md`, "Reply, dispatch or escalate": a new "Which project" bullet. It
      gives the order: a matching text rule first, then the chat's only project, then
      choosing among `candidates` with `caso proyecto <id> --proyecto <pid> --actor agente
      --porque`. If still in doubt, `caso pregunta-proyecto`, and propose what its `next`
      says, because the chat's setting decides who is asked. It also says that project names
      never go to a customer unless that setting sends the question to them, and that
      `E_OWNER` means the owner's choice stands.
    - `harness/CLASSIFICATION.md`, "The content decides, not the chat": the same order. The
      agent never picks outside `candidates`, and "a rule is missing" now applies only when
      there are no `candidates`.
    - `harness/skills/whatsapp-soporte/SKILL.md`, "Handing work to a project agent": the
      three steps with the exact commands, and the customer and `E_OWNER` rules.
    - The `PROJECTS.md` header (`harness.mjs` `renderProyectos`): `candidates`, the order,
      and the two commands.
    - Only sections the plugin declares changed. The per-section fingerprint in
      `harness.mjs` (`juntar`) still keeps any section the user edited (`AGENTS.md:5-7`).
  - Evidence: `scripts/check-harness`, the new "proyectos-por-chat (M7)" block. RED: it
    failed on all four files (AGENTS.md, SKILL.md, CLASSIFICATION.md and harness.mjs were
    missing every phrase). GREEN: 66 checks (62 before), exit 0. The skill flag check also
    confirms that `--porque` and `--candidatos` are real flags of `wa-scope caso`.
    `check-voseo` and `check-prompts` pass.
- [x] **Verification fixes (on 50be84a)** — nine defects found by independent verifiers, each
  reproduced on fake data. One test per defect, in `scripts/check-casos` ("proyectos-por-chat:
  lo que encontro la verificacion", 22 checks) and `test/panels.test.mjs` (three sections
  after the M6 ones, 7 checks).
  - RED: check-casos 5/22 passed. The 5 that passed are the controls (dispatch still says it
    cannot find a removed project, a rule outside the list stays on the route, a question
    escalates after the deadline counted from the send, `auto` in the owner's own chat asks the
    writer, a `respondido` case with no question still gets `E_STAGE`). panels 1272/1277 at first,
    then 1277/1278 after the `pqHelp` check was added.
  - GREEN: check-casos section 22/22, all five proyectos-por-chat sections 79/79. panels
    1278/1278. check-harness 66, check-voseo, check-panels and check-datos-reales pass.
    Full `npm run check`, exit 0: check-casos 1312/1312 (1290 before, plus 22), panels
    1278/1278, worker 410/410, 1548 captures with no overflow, JS errors or selects.
  1. **A removed single project showed on the card** as "the conversation's project". Now
     `proyecto_de_ruta` returns `quitado` for that case. The card's `project` is null and
     `project_routes.by` is null, with the "no longer in the accepted list" reason and
     `missing`. This is what origin/main showed ("Sin proyecto"). Dispatch still names the id
     ("no encuentro el proyecto ..."), and T22.9 still waits with `outside_project`, as before.
     `porQueDelProyecto` also says nothing for `by: chat` with no project.
  2. and 8. **The agent could replace a text rule's project.** That let a later message with
     the same rule keep the agent's choice, and it turned an `outside_project` wait into a
     dispatch with no click. Now `caso proyecto --actor agente` fails with `E_OWNER` when the
     effective project came from a rule (`by == "rule"`, also derived for older routes). The
     rule is the owner's choice. AGENTS.md and SKILL.md say so, and check-harness checks the
     wording.
  3. **The A/B answer dropped Jev's exceptions.** The `pregunta` branch of `ingest_mensaje` now
     calls `caso_marca_jev`, as the joined path does. The test checks that `excepciones` stays
     `["jev"]` and that `trabajo_espera_al_dueno` then says `exceptions`.
  4. **`projectQuestionHours` counted from when the question was recorded.** Now
     `tick_preguntas_proyecto` measures from the later of `pregunta.at` and the case's last
     entry to `respondido`, which is when the question went out. An approval that came 25 h
     late sends the question, does not escalate in the same tick, and the customer's answer
     still reaches it. The M5 timeout test now also backdates that entry event. It used to
     backdate only `at`, which is the situation this defect describes.
  5. **A destination-only rule erased the agent's project.** In `caso_enruta`, a new rule that
     names no project (`by != "rule"`) keeps the agent's `workspace`, name, path, `why` and
     `by`. Only the destination and `matched` change.
  6. **The owner could not choose while a writer question waited.** In `respondido` with an
     open question to the writer, the card offers `proyecto`
     (`acciones_de(..., con_pregunta)`), and `activity.html` allows it in that stage.
     `caso proyecto --actor dueno` closes the question and moves the case back to `recibido`
     with `necesita_agente=1`. A `respondido` case without such a question is unchanged:
     `['cerrar', 'reabrir']` and `E_STAGE`. `pqToWriter` now adds "si usted ya lo sabe, elija el
     proyecto aqui" (ES/EN/PT).
  7. **`auto` sent the question to a whole group when the owner wrote there.** Now, under
     `auto`, the question goes to the writer only in the owner's own chat
     (`chat_es_del_dueno`). Any other chat, groups included, goes to the owner. An explicit
     `writer` is still the owner's choice. `pqHelp` says this in ES/EN/PT. **This changes the
     M5 expectation added on this branch** ("auto y escribe el dueno: ... para el que
     escribio", in a group). That M5 group now uses `--project-question writer` explicitly, and
     the check is renamed "writer y escribe el dueno". The `auto` group case is now pinned in
     the new section. It is not a pre-feature test, and nothing on origin/main is touched.
  9. **The Spanish `pqHoursHelp` lacked the opening `¿`.** It now reads `"¿A o B?"`, like the
     board.
  - Screenshots looked at (in `/Volumes/Data/claude-tmp/claude-501/proyectos-por-chat/fix-shots`
    and, after `npm run check`, in `WA_INBOX_CAPTURAS`): `config-pregunta-horas` ES light
    1440 (the `¿`), `tablero-pregunta-abierta` ES light 390 (the new `pqToWriter` sentence and
    Cambiar proyecto in respondido), `config-proyectos-varios` ES dark 1440 and EN light 320
    (the editor rows and the new `pqHelp`).

### B. Roles by number

- [x] **M8** — Sidecar `grupo_miembro` table and `group-participants.update`; `wa-read members`.
  - Tests in `test/almacen.test.mjs` and `test/sidecar-mensajes.test.mjs`: metadata from a fetch, add and remove events, an old store gets the table, the line's own id is excluded.
  - Baileys shapes, read in the installed 6.7.24 source (not guessed):
    - `extractGroupMetadata` (`lib/Socket/groups.js:312-319`): each participant is
      `{id, jid, lid, admin}`, `admin` = `admin | superadmin | null`.
      `groupFetchAllParticipating` returns `{jid: metadata}` and also emits it as
      `groups.update` (`:54`); Baileys refetches on the `CB:ib,,dirty` groups bit (`:57-64`).
    - `group-participants.update` (`lib/Types/Events.d.ts:80-85`, emitted at
      `lib/Utils/process-message.js:271`): `{id, author, participants: string[], action}`,
      `action` = `add | remove | promote | demote | modify`. `modify` (a number change)
      carries only the OLD number (`lib/Socket/messages-recv.js:211-214`).
  - What was built:
    - `sidecar/src/mensajes.js`: `miembrosDeGrupo(meta, esPropio)` (null when the metadata
      has no `participants`, so a partial `groups.update` touches nothing; ids without the
      device; the line's own LID/phone excluded; WhatsApp admin and superadmin are `admin=1`;
      the `{lid, pn}` pair the metadata carries) and `cambioDeMiembros(evento, esPropio)`
      (add/remove/promote/demote; `modify` ignored until the next fetch; participants read
      as strings or `{id}`; `salioLaLinea` when the line itself is removed).
    - `sidecar/src/almacen.js`: table `grupo_miembro(account, chat_jid, member_jid, admin,
      updated_at)`, primary key `(account, chat_jid, member_jid)`, in `ESQUEMA` (`create table
      if not exists`, so an old store gets it on open; `ESQUEMA_VERSION` unchanged, so an
      older `wa-read` keeps reading). `reemplazarMiembros` (a fetch replaces the group's
      list), `cambiarMiembros` (promote/demote of an unknown member adds it; the line
      removed clears the group's list), and `lote` (one transaction per fetch batch).
    - `sidecar/src/ingesta.js`: `ingerirMiembros` (also writes the metadata's LID-phone pair
      to `lid_telefono`) and `ingerirCambioDeMiembros`.
    - `sidecar/src/index.js`: the fetch result, `groups.upsert`, `groups.update` with
      `participants`, and `group-participants.update` feed it, even for chats in `off`
      (bookkeeping, like `chat`). Ids only, never a body. `sidecar/sidecar.cjs` rebuilt.
    - `wa-read members --chat <jid|id|name> --json` (`wa_store.miembros`): see "Part B data
      contract" below.
  - Evidence:
    - RED: `node test/sidecar-mensajes.test.mjs` and `node test/almacen.test.mjs` failed to
      load (`does not provide an export named 'cambioDeMiembros'` / `'ingerirCambioDeMiembros'`).
      With the sidecar side in place, `almacen.test.mjs` was 288/298: the 10 `wa-read
      members` checks failed with `invalid choice: 'members'`. The new `check-clis`
      `revisa_miembros`, run against an untouched HEAD worktree, failed (no
      `ingerirMiembros`).
    - GREEN: `sidecar-mensajes` 112/112 (13 new), `almacen` 300/300 (30 new: the table's
      columns, a fetch, each event, a refetch replacing the list, other groups and other
      lines untouched, an old store getting the table, `members` on a store without the
      table, the line excluded even when a row exists, a direct chat, an unknown chat exits
      1). `check-clis` 329 checks (327 + 2), exit 0. `sidecar-pairing` 88/88,
      `sidecar-build` 5/5, `check-datos-reales` pass.
- [x] **M9** — `chat_scope.miembros`, panel `members`, `set --member`, the `groupMembers` push, `wa_store.rol_de`, `rol_del_caso`.
  - Tests:
    - a global owner is admin in every chat;
    - a group operator is client in another chat;
    - LID and phone match only through a `lid_telefono` pair;
    - mixed senders give the lowest role.
  - What was built (the full contract is in "Part B data contract" below):
    - `bin/wa_store.py`: `ROLES`, `id_de_persona`, `rol_menor`, `rol_de`, and the
      `companeros_de` pair lookup (shared with `wa-read members`).
    - `bin/wa-scope`: the `chat_scope.miembros` column (DDL, `migrate`, `CHAT_SCOPE_COLS`).
      `merged_scope`, `persistir_panel` and `push_to_plugin` handle `members` as they handle
      `approval`. Also `set --member` (`miembros_pedidos`), `build_group_members` (pushed as
      `groupMembers` on every sync with activity), `miembros_por_chat`, `rol_del_caso`, and
      `remitentes_en`, which `caso_del_dueno` now shares with `rol_del_caso` (same query,
      same result).
    - Owner decision (1), as the "Part A limitation" asked of Part B:
      `cmd_caso_pregunta_proyecto` under `auto` asks the writer in the owner's own chat (as
      before) or in a DIRECT chat whose `rol_del_caso` is `admin`/`operator`. In a group it
      asks the owner, whatever the roles. An explicit `writer`/`owner` is unchanged.
    - Not changed here (M10): ingest's `de_dueno`, Jev's `from`, `piso_de_entrada`,
      `frenos_de_regla`, `wa-send`, the brief. `caso_del_dueno` keeps its behaviour for its
      existing callers.
  - Evidence:
    - `scripts/check-clis`, `revisa_roles`. RED: 33 of 33 failed (`sin columna`, no
      `members` merged or pushed, no `groupMembers`, `--member` unknown to argparse, no
      `wa_store.rol_de`). GREEN: 33/33. The 17 `rol_de` cases:
      - a global owner is admin in a chat with no roles, in one where he was marked
        operator, and with a device suffix;
      - a group operator is operator there and client in another chat, or in a chat with
        no entry;
      - an owner stored by phone who writes with his LID, and an operator stored by LID who
        writes with his phone, match through the pair;
      - with no pair, a LID with the same digits as the owner's phone is client;
      - a pair from another line, or no store at all, matches nothing;
      - in a direct chat with no sender, the writer is the chat; in a group with no sender,
        client;
      - an unknown stored role gives nothing;
      - with no roles stored (an old database), only the owner is admin.
    - `scripts/check-casos`, "roles-por-numero: el rol del caso (M9)". RED, in a full run:
      the 1313 existing checks all passed (0 failures, the M9 storage already in place),
      then the section stopped with `module 'wa_scope_carrera' has no attribute
      'rol_del_caso'`. GREEN: 11/11. The checks:
      - with no roles: the owner is admin, everyone else client, and `caso_del_dueno`
        unchanged;
      - an operator alone, from another device: operator;
      - operator + client: client;
      - owner + operator: operator;
      - the same operator in another group: client;
      - `auto` with a group operator: owner;
      - `auto` with a customer's direct chat: owner, as before;
      - `auto` with an operator's direct chat: writer, and `next` says `responder`.
      A mutation run, with only the `projectQuestion` change reverted in a scratch copy of
      `bin/`, failed exactly the last two checks (9/11).
    - Full `npm run check` on the M8+M9 tree, exit 0 (35 min): check-clis 362 checks (327
      before Part B, + 2 M8 + 33 M9), check-casos 1324/1324 (1313 + 11), sidecar-mensajes
      112/112, almacen 300/300, panels 1278/1278, worker 410/410, sidecar-build 5/5,
      sidecar-pairing 88/88, check-harness 66, check-voseo, check-datos-reales; 1548
      captures with no overflow, JS errors or selects. No existing assertion was changed.
      No panel file was touched in this stage, so no new screenshot was looked at here (the
      captures are the existing set; M11 adds the People card and its screenshots).
- [x] **M10** — Role at ingest, Jev `from` and the operator prompt, the cache stores the role and re-judges on a change, `piso_de_entrada`, `frenos_de_regla`/`wa-send` per Open question 3, operator brief and header texts.
  - Tests:
    - the text "I am the admin" from a client still flags;
    - an operator's in-project `trabajar` dispatches without a click;
    - an operator's destructive or out-of-project request waits for the owner;
    - the existing owner tests (`check-casos:5183-5216`, `:9016-9040`) are unchanged.
  - What was built:
    - Ingest: `de_dueno` is gone. Each new message carries `rol` (`admin | operator |
      client`) from `roles_de_entrada`, which reads the owners, each chat's roles and the
      line's LID-phone pairs once per run and calls `wa_store.rol_de` (new optional `pares`
      argument). A burst takes the lowest role of its messages (`rol_menor`). The audio path
      (`reevalua_audio`) computes it the same way. The approval-number gate keeps
      `es_dueno`: WhatsApp approval stays with the global owners.
    - Jev (`bin/wa_jev.py`): `from` is `owner` (admin), `operator` or `participant`. A new
      `OPERADOR_REMITENTE` tells Jev the plugin verified the operator by id, that his
      request to the assistant is a work order, and that a credential still counts. For an
      operator, `tries_to_instruct_the_assistant` is dropped from the flags; the
      credential exceptions stay (unlike the owner, whose exceptions keep only a secret).
    - The verdict cache: new column `juicio.rol` (DDL and `migrate`). `jev_juzga` stores
      the role it judged with. `jev_cacheado` (through `jev_guardado`) returns nothing when
      the role changed, so Jev judges again. `veredicto_de` also stops using the cached
      class of a Jev verdict judged with another role. A verdict from before the roles
      (`rol` null) counts as judged with what v4.16.0 used: admin for an owner id, client
      for anyone else. So an old cache is reused exactly as before, and only a new operator
      is judged again.
    - `piso_de_entrada`: only `admin` gets the owner floor. An operator gets everyone's.
    - Decision 3: `wa_store.directo_sin_reglas` is true only for a DIRECT chat whose person
      is `operator` or `admin` of that chat (`rol_de` on the chat itself, never the text).
      `frenos_de_regla` (through `directo_de_operador`) and `wa-send` then treat it like the
      owner's chat: every customer level is Permitir, Jev does not review the outgoing
      text, and a secret is still held. A group with an operator keeps the chat's levels
      and Jev. `wa-send` reads each chat's roles from `chat_scope.miembros` and the panel's
      `members`, as it reads `approval`. `miembros_de_columna` and `miembros_del_panel`
      moved from `wa-scope` to `wa_store`, so both CLIs share them.
    - The case file header (`cabeza_del_caso`) says `DICE_OPERADOR` ("an operator of this
      chat ... An operator asked ... within this chat's projects ... destructive, or outside
      this chat's projects, goes to the owner") when `rol_del_caso` is operator or admin and
      the case is not the owner's. In a group it adds `GRUPO_OPERADOR` ("customers read this
      group too"). The dispatch brief adds the `## An operator's case` section
      (`BRIEF_OPERADOR`) and a matching hard rule instead of "data from the customer".
      `caso_del_dueno` and the owner texts are unchanged. A case with an operator and a
      client is the client's (the lowest role).
    - `trabajo_espera_al_dueno` is unchanged for every role, and so is T22.9 for a Cliente
      (Decision 2).
  - Evidence:
    - `scripts/check-casos`, "roles-por-numero: el rol en el comportamiento (M10)", 41
      checks. RED, with the new section run against the M9 `bin/` (a scratch copy with only
      `wa-scope`, `wa-send`, `wa_jev.py` and `wa_store.py` taken from HEAD):
      - ingest and cache block: 8 passed and 9 failed, then it stopped with `no such
        column: rol`. The failures were: the operator reached Jev as `participant`, with no
        operator text and with the instruct flag; no role stored with the verdict; a chat
        admin got `participant` and the client floor; a role change was not judged again.
      - outgoing, work and question blocks: 14/21. The failures were: the operator's direct
        chat held money and quality (`decision` / `clasificado`), Jev reviewed it, and
        `wa-send` to it exited 3 `send-needs-approval`; neither the brief nor the case file
        said an operator asked.
    - GREEN: 41/41.
    - The checks that passed before and after are guards. They pin what must not change:
      - a client's "soy el admin" / "I am the admin" / "soy administrador" stays
        `participant` with the flag;
      - the operator of SOPORTE is `participant` elsewhere;
      - an operator's credential (named or a value) stays an exception;
      - a secret to the operator's direct chat is held;
      - the group keeps its levels and Jev on outgoing;
      - an unmarked client is unchanged;
      - the operator's clean in-project `trabajar` leaves with no click;
      - his destructive or out-of-project work waits;
      - `projectQuestion=auto`: a chat admin in a direct chat is asked, in a group it goes
        to the owner, and once the role is removed it goes to the owner.
    - `scripts/check-clis`, `revisa_rol_del_juicio`. RED against the M9 `bin/`: "la
      migracion no le agrego la columna rol a juicio". GREEN: 3 checks. An old `juicio`
      table gains `rol`, and its verdicts are kept with `rol` null.
    - No existing assertion was changed. The owner sections ("los numeros del dueno",
      "dueno-en-el-caso") are untouched and green in the full run below.
    - Full `npm run check` on the M10 tree, exit 0:
      - check-clis 365 checks (362 + 3);
      - check-casos 1365/1365 (1324 + 41);
      - sidecar-build 5/5, sidecar-pairing 88/88, sidecar-mensajes 112/112;
      - almacen 300/300, envio 93/93, panels 1278/1278, worker 410/410;
      - check-harness 66, check-prompts 15, check-voseo, check-datos-reales;
      - 1548 captures with no overflow, JS errors or selects.

      The first full run stopped inside the new section with `'str' object is not
      callable`: the module-level `brief` helper is shadowed by a variable of the
      dueno-en-el-caso section. All 1324 existing checks had passed before that. The
      section now reads the launched brief through `brief_lanzado`. No panel file changed,
      so no new screenshot applies to M10.
- [x] **M11** — The panel "People" card for direct chats and groups, with the read-only global owners, in ES/EN/PT.
  - `panels.test.mjs`: save and load of `members`, no `<select>`.
  - Screenshots at the four widths, both themes.
  - What was built (`config.html`, the per-chat editor):
    - A "Personas y roles" block (`#people-wrap`) after the projects. It is hidden until a
      chat is chosen and shows only for a chat of people.
    - **Direct chat:** one row for the chat's person (name, and phone when known), with a
      Cliente / Operador / Super admin button group: `role=group`, an `aria-label` "Rol de
      <name>", native buttons with `aria-pressed`, and the existing `focus-visible` ring.
    - **Group:** one row per participant from `groupMembers[jid]`. A row has the name, or the
      phone when there is no name, and the phone below. A search field (`#people-search`, with
      a label) filters by name, phone digits or id and says "N de M". "Nadie del grupo coincide
      con eso" when nothing matches. A saved role whose id is no longer in the list stays as a
      row, marked "ya no esta en esta conversacion", so saving never drops it silently.
    - **Empty or missing list:** "Todavia no hay lista de participantes de este grupo. Llega
      cuando el plugin sincroniza ..." (`#people-empty`). Roles already saved still show.
    - **Global owners** (`owners`, by exact id since the verification fixes; before, also by
      the phone the list carries): a read-only "Super admin" badge, "Numero de
      confianza: Super admin en todas las conversaciones", and a "Se cambia en Su aprobacion"
      button that opens that tab at the owners card. The line's own chat is also read-only.
    - **Help text:** the role comes from the number and never from a message, and it holds
      only in this chat. It says what Operador and Super admin mean, that a direct chat skips
      the customer rules (a secret is still held), and that in a group customers read
      everything, so the customer rules and Jev stay.
    - **Save** writes `members: [{id, name, role}]` on every save, in list order. Client
      entries are omitted, and so are global owners unless the CLI stored a role for them, in
      which case it is kept unchanged. A chat with no roles writes `[]`, which the CLI treats
      as no roles, exactly like v4.16.0. Edit loads `scope[jid].members`, Cancel and a new
      form reset it, and picking a chat that already has roles in the new form loads them,
      so saving over it does not wipe them.
    - `pqHelp` (ES/EN/PT) now also says that `auto` asks the writer in the direct chat of an
      Operador or Super admin (the M9 rule). Its existing assertions still pass unchanged.
    - New strings `people*` and `role*` in ES, EN and PT. PT is explicit; "Super admin" is the
      same word in all three.
  - Deviation, on purpose: `groupMembers` is NOT in the full reload (`CLAVES`). Adding it
    broke the existing "el clic contra el cupo del host" check: one more read in the full
    reload pushed the user's click over the host's 30-messages-per-10-s budget. It is read
    instead when a group is open in the editor, and again on each reload while it stays
    open: one read, and only then. That is also how a just-authorised group's list shows up
    without reopening. The rows repaint only when what they show changes, so the poll never
    takes focus away from a role button.
  - Evidence: `test/panels.test.mjs`, seven "roles-por-numero (M11)" sections. They cover the
    direct chat, the owner's direct chat, a group with search and save order, an empty group
    with and without the key, a list that arrives after opening, the strings in ES/EN/PT, and
    the EN and PT role labels.
    - RED: 1279/1299. All 20 failures were in the new sections (no `#people-wrap`, no
      strings, `pqHelp` without Operador). The 1278 existing checks passed.
    - GREEN: 1329/1329, of which 51 checks are new. On the way, two existing checks failed
      and were fixed in the code, not in the tests. A code comment contained the literal
      `<select`, which the T17 file guard caught. `groupMembers` in `CLAVES` broke the budget
      check; it is now read lazily, as described above.
    - Screenshots (`test/shots.mjs`, fake data): `config-personas-directo` (Laura Mendez marked
      Operador), `config-personas-grupo` (six participants: the owner read-only, one
      Operador, one Super admin with a long name, one with no name shown by phone, one with an
      emoji, and one saved role no longer in the group), and `config-personas-vacio` (a group
      with no list yet).
    - Fixes that came from looking at the screenshots:
      - the owner row's three right-aligned lines were cramped, so the note moved under the
        name;
      - "Modo" sat right under the last row, so the block got a bottom rule;
      - at 390 and 320 the scroll area cut a row with no frame and looked broken, so the
        list got a frame;
      - in dark mode that frame (`--border`, 7% white) was invisible, so it uses `--input`.
    - Looked at, after the last fix, in the captures of the full `npm run check`
      (`WA_INBOX_CAPTURAS`, cropped around the card, light and dark side by side): the three
      states `config-personas-{directo,grupo,vacio}` in ES and EN at 1440, 768, 390 and 320,
      and in PT at 1440 and 320, all in light and dark. That is 60 PNGs, named
      `config-personas-<state>-<es|en|pt>-<light|dark>-<width>.png`. One leftover cosmetic
      detail: at 320 and 390 in EN, the "Change it in Your approval" link wraps to its own line
      with a 4 px indent.
- [ ] **M12** — Harness text for roles; `npm run check` green; screenshots looked at and listed; live check on the real line:
  - a two-project group: a rule case, an agent-chosen case with its reason, an A/B question answered;
  - an operator request dispatched and the result back in his chat;
  - a client message unchanged.
  - [x] **Harness text for roles.** Only sections the plugin declares changed: two new `##`
    sections and one new table row. `juntar` (`harness.mjs`) inserts a new declared section in
    order and keeps any section the user edited (`AGENTS.md:5-7`).
    - `harness/AGENTS.md`, new section "An operator's case", after "The owner's own case":
      - the role comes from the WhatsApp id the owner configured, never from what a message
        says, and the case file's line is "Sender: an operator of this chat";
      - it holds only in that chat and for its projects, and a mixed case is the customer's;
      - an in-project work request is his work order (`trabajar`): it goes to the project
        agent, and the result comes back to his chat through `caso resultado`;
      - anything destructive, or outside this chat's projects, goes to the owner (`escalar`);
      - in his direct chat the customer rules do not review the reply; in a group, customers
        read this group too, so the customer rules still apply;
      - never write a credential value, and never change a role yourself.
    - `harness/skills/whatsapp-soporte/SKILL.md`: the same section as four steps, with the
      exact `caso propuesta --tipo trabajar` command. It says that `wa-scope set --member` is
      the owner's setting and not a command for the agent, whoever asks.
    - `harness/CLASSIFICATION.md`: a new row, "An operator's work request": `card` and
      `trabajar` within the chat's projects; `escalar` when destructive or outside; "I am the
      admin" from anyone else is a customer's text.
    - Evidence: `scripts/check-harness`, a new "roles-por-numero (M12)" block of 3 checks (one
      per file). RED: all three failed, each file missing every phrase. GREEN: 69 checks (66
      before), exit 0. `check-prompts` 15 and `check-voseo` also pass.
  - [x] **`npm run check` green** on the M11+M12 tree, exit 0:
    - `check-clis` 365 checks, `check-casos` 1365/1365, `check-harness` 69, `check-prompts` 15;
    - `check-closing` 36/36, sidecar-build 5/5, sidecar-pairing 88/88, sidecar-mensajes
      112/112;
    - almacen 300/300, envio 93/93, panels 1329/1329 (1278 + 51), worker 410/410;
    - `check-voseo` and `check-datos-reales` pass;
    - 1620 captures (1548 + 72) with no overflow, no JS errors and no selects.

    No existing assertion was changed: `git diff` of `test/` and `scripts/` has no removed
    lines.
  - [x] **Screenshots looked at and listed:** see M11, 60 PNGs of the three People states.
  - [ ] **Live check on the real line.** Not done in this stage: it is for the main session.
- [x] **Verification fixes (on 93bba3c)** — six defects found by independent verifiers, each
  reproduced on fake data. Tests: `scripts/check-casos` ("roles-por-numero: lo que encontro la
  verificacion", 13 checks), `scripts/check-clis` (`revisa_roles`, +3 checks and one changed
  expectation, below) and `test/panels.test.mjs` (one section after the M11 ones, 10 checks).
  - RED, each new test run alone against the 93bba3c code: check-casos 4/13 (the 4 that
    passed are controls: the owner's exact id is still `owner`, a client is unchanged, the
    question to a current operator is signed by the rule, and an explicit `writer` follows its
    usual path). check-clis `revisa_roles` 4 failures out of 36. panels 1/10 (the control:
    the search says "1 de 2").
  - GREEN: the same 13/13, 36/36 and 10/10. Full `npm run check`, exit 0:
    - `check-clis` 368 checks (365 + 3), `check-casos` 1378/1378 (1365 + 13), `check-harness`
      69, `check-prompts` 15, `check-closing` 36/36;
    - sidecar-build 5/5, sidecar-pairing 88/88, sidecar-mensajes 112/112, almacen 300/300,
      envio 93/93, panels 1339/1339 (1329 + 10), worker 410/410;
    - `check-voseo`, `check-datos-reales`, `check-panels` pass; 1620 captures with no
      overflow, JS errors or selects.
  1. and 2. **The owner's other id became admin through the LID-phone pair.** `rol_de`
     expanded the sender with `companeros_de` and returned admin when any paired id was an
     owner, while `es_dueno`, `chat_del_dueno`, `caso_del_dueno`, the approval gate and the
     `jev_guardado` fallback match the exact id. M8 writes a pair for every group participant,
     so after the upgrade the owner's case became half owner, half "operator": Jev `from`
     `owner`, `juicio.rol` admin, his direct chat by phone without the customer levels, the
     header and brief `DICE_OPERADOR`/`BRIEF_OPERADOR` ("the owner named this number operator
     or admin here", false), and the `auto` question to the writer. Now `rol_de` checks the
     global owners with `es_dueno` on the sender's own id, before any pair; the pair is used
     only for the per-chat roles. A chat with no roles is again exactly v4.16.0. The panel
     follows the same rule: `esDuenoGuardado` matches the exact id only, so a participant who
     only shares the owner's phone through the pair is a normal row the owner can mark.
     **This changes one `rol_de` expectation added on this branch in M9** ("el dueno guardado
     por telefono escribe con su LID: el par lo une", `admin`): it now expects `client`, as
     v4.16.0. It is not a pre-feature test, and nothing on origin/main is touched. Two cases
     were added: his direct chat by LID is `client`, and a per-chat role saved for his phone
     id still reaches his LID through the pair (`operator`).
  3. **`wa-scope set --member` brought back a role removed in the panel.** It started from the
     `chat_scope.miembros` column, which only catches up with the panel on the next sync, and
     then overwrote the panel's `members` with that list. Now it starts from `merged_scope`
     (the panel's list wins). check-clis: the panel clears the roles, then `set --member` with
     another person leaves only that person, in the database, in `list` and in the panel.
  4. **A question routed to the writer stayed with him after the owner removed his role.**
     The recipient was decided once, when the question was recorded. Now `para_de_pregunta`
     holds the routing rule, and `pregunta_del_dueno` re-checks it each time a reply or an
     update would go out: a question stored with `a: writer` is the owner's when the rule no
     longer says `writer`. `frenos_de_regla` then holds the reply with `project_question`
     (the rule does not sign it, `E_EXCEPTION`), and `avance_frena` refuses an update. With
     the role still in place, or with an explicit `writer`, nothing changes.
  5. **The search count's live region was `display: none` while empty**, so it entered the
     accessibility tree in the same update as its first text. It is now always rendered
     (`#people-count:empty { margin: 0; }`, zero height when empty). The panels test reads
     the computed `display` before the first search.
  6. **The empty-group text asked the owner to save a group that was already saved.** A group
     being edited, or already in the scope, now says `peopleGroupPending` ("Aparece sola
     cuando el plugin la recibe de WhatsApp y sincroniza: no hace falta guardar de nuevo",
     with EN and PT). A group picked in the new form and not saved yet keeps `peopleGroupEmpty`.
  - Screenshots looked at (cropped around the card, in
    `/Volumes/Data/claude-tmp/claude-501/roles-por-numero/fix-shots`, from the
    `WA_INBOX_CAPTURAS` of the full run): `config-personas-vacio` ES light 1440, ES dark 320,
    EN light 320 and PT dark 1440 (the new text, no "save it"); `config-personas-grupo` ES dark
    1440 and EN light 320 (the owner by exact id still read-only, the search field and the list
    with no extra gap from the always-rendered count).

## Acceptance

1. A chat saved before this feature with one `workspace` routes, dispatches, reports and shows exactly as before. All existing `check-casos`, `check-clis`, panels and worker tests pass unchanged.
2. A chat with projects `[A, B]`:
   - a text-rule match uses the rule's project;
   - otherwise the agent sets A or B with a written reason, visible on the card;
   - otherwise a question goes to the writer or to the owner, per `projectQuestion`. Its answer lands in the same case and the agent then sets the project.
3. The card's project is always the project dispatch would use. "Sin proyecto" chosen by the owner never dispatches.
4. Work in A or B with no destructive content dispatches with no click (T22.9). A project outside `[A, B]`, or no project, waits for the owner with a stated reason.
5. A number marked Operador in group G:
   - is treated as operator only in G and only for G's projects;
   - his in-project requests reach the project agent, and the result returns to G;
   - destructive or out-of-scope requests reach the owner.

   A global owner is Super admin in every chat. Nobody's role changes because of what a message says.
6. A Cliente never receives a project question, a project name or a result that the owner has not authorized through the chat's approval path. This holds under the default `projectQuestion=auto`.
7. Everything in the panel, both editors and the board is available in ES, EN and PT and in both themes, and was looked at in screenshots at 1440/768/390/320.

## Checks

- Strict TDD per task: watch it fail (RED), then make it pass (GREEN). Each task closes with a Conventional Commit on a feature branch.
- `npm run check` (`package.json` `scripts.check`). That covers check-panels, check-voseo, check-datos-reales, check-harness, check-clis, check-casos, the node tests and `npm run shots`.
- Fake data only in tests and fixtures, using the allowlisted values in `scripts/check-datos-reales`.
- Screenshots kept in the capture folder (`WA_INBOX_CAPTURAS`) and listed by state, width, theme and language.
- Live check on the real line (M12) before closing. Anything not verified live is reported as such.

## Decisions (2026-10-05)

The owner approved T22.7 and T22.8 and asked for this feature after v4.15.1. The three questions the requirements left open were settled with the safe default. Each one follows the owner's standing rule that customers never get data without his authorization.

1. **Who gets "A or B?"** It follows `projectQuestion=auto`. An Operador or Super admin is asked directly. A Cliente's case asks the owner, because asking a customer reveals project names. The owner can set a chat to `writer` or `owner`.
2. **No-click work (T22.9) for a Cliente.** It stays as today: any sender's in-project, non-destructive `trabajar` dispatches. There is no regression and no new toggle.
3. **Customer rules for an Operador.** They are skipped only in a direct chat with the operator. In a group, which customers also read, the chat's levels and Jev stay. The secret floor applies everywhere.

## Part A backend contract (M1–M5, for the Panels and Harness stages)

What the backend reads and writes, so the panels can be built against it without reading
`bin/wa-scope`. Everything here is on the branch and covered by `scripts/check-clis`
(`revisa_varios_proyectos`) and `scripts/check-casos` (the "proyectos-por-chat" sections).

### Storage keys the panel writes and reads

- `scope[jid].workspaces: string[]` — the chat's projects, in order (the first is listed
  first). Ids that do not have the shape of an id are dropped, and repeats are removed.
- `scope[jid].workspace: string | null` — kept and derived: the only id when the list has
  exactly one, else null. **The panel must write both keys on every save**: `workspace`
  set to the derived value. The CLI trusts the list only when the `workspace` stored next
  to it is its derived value (`lista_de_proyectos`). Otherwise an older panel edited
  `workspace` and left a stale list, and `workspace` wins as a one-item list. The same
  rule protects the database from an older CLI that writes only `workspace`. An entry
  with `workspaces` and no `workspace` key is also accepted, and then the list wins.
- `scope[jid].projectQuestion: "auto" | "writer" | "owner"` — who gets "A or B?". Any
  other value is `auto`. The sync pushes it back as a string, `auto` when unset.
- `projectQuestionHours: string` — a global flat key, a whole number > 0, factory `"24"`.
  The panel value wins over the CLI value, like `slaMinutes`, and an invalid value is
  ignored. The sync pushes it back.
- `projects` (the accepted catalog) is unchanged. An id in a chat's list that is no longer
  in the catalog stays in the list. The panel marks it as removed, as it does today.

### Database and CLI

- `chat_scope.workspaces` (JSON array) and `chat_scope.pregunta_proyecto` (text,
  null = auto). Both columns are added by `migrate`. The list is backfilled once with
  `[workspace]`, or `[]` when there is no workspace.
- `wa-scope set <chat> --workspaces a,b` (`''` clears the list). Every id is checked
  against the catalog. `--workspace X` is a one-item list. `--project-question
  auto|writer|owner` sets who gets the question.
- `wa-scope list`, `check` and `voice` return `workspaces`, and `voice` also returns
  `project_question`.
- `wa-scope where` returns:
  - `candidates: [{id, name, note}]`, the chat's accepted projects in list order;
  - `missing: [id]`, the ids in the list that are not in the catalog;
  - `by: "rule" | "chat" | null`.
  With two or more candidates and no rule, it returns `workspace: null` and `workspace_why:
  "the chat has N projects: the agent chooses by content"`.
- `wa-scope config project_question_hours <n>` sets the global wait.
- `wa-scope caso proyecto <id> --proyecto <pid> --actor agente --porque "<why>"`:
  - `--porque` is required;
  - the id must be one of the chat's candidates;
  - the call fails with `E_OWNER` when the owner already chose the project, by hand or
    with a text rule (the effective `by` is `rule`).
  It writes `by: "agent"` and the reason, and it does not freeze the route. With `--actor
  dueno` it works as before, plus `by: "owner"`. Either choice closes an open question.
  In `respondido` with an open question to the writer, the owner (not the agent) can also
  choose: the question closes and the case goes back to `recibido` for the agent. The card
  then offers `proyecto` in `respondido`, and only then.
- `wa-scope caso pregunta-proyecto <id> --candidatos a,b --texto "<question>" --actor
  agente` records the question. It fails with `E_ARGS` for fewer than two candidates, an
  id outside the chat's projects or an empty text, and with `E_OWNER` when the owner
  already chose. The output row carries `next`, which tells the agent what to propose: a
  `responder` with the question for the writer, or an `escalar` for the owner.
- The new error code `E_OWNER` is in `ERRORES_CASO`. It is not added to `acciones.mjs`,
  because the panel only calls with `--actor dueno` and never gets it.

### The card (`board.cards[]`)

- `project: {id, name} | null` keeps its shape. It is now the **effective** project,
  the one dispatch uses (`proyecto_de_ruta`):
  - the case route's project;
  - else none, when the owner chose "Sin proyecto";
  - else the chat's only project, when the owner still has it in the catalog (a removed one
    shows none, as before; dispatch still says it cannot find it);
  - else none.

  A case of a one-project chat whose route has no project now shows the chat's project,
  which is what dispatch has always used. The owner's "Sin proyecto" now shows none and
  never dispatches.
- New board-level map `board.project_routes`, keyed by the case id as a string, one entry
  per card:

  ```json
  {"12": {"why": "string | null", "by": "rule | chat | agent | owner | null",
          "candidates": [{"id": "alfa-demo", "name": "Alfa Demo", "note": "Tienda en linea"}],
          "missing": ["beta-demo"],
          "question": null}}
  ```

  `question`, when there is one, is `{"candidates": [{"id", "name"}], "to": "writer |
  owner", "text": "...", "at": "ISO", "state": "open | answered | closed", "escalated":
  bool}`.

  It lives on the board, not on the card, because two existing `check-casos` assertions
  pin the card:
  - "la tarjeta trae exactamente las llaves del contrato" pins the card's key set
    (`LLAVES_TARJETA`);
  - "la tarjeta lo trae con su nombre" pins `project == {"id", "name"}`.

  Neither could change, so neither new fields in `project` nor a new card key were
  possible. A board-level map leaves both untouched. It also covers a two-project case
  with no project, whose `project: null` could not carry the candidates.
- New event codes in `events[].que`:
  - `project` with `args [id, "agent"]` when the agent chose; the owner's choice keeps
    `args []`;
  - `project_question` with `args ["writer"]` or `["owner"]`, which covers both the
    question and its move to the owner;
  - `project_answer`, when the writer's answer came back.
- New wait reasons (event `work_waits` args, and the notice texts): `no_project` (es "no
  tiene proyecto", en "it has no project") and `project_question` (es "la pregunta de
  proyecto es suya", en "the project question is yours"). `outside_project` now reads
  "queda fuera de los proyectos del chat" / "it is outside the chat's projects". The board
  (`activity.html:2107`) needs `no_project` and `project_question` in its reason map, in
  ES, EN and PT.

### Part A limitation: the sender role (Part B replaces it)

**Replaced in Part B (M9, confirmed in M10).** `cmd_caso_pregunta_proyecto` no longer
decides `auto` with `chat_es_del_dueno` alone. Under `auto` the question goes to the writer
in the owner's own chat, or in a DIRECT chat whose `rol_del_caso` is `admin` or `operator`.
In a group it stays with the owner, whatever the roles (owner decision 1, and Decision 3:
customers read the group). An explicit `projectQuestion=writer` still asks the writer, in a
group too. Pinned by "roles-por-numero: el rol del caso (M9)" and "... el rol en el
comportamiento (M10)" in `scripts/check-casos`. The text below is the Part A record.

`projectQuestion=auto` needs the sender's role, and the roles arrive with Part B (M9,
`rol_del_caso`). Until then the role is binary and comes only from the WhatsApp id, and
only the chat decides it:

- the owner's own chat (`chat_es_del_dueno`: his direct chat or the line's chat with
  itself) → `writer`;
- anything else, a group included even when the owner wrote there → `owner`.

So an Operador is treated as a Cliente: his "A or B?" goes to the owner. That is the safe
side, because nothing goes to the chat. Part B replaces the `chat_es_del_dueno` call in
`cmd_caso_pregunta_proyecto` with `rol_del_caso`: `admin` or `operator` then means `writer`
in a direct chat. In a group the question stays with the owner under `auto` (customers read
the group, Decision 3), unless Part B's Open question 3 decides otherwise with the owner.
An explicit `projectQuestion=writer` is the owner's choice and still asks the writer in a
group.

Until the verification fixes, `auto` used `caso_del_dueno` (every message from an owner id),
so an owner writing in a group was asked in the group, where customers read the project
names, and the reply was signed by the rule in `responder` mode. That is closed.

`caso avance` (Beta progress updates) is held as well while a question is with the owner:
`avance_frena` refuses it with `E_EXCEPTION (project_question)`. RED: the update "Estamos
revisando lo de Alfa Demo." went out to the customer's group (check-casos 1310/1313).
GREEN: check-casos 1313/1313.

## Part B data contract (M8–M9, for the Panels and Behaviour stages)

What the data layer of Part B stores, reads and pushes. Everything here is covered by
`test/almacen.test.mjs`, `test/sidecar-mensajes.test.mjs`, `scripts/check-clis`
(`revisa_miembros`, `revisa_roles`) and `scripts/check-casos` ("roles-por-numero: el rol
del caso (M9)").

### Roles

- Three values, lowest to highest: `client`, `operator`, `admin` (`wa_store.ROLES`). Only
  `operator` and `admin` are ever stored. `client` means "no role" and is never written.
- A global owner (`duenos()`, the panel's `owners`) is `admin` in every chat, whatever a
  chat's list says, by his EXACT id, the same rule as `es_dueno`, `chat_del_dueno` and
  `caso_del_dueno`. A `lid_telefono` pair never makes his other id an owner: with no roles
  saved, every chat behaves as v4.16.0 (the owner or anyone else). To give that other id a
  role in one chat, the owner marks it there like anyone else. WhatsApp approval stays with
  them: `es_dueno` and `numero_aprobacion` are unchanged.
- Any other number has the role the owner saved for THAT chat, and only there.
- WhatsApp's own group admin flag (`wa_admin`) is information only. It never gives a role.

### Storage keys the panel writes and reads

- `scope[jid].members: [{id, name, role}]`. These are the roles of that chat's people:
  - `id` is a person's WhatsApp id without the device: `<digits>@lid` or
    `<digits>@s.whatsapp.net`;
  - `role` is `operator | admin | client`;
  - `name` is only for display.

  It is merged, persisted and pushed like `approval`:
  - when the key is a list, it wins, and an empty list clears the roles;
  - an entry without the key (an older panel) keeps the database value;
  - `role: client`, an unknown role and an id that is not a person (a group, a name, a
    typed number) are dropped when saving.

  The sync always pushes it back as a list, `[]` when nobody has a role. The list keeps
  the panel's order, then any others sorted by id. Each `name` is the one the panel had,
  else the one from `groupMembers`, else `""`. The global owners are not added to it. The
  panel shows them read-only from `owners`.
- `groupMembers: {jid: [{id, name, phone}]}` is a global flat key that `wa-scope sync`
  writes next to `senders`, on every sync with activity (not only when WhatsApp changed).
  It covers the GROUPS in the active line's scope, and only those. It holds:
  - `id`, without the device;
  - `name`, from the member's latest `sender_name`, else the name of their direct chat (the
    contacts), else `""`;
  - `phone`, `+E.164` from the id itself or from a `lid_telefono` pair, else `null`.

  The line itself is never listed. The list is sorted by name, with unnamed members last,
  then by id. With no message store the value is `{}`. A direct chat has no entry: its
  person is the chat itself (`chats[].jid`, `name`, `phone`).

### Database and CLI

- `chat_scope.miembros` holds JSON `{id: "operator" | "admin"}`. `migrate` adds the
  column, and null means nobody has a role. It is in `CHAT_SCOPE_COLS`.
- `wa-scope list` returns `miembros` as that object (`{}` when empty).
- `wa-scope set <chat> --member <id>=operator|admin|client` is repeatable. `client` removes
  the entry. An id that is not a person, or an unknown role, exits non-zero and saves
  nothing. It starts from the merged scope (the panel's `members` list wins, as in
  `merged_scope`), so a role the owner removed in the panel before the next sync does not
  come back. It also corrects the chat's panel entry, as `--approval` does.
- `wa_store.rol_de(con, cuenta, chat_jid, sender_jid, owners, miembros)` returns
  `admin | operator | client`. Its arguments:
  - `con` is the open message store, or None;
  - `owners` is `duenos()`;
  - `miembros` is `{chat_jid: {id: role}}`, and only `miembros[chat_jid]` is read.

  For the per-chat roles, a LID and a phone are the same person only through that line's
  `lid_telefono` pair. They are never matched by their digits. A global owner is matched by
  his exact id only (`es_dueno`), never through the pair. With no sender in a direct chat, the writer is the
  chat itself; in a group, nobody (`client`). If one person has two ids with different
  roles, the lower role wins.
- `rol_del_caso(con, caso)` (`bin/wa-scope`) is the lowest role among the case's non-own
  senders. The owner's own chat (`chat_es_del_dueno`) is `admin`. A case with no stored
  messages, or no store, is `client`. `caso_del_dueno` is unchanged for its existing
  callers (the brief, dispatch). Since M10, ingest uses the role (`rol` on each message),
  and the brief and the case header add the operator texts when `rol_del_caso` is
  `operator` or `admin` and the case is not the owner's.
- `wa_store.directo_sin_reglas(con, cuenta, chat_jid, owners, miembros)` (M10): true only
  for a direct chat whose person is `operator` or `admin` of that chat. `frenos_de_regla`
  and `wa-send` then skip the customer levels and Jev on outgoing; a secret is still held.
- `juicio.rol` (M10): the role a Jev verdict was judged with. Null is a verdict from before
  the roles.
- `cmd_caso_pregunta_proyecto`, `auto`: the question goes to the writer in the owner's own
  chat (as before), or in a DIRECT chat whose `rol_del_caso` is `admin` or `operator`. In a
  group it goes to the owner, whatever the roles. An explicit `writer` or `owner` wins, as
  before. The rule lives in `para_de_pregunta(con, caso)`.
- `pregunta_del_dueno(con, caso)`: an open question is the owner's when it was stored with
  `a: owner`, or when it was stored with `a: writer` and `para_de_pregunta` no longer says
  `writer` (the owner removed the role, or changed `projectQuestion`, before the question
  went out). `frenos_de_regla` then holds a reply with `project_question`, and `avance_frena`
  refuses an update with `E_EXCEPTION (project_question)`.

### `wa-read members --chat <jid|id|name> --json`

- `[{id, name, phone, wa_admin}]`, exactly these four keys:
  - `id`, `name` and `phone` follow the `groupMembers` rules;
  - `wa_admin` is a boolean (WhatsApp admin or superadmin).
- For a group, the rows come from the sidecar's `grupo_miembro` list, without the line.
  For a direct chat, the result is the single person on the other side.
- A store from before the table answers `[]`. A chat reference that matches nothing exits
  1 with stdout empty; an ambiguous one exits 2. Without `--chat` it is an argparse error.
- `--line ACCOUNT` works as in every other command. The default is the active line.

## Delivery

- Part A (M1–M7) ships first, as its own PR and release.
- Part B (M8–M12) follows on the same branch line, after A is merged.