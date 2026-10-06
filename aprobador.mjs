#!/usr/bin/env node
/**
 * La llave del aprobador: lo que separa una aprobacion del dueno de la de un agente.
 *
 * `wa-send --approve <id>` pone en la linea un mensaje retenido. Solo lo pueden pedir dos:
 * el worker, cuando el dueno aprieta en el tablero, y `wa-scope` desde el tick, cuando el
 * dueno contesto el aviso por WhatsApp. Visto 2026-10-02: la sesion de un proyecto aprobo
 * sus propios avisos retenidos, porque cualquiera que corre la CLI podia. Ahora `wa-send`
 * exige esta llave en `WA_INBOX_APPROVER`, y esos dos se la pasan SOLO al hijo `--approve`.
 * Ningun agente, automatizacion ni prompt la recibe.
 *
 * Lo que esto NO es: una defensa contra codigo del mismo usuario que lea el archivo a
 * proposito. Frena al agente equivocado o mal dirigido, que es lo que paso.
 *
 * Vive en un archivo 0600 junto a `scope.db` (`~/.wa-inbox/approver.key`, o
 * `%APPDATA%/wa-inbox/` en Windows: la misma carpeta que `wa_settings.scope_db`). Este
 * script es el UNICO que la escribe: el worker corre tras la valla de permisos de Node y no
 * puede escribir disco (mismo motivo que `jev-espejo.mjs`), asi que la pide aca, en un
 * subproceso sin valla. Python solo la lee (`wa_settings.llave_aprobador`).
 *
 * Uso: `node aprobador.mjs` imprime UNA linea JSON: `{"ok":true,"llave":"<64 hex>"}`, o
 * `{"ok":false,"motivo":...}` sin la llave. La crea si no hay una valida, y si hay una la
 * devuelve igual: una llave que cambia en cada arranque dejaria al tick con la vieja.
 */
import { chmod, link, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const VARIABLE_APROBADOR = 'WA_INBOX_APPROVER'
const LLAVE_RE = /^[0-9a-f]{64}$/

/** La misma carpeta que `scope_db()` de `bin/wa_settings.py`. */
export function rutaLlave (env = process.env, plataforma = process.platform) {
  if (plataforma === 'win32') {
    const base = env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    return join(base, 'wa-inbox', 'approver.key')
  }
  return join(homedir(), '.wa-inbox', 'approver.key')
}

async function leer (ruta) {
  try {
    const texto = (await readFile(ruta, 'utf8')).trim()
    return LLAVE_RE.test(texto) ? texto : ''
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** La llave vigente, creandola si no hay una valida. */
export async function llaveAprobador (ruta = rutaLlave()) {
  const actual = await leer(ruta)
  if (actual) {
    // Un archivo que quedo legible para otros (un `cp`, un umask raro) vuelve a ser solo
    // del usuario. La llave no cambia: el tick puede estar usandola.
    const modo = (await stat(ruta)).mode & 0o777
    if (modo !== 0o600) await chmod(ruta, 0o600).catch(() => {})
    return actual
  }
  await mkdir(dirname(ruta), { recursive: true })
  const llave = randomBytes(32).toString('hex')
  const temporal = `${ruta}.${randomUUID()}.tmp`
  try {
    await writeFile(temporal, `${llave}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(temporal, 0o600).catch(() => {})
    if (actual === null) {
      // `link` falla si otro la creo entre la lectura y aca: entonces vale la suya, y dos
      // arranques a la vez no se quedan cada uno con una llave distinta.
      try {
        await link(temporal, ruta)
        return llave
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        const ganadora = await leer(ruta)
        if (ganadora) return ganadora
      }
    }
    // Lo que hay no es una llave: se reemplaza entero, sin que nadie lea uno a medias.
    await rename(temporal, ruta)
    return llave
  } finally {
    await rm(temporal, { force: true }).catch(() => {})
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let salida
  try {
    salida = { ok: true, llave: await llaveAprobador() }
  } catch (error) {
    // Solo el codigo del sistema: el mensaje de un error de fs lleva rutas.
    salida = { ok: false, motivo: 'fallo', detalle: String(error?.code ?? error?.name ?? 'error') }
  }
  process.stdout.write(`${JSON.stringify(salida)}\n`)
}
