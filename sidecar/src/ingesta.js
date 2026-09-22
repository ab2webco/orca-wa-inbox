// La ingesta: donde se decide QUE se guarda y que no llega a tocar el disco.
//
// Esto es el punto entero del modelo de autorizacion. `bin/wa-scope` mantiene el
// registro —`chat_scope`, con la escalera `off/observar/borrador/responder`— y denegar
// por defecto es ESTRUCTURAL: `merged_scope` nunca sintetiza una fila, asi que un chat
// que nadie registro no existe para el agente (docs/ENCARGO-TRANSPORTE-UNICO.md §5).
// Aca no se reimplementa esa decision: se le pregunta (sidecar/src/alcance.js) y se
// obedece.
//
// El corte va ANTES de escribir, no en la consulta. Un chat en `off` no deja un cuerpo
// "que despues no se muestra": no deja cuerpo. La diferencia se ve el dia que alguien
// abre el archivo con un visor de sqlite.
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { asegurarDirectorio } from './almacen.js'
import { esGrupo, filaDeActualizacion, filaDeMensaje } from './mensajes.js'

/** Lo que se contesta de cada mensaje. Son motivos, no booleanos: el sidecar los cuenta
 *  por separado para poder decir "llegaron 40, se guardaron 12" sin nombrar a nadie. */
export const INGESTA = Object.freeze({
  GUARDADO: 'guardado',
  SIN_AUTORIZAR: 'sin-autorizar',
  NO_ES_CONVERSACION: 'no-es-conversacion'
})

/** El nombre de archivo de un adjunto. El `stanza_id` es unico por mensaje y estable
 *  entre corridas, asi que sirve de nombre; se sanea porque llega de la red y un `..`
 *  ahi escribiria fuera del directorio de media. */
export function nombreDeArchivo (stanzaId, ext) {
  const limpio = String(stanzaId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96)
  return `${limpio || 'sin-id'}${ext || '.bin'}`
}

export function carpetaDeCuenta (mediaDir, cuenta) {
  return join(mediaDir, String(cuenta).replace(/[^A-Za-z0-9._-]/g, '_') || 'sin-cuenta')
}

/**
 * Un mensaje entrante, de `messages.upsert`.
 *
 * Devuelve `{ motivo }` y nunca lanza: una excepcion aca mata al sidecar, y con el
 * sidecar se cae la linea entera por un mensaje raro.
 */
export async function ingerirMensaje ({ almacen, alcance, cuenta, identidades, wa,
  mediaDir, descargarMedia = null, nombreDeChat = () => null, ahora = Date.now() }) {
  const fila = filaDeMensaje(wa, { cuenta, identidades })
  if (!fila) return { motivo: INGESTA.NO_ES_CONVERSACION }

  // CONTABILIDAD, siempre y aunque el chat este en `off`: sin esto una conversacion
  // que nadie autorizo no se puede ni ofrecer para autorizarla, y la lista del panel
  // nace vacia para siempre. Un jid, un nombre visible y una hora no son el texto de
  // nadie (§11-F3).
  almacen.anotarChat({
    cuenta,
    chatJid: fila.chatJid,
    nombre: fila.chatNombre || nombreDeChat(fila.chatJid) || '',
    esGrupo: esGrupo(fila.chatJid) ? 1 : 0,
    ts: fila.ts,
    ahora
  })

  if (alcance(cuenta, fila.chatJid) === 'off') return { motivo: INGESTA.SIN_AUTORIZAR }

  let mediaPath = null
  if (fila.mediaExt && typeof descargarMedia === 'function') {
    mediaPath = await bajarMedia({ wa, fila, cuenta, mediaDir, descargarMedia })
  }
  almacen.guardarMensaje(fila, { mediaPath, ahora })
  return { motivo: INGESTA.GUARDADO, mediaPath }
}

/**
 * Un borrado o una edicion, de `messages.update` (§11-B4).
 *
 * No hay prior art que copiar: el lector viejo no manejaba ninguno de los dos. Un
 * mensaje borrado se quedaba en la bandeja para siempre y uno editado se atendia por
 * lo que decia antes.
 */
export function ingerirActualizacion ({ almacen, alcance, cuenta, evento }) {
  const cambio = filaDeActualizacion(evento)
  if (!cambio) return { motivo: INGESTA.NO_ES_CONVERSACION }
  // Un chat en `off` no tiene filas que actualizar. Preguntar igual es lo que hace que
  // apagar un chat y despues recibir un borrado no reabra nada.
  if (alcance(cuenta, cambio.chatJid) === 'off') return { motivo: INGESTA.SIN_AUTORIZAR }
  almacen.aplicarActualizacion(cuenta, cambio)
  return { motivo: INGESTA.GUARDADO, revocado: cambio.revocado, editado: cambio.editado }
}

async function bajarMedia ({ wa, fila, cuenta, mediaDir, descargarMedia }) {
  try {
    const bytes = await descargarMedia(wa)
    if (!bytes || !bytes.length) return null
    const carpeta = carpetaDeCuenta(mediaDir, cuenta)
    asegurarDirectorio(carpeta)
    const destino = join(carpeta, nombreDeArchivo(fila.stanzaId, fila.mediaExt))
    // 0600 al crear Y despues: `mode` no se aplica a un archivo que ya existia, y esto
    // son fotos y audios de otra gente (§11-F1).
    writeFileSync(destino, bytes, { mode: 0o600 })
    chmodSync(destino, 0o600)
    return destino
  } catch {
    // §11-C4: nunca sintetizar una ruta que no se puede respaldar. Si la descarga
    // fallo, la fila se guarda SIN ruta: `wa-transcribe` fallaria con "no such file"
    // lejos de aca, y el agente leeria "mira esto" creyendo que ya lo miro.
    return null
  }
}
