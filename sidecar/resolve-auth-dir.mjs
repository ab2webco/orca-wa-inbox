// Resuelve —y, si se lo piden, borra— el directorio de auth state del sidecar de
// Baileys, FUERA del arbol verificado por content-hash del plugin
// (docs/ENCARGO-TRANSPORTE-UNICO.md §7).
//
// Corre como subproceso, igual que la siembra del arnes en main.mjs (`sembrarFuera`):
// el worker no puede leer el userData de Orca, porque su valla de permisos solo
// declara `--allow-fs-read` sobre la raiz del plugin y la carpeta del host
// (docs/ENCARGO...§1), nunca sobre el userData. Preguntarselo al disco desde dentro
// de la valla lanzaria `ERR_ACCESS_DENIED` en vez de contestar. Y ESCRIBIR ahi es
// imposible de plano: `--allow-fs-write` no existe en todo orca-oss, asi que el
// borrado tampoco podia vivir del otro lado.
//
// Reusa `dataDir` de harness.mjs: es la MISMA tabla de raices de userData que ya usa
// la siembra del arnes, asi que las dos carpetas de un mismo plugin -harness y auth
// state- nunca terminan en raices distintas en una maquina con mas de un Orca
// instalado (release + dev).
//
// El borrado vive ACA y no en un guion hermano por la misma razon por la que la ruta
// vive aca: una segunda copia de esa tabla de raices puede discrepar con esta, y
// discrepar sobre esta ruta significa borrar la carpeta equivocada, o dejar viva la
// que el usuario pidio borrar creyendo que su sesion quedo revocada. Una credencial
// viva que alguien cree muerta es peor que una que se sabe viva.
import { rmSync } from 'node:fs'

import { dataDir } from '../harness.mjs'

const argumentos = process.argv.slice(2)
const pluginDir = argumentos[0]
const borrar = argumentos.includes('--borrar')
const dir = pluginDir ? dataDir(pluginDir, 'wa-auth') : null

function responder (objeto) {
  process.stdout.write(JSON.stringify(objeto))
}

if (!dir) {
  responder({ ok: false, dir: null, reason: 'sin-userdata',
    detail: 'no userData directory was found for Orca on this machine' })
} else if (!borrar) {
  responder({ ok: true, dir })
} else {
  try {
    // `force: true` a proposito: desvincular una linea que no estaba vinculada no es un
    // error, es lo que el usuario pidio, ya cierto. Fallar ahi dejaria al panel diciendo
    // que no pudo hacer algo que efectivamente esta hecho.
    rmSync(dir, { recursive: true, force: true })
    responder({ ok: true, dir, borrado: true })
  } catch (error) {
    // Se contesta el fallo en vez de morir con un exit code: el worker NO puede
    // distinguir "el guion reviento" de "el guion no arranco", y de esa distincion
    // depende que el panel mande a la accion correcta. Si el borrado no ocurrio, el
    // worker NO relanza: relanzar con las credenciales intactas volveria a conectar la
    // misma sesion que el usuario acaba de pedir cortar.
    responder({ ok: false, dir, borrado: false, reason: 'borrado-fallo',
      detail: String(error?.message ?? error).slice(0, 300) })
  }
}
