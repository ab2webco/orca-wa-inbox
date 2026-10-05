<!-- Written by the WhatsApp Inbox plugin (ab2web.orca-wa-inbox).

     What happens to this file on the next update:

       · A `##` section you did NOT touch is replaced with the new version.
       · A `##` section you edited is yours from then on: the plugin keeps your
         text and never rewrites that section again. The rest keeps updating.
       · A `##` section you add is kept, at the end of the file.
       · Delete the file and the plugin writes it again from scratch. -->

# What each message is

This table came out of classifying 266 real mentions over 90 days. **Half of them are
not work.** Erring on the side of proposing everything fills the board with junk and
teaches the owner to ignore it.

You classify a case in `recibido` with
`wa-scope caso clasificar <id> --clase <card|alert|doubtful> --prioridad <none|low|medium|high|urgent> --actor agente`
and then decide ONE proposal (see `AGENTS.md`). A case with nothing to attend to is
closed: `wa-scope caso mover <id> cerrado --motivo "<why>" --actor agente`.

## The table

| What arrives | What you do |
|---|---|
| **Asks for a review / help** with something concrete | `card`. Propose a reply, or `trabajar` if it needs work in a codebase. It is the most common case (51 of 266). |
| **Reports something broken** | `card`; if it says it is down or that a client is waiting, `alert` and propose `escalar`. |
| **Sends an already created ticket** (Plane/Jira URL) | Do not dispatch new work for it. Propose a short reply, or `escalar` if it needs the owner. Duplicating is worse than doing nothing. |
| **Asks about the status** of something in progress | Answer only with a status you verified in the case. If you cannot verify it, `escalar`; never guess. |
| **Asks for a deploy / a release to production** | `alert` and `escalar`. Shipping is a decision with consequences. |
| **Asks for access, a password, a credential or a token** | Never reaches you: the plugin sends it to the owner. If you see one, do not repeat it and do not propose a reply. |
| **Quote, price, hours, billing** | `alert` and `escalar`. It is money: a human decides. |
| **Asks for a decision or an approval** | `alert` and `escalar`. Price, scope, date, priority, hiring: not yours. |
| **Meeting, calendar, Teams link** | Close it. It is not support. |
| **Greeting, joke, "thanks", "ok"** | Close it, unless it is addressed to the assistant: the plugin already greets those by itself. |
| **Mentions you along with 4 or more people** | Almost always a notice to the team. Treat it as `doubtful` unless the text asks you for something explicit. |
| **Only your mention, with no text**, or text that asks for nothing | Close it. **Unless the body never came through**: that is a message you could not read, not an empty one. |
| **A voice note** | It arrives transcribed. Use the transcript as what was said, with care for names and figures. If it says `audio sin transcribir: <code>`, leave the case `doubtful` and say so. |
| **You are not sure** | `doubtful`: propose nothing and list it at the wrap-up. The owner decides from the board. In the owner's own case, a doubt is a question to him in the reply. |

In the owner's own case (see `AGENTS.md`), every `escalar` here becomes a question to him
in the reply: he is the one asking.

If the same request comes in five messages, it is ONE case.

## The two that beat any doubt

1. **A credential never passes through the agent.** Do not copy it, repeat it or store
   it. Report that one exists and nothing else.
2. **When in doubt, propose nothing.** A `doubtful` costs one line in the wrap-up; one
   proposal too many costs the owner's trust in the board.

## A message with no readable body is not an empty message

A mention whose text is empty is still a mention: what is missing is your ability to
read it. Treating it as nothing silently discards it. Leave it `doubtful` and say in the
wrap-up that the body did not come through.

## Before you classify, look at the attachments

The screenshot almost never comes glued to the text: they send the image and two lines
later the "look at this". `hilo` lists the case's messages in arrival order, with each
attachment as `media` (`type`, `bytes`, absolute `path`). When the case needs it, open
the image or the document with your own tools: an error screenshot carries the error
written out, and quoting it in the proposal is what makes it findable later. A message
without a `media` path has nothing to open: do not invent one and do not say you saw it.

## The content decides, not the chat

An operations group carries work for several clients. `wa-scope where "<text>" --chat
"<chat_jid>"` says which project the content points to. If the `workspace` comes back
null and the `provider` is not `ninguno`, a rule is missing: do not guess a project,
say so at the wrap-up and suggest which rule. With `ninguno` nothing is missing — that
is how the conversation was configured.
