#!/usr/bin/env node
/**
 * El almacen de mensajes, de punta a punta y sin una cuenta de WhatsApp.
 *
 * Los mensajes se fabrican con la forma que emite Baileys, se ingieren con el MISMO
 * codigo que corre dentro del sidecar, y despues se le pregunta al `bin/wa-read` de
 * verdad —el proceso, con su HOME propio— para que lo que se prueba sea el contrato
 * JSON que leen `wa-scope`, el panel y los prompts, y no una funcion interna.
 *
 * Los seis casos de uso son los de odd/tasks/transporte-unico.md T8, que son los que
 * importan mas que cualquier asercion de unidad:
 *
 *   1. Un cliente escribe en su grupo y eso aparece en la bandeja, con conversacion,
 *      remitente y hora.
 *   2. La captura que manda DESPUES queda asociada al problema, no suelta (§11-C5).
 *   3. Una nota de voz deja una ruta que `bin/wa-transcribe` puede abrir (§11-C4).
 *   4. Cinco mensajes sobre un problema le llegan al agente como UNA conversacion.
 *   5. Una mencion ya contestada no vuelve (§11-D1).
 *   6. Un grupo en `off` no produce NI UN cuerpo (§5, denegar por defecto).
 *
 * Y las invariantes que no se ven mirando el panel: la llave `(cuenta, chat_jid,
 * stanza_id)` que aisla dos lineas propias (§11-F4/A1), los permisos 0600 (§11-F1), el
 * tope de retencion con desalojo VISIBLE (§11-F2), el borrado del contenido que
 * conserva la contabilidad (§11-F3), y la diferencia entre una bandeja vacia y una
 * bandeja rota (§11-E5).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
// `node:sqlite` vive en el Node que trae Orca (medido: Electron 43, Node 24.18), que es
// el mismo que corre el sidecar. La prueba abre el almacen con el MISMO motor que lo
// escribe, para que un desacuerdo de esquema se vea aca y no en produccion.
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { identidadesPropias } from '../sidecar/src/mensajes.js'
import { abrirAlmacen, ESQUEMA_VERSION, rutaAlmacen, rutaMedia } from '../sidecar/src/almacen.js'
import { ingerirActualizacion, ingerirChats, ingerirMensaje } from '../sidecar/src/ingesta.js'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')
const WA_READ = join(RAIZ, 'bin', 'wa-read')
const WA_SCOPE = join(RAIZ, 'bin', 'wa-scope')

let fallos = 0
let pruebas = 0
function ok (nombre, condicion, detalle = '') {
  pruebas += 1
  if (condicion) return console.log(`  ok    ${nombre}`)
  fallos += 1
  console.log(`  FALLA ${nombre}${detalle ? ` — ${String(detalle).slice(0, 400)}` : ''}`)
}

// ── El escenario ────────────────────────────────────────────────────────────────────
const CUENTA = 'local'
const MI_LID = '199887766554433@lid'
const MI_TEL = '573001112233@s.whatsapp.net'
const YO = identidadesPropias(MI_LID, MI_TEL)

const ALFA = '120363111222333444@g.us'      // grupo del cliente, autorizado
const CALLADO = '120363999888777666@g.us'   // grupo en off
const LAURA = '573009998877@s.whatsapp.net' // directo, autorizado
const OTRA_PERSONA = '573005554433@s.whatsapp.net'

const T0 = 1758500000  // epoch en segundos; todo el escenario cuelga de aca

function mensaje ({ chat, id, ts, de = OTRA_PERSONA, texto = '', mio = false,
  menciona = false, cita = false, media = null, nombre = 'Laura Mendez' }) {
  const contextInfo = {}
  if (menciona) contextInfo.mentionedJid = [MI_LID]
  // La forma VIEJA a proposito: `@c.us`. Es §11-B1 metido en el camino real.
  if (cita) contextInfo.participant = '573001112233@c.us'
  const cuerpo = media
    ? { [media.campo]: { mimetype: media.mime, fileLength: media.bytes, caption: texto,
        ...(Object.keys(contextInfo).length ? { contextInfo } : {}) } }
    : { extendedTextMessage: { text: texto, contextInfo } }
  return {
    key: { remoteJid: chat, fromMe: mio, id,
      ...(chat.endsWith('@g.us') ? { participant: mio ? MI_TEL : de } : {}) },
    messageTimestamp: ts,
    pushName: mio ? undefined : nombre,
    message: cuerpo
  }
}

// El descargador de mentira: no hay red, pero SI hay bytes y SI hay archivo, porque lo
// que se prueba es que `wa-transcribe` pueda abrir la ruta que publica la bandeja.
async function descargarFalso () {
  return Buffer.from('bytes-de-mentira-que-igual-ocupan-lugar')
}

function correrLectura (home, args) {
  const r = spawnSync(WA_READ, args, {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ORCA_CLI_COMMAND: join(home, 'no-existe-orca') },
    timeout: 120000
  })
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

function leerJson (home, args) {
  const r = correrLectura(home, [...args, '--json'])
  try {
    return { ...r, filas: JSON.parse(r.stdout || '[]') }
  } catch {
    return { ...r, filas: null }
  }
}

function casaNueva () {
  const home = mkdtempSync(join(tmpdir(), 'wa-almacen-'))
  mkdirSync(join(home, '.wa-inbox'), { recursive: true })
  return home
}

function autorizar (home, { jid, nombre, modo, cuenta = CUENTA }) {
  // Se registra con el CLI de verdad y no escribiendo el sqlite a mano: el registro de
  // autorizacion es de `wa-scope` y esta prueba lo ALIMENTA, no lo reemplaza.
  execFileSync(WA_SCOPE, ['set', jid, '--mode', modo, '--provider', 'ninguno'], {
    env: { ...process.env, HOME: home }, encoding: 'utf8'
  })
  const con = new DatabaseSync(join(home, '.wa-inbox', 'scope.db'))
  con.prepare('update chat_scope set chat_name=?, account=? where chat_jid=?')
    .run(nombre, cuenta, jid)
  con.close()
}

// ── Arranque ────────────────────────────────────────────────────────────────────────
const casas = []
function nueva () {
  const home = casaNueva()
  casas.push(home)
  return home
}

console.log('\nE5: una bandeja vacia y una bandeja rota NO se pueden ver igual')
{
  const home = nueva()
  // Sin almacen: nadie enlazo una linea todavia. Negarse es el punto.
  for (const cmd of ['inbox', 'chats', 'whoami', 'state']) {
    const r = correrLectura(home, [cmd, '--json'])
    ok(`sin almacen, \`${cmd}\` sale 4`, r.code === 4, `salio ${r.code}`)
    ok(`sin almacen, \`${cmd}\` dice no-transport en la primera linea de stderr`,
      (r.stderr.trim().split('\n')[0] || '') === 'wa-read: no-transport', r.stderr)
    ok(`sin almacen, \`${cmd}\` no escribe en stdout`, r.stdout.trim() === '', r.stdout)
  }

  // Con la linea enlazada y CERO mensajes: contesta vacio y sale 0. Es lo contrario.
  const alm = abrirAlmacen(rutaAlmacen({ HOME: home }))
  alm.registrarLinea({ cuenta: CUENTA, lid: MI_LID, pn: MI_TEL, nombre: 'Mi Linea' })
  alm.cerrar()
  const vacio = leerJson(home, ['inbox'])
  ok('con linea y sin mensajes, `inbox` sale 0', vacio.code === 0, vacio.stderr)
  ok('y devuelve una lista vacia, no un error',
    Array.isArray(vacio.filas) && vacio.filas.length === 0, vacio.stdout)
}

console.log('\nF1: el almacen es texto ajeno — 0600, no el umask')
{
  const home = nueva()
  const alm = abrirAlmacen(rutaAlmacen({ HOME: home }))
  alm.registrarLinea({ cuenta: CUENTA, lid: MI_LID, pn: MI_TEL, nombre: 'Mi Linea' })
  alm.cerrar()
  const modo = statSync(rutaAlmacen({ HOME: home })).mode & 0o777
  ok('capture.db queda en 0600', modo === 0o600, '0' + modo.toString(8))
}

// ── El escenario completo, que es donde viven los seis casos de uso ─────────────────
const home = nueva()
const almacen = abrirAlmacen(rutaAlmacen({ HOME: home }))
const mediaDir = rutaMedia({ HOME: home })
almacen.registrarLinea({ cuenta: CUENTA, lid: MI_LID, pn: MI_TEL, nombre: 'Mi Linea' })

autorizar(home, { jid: ALFA, nombre: 'Cliente Alfa', modo: 'observar' })
autorizar(home, { jid: LAURA, nombre: 'Laura Mendez', modo: 'observar' })
autorizar(home, { jid: CALLADO, nombre: 'Grupo Callado', modo: 'off' })

// El alcance, tal como lo ve el sidecar: un mapa `(cuenta, jid) -> modo`, que se le
// pregunta a `wa-scope` y NUNCA se sintetiza. Lo que no esta, esta en off.
const ALCANCE = new Map([
  [`${CUENTA}\u0000${ALFA}`, 'observar'],
  [`${CUENTA}\u0000${LAURA}`, 'observar'],
  [`${CUENTA}\u0000${CALLADO}`, 'off']
])
const alcance = (cuenta, jid) => ALCANCE.get(`${cuenta}\u0000${jid}`) || 'off'

const nombres = new Map([[ALFA, 'Cliente Alfa'], [LAURA, 'Laura Mendez'],
  [CALLADO, 'Grupo Callado']])

async function ingerir (wa) {
  return ingerirMensaje({
    almacen, alcance, cuenta: CUENTA, identidades: YO, wa, mediaDir,
    descargarMedia: descargarFalso,
    nombreDeChat: (jid) => nombres.get(jid) || null
  })
}

// Caso 1: el cliente reporta el problema, nombrando al propietario.
await ingerir(mensaje({ chat: ALFA, id: 'M1', ts: T0,
  texto: '@199887766554433 el reporte de ayer salio en blanco', menciona: true }))
// Caso 3: la nota de voz, un minuto despues.
await ingerir(mensaje({ chat: ALFA, id: 'M2', ts: T0 + 60,
  media: { campo: 'audioMessage', mime: 'audio/ogg; codecs=opus', bytes: 9000 } }))
// Caso 2: la captura, dos minutos despues. Sin pie y sin mencion, como en la vida real.
await ingerir(mensaje({ chat: ALFA, id: 'M3', ts: T0 + 120,
  media: { campo: 'imageMessage', mime: 'image/jpeg', bytes: 40960 } }))
// Caso 4: el problema contado en cinco mensajes, todos del mismo cliente y chat.
for (let i = 0; i < 4; i += 1) {
  await ingerir(mensaje({ chat: ALFA, id: `M4${i}`, ts: T0 + 180 + i * 30,
    texto: `y ademas la columna ${i} sale corrida`, menciona: i === 3 }))
}
// Caso 6: el grupo en off escribe, y nombra al propietario. No puede quedar nada.
await ingerir(mensaje({ chat: CALLADO, id: 'X1', ts: T0 + 200,
  texto: '@199887766554433 miren esto', menciona: true }))
await ingerir(mensaje({ chat: CALLADO, id: 'X2', ts: T0 + 210,
  media: { campo: 'imageMessage', mime: 'image/jpeg', bytes: 1024 } }))
// Un directo: en un uno a uno todo mensaje ajeno es para usted.
await ingerir(mensaje({ chat: LAURA, id: 'D1', ts: T0 + 300, texto: 'quedo pendiente eso' }))
// Una cita en la forma vieja (@c.us), que es §11-B1 en el camino real.
await ingerir(mensaje({ chat: ALFA, id: 'Q1', ts: T0 + 400, texto: 'si, exacto', cita: true }))

console.log('\nCaso 1: el reporte del cliente aparece en la bandeja, con todo lo suyo')
{
  const { code, filas, stderr } = leerJson(home, ['inbox', '--days', '36500'])
  ok('`inbox` contesta 0', code === 0, stderr)
  const m1 = (filas || []).find((f) => f.stanza_id === 'M1')
  ok('el mensaje del cliente esta en la bandeja', !!m1, JSON.stringify(filas))
  ok('con su conversacion', m1?.chat === 'Cliente Alfa' && m1?.chat_jid === ALFA,
    JSON.stringify(m1))
  ok('con su remitente', m1?.sender === 'Laura Mendez', JSON.stringify(m1))
  ok('con su hora, y no en 1970', /^20\d\d-\d\d-\d\d \d\d:\d\d$/.test(m1?.date || ''),
    String(m1?.date))
  ok('con su texto', (m1?.text || '').includes('el reporte de ayer salio en blanco'))
  ok('y clasificado como mencion', m1?.kind === 'mencion', String(m1?.kind))

  // El contrato JSON entero, que es lo que leen wa-scope y el panel.
  const ESPERADAS = ['date', 'stanza_id', 'chat', 'chat_id', 'chat_jid', 'sender',
    'kind', 'text', 'media', 'adjuntos_cerca', 'audios']
  ok('la fila trae todas las claves del contrato',
    ESPERADAS.every((k) => m1 && k in m1),
    JSON.stringify(ESPERADAS.filter((k) => m1 && !(k in m1))))
  ok('`text` nunca es null', typeof m1?.text === 'string')
  ok('`chat_id` es un entero, como lo espera wa-scope', Number.isInteger(m1?.chat_id),
    String(m1?.chat_id))

  // La cita en `@c.us` entro por el camino real, no solo en la prueba de unidad.
  const q1 = (filas || []).find((f) => f.stanza_id === 'Q1')
  ok('B1: una cita en la forma vieja llega a la bandeja', !!q1, JSON.stringify(filas))
  ok('y se clasifica como respuesta', q1?.kind === 'respuesta', String(q1?.kind))

  // En un directo todo mensaje ajeno cuenta.
  const d1 = (filas || []).find((f) => f.stanza_id === 'D1')
  ok('un directo entra a la bandeja', !!d1)
  ok('y se clasifica como directo', d1?.kind === 'directo', String(d1?.kind))
}

console.log('\nCaso 2 (§11-C5): la captura que llega DESPUES queda con el problema')
{
  const { filas } = leerJson(home, ['inbox', '--days', '36500'])
  const m1 = (filas || []).find((f) => f.stanza_id === 'M1')
  const cerca = m1?.adjuntos_cerca || []
  ok('el mensaje de la mencion no trae adjunto propio', m1?.media === null,
    String(m1?.media))
  ok('pero la captura aparece en adjuntos_cerca',
    cerca.some((a) => a.type === 'imagen'), JSON.stringify(cerca))
  const img = cerca.find((a) => a.type === 'imagen')
  ok('con su ruta en disco', !!img?.path && existsSync(img.path), String(img?.path))
  ok('y con sus claves de contrato',
    img && ['date', 'sender', 'type', 'caption', 'path'].every((k) => k in img),
    JSON.stringify(img))

  // La ventana es de +/- N minutos y se puede apagar: con 0 no se inventa vecindad.
  const sinVentana = leerJson(home, ['inbox', '--days', '36500', '--window', '0'])
  const m1sin = (sinVentana.filas || []).find((f) => f.stanza_id === 'M1')
  ok('con --window 0 no hay adjuntos cercanos', (m1sin?.adjuntos_cerca || []).length === 0,
    JSON.stringify(m1sin?.adjuntos_cerca))
}

console.log('\nCaso 3: la nota de voz deja una ruta que wa-transcribe puede abrir')
{
  const { filas } = leerJson(home, ['inbox', '--days', '36500'])
  const m1 = (filas || []).find((f) => f.stanza_id === 'M1')
  const audios = m1?.audios || []
  ok('la nota de voz sale en `audios`', audios.length === 1, JSON.stringify(audios))
  ok('la ruta existe de verdad', audios[0] && existsSync(audios[0]), String(audios[0]))
  // §11-C4: nunca sintetizar una ruta que no se puede respaldar. Y la extension
  // importa: un `.bin` deja el audio sin leer lejos de aca.
  ok('y termina en .ogg, que es lo que ffmpeg abre', /\.ogg$/.test(audios[0] || ''),
    String(audios[0]))
  ok('el archivo de media tambien es 0600',
    audios[0] ? (statSync(audios[0]).mode & 0o777) === 0o600 : false)

  const media = leerJson(home, ['media', ALFA])
  ok('`media` lista los adjuntos del chat', (media.filas || []).length === 2,
    JSON.stringify(media.filas))
  const fila = (media.filas || [])[0]
  ok('con las claves del contrato',
    fila && ['date', 'chat', 'sender', 'type', 'bytes', 'caption', 'path', 'exists']
      .every((k) => k in fila), JSON.stringify(fila))
  ok('y `exists` dice la verdad sobre el disco', fila?.exists === true, JSON.stringify(fila))
}

console.log('\nCaso 4: cinco mensajes sobre un problema son UNA conversacion')
{
  const { filas } = leerJson(home, ['inbox', '--days', '36500'])
  const deAlfa = (filas || []).filter((f) => f.chat_jid === ALFA)
  ok('los mensajes del cliente comparten chat_jid', deAlfa.length >= 2,
    String(deAlfa.length))
  ok('y comparten chat_id, que es por donde se agrupan',
    new Set(deAlfa.map((f) => f.chat_id)).size === 1,
    JSON.stringify(deAlfa.map((f) => f.chat_id)))
  // El agente no puede abrir una tarjeta por mensaje si no ve el hilo: los vecinos
  // viajan con cada fila para que los cinco se lean como un problema y no como cinco.
  const m1 = deAlfa.find((f) => f.stanza_id === 'M1')
  ok('cada fila trae el contexto de al lado',
    Array.isArray(m1?.contexto_cerca) && m1.contexto_cerca.length > 0,
    JSON.stringify(m1?.contexto_cerca))
  const ctx = (m1?.contexto_cerca || [])[0]
  ok('con las claves del contrato',
    ctx && ['date', 'sender', 'text'].every((k) => k in ctx), JSON.stringify(ctx))
}

console.log('\nCaso 5 (§11-D1): una mencion ya contestada no vuelve')
{
  const antes = leerJson(home, ['inbox', '--days', '36500'])
  ok('antes de contestar, la mencion esta',
    (antes.filas || []).some((f) => f.stanza_id === 'M1'))

  // El propietario contesta en ese chat, despues de todo lo anterior.
  await ingerir(mensaje({ chat: ALFA, id: 'MIO1', ts: T0 + 900, mio: true,
    texto: 'lo reviso y le cuento' }))

  const despues = leerJson(home, ['inbox', '--days', '36500'])
  const quedan = (despues.filas || []).filter((f) => f.chat_jid === ALFA)
  ok('despues de contestar, no queda nada pendiente de ese chat', quedan.length === 0,
    JSON.stringify(quedan.map((f) => f.stanza_id)))
  ok('y la conversacion que SI sigue pendiente no se toco',
    (despues.filas || []).some((f) => f.chat_jid === LAURA),
    JSON.stringify(despues.filas))

  // Y un mensaje nuevo DESPUES de la respuesta si vuelve a aparecer: "ya contestado"
  // es una linea de corte, no una mordaza sobre el chat.
  await ingerir(mensaje({ chat: ALFA, id: 'M9', ts: T0 + 1200,
    texto: '@199887766554433 sigue igual', menciona: true }))
  const otra = leerJson(home, ['inbox', '--days', '36500'])
  ok('un mensaje posterior a la respuesta vuelve a aparecer',
    (otra.filas || []).some((f) => f.stanza_id === 'M9'),
    JSON.stringify((otra.filas || []).map((f) => f.stanza_id)))
}

console.log('\nCaso 6: un grupo en `off` no produce NI UN cuerpo')
{
  const con = new DatabaseSync(rutaAlmacen({ HOME: home }))
  const n = con.prepare('select count(*) c from mensaje where chat_jid=?').get(CALLADO)
  ok('cero filas de contenido para el chat en off', Number(n?.c) === 0, JSON.stringify(n))
  const chat = con.prepare('select chat_name from chat where chat_jid=?').get(CALLADO)
  // Pero la conversacion SI existe como contabilidad: sin eso, un grupo en off no se
  // puede ni ofrecer para autorizarlo, y la lista del panel nace vacia para siempre.
  // No es contenido de nadie (§11-F3).
  ok('pero la conversacion existe para poder autorizarla', !!chat, JSON.stringify(chat))
  con.close()

  const inbox = leerJson(home, ['inbox', '--days', '36500'])
  ok('y no aparece en la bandeja',
    !(inbox.filas || []).some((f) => f.chat_jid === CALLADO))
  const media = leerJson(home, ['media', CALLADO])
  ok('ni deja adjuntos', (media.filas || []).length === 0, JSON.stringify(media.filas))
  ok('ni un archivo en disco',
    !existsSync(join(mediaDir, CUENTA, 'X2.jpg')), join(mediaDir, CUENTA, 'X2.jpg'))
}

console.log('\nB4: borrados y editados, que antes no se manejaban en ningun lado')
{
  await ingerir(mensaje({ chat: LAURA, id: 'E1', ts: T0 + 1300, texto: 'el lunes a las 9' }))
  ingerirActualizacion({ almacen, alcance, cuenta: CUENTA, evento: {
    key: { remoteJid: LAURA, fromMe: false, id: 'E1' },
    update: { message: { editedMessage: { message: { conversation: 'el MARTES a las 9' } } },
      messageTimestamp: T0 + 1350 }
  } })
  const chat = leerJson(home, ['chat', LAURA])
  const e1 = (chat.filas || []).find((f) => (f.text || '').includes('a las 9'))
  ok('un mensaje editado se lee por lo que dice AHORA',
    e1?.text === 'el MARTES a las 9', JSON.stringify(e1))

  await ingerir(mensaje({ chat: LAURA, id: 'R1', ts: T0 + 1400, texto: 'perdon, era para otro' }))
  const conBorrable = leerJson(home, ['chat', LAURA])
  ok('antes de borrarlo, el mensaje esta',
    (conBorrable.filas || []).some((f) => (f.text || '').includes('era para otro')))
  ingerirActualizacion({ almacen, alcance, cuenta: CUENTA, evento: {
    key: { remoteJid: LAURA, fromMe: false, id: 'R1' },
    update: { message: null, messageStubType: 68 }
  } })
  const despues = leerJson(home, ['chat', LAURA])
  ok('despues de borrarlo, el cuerpo NO se sigue sirviendo',
    !(despues.filas || []).some((f) => (f.text || '').includes('era para otro')),
    JSON.stringify(despues.filas))
  const inbox = leerJson(home, ['inbox', '--days', '36500'])
  ok('ni vuelve por la bandeja',
    !(inbox.filas || []).some((f) => f.stanza_id === 'R1'))
}

console.log('\nchats / whoami / state: el resto del contrato JSON')
{
  const chats = leerJson(home, ['chats', '-n', '400'])
  ok('`chats` contesta 0', chats.code === 0, chats.stderr)
  const alfa = (chats.filas || []).find((c) => c.jid === ALFA)
  ok('el grupo autorizado esta', !!alfa, JSON.stringify(chats.filas))
  ok('con las claves del contrato',
    alfa && ['id', 'jid', 'kind', 'unread', 'last', 'name'].every((k) => k in alfa),
    JSON.stringify(alfa))
  // `jid_of` en wa-scope hace `c["id"]` y no `.get`: sin esa clave revienta con
  // KeyError y se lleva puesto todo comando que acepte un nombre en vez de un jid.
  ok('`id` viene siempre, que es lo que wa-scope indexa sin .get',
    (chats.filas || []).every((c) => c.id !== undefined && c.id !== null))
  ok('un grupo dice grupo', alfa?.kind === 'grupo', String(alfa?.kind))
  ok('un directo dice directo',
    (chats.filas || []).find((c) => c.jid === LAURA)?.kind === 'directo')
  ok('el grupo en off TAMBIEN se lista, o no se puede autorizar nunca',
    (chats.filas || []).some((c) => c.jid === CALLADO))
  const busca = leerJson(home, ['chats', '--query', 'Alfa'])
  ok('`--query` filtra por nombre',
    (busca.filas || []).length === 1 && busca.filas[0].jid === ALFA,
    JSON.stringify(busca.filas))

  const quien = leerJson(home, ['whoami'])
  ok('`whoami` devuelve UNA fila', Array.isArray(quien.filas) && quien.filas.length === 1,
    JSON.stringify(quien.filas))
  ok('con lid, name y grupos',
    quien.filas?.[0] && ['lid', 'name', 'grupos'].every((k) => k in quien.filas[0]),
    JSON.stringify(quien.filas?.[0]))
  ok('y el lid es el de la linea', quien.filas?.[0]?.lid === MI_LID,
    JSON.stringify(quien.filas?.[0]))

  const estado = leerJson(home, ['state'])
  ok('`state` devuelve una fila por linea', (estado.filas || []).length === 1)
  const f = (estado.filas || [])[0]
  ok('con las claves del contrato',
    f && ['account', 'db', 'exists', 'mtime', 'size', 'fingerprint'].every((k) => k in f),
    JSON.stringify(f))
  // `missing` y `live` son centinelas de wa-scope: devolverlas como firma de verdad
  // congela la bandeja, que es el defecto que documenta §11-E6.
  ok('y la firma no es ninguno de los dos centinelas',
    f && !['missing', 'live'].includes(f.fingerprint), JSON.stringify(f))
}

console.log('\nF4/A1: la llave aisla dos lineas propias')
{
  // La MISMA conversacion, vista desde otra linea del propietario. Servir el cuerpo de
  // la otra linea es contestar sobre la conversacion ajena.
  almacen.registrarLinea({ cuenta: 'segunda', lid: '2222@lid', pn: '573002220000@s.whatsapp.net',
    nombre: 'Segunda Linea' })
  ALCANCE.set(`segunda\u0000${LAURA}`, 'observar')
  await ingerirMensaje({
    almacen, alcance, cuenta: 'segunda', identidades: identidadesPropias('2222@lid', '573002220000@s.whatsapp.net'),
    wa: mensaje({ chat: LAURA, id: 'S1', ts: T0 + 2000, texto: 'esto es de la otra linea' }),
    mediaDir, descargarMedia: descargarFalso, nombreDeChat: () => 'Laura Mendez'
  })
  const con = new DatabaseSync(rutaAlmacen({ HOME: home }))
  const filas = con.prepare(
    'select account, chat_jid, stanza_id from mensaje where stanza_id in (?,?) order by account')
    .all('D1', 'S1')
  ok('las dos lineas guardan el mismo chat por separado',
    filas.length === 2 && filas[0].account !== filas[1].account, JSON.stringify(filas))
  const propio = leerJson(home, ['chat', LAURA, '--line', CUENTA])
  ok('pedir una linea no sirve el cuerpo de la otra',
    !(propio.filas || []).some((f) => (f.text || '').includes('de la otra linea')),
    JSON.stringify(propio.filas))
  con.close()
}

console.log('\nF2: tope de retencion, con desalojo VISIBLE')
{
  const podado = almacen.podar({ max: 3, dias: 36500, ahora: (T0 + 3000) * 1000 })
  ok('podar devuelve cuanto se fue por tope', podado.desalojados > 0, JSON.stringify(podado))
  ok('y cuanto por caducidad', typeof podado.caducados === 'number', JSON.stringify(podado))
  ok('y cuantos archivos de media se borraron con sus filas',
    typeof podado.archivos === 'number', JSON.stringify(podado))

  const estado = leerJson(home, ['state'])
  const f = (estado.filas || [])[0]
  // Un desalojo callado es un caso que se pierde y se descubre despues, cuando la fila
  // ya salio sin cuerpo y sin explicacion. `state` es donde wa-scope y el panel miran.
  ok('el ultimo desalojo se puede ver desde wa-read',
    f && 'evicted' in f && Number(f.evicted) > 0, JSON.stringify(f))
  ok('y dice cuando fue', f && 'evictedAt' in f, JSON.stringify(f))
}

console.log('\nF2: y el desalojo se puede VER desde el doctor, que es lo que pinta el panel')
{
  const doctor = leerJson(home, ['doctor'])
  const transporte = (doctor.filas || []).find((f) => f.code === 'no-transport')
  ok('con la linea enlazada, el renglon del transporte esta en verde',
    transporte && transporte.ok === true, JSON.stringify(transporte))
  ok('y el doctor sale 0, que es lo que desbloquea a las automatizaciones',
    doctor.code === 0, `salio ${doctor.code}`)

  const retencion = (doctor.filas || []).find((f) => f.code === 'retention')
  ok('el desalojo trae su propio renglon', !!retencion, JSON.stringify(doctor.filas))
  // `checkSystem` arma la lista de opcionales con `c.requerido === false && !c.ok`
  // (main.mjs): un renglon en `ok` no llega NUNCA al panel. Un desalojo que solo se ve
  // corriendo el CLI a mano no esta visible, esta escondido detras de una terminal.
  ok('y llega al panel: no bloquea, pero tampoco viene en ok',
    retencion && retencion.requerido === false && retencion.ok === false,
    JSON.stringify(retencion))
  ok('con el codigo que el panel traduce, no solo con la frase en ingles',
    retencion && retencion.detailCode === 'retention-evicted', JSON.stringify(retencion))
  ok('y el detalle dice cuantos se fueron y por que tope',
    /\d+/.test(retencion?.detalle || '') &&
    /capture_max|capture_days/.test(retencion?.detalle || ''), String(retencion?.detalle))
}

console.log('\nF3: apagar la captura borra los CUERPOS, no la contabilidad')
{
  almacen.olvidarCuerpos({ cuenta: CUENTA, chatJid: LAURA })
  const con = new DatabaseSync(rutaAlmacen({ HOME: home }))
  const cuerpos = con.prepare('select count(*) c from mensaje where account=? and chat_jid=?')
    .get(CUENTA, LAURA)
  ok('los cuerpos de ese chat se fueron', Number(cuerpos?.c) === 0, JSON.stringify(cuerpos))
  const chat = con.prepare('select first_seen from chat where account=? and chat_jid=?')
    .get(CUENTA, LAURA)
  ok('pero la contabilidad queda: no es contenido de nadie',
    !!chat && Number(chat.first_seen) > 0, JSON.stringify(chat))
  const linea = con.prepare('select first_seen from linea where account=?').get(CUENTA)
  ok('y la linea sigue con su fecha de enlace', !!linea, JSON.stringify(linea))
  con.close()
}

// ── La migracion del almacen que dejo la via vieja ──────────────────────────────────
// En toda maquina que alguna vez uso la via de WhatsApp Web, `~/.wa-inbox/capture.db`
// YA existe con otro esquema: `capturado` (la cache de cuerpos de esa via) y una
// `linea` de dos columnas, sin `store_meta`. El lector se niega con `store-schema`, que
// es lo correcto —contestar filas a medias es peor (§11-E5)— pero sin un camino de
// subida el plugin se instala, empareja y despues contesta `store-schema` a todo.
//
// Lo que se prueba aca es el camino de subida entero, con la forma EXACTA del archivo
// medido en la maquina del dueno.

/** El almacen de la via muerta, tal cual esta hoy en la maquina del dueno: sin
 *  `store_meta`, `pragma user_version` en 0, `capturado` con su indice por edad y una
 *  `linea` de dos columnas con las cuentas `web` y `web:<lid>`. */
function almacenViejo (home, { cuerpos = 0,
  lineas = ['web', 'web:262444127674377'] } = {}) {
  const ruta = rutaAlmacen({ HOME: home })
  const con = new DatabaseSync(ruta)
  con.exec(`
    create table capturado (
      account text not null, chat_jid text not null, stanza_id text not null,
      body text not null, captured_at integer not null,
      primary key (account, chat_jid, stanza_id));
    create table linea (account text primary key, first_seen integer not null);
    create index capturado_edad on capturado (captured_at);`)
  for (let i = 0; i < cuerpos; i += 1) {
    con.prepare('insert into capturado values (?,?,?,?,?)')
      .run('web', '120363000000000001@g.us', `V${i}`, `texto ajeno numero ${i}`, T0 - i)
  }
  for (const cuenta of lineas) {
    con.prepare('insert into linea values (?,?)').run(cuenta, T0 - 1000)
  }
  con.close()
  return ruta
}

function abrirLectura (home) {
  return new DatabaseSync(rutaAlmacen({ HOME: home }))
}

function tablas (con) {
  return new Set(con.prepare("select name from sqlite_master where type='table'")
    .all().map((f) => f.name))
}

console.log('\nMigracion: el almacen que dejo la via de WhatsApp Web se puede subir')
{
  const home = nueva()
  almacenViejo(home, { cuerpos: 3 })

  // Antes de migrar: se NIEGA. Eso no cambia y no tiene que cambiar — lo que cambia es
  // que ahora hay una salida.
  const antes = correrLectura(home, ['chats', '--json'])
  ok('sin migrar, el lector se niega con store-schema',
    (antes.stderr.trim().split('\n')[0] || '') === 'wa-read: store-schema', antes.stderr)

  const alm = abrirAlmacen(rutaAlmacen({ HOME: home }))
  ok('el escritor migra al abrir y dice que hizo', !!alm.migracion,
    JSON.stringify(alm.migracion))
  ok('desde la version 0 hasta la de hoy',
    alm.migracion?.desde === 0 && alm.migracion?.hasta === ESQUEMA_VERSION,
    JSON.stringify(alm.migracion))
  ok('con los cuerpos ajenos de la via muerta contados', alm.migracion?.cuerpos === 3,
    JSON.stringify(alm.migracion))
  ok('y las lineas de esa via tambien', alm.migracion?.lineas === 2,
    JSON.stringify(alm.migracion))

  const con = abrirLectura(home)
  ok('la cache de cuerpos de la via muerta ya no esta',
    !tablas(con).has('capturado'), JSON.stringify([...tablas(con)]))
  ok('no queda ni una linea de la via muerta',
    Number(con.prepare('select count(*) c from linea').get()?.c) === 0)
  ok('el almacen queda sellado en la version de hoy',
    String(con.prepare("select value from store_meta where key='schema_version'")
      .get()?.value) === String(ESQUEMA_VERSION))
  // El sello tambien va en `pragma user_version`: es lo que contesta un `sqlite3` a
  // mano, que es justo como se diagnostico este bloqueo.
  ok('y tambien se ve con un sqlite3 a mano, en pragma user_version',
    Number(con.prepare('pragma user_version').get()?.user_version) === ESQUEMA_VERSION)
  con.close()
  alm.cerrar()

  // Migrado, pero todavia sin linea de ESTE transporte: la negativa correcta ya no es
  // `store-schema` sino `no-transport`, que es la que manda a escanear el QR. Las dos
  // son negativas a proposito: lo que no puede pasar es una lista vacia (§11-E5).
  const sinLinea = correrLectura(home, ['chats', '--json'])
  ok('recien migrado, el lector manda a enlazar la linea y no a actualizar el plugin',
    (sinLinea.stderr.trim().split('\n')[0] || '') === 'wa-read: no-transport',
    sinLinea.stderr)

  // Y con la linea enlazada —lo que hace el sidecar al conectar— contesta limpio.
  const alm2 = abrirAlmacen(rutaAlmacen({ HOME: home }))
  ok('reabrir un almacen ya migrado no lo vuelve a migrar', alm2.migracion === null,
    JSON.stringify(alm2.migracion))
  alm2.registrarLinea({ cuenta: CUENTA, lid: MI_LID, pn: MI_TEL, nombre: 'Mi Linea' })
  alm2.cerrar()
  for (const cmd of ['chats', 'inbox', 'whoami', 'state']) {
    const r = leerJson(home, [cmd])
    ok(`con la linea enlazada, \`${cmd}\` sale 0 sobre el almacen migrado`,
      r.code === 0, `salio ${r.code}: ${r.stderr}`)
    ok(`y \`${cmd}\` devuelve una lista, no un error`, Array.isArray(r.filas), r.stdout)
  }
  const chats = leerJson(home, ['chats'])
  ok('y la lista de conversaciones nace vacia, no con las de la via muerta',
    chats.filas?.length === 0, chats.stdout)
}

console.log('\nMigracion: lo que se llevo se DICE, y por el camino que ve el panel')
{
  const home = nueva()
  almacenViejo(home, { cuerpos: 5 })
  abrirAlmacen(rutaAlmacen({ HOME: home })).cerrar()

  const doctor = leerJson(home, ['doctor'])
  const fila = (doctor.filas || []).find((f) => f.code === 'store-migrated')
  ok('la migracion trae su propio renglon en el doctor', !!fila,
    JSON.stringify(doctor.filas))
  // El renglon tiene que salir AUNQUE el almacen todavia no tenga linea enlazada: si
  // solo se viera con todo lo demas en verde, no se veria nunca en la maquina en la
  // que importa, que es justo la que acaba de migrar.
  const transporte = (doctor.filas || []).find((f) => f.code === 'no-transport')
  ok('y sale aunque el transporte todavia este en rojo',
    !!fila && transporte && transporte.ok === false, JSON.stringify(doctor.filas))
  // `checkSystem` arma la lista de opcionales del panel con
  // `requerido === false && !ok` (main.mjs): un renglon en `ok` no llega NUNCA a la
  // pantalla. Un aviso que solo se ve corriendo el CLI a mano no esta visible.
  ok('llega al panel: no bloquea, pero tampoco viene en ok',
    fila && fila.requerido === false && fila.ok === false, JSON.stringify(fila))
  ok('con el codigo que el panel traduce, no solo con la frase en ingles',
    fila && fila.detailCode === 'store-migrated-dropped', JSON.stringify(fila))
  ok('y el detalle dice cuantos cuerpos y cuantas lineas se fueron',
    /5/.test(fila?.detalle || '') && /2/.test(fila?.detalle || ''),
    String(fila?.detalle))
  ok('y que la via que los escribio ya no existe',
    /WhatsApp Web/.test(fila?.detalle || ''), String(fila?.detalle))
  // El doctor sigue saliendo 1 por el transporte que falta, no por la migracion.
  ok('la migracion no bloquea el doctor por si sola', doctor.code === 1,
    `salio ${doctor.code}`)
}

console.log('\nMigracion: un almacen ya al dia se deja quieto')
{
  const home = nueva()
  const alm = abrirAlmacen(rutaAlmacen({ HOME: home }))
  ok('una instalacion nueva no reporta ninguna migracion', alm.migracion === null,
    JSON.stringify(alm.migracion))
  alm.registrarLinea({ cuenta: CUENTA, lid: MI_LID, pn: MI_TEL, nombre: 'Mi Linea' })
  alm.anotarChat({ cuenta: CUENTA, chatJid: LAURA, nombre: 'Laura Mendez' })
  alm.guardarMensaje({ cuenta: CUENTA, chatJid: LAURA, stanzaId: 'YA1', ts: T0,
    fromMe: 0, senderJid: LAURA, senderName: 'Laura Mendez', body: 'hola',
    mediaTipo: null, mediaBytes: null, mencionaMe: 0, citaMe: 0 })
  alm.cerrar()

  const otra = abrirAlmacen(rutaAlmacen({ HOME: home }))
  ok('reabrirlo no dispara ninguna migracion', otra.migracion === null,
    JSON.stringify(otra.migracion))
  otra.cerrar()

  const con = abrirLectura(home)
  ok('y no anota ningun renglon de migracion',
    Number(con.prepare('select count(*) c from migracion').get()?.c) === 0)
  ok('el mensaje que ya estaba sigue ahi',
    Number(con.prepare('select count(*) c from mensaje').get()?.c) === 1)
  con.close()

  const doctor = leerJson(home, ['doctor'])
  ok('y el doctor no inventa un aviso de migracion',
    !(doctor.filas || []).some((f) => f.code === 'store-migrated'),
    JSON.stringify(doctor.filas))
}

console.log('\nMigracion: a medias no queda NUNCA — o migra entera, o no migra')
{
  const home = nueva()
  almacenViejo(home, { cuerpos: 4 })
  // Se fabrica un fallo A MITAD de la migracion: una `store_meta` con otra forma hace
  // reventar el sello de version DESPUES de que el borrado de la cache vieja ya corrio.
  // La causa da igual —un disco lleno o un apagon hacen lo mismo—: lo que se prueba es
  // que el archivo no pueda quedar en un estado que conteste datos incompletos.
  const roto = abrirLectura(home)
  roto.exec('create table store_meta (key text primary key)')
  roto.close()

  let reviento = false
  try {
    abrirAlmacen(rutaAlmacen({ HOME: home })).cerrar()
  } catch {
    reviento = true
  }
  ok('una migracion que no puede terminar falla en voz alta', reviento)

  const con = abrirLectura(home)
  ok('y no se llevo ni un cuerpo por delante',
    Number(con.prepare('select count(*) c from capturado').get()?.c) === 4)
  ok('ni una linea', Number(con.prepare('select count(*) c from linea').get()?.c) === 2)
  ok('y el almacen sigue sin sellar: nadie lo va a leer como si estuviera al dia',
    Number(con.prepare('pragma user_version').get()?.user_version) === 0)
  con.close()

  // Y el lector se sigue negando con el mismo motivo de antes: cerrado, no a medias.
  const r = correrLectura(home, ['chats', '--json'])
  ok('el lector se niega igual que antes, con store-schema',
    (r.stderr.trim().split('\n')[0] || '') === 'wa-read: store-schema', r.stderr)
  ok('y no escribe ni una fila en stdout', r.stdout.trim() === '', r.stdout)

  // Quitado el obstaculo, el siguiente arranque migra como si nada hubiera pasado: un
  // apagon a mitad no deja el almacen condenado.
  const limpio = abrirLectura(home)
  limpio.exec('drop table store_meta')
  limpio.close()
  const alm = abrirAlmacen(rutaAlmacen({ HOME: home }))
  ok('el arranque siguiente migra igual', alm.migracion?.cuerpos === 4,
    JSON.stringify(alm.migracion))
  alm.cerrar()
}

// ── F3/A2/A3: la lista de conversaciones que llega con la sincronizacion inicial ────
// El defecto medido en la cuenta viva: 296 filas en `chat` y NI UNA de
// `@s.whatsapp.net`. Sin una fila de contabilidad, un uno a uno no se puede ni ofrecer
// para autorizarlo — el dueno no puede elegir lo que el panel no lista (§11-F3).
console.log('\nHistorial: la sincronizacion inicial deja las conversaciones, sin un solo cuerpo')
{
  const home = nueva()
  const alm = abrirAlmacen(rutaAlmacen({ HOME: home }))
  alm.registrarLinea({ cuenta: CUENTA, lid: MI_LID, pn: MI_TEL, nombre: 'Mi Linea' })

  const GRUPO_H = '120363555444333222@g.us'
  const DIRECTO_H = '573007776655@s.whatsapp.net'
  const BOLETIN = '120363000000000999@newsletter'

  // El payload de `messaging-history.set` tal como lo arma Baileys 6.7.24
  // (lib/Utils/history.js:processHistoryMessage): `chats` son `proto.IConversation`, y
  // sus enteros de 64 bits llegan como Long -{low,high,unsigned}-, NO como number. Esa
  // es la forma real; un stub con numeros sueltos probaria el stub.
  const largo = (n) => ({ low: n, high: 0, unsigned: false })
  const historial = {
    isLatest: true,
    syncType: 3,
    contacts: [],
    // Mensajes DE VERDAD en el lote: es lo que el telefono manda junto con la lista, y
    // la prueba entera existe para comprobar que NO tocan el disco.
    messages: [
      { key: { remoteJid: DIRECTO_H, fromMe: false, id: 'H1' },
        messageTimestamp: largo(T0), message: { conversation: 'hola, quedamos asi' } },
      { key: { remoteJid: GRUPO_H, fromMe: false, id: 'H2', participant: OTRA_PERSONA },
        messageTimestamp: largo(T0 + 5), message: { conversation: 'listo el envio' } }
    ],
    chats: [
      { id: GRUPO_H, name: 'Proveedores Andes', unreadCount: 2,
        conversationTimestamp: largo(T0 + 5),
        messages: [{ message: { key: { id: 'H2' }, message: { conversation: 'listo el envio' } } }] },
      // El uno a uno: en el historial viene SIN `name` — el nombre visible esta en
      // `displayName`, que es lo que el telefono guarda de la agenda. Leer solo `name`
      // deja la fila con el jid por nombre y el buscador del panel sin nada que buscar.
      { id: DIRECTO_H, displayName: 'Camila Restrepo', unreadCount: 0,
        conversationTimestamp: largo(T0) },
      // §11-A2: lista de exclusion CERRADA. Un boletin no es una conversacion que
      // alguien pueda autorizar, y ofrecerlo es ruido en una lista de 296.
      { id: BOLETIN, name: 'Noticias', conversationTimestamp: largo(T0) }
    ]
  }

  const vistos = new Map()
  const r = ingerirChats({
    almacen: alm, cuenta: CUENTA, chats: historial.chats,
    recordarNombre: (jid, nombre) => vistos.set(jid, nombre)
  })
  ok('anota las conversaciones del historial', r.anotados === 2, JSON.stringify(r))
  ok('y descarta lo que no es una conversacion', r.omitidos === 1, JSON.stringify(r))
  alm.cerrar()

  const con = abrirLectura(home)
  const filas = con.prepare('select chat_jid, chat_name, is_group, unread, last_ts from chat order by chat_jid').all()
  const porJid = Object.fromEntries(filas.map((f) => [f.chat_jid, f]))

  ok('el grupo queda anotado', !!porJid[GRUPO_H], JSON.stringify(filas))
  // A3: `@g.us` = grupo. Lo demas NO lo es, y `is_group` mal puesto manda al agente a
  // tratar un uno a uno como un grupo (kind, menciones, §11-A4).
  ok('el grupo queda marcado como grupo', porJid[GRUPO_H]?.is_group === 1,
    JSON.stringify(porJid[GRUPO_H]))
  ok('el uno a uno TAMBIEN queda anotado — que es el defecto que esto arregla',
    !!porJid[DIRECTO_H], JSON.stringify(filas))
  ok('y NO queda marcado como grupo', porJid[DIRECTO_H]?.is_group === 0,
    JSON.stringify(porJid[DIRECTO_H]))
  ok('el uno a uno se anota con su nombre visible, no con el jid',
    porJid[DIRECTO_H]?.chat_name === 'Camila Restrepo', JSON.stringify(porJid[DIRECTO_H]))
  ok('el boletin no entra', !porJid[BOLETIN], JSON.stringify(filas))
  // El Long se convierte: sin eso `last_ts` queda en null y la lista del panel pierde
  // el orden por actividad, que es como se encuentra una conversacion.
  ok('la hora del ultimo mensaje sobrevive al entero de 64 bits',
    porJid[GRUPO_H]?.last_ts === T0 + 5, JSON.stringify(porJid[GRUPO_H]))
  ok('los no leidos tambien', porJid[GRUPO_H]?.unread === 2, JSON.stringify(porJid[GRUPO_H]))
  ok('el nombre queda tambien en la memoria del proceso',
    vistos.get(DIRECTO_H) === 'Camila Restrepo', JSON.stringify([...vistos]))

  // LO MAS IMPORTANTE: listar no es autorizar. Ninguna de las dos conversaciones esta
  // en el registro de alcance, asi que el lote trae cuerpos y NO puede quedar ni uno.
  const cuerpos = con.prepare('select count(*) c from mensaje').get()
  ok('ni un solo cuerpo guardado: listar una conversacion no la autoriza',
    cuerpos.c === 0, JSON.stringify(cuerpos))
  con.close()
}

almacen.cerrar()
for (const casa of casas) rmSync(casa, { recursive: true, force: true })

console.log(`\n${pruebas - fallos}/${pruebas} en verde`)
if (fallos) {
  console.error(`\n${fallos} fallas`)
  process.exit(1)
}
