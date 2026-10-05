# La carpeta del plugin es la del Orca que lo corre

## El problema, medido en una Linux de un usuario

- La app publicada de Linux guarda su userData en `~/.config/orca-ide`, y Orca crea
  la carpeta de las automatizaciones del plugin en `<userData que corre>/plugin-workspaces/<llave>`
  (orca-oss `plugin-owned-workspace.ts`, `getPluginWorkspaceDir`).
- En esa maquina tambien existe `~/.config/orca/plugin-workspaces/ab2web.orca-wa-inbox`
  (sembrada, con `.wa-bin`). `workspaceDir` del arnes prefiere la raiz "ya sembrada" y
  siembra ahi; Orca corre las automatizaciones en la de `orca-ide`, que queda vacia.
- El `command` del tick (`WA="$(cat .wa-bin 2>/dev/null)"; [ -x "$WA/wa-scope" ] || exit 1`)
  sale con 1 sin decir nada cada minuto, el precheck de triage igual, y los agentes no
  tienen el arnes. `"$(cat ~/.wa-inbox/bin-path)/wa-scope" tick --json` a mano funciona.

## Decision

- El plugin instalado vive en `<userData>/plugins/<llave>/<hash>` (orca-oss
  `plugin-discovery.ts`: `getUserPluginsDir(userDataPath)` + `current`). Si la carpeta
  del plugin tiene esa forma y la llave es la del manifiesto, la carpeta de trabajo sale
  de ESE userData. Un build de desarrollo (checkout del repo) resuelve como hoy.
- `dataDir` (el auth state del sidecar) NO se mueve: moverlo pide un QR nuevo sin avisar.
- Los comandos leen `.wa-bin`, y si no da un `wa-scope` ejecutable caen en `bin-path`
  (`$HOME/.wa-inbox`, y `$APPDATA/wa-inbox` si existe la variable). Sin ninguno, una
  linea a stderr con el motivo y salida 1.
- Python: `plugin_store_path` lee todas las raices (gana el `storage.json` mas nuevo) y
  `plugin_store_targets` escribe en todas; no elige una sola raiz. Sin cambio.

## Tareas

- [x] T1 `workspaceDir` sale del userData donde esta instalado; `dataDir` igual (test/userdata.test.mjs).
- [x] T2 Comandos con respaldo en `bin-path` y motivo en stderr (test/resolver.test.mjs, manifest, check-resolver).
- [x] T3 Docs y skills dicen lo mismo; version 4.16.1; `npm run check` en 0.

## Criterios de aceptacion

- Linux con `orca` sembrada y el plugin instalado bajo `orca-ide`: carpeta de trabajo en
  `orca-ide`, auth state en `orca`. Lo mismo en las formas de macOS y Windows.
- Un checkout de desarrollo resuelve exactamente como antes.
- El comando publicado, corrido con `sh` en una carpeta vacia, usa `bin-path`; sin nada
  dice por que en una linea y sale con 1. Nunca un `wa-scope` de `PATH`.
