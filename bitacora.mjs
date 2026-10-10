#!/usr/bin/env node
/**
 * La bitacora de fallas del worker, por linea (linea-viva, V4).
 *
 * El 2026-10-09 la segunda linea paso seis horas y media sin que nadie juzgara un mensaje,
 * y lo unico que el worker sabia de eso se fue con `orca.log`, que desde aca no se puede
 * leer despues. Cada falla de la ingesta, del tick de respaldo o de la salud de las lineas
 * queda ahora en disco: una linea JSON en `<estado>/logs/worker-<cuenta>.log` (`~/.wa-inbox`,
 * o `%APPDATA%\wa-inbox` en Windows, la misma carpeta que `dirEstado` del arnes). Lo que no
 * es de una linea va a `worker-general.log`.
 *
 * El worker corre tras la valla de permisos de Node y no puede escribir disco: la escribe
 * este script, en un subproceso sin valla (`mandoSinValla`), igual que `aprobador.mjs` y
 * `jev-espejo.mjs`. Con tope: pasado `BITACORA_TOPE` la actual pasa a `.1` (pisando la
 * anterior) y se empieza otra; nunca hay mas de dos.
 *
 * Uso: `node bitacora.mjs` con UNA linea JSON por stdin, `{"cuenta": "pn:...", "registro":
 * {...}}`. Imprime `{"ok":true}` o `{"ok":false,"motivo":...}`. Por stdin y no por argv: el
 * detalle de una falla puede traer cualquier cosa, y argv lo ve cualquier `ps`.
 */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dirEstado } from './harness.mjs'

// Un mega por archivo, dos archivos: lo bastante para semanas de fallas de un minuto.
export const BITACORA_TOPE = 1024 * 1024
// Lo mas largo que puede ser un registro: uno que no cabe se corta, nunca se pierde entero.
const REGISTRO_MAX = 4000

/** El archivo de una linea: la cuenta solo con letras, digitos, `-` y `_`. */
export function nombreBitacora (cuenta) {
  const limpia = String(cuenta ?? '').replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 64)
  return `worker-${limpia || 'general'}.log`
}

export function rutaBitacora (cuenta, env = process.env, plataforma = process.platform) {
  return join(dirEstado(env, plataforma), 'logs', nombreBitacora(cuenta))
}

/** Agrega `registro` como una linea JSON, rotando antes si pasaria del tope. */
export async function anotarEnBitacora (ruta, registro, tope = BITACORA_TOPE) {
  let linea = JSON.stringify(registro)
  if (linea.length > REGISTRO_MAX) {
    linea = JSON.stringify({ at: registro?.at ?? null, que: registro?.que ?? null,
      cortado: true, detalle: linea.slice(0, REGISTRO_MAX - 200) })
  }
  linea += '\n'
  await mkdir(dirname(ruta), { recursive: true })
  let tamano = 0
  try {
    tamano = (await stat(ruta)).size
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (tamano > 0 && tamano + Buffer.byteLength(linea) > tope) await rename(ruta, `${ruta}.1`)
  await appendFile(ruta, linea, { encoding: 'utf8', mode: 0o600 })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let entrada = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (trozo) => { entrada += trozo })
  process.stdin.on('end', () => {
    let pedido = null
    try { pedido = JSON.parse(entrada || 'null') } catch { pedido = null }
    if (!pedido || typeof pedido !== 'object' || !pedido.registro ||
        typeof pedido.registro !== 'object') {
      process.stdout.write(JSON.stringify({ ok: false, motivo: 'sin-registro' }))
      return
    }
    const cuenta = typeof pedido.cuenta === 'string' ? pedido.cuenta : null
    anotarEnBitacora(rutaBitacora(cuenta), { cuenta, ...pedido.registro })
      .then(() => process.stdout.write(JSON.stringify({ ok: true })))
      .catch((error) => process.stdout.write(JSON.stringify({ ok: false, motivo: 'escritura',
        detalle: String(error?.code ?? error?.name ?? '').slice(0, 60) })))
  })
}
