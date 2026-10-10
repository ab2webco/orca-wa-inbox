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

import { identidadesPropias, identidadPropia } from '../sidecar/src/mensajes.js'
import { abrirAlmacen, ESQUEMA_VERSION, rutaAlmacen, rutaMedia } from '../sidecar/src/almacen.js'
import { reclaveDecididaDe } from '../sidecar/src/alcance.js'
import { ingerirActualizacion, ingerirCambioDeMiembros, ingerirChats, ingerirContactos,
  ingerirMensaje, ingerirMiembros, ingerirParesLid, nombreDeContacto } from '../sidecar/src/ingesta.js'

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

console.log('\nT9: cada numero, su linea — la linea activa no pisa a la otra')
{
  const home = nueva()
  const alm = abrirAlmacen(rutaAlmacen({ HOME: home }))
  ok('un almacen nuevo no tiene linea activa', alm.lineaActiva() === null,
    String(alm.lineaActiva()))
  const VIEJA = 'pn:573001112233'
  const NUEVA = 'pn:573000000012'
  const primera = alm.activarLinea(VIEJA)
  ok('activar la primera linea la deja activa', alm.lineaActiva() === VIEJA &&
    primera.cambio === true && primera.antes === null, JSON.stringify(primera))
  alm.registrarLinea({ cuenta: VIEJA, lid: '100000000000001@lid',
    pn: '573001112233:7@s.whatsapp.net', nombre: 'Vieja' })
  alm.anotarChat({ cuenta: VIEJA, chatJid: ALFA, nombre: 'Cliente Alfa', esGrupo: 1 })
  ok('activar la MISMA linea otra vez no es un cambio',
    alm.activarLinea(VIEJA).cambio === false)

  // Se vincula OTRO numero.
  const cambio = alm.activarLinea(NUEVA)
  ok('activar otra identidad cambia la linea activa', alm.lineaActiva() === NUEVA &&
    cambio.cambio === true && cambio.antes === VIEJA, JSON.stringify(cambio))
  alm.registrarLinea({ cuenta: NUEVA, lid: '100000000000002:1@lid',
    pn: '573000000012:7@s.whatsapp.net', nombre: 'Nueva' })
  alm.cerrar()

  const con = new DatabaseSync(rutaAlmacen({ HOME: home }))
  const lineas = con.prepare('select account, lid, name from linea order by account').all()
  ok('la fila de la linea vieja NO se piso: hay dos lineas', lineas.length === 2 &&
    lineas.some((l) => l.account === VIEJA && l.name === 'Vieja' &&
      l.lid === '100000000000001@lid'), JSON.stringify(lineas))
  const chatsNueva = con.prepare('select count(*) c from chat where account=?').get(NUEVA).c
  const chatsVieja = con.prepare('select count(*) c from chat where account=?').get(VIEJA).c
  ok('la linea nueva no hereda ninguna conversacion', chatsNueva === 0, String(chatsNueva))
  ok('y las de la vieja siguen ahi, sin borrar', chatsVieja === 1, String(chatsVieja))
  con.close()

  // T9b: los lectores miran SOLO la linea activa.
  const chatsActiva = leerJson(home, ['chats'])
  ok('con el numero nuevo vinculado, `wa-read chats` no muestra las del viejo',
    chatsActiva.code === 0 && Array.isArray(chatsActiva.filas) &&
    chatsActiva.filas.length === 0, chatsActiva.stdout + chatsActiva.stderr)
  const quien = leerJson(home, ['whoami'])
  ok('y `whoami` dice el numero nuevo, uno solo',
    (quien.filas || []).length === 1 && quien.filas[0].account === NUEVA,
    JSON.stringify(quien.filas))
  const estado = leerJson(home, ['state'])
  ok('y `state` mide la linea activa', (estado.filas || []).length === 1 &&
    estado.filas[0].account === NUEVA, JSON.stringify(estado.filas))
  const doc = leerJson(home, ['doctor'])
  const transporte = (doc.filas || []).find((f) => f.check === 'a message transport')
  ok('y el doctor habla de la linea activa, no de las dos',
    transporte && transporte.via === NUEVA && !/Vieja|573001112233/.test(transporte.detalle),
    JSON.stringify(transporte))
  // `--line` sigue pudiendo pedir otra a proposito: se nombra, no se hereda.
  const explicita = leerJson(home, ['chats', '--line', VIEJA])
  ok('pidiendo la vieja por nombre, sus conversaciones siguen ahi',
    (explicita.filas || []).length === 1, JSON.stringify(explicita.filas))

  // Vuelve el numero viejo: reaparece tal cual.
  const alm2 = abrirAlmacen(rutaAlmacen({ HOME: home }))
  const vuelta = alm2.activarLinea(VIEJA)
  ok('volver a vincular el numero viejo lo reactiva', vuelta.cambio === true &&
    alm2.lineaActiva() === VIEJA, JSON.stringify(vuelta))
  alm2.cerrar()
  const deVuelta = leerJson(home, ['chats'])
  ok('y sus conversaciones reaparecen tal cual', (deVuelta.filas || []).length === 1 &&
    deVuelta.filas[0].jid === ALFA, JSON.stringify(deVuelta.filas))
}

console.log('\nL1: varias lineas a la vez — el conjunto de lineas activas')
{
  // Con varias lineas vinculadas, cada sidecar anota la suya. Solo la principal decide
  // `linea_activa` (la que leen los CLI sin `--line`); las demas se SUMAN al conjunto sin
  // tocarla. Desvincular una la saca del conjunto, y nunca deja a los lectores sin linea.
  const home = nueva()
  const alm = abrirAlmacen(rutaAlmacen({ HOME: home }))
  const A = 'pn:573000000001'
  const B = 'pn:573000000002'
  const C = 'pn:573000000011'
  ok('un almacen nuevo no tiene lineas activas', JSON.stringify(alm.lineasActivas()) === '[]',
    JSON.stringify(alm.lineasActivas()))
  alm.activarLinea(A)
  ok('la principal entra al conjunto al activarse',
    JSON.stringify(alm.lineasActivas()) === JSON.stringify([A]), JSON.stringify(alm.lineasActivas()))
  const sumada = alm.sumarLinea(B)
  ok('una segunda linea se suma sin quitarle la principal a la primera',
    JSON.stringify(alm.lineasActivas()) === JSON.stringify([A, B]) && alm.lineaActiva() === A &&
    sumada.nueva === true, JSON.stringify({ l: alm.lineasActivas(), a: alm.lineaActiva(), sumada }))
  ok('sumar la misma linea otra vez no es nueva', alm.sumarLinea(B).nueva === false)
  ok('reactivar la principal no cambia nada',
    alm.activarLinea(A).cambio === false &&
    JSON.stringify(alm.lineasActivas()) === JSON.stringify([A, B]))
  // La principal se vuelve a vincular con OTRO numero: es el mismo lugar, otro numero.
  const otra = alm.activarLinea(C)
  ok('la principal con otro numero reemplaza a la vieja en su lugar',
    otra.cambio === true && alm.lineaActiva() === C &&
    JSON.stringify(alm.lineasActivas()) === JSON.stringify([C, B]),
    JSON.stringify({ otra, l: alm.lineasActivas() }))
  // Una secundaria que se re-vincula con otro numero dice cual era.
  alm.sumarLinea(A, { antes: B })
  ok('una secundaria con otro numero reemplaza a la suya, no a la principal',
    JSON.stringify(alm.lineasActivas()) === JSON.stringify([C, A]) && alm.lineaActiva() === C,
    JSON.stringify(alm.lineasActivas()))
  const sinC = alm.retirarLinea(C)
  ok('desvincular la principal pasa la principal a la que queda',
    sinC.retirada === true && alm.lineaActiva() === A &&
    JSON.stringify(alm.lineasActivas()) === JSON.stringify([A]),
    JSON.stringify({ sinC, a: alm.lineaActiva(), l: alm.lineasActivas() }))
  alm.retirarLinea(A)
  ok('desvincular la ultima deja el conjunto vacio y la principal anotada: un lector sin ' +
    'linea leeria TODAS', JSON.stringify(alm.lineasActivas()) === '[]' && alm.lineaActiva() === A,
    JSON.stringify({ a: alm.lineaActiva(), l: alm.lineasActivas() }))
  ok('retirar una linea que no esta no es un error', alm.retirarLinea(B).retirada === false)
  alm.cerrar()

  // Un almacen de antes de esto solo tiene `linea_activa`: el conjunto es esa linea.
  const vieja = nueva()
  const alm2 = abrirAlmacen(rutaAlmacen({ HOME: vieja }))
  alm2.con.prepare("insert into store_meta (key,value) values ('linea_activa', ?)").run(A)
  ok('sin el conjunto anotado, las activas son la principal de siempre',
    JSON.stringify(alm2.lineasActivas()) === JSON.stringify([A]), JSON.stringify(alm2.lineasActivas()))
  alm2.cerrar()
}

console.log('\nT9f: lo de `local` pasa al numero de su linea — explicito, atomico y visible')
{
  const home = nueva()
  const alm = abrirAlmacen(rutaAlmacen({ HOME: home }))
  // Una maquina de antes de T9: todo cuelga de `local`, y la fila de `linea` dice que
  // telefono era.
  alm.registrarLinea({ cuenta: 'local', lid: '100000000000001@lid',
    pn: '573001112233:7@s.whatsapp.net', nombre: 'Vieja' })
  alm.anotarChat({ cuenta: 'local', chatJid: ALFA, nombre: 'Cliente Alfa', esGrupo: 1 })
  alm.anotarChat({ cuenta: 'local', chatJid: CALLADO, nombre: 'Grupo Callado', esGrupo: 1 })
  alm.guardarMensaje({ cuenta: 'local', chatJid: ALFA, stanzaId: 'L1', ts: T0, fromMe: 0,
    senderJid: OTRA_PERSONA, senderName: 'Otra', body: 'hola de antes', mediaTipo: null,
    mediaBytes: null, mencionaMe: 0, citaMe: 0 })
  // Lo que ya escribio el sidecar nuevo para ese mismo numero: el grupo Alfa repetido.
  alm.anotarChat({ cuenta: 'pn:573001112233', chatJid: ALFA, nombre: 'Cliente Alfa', esGrupo: 1 })
  alm.cerrar()

  // Abrir el almacen NO re-clava nada: la migracion no corre sola al arrancar hasta que
  // se reparen los datos vivos (ver T9f en odd/tasks/linea-muerta.md).
  const abierto = abrirAlmacen(rutaAlmacen({ HOME: home }))
  abierto.cerrar()
  const antes = new DatabaseSync(rutaAlmacen({ HOME: home }))
  const quedanLocal = antes.prepare("select count(*) c from chat where account='local'").get().c
  antes.close()
  ok('abrir el almacen no mueve nada de `local`', quedanLocal === 2, String(quedanLocal))

  const alm2 = abrirAlmacen(rutaAlmacen({ HOME: home }))
  const r = alm2.reclavarLocal()
  ok('la re-clave dice adonde fue: al numero de la fila `local` de `linea`',
    r && r.desde === 'local' && r.hacia === 'pn:573001112233', JSON.stringify(r))
  ok('y cuanto movio', r && r.chats === 2 && r.mensajes === 1, JSON.stringify(r))
  ok('correrla de nuevo no hace nada: ya no hay `local`', alm2.reclavarLocal() === null)
  alm2.cerrar()

  const con = new DatabaseSync(rutaAlmacen({ HOME: home }))
  const local = con.prepare("select (select count(*) from chat where account='local') + " +
    "(select count(*) from mensaje where account='local') + " +
    "(select count(*) from linea where account='local') c").get().c
  ok('no queda ninguna fila `local`', local === 0, String(local))
  const chats = con.prepare("select count(*) c from chat where account='pn:573001112233'").get().c
  ok('las dos conversaciones son del numero, sin duplicar la que ya estaba', chats === 2,
    String(chats))
  const msj = con.prepare("select body from mensaje where account='pn:573001112233' and stanza_id='L1'").get()
  ok('el mensaje viejo sigue entero, ahora en su numero', msj && msj.body === 'hola de antes',
    JSON.stringify(msj))
  const linea = con.prepare("select account, lid, name from linea").all()
  ok('la fila de linea paso al numero y conserva quien era', linea.length === 1 &&
    linea[0].account === 'pn:573001112233' && linea[0].name === 'Vieja', JSON.stringify(linea))
  const anotada = con.prepare('select desde, hacia, chats, mensajes from reclave').all()
  ok('y quedo escrita, para que se pueda mirar', anotada.length === 1 &&
    anotada[0].hacia === 'pn:573001112233', JSON.stringify(anotada))
  con.close()

  const doc = leerJson(home, ['doctor'])
  const fila = (doc.filas || []).find((f) => f.code === 'store-rekeyed')
  ok('el doctor la cuenta en su propio renglon', fila && fila.requerido === false &&
    fila.ok === false && fila.detailCode === 'store-rekeyed-line' &&
    fila.detalle.includes('573001112233'), JSON.stringify(doc.filas))

  // Sin telefono en la fila `local` no hay a quien atribuirle nada: se deja como esta.
  const home2 = nueva()
  const alm3 = abrirAlmacen(rutaAlmacen({ HOME: home2 }))
  alm3.registrarLinea({ cuenta: 'local', lid: '1@lid' })
  alm3.anotarChat({ cuenta: 'local', chatJid: ALFA, nombre: 'Cliente Alfa', esGrupo: 1 })
  ok('sin telefono conocido no se inventa un numero', alm3.reclavarLocal() === null)
  alm3.cerrar()
}

console.log('\nT9f: la decision del dueno llega al sidecar por `wa-scope config`')
{
  // `wa-scope reclave --numero` la anota en los ajustes; el sidecar la lee con los topes.
  ok('lee la cuenta decidida', reclaveDecididaDe([{ key: 'capture_max', value: '5' },
    { key: 'reclave_local_a', value: 'pn:573000000011' }]) === 'pn:573000000011')
  ok('sin decision no hay cuenta', reclaveDecididaDe([{ key: 'capture_max', value: '5' }]) === null)
  ok('y algo que no es una cuenta de telefono se ignora',
    reclaveDecididaDe([{ key: 'reclave_local_a', value: 'local' }]) === null &&
    reclaveDecididaDe('basura') === null)
}

console.log('\nT9f: la re-clave al arrancar solo con evidencia — si no, no mueve nada y pregunta')
{
  // Otros usuarios pueden estar como el dueno estuvo: la fila `local` de `linea` pisada
  // por OTRO numero. Re-clavar ahi le daria al numero nuevo lo del viejo. Se mueve solo
  // cuando hay evidencia de que la identidad de `local` es la que produjo los datos.
  const VIEJO_PN = '573000000011:7@s.whatsapp.net'
  const VIEJO_LID = '100000000000001:3@lid'
  const NUEVO_PN = '573000000012:7@s.whatsapp.net'
  const NUEVO_LID = '100000000000002:1@lid'
  const legado = (home, linea, remitente) => {
    const a = abrirAlmacen(rutaAlmacen({ HOME: home }))
    a.registrarLinea({ cuenta: 'local', ...linea, nombre: 'De antes' })
    a.anotarChat({ cuenta: 'local', chatJid: ALFA, nombre: 'Cliente Alfa', esGrupo: 1 })
    a.guardarMensaje({ cuenta: 'local', chatJid: ALFA, stanzaId: 'P1', ts: T0, fromMe: 1,
      senderJid: remitente, senderName: null, body: 'lo mande yo', mediaTipo: null,
      mediaBytes: null, mencionaMe: 0, citaMe: 0 })
    // Un directo propio: su remitente es null y no prueba nada en ningun sentido.
    a.guardarMensaje({ cuenta: 'local', chatJid: LAURA, stanzaId: 'P2', ts: T0, fromMe: 1,
      senderJid: null, senderName: null, body: 'directo', mediaTipo: null,
      mediaBytes: null, mencionaMe: 0, citaMe: 0 })
    return a
  }
  const locales = (home) => {
    const c = new DatabaseSync(rutaAlmacen({ HOME: home }))
    const n = c.prepare("select (select count(*) from chat where account='local') + " +
      "(select count(*) from mensaje where account='local') c").get().c
    c.close()
    return n
  }

  // 1. Actualizacion limpia: la fila `local` es del numero emparejado y lo que mando
  //    desde los grupos lo firmo esa misma identidad.
  const limpia = nueva()
  const a1 = legado(limpia, { lid: VIEJO_LID, pn: VIEJO_PN }, '100000000000001@lid')
  const r1 = a1.resolverLocal({ emparejada: 'pn:573000000011' })
  a1.cerrar()
  ok('actualizacion limpia: se re-clava sola', r1.accion === 'movida' &&
    r1.hacia === 'pn:573000000011', JSON.stringify(r1))
  ok('y no queda nada en `local`', locales(limpia) === 0, String(locales(limpia)))

  // 2. Cambio de numero: la fila `local` dice el numero nuevo (se piso), pero lo que se
  //    mando desde los grupos lo firmo OTRA identidad. No se toca nada.
  const cambiada = nueva()
  const a2 = legado(cambiada, { lid: NUEVO_LID, pn: NUEVO_PN }, '100000000000001@lid')
  const r2 = a2.resolverLocal({ emparejada: 'pn:573000000012' })
  a2.cerrar()
  ok('numero cambiado: no se re-clava', r2.accion === 'bloqueada', JSON.stringify(r2))
  ok('y todo sigue en `local`, sin borrar', locales(cambiada) === 3, String(locales(cambiada)))
  const doc = leerJson(cambiada, ['doctor'])
  const pendiente = (doc.filas || []).find((f) => f.code === 'store-rekey-pending')
  ok('el doctor pide la decision, con el comando exacto', pendiente &&
    pendiente.requerido === false && pendiente.ok === false &&
    pendiente.detailCode === 'store-rekey-decide' &&
    /wa-scope reclave --numero/.test(pendiente.detalle), JSON.stringify(doc.filas))
  ok('y no anuncia una re-clave que no paso',
    !(doc.filas || []).some((f) => f.code === 'store-rekeyed'), JSON.stringify(doc.filas))

  // Tambien bloquea si la fila `local` es de un numero que no es el emparejado.
  const otro = nueva()
  const a3 = legado(otro, { lid: VIEJO_LID, pn: VIEJO_PN }, '100000000000001@lid')
  const r3 = a3.resolverLocal({ emparejada: 'pn:573000000012' })
  a3.cerrar()
  ok('si el emparejado es otro numero, tampoco', r3.accion === 'bloqueada', JSON.stringify(r3))

  // La decision del dueno destraba: dice de que numero son, y ahi si se mueven.
  const a4 = abrirAlmacen(rutaAlmacen({ HOME: cambiada }))
  const r4 = a4.resolverLocal({ emparejada: 'pn:573000000012', decidida: 'pn:573000000011' })
  a4.cerrar()
  ok('con la decision del dueno se mueven al numero que el dijo',
    r4.accion === 'movida' && r4.hacia === 'pn:573000000011' && locales(cambiada) === 0,
    JSON.stringify(r4))
  const doc2 = leerJson(cambiada, ['doctor'])
  ok('y el pedido de decision desaparece del doctor',
    !(doc2.filas || []).some((f) => f.code === 'store-rekey-pending'), JSON.stringify(doc2.filas))

  // 3. Ya re-clavado (o nunca hubo `local`): no hace nada.
  const a5 = abrirAlmacen(rutaAlmacen({ HOME: limpia }))
  const r5 = a5.resolverLocal({ emparejada: 'pn:573000000011' })
  a5.cerrar()
  ok('sin nada en `local`, no hace nada', r5.accion === 'nada', JSON.stringify(r5))

  // Emparejando (todavia sin numero), espera: no decide a ciegas.
  const espera = nueva()
  const a6 = legado(espera, { lid: VIEJO_LID, pn: VIEJO_PN }, '100000000000001@lid')
  const r6 = a6.resolverLocal({ emparejada: null })
  a6.cerrar()
  ok('sin numero emparejado todavia, espera', r6.accion === 'esperar' &&
    locales(espera) === 3, JSON.stringify(r6))
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

console.log('\nCaso 5 (§11-D1): haber escrito NO es haber atendido')
{
  const antes = leerJson(home, ['inbox', '--days', '36500'])
  ok('antes de contestar, la mencion esta',
    (antes.filas || []).some((f) => f.stanza_id === 'M1'))

  // El propietario contesta en ese chat, despues de todo lo anterior.
  await ingerir(mensaje({ chat: ALFA, id: 'MIO1', ts: T0 + 900, mio: true,
    texto: 'lo reviso y le cuento' }))

  const despues = leerJson(home, ['inbox', '--days', '36500'])
  const quedan = (despues.filas || []).filter((f) => f.chat_jid === ALFA)
  // ANTES esto afirmaba que la bandeja del chat quedaba en cero. Se quito a proposito:
  // haber escrito no es haber atendido. Medido en la cuenta del dueno, tres mensajes
  // suyos que no contestaban nada borraron dos menciones directas sin responder, y la
  // automatizacion informo cero pendientes con la pregunta ahi delante.
  //
  // Lo que se sabia no se perdio: se ACOMPANA la fila en vez de esconderla, y el
  // agente decide. Informar en vez de esconder es la misma regla que el resto del
  // plugin: una lista vacia tiene que significar que no hay nada, no que no se miro.
  ok('lo anterior sigue en la bandeja: escribir no es atender', quedan.length > 0,
    JSON.stringify(quedan.map((f) => f.stanza_id)))
  ok('pero cada fila dice que el dueno escribio despues',
    quedan.every((f) => f.escribio_despues === true),
    JSON.stringify(quedan.map((f) => [f.stanza_id, f.escribio_despues])))
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

// ── El doctor exige que la linea este VIVA, no solo que exista ──────────────────────
// Medido en la maquina del dueno (2026-10-01): el doctor daba el transporte por bueno
// porque habia una fila en `linea`, con el sidecar muerto desde el dia anterior. Una
// fila en `linea` dice que alguna vez hubo una linea; el latido dice que hay alguien
// del otro lado AHORA. Es la misma regla que ya usaba `wa-send` (`sidecar_vivo`).
console.log('\nel doctor: el transporte exige latido fresco')
{
  const viejoMs = Date.now() - 10 * 60 * 1000
  almacen.latir(viejoMs)
  const doctor = leerJson(home, ['doctor'])
  const fila = (doctor.filas || []).find((f) => f.check === 'a message transport')
  ok('con el latido viejo, el transporte NO esta en verde', fila && fila.ok === false,
    JSON.stringify(fila))
  ok('con un codigo propio, que el panel traduce', fila && fila.code === 'transport-silent',
    JSON.stringify(fila))
  ok('y bloquea, como cualquier transporte que no lee', fila && fila.requerido === true &&
    doctor.code === 1, `salio ${doctor.code} ${JSON.stringify(fila)}`)
  const hora = new Date(viejoMs).toTimeString().slice(0, 5)
  ok('el detalle dice desde cuando', (fila?.detalle || '').includes(hora),
    `${fila?.detalle} / ${hora}`)

  // Control: el mismo almacen con latido de ahora vuelve a verde. Sin esto, la regla de
  // arriba se cumpliria con un doctor que no da el transporte por bueno nunca.
  almacen.latir()
  const vivo = leerJson(home, ['doctor'])
  const filaViva = (vivo.filas || []).find((f) => f.check === 'a message transport')
  ok('control: con latido de ahora el transporte vuelve a verde',
    filaViva && filaViva.ok === true && vivo.code === 0, JSON.stringify(filaViva))
}

// ── T16c: la alarma de "linea muda" no salta durante un reinicio normal ────────────
// Visto en vivo (2026-10-01): el sync de 5 minutos corrio mientras el boton "Traer
// conversaciones" reiniciaba el sidecar y el doctor dijo "ninguna senal de vida desde
// las 12:20" sobre una linea que estaba recibiendo. Un sidecar que reinicia deja de
// latir lo que tarda en arrancar —cargar Baileys, preguntar la version, abrir el
// almacen—, y 15 s (el plazo de `wa-send`, que es un proceso que espera un veredicto) es
// demasiado corto para eso. El DIAGNOSTICO del doctor tiene su propio plazo.
console.log('\nT16c: el doctor no da la linea por muda durante un reinicio')
{
  const ahora = Date.now()
  const transporte = () => (leerJson(home, ['doctor']).filas || [])
    .find((f) => f.check === 'a message transport')

  almacen.latir(ahora - 45 * 1000)
  const reiniciando = transporte()
  ok('con 45 s sin latir (un reinicio) el transporte sigue en verde',
    reiniciando && reiniciando.ok === true, JSON.stringify(reiniciando))

  const limiteMs = ahora - 100 * 1000
  almacen.latir(limiteMs)
  const lento = transporte()
  ok('y con 100 s todavia, un arranque lento', lento && lento.ok === true,
    JSON.stringify(lento))

  const muerto = ahora - 4 * 60 * 1000
  almacen.latir(muerto)
  const mudo = transporte()
  ok('con 4 minutos sin latir si es una linea muda', mudo && mudo.ok === false &&
    mudo.code === 'transport-silent', JSON.stringify(mudo))
  const horaReal = new Date(muerto).toTimeString().slice(0, 5)
  ok('y el "desde" es el ultimo latido de verdad', (mudo?.detalle || '').includes(
    `since ${new Date(muerto).getFullYear()}-`) && (mudo?.detalle || '').includes(horaReal),
    String(mudo?.detalle))

  // `wa-send` NO cambia: un envio que espera un veredicto no puede esperar dos minutos
  // a saber que no hay nadie. El plazo del doctor y el de wa-send son dos preguntas.
  almacen.latir(ahora - 45 * 1000)
  const r = spawnSync('python3', ['-c',
    'import sys; sys.path.insert(0, sys.argv[1]); import wa_store; ' +
    'con = wa_store.abrir(); print(wa_store.sidecar_vivo(con))', join(RAIZ, 'bin')],
  { env: { ...process.env, HOME: home, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' })
  ok('con 45 s sin latir, `sidecar_vivo` (la regla de wa-send) sigue diciendo que no',
    r.stdout.trim() === 'False', `${r.stdout} ${r.stderr}`)
  almacen.latir()
}

// ── linea-viva V8: el latido es de CADA linea, no del almacen ───────────────────────
// Visto en vivo (2026-10-09): con dos lineas, `sidecar_beat` es UNA llave que escriben
// los dos sidecars cada segundo. Una linea caida, desvinculada o reconectando parecia
// viva porque la otra mantenia fresco el latido: `wa-send` contestaba "se vencio el
// plazo" en vez de "no hay transporte", y el doctor y el tick la daban por buena.
console.log('\nlinea-viva V8: el latido y la conexion de cada linea')
{
  const A = 'pn:15550000001'
  const B = 'pn:15550000002'
  const casa = nueva()
  const alm = abrirAlmacen(rutaAlmacen({ HOME: casa }))
  alm.registrarLinea({ cuenta: A, pn: '15550000001@s.whatsapp.net', nombre: 'Linea A' })
  alm.registrarLinea({ cuenta: B, pn: '15550000002@s.whatsapp.net', nombre: 'Linea B' })
  alm.activarLinea(A)
  alm.sumarLinea(B)
  const meta = (llave) => alm.con.prepare('select value from store_meta where key=?')
    .get(llave)?.value
  // Lo que contesta `wa_store` en un proceso aparte, como lo llaman wa-send y el tick.
  const pregunta = (home, expresion) => {
    const r = spawnSync('python3', ['-c',
      'import sys; sys.path.insert(0, sys.argv[1]); import wa_store; ' +
      `con = wa_store.abrir(); print(${expresion})`, join(RAIZ, 'bin')],
    { env: { ...process.env, HOME: home, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' })
    return `${r.stdout.trim()}${r.stderr.trim() ? ` ${r.stderr.trim()}` : ''}`
  }
  const ahora = Date.now()

  alm.latir(ahora, { cuenta: A, conectado: true })
  ok('cada sidecar anota el latido de SU linea',
    meta(`sidecar_beat@${A}`) === String(Math.floor(ahora / 1000)), meta(`sidecar_beat@${A}`))
  ok('y si su linea esta conectada', meta(`sidecar_conectado@${A}`) === '1',
    meta(`sidecar_conectado@${A}`))
  ok('y sigue anotando el latido de siempre, para los lectores de antes',
    meta('sidecar_beat') === String(Math.floor(ahora / 1000)), meta('sidecar_beat'))

  // B dejo de latir hace 4 minutos; A sigue latiendo, y con eso la llave global.
  alm.latir(ahora - 4 * 60 * 1000, { cuenta: B, conectado: true })
  alm.latir(ahora, { cuenta: A, conectado: true })
  ok('B sin latir NO esta viva aunque A mantenga fresco el latido global',
    pregunta(casa, `wa_store.sidecar_vivo(con, ${JSON.stringify(B)})`) === 'False',
    pregunta(casa, `wa_store.sidecar_vivo(con, ${JSON.stringify(B)})`))
  ok('y esta muda para el doctor',
    pregunta(casa, `wa_store.sidecar_mudo(con, ${JSON.stringify(B)})`) === 'True',
    pregunta(casa, `wa_store.sidecar_mudo(con, ${JSON.stringify(B)})`))
  ok('A no se entera: sigue viva',
    pregunta(casa, `wa_store.sidecar_vivo(con, ${JSON.stringify(A)})`) === 'True',
    pregunta(casa, `wa_store.sidecar_vivo(con, ${JSON.stringify(A)})`))
  ok('sin linea, la pregunta de siempre (el latido global) no cambia',
    pregunta(casa, 'wa_store.sidecar_vivo(con)') === 'True',
    pregunta(casa, 'wa_store.sidecar_vivo(con)'))

  // El doctor: el renglon del transporte conserva su forma y su verde (A lee), y dice
  // cual linea esta muda, con el detalle por linea.
  const doctor = leerJson(casa, ['doctor'])
  const fila = (doctor.filas || []).find((f) => f.check === 'a message transport')
  ok('el doctor sigue en verde mientras alguna linea lee',
    fila && fila.ok === true && fila.code === 'no-transport', JSON.stringify(fila))
  const porLinea = Object.fromEntries((fila?.lineas || []).map((l) => [l.account, l]))
  ok('y trae el detalle de cada linea: B muda',
    porLinea[B]?.ok === false && porLinea[B]?.code === 'transport-silent',
    JSON.stringify(fila?.lineas))
  ok('A viva', porLinea[A]?.ok === true, JSON.stringify(fila?.lineas))
  ok('el texto nombra la linea muda', (fila?.detalle || '').includes(B), fila?.detalle)

  // B late pero su socket esta caido (reconectando, o desvinculada): no hay quien mande.
  alm.latir(ahora, { cuenta: B, conectado: false })
  ok('B latiendo pero desconectada NO esta viva para mandar',
    pregunta(casa, `wa_store.sidecar_vivo(con, ${JSON.stringify(B)})`) === 'False',
    pregunta(casa, `wa_store.sidecar_vivo(con, ${JSON.stringify(B)})`))
  ok('pero no esta muda: el proceso corre, es un reinicio de la conexion',
    pregunta(casa, `wa_store.sidecar_mudo(con, ${JSON.stringify(B)})`) === 'False',
    pregunta(casa, `wa_store.sidecar_mudo(con, ${JSON.stringify(B)})`))
  alm.latir(ahora, { cuenta: B, conectado: true })
  ok('control: B conectada y latiendo vuelve a estar viva',
    pregunta(casa, `wa_store.sidecar_vivo(con, ${JSON.stringify(B)})`) === 'True',
    pregunta(casa, `wa_store.sidecar_vivo(con, ${JSON.stringify(B)})`))
  alm.cerrar()

  // Una linea cuyo sidecar no arranco nunca desde que los sidecars anotan por linea:
  // su ausencia es "no late", no "pregunta al latido global", que es de la otra.
  const casaC = nueva()
  const almC = abrirAlmacen(rutaAlmacen({ HOME: casaC }))
  almC.registrarLinea({ cuenta: A, pn: '15550000001@s.whatsapp.net', nombre: 'Linea A' })
  almC.activarLinea(A)
  almC.sumarLinea(B)
  almC.latir(Date.now(), { cuenta: A, conectado: true })
  ok('una linea sin latido propio, con otra que si lo anota, no esta viva',
    pregunta(casaC, `wa_store.sidecar_vivo(con, ${JSON.stringify(B)})`) === 'False',
    pregunta(casaC, `wa_store.sidecar_vivo(con, ${JSON.stringify(B)})`))
  ok('y nunca latio', pregunta(casaC, `wa_store.ultimo_latido(con, ${JSON.stringify(B)})`) ===
    'None', pregunta(casaC, `wa_store.ultimo_latido(con, ${JSON.stringify(B)})`))
  almC.cerrar()

  // El sidecar de antes: solo la llave global. Una linea sola se comporta como siempre.
  const casaV = nueva()
  const almV = abrirAlmacen(rutaAlmacen({ HOME: casaV }))
  almV.registrarLinea({ cuenta: A, pn: '15550000001@s.whatsapp.net', nombre: 'Linea A' })
  almV.activarLinea(A)
  almV.latir()
  ok('sidecar de antes (solo la llave global): la linea sigue viva',
    pregunta(casaV, `wa_store.sidecar_vivo(con, ${JSON.stringify(A)})`) === 'True',
    pregunta(casaV, `wa_store.sidecar_vivo(con, ${JSON.stringify(A)})`))
  almV.latir(Date.now() - 4 * 60 * 1000)
  ok('y con el latido global viejo, muerta, como siempre',
    pregunta(casaV, `wa_store.sidecar_vivo(con, ${JSON.stringify(A)})`) === 'False' &&
    pregunta(casaV, `wa_store.sidecar_mudo(con, ${JSON.stringify(A)})`) === 'True',
    pregunta(casaV, `wa_store.sidecar_mudo(con, ${JSON.stringify(A)})`))
  almV.cerrar()
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
  // El sidecar late en el almacen cada segundo mientras vive (`latir`). Este es el caso
  // de una linea viva: latido de ahora.
  almacen.latir()
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
  lineas = ['web', 'web:100000000000001'] } = {}) {
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

console.log('\nT10: el aviso de la migracion dura una semana y no dice que borro lo que no borro')
{
  // Visto en vivo: "Almacen de mensajes actualizado — ... se borro" una semana despues,
  // con `cuerpos=0`. No se habia borrado ningun mensaje.
  const home = nueva()
  almacenViejo(home, { cuerpos: 0 })
  abrirAlmacen(rutaAlmacen({ HOME: home })).cerrar()
  const doctor = leerJson(home, ['doctor'])
  const fila = (doctor.filas || []).find((f) => f.code === 'store-migrated')
  ok('sin cuerpos borrados, el renglon no habla de borrar mensajes',
    fila && fila.detailCode === 'store-migrated-clean' && !/dropped/i.test(fila.detalle),
    JSON.stringify(fila))

  // La misma migracion, ocho dias despues: ya no se avisa.
  const con = new DatabaseSync(rutaAlmacen({ HOME: home }))
  con.prepare('update migracion set at = ?').run(Math.floor(Date.now() / 1000) - 8 * 86400)
  con.close()
  const despues = leerJson(home, ['doctor'])
  ok('pasada una semana el aviso ya no sale',
    !(despues.filas || []).some((f) => f.code === 'store-migrated'),
    JSON.stringify(despues.filas))
}

console.log('\nT10: el chat propio de la linea se reconoce, no se muestra como un jid')
{
  // El "mensaje a uno mismo" de la linea aparece en la lista con el jid pelado
  // (`<lid>@lid`). Su jid es el LID o el telefono de la linea, sin el dispositivo.
  const home = nueva()
  const alm = abrirAlmacen(rutaAlmacen({ HOME: home }))
  const CUENTA_T10 = 'pn:573000000012'
  alm.activarLinea(CUENTA_T10)
  alm.registrarLinea({ cuenta: CUENTA_T10, lid: '100000000000002:1@lid',
    pn: '573000000012:7@s.whatsapp.net', nombre: 'Nueva' })
  alm.anotarChat({ cuenta: CUENTA_T10, chatJid: '100000000000002@lid',
    nombre: '100000000000002@lid', esGrupo: 0, ts: Math.floor(Date.now() / 1000) - 1 })
  alm.anotarChat({ cuenta: CUENTA_T10, chatJid: '573000000012@s.whatsapp.net', nombre: '',
    esGrupo: 0, ts: Math.floor(Date.now() / 1000) - 2 })
  alm.anotarChat({ cuenta: CUENTA_T10, chatJid: LAURA, nombre: 'Laura Mendez', esGrupo: 0,
    ts: Math.floor(Date.now() / 1000) })
  alm.cerrar()
  const r = leerJson(home, ['chats'])
  const porJid = Object.fromEntries((r.filas || []).map((c) => [c.jid, c]))
  ok('el chat propio por LID se marca como propio',
    porJid['100000000000002@lid']?.own === true, JSON.stringify(porJid['100000000000002@lid']))
  ok('y por telefono tambien', porJid['573000000012@s.whatsapp.net']?.own === true,
    JSON.stringify(porJid['573000000012@s.whatsapp.net']))
  ok('y se llama como la linea, no como su jid',
    porJid['100000000000002@lid']?.name === 'Nueva', JSON.stringify(porJid['100000000000002@lid']))
  ok('un chat ajeno no se marca', porJid[LAURA] && !porJid[LAURA].own,
    JSON.stringify(porJid[LAURA]))
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

// ── La ventana entre vincular la linea y saber el LID ───────────────────────────────
// Regresion de un defecto medido en una instalacion viva. `sock.user` no trae el LID
// cuando dispara `connection: 'open'`, asi que los mensajes que llegan en esos primeros
// segundos se ingieren con `menciona_me = 0` aunque nombren al dueno con todas las
// letras. Como no vuelven a pasar por la ingesta y `wa-read inbox` cruza contra esa
// columna, no salian NUNCA: bandeja vacia, `activity.pending` vacio, `wa-scope pending`
// contestando `hay_trabajo: false` y la automatizacion saltandose todo.
console.log('\nalmacen: reparar las menciones que se guardaron antes de saber el LID')
{
  const casa = nueva()
  const alm = abrirAlmacen(rutaAlmacen({ HOME: casa }))
  const usuario = MI_LID.split('@')[0]
  const grupo = '120363000000000001@g.us'
  const fila = (stanzaId, body, extra = {}) => ({
    cuenta: CUENTA, chatJid: grupo, stanzaId, ts: 1700000000, fromMe: 0,
    senderJid: '573009998877@s.whatsapp.net', senderName: 'Pedro', body,
    mediaTipo: null, mediaBytes: null, mencionaMe: 0, citaMe: 0, ...extra
  })

  // Lo que de verdad paso: se vincula, llega la mencion, y el LID todavia no se sabe.
  alm.registrarLinea({ cuenta: CUENTA, pn: MI_TEL, grupos: 296 })
  alm.guardarMensaje(fila('A1', `@${usuario} Como vas?`))
  alm.guardarMensaje(fila('A2', `@${usuario} ya hiciste las tareas`))
  // Ruido que NO se puede marcar: otra persona, y un LID que empieza igual.
  alm.guardarMensaje(fila('B1', '@573001234567 nada que ver'))
  alm.guardarMensaje(fila('B2', `@${usuario}99 ese es otro`))
  alm.guardarMensaje(fila('B3', 'sin mencion ninguna'))

  const antes = alm.con.prepare('select count(*) n from mensaje where menciona_me=1')
    .get().n
  ok('antes de saber el LID no hay ni una mencion reconocida', antes === 0, String(antes))

  const reparados = alm.repararMenciones({ cuenta: CUENTA, lid: MI_LID })
  ok('se reparan las dos que nombran al dueno, y solo esas', reparados === 2,
    String(reparados))
  const marcados = alm.con.prepare(
    'select stanza_id from mensaje where menciona_me=1 order by stanza_id')
    .all().map((f) => f.stanza_id).join(',')
  ok('y son las dos correctas', marcados === 'A1,A2', marcados)

  // Un LID que es PREFIJO de otro no puede arrastrar mensajes ajenos: sin el limite a
  // la derecha, `@199887766554433` marcaria tambien `@19988776655443399`.
  const b2 = alm.con.prepare("select menciona_me m from mensaje where stanza_id='B2'")
    .get().m
  ok('un LID mas largo que empieza igual NO se marca', b2 === 0, String(b2))

  ok('volver a repararlas no cambia nada',
    alm.repararMenciones({ cuenta: CUENTA, lid: MI_LID }) === 0)
  ok('un LID que no es un numero no toca nada',
    alm.repararMenciones({ cuenta: CUENTA, lid: null }) === 0)

  // `registrarLinea` la llaman dos sitios con mitades distintas: la identidad por un
  // lado y el conteo de grupos por otro. El que no trae un dato no puede borrarlo.
  alm.registrarLinea({ cuenta: CUENTA, lid: MI_LID, pn: MI_TEL, nombre: 'Mi Linea' })
  const linea = alm.con.prepare('select lid, pn, name, groups_n from linea where account=?')
    .get(CUENTA)
  ok('registrar la identidad NO borra el conteo de grupos', linea.groups_n === 296,
    JSON.stringify(linea))
  ok('y el LID queda guardado', linea.lid === MI_LID, JSON.stringify(linea))
  alm.registrarLinea({ cuenta: CUENTA, grupos: 300 })
  const linea2 = alm.con.prepare('select lid, name, groups_n from linea where account=?')
    .get(CUENTA)
  ok('registrar el conteo NO borra la identidad',
    linea2.lid === MI_LID && linea2.name === 'Mi Linea' && linea2.groups_n === 300,
    JSON.stringify(linea2))
  alm.cerrar()
}

// ── Las conversaciones DIRECTAS ────────────────────────────────────────────────────
// La queja medida: "no puedo meter conversaciones directas". No estaban bloqueadas —
// `config.html` no filtra por `@g.us` en ningun lado— sino que no llegaban a la lista,
// y las que llegaban venian sin nombre. En la cuenta del dueno: 296 grupos, 3 directas,
// y de esas tres una era el PROPIO dueno y otra se llamaba como su numero.
console.log('\ningesta: la libreta de nombres y los directos')
{
  const casa = nueva()
  const alm = abrirAlmacen(rutaAlmacen({ HOME: casa }))
  const YO_MISMO = identidadesPropias(MI_LID, MI_TEL)
  const esPropio = (jid) => YO_MISMO.has(identidadPropia(jid))
  const memoria = new Map()
  const recordarNombre = (jid, nombre) => memoria.set(jid, nombre)

  ok('el nombre verificado va primero',
    nombreDeContacto({ verifiedName: 'Ferreteria SAS', name: 'ferre', notify: 'x' }) ===
    'Ferreteria SAS')
  ok('despues la agenda del telefono',
    nombreDeContacto({ name: 'Laura Mendez', notify: 'lau' }) === 'Laura Mendez')
  ok('y de ultimo como se presenta quien escribe',
    nombreDeContacto({ notify: 'Pedro' }) === 'Pedro')
  ok('sin nada, cadena vacia — no se inventa un nombre',
    nombreDeContacto({}) === '' && nombreDeContacto(null) === '')

  // Llegan los chats ANTES que la libreta, que es el orden real de los eventos.
  const DIRECTO = '573000000013@s.whatsapp.net'
  ingerirChats({
    almacen: alm,
    cuenta: CUENTA,
    chats: [
      { id: DIRECTO, conversationTimestamp: 1700000000 },
      { id: MI_LID, conversationTimestamp: 1700000001 },
      { id: '120363000000000009@g.us', name: 'Grupo Real', conversationTimestamp: 1700000002 }
    ],
    esPropio,
    recordarNombre
  })

  const propias = alm.con.prepare('select count(*) n from chat where chat_jid = ?')
    .get(MI_LID).n
  ok('la conversacion del dueno consigo mismo NO entra en la lista', propias === 0,
    String(propias))

  const sinNombre = alm.con.prepare('select chat_name from chat where chat_jid = ?')
    .get(DIRECTO)
  ok('un directo sin libreta nace sin nombre de verdad',
    !sinNombre.chat_name || sinNombre.chat_name === DIRECTO,
    JSON.stringify(sinNombre))

  // Y ahora si llega la libreta.
  const { nombrados } = ingerirContactos({
    almacen: alm,
    cuenta: CUENTA,
    contactos: [
      { id: DIRECTO, name: 'Laura Mendez' },
      { id: MI_LID, name: 'Yo Mismo' },
      { id: '573009999999@s.whatsapp.net', name: 'Nunca Escribio' }
    ],
    esPropio,
    recordarNombre
  })
  ok('la libreta nombra el directo que ya existia', nombrados === 1, String(nombrados))
  ok('y queda guardado',
    alm.con.prepare('select chat_name from chat where chat_jid=?').get(DIRECTO)
      .chat_name === 'Laura Mendez')
  ok('el propio dueno tampoco se nombra: no esta ni tiene por que estar',
    alm.con.prepare('select count(*) n from chat where chat_jid=?').get(MI_LID).n === 0)
  ok('un contacto que nunca escribio no CREA una conversacion',
    alm.con.prepare('select count(*) n from chat where chat_jid=?')
      .get('573009999999@s.whatsapp.net').n === 0)
  ok('pero su nombre queda en memoria para cuando escriba',
    memoria.get('573009999999@s.whatsapp.net') === 'Nunca Escribio')

  // Un nombre de verdad no se degrada: la libreta llega en lotes y a destiempo.
  ingerirContactos({ almacen: alm, cuenta: CUENTA, esPropio, recordarNombre,
    contactos: [{ id: DIRECTO, notify: '+57 317 256 1455' }] })
  ok('un lote posterior NO pisa un nombre que ya era bueno',
    alm.con.prepare('select chat_name from chat where chat_jid=?').get(DIRECTO)
      .chat_name === 'Laura Mendez')

  ok('nombrarChat avisa cuando no cambio nada',
    alm.nombrarChat({ cuenta: CUENTA, chatJid: DIRECTO, nombre: 'Otro' }) === false)
  ok('y un nombre igual al jid no cuenta como nombre',
    alm.nombrarChat({ cuenta: CUENTA, chatJid: DIRECTO, nombre: DIRECTO }) === false)

  // WhatsApp ya guarda el directo con el LID y no con el numero, pero la libreta del
  // telefono llega por numero, con el LID al lado (`lid`). Sin mirar ese campo el directo
  // nunca tenia nombre aunque el contacto estuviera guardado en el telefono.
  const DIRECTO_LID = '111122223333@lid'
  alm.anotarChat({ cuenta: CUENTA, chatJid: DIRECTO_LID, nombre: '', esGrupo: 0,
    ts: 1700000000, ahora: Date.now() })
  const conLid = ingerirContactos({ almacen: alm, cuenta: CUENTA, esPropio, recordarNombre,
    contactos: [{ id: '573007776655@s.whatsapp.net', name: 'Persona Guardada',
      lid: DIRECTO_LID }] })
  ok('la libreta nombra el directo guardado con su LID',
    alm.con.prepare('select chat_name from chat where chat_jid=?').get(DIRECTO_LID)
      .chat_name === 'Persona Guardada' && conLid.nombrados === 1, JSON.stringify(conLid))
  ok('y el nombre queda en memoria tambien por el LID',
    memoria.get(DIRECTO_LID) === 'Persona Guardada')

  // Baileys 7: el contacto puede venir con `id` en LID y el telefono en `phoneNumber`
  // (el historial y `lidContactAction`, lib/Utils/history.js). El directo guardado por
  // telefono tiene que recibir el nombre igual.
  const DIRECTO_PN = '573000000012@s.whatsapp.net'
  alm.anotarChat({ cuenta: CUENTA, chatJid: DIRECTO_PN, nombre: '', esGrupo: 0,
    ts: 1700000000, ahora: Date.now() })
  const porLid = ingerirContactos({ almacen: alm, cuenta: CUENTA, esPropio, recordarNombre,
    contactos: [{ id: '111122224444@lid', lid: '111122224444@lid',
      phoneNumber: DIRECTO_PN, name: 'Persona Por Lid' }] })
  ok('un contacto con id LID y phoneNumber (Baileys 7) nombra el directo por telefono',
    alm.con.prepare('select chat_name from chat where chat_jid=?').get(DIRECTO_PN)
      .chat_name === 'Persona Por Lid' && porLid.nombrados === 1, JSON.stringify(porLid))
  ok('y el nombre queda en memoria por los dos',
    memoria.get(DIRECTO_PN) === 'Persona Por Lid' &&
    memoria.get('111122224444@lid') === 'Persona Por Lid')
  alm.cerrar()
}

// ── El caso medido en la cuenta del dueno ──────────────────────────────────────────
// "Esa automatizacion no ve nunca nada, todo skipped, asi me escriban". Tenia razon:
// dos filtros del SQL escondian trabajo real de chats que EL MISMO habia autorizado.
console.log('\ninbox: lo que llega a un chat autorizado se ve, con @ o sin @')
{
  const casa = nueva()
  const alm = abrirAlmacen(rutaAlmacen({ HOME: casa }))
  const GRUPO = '120363000000000077@g.us'
  const DIRECTO = '573009998877@s.whatsapp.net'
  alm.registrarLinea({ cuenta: CUENTA, lid: MI_LID, pn: MI_TEL, nombre: 'Yo' })
  autorizar(casa, { jid: GRUPO, nombre: 'Operaciones', modo: 'responder' })
  autorizar(casa, { jid: DIRECTO, nombre: 'Pedro', modo: 'responder' })

  const T = 1700000000
  // Las filas de `chat` tienen que existir: `inbox` hace join contra ellas.
  alm.anotarChat({ cuenta: CUENTA, chatJid: GRUPO, nombre: 'Operaciones', esGrupo: 1, ts: T })
  alm.anotarChat({ cuenta: CUENTA, chatJid: DIRECTO, nombre: 'Pedro', esGrupo: 0, ts: T })
  const fila = (chat, id, ts, body, extra = {}) => ({
    cuenta: CUENTA, chatJid: chat, stanzaId: id, ts, fromMe: 0,
    senderJid: '573009998877@s.whatsapp.net', senderName: 'Pedro', body,
    mediaTipo: null, mediaBytes: null, mencionaMe: 0, citaMe: 0, ...extra
  })

  // Una mencion, y despues una linea del grupo SIN @ — la que el dueno no veia.
  alm.guardarMensaje(fila(GRUPO, 'G1', T, '@yo como va el proyecto', { mencionaMe: 1 }))
  alm.guardarMensaje(fila(GRUPO, 'G2', T + 60, 'pilas tu. o quieres que te suba a cliente?'))
  // Y un privado.
  alm.guardarMensaje(fila(DIRECTO, 'D1', T + 120, 'hola, me confirmas?'))
  alm.cerrar()

  const antes = leerJson(casa, ['inbox', '--days', '36500'])
  const ids = (antes.filas || []).map((f) => f.stanza_id)
  ok('la mencion del grupo se ve', ids.includes('G1'), JSON.stringify(ids))
  ok('y el mensaje del grupo SIN mencion tambien — este era el que se perdia',
    ids.includes('G2'), JSON.stringify(ids))
  ok('y el privado', ids.includes('D1'), JSON.stringify(ids))

  // Lo que se sabia NO se perdio: `kind` sigue distinguiendo, para que el agente
  // priorice. Una mencion pide respuesta; una linea suelta del grupo puede no pedir
  // nada, y esa decision es del agente, no del SQL.
  const porId = {}
  ;(antes.filas || []).forEach((f) => { porId[f.stanza_id] = f })
  ok('la mencion se sigue llamando mencion', porId.G1.kind === 'mencion', porId.G1.kind)
  ok('la linea del grupo se llama grupo, no se aplana con la mencion',
    porId.G2.kind === 'grupo', porId.G2.kind)
  ok('y el privado se llama directo', porId.D1.kind === 'directo', porId.D1.kind)

  // Y el segundo filtro: el dueno escribe algo que NO contesta nada.
  const alm2 = abrirAlmacen(rutaAlmacen({ HOME: casa }))
  alm2.guardarMensaje(fila(GRUPO, 'MIO', T + 300, 'Deja tu gracia ponte pilas con el informe',
    { fromMe: 1, senderJid: MI_TEL, senderName: 'Yo' }))
  alm2.cerrar()

  const despues = leerJson(casa, ['inbox', '--days', '36500'])
  const tras = (despues.filas || []).map((f) => f.stanza_id)
  ok('escribir en el chat NO borra lo que quedo sin responder',
    tras.includes('G1') && tras.includes('G2'), JSON.stringify(tras))
  const g1 = (despues.filas || []).find((f) => f.stanza_id === 'G1')
  ok('pero la fila avisa que el dueno escribio despues',
    g1.escribio_despues === true, JSON.stringify(g1.escribio_despues))
  const d1 = (despues.filas || []).find((f) => f.stanza_id === 'D1')
  ok('y en el chat donde NO escribio, la bandera no se enciende',
    d1.escribio_despues === false, JSON.stringify(d1.escribio_despues))
}

console.log('\nJuicio cacheado: T2/T5/T6 — el veredicto viaja en la fila, o no viaja')
{
  const casa = nueva()
  const GRUPO = '120363000000000099@g.us'
  const alm = abrirAlmacen(rutaAlmacen({ HOME: casa }))
  alm.registrarLinea({ cuenta: CUENTA, lid: MI_LID, pn: MI_TEL, nombre: 'Yo' })
  autorizar(casa, { jid: GRUPO, nombre: 'Grupo Juicio', modo: 'observar' })
  const T = 1710000000
  alm.anotarChat({ cuenta: CUENTA, chatJid: GRUPO, nombre: 'Grupo Juicio', esGrupo: 1, ts: T })
  const fila = (id, ts, body) => ({
    cuenta: CUENTA, chatJid: GRUPO, stanzaId: id, ts, fromMe: 0,
    senderJid: '573009998877@s.whatsapp.net', senderName: 'Pedro', body,
    mediaTipo: null, mediaBytes: null, mencionaMe: 0, citaMe: 0
  })
  alm.guardarMensaje(fila('J1', T, 'ya lo clasificaron antes'))
  alm.guardarMensaje(fila('J2', T + 60, 'este todavia no tiene veredicto'))
  alm.guardarMensaje(fila('J3', T + 120, 'este tiene un valor corrupto'))
  alm.cerrar()

  // T2: se guarda un veredicto con el CLI de verdad, no escribiendo el sqlite a mano.
  execFileSync(WA_SCOPE, ['juicio', '--account', CUENTA, '--chat', GRUPO,
    '--stanza', 'J1', '--clase', 'card', '--origen', 'agente'],
    { env: { ...process.env, HOME: casa }, encoding: 'utf8' })

  // Un valor corrupto, escrito a mano y sin pasar por la validacion del CLI: lo que
  // puede llegar de una base vieja o de una escritura a medias.
  const scopeDb = new DatabaseSync(join(casa, '.wa-inbox', 'scope.db'))
  scopeDb.prepare(`insert into juicio (account, chat_jid, stanza_id, clase, origen, at)
    values (?,?,?,?,?,?)`).run(CUENTA, GRUPO, 'J3', 'basura', 'agente', '2025-01-01 00:00')
  scopeDb.close()

  const filas = leerJson(casa, ['inbox', '--days', '36500'])
  const porId = {}
  ;(filas.filas || []).forEach((f) => { porId[f.stanza_id] = f })

  ok('T5: con veredicto guardado, la fila trae `juicio.clase`',
    porId.J1 && porId.J1.juicio && porId.J1.juicio.clase === 'card',
    JSON.stringify(porId.J1 && porId.J1.juicio))
  ok('y trae quien lo produjo, en `juicio.origen`',
    porId.J1 && porId.J1.juicio && porId.J1.juicio.origen === 'agente',
    JSON.stringify(porId.J1 && porId.J1.juicio))
  ok('T6: sin veredicto guardado, la fila no trae `juicio`',
    porId.J2 && !('juicio' in porId.J2), JSON.stringify(porId.J2))
  ok('T6: una clase fuera del vocabulario cerrado no llega como veredicto',
    porId.J3 && !('juicio' in porId.J3), JSON.stringify(porId.J3))
}

console.log('\nJuicio cacheado: T6 — sin scope.db, y sin la tabla, la bandeja no se rompe')
{
  // Sin scope.db: nunca se corrio wa-scope en este HOME. wa_store.py sigue siendo
  // mode=ro y no puede ser quien lo cree.
  const casa = nueva()
  const GRUPO = '120363000000000098@g.us'
  const alm = abrirAlmacen(rutaAlmacen({ HOME: casa }))
  alm.registrarLinea({ cuenta: CUENTA, lid: MI_LID, pn: MI_TEL, nombre: 'Yo' })
  alm.anotarChat({ cuenta: CUENTA, chatJid: GRUPO, nombre: 'Sin Alcance', esGrupo: 1, ts: 1710000000 })
  alm.guardarMensaje({
    cuenta: CUENTA, chatJid: GRUPO, stanzaId: 'N1', ts: 1710000000, fromMe: 0,
    senderJid: '573009998877@s.whatsapp.net', senderName: 'Pedro', body: 'hola',
    mediaTipo: null, mediaBytes: null, mencionaMe: 0, citaMe: 0
  })
  alm.cerrar()
  ok('sin scope.db en el HOME', !existsSync(join(casa, '.wa-inbox', 'scope.db')))
  const sinBase = leerJson(casa, ['inbox', '--days', '36500'])
  ok('sin scope.db, `inbox` igual contesta 0', sinBase.code === 0, sinBase.stderr)
  const n1 = (sinBase.filas || []).find((f) => f.stanza_id === 'N1')
  ok('y la fila se ve, sin el campo `juicio`', n1 && !('juicio' in n1), JSON.stringify(n1))

  // scope.db existe, pero de antes de esta tarea: sin la tabla juicio.
  const scopeDb = new DatabaseSync(join(casa, '.wa-inbox', 'scope.db'))
  scopeDb.exec(`create table chat_scope (
    account text not null default 'local', chat_jid text not null,
    chat_name text not null, mode text not null default 'off',
    primary key (account, chat_jid))`)
  scopeDb.close()
  const sinTabla = leerJson(casa, ['inbox', '--days', '36500'])
  ok('scope.db sin la tabla juicio: `inbox` igual contesta 0',
    sinTabla.code === 0, sinTabla.stderr)
  const n1b = (sinTabla.filas || []).find((f) => f.stanza_id === 'N1')
  ok('y la fila sigue sin `juicio`, sin romperse', n1b && !('juicio' in n1b),
    JSON.stringify(n1b))
}

// ── T16b: el mismo directo, con y sin dispositivo ──────────────────────────────────
// Visto en vivo (2026-10-01): en una linea enlazada la lista traia a la misma persona
// dos veces, `<lid>@lid` con su nombre y `<lid>:90@lid` sin nombre. El sidecar tiene
// que dejar de producir la segunda, y el almacen que ya la tiene tiene que juntarla con
// la primera sin perder un mensaje.
console.log('\nT16b: un directo con dispositivo (`:N`) no duplica a la persona')
{
  const casa = nueva()
  const alm = abrirAlmacen(rutaAlmacen({ HOME: casa }))
  const LIMPIO = '100000000000001@lid'
  const CON_DISPOSITIVO = '100000000000001:90@lid'
  const alcanceAbierto = () => 'observar'
  const wa = (chat, id) => ({
    key: { remoteJid: chat, fromMe: false, id }, messageTimestamp: T0 + 10,
    pushName: 'Persona Uno', message: { conversation: 'hola' }
  })
  await ingerirMensaje({ almacen: alm, alcance: alcanceAbierto, cuenta: CUENTA,
    identidades: YO, wa: wa(CON_DISPOSITIVO, 'Z1'), mediaDir })
  await ingerirMensaje({ almacen: alm, alcance: alcanceAbierto, cuenta: CUENTA,
    identidades: YO, wa: wa(LIMPIO, 'Z2'), mediaDir })
  ingerirContactos({ almacen: alm, cuenta: CUENTA,
    contactos: [{ id: CON_DISPOSITIVO, name: 'Persona Uno' }] })
  const chats = alm.con.prepare(
    "select chat_jid, chat_name from chat where chat_jid like '100000000000001%'").all()
  ok('un solo chat para la persona, sin dispositivo',
    chats.length === 1 && chats[0].chat_jid === LIMPIO, JSON.stringify(chats))
  ok('y ahi quedaron sus dos mensajes',
    alm.con.prepare('select count(*) n from mensaje where chat_jid = ?').get(LIMPIO).n === 2)
  ok('la libreta nombro el chat sin dispositivo',
    alm.con.prepare('select chat_name from chat where chat_jid = ?').get(LIMPIO)
      .chat_name === 'Persona Uno')
  alm.cerrar()
}

console.log('\nT16b: la migracion junta los directos con dispositivo que ya estaban guardados')
{
  const home = nueva()
  const ruta = rutaAlmacen({ HOME: home })
  const LIMPIO = '100000000000001@lid'
  const DISP = '100000000000001:90@lid'
  const DISP2 = '100000000000001:12@lid'
  const TEL = '573000000012@s.whatsapp.net'
  const TEL_DISP = '573000000012:3@s.whatsapp.net'
  const SOLO_DISP = '573000000013:5@s.whatsapp.net'
  const SOLO_LIMPIO = '573000000013@s.whatsapp.net'
  const GRUPO = '120363000000000099@g.us'
  const OTRA = 'pn:573000000011'

  // Un almacen de HOY, con las filas como las dejaba el defecto, escritas a mano.
  const prep = abrirAlmacen(ruta)
  prep.registrarLinea({ cuenta: CUENTA, lid: MI_LID, pn: MI_TEL, nombre: 'Linea' })
  prep.cerrar()
  const con = new DatabaseSync(ruta)
  const chat = con.prepare('insert into chat (account, chat_jid, chat_name, is_group, ' +
    'unread, last_ts, first_seen) values (?,?,?,?,?,?,?)')
  const msg = con.prepare('insert into mensaje (account, chat_jid, stanza_id, ts, ' +
    'from_me, body, captured_at) values (?,?,?,?,?,?,?)')
  chat.run(CUENTA, LIMPIO, 'Persona Uno', 0, 1, T0 + 5, T0 - 100)
  chat.run(CUENTA, DISP, '', 0, 4, T0 + 50, T0 - 200)
  chat.run(CUENTA, DISP2, '', 0, 0, T0 + 20, T0 - 50)
  chat.run(CUENTA, TEL, '', 0, 0, T0 + 1, T0)
  chat.run(CUENTA, TEL_DISP, 'Laura Mendez', 0, 2, T0 + 9, T0 - 10)
  chat.run(CUENTA, SOLO_DISP, '', 0, 0, T0 + 3, T0)
  chat.run(CUENTA, GRUPO, 'Grupo Alfa', 1, 0, T0, T0)
  chat.run(OTRA, DISP, '', 0, 0, T0, T0)
  msg.run(CUENTA, LIMPIO, 'A1', T0 + 1, 0, 'ya estaba', T0)
  msg.run(CUENTA, DISP, 'A2', T0 + 2, 0, 'solo con dispositivo', T0)
  msg.run(CUENTA, DISP, 'A1', T0 + 1, 0, 'duplicado distinto', T0 + 9)
  msg.run(CUENTA, DISP2, 'A3', T0 + 3, 1, 'otro dispositivo', T0)
  msg.run(CUENTA, TEL_DISP, 'B1', T0 + 4, 0, 'del telefono', T0)
  msg.run(CUENTA, SOLO_DISP, 'C1', T0 + 5, 0, 'chat que solo existia asi', T0)
  msg.run(CUENTA, GRUPO, 'G1', T0 + 6, 0, 'grupo', T0)
  msg.run(OTRA, DISP, 'A2', T0 + 2, 0, 'de otra linea', T0)
  con.close()

  const alm = abrirAlmacen(ruta)
  const q = alm.con
  const jids = q.prepare('select account, chat_jid from chat order by account, chat_jid')
    .all().map((f) => `${f.account}|${f.chat_jid}`)
  ok('no queda ningun chat directo con dispositivo',
    !jids.some((j) => /:\d+@(lid|s\.whatsapp\.net)$/.test(j)), JSON.stringify(jids))
  const unido = q.prepare('select * from chat where account=? and chat_jid=?')
    .get(CUENTA, LIMPIO)
  ok('se queda la fila con nombre', unido?.chat_name === 'Persona Uno',
    JSON.stringify(unido))
  ok('con SU no leido y la ultima actividad de la fila mas reciente',
    unido?.unread === 1 && unido?.last_ts === T0 + 50, JSON.stringify(unido))
  ok('y la primera vez que se la vio, la mas vieja', unido?.first_seen === T0 - 200,
    JSON.stringify(unido))
  const tel = q.prepare('select chat_name from chat where account=? and chat_jid=?')
    .get(CUENTA, TEL)
  ok('si el nombre estaba en la fila con dispositivo, se conserva',
    tel?.chat_name === 'Laura Mendez', JSON.stringify(tel))
  ok('un chat que solo existia con dispositivo se renombra, no se pierde',
    q.prepare('select count(*) n from chat where account=? and chat_jid=?')
      .get(CUENTA, SOLO_LIMPIO).n === 1)
  const mensajes = q.prepare('select chat_jid, stanza_id, body from mensaje ' +
    'where account=? order by stanza_id, chat_jid').all(CUENTA)
  const de = (id, jid) => mensajes.find((m) => m.stanza_id === id && m.chat_jid === jid)
  ok('los mensajes de los chats con dispositivo pasan al chat sin dispositivo',
    de('A2', LIMPIO) && de('A3', LIMPIO) && de('B1', TEL) && de('C1', SOLO_LIMPIO),
    JSON.stringify(mensajes))
  ok('ante una llave repetida gana el mensaje que ya estaba',
    de('A1', LIMPIO)?.body === 'ya estaba', JSON.stringify(de('A1', LIMPIO)))
  ok('y no se pierde ningun mensaje: el repetido queda donde estaba',
    mensajes.length === 7 && de('A1', DISP)?.body === 'duplicado distinto',
    JSON.stringify(mensajes))
  ok('un grupo no se toca', q.prepare('select count(*) n from chat where chat_jid=?')
    .get(GRUPO).n === 1 && de('G1', GRUPO))
  ok('la otra linea se junta en SU cuenta, sin mezclarse',
    q.prepare('select count(*) n from mensaje where account=? and chat_jid=?')
      .get(OTRA, LIMPIO).n === 1 &&
    q.prepare('select count(*) n from chat where account=? and chat_jid=?')
      .get(OTRA, LIMPIO).n === 1)
  const nota = q.prepare("select value from store_meta where key='jid_dispositivo_unido'")
    .get()
  const datos = nota ? JSON.parse(nota.value) : {}
  ok('queda anotado cuanto junto, solo numeros',
    datos.chats === 5 && datos.mensajes === 5, JSON.stringify(datos))
  ok('el almacen lo dice al abrir', alm.dispositivosUnidos?.chats === 5,
    JSON.stringify(alm.dispositivosUnidos))
  alm.cerrar()

  const otra = abrirAlmacen(ruta)
  ok('reabrirlo no vuelve a juntar nada', otra.dispositivosUnidos === null,
    JSON.stringify(otra.dispositivosUnidos))
  const estado = JSON.stringify([
    otra.con.prepare('select * from chat order by account, chat_jid').all(),
    otra.con.prepare('select * from mensaje order by account, chat_jid, stanza_id').all()])
  otra.cerrar()
  const tercera = abrirAlmacen(ruta)
  ok('ni cambia el contenido: es idempotente',
    JSON.stringify([
      tercera.con.prepare('select * from chat order by account, chat_jid').all(),
      tercera.con.prepare('select * from mensaje order by account, chat_jid, stanza_id').all()
    ]) === estado)
  tercera.cerrar()
}

// WhatsApp guarda los directos con un id interno (`<digitos>@lid`) y ya no muestra el
// numero: el dueno no distingue un chat de otro ni lo encuentra por el telefono que
// tiene en la agenda. Baileys trae el par LID-telefono por tres caminos, y los tres se
// anotan como CONTABILIDAD: un jid y un numero, nunca un cuerpo.
console.log('\ningesta: el telefono de cada LID')
{
  const casa = nueva()
  const alm = abrirAlmacen(rutaAlmacen({ HOME: casa }))
  const esPropio = (jid) => YO.has(identidadPropia(jid))
  const LID = '100000000000002@lid'
  const TEL = '573007776655@s.whatsapp.net'
  const LID_B = '111122223333@lid'
  const TEL_B = '573000000002@s.whatsapp.net'
  const LID_C = '111122224444@lid'
  const TEL_C = '573009999999@s.whatsapp.net'
  const LID_D = '111122225555@lid'
  const TEL_D = '573000000011@s.whatsapp.net'
  const GRUPO = '120363000000000077@g.us'
  const pares = (cuenta = CUENTA) => Object.fromEntries(alm.con.prepare(
    'select lid, pn from lid_telefono where account=? order by lid').all(cuenta)
    .map((f) => [f.lid, f.pn]))

  // 1. La libreta: `{ id: <telefono>, name, lid }`, la forma que emite `contactAction`.
  //    El par se guarda AUNQUE el contacto no tenga nombre, y sin el dispositivo.
  ingerirContactos({ almacen: alm, cuenta: CUENTA, esPropio,
    contactos: [
      { id: TEL, name: 'Persona Guardada', lid: '100000000000002:7@lid' },
      { id: TEL_B, lid: LID_B },
      { id: '573000000012@s.whatsapp.net', name: 'Sin Lid' },
      { id: MI_TEL, name: 'Yo', lid: MI_LID }
    ] })
  // Baileys 7 trae el telefono en `phoneNumber`: con `id` en LID (historial) o en
  // telefono (`contactAction`, que lo repite ahi).
  ingerirContactos({ almacen: alm, cuenta: CUENTA, esPropio,
    contactos: [
      { id: '111122220001@lid', lid: '111122220001@lid',
        phoneNumber: '573001234567@s.whatsapp.net', name: 'Por Lid' },
      { id: '573005554433@s.whatsapp.net', lid: '111122220002@lid',
        phoneNumber: '573005554433@s.whatsapp.net' },
      { id: MI_LID, phoneNumber: MI_TEL, name: 'Yo' }
    ] })
  let p = pares()
  ok('Baileys 7: phoneNumber da el par, venga el id en LID o en telefono',
    p['111122220001@lid'] === '573001234567@s.whatsapp.net' &&
    p['111122220002@lid'] === '573005554433@s.whatsapp.net' && !p[MI_LID],
    JSON.stringify(p))
  alm.con.prepare("delete from lid_telefono where lid like '11112222000%'").run()
  p = pares()
  ok('la libreta anota el telefono de cada LID, sin dispositivo',
    p[LID] === TEL && p[LID_B] === TEL_B, JSON.stringify(p))
  ok('un contacto sin LID no anota nada, y el dueno tampoco',
    Object.keys(p).length === 2 && !p[MI_LID], JSON.stringify(p))

  // 2. Los mensajes: la forma alterna de la llave (`remoteJidAlt` en un directo,
  //    `participantAlt` en un grupo, Baileys 7) es del que MANDA. En un directo recibido el que
  //    manda es la conversacion; en uno propio es el dueno, y ese par seria mentira.
  const alcanceCerrado = () => 'off'
  const wa = (key) => ({ key: { fromMe: false, ...key }, messageTimestamp: T0,
    message: { conversation: 'hola' } })
  await ingerirMensaje({ almacen: alm, alcance: alcanceCerrado, cuenta: CUENTA,
    identidades: YO, mediaDir, wa: wa({ remoteJid: LID_C, id: 'P1', remoteJidAlt: TEL_C }) })
  await ingerirMensaje({ almacen: alm, alcance: alcanceCerrado, cuenta: CUENTA,
    identidades: YO, mediaDir,
    wa: wa({ remoteJid: '111122226666@lid', id: 'P2', fromMe: true, remoteJidAlt: MI_TEL }) })
  await ingerirMensaje({ almacen: alm, alcance: alcanceCerrado, cuenta: CUENTA,
    identidades: YO, mediaDir,
    wa: wa({ remoteJid: GRUPO, id: 'P3', participant: LID_D, participantAlt: TEL_D }) })
  await ingerirMensaje({ almacen: alm, alcance: alcanceCerrado, cuenta: CUENTA,
    identidades: YO, mediaDir,
    wa: wa({ remoteJid: '573000000013@s.whatsapp.net', id: 'P4',
      remoteJidAlt: '111122227777@lid' }) })
  p = pares()
  ok('un directo recibido anota el telefono de quien escribe, aunque este en off',
    p[LID_C] === TEL_C, JSON.stringify(p))
  ok('en un grupo, el del participante', p[LID_D] === TEL_D, JSON.stringify(p))
  ok('un directo por telefono anota su LID',
    p['111122227777@lid'] === '573000000013@s.whatsapp.net', JSON.stringify(p))
  ok('un mensaje PROPIO no le pone el telefono del dueno a la conversacion',
    !p['111122226666@lid'], JSON.stringify(p))
  ok('y ningun cuerpo se guardo: el chat estaba en off',
    alm.con.prepare('select count(*) n from mensaje').get().n === 0)

  // 3. La lista de conversaciones del historial: `IConversation` trae `pnJid`/`lidJid`.
  ingerirChats({ almacen: alm, cuenta: CUENTA, esPropio,
    chats: [{ id: '111122228888@lid', pnJid: '573000000001@s.whatsapp.net',
      conversationTimestamp: T0 },
    { id: '573000000000@s.whatsapp.net', lidJid: '111122229999@lid',
      conversationTimestamp: T0 }] })
  p = pares()
  ok('el historial anota el par de cada conversacion',
    p['111122228888@lid'] === '573000000001@s.whatsapp.net' &&
    p['111122229999@lid'] === '573000000000@s.whatsapp.net', JSON.stringify(p))

  // 4. Baileys 7 avisa el par por su cuenta: `lid-mapping.update` ({ lid, pn }) y
  //    `lidPnMappings` en el lote del historial. Es el mismo par que guarda para
  //    descifrar; aca se anota como contabilidad, y el del dueno no.
  const r = ingerirParesLid({ almacen: alm, cuenta: CUENTA, esPropio,
    pares: [{ lid: '111122220003:2@lid', pn: '573002220000@s.whatsapp.net' },
      { lid: MI_LID, pn: MI_TEL }, { lid: 'no-es-lid', pn: '573002220000@s.whatsapp.net' },
      null] })
  p = pares()
  ok('lid-mapping.update y lidPnMappings anotan el par, sin dispositivo',
    p['111122220003@lid'] === '573002220000@s.whatsapp.net' && r.anotados === 1,
    JSON.stringify({ p, r }))
  ok('y no anotan al dueno ni lo que no es un par', !p[MI_LID], JSON.stringify(p))
  ok('sin pares no hace nada',
    ingerirParesLid({ almacen: alm, cuenta: CUENTA, pares: undefined }).anotados === 0)

  // Un par nuevo para el mismo LID manda: el numero de una persona puede cambiar.
  ok('anotar el mismo par otra vez no cambia nada',
    alm.anotarTelefono({ cuenta: CUENTA, lid: LID, pn: TEL }) === false)
  ok('un telefono nuevo para el mismo LID lo reemplaza',
    alm.anotarTelefono({ cuenta: CUENTA, lid: LID, pn: TEL_B }) === true &&
    pares()[LID] === TEL_B)
  ok('lo que no es un LID y un telefono no se anota',
    alm.anotarTelefono({ cuenta: CUENTA, lid: TEL, pn: LID }) === false &&
    alm.anotarTelefono({ cuenta: CUENTA, lid: GRUPO, pn: TEL }) === false)
  ok('cada linea guarda los suyos',
    Object.keys(pares('pn:573000000012')).length === 0)
  const columnas = alm.con.prepare('pragma table_info(lid_telefono)').all()
    .map((c) => c.name).sort().join(',')
  ok('la tabla es contabilidad: cuenta, LID, telefono y cuando',
    columnas === 'account,lid,pn,updated_at', columnas)
  alm.cerrar()

  // Un almacen de antes de esta tabla la recibe al abrirse, sin perder nada.
  const viejo = new DatabaseSync(rutaAlmacen({ HOME: casa }))
  viejo.exec('drop table lid_telefono')
  viejo.close()
  const reabierto = abrirAlmacen(rutaAlmacen({ HOME: casa }))
  ok('un almacen sin la tabla la recibe al abrirse',
    reabierto.anotarTelefono({ cuenta: CUENTA, lid: LID, pn: TEL }) === true)
  reabierto.cerrar()
}

// roles-por-numero (M8): la lista de participantes de cada grupo se GUARDA, para que el
// dueno pueda marcar a cada persona Operador o Super admin desde el panel. Es contabilidad
// como `lid_telefono`: ids, si es admin de WhatsApp y cuando, nunca un cuerpo. Llega por
// `groupFetchAllParticipating` (la lista entera) y cambia por `group-participants.update`.
console.log('\nroles-por-numero (M8): los miembros de cada grupo')
{
  const casa = casaNueva()
  const ruta = rutaAlmacen({ HOME: casa })
  const alm = abrirAlmacen(ruta)
  alm.registrarLinea({ cuenta: CUENTA, lid: MI_LID, pn: MI_TEL, nombre: 'Mi Linea' })
  alm.activarLinea(CUENTA)
  alm.latir()
  const esPropio = (jid) => YO.has(identidadPropia(jid))
  const GRUPO = '120363000000000077@g.us'
  const OTRO = '120363000000000078@g.us'
  const UNO = '100000000000002@lid'
  const UNO_TEL = '573007776655@s.whatsapp.net'
  const DOS = '573000000002@s.whatsapp.net'
  const TRES = '111122224444@lid'
  const CUATRO = '111122225555@lid'
  const miembros = (chat = GRUPO, cuenta = CUENTA) => Object.fromEntries(alm.con.prepare(
    'select member_jid, admin from grupo_miembro where account=? and chat_jid=? ' +
    'order by member_jid').all(cuenta, chat).map((f) => [f.member_jid, f.admin]))

  const columnas = alm.con.prepare('pragma table_info(grupo_miembro)').all()
    .map((c) => c.name).sort().join(',')
  ok('la tabla es contabilidad: cuenta, grupo, miembro, si es admin y cuando',
    columnas === 'account,admin,chat_jid,member_jid,updated_at', columnas)

  // 1. La lista entera, con la forma de `groupFetchAllParticipating` (jid -> metadata).
  alm.anotarChat({ cuenta: CUENTA, chatJid: GRUPO, nombre: 'Grupo Demo', esGrupo: 1 })
  const r1 = ingerirMiembros({ almacen: alm, cuenta: CUENTA, esPropio, grupos: [
    { id: GRUPO, subject: 'Grupo Demo', participants: [
      { id: UNO, phoneNumber: UNO_TEL, admin: 'admin' },
      { id: DOS, admin: null },
      { id: `${TRES.split('@')[0]}:4@lid`, admin: null },
      { id: MI_LID, phoneNumber: MI_TEL, admin: 'superadmin' }] },
    { id: OTRO, subject: 'Otro', participants: [{ id: DOS, admin: 'superadmin' }] },
    { id: LAURA, participants: [{ id: DOS }] }] })
  let m = miembros()
  ok('la lista de un fetch queda guardada, un miembro por participante y sin dispositivo',
    JSON.stringify(m) === JSON.stringify({ [UNO]: 1, [TRES]: 0, [DOS]: 0 }), JSON.stringify(m))
  ok('la linea misma no es miembro de nada', !m[MI_LID] && !m[MI_TEL])
  ok('cada grupo guarda los suyos', JSON.stringify(miembros(OTRO)) ===
    JSON.stringify({ [DOS]: 1 }) && r1.grupos === 2, JSON.stringify(r1))
  ok('el telefono de un LID que trae la metadata queda en lid_telefono',
    alm.con.prepare('select pn from lid_telefono where account=? and lid=?')
      .get(CUENTA, UNO)?.pn === UNO_TEL)
  ok('y ningun cuerpo se guardo', alm.con.prepare('select count(*) n from mensaje').get().n === 0)

  // 2. Los cambios, con la forma de `group-participants.update`.
  const cambio = (action, participants) => ingerirCambioDeMiembros({ almacen: alm,
    cuenta: CUENTA, esPropio, evento: { id: GRUPO, author: UNO, participants, action } })
  cambio('add', [CUATRO])
  ok('add suma al miembro, sin admin', miembros()[CUATRO] === 0, JSON.stringify(miembros()))
  cambio('promote', [CUATRO])
  ok('promote lo hace admin', miembros()[CUATRO] === 1)
  cambio('demote', [CUATRO, UNO])
  ok('demote se lo quita', miembros()[CUATRO] === 0 && miembros()[UNO] === 0)
  cambio('remove', [TRES])
  ok('remove lo saca', !(TRES in miembros()) && Object.keys(miembros()).length === 3,
    JSON.stringify(miembros()))
  cambio('promote', [TRES])
  ok('promote de alguien que no estaba lo suma como admin', miembros()[TRES] === 1)
  cambio('modify', [DOS])
  ok('modify no toca nada', miembros()[DOS] === 0)

  // 3. Un fetch nuevo REEMPLAZA: el que ya no esta, se va.
  ingerirMiembros({ almacen: alm, cuenta: CUENTA, esPropio, grupos: [
    { id: GRUPO, participants: [{ id: UNO, admin: 'admin' }, { id: DOS, admin: null }] }] })
  ok('un fetch nuevo reemplaza la lista del grupo',
    JSON.stringify(miembros()) === JSON.stringify({ [UNO]: 1, [DOS]: 0 }),
    JSON.stringify(miembros()))
  ok('y no toca la de otro grupo', JSON.stringify(miembros(OTRO)) === JSON.stringify({ [DOS]: 1 }))
  ok('ni la de otra linea', Object.keys(miembros(GRUPO, 'pn:573000000012')).length === 0)

  // 4. wa-read members: [{id, name, phone, wa_admin}], el nombre del ultimo mensaje o de
  //    la libreta, el telefono por el par o por el propio jid.
  alm.anotarChat({ cuenta: CUENTA, chatJid: DOS, nombre: 'Persona Dos Libreta', esGrupo: 0 })
  const sinMedia = { mediaTipo: null, mediaBytes: null, mencionaMe: 0, citaMe: 0 }
  alm.guardarMensaje({ cuenta: CUENTA, chatJid: GRUPO, stanzaId: 'GM1', ts: T0, fromMe: 0,
    senderJid: `${UNO.split('@')[0]}:7@lid`, senderName: 'Uno Viejo', body: 'hola',
    ...sinMedia })
  alm.guardarMensaje({ cuenta: CUENTA, chatJid: GRUPO, stanzaId: 'GM2', ts: T0 + 60,
    fromMe: 0, senderJid: UNO, senderName: 'Uno Nuevo', body: 'otra cosa', ...sinMedia })
  cambio('add', [CUATRO])
  alm.cerrar()
  const r = leerJson(casa, ['members', '--chat', GRUPO])
  const por = Object.fromEntries((r.filas || []).map((f) => [f.id, f]))
  ok('`wa-read members --chat` sale 0 con una lista', r.code === 0 && Array.isArray(r.filas),
    r.stderr)
  ok('cada fila trae exactamente id, name, phone y wa_admin',
    (r.filas || []).length > 0 && r.filas.every((f) => Object.keys(f).sort().join(',') === 'id,name,phone,wa_admin'),
    r.stdout)
  ok('los miembros del grupo, sin la linea', Object.keys(por).sort().join(',') ===
    [UNO, DOS, CUATRO].sort().join(',') && !por[MI_LID], r.stdout)
  ok('el nombre es el del ultimo mensaje que mando', por[UNO]?.name === 'Uno Nuevo', r.stdout)
  ok('sin mensajes, el de la libreta (su directo)', por[DOS]?.name === 'Persona Dos Libreta',
    r.stdout)
  ok('sin ninguno, vacio', por[CUATRO]?.name === '', r.stdout)
  ok('el telefono: el de su jid, o el del par LID-telefono; sin par, null',
    por[UNO]?.phone === '+573007776655' && por[DOS]?.phone === '+573000000002' &&
    por[CUATRO]?.phone === null, r.stdout)
  ok('wa_admin es un booleano', por[UNO]?.wa_admin === true && por[DOS]?.wa_admin === false,
    r.stdout)
  const directo = leerJson(casa, ['members', '--chat', DOS])
  ok('en un directo, la persona del otro lado',
    JSON.stringify(directo.filas) === JSON.stringify([{ id: DOS, name: 'Persona Dos Libreta',
      phone: '+573000000002', wa_admin: false }]), directo.stdout)
  // Una fila de la linea misma que dejo un escritor anterior tampoco sale.
  const crudo = new DatabaseSync(ruta)
  crudo.prepare('insert into grupo_miembro values (?,?,?,0,?)').run(CUENTA, GRUPO, MI_LID, T0)
  crudo.close()
  ok('la linea misma no sale aunque este en la tabla',
    !(leerJson(casa, ['members', '--chat', GRUPO]).filas || []).some((f) => f.id === MI_LID))
  const nadie = leerJson(casa, ['members', '--chat', '120363000000000079@g.us'])
  ok('un chat que no existe sale 1, sin escribir en stdout',
    nadie.code === 1 && nadie.stdout.trim() === '', `${nadie.code} ${nadie.stdout}`)
  ok('un grupo sin miembros guardados: lista vacia', (() => {
    const a = abrirAlmacen(ruta)
    a.anotarChat({ cuenta: CUENTA, chatJid: '120363000000000079@g.us', nombre: 'Vacio',
      esGrupo: 1 })
    a.cerrar()
    const v = leerJson(casa, ['members', '--chat', '120363000000000079@g.us'])
    return v.code === 0 && JSON.stringify(v.filas) === '[]'
  })())

  // 5. Un almacen de antes de la tabla la recibe al abrirse, y wa-read lo lee igual.
  const viejo = new DatabaseSync(ruta)
  viejo.exec('drop table grupo_miembro')
  viejo.close()
  const sinTabla = leerJson(casa, ['members', '--chat', GRUPO])
  ok('sin la tabla (el sidecar de antes), `members` contesta vacio y no revienta',
    sinTabla.code === 0 && JSON.stringify(sinTabla.filas) === '[]', sinTabla.stderr)
  const reabierto = abrirAlmacen(ruta)
  ok('un almacen sin la tabla la recibe al abrirse',
    reabierto.con.prepare("select count(*) n from sqlite_master where name='grupo_miembro'")
      .get().n === 1)
  reabierto.cerrar()

  // 6. La linea sale del grupo: lo que se sabia de el ya no se puede mantener, se va.
  const otra = abrirAlmacen(ruta)
  ingerirMiembros({ almacen: otra, cuenta: CUENTA, esPropio, grupos: [
    { id: GRUPO, participants: [{ id: UNO, admin: null }, { id: DOS, admin: null }] }] })
  ingerirCambioDeMiembros({ almacen: otra, cuenta: CUENTA, esPropio,
    evento: { id: GRUPO, author: UNO, participants: [MI_LID], action: 'remove' } })
  ok('la linea sale del grupo: su lista se borra',
    otra.con.prepare('select count(*) n from grupo_miembro where chat_jid=?').get(GRUPO).n === 0)
  otra.cerrar()
  rmSync(casa, { recursive: true, force: true })
}

console.log('\nlinea-viva-2 W6: el id del mensaje citado se guarda y se lee')
{
  const casa = nueva()
  const ruta = rutaAlmacen({ HOME: casa })
  const alm = abrirAlmacen(ruta)
  alm.registrarLinea({ cuenta: CUENTA, lid: MI_LID, pn: MI_TEL, nombre: 'Mi Linea' })
  autorizar(casa, { jid: LAURA, nombre: 'Laura Mendez', modo: 'observar' })
  autorizar(casa, { jid: ALFA, nombre: 'Cliente Alfa', modo: 'observar' })
  const entra = (wa) => ingerirMensaje({
    almacen: alm, alcance, cuenta: CUENTA, identidades: YO, wa,
    mediaDir: rutaMedia({ HOME: casa }), descargarMedia: descargarFalso,
    nombreDeChat: (jid) => nombres.get(jid) || null
  })
  const cita = (chat, id, ts, citado) => ({
    key: { remoteJid: chat, fromMe: false, id,
      ...(chat.endsWith('@g.us') ? { participant: OTRA_PERSONA } : {}) },
    messageTimestamp: ts,
    pushName: 'Laura Mendez',
    message: { extendedTextMessage: { text: 'si', contextInfo: { stanzaId: citado } } }
  })
  const ahora = Math.floor(Date.now() / 1000)
  await entra(cita(LAURA, 'W6D1', ahora - 60, 'AVISO-CITADO-1'))
  await entra(cita(ALFA, 'W6G1', ahora - 50, 'OTRO-CITADO-2'))
  await entra(mensaje({ chat: LAURA, id: 'W6D2', ts: ahora - 40, texto: 'si' }))
  const filaDe = (con, id) =>
    con.prepare('select * from mensaje where stanza_id=?').get(id)
  ok('el directo que cita guarda el id citado',
    filaDe(alm.con, 'W6D1')?.cita_id === 'AVISO-CITADO-1', JSON.stringify(filaDe(alm.con, 'W6D1')))
  ok('el grupo que cita tambien', filaDe(alm.con, 'W6G1')?.cita_id === 'OTRO-CITADO-2')
  ok('sin cita queda null', filaDe(alm.con, 'W6D2')?.cita_id === null)
  // Una re-sincronizacion del mismo mensaje sin su contexto no borra la cita.
  await entra(mensaje({ chat: LAURA, id: 'W6D1', ts: ahora - 60, texto: 'si' }))
  ok('la misma fila sin contexto no borra el id citado',
    filaDe(alm.con, 'W6D1')?.cita_id === 'AVISO-CITADO-1')
  alm.cerrar()

  const { filas, stderr } = leerJson(casa, ['inbox', '--days', '36500'])
  const d1 = (filas || []).find((f) => f.stanza_id === 'W6D1')
  ok('la bandeja expone el id citado', d1?.cita_id === 'AVISO-CITADO-1', JSON.stringify(d1) + stderr)
  const d2 = (filas || []).find((f) => f.stanza_id === 'W6D2')
  ok('y sin cita no trae la clave', !!d2 && !('cita_id' in d2), JSON.stringify(d2))

  // El almacen de antes de la columna: sus mensajes siguen ahi y el lector lo lee igual.
  const viejo = new DatabaseSync(ruta)
  viejo.exec('alter table mensaje drop column cita_id')
  viejo.close()
  const sinColumna = leerJson(casa, ['inbox', '--days', '36500'])
  ok('sin la columna (el sidecar de antes), la bandeja sale 0 con sus mensajes',
    sinColumna.code === 0 && (sinColumna.filas || []).some((f) => f.stanza_id === 'W6D1') &&
    !(sinColumna.filas || []).some((f) => 'cita_id' in f), sinColumna.stderr)
  const reabierto = abrirAlmacen(ruta)
  const columnas = reabierto.con.prepare('pragma table_info(mensaje)').all().map((f) => f.name)
  ok('el almacen de antes gana la columna al abrirse', columnas.includes('cita_id'),
    JSON.stringify(columnas))
  ok('sin perder un mensaje', reabierto.con.prepare('select count(*) n from mensaje').get().n === 3)
  ok('y sin cambiar la version del esquema',
    reabierto.con.prepare("select value from store_meta where key='schema_version'").get()
      ?.value === String(ESQUEMA_VERSION) && ESQUEMA_VERSION === 1)
  reabierto.cerrar()
  const otraVez = abrirAlmacen(ruta)
  ok('abrirlo otra vez no falla (la subida es idempotente)',
    otraVez.con.prepare('pragma table_info(mensaje)').all()
      .filter((f) => f.name === 'cita_id').length === 1)
  otraVez.cerrar()
  ok('y el lector lo sigue leyendo', leerJson(casa, ['inbox', '--days', '36500']).code === 0)
  rmSync(casa, { recursive: true, force: true })
}

console.log(`\n${pruebas - fallos}/${pruebas} en verde`)
if (fallos) {
  console.error(`\n${fallos} fallas`)
  process.exit(1)
}
