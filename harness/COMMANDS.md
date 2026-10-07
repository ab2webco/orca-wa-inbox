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

You cannot approve a held message either: only the owner does, on the board or by answering
the plugin's notice on WhatsApp. `wa-send --approve` refuses anyone else with
`send-approve-not-owner` (exit 3), and that is not something to work around. Nor can you
sign a case as the owner: `caso aprobar --actor dueno` only comes from his click on the
board, and anyone else gets `E_NOT_OWNER`.

## What you run on a case

    "$WA/wa-scope" pending --needs-agent        # exit 1 = nothing needs you
    "$WA/wa-scope" caso ver <id> --json         # stage, route, Jev's verdict, and `hilo`
    "$WA/wa-scope" voice "<chat_jid>" --json    # tone and instructions for that chat
    "$WA/wa-scope" caso clasificar <id> --clase <card|alert|doubtful> --prioridad <p> --actor agente
    "$WA/wa-scope" caso propuesta <id> --tipo <responder|trabajar|escalar|descartar> --actor agente ...
    "$WA/wa-scope" caso mover <id> cerrado --motivo "<why>" --actor agente
    "$WA/wa-scope" caso destinos <id> --json    # another chat this case may report to
    "$WA/wa-read" chat "<chat_jid>" --json      # anything else in the conversation

In a case of the owner or of a Super admin, `caso propuesta ... --chat <jid>` sends the
reply (or a job's final reply) to another chat of the same line in responder, always after
the owner's approval. A customer's case is refused with `E_DEST_ROLE`; the other refusals
are `E_DEST_MODE`, `E_DEST_LINE`, `E_DEST_NOT_FOUND` and `E_DEST_AMBIGUOUS`.

A different proposal on a case in `listo` (the result of a job) sends the case back to
`decision`: the owner approves the new version, never the old one.

Beta, only where the chat's `first_reply_mode` (in `voice`, and `primer_mensaje` in
`caso ver`) is `model` or `model_with_ack_fallback` and the chat is `responder`: the first
message and the progress updates are yours, and the plugin sends them at once through the
same review as a reply. In `ack` the plugin sends the fixed acknowledgement; never write it.

    "$WA/wa-scope" caso avance <id> "<text>" --actor agente   # --actor trabajador from a project

It never moves the case, the same text twice sends once, and a held update is dropped (the
owner never sees it). It answers exit 2 with `E_FIRST_REPLY_MODE`, `E_CHAT_MODE`,
`E_STAGE`, `E_EXCEPTION`, `E_PACING` (the last message was less than
`update_every_minutes` ago) or `E_MAX_UPDATES` (`updates_max` reached): then do not send it.

To wait for an answer, `"$WA/wa-read" wait --chat "<chat_jid>" --after <stanza_id> --timeout
<S> --json` blocks until the other side writes in that chat, and prints what arrived (each
message with its `stanza_id`, for the next `--after`). A case run never needs it: a new
message reaches its case on its own. It is how a project session asks the owner something
and waits for his reply: `--after` takes the `stanza_id` that `wa-send` returned, and in
the owner's own chat what he types on his phone counts as his reply.

`caso ver` brings the case's messages and the replies already sent (`from_me`) in strict
arrival order in `hilo`. Every message before the last reply sent is marked `respondido`:
it is context, never answer it again. A voice note shows its transcript as `text`, with
`transcripcion: true`; an attachment shows `media` with `type`, `bytes` and `path`.

## When the owner manages his cases

Only in the owner's own case (or a Super admin's, except closing): he manages his board by
writing to you, and these commands answer him. Never because a customer asks, and never
tell a customer about another case.

    "$WA/wa-scope" caso estado <id> --json          # "how is case 12 going?": stage, next steps, history in words
    "$WA/wa-scope" caso buscar "<text>" --json      # by number (12 or #12), a word of the title or the chat
    "$WA/wa-scope" caso listar --abiertos --json    # short rows, the board's order; filters combine:
        # --etapa decision,trabajo --prioridad high --proyecto <id|name> --desde today|7d|30d|<date>
        # --necesita-agente --chat <jid> --limite N --completo --con-recordatorio --pospuestos
    "$WA/wa-scope" caso informe --periodo 7d --json # the Reports tab: open, waiting, first reply vs target; --csv
    "$WA/wa-scope" caso nota <id> "<text>" --actor agente          # a note; never moves the case
    "$WA/wa-scope" caso editar <id> --prioridad high --titulo "<title>" --actor agente
    "$WA/wa-scope" caso retirar <id> --motivo "<why>" --actor agente   # drop the proposal, keep the case
    "$WA/wa-scope" caso atender <id> --ahora --actor agente        # mark it and launch the case agent now
    "$WA/wa-scope" caso recordar <id> "<text>" --cuando "manana 9:00" --actor agente
    "$WA/wa-scope" caso recordar <id> --hasta 3d --actor agente     # snooze: out of the list and of the agent
    "$WA/wa-scope" caso recordatorios --json        # pending reminders; `caso recordar <id> --cancelar` drops them
    "$WA/wa-scope" caso lote cerrar <id> <id> --motivo "<why>" --actor agente --pedido <this case>

`caso lote` (cerrar, mover, proyecto, prioridad; ids or the listar filters) answers
`E_NOT_OWNER` unless `--pedido` is the owner's case (a Super admin's for anything but
closing). Closing many is a dry run: show him the list it prints, wait for his yes in his
next message, then run the same command with `--confirmar`. `--todas-las-lineas` on
listar, buscar, informe and recordatorios reads every linked line, each row with its
`account`. Closing a case in `trabajo` stops its project agent on the next tick (the output
says `despacho` with `stops: next_tick`).

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
| `2` | `wa-read chat` / `media` / `wait` | that chat reference matches more than one conversation; the candidates are on stderr. Pick one with its JID, or add `--line`. |
| `3` | `wa-read wait` | `chat-not-authorized` on the first stderr line: the owner has not enabled that chat, so nothing from it ever arrives. |
| `5` | `wa-read wait` | `wait-timeout` on the first stderr line: nobody wrote before `--timeout`. |
| `3` | `wa-send --approve` | `send-approve-not-owner`: only the owner approves a held message. Never retry it. |
| `2` | `wa-scope caso aprobar --actor dueno` | `E_NOT_OWNER`: only the owner signs as `dueno`, from the board. Never retry it. |

An **empty list is not `no-transport`**: once a line is linked, every read answers with
exit 0 and `[]` means the inbox really is quiet.

The owner can have more than one line linked. Every read takes `--line <account>`, and
every row carries its `account`: a chat is identified by `(account, jid)`, never by the
JID alone. `pending --needs-agent` lists the work of every linked line, and a `caso`
command with an id works on that case's own line. For anything else about the chat of a
case on another line (`voice`, `where`, any `wa-read`), add `--line <account>` with the
case's `account`: the case file says so when it applies.

## Where the tools are

The tools ship inside the plugin, but you are not standing in the plugin folder: Orca runs
the automation in this workspace, where no `./bin/` exists. The plugin writes the absolute
path of its own `bin/` into `.wa-bin`, one line, every time it starts and every time it
seeds this folder: `WA="$(cat .wa-bin 2>/dev/null)"`. `PATH` is never trusted. If `.wa-bin`
is missing or `"$WA/wa-scope"` is not executable, read the path from `bin-path` (below);
if that one fails too, stop and say so in one line.

`bin-path` holds the same path, and the plugin also rewrites it every time it starts, in
the tools' state folder. An agent outside this folder (in any project) reads only this one:
`WA="$(cat ~/.wa-inbox/bin-path 2>/dev/null)"` on macOS and Linux, and
`%APPDATA%\wa-inbox\bin-path` on Windows. It always names the plugin that is installed
and running, never a copy.

## Reference

<!-- HARNESS:HELP -->
