#!/usr/bin/env node
/**
 * La traduccion de un mensaje de Baileys a una fila del almacen, probada como logica
 * PURA: sin socket, sin cuenta real, sin disco. Lo que se ejercita aca son las cuatro
 * rarezas de WhatsApp que producen fallos SILENCIOSOS —las que no revientan, las que
 * devuelven cero y se ven igual que "no paso nada"— documentadas en
 * docs/ENCARGO-TRANSPORTE-UNICO.md §11:
 *
 *   B1  `quotedParticipant` llega en @lid Y en @c.us. "sobre 2343 citas, 45 traian el
 *       telefono. Mirar solo el LID pierde las respuestas viejas."
 *   B2  la lista de menciones puede traer OBJETOS y no cadenas: comparar con `===`
 *       contra el LID "no encuentra nunca nada, y eso se ve igual que 'nadie te nombro
 *       esta semana'."
 *   A2  lista de exclusion CERRADA, nunca whitelist por sufijo: `@status` y
 *       `@lid.status` son conversaciones de verdad.
 *   B4  borrados y editados, que el codigo viejo no manejaba en ningun lado.
 *
 * Que sean funciones puras no es estetica: un cero silencioso solo se ve poniendole
 * las dos formas del dato al lado y comparando, y eso no se puede hacer contra un
 * socket vivo.
 */
import {
  esConversacion, esGrupo, usuarioDe, identidadPropia, identidadesPropias,
  identidadDeSesion,
  mencionaA, citaA, textoDe, mediaDe, filaDeMensaje, filaDeActualizacion,
  TIPO_MEDIA
} from '../sidecar/src/mensajes.js'

let fallos = 0
let pruebas = 0
function ok (nombre, condicion, detalle = '') {
  pruebas += 1
  if (condicion) return console.log(`  ok    ${nombre}`)
  fallos += 1
  console.log(`  FALLA ${nombre}${detalle ? ` — ${detalle}` : ''}`)
}

// El propietario, con sus dos identidades: el LID que WhatsApp le da en los grupos y
// el telefono de siempre. Son numeros DISTINTOS, y esa es justo la trampa de B1.
const MI_LID = '199887766554433@lid'
const MI_TEL = '573001112233@s.whatsapp.net'
const YO = identidadesPropias(MI_LID, MI_TEL)

console.log('\nA2: que es una conversacion y que no (lista de exclusion CERRADA)')
{
  ok('un grupo es conversacion', esConversacion('120363000000000000@g.us'))
  ok('un directo es conversacion', esConversacion('573001112233@s.whatsapp.net'))
  // La razon entera de que la lista sea de exclusion y no de sufijos permitidos.
  ok('@status ES conversacion', esConversacion('573001112233@status'))
  ok('@lid.status ES conversacion', esConversacion('123@lid.status'))
  ok('@lid es conversacion', esConversacion('199887766554433@lid'))
  ok('un canal NO es conversacion', esConversacion('123@newsletter') === false)
  ok('una difusion NO es conversacion', esConversacion('123@broadcast') === false)
  ok('sin arroba NO es conversacion', esConversacion('123') === false)
  ok('vacio NO es conversacion', esConversacion('') === false && esConversacion(null) === false)

  ok('un @g.us es grupo', esGrupo('120363000000000000@g.us'))
  ok('un directo no es grupo', esGrupo(MI_TEL) === false)
}

console.log('\nB2: la lista de menciones, en las dos formas que puede llegar')
{
  // Forma 1: la que declara el protobuf de Baileys 6.7.24 (`mentionedJid?: string[]`).
  const conCadenas = { mentionedJid: ['573009998877@s.whatsapp.net', MI_LID] }
  ok('menciona cuando la lista trae cadenas', mencionaA(conCadenas, YO) === true,
    JSON.stringify(conCadenas))

  // Forma 2: objetos wid. Es la forma que ya costo un cero silencioso, y un `===`
  // contra el LID no la encuentra NUNCA.
  const conObjetos = { mentionedJid: [{ _serialized: MI_LID, user: '199887766554433', server: 'lid' }] }
  ok('menciona cuando la lista trae OBJETOS', mencionaA(conObjetos, YO) === true,
    JSON.stringify(conObjetos))
  const conObjetosSinSerializado = { mentionedJid: [{ user: '199887766554433', server: 'lid' }] }
  ok('menciona con objetos sin _serialized', mencionaA(conObjetosSinSerializado, YO) === true)

  // Y el negativo, que es lo que tiene que seguir dando cero: nombrar a OTRO.
  const aOtro = { mentionedJid: ['573009998877@s.whatsapp.net'] }
  ok('no menciona cuando nombran a otro', mencionaA(aOtro, YO) === false)
  ok('no menciona sin contextInfo', mencionaA(undefined, YO) === false)
  ok('no menciona con lista vacia', mencionaA({ mentionedJid: [] }, YO) === false)

  // El sufijo de dispositivo (`:12`) lo pone WhatsApp y no cambia quien es.
  const conDispositivo = { mentionedJid: ['199887766554433:12@lid'] }
  ok('el sufijo de dispositivo no esconde la mencion',
    mencionaA(conDispositivo, YO) === true)

  // Un LID ajeno cuyo numero coincide con MI TELEFONO no es una mencion: comparar
  // solo el numero, sin el tipo de identidad, inventaria menciones que nadie hizo.
  const lidQueParece = { mentionedJid: ['573001112233@lid'] }
  ok('un @lid con el numero de mi telefono NO cuenta como mencion',
    mencionaA(lidQueParece, YO) === false, JSON.stringify(lidQueParece))
}

console.log('\nB1: la cita llega en @lid Y en @c.us — hay que mirar las dos')
{
  ok('cita en @lid', citaA({ participant: MI_LID }, YO) === true)
  // La forma vieja. 45 de 2343 citas reales venian asi, y mirarla sola perdia el 2%
  // de las respuestas SIN un solo error.
  ok('cita en @c.us', citaA({ participant: '573001112233@c.us' }, YO) === true)
  ok('cita en @s.whatsapp.net', citaA({ participant: MI_TEL }, YO) === true)
  ok('cita de otro no cuenta', citaA({ participant: '573009998877@c.us' }, YO) === false)
  ok('sin participant no hay cita', citaA({}, YO) === false)
  ok('sin contextInfo no hay cita', citaA(null, YO) === false)
  // Baileys tambien deja las dos formas explicitas cuando las conoce.
  ok('cita por participantPn', citaA({ participantPn: '573001112233@s.whatsapp.net' }, YO) === true)
  ok('cita por participantLid', citaA({ participantLid: MI_LID }, YO) === true)

  ok('usuarioDe corta el dispositivo', usuarioDe('573001112233:9@s.whatsapp.net') === '573001112233')
  ok('usuarioDe acepta un objeto wid', usuarioDe({ user: '123', server: 'lid' }) === '123')
  ok('identidadPropia distingue lid de telefono',
    identidadPropia(MI_LID) !== identidadPropia(MI_TEL),
    `${identidadPropia(MI_LID)} vs ${identidadPropia(MI_TEL)}`)
  ok('c.us y s.whatsapp.net son la MISMA identidad',
    identidadPropia('573001112233@c.us') === identidadPropia(MI_TEL))
}

console.log('\ntexto y media: de donde sale el cuerpo de cada tipo de mensaje')
{
  ok('conversation', textoDe({ conversation: 'el reporte de ayer salio en blanco' })
    === 'el reporte de ayer salio en blanco')
  ok('extendedTextMessage', textoDe({ extendedTextMessage: { text: 'mira esto' } }) === 'mira esto')
  ok('pie de imagen', textoDe({ imageMessage: { caption: 'la pantalla' } }) === 'la pantalla')
  ok('sin texto devuelve cadena vacia, nunca null', textoDe({ audioMessage: {} }) === '')
  ok('sin mensaje devuelve cadena vacia', textoDe(null) === '')

  const img = mediaDe({ imageMessage: { mimetype: 'image/jpeg', fileLength: 4096 } })
  ok('imagen', img?.tipo === 'imagen' && img?.bytes === 4096, JSON.stringify(img))
  ok('la extension sale del mimetype', img?.ext === '.jpg', JSON.stringify(img))
  const voz = mediaDe({ audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, fileLength: 9000 } })
  ok('nota de voz es audio', voz?.tipo === 'audio', JSON.stringify(voz))
  // wa-transcribe recibe una RUTA y nada mas: la extension tiene que ser la que
  // ffmpeg sabe abrir, o el audio queda sin leer lejos de aca (§11-C4).
  ok('la nota de voz se guarda como .ogg', voz?.ext === '.ogg', JSON.stringify(voz))
  ok('un video es video', mediaDe({ videoMessage: { mimetype: 'video/mp4' } })?.tipo === 'video')
  ok('un documento es documento',
    mediaDe({ documentMessage: { mimetype: 'application/pdf', fileName: 'a.pdf' } })?.tipo === 'documento')
  ok('un texto no trae media', mediaDe({ conversation: 'hola' }) === null)
  ok('los tipos son los mismos que publica wa-read',
    new Set(Object.values(TIPO_MEDIA)).size === 5 &&
    ['imagen', 'video', 'audio', 'documento', 'sticker']
      .every((t) => Object.values(TIPO_MEDIA).includes(t)),
    JSON.stringify(TIPO_MEDIA))
}

console.log('\nfilaDeMensaje: de un WAMessage a una fila del almacen')
{
  const grupo = '120363111222333444@g.us'
  const base = {
    key: { remoteJid: grupo, fromMe: false, id: 'ABC123', participant: '573009998877@s.whatsapp.net' },
    messageTimestamp: 1758500000,
    pushName: 'Laura Mendez',
    message: {
      extendedTextMessage: {
        text: '@199887766554433 el reporte de ayer salio en blanco',
        contextInfo: { mentionedJid: [MI_LID] }
      }
    }
  }
  const fila = filaDeMensaje(base, { cuenta: 'linea-uno', identidades: YO })
  ok('trae la cuenta, que es parte de la llave (§11-A1/F4)', fila?.cuenta === 'linea-uno')
  ok('trae el chat', fila?.chatJid === grupo)
  ok('trae el stanza_id, que es la llave de idempotencia', fila?.stanzaId === 'ABC123')
  ok('la fecha viene en segundos de epoch unix', fila?.ts === 1758500000, String(fila?.ts))
  ok('el remitente es el participante del grupo',
    fila?.senderJid === '573009998877@s.whatsapp.net')
  ok('el nombre visible sale del pushName', fila?.senderName === 'Laura Mendez')
  ok('el cuerpo es el texto', fila?.body.includes('el reporte de ayer'))
  ok('la mencion quedo marcada', fila?.mencionaMe === 1, JSON.stringify(fila))
  ok('no hay cita', fila?.citaMe === 0)
  ok('sabe que es grupo', fila?.esGrupo === 1)
  ok('sin media, los campos van en null', fila?.mediaTipo === null)

  // Un directo: todo mensaje ajeno es para usted, y no hay participante.
  const directo = filaDeMensaje({
    key: { remoteJid: '573009998877@s.whatsapp.net', fromMe: false, id: 'D1' },
    messageTimestamp: 1758500100,
    pushName: 'Laura Mendez',
    message: { conversation: 'hola' }
  }, { cuenta: 'linea-uno', identidades: YO })
  ok('en un directo el remitente es el chat mismo',
    directo?.senderJid === '573009998877@s.whatsapp.net', JSON.stringify(directo))
  ok('y no se marca como grupo', directo?.esGrupo === 0)

  // Lo propio se guarda igual: es lo que suprime una mencion ya contestada (§11-D1).
  const mio = filaDeMensaje({
    key: { remoteJid: grupo, fromMe: true, id: 'MIO1' },
    messageTimestamp: 1758500200,
    message: { conversation: 'ya lo reviso' }
  }, { cuenta: 'linea-uno', identidades: YO })
  ok('un mensaje propio queda marcado fromMe', mio?.fromMe === 1)

  // Lo que NO es una conversacion no produce fila. Cortarlo aca y no en la consulta
  // es lo que hace que un canal no deje ni un cuerpo en disco.
  const canal = filaDeMensaje({
    key: { remoteJid: '123@newsletter', fromMe: false, id: 'N1' },
    messageTimestamp: 1758500300, message: { conversation: 'promo' }
  }, { cuenta: 'linea-uno', identidades: YO })
  ok('un canal no produce fila', canal === null)

  // Sin stanza_id no hay idempotencia posible: guardar eso duplicaria el mensaje en
  // cada corrida, que es peor que perderlo.
  ok('sin id no produce fila', filaDeMensaje({
    key: { remoteJid: grupo, fromMe: false }, messageTimestamp: 1, message: { conversation: 'x' }
  }, { cuenta: 'linea-uno', identidades: YO }) === null)

  // messageTimestamp llega como Long de protobufjs en mensajes reales.
  const conLong = filaDeMensaje({
    key: { remoteJid: grupo, fromMe: false, id: 'L1' },
    messageTimestamp: { low: 1758500400, high: 0, unsigned: true, toNumber: () => 1758500400 },
    message: { conversation: 'x' }
  }, { cuenta: 'linea-uno', identidades: YO })
  ok('un timestamp Long se convierte a numero', conLong?.ts === 1758500400, String(conLong?.ts))

  // Una cita a un mensaje mio, en la forma vieja (@c.us). Es B1 de punta a punta.
  const cita = filaDeMensaje({
    key: { remoteJid: grupo, fromMe: false, id: 'Q1', participant: '573009998877@s.whatsapp.net' },
    messageTimestamp: 1758500500,
    message: { extendedTextMessage: { text: 'si, eso', contextInfo: { participant: '573001112233@c.us' } } }
  }, { cuenta: 'linea-uno', identidades: YO })
  ok('una cita en @c.us queda marcada', cita?.citaMe === 1, JSON.stringify(cita))
  ok('y no se confunde con una mencion', cita?.mencionaMe === 0)
}

console.log('\nB4: borrados y editados — el hueco que el codigo viejo no llenaba')
{
  // Revocacion: Baileys manda `message: null` + `messageStubType: REVOKE` (68).
  const borrado = filaDeActualizacion({
    key: { remoteJid: '120363111222333444@g.us', fromMe: false, id: 'ABC123' },
    update: { message: null, messageStubType: 68 }
  })
  ok('un borrado se reconoce', borrado?.revocado === 1, JSON.stringify(borrado))
  ok('y trae el chat y el stanza del mensaje borrado',
    borrado?.chatJid === '120363111222333444@g.us' && borrado?.stanzaId === 'ABC123')
  ok('un borrado no trae cuerpo nuevo', borrado?.body === null)

  // Edicion: el cuerpo nuevo viene envuelto en `editedMessage`.
  const editado = filaDeActualizacion({
    key: { remoteJid: '120363111222333444@g.us', fromMe: false, id: 'ABC123' },
    update: {
      message: { editedMessage: { message: { conversation: 'el reporte de ANTEAYER salio en blanco' } } },
      messageTimestamp: 1758500900
    }
  })
  ok('una edicion se reconoce', editado?.editado === 1, JSON.stringify(editado))
  ok('y trae el cuerpo nuevo', editado?.body === 'el reporte de ANTEAYER salio en blanco')
  ok('el borrado no se confunde con la edicion', borrado?.editado === 0)
  ok('la edicion no se confunde con el borrado', editado?.revocado === 0)

  // Lo demas que llega por `messages.update` —recibos de lectura, estados de envio—
  // no es ni un borrado ni una edicion y no puede tocar el cuerpo guardado.
  const recibo = filaDeActualizacion({
    key: { remoteJid: '120363111222333444@g.us', fromMe: true, id: 'MIO1' },
    update: { status: 3 }
  })
  ok('un recibo de lectura no produce cambio', recibo === null, JSON.stringify(recibo))
  ok('una actualizacion sin id no produce cambio',
    filaDeActualizacion({ key: { remoteJid: 'x@g.us' }, update: { message: null } }) === null)
}

console.log('\nmensajes: la identidad de la sesion se lee de donde de verdad esta')
{
  // El caso medido: en `connection: open`, `sock.user` trae el telefono y NO el LID.
  // Mirar solo ahi dejaba `identidades` sin el LID, y como las menciones de WhatsApp
  // viajan en @lid, `menciona_me` quedaba en 0 sobre mensajes que nombraban al dueno.
  const enOpen = identidadDeSesion(
    { me: { id: '573001112233:7@s.whatsapp.net' } },
    { id: '573001112233:7@s.whatsapp.net' })
  ok('en el open todavia no hay LID, y eso no se inventa', enOpen.lid === null,
    JSON.stringify(enOpen))
  ok('pero el telefono si se conoce', enOpen.pn === '573001112233:7@s.whatsapp.net',
    JSON.stringify(enOpen))

  // Y por `creds.update` aparece. Por eso hay que volver a preguntar.
  const tras = identidadDeSesion(
    { me: { id: '573001112233:7@s.whatsapp.net', lid: '199887766554433:7@lid',
      name: 'Fabian' } }, null)
  ok('tras creds.update el LID ya esta', tras.lid === '199887766554433:7@lid',
    JSON.stringify(tras))
  ok('y el nombre tambien', tras.nombre === 'Fabian', JSON.stringify(tras))

  // `creds.me` manda sobre `sock.user`: es el registro persistente, y es el que tenia
  // el LID cuando la tabla `linea` lo tenia en NULL.
  const preferencia = identidadDeSesion(
    { me: { id: 'guardado@s.whatsapp.net', lid: 'guardado@lid' } },
    { id: 'vivo@s.whatsapp.net', lid: 'vivo@lid' })
  ok('creds manda sobre sock.user',
    preferencia.lid === 'guardado@lid' && preferencia.pn === 'guardado@s.whatsapp.net',
    JSON.stringify(preferencia))

  // Pero si creds no lo tiene y el socket si, se usa el del socket: no saber por un
  // lado no puede tapar lo que el otro si sabe.
  const respaldo = identidadDeSesion({ me: {} }, { id: 'vivo@s.whatsapp.net', lid: 'vivo@lid' })
  ok('y sock.user queda de respaldo', respaldo.lid === 'vivo@lid', JSON.stringify(respaldo))

  ok('sin nada, no se inventa nada',
    JSON.stringify(identidadDeSesion(null, null)) ===
    JSON.stringify({ lid: null, pn: null, nombre: null }))

  // Lo que todo esto habilita: con el LID, la mencion se reconoce; sin el, no.
  const conLid = identidadesPropias('199887766554433:7@lid', '573001112233:7@s.whatsapp.net')
  const sinLid = identidadesPropias(null, '573001112233:7@s.whatsapp.net')
  const mencion = { mentionedJid: ['199887766554433@lid'] }
  ok('con el LID la mencion se reconoce', mencionaA(mencion, conLid) === true)
  ok('sin el LID no se reconoce NUNCA — el defecto entero en una linea',
    mencionaA(mencion, sinLid) === false)
}

console.log(`\n${pruebas - fallos}/${pruebas} en verde`)
if (fallos) {
  console.error(`\n${fallos} fallas`)
  process.exit(1)
}
