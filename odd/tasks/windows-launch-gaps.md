# Windows launch gaps: finish issue #78 after PR #79

## Objective

PR #79 fixed the core of #78 (tool launch on win32, sidecar fence). Close the parts
it left open so the issue can be closed, without changing any macOS/Linux command line.

## Boundary

`sidecar/` (incl. `herramienta.js`, `alcance.js`) and `scripts/check-casos` belong to other
members right now. Everything here is worker-side: the `sin-python` resolution lives in
`main.mjs` and reuses `resolverPython` from `sidecar/src/herramienta.js` read-only.

## Mapping of #78

| #78 item | Status | Where |
|---|---|---|
| D1 / T1 one launcher, `mandoHerramienta` | Done in #79 | `sidecar/src/herramienta.js` (the issue's `lanzador.mjs`) |
| D1 interpreter order: env var, `py -3`, `python` | Done in #79 | `resolverPython`; the env var is `WA_INBOX_PYTHON`, not the issue's `WA_PYTHON` |
| D1 `sin-python` stable code | Done here (G1, G2) | `main.mjs` `encontrarPython`, `crearPythonDelProceso`, `mandoDe`, `motivoDe`, `checkSystem`; `config.html` |
| T2 `run`, lock `spawn`, agente/acciones `herramienta()` | Done in #79 | `main.mjs` `mandoDe` |
| T2 sidecar `correr` (`alcance.js`) | Done in #79 | `sidecar/src/alcance.js:140` |
| T2 harness `corre()` | Done here (G3) | `harness.mjs` `mandoDeAyuda`; worker passes `PYTHON_ENV` via `envDeSiembra` |
| T2 guard against direct launches | Done here (G5) | `scripts/check-clis` `revisa_lanzamientos_node` |
| T2 `sin-python` reaches the panel | Done here (G2) | `config.html` health, sync, projects, scope, routes maps (es/en/pt) |
| D2 / T3 `mando_herramienta` in Python | Done in #79 | `bin/wa_settings.py` |
| T3 remaining bare sibling launches | Done here (G4) | `bin/wa-scope` `wa_chats()`, `bin/wa-transcribe` `ajustes()`; guard widened to variable-built paths |
| D3 / T4 sidecar outside the fence on win32 | Done in #79, another way | `main.mjs` `mandoSinValla`: no `cmd.exe`; the Node child gets `--permission` with every door open, so Node does not copy the parent's fence (no argument quoting needed). Unit-tested; the measurement on a real Windows is still pending |
| T5 README Windows requirement | Done here (G6) | `README.md` requirements table |
| T5 version bump | Not here | release PRs bump the version; feature PRs on main do not |
| T5 real Windows 11 run | Pending | needs a Windows 11 machine with Orca Lab |
| Out of scope: `harness/skills/*` | Not here | the issue puts it out of scope |

## Checklist

- [x] G1 `sin-python`: resolver signal + `mandoDe` tag + `run()`/`motivoDe`/`checkSystem`
- [x] G2 panel strings for `sin-python` in `config.html`, es/en/pt
- [x] G3 `harness.mjs` `corre()` through the launcher, worker passes `PYTHON_ENV`
- [x] G4 Python bare-path siblings (`wa_chats`, `wa-transcribe ajustes`) + wider guard
- [x] G5 JS-side guard in `scripts/check-clis`
- [x] G6 README Windows requirement
- [ ] Follow-up: `activity.html` maps `sin-herramientas` but not `sin-python` (outside this brief)

## Acceptance criteria

- On darwin/linux every command line is byte-for-byte what it was (existing tests untouched).
- On win32 with no Python, health shows `problemCode: 'sin-python'` and the panel says
  Python is missing in the user's language.
- The guards fail on a new bare-path launch, in Node and in Python.

## Checks

- `node test/worker.test.mjs`, `node test/panels.test.mjs`, `scripts/check-clis`,
  `scripts/check-harness`, `scripts/check-voseo`, full `npm run check` minus shots, then
  reduced shots of the `sin-python` alert.
