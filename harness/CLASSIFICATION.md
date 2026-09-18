<!-- Written by the WhatsApp Inbox plugin (ab2web.orca-wa-inbox).

     What happens to this file on the next update:

       · A `##` section you did NOT touch is replaced with the new version.
       · A `##` section you edited is yours from then on: the plugin keeps your
         text and never rewrites that section again. The rest keeps updating.
       · A `##` section you add is kept, at the end of the file.
       · Delete the file and the plugin writes it again from scratch. -->

# What each message is

This table came out of classifying 266 real mentions over 90 days. **Half of them
are not work.** Erring on the side of opening cards fills the board with junk and
teaches the owner to ignore it.

## The table

| What arrives | What you do |
|---|---|
| **Asks for a review / help** with something concrete | Card. It is the most common case (51 of 266). |
| **Reports something broken** | Card, and if it says it is down or that a client is waiting, also `alert`. |
| **Sends an already created ticket** (Plane/Jira URL) | **Do not open another one.** Comment on that one, or leave it in `work` to follow it. Duplicating is worse than doing nothing. |
| **Asks about the status** of something in progress | **Do not open a card.** Look in `work` and on the board, and answer with the real status. If you do not know it, do not answer. |
| **Asks for a deploy / a release to production** | `alert`, never a card on its own. Shipping is a decision with consequences; an agent does not schedule it. |
| **Asks for access, a password, a credential or a token** | **Do not touch it. No card, no reply, do not repeat it in the chat.** Only `alert` saying someone asked for access. A credential does not pass through you. |
| **Quote, price, hours, billing** | `alert`. It is money: a human decides. |
| **Asks for a decision or an approval** | `alert`. Price, scope, date, priority, hiring: not yours. |
| **Meeting, calendar, Teams link** | Nothing. It is not support. |
| **Greeting, joke, "thanks", "ok"** | Nothing. They are 40 of 266; do not answer pleasantries. |
| **Mentions you along with 4 or more people** | Almost always a notice to the team, not a request to you. Treat it as DOUBTFUL unless the text asks you for something explicit. |
| **Only your mention, with no text**, or text that asks for nothing | Nothing. They are the bulk of what has no pattern. |
| **You are not sure** | DOUBTFUL: open nothing, list it at the wrap-up. The human resolves it with Take or Ignore and on the next run it reaches you decided. |

If the same request comes in five messages, it is ONE card.

## The two that beat any doubt

1. **A credential never passes through the agent.** If the message carries a
   password, do not copy it into the card, do not repeat it, do not store it.
   Report it and nothing else.
2. **When in doubt, do not open a card.** A DOUBTFUL costs one line in the wrap-up;
   one card too many costs nobody ever looking at the board again.

## Before you classify, look at the attachments

The screenshot almost never comes glued to the text: they send the image and two
lines later the "look at this". That is why `adjuntos_cerca` exists.

The paths are real unencrypted files: **open them and look at them**. An error
screenshot carries the error written out; transcribe it into the card, which is what
makes it searchable.

Audio (`.opus`) you cannot hear: say so and leave it as DOUBTFUL.

## The content decides, not the chat

An operations group carries work for several clients; sending everything to the
chat's destination puts half of it on the wrong board. That is what
`wa-scope where "<text>" --chat "<chat_jid>"` is for.

If `target` comes back null and the `provider` is not `ninguno`, do NOT open a card:
a rule is missing. Say it at the wrap-up and suggest which one. With `ninguno` no
rule is missing — that is how the conversation was configured — so do not suggest
one.
