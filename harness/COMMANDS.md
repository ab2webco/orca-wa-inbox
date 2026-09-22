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
| `wa-send` | writes a message in the chat, and sends it only with `--send` |
| `wa-transcribe` | turns a voice note into text, when this machine can |

Some exit codes are answers, not failures, and all of them are load-bearing:

| Code | Where | What it means |
|---|---|---|
| `3` | `wa-scope check` | denied. Note it and move on. Do not negotiate with the gate. |
| `4` | `wa-scope lock` | another run is already going. Stop there, read nothing, open nothing. |
| `4` | `wa-read` (any read) | `no-transport` on the first stderr line: no WhatsApp line is linked yet, so there is nothing to read. This is a normal state, not a broken tool. |
| `2` | `wa-read chat` / `media` | that chat reference matches more than one conversation. The candidates are on stderr. Pick one with its JID, or add `--line`. |

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

If the resolution comes back empty, or `"$WA/wa-scope"` is not executable, **stop and
say so in one line**. Better a run that did nothing and said so than one that worked on
another tree's data.

## Reference

<!-- HARNESS:HELP -->
