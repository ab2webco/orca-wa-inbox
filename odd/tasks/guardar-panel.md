# guardar-panel

## Objective

The panel's per-chat Save never reports success it did not get, a save is never lost to a running sync, and what the owner saves for a chat is what the case agents load. Also: a burst of messages is judged as a whole, and a project worker can report to another chat when the owner or a Super admin asked.

## Scope

- `config.html` `save-scope` handler (and the other scope writes that share `escribirAlcanceVisto`): check the host result, retry a host rejection, show the failure, and keep the form when it fails. Read back the written entry before saying saved.
- `bin/wa-scope` `push_to_plugin` / `plugin_store_write`: inside the locked read-modify-write, a chat entry that the panel changed after the sync read it (newer `updatedAt`) wins over the sync's copy.
- Stale copy: the principal line's leftover in `alcancePorLinea[<principal>]` is not used by anyone and drifts. Drop it on sync, so no reader crosses an old copy.
- Burst verdicts (`agrupa_rafagas`, `mensaje_de_rafaga`, `jev_cacheado`): a cached Jev verdict is reused only for the same set of messages. A first message judged alone does not decide a later, larger burst.
- Worker to another chat: on a case of the owner or a Super admin, the project worker can send its `caso resultado` (resuelto) to another chat of the same line in `responder` with `--chat`. It is held for the owner's approval, as `caso propuesta --chat` is. The brief tells the worker how. `caso avance --chat` is G7, deferred to a later version: an update is sent at once and the approval path (board and `si N`) only signs the case's single proposal, so a held update needs its own approval channel.

## Checklist

- [x] G1 RED then GREEN: a host write rejection on Save shows an error, not "saved", and keeps the form (panels test).
- [x] G2 RED then GREEN: a panel save landing between the sync's read and its write survives (check-clis).
- [x] G3 RED then GREEN: the principal line's copy in `alcancePorLinea` is removed on sync, and the other lines' copies stay (check-clis).
- [x] G4 RED then GREEN: a burst whose first message was judged alone is judged again as a whole, and its text-bearing messages are not dropped (check-casos or check-clis).
- [x] G5 RED then GREEN: the worker of an owner case can send its resultado to another chat, held for approval. A customer case gets E_DEST_ROLE. The dispatch brief documents it.
- [x] G6 Version bump (orca-plugin.json only), `npm run check` without shots.
- [ ] G7 Deferred to a later version: `caso avance --chat`, held for the owner's approval (needs its own approval channel).
- [x] G8 RED then GREEN: the sweep never retries a sleeping terminal (no close, no /exit) and a sleeping terminal is not counted as alive (check-casos).
  - Not doable from the plugin (Orca source, 1.4.160-lab.89): a CLI/RPC close is `runtimeInitiated` and keeps the agent's resume record, so closing the triage tab while live would still leave a sleeping row (and cut the run short). The manifest automation schema has no `reuseSession`/workspace-mode/close option, and reuse is unsafe for a Claude that exits by itself. No CLI/RPC/plugin call removes a sleeping record: the owner releases them in Settings > Resume Vault > "Release all".

## Acceptance

- Save says saved only when the host accepted the write and the read-back matches.
- No real phone numbers, lids, names or chat names in the repo.

## Checks

`npm run check` (without shots), `scripts/check-clis`, `scripts/check-casos`, `node --test test/panels.test.mjs test/worker.test.mjs`.
