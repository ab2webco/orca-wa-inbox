// Resuelve el directorio de auth state del sidecar de Baileys, FUERA del arbol
// verificado por content-hash del plugin (docs/ENCARGO-TRANSPORTE-UNICO.md §7).
//
// Corre como subproceso, igual que la siembra del arnes en main.mjs (`sembrarFuera`):
// el worker no puede leer el userData de Orca, porque su valla de permisos solo
// declara `--allow-fs-read` sobre la raiz del plugin y la carpeta del host
// (docs/ENCARGO...§1), nunca sobre el userData. Preguntarselo al disco desde dentro
// de la valla lanzaria `ERR_ACCESS_DENIED` en vez de contestar.
//
// Reusa `dataDir` de harness.mjs: es la MISMA tabla de raices de userData que ya usa
// la siembra del arnes, asi que las dos carpetas de un mismo plugin -harness y auth
// state- nunca terminan en raices distintas en una maquina con mas de un Orca
// instalado (release + dev).
import { dataDir } from '../harness.mjs'

const [pluginDir] = process.argv.slice(2)
const dir = pluginDir ? dataDir(pluginDir, 'wa-auth') : null

process.stdout.write(JSON.stringify(dir
  ? { ok: true, dir }
  : { ok: false, dir: null, reason: 'sin-userdata',
      detail: 'no userData directory was found for Orca on this machine' }))
