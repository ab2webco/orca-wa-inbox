# Windows launch: tools and sidecar start on win32

## Objective

On Windows the plugin does not start: the `wa-*` tools are extensionless Python
scripts with a shebang that `execFile` cannot run (`spawn ... ENOENT`), and the
sidecar is launched inside Node's permission fence (`mandoSinValla` returns the
binary unchanged on win32), so it cannot write its auth state
(`sidecar-authdir-fallo`, "Use --allow-fs-read"). Fix both on win32 without
changing what macOS and Linux run.

## Scope

- Node worker (`main.mjs`): every `wa-*` launch goes through one translation that,
  on win32 only, runs the script with the Python interpreter.
- Sidecar (`sidecar/src/alcance.js`): same translation; the worker passes the
  interpreter by env, the sidecar never guesses it.
- Python (`bin/wa-scope`, `bin/wa-read`): sibling tools launched by bare path get
  the interpreter on Windows only.
- Fence (`mandoSinValla`): on win32, a Node child gets an explicit `--permission`
  with everything allowed, which stops Node from copying the worker's fence into
  `NODE_OPTIONS` (measured on Orca's Electron 43 / Node 24.18).
- Out of scope: Agent Teams on Windows (an Orca decision, not the plugin's), the
  Orca CLI resolution on Windows (`orca` vs `orca.cmd`), not verified here.

## Checklist

- [x] W1 `mandoSinValla` takes the platform; posix stays `/usr/bin/env -u NODE_OPTIONS`;
      win32 + fenced + Node target gets the open `--permission` flags.
- [x] W2 `mandoHerramienta` + Python resolution (env override, `py -3`, `python`),
      wired into `run()`, the storage-lock spawn and the sidecar env.
- [x] W3 Sidecar `alcance.js` runs `wa-scope` through the same translation.
- [x] W4 Python siblings (`WA_READ`, `WA_SEND`, `wa-transcribe`) through
      `wa_store.mando_herramienta`.
- [x] W5 `npm run check` green from the worktree.

## Acceptance criteria

- On darwin/linux every command line is byte-for-byte what it was (tests assert it).
- On win32 a `wa-*` tool runs as `[python..., script, ...args]`.
- On win32 a fenced worker launches its Node children with the open flags, and a
  child launched that way can write outside the plugin root (measured with Orca Helper).

## Checks

- `node test/worker.test.mjs`, `node test/sidecar-pairing.test.mjs`,
  `scripts/check-clis`, full `npm run check`.
- Not verifiable here: a real Windows machine. The change ships only after the
  owner reviews it.
