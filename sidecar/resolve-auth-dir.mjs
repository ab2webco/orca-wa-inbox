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
// Reusa `dataDir` de harness.mjs, que conserva la eleccion de raiz de siempre (ya
// sembrada, si no con datos, si no la primera de la tabla de userData): un auth state ya
// vinculado nunca se mueve solo, porque moverlo es pedir un QR nuevo sin avisar. La
// carpeta de trabajo del arnes NO sigue esa eleccion cuando el plugin esta instalado:
// sale del userData donde esta instalado (`raizDeLaInstalacion`), el del Orca que corre
// las automatizaciones. Asi que en una maquina con mas de un Orca (p. ej. `orca` vieja y
// sembrada, y la app corriendo desde `orca-ide`) el arnes y el auth state pueden quedar
// en raices distintas, y es a proposito.
//
// El borrado vive ACA y no en un guion hermano por la misma razon por la que la ruta
// vive aca: una segunda copia de esa tabla de raices puede discrepar con esta, y
// discrepar sobre esta ruta significa borrar la carpeta equivocada, o dejar viva la
// que el usuario pidio borrar creyendo que su sesion quedo revocada. Una credencial
// viva que alguien cree muerta es peor que una que se sabe viva.
//
// VARIAS LINEAS (odd/tasks/varias-lineas-y-segundo-cerebro.md, L1). Cada linea tiene su
// auth state en `wa-auth/<carpeta>`: la de una linea vinculada es su cuenta con `-` en vez
// de `:` (`pn-<digitos>`, valida en cualquier sistema), y la de una que se esta vinculando
// es `nueva-<id>`. `--lineas` las lista y ordena el disco: muda el auth state plano de
// siempre a la carpeta de su numero —los mismos bytes, asi que la sesion sigue sin QR
// nuevo— y pasa cada `nueva-...` ya vinculada a la carpeta de su numero. Mueve carpetas,
// asi que el worker lo pide SOLO antes de lanzar ningun sidecar: mover la carpeta de un
// sidecar vivo lo deja escribiendo su credencial en una ruta que ya no existe.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
  statSync } from 'node:fs'
import { join } from 'node:path'

import { dataDir } from '../harness.mjs'
import { cuentaDeIdentidad } from './src/mensajes.js'

const argumentos = process.argv.slice(2)
const pluginDir = argumentos[0]
const borrar = argumentos.includes('--borrar')
const lineas = argumentos.includes('--lineas')
const valorDe = (bandera) => {
  const i = argumentos.indexOf(bandera)
  return i >= 0 && i + 1 < argumentos.length ? argumentos[i + 1] : null
}
const carpeta = valorDe('--carpeta')
const cuentaPedida = valorDe('--cuenta')
const dir = pluginDir ? dataDir(pluginDir, 'wa-auth') : null

/** Un nombre de carpeta de linea: simple, sin separadores ni puntos. Es lo que se borra,
 *  asi que lo que no tenga esta forma no se toca. */
const CARPETA_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const PREFIJO_NUEVA = 'nueva-'

/** La carpeta de una cuenta: `pn:<digitos>` -> `pn-<digitos>`. */
function carpetaDeCuenta (cuenta) {
  return String(cuenta).replace(/[^A-Za-z0-9]/g, '-')
}

function responder (objeto) {
  process.stdout.write(JSON.stringify(objeto))
}

/** La cuenta de un `creds.json`, o `null` si no hay archivo o todavia no tiene `me`
 *  (un vinculo a medias). */
function cuentaDeCreds (ruta) {
  try {
    return cuentaDeIdentidad(JSON.parse(readFileSync(ruta, 'utf8'))?.me?.id) || null
  } catch {
    return null
  }
}

function esCarpeta (ruta) {
  try { return statSync(ruta).isDirectory() } catch { return false }
}

/** El auth state plano de antes (`wa-auth/creds.json`) a la carpeta de su numero. Archivo
 *  por archivo y `creds.json` el ULTIMO: si esto se corta a mitad, el `creds.json` que
 *  sigue suelto hace que la proxima vez se termine de mudar. */
function mudarPlano (base) {
  const creds = join(base, 'creds.json')
  if (!existsSync(creds)) return null
  const cuenta = cuentaDeCreds(creds)
  const destino = cuenta ? carpetaDeCuenta(cuenta) : `${PREFIJO_NUEVA}${Date.now().toString(36)}`
  const hacia = join(base, destino)
  mkdirSync(hacia, { recursive: true, mode: 0o700 })
  for (const nombre of readdirSync(base)) {
    if (nombre === 'creds.json' || esCarpeta(join(base, nombre))) continue
    renameSync(join(base, nombre), join(hacia, nombre))
  }
  renameSync(creds, join(hacia, 'creds.json'))
  return destino
}

/** Las lineas en disco, con el disco ya ordenado. */
function lineasEnDisco (base) {
  if (!existsSync(base)) return []
  mudarPlano(base)
  for (const nombre of readdirSync(base)) {
    if (!nombre.startsWith(PREFIJO_NUEVA) || !CARPETA_RE.test(nombre)) continue
    const cuenta = cuentaDeCreds(join(base, nombre, 'creds.json'))
    if (!cuenta) continue
    const destino = join(base, carpetaDeCuenta(cuenta))
    // El mismo numero vinculado otra vez: la sesion que el dueno acaba de escanear es la
    // que vale, y la vieja se reemplaza en vez de dejar dos sidecars sobre una cuenta.
    rmSync(destino, { recursive: true, force: true })
    renameSync(join(base, nombre), destino)
  }
  return readdirSync(base)
    .filter((nombre) => CARPETA_RE.test(nombre) && esCarpeta(join(base, nombre)))
    .sort()
    .map((nombre) => ({ carpeta: nombre, dir: join(base, nombre),
      cuenta: cuentaDeCreds(join(base, nombre, 'creds.json')) }))
}

/** Saca la linea de las activas del almacen al desvincularla. Solo si el almacen existe:
 *  crearlo aca dejaria un archivo vacio que se lee como una linea lista. Se importa aca
 *  adentro porque `node:sqlite` no hace falta para resolver ni para borrar. */
async function retirarDelAlmacen (cuenta) {
  const { abrirAlmacen, rutaAlmacen } = await import('./src/almacen.js')
  const ruta = rutaAlmacen(process.env)
  if (!existsSync(ruta)) return false
  const almacen = abrirAlmacen(ruta)
  try {
    return almacen.retirarLinea(cuenta).retirada
  } finally {
    almacen.cerrar()
  }
}

if (!dir) {
  responder({ ok: false, dir: null, reason: 'sin-userdata',
    detail: 'no userData directory was found for Orca on this machine' })
} else if (carpeta !== null && !CARPETA_RE.test(carpeta)) {
  responder({ ok: false, dir, reason: 'carpeta-invalida',
    detail: 'the line folder must be a plain name' })
} else if (borrar) {
  const objetivo = carpeta ? join(dir, carpeta) : dir
  try {
    // `force: true` a proposito: desvincular una linea que no estaba vinculada no es un
    // error, es lo que el usuario pidio, ya cierto. Fallar ahi dejaria al panel diciendo
    // que no pudo hacer algo que efectivamente esta hecho.
    rmSync(objetivo, { recursive: true, force: true })
    let retirada = false
    if (cuentaPedida) {
      try {
        retirada = await retirarDelAlmacen(cuentaPedida)
      } catch (error) {
        // La credencial ya no esta, que es lo que importa: se dice y se sigue.
        process.stderr.write(`linea no retirada del almacen: ${error?.message ?? error}\n`)
      }
    }
    responder({ ok: true, dir: objetivo, borrado: true, retirada })
  } catch (error) {
    // Se contesta el fallo en vez de morir con un exit code: el worker NO puede
    // distinguir "el guion reviento" de "el guion no arranco", y de esa distincion
    // depende que el panel mande a la accion correcta. Si el borrado no ocurrio, el
    // worker NO relanza: relanzar con las credenciales intactas volveria a conectar la
    // misma sesion que el usuario acaba de pedir cortar.
    responder({ ok: false, dir: objetivo, borrado: false, reason: 'borrado-fallo',
      detail: String(error?.message ?? error).slice(0, 300) })
  }
} else if (lineas) {
  try {
    responder({ ok: true, dir, lineas: lineasEnDisco(dir) })
  } catch (error) {
    responder({ ok: false, dir, reason: 'lineas-fallo',
      detail: String(error?.message ?? error).slice(0, 300) })
  }
} else {
  responder({ ok: true, dir })
}
