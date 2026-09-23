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
import { aNumero, esConversacion, esGrupo, filaDeActualizacion, filaDeMensaje,
  jidDe } from './mensajes.js'

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

/** De una conversacion de Baileys a la fila de CONTABILIDAD del almacen, o `null` si
 *  eso no es una conversacion que nadie pueda autorizar.
 *
 *  Acepta las tres formas que llegan por tres eventos distintos y NO son iguales:
 *   - `messaging-history.set` trae `proto.IConversation`: el nombre de un uno a uno
 *     vive en `displayName` (la agenda del telefono) y no en `name`, y los enteros de
 *     64 bits llegan como `Long`, no como number. Leer solo `name` deja al directo
 *     llamandose como su jid, y meter un `Long` en SQLite lo guarda como texto de
 *     objeto: la fecha sale en 1970 y el JSON se ve perfecto igual (§11-B5).
 *   - `chats.upsert` / `chats.update` traen `Chat`, con `name` y `conversationTimestamp`
 *     ya en number.
 *
 *  `esGrupo` decide `is_group` por `@g.us` y NADA MAS (§11-A3: `@s.whatsapp.net` es
 *  directo, `@g.us` grupo, `@lid`/`@status` otros). Lo que se excluye se excluye con la
 *  lista CERRADA de `esConversacion` (§11-A2) y nunca con una whitelist de sufijos:
 *  `@status` y `@lid.status` SON conversaciones reales y una whitelist las esconderia
 *  sin avisar. */
export function filaDeChat (chat) {
  const jid = jidDe(chat?.id)
  if (!jid || !esConversacion(jid)) return null
  const nombre = [chat?.name, chat?.displayName, chat?.subject]
    .find((n) => typeof n === 'string' && n.trim()) || ''
  const unread = aNumero(chat?.unreadCount)
  const ts = aNumero(chat?.conversationTimestamp) ??
    aNumero(chat?.lastMessageRecvTimestamp) ?? aNumero(chat?.lastMsgTimestamp)
  return {
    chatJid: jid,
    nombre: nombre.trim(),
    esGrupo: esGrupo(jid) ? 1 : 0,
    // Distinto de 0: `anotarChat` conserva el valor anterior cuando llega `null`, y una
    // actualizacion que no habla de no leidos no puede ponerlos en cero.
    unread: typeof unread === 'number' ? unread : null,
    ts: typeof ts === 'number' && ts > 0 ? ts : null
  }
}

/**
 * Un lote de conversaciones: la lista inicial de `messaging-history.set`, una
 * conversacion nueva de `chats.upsert`, o un cambio de `chats.update`.
 *
 * Esto anota CONTABILIDAD y NUNCA cuerpos. El lote del historial trae tambien los
 * mensajes recientes de cada conversacion y aca no se miran: listar un uno a uno tiene
 * que poder hacerse sin guardar una sola palabra de nadie. Guardar un cuerpo sigue
 * siendo trabajo de `ingerirMensaje`, que pregunta por el alcance antes de escribir
 * (§5: denegar por defecto es estructural).
 *
 * Sin esta contabilidad, una conversacion en la que nadie escribio desde que arranco el
 * plugin no se puede ni ofrecer para autorizarla, y la lista del panel nace con lo que
 * haya llegado por casualidad (§11-F3). Medido en la cuenta del dueno: 296 grupos y
 * CERO directos, porque `groupFetchAllParticipating` devuelve grupos por definicion.
 */
export function ingerirChats ({ almacen, cuenta, chats, nombreDeChat = () => null,
  recordarNombre = () => {}, ahora = Date.now() }) {
  let anotados = 0
  let omitidos = 0
  for (const chat of Array.isArray(chats) ? chats : []) {
    const fila = filaDeChat(chat)
    if (!fila) { omitidos += 1; continue }
    if (fila.nombre) recordarNombre(fila.chatJid, fila.nombre)
    almacen.anotarChat({
      cuenta,
      chatJid: fila.chatJid,
      // Un nombre vacio no borra el que ya se sabia — eso lo garantiza `anotarChat` —,
      // pero preguntar por el que este proceso ya vio evita una fila que nace sin
      // nombre solo porque este evento no lo traia.
      nombre: fila.nombre || nombreDeChat(fila.chatJid) || '',
      esGrupo: fila.esGrupo,
      unread: fila.unread,
      ts: fila.ts,
      ahora
    })
    anotados += 1
  }
  return { anotados, omitidos }
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
