<!-- Written by the WhatsApp Inbox plugin (ab2web.orca-wa-inbox).

     The reference below is generated from the tools' own `--help` every time the
     plugin starts, so a flag that changes shows up here instead of going stale.
     Editing it by hand is therefore pointless: put your notes in a section of
     your own.

     What happens to this file on the next update:

       · A `##` section you did NOT touch is replaced with the new version.
       · A `##` section you edited is yours from then on: the plugin keeps your
         text and never rewrites that section again. The rest keeps updating.
       · A `##` section you add is kept, at the end of the file.
       · Delete the file and the plugin writes it again from scratch. -->

# The commands

Four tools ship inside the plugin. The prompt resolves their directory into `$WA`
before anything else, so **every command below is run as `"$WA/<tool>"`** — never as
a bare name from `PATH`. On someone else's machine the tools are not in `PATH`, and
if a name does resolve it may be an old copy reading another database.

| Tool | What it does |
|---|---|
| `wa-scope` | the authorization registry, the state between runs, and everything the agent records |
| `wa-read` | read-only access to WhatsApp: inbox, chats, messages, attachments |
| `wa-send` | writes the reply, and sends it only with `--send` and only where the registry says `responder` |
| `wa-transcribe` | turns a voice note into text, when this machine can |

## The permission ladder, and what `borrador` really does

| Mode | It may |
|---|---|
| `off` | nothing. This is the default for any chat nobody registered. |
| `observar` | read, and open a card. It never writes in WhatsApp. |
| `borrador` | write the reply. **Nothing reaches WhatsApp until the owner approves it.** |
| `responder` | send by itself. |

`borrador` used to mean "the text is left typed in the chat, unsent". It is not that
any more and it cannot be: **WhatsApp has no draft of its own**, so nothing can be
left sitting in someone's chat window. That rung was only possible while the agent
drove a screen, and that transport is gone.

What it does now: `wa-send "<chat>" "<text>" --send` on a `borrador` conversation
stores the reply, answers `send-needs-approval` on the first stderr line with the id,
and sends nothing. The owner lists what is waiting with `wa-send --drafts` and sends
one with `wa-send --approve <id>`.

**So never report a draft as "left written in the chat".** It is not there. Say the
reply is waiting for approval, and give the id. Reporting the old behaviour about a
message the client cannot see is the exact failure this wording exists to prevent.

Some exit codes are answers, not failures, and all of them are load-bearing:

| Code | Where | What it means |
|---|---|---|
| `3` | `wa-scope check` | denied. Note it and move on. Do not negotiate with the gate. |
| `4` | `wa-scope lock` | another run is already going. Stop there, read nothing, open nothing. |
| `4` | `wa-read` (any read) | `no-transport` on the first stderr line: no WhatsApp line is linked yet, so there is nothing to read. This is a normal state, not a broken tool. |
| `2` | `wa-read chat` / `media` | that chat reference matches more than one conversation. The candidates are on stderr. Pick one with its JID, or add `--line`. |
| `3` | `wa-send` | `send-denied`: that conversation's permission does not write. Same answer as the gate — note it and move on. |
| `3` | `wa-send` | `send-needs-approval`: the conversation is on `borrador`. The reply was written and is waiting for the owner. Nothing was sent. |
| `4` | `wa-send` | `send-no-transport`: the line is not running, so there is nothing to send through. Nothing was queued. |

`wa-send` answers with the same two-line shape as the reads: the stable code on the
first line of stderr, the human detail on the second. The codes that matter are
`send-denied`, `send-needs-approval`, `send-no-transport` (the line is down) and
`send-rejected` (the line is up and WhatsApp refused the message) — those last two are
different on purpose, because what the owner has to do about each is different.

**Retrying a send.** Every request carries an id (`--id`). The same id delivers **once**:
if a verdict is slow and you ask again with the same id, it is not sent twice. Retry
with the same id, never with a new one — a duplicate message in a client's group cannot
be taken back.

`no-transport` is the one worth knowing by name. It means the owner has not linked a
line from the plugin settings yet — the QR code lives there. There is nothing for you
to fix and nothing to retry: **stop the run and say so in one line.** Do not open
cards, do not guess at conversations, and do not report it as a failure of the tools —
they answered correctly. `wa-scope pending` already returns `hay_trabajo: false` with
this code, so a run that starts anyway has ignored its own precheck.

An **empty list is not this**. Once a line is linked, every read answers with exit 0,
and `[]` means the inbox really is quiet. The two are different answers on purpose:
treating an empty list as a broken tool, or a refusal as a quiet week, are the two
mistakes this contract exists to prevent.

The owner can have more than one line linked at once — a personal number and a support
one. Every read takes `--line <account>` to answer for one of them, and every inbox row
carries its `account`. The same one-to-one conversation seen from two of the owner's
own lines is the *same* JID, so a chat is identified by `(account, jid)` and never by
the JID alone. When you are about to write, that distinction is the difference between
answering the client and answering from the wrong number.

Cards are opened with the task service's own CLI, which `wa-scope where` names in
`provider`: `orca plane create`, `orca linear save-issue` or `gh issue create`. With
`provider: ninguno` no card is opened at all.

## Where the tools are

The tools ship inside the plugin, but **you are not standing in the plugin folder**:
Orca runs the automation in a workspace, where no `./bin/` exists. That is why the
prompt resolves the path instead of assuming it — and why `PATH` is not trusted either:
on someone else's machine the tools are not there, and a `PATH` hit may be an old copy
from another tree, reading another database.

When several copies are installed, the one that wins is the highest **version** in
`orca-plugin.json` — never the one installed most recently, which is not the same thing:
a 3.0.1 downloaded today is still older than a 3.13.0 from last week. A registered dev
path with a usable `bin/` wins over every installed copy, which is the point of dev mode.
The pre-rename identity `ab2web.wa-inbox` is not resolved at all: that build sends
WhatsApp by driving the desktop app, a path this plugin removed, so running it is not
running an old version, it is running another product.

If the resolution comes back empty, or `"$WA/wa-scope"` is not executable, **stop and
say so in one line**. Better a run that did nothing and said so than one that worked on
another tree's data — or one that sent a real message through code that was deleted.

## Reference

<!-- HARNESS:HELP -->
