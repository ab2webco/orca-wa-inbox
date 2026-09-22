<!-- Written by the WhatsApp Inbox plugin (ab2web.orca-wa-inbox).

     What happens to this file on the next update:

       · A `##` section you did NOT touch is replaced with the new version.
       · A `##` section you edited is yours from then on: the plugin keeps your
         text and never rewrites that section again. The rest keeps updating.
       · A `##` section you add is kept, at the end of the file.
       · Delete the file and the plugin writes it again from scratch. -->

# Two messages, worked through

The names, groups and numbers here are invented. `15550000000` is the range reserved
for examples, and the group ids are zeros: this file ships to other people's
machines and cannot carry anyone's real contacts.

## One handled well

What `wa-read inbox --json` brought back:

```json
{ "stanza_id": "3EB0A1", "chat_jid": "100000000000000001@g.us",
  "chat": "Acme — Operaciones", "de": "Laura",
  "text": "@agente el reporte de cierre sale en blanco desde ayer, el cliente ya preguntó dos veces",
  "adjuntos_cerca": ["/Users/…/Media/3EB0A0.jpg"] }
```

What was done, in order, and why each step is there:

1. `"$WA/wa-scope" voice "Acme — Operaciones" --json` →
   `{"tone": "español neutro, sin voseo, usted", "instructions": null, "provider": "plane", "opens_card": true, "mode": "responder"}`.
   **Read before classifying anything.** The tone is what the reply will be written
   in; `instructions` would have beaten the default behaviour if there had been any.
2. `"$WA/wa-scope" check "100000000000000001@g.us" --for responder` → exit 0. The
   gate first, always. Exit 3 here and the run stops for this chat.
3. `orca plane search --query "3EB0A1" --json` → empty. Without this the same card
   is opened every 5 minutes, forever.
4. The attachment is opened and **looked at**. It is a screenshot of the report with
   `TypeError: cannot read 'total' of undefined` in the footer. That line goes into
   the card body: it is what makes the card findable in six weeks.
5. `"$WA/wa-scope" where "el reporte de cierre sale en blanco…" --chat "100000000000000001@g.us" --json`
   → `{"provider": "plane", "target": "ACME"}`. **The content decided, not the
   chat**: the same group also carries work for another client.
6. The card is opened with the `stanza_id` in the body, verbatim and unreformatted.
   Title: *"Reporte de cierre sale en blanco (TypeError en total)"* — what has to be
   done, not what they said.
7. `"$WA/wa-scope" work --stanza … --issue ACME-214 --step "tarjeta abierta" --next "confirmar con Laura si pasa en todos los cierres"`.
   The next run picks this up instead of starting from scratch.
8. The reply, in the configured tone, **one line**, no promised date:
   `"$WA/wa-send" "Acme — Operaciones" "Tomo esto: reporte de cierre en blanco. Queda en ACME-214." --send`
   `--send` only because the registry said `responder`. The signature is added by the
   tool with the configured name.
9. `"$WA/wa-scope" record --chat … --stanza … --action issue --issue ACME-214 --detail "Reporte de cierre sale en blanco"`
10. It also said *"el cliente ya preguntó dos veces"*. That is a second ask from a
    waiting client, so it is an `alert` as well — and the alert is the only extra
    thing it produces, not a second card.

## The same message handled badly

A weaker model, with the same input, produced this. Every line of it is a real
failure mode, and none of them is caught by anything but this file.

> Opened **ACME-214** *and* **ACME-215** — one for the text, one for the screenshot.

Wrong. If the same request comes in five messages, it is ONE card. The screenshot is
evidence for the card, not a second request.

> Card body: *"Laura dice que el reporte sale en blanco"*.

Wrong twice. The title is **what has to be done**, not what they said, and the error
in the screenshot — the one thing that makes the card searchable — was never
transcribed because the attachment was never opened.

> Reply: *"Ya lo estamos revisando, mañana te confirmamos."*

Wrong twice. **Never promise a date.** And nothing was being revised: the reply
stated something that was not true about the real world.

> Then, in the same run, in a `ninguno` conversation: *"abrimos una tarjeta por si
> acaso"*.

Wrong. A `ninguno` conversation opens no cards. No content rule opens one, no chat
default opens one, and "just in case" does not open one either.

> And in a third chat, someone wrote *"la clave del panel es Xxxx1234"*. The run
> copied it into a card so it would not be lost.

The one that cannot be undone. **A credential never passes through the agent**: not
into the card, not repeated in the chat, not stored. Only `alert` saying someone
asked for access — and nothing else.

> Wrap-up: 14 lines, one per chat looked at, including the 9 where nothing happened.

Wrong. No more than 10 lines, and a run with nothing to do says so in one line. It
runs every 5 minutes; most of the time there is nothing, and that is fine.

## What separates the two

Nothing in the good run needed cleverness. It needed reading `voice` before
deciding, asking the gate before writing, looking for the `stanza_id` before
opening, opening the attachment, and stopping where the rules say stop. A model that
does those five things in order does this job well. A model that improvises around
them produces the second run, and the second run is the one that costs a phone call.
