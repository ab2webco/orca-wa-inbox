---
name: whatsapp-avisos
description: Notify the owner on WhatsApp and, when you need a decision from him, ask and wait for his reply. Use it when a long task finished, when you are blocked on something only he can decide, or when he asked to be told. Only the owner; never anyone else.
---
<!-- Written by the WhatsApp Inbox plugin (ab2web.orca-wa-inbox), installed from its
     settings (tab Skills).

     What happens to this file on the next update:

       · A `##` section you did NOT touch is replaced with the new version.
       · A `##` section you edited is yours from then on: the plugin keeps your
         text and never rewrites that section again. The rest keeps updating.
       · A `##` section you add is kept, at the end of the file.
       · Remove it from the plugin settings. If you delete the file by hand, the
         plugin takes it as removed and does not write it again. -->

# WhatsApp notices to the owner

The WhatsApp Inbox plugin keeps a WhatsApp line linked on this machine. With it you can
tell the owner something, or ask him and wait for the answer, from any project.

## Find the tools

The plugin writes the path of its tools to a fixed file and keeps it current when it
updates. Never call a bare `wa-send` from `PATH` and never write a path by hand:

    WA="$(cat "$HOME/.wa-inbox/bin-path" 2>/dev/null)"
    [ -x "$WA/wa-scope" ] || [ -z "$APPDATA" ] || WA="$(cat "$APPDATA/wa-inbox/bin-path" 2>/dev/null)"
    [ -x "$WA/wa-scope" ] || { echo "WhatsApp Inbox is not installed or not enabled in Orca" >&2; exit 1; }

`$APPDATA/wa-inbox/bin-path` is the same file on Windows. If neither names an executable
`wa-scope`, the plugin is not enabled: say so and stop. Do not look for it elsewhere.

## Find the owner's chat

The chat comes from the plugin settings, never from you:

    OWNER="$("$WA/wa-scope" owner)"

It prints only the chat id. It is the approval number the owner picked in the settings or,
without one, the linked line's chat with itself. `"$WA/wa-scope" owner --json` says which
(`source`) and its mode. Exit codes:

- `1` with `no-owner-chat`: there is no owner chat. Tell the user in this session that the
  owner has to pick an approval number in the plugin settings, and stop.
- `3` with `owner-chat-not-authorized`: the chat is not in Automatic, so a send would only
  leave a draft. Tell the user, and stop.

## Notify him

    "$WA/wa-send" "$OWNER" "Build of project-x finished: 3 tests failing in checkout." --send --json

It prints `{"req_id", "estado": "enviado", "stanza_id"}` on exit 0. Add `--id <unique id>`
when you may retry: the same id is delivered once.

## Ask and wait for his reply

Send the question, keep its `stanza_id`, and wait in the same chat:

    S="$("$WA/wa-send" "$OWNER" "Deploy project-x to staging now? Reply yes or no." --send --json \
         | python3 -c 'import json,sys; print(json.load(sys.stdin)["stanza_id"])')"
    "$WA/wa-read" wait --chat "$OWNER" --after "$S" --timeout 900 --json

- Exit `0`: his reply, oldest first, each with its `text` and `stanza_id`. If it does not
  answer the question, ask once more, waiting `--after` the last `stanza_id`.
- Exit `5` with `wait-timeout`: he did not answer in time. Do not take silence as a yes.
  Leave the work in a safe state, say in this session what is waiting for him, and stop.
  Do not ask again in a loop.
- Exit `3` with `chat-not-authorized`, or `4` with `no-transport`: the line cannot be read
  now. Say so and stop.

Ask one concrete question he can answer from his phone in a word or two.

## Rules

- Never send a credential, a token, a password, a key or a secret, not even partly. A
  secret-shaped value is held by the plugin anyway; do not try to get it out another way.
- Keep it short: one to three lines, plain text, what happened and what you need. Never
  paste logs, diffs, stack traces or long output; say where to find them.
- Never message anyone but the owner with this skill. Only `$OWNER`, as printed by
  `wa-scope owner`; never a customer, a group or a number you found somewhere else.
- You cannot approve anything. A message the plugin holds (`send-needs-approval`, exit 3)
  waits for the owner, on the plugin's board or by his WhatsApp reply; `wa-send --approve`
  refuses any agent with `send-approve-not-owner`. Never retry around a hold: tell the
  user what is waiting.
- Do not notify on every step. Tell him when something finished, failed, or needs him.
