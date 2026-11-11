# WAINBOX-87: attachment previews do not show in the panel

## Objective
Image and sticker attachments in the case detail ("Conversation" section of the board
side panel) show their `data:` preview again in the live plugin.

## Scope (what has previews at all)
- Only the case detail renders previews (`activity.html` `adjuntoNodo`, ~line 2869), and only
  for `imagen` and `sticker` (`hilo.mjs` `TIPOS_CON_VISTA`). Incoming and agent-sent take the
  same path, so both fail.
- PDF, audio, video and documents never had a preview by design: they show a caption
  (type, size, name). The board card and the chat list only carry `hasMedia`/`mediaKind`.
  Not part of this bug.

## Root cause (verified)
- Orca starts the plugin worker with Node's permission model: `--permission`,
  `--allow-fs-read=<plugin root>`, `--allow-fs-read=<host dir>` and nothing else
  (orca-oss `src/main/plugins/plugin-worker-sandbox-args.ts:11-17`).
- The `hilo` action (`acciones.mjs:438-443`) calls `hiloParaPanel(c.hilo)` with the default
  `vistaPrevia` (`hilo.mjs:55`), which runs `stat`/`readFile` on `~/.wa-inbox/media/...` and
  `mkdtemp(tmpdir())` INSIDE the worker. Under the fence that throws `ERR_ACCESS_DENIED`.
- `hiloParaPanel` swallows it (`hilo.mjs:118`, `catch { }`): the attachment goes out with no
  `vista` and no `sinVista`, so the panel shows only the caption.
- Reproduced: `node --permission --allow-fs-read=<repo> --allow-child-process` + `vistaPrevia`
  on an image outside the repo -> `ERR_ACCESS_DENIED`; the same call without the fence returns a
  ~10 KB `data:image/jpeg`. Live store checked read-only: all stored media paths exist, the
  last `hilo` verdict in the live storage had no `vista` on any attachment.
- Why tests missed it: the P1 hilo test in `test/worker.test.mjs` runs the worker unfenced.
- Not the cause: host CSP allows `img-src data:` (orca-oss `src/shared/plugins/plugin-panel-shell.ts:27`).

## Planned fix
Build the preview in a subprocess OUTSIDE the fence, same pattern as `aprobador.mjs` /
`llaveAprobador` in `main.mjs` (~line 1137) using `mandoSinValla` + `ELECTRON_RUN_AS_NODE=1`:
1. `hilo.mjs`: a CLI entry (`node hilo.mjs <path>` prints one JSON line
   `{"ok":true,"vista":"data:..."}` / `{"ok":false}`), reusing `vistaPrevia`.
2. `main.mjs`: export `vistaSinValla(ruta)` that runs it via `mandoSinValla(process.execPath,
   [HILO_SCRIPT, ruta])` (timeout ~10 s, maxBuffer ~256 KB), returns the `data:` string or null;
   cache by path (media files are immutable). Pass it as `vista` to `crearAccionesCaso`
   (`main.mjs:3381`).
3. `acciones.mjs`: `crearAccionesCaso({ ..., vista })` and `hiloParaPanel(c.hilo, vista)`
   (default `vistaPrevia` when not given).

## Checklist
- [x] T0 Diagnosis + RED tests written (`test/worker.test.mjs`, block "WAINBOX-87", end of file):
      fenced child imports `main.mjs` `vistaSinValla` (does not exist yet) and asserts a `data:`
      preview; unit asserts the `hilo` action uses the injected `vista`.
- [x] T1 Observe RED: run `node test/worker.test.mjs` (slow, >10 min on this suite) and confirm
      only the 2 new WAINBOX-87 assertions fail (the "inside the fence -> no preview" one should pass).
- [x] T2 Implement steps 1-3 above; GREEN.
- [x] T3 `npm run check` without shots; then reduced shots of the case detail only
      (WA_INBOX_SOLO/TEMA/ANCHO/IDIOMA) and look at them.
- [ ] T4 Conventional commit(s), PR to main, report link + root cause to the lead. Do not merge.

## Notes (T2-T3)
- `hilo.mjs` CLI never prints the path; errors carry only the system code (like `aprobador.mjs`).
- `vistaSinValla` caches only successes (max 200, by path); a failure is retried next open.
- The shots use a stubbed `hilo` verdict, so they show the panel side only; the worker side is
  covered by the fenced WAINBOX-87 test.

## Checks
`node test/worker.test.mjs`, `npm run check` (shots reduced). Fake data only (public repo).
