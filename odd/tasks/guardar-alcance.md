# A panel save during a sync is kept

## Objective

The owner authorized a group in the panel, pressed Save, saw it, and later it vanished: no
row in `chat_scope`, no entry in the storage `scope` nor in `alcancePorLinea`.

`push_to_plugin` (bin/wa-scope) read the panel scope at the start of the sync, spent up to
~120 s reading WhatsApp, and at the end wrote that start snapshot over the storage. A Save
made in that window was erased before the next `persistir_panel` could take it to
`scope.db`. The same stale write resurrected a chat removed mid-sync.

A second bug on the same path: `merged_scope` took a panel `chatName` equal to the jid over
the real name in `chat_scope.chat_name`, and the sync wrote the jid back to the panel, so
the name never healed. `persistir_panel` already guarded that case.

## Scope

- T1. RED check: a panel save (and a removal) during `push_to_plugin`, on the main line and
  on a second line (`alcancePorLinea[<account>]`).
- T2. Rebuild the scope from the panel right before the final write (`alcance_al_panel`,
  which runs `persistir_panel`, an idempotent upsert, and a fresh `merged_scope`). The early
  build stays because activity needs it; `grupos` is kept as computed.
- T2b. A panel `chatName` that is empty or equal to the jid falls back to the stored name in
  `merged_scope` (RED check first).
- T3. Release bump 4.27.2 -> 4.27.3.

Out of scope: moving the re-read inside the storage lock. The window is now milliseconds
instead of the whole sync.

## Checklist

- [x] T1 check `revisa_guardar_durante_sync` (RED observed on both lines)
- [x] T2 re-read before the final write (GREEN)
- [x] T2b check `revisa_nombre_que_es_jid` (RED observed) and fix (GREEN)
- [ ] T3 Release

## Acceptance criteria

- A chat saved in the panel while a sync runs is in the storage scope and in `chat_scope`
  with its mode after the sync, on the main line and on a second line.
- A chat removed while a sync runs is not brought back.
- A panel entry whose `chatName` is its jid gets the name from `chat_scope` after a sync.

## Checks

- `scripts/check-clis`: pass (504 checks, 8 CLIs).
- `npm run check` without `npm run shots`: every step passes. `check-casos` failed P3 (dispatch
  account per line) once in the chain and passed 2029/2029 on rerun with the same code;
  `test/worker.test.mjs` stopped mid-run once in the chain and passed 589/589 alone.
- Shots skipped: no UI change.
