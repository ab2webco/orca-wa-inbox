# Several lines at once, and a personal "second brain" line

Status: planned (2026-10-05). Starts after the work in flight ships: the Linux plugin
folder fix, the rules-and-acknowledgement fix, and Part B of `proyectos-por-chat.md` (roles).

## Objective

Today the plugin serves one WhatsApp line at a time:

- The sidecar runs one Baileys session per process, with one auth folder
  (`sidecar/src/index.js`, `WA_SIDECAR_AUTH_DIR`).
- The worker starts one sidecar (`main.mjs`, `arrancarSidecar`).
- `wa-scope` works only on the line linked right now (`cuenta_activa`, `bin/wa-scope`).
  The data of other lines stays stored but inactive.

The data model is already split by line. `capture.db` has a `linea` table and an `account`
column, and the scope and cases are keyed by `account`. So several lines need several live
sessions, not a new data model.

The owner wants two things:

1. **Several lines at once.** The bot line keeps working as today, and other lines can be
   linked next to it.
2. **A personal line type ("second brain").** On the owner's own number, the plugin works
   as his assistant, not as a support desk:
   - it answers in his voice, with no bot signature;
   - it uses the context the owner gives for each conversation;
   - it can read project progress, read-only.

What works today must not change. A support line keeps exactly today's behaviour, and every
existing test stays green unchanged.

## Scope

### Part 1: several lines at once

1. **Sidecar:** one process per linked line, each with its own auth folder
   (`wa-auth/<account>`). Migrate the current single `wa-auth` to its line without a new
   QR.
2. **Worker:**
   - start, watch and restart one sidecar per line;
   - link a new line from the panel with its own QR;
   - unlink a line.
3. **`wa-scope`:** the tick, ingest, triage and sends run for every active line, not only
   `cuenta_activa`. A per-line lock means one line's failure never stops another.
   - Every send names its line. Today `wa-send --line` exists.
   - Nothing crosses lines: permissions, notices, cases, approvals.
4. **Panel:** a "Lines" list showing each line's status, its type and the link/unlink
   actions. Conversations, the board and reports filter by line.
5. **Line type:** `support` (today's behaviour, the default for every existing line) or
   `personal`. Part 1 adds only the setting, and `personal` stays disabled until Part 2.

### Part 2: the personal line

1. **Opt-in per conversation.** Only conversations the owner adds are read or answered.
   The rest are ignored, not even triaged.
2. **Context per conversation:**
   - the owner's notes ("my partner; we talk about X; formal or not");
   - the chat history;
   - optionally linked projects, whose progress the agent can read: tasks, Engram, PRs.
     The agent never acts on a project from this line.
3. **Voice:**
   - replies in the owner's style, learned from his own past messages in that chat;
   - no signature;
   - never says it is a bot unless the owner sets that per conversation.
4. **Autonomy per conversation:**
   - `draft` is the default: the agent proposes, and the owner sends with one tap from the
     panel or WhatsApp.
   - `auto` is opt-in per conversation and only for low-risk replies. Anything with money,
     a commitment, a date, project data, links or a secret value stays a draft.
5. **Privacy:**
   - no project data, links or results go to a contact without the owner's authorization;
   - personal chats never feed the support line or its agents.
6. **No cases board.** A personal line has a simple "pending replies" view, not cards.

### Out of scope

- Official WhatsApp Business API.
- Group automation on the personal line (only direct chats in the first version).
- Voice notes as replies.

## Design of Part 1 (decided while building it)

- **Auth folders.** `wa-auth/<folder>` per line. A linked line's folder is its account
  with `-` for `:` (`pn-<digits>`), so it is valid on every OS. A line being linked lives
  in `wa-auth/nueva-<id>` until its next start, when the resolver renames it to its
  account. The resolver (`sidecar/resolve-auth-dir.mjs --lineas`) is the only place that
  moves folders, and the worker calls it only before any sidecar runs.
- **Migration.** A flat `wa-auth/creds.json` (today's layout) moves, file by file and
  `creds.json` last, into the folder of the account its `me.id` names. The bytes do not
  change, so the session keeps working with no new QR. A flat folder with no `me` is an
  unfinished pairing and moves to a `nueva-` folder.
- **Principal line.** The worker keeps the lines in order in the storage key `lineas`
  (`[{carpeta, cuenta, tipo, alta}]`). The first one is the principal: its sidecar state
  stays in the `sidecar` key, exactly as today, and its sidecar is the only one that sets
  `store_meta.linea_activa`. Every other line writes its state to `sidecars[<folder>]`,
  and its sidecar runs with `WA_SIDECAR_LINEA_SECUNDARIA=1`.
- **Active lines.** `store_meta.lineas_activas` in capture.db (a JSON list) holds every
  linked line. Each sidecar adds its own line, and unlinking removes it (the resolver,
  through `almacen.js`). With no list, the active lines are `[linea_activa]`, as before.
- **The CLIs.** `WA_INBOX_LINEA=<account>` (or `wa-scope --line`) names the line of a run.
  Without it, `wa-scope tick`, `ingest`, `sync` and `pending --needs-agent` run once per
  active line, each in its own process with its own lock. With one line they run in the
  same process, as today. A `caso` command with a case id runs on that case's line when
  the line is active. The panel storage keys of a line that is not the principal live
  apart, so they never overwrite the principal's: its scope in
  `alcancePorLinea[<account>]` (the panel writes it too), its reports in
  `informesPorLinea[<account>]`, and the rest (board, activity, chats) in
  `porLinea[<account>]`. The nav badge adds up the decisions of every line.

- **One card for the lines.** Settings has no separate pairing card any more: the usual
  pairing (status, QR, Retry, Unlink) is the principal's row inside "Lines", with its
  number on top ("Main" only when there is another line). Each other line has its own row.
  Each line is unlinked only from its own row, and "Check now" is one action for the
  whole card. With no linked line, the principal row is the QR flow, as before.

Decisions accepted by the owner (2026-10-05):

- "Attend now" on a case of another line marks the case; the agent is launched by that
  line's tick, not immediately.
- Relinking a number that was already linked replaces its old folder on the next start
  (the phone may keep a ghost linked device).

## Checklist

### Part 1: several lines

- [x] **L1** Sidecar per line: `wa-auth/<account>`, migration of the current folder, with no
  new QR. Tests in `test/almacen.test.mjs` / the sidecar tests.
  Evidence: RED then GREEN in `almacen.test.mjs` ("L1: varias lineas a la vez", 11 checks),
  `sidecar-pairing.test.mjs` ("L1 — cada linea anota la suya", 7 checks) and
  `worker.test.mjs` ("L1 — cada linea en su carpeta, y la de siempre se muda sin QR
  nuevo", 12 checks: a fake flat auth folder ends byte-identical in `wa-auth/pn-<digits>`).
- [x] **L2** Worker: one sidecar per line, its health and restart, and link/unlink
  commands. Worker tests.
  Evidence: `worker.test.mjs` "L2 — un sidecar por linea", RED (17 checks, 6 passing by
  accident) then GREEN: the flat auth migrated by the real resolver starts as the principal
  with the same credential, the second line starts as secondary, a crash restarts only that
  line, `vincular` opens one `nueva-` line with its own QR (never two), `desvincular` with a
  folder removes only that line, and unlinking the principal promotes the next one. The
  registry also travels inside `sidecar.lineas`. Full worker suite 442/442.
- [x] **L3** `wa-scope` over every active line. Per-line locks and no cross-line leaks.
  `check-casos` / `check-clis`: two lines, a message on each, and a case, a notice and an
  approval that never cross.
  Evidence: `check-casos` section "varias lineas a la vez (L3)", RED (`--line` unknown,
  then the case file and the summed badge) and GREEN, 24 checks: per-line scope, ingest and
  `pending --needs-agent` once per line, a case per line, `caso ver` by case id, the board
  and scope of the other line apart in storage, each reply approved and delivered by its
  own line's sidecar, each owner notice sent by its own line, the summed nav badge, a busy
  principal lock that does not stop the other line, and an unlinked line that goes quiet.
  Full `check-casos` 1630/1630, `check-clis`, `envio` 93/93 and `almacen` 311/311 green.
- [x] **L4** Panel "Lines" card, line filter in conversations/board/reports, in ES/EN/PT.
  Screenshots at 1440/768/390/320, both themes.
  Evidence: `panels.test.mjs` "L4/L5" sections, RED then GREEN (30 checks): the Lines card
  (number, main, status, own QR for a new line, link, unlink with confirmation, cancel for a
  waiting line), the line picker in Conversations (reads and saves `alcancePorLinea`, removes
  with `linea`) and in the board (board, activity, line status and reports of the chosen
  line). `worker.test.mjs`: removing a chat on another line runs `wa-scope rm --line`. Full
  panel suite 1422/1422. Screenshots: `config-lineas-*`, `tablero-lineas*` and
  `config-tab-estado`.
- [x] **L5** Line type setting (`support` default; `personal` disabled until Part 2).
  Evidence: worker action `tipo` (`tipo-guardado`, `tipo-no-disponible` for `personal`,
  `tipo-invalido`, `linea-desconocida`), RED then GREEN in `worker.test.mjs`; the type control
  in each line row, with Personal disabled and one notice for the card.
- [ ] **L6** `npm run check` green. Live check: the bot line and a second test line linked
  together, each answering only its own chats.

  Release v4.22.0 (rebased on v4.21.0). What met the features shipped meanwhile:
  - `wa-scope owner` and `wa-scope orca-aviso` always work on the main line (the owner's
    line) unless `--line` names another; the Orca notices run only in the main line's
    tick (`tick_orca_si_toca`), so each notice goes out once. A `wa-send` to the owner's
    chat with no `--line` goes out from the main line instead of failing as ambiguous.
  - The approver key is one per machine: it approves a held draft of any line, which then
    leaves from its own line. Held drafts live on their line's board, and with several
    lines their card says which line.
  - Every line's status uses the same words as the main row ("WhatsApp is connected").

  Single-line regression proof (the release goes to every user):
  - `worker.test.mjs` "v4.22.0 — una sola linea sigue conectada, sin QR y como antes": one
    sidecar, main, from `wa-auth/pn-<digits>` with the same `creds.json`, connected with no
    QR in the same `sidecar` key, and no other line's state.
  - `worker.test.mjs` "v4.22.0 — la mudanza cortada a mitad deja wa-auth/ entero": the move
    copies first and deletes last. A move that fails leaves the old folder byte-identical
    (the worker reports `sidecar-authdir-fallo`, offers Retry, and launches nothing), and
    the next start finishes it with nothing lost.
  - `worker.test.mjs` "L1 — cada linea en su carpeta": the flat folder ends byte-identical
    in its line's folder, and moving it twice changes nothing.
  - `check-casos` (the whole suite, unchanged tests) for tick and ingest with one line, plus
    the L3 check "y el tick vuelve a correr solo en la que queda, como siempre" (no `lineas`
    key in the tick output with one line).
  - `panels.test.mjs`: every pairing test from before still passes against the merged card.
  - Known limit: going back to a version before v4.22.0 after the move finds no flat
    `creds.json` and asks for a new QR.

  Live check, for the owner (not done: it needs the bot line and a spare phone):
  1. Install this branch's build over the live plugin and restart Orca. On first start the
     bot line's flat `wa-auth` moves to `wa-auth/pn-<digits>`: the panel shows it connected
     with NO new QR, and the Lines card lists it as Main.
  2. Settings > Status > Lines > "Link another line", and scan the new code with the spare
     test phone. Its row turns Connected with its number.
  3. Settings > Conversations: pick the test line in the Line picker and authorize one test
     chat there (Automatic or Ask me first). The bot line's list must not change.
  4. Write from a third phone to the bot line and to the test line. Each case appears only on
     its own line's board (Dashboard > Line picker), each reply goes out from its own number,
     and the nav badge counts both.
  5. Unlink the test line from its row: the bot line keeps working with no QR, and
     `wa-scope tick --json` reports no `lineas` key again.

### Part 2: personal line

- [ ] **S1** Opt-in conversation list for a personal line. Nothing else is read.
- [ ] **S2** Per-conversation context: notes, history and read-only linked projects.
- [ ] **S3** Voice from the owner's own messages. No signature.
- [ ] **S4** Draft flow (default) and per-conversation `auto` with the exception floor.
- [ ] **S5** Pending replies view in the panel, in ES/EN/PT, with screenshots.
- [ ] **S6** Harness texts for the personal agent (`harness/`), plus `check-harness`.
- [ ] **S7** `npm run check` green. Live check on a test number before the owner's own
  number.

## Acceptance

1. With one support line and no change in settings, everything behaves exactly as before.
2. Two lines linked at once each receive, triage and answer only their own conversations.
   Nothing crosses lines.
3. A personal line reads only the conversations the owner added. By default it proposes
   drafts in the owner's voice, and sends nothing on its own.
4. No contact receives project data, links or results without the owner's authorization.

## Risks

- **Ban risk:** the sidecar uses an unofficial WhatsApp client (Baileys). On a personal
  number a ban costs more than on the bot line. Drafts first, low send volume, and test on
  a spare number first.
- **Messages in the owner's name:** a wrong reply reads as his. Hence drafts by default and
  the exception floor.
- **Personal data in agent context:** only opted-in chats, never shared with the support
  agents.

## Checks

- Strict TDD per task, with a Conventional Commit per task on a feature branch.
- `npm run check` (all suites and screenshots), with fake data only.
- Live checks as listed. Anything not verified live is reported as such.

## Delivery

- Part 1 and Part 2 ship as separate PRs and releases, in that order.
- Each part is likely over 400 changed lines. Slice it by task (sidecar, worker, `wa-scope`,
  panel) when it is reviewed.
