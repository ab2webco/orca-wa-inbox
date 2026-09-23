#!/usr/bin/env node
/**
 * Ejercita el worker: activate(), el sync automatico y el pedido que deja el panel.
 *
 * Existe porque el defecto que motivo todo esto no se ve en ningun otro chequeo. El
 * sync fallaba callado — run() se tragaba el error y solo quedaba un orca.log que
 * nadie mira — y el panel se quedaba diciendo "Buscando tus conversaciones…" para
 * siempre. Un camino de falla que ninguna prueba recorre es un camino que nadie sabe
 * si existe, asi que aca se recorre: se le apunta el directorio de herramientas a algo
 * que no puede correr y se comprueba que el motivo llegue al storage que lee el panel.
 *
 * Y el arnes: los archivos que el worker siembra en la carpeta de trabajo del plugin.
 * Esa rama escribe en disco, asi que se recorre entera con un HOME temporal — la
 * siembra, la segunda activacion, y que una edicion del usuario sobreviva.
 *
 * Nada de esto toca WhatsApp ni la base del usuario: las herramientas son guiones
 * falsos en un directorio temporal y el host es un objeto en memoria.
 *
 * Y el sidecar (T3): que `activate()` lo lance con un guion de mentira, que su
 * protocolo JSON-lines llegue a storage con el `ts` del QR, y que una caida — o un
 * arranque que nunca llega a hablar — deje un CODIGO ESTABLE y no texto libre. Mismo
 * principio que el sync: un camino de falla que ninguna prueba recorre es un camino
 * que nadie sabe si existe.
 */
import { mandoSinValla } from '../main.mjs'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile as execFileNode } from 'node:child_process'
import { EventEmitter } from 'node:events'

const RAIZ = mkdtempSync(join(tmpdir(), 'wa-inbox-worker-'))

// ANTES de activar nada: al activarse el worker siembra el arnes en el userData de
// Orca, y con el HOME de verdad una prueba le escribiria en la carpeta al usuario.
process.env.HOME = join(RAIZ, 'home')
process.env.XDG_CONFIG_HOME = join(RAIZ, 'home', '.config')
process.env.APPDATA = join(RAIZ, 'home', 'AppData', 'Roaming')
for (const base of [join(process.env.HOME, 'Library', 'Application Support'),
  process.env.XDG_CONFIG_HOME, process.env.APPDATA]) {
  mkdirSync(join(base, 'orca'), { recursive: true })
}

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

const { default: activate, intervaloSync, lanzarSidecar } = await import('../main.mjs')
const { workspaceDir, dataDir } = await import('../harness.mjs')

// Un sidecar de mentira para TODO el resto de las pruebas de este archivo: sin esto
// `activate()` lanzaria el bundle real de Baileys -3,4 MB, un socket de verdad- en
// cada una de las pruebas que no tienen nada que ver con el sidecar. Sale con 0 y no
// dice nada: exactamente el "nunca llego a hablar" que una de las pruebas de abajo
// comprueba que se reporte con un codigo estable.
const SIDECAR_STUB = join(RAIZ, 'sidecar-stub.cjs')
writeFileSync(SIDECAR_STUB, '#!/usr/bin/env node\nprocess.exit(0)\n', { mode: 0o755 })

let fallos = 0
let pruebas = 0

function ok (nombre, condicion, detalle = '') {
  pruebas += 1
  if (condicion) return console.log(`  ok    ${nombre}`)
  fallos += 1
  console.log(`  FALLA ${nombre}${detalle ? ` — ${detalle}` : ''}`)
}

/** Un directorio de herramientas con el wa-scope que pida cada caso. */
function herramientas (nombre, guion, modo = 0o755) {
  const dir = join(RAIZ, nombre)
  mkdirSync(dir, { recursive: true })
  if (guion !== null) writeFileSync(join(dir, 'wa-scope'), guion, { mode: modo })
  return dir
}

/** El host, en memoria: responde storage y settings como Orca.
 *
 *  `sidecarPath` por defecto es el guion de mentira de arriba: las pruebas que
 *  quieren un sidecar de verdad -las de esta rebanada- pasan el suyo. */
function hostFalso (toolsDir, store = {}, sidecarPath = SIDECAR_STUB) {
  const logs = []
  const avisos = []
  return {
    store,
    logs,
    avisos,
    log: (m) => logs.push(String(m)),
    host: {
      call: async (action, params) => {
        if (action === 'storage.get') return { value: store[params.key] }
        if (action === 'storage.set') { store[params.key] = params.value; return { ok: true } }
        if (action === 'settings.get') return { value: { toolsDir, sidecarPath } }
        if (action === 'settings.set') return { ok: true }
        if (action === 'notifications.show') { avisos.push(params); return { ok: true } }
        throw new Error(`accion no soportada: ${action}`)
      }
    },
    commands: { register () {} },
    events: { on () {} }
  }
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

async function hasta (condicion, limiteMs = 15000) {
  const fin = Date.now() + limiteMs
  while (Date.now() < fin) {
    if (condicion()) return true
    await dormir(100)
  }
  return false
}

/** Activa el plugin, espera a que el primer sync termine y devuelve el apagado. */
async function arranca (orca) {
  const apagar = activate(orca)
  const listo = await hasta(() => orca.store.syncStatus && !orca.store.syncStatus.running)
  return { apagar, listo }
}

// ───────── el sync deja escrito que fallo, y por que ─────────
console.log('\nworker: el sync que falla lo dice')
{
  // Nada que ejecutar: es el caso del entorno recortado del worker, donde el CLI no
  // esta donde el plugin cree. Antes esto no dejaba rastro ninguno.
  const orca = hostFalso(herramientas('vacio', null))
  const { apagar, listo } = await arranca(orca)
  const e = orca.store.syncStatus
  ok('escribe el estado aunque no haya nada que correr', listo && !!e)
  ok('el estado dice que fallo', e && e.ok === false, JSON.stringify(e))
  ok('el motivo es que no pudo ejecutar las herramientas',
    e && e.reason === 'sin-herramientas', `reason = ${e && e.reason}`)
  ok('guarda la causa real, no solo que fallo',
    e && /ENOENT/.test(e.detail || ''), `detail = ${e && e.detail}`)
  // El log del worker es para quien depura, no para el usuario: va en ingles como el
  // resto de lo que no se puede traducir. Lo que se comprueba es que el motivo quede
  // escrito, no en que idioma.
  ok('deja rastro en el log del plugin',
    orca.logs.some((l) => l.includes('sync failed') && l.includes('sin-herramientas')),
    JSON.stringify(orca.logs))
  apagar()
}

{
  const orca = hostFalso(herramientas('sin-permiso', '#!/bin/sh\necho hola\n', 0o644))
  const { apagar } = await arranca(orca)
  const e = orca.store.syncStatus
  ok('un binario sin permiso de ejecucion se distingue de uno que no esta',
    e && e.reason === 'sin-permiso', `reason = ${e && e.reason}`)
  apagar()
}

{
  // El caso que ya se pago una vez: un NameError en un CLI. La primera linea del
  // stderr es el encabezado del traceback; lo que sirve es la ultima.
  const guion = '#!/usr/bin/env python3\n' +
    'import sys\n' +
    'sys.stderr.write("Traceback (most recent call last):\\n")\n' +
    'sys.stderr.write("  File \\"wa-scope\\", line 1\\n")\n' +
    'sys.stderr.write("NameError: name \'plugin_store_path\' is not defined\\n")\n' +
    'sys.exit(1)\n'
  const orca = hostFalso(herramientas('revienta', guion))
  const { apagar } = await arranca(orca)
  const e = orca.store.syncStatus
  ok('un CLI que revienta queda como fallo', e && e.ok === false && e.reason === 'fallo',
    JSON.stringify(e))
  ok('guarda el codigo de salida', e && e.exitCode === 1, `exitCode = ${e && e.exitCode}`)
  ok('la causa que guarda es la linea util del traceback, no el encabezado',
    e && /NameError/.test(e.detail || ''), `detail = ${e && e.detail}`)
  apagar()
}

// ───────── el sync que anda ─────────
console.log('\nworker: el sync que anda')
const BUENO = '#!/bin/sh\necho \'[{"synced": true, "destinos": []}]\'\n'
{
  const orca = hostFalso(herramientas('bueno', BUENO), {
    chats: [{ jid: '1@g.us', name: 'Soporte' }, { jid: '2@g.us', name: 'Ops' }]
  })
  const { apagar } = await arranca(orca)
  const e = orca.store.syncStatus
  ok('un sync bueno queda en ok', e && e.ok === true, JSON.stringify(e))
  ok('cuenta las conversaciones que quedaron a la vista', e && e.chats === 2,
    `chats = ${e && e.chats}`)
  ok('dice que lo disparo la activacion', e && e.trigger === 'activate',
    `trigger = ${e && e.trigger}`)
  apagar()
}

{
  // Sync bueno y cero conversaciones: el plugin anda y aun asi no hay nada. El panel
  // tiene que decir otra cosa, asi que el estado tiene que poder distinguirlo.
  const orca = hostFalso(herramientas('bueno', BUENO), { chats: [] })
  const { apagar } = await arranca(orca)
  const e = orca.store.syncStatus
  ok('un sync bueno sin conversaciones no se disfraza de error',
    e && e.ok === true && e.chats === 0, JSON.stringify(e))
  apagar()
}

// ───────── el pedido del panel ─────────
console.log('\nworker: el boton del panel')
{
  const orca = hostFalso(herramientas('bueno', BUENO), { chats: [] })
  const { apagar } = await arranca(orca)
  const antes = orca.store.syncStatus.at

  orca.store.syncRequest = { at: new Date().toISOString() }
  const atendido = await hasta(() => orca.store.syncStatus &&
    orca.store.syncStatus.trigger === 'peticion' && !orca.store.syncStatus.running)
  ok('atiende el pedido del panel sin esperar el ciclo de 5 minutos', atendido,
    JSON.stringify(orca.store.syncStatus))
  ok('el pedido se sincronizo de nuevo, no devolvio el estado viejo',
    orca.store.syncStatus.at !== antes)
  ok('borra el pedido: un clic causa un sync, no una cadena',
    orca.store.syncRequest === null, JSON.stringify(orca.store.syncRequest))

  // Un pedido viejo quedo de otra sesion. Atenderlo seria leer WhatsApp porque
  // alguien apreto un boton ayer.
  const sello = orca.store.syncStatus.at
  orca.store.syncRequest = { at: new Date(Date.now() - 30 * 60 * 1000).toISOString() }
  const limpiado = await hasta(() => orca.store.syncRequest === null, 8000)
  await dormir(500)
  ok('descarta un pedido viejo', limpiado)
  ok('y no sincroniza por el', orca.store.syncStatus.at === sello)

  apagar()
  // Apagado el plugin, el vigia se va con el: si no, sigue leyendo WhatsApp despues
  // de que el usuario dijo que no.
  orca.store.syncRequest = { at: new Date().toISOString() }
  await dormir(5000)
  ok('apagar el plugin detiene al vigia del pedido',
    orca.store.syncRequest !== null, JSON.stringify(orca.store.syncRequest))
}

// ───────── quitar una autorizacion: el panel pide, el worker borra en LOS DOS lados ──
// El defecto que motivo esto, medido en la maquina del dueno: el panel borraba la
// conversacion de su propio `storage.json` y nada mas. La fila seguia en `scope.db`, y
// como todos los CLIs leen el alcance MEZCLADO (`merged_scope` en bin/wa-scope:622),
// la conversacion seguia autorizada y volvia a aparecer. El panel decia "✓ quitada"
// encima de una autorizacion que seguia en pie: es la misma clase de defecto que una
// credencial que alguien cree muerta, y esta le da permiso a un agente para actuar en
// la conversacion de un cliente.
console.log('\nworker: quitar una conversacion la saca de los DOS registros')
{
  // Un `wa-scope` que deja rastro de como lo llamaron: lo que hay que comprobar es que
  // el worker corra `rm` de verdad, no que el storage quede bonito.
  const dir = herramientas('rm-bueno', [
    '#!/bin/sh',
    'if [ "$1" = "rm" ]; then',
    '  echo "$@" >> "$0.llamadas"',
    '  echo \'[{"removed": true}]\'',
    '  exit 0',
    'fi',
    'echo \'[{"synced": true, "destinos": []}]\'',
    ''
  ].join('\n'))
  const orca = hostFalso(dir, {
    chats: [],
    scope: {
      '1@g.us': { chatName: 'Soporte', provider: 'plane', target: 'SOP', mode: 'responder' },
      '2@g.us': { chatName: 'Ops', provider: 'plane', target: 'OPS', mode: 'observar' }
    }
  })
  const { apagar } = await arranca(orca)

  orca.store.scopeRequest = { id: 'quita-1', action: 'quitar', jid: '1@g.us',
    at: new Date().toISOString() }
  const contestado = await hasta(() => orca.store.scopeResult &&
    orca.store.scopeResult.requestId === 'quita-1', 15000)
  ok('el worker contesta el pedido de quitar', contestado,
    JSON.stringify(orca.store.scopeResult))
  ok('y contesta que si', orca.store.scopeResult && orca.store.scopeResult.ok === true,
    JSON.stringify(orca.store.scopeResult))
  // Esto es el arreglo: el CLI es el unico que sabe borrar en sqlite Y en el store del
  // panel a la vez (bin/wa-scope:858-865). El panel solo, no puede.
  const llamadas = existsSync(join(dir, 'wa-scope.llamadas'))
    ? readFileSync(join(dir, 'wa-scope.llamadas'), 'utf8')
    : ''
  ok('corrio `wa-scope rm` con el jid, que borra en sqlite y en el store',
    /^rm 1@g\.us/m.test(llamadas), JSON.stringify(llamadas))
  ok('y la conversacion ya no esta en el alcance que lee el panel',
    orca.store.scope && !('1@g.us' in orca.store.scope), JSON.stringify(orca.store.scope))
  ok('sin llevarse por delante las demas',
    orca.store.scope && '2@g.us' in orca.store.scope, JSON.stringify(orca.store.scope))
  ok('borra el pedido: un clic quita una vez',
    orca.store.scopeRequest === null, JSON.stringify(orca.store.scopeRequest))

  // Quitar lo que ya no esta no es un error: el usuario pidio que no estuviera y no
  // esta. Un fallo aca mandaria a reintentar algo que ya se hizo.
  orca.store.scopeRequest = { id: 'quita-2', action: 'quitar', jid: '1@g.us',
    at: new Date().toISOString() }
  await hasta(() => orca.store.scopeResult &&
    orca.store.scopeResult.requestId === 'quita-2', 15000)
  ok('quitar dos veces no es un error', orca.store.scopeResult &&
    orca.store.scopeResult.ok === true, JSON.stringify(orca.store.scopeResult))
  apagar()
}

{
  // El CLI que no esta. El worker tiene que DECIRLO: quitar sin poder correr `rm` deja
  // la autorizacion viva, y callarlo es exactamente el defecto de partida.
  const orca = hostFalso(herramientas('rm-sin-nada', null), {
    chats: [], scope: { '1@g.us': { chatName: 'Soporte', mode: 'responder' } }
  })
  const { apagar } = await arranca(orca)
  orca.store.scopeRequest = { id: 'quita-mal', action: 'quitar', jid: '1@g.us',
    at: new Date().toISOString() }
  await hasta(() => orca.store.scopeResult &&
    orca.store.scopeResult.requestId === 'quita-mal', 15000)
  const v = orca.store.scopeResult
  ok('si no puede correr el CLI, lo dice', v && v.ok === false, JSON.stringify(v))
  ok('con el mismo codigo estable que el resto del worker',
    v && v.code === 'sin-herramientas', JSON.stringify(v))
  // Y NO la saca del storage: decir que se quito cuando sigue autorizada es la mentira
  // que esto viene a matar.
  ok('y la autorizacion sigue donde estaba, sin fingir que se fue',
    orca.store.scope && '1@g.us' in orca.store.scope, JSON.stringify(orca.store.scope))
  apagar()
}

{
  // Una accion que este worker no conoce, y un jid que no es un jid. `wa-scope rm`
  // acepta tambien un trozo de NOMBRE y ahi resuelve por parecido: pasarle lo que
  // venga podria borrar la conversacion equivocada (§11-A1: el nombre no es identidad).
  const orca = hostFalso(herramientas('rm-raro', BUENO), { chats: [], scope: {} })
  const { apagar } = await arranca(orca)
  orca.store.scopeRequest = { id: 'raro-1', action: 'quitar', jid: 'Soporte',
    at: new Date().toISOString() }
  await hasta(() => orca.store.scopeResult &&
    orca.store.scopeResult.requestId === 'raro-1', 15000)
  ok('un jid que no es un jid se rechaza, no se resuelve por parecido',
    orca.store.scopeResult && orca.store.scopeResult.ok === false &&
    orca.store.scopeResult.code === 'jid-invalido',
    JSON.stringify(orca.store.scopeResult))
  orca.store.scopeRequest = { id: 'raro-2', action: 'incendiar', jid: '1@g.us',
    at: new Date().toISOString() }
  await hasta(() => orca.store.scopeResult &&
    orca.store.scopeResult.requestId === 'raro-2', 15000)
  ok('una accion desconocida se contesta, no se calla',
    orca.store.scopeResult && orca.store.scopeResult.ok === false &&
    orca.store.scopeResult.code === 'accion-desconocida',
    JSON.stringify(orca.store.scopeResult))
  apagar()
}

// ───────── el arnes de la carpeta del plugin ─────────
// Es la rama que escribe en disco, y la que no recorre ningun otro chequeo. Un
// NameError ya se colo una vez por exactamente eso.
console.log('\nworker: el arnes de la carpeta del plugin')
{
  // Herramientas falsas que contestan `--help` con una version que la prueba cambia.
  // Asi la segunda activacion tiene contenido nuevo que ofrecer, que es lo unico que
  // permite comprobar que lo que el usuario NO toco si se actualiza.
  const dir = join(RAIZ, 'arnes-bin')
  mkdirSync(dir, { recursive: true })
  const guion = '#!/bin/sh\n' +
    'case "$1" in\n' +
    '  sync) echo \'[{"synced": true}]\' ;;\n' +
    '  doctor) echo \'[]\' ;;\n' +
    '  *) echo "AYUDA $(cat "$(dirname "$0")/version.txt") de $(basename "$0") $*" ;;\n' +
    'esac\n'
  for (const tool of ['wa-scope', 'wa-read', 'wa-send', 'wa-transcribe']) {
    writeFileSync(join(dir, tool), guion, { mode: 0o755 })
  }
  writeFileSync(join(dir, 'version.txt'), 'V1\n')

  const orca = hostFalso(dir, { chats: [] })
  const { apagar } = await arranca(orca)
  await hasta(() => orca.store.harnessStatus)
  const e = orca.store.harnessStatus
  apagar()

  ok('la siembra deja escrito como le fue', !!e && e.ok === true, JSON.stringify(e))
  const carpeta = workspaceDir(PLUGIN_DIR)
  ok('siembra en la carpeta de trabajo del plugin', e && e.dir === carpeta,
    `${e && e.dir} != ${carpeta}`)
  const puestos = (e?.files ?? []).map((f) => f.name).sort()
  ok('deja los cuatro archivos del arnes',
    puestos.join(',') === 'AGENTS.md,CLASSIFICATION.md,COMMANDS.md,EXAMPLES.md',
    puestos.join(','))

  const lee = (n) => readFileSync(join(carpeta, n), 'utf8')
  // Las cinco reglas duras tienen que llegar al archivo que Orca le mete al contexto.
  const agentes = lee('AGENTS.md')
  for (const [nombre, frase] of [
    ['la credencial', 'credential never passes through the agent'],
    ['el permiso responder', 'Without the `responder` permission nothing is sent'],
    ['la duda', 'When in doubt, no card is opened'],
    ['ninguno', '`ninguno` conversation never opens a card'],
    ['el tono', 'come from `wa-scope voice`']
  ]) {
    ok(`el AGENTS.md sembrado lleva la regla de ${nombre}`, agentes.includes(frase))
  }
  // Y la referencia sale del `--help` de verdad, no de una transcripcion a mano.
  ok('la referencia se genera con el --help de las herramientas',
    lee('COMMANDS.md').includes('AYUDA V1 de wa-scope --help'))
  ok('y tambien el de los subcomandos que usa el prompt',
    lee('COMMANDS.md').includes('AYUDA V1 de wa-scope voice --help'))

  // ── segunda activacion: el usuario edito una seccion y agrego otra suya.
  const antes = lee('COMMANDS.md')
  writeFileSync(join(carpeta, 'COMMANDS.md'),
    `${antes.replace('## Where the tools are', '## Where the tools are\n\nESTO LO ESCRIBO YO')}\n## Mia\n\nmis notas\n`)
  writeFileSync(join(dir, 'version.txt'), 'V2\n')

  const orca2 = hostFalso(dir, { chats: [] })
  const { apagar: apagar2 } = await arranca(orca2)
  await hasta(() => orca2.store.harnessStatus)
  const e2 = orca2.store.harnessStatus
  apagar2()

  const comandos = (e2?.files ?? []).find((f) => f.name === 'COMMANDS.md')
  const final = lee('COMMANDS.md')
  ok('lo que el usuario edito queda como suyo',
    !!comandos && comandos.yours.includes('Where the tools are'), JSON.stringify(comandos))
  ok('y no se lo pisa la actualizacion', final.includes('ESTO LO ESCRIBO YO'))
  ok('la seccion que agrego el usuario sobrevive', final.includes('mis notas'))
  ok('y lo que no toco si se actualiza', final.includes('AYUDA V2 de wa-scope --help'),
    JSON.stringify(comandos))
  ok('la referencia vieja ya no esta', !final.includes('AYUDA V1 de wa-scope --help'))
  // Un archivo que nadie toco y que no cambio no se reescribe: sin esto cada arranque
  // dejaria la carpeta con cuatro archivos "modificados" que no cambiaron en nada.
  const agentes2 = (e2?.files ?? []).find((f) => f.name === 'AGENTS.md')
  ok('lo que no cambio no se reescribe', !!agentes2 && agentes2.action === 'igual',
    JSON.stringify(agentes2))
}

// ───────── sin carpeta donde sembrar ─────────
{
  // Una maquina donde Orca todavia no le da carpeta al plugin. El arnes no se siembra
  // y NADA MAS cambia: el plugin tiene que andar exactamente igual que antes.
  const homeAnterior = process.env.HOME
  const xdgAnterior = process.env.XDG_CONFIG_HOME
  const appAnterior = process.env.APPDATA
  const vacio = join(RAIZ, 'sin-userdata')
  mkdirSync(vacio, { recursive: true })
  process.env.HOME = vacio
  process.env.XDG_CONFIG_HOME = join(vacio, '.config')
  process.env.APPDATA = join(vacio, 'AppData')

  const orca = hostFalso(herramientas('bueno-2', BUENO), { chats: [] })
  const { apagar, listo } = await arranca(orca)
  await hasta(() => orca.store.harnessStatus)
  const e = orca.store.harnessStatus
  apagar()
  ok('sin carpeta el arnes falla callado y dice por que',
    !!e && e.ok === false && e.reason === 'sin-userdata', JSON.stringify(e))
  ok('y el sync sigue andando igual que siempre',
    listo && orca.store.syncStatus.ok === true, JSON.stringify(orca.store.syncStatus))

  process.env.HOME = homeAnterior
  process.env.XDG_CONFIG_HOME = xdgAnterior
  process.env.APPDATA = appAnterior
}

// El intervalo de sync es el unico momento en que se abre la base de WhatsApp, asi que
// tambien es el peor caso para que un mensaje nuevo llegue al agente. Que el usuario lo
// pueda mover es la mitad; la otra es que un valor absurdo no lo rompa: con 0 minutos el
// worker leeria 260 MB en bucle, que es justo el problema que este cambio vino a sacar.
console.log('\nworker: cada cuanto relee WhatsApp')
{
  const casos = [
    [undefined, 5 * 60000, 'sin nada guardado son 5 minutos'],
    ['15', 15 * 60000, 'respeta lo que el usuario dejo puesto'],
    ['0', 5 * 60000, 'un 0 no deja el sync en bucle'],
    ['-3', 5 * 60000, 'un negativo tampoco'],
    ['no-es-un-numero', 5 * 60000, 'ni una cadena que no es numero'],
    ['1000', 60 * 60000, 'y un valor enorme se corta en una hora']
  ]
  for (const [guardado, esperado, nombre] of casos) {
    const orca = hostFalso(RAIZ, guardado === undefined ? {} : { syncMinutes: guardado })
    const ms = await intervaloSync(orca)
    ok(nombre, ms === esperado, `${guardado} -> ${ms} ms, se esperaban ${esperado}`)
  }
}

// ───────── el estado del sistema se PUBLICA, tambien cuando es malo ─────────
// `wa-read doctor` sale con 1 cuando falta algo requerido — que es justo lo que se le
// pregunta. Rechazar por el codigo de salida tiraba su respuesta entera, y `health` no
// lo escribia NADIE: una maquina sin WhatsApp instalado se veia igual que una sana.
console.log('\nworker: el diagnostico llega al panel')
{
  const DOCTOR_MALO = '#!/usr/bin/env node\n' +
    'console.log(JSON.stringify([' +
    '{ check: "a message transport", ok: false, detalle: "there is no message transport yet",' +
    ' requerido: true, code: "no-transport" },' +
    '{ check: "audio transcription", ok: false, detalle: "no engine",' +
    ' requerido: false, code: "transcribe", detailCode: "transcribe-no-engine" }' +
    ']))\nprocess.exit(1)\n'
  const dir = herramientas('doctor-malo', '#!/bin/sh\necho \'[]\'\n')
  writeFileSync(join(dir, 'wa-read'), DOCTOR_MALO, { mode: 0o755 })
  const orca = hostFalso(dir, { chats: [] })
  const apagar = activate(orca)
  await hasta(() => orca.store.health, 20000)
  const h = orca.store.health
  ok('un doctor que sale con 1 igual publica su diagnostico', !!h, JSON.stringify(h))
  ok('y dice que este sistema NO puede leer', h && h.ok === false, JSON.stringify(h))
  ok('con el codigo del chequeo que falta, para que el panel lo traduzca',
    h && h.problemCode === 'no-transport', `problemCode = ${h && h.problemCode}`)
  ok('y no confunde "no hay transporte" con "las herramientas no contestaron"',
    h && h.problemCode !== 'sin-herramientas', JSON.stringify(h))
  ok('y lo opcional viaja aparte, sin avisar', h && Array.isArray(h.optional) &&
    h.optional.length === 1 && h.optional[0].code === 'transcribe',
    JSON.stringify(h && h.optional))
  // Que no haya transporte bloquea, pero NO tiene accion: el usuario no puede
  // construir la rebanada que falta. Una notificacion en cada arranque de cada maquina
  // por algo que nadie puede arreglar es como se ensenia a ignorarlas, asi que el
  // motivo viaja al panel —que lo pinta— y no a una notificacion.
  ok('y no saca una notificacion por algo que el usuario no puede arreglar',
    orca.avisos.length === 0, JSON.stringify(orca.avisos))
  apagar()
}

// ───────── lo que SI tiene accion sigue avisando ─────────
// El silencio de arriba es por el codigo, no por el nivel: un requisito que el usuario
// puede resolver tiene que seguir sacando su notificacion, o el filtro se convierte en
// un apagon de avisos.
console.log('\nworker: un requisito accionable sigue avisando')
{
  const DOCTOR_ACCIONABLE = '#!/usr/bin/env node\n' +
    'console.log(JSON.stringify([' +
    '{ check: "sqlite3 available", ok: false, detalle: "not in PATH",' +
    ' requerido: true, code: "sqlite3" }' +
    ']))\nprocess.exit(1)\n'
  const dir = herramientas('doctor-accionable', '#!/bin/sh\necho \'[]\'\n')
  writeFileSync(join(dir, 'wa-read'), DOCTOR_ACCIONABLE, { mode: 0o755 })
  const orca = hostFalso(dir, { chats: [] })
  const apagar = activate(orca)
  await hasta(() => orca.avisos.length > 0, 20000)
  ok('un requisito con arreglo del usuario sigue sacando su notificacion',
    orca.avisos.length === 1, JSON.stringify(orca.avisos))
  apagar()
}

// ───────── el latido: "no contesto" y "no esta" son dos cosas ─────────
console.log('\nworker: el latido')
{
  const orca = hostFalso(herramientas('latido', '#!/bin/sh\necho \'[]\'\n'), { chats: [] })
  ok('antes de activar no hay latido', orca.store.workerBeat === undefined,
    JSON.stringify(orca.store.workerBeat))
  const apagar = activate(orca)
  await hasta(() => orca.store.workerBeat, 10000)
  ok('activar deja latido en el acto', !!(orca.store.workerBeat || {}).at,
    JSON.stringify(orca.store.workerBeat))
  // Lo que importa: late aunque TODO lo demas falle. Este host no tiene herramientas
  // que corran, y aun asi el panel tiene que poder distinguirlo de un plugin ausente.
  const primero = orca.store.workerBeat.at
  await new Promise((r) => setTimeout(r, 6000))
  ok('y sigue latiendo con las herramientas rotas',
    orca.store.workerBeat.at !== primero,
    `${primero} -> ${orca.store.workerBeat.at}`)
  apagar()
}

// ───────── el arnes no se siembra desde dentro de la valla ─────────
// El worker corre con `--permission` y sin ningun permiso de escritura: ahi dentro
// `existsSync` no devuelve false, LANZA, y el motivo que quedaba escrito era falso
// ("esta maquina no tiene userData") sobre una maquina que lo tiene.
console.log('\nworker: el arnes se siembra fuera de la valla')
{
  const { vallado, sembrar } = await import('../harness.mjs')
  ok('sin valla, este proceso puede escribir', vallado() === false,
    `vallado() = ${vallado()}`)

  const salida = await new Promise((resolve) => {
    execFileNode(process.execPath,
      ['--permission', `--allow-fs-read=${PLUGIN_DIR}`, '--input-type=module', '-e',
        `const h = await import(${JSON.stringify(join(PLUGIN_DIR, 'harness.mjs'))})\n` +
        `process.stdout.write(JSON.stringify({ vallado: h.vallado(),\n` +
        `  estado: await h.sembrar(${JSON.stringify(PLUGIN_DIR)}, ${JSON.stringify(join(PLUGIN_DIR, 'bin'))}) }))`],
      { timeout: 60000 }, (error, stdout) => resolve({ error, stdout }))
  })
  let leido = null
  try { leido = JSON.parse(salida.stdout || 'null') } catch { leido = null }
  ok('dentro de la valla el proceso se reconoce vallado',
    leido && leido.vallado === true, JSON.stringify(salida).slice(0, 200))
  ok('y no inventa un motivo mirando el disco',
    leido && leido.estado && leido.estado.reason === 'vallado',
    JSON.stringify(leido && leido.estado))

  // Y la siembra de verdad, en un subproceso sin valla: es el camino que usa el worker.
  const casa = join(RAIZ, 'siembra-fuera')
  mkdirSync(join(casa, 'Library', 'Application Support', 'orca'), { recursive: true })
  const hijo = await new Promise((resolve) => {
    execFileNode(process.execPath, [join(PLUGIN_DIR, 'harness.mjs'), PLUGIN_DIR,
      join(PLUGIN_DIR, 'bin')],
    { timeout: 120000, env: { ...process.env, HOME: casa } }, (error, stdout) =>
      resolve({ error, stdout }))
  })
  let estado = null
  try { estado = JSON.parse(hijo.stdout || 'null') } catch { estado = null }
  ok('el subproceso siembra y devuelve el estado por stdout',
    estado && estado.ok === true, JSON.stringify(hijo).slice(0, 300))
  ok('y la carpeta que eligio es la del userData de esa maquina',
    estado && String(estado.dir || '').startsWith(casa),
    `dir = ${estado && estado.dir}`)
  // sembrar() en proceso, sin valla, sigue funcionando: es lo que corren estas pruebas.
  const directo = await sembrar(PLUGIN_DIR, join(PLUGIN_DIR, 'bin'))
  ok('y sembrar() sigue andando sin valla', directo.ok === true,
    JSON.stringify(directo).slice(0, 200))
}

// ───────── el sidecar habla: el QR y la conexion llegan a storage ─────────
console.log('\nworker: el sidecar habla, el panel se entera')
{
  const guion = join(RAIZ, 'sidecar-charla.cjs')
  writeFileSync(guion,
    '#!/usr/bin/env node\n' +
    'function emit (m) { process.stdout.write(JSON.stringify(m) + "\\n") }\n' +
    'emit({ type: "connection", state: "connecting" })\n' +
    'setTimeout(() => emit({ type: "qr", qr: "QR-DE-PRUEBA", ts: Date.now(), rotation: 1 }), 50)\n' +
    'setTimeout(() => emit({ type: "connection", state: "open" }), 250)\n' +
    'setInterval(() => {}, 1000)\n', // se queda vivo hasta que el worker lo mate
    { mode: 0o755 })

  const orca = hostFalso(herramientas('sidecar-charla', '#!/bin/sh\necho \'[]\'\n'), {}, guion)
  const { apagar } = await arranca(orca)

  await hasta(() => orca.store.sidecar && orca.store.sidecar.qr, 10000)
  const conQr = orca.store.sidecar
  ok('el QR llega a storage', conQr && conQr.qr && conQr.qr.qr === 'QR-DE-PRUEBA',
    JSON.stringify(conQr))
  ok('con su numero de rotacion', conQr && conQr.qr && conQr.qr.rotation === 1,
    JSON.stringify(conQr && conQr.qr))
  ok('y su marca de tiempo, para que el panel descarte lo vencido',
    conQr && conQr.qr && typeof conQr.qr.ts === 'number', JSON.stringify(conQr && conQr.qr))

  await hasta(() => orca.store.sidecar && orca.store.sidecar.connection === 'open', 10000)
  const conectado = orca.store.sidecar
  ok('la conexion abierta llega a storage', conectado && conectado.connection === 'open',
    JSON.stringify(conectado))
  ok('y el QR se descarta: uno vencido no tiene por que seguir pintado detras de una ' +
    'sesion ya conectada (docs/ENCARGO...§6)',
    conectado && conectado.qr === null, JSON.stringify(conectado))
  apagar()
}

// ───────── el almacen: conteos al panel, y donde estan las herramientas ─────────
console.log('\nworker: lo que el sidecar guardo y desalojo llega al panel, en numeros')
{
  const marcador = join(RAIZ, 'toolsdir-visto.txt')
  const guion = join(RAIZ, 'sidecar-almacen.cjs')
  writeFileSync(guion,
    '#!/usr/bin/env node\n' +
    `require('node:fs').writeFileSync(${JSON.stringify(marcador)}, process.env.WA_SIDECAR_TOOLS_DIR || '')\n` +
    'function emit (m) { process.stdout.write(JSON.stringify(m) + "\\n") }\n' +
    'emit({ type: "connection", state: "open" })\n' +
    'setTimeout(() => emit({ type: "store", at: 1758500000000, llegaron: 40, guardados: 12,\n' +
    '  sinAutorizar: 28, actualizados: 2, autorizadas: 3, desalojados: 7, caducados: 1,\n' +
    '  migradoCuerpos: 12, migradoLineas: 2, chatsHistorial: 314,\n' +
    '  historialCompleto: true }), 50)\n' +
    'setInterval(() => {}, 1000)\n',
    { mode: 0o755 })

  const toolsDir = herramientas('almacen', '#!/bin/sh\necho \'[]\'\n')
  const orca = hostFalso(toolsDir, {}, guion)
  const { apagar } = await arranca(orca)
  await hasta(() => orca.store.sidecar && orca.store.sidecar.store, 10000)
  const est = orca.store.sidecar.store
  apagar()

  // Sin esto el sidecar no sabe a quien preguntarle que conversaciones estan
  // autorizadas, y con el alcance vacio no guarda NADA: una bandeja vacia para
  // siempre y sin un solo error (docs/ENCARGO...§11-E4).
  const visto = existsSync(marcador) ? readFileSync(marcador, 'utf8') : ''
  ok('WA_SIDECAR_TOOLS_DIR le llega al sidecar, y apunta al bin de ESTA instalacion',
    visto === toolsDir, `${visto} != ${toolsDir}`)

  ok('los conteos del almacen llegan a storage', !!est, JSON.stringify(orca.store.sidecar))
  ok('con lo que llego y lo que se guardo, que es lo que distingue "no hay nada ' +
    'autorizado" de "esto no funciona"',
    est && est.llegaron === 40 && est.guardados === 12 && est.sinAutorizar === 28,
    JSON.stringify(est))
  ok('y con el desalojo, que callado es un caso que se pierde sin explicacion (§11-F2)',
    est && est.desalojados === 7 && est.caducados === 1, JSON.stringify(est))
  // Y con lo que se llevo la subida de esquema del almacen. El renglon del `doctor` lo
  // ve quien entra al panel; esto lo ve quien mire el log o el storage el dia que
  // pregunte adonde fueron a parar los mensajes de antes. Es el mismo trato que el
  // desalojo, por el mismo motivo: callarlo es perder el caso sin explicacion.
  ok('y con lo que se llevo la migracion del almacen',
    est && est.migradoCuerpos === 12 && est.migradoLineas === 2, JSON.stringify(est))
  // Y con cuantas conversaciones dejo la sincronizacion inicial. Es lo unico que
  // distingue "el telefono no mando la lista" de "la mando y no quedo nada": las dos
  // se ven igual desde afuera —una lista con solo grupos— y esa confusion es la que
  // costo el arreglo de los uno a uno.
  ok('y con cuantas conversaciones trajo la sincronizacion inicial',
    est && est.chatsHistorial === 314 && est.historialCompleto === true,
    JSON.stringify(est))
  // Esto es una cuenta real con conversaciones de clientes reales. Lo que llega al
  // storage tiene que ser CONTABILIDAD y nada mas.
  const texto = JSON.stringify(est)
  // Numeros y banderas, nada mas. Un booleano no puede llevar el texto de nadie; una
  // CADENA si, y por eso sigue sin haber ni una.
  ok('y NADA de contenido: ni cuerpos, ni telefonos, ni jids de remitente',
    Object.values(est).every((v) => typeof v === 'number' || typeof v === 'boolean' ||
      v === null) &&
    !/@|\+?\d{7,}/.test(texto.replace(/\d{13}/g, '')), texto)
}

// ───────── si el sidecar se cae, el motivo llega con un codigo estable ─────────
console.log('\nworker: si el sidecar se cae, el motivo llega a storage con codigo estable')
{
  const guion = join(RAIZ, 'sidecar-cae.cjs')
  writeFileSync(guion, '#!/usr/bin/env node\nprocess.stderr.write("boom\\n")\nprocess.exit(1)\n',
    { mode: 0o755 })

  const orca = hostFalso(herramientas('sidecar-cae', '#!/bin/sh\necho \'[]\'\n'), {}, guion)
  const { apagar } = await arranca(orca)
  await hasta(() => orca.store.sidecar && orca.store.sidecar.exited, 10000)
  const e = orca.store.sidecar
  ok('la caida queda escrita', e && e.exited === true, JSON.stringify(e))
  ok('con un codigo ESTABLE, no texto libre: el panel lo traduce por codigo, igual ' +
    'que el resto del contrato (docs/ENCARGO...§11-E1)',
    e && e.error && e.error.code === 'sidecar-cayo', JSON.stringify(e))
  apagar()
}

// ───────── si el sidecar nunca llega a arrancar, tambien queda escrito ─────────
console.log('\nworker: si el sidecar nunca llega a arrancar, tambien queda escrito')
{
  const orca = hostFalso(herramientas('spawn-fake', null), {}, SIDECAR_STUB)
  function spawnFalso () {
    const p = new EventEmitter()
    p.stdout = new EventEmitter()
    p.stderr = new EventEmitter()
    p.kill = () => { p.killed = true }
    setTimeout(() => p.emit('error',
      Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })), 10)
    return p
  }
  const detener = lanzarSidecar({ orca, scriptPath: '/no/existe.cjs',
    authDir: join(RAIZ, 'auth-fake'), spawnFn: spawnFalso })
  await hasta(() => orca.store.sidecar && orca.store.sidecar.exited, 2000)
  const e = orca.store.sidecar
  ok('el fallo de arranque queda escrito', e && e.exited === true, JSON.stringify(e))
  ok('con su propio codigo estable, distinto del de una caida en marcha',
    e && e.error && e.error.code === 'sidecar-no-arranco', JSON.stringify(e))
  detener()
}

// ───────── apagarlo a proposito no se reporta como una caida ─────────
console.log('\nworker: apagar el sidecar a proposito no se reporta como una caida')
{
  const guion = join(RAIZ, 'sidecar-vivo.cjs')
  writeFileSync(guion,
    '#!/usr/bin/env node\n' +
    'process.stdout.write(JSON.stringify({ type: "connection", state: "connecting" }) + "\\n")\n' +
    'setInterval(() => {}, 1000)\n',
    { mode: 0o755 })
  const orca = hostFalso(herramientas('sidecar-vivo', null), {}, guion)
  const detener = lanzarSidecar({ orca, scriptPath: guion, authDir: join(RAIZ, 'auth-vivo') })
  await hasta(() => orca.store.sidecar && orca.store.sidecar.connection === 'connecting', 5000)
  detener()
  await new Promise((r) => setTimeout(r, 300))
  ok('apagarlo a proposito no lo marca como caido',
    !(orca.store.sidecar && orca.store.sidecar.exited === true),
    JSON.stringify(orca.store.sidecar))
}

// ───────── dos escrituras seguidas no se pisan aunque el host las resuelva al reves ─────────
console.log('\nworker: dos storage.set de sidecar seguidos quedan en el orden en que se pidieron')
{
  // Regresion de un defecto medido en una instalacion viva: una rotacion entera de
  // QR (la numero 4) desaparecio de storage sin dejar rastro. La causa no era el
  // sidecar -el en memoria (`estado` en `lanzarSidecar`) siempre quedaba bien-, era
  // que dos `storage.set` en vuelo a la vez podian resolver AL REVES del orden en
  // que se pidieron -la cola de CUPO del host reordena bajo carga
  // (docs/ENCARGO...§H2-H3)-, y el que resuelve DESPUES pisa en storage al que le
  // sigue. Se simula aca con un host de mentira que demora mas la escritura MAS
  // VIEJA: sin encadenar las escrituras, la mas nueva se pierde.
  const orca = { store: {}, log: () => {},
    host: {
      call: (accion, params) => {
        if (accion !== 'storage.set') return Promise.resolve({ ok: true })
        // La del QR de la rotacion 1 tarda mas que la de la rotacion 2: si algo no
        // las serializa, la 2 resuelve primero y la 1 la pisa al llegar despues.
        const demora = params.value && params.value.qr && params.value.qr.rotation === 1
          ? 60 : 5
        return new Promise((resolve) => setTimeout(() => {
          orca.store[params.key] = params.value
          resolve({ ok: true })
        }, demora))
      }
    } }
  let proceso
  const detener = lanzarSidecar({ orca, scriptPath: '/no/existe.cjs',
    authDir: join(RAIZ, 'auth-orden'),
    spawnFn: () => {
      proceso = new EventEmitter()
      proceso.stdout = new EventEmitter()
      proceso.stderr = new EventEmitter()
      proceso.kill = () => { proceso.killed = true }
      return proceso
    } })
  // Dos rotaciones de QR, una atras de la otra, como las dispara un socket que rota
  // justo cuando algo mas pasa (docs/ENCARGO...§6). Las dos lineas llegan en el
  // MISMO chunk de stdout, que es el caso mas apretado: main.mjs las procesa una por
  // una, sin esperar a que la escritura de la primera termine antes de arrancar la
  // segunda.
  proceso.stdout.emit('data',
    JSON.stringify({ type: 'qr', qr: 'Q1', ts: Date.now(), rotation: 1, ttlMs: 75000 }) +
    '\n' +
    JSON.stringify({ type: 'qr', qr: 'Q2', ts: Date.now(), rotation: 2, ttlMs: 75000 }) +
    '\n')
  await hasta(() => orca.store.sidecar && orca.store.sidecar.qr &&
    orca.store.sidecar.qr.rotation === 2, 2000)
  detener()
  ok('la rotacion mas nueva no se pierde aunque su escritura resuelva antes',
    !!(orca.store.sidecar && orca.store.sidecar.qr && orca.store.sidecar.qr.qr === 'Q2' &&
       orca.store.sidecar.qr.rotation === 2),
    JSON.stringify(orca.store.sidecar))
}

// ───────── el auth dir se resuelve fuera de la valla, igual que el arnes ─────────
console.log('\nworker: el directorio de auth del sidecar se resuelve fuera de la valla')
{
  // Con el HOME de mentira de todo este archivo ya hay un userData de Orca: el mismo
  // que usa la siembra del arnes, arriba.
  const esperado = dataDir(PLUGIN_DIR, 'wa-auth')
  ok('dataDir() encuentra un userData en esta maquina de mentira', !!esperado, `${esperado}`)

  const marcador = join(RAIZ, 'authdir-visto.txt')
  const guion = join(RAIZ, 'sidecar-mira-authdir.cjs')
  writeFileSync(guion,
    '#!/usr/bin/env node\n' +
    `require('node:fs').writeFileSync(${JSON.stringify(marcador)}, process.env.WA_SIDECAR_AUTH_DIR || '')\n` +
    'process.stdout.write(JSON.stringify({ type: "connection", state: "connecting" }) + "\\n")\n' +
    'setInterval(() => {}, 1000)\n',
    { mode: 0o755 })

  const orca = hostFalso(herramientas('mira-authdir', '#!/bin/sh\necho \'[]\'\n'), {}, guion)
  const { apagar } = await arranca(orca)
  await hasta(() => existsSync(marcador), 10000)
  const visto = readFileSync(marcador, 'utf8')
  apagar()
  ok('WA_SIDECAR_AUTH_DIR le llega absoluto y FUERA del arbol del plugin, bajo ' +
    'plugins-data/<publisher>.<id>/wa-auth (docs/ENCARGO...§7)',
    visto.length > 0 && isAbsolute(visto) && visto === esperado, `${visto} != ${esperado}`)
}

// ───────── sin userData de Orca, el sidecar no arranca a ciegas ─────────
console.log('\nworker: sin userData de Orca, el resolvedor de auth dice por que')
{
  const vacio = join(RAIZ, 'sin-userdata')
  mkdirSync(vacio, { recursive: true })
  const salida = await new Promise((resolve) => {
    execFileNode(process.execPath,
      [join(PLUGIN_DIR, 'sidecar', 'resolve-auth-dir.mjs'), PLUGIN_DIR],
      { timeout: 15000,
        env: { ...process.env, HOME: vacio, XDG_CONFIG_HOME: join(vacio, '.config'),
          APPDATA: join(vacio, 'AppData', 'Roaming') } },
      (error, stdout) => resolve({ error, stdout }))
  })
  let leido = null
  try { leido = JSON.parse(salida.stdout || 'null') } catch { leido = null }
  ok('sin ningun userData, dice por que en vez de adivinar una ruta',
    leido && leido.ok === false && leido.reason === 'sin-userdata', JSON.stringify(salida))
}

// ───────── "no hay userData" y "no pude preguntar" no son el mismo problema ─────────
// El defecto que esto recorre se vio en el producto: el plugin estaba en "Requiere
// revision" -sin `process:spawn` concedido, asi que el worker arranca SIN
// `--allow-child-process`- y el panel decia que no habia userData en este equipo,
// cuando el resolvedor corrido a mano contestaba la ruta perfecta. Dos fallas
// distintas con un solo codigo le pedian al usuario justo lo que no lo iba a sacar
// del pozo.
console.log('\nworker: el resolvedor que contesta y el que no llega a correr se distinguen')
{
  // Cada caso necesita un ARRANQUE distinto -un HOME sin userData, la valla de
  // permisos de Node, un `node` que no levanta-, y eso no se puede cambiar dentro de
  // la corrida que ya esta andando: por eso `activate()` corre en un hijo.
  const stub = join(RAIZ, 'sidecar-no-deberia-correr.cjs')
  writeFileSync(stub, '#!/usr/bin/env node\nprocess.exit(0)\n', { mode: 0o755 })
  const ayudante = join(RAIZ, 'activar-y-mirar.mjs')
  writeFileSync(ayudante,
    "import { pathToFileURL } from 'node:url'\n" +
    'const store = {}\n' +
    // Sin esto, una cadena rechazada -las hay a monton cuando nada puede lanzar
    // subprocesos- mataria al hijo antes de que alcance a contar lo que quedo escrito.
    'process.on("unhandledRejection", () => {})\n' +
    'const orca = {\n' +
    '  log: () => {},\n' +
    '  host: { call: async (a, p) => {\n' +
    '    if (a === "storage.get") return { value: store[p.key] }\n' +
    '    if (a === "storage.set") { store[p.key] = p.value; return { ok: true } }\n' +
    '    if (a === "settings.get") return { value: { toolsDir: process.argv[3], sidecarPath: process.argv[4],\n' +
    '      authDirResolverPath: process.argv[5] === "roto" ? "/no/existe/resolvedor.mjs" : undefined } }\n' +
    '    return { ok: true }\n' +
    '  } },\n' +
    '  commands: { register () {} },\n' +
    '  events: { on () {} }\n' +
    '}\n' +
    // "roto" apunta el resolvedor a un guion que no existe: el hijo arranca, no
    // encuentra que cargar y muere sin escribir JSON. Es el resolvedor que CORRIO y
    // no contesto, que no es ni "no hay userData" ni "no me dejaron lanzarlo".
    //
    // Antes se ensuciaba NODE_OPTIONS para romperlo, y dejo de servir el dia que los
    // hijos pasaron a lanzarse por `/usr/bin/env -u NODE_OPTIONS`: la prueba se
    // curaba sola con el arreglo que debia vigilar. Un fallo inducido por el mismo
    // mecanismo que el codigo limpia no prueba nada.
    'const { default: activate } = await import(pathToFileURL(process.argv[2]).href)\n' +
    'activate(orca)\n' +
    'const fin = Date.now() + 20000\n' +
    'const mirar = setInterval(() => {\n' +
    '  if (!store.sidecar && Date.now() < fin) return\n' +
    '  clearInterval(mirar)\n' +
    '  process.stdout.write(JSON.stringify(store.sidecar ?? null))\n' +
    '  process.exit(0)\n' +
    '}, 50)\n')

  const MAIN = join(PLUGIN_DIR, 'main.mjs')
  const correr = (previos, env, guion = ayudante, modo = 'normal') => new Promise((resolve) => {
    execFileNode(process.execPath,
      [...previos, guion, MAIN, join(RAIZ, 'sin-herramientas'), stub, modo],
      { timeout: 60000, env },
      (error, stdout) => {
        let leido = null
        try { leido = JSON.parse(stdout || 'null') } catch { leido = null }
        resolve({ error, stdout, leido })
      })
  })

  const sinUserData = join(RAIZ, 'home-pelado')
  mkdirSync(sinUserData, { recursive: true })
  const a = await correr([], { ...process.env, HOME: sinUserData,
    XDG_CONFIG_HOME: join(sinUserData, '.config'),
    APPDATA: join(sinUserData, 'AppData', 'Roaming') })
  ok('sin userData de Orca, el motivo sigue siendo SIN_AUTHDIR',
    a.leido && a.leido.error && a.leido.error.code === 'sidecar-sin-authdir',
    JSON.stringify(a.leido) || String(a.stdout))

  // La valla de verdad: `--permission` sin `--allow-child-process` es exactamente como
  // Orca arranca un plugin al que todavia no se le concedio `process:spawn`
  // (docs/ENCARGO-TRANSPORTE-UNICO.md §1). Ahi `execFile` no falla por callback: LANZA
  // en el acto, y el motivo ni llegaba al storage.
  //
  // El realpath no es adorno: la valla resuelve los enlaces simbolicos antes de
  // comparar y en macOS el directorio temporal ES uno (/var/folders ->
  // /private/var/folders), asi que hay que darle la ruta real Y ENTRAR por ella, o el
  // hijo no puede leer ni su propio guion.
  const raizReal = realpathSync(RAIZ)
  const b = await correr(['--permission', `--allow-fs-read=${PLUGIN_DIR}`,
    `--allow-fs-read=${raizReal}`], process.env, join(raizReal, 'activar-y-mirar.mjs'))
  ok('sin permiso para lanzar el resolvedor, el motivo llega al storage igual',
    b.leido && b.leido.exited === true, JSON.stringify(b.leido) || String(b.stdout))
  ok('y con su propio codigo, que manda a revisar el plugin y no a buscar una carpeta',
    b.leido && b.leido.error && b.leido.error.code === 'sidecar-sin-permiso',
    JSON.stringify(b.leido) || String(b.stdout))

  const c = await correr([], process.env, ayudante, 'roto')
  ok('un resolvedor que corrio y no contesto tampoco es "no hay userData"',
    c.leido && c.leido.error && c.leido.error.code === 'sidecar-authdir-fallo',
    JSON.stringify(c.leido) || String(c.stdout))

  const codigos = [a, b, c].map((r) => r.leido && r.leido.error && r.leido.error.code)
  ok('los tres llegan con codigos DISTINTOS: el panel los traduce por codigo y una ' +
    'sola etiqueta para tres arreglos distintos es la que mando a mirar la carpeta ' +
    'equivocada (docs/ENCARGO-TRANSPORTE-UNICO.md §11 E2: "la accion del usuario es ' +
    'distinta en cada uno")',
    new Set(codigos).size === 3 && codigos.every(Boolean), JSON.stringify(codigos))
}

// ───────── el panel pide desvincular: el canal de vuelta y la accion ─────────
// El auth state es una CREDENCIAL VIVA (docs/ENCARGO-TRANSPORTE-UNICO.md §11-F1): quien
// lo tenga lee y escribe como esa cuenta sin el telefono. Poder revocarlo desde el panel
// no es una comodidad — sin esto, quien escaneo con el telefono equivocado solo sale
// borrando un directorio a mano. §8.1 lo pide con nombre: "boton de desvincular".
//
// El panel no tiene canal con el worker: deja el pedido en storage y el worker lo mira
// cada pocos segundos, igual que `syncRequest`. Lo que se recorre aca es lo que hace
// peligroso ese canal: que un pedido no se ejecute DOS veces.
console.log('\nworker: el panel pide desvincular y el worker lo atiende una sola vez')
{
  // El resolvedor de mentira lleva la cuenta de los borrados en un archivo: asi la
  // prueba puede afirmar "una sola vez" sobre un hecho observado y no sobre un log.
  const authFalso = join(RAIZ, 'auth-desvincular')
  const borrados = join(RAIZ, 'borrados.txt')
  const resolvedor = join(RAIZ, 'resolve-desvincular.mjs')
  // No crea el directorio: el resolvedor de verdad tampoco lo crea -lo crea el sidecar
  // al guardar-, y creandolo aca "se borro" seria inobservable despues del relanzamiento.
  writeFileSync(resolvedor,
    'import { appendFileSync, rmSync } from "node:fs"\n' +
    'const dir = ' + JSON.stringify(authFalso) + '\n' +
    'if (process.argv.includes("--borrar")) {\n' +
    '  appendFileSync(' + JSON.stringify(borrados) + ', "x\\n")\n' +
    '  rmSync(dir, { recursive: true, force: true })\n' +
    '}\n' +
    'process.stdout.write(JSON.stringify({ ok: true, dir }))\n')
  mkdirSync(authFalso, { recursive: true })
  writeFileSync(join(authFalso, 'creds.json'), '{"credencial":"viva"}')

  const guion = join(RAIZ, 'sidecar-conectado.cjs')
  writeFileSync(guion,
    '#!/usr/bin/env node\n' +
    'process.stdout.write(JSON.stringify({ type: "connection", state: "open" }) + "\\n")\n' +
    'setInterval(() => {}, 1000)\n', { mode: 0o755 })

  const orca = hostFalso(herramientas('desvincular', '#!/bin/sh\necho \'[]\'\n'), {}, guion)
  orca.host.call = (function (original) {
    return async (action, params) => {
      if (action === 'settings.get') {
        return { value: { toolsDir: join(RAIZ, 'desvincular'), sidecarPath: guion,
          authDirResolverPath: resolvedor } }
      }
      return original(action, params)
    }
  })(orca.host.call)

  const { apagar } = await arranca(orca)
  await hasta(() => orca.store.sidecar && orca.store.sidecar.connection === 'open', 10000)
  ok('antes de desvincular la sesion se ve conectada',
    orca.store.sidecar && orca.store.sidecar.connection === 'open',
    JSON.stringify(orca.store.sidecar))

  const pedido = { id: 'pedido-1', action: 'desvincular', at: new Date().toISOString() }
  orca.store.sidecarRequest = pedido
  const contestado = await hasta(() => orca.store.sidecarResult &&
    orca.store.sidecarResult.requestId === 'pedido-1', 15000)
  ok('el worker contesta el pedido del panel con un veredicto', contestado,
    JSON.stringify(orca.store.sidecarResult))
  ok('y el veredicto trae un codigo ESTABLE, no texto libre',
    orca.store.sidecarResult && orca.store.sidecarResult.ok === true &&
    orca.store.sidecarResult.code === 'desvinculado',
    JSON.stringify(orca.store.sidecarResult))
  ok('el pedido se borra: quien lo atendio no lo deja para la proxima vuelta',
    orca.store.sidecarRequest === null, JSON.stringify(orca.store.sidecarRequest))
  ok('las credenciales guardadas se borraron',
    !existsSync(authFalso), authFalso)

  // Dos veces el MISMO pedido: el panel lo puede reescribir -su escritura se reintenta
  // cuando el host la rechaza- y el worker lo puede releer si el borrado no llego.
  // Desvincular dos veces no es dos veces lo mismo: la segunda se lleva puesta la
  // sesion nueva que el usuario acaba de escanear.
  orca.store.sidecarRequest = pedido
  await dormir(6000)
  const veces = existsSync(borrados)
    ? readFileSync(borrados, 'utf8').trim().split('\n').filter(Boolean).length : 0
  ok('el mismo pedido escrito dos veces se ejecuta UNA sola vez', veces === 1,
    `borrados=${veces}`)

  apagar()
}

// ───────── desvincular deja la pantalla en el estado nuevo, no en el viejo ─────────
// Un panel que sigue diciendo "WhatsApp esta conectado" despues de desvincular es peor
// que uno que no ofrece desvincular: afirma en voz alta algo que acaba de dejar de ser
// cierto.
console.log('\nworker: tras desvincular, el estado que lee el panel ya no es el de antes')
{
  const authFalso = join(RAIZ, 'auth-estado')
  const resolvedor = join(RAIZ, 'resolve-estado.mjs')
  writeFileSync(resolvedor,
    'import { mkdirSync, rmSync } from "node:fs"\n' +
    'const dir = ' + JSON.stringify(authFalso) + '\n' +
    'if (process.argv.includes("--borrar")) rmSync(dir, { recursive: true, force: true })\n' +
    'else mkdirSync(dir, { recursive: true })\n' +
    'process.stdout.write(JSON.stringify({ ok: true, dir }))\n')

  // Este sidecar de mentira dice "open" UNA vez y se queda callado: tras desvincular,
  // el que se lance de nuevo vuelve a decir "open" solo si alguien lo relanzo. Lo que
  // importa aca es que la clave NO siga diciendo lo de antes.
  const vidas = join(RAIZ, 'vidas-silencioso.txt')
  const guion = join(RAIZ, 'sidecar-silencioso.cjs')
  writeFileSync(guion,
    '#!/usr/bin/env node\n' +
    'const fs = require("node:fs")\n' +
    'fs.appendFileSync(' + JSON.stringify(vidas) + ', "x\\n")\n' +
    'const primera = fs.readFileSync(' + JSON.stringify(vidas) + ', "utf8")\n' +
    '  .trim().split("\\n").filter(Boolean).length === 1\n' +
    'if (primera) {\n' +
    '  process.stdout.write(JSON.stringify({ type: "connection", state: "open" }) + "\\n")\n' +
    '}\n' +
    'setInterval(() => {}, 1000)\n', { mode: 0o755 })

  const orca = hostFalso(herramientas('estado', '#!/bin/sh\necho \'[]\'\n'), {}, guion)
  orca.host.call = (function (original) {
    return async (action, params) => {
      if (action === 'settings.get') {
        return { value: { toolsDir: join(RAIZ, 'estado'), sidecarPath: guion,
          authDirResolverPath: resolvedor } }
      }
      return original(action, params)
    }
  })(orca.host.call)

  const { apagar } = await arranca(orca)
  await hasta(() => orca.store.sidecar && orca.store.sidecar.connection === 'open', 10000)

  orca.store.sidecarRequest = { id: 'pedido-estado', action: 'desvincular',
    at: new Date().toISOString() }
  await hasta(() => orca.store.sidecarResult &&
    orca.store.sidecarResult.requestId === 'pedido-estado', 15000)
  const d = orca.store.sidecar
  ok('la conexion vieja no sigue en pie en la clave que lee el panel',
    !!d && d.connection !== 'open', JSON.stringify(d))
  ok('y el QR viejo tampoco: escanear uno de la sesion anterior falla sin explicacion',
    !!d && !d.qr, JSON.stringify(d))
  apagar()
}

// ───────── el reintento: el panel ya no manda a reiniciar Orca ─────────
// "Reinicie Orca" es lo mas debil que puede decir un panel: manda a apagar la aplicacion
// entera por un proceso hijo que el propio plugin sabe relanzar.
console.log('\nworker: el reintento del panel relanza el sidecar sin reiniciar Orca')
{
  const authFalso = join(RAIZ, 'auth-reintento')
  const arranques = join(RAIZ, 'arranques.txt')
  const resolvedor = join(RAIZ, 'resolve-reintento.mjs')
  writeFileSync(resolvedor,
    'import { mkdirSync } from "node:fs"\n' +
    'const dir = ' + JSON.stringify(authFalso) + '\n' +
    'mkdirSync(dir, { recursive: true })\n' +
    'process.stdout.write(JSON.stringify({ ok: true, dir }))\n')

  const guion = join(RAIZ, 'sidecar-cuenta-arranques.cjs')
  writeFileSync(guion,
    '#!/usr/bin/env node\n' +
    'require("node:fs").appendFileSync(' + JSON.stringify(arranques) + ', "x\\n")\n' +
    'setInterval(() => {}, 1000)\n', { mode: 0o755 })

  const orca = hostFalso(herramientas('reintento', '#!/bin/sh\necho \'[]\'\n'), {}, guion)
  orca.host.call = (function (original) {
    return async (action, params) => {
      if (action === 'settings.get') {
        return { value: { toolsDir: join(RAIZ, 'reintento'), sidecarPath: guion,
          authDirResolverPath: resolvedor } }
      }
      return original(action, params)
    }
  })(orca.host.call)

  const { apagar } = await arranca(orca)
  await hasta(() => existsSync(arranques), 10000)
  const cuenta = () => existsSync(arranques)
    ? readFileSync(arranques, 'utf8').trim().split('\n').filter(Boolean).length : 0
  const antes = cuenta()

  orca.store.sidecarRequest = { id: 'pedido-reintento', action: 'reintentar',
    at: new Date().toISOString() }
  const contestado = await hasta(() => orca.store.sidecarResult &&
    orca.store.sidecarResult.requestId === 'pedido-reintento', 15000)
  ok('el reintento tambien llega al worker por el mismo canal', contestado,
    JSON.stringify(orca.store.sidecarResult))
  ok('y contesta con su propio codigo estable',
    orca.store.sidecarResult && orca.store.sidecarResult.ok === true &&
    orca.store.sidecarResult.code === 'reintentado',
    JSON.stringify(orca.store.sidecarResult))
  // Se ESPERA a que el hijo deje su marca en vez de leerla en el acto: el veredicto se
  // escribe cuando el worker ya hizo `spawn`, y un Node recien nacido tarda un momento
  // mas en llegar a su primera linea. Leer ahi mismo medía la carrera, no el relanzamiento.
  const relanzo = await hasta(() => cuenta() > antes, 10000)
  const despues = cuenta()
  ok('el sidecar se lanzo de nuevo de verdad, no solo se dijo que si',
    relanzo && despues > antes, `antes=${antes} despues=${despues}`)
  apagar()
}

// ───────── un pedido viejo no se atiende, pero tampoco se calla ─────────
console.log('\nworker: un pedido viejo del panel se descarta con motivo')
{
  const orca = hostFalso(herramientas('viejo', '#!/bin/sh\necho \'[]\'\n'), {})
  const { apagar } = await arranca(orca)
  orca.store.sidecarRequest = { id: 'pedido-viejo', action: 'desvincular',
    at: new Date(Date.now() - 30 * 60 * 1000).toISOString() }
  const contestado = await hasta(() => orca.store.sidecarResult &&
    orca.store.sidecarResult.requestId === 'pedido-viejo', 10000)
  ok('el pedido de otra sesion igual deja veredicto: callarlo deja al panel esperando ' +
    'una respuesta que no va a llegar', contestado,
    JSON.stringify(orca.store.sidecarResult))
  ok('y el veredicto dice que vencio, no que salio bien',
    orca.store.sidecarResult && orca.store.sidecarResult.ok === false &&
    orca.store.sidecarResult.code === 'vencido',
    JSON.stringify(orca.store.sidecarResult))
  apagar()
}

// ───────── el resolvedor sabe borrar, y borra lo que dijo que borraria ─────────
// El worker NO puede borrar el auth state: su valla declara `--allow-fs-read` sobre la
// raiz del plugin y nada de escritura (docs/ENCARGO...§1). El borrado ocurre en el
// MISMO guion que resuelve la ruta, y no en un hermano, porque dos copias de la tabla
// de raices de userData pueden discrepar — y discrepar aca significa borrar la carpeta
// equivocada o dejar viva la que se pidio borrar.
console.log('\nworker: el resolvedor de auth borra el directorio cuando se lo piden')
{
  const casa = join(RAIZ, 'home-borrado')
  const soporte = join(casa, 'Library', 'Application Support')
  mkdirSync(join(soporte, 'orca'), { recursive: true })
  mkdirSync(join(casa, '.config', 'orca'), { recursive: true })
  mkdirSync(join(casa, 'AppData', 'Roaming', 'orca'), { recursive: true })
  const entorno = { ...process.env, HOME: casa,
    XDG_CONFIG_HOME: join(casa, '.config'), APPDATA: join(casa, 'AppData', 'Roaming') }
  const guion = join(PLUGIN_DIR, 'sidecar', 'resolve-auth-dir.mjs')

  const correr = (args) => new Promise((resolve) => {
    execFileNode(process.execPath, [guion, PLUGIN_DIR, ...args], { env: entorno },
      (error, stdout) => resolve({ error, salida: JSON.parse(stdout || 'null') }))
  })

  const a = await correr([])
  ok('sin --borrar sigue contestando la ruta y no toca nada',
    a.salida && a.salida.ok === true && isAbsolute(String(a.salida.dir || '')),
    JSON.stringify(a.salida))
  mkdirSync(a.salida.dir, { recursive: true })
  writeFileSync(join(a.salida.dir, 'creds.json'), '{"credencial":"viva"}')

  const b = await correr(['--borrar'])
  ok('con --borrar contesta que borro', b.salida && b.salida.ok === true &&
    b.salida.borrado === true, JSON.stringify(b.salida))
  ok('y la credencial viva ya no esta en el disco',
    !existsSync(join(a.salida.dir, 'creds.json')), a.salida.dir)

  // Desvincular sin nada vinculado no es un error: es lo que el usuario pidio, ya hecho.
  const c = await correr(['--borrar'])
  ok('borrar lo que ya no esta no falla: el resultado que el usuario pidio ya es cierto',
    c.salida && c.salida.ok === true, JSON.stringify(c.salida))
}

// El hijo que resuelve el auth dir y el sidecar mismo tienen que correr SIN la valla
// de permisos: ese es el motivo entero de lanzarlos fuera del worker. Pero Node no
// deja escapar por el entorno — cuando el proceso vallado lanza otro le inyecta el
// mismo --permission en el NODE_OPTIONS del hijo, y lo hace aunque uno borre la
// variable o pase un entorno minimo. Medido: con el entorno tal cual, borrado, vacio
// o reducido a PATH y HOME, el hijo nace vallado en los cuatro casos.
//
// La salida es no ser Node en el medio: `/usr/bin/env -u NODE_OPTIONS` no es un
// proceso de Node, asi que Node no le inyecta nada, y `env` borra la variable antes
// de ejecutar el binario. Sin esto el sidecar hereda lectura sobre la raiz del plugin
// y CERO escritura, con lo cual no puede guardar el auth state — y guardarlo es el
// motivo por el que existe como proceso aparte.
{
  const m = mandoSinValla('/ruta/al/node', ['guion.mjs', 'argumento'])
  if (process.platform === 'win32') {
    ok('en Windows no hay /usr/bin/env: se lanza directo y se asume la limitacion',
      m.cmd === '/ruta/al/node' && m.args[0] === 'guion.mjs', JSON.stringify(m))
  } else {
    ok('no lanza el binario directo: Node le inyectaria la valla al hijo',
      m.cmd !== '/ruta/al/node', JSON.stringify(m.cmd))
    ok('lanza por un intermediario que NO es Node', m.cmd === '/usr/bin/env', m.cmd)
    ok('le quita NODE_OPTIONS, que es por donde viaja la valla',
      m.args[0] === '-u' && m.args[1] === 'NODE_OPTIONS', JSON.stringify(m.args.slice(0, 2)))
    ok('el binario y sus argumentos quedan intactos detras',
      m.args[2] === '/ruta/al/node' && m.args[3] === 'guion.mjs' && m.args[4] === 'argumento',
      JSON.stringify(m.args.slice(2)))
  }
}

rmSync(RAIZ, { recursive: true, force: true })
// ───────── desvincular espera a que el viejo MUERA antes de borrarle debajo ─────────
// Reportado en produccion: "desvinculo y ya no conecta otro, sale error y error".
// `apagarSidecar()` mandaba la senal y volvia al instante. Baileys escribe su auth
// state al cerrar, asi que el moribundo recreaba archivos DENTRO de `wa-auth` despues
// del borrado; el sidecar nuevo arrancaba sobre esa credencial a medias, no autenticaba
// y se caia, y reintentar caia igual porque la mezcla seguia ahi.
console.log('\nworker: desvincular espera a que el sidecar viejo muera antes de borrar')
{
  // Este bloque corre al final, cuando alguna limpieza anterior ya pudo llevarse RAIZ.
  mkdirSync(RAIZ, { recursive: true })
  const authFalso = join(RAIZ, 'auth-carrera')
  const resolvedor = join(RAIZ, 'resolve-carrera.mjs')
  writeFileSync(resolvedor,
    'import { rmSync } from "node:fs"\n' +
    'const dir = ' + JSON.stringify(authFalso) + '\n' +
    'if (process.argv.includes("--borrar")) rmSync(dir, { recursive: true, force: true })\n' +
    'process.stdout.write(JSON.stringify({ ok: true, dir }))\n')
  mkdirSync(authFalso, { recursive: true })
  writeFileSync(join(authFalso, 'creds.json'), '{"credencial":"viva"}')

  // El sidecar de mentira hace lo mismo que Baileys: al recibir SIGTERM guarda su
  // estado y RECIEN entonces se va. Si el worker borra sin esperarlo, ese archivo
  // aparece despues del borrado y queda una credencial a medias.
  const guion = join(RAIZ, 'sidecar-escribe-al-morir.cjs')
  writeFileSync(guion,
    '#!/usr/bin/env node\n' +
    'const { writeFileSync, mkdirSync } = require("node:fs")\n' +
    'const { join } = require("node:path")\n' +
    'const dir = ' + JSON.stringify(authFalso) + '\n' +
    'process.on("SIGTERM", () => {\n' +
    '  setTimeout(() => {\n' +
    '    try { mkdirSync(dir, { recursive: true }) } catch (e) {}\n' +
    '    try { writeFileSync(join(dir, "escrito-al-morir.json"), "{}") } catch (e) {}\n' +
    '    process.exit(0)\n' +
    '  }, 2500)\n' +
    '})\n' +
    'process.stdout.write(JSON.stringify({ type: "connection", state: "open" }) + "\\n")\n' +
    'setInterval(() => {}, 1000)\n', { mode: 0o755 })

  const orca = hostFalso(herramientas('carrera', '#!/bin/sh\necho \'[]\'\n'), {}, guion)
  orca.host.call = (function (original) {
    return async (action, params) => {
      if (action === 'settings.get') {
        return { value: { toolsDir: join(RAIZ, 'carrera'), sidecarPath: guion,
          authDirResolverPath: resolvedor } }
      }
      return original(action, params)
    }
  })(orca.host.call)

  const { apagar } = await arranca(orca)
  await hasta(() => orca.store.sidecar && orca.store.sidecar.connection === 'open', 10000)

  orca.store.sidecarRequest = { id: 'carrera-1', action: 'desvincular',
    at: new Date().toISOString() }
  await hasta(() => orca.store.sidecarResult &&
    orca.store.sidecarResult.requestId === 'carrera-1', 15000)

  // Margen de sobra para que un moribundo no esperado hubiera escrito ya.
  await dormir(4000)
  const resucitado = existsSync(join(authFalso, 'escrito-al-morir.json'))
  ok('el sidecar viejo no resucita la credencial despues del borrado', !resucitado,
    `escrito-al-morir.json presente=${resucitado}`)

  apagar()
}

console.log(`\n${pruebas - fallos}/${pruebas} en verde`)
process.exit(fallos ? 1 : 0)
