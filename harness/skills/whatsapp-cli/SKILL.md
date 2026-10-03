---
name: whatsapp-cli
description: How to use the plugin's command line tools (wa-scope, wa-read, wa-transcribe) on a WhatsApp case. Use it before running any of them, to get the real commands and flags.
---
<!-- Written by the WhatsApp Inbox plugin (ab2web.orca-wa-inbox).

     What happens to this file on the next update:

       · A `##` section you did NOT touch is replaced with the new version.
       · A `##` section you edited is yours from then on: the plugin keeps your
         text and never rewrites that section again. The rest keeps updating.
       · A `##` section you add is kept, at the end of the file.
       · Delete the file and the plugin writes it again from scratch. -->

# The WhatsApp tools

Run every tool as `"$WA/<tool>"`, with `WA` read from `.wa-bin` (never a bare name from
`PATH`). `COMMANDS.md` has the full `--help` of each one.

## You propose; only the plugin sends

You never run `wa-send`. A reply is a proposal on a case; the plugin's minute (`wa-scope
tick`) sends it when the conversation's permission and the fixed floor allow it, and the
owner approves it on the board otherwise.

## Read

    "$WA/wa-scope" pending --needs-agent        # exit 1 = nothing needs you
    "$WA/wa-scope" caso ver <id> --json         # stage, Jev, and `hilo` in arrival order
    "$WA/wa-scope" voice "<chat_jid>" --json    # the chat's tone and instructions
    "$WA/wa-scope" check "<chat_jid>" --for responder   # exit 3 = denied
    "$WA/wa-scope" where "<text>" --chat "<chat_jid>" --json
    "$WA/wa-read" chat "<chat_jid>" --json      # more of the conversation

`hilo` marks every message before the last reply sent as `respondido`: context only.

## Decide

    "$WA/wa-scope" caso clasificar <id> --clase <card|alert|doubtful> --prioridad <none|low|medium|high|urgent> --actor agente
    "$WA/wa-scope" caso propuesta <id> --tipo responder --respuesta "<text>" --actor agente
    "$WA/wa-scope" caso propuesta <id> --tipo trabajar --instrucciones "<brief>" --actor agente
    "$WA/wa-scope" caso propuesta <id> --tipo escalar --instrucciones "<why>" --actor agente
    "$WA/wa-scope" caso mover <id> cerrado --motivo "<why>" --actor agente

The same proposal twice changes nothing. A stage that is not allowed fails without
writing; read the error instead of retrying.

## One run at a time

    "$WA/wa-scope" lock --note triage           # exit 4 = another run is going: stop
    "$WA/wa-scope" unlock

## Voice notes

The plugin transcribes them before you see the case. `"$WA/wa-transcribe" <file> --json`
exists for a file you already have; `"$WA/wa-transcribe" --check` says whether this
machine can transcribe. Never run it on a case's note again.

## Exit codes

`wa-read`: `4` with `no-transport` on the first stderr line = no line linked, stop and say
so; `2` = the chat reference matches more than one conversation, pick one by JID. An empty
list with exit 0 means the inbox is quiet.
