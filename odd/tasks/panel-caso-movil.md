# Case side panel: conversation, attachments and mobile

## Objective

The owner now opens the board from the Orca mobile app. The case side panel shows the
summary and the proposal but never the client's messages or their attachments, although
the plugin stores both (`mensaje.media_path`, `caso ver` → `hilo`). Its close button scrolls
away with the content, and at phone width the detail opens inside the list, cramped.

## Scope

- Worker action `hilo` (read-only, through `scopeRequest`/`scopeResult` like the others):
  runs `wa-scope caso ver <id> --json` and answers with the case's latest messages
  (sender, time, mine or theirs, text, transcription mark) and their attachments (kind,
  size, file name; never the path). Images carry a small JPEG preview as a `data:` URI when
  one can be made (macOS `sips`, or ImageMagick), within the host's 64 KB per message: the
  answer is cut by whole messages, newest kept, and says how many were left out.
- Panel: opening a case asks for its conversation and shows it under "Conversation", with
  attachment rows and image previews; loading and error states.
- The detail header (id, stage, close) stays visible while the detail scrolls.
- At 768 px or less the detail opens as a full-screen sheet over the board, with its own
  scroll, the header fixed at the top, Escape and the close button closing it, and the page
  behind not scrolling.
- Mobile fixes seen in the 390 px screenshots: the stage filters wrap instead of being cut,
  and the history rows put who and when under what happened.

## Checklist

- [x] P1 Worker action `hilo` with previews and the 64 KB budget (`test/worker.test.mjs`).
- [x] P2 Panel conversation section (`test/panels.test.mjs`).
- [x] P3 Sticky header and full-screen sheet on narrow widths (`test/panels.test.mjs`).
- [x] P4 Mobile fixes: filters and history (`test/panels.test.mjs`).
- [x] P5 Screenshots 1440/768/390/320, light and dark; full checks; release.

## Acceptance criteria

- Opening a case shows its messages and attachments; an image shows a preview when the
  machine can make one, and its name and size otherwise.
- No file path reaches the panel.
- The close button is visible at any scroll position of the detail, at every width.
- At 390 and 320 px nothing is cut or overflows horizontally.

## Checks

- `node test/worker.test.mjs`, `node test/panels.test.mjs`, `scripts/check-panels`,
  `scripts/check-voseo`, `scripts/check-datos-reales`, screenshots.

## Release

v4.30.8. Checks on the final code: check-casos 2461/2461, panels 1738/1738, worker 728/728,
almacen 357/357, envio 138/138, sidecar-mensajes 142/142, sidecar-pairing 129/129,
sidecar-build 11/11, manifest 112/112, resolver 55/55, userdata 25/25, check-closing 36/36,
check-lid 51/51, check-clis, check-panels, check-voseo, check-prompts, check-resolver,
check-harness, check-datos-reales. RED observed for P1 to P4 before the code. Screens looked
at: `tablero-conversacion` and `tablero-conversacion-abajo` at 1440, 768, 390 and 320, light
and dark; `tablero-poblado` at 320. A real preview was made from a stored image (12 KB data
URI, 69 ms). Not verified live: the Orca mobile app itself.
