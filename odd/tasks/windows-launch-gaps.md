# Windows launch gaps: finish issue #78 after PR #79

## Objective

PR #79 fixed the core of #78 (tool launch on win32, sidecar fence). Close the parts
it left open so the issue can be closed, without changing any macOS/Linux command line.

## Scope

- `harness.mjs` `corre()`: run `wa-*` through `mandoHerramienta` (the harness seeds the
  command reference from `--help`; on win32 it gets ENOENT and marks `sin-herramientas`).
  The worker passes the interpreter by `PYTHON_ENV`, as it does for the sidecar.
- `sin-python`: a stable code, decided at interpreter resolution (not from the spawn
  error), carried by `run()` errors, read by `motivoDe` and `checkSystem`, and translated
  in `config.html` / `activity.html` (es/en/pt). A negative resolution is re-probed on the
  health round, never cached forever.
- Python siblings still launched by bare path: `bin/wa-scope` `wa_chats()` and
  `bin/wa-transcribe` `ajustes()`. Widen the `check-clis` guard so it catches them.
- JS guard in `scripts/check-clis`: no `execFile`/`spawn` on a raw path outside a
  `mando*` result, with an explicit allowlist.
- README: Windows requirement (Python 3, `py` launcher) and `WA_INBOX_PYTHON`.
- Out of scope: a real Windows 11 run (not available here), agent skills in
  `harness/skills/*` (the issue puts them out of scope).

## Checklist

- [ ] G1 `sin-python`: resolver signal + `mandoHerramienta` tag + `run()`/`motivoDe`/`checkSystem`
- [ ] G2 panel strings for `sin-python` (config.html, activity.html), es/en/pt
- [ ] G3 `harness.mjs` `corre()` through the launcher, worker passes `PYTHON_ENV`
- [ ] G4 Python bare-path siblings (`wa_chats`, `wa-transcribe ajustes`) + wider guard
- [ ] G5 JS-side guard in `scripts/check-clis`
- [ ] G6 README Windows requirement
- [ ] G7 version bump

## Acceptance criteria

- On darwin/linux every command line is byte-for-byte what it was (existing tests untouched).
- On win32 with no Python, health shows `problemCode: 'sin-python'` and the panel says
  Python is missing in the user's language.
- The guards fail on a new bare-path launch, in Node and in Python.

## Checks

- `node test/worker.test.mjs`, `node test/sidecar-pairing.test.mjs`,
  `node test/panels.test.mjs`, `scripts/check-clis`, `scripts/check-harness`,
  full `npm run check` minus shots, then reduced shots of the changed panel.
