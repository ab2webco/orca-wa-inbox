// De un mensaje de Baileys a una fila del almacen. TODO lo de aca adentro es puro: no
// abre un socket, no toca disco y no importa Baileys. Esa pureza no es estetica.
//
// Las cuatro rarezas que este archivo resuelve (docs/ENCARGO-TRANSPORTE-UNICO.md §11)
// no producen excepciones: producen CEROS. Una mencion que no se encuentra se ve
// exactamente igual que una semana en la que nadie lo nombro, y una cita perdida se ve
// igual que una conversacion sin respuestas. La unica manera de ver un cero silencioso
// es poner las dos formas del dato al lado y comparar, y eso se hace en una prueba
// (test/sidecar-mensajes.test.mjs), no contra una cuenta viva.

// Los cinco tipos que publica `wa-read` en `media`, `adjuntos_cerca[].type` y
// `inbox[].media`. Son contrato con el agente y con el panel: el prompt de triage
// distingue un audio de una imagen para decidir si transcribe.
export const TIPO_MEDIA = Object.freeze({
  imageMessage: 'imagen',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'documento',
  stickerMessage: 'sticker'
})

// Lo que NO es una conversacion. Lista CERRADA de exclusion, nunca una lista blanca de
// sufijos permitidos (§11-A2): la base de macOS ya traia jids terminados en `@status` y
// `@lid.status` que SI son conversaciones reales, y una lista blanca los habria
// escondido sin decirlo el dia que WhatsApp los use en otra punta.
const NO_ES_CONVERSACION = /@(newsletter|broadcast)$/

// Las envolturas que WhatsApp le pone a un mensaje antes del contenido de verdad. Un
// mensaje efimero o de ver-una-vez trae el cuerpo ADENTRO, y leer la envoltura devuelve
// texto vacio: el mensaje existe, se ve, y el agente lo lee en blanco.
const ENVOLTURAS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2',
  'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'editedMessage']

// De mimetype a extension. wa-transcribe recibe una RUTA y nada mas, y ffmpeg abre por
// contenido pero los motores de voz miran el nombre: un `.bin` deja el audio sin leer
// lejos de aca, que es justo el fallo que §11-C4 manda no volver a producir.
const EXTENSION = Object.freeze({
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/3gpp': '.3gp', 'video/quicktime': '.mov',
  'audio/ogg': '.ogg', 'audio/opus': '.ogg', 'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/amr': '.amr', 'audio/wav': '.wav',
  'application/pdf': '.pdf'
})

/** El jid pelado de un valor que puede llegar como cadena o como objeto.
 *
 *  §11-B2: la lista de menciones del transporte viejo traia OBJETOS wid
 *  `{server, user, _serialized}` y no cadenas, y comparar con `===` contra el LID "no
 *  encuentra nunca nada". El protobuf de Baileys 6.7.24 declara `mentionedJid: string[]`
 *  — verificado en WAProto/index.d.ts:10752 — pero la leccion no es sobre una libreria:
 *  es que el fallo NO avisa. Aceptar las dos formas cuesta tres lineas; descubrir que
 *  hace meses que nadie lo nombra cuesta un trimestre. */
export function jidDe (valor) {
  if (!valor) return ''
  if (typeof valor === 'string') return valor
  if (typeof valor !== 'object') return ''
  if (valor._serialized) return String(valor._serialized)
  if (valor.id) return jidDe(valor.id)
  if (valor.user) return `${valor.user}@${valor.server || 's.whatsapp.net'}`
  return ''
}

/** El numero, sin el servidor y sin el sufijo de dispositivo (`:12`) que pone WhatsApp
 *  cuando la cuenta esta en varios aparatos. */
export function usuarioDe (valor) {
  return jidDe(valor).split('@')[0].split(':')[0].trim()
}

/** La identidad de alguien, CON su tipo. Dos numeros iguales en universos distintos no
 *  son la misma persona: el LID que WhatsApp le asigna a un tercero puede coincidir,
 *  digito por digito, con el telefono del propietario. Comparar solo el numero
 *  inventaria menciones que nadie hizo, que es el error espejo del cero silencioso.
 *
 *  `@c.us` y `@s.whatsapp.net` son EL MISMO espacio —el telefono— escrito de dos
 *  maneras, y ahi esta §11-B1: sobre 2343 citas reales, 45 traian la forma vieja. */
export function identidadPropia (valor) {
  const jid = jidDe(valor)
  const usuario = usuarioDe(jid)
  if (!usuario) return ''
  const servidor = jid.split('@')[1] || ''
  return `${servidor === 'lid' ? 'lid' : 'pn'}:${usuario}`
}

/** Quien es el propietario a los efectos de "me nombraron" y "contestaron algo mio":
 *  su LID y su telefono, que son numeros DISTINTOS y llegan cada uno por su lado. */
export function identidadesPropias (lid, telefono) {
  return new Set([identidadPropia(lid), identidadPropia(telefono)].filter(Boolean))
}

/** La identidad de la sesion, leida de donde de verdad esta.
 *
 *  `sock.user` NO la tiene entera cuando dispara `connection: 'open'`: trae `id` y
 *  todavia no `lid` ni `name`, que Baileys completa despues por `creds.update`. Medido
 *  en una instalacion viva, la tabla `linea` quedaba asi:
 *
 *      lid=NULL  pn=573008236130:7@s.whatsapp.net  name=NULL
 *
 *  mientras `creds.json` ya decia `me.lid = 262444127674377:7@lid`. Con el LID vacio,
 *  `identidadesPropias` solo conoce el telefono, `mencionaA` no puede acertar nunca
 *  -las menciones de WhatsApp viajan en `@lid`- y `menciona_me` queda en 0 sobre
 *  mensajes que nombran al dueno con todas las letras. Aguas abajo eso es la bandeja
 *  vacia, `activity.pending` vacio, `wa-scope pending` contestando `hay_trabajo: false`
 *  y la automatizacion saltandose todo sin decir por que.
 *
 *  Por eso se mira PRIMERO `creds.me`, que es el registro persistente, y `sock.user`
 *  queda de respaldo. Y por eso quien llama tiene que volver a preguntar en cada
 *  `creds.update`: en el `open` la respuesta todavia esta incompleta. */
export function identidadDeSesion (creds, user) {
  const guardada = creds?.me || {}
  const viva = user || {}
  return {
    lid: guardada.lid || viva.lid || null,
    pn: guardada.id || viva.id || null,
    nombre: guardada.name || viva.name || null
  }
}

/** Lista de exclusion cerrada (§11-A2). */
export function esConversacion (jid) {
  const texto = typeof jid === 'string' ? jid : jidDe(jid)
  if (!texto || !texto.includes('@')) return false
  return !NO_ES_CONVERSACION.test(texto)
}

export function esGrupo (jid) {
  const texto = typeof jid === 'string' ? jid : jidDe(jid)
  return !!texto && texto.endsWith('@g.us')
}

/** ¿Nombran al propietario en este mensaje? (§11-B2) */
export function mencionaA (contextInfo, identidades) {
  const lista = contextInfo?.mentionedJid
  if (!Array.isArray(lista) || !lista.length) return false
  return lista.some((entrada) => identidades.has(identidadPropia(entrada)))
}

/** ¿Este mensaje cita algo del propietario? (§11-B1)
 *
 *  `participant` es el autor del mensaje citado y llega en `@lid` Y en `@c.us`. Baileys
 *  ademas deja las dos formas explicitas cuando las conoce (`participantPn`,
 *  `participantLid`, WAMessageKey en lib/Types/Message.d.ts:20-21). Se miran las tres:
 *  mirar una sola pierde ~2% de las respuestas, las mas viejas, SIN un solo error. */
export function citaA (contextInfo, identidades) {
  if (!contextInfo) return false
  for (const campo of ['participant', 'participantPn', 'participantLid']) {
    const quien = identidadPropia(contextInfo[campo])
    if (quien && identidades.has(quien)) return true
  }
  return false
}

/** El contenido de verdad, sacando las envolturas de efimero / ver-una-vez / editado. */
export function contenidoDe (mensaje) {
  let actual = mensaje
  for (let vuelta = 0; actual && vuelta < 5; vuelta += 1) {
    const envoltura = ENVOLTURAS.find((nombre) => actual[nombre]?.message)
    if (!envoltura) return actual
    actual = actual[envoltura].message
  }
  return actual || null
}

/** El cuerpo en claro. Devuelve SIEMPRE una cadena: `null` en un campo que el panel y
 *  los prompts leen como texto se pinta como "null" o revienta un `.slice`. */
export function textoDe (mensaje) {
  const c = contenidoDe(mensaje)
  if (!c) return ''
  if (typeof c.conversation === 'string') return c.conversation
  if (typeof c.extendedTextMessage?.text === 'string') return c.extendedTextMessage.text
  for (const tipo of Object.keys(TIPO_MEDIA)) {
    if (typeof c[tipo]?.caption === 'string') return c[tipo].caption
  }
  if (typeof c.buttonsResponseMessage?.selectedDisplayText === 'string') {
    return c.buttonsResponseMessage.selectedDisplayText
  }
  if (typeof c.listResponseMessage?.title === 'string') return c.listResponseMessage.title
  return ''
}

/** El contextInfo del mensaje, venga de donde venga: cada tipo lo cuelga del suyo. */
export function contextoDe (mensaje) {
  const c = contenidoDe(mensaje)
  if (!c) return null
  if (c.extendedTextMessage?.contextInfo) return c.extendedTextMessage.contextInfo
  for (const tipo of Object.keys(TIPO_MEDIA)) {
    if (c[tipo]?.contextInfo) return c[tipo].contextInfo
  }
  return c.contextInfo || null
}

/** El adjunto, si lo hay: tipo, mimetype, tamano y con que extension guardarlo. */
export function mediaDe (mensaje) {
  const c = contenidoDe(mensaje)
  if (!c) return null
  for (const [campo, tipo] of Object.entries(TIPO_MEDIA)) {
    const nodo = c[campo]
    if (!nodo) continue
    const mime = String(nodo.mimetype || '').split(';')[0].trim().toLowerCase()
    const porNombre = String(nodo.fileName || '').match(/(\.[A-Za-z0-9]{1,8})$/)
    return {
      tipo,
      campo,
      mime: nodo.mimetype || null,
      bytes: aNumero(nodo.fileLength),
      // El pie del documento manda sobre el mimetype: un `.xlsx` es
      // `application/vnd.openxmlformats-...` y la tabla no lo puede conocer entero.
      ext: EXTENSION[mime] || (porNombre ? porNombre[1].toLowerCase() : '') ||
        (tipo === 'sticker' ? '.webp' : '.bin')
    }
  }
  return null
}

/** Los timestamps de Baileys llegan como numero o como `Long` de protobufjs. Un `Long`
 *  puesto en una columna de SQLite se guarda como texto de objeto y la fecha sale en
 *  1970 — el JSON se ve perfecto igual (§11-B5: "un error bien formado"). */
export function aNumero (valor) {
  if (valor === null || valor === undefined) return null
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null
  if (typeof valor === 'string') {
    const n = Number(valor)
    return Number.isFinite(n) ? n : null
  }
  if (typeof valor?.toNumber === 'function') {
    const n = valor.toNumber()
    return Number.isFinite(n) ? n : null
  }
  if (typeof valor?.low === 'number') return valor.low
  return null
}

/**
 * De un `WAMessage` de `messages.upsert` a una fila del almacen, o `null` si eso no se
 * guarda.
 *
 * Devolver `null` aca es lo que hace que un canal no deje NI UN BYTE en disco: el corte
 * ocurre antes de escribir, no en la consulta.
 */
export function filaDeMensaje (wa, { cuenta, identidades }) {
  const chatJid = wa?.key?.remoteJid
  const stanzaId = wa?.key?.id
  if (!chatJid || !stanzaId) return null
  if (!esConversacion(chatJid)) return null

  const grupo = esGrupo(chatJid)
  const fromMe = wa.key.fromMe ? 1 : 0
  const contexto = contextoDe(wa.message)
  const media = mediaDe(wa.message)
  // En un directo el autor es la conversacion misma; en un grupo, el participante.
  const senderJid = grupo
    ? (wa.key.participant || wa.key.participantPn || wa.key.senderPn || null)
    : (fromMe ? null : chatJid)

  return {
    cuenta,
    chatJid,
    stanzaId,
    ts: aNumero(wa.messageTimestamp) ?? 0,
    fromMe,
    senderJid: senderJid ? jidDe(senderJid) : null,
    senderName: (typeof wa.pushName === 'string' && wa.pushName.trim()) || null,
    body: textoDe(wa.message),
    mediaTipo: media ? media.tipo : null,
    mediaMime: media ? media.mime : null,
    mediaBytes: media ? media.bytes : null,
    mediaExt: media ? media.ext : null,
    // Lo propio NUNCA cuenta como mencion ni como cita: nombrarse a si mismo en el
    // borrador de una respuesta abriria una tarjeta por cada mensaje que uno escribe.
    mencionaMe: !fromMe && grupo && mencionaA(contexto, identidades) ? 1 : 0,
    citaMe: !fromMe && grupo && citaA(contexto, identidades) ? 1 : 0,
    esGrupo: grupo ? 1 : 0,
    // Solo los directos traen su nombre en el mensaje. El de un grupo es su asunto, y
    // eso se pregunta aparte: inventarlo aca lo dejaria llamandose como quien escribio.
    chatNombre: !grupo && !fromMe && typeof wa.pushName === 'string' && wa.pushName.trim()
      ? wa.pushName.trim()
      : null
  }
}

/**
 * De un evento de `messages.update` a un cambio sobre una fila ya guardada, o `null`.
 *
 * §11-B4 es un HUECO CONFIRMADO, no una leccion a portar: el grep completo sobre el
 * lector viejo no encontro nada de revocacion ni de edicion, y `ZWAMESSAGE` se leia
 * como un log que solo crece. Un mensaje borrado seguia en la bandeja para siempre, y
 * uno editado se atendia por lo que decia antes.
 *
 * Las dos formas salen de Baileys 6.7.24 (lib/Utils/process-message.js:195-251):
 * REVOKE manda `message: null` con `messageStubType` 68, y MESSAGE_EDIT manda el cuerpo
 * nuevo envuelto en `editedMessage`. Todo lo demas que viaja por este evento —recibos
 * de lectura, estados de envio— NO puede tocar el cuerpo guardado.
 */
const STUB_REVOKE = 68

export function filaDeActualizacion (evento) {
  const chatJid = evento?.key?.remoteJid
  const stanzaId = evento?.key?.id
  const cambio = evento?.update
  if (!chatJid || !stanzaId || !cambio) return null
  if (!esConversacion(chatJid)) return null

  const editado = cambio.message?.editedMessage?.message
  if (editado) {
    return {
      chatJid,
      stanzaId,
      revocado: 0,
      editado: 1,
      body: textoDe(editado),
      ts: aNumero(cambio.messageTimestamp)
    }
  }
  // `message: null` explicito, no `undefined`: un update que no habla del cuerpo no
  // trae la clave, y confundir "no dijo nada" con "lo borraron" vaciaria la bandeja
  // con cada recibo de lectura.
  const revocado = cambio.messageStubType === STUB_REVOKE ||
    (Object.prototype.hasOwnProperty.call(cambio, 'message') && cambio.message === null)
  if (!revocado) return null
  return { chatJid, stanzaId, revocado: 1, editado: 0, body: null, ts: null }
}
