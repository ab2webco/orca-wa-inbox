/**
 * La conversacion de un caso para el panel lateral (panel-caso-movil, P1).
 *
 * `wa-scope caso ver` ya trae el hilo: los mensajes del caso, lo que se le contesto y el
 * adjunto de cada uno con su ruta. El panel no toca disco y vive en un iframe que solo
 * acepta imagenes `data:`, asi que el worker le arma lo que puede mostrar: quien, cuando,
 * el texto, y del adjunto el tipo, el tamano y el nombre. La ruta nunca sale de aca.
 *
 * El host corta cada mensaje del panel en 64 KB. La respuesta se arma desde lo mas nuevo
 * hacia atras y se queda bajo `PRESUPUESTO_BYTES`: a una imagen que no cabe se le quita la
 * vista previa antes que el mensaje, y lo mas viejo que no entra se cuenta en `omitidos`.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'

// Lo que entra en un mensaje del host (64 KB) con aire para el sobre del veredicto.
export const PRESUPUESTO_BYTES = 56000
// Los tipos del almacen (sidecar/src/mensajes.js) que tienen una imagen que mostrar.
const TIPOS_CON_VISTA = new Set(['imagen', 'sticker'])
// Una imagen de hasta esto viaja tal cual; una mas grande se achica.
const CRUDA_MAX = 24 * 1024
// La vista previa: el lado mas largo en px y la calidad JPEG. Unos 6 a 9 KB por imagen.
const LADO_VISTA = 240
const CALIDAD_VISTA = 55
const ESPERA_VISTA_MS = 8000
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif' }
// Las ya hechas, por ruta y fecha del archivo: abrir el mismo caso otra vez no las rehace.
const hechas = new Map()
const HECHAS_MAX = 200

const correr = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: ESPERA_VISTA_MS }, (error) => (error ? reject(error) : resolve()))
})

/** Achica `ruta` a un JPEG en `salida`: `sips` en macOS, ImageMagick en lo demas. */
async function achicar (ruta, salida) {
  if (process.platform === 'darwin') {
    await correr('sips', ['-Z', String(LADO_VISTA), '-s', 'format', 'jpeg',
      '-s', 'formatOptions', String(CALIDAD_VISTA), ruta, '--out', salida])
    return
  }
  const args = [ruta, '-auto-orient', '-thumbnail', `${LADO_VISTA}x${LADO_VISTA}`,
    '-quality', String(CALIDAD_VISTA), `jpeg:${salida}`]
  try {
    await correr('magick', args)
  } catch {
    await correr('convert', args)
  }
}

/** La vista previa de una imagen como `data:` URI, o null si no hay como hacerla. */
export async function vistaPrevia (ruta) {
  const info = await stat(ruta)
  const llave = `${ruta}\n${info.mtimeMs}`
  if (hechas.has(llave)) return hechas.get(llave)
  let dato = null
  const mime = MIME[extname(ruta).toLowerCase()]
  if (mime && info.size <= CRUDA_MAX) {
    dato = `data:${mime};base64,${(await readFile(ruta)).toString('base64')}`
  } else {
    const dir = await mkdtemp(join(tmpdir(), 'wa-vista-'))
    try {
      const salida = join(dir, 'vista.jpg')
      await achicar(ruta, salida)
      dato = `data:image/jpeg;base64,${(await readFile(salida)).toString('base64')}`
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  if (hechas.size >= HECHAS_MAX) hechas.delete(hechas.keys().next().value)
  hechas.set(llave, dato)
  return dato
}

const texto = (x) => (typeof x === 'string' ? x : '')
const tamano = (x) => (Number.isInteger(x) && x >= 0 ? x : null)

/** Un mensaje del hilo como lo pinta el panel, sin vista previa todavia. */
function mensajeDe (m) {
  const media = m && typeof m.media === 'object' && m.media ? m.media : null
  const salida = {
    quien: texto(m?.sender).slice(0, 120),
    fecha: texto(m?.date),
    propio: m?.from_me === true,
    texto: texto(m?.text)
  }
  if (m?.transcripcion === true || m?.transcripcion === false) salida.transcripcion = m.transcripcion
  if (media) {
    salida.adjunto = { tipo: texto(media.type).slice(0, 20), bytes: tamano(media.bytes),
      nombre: basename(texto(media.path)).slice(0, 120) }
  }
  return salida
}

const peso = (x) => Buffer.byteLength(JSON.stringify(x))

/**
 * `{mensajes, omitidos}` para el panel, bajo `PRESUPUESTO_BYTES`. `vista(ruta)` da la vista
 * previa de una imagen o null; si falla, el adjunto sale sin ella.
 */
export async function hiloParaPanel (hilo, vista = vistaPrevia) {
  const lista = Array.isArray(hilo) ? hilo : []
  const elegidos = []
  let usado = peso({ mensajes: [], omitidos: lista.length })
  for (let i = lista.length - 1; i >= 0; i--) {
    const m = mensajeDe(lista[i])
    const media = lista[i]?.media
    let conVista = null
    if (m.adjunto && TIPOS_CON_VISTA.has(m.adjunto.tipo) && texto(media?.path)) {
      try {
        const dato = await vista(media.path)
        if (typeof dato === 'string' && dato.startsWith('data:image/')) {
          conVista = { ...m, adjunto: { ...m.adjunto, vista: dato } }
        }
      } catch { /* sin vista previa: el adjunto sale igual */ }
    }
    const coma = elegidos.length ? 1 : 0
    if (conVista && usado + coma + peso(conVista) <= PRESUPUESTO_BYTES) {
      elegidos.unshift(conVista)
      usado += coma + peso(conVista)
      continue
    }
    if (conVista) m.adjunto.sinVista = true
    if (usado + coma + peso(m) > PRESUPUESTO_BYTES) break
    elegidos.unshift(m)
    usado += coma + peso(m)
  }
  return { mensajes: elegidos, omitidos: lista.length - elegidos.length }
}
