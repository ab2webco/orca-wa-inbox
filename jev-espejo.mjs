#!/usr/bin/env node
/**
 * El espejo de la llave de Jev: `~/.wa-inbox/jev.env`.
 *
 * La llave vive en la boveda `secrets` de Orca, que cifra con safeStorage y solo le
 * responde al worker. Los CLIs de Python no son Electron y no la pueden leer, asi que el
 * worker deja una copia que ellos SI leen. Esta copia no la escribe el worker: corre tras
 * la valla de permisos de Node, sin permiso de escritura (mismo motivo que `harness.mjs`).
 * Este modulo corre como script, en un subproceso sin valla, y es la unica escritura.
 *
 * Formato (contrato con el lector de Python, que no lee nada que no lo cumpla):
 *
 *     # wa-inbox jev mirror v1
 *     TYPESAFE_API_KEY=<llave>
 *
 * Un archivo SIN esa primera linea no es nuestro —alguien lo copio a mano— y el lector lo
 * trata como "sin llave". Por eso este script nunca lo borra ni lo pisa salvo que quien
 * pide sea un guardado explicito de la llave desde el panel (`guardar`).
 *
 * Uso: `node jev-espejo.mjs <guardar|sincronizar|borrar|estado>`
 *   guardar       la llave llega por STDIN —nunca por argv, que cualquier `ps` ve—.
 *                 Escribe siempre, aunque haya un archivo ajeno: el usuario acaba de
 *                 escribir la llave en el panel.
 *   sincronizar   igual, pero NO pisa un archivo ajeno (`ajeno`). Es lo que corre el
 *                 worker por su cuenta: al arrancar y al encender Jev.
 *   borrar        borra el espejo si es nuestro. Un archivo ajeno se deja y se dice.
 *   estado        `ausente`, `propio` o `ajeno`. Nunca devuelve la llave.
 *
 * Escribe un temporal con modo 0600 desde el primer byte y lo renombra encima: el lector
 * nunca ve un archivo a medias ni uno legible por otros. Imprime UNA linea JSON y nada
 * mas; la llave no sale nunca, ni a stderr ni a un mensaje de error.
 *
 * El HOME es el del proceso (`os.homedir()` respeta $HOME, o USERPROFILE en Windows), el
 * mismo que resuelven los CLIs con `expanduser("~")`: una prueba que apunta HOME a una
 * carpeta temporal mueve los dos juntos.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CABECERA = '# wa-inbox jev mirror v1'
export const VARIABLE = 'TYPESAFE_API_KEY'
/** Una llave real no pasa de unas decenas de caracteres. Sin tope, el espejo seria un
 *  lugar donde dejar cualquier cosa. */
export const LLAVE_MAX = 512
const LLAVE_RE = /^[\x21-\x7e]+$/

export const rutaEspejo = () => join(homedir(), '.wa-inbox', 'jev.env')

/** Una llave se escribe tal cual en una linea: con un salto, un espacio o un caracter de
 *  control metida a la fuerza, el espejo tendria una segunda linea que nadie pidio. */
export const llaveValida = (llave) =>
  typeof llave === 'string' && llave.length <= LLAVE_MAX && LLAVE_RE.test(llave)

async function leerEspejo (ruta) {
  try {
    return await readFile(ruta, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

const esPropio = (contenido) =>
  contenido !== null && contenido.split(/\r?\n/, 1)[0] === CABECERA

async function escribir (ruta, llave) {
  await mkdir(dirname(ruta), { recursive: true })
  const temporal = `${ruta}.${randomUUID()}.tmp`
  try {
    await writeFile(temporal, `${CABECERA}\n${VARIABLE}=${llave}\n`,
      { encoding: 'utf8', mode: 0o600 })
    // El modo de `writeFile` lo recorta el umask y no cuenta en Windows: se fija aparte.
    await chmod(temporal, 0o600).catch(() => {})
    await rename(temporal, ruta)
  } catch (error) {
    await rm(temporal, { force: true }).catch(() => {})
    throw error
  }
}

async function leerStdin () {
  const trozos = []
  for await (const trozo of process.stdin) trozos.push(trozo)
  return Buffer.concat(trozos).toString('utf8').trim()
}

/** `llave` solo viaja en `guardar` y `sincronizar`. Devuelve siempre `{ ok, ... }`. */
export async function correr (modo, llave = '', ruta = rutaEspejo()) {
  const actual = await leerEspejo(ruta)
  if (modo === 'estado') {
    return { ok: true, estado: actual === null ? 'ausente' : esPropio(actual) ? 'propio' : 'ajeno' }
  }
  if (modo === 'borrar') {
    if (actual === null) return { ok: true, estado: 'ausente' }
    if (!esPropio(actual)) return { ok: true, estado: 'ajeno' }
    await rm(ruta, { force: true })
    return { ok: true, estado: 'ausente' }
  }
  if (modo === 'guardar' || modo === 'sincronizar') {
    if (!llaveValida(llave)) return { ok: false, motivo: 'llave-invalida' }
    if (modo === 'sincronizar' && actual !== null && !esPropio(actual)) {
      return { ok: true, estado: 'ajeno' }
    }
    const igual = `${CABECERA}\n${VARIABLE}=${llave}\n`
    if (actual !== igual) await escribir(ruta, llave)
    return { ok: true, estado: 'propio' }
  }
  return { ok: false, motivo: 'modo-desconocido' }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const modo = process.argv[2]
  const conLlave = modo === 'guardar' || modo === 'sincronizar'
  let salida
  try {
    salida = await correr(modo, conLlave ? await leerStdin() : '')
  } catch (error) {
    // Solo el codigo del sistema y el nombre: el mensaje de un error de fs lleva rutas,
    // y nada de lo que se imprima aca puede llevar la llave.
    salida = { ok: false, motivo: 'fallo', detalle: String(error?.code ?? error?.name ?? 'error') }
  }
  process.stdout.write(`${JSON.stringify(salida)}\n`)
}
