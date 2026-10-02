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
before anything else, so **every command below is run as `"$WA/<tool>"`**, never as a
bare name from `PATH`: on someone else's machine a `PATH` hit may be an old copy reading
another database. If `$WA` is empty, or `"$WA/wa-scope"` is not executable, stop and say
so in one line.

| Tool | What it does | Yours? |
|---|---|---|
| `wa-scope` | the authorization registry, the cases, and the commands you use to read and propose | yes |
| `wa-read` | read-only access to WhatsApp: the inbox, chats, messages, attachments | yes |
| `wa-transcribe` | turns a voice note into text; the plugin already runs it on every voice note that reaches a case | rarely |
| `wa-send` | writes and sends WhatsApp messages | **no: the plugin sends, you never do** |

## What you run on a case

    "$WA/wa-scope" pending --needs-agent        # exit 1 = nothing needs you
    "$WA/wa-scope" caso ver <id> --json         # stage, route, Jev's verdict, and `hilo`
    "$WA/wa-scope" voice "<chat_jid>" --json    # tone and instructions for that chat
    "$WA/wa-scope" caso clasificar <id> --clase <card|alert|doubtful> --prioridad <p> --actor agente
    "$WA/wa-scope" caso propuesta <id> --tipo <responder|trabajar|escalar|descartar> --actor agente ...
    "$WA/wa-scope" caso mover <id> cerrado --motivo "<why>" --actor agente
    "$WA/wa-read" chat "<chat_jid>" --json      # anything else in the conversation

`caso ver` brings the case's messages and the replies already sent (`from_me`) in strict
arrival order in `hilo`. Every message before the last reply sent is marked `respondido`:
it is context, never answer it again. A voice note shows its transcript as `text`, with
`transcripcion: true`; an attachment shows `media` with `type`, `bytes` and `path`.

## Permissions, and who sends

| Mode | What the plugin does with a proposal |
|---|---|
| `off` | nothing: the chat does not exist for you. This is the default for any chat nobody registered. |
| `observar` | the case exists and the owner sees it; nothing is ever sent. |
| `borrador` | your reply waits on the board for the owner's approval. |
| `responder` | your reply is sent by the plugin on its own, unless the case carries an exception (money, credential, commitment, a Jev warning): then it waits for the owner. |

WhatsApp has no draft of its own: a reply waiting for approval is **not** written in the
chat and the client cannot see it. Say it is a proposal waiting for approval.

## Exit codes that are answers, not failures

| Code | Where | What it means |
|---|---|---|
| `1` | `wa-scope pending --needs-agent` | nothing needs you. Say so in one line and finish. |
| `3` | `wa-scope check` | denied. Note it and move on. |
| `4` | `wa-scope lock` | another run is going. Stop there, read nothing. |
| `4` | `wa-read` (any read) | `no-transport` on the first stderr line: no WhatsApp line is linked yet. A normal state, not a broken tool: stop and say so in one line. |
| `2` | `wa-read chat` / `media` | that chat reference matches more than one conversation; the candidates are on stderr. Pick one with its JID, or add `--line`. |

An **empty list is not `no-transport`**: once a line is linked, every read answers with
exit 0 and `[]` means the inbox really is quiet.

The owner can have more than one line linked. Every read takes `--line <account>`, and
every row carries its `account`: a chat is identified by `(account, jid)`, never by the
JID alone.

## Where the tools are

The tools ship inside the plugin, but you are not standing in the plugin folder: Orca runs
the automation in this workspace, where no `./bin/` exists. The plugin writes the absolute
path of its own `bin/` into `.wa-bin`, one line, every time it starts and every time it
seeds this folder: `WA="$(cat .wa-bin 2>/dev/null)"`. `PATH` is never trusted. If `.wa-bin`
is missing or `"$WA/wa-scope"` is not executable, stop and say so in one line.

## Reference

<!-- HARNESS:HELP -->
