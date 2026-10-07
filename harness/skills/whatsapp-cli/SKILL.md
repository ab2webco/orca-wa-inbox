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
`PATH`). `COMMANDS.md` has the full `--help` of each one. The plugin keeps the same path
in `bin-path` in the tools' state folder: `WA="$(cat ~/.wa-inbox/bin-path)"` on macOS and
Linux, `%APPDATA%\wa-inbox\bin-path` on Windows. Use it when `.wa-bin` is missing or does
not name an executable `wa-scope`, and outside this folder.

## You propose; only the plugin sends

You never run `wa-send`. A reply is a proposal on a case; the plugin's minute (`wa-scope
tick`) sends it when the conversation's permission and the fixed floor allow it, and the
owner approves it on the board otherwise.

You cannot approve anything either. A held message goes out only with the owner's
approval, from the board or his answer to the plugin's notice on WhatsApp; `wa-send
--approve` refuses any other caller with `send-approve-not-owner` (exit 3). The same goes
for signing a case as the owner: `caso aprobar --actor dueno` only comes from his click on
the board and refuses anyone else with `E_NOT_OWNER`. Never try to get around either: tell
the owner what is waiting instead.

## Read

    "$WA/wa-scope" pending --needs-agent        # exit 1 = nothing needs you
    "$WA/wa-scope" caso ver <id> --json         # stage, Jev, and `hilo` in arrival order
    "$WA/wa-scope" voice "<chat_jid>" --json    # the chat's tone and instructions
    "$WA/wa-scope" check "<chat_jid>" --for responder   # exit 3 = denied
    "$WA/wa-scope" where "<text>" --chat "<chat_jid>" --json
    "$WA/wa-read" chat "<chat_jid>" --json      # more of the conversation
    "$WA/wa-read" wait --chat "<chat_jid>" --after <stanza_id> --timeout 600 --json   # block until the other side writes

`hilo` marks every message before the last reply sent as `respondido`: context only.

## Decide

    "$WA/wa-scope" caso clasificar <id> --clase <card|alert|doubtful> --prioridad <none|low|medium|high|urgent> --actor agente
    "$WA/wa-scope" caso propuesta <id> --tipo responder --respuesta "<text>" --actor agente
    "$WA/wa-scope" caso propuesta <id> --tipo trabajar --instrucciones "<brief>" --actor agente
    "$WA/wa-scope" caso propuesta <id> --tipo escalar --instrucciones "<why>" --actor agente
    "$WA/wa-scope" caso mover <id> cerrado --motivo "<why>" --actor agente

Only in a case of the owner or of a Super admin (the case file says "Reply to another chat:
allowed"): the reply, or a job's final reply, can go to another chat of the same line in
responder. A customer's case is refused (`E_DEST_ROLE`).

    "$WA/wa-scope" caso destinos <id> --json    # the candidate chats (same project, responder)
    "$WA/wa-scope" caso propuesta <id> --tipo responder --respuesta "<text>" --chat <jid> --actor agente

Beta, only where `voice` says `first_reply_mode` is `model` or `model_with_ack_fallback`
(see the `whatsapp-soporte` skill): the first message and the updates, sent by the plugin.

    "$WA/wa-scope" caso avance <id> "<text>" --actor agente

The same proposal twice changes nothing. A different proposal on a case in `listo` (the
result of a job) sends it back to `decision`, to be approved again. A stage that is not
allowed fails without writing; read the error instead of retrying.

## Manage cases for the owner

Only in the owner's own case (or a Super admin's, except closing), never for a customer.

    "$WA/wa-scope" caso estado <id> --json          # how a case is going, in words
    "$WA/wa-scope" caso buscar "<text>" --json      # by number, title word or chat, accents ignored
    "$WA/wa-scope" caso listar --abiertos --etapa decision,trabajo --desde 7d --json   # short rows; --completo for all
    "$WA/wa-scope" caso informe --periodo 7d --json # the Reports tab numbers; --csv
    "$WA/wa-scope" caso nota <id> "<text>" --actor agente
    "$WA/wa-scope" caso editar <id> --prioridad urgent --titulo "<title>" --actor agente
    "$WA/wa-scope" caso retirar <id> --actor agente # the proposal goes, the case stays
    "$WA/wa-scope" caso atender <id> --ahora --actor agente   # and autorizar --ahora
    "$WA/wa-scope" caso recordar <id> "<text>" --cuando 2h --actor agente   # --hasta snoozes, --cancelar drops
    "$WA/wa-scope" caso lote cerrar <id> <id> --motivo "<why>" --actor agente --pedido <this case>   # dry run
    "$WA/wa-scope" caso lote cerrar <id> <id> --motivo "<why>" --actor agente --pedido <this case> --confirmar

`--todas-las-lineas` reads every linked line (listar, buscar, informe, recordatorios).
`caso lote` without the owner's case in `--pedido` is `E_NOT_OWNER`. `--confirmar` needs his
message in that chat after the dry run, for the same cases; else `E_NEEDS_OWNER_YES`.

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
list with exit 0 means the inbox is quiet. `wa-read wait`: `5` = `wait-timeout`, nobody
wrote before `--timeout`; `3` = `chat-not-authorized`, the owner has not enabled that chat.
