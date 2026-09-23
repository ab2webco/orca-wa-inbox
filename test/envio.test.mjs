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

function entorno (home) {
  return { ...process.env, HOME: home, ORCA_CLI_COMMAND: join(home, 'no-existe-orca') }
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
  latir = true } = {}) {
  return new Promise((resolve) => {
    // El primer latido ANTES de arrancar: `wa-send` mira si hay sidecar vivo antes de
    // encolar nada, y un latido que llega tarde se veria como un sidecar apagado.
    if (almacen && latir) almacen.latir()
    const p = spawn(WA_SEND, args, { env: entorno(home) })
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

  // Y recien con la aprobacion explicita sale.
  const aprobado = await correrEnvio(home, ['--approve', 'REQ-BORRADOR'],
    { almacen, socket })
  ok('aprobado sale 0', aprobado.code === 0, aprobado.stderr)
  ok('y recien ahi se envia, una sola vez', socket.enviados.length === 1,
    JSON.stringify(socket.enviados))

  // Aprobar dos veces no entrega dos veces.
  const otra = await correrEnvio(home, ['--approve', 'REQ-BORRADOR'], { almacen, socket })
  ok('aprobar de nuevo no vuelve a entregar', socket.enviados.length === 1,
    JSON.stringify(socket.enviados))
  ok('y contesta el veredicto que ya habia, sin fallar', otra.code === 0, otra.stderr)
  almacen.cerrar()
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
