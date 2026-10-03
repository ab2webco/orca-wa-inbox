# CLI gaps (kanban T18) and a stable tool path

## Objective

Close the CLI gaps seen live and give agents outside the plugin a stable way to reach the
tools, so the Skills section (T24) can build on it.

## Scope

1. `wa-scope caso propuesta` can edit the proposal of a case in `listo` (today only in
   `clasificado`/`decision`): it goes back to `decision` with the new version and the
   approval cleared, with its event.
2. `wa-scope caso clasificar` can reclassify from `clasificado` (and `decision`) with an
   event, not only the first time.
3. `wa-send --approve <id>` approved by the owner leaves no draft row behind.
4. `wa-read wait "<chat>" [--after <stanza|ts>] [--timeout S] [--json]`: blocks until a new
   message arrives in that chat (authorized chats only, same scope rules as `wa-read chat`)
   or the timeout ends; exit codes documented in `--help` (0 message, 5 timeout, existing
   codes for no transport / ambiguous chat). Polls the store, never the socket.
5. A stable, user-level pointer to the installed plugin's `bin` (the `.wa-bin` idea, at a
   fixed location under the user's data dir that `wa_settings`/`harness.mjs` already
   resolve, e.g. `<userData>/plugins-data/<plugin>/bin-path` or `~/.wa-inbox/bin`), kept up
   to date by the worker on every start, so an agent in any project can run the tools of
   the plugin that is actually installed. Never a hard-coded path; works on macOS, Linux
   (`orca-ide` userData) and Windows paths the code already supports.
6. `COMMANDS.md`/skill text updated for the new commands; check-harness.

## Checklist

- [x] C1 propuesta en `listo` (check-casos). `listo -> decision` en la tabla de etapas; la
      misma propuesta en listo no escribe. El panel ofrece "Editar y enviar" en listo.
      Rojo: E_STAGE; verde: check-casos "editar la propuesta en listo" 7/7 (ae7507c).
- [x] C2 reclasificar (check-casos). Ya funcionaba en el CLI (desde clasificado toca el
      caso, desde decision vuelve a clasificado); se fijo con pruebas, sin rojo posible:
      check-casos "reclasificar" 4/4 (6619462).
- [x] C3 `--approve` sin borrador (test/envio.test.mjs). La fila `draft` de la actividad
      se quita al aprobar y al retirar. Rojo: la fila seguia; verde: envio 93/93 (0b1175d).
- [x] C4 `wa-read wait` (check-clis `revisa_espera` + sin transporte). Rojo: subcomando
      inexistente; verde: check-clis 233 comprobaciones (f0978b8).
- [x] C5 ruta estable del bin: `<dir de estado>/bin-path` (`~/.wa-inbox/bin-path`,
      `%APPDATA%\wa-inbox\bin-path`), escrito en cada siembra aunque no haya carpeta de
      trabajo. Rojo: no existia; verde: worker 398/398; check-harness compara la ruta con
      `wa_store.inbox_dir()` (2d5c716, 5d6fcea).
- [x] C6 docs/skill + `npm run check` en verde: COMMANDS.md, skill whatsapp-cli y README;
      check-harness exige `bin-path` y `wa-read wait` (5d6fcea). `npm run check` sale 0.
