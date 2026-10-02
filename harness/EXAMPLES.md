<!-- Written by the WhatsApp Inbox plugin (ab2web.orca-wa-inbox).

     What happens to this file on the next update:

       · A `##` section you did NOT touch is replaced with the new version.
       · A `##` section you edited is yours from then on: the plugin keeps your
         text and never rewrites that section again. The rest keeps updating.
       · A `##` section you add is kept, at the end of the file.
       · Delete the file and the plugin writes it again from scratch. -->

# Two cases, worked through

The names, groups and numbers here are invented. `15550000000` is the range reserved for
examples, and the group ids are zeros: this file ships to other people's machines and
cannot carry anyone's real contacts.

## One handled well

`wa-scope pending --needs-agent` printed case 41. `wa-scope caso ver 41 --json` brought
back, abridged:

```json
{ "case_id": 41, "etapa": "clasificado", "clase": "card", "chat_jid": "100000000000000001@g.us",
  "hilo": [
    { "stanza_id": "3EB0A1", "from_me": false, "sender": "Laura", "respondido": false,
      "text": "@agente el reporte de cierre sale en blanco desde ayer, el cliente ya preguntó dos veces",
      "media": null },
    { "stanza_id": "3EB0A2", "from_me": false, "sender": "Laura", "respondido": false,
      "text": "mira lo que me sale", "media": { "type": "imagen", "bytes": 48213,
      "path": "/home/example/.wa-inbox/media/3EB0A2.jpg" } } ] }
```

What was done, in order, and why each step is there:

1. `"$WA/wa-scope" voice "100000000000000001@g.us" --json` →
   `{"tone": "español neutro, sin voseo, usted", "instructions": null, "mode": "responder"}`.
   **Read before drafting anything.** The tone is what the reply is written in.
2. `"$WA/wa-scope" check "100000000000000001@g.us" --for responder` → exit 0. The gate
   first, always. Exit 3 and the run stops for this chat.
3. Only the messages after the last reply sent are acted on. Here there is none, so both
   count.
4. The case needs the project's code, and the attachment is a screenshot: the image was
   opened and **looked at**. It shows `TypeError: cannot read 'total' of undefined`.
5. `"$WA/wa-scope" where "el reporte de cierre sale en blanco" --chat "100000000000000001@g.us" --json`
   → `{"workspace": "acme-reports"}`. **The content decided, not the chat.**
6. `"$WA/wa-scope" caso propuesta 41 --tipo trabajar --actor agente --instrucciones "<brief>"`.
   The brief quotes both messages VERBATIM, in order, in a quoted block. Below it, marked
   as interpretation: "the report seems to fail in the footer total (error in the
   screenshot)". Open questions for the project agent: "Does it fail for every closing or
   only this client's?". It does not say who Laura is. It says what to answer once done,
   with no date.
7. It also said *"el cliente ya preguntó dos veces"*, a waiting client, so the case was
   classified `alert` and the proposal reaches the owner, who decides on the board.
8. Wrap-up: one line, `41 → trabajar (alert: client waiting)`.

Nothing was sent. The owner approves the proposal on the board and the plugin runs it.

## The same case handled badly

A weaker model, with the same input, produced this. Every line is a real failure mode.

> Proposed `responder`: *"Ya lo estamos revisando, mañana te confirmamos."*

Wrong three times. **Never promise a date.** Nothing was being revised, so the reply
stated something untrue. And `te` is not the tone the chat is configured for.

> Told the owner which button to press to resolve the case.

Wrong. The owner's board actions are **Atender ahora**, **Autorizar** and **Ignorar**,
and they are the owner's: you do not instruct the owner, you propose and list the case
at the wrap-up.

> Ran `wa-send "Acme" "Tomo esto" --send` to answer at once.

Wrong. **You never send anything on WhatsApp.** A reply travels as a proposal.

> Brief: *"Laura (the client's PM) says the closing report fails because of the total"*.

Wrong. Nothing in the case says who Laura is, and "because of the total" is a guess
presented as a fact. The messages go VERBATIM; the reading goes below, marked as
interpretation, and who Laura is stays an open question.

> A voice note read `audio sin transcribir: sin_motor`, and the run proposed *"entendido,
> lo revisamos"*.

Wrong. It could not hear it. Leave the case `doubtful` and say so at the wrap-up.

> In another chat someone wrote *"la clave del panel es Xxxx1234"* and the run copied it
> into a brief so it would not be lost.

The one that cannot be undone. **A credential never passes through the agent.**

> Wrap-up: 14 lines, one per chat looked at, including the 9 where nothing happened.

Wrong. No more than 10 lines, and a run with nothing to do says so in one line.

## What separates the two

Nothing in the good run needed cleverness. It read `voice` before drafting, asked the
gate before touching the chat, acted only on what came after the last reply, opened the
attachment, quoted verbatim and stopped where the rules say stop. A model that does
those things in order does this job well.
