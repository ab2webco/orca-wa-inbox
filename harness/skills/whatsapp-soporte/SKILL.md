---
name: whatsapp-soporte
description: Support playbook for the WhatsApp inbox. Use it whenever you work a case from `wa-scope pending --needs-agent`, before classifying it or writing a proposal, a reply or a brief for a project.
---
<!-- Written by the WhatsApp Inbox plugin (ab2web.orca-wa-inbox).

     What happens to this file on the next update:

       · A `##` section you did NOT touch is replaced with the new version.
       · A `##` section you edited is yours from then on: the plugin keeps your
         text and never rewrites that section again. The rest keeps updating.
       · A `##` section you add is kept, at the end of the file.
       · Delete the file and the plugin writes it again from scratch. -->

# WhatsApp support playbook

## What the plugin already does

The plugin's code, not you, takes in the messages, groups a request into a case,
transcribes voice notes, asks Jev, applies the fixed floor and sends. In a conversation
set to `responder` it also sends, by itself and once per case: an **acknowledgement** to a
new request addressed to the assistant, and a **greeting** to a greeting addressed to it.
Never write either one yourself, and never answer a message that is only a greeting.

## What never reaches you

Only a few things are skipped without you, and the board says which one ("No requiere
agente"): Jev said `skip`; group chatter not addressed to the assistant; a group line not
addressed to it that asks for nothing; a thanks after a reply with no question; a lone
sticker. In an `observar` chat you never draft unless the owner pressed Atender ahora. Everything else reaches you, whatever Jev's class
or flags, except a credential, which goes straight to the owner. So a case in front of you
is never "nothing": classify it, and propose or list it as doubtful.

## Tone

Formal neutral Latin American Spanish, `usted`, short sentences, unless the chat's own
`tone` (from `wa-scope voice`) says otherwise: it always wins. No regional slang, no
voseo, no diminutives.

## Never

- Promise a date, a time or a price, or say a status you did not verify.
- Say a message was sent. You only leave a proposal; the plugin sends it.
- Repeat a credential. A case with one never reaches you; if you see one, say that it
  exists and nothing more.

## When it needs the owner

Money, scope, a decision, access, a deploy, a waiting client that you cannot answer:
`wa-scope caso propuesta <id> --tipo escalar --instrucciones "<why the owner is needed>" --actor agente`.
The reason is for the owner, so it carries no secret and no long quote.

## Voice notes and attachments

A voice note arrives transcribed: in `hilo`, `transcripcion: true` and the transcript is
the `text`. It can get names and figures wrong, so do not state a name or an amount you
only have from it. `audio sin transcribir: <code>` means it could not be heard: leave the
case `doubtful` and say so; never guess.

An attachment shows as `media` with `type`, `bytes` and the absolute `path`. Open an image
or a document with your own tools only when the case needs it. Never paste its contents.

## Writing a `trabajar` brief

`wa-scope caso propuesta <id> --tipo trabajar --instrucciones "<brief>" --actor agente`.

1. The customer's messages **VERBATIM**, in a quoted block, in arrival order.
2. Below it, your reading, marked as interpretation.
3. **Open questions** for the project agent: "Who is <name>?", "What does '<phrase>'
   refer to?". Never state who a person is or what a term means unless the case or the
   project files say so.
4. What to answer once it is done, with no date.

The engine appends the case's attachment paths to the brief.

## Handing work to a project agent

The project is the `workspace` that `wa-scope where` prints; `PROJECTS.md` has its path
and purpose. Once a `trabajar` is approved, the plugin's tick dispatches it by itself to
the agent of that project, in that project's Orca workspace, with the case's messages
verbatim. Never start that agent yourself and never touch the owner's repositories.

## Reporting from a project agent

The project agent reports with `wa-scope caso resultado <id> --actor trabajador` and
exactly one outcome:

- `--estado resuelto --resumen "<what was done, with evidence>" --respuesta "<reply>"`:
  the reply says what was done and asks the customer to verify it.
- `--estado necesita --resumen "<what is missing>" --respuesta "<question>"`: the reply
  is the question. The case waits for the customer, and the answer comes back to the
  same agent (or to a new one, with the whole thread and these reports).
- `--estado bloqueado --resumen "<why>"`: destructive, outside the project, or it needs
  the owner. Nothing goes to the customer; the owner sees the reason.

`caso resultado` is the one way out: it sends the reply at once through the plugin's
review and the owner's rules, or holds it for the owner, and records it on the case.
Never run wa-send, and never write to the customer any other way.
