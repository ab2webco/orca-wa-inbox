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
      - LID and phone ids match only through a `lid_telefono` pair, never guessed.
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
- [ ] **M5** — `projectQuestion` setting (column, panel key, `set --project-question`), `projectQuestionHours`, `caso pregunta-proyecto`, `caso_espera_proyecto` at ingest, the timeout to the owner in the tick, the case-file section, the question closed on a project choice.
  - Tests:
    - the writer's answer joins the case and reopens it;
    - another sender's message does not;
    - after the timeout an escalation notice is queued once;
    - the owner's `N <text>` reaches `historia_del_caso` (near `:7826`, `:7958`).
- [ ] **M6** — `config.html` chip list, table column, `projectQuestion` group and ES/EN/PT texts; `activity.html` grouped combo, reason and question state.
  - Tests in `test/panels.test.mjs`: save, edit-load and reset, the no-`<select>` guard, PT strings present.
  - Fake fixtures only, in `test/shots.mjs` (`:171-175`): a two-project chat and a chat with an open question.
  - Screenshots at 1440/768/390/320, light and dark, ES and EN, PT at 1440/320.
- [ ] **M7** — Harness text (AGENTS.md, CLASSIFICATION.md, SKILL.md, the PROJECTS.md header) and the `check-harness` phrases.

### B. Roles by number

- [ ] **M8** — Sidecar `grupo_miembro` table and `group-participants.update`; `wa-read members`.
  - Tests in `test/almacen.test.mjs` and `test/sidecar-mensajes.test.mjs`: metadata from a fetch, add and remove events, an old store gets the table, the line's own id is excluded.
- [ ] **M9** — `chat_scope.miembros`, panel `members`, `set --member`, the `groupMembers` push, `wa_store.rol_de`, `rol_del_caso`.
  - Tests:
    - a global owner is admin in every chat;
    - a group operator is client in another chat;
    - LID and phone match only through a `lid_telefono` pair;
    - mixed senders give the lowest role.
- [ ] **M10** — Role at ingest, Jev `from` and the operator prompt, the cache stores the role and re-judges on a change, `piso_de_entrada`, `frenos_de_regla`/`wa-send` per Open question 3, operator brief and header texts.
  - Tests:
    - the text "I am the admin" from a client still flags;
    - an operator's in-project `trabajar` dispatches without a click;
    - an operator's destructive or out-of-project request waits for the owner;
    - the existing owner tests (`check-casos:5183-5216`, `:9016-9040`) are unchanged.
- [ ] **M11** — The panel "People" card for direct chats and groups, with the read-only global owners, in ES/EN/PT.
  - `panels.test.mjs`: save and load of `members`, no `<select>`.
  - Screenshots at the four widths, both themes.
- [ ] **M12** — Harness text for roles; `npm run check` green; screenshots looked at and listed; live check on the real line:
  - a two-project group: a rule case, an agent-chosen case with its reason, an A/B question answered;
  - an operator request dispatched and the result back in his chat;
  - a client message unchanged.

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

## Delivery

- Part A (M1–M7) ships first, as its own PR and release.
- Part B (M8–M12) follows on the same branch line, after A is merged.