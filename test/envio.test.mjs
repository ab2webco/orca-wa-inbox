#!/usr/bin/env node
/**
 * El envio, de punta a punta y sin una cuenta de WhatsApp.
 *
 * La linea estaba conectada y sabia LEER. No sabia contestar: el camino de escritura
 * se fue con los dos transportes viejos y nunca se rehizo sobre Baileys, asi que el
 * dueno tenia un agente que escuchaba y no podia responder. Esto ejercita el camino
 * nuevo con un socket de mentira, que es lo unico que hace falta: `sock.sendMessage`
 * es la unica funcion de Baileys que toca el envio.
 *
 * Se prueban las dos puntas y el contrato que las une:
 *
 *   - El lado del sidecar (`atenderSalida`): toma UNA vez, no toca los borradores, y
 *     un socket que se niega deja `rechazado` y no `enviado`.
 *   - El `bin/wa-send` de verdad —el proceso, con su HOME propio—, porque lo que el
 *     agente ejecuta es el ejecutable y no una funcion interna.
 *
 * Y sobre todo la invariante que no se deshace: un mensaje repetido a un grupo de un
 * cliente no se puede retirar, asi que el MISMO `--id` entrega UNA sola vez.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { abrirAlmacen, rutaAlmacen } from '../sidecar/src/almacen.js'
import { atenderSalida, ENVIO, LATIDO_VENCE_MS } from '../sidecar/src/envio.js'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')
const WA_SEND = join(RAIZ, 'bin', 'wa-send')
const WA_SCOPE = join(RAIZ, 'bin', 'wa-scope')
const MANIFIESTO = JSON.parse(readFileSync(join(RAIZ, 'orca-plugin.json'), 'utf8'))

let fallos = 0
let pruebas = 0
function ok (nombre, condicion, detalle = '') {
  pruebas += 1
  if (condicion) return console.log(`  ok    ${nombre}`)
  fallos += 1
  console.log(`  FALLA ${nombre}${detalle ? ` — ${String(detalle).slice(0, 500)}` : ''}`)
}

const CUENTA = 'local'
const ALFA = '120363111222333444@g.us'
const LAURA = '573009998877@s.whatsapp.net'
const CALLADO = '120363999888777666@g.us'
const DESDE_EL_PANEL = '120363555444333222@g.us'

const casas = []
function nueva () {
  const home = mkdtempSync(join(tmpdir(), 'wa-envio-'))
  mkdirSync(join(home, '.wa-inbox'), { recursive: true })
  casas.push(home)
  return home
}

function entorno (home, extra = {}) {
  return { ...process.env, HOME: home, ORCA_CLI_COMMAND: join(home, 'no-existe-orca'), ...extra }
}

function autorizar (home, { jid, nombre, modo, cuenta = CUENTA }) {
  execFileSync(WA_SCOPE, ['set', jid, '--mode', modo, '--provider', 'ninguno'],
    { env: entorno(home), encoding: 'utf8' })
  const con = new DatabaseSync(join(home, '.wa-inbox', 'scope.db'))
  con.prepare('update chat_scope set chat_name=?, account=? where chat_jid=?')
    .run(nombre, cuenta, jid)
  con.close()
}

/** El almacen del panel: el MISMO archivo que lee `wa_settings.plugin_store_raw`. Es
 *  donde vive lo que el usuario acaba de tocar, y no mirarlo es como nacio el defecto
 *  del nombre del agente (scripts/check-clis:revisa_firma_del_panel). */
function escribirPanel (home, datos) {
  const ruta = join(home, 'Library', 'Application Support', 'orca', 'plugins-data',
    `${MANIFIESTO.publisher}.${MANIFIESTO.id}`, 'storage.json')
  mkdirSync(dirname(ruta), { recursive: true })
  writeFileSync(ruta, JSON.stringify(datos), 'utf8')
}

function firmar (home, nombre) {
  execFileSync(WA_SCOPE, ['agent', nombre], { env: entorno(home), encoding: 'utf8' })
}

/** El socket de mentira. No hay red: lo unico que Baileys aporta al envio es
 *  `sendMessage(jid, { text })`, y eso es lo que se reemplaza. */
function socketFalso ({ falla = null } = {}) {
  const enviados = []
  let n = 0
  return {
    enviados,
    async enviar (jid, contenido) {
      if (falla) throw new Error(falla)
      n += 1
      enviados.push({ jid, texto: contenido.text })
      return { key: { id: `STANZA-FALSA-${n}` } }
    }
  }
}

/**
 * Corre el `wa-send` de verdad mientras un sidecar de mentira drena la bandeja de
 * salida. Las dos cosas a la vez, porque eso es justo lo que la CLI exige: es un
 * proceso corto que tiene que salir con un veredicto o con un plazo vencido, nunca
 * colgado.
 */
function correrEnvio (home, args, { almacen = null, socket = null, conectado = true,
  latir = true, env = {} } = {}) {
  return new Promise((resolve) => {
    // El primer latido ANTES de arrancar: `wa-send` mira si hay sidecar vivo antes de
    // encolar nada, y un latido que llega tarde se veria como un sidecar apagado.
    if (almacen && latir) almacen.latir()
    const p = spawn(WA_SEND, args, { env: entorno(home, env) })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => { stdout += d })
    p.stderr.on('data', (d) => { stderr += d })
    let ocupado = false
    const timer = almacen
      ? setInterval(() => {
          if (ocupado) return
          ocupado = true
          if (latir) almacen.latir()
          atenderSalida({ almacen, enviar: socket?.enviar, conectado })
            .catch(() => {})
            .finally(() => { ocupado = false })
        }, 40)
      : null
    p.on('close', (code) => {
      if (timer) clearInterval(timer)
      resolve({ code, stdout, stderr, primera: (stderr.trim().split('\n')[0] || '') })
    })
  })
}

function filasEnvio (home) {
  const con = new DatabaseSync(rutaAlmacen({ HOME: home }))
  const filas = con.prepare('select * from envio order by created_at, rowid').all()
  con.close()
  return filas
}

/** Las filas `draft` de la actividad que nombran un pedido: lo que el panel muestra como
 *  "approve with `wa-send --approve <id>`". */
function borradoresEnActividad (home, reqId) {
  const con = new DatabaseSync(join(home, '.wa-inbox', 'scope.db'))
  const filas = con.prepare("select detail from agent_action where action='draft'").all()
    .filter((f) => String(f.detail ?? '').includes(reqId))
  con.close()
  return filas
}

// ── El lado del sidecar ─────────────────────────────────────────────────────────────
console.log('\nsidecar: la bandeja de salida se toma UNA vez')
{
  const home = nueva()
  const almacen = abrirAlmacen(rutaAlmacen({ HOME: home }))
  almacen.registrarLinea({ cuenta: CUENTA, lid: 'x@lid', pn: 'y@s.whatsapp.net' })
  almacen.encolarEnvio({ reqId: 'R-1', cuenta: CUENTA, chatJid: ALFA,
    chatNombre: 'Cliente Alfa', cuerpo: 'hola', estado: ENVIO.PENDIENTE })

  const socket = socketFalso()
  // Dos drenados a la vez sobre la misma fila: el peor caso real, porque un mensaje
  // repetido a un grupo de un cliente no se retira.
  await Promise.all([
    atenderSalida({ almacen, enviar: socket.enviar }),
    atenderSalida({ almacen, enviar: socket.enviar })
  ])
  ok('una fila pendiente se envia exactamente una vez', socket.enviados.length === 1,
    JSON.stringify(socket.enviados))
  const fila = filasEnvio(home)[0]
  ok('y queda en enviado, con el stanza que contesto WhatsApp',
    fila.estado === ENVIO.ENVIADO && fila.stanza_id === 'STANZA-FALSA-1',
    JSON.stringify(fila))

  // Y un segundo drenado despues no la vuelve a mandar.
  await atenderSalida({ almacen, enviar: socket.enviar })
  ok('un drenado posterior no la reenvia', socket.enviados.length === 1,
    JSON.stringify(socket.enviados))
  almacen.cerrar()
}

console.log('\nsidecar: un borrador NO se envia, y un socket caido no consume la fila')
{
  const home = nueva()
  const almacen = abrirAlmacen(rutaAlmacen({ HOME: home }))
  almacen.encolarEnvio({ reqId: 'R-B', cuenta: CUENTA, chatJid: ALFA,
    chatNombre: 'Cliente Alfa', cuerpo: 'borrador', estado: ENVIO.BORRADOR })
  almacen.encolarEnvio({ reqId: 'R-P', cuenta: CUENTA, chatJid: LAURA,
    chatNombre: 'Laura Mendez', cuerpo: 'pendiente', estado: ENVIO.PENDIENTE })

  const socket = socketFalso()
  await atenderSalida({ almacen, enviar: socket.enviar, conectado: false })
  ok('sin socket vivo no se manda nada', socket.enviados.length === 0)
  ok('y la fila pendiente sigue pendiente, no rechazada',
    filasEnvio(home).find((f) => f.req_id === 'R-P').estado === ENVIO.PENDIENTE)

  await atenderSalida({ almacen, enviar: socket.enviar })
  ok('con el socket vivo sale la pendiente y solo la pendiente',
    socket.enviados.length === 1 && socket.enviados[0].jid === LAURA,
    JSON.stringify(socket.enviados))
  ok('el borrador sigue siendo borrador: esperar aprobacion no es esperar turno',
    filasEnvio(home).find((f) => f.req_id === 'R-B').estado === ENVIO.BORRADOR)
  almacen.cerrar()
}

console.log('\nT9: el socket de un numero no manda lo encolado para otro')
{
  // Cada numero, su linea. Un envio encolado mientras estaba vinculado el numero viejo
  // NO puede salir desde el nuevo: el cliente recibiria un mensaje de un numero que no
  // conoce, firmado como si fuera el de siempre.
  const home = nueva()
  const almacen = abrirAlmacen(rutaAlmacen({ HOME: home }))
  almacen.encolarEnvio({ reqId: 'R-VIEJA', cuenta: 'pn:573001112233', chatJid: ALFA,
    chatNombre: 'Cliente Alfa', cuerpo: 'de la vieja', estado: ENVIO.PENDIENTE })
  almacen.encolarEnvio({ reqId: 'R-NUEVA', cuenta: 'pn:573000000012', chatJid: LAURA,
    chatNombre: 'Laura Mendez', cuerpo: 'de la nueva', estado: ENVIO.PENDIENTE })
  const socket = socketFalso()
  await atenderSalida({ almacen, enviar: socket.enviar, cuenta: 'pn:573000000012' })
  ok('sale solo lo de la linea del socket', socket.enviados.length === 1 &&
    socket.enviados[0].jid === LAURA, JSON.stringify(socket.enviados))
  ok('y lo de la otra linea sigue pendiente, esperando a su numero',
    filasEnvio(home).find((f) => f.req_id === 'R-VIEJA').estado === ENVIO.PENDIENTE)
  // Sin cuenta conocida (emparejando, todavia sin identidad) no se manda nada.
  await atenderSalida({ almacen, enviar: socket.enviar, cuenta: null })
  ok('sin identidad todavia no se manda nada', socket.enviados.length === 1,
    JSON.stringify(socket.enviados))
  almacen.cerrar()
}

console.log('\nsidecar: lo que WhatsApp rechaza queda rechazado, no enviado')
{
  const home = nueva()
  const almacen = abrirAlmacen(rutaAlmacen({ HOME: home }))
  almacen.encolarEnvio({ reqId: 'R-X', cuenta: CUENTA, chatJid: ALFA,
    chatNombre: 'Cliente Alfa', cuerpo: 'hola', estado: ENVIO.PENDIENTE })
  const socket = socketFalso({ falla: 'not-authorized' })
  await atenderSalida({ almacen, enviar: socket.enviar })
  const fila = filasEnvio(home)[0]
  ok('queda rechazado', fila.estado === ENVIO.RECHAZADO, JSON.stringify(fila))
  ok('con motivo, y sin stanza', !!fila.motivo && !fila.stanza_id, JSON.stringify(fila))
  almacen.cerrar()
}

// ── El lado de la CLI ───────────────────────────────────────────────────────────────
console.log('\nwa-send: la escalera de permisos')
{
  const home = nueva()
  firmar(home, 'Agente De Ejemplo')
  const almacen = abrirAlmacen(rutaAlmacen({ HOME: home }))
  almacen.registrarLinea({ cuenta: CUENTA, lid: 'x@lid', pn: 'y@s.whatsapp.net' })
  autorizar(home, { jid: ALFA, nombre: 'Cliente Alfa', modo: 'responder' })
  autorizar(home, { jid: LAURA, nombre: 'Laura Mendez', modo: 'observar' })
  autorizar(home, { jid: CALLADO, nombre: 'Grupo Callado', modo: 'off' })

  const socket = socketFalso()
  const enviado = await correrEnvio(home, ['Cliente Alfa', 'listo', '--send'],
    { almacen, socket })
  ok('responder + --send sale 0', enviado.code === 0, enviado.stderr)
  ok('y el socket recibio exactamente un mensaje, en el jid correcto',
    socket.enviados.length === 1 && socket.enviados[0].jid === ALFA,
    JSON.stringify(socket.enviados))
  ok('firmado con el nombre configurado',
    (socket.enviados[0]?.texto || '').endsWith('\n-- Agente De Ejemplo'),
    JSON.stringify(socket.enviados[0]))

  const observa = await correrEnvio(home, ['Laura Mendez', 'listo', '--send'],
    { almacen, socket })
  ok('observar NO envia', socket.enviados.length === 1, JSON.stringify(socket.enviados))
  ok('y se niega con su propio codigo', observa.primera === 'wa-send: send-denied',
    observa.stderr)
  ok('con salida 3, la misma que la compuerta de wa-scope', observa.code === 3,
    String(observa.code))

  const apagado = await correrEnvio(home, ['Grupo Callado', 'listo', '--send'],
    { almacen, socket })
  ok('off tampoco envia', socket.enviados.length === 1)
  ok('y dice send-denied', apagado.primera === 'wa-send: send-denied', apagado.stderr)

  const ajeno = await correrEnvio(home, ['Grupo Que Nadie Registro', 'listo', '--send'],
    { almacen, socket })
  ok('una conversacion fuera del registro se niega igual: denegar por defecto',
    ajeno.primera === 'wa-send: send-denied' && socket.enviados.length === 1,
    ajeno.stderr)
  almacen.cerrar()
}

console.log('\nT9: wa-send no manda por una autorizacion de otro numero')
{
  // Visto en vivo: tras vincular OTRO numero, las autorizaciones en `responder` del
  // viejo seguian valiendo. Mandar con ellas es escribirle a un cliente desde un numero
  // que nunca autorizo esa conversacion.
  const VIEJA = 'pn:573001112233'
  const NUEVA = 'pn:573000000012'
  const home = nueva()
  firmar(home, 'Agente De Ejemplo')
  const almacen = abrirAlmacen(rutaAlmacen({ HOME: home }))
  almacen.registrarLinea({ cuenta: NUEVA, pn: '573000000012:7@s.whatsapp.net' })
  almacen.activarLinea(NUEVA)
  // El viejo autorizo a Cliente Alfa en la base; el panel de antes dejo a Laura sin
  // cuenta (o sea `local`). Ninguna de las dos es del numero vinculado.
  const scopeDb = new DatabaseSync(join(home, '.wa-inbox', 'scope.db'))
  scopeDb.prepare("insert into chat_scope (account, chat_jid, chat_name, mode, provider) " +
    "values (?,?,?,'responder','ninguno')").run(VIEJA, ALFA, 'Cliente Alfa')
  scopeDb.close()
  escribirPanel(home, { agentName: 'Agente De Ejemplo',
    scope: { [LAURA]: { chatName: 'Laura Mendez', mode: 'responder', provider: 'ninguno' } } })

  const socket = socketFalso()
  const vieja = await correrEnvio(home, ['Cliente Alfa', 'hola', '--send'], { almacen, socket })
  ok('la autorizacion del numero viejo no manda desde el nuevo',
    socket.enviados.length === 0 && vieja.code !== 0, vieja.stderr)
  ok('y lo dice con su propio codigo', vieja.primera === 'wa-send: send-line-not-linked',
    vieja.stderr)
  const legado = await correrEnvio(home, ['Laura Mendez', 'hola', '--send'], { almacen, socket })
  ok('la del panel de antes (sin cuenta) tampoco', socket.enviados.length === 0 &&
    legado.primera === 'wa-send: send-line-not-linked', legado.stderr)
  const pedida = await correrEnvio(home, ['Cliente Alfa', 'hola', '--send', '--line', VIEJA],
    { almacen, socket })
  ok('ni nombrando la linea vieja a proposito', socket.enviados.length === 0 &&
    pedida.primera === 'wa-send: send-line-not-linked', pedida.stderr)

  // Control: autorizada para el numero vinculado, sale.
  const scopeDb2 = new DatabaseSync(join(home, '.wa-inbox', 'scope.db'))
  scopeDb2.prepare("insert into chat_scope (account, chat_jid, chat_name, mode, provider) " +
    "values (?,?,?,'responder','ninguno')").run(NUEVA, CALLADO, 'Grupo Nuevo')
  scopeDb2.close()
  const propia = await correrEnvio(home, ['Grupo Nuevo', 'hola', '--send'], { almacen, socket })
  ok('control: la del numero vinculado si sale', propia.code === 0 &&
    socket.enviados.length === 1 && socket.enviados[0].jid === CALLADO, propia.stderr)
  almacen.cerrar()
}

console.log('\nwa-send: borrador deja un borrador y NO envia, y se aprueba a mano')
{
  const home = nueva()
  firmar(home, 'Agente De Ejemplo')
  const almacen = abrirAlmacen(rutaAlmacen({ HOME: home }))
  almacen.registrarLinea({ cuenta: CUENTA, lid: 'x@lid', pn: 'y@s.whatsapp.net' })
  autorizar(home, { jid: ALFA, nombre: 'Cliente Alfa', modo: 'borrador' })

  const socket = socketFalso()
  const r = await correrEnvio(home, ['Cliente Alfa', 'quedo resuelto', '--send',
    '--id', 'REQ-BORRADOR'], { almacen, socket })
  ok('borrador + --send NO envia', socket.enviados.length === 0,
    JSON.stringify(socket.enviados))
  ok('y lo dice con un codigo propio, no con el de "denegado" a secas',
    r.primera === 'wa-send: send-needs-approval', r.stderr)
  ok('el segundo renglon nombra como se aprueba',
    r.stderr.includes('--approve') && r.stderr.includes('REQ-BORRADOR'), r.stderr)

  const filas = filasEnvio(home)
  ok('quedo una fila en estado borrador',
    filas.length === 1 && filas[0].estado === ENVIO.BORRADOR, JSON.stringify(filas))

  // El dueno lo ve sin abrir la base.
  const listado = await correrEnvio(home, ['--drafts'], {})
  ok('`--drafts` lista el borrador que espera', listado.code === 0 &&
    listado.stdout.includes('REQ-BORRADOR') && listado.stdout.includes('Cliente Alfa'),
  listado.stdout + listado.stderr)

  ok('la actividad anota el borrador con el comando para aprobarlo',
    borradoresEnActividad(home, 'REQ-BORRADOR').length === 1,
  JSON.stringify(borradoresEnActividad(home, 'REQ-BORRADOR')))

  // Y recien con la aprobacion explicita sale.
  const aprobado = await correrEnvio(home, ['--approve', 'REQ-BORRADOR'],
    { almacen, socket })
  ok('aprobado sale 0', aprobado.code === 0, aprobado.stderr)
  ok('y recien ahi se envia, una sola vez', socket.enviados.length === 1,
    JSON.stringify(socket.enviados))
  // Aprobado ya no espera a nadie: una fila que sigue diciendo "approve with" le pide al
  // dueno algo que ya hizo (cli-huecos, C3).
  ok('aprobado no deja la fila de borrador en la actividad',
    borradoresEnActividad(home, 'REQ-BORRADOR').length === 0,
  JSON.stringify(borradoresEnActividad(home, 'REQ-BORRADOR')))

  // Un borrador retirado tampoco: ya no se puede aprobar.
  await correrEnvio(home, ['Cliente Alfa', 'otro texto', '--id', 'REQ-RETIRADO'],
    { almacen, socket })
  const antesDeRetirar = borradoresEnActividad(home, 'REQ-RETIRADO').length
  const retirado = await correrEnvio(home, ['--cancel', 'REQ-RETIRADO'], {})
  ok('retirar un borrador quita su fila de la actividad', retirado.code === 0 &&
    antesDeRetirar === 1 && borradoresEnActividad(home, 'REQ-RETIRADO').length === 0,
  `${antesDeRetirar} antes; ${retirado.stderr}`)

  // Aprobar dos veces no entrega dos veces.
  const otra = await correrEnvio(home, ['--approve', 'REQ-BORRADOR'], { almacen, socket })
  ok('aprobar de nuevo no vuelve a entregar', socket.enviados.length === 1,
    JSON.stringify(socket.enviados))
  ok('y contesta el veredicto que ya habia, sin fallar', otra.code === 0, otra.stderr)
  almacen.cerrar()
}

// ── Jev revisa lo que va a salir ─────────────────────────────────────────────────────
// Con llave, `wa-send --send` en `responder` le pregunta a Jev por el texto. Una
// bandera, un error o un timeout lo dejan como borrador para el dueno y dicen por que;
// nunca al reves. Sin llave manda el modo, como siempre. Jev es un servidor de mentira
// en 127.0.0.1: la API real no se toca, y la llave es de prueba.
const LLAVE_JEV = 'tsk-prueba-0000000000000000'

function ponerLlave (home, texto = `# wa-inbox jev mirror v1\nTYPESAFE_API_KEY=${LLAVE_JEV}\n`) {
  writeFileSync(join(home, '.wa-inbox', 'jev.env'), texto, 'utf8')
}

/** Un Jev local: `decide(cuerpo)` devuelve `[estado, respuesta]`. */
async function jevFalso (decide) {
  const pedidos = []
  const server = createServer((req, res) => {
    let datos = ''
    req.on('data', (d) => { datos += d })
    req.on('end', () => {
      const cuerpo = JSON.parse(datos)
      pedidos.push({ cuerpo, auth: req.headers.authorization })
      const [estado, respuesta] = decide(cuerpo)
      res.writeHead(estado, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(respuesta))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/v1/systemone`
  return { pedidos, env: { WA_INBOX_JEV_ENDPOINT: url }, cerrar: () => server.close() }
}

function jevDice (noul = {}) {
  return (cuerpo) => [200, { model: 'jev-9.9.9', answers: Object.fromEntries(
    Object.keys(cuerpo.questions).map((q) => [q, { type: 'noul', noul: noul[q] ?? 0.05 }])) }]
}

function bitacora (home) {
  const con = new DatabaseSync(join(home, '.wa-inbox', 'scope.db'))
  const filas = con.prepare('select action, detail from agent_action order by id').all()
  con.close()
  return filas
}

function casaConJev () {
  const home = nueva()
  firmar(home, 'Agente De Ejemplo')
  const almacen = abrirAlmacen(rutaAlmacen({ HOME: home }))
  almacen.registrarLinea({ cuenta: CUENTA, lid: 'x@lid', pn: 'y@s.whatsapp.net' })
  autorizar(home, { jid: ALFA, nombre: 'Cliente Alfa', modo: 'responder' })
  return { home, almacen }
}

console.log('\nwa-send: con llave, Jev revisa antes de enviar')
{
  const jev = await jevFalso(jevDice())
  const { home, almacen } = casaConJev()
  ponerLlave(home)
  const socket = socketFalso()
  const r = await correrEnvio(home, ['Cliente Alfa', 'Tomo esto', '--send'],
    { almacen, socket, env: jev.env })
  ok('un texto limpio sale', r.code === 0 && socket.enviados.length === 1, r.stderr)
  ok('despues de UNA pregunta a Jev, con la llave y las tres preguntas del borrador',
    jev.pedidos.length === 1 && jev.pedidos[0].auth === `Bearer ${LLAVE_JEV}` &&
    JSON.stringify(Object.keys(jev.pedidos[0].cuerpo.questions).sort()) ===
      JSON.stringify(['contains_credential', 'promises_a_date', 'states_status_not_verified']),
    JSON.stringify(jev.pedidos.map((p) => Object.keys(p.cuerpo.questions))))
  ok('la llave no aparece en la salida', !(r.stdout + r.stderr).includes(LLAVE_JEV))
  almacen.cerrar()
  jev.cerrar()
}
{
  const jev = await jevFalso(jevDice({ promises_a_date: 0.9 }))
  const { home, almacen } = casaConJev()
  ponerLlave(home)
  const socket = socketFalso()
  const r = await correrEnvio(home, ['Cliente Alfa', 'Manana te confirmamos', '--send',
    '--id', 'REQ-JEV'], { almacen, socket, env: jev.env })
  ok('una fecha prometida NO sale', socket.enviados.length === 0, JSON.stringify(socket.enviados))
  ok('queda como borrador para el dueno', r.primera === 'wa-send: send-needs-approval' &&
    r.code === 3 && filasEnvio(home)[0]?.estado === ENVIO.BORRADOR, r.stderr)
  ok('y dice por que: lo freno Jev, con la pregunta', r.stderr.includes('promises_a_date'),
    r.stderr)
  ok('la bitacora del borrador tambien dice por que',
    bitacora(home).some((f) => f.action === 'draft' && f.detail.includes('promises_a_date')),
    JSON.stringify(bitacora(home)))
  almacen.cerrar()
  jev.cerrar()
}
{
  const jev = await jevFalso(() => [500, { error: 'boom' }])
  const { home, almacen } = casaConJev()
  ponerLlave(home)
  const socket = socketFalso()
  const r = await correrEnvio(home, ['Cliente Alfa', 'Tomo esto', '--send'],
    { almacen, socket, env: jev.env })
  ok('con Jev en error NO sale: falla cerrado', socket.enviados.length === 0 &&
    r.primera === 'wa-send: send-needs-approval', r.stderr)
  ok('y dice que Jev no contesto', r.stderr.includes('jev-unavailable'), r.stderr)
  almacen.cerrar()
  jev.cerrar()
}
{
  const jev = await jevFalso(jevDice({ promises_a_date: 0.9 }))
  const { home, almacen } = casaConJev()
  ponerLlave(home, `TYPESAFE_API_KEY=${LLAVE_JEV}\n`)
  const socket = socketFalso()
  const r = await correrEnvio(home, ['Cliente Alfa', 'Tomo esto', '--send'],
    { almacen, socket, env: jev.env })
  ok('sin la cabecera del espejo no hay llave: manda el modo, como hoy',
    r.code === 0 && socket.enviados.length === 1 && jev.pedidos.length === 0, r.stderr)
  almacen.cerrar()
  jev.cerrar()
}
{
  const jev = await jevFalso(jevDice({ promises_a_date: 0.9 }))
  const { home, almacen } = casaConJev()
  ponerLlave(home)
  autorizar(home, { jid: LAURA, nombre: 'Laura Mendez', modo: 'borrador' })
  const socket = socketFalso()
  const r = await correrEnvio(home, ['Laura Mendez', 'Manana te confirmamos', '--send',
    '--id', 'REQ-B'], { almacen, socket, env: jev.env })
  ok('en borrador no hace falta preguntar: ya espera al dueno',
    socket.enviados.length === 0 && jev.pedidos.length === 0 &&
    r.primera === 'wa-send: send-needs-approval', r.stderr)
  const aprobado = await correrEnvio(home, ['--approve', 'REQ-B'],
    { almacen, socket, env: jev.env })
  ok('y la aprobacion del dueno lo envia sin pasar por Jev',
    aprobado.code === 0 && socket.enviados.length === 1 && jev.pedidos.length === 0,
    aprobado.stderr)
  almacen.cerrar()
  jev.cerrar()
}

// ── El piso fijo (T19): dinero, credenciales y compromisos, con o sin Jev ───────────
console.log('\nwa-send: el piso fijo frena lo que es del dueno, sin llave de Jev')
{
  const { home, almacen } = casaConJev()
  const socket = socketFalso()
  const precio = await correrEnvio(home, ['Cliente Alfa', 'el precio es $1.400', '--send',
    '--id', 'REQ-PRECIO'], { almacen, socket })
  ok('un precio NO sale sin el dueno, aunque no haya llave', socket.enviados.length === 0,
    JSON.stringify(socket.enviados))
  ok('queda como borrador, con el codigo de siempre',
    precio.primera === 'wa-send: send-needs-approval' && precio.code === 3 &&
    filasEnvio(home)[0]?.estado === ENVIO.BORRADOR, precio.stderr)
  ok('y dice por que: la regla fija, con la excepcion', precio.stderr.includes('money') &&
    precio.stderr.includes('--approve REQ-PRECIO'), precio.stderr)
  ok('la bitacora del borrador tambien lo dice',
    bitacora(home).some((f) => f.action === 'draft' && f.detail.includes('money') &&
      f.detail.includes('REQ-PRECIO')), JSON.stringify(bitacora(home)))
  ok('y no copia el texto en la bitacora',
    !bitacora(home).some((f) => f.detail.includes('1.400')), JSON.stringify(bitacora(home)))

  const limpio = await correrEnvio(home, ['Cliente Alfa', 'hola, ya lo revisamos', '--send'],
    { almacen, socket })
  ok('lo limpio sigue saliendo', limpio.code === 0 && socket.enviados.length === 1,
    limpio.stderr)

  const promesa = await correrEnvio(home, ['Cliente Alfa', 'Queda listo el viernes', '--send'],
    { almacen, socket })
  ok('una fecha prometida tampoco sale', socket.enviados.length === 1 &&
    promesa.primera === 'wa-send: send-needs-approval' &&
    promesa.stderr.includes('commitment'), promesa.stderr)

  const aprobado = await correrEnvio(home, ['--approve', 'REQ-PRECIO'], { almacen, socket })
  ok('el dueno es la compuerta: su aprobacion lo envia', aprobado.code === 0 &&
    socket.enviados.length === 2 && socket.enviados[1].texto.startsWith('el precio es $1.400'),
  aprobado.stderr + JSON.stringify(socket.enviados))
  almacen.cerrar()
}
{
  // Jev dice que no hay nada: el piso igual frena. Jev solo suma.
  const jev = await jevFalso(jevDice())
  const { home, almacen } = casaConJev()
  ponerLlave(home)
  const socket = socketFalso()
  const r = await correrEnvio(home, ['Cliente Alfa', 'el precio es $1.400', '--send'],
    { almacen, socket, env: jev.env })
  ok('con Jev limpio, el piso igual lo deja para el dueno',
    socket.enviados.length === 0 && r.primera === 'wa-send: send-needs-approval' &&
    r.stderr.includes('money'), r.stderr)
  almacen.cerrar()
  jev.cerrar()
}
{
  // El nombre del agente no cuenta: la firma la pone la herramienta, no la respuesta.
  const home = nueva()
  firmar(home, 'Pago Rapido Hoy')
  const almacen = abrirAlmacen(rutaAlmacen({ HOME: home }))
  almacen.registrarLinea({ cuenta: CUENTA, lid: 'x@lid', pn: 'y@s.whatsapp.net' })
  autorizar(home, { jid: ALFA, nombre: 'Cliente Alfa', modo: 'responder' })
  const socket = socketFalso()
  const r = await correrEnvio(home, ['Cliente Alfa', 'hola, ya lo revisamos', '--send'],
    { almacen, socket })
  ok('la firma del agente no dispara el piso', r.code === 0 && socket.enviados.length === 1,
    r.stderr)
  almacen.cerrar()
}

// ── Los niveles por chat (T22.3) ──────────────────────────────────────────────────────
console.log('\nwa-send: cada chat decide sus niveles, y el secreto se frena siempre')
{
  const jev = await jevFalso((cuerpo) => {
    const texto = cuerpo.state.reply_to_review || ''
    return jevDice({
      promises_a_date: texto.includes('viernes') ? 0.9 : 0.05,
      states_status_not_verified: texto.includes('escuchado') ? 0.9 : 0.05
    })(cuerpo)
  })
  const { home, almacen } = casaConJev()
  ponerLlave(home)
  execFileSync(WA_SCOPE, ['set', ALFA, '--approval', 'money=allow', '--approval',
    'credential=allow', '--approval', 'quality=allow', '--approval', 'commitment=allow'],
  { env: entorno(home), encoding: 'utf8' })
  const socket = socketFalso()
  const precio = await correrEnvio(home, ['Cliente Alfa', 'el precio es $1.400', '--send'],
    { almacen, socket, env: jev.env })
  ok('dinero en Permitir sale', precio.code === 0 && socket.enviados.length === 1, precio.stderr)
  const fecha = await correrEnvio(home, ['Cliente Alfa', 'Queda listo el viernes', '--send'],
    { almacen, socket, env: jev.env })
  ok('compromiso en Permitir sale, aunque Jev marque la fecha',
    fecha.code === 0 && socket.enviados.length === 2, fecha.stderr)
  const calidad = await correrEnvio(home, ['Cliente Alfa', 'Su audio fue escuchado', '--send'],
    { almacen, socket, env: jev.env })
  ok('calidad en Permitir sale, aunque Jev la marque',
    calidad.code === 0 && socket.enviados.length === 3, calidad.stderr)
  const nombra = await correrEnvio(home, ['Cliente Alfa', 'te mando la clave por otro medio',
    '--send'], { almacen, socket, env: jev.env })
  ok('nombrar una clave con la credencial en Permitir sale',
    nombra.code === 0 && socket.enviados.length === 4, nombra.stderr)
  const secreto = await correrEnvio(home, ['Cliente Alfa', 'la clave: Abc12345', '--send',
    '--id', 'REQ-SECRETO'], { almacen, socket, env: jev.env })
  ok('un valor con forma de secreto NO sale, aunque todo este en Permitir',
    socket.enviados.length === 4 && secreto.primera === 'wa-send: send-needs-approval' &&
    secreto.stderr.includes('rule: secret'), secreto.stderr)
  ok('y no copia el secreto en la bitacora',
    !bitacora(home).some((f) => f.detail.includes('Abc12345')), JSON.stringify(bitacora(home)))
  almacen.cerrar()
  jev.cerrar()
}
{
  const jev = await jevFalso((cuerpo) => jevDice({
    states_status_not_verified: (cuerpo.state.reply_to_review || '').includes('Tomo') ? 0.9 : 0.05
  })(cuerpo))
  const { home, almacen } = casaConJev()
  ponerLlave(home)
  // Lo que el panel guarda manda sobre la base, como el modo.
  escribirPanel(home, { agentName: 'Agente De Ejemplo',
    scope: { [ALFA]: { chatName: 'Cliente Alfa', mode: 'responder', provider: 'ninguno',
      approval: { money: 'agent', quality: 'ask' } } } })
  const socket = socketFalso()
  const precio = await correrEnvio(home, ['Cliente Alfa', 'el precio es $1.400', '--send'],
    { almacen, socket, env: jev.env })
  ok('dinero en Que el agente lo revise: no sale y dice que lo reescriba el agente',
    socket.enviados.length === 0 && precio.primera === 'wa-send: send-needs-approval' &&
    precio.stderr.includes('rule: money') && precio.stderr.includes('rewrite'), precio.stderr)
  const calidad = await correrEnvio(home, ['Cliente Alfa', 'Tomo esto', '--send'],
    { almacen, socket, env: jev.env })
  ok('calidad en Preguntarme (desde el panel): no sale, y espera al dueno',
    socket.enviados.length === 0 && calidad.primera === 'wa-send: send-needs-approval' &&
    calidad.stderr.includes('states_status_not_verified') &&
    !calidad.stderr.includes('rewrite'), calidad.stderr)
  almacen.cerrar()
  jev.cerrar()
}

// ── El chat del dueno (T22.1) ────────────────────────────────────────────────────────
console.log('\nwa-send: al chat del dueno no lo frenan las reglas ni Jev, solo un secreto')
{
  const DUENO = '100000000000001@lid'
  const jev = await jevFalso(jevDice({ states_status_not_verified: 0.9, promises_a_date: 0.9 }))
  const { home, almacen } = casaConJev()
  ponerLlave(home)
  autorizar(home, { jid: DUENO, nombre: 'Dueno Directo', modo: 'responder' })
  autorizar(home, { jid: 'x@lid', nombre: 'Yo Mismo', modo: 'responder' })
  escribirPanel(home, { agentName: 'Agente De Ejemplo',
    owners: [{ id: '100000000000001:3@lid', name: 'Dueno Real' }] })
  const socket = socketFalso()
  const aviso = await correrEnvio(home, ['Dueno Directo',
    'Aviso: el informe quedo verificado, cuesta $50 y sale el viernes', '--send'],
  { almacen, socket, env: jev.env })
  ok('un aviso al chat de un numero del dueno sale', aviso.code === 0 &&
    socket.enviados.length === 1 && socket.enviados[0].jid === DUENO, aviso.stderr)
  const propio = await correrEnvio(home, ['Yo Mismo', 'Aviso: tarea lista y verificada',
    '--send'], { almacen, socket, env: jev.env })
  ok('y uno al chat de la linea consigo misma tambien', propio.code === 0 &&
    socket.enviados.length === 2, propio.stderr)
  ok('sin preguntarle a Jev por ninguno', jev.pedidos.length === 0,
    JSON.stringify(jev.pedidos.map((p) => p.cuerpo.state)))
  const secreto = await correrEnvio(home, ['Dueno Directo', 'la clave: Abc12345', '--send'],
    { almacen, socket, env: jev.env })
  ok('un secreto al chat del dueno igual se frena', socket.enviados.length === 2 &&
    secreto.primera === 'wa-send: send-needs-approval' &&
    secreto.stderr.includes('rule: secret'), secreto.stderr)
  const ajeno = await correrEnvio(home, ['Cliente Alfa', 'Aviso: tarea lista y verificada',
    '--send'], { almacen, socket, env: jev.env })
  ok('a cualquier otro chat Jev sigue revisando', socket.enviados.length === 2 &&
    ajeno.primera === 'wa-send: send-needs-approval' && jev.pedidos.length === 1, ajeno.stderr)
  almacen.cerrar()
  jev.cerrar()
}

console.log('\nwa-send: Jev juzga el borrador con el tono del chat (T22.5)')
{
  const jev = await jevFalso(jevDice())
  const { home, almacen } = casaConJev()
  ponerLlave(home)
  execFileSync(WA_SCOPE, ['set', ALFA, '--tone', 'Cercano, tutea, frases cortas'],
    { env: entorno(home), encoding: 'utf8' })
  autorizar(home, { jid: LAURA, nombre: 'Laura Mendez', modo: 'responder' })
  execFileSync(WA_SCOPE, ['config', 'tone', 'Formal y de usted, sin emojis'],
    { env: entorno(home), encoding: 'utf8' })
  const socket = socketFalso()
  await correrEnvio(home, ['Cliente Alfa', 'Hola, ya quedo', '--send'], { almacen, socket, env: jev.env })
  await correrEnvio(home, ['Laura Mendez', 'Hola, ya quedo', '--send'], { almacen, socket, env: jev.env })
  const registros = jev.pedidos.map((p) => p.cuerpo.state.expected_register)
  ok('con el tono de la conversacion, y sin el, el global',
    registros[0] === 'Cercano, tutea, frases cortas' &&
    registros[1] === 'Formal y de usted, sin emojis', JSON.stringify(registros))
  almacen.cerrar()
  jev.cerrar()
}

console.log('\nwa-send: sin nombre de agente no se envia, ni siquiera en responder')
{
  const home = nueva()
  const almacen = abrirAlmacen(rutaAlmacen({ HOME: home }))
  almacen.registrarLinea({ cuenta: CUENTA, lid: 'x@lid', pn: 'y@s.whatsapp.net' })
  autorizar(home, { jid: ALFA, nombre: 'Cliente Alfa', modo: 'responder' })
  const socket = socketFalso()
  const r = await correrEnvio(home, ['Cliente Alfa', 'listo', '--send'],
    { almacen, socket })
  ok('se bloquea, no se advierte', r.code !== 0 && socket.enviados.length === 0,
    `${r.code} · ${JSON.stringify(socket.enviados)}`)
  ok('y el motivo es la firma, antes que cualquier otra cosa',
    r.stderr.includes('no agent name is configured'), r.stderr)
  ok('ni se encolo nada', filasEnvio(home).length === 0)
  almacen.cerrar()
}

console.log('\nwa-send: el sidecar caido es un motivo DISTINTO de un envio rechazado')
{
  const home = nueva()
  firmar(home, 'Agente De Ejemplo')
  const almacen = abrirAlmacen(rutaAlmacen({ HOME: home }))
  almacen.registrarLinea({ cuenta: CUENTA, lid: 'x@lid', pn: 'y@s.whatsapp.net' })
  autorizar(home, { jid: ALFA, nombre: 'Cliente Alfa', modo: 'responder' })

  // Nadie late: el sidecar no esta corriendo. No se encola nada y se dice por que.
  const caido = await correrEnvio(home, ['Cliente Alfa', 'listo', '--send'], {})
  ok('sin sidecar vivo se niega con send-no-transport',
    caido.primera === 'wa-send: send-no-transport', caido.stderr)
  ok('con salida 4, la misma que `wa-read` sin linea', caido.code === 4,
    String(caido.code))
  ok('y no deja la peticion encolada esperando a nadie', filasEnvio(home).length === 0,
    JSON.stringify(filasEnvio(home)))

  // Con el sidecar vivo pero WhatsApp negandose, el codigo es OTRO.
  const socket = socketFalso({ falla: 'not-authorized' })
  const rechazado = await correrEnvio(home, ['Cliente Alfa', 'listo', '--send'],
    { almacen, socket })
  ok('un envio rechazado dice send-rejected',
    rechazado.primera === 'wa-send: send-rejected', rechazado.stderr)
  ok('los dos codigos son distintos: la accion del dueno no es la misma',
    caido.primera !== rechazado.primera)
  almacen.cerrar()
}

console.log('\nwa-send: el MISMO --id entrega una sola vez')
{
  const home = nueva()
  firmar(home, 'Agente De Ejemplo')
  const almacen = abrirAlmacen(rutaAlmacen({ HOME: home }))
  almacen.registrarLinea({ cuenta: CUENTA, lid: 'x@lid', pn: 'y@s.whatsapp.net' })
  autorizar(home, { jid: ALFA, nombre: 'Cliente Alfa', modo: 'responder' })
  const socket = socketFalso()

  const uno = await correrEnvio(home,
    ['Cliente Alfa', 'reporte listo', '--send', '--id', 'REQ-42'], { almacen, socket })
  const dos = await correrEnvio(home,
    ['Cliente Alfa', 'reporte listo', '--send', '--id', 'REQ-42'], { almacen, socket })
  ok('los dos salen 0', uno.code === 0 && dos.code === 0, uno.stderr + dos.stderr)
  ok('pero el cliente recibio UNO', socket.enviados.length === 1,
    JSON.stringify(socket.enviados))
  ok('y quedo una sola fila', filasEnvio(home).length === 1,
    JSON.stringify(filasEnvio(home)))
  almacen.cerrar()
}

console.log('\nwa-send: el orden de las negativas no cambia')
{
  const home = nueva()
  firmar(home, 'Agente De Ejemplo')
  const almacen = abrirAlmacen(rutaAlmacen({ HOME: home }))
  almacen.registrarLinea({ cuenta: CUENTA, lid: 'x@lid', pn: 'y@s.whatsapp.net' })
  // La MISMA conversacion en dos lineas propias, las dos en responder: la ambiguedad
  // se rechaza igual. Elegir "la primera" le escribe a la conversacion equivocada, y
  // eso no se deshace ni con el permiso mas alto.
  const con = new DatabaseSync(join(home, '.wa-inbox', 'scope.db'))
  execFileSync(WA_SCOPE, ['config', '--json'], { env: entorno(home), encoding: 'utf8' })
  for (const cuenta of ['linea-uno', 'linea-dos']) {
    con.prepare('insert or replace into chat_scope (account, chat_jid, chat_name, mode) ' +
      'values (?,?,?,?)').run(cuenta, ALFA, 'Grupo En Dos Lineas', 'responder')
  }
  con.close()
  const socket = socketFalso()

  const ambigua = await correrEnvio(home, ['Grupo En Dos Lineas', 'hola', '--send'],
    { almacen, socket })
  ok('la ambiguedad se rechaza antes que el permiso y antes que el transporte',
    ambigua.primera === 'wa-send: send-ambiguous-line', ambigua.stderr)
  ok('y no mando nada', socket.enviados.length === 0)

  const equivocada = await correrEnvio(home,
    ['Grupo En Dos Lineas', 'hola', '--send', '--line', 'linea-tres'], { almacen, socket })
  ok('una linea ajena a la conversacion se rechaza con su propio codigo',
    equivocada.primera === 'wa-send: send-wrong-line', equivocada.stderr)

  const resuelta = await correrEnvio(home,
    ['Grupo En Dos Lineas', 'hola', '--send', '--line', 'linea-uno'], { almacen, socket })
  ok('con la linea dicha, se envia por ESA linea', resuelta.code === 0,
    resuelta.stderr)
  ok('y salio una sola vez', socket.enviados.length === 1,
    JSON.stringify(socket.enviados))
  almacen.cerrar()
}

console.log('\nwa-send: el permiso puesto DESDE EL PANEL tambien manda')
{
  // Es el defecto del nombre del agente otra vez: el panel guarda en el almacen del
  // plugin, no en el sqlite. Un `responder` puesto ahi que wa-send no viera dejaria al
  // agente negandose sobre una conversacion que la pantalla muestra autorizada.
  const home = nueva()
  firmar(home, 'Agente De Ejemplo')
  const almacen = abrirAlmacen(rutaAlmacen({ HOME: home }))
  almacen.registrarLinea({ cuenta: CUENTA, lid: 'x@lid', pn: 'y@s.whatsapp.net' })
  autorizar(home, { jid: DESDE_EL_PANEL, nombre: 'Cliente Del Panel', modo: 'off' })
  escribirPanel(home, { agentName: 'Agente De Ejemplo',
    scope: { [DESDE_EL_PANEL]: { chatName: 'Cliente Del Panel', mode: 'responder',
      provider: 'ninguno' } } })

  const socket = socketFalso()
  const r = await correrEnvio(home, ['Cliente Del Panel', 'listo', '--send'],
    { almacen, socket })
  ok('el modo del panel manda sobre el de la base', r.code === 0, r.stderr)
  ok('y el mensaje salio', socket.enviados.length === 1, JSON.stringify(socket.enviados))
  almacen.cerrar()
}

console.log('\nel latido tiene un plazo, y es el mismo de los dos lados')
{
  ok('el sidecar publica cada cuanto vence su latido',
    Number.isFinite(LATIDO_VENCE_MS) && LATIDO_VENCE_MS >= 5000, String(LATIDO_VENCE_MS))
}

for (const home of casas) rmSync(home, { recursive: true, force: true })

console.log(`\n${pruebas - fallos}/${pruebas} en verde`)
process.exit(fallos ? 1 : 0)
