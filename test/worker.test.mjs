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
import { envSinValla } from '../main.mjs'
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
    '    if (a === "settings.get") return { value: { toolsDir: process.argv[3], sidecarPath: process.argv[4] } }\n' +
    '    return { ok: true }\n' +
    '  } },\n' +
    '  commands: { register () {} },\n' +
    '  events: { on () {} }\n' +
    '}\n' +
    // "roto" es un `node` hijo que ni levanta: sale con 9 y no escribe nada en stdout.
    // Es el resolvedor que CORRIO y no contesto, que no es ni "no hay userData" ni
    // "no me dejaron lanzarlo".
    'if (process.argv[5] === "roto") process.env.NODE_OPTIONS = "--esto-no-es-una-bandera"\n' +
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

// El hijo que resuelve el auth dir y el sidecar mismo tienen que correr SIN la valla
// de permisos: ese es el motivo entero de lanzarlos fuera del worker. Pero Node pasa
// la valla a los hijos por NODE_OPTIONS, y `{ ...process.env }` la copia tal cual. El
// sintoma no se parece a la causa: el hijo arranca, avisa con un SecurityWarning sobre
// --allow-child-process, y muere en el primer existsSync con "Access to this API has
// been restricted". El worker solo ve "Command failed" y lo reporta como fallo del
// resolvedor, que es cierto y no sirve para nada.
{
  const conValla = {
    PATH: '/usr/bin',
    NODE_OPTIONS: '--permission --allow-fs-read=/algo --allow-child-process --max-old-space-size=512'
  }
  const limpio = envSinValla(conValla)
  ok('quita --permission del NODE_OPTIONS heredado',
    !/--permission/.test(limpio.NODE_OPTIONS || ''), JSON.stringify(limpio.NODE_OPTIONS))
  ok('quita --allow-fs-read del NODE_OPTIONS heredado',
    !/--allow-fs-read/.test(limpio.NODE_OPTIONS || ''), JSON.stringify(limpio.NODE_OPTIONS))
  ok('quita --allow-child-process del NODE_OPTIONS heredado',
    !/--allow-child-process/.test(limpio.NODE_OPTIONS || ''), JSON.stringify(limpio.NODE_OPTIONS))
  ok('CONSERVA las opciones que no son la valla: borrar NODE_OPTIONS entero cambiaria ' +
    'como corre el hijo por razones que no tienen nada que ver con los permisos',
    /--max-old-space-size=512/.test(limpio.NODE_OPTIONS || ''), JSON.stringify(limpio.NODE_OPTIONS))
  ok('no toca el resto del entorno', limpio.PATH === '/usr/bin', JSON.stringify(limpio.PATH))

  const soloValla = envSinValla({ PATH: '/usr/bin', NODE_OPTIONS: '--permission' })
  ok('si no queda nada, borra NODE_OPTIONS en vez de dejarlo vacio: una cadena vacia ' +
    'no es lo mismo que ausente para quien la lea despues',
    !('NODE_OPTIONS' in soloValla), JSON.stringify(soloValla))

  const sinNada = envSinValla({ PATH: '/usr/bin' })
  ok('sin NODE_OPTIONS lo deja igual', !('NODE_OPTIONS' in sinNada) && sinNada.PATH === '/usr/bin')
}

rmSync(RAIZ, { recursive: true, force: true })
console.log(`\n${pruebas - fallos}/${pruebas} en verde`)
process.exit(fallos ? 1 : 0)
