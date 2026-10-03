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

- [ ] C1 propuesta en `listo` (check-casos).
- [ ] C2 reclasificar (check-casos).
- [ ] C3 `--approve` sin borrador (check-clis / check-casos).
- [ ] C4 `wa-read wait` (check-clis).
- [ ] C5 ruta estable del bin (worker test + check-harness).
- [ ] C6 docs/skill + `npm run check` en verde.
