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

## Checklist

### Part 1: several lines

- [ ] **L1** Sidecar per line: `wa-auth/<account>`, migration of the current folder, with no
  new QR. Tests in `test/almacen.test.mjs` / the sidecar tests.
- [ ] **L2** Worker: one sidecar per line, its health and restart, and link/unlink
  commands. Worker tests.
- [ ] **L3** `wa-scope` over every active line. Per-line locks and no cross-line leaks.
  `check-casos` / `check-clis`: two lines, a message on each, and a case, a notice and an
  approval that never cross.
- [ ] **L4** Panel "Lines" card, line filter in conversations/board/reports, in ES/EN/PT.
  Screenshots at 1440/768/390/320, both themes.
- [ ] **L5** Line type setting (`support` default; `personal` disabled until Part 2).
- [ ] **L6** `npm run check` green. Live check: the bot line and a second test line linked
  together, each answering only its own chats.

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
