# panel-urgente

Three defects the owner hit in v4.27.4, all of them costing real usability, plus the
reporting gap that let one of them stay invisible for six days.

## Objective

A chat edit saves. A button acts on the first click. A stalled agent is visible on the
panel instead of having to be found by reading the database.

## What is actually wrong

### D1 — A chat edit can never be saved (deterministic, not flaky)

`config.html` writes the WHOLE `scope` object in ONE host message on every save
(`escribirAlcanceVisto` → `write('scope', next)`). Orca caps a single panel message at
`PANEL_MESSAGE_MAX_BYTES = 64 * 1024` (verified in the installed app, at
`out/shared/plugins/plugin-panel-bridge.js:28`). Over the cap the host answers
`errorCode: 'invalid_request'`, "Message exceeds the size limit."

Measured on the owner's machine: `scope` is **89,116 bytes**. Five entries carry 11k-18k
characters of `instructions` each. Every save of every chat is refused, and the three
retries in `guardarAlcanceConfirmado` cannot help — nothing about the payload changes
between them.

Only inbound messages are size-checked; `respond` is not. Reads of the 89 KB blob keep
working, which is why the panel lists the chats correctly and only saving fails.

### D2 — Buttons need two clicks

`renderScope` rebuilds its whole table with `el('scope-wrap').innerHTML = ...`, and
`reload(true)` runs on a 12-second `setInterval`. A repaint landing between `mousedown`
and `mouseup` destroys the button node, so no `click` event fires. The first click is
swallowed; the second one happens to fall between repaints.

### D3 — The panel measures the service but never the machinery

The Reports tab covers first response, resolution, SLA and stages: all of it about the
client's experience. Nothing charts what the automation itself did. The `juicio` table
holds every verdict and no view reads it, so ~70 `card` verdicts piled up between Oct 4
and Oct 9 2026 with no agent output after Oct 3 and the panel showed nothing wrong.

### Why the suite did not catch D1

The panel test stub answers `storage.set` with `{ ok: true }` whatever the payload
weighs (`test/panels.test.mjs:78`). It never modelled the host's size cap, so the one
failure mode that matters here was unreachable from a test.

## Scope

In: `config.html`, `test/panels.test.mjs`, `test/shots.mjs`, `activity.html`, and the
`wa-scope` report that feeds D3. Out: anything in the Orca host, and the Jev threshold
recalibration discussed separately.

## Tasks

- [x] **U1** Teach the test stub the real limit: `storage.set` over 64 KB answers
      `{ ok: false, errorCode: 'invalid_request' }`, exactly as the host does. Expect the
      current save test to go RED.
- [x] **U2** Keep every panel write under the cap. `scope` stops being one blob: each
      chat is its own key, with a small index, and a migration that splits an existing
      oversized `scope` on first read without losing a single entry.
- [x] **U3** Say what actually happened. A refusal for size must not be reported with the
      generic "the host did not confirm the write"; the owner needs to know the payload
      was too big and which chat carries the bulk.
- [x] **U4** A repaint must never destroy a control the user is pressing. The scope table
      stops being rebuilt wholesale while a pointer is down on it.
- [x] **U5** The Reports tab gains the machinery: verdicts by class, how many `card`
      verdicts the agent actually resolved, and when the agent last produced anything.
- [x] **U6** Screenshots at 1440/768/390/320 in both themes, version bump, release.

## Acceptance criteria

- Saving a chat edit on a store the size of the owner's current one succeeds, and the
  entry's `updatedAt` changes in storage.
- No single panel write exceeds 64 KB, asserted by the stub for every write the suite
  makes, not only the scope one.
- A size refusal reaches the owner as a size refusal.
- A click whose `mousedown` and `mouseup` straddle a 12-second repaint still fires.
- An agent that stopped producing is visible on the panel without opening the database.

## Checks

`npm run check` (full suite), plus the reduced shots the owner prefers for a release.

## Verified so far

- `test/panels.test.mjs`: **1662/1662 green** with U1-U4 in place, after the stub learned
  the host's real 64 KB cap. The RED before the fix was exactly the owner's bug:
  `rechazadas por tamano: ["scope","scope","scope"]` — three attempts, all refused.
- `test/worker.test.mjs`: green, including the new `guardar` action (merge, whitelist,
  jid change, invalid entry).
- Two defects of my own that the tests caught, both fixed: merging onto `next[jid]` lost
  `provider`/`target` when a group changed jid, and a two-line test's hook was written for
  `quitar` only and swallowed the save.

## Verified at the end

- Full `npm run check`, all thirteen: the ten `scripts/check-*`, the sidecar build and
  its three suites, `almacen`, `envio`, `manifest`, `resolver`, `userdata`, `panels`
  (**1668/1668**) and `worker`. None skipped.
- Reports photographed at 1440, 768, 390 and 320 in both themes (48 shots, the harness
  reporting no overflow, no JS error). Looked at: the engine block at 1440 light, 768
  dark, 390 light and 320 in both themes, stalled and healthy.
- What looking at them caught, and the tests did not: the block painted `card`, `alert`
  and `nothing` but dropped `doubtful`, which `wa-scope` already ships. The three shown
  add to 187 of 214 judged, so the numbers could not be reconciled, and the class that
  most deserves a look was the invisible one. Fixed with the assertion first.
