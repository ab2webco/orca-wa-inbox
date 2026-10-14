# A line that is unlinked leaves nothing behind

## Objective

The owner unlinked his second line and kept one. The nav badge still said 1 and the board
showed nothing: the stored board of the gone line (`porLinea[<line>]`) kept a case in
`decision` and the badge sums every stored board. Unlinking a line must stop everything of
that line from counting, showing or running, while the remaining line keeps working.

## Evidence (owner machine, read-only, 2026-10-13)

- `store_meta.lineas_activas` names only the remaining line (the sidecar retired the other).
- Panel storage still has `porLinea[<gone>]` with `board.counts.decision == 1`, so
  `navBadge == {"count": 1}` while the visible board (remaining line) has `decision == 0`.
- The panel hides the line selector with one linked line, so the case cannot be reached.

## Scope

- Badge: only the boards of lines in `lineas_activas` count.
- Everything else found stale after an unlink (see the checklist), fixed in this branch.
- Out of scope: changing how a line is linked; deleting cases of the gone line (they stay in
  scope.db as history).

## Found after unlinking (exploration, 2026-10-13)

What unlinking cleans today: `desvincularLinea` (main.mjs) stops the sidecar, deletes the
auth folder, drops the line from the worker registry; the store retires it from
`lineas_activas`. Nothing in the panel storage, scope.db or the outbox is touched.

1. Unlinking the PRINCIPAL: the remaining line becomes principal and reads the root keys,
   which are the gone line's (agent name, tone, approval number, scope, board). Its own
   `ajustesPorLinea`/`alcancePorLinea`/`porLinea` entries are ignored, and its stale
   `porLinea` board is summed into the badge on top of the root board.
2. The badge sums the stored board of the gone line (the owner's report).
3. Dispatches left in flight on the gone line are never closed (only that line's tick
   closes them) and protect their tabs and worktrees from the cleanup forever.
4. Pending notices of the gone line never expire; drafts of the gone line are listed by
   `wa-send --drafts` and cannot be approved (no transport).
5. Jev status and the Orca waiting-notice gate still read the gone line's settings.
6. Relinking the same number revives the old scope (permissions) and settings, against the
   deny-by-default rule of `accounts --forget`.

## Checklist

- [x] D1 Badge counts the root board plus the boards of the other ACTIVE lines only (never
  `porLinea[<principal>]`); a write drops `porLinea`/`informesPorLinea` entries of lines
  that are not active (check-casos L3, RED then GREEN). RED: badge 3 vs principal 1
  (2396/2397); GREEN 2401/2401.
- [x] D2 Unlink removes the gone line from every per-line container and `skillsLine`; when
  the gone line was the principal, the remaining line's own data moves to the root
  (`quitarLineaDelStorage`, worker.test D2, RED then GREEN). RED: unit block crashed
  (function missing); integration assertion failed with the call disabled. GREEN: 719/719.
- [x] D3 Jev status and the Orca waiting gate read only linked lines (worker.test D2 block).
  RED observed against the previous code (both false), GREEN in the 719/719 run.
- [x] D4 The principal's tick cancels dispatches in flight and fails pending notices of
  lines that are no longer active (`linea-desvinculada`); `wa-send --drafts` lists only
  active lines (check-casos L3). RED with D1 applied and D4 removed: the 3 D4 checks failed
  (2398/2401); GREEN 2401/2401; check-clis 542 and envio 138/138 green.
- [x] D6 (reported live during this task) A reaction is not a message: the owner's ❤️ was
  stored as an empty message, opened case "sin texto" and the agent replied that it arrived
  empty. `filaDeMensaje` now drops content-less control messages (reaction, encrypted
  reaction, protocol, poll vote, pin, keep) and messages with no content; text, emoji text
  and media still produce a row. RED 128/132, GREEN 132/132; almacen 353/353, pairing
  120/120, bundle rebuilt, sidecar-build 11/11.
- [ ] D5 Release: version bump, full check set, reduced shots only if a panel changed.

## Acceptance

- With two lines and one case waiting in each, the badge is 2; after the second line is
  retired and the board republished, the badge is 1.
- Full suite green; reduced shots if a panel changes.

## Checks

`scripts/check-casos`, the suites touched, then the release check set.
