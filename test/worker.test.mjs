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
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync,
  statSync, readdirSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile as execFileNode } from 'node:child_process'
import { EventEmitter } from 'node:events'

// Falla hasta que se demuestre lo contrario. `activate()` instala sus propios
// `uncaughtException`/`unhandledRejection` (la autopsia del worker), asi que una
// excepcion a mitad de esta prueba no la tumba: se la traga, el proceso se vacia y salia
// con 0 sin haber corrido la mitad de los casos. Solo la ultima linea, que cuenta los
// fallos de verdad, decide el codigo de salida.
process.exitCode = 1

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

// Y sin la CLI de Orca de verdad: al activarse el worker le pregunta a Orca por las
// automatizaciones del plugin y enciende las apagadas (caso-en-archivo, T4). Una prueba
// nunca le cambia nada al Orca del dueno: cada una que necesita la CLI pone la suya.
process.env.PATH = String(process.env.PATH ?? '').split(':').filter((dir) => dir &&
  !['orca', 'orca-ide'].some((nombre) => existsSync(join(dir, nombre)))).join(':')
delete process.env.ORCA_CLI_COMMAND

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

const {
  default: activate, intervaloSync, lanzarSidecar, programarIngesta, correrIngesta,
  INGESTA_AVISOS_MAX, INGESTA_ESPERA_MS
} = await import('../main.mjs')
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
  // La boveda de `secrets`: el worker es el unico que la toca (el panel no puede).
  const secrets = {}
  return {
    store,
    secrets,
    logs,
    avisos,
    log: (m) => logs.push(String(m)),
    host: {
      call: async (action, params) => {
        if (action === 'storage.get') return { value: store[params.key] }
        if (action === 'storage.set') { store[params.key] = params.value; return { ok: true } }
        if (action === 'secrets.get') return { value: secrets[params.key] ?? null }
        if (action === 'secrets.set') { secrets[params.key] = params.value; return { ok: true } }
        if (action === 'secrets.delete') { delete secrets[params.key]; return { ok: true } }
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
  const lee = (n) => readFileSync(join(carpeta, n), 'utf8')
  const puestos = (e?.files ?? []).map((f) => f.name).sort()
  // PROJECTS.md es el quinto y es DISTINTO de los otros cuatro: no sale de harness/ sino
  // de la lista de proyectos que el dueno acepto en los ajustes. Se siembra siempre,
  // vacio incluido, porque el AGENTS.md lo nombra y un archivo nombrado que no existe es
  // una instruccion que el agente obedece sin obtener nada.
  ok('deja los archivos del arnes, las dos skills, el CLAUDE.md y lo generado',
    puestos.join(',') === ['.claude/skills/whatsapp-cli/SKILL.md',
      '.claude/skills/whatsapp-soporte/SKILL.md', '.wa-bin', 'AGENTS.md', 'CLASSIFICATION.md',
      'CLAUDE.md', 'COMMANDS.md', 'EXAMPLES.md', 'PROJECTS.md'].join(','),
    puestos.join(','))
  // `.wa-bin`: la ruta del bin de ESTE plugin, una linea. Es la que leen primero el prompt
  // y las dos automations; `bin-path` (abajo) es su respaldo.
  ok('siembra `.wa-bin` con la ruta de las herramientas que usa el worker',
    lee('.wa-bin') === `${dir}\n`, JSON.stringify(lee('.wa-bin')))
  // Y la misma ruta en un lugar fijo del usuario, fuera de la carpeta de trabajo: un agente
  // de cualquier proyecto llega a las herramientas del plugin instalado sin saber donde
  // esta su userData (cli-huecos, C5).
  const puntero = process.platform === 'win32'
    ? join(process.env.APPDATA, 'wa-inbox', 'bin-path')
    : join(process.env.HOME, '.wa-inbox', 'bin-path')
  ok('deja `bin-path` en la carpeta de estado de las herramientas, con la misma ruta',
    existsSync(puntero) && readFileSync(puntero, 'utf8') === `${dir}\n`,
    existsSync(puntero) ? JSON.stringify(readFileSync(puntero, 'utf8')) : 'no existe')
  ok('y la siembra dice donde lo dejo', e?.binPath?.path === puntero, JSON.stringify(e?.binPath))
  // Las skills van donde Claude Code las lee, con un frontmatter valido.
  for (const nombre of ['whatsapp-soporte', 'whatsapp-cli']) {
    const skill = lee(`.claude/skills/${nombre}/SKILL.md`)
    ok(`la skill ${nombre} se siembra con su frontmatter`,
      skill.startsWith(`---\nname: ${nombre}\ndescription: `) && /\n---\n/.test(skill),
      skill.slice(0, 120))
    ok(`y ${nombre} no manda a Take or Ignore`, !/Take or Ignore|only-taken/i.test(skill))
  }
  ok('el CLAUDE.md sembrado apunta a AGENTS.md y a las skills',
    /AGENTS\.md/.test(lee('CLAUDE.md')) && /whatsapp-soporte/.test(lee('CLAUDE.md')))

  // Las cinco reglas duras tienen que llegar al archivo que Orca le mete al contexto.
  const agentes = lee('AGENTS.md')
  for (const [nombre, frase] of [
    ['la credencial', 'credential never passes through the agent'],
    ['no enviar', 'You never send anything on WhatsApp'],
    ['la duda', 'When in doubt, you propose nothing'],
    ['las promesas', 'Never promise a date or a price'],
    ['el tono', 'come from `wa-scope voice`']
  ]) {
    ok(`el AGENTS.md sembrado lleva la regla de ${nombre}`, agentes.includes(frase))
  }
  // El arnes describe el modelo de casos: ningun archivo sembrado manda al dueno a botones
  // que ya no existen.
  for (const n of ['AGENTS.md', 'CLASSIFICATION.md', 'COMMANDS.md', 'EXAMPLES.md']) {
    ok(`el ${n} sembrado ya no habla de Take or Ignore`,
      !/Take or Ignore|only-taken|take lock/i.test(lee(n)))
  }
  // El orquestador: por caso, o redacta la respuesta o despacha el pedido al proyecto, y
  // nunca envia el mismo.
  for (const [nombre, frase] of [
    ['la lista de proyectos', 'PROJECTS.md'],
    ['despachar al proyecto', '**Dispatch** when answering needs work in a codebase'],
    ['no enviar por WhatsApp', 'You propose; you never send.'],
    ['reportar el resultado', 'wa-scope caso resultado']
  ]) {
    ok(`el AGENTS.md sembrado lleva el orquestador: ${nombre}`, agentes.includes(frase),
      frase)
  }
  const generado = existsSync(join(carpeta, 'PROJECTS.md')) ? lee('PROJECTS.md') : ''
  ok('y PROJECTS.md sin proyectos lo dice, con la advertencia de que se reescribe',
    /No projects accepted yet/.test(generado) && /overwritten/.test(generado.slice(0, 400)),
    generado.slice(0, 200))
  // Y la referencia sale del `--help` de verdad, no de una transcripcion a mano.
  ok('la referencia se genera con el --help de las herramientas',
    lee('COMMANDS.md').includes('AYUDA V1 de wa-scope --help'))
  ok('y tambien el de los subcomandos que usa el prompt',
    lee('COMMANDS.md').includes('AYUDA V1 de wa-scope voice --help'))

  // ── segunda activacion: el usuario edito una seccion y agrego otra suya.
  const antes = lee('COMMANDS.md')
  const rutaSkill = join(carpeta, '.claude', 'skills', 'whatsapp-soporte', 'SKILL.md')
  const skillAntes = readFileSync(rutaSkill, 'utf8')
  writeFileSync(rutaSkill, skillAntes.replace('## Tone', '## Tone\n\nMI TONO'))
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
  const skillDespues = readFileSync(rutaSkill, 'utf8')
  ok('una seccion de la skill que el usuario edito queda como suya',
    skillDespues.includes('MI TONO') &&
    (e2?.files ?? []).find((f) => f.name.endsWith('whatsapp-soporte/SKILL.md'))?.yours.includes('Tone'))
  ok('y lo demas de la skill sigue siendo el del plugin', skillDespues.includes('## Never'))
  ok('`.wa-bin` no cambia entre activaciones', lee('.wa-bin') === `${dir}\n` &&
    (e2?.files ?? []).find((f) => f.name === '.wa-bin')?.action === 'igual')
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
  // El puntero no depende de la carpeta que Orca le da al plugin: se deja igual.
  const puntero = process.platform === 'win32'
    ? join(process.env.APPDATA, 'wa-inbox', 'bin-path')
    : join(vacio, '.wa-inbox', 'bin-path')
  ok('sin carpeta de trabajo igual deja `bin-path`', existsSync(puntero) &&
    readFileSync(puntero, 'utf8').trim() === herramientas('bueno-2', BUENO),
  existsSync(puntero) ? readFileSync(puntero, 'utf8') : 'no existe')
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

// ───────── la salud se vuelve a mirar, sin repetir el mismo aviso ─────────
// `checkSystem` corria UNA vez, al activar: un sidecar que moria despues dejaba el
// diagnostico en verde para siempre. Ahora se repite; y repetirlo no puede repetir la
// notificacion, o cada cinco minutos saldria el mismo aviso hasta que dejen de leerlos.
console.log('\nworker: la salud se revisa sola, y el mismo aviso no se repite')
{
  const { programarSalud, checkSystem, SALUD_MS } = await import('../main.mjs')
  ok('se revisa cada pocos minutos, no cada segundo', SALUD_MS >= 60000 && SALUD_MS <= 15 * 60000,
    String(SALUD_MS))
  let vueltas = 0
  const parar = programarSalud(async () => { vueltas += 1 }, 100)
  await dormir(450)
  parar()
  const alParar = vueltas
  await dormir(300)
  ok('la revision se repite', alParar >= 3, `vueltas=${alParar}`)
  ok('y se detiene cuando se apaga el plugin', vueltas === alParar,
    `al parar=${alParar} despues=${vueltas}`)
  // Una revision lenta (el doctor tarda) no se encima con la siguiente.
  let enVuelo = 0
  let maximo = 0
  const pararLenta = programarSalud(async () => {
    enVuelo += 1; maximo = Math.max(maximo, enVuelo)
    await dormir(250)
    enVuelo -= 1
  }, 50)
  await dormir(600)
  pararLenta()
  ok('dos revisiones no corren a la vez', maximo === 1, `maximo=${maximo}`)

  const DOCTOR_ACCIONABLE = '#!/usr/bin/env node\n' +
    'console.log(JSON.stringify([{ check: "sqlite3 available", ok: false,' +
    ' detalle: "not in PATH", requerido: true, code: "sqlite3" }]))\nprocess.exit(1)\n'
  const dir = herramientas('doctor-repetido', '#!/bin/sh\necho \'[]\'\n')
  writeFileSync(join(dir, 'wa-read'), DOCTOR_ACCIONABLE, { mode: 0o755 })
  const orca = hostFalso(dir, { chats: [] })
  const memoria = {}
  await checkSystem(orca, dir, memoria)
  await checkSystem(orca, dir, memoria)
  ok('el mismo requisito, dos revisiones: UN aviso', orca.avisos.length === 1,
    JSON.stringify(orca.avisos))

  // La linea muda bloquea y se pinta en el panel, al lado del QR: igual que "sin
  // transporte", no saca notificacion.
  const DOCTOR_MUDO = '#!/usr/bin/env node\n' +
    'console.log(JSON.stringify([{ check: "a message transport", ok: false,' +
    ' detalle: "no sign of life", requerido: true, code: "transport-silent" }]))\n' +
    'process.exit(1)\n'
  const dirMudo = herramientas('doctor-mudo', '#!/bin/sh\necho \'[]\'\n')
  writeFileSync(join(dirMudo, 'wa-read'), DOCTOR_MUDO, { mode: 0o755 })
  const orcaMudo = hostFalso(dirMudo, { chats: [] })
  await checkSystem(orcaMudo, dirMudo, {})
  ok('la linea muda llega al panel', orcaMudo.store.health &&
    orcaMudo.store.health.problemCode === 'transport-silent', JSON.stringify(orcaMudo.store.health))
  ok('y no saca notificacion: el panel ya lo dice', orcaMudo.avisos.length === 0,
    JSON.stringify(orcaMudo.avisos))
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
  // El userData va donde lo pondria ESTA plataforma, y el env del hijo se arma entero.
  // Antes se creaba siempre el layout de macOS y solo se pasaba HOME: en Linux el hijo
  // heredaba el XDG_CONFIG_HOME de arriba, sembraba en el HOME comun de este archivo y
  // la comprobacion quedaba roja para siempre sin que dijera nada util. Una prueba que
  // solo corre de verdad en la maquina de quien la escribio es como no tenerla — es
  // justo la que tenia que haber visto que `orca-ide` faltaba en la tabla.
  const envHijo = { ...process.env, HOME: casa }
  let baseCasa
  if (process.platform === 'darwin') {
    baseCasa = join(casa, 'Library', 'Application Support')
    delete envHijo.XDG_CONFIG_HOME
    delete envHijo.APPDATA
  } else if (process.platform === 'win32') {
    baseCasa = join(casa, 'AppData', 'Roaming')
    envHijo.APPDATA = baseCasa
    delete envHijo.XDG_CONFIG_HOME
  } else {
    baseCasa = join(casa, '.config')
    envHijo.XDG_CONFIG_HOME = baseCasa
    delete envHijo.APPDATA
  }
  mkdirSync(join(baseCasa, 'orca'), { recursive: true })
  const hijo = await new Promise((resolve) => {
    execFileNode(process.execPath, [join(PLUGIN_DIR, 'harness.mjs'), PLUGIN_DIR,
      join(PLUGIN_DIR, 'bin')],
    { timeout: 120000, env: envHijo }, (error, stdout) =>
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

// ───────── el latido de la linea llega a storage ─────────
console.log('\nworker: el latido del sidecar llega al panel')
{
  const guion = join(RAIZ, 'sidecar-late.cjs')
  writeFileSync(guion,
    '#!/usr/bin/env node\n' +
    'function emit (m) { process.stdout.write(JSON.stringify(m) + "\\n") }\n' +
    'emit({ type: "connection", state: "open" })\n' +
    'setTimeout(() => emit({ type: "latido", ts: 1758500000000, conectado: true }), 50)\n' +
    'setInterval(() => {}, 1000)\n',
    { mode: 0o755 })
  const orca = hostFalso(herramientas('sidecar-late', '#!/bin/sh\necho \'[]\'\n'), {}, guion)
  const { apagar } = await arranca(orca)
  await hasta(() => orca.store.sidecar && orca.store.sidecar.latido, 10000)
  const l = orca.store.sidecar && orca.store.sidecar.latido
  ok('el latido queda en la clave que leen los paneles', !!l, JSON.stringify(orca.store.sidecar))
  ok('con la hora del sidecar, no la de la escritura', l && l.ts === 1758500000000,
    JSON.stringify(l))
  ok('y si el socket estaba abierto', l && l.conectado === true, JSON.stringify(l))
  apagar()
}

// ───────── T9: de que numero es la linea, y que pasa cuando cambia ─────────
console.log('\nworker: la linea vinculada llega al panel y un numero nuevo dispara un sync')
{
  // Cada numero, su linea. El panel necesita saber CUAL esta vinculada para no pintar
  // lo del numero anterior como si fuera del nuevo, y lo que muestra (conversaciones,
  // actividad, insignia) tiene que rearmarse para el numero nuevo sin esperar 5 min.
  const guion = join(RAIZ, 'sidecar-otra-linea.cjs')
  writeFileSync(guion,
    '#!/usr/bin/env node\n' +
    'function emit (m) { process.stdout.write(JSON.stringify(m) + "\\n") }\n' +
    'emit({ type: "connection", state: "open" })\n' +
    'setTimeout(() => emit({ type: "linea", cuenta: "pn:573000000012", cambio: true, ts: Date.now() }), 50)\n' +
    'setTimeout(() => emit({ type: "identidad", me: "+573000000012", cuenta: "pn:573000000012", reparados: 0, ts: Date.now() }), 100)\n' +
    'setInterval(() => {}, 1000)\n', { mode: 0o755 })
  const syncs = join(RAIZ, 'syncs-linea.txt')
  const wascope = '#!/bin/sh\n' +
    `[ "$1" = "sync" ] && echo "$@" >> ${JSON.stringify(syncs)}\n` +
    'echo \'[{"synced": true, "destinos": []}]\'\n'
  const orca = hostFalso(herramientas('otra-linea', wascope), {}, guion)
  const { apagar } = await arranca(orca)
  const antes = existsSync(syncs) ? readFileSync(syncs, 'utf8').trim().split('\n').length : 0
  await hasta(() => orca.store.sidecar && orca.store.sidecar.cuenta, 10000)
  ok('la cuenta de la linea vinculada queda en la clave que leen los paneles',
    orca.store.sidecar && orca.store.sidecar.cuenta === 'pn:573000000012',
    JSON.stringify(orca.store.sidecar))
  const sincronizo = await hasta(() => existsSync(syncs) &&
    readFileSync(syncs, 'utf8').trim().split('\n').length > antes, 10000)
  ok('y el cambio de linea dispara un sync, sin esperar al reloj', sincronizo,
    existsSync(syncs) ? readFileSync(syncs, 'utf8') : '(sin syncs)')
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

// ───────── credenciales muertas: el QR nuevo aparece solo ─────────
// Medido en la maquina del dueno (2026-10-01): WhatsApp cerro la sesion desde el
// telefono (401), `creds.json` se quedo con `me` puesto y Baileys, con `me`, hace login
// y no registro: ningun reinicio podia producir un QR. El panel ofrecia "Reintentar",
// que repetia el mismo 401. Ahora el sidecar sale con su codigo de credenciales muertas
// y el worker hace solo lo que hace el boton Desvincular: borra y relanza.
console.log('\nworker: con credenciales muertas el QR nuevo aparece sin que nadie apriete nada')
{
  const authFalso = join(RAIZ, 'auth-muerta')
  const borrados = join(RAIZ, 'borrados-muerta.txt')
  const resolvedor = join(RAIZ, 'resolve-muerta.mjs')
  writeFileSync(resolvedor,
    'import { appendFileSync, rmSync } from "node:fs"\n' +
    'const dir = ' + JSON.stringify(authFalso) + '\n' +
    'if (process.argv.includes("--borrar")) {\n' +
    '  appendFileSync(' + JSON.stringify(borrados) + ', "x\\n")\n' +
    '  rmSync(dir, { recursive: true, force: true })\n' +
    '}\n' +
    'process.stdout.write(JSON.stringify({ ok: true, dir }))\n')
  mkdirSync(authFalso, { recursive: true })
  writeFileSync(join(authFalso, 'creds.json'), '{"me":{"id":"573000000000:7@s.whatsapp.net"}}')
  // El almacen de mensajes vive en OTRO lado (`~/.wa-inbox/capture.db`) y no se toca:
  // tirar una credencial no puede llevarse las conversaciones guardadas.
  const almacenFalso = join(RAIZ, 'capture-muerta.db')
  writeFileSync(almacenFalso, 'mensajes')

  // El sidecar de mentira se porta como el de verdad: con `creds.json` (credencial
  // muerta) cierra con 401 y sale con 3; sin ella, registra y emite un QR.
  const guion = join(RAIZ, 'sidecar-credencial-muerta.cjs')
  writeFileSync(guion,
    '#!/usr/bin/env node\n' +
    'const fs = require("node:fs")\n' +
    'const path = require("node:path")\n' +
    'const dir = process.env.WA_SIDECAR_AUTH_DIR\n' +
    'function emit (m) { process.stdout.write(JSON.stringify(m) + "\\n") }\n' +
    'if (fs.existsSync(path.join(dir, "creds.json"))) {\n' +
    '  emit({ type: "connection", state: "close", motivo: "sesion-cerrada", statusCode: 401 })\n' +
    '  emit({ type: "error", code: "sesion-cerrada", detail: "la sesion se cerro" })\n' +
    '  process.stdout.write("", () => process.exit(3))\n' +
    '} else {\n' +
    '  fs.mkdirSync(dir, { recursive: true })\n' +
    '  emit({ type: "qr", qr: "QR-NUEVO", ts: Date.now(), rotation: 1, ttlMs: 75000 })\n' +
    '  setInterval(() => {}, 1000)\n' +
    '}\n', { mode: 0o755 })

  const orca = hostFalso(herramientas('muerta', '#!/bin/sh\necho \'[]\'\n'), {}, guion)
  orca.host.call = (function (original) {
    return async (action, params) => {
      if (action === 'settings.get') {
        return { value: { toolsDir: join(RAIZ, 'muerta'), sidecarPath: guion,
          authDirResolverPath: resolvedor } }
      }
      return original(action, params)
    }
  })(orca.host.call)

  const { apagar } = await arranca(orca)
  const conQr = await hasta(() => orca.store.sidecar && orca.store.sidecar.qr &&
    orca.store.sidecar.qr.qr === 'QR-NUEVO', 15000)
  ok('el QR nuevo llega a storage sin ningun pedido del panel', conQr,
    JSON.stringify(orca.store.sidecar))
  ok('porque la credencial muerta se borro', !existsSync(join(authFalso, 'creds.json')),
    authFalso)
  ok('el pedido del panel no tuvo nada que ver', !orca.store.sidecarRequest,
    JSON.stringify(orca.store.sidecarRequest))
  await dormir(1500)
  const veces = existsSync(borrados)
    ? readFileSync(borrados, 'utf8').trim().split('\n').filter(Boolean).length : 0
  ok('se borro UNA vez: el sidecar nuevo, ya sin credencial, no vuelve a disparar el borrado',
    veces === 1, `borrados=${veces}`)
  ok('y el almacen de mensajes sigue en su lugar', existsSync(almacenFalso), almacenFalso)
  apagar()

  // El codigo de salida es el contrato entre las dos puntas. Vive en dos archivos
  // porque el worker no importa el sidecar (arrastraria Baileys y el almacen dentro de
  // la valla), y por eso se comparan aca: si uno cambia solo, el QR deja de aparecer.
  const { SALIDA } = await import('../sidecar/src/index.js')
  const { SIDECAR_SALIDA } = await import('../main.mjs')
  ok('el worker y el sidecar usan los mismos codigos de salida',
    JSON.stringify(SALIDA) === JSON.stringify(SIDECAR_SALIDA),
    `sidecar=${JSON.stringify(SALIDA)} worker=${JSON.stringify(SIDECAR_SALIDA)}`)
}

// ───────── un sidecar que se rinde deja SU motivo, no "se cayo" ─────────
console.log('\nworker: un sidecar que se rindio deja escrito por que')
{
  const { clasificarSalida, SIDECAR_SALIDA } = await import('../main.mjs')
  // 440 repetido hasta el tope: el sidecar ya mando el motivo por stdout y sale con
  // RENDIDO. Taparlo con `sidecar-cayo` le ofreceria Reintentar al dueno, que es justo
  // el reintento que se acaba de agotar.
  const estado = { motivo: 'sesion-reemplazada',
    error: { code: 'sesion-reemplazada', detail: 'el socket no va a reintentar mas' } }
  const r = clasificarSalida({ code: SIDECAR_SALIDA.RENDIDO, signal: null, estado })
  ok('la salida se clasifica como rendida', r.tipo === 'rendido', JSON.stringify(r))
  ok('y conserva el motivo que mando el sidecar',
    r.motivo === 'sesion-reemplazada' && r.error.code === 'sesion-reemplazada',
    JSON.stringify(r))
  // Si por lo que sea la linea no llego, no se inventa un motivo: queda la caida.
  const sinLinea = clasificarSalida({ code: SIDECAR_SALIDA.RENDIDO, signal: null, estado: {} })
  ok('sin motivo escrito no se inventa uno', sinLinea.error.code === 'sidecar-cayo',
    JSON.stringify(sinLinea))
}

// ───────── la salida nunca tapa la sesion cerrada ─────────
console.log('\nworker: la salida del sidecar no tapa "sesion cerrada"')
{
  const { clasificarSalida } = await import('../main.mjs')
  // El caso medido en la maquina del dueno: el sidecar dijo `sesion-cerrada` y salio
  // con 0. El `exit` escribia `sidecar-cayo` encima, el panel escondia Desvincular y
  // ofrecia Reintentar, que repetia el mismo 401.
  const r = clasificarSalida({ code: 0, signal: null, estado: { motivo: 'sesion-cerrada',
    error: { code: 'sesion-cerrada', detail: 'la sesion se cerro' } } })
  ok('un exit 0 tras "sesion cerrada" sigue diciendo sesion cerrada',
    r.motivo === 'sesion-cerrada' && r.error.code === 'sesion-cerrada', JSON.stringify(r))
  ok('y se trata como credenciales muertas, no como una caida',
    r.tipo === 'credenciales-muertas', JSON.stringify(r))
}

// ───────── una caida se reinicia sola, con espera creciente y tope ─────────
console.log('\nworker: una caida del sidecar se reinicia sola, con backoff y tope')
{
  const { decidirReinicio } = await import('../main.mjs')
  const pasos = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => decidirReinicio(n))
  ok('los primeros reinicios se hacen', pasos[0].reiniciar === true && pasos[1].reiniciar === true,
    JSON.stringify(pasos.slice(0, 2)))
  ok('con espera desde el primero: un proceso que revienta al nacer no se relanza en rafaga',
    pasos[0].esperaMs >= 1000, JSON.stringify(pasos[0]))
  const esperas = pasos.filter((p) => p.reiniciar).map((p) => p.esperaMs)
  ok('cada espera es igual o mayor que la anterior',
    esperas.every((ms, i) => i === 0 || ms >= esperas[i - 1]), JSON.stringify(esperas))
  ok('y hay tope: pasado cierto numero se deja de reiniciar',
    pasos.some((p) => p.reiniciar === false) && pasos[pasos.length - 1].reiniciar === false,
    JSON.stringify(pasos.map((p) => p.reiniciar)))

  // De punta a punta: un sidecar que revienta dos veces y a la tercera conecta. Sin
  // supervisor se quedaba en la primera caida hasta que alguien apretara Reintentar.
  const vidas = join(RAIZ, 'vidas-cae-dos.txt')
  const guion = join(RAIZ, 'sidecar-cae-dos.cjs')
  writeFileSync(guion,
    '#!/usr/bin/env node\n' +
    'const fs = require("node:fs")\n' +
    'fs.appendFileSync(' + JSON.stringify(vidas) + ', "x\\n")\n' +
    'const n = fs.readFileSync(' + JSON.stringify(vidas) + ', "utf8").trim().split("\\n").length\n' +
    'if (n <= 2) process.exit(1)\n' +
    'process.stdout.write(JSON.stringify({ type: "connection", state: "open" }) + "\\n")\n' +
    'setInterval(() => {}, 1000)\n', { mode: 0o755 })
  const orca = hostFalso(herramientas('cae-dos', '#!/bin/sh\necho \'[]\'\n'), {}, guion)
  const { apagar } = await arranca(orca)
  const volvio = await hasta(() => orca.store.sidecar && orca.store.sidecar.connection === 'open',
    20000)
  const cuantas = existsSync(vidas)
    ? readFileSync(vidas, 'utf8').trim().split('\n').filter(Boolean).length : 0
  ok('tras dos caidas el sidecar vuelve solo', volvio, JSON.stringify(orca.store.sidecar))
  ok('relanzandolo de verdad, no solo diciendolo', cuantas === 3, `vidas=${cuantas}`)
  apagar()
  // Apagado el plugin no queda ningun reinicio en el aire.
  await dormir(2500)
  const despues = existsSync(vidas)
    ? readFileSync(vidas, 'utf8').trim().split('\n').filter(Boolean).length : 0
  ok('apagar el plugin no deja un reinicio pendiente', despues === cuantas,
    `antes=${cuantas} despues=${despues}`)
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

// ───────── L1: una carpeta por linea, y la de siempre se muda sin pedir otro QR ─────────
// Varias lineas a la vez necesitan un auth state cada una: `wa-auth/<carpeta>`. La linea
// que ya estaba vinculada vive en `wa-auth/` a secas, y moverla mal es pedirle al dueno un
// QR nuevo sin avisar. Se prueba con una carpeta de mentira: los MISMOS bytes tienen que
// terminar en la carpeta de su numero.
console.log('\nworker: L1 — cada linea en su carpeta, y la de siempre se muda sin QR nuevo')
{
  const casa = join(RAIZ, 'home-lineas')
  for (const base of [join(casa, 'Library', 'Application Support'), join(casa, '.config'),
    join(casa, 'AppData', 'Roaming')]) mkdirSync(join(base, 'orca'), { recursive: true })
  const entorno = { ...process.env, HOME: casa,
    XDG_CONFIG_HOME: join(casa, '.config'), APPDATA: join(casa, 'AppData', 'Roaming') }
  const guion = join(PLUGIN_DIR, 'sidecar', 'resolve-auth-dir.mjs')
  const correr = (args) => new Promise((resolve) => {
    execFileNode(process.execPath, [guion, PLUGIN_DIR, ...args], { env: entorno },
      (error, stdout, stderr) => {
        let salida = null
        try { salida = JSON.parse(stdout || 'null') } catch { salida = null }
        resolve({ error, salida, stderr })
      })
  })

  const base = (await correr([])).salida.dir
  mkdirSync(base, { recursive: true })
  // La forma de hoy: el auth state plano, con `creds.json` y las llaves al lado.
  const archivos = {
    'creds.json': JSON.stringify({ me: { id: '573000000001:7@s.whatsapp.net', name: 'Bot' },
      noiseKey: { private: 'AAAA', public: 'BBBB' } }),
    'pre-key-1.json': '{"privada":"llave-de-prueba-1"}',
    'app-state-sync-key-AAAAAA.json': '{"llave":"de-prueba"}',
    'session-573000000002.0.json': '{"sesion":"de-prueba"}'
  }
  for (const [nombre, texto] of Object.entries(archivos)) writeFileSync(join(base, nombre), texto)

  const a = await correr(['--lineas'])
  const linea = a.salida?.lineas?.[0]
  const carpeta = join(base, 'pn-573000000001')
  ok('la linea de siempre sale con su numero y su carpeta propia',
    a.salida?.ok === true && a.salida.lineas?.length === 1 &&
    linea.cuenta === 'pn:573000000001' && linea.carpeta === 'pn-573000000001' &&
    linea.dir === carpeta, JSON.stringify(a.salida) + a.stderr)
  ok('los MISMOS bytes estan en la carpeta de la linea: la sesion sigue, sin QR nuevo',
    Object.entries(archivos).every(([n, t]) => existsSync(join(carpeta, n)) &&
      readFileSync(join(carpeta, n), 'utf8') === t),
    existsSync(carpeta) ? readdirSync(carpeta).join(',') : 'sin carpeta')
  ok('y no queda ninguna credencial suelta en wa-auth/',
    Object.keys(archivos).every((n) => !existsSync(join(base, n))), readdirSync(base).join(','))
  const otraVez = await correr(['--lineas'])
  ok('mudarla otra vez no mueve nada: la misma linea, la misma carpeta',
    JSON.stringify(otraVez.salida?.lineas) === JSON.stringify(a.salida.lineas),
    JSON.stringify(otraVez.salida))

  // Una linea nueva se vincula en una carpeta `nueva-...`: al arrancar otra vez pasa a la
  // carpeta de su numero.
  const nueva = join(base, 'nueva-prueba1')
  mkdirSync(nueva)
  writeFileSync(join(nueva, 'creds.json'), JSON.stringify({ me: { id: '573000000002:3@s.whatsapp.net' } }))
  // Y una que todavia esta esperando su QR: sin `me`, sigue siendo `nueva-...`.
  mkdirSync(join(base, 'nueva-prueba2'))
  const b = await correr(['--lineas'])
  const porCarpeta = Object.fromEntries((b.salida?.lineas || []).map((l) => [l.carpeta, l.cuenta]))
  ok('la nueva ya vinculada pasa a la carpeta de su numero',
    porCarpeta['pn-573000000002'] === 'pn:573000000002' && !existsSync(nueva) &&
    existsSync(join(base, 'pn-573000000002', 'creds.json')), JSON.stringify(b.salida))
  ok('la que espera su QR sigue esperando, sin numero',
    'nueva-prueba2' in porCarpeta && porCarpeta['nueva-prueba2'] === null, JSON.stringify(b.salida))
  ok('y la de siempre sigue en su lugar', porCarpeta['pn-573000000001'] === 'pn:573000000001',
    JSON.stringify(b.salida))

  // Desvincular UNA linea borra su carpeta y nada mas, y la saca de las activas del almacen.
  const { abrirAlmacen, rutaAlmacen } = await import('../sidecar/src/almacen.js')
  mkdirSync(join(casa, '.wa-inbox'), { recursive: true })
  const alm = abrirAlmacen(rutaAlmacen({ HOME: casa }))
  alm.activarLinea('pn:573000000001')
  alm.sumarLinea('pn:573000000002')
  alm.cerrar()
  const c = await correr(['--borrar', '--carpeta', 'pn-573000000002', '--cuenta', 'pn:573000000002'])
  ok('desvincular una linea borra SU carpeta', c.salida?.ok === true && c.salida.borrado === true &&
    !existsSync(join(base, 'pn-573000000002')), JSON.stringify(c.salida))
  ok('y deja intacta la otra', existsSync(join(carpeta, 'creds.json')), readdirSync(base).join(','))
  const alm2 = abrirAlmacen(rutaAlmacen({ HOME: casa }))
  const activas = alm2.lineasActivas()
  alm2.cerrar()
  ok('y la saca de las lineas activas del almacen',
    JSON.stringify(activas) === JSON.stringify(['pn:573000000001']), JSON.stringify(activas))
  const mala = await correr(['--borrar', '--carpeta', '../pn-573000000001'])
  ok('una carpeta que no es un nombre simple no se borra: ni se intenta',
    mala.salida?.ok === false && mala.salida.reason === 'carpeta-invalida' &&
    existsSync(join(carpeta, 'creds.json')), JSON.stringify(mala.salida))

  // Un auth state plano a medio vincular (sin `me`) es un QR pendiente: no tiene numero.
  const casa2 = join(RAIZ, 'home-lineas-pendiente')
  for (const b2 of [join(casa2, 'Library', 'Application Support'), join(casa2, '.config'),
    join(casa2, 'AppData', 'Roaming')]) mkdirSync(join(b2, 'orca'), { recursive: true })
  const entorno2 = { ...entorno, HOME: casa2, XDG_CONFIG_HOME: join(casa2, '.config'),
    APPDATA: join(casa2, 'AppData', 'Roaming') }
  const correr2 = (args) => new Promise((resolve) => {
    execFileNode(process.execPath, [guion, PLUGIN_DIR, ...args], { env: entorno2 },
      (error, stdout) => resolve(JSON.parse(stdout || 'null')))
  })
  const base2 = (await correr2([])).dir
  mkdirSync(base2, { recursive: true })
  writeFileSync(join(base2, 'creds.json'), '{"noiseKey":{"private":"CCCC"}}')
  const d = await correr2(['--lineas'])
  const pendiente = d?.lineas?.[0]
  ok('un vinculo a medias se muda a una carpeta nueva-..., sin numero',
    d?.lineas?.length === 1 && pendiente.cuenta === null && /^nueva-/.test(pendiente.carpeta) &&
    readFileSync(join(base2, pendiente.carpeta, 'creds.json'), 'utf8') ===
      '{"noiseKey":{"private":"CCCC"}}' && !existsSync(join(base2, 'creds.json')),
    JSON.stringify(d))
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

// ───────── la entrada: un mensaje nuevo se vuelve caso sin esperar al reloj ─────────
console.log('\nworker: el rebote de la entrada junta las rafagas en una sola corrida')
{
  ok('el rebote por defecto es de unos 5 segundos', INGESTA_ESPERA_MS === 5000,
    `${INGESTA_ESPERA_MS}`)
  const corridas = []
  let enCurso = 0
  let simultaneas = 0
  const correr = async () => {
    enCurso += 1
    simultaneas = Math.max(simultaneas, enCurso)
    corridas.push(Date.now())
    await dormir(150)
    enCurso -= 1
  }
  const entrada = programarIngesta(correr, { esperaMs: 80 })
  for (let i = 0; i < 5; i += 1) { entrada.pedir(); await dormir(25) }
  ok('mientras llegan pedidos seguidos no corre: espera a que se calme', corridas.length === 0,
    `${corridas.length} corridas`)
  await hasta(() => corridas.length >= 1, 3000)
  await dormir(400)
  ok('una rafaga de cinco pedidos es UNA corrida', corridas.length === 1,
    `${corridas.length} corridas`)

  // Un pedido que llega con una corrida en curso no arranca otra a la vez: espera, y
  // despues corre UNA vez mas por mucho que hayan sido.
  entrada.pedir()
  await hasta(() => enCurso === 1, 3000)
  for (let i = 0; i < 4; i += 1) entrada.pedir()
  await hasta(() => corridas.length >= 3, 3000)
  await dormir(600)
  ok('los pedidos de una corrida en curso suman UNA corrida mas, no cuatro',
    corridas.length === 3, `${corridas.length} corridas`)
  ok('y nunca hay dos corriendo a la vez', simultaneas === 1, `${simultaneas} a la vez`)

  // Apagar cancela lo que esta esperando.
  const antes = corridas.length
  entrada.pedir()
  entrada.parar()
  await dormir(300)
  ok('parar cancela el pedido que esperaba', corridas.length === antes,
    `${corridas.length - antes} corridas despues de parar`)

  // Una corrida que revienta no apaga la entrada.
  let intentos = 0
  const revienta = programarIngesta(async () => { intentos += 1; throw new Error('x') },
    { esperaMs: 20 })
  revienta.pedir()
  await dormir(150)
  revienta.pedir()
  await dormir(150)
  ok('una corrida que falla no impide la siguiente', intentos === 2, `${intentos} intentos`)
  revienta.parar()
}

console.log('\nworker: la corrida de la entrada no gasta llamadas al host y su log tiene tope')
{
  const marca = join(RAIZ, 'ingesta-llamadas.txt')
  const buena = herramientas('ingesta-buena', '#!/bin/sh\n' +
    `echo "$@" >> ${JSON.stringify(marca)}\n` +
    'echo \'[{"nuevos": 2, "casos": [1]}]\'\n')
  const orca = hostFalso(buena)
  let llamadas = 0
  const original = orca.host.call
  orca.host.call = async (action, params) => { llamadas += 1; return original(action, params) }
  const estado = { avisos: 0 }
  await correrIngesta(orca, buena, estado)
  ok('corre `wa-scope ingest --json`',
    existsSync(marca) && readFileSync(marca, 'utf8').trim() === 'ingest --json',
    existsSync(marca) ? readFileSync(marca, 'utf8') : '(no corrio)')
  ok('es un proceso hijo: cero llamadas al host, que Orca cuenta y mata a las 64',
    llamadas === 0, `${llamadas} llamadas`)
  ok('y una corrida buena no escribe en el log', orca.logs.length === 0,
    JSON.stringify(orca.logs))

  const rota = herramientas('ingesta-rota',
    '#!/bin/sh\necho "NameError: algo se rompio" >&2\nexit 1\n')
  const orca2 = hostFalso(rota)
  const estado2 = { avisos: 0 }
  for (let i = 0; i < INGESTA_AVISOS_MAX + 6; i += 1) await correrIngesta(orca2, rota, estado2)
  ok('una entrada que falla lo dice, con la causa',
    orca2.logs.length > 0 && orca2.logs[0].includes('ingest failed') &&
    orca2.logs[0].includes('NameError'), JSON.stringify(orca2.logs))
  ok('pero el log tiene tope: cada linea es una llamada al host',
    orca2.logs.length === INGESTA_AVISOS_MAX, `${orca2.logs.length} lineas`)
  ok('y la ultima dice que no se registran mas',
    orca2.logs[orca2.logs.length - 1].includes('no se registran mas'),
    orca2.logs[orca2.logs.length - 1])
}

console.log('\nworker: un evento store con mensajes nuevos dispara UNA ingesta, en un hijo')
{
  const guion = join(RAIZ, 'sidecar-store-ingesta.cjs')
  writeFileSync(guion,
    '#!/usr/bin/env node\n' +
    'function emit (m) { process.stdout.write(JSON.stringify(m) + "\\n") }\n' +
    'emit({ type: "connection", state: "open" })\n' +
    'const base = { llegaron: 9, sinAutorizar: 0, actualizados: 0, autorizadas: 1 }\n' +
    // Sin nada nuevo, y despues una rafaga de tres lecturas de un almacen que sigue
    // creciendo, y una cuarta igual a la tercera.
    'setTimeout(() => emit({ type: "store", at: 1, ...base, guardados: 0 }), 100)\n' +
    'setTimeout(() => emit({ type: "store", at: 2, ...base, guardados: 3 }), 300)\n' +
    'setTimeout(() => emit({ type: "store", at: 3, ...base, guardados: 5 }), 500)\n' +
    'setTimeout(() => emit({ type: "store", at: 4, ...base, guardados: 5 }), 700)\n' +
    'setInterval(() => {}, 1000)\n', { mode: 0o755 })
  const llamadas = join(RAIZ, 'ingesta-evento.txt')
  const wascope = '#!/bin/sh\n' +
    `[ "$1" = "ingest" ] && echo "$@ $(date +%s)" >> ${JSON.stringify(llamadas)}\n` +
    'echo \'[{"synced": true, "destinos": []}]\'\n'
  const orca = hostFalso(herramientas('ingesta-evento', wascope), {}, guion)
  const { apagar } = await arranca(orca)
  const antes = Date.now()
  await hasta(() => existsSync(llamadas), 15000)
  const lineas = () => existsSync(llamadas) ? readFileSync(llamadas, 'utf8').trim().split('\n') : []
  ok('llega la ingesta', lineas().length >= 1, '(no corrio)')
  ok('espera el rebote: no corre en cuanto llega el evento', Date.now() - antes >= 3500,
    `${Date.now() - antes} ms`)
  await dormir(2500)
  ok('tres lecturas seguidas de un almacen que crece son UNA ingesta', lineas().length === 1,
    lineas().join(' | '))
  ok('con `ingest --json`', lineas()[0] && lineas()[0].startsWith('ingest --json'),
    lineas()[0])
  apagar()
}

console.log('\nworker: sin mensajes nuevos en el evento store no hay ingesta')
{
  const guion = join(RAIZ, 'sidecar-store-quieto.cjs')
  writeFileSync(guion,
    '#!/usr/bin/env node\n' +
    'function emit (m) { process.stdout.write(JSON.stringify(m) + "\\n") }\n' +
    'emit({ type: "connection", state: "open" })\n' +
    'const base = { llegaron: 4, sinAutorizar: 4, actualizados: 0, autorizadas: 1, guardados: 0 }\n' +
    'setTimeout(() => emit({ type: "store", at: 1, ...base }), 100)\n' +
    'setTimeout(() => emit({ type: "store", at: 2, ...base }), 300)\n' +
    'setInterval(() => {}, 1000)\n', { mode: 0o755 })
  const llamadas = join(RAIZ, 'ingesta-quieta.txt')
  const wascope = '#!/bin/sh\n' +
    `[ "$1" = "ingest" ] && echo "$@" >> ${JSON.stringify(llamadas)}\n` +
    'echo \'[{"synced": true, "destinos": []}]\'\n'
  const orca = hostFalso(herramientas('ingesta-quieta', wascope), {}, guion)
  const { apagar } = await arranca(orca)
  await hasta(() => orca.store.sidecar && orca.store.sidecar.store && orca.store.sidecar.store.at === 2, 10000)
  await dormir(INGESTA_ESPERA_MS + 1500)
  ok('con guardados en 0 no corre nada', !existsSync(llamadas),
    existsSync(llamadas) ? readFileSync(llamadas, 'utf8') : '')
  apagar()
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


// ───────── quitar una regla de texto: el panel pide, el worker borra en LOS DOS lados ──
// Las reglas que se crean con el CLI viven en `scope.db` (tabla `route`) y el sync las
// vuelve a empujar al panel (`rutas_efectivas`). Quitar la fila solo del storage del
// panel dejaba la de la base debajo: la regla "vieja" reaparecia en el siguiente sync.
console.log('\nworker: quitar una regla de texto la saca de la base y del storage')
{
  const dir = herramientas('regla-bueno', [
    '#!/bin/sh',
    'if [ "$1" = "route" ]; then',
    '  echo "$@" >> "$0.llamadas"',
    '  echo \'[{"removed": true}]\'',
    '  exit 0',
    'fi',
    'echo \'[{"synced": true, "destinos": []}]\'',
    ''
  ].join('\n'))
  const llamadas = () => existsSync(join(dir, 'wa-scope.llamadas'))
    ? readFileSync(join(dir, 'wa-scope.llamadas'), 'utf8') : ''
  const orca = hostFalso(dir, {
    chats: [],
    routes: [
      { pattern: 'attus', provider: 'plane', target: 'ATT', note: 'regla vieja' },
      { pattern: 'acme', workspace: 'alfa-demo' }
    ]
  })
  const { apagar } = await arranca(orca)
  const pedir = async (id, extra) => {
    orca.store.scopeRequest = { id, at: new Date().toISOString(), ...extra }
    await hasta(() => orca.store.scopeResult && orca.store.scopeResult.requestId === id, 15000)
    return orca.store.scopeResult
  }

  let v = await pedir('regla-1', { action: 'regla-quitar', pattern: '  ATTUS ' })
  ok('el worker contesta con un codigo estable',
    v && v.ok === true && v.code === 'regla-quitada', JSON.stringify(v))
  ok('corrio `wa-scope route --remove` con el patron limpio y en minusculas',
    /^route --remove=attus$/m.test(llamadas()), JSON.stringify(llamadas()))
  ok('la regla ya no esta en el storage del panel y las demas siguen',
    Array.isArray(orca.store.routes) && orca.store.routes.length === 1 &&
    orca.store.routes[0].pattern === 'acme', JSON.stringify(orca.store.routes))
  ok('borra el pedido: un clic quita una vez', orca.store.scopeRequest === null)

  // Una regla que solo existe en el storage (el CLI borra cero filas y sale con 0).
  orca.store.routes = [{ pattern: 'solo-panel', workspace: 'alfa-demo' },
    { pattern: 'acme', workspace: 'alfa-demo' }]
  v = await pedir('regla-2', { action: 'regla-quitar', pattern: 'solo-panel' })
  ok('una regla que solo esta en el storage tambien se quita',
    v && v.ok === true && orca.store.routes.length === 1 &&
    orca.store.routes[0].pattern === 'acme', JSON.stringify([v, orca.store.routes]))

  // Un patron que no es un patron nunca llega a la linea de comandos.
  const antes = llamadas()
  for (const [id, malo] of [['regla-m1', ''], ['regla-m2', '   '], ['regla-m3', 42],
    ['regla-m4', 'x'.repeat(300)], ['regla-m5', 'a\nb'], ['regla-m6', null]]) {
    v = await pedir(id, { action: 'regla-quitar', pattern: malo })
    ok(`un patron invalido se rechaza con codigo (${JSON.stringify(malo).slice(0, 12)})`,
      v && v.ok === false && v.code === 'patron-invalido', JSON.stringify(v))
  }
  ok('y no corrio nada', llamadas() === antes, JSON.stringify(llamadas()))
  ok('ni toco las reglas', orca.store.routes.length === 1, JSON.stringify(orca.store.routes))
  apagar()
}

{
  // Sin lista de reglas legible NO se escribe una lista vacia: borraria todas por culpa
  // de una lectura fallida.
  const dir = herramientas('regla-sin-lista', [
    '#!/bin/sh', 'echo \'[{"removed": true}]\'', ''].join('\n'))
  const orca = hostFalso(dir, { chats: [] })
  const { apagar } = await arranca(orca)
  orca.store.scopeRequest = { id: 'regla-sl', action: 'regla-quitar', pattern: 'attus',
    at: new Date().toISOString() }
  await hasta(() => orca.store.scopeResult && orca.store.scopeResult.requestId === 'regla-sl',
    15000)
  ok('con la base quitada y sin lista en el storage contesta que si',
    orca.store.scopeResult && orca.store.scopeResult.ok === true,
    JSON.stringify(orca.store.scopeResult))
  ok('y no inventa una lista vacia', !('routes' in orca.store), JSON.stringify(orca.store.routes))
  apagar()
}

{
  // El CLI que no esta: decirlo, y NO quitar la regla del storage (seguiria viva en la
  // base y el panel diria que se fue).
  const orca = hostFalso(herramientas('regla-sin-cli', null), {
    chats: [], routes: [{ pattern: 'attus', provider: 'plane', target: 'ATT' }]
  })
  const { apagar } = await arranca(orca)
  orca.store.scopeRequest = { id: 'regla-mal', action: 'regla-quitar', pattern: 'attus',
    at: new Date().toISOString() }
  await hasta(() => orca.store.scopeResult && orca.store.scopeResult.requestId === 'regla-mal',
    15000)
  const v = orca.store.scopeResult
  ok('si no puede correr el CLI, lo dice con el codigo estable',
    v && v.ok === false && v.code === 'sin-herramientas', JSON.stringify(v))
  ok('y la regla sigue en el storage, sin fingir que se fue',
    orca.store.routes.length === 1, JSON.stringify(orca.store.routes))
  apagar()
}

{
  // El recorrido de verdad: la base real de `wa-scope` en un HOME temporal. Una regla
  // creada con el CLI, quitada por el worker, NO vuelve con el siguiente `wa-scope sync`.
  const CLI = join(PLUGIN_DIR, 'bin', 'wa-scope')
  const dir = herramientas('regla-real', `#!/bin/sh\nexec "${CLI}" "$@"\n`)
  const man = JSON.parse(readFileSync(join(PLUGIN_DIR, 'orca-plugin.json'), 'utf8'))
  const base = process.platform === 'darwin'
    ? join(process.env.HOME, 'Library', 'Application Support', 'orca')
    : join(process.env.HOME, '.config', 'orca')
  const almacen = join(base, 'plugins-data', `${man.publisher}.${man.id}`, 'storage.json')
  mkdirSync(dirname(almacen), { recursive: true })
  const cli = (...args) => new Promise((resolve, reject) => {
    execFileNode(CLI, args, { env: process.env, timeout: 60000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout))
  })
  const reglasDelAlmacen = () => (JSON.parse(readFileSync(almacen, 'utf8')).routes || [])
    .map((r) => r.pattern)

  rmSync(join(process.env.HOME, '.wa-inbox'), { recursive: true, force: true })
  await cli('route', '--match', 'attus', '--provider', 'plane', '--target', 'ATT',
    '--note', 'regla vieja')
  writeFileSync(almacen, JSON.stringify({}))
  await cli('sync')
  ok('antes de quitar, el sync empuja la regla de la base al panel',
    reglasDelAlmacen().includes('attus'), JSON.stringify(reglasDelAlmacen()))

  const orca = hostFalso(dir, { chats: [], routes: [{ pattern: 'attus', provider: 'plane',
    target: 'ATT', note: 'regla vieja' }] })
  const { apagar } = await arranca(orca)
  orca.store.scopeRequest = { id: 'regla-real', action: 'regla-quitar', pattern: 'ATTUS',
    at: new Date().toISOString() }
  await hasta(() => orca.store.scopeResult && orca.store.scopeResult.requestId === 'regla-real',
    30000)
  ok('el worker quita la regla con el CLI real',
    orca.store.scopeResult && orca.store.scopeResult.ok === true,
    JSON.stringify(orca.store.scopeResult))
  apagar()
  // Lo que Orca persistiria del storage del panel, y el sync que corre cada pocos minutos.
  writeFileSync(almacen, JSON.stringify({ routes: orca.store.routes }))
  await cli('sync')
  ok('despues de un `wa-scope sync` la regla quitada sigue quitada',
    !reglasDelAlmacen().includes('attus'), JSON.stringify(reglasDelAlmacen()))
}

// ───────── la llave de Jev es del plugin y el espejo lo escribe el worker ─────────
console.log('\nworker: la llave de Jev, su espejo 0600 y el aviso de que no es obligatoria')
{
  // Una llave de mentira, obviamente falsa. Esta prueba comprueba POR DONDE pasa, y la
  // primera regla es que no pasa por ningun log ni por ningun veredicto.
  const LLAVE = 'tsk-FALSA-0000000000000000'
  const CABECERA = '# wa-inbox jev mirror v1'
  const espejo = join(process.env.HOME, '.wa-inbox', 'jev.env')
  const contenido = () => existsSync(espejo) ? readFileSync(espejo, 'utf8') : null
  rmSync(join(process.env.HOME, '.wa-inbox'), { recursive: true, force: true })

  const orca = hostFalso(herramientas('jev', '#!/bin/sh\necho \'[]\'\n'), { chats: [] })
  const { apagar } = await arranca(orca)
  await hasta(() => orca.store.jevStatus)

  const pedir = async (id, extra) => {
    orca.store.jevRequest = { id, at: new Date().toISOString(), ...extra }
    await hasta(() => orca.store.jevResult && orca.store.jevResult.requestId === id, 15000)
    return orca.store.jevResult
  }

  ok('apagado de fabrica: sin llave, sin espejo y el estado lo dice',
    orca.store.jevStatus && orca.store.jevStatus.enabled === false &&
    orca.store.jevStatus.keySet === false && orca.store.jevStatus.mirror === 'apagado' &&
    contenido() === null, JSON.stringify(orca.store.jevStatus))

  let v = await pedir('jev-on-1', { action: 'activar', enabled: true })
  ok('encenderlo sin llave contesta que si y no escribe nada',
    v && v.ok === true && contenido() === null, JSON.stringify(v))
  ok('y el estado dice que falta la llave',
    orca.store.jevStatus.enabled === true && orca.store.jevStatus.keySet === false &&
    orca.store.jevStatus.mirror === 'sin-llave', JSON.stringify(orca.store.jevStatus))

  v = await pedir('jev-key-1', { action: 'guardar-llave', value: `  ${LLAVE}\n` })
  ok('guardar la llave contesta que si', v && v.ok === true && v.code === 'guardada',
    JSON.stringify(v))
  ok('la llave queda en la boveda de secrets', orca.secrets.jevKey === LLAVE,
    JSON.stringify(orca.secrets))
  ok('el espejo tiene el formato EXACTO del contrato: cabecera y una linea',
    contenido() === `${CABECERA}\nTYPESAFE_API_KEY=${LLAVE}\n`, JSON.stringify(contenido()))
  ok('el espejo es 0600',
    process.platform === 'win32' || (statSync(espejo).mode & 0o777) === 0o600,
    (statSync(espejo).mode & 0o777).toString(8))
  ok('no queda un temporal al lado del espejo',
    readdirSync(dirname(espejo)).every((f) => !f.endsWith('.tmp')),
    JSON.stringify(readdirSync(dirname(espejo))))
  ok('el estado dice que esta guardada y activa, sin decir cual es',
    orca.store.jevStatus.keySet === true && orca.store.jevStatus.mirror === 'activo',
    JSON.stringify(orca.store.jevStatus))
  ok('la llave NO se repite en el estado, ni en el veredicto, ni en el pedido',
    !JSON.stringify([orca.store.jevStatus, orca.store.jevResult, orca.store.jevRequest])
      .includes(LLAVE), JSON.stringify([orca.store.jevStatus, orca.store.jevResult]))
  ok('el pedido con la llave se borra de storage', orca.store.jevRequest === null,
    JSON.stringify(orca.store.jevRequest))

  v = await pedir('jev-off-1', { action: 'activar', enabled: false })
  ok('apagarlo borra el espejo y deja la llave guardada',
    v && v.ok === true && contenido() === null && orca.secrets.jevKey === LLAVE,
    JSON.stringify([v, contenido()]))
  ok('y el estado lo cuenta', orca.store.jevStatus.enabled === false &&
    orca.store.jevStatus.keySet === true && orca.store.jevStatus.mirror === 'apagado',
    JSON.stringify(orca.store.jevStatus))

  v = await pedir('jev-on-2', { action: 'activar', enabled: true })
  ok('encenderlo con la llave puesta reescribe el espejo',
    v && v.ok === true && contenido() === `${CABECERA}\nTYPESAFE_API_KEY=${LLAVE}\n`,
    JSON.stringify([v, contenido()]))

  // Una llave con espacio o salto de linea metida a la fuerza escribiria una segunda
  // linea en el espejo: se rechaza antes de tocar nada.
  for (const [id, malo] of [['jev-mala-1', 'dos palabras'], ['jev-mala-2', 'a\nB=1'],
    ['jev-mala-3', '   '], ['jev-mala-4', 'x'.repeat(600)], ['jev-mala-5', 42]]) {
    v = await pedir(id, { action: 'guardar-llave', value: malo })
    ok(`una llave invalida (${id}) se rechaza y no cambia nada`,
      v && v.ok === false && v.code === 'llave-invalida' && orca.secrets.jevKey === LLAVE &&
      contenido() === `${CABECERA}\nTYPESAFE_API_KEY=${LLAVE}\n`, JSON.stringify(v))
  }

  v = await pedir('jev-del-1', { action: 'quitar-llave' })
  ok('quitar la llave la borra de la boveda y borra el espejo',
    v && v.ok === true && v.code === 'quitada' && orca.secrets.jevKey === undefined &&
    contenido() === null, JSON.stringify([v, orca.secrets, contenido()]))
  ok('y el estado vuelve a decir que falta', orca.store.jevStatus.keySet === false &&
    orca.store.jevStatus.mirror === 'sin-llave', JSON.stringify(orca.store.jevStatus))

  // Un archivo sin la cabecera NO es nuestro —alguien lo copio a mano—: el lector de
  // Python lo trata como "sin llave". Lo que el worker hace por su cuenta (apagar, quitar
  // la llave) no lo borra ni lo pisa; lo que el dueno pide con un gesto explicito
  // (encender el interruptor, guardar la llave) SI lo reemplaza con el espejo.
  const AJENO = 'TYPESAFE_API_KEY=copiada-a-mano\n'
  const ESPEJO = `${CABECERA}\nTYPESAFE_API_KEY=${LLAVE}\n`
  writeFileSync(espejo, AJENO, { mode: 0o600 })
  orca.secrets.jevKey = LLAVE
  v = await pedir('jev-ajeno-2', { action: 'activar', enabled: false })
  ok('apagar no borra el archivo ajeno', contenido() === AJENO, JSON.stringify(contenido()))
  v = await pedir('jev-ajeno-4', { action: 'quitar-llave' })
  ok('quitar la llave tampoco borra el archivo ajeno', contenido() === AJENO,
    JSON.stringify(contenido()))
  orca.secrets.jevKey = LLAVE
  // El caso del dueno: guardo la llave con Jev apagado (no se escribio espejo) y despues
  // encendio el interruptor. Encender es un gesto explicito: reemplaza el archivo ajeno.
  v = await pedir('jev-ajeno-1', { action: 'activar', enabled: true })
  ok('encender el interruptor con llave en la boveda reemplaza el archivo ajeno',
    v && v.ok === true && contenido() === ESPEJO && orca.store.jevStatus.mirror === 'activo',
    JSON.stringify([v, contenido(), orca.store.jevStatus]))
  ok('y el archivo nuevo empieza por la cabecera del plugin',
    (contenido() || '').split('\n')[0] === CABECERA, JSON.stringify(contenido()))
  ok('sin que la llave aparezca en el veredicto ni en el estado',
    !JSON.stringify([v, orca.store.jevStatus]).includes(LLAVE))
  // Apagar y encender otra vez con el espejo ya propio: nada que reemplazar, mismo estado.
  await pedir('jev-ajeno-off', { action: 'activar', enabled: false })
  v = await pedir('jev-ajeno-on', { action: 'activar', enabled: true })
  ok('encender de nuevo con el espejo propio sigue en activo',
    v && v.ok === true && contenido() === ESPEJO && orca.store.jevStatus.mirror === 'activo',
    JSON.stringify([v, contenido()]))
  // Con Jev encendido, un archivo ajeno que aparezca despues lo reemplaza tambien el
  // guardado de la llave desde el panel.
  writeFileSync(espejo, AJENO, { mode: 0o600 })
  v = await pedir('jev-ajeno-5', { action: 'guardar-llave', value: LLAVE })
  ok('escribir la llave en el panel tambien lo reemplaza, con la cabecera',
    v && v.ok === true && contenido() === ESPEJO && orca.store.jevStatus.mirror === 'activo',
    JSON.stringify([v, contenido()]))

  v = await pedir('jev-raro-1', { action: 'inventada' })
  ok('una accion que no existe se contesta, no se calla',
    v && v.ok === false && v.code === 'accion-desconocida', JSON.stringify(v))

  // El panel que se rinde deja una lapida sin la llave: se limpia y no se ejecuta.
  orca.store.jevRequest = { id: 'jev-lapida', at: new Date().toISOString(), tombstone: true }
  await hasta(() => orca.store.jevRequest === null, 15000)
  ok('una lapida del panel se borra sin contestar nada',
    orca.store.jevRequest === null &&
    !(orca.store.jevResult && orca.store.jevResult.requestId === 'jev-lapida'),
    JSON.stringify(orca.store.jevResult))

  ok('ningun log del plugin lleva la llave',
    !orca.logs.some((l) => l.includes(LLAVE)), JSON.stringify(orca.logs))
  apagar()
}

{
  // Al arrancar el worker deja el espejo como dicen los ajustes, sin esperar al panel:
  // una llave puesta en una sesion anterior sigue valiendo, y un espejo que quedo de una
  // sesion en la que Jev ya estaba apagado se va.
  const LLAVE = 'tsk-FALSA-1111111111111111'
  const espejo = join(process.env.HOME, '.wa-inbox', 'jev.env')
  rmSync(join(process.env.HOME, '.wa-inbox'), { recursive: true, force: true })

  const orca = hostFalso(herramientas('jev-arranque', '#!/bin/sh\necho \'[]\'\n'),
    { chats: [], jevEnabled: true })
  orca.secrets.jevKey = LLAVE
  const { apagar } = await arranca(orca)
  await hasta(() => orca.store.jevStatus && orca.store.jevStatus.mirror === 'activo')
  ok('al arrancar con Jev encendido y llave, el espejo queda escrito',
    existsSync(espejo) &&
    readFileSync(espejo, 'utf8') === `# wa-inbox jev mirror v1\nTYPESAFE_API_KEY=${LLAVE}\n`,
    JSON.stringify(orca.store.jevStatus))
  apagar()

  const orca2 = hostFalso(herramientas('jev-arranque-2', '#!/bin/sh\necho \'[]\'\n'),
    { chats: [], jevEnabled: false })
  orca2.secrets.jevKey = LLAVE
  const { apagar: apagar2 } = await arranca(orca2)
  await hasta(() => orca2.store.jevStatus && orca2.store.jevStatus.mirror === 'apagado')
  ok('al arrancar con Jev apagado, el espejo viejo se borra', !existsSync(espejo),
    JSON.stringify(orca2.store.jevStatus))
  apagar2()
}

{
  // Lo que corre por su cuenta (arranque, revision de salud) NO pisa un archivo ajeno:
  // lo dice (`ajeno`) y lo deja intacto. Solo un gesto del dueno lo reemplaza.
  const LLAVE = 'tsk-FALSA-2222222222222222'
  const AJENO = 'TYPESAFE_API_KEY=copiada-a-mano\n'
  const espejo = join(process.env.HOME, '.wa-inbox', 'jev.env')
  rmSync(join(process.env.HOME, '.wa-inbox'), { recursive: true, force: true })
  mkdirSync(join(process.env.HOME, '.wa-inbox'), { recursive: true })
  writeFileSync(espejo, AJENO, { mode: 0o600 })

  const orca = hostFalso(herramientas('jev-arranque-ajeno', '#!/bin/sh\necho \'[]\'\n'),
    { chats: [], jevEnabled: true })
  orca.secrets.jevKey = LLAVE
  const { apagar } = await arranca(orca)
  await hasta(() => orca.store.jevStatus && orca.store.jevStatus.mirror === 'ajeno')
  ok('al arrancar con un archivo ajeno, el estado dice ajeno y el archivo no se toca',
    orca.store.jevStatus && orca.store.jevStatus.mirror === 'ajeno' &&
    orca.store.jevStatus.keySet === true && readFileSync(espejo, 'utf8') === AJENO,
    JSON.stringify([orca.store.jevStatus, readFileSync(espejo, 'utf8')]))
  apagar()
}

// ───────── T6: las acciones del dueno sobre una tarjeta del tablero ─────────
console.log('\nworker: las acciones del dueno sobre el tablero')

// Un wa-scope y un wa-send de mentira que RECUERDAN lo que se les pidio. Son Python
// porque el argv se guarda tal cual (JSON por linea): comprobar cada bandera con un
// grep sobre `$*` no distingue un texto con espacios de dos argumentos.
const ESTADO_FALSO = `
import json, os, sys, hashlib
AQUI = os.path.dirname(os.path.abspath(__file__))
RUTA = os.path.join(AQUI, 'estado.json')
def carga():
    with open(RUTA) as f: return json.load(f)
def guarda(e):
    with open(RUTA, 'w') as f: json.dump(e, f)
def anota(nombre):
    with open(os.path.join(AQUI, nombre), 'a') as f: f.write(json.dumps(sys.argv[1:]) + '\\n')
    # La llave del aprobador que trajo cada llamada (approve-solo-dueno): solo el hijo
    # --approve la puede recibir.
    with open(os.path.join(AQUI, nombre.replace('.jsonl', '-env.jsonl')), 'a') as f:
        f.write(json.dumps(os.environ.get('WA_INBOX_APPROVER')) + '\\n')
def opcion(argv, nombre):
    for i, a in enumerate(argv):
        if a == nombre and i + 1 < len(argv): return argv[i + 1]
        if a.startswith(nombre + '='): return a[len(nombre) + 1:]
    return None
`
const WA_SCOPE_FALSO = '#!/usr/bin/env python3\n' + ESTADO_FALSO + `
anota('scope.jsonl')
argv = sys.argv[1:]
if argv[:2] == ['agente', 'lanzar']:
    cfg = carga().get('agente') or {}
    if cfg.get('sale'):
        sys.stderr.write('SECRETO mensaje del cliente\\n'); sys.exit(cfg['sale'])
    print(json.dumps(cfg.get('salida', {'agent': 'launched'}))); sys.exit(0)
if argv[:1] != ['caso']:
    print('[{"synced": true, "destinos": []}]'); sys.exit(0)
e = carga()
sub, cid = argv[1], argv[2]
def falla(code, detail='fake'):
    sys.stderr.write(json.dumps({'error': code, 'detail': detail}) + '\\n'); sys.exit(2)
if e.get('falla', {}).get(sub): falla(e['falla'][sub])
caso = e['casos'].get(cid)
if caso is None: falla('E_NOT_FOUND')
if opcion(argv, '--actor') is None and sub != 'ver': falla('E_ARGS', 'no actor')
if sub == 'propuesta':
    texto = opcion(argv, '--respuesta')
    caso['propuesta'] = {'tipo': opcion(argv, '--tipo'), 'respuesta': texto}
    caso['propuesta_version'] = hashlib.sha256(texto.encode()).hexdigest()
    caso['propuesta_aprobada'] = None
    caso['etapa'] = 'decision'
elif sub == 'aprobar':
    if opcion(argv, '--version') != caso['propuesta_version']: falla('E_VERSION')
    caso['propuesta_aprobada'] = caso['propuesta_version']
    if caso['etapa'] == 'decision' and caso['propuesta']['tipo'] == 'trabajar': caso['etapa'] = 'trabajo'
elif sub == 'mover':
    caso['etapa'] = argv[3]
caso['aprobada'] = caso['propuesta_aprobada'] == caso['propuesta_version']
e['casos'][cid] = caso
guarda(e)
print(json.dumps([caso]))
`
const WA_SEND_FALSO = '#!/usr/bin/env python3\n' + ESTADO_FALSO + `
anota('send.jsonl')
argv = sys.argv[1:]
e = carga()
cfg = e.get('send', {})
def niega(codigo, salida=1):
    sys.stderr.write('wa-send: ' + codigo + '\\n' + 'detalle largo\\n'); sys.exit(cfg.get('salida', salida))
if '--approve' in argv:
    req = argv[argv.index('--approve') + 1]
    if cfg.get('approve', 'ok') != 'ok': niega(cfg['approve'])
    if req not in e.setdefault('entregados', []): e['entregados'].append(req)
    guarda(e)
    print(json.dumps({'req_id': req, 'estado': 'enviado', 'chat': 'Cliente Alfa'})); sys.exit(0)
if '--cancel' in argv:
    req = argv[argv.index('--cancel') + 1]
    hecho = cfg.get('cancel', 'ok') == 'ok'
    print(json.dumps({'req_id': req, 'estado': 'cancelado' if hecho else 'enviado',
                      'cancelled': hecho})); sys.exit(0)
if cfg.get('draft', 'ok') != 'ok': niega(cfg['draft'])
req = opcion(argv, '--id')
e.setdefault('borradores', {})[req] = argv[argv.index('--') + 1:] if '--' in argv else argv
guarda(e)
print(json.dumps({'req_id': req, 'estado': 'borrador', 'chat': 'Cliente Alfa'}))
`

const V1 = 'a1'.repeat(32)
const V2 = 'b2'.repeat(32)
const CHAT_CASO = '120363000000000001@g.us'
const casoDe = (extra = {}) => ({
  case_id: 7, account: 'pn:573000000012', chat_jid: CHAT_CASO, etapa: 'decision',
  propuesta: { tipo: 'responder', respuesta: 'Hola, ya lo revisamos.' },
  propuesta_version: V1, propuesta_aprobada: null, aprobada: false, ...extra
})

/** Un directorio de herramientas con los dos falsos y el estado que pida cada caso. */
function herramientasCaso (nombre, estado) {
  const dir = herramientas(nombre, WA_SCOPE_FALSO)
  writeFileSync(join(dir, 'wa-send'), WA_SEND_FALSO, { mode: 0o755 })
  writeFileSync(join(dir, 'estado.json'), JSON.stringify(estado))
  const leer = (archivo) => existsSync(join(dir, archivo))
    ? readFileSync(join(dir, archivo), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
  return {
    dir,
    estado: () => JSON.parse(readFileSync(join(dir, 'estado.json'), 'utf8')),
    // Solo lo de `caso`: el sync que corre solo tambien pasa por aca.
    scope: () => leer('scope.jsonl').filter((a) => a[0] === 'caso'),
    todasScope: () => leer('scope.jsonl'),
    send: () => leer('send.jsonl'),
    // La llave que trajo cada llamada, en el mismo orden (null si no trajo).
    scopeEnv: () => leer('scope-env.jsonl'),
    sendEnv: () => leer('send-env.jsonl')
  }
}

let ordenPedido = 0
/** Deja el pedido como lo deja el panel y espera SU veredicto. */
async function pideCaso (orca, pedido) {
  ordenPedido += 1
  const id = pedido.id ?? `caso-${ordenPedido}`
  orca.store.scopeRequest = { at: new Date().toISOString(), ...pedido, id }
  await hasta(() => orca.store.scopeResult && orca.store.scopeResult.requestId === id, 20000)
  return orca.store.scopeResult
}
const verbo = (llamada) => llamada[1]

{
  const f = herramientasCaso('caso-enviar', { casos: { 7: casoDe() } })
  const orca = hostFalso(f.dir, { chats: [] })
  const { apagar } = await arranca(orca)
  // El panel manda lo que VIO; el texto, el actor y el chat salen del caso, no del pedido.
  const v = await pideCaso(orca, { action: 'enviar', caseId: 7, version: V1,
    actor: 'agente', texto: 'OTRO TEXTO', chat: 'otro@g.us' })
  ok('Enviar contesta que si, con su codigo estable', v && v.ok === true && v.code === 'enviado',
    JSON.stringify(v))
  const verbos = f.scope().map(verbo)
  ok('lee el caso, firma la version y despues lo da por respondido, en ese orden',
    JSON.stringify(verbos) === JSON.stringify(['ver', 'aprobar', 'mover']), JSON.stringify(f.scope()))
  ok('TODA mutacion lleva --actor dueno, puesto por el worker y no por el panel',
    f.scope().filter((a) => verbo(a) !== 'ver').every((a) => {
      const i = a.indexOf('--actor')
      return i > 0 && a[i + 1] === 'dueno'
    }) && !f.scope().some((a) => a.includes('agente')), JSON.stringify(f.scope()))
  const aprobar = f.scope().find((a) => verbo(a) === 'aprobar')
  ok('firma la version que el dueno vio', aprobar && aprobar.includes(V1) &&
    aprobar.includes('--version'), JSON.stringify(aprobar))
  const [borrador, aprobacion] = f.send()
  ok('el texto sale del caso, no del pedido',
    borrador && borrador.includes('Hola, ya lo revisamos.') && !borrador.includes('OTRO TEXTO'),
    JSON.stringify(f.send()))
  ok('el chat sale del caso, no del pedido',
    borrador && borrador.includes(CHAT_CASO) && !borrador.includes('otro@g.us'),
    JSON.stringify(borrador))
  ok('deja el borrador y despues lo aprueba: la aprobacion del dueno es la que lo manda',
    f.send().length === 2 && aprobacion && aprobacion.includes('--approve'), JSON.stringify(f.send()))
  const llaveArchivo = join(process.env.HOME, '.wa-inbox', 'approver.key')
  const llave = existsSync(llaveArchivo) ? readFileSync(llaveArchivo, 'utf8').trim() : null
  ok('la aprobacion dice que viene del tablero (--by board)',
    aprobacion && aprobacion[aprobacion.indexOf('--by') + 1] === 'board', JSON.stringify(aprobacion))
  ok('solo el hijo --approve recibe la llave del plugin, y es la del archivo 0600',
    /^[0-9a-f]{64}$/.test(llave ?? '') && JSON.stringify(f.sendEnv()) === JSON.stringify([null, llave]),
    JSON.stringify({ llave, env: f.sendEnv() }))
  // Todas las llamadas a wa-scope, en orden, con la llave que trajo cada una: la firma del
  // dueno (`caso aprobar --actor dueno`) la lleva, y nada mas.
  const todasScope = f.todasScope()
  const conLlave = todasScope.filter((_, i) => f.scopeEnv()[i] !== null)
  ok('la firma del dueno (caso aprobar) lleva la llave del plugin, y ningun otro wa-scope',
    todasScope.length === f.scopeEnv().length && conLlave.length === 1 &&
    conLlave[0][0] === 'caso' && conLlave[0][1] === 'aprobar' &&
    f.scopeEnv()[todasScope.indexOf(conLlave[0])] === llave,
  JSON.stringify({ conLlave, env: f.scopeEnv() }))
  ok('el borrador NO pide --send: un chat en responder no lo manda solo antes de la aprobacion',
    borrador && !borrador.includes('--send'), JSON.stringify(borrador))
  ok('el id de la peticion lo fija el caso y su version: un reintento es el mismo envio',
    borrador && borrador.some((x) => x.startsWith('--id=') && x.includes('7') && x.includes(V1.slice(0, 12))),
    JSON.stringify(borrador))
  ok('un texto que empieza con guion no se confunde con una bandera: va despues de `--`',
    borrador && borrador.indexOf('--') > 0 && borrador.indexOf('--') < borrador.indexOf('Hola, ya lo revisamos.'),
    JSON.stringify(borrador))
  ok('la linea del caso viaja, para no escribirle a la conversacion de otro numero',
    borrador && borrador.some((x) => x === '--line=pn:573000000012'), JSON.stringify(borrador))
  ok('el caso termina en respondido', f.estado().casos['7'].etapa === 'respondido',
    JSON.stringify(f.estado().casos['7']))
  apagar()
}

{
  // approve-solo-dueno: un mensaje retenido que no es de un caso (el aviso de la sesion de
  // un proyecto, frenado por el piso) se aprueba o se retira desde el panel. Aprobar va por
  // el worker con la llave del plugin y `--by board`, como la tarjeta.
  const f = herramientasCaso('retenido', { casos: {} })
  const orca = hostFalso(f.dir, { chats: [] })
  const { apagar } = await arranca(orca)
  const v = await pideCaso(orca, { action: 'aprobar-retenido', reqId: 'nota-proyecto-1',
    actor: 'agente' })
  ok('Aprobar un retenido contesta enviado', v && v.ok === true && v.code === 'enviado' &&
    v.reqId === 'nota-proyecto-1', JSON.stringify(v))
  const llave = readFileSync(join(process.env.HOME, '.wa-inbox', 'approver.key'), 'utf8').trim()
  const [aprobacion] = f.send()
  ok('va como --approve <id> --by board, con la llave del plugin solo en ese proceso',
    aprobacion && aprobacion[0] === '--approve' && aprobacion[1] === 'nota-proyecto-1' &&
    aprobacion[aprobacion.indexOf('--by') + 1] === 'board' &&
    JSON.stringify(f.sendEnv()) === JSON.stringify([llave]),
  JSON.stringify({ send: f.send(), env: f.sendEnv() }))
  ok('y no toca ningun caso', f.scope().length === 0, JSON.stringify(f.scope()))

  const caso = await pideCaso(orca, { action: 'aprobar-retenido', reqId: 'caso-7-a1a1a1a1a1a1' })
  ok('el envio de un caso no se aprueba por aca: va por su tarjeta, con su version',
    caso && caso.ok === false && caso.code === 'E_ARGS' && f.send().length === 1,
    JSON.stringify(caso))
  const aviso = await pideCaso(orca, { action: 'aprobar-retenido', reqId: 'aviso-3-b2b2' })
  ok('ni un aviso del plugin al dueno', aviso && aviso.ok === false && aviso.code === 'E_ARGS' &&
    f.send().length === 1, JSON.stringify(aviso))
  const bandera = await pideCaso(orca, { action: 'aprobar-retenido', reqId: '--send' })
  ok('un id con forma de bandera se rechaza sin llegar a wa-send',
    bandera && bandera.ok === false && bandera.code === 'E_ARGS' && f.send().length === 1,
    JSON.stringify(bandera))

  const r = await pideCaso(orca, { action: 'cancelar-retenido', reqId: 'nota-proyecto-2' })
  ok('Cancelar un retenido contesta cancelado', r && r.ok === true && r.code === 'cancelado',
    JSON.stringify(r))
  const retiro = f.send()[1]
  ok('va como --cancel <id> con su motivo, y sin la llave',
    retiro && retiro[0] === '--cancel' && retiro[1] === 'nota-proyecto-2' &&
    retiro.includes('--reason') && f.sendEnv()[1] === null, JSON.stringify(f.send()))
  const e = f.estado()
  e.send = { cancel: 'no' }
  writeFileSync(join(f.dir, 'estado.json'), JSON.stringify(e))
  const tarde = await pideCaso(orca, { action: 'cancelar-retenido', reqId: 'nota-proyecto-3' })
  ok('lo que ya no era un borrador no se cancela, y se dice', tarde && tarde.ok === false &&
    tarde.code === 'send-no-draft', JSON.stringify(tarde))
  apagar()
}

{
  // La propuesta cambio mientras el dueno miraba (triage corre cada 5 minutos): no se
  // aprueba ni se manda lo que no vio.
  const f = herramientasCaso('caso-version', { casos: { 7: casoDe({ propuesta_version: V2 }) } })
  const orca = hostFalso(f.dir, { chats: [] })
  const { apagar } = await arranca(orca)
  const v = await pideCaso(orca, { action: 'enviar', caseId: 7, version: V1 })
  ok('una version vieja se rechaza con E_VERSION', v && v.ok === false && v.code === 'E_VERSION',
    JSON.stringify(v))
  ok('y no se manda NADA', f.send().length === 0, JSON.stringify(f.send()))
  ok('ni se firma ni se mueve', !f.scope().some((a) => ['aprobar', 'mover'].includes(verbo(a))),
    JSON.stringify(f.scope()))
  apagar()
}

{
  // El caso cuya propuesta es un trabajo: "Enviar" no es lo que se aprueba ahi.
  const f = herramientasCaso('caso-enviar-trabajo', { casos: { 7: casoDe({
    propuesta: { tipo: 'trabajar', instrucciones: 'Revisar el modulo.' } }) } })
  const orca = hostFalso(f.dir, { chats: [] })
  const { apagar } = await arranca(orca)
  const v = await pideCaso(orca, { action: 'enviar', caseId: 7, version: V1 })
  ok('Enviar sobre una propuesta de trabajo se rechaza', v && v.ok === false && v.code === 'accion-invalida',
    JSON.stringify(v))
  ok('sin firmar ni mandar nada', f.send().length === 0 &&
    !f.scope().some((a) => ['aprobar', 'mover'].includes(verbo(a))), JSON.stringify(f.scope()))
  apagar()
}

{
  // Cada motivo por el que wa-send no manda llega con su codigo y deja el caso donde
  // estaba: decir "enviado" de lo que no salio es lo peor que puede hacer este panel.
  for (const [codigo, salida] of [['send-timeout', 1], ['send-rejected', 1], ['send-no-transport', 4],
    ['send-denied', 3], ['send-needs-approval', 3], ['send-no-draft', 1]]) {
    const f = herramientasCaso(`caso-send-${codigo}`, { casos: { 7: casoDe() },
      send: { approve: codigo, salida } })
    const orca = hostFalso(f.dir, { chats: [] })
    const { apagar } = await arranca(orca)
    const v = await pideCaso(orca, { action: 'enviar', caseId: 7, version: V1 })
    ok(`wa-send ${codigo} (salida ${salida}) llega como ese mismo codigo`,
      v && v.ok === false && v.code === codigo, JSON.stringify(v))
    ok(`y con ${codigo} el caso no se da por respondido`,
      !f.scope().some((a) => verbo(a) === 'mover'), JSON.stringify(f.scope()))
    apagar()
  }
}

{
  // Un doble clic: dos pedidos con ids distintos sobre la MISMA tarjeta. wa-send entrega
  // por su `--id`, y ese id sale del caso y su version.
  const f = herramientasCaso('caso-doble', { casos: { 7: casoDe() } })
  const orca = hostFalso(f.dir, { chats: [] })
  const { apagar } = await arranca(orca)
  const a = await pideCaso(orca, { id: 'clic-1', action: 'enviar', caseId: 7, version: V1 })
  const b = await pideCaso(orca, { id: 'clic-2', action: 'enviar', caseId: 7, version: V1 })
  ok('los dos clics se contestan', a && b && a.requestId === 'clic-1' && b.requestId === 'clic-2')
  ok('pero el mensaje se entrega UNA vez', f.estado().entregados.length === 1,
    JSON.stringify(f.estado().entregados))
  // El MISMO pedido dos veces (el panel reescribio la clave): el vigia lo ignora.
  const antes = f.send().length
  orca.store.scopeRequest = { at: new Date().toISOString(), id: 'clic-2', action: 'enviar',
    caseId: 7, version: V1 }
  await dormir(4500)
  ok('un pedido con el mismo id no se ejecuta otra vez', f.send().length === antes,
    JSON.stringify(f.send()))
  apagar()
}

{
  // Editar y enviar: el texto del dueno es una propuesta NUEVA, con su version, y esa es
  // la que se firma y sale.
  const f = herramientasCaso('caso-editar', { casos: { 7: casoDe() } })
  const orca = hostFalso(f.dir, { chats: [] })
  const { apagar } = await arranca(orca)
  const v = await pideCaso(orca, { action: 'editar-enviar', caseId: 7, version: V1,
    texto: '-Hola, le confirmo el jueves.' })
  ok('Editar y enviar contesta que si', v && v.ok === true && v.code === 'enviado', JSON.stringify(v))
  const verbos = f.scope().map(verbo)
  ok('lee, propone, firma la version NUEVA y da por respondido',
    JSON.stringify(verbos) === JSON.stringify(['ver', 'propuesta', 'aprobar', 'mover']), JSON.stringify(f.scope()))
  const prop = f.scope().find((a) => verbo(a) === 'propuesta')
  ok('la propuesta es de tipo responder con el texto del dueno, en una sola bandera `--respuesta=`',
    prop && prop.includes('--tipo=responder') && prop.includes('--respuesta=-Hola, le confirmo el jueves.'),
    JSON.stringify(prop))
  const nueva = f.estado().casos['7'].propuesta_version
  const aprobar = f.scope().find((a) => verbo(a) === 'aprobar')
  ok('firma la version nueva, no la que habia', nueva !== V1 && aprobar &&
    aprobar.includes(nueva) && !aprobar.includes(V1), JSON.stringify(aprobar))
  ok('manda el texto del dueno', f.send()[0] && f.send()[0].includes('-Hola, le confirmo el jueves.'),
    JSON.stringify(f.send()))
  apagar()

  const g = herramientasCaso('caso-editar-viejo', { casos: { 7: casoDe({ propuesta_version: V2 }) } })
  const orca2 = hostFalso(g.dir, { chats: [] })
  const { apagar: apagar2 } = await arranca(orca2)
  const w = await pideCaso(orca2, { action: 'editar-enviar', caseId: 7, version: V1, texto: 'nuevo' })
  ok('editar sobre una propuesta que cambio se rechaza, sin pisarla',
    w && w.ok === false && w.code === 'E_VERSION' && !g.scope().some((a) => verbo(a) === 'propuesta'),
    JSON.stringify([w, g.scope()]))
  const vacio = await pideCaso(orca2, { action: 'editar-enviar', caseId: 7, version: V2, texto: '   ' })
  ok('un texto vacio es E_ARGS y no llama a nada', vacio && vacio.ok === false && vacio.code === 'E_ARGS' &&
    g.scope().length === 1, JSON.stringify([vacio, g.scope()]))
  apagar2()
}

{
  // Ejecutar aprueba un TRABAJO: el agente de la automatizacion lo recoge despues (T7).
  const f = herramientasCaso('caso-ejecutar', { casos: { 7: casoDe({
    propuesta: { tipo: 'trabajar', instrucciones: 'Revisar el modulo.' } }) } })
  const orca = hostFalso(f.dir, { chats: [] })
  const { apagar } = await arranca(orca)
  const v = await pideCaso(orca, { action: 'ejecutar', caseId: 7, version: V1 })
  ok('Ejecutar contesta que quedo aprobado', v && v.ok === true && v.code === 'aprobada', JSON.stringify(v))
  ok('firma la version y nada mas: ni mueve a mano ni toca WhatsApp',
    JSON.stringify(f.scope().map(verbo)) === JSON.stringify(['ver', 'aprobar']) && f.send().length === 0,
    JSON.stringify(f.scope()))
  ok('el caso queda en trabajo, lo que hace el CLI al firmar un trabajo',
    f.estado().casos['7'].etapa === 'trabajo')
  apagar()

  const g = herramientasCaso('caso-ejecutar-respuesta', { casos: { 7: casoDe() } })
  const orca2 = hostFalso(g.dir, { chats: [] })
  const { apagar: apagar2 } = await arranca(orca2)
  const w = await pideCaso(orca2, { action: 'ejecutar', caseId: 7, version: V1 })
  ok('Ejecutar sobre una respuesta se rechaza: eso se envia, no se ejecuta',
    w && w.ok === false && w.code === 'accion-invalida' && !g.scope().some((a) => verbo(a) === 'aprobar'),
    JSON.stringify([w, g.scope()]))
  apagar2()
}

{
  const f = herramientasCaso('caso-mover', { casos: { 7: casoDe(), 8: casoDe({ case_id: 8 }),
    9: casoDe({ case_id: 9, etapa: 'cerrado' }) } })
  const orca = hostFalso(f.dir, { chats: [] })
  const { apagar } = await arranca(orca)

  const r = await pideCaso(orca, { action: 'reclasificar', caseId: 7, nota: 'es una queja, no una consulta' })
  const re = f.scope().find((a) => verbo(a) === 'mover')
  ok('Reclasificar devuelve el caso a clasificado con la nota del dueno',
    r && r.ok === true && r.code === 'reclasificado' && re && re[2] === '7' && re[3] === 'clasificado' &&
    re.includes('--motivo=es una queja, no una consulta') && re.includes('--actor') &&
    re[re.indexOf('--actor') + 1] === 'dueno', JSON.stringify([r, re]))

  await pideCaso(orca, { action: 'reclasificar', caseId: 8, nota: '  ' })
  const sinNota = f.scope().filter((a) => verbo(a) === 'mover')[1]
  ok('la nota es opcional: sin ella no se pasa --motivo', sinNota && !sinNota.some((x) => x.startsWith('--motivo')),
    JSON.stringify(sinNota))

  const c = await pideCaso(orca, { action: 'cerrar', caseId: 7, motivo: 'ya lo resolvi por telefono' })
  const cerrar = f.scope().filter((a) => verbo(a) === 'mover')[2]
  ok('Cerrar lleva el motivo del dueno', c && c.ok === true && c.code === 'cerrado' && cerrar[3] === 'cerrado' &&
    cerrar.includes('--motivo=ya lo resolvi por telefono'), JSON.stringify([c, cerrar]))

  await pideCaso(orca, { action: 'cerrar', caseId: 8 })
  const cerrarSin = f.scope().filter((a) => verbo(a) === 'mover')[3]
  const motivo = (cerrarSin || []).find((x) => x.startsWith('--motivo='))
  ok('cerrar sin motivo pone uno: el CLI no deja una tarjeta cerrada sin decir por que',
    !!motivo && motivo.length > '--motivo='.length, JSON.stringify(cerrarSin))

  const a = await pideCaso(orca, { action: 'reabrir', caseId: 9 })
  const reabrir = f.scope().filter((x) => verbo(x) === 'mover')[4]
  ok('Reabrir lo devuelve a recibido', a && a.ok === true && a.code === 'reabierto' &&
    reabrir[3] === 'recibido', JSON.stringify([a, reabrir]))
  ok('ninguna de esas toca WhatsApp', f.send().length === 0)
  apagar()
}

// "Atender ahora" abre al agente de casos por el MISMO camino que el tick: `wa-scope agente
// lanzar`, que lo abre por terminal con una cuenta de Claude que sirva. Nunca `orca
// automations run`: Orca la lanza con la cuenta activa y, tomada, falla en silencio. Aqui
// hay una `orca` de mentira en el PATH que anota cada llamada: no se la puede llamar.
async function conOrcaVigilada (nombre, prueba) {
  const { comandoOrca } = await import('../catalogo.mjs')
  const bin = join(RAIZ, nombre)
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, comandoOrca()), [
    '#!/bin/sh',
    'echo "$@" >> "$(dirname "$0")/llamadas.txt"',
    'echo \'{"ok":true,"result":{"automations":[],"run":{"id":"r1"}}}\'', ''
  ].join('\n'), { mode: 0o755 })
  const pathAntes = process.env.PATH
  process.env.PATH = `${bin}:/usr/bin:/bin`
  try {
    await prueba({
      llamadas: () => existsSync(join(bin, 'llamadas.txt'))
        ? readFileSync(join(bin, 'llamadas.txt'), 'utf8').trim().split('\n').filter(Boolean) : []
    })
  } finally {
    process.env.PATH = pathAntes
  }
}

/** Las llamadas a la CLI de Orca sin la lista de automatizaciones que el worker pide al
 *  arrancar para encender las del plugin (caso-en-archivo, T4). */
const sinEncendido = (llamadas) => llamadas.filter((l) => l !== 'automations list --json')

/** Lo que el `wa-scope` falso recibio fuera de `caso`: el lanzamiento del agente. */
const lanzamientosAgente = (f) => (existsSync(join(f.dir, 'scope.jsonl'))
  ? readFileSync(join(f.dir, 'scope.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((a) => a[0] === 'agente')
  : [])

{
  const casos = (agente) => ({ agente, casos: {
    7: casoDe({ etapa: 'clasificado', propuesta: null, propuesta_version: null }) } })

  await conOrcaVigilada('orca-atender', async (o) => {
    const f = herramientasCaso('atender-lanza', casos({ salida: { agent: 'launched' } }))
    const orca = hostFalso(f.dir, { chats: [] })
    const { apagar } = await arranca(orca)
    const v = await pideCaso(orca, { action: 'atender', caseId: 7 })
    ok('lanzado: contesta atendido y dice que el agente salio',
      v && v.ok === true && v.code === 'atendido' && v.agent === 'launched', JSON.stringify(v))
    ok('el caso quedo marcado', f.scope().some((a) => verbo(a) === 'atender'), JSON.stringify(f.scope()))
    ok('abre al agente con `wa-scope agente lanzar`, el camino del tick, con su plazo',
      JSON.stringify(lanzamientosAgente(f)) === JSON.stringify([
        ['agente', 'lanzar', '--plazo-s', '60', '--json']]), JSON.stringify(lanzamientosAgente(f)))
    // `automations list` es el encendido de las automatizaciones al arrancar: no corre nada.
    ok('y nunca le pide a Orca que corra la automatizacion', sinEncendido(o.llamadas()).length === 0,
      JSON.stringify(o.llamadas()))
    apagar()
  })

  // Autorizar: el dueno suelta las excepciones de entrada de un caso en decision, y el agente
  // lo ve YA, igual que con Atender ahora.
  await conOrcaVigilada('orca-autoriza', async (o) => {
    const f = herramientasCaso('autorizar-lanza', { agente: { salida: { agent: 'launched' } },
      casos: { 7: casoDe({ etapa: 'decision', excepciones: '["credential"]' }) } })
    const orca = hostFalso(f.dir, { chats: [] })
    const { apagar } = await arranca(orca)
    const v = await pideCaso(orca, { action: 'autorizar', caseId: 7, actor: 'agente' })
    const llamada = f.scope().find((a) => verbo(a) === 'autorizar')
    ok('Autorizar pide `caso autorizar` firmado por el dueno y lanza al agente',
      v && v.ok === true && v.code === 'autorizado' && v.agent === 'launched' && llamada &&
      llamada[2] === '7' && llamada.includes('dueno') && !llamada.includes('agente'),
      JSON.stringify([v, llamada]))
    ok('por el mismo camino, y sin la automatizacion', lanzamientosAgente(f).length === 1 &&
      sinEncendido(o.llamadas()).length === 0, JSON.stringify([lanzamientosAgente(f), o.llamadas()]))
    apagar()
  })

  await conOrcaVigilada('orca-autoriza-etapa', async () => {
    const f = herramientasCaso('autorizar-etapa', { casos: { 7: casoDe({ etapa: 'clasificado' }) },
      falla: { autorizar: 'E_STAGE' } })
    const orca = hostFalso(f.dir, { chats: [] })
    const { apagar } = await arranca(orca)
    const v = await pideCaso(orca, { action: 'autorizar', caseId: 7 })
    ok('si el caso no esta en decision o no tiene excepciones llega E_STAGE y no se lanza nada',
      v && v.ok === false && v.code === 'E_STAGE' && v.agent === undefined &&
      lanzamientosAgente(f).length === 0, JSON.stringify(v))
    apagar()
  })

  const resultados = [
    ['ya hay uno corriendo', { salida: { agent: 'running' } }, { agent: 'running' }],
    ['nadie lo espera ya', { salida: { agent: 'nothing' } }, { agent: 'running' }],
    ['ninguna cuenta sirve', { salida: { agent: 'failed', reason: 'sin-cuenta' } },
      { agent: 'run-failed', agentReason: 'sin-cuenta' }],
    ['no hay CLI de Orca', { salida: { agent: 'failed', reason: 'sin-cli' } },
      { agent: 'orca-cli-missing' }],
    ['un motivo que no es un codigo', { salida: { agent: 'failed', reason: 'SECRETO mensaje del cliente' } },
      { agent: 'run-failed', agentReason: 'failed' }],
    ['wa-scope sale mal', { sale: 1 }, { agent: 'run-failed', agentReason: 'exit-1' }]
  ]
  for (const [como, agente, espera] of resultados) {
    await conOrcaVigilada(`orca-atender-${espera.agent}-${espera.agentReason || 'x'}`, async () => {
      const f = herramientasCaso(`atender-${como.replace(/\W+/g, '-')}`, casos(agente))
      const orca = hostFalso(f.dir, { chats: [] })
      const { apagar } = await arranca(orca)
      const v = await pideCaso(orca, { action: 'atender', caseId: 7 })
      ok(`${como}: el caso sigue marcado y el veredicto lo dice con un codigo`,
        v && v.ok === true && v.code === 'atendido' && v.agent === espera.agent &&
        v.agentReason === espera.agentReason && f.scope().some((a) => verbo(a) === 'atender'),
        JSON.stringify(v))
      ok(`${como}: el veredicto nunca lleva el texto de un mensaje`,
        !/SECRETO/.test(JSON.stringify(orca.store.scopeResult)), JSON.stringify(orca.store.scopeResult))
      apagar()
    })
  }
}

{
  // La cuenta de Claude del bot: Ajustes pide la lista de cuentas al worker, que la lee de
  // `orca account list` y devuelve solo lo que el panel muestra. Nada de credenciales.
  const { comandoOrca } = await import('../catalogo.mjs')
  const conCuentas = async (nombre, salida, prueba) => {
    const bin = join(RAIZ, nombre)
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'salida.json'), JSON.stringify(salida))
    writeFileSync(join(bin, comandoOrca()), [
      '#!/bin/sh',
      'echo "$@" >> "$(dirname "$0")/llamadas.txt"',
      'cat "$(dirname "$0")/salida.json"', ''
    ].join('\n'), { mode: 0o755 })
    const pathAntes = process.env.PATH
    process.env.PATH = `${bin}:/usr/bin:/bin`
    try {
      await prueba(() => existsSync(join(bin, 'llamadas.txt'))
        ? readFileSync(join(bin, 'llamadas.txt'), 'utf8').trim().split('\n').filter(Boolean) : [])
    } finally {
      process.env.PATH = pathAntes
    }
  }
  const CUENTAS_ORCA = { ok: true, result: { accounts: [
    { provider: 'claude', id: 'cuenta-bot', email: 'bot@example.invalid', active: false,
      auth: { state: 'authenticated', accountId: 'SECRETO-auth' },
      quota: { session: { usedPercent: 20 } }, authMethod: 'SECRETO-metodo' },
    { provider: 'claude', id: 'cuenta-sin', email: 'sin@example.invalid', active: true,
      auth: { state: 'expired' }, quota: {} },
    { provider: 'claude', id: 'cuenta-propia', email: 'endpoint · Ejemplo', active: false,
      authMethod: 'custom-endpoint', auth: null, quota: null },
    { provider: 'codex', id: 'cuenta-codex', email: 'codex@example.invalid', active: false,
      auth: { state: 'authenticated' } }] } }

  await conCuentas('orca-cuentas', CUENTAS_ORCA, async (llamadas) => {
    const f = herramientasCaso('cuentas-claude', { casos: {} })
    const orca = hostFalso(f.dir, { chats: [] })
    const { apagar } = await arranca(orca)
    const v = await pideCaso(orca, { action: 'cuentas-claude' })
    ok('Ajustes pide las cuentas y el worker las lee de `orca account list`',
      v && v.ok === true && v.code === 'cuentas' && llamadas().includes('account list --json'),
      JSON.stringify([v, llamadas()]))
    ok('solo las de Claude, con lo que el panel muestra y nada mas',
      JSON.stringify(v && v.accounts) === JSON.stringify([
        { id: 'cuenta-bot', email: 'bot@example.invalid', authenticated: true, active: false, used: 20 },
        { id: 'cuenta-sin', email: 'sin@example.invalid', authenticated: false, active: true, used: null },
        { id: 'cuenta-propia', email: 'endpoint · Ejemplo', authenticated: true, active: false, used: null }]),
      JSON.stringify(v && v.accounts))
    ok('ni un dato de autenticacion llega al storage',
      !/SECRETO/.test(JSON.stringify(orca.store.scopeResult)), JSON.stringify(orca.store.scopeResult))
    apagar()
  })

  await conCuentas('orca-cuentas-falla', { ok: false, error: { code: 'runtime_unavailable' } }, async () => {
    const f = herramientasCaso('cuentas-claude-falla', { casos: {} })
    const orca = hostFalso(f.dir, { chats: [] })
    const { apagar } = await arranca(orca)
    const v = await pideCaso(orca, { action: 'cuentas-claude' })
    ok('si Orca no contesta la lista, el veredicto lo dice con un codigo',
      v && v.ok === false && v.code === 'cuentas-fallo', JSON.stringify(v))
    apagar()
  })
}

{
  // Lo que era la bandeja, ahora en el tablero: "Atender ahora" (era Tomar), "Ignorar" y
  // el proyecto puesto a mano. Las tres por el mismo canal, con --actor dueno.
  // Atender tambien lanza el agente: aqui con una CLI de Orca falsa, nunca la de verdad.
  const pathAntesBandeja = process.env.PATH
  const binBandeja = join(RAIZ, 'orca-bandeja')
  mkdirSync(binBandeja, { recursive: true })
  writeFileSync(join(binBandeja, (await import('../catalogo.mjs')).comandoOrca()),
    '#!/bin/sh\necho \'{"ok":true,"result":{"automations":[]}}\'\n', { mode: 0o755 })
  process.env.PATH = `${binBandeja}:/usr/bin:/bin`
  const f = herramientasCaso('caso-bandeja', { casos: {
    7: casoDe({ etapa: 'clasificado', propuesta: null, propuesta_version: null }),
    8: casoDe({ case_id: 8, etapa: 'recibido', propuesta: null, propuesta_version: null }) } })
  const orca = hostFalso(f.dir, { chats: [] })
  const { apagar } = await arranca(orca)
  const actorDueno = (a) => { const i = a.indexOf('--actor'); return i > 0 && a[i + 1] === 'dueno' }

  const at = await pideCaso(orca, { action: 'atender', caseId: 7, actor: 'agente' })
  const llamadaAt = f.scope().find((a) => verbo(a) === 'atender')
  ok('Atender ahora pide `caso atender` sobre ese caso, firmado por el dueno',
    at && at.ok === true && at.code === 'atendido' && llamadaAt && llamadaAt[2] === '7' &&
    actorDueno(llamadaAt) && !llamadaAt.includes('agente'), JSON.stringify([at, llamadaAt]))

  const ig = await pideCaso(orca, { action: 'ignorar', caseId: 8 })
  const llamadaIg = f.scope().filter((a) => verbo(a) === 'mover').pop()
  ok('Ignorar cierra el caso con un motivo propio, firmado por el dueno',
    ig && ig.ok === true && ig.code === 'ignorado' && llamadaIg && llamadaIg[2] === '8' &&
    llamadaIg[3] === 'cerrado' && llamadaIg.some((x) => /^--motivo=.+/.test(x)) &&
    actorDueno(llamadaIg), JSON.stringify([ig, llamadaIg]))

  const pr = await pideCaso(orca, { action: 'proyecto', caseId: 7, proyecto: 'beta-demo' })
  const llamadaPr = f.scope().filter((a) => verbo(a) === 'proyecto').pop()
  ok('el proyecto viaja en una sola bandera `--proyecto=`, firmado por el dueno',
    pr && pr.ok === true && pr.code === 'proyecto-cambiado' && llamadaPr && llamadaPr[2] === '7' &&
    llamadaPr.includes('--proyecto=beta-demo') && actorDueno(llamadaPr), JSON.stringify([pr, llamadaPr]))

  const sin = await pideCaso(orca, { action: 'proyecto', caseId: 7, proyecto: '' })
  const llamadaSin = f.scope().filter((a) => verbo(a) === 'proyecto').pop()
  ok('sin proyecto se pide con `--proyecto=`', sin && sin.ok === true &&
    llamadaSin && llamadaSin.includes('--proyecto='), JSON.stringify([sin, llamadaSin]))

  const antes = f.scope().length
  for (const [nombre, valor] of [['con mayusculas', 'Beta'], ['con espacios', 'beta demo'],
    ['que empieza con guion', '-x'], ['que no es texto', 7]]) {
    const v = await pideCaso(orca, { action: 'proyecto', caseId: 7, proyecto: valor })
    ok(`un proyecto ${nombre} es E_ARGS`, v && v.ok === false && v.code === 'E_ARGS', JSON.stringify(v))
  }
  ok('y ninguno llega al CLI', f.scope().length === antes, JSON.stringify(f.scope().slice(antes)))
  ok('ninguna de las tres toca WhatsApp', f.send().length === 0)
  apagar()

  const g = herramientasCaso('caso-atender-etapa', { casos: { 7: casoDe() }, falla: { atender: 'E_STAGE' } })
  const orca2 = hostFalso(g.dir, { chats: [] })
  const { apagar: apagar2 } = await arranca(orca2)
  const v = await pideCaso(orca2, { action: 'atender', caseId: 7 })
  ok('atender fuera de recibido o clasificado llega como E_STAGE', v && v.ok === false && v.code === 'E_STAGE',
    JSON.stringify(v))
  apagar2()
  process.env.PATH = pathAntesBandeja
}

{
  // Cada codigo estable del CLI llega al panel igual, para que el panel lo traduzca por
  // codigo y no por el texto en ingles.
  for (const codigo of ['E_ARGS', 'E_NOT_FOUND', 'E_STAGE', 'E_NOT_APPROVED', 'E_VERSION',
    'E_EXCEPTION', 'E_BUSY']) {
    const f = herramientasCaso(`caso-codigo-${codigo}`, { casos: { 7: casoDe() }, falla: { mover: codigo } })
    const orca = hostFalso(f.dir, { chats: [] })
    const { apagar } = await arranca(orca)
    const v = await pideCaso(orca, { action: 'cerrar', caseId: 7, motivo: 'x' })
    ok(`el error ${codigo} del CLI llega como ${codigo}`, v && v.ok === false && v.code === codigo,
      JSON.stringify(v))
    apagar()
  }
  const f = herramientasCaso('caso-sin-firma', { casos: { 7: casoDe() } })
  writeFileSync(join(f.dir, 'wa-send'),
    '#!/bin/sh\necho "no agent name is configured. Set it with x" >&2\nexit 1\n', { mode: 0o755 })
  const orca = hostFalso(f.dir, { chats: [] })
  const { apagar } = await arranca(orca)
  const v = await pideCaso(orca, { action: 'enviar', caseId: 7, version: V1 })
  ok('wa-send sin nombre de agente se distingue de un fallo cualquiera',
    v && v.ok === false && v.code === 'send-no-signature', JSON.stringify(v))
  apagar()
}

{
  // Lo que no es un pedido valido se rechaza antes de llamar a nadie.
  const f = herramientasCaso('caso-args', { casos: { 7: casoDe() } })
  const orca = hostFalso(f.dir, { chats: [] })
  const { apagar } = await arranca(orca)
  for (const [nombre, pedido] of [
    ['un id que no es numero', { action: 'cerrar', caseId: 'siete' }],
    ['un id negativo', { action: 'cerrar', caseId: -1 }],
    ['un id con decimales', { action: 'cerrar', caseId: 7.5 }],
    ['sin id', { action: 'reabrir' }],
    ['enviar sin version', { action: 'enviar', caseId: 7 }],
    ['una version que no es un hash', { action: 'enviar', caseId: 7, version: 'cualquier cosa' }]
  ]) {
    const v = await pideCaso(orca, pedido)
    ok(`${nombre} es E_ARGS`, v && v.ok === false && v.code === 'E_ARGS', JSON.stringify(v))
  }
  ok('y ninguno llega al CLI', f.scope().length === 0 && f.send().length === 0, JSON.stringify(f.scope()))
  apagar()
}

{
  // Ni siquiera el CLI: sin herramientas el panel recibe el mismo motivo estable de siempre.
  const orca = hostFalso(herramientas('caso-sin-nada', null), { chats: [] })
  const { apagar } = await arranca(orca)
  const v = await pideCaso(orca, { action: 'cerrar', caseId: 7, motivo: 'x' })
  ok('sin herramientas, el motivo es el estable del worker', v && v.ok === false && v.code === 'sin-herramientas',
    JSON.stringify(v))
  apagar()
}

// ───────── T16: "Traer conversaciones" refresca la lista, sin esperar al reloj ─────────
console.log('\nworker: traer la libreta deja la lista al dia en segundos')
{
  // El boton relanza la sesion y las conversaciones llegan DESPUES, cuando el sidecar
  // conecta y pide el estado de la libreta. La lista que lee el panel solo se rearmaba en
  // el sync de 5 minutos: una conversacion nueva no aparecia hasta entonces.
  const guion = join(RAIZ, 'sidecar-libreta.cjs')
  writeFileSync(guion,
    '#!/usr/bin/env node\n' +
    'function emit (m) { process.stdout.write(JSON.stringify(m) + "\\n") }\n' +
    'emit({ type: "connection", state: "connecting" })\n' +
    // Conecta y late sin parar, igual que el de verdad; la libreta llega mas tarde.
    'setTimeout(() => emit({ type: "connection", state: "open" }), 100)\n' +
    'setInterval(() => emit({ type: "latido", ts: Date.now(), conectado: true }), 300)\n' +
    'setTimeout(() => emit({ type: "libreta", ok: true }), 1200)\n' +
    'setInterval(() => {}, 1000)\n', { mode: 0o755 })
  const syncs = join(RAIZ, 'syncs-libreta.txt')
  const wascope = '#!/bin/sh\n' +
    `[ "$1" = "sync" ] && echo "$@" >> ${JSON.stringify(syncs)}\n` +
    'echo \'[{"synced": true, "destinos": []}]\'\n'
  const cuenta = () => existsSync(syncs) ? readFileSync(syncs, 'utf8').trim().split('\n').length : 0
  // Un resolvedor de mentira: este bloque corre despues de que otro borro el userData del
  // HOME de prueba, y el de verdad contestaria que no encuentra el de Orca.
  const resolvedor = join(RAIZ, 'resolve-libreta.mjs')
  writeFileSync(resolvedor,
    'import { mkdirSync } from "node:fs"\n' +
    'const dir = ' + JSON.stringify(join(RAIZ, 'auth-libreta')) + '\n' +
    'mkdirSync(dir, { recursive: true })\n' +
    'process.stdout.write(JSON.stringify({ ok: true, dir }))\n')
  const toolsLibreta = herramientas('libreta', wascope)
  const orca = hostFalso(toolsLibreta, { chats: [] }, guion)
  orca.host.call = (function (original) {
    return async (action, params) => {
      if (action === 'settings.get') {
        return { value: { toolsDir: toolsLibreta, sidecarPath: guion, authDirResolverPath: resolvedor } }
      }
      return original(action, params)
    }
  })(orca.host.call)
  const { apagar } = await arranca(orca)
  // Al arrancar: la libreta que llega NO pedida no dispara nada propio. El primer latido
  // conectado tras el arranque si pide UN sync (ver el bloque siguiente): se espera a que
  // pase antes de contar, para que no se confunda con uno de la libreta.
  await dormir(2500)
  await hasta(() => cuenta() >= 2, 8000)
  const base = cuenta()
  await dormir(1500)
  ok('sin que nadie la pida, los latidos y la libreta no disparan un sync', cuenta() === base,
    `${base} -> ${cuenta()}`)

  orca.store.sidecarRequest = { id: 'libreta-1', action: 'libreta', at: new Date().toISOString() }
  await hasta(() => orca.store.sidecarResult && orca.store.sidecarResult.requestId === 'libreta-1', 15000)
  ok('el boton contesta que si', orca.store.sidecarResult && orca.store.sidecarResult.ok === true,
    JSON.stringify(orca.store.sidecarResult))
  const alConectar = await hasta(() => cuenta() >= base + 1, 8000)
  ok('al conectar la linea corre un sync, sin esperar los 5 minutos', alConectar, `${base} -> ${cuenta()}`)
  const alLlegar = await hasta(() => cuenta() >= base + 2, 8000)
  ok('y otro cuando la libreta llega, que es cuando estan las conversaciones nuevas', alLlegar,
    `${base} -> ${cuenta()}`)
  await dormir(2500)
  ok('y ahi paran: no es un sync por cada latido', cuenta() === base + 2, `${base} -> ${cuenta()}`)
  apagar()
}
// ───────── tras (re)arrancar, el primer latido conectado dispara UN sync ─────────
console.log('\nworker: el primer latido tras un arranque pide un sync y solo uno')
{
  // Visto en vivo: el plugin reinicia tras mas de 2 minutos caido, el sync del arranque
  // corre ~0.5 s despues de lanzar el sidecar -antes de que haya un solo latido- y la
  // salud sale `transport-silent` ("sin senal desde <hora vieja>"). El aviso rojo se
  // quedaba hasta el sync de 5 minutos con la linea ya conectada.
  const guion = join(RAIZ, 'sidecar-primer-latido.cjs')
  writeFileSync(guion,
    '#!/usr/bin/env node\n' +
    'function emit (m) { process.stdout.write(JSON.stringify(m) + "\\n") }\n' +
    'emit({ type: "connection", state: "connecting" })\n' +
    // Ni un latido durante el primer segundo y medio: el sync del arranque corre en ese hueco.
    'setTimeout(() => { emit({ type: "connection", state: "open" });\n' +
    '  setInterval(() => emit({ type: "latido", ts: Date.now(), conectado: true }), 300) }, 1500)\n' +
    'setInterval(() => {}, 1000)\n', { mode: 0o755 })
  const syncs = join(RAIZ, 'syncs-primer-latido.txt')
  const wascope = '#!/bin/sh\n' +
    `[ "$1" = "sync" ] && echo "$@" >> ${JSON.stringify(syncs)}\n` +
    'echo \'[{"synced": true, "destinos": []}]\'\n'
  const cuenta = () => existsSync(syncs) ? readFileSync(syncs, 'utf8').trim().split('\n').length : 0
  const resolvedor = join(RAIZ, 'resolve-primer-latido.mjs')
  writeFileSync(resolvedor,
    'import { mkdirSync } from "node:fs"\n' +
    'const dir = ' + JSON.stringify(join(RAIZ, 'auth-primer-latido')) + '\n' +
    'mkdirSync(dir, { recursive: true })\n' +
    'process.stdout.write(JSON.stringify({ ok: true, dir }))\n')
  const herr = herramientas('primer-latido', wascope)
  const orca = hostFalso(herr, { chats: [] }, guion)
  orca.host.call = (function (original) {
    return async (action, params) => {
      if (action === 'settings.get') {
        return { value: { toolsDir: herr, sidecarPath: guion, authDirResolverPath: resolvedor } }
      }
      return original(action, params)
    }
  })(orca.host.call)
  const { apagar } = await arranca(orca)
  const alArrancar = cuenta()
  ok('el sync del arranque corre antes de que haya latido', alArrancar >= 1 &&
    !(orca.store.sidecar && orca.store.sidecar.latido), `${alArrancar} ${JSON.stringify(orca.store.sidecar)}`)
  const llego = await hasta(() => orca.store.sidecar && orca.store.sidecar.latido, 8000)
  ok('despues llega el primer latido conectado', !!llego)
  const extra = await hasta(() => cuenta() >= alArrancar + 1, 8000)
  ok('y pide un sync mas, sin esperar los 5 minutos', extra, `${alArrancar} -> ${cuenta()}`)
  ok('con el motivo de la conexion', orca.store.syncStatus && orca.store.syncStatus.trigger === 'conexion',
    JSON.stringify(orca.store.syncStatus))
  await dormir(3000)
  ok('y ahi para: no es un sync por cada latido', cuenta() === alArrancar + 1,
    `${alArrancar} -> ${cuenta()}`)
  apagar()
}

// ───────── el catalogo de proyectos: lo que Orca conoce, propuesto al dueno ─────────
console.log('\nworker: el catalogo deriva propuestas de `orca worktree ps` sin inventar nada')
{
  const { comandoOrca, ORCA_ARGS, leerWorktrees, leerRepos, proponer } =
    await import('../catalogo.mjs')

  ok('en macOS la CLI se llama orca', comandoOrca('darwin', {}) === 'orca')
  // En Linux `orca` es el lector de pantalla de GNOME: arrancarlo habla.
  ok('en Linux se llama orca-ide y nunca cae a orca',
    comandoOrca('linux', {}) === 'orca-ide')
  ok('ORCA_CLI_COMMAND manda en cualquier plataforma',
    comandoOrca('linux', { ORCA_CLI_COMMAND: ' /opt/orca/bin/orca ' }) === '/opt/orca/bin/orca')
  // La frontera de seguridad: los argumentos son literales, nada del panel llega aca.
  ok('los argumentos son literales',
    JSON.stringify(ORCA_ARGS) === JSON.stringify({
      worktrees: ['worktree', 'ps', '--json'], repos: ['repo', 'list', '--json'] }))

  ok('un sobre que no es el de la CLI da lista vacia, no excepcion',
    leerWorktrees(null).length === 0 && leerWorktrees({ result: 3 }).length === 0 &&
    leerRepos('x').length === 0 && leerRepos({ result: { repos: 'no' } }).length === 0)
  ok('un worktree sin ruta o sin repo se descarta',
    leerWorktrees({ result: { worktrees: [{ repo: 'a' }, { path: '/x' },
      { repo: 'b', path: '/b', repoId: 'rb' }] } }).length === 1)

  const wt = (repoId, repo, path, extra = {}) =>
    ({ repoId, repo, path, isArchived: false, isMainWorktree: false, ...extra })
  const worktrees = [
    wt('r1', 'tienda-demo', '/srv/ejemplo/tienda-demo', { isMainWorktree: true }),
    // Un worktree hijo del mismo repo, dentro de otra carpeta: no es otro proyecto.
    wt('r1', 'tienda-demo', '/srv/ejemplo/tienda-demo-ramas/fix-1'),
    // Archivado: no se propone.
    wt('r2', 'viejo-demo', '/srv/ejemplo/viejo-demo', { isArchived: true }),
    // Anidado dentro de otro proyecto: queda cubierto por el de arriba.
    wt('r3', 'modulo-demo', '/srv/ejemplo/tienda-demo/modulo'),
    wt('r4', 'api-demo', '/srv/ejemplo/api-demo', { isMainWorktree: true }),
    // Dos repos con el mismo nombre: los ids no pueden chocar.
    wt('r5', 'api-demo', '/srv/otro/api-demo', { isMainWorktree: true })
  ]
  const repos = leerRepos({ result: { repos: [
    { id: 'r1', path: '/srv/ejemplo/tienda-demo', displayName: 'Tienda Demo' },
    { id: 'r4', path: '/srv/ejemplo/api-demo', displayName: 'API Demo' }
  ] } })
  const propuestas = proponer(worktrees, repos, [])
  ok('descarta los archivados', !propuestas.some((p) => p.path.includes('viejo-demo')),
    JSON.stringify(propuestas))
  ok('colapsa los anidados en el proyecto que los cubre',
    !propuestas.some((p) => p.path.endsWith('/modulo')) &&
    propuestas.filter((p) => p.path.includes('tienda-demo')).length === 1,
    JSON.stringify(propuestas))
  ok('un repo con varios worktrees es un solo proyecto, en la ruta del repo',
    propuestas.find((p) => p.path === '/srv/ejemplo/tienda-demo')?.name === 'Tienda Demo',
    JSON.stringify(propuestas))
  ok('el nombre sale de `repo list` y, sin el, del nombre del repo',
    propuestas.find((p) => p.path === '/srv/otro/api-demo')?.name === 'api-demo',
    JSON.stringify(propuestas))
  const ids = propuestas.map((p) => p.id)
  ok('los ids son estables, sin signos y no se repiten',
    new Set(ids).size === ids.length && ids.every((i) => /^[a-z0-9][a-z0-9-]*$/.test(i)),
    ids.join(','))
  ok('el orden es el de los ids', JSON.stringify(ids) === JSON.stringify([...ids].sort()))
  ok('las propuestas llevan solo id, name y path',
    propuestas.every((p) => Object.keys(p).sort().join() === 'id,name,path'),
    JSON.stringify(propuestas))

  const aceptado = [{ id: 'tienda-demo', name: 'Tienda Demo', path: '/srv/ejemplo/tienda-demo',
    note: '' }]
  const resto = proponer(worktrees, repos, aceptado)
  ok('lo ya aceptado no se vuelve a proponer',
    !resto.some((p) => p.path === '/srv/ejemplo/tienda-demo'), JSON.stringify(resto))
  ok('ni lo que queda dentro de un proyecto aceptado',
    proponer([wt('r9', 'sub-demo', '/srv/ejemplo/tienda-demo/sub')], [], aceptado).length === 0)
  // Un id nuevo que choca con uno ya aceptado, de OTRO proyecto, no lo pisa.
  const choque = proponer([wt('r7', 'tienda-demo', '/srv/tercero/tienda-demo',
    { isMainWorktree: true })], [], aceptado)
  ok('un id que choca con uno aceptado recibe sufijo',
    choque.length === 1 && choque[0].id === 'tienda-demo-2', JSON.stringify(choque))
}

// ───────── el catalogo en el worker: el panel pide, Orca contesta, el dueno decide ─────────
console.log('\nworker: el catalogo de proyectos se refresca, se acepta y llega al arnes')
{
  const { comandoOrca } = await import('../catalogo.mjs')
  // Un bloque anterior borra RAIZ entera (arriba): sin un userData de Orca el arnes no
  // tiene donde sembrarse, asi que se vuelve a poner el de este archivo.
  for (const base of [join(process.env.HOME, 'Library', 'Application Support'),
    process.env.XDG_CONFIG_HOME, process.env.APPDATA]) {
    mkdirSync(join(base, 'orca'), { recursive: true })
  }
  const bin = join(RAIZ, 'orca-falsa')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'ps.json'), JSON.stringify({ id: 'x', ok: true, result: { worktrees: [
    { repoId: 'r1', repo: 'alfa-demo', path: '/srv/ejemplo/alfa-demo', isArchived: false,
      isMainWorktree: true },
    { repoId: 'r2', repo: 'beta-demo', path: '/srv/ejemplo/beta-demo', isArchived: false,
      isMainWorktree: true },
    { repoId: 'r3', repo: 'gama-demo', path: '/srv/ejemplo/gama-demo', isArchived: true,
      isMainWorktree: true }
  ] } }))
  writeFileSync(join(bin, 'repos.json'), JSON.stringify({ id: 'x', ok: true, result: { repos: [
    { id: 'r1', path: '/srv/ejemplo/alfa-demo', displayName: 'Alfa Demo' }
  ] } }))
  // La CLI de mentira. Anota cada llamada: lo unico que el catalogo puede ejecutar son
  // estas dos, con estos argumentos.
  writeFileSync(join(bin, comandoOrca()), [
    '#!/bin/sh',
    'echo "$@" >> "$(dirname "$0")/llamadas.txt"',
    'case "$1 $2" in',
    '  "worktree ps") cat "$(dirname "$0")/ps.json" ;;',
    '  "repo list") cat "$(dirname "$0")/repos.json" ;;',
    '  *) echo "comando inesperado" >&2; exit 2 ;;',
    'esac', ''
  ].join('\n'), { mode: 0o755 })
  const pathAntes = process.env.PATH
  process.env.PATH = `${bin}:${pathAntes}`

  const orca = hostFalso(herramientas('catalogo', BUENO), { chats: [] })
  const { apagar } = await arranca(orca)
  const pide = async (id, extra) => {
    orca.store.scopeRequest = { ...extra, id, at: new Date().toISOString() }
    await hasta(() => orca.store.scopeResult && orca.store.scopeResult.requestId === id, 15000)
    return orca.store.scopeResult
  }
  const md = () => {
    const carpeta = workspaceDir(PLUGIN_DIR)
    const ruta = carpeta && join(carpeta, 'PROJECTS.md')
    return ruta && existsSync(ruta) ? readFileSync(ruta, 'utf8') : ''
  }

  const r1 = await pide('cat-1', { action: 'proyectos-refrescar' })
  ok('refrescar contesta que si y cuantas propuestas hay',
    r1 && r1.ok === true && r1.code === 'refrescado' && r1.proposals === 2, JSON.stringify(r1))
  const st = orca.store.projectsStatus
  ok('publica las propuestas para el panel, sin los archivados',
    st && st.ok === true && st.proposals.map((p) => p.id).join() === 'alfa-demo,beta-demo',
    JSON.stringify(st))
  ok('el nombre sale de `repo list`', st && st.proposals[0].name === 'Alfa Demo',
    JSON.stringify(st))
  ok('refrescar NO acepta nada por si solo', orca.store.projects === undefined,
    JSON.stringify(orca.store.projects))
  const llamadas = sinEncendido(readFileSync(join(bin, 'llamadas.txt'), 'utf8').trim().split('\n'))
  ok('solo corrio `worktree ps --json` y `repo list --json`',
    llamadas.every((l) => l === 'worktree ps --json' || l === 'repo list --json') &&
    llamadas.length === 2, JSON.stringify(llamadas))

  const r2 = await pide('cat-2', { action: 'proyectos-aceptar',
    ids: ['alfa-demo', 'inventado'] })
  ok('aceptar contesta cuantos entraron', r2 && r2.ok === true && r2.added === 1,
    JSON.stringify(r2))
  ok('guarda el proyecto con el nombre y la ruta que dijo Orca',
    JSON.stringify(orca.store.projects) === JSON.stringify([
      { id: 'alfa-demo', name: 'Alfa Demo', path: '/srv/ejemplo/alfa-demo', note: '' }]),
    JSON.stringify(orca.store.projects))
  ok('lo aceptado sale de las propuestas',
    orca.store.projectsStatus.proposals.map((p) => p.id).join() === 'beta-demo',
    JSON.stringify(orca.store.projectsStatus))
  ok('un id que Orca no propone no entra, aunque el panel lo mande',
    !orca.store.projects.some((p) => p.id === 'inventado'))
  ok('el arnes se regenera con el proyecto aceptado',
    await hasta(() => md().includes('alfa-demo') && md().includes('/srv/ejemplo/alfa-demo'), 20000),
    md())

  const r3 = await pide('cat-3', { action: 'proyectos-nota', project: 'alfa-demo',
    note: 'Tienda\nen linea.  Cobros y envios' })
  ok('la nota se guarda en una sola linea', r3 && r3.ok === true &&
    orca.store.projects[0].note === 'Tienda en linea. Cobros y envios',
    JSON.stringify([r3, orca.store.projects]))
  ok('y llega al arnes',
    await hasta(() => md().includes('Tienda en linea. Cobros y envios'), 20000), md())

  const r4 = await pide('cat-4', { action: 'proyectos-aceptar', ids: ['no-existe'] })
  ok('aceptar solo lo que no es propuesta no cambia nada y lo dice',
    r4 && r4.ok === false && r4.code === 'sin-cambios', JSON.stringify(r4))
  const r5 = await pide('cat-5', { action: 'proyectos-aceptar', ids: 'alfa-demo' })
  ok('un pedido mal formado se rechaza con codigo',
    r5 && r5.ok === false && r5.code === 'argumentos-invalidos', JSON.stringify(r5))
  const r6 = await pide('cat-6', { action: 'proyectos-nota', project: 'fantasma', note: 'x' })
  ok('una nota para un proyecto que no esta se rechaza',
    r6 && r6.ok === false && r6.code === 'proyecto-no-existe', JSON.stringify(r6))

  const r7 = await pide('cat-7', { action: 'proyectos-quitar', project: 'alfa-demo' })
  ok('quitar lo saca del catalogo', r7 && r7.ok === true &&
    JSON.stringify(orca.store.projects) === '[]', JSON.stringify([r7, orca.store.projects]))
  ok('y del arnes, que vuelve a decir que no hay proyectos',
    await hasta(() => !md().includes('alfa-demo') && /No projects accepted yet/.test(md()), 20000),
    md())
  apagar()

  // Al arrancar, el arnes sale con lo que ya estaba aceptado: no espera a que alguien
  // abra el panel.
  const orca2 = hostFalso(herramientas('catalogo-2', BUENO), { chats: [],
    projects: [{ id: 'beta-demo', name: 'Beta Demo', path: '/srv/ejemplo/beta-demo',
      note: 'Backend' }] })
  const { apagar: apagar2 } = await arranca(orca2)
  ok('al arrancar siembra PROJECTS.md con los proyectos ya aceptados',
    await hasta(() => md().includes('beta-demo') && md().includes('Backend'), 20000), md())
  apagar2()

  // Sin la CLI de Orca: se dice, no se finge una lista vacia.
  process.env.PATH = '/usr/bin:/bin'
  const orca3 = hostFalso(herramientas('catalogo-3', BUENO), { chats: [] })
  const { apagar: apagar3 } = await arranca(orca3)
  orca3.store.scopeRequest = { id: 'cat-sin', at: new Date().toISOString(),
    action: 'proyectos-refrescar' }
  await hasta(() => orca3.store.scopeResult && orca3.store.scopeResult.requestId === 'cat-sin', 15000)
  const sin = orca3.store.scopeResult
  ok('sin la CLI de Orca el pedido falla con codigo estable',
    sin && sin.ok === false && sin.code === 'sin-cli-orca', JSON.stringify(sin))
  ok('y el estado dice que no se pudo preguntar, no que no hay propuestas',
    orca3.store.projectsStatus && orca3.store.projectsStatus.ok === false &&
    orca3.store.projectsStatus.reason === 'sin-cli-orca',
    JSON.stringify(orca3.store.projectsStatus))
  apagar3()
  process.env.PATH = pathAntes
}

{
  // Las automatizaciones del plugin, encendidas solas (caso-en-archivo, T4). Orca las
  // recrea apagadas, con ids nuevos, cada vez que el dueno vuelve a aprobar el plugin. El
  // worker las reconoce por lo que declara el manifiesto (el plugin y el id de cada una),
  // nunca por un id fijo, y no toca ninguna que no sea suya.
  const { crearEncendedor, apagadasDelPlugin, automatizacionesDelManifiesto } =
    await import('../agente.mjs')
  const manifiesto = JSON.parse(readFileSync(join(PLUGIN_DIR, 'orca-plugin.json'), 'utf8'))
  const propias = automatizacionesDelManifiesto(manifiesto)
  ok('del manifiesto salen el plugin y los ids de sus automatizaciones',
    propias && propias.pluginKey === 'ab2web.orca-wa-inbox' &&
    JSON.stringify(propias.ids) === JSON.stringify(['tick', 'triage']), JSON.stringify(propias))
  ok('un manifiesto sin automatizaciones no reconoce ninguna',
    automatizacionesDelManifiesto({ id: 'x', publisher: 'y' }).ids.length === 0)

  const origen = (pluginKey, automationId) => ({ pluginKey, automationId })
  const LISTA = { ok: true, result: { automations: [
    { id: 'auto-tick-2', enabled: false, pluginOrigin: origen('ab2web.orca-wa-inbox', 'tick') },
    { id: 'auto-triage-2', enabled: true, rrule: '*/5 * * * *',
      pluginOrigin: origen('ab2web.orca-wa-inbox', 'triage') },
    { id: 'auto-otro', enabled: false, pluginOrigin: origen('otro.plugin', 'triage') },
    { id: 'auto-dueno', enabled: false, name: 'WhatsApp: triage' },
    { id: 'auto-vieja', enabled: false, pluginOrigin: origen('ab2web.orca-wa-inbox', 'take') },
    { id: 'auto-sin-dato', pluginOrigin: origen('ab2web.orca-wa-inbox', 'triage') }] } }
  ok('solo las del plugin, declaradas en el manifiesto y apagadas de verdad',
    JSON.stringify(apagadasDelPlugin(LISTA, propias)) === JSON.stringify(['auto-tick-2']),
    JSON.stringify(apagadasDelPlugin(LISTA, propias)))
  ok('un sobre que no es la lista no enciende nada',
    apagadasDelPlugin({ ok: true, result: {} }, propias).length === 0 &&
    apagadasDelPlugin(null, propias).length === 0)

  const correrFalso = (salidas) => {
    const llamadas = []
    const correr = async (cmd, args) => {
      llamadas.push([cmd, ...args].join(' '))
      const salida = salidas[args.slice(0, 2).join(' ')]
      if (salida instanceof Error) throw salida
      return { stdout: JSON.stringify(salida ?? { ok: true, result: {} }) }
    }
    return { correr, llamadas }
  }
  {
    const { correr, llamadas } = correrFalso({ 'automations list': LISTA })
    const r = await crearEncendedor({ correr, manifiesto, plataforma: 'darwin', env: {} })()
    ok('enciende la del plugin con `automations edit <id> --enabled`, y nada mas',
      JSON.stringify(llamadas) === JSON.stringify(['orca automations list --json',
        'orca automations edit auto-tick-2 --enabled --json']) &&
      r.ok === true && JSON.stringify(r.enabled) === JSON.stringify(['auto-tick-2']),
      JSON.stringify([llamadas, r]))
  }
  {
    const { correr, llamadas } = correrFalso({ 'automations list': {
      ok: true, result: { automations: [LISTA.result.automations[1]] } } })
    const r = await crearEncendedor({ correr, manifiesto, plataforma: 'darwin', env: {} })()
    ok('con todas encendidas solo pregunta', llamadas.length === 1 && r.ok === true &&
      r.enabled.length === 0, JSON.stringify([llamadas, r]))
  }
  {
    const { correr, llamadas } = correrFalso({ 'automations list': Object.assign(new Error('x'), { exitCode: 1 }) })
    const r = await crearEncendedor({ correr, manifiesto, plataforma: 'darwin', env: {} })()
    ok('si Orca no da la lista no enciende nada y lo dice con un codigo',
      llamadas.length === 1 && r.ok === false && r.code === 'automatizaciones-fallo',
      JSON.stringify([llamadas, r]))
  }
  {
    const { correr } = correrFalso({ 'automations list': LISTA,
      'automations edit': Object.assign(new Error('x'), { exitCode: 1 }) })
    const r = await crearEncendedor({ correr, manifiesto, plataforma: 'darwin', env: {} })()
    ok('una que no se pudo encender se dice, sin tumbar nada',
      r.ok === false && r.code === 'encender-fallo' && JSON.stringify(r.failed) === JSON.stringify(['auto-tick-2']),
      JSON.stringify(r))
  }

  {
    // La que el dueno apaga a mano se respeta: ya la vio encendida, asi que no es una
    // recien creada por Orca. Solo se enciende un id que nunca se vio encendido.
    const lista = { ok: true, result: { automations: [
      { id: 'auto-tick-3', enabled: true, pluginOrigin: origen('ab2web.orca-wa-inbox', 'tick') }] } }
    const { correr, llamadas } = correrFalso({ 'automations list': lista })
    const encender = crearEncendedor({ correr, manifiesto, plataforma: 'darwin', env: {} })
    await encender()
    lista.result.automations[0].enabled = false
    const r = await encender()
    ok('la que el dueno apago despues de verla encendida no se vuelve a encender',
      !llamadas.some((l) => l.includes('automations edit')) && r.enabled.length === 0,
      JSON.stringify([llamadas, r]))
  }

  // El ritmo de la atencion (ritmo-triage): el selector del panel tambien fija el cron de
  // la automatizacion `triage` del plugin. Se reconoce por el manifiesto, nunca por un id.
  const { crearAjustadorRitmo, cronDeMinutos } = await import('../agente.mjs')
  ok('cada N minutos es */N, y una hora es al minuto cero',
    cronDeMinutos(2) === '*/2 * * * *' && cronDeMinutos(5) === '*/5 * * * *' &&
    cronDeMinutos(30) === '*/30 * * * *' && cronDeMinutos(60) === '0 * * * *',
    JSON.stringify([2, 5, 30, 60].map(cronDeMinutos)))
  ok('fuera de 1 a 60 minutos no hay cron', cronDeMinutos(0) === null &&
    cronDeMinutos(61) === null && cronDeMinutos(Number.NaN) === null && cronDeMinutos(1.5) === null)
  const conRitmo = (rrule) => ({ ok: true, result: { automations: [
    { id: 'auto-tick-2', enabled: true, rrule: '* * * * *',
      pluginOrigin: origen('ab2web.orca-wa-inbox', 'tick') },
    { id: 'auto-triage-2', enabled: true, rrule, pluginOrigin: origen('ab2web.orca-wa-inbox', 'triage') },
    { id: 'auto-otro', enabled: true, rrule: '*/5 * * * *', pluginOrigin: origen('otro.plugin', 'triage') },
    { id: 'auto-dueno', enabled: true, rrule: '*/5 * * * *', name: 'WhatsApp: triage' }] } })
  {
    const { correr, llamadas } = correrFalso({ 'automations list': conRitmo('*/5 * * * *') })
    const r = await crearAjustadorRitmo({ correr, manifiesto, plataforma: 'darwin', env: {} })(2)
    ok('el triage del plugin pasa al cron del selector con `automations edit --trigger`, y nada mas',
      JSON.stringify(llamadas) === JSON.stringify(['orca automations list --json',
        'orca automations edit auto-triage-2 --trigger */2 * * * * --json']) &&
      r.ok === true && r.code === 'ajustado' && r.cron === '*/2 * * * *' && r.minutes === 2,
      JSON.stringify([llamadas, r]))
  }
  {
    const { correr, llamadas } = correrFalso({ 'automations list': conRitmo('*/2 * * * *') })
    const r = await crearAjustadorRitmo({ correr, manifiesto, plataforma: 'darwin', env: {} })(2)
    ok('si ya corre a ese ritmo solo pregunta', llamadas.length === 1 && r.ok === true &&
      r.code === 'al-dia' && r.cron === '*/2 * * * *', JSON.stringify([llamadas, r]))
  }
  {
    const { correr, llamadas } = correrFalso({ 'automations list': {
      ok: true, result: { automations: [conRitmo('*/5 * * * *').result.automations[0]] } } })
    const r = await crearAjustadorRitmo({ correr, manifiesto, plataforma: 'darwin', env: {} })(2)
    ok('sin la automatizacion del triage no toca nada y lo dice',
      llamadas.length === 1 && r.ok === false && r.code === 'sin-triage', JSON.stringify([llamadas, r]))
  }
  {
    const { correr, llamadas } = correrFalso({ 'automations list': Object.assign(new Error('x'), { exitCode: 1 }) })
    const r = await crearAjustadorRitmo({ correr, manifiesto, plataforma: 'darwin', env: {} })(2)
    ok('si Orca no da la lista no cambia nada', llamadas.length === 1 && r.ok === false &&
      r.code === 'automatizaciones-fallo', JSON.stringify([llamadas, r]))
  }
  {
    const { correr } = correrFalso({ 'automations list': conRitmo('*/5 * * * *'),
      'automations edit': { ok: false, error: { code: 'invalid' } } })
    const r = await crearAjustadorRitmo({ correr, manifiesto, plataforma: 'darwin', env: {} })(2)
    ok('si Orca contesta que no, se dice', r.ok === false && r.code === 'ajustar-fallo' &&
      r.cron === '*/2 * * * *', JSON.stringify(r))
  }
  {
    const { correr, llamadas } = correrFalso({ 'automations list': conRitmo('*/5 * * * *') })
    const r = await crearAjustadorRitmo({ correr, manifiesto, plataforma: 'darwin', env: {} })(0)
    ok('un ritmo fuera de rango no llama a Orca', llamadas.length === 0 && r.ok === false &&
      r.code === 'ritmo-invalido', JSON.stringify([llamadas, r]))
  }

  // Y el worker lo hace solo al arrancar, por la CLI de Orca sin la valla.
  const { comandoOrca } = await import('../catalogo.mjs')
  const bin = join(RAIZ, 'orca-automatizaciones')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'lista.json'), JSON.stringify(LISTA))
  writeFileSync(join(bin, comandoOrca()), [
    '#!/bin/sh',
    'echo "$@" >> "$(dirname "$0")/llamadas.txt"',
    'if [ "$1 $2" = "automations list" ]; then cat "$(dirname "$0")/lista.json"; else echo \'{"ok":true,"result":{}}\'; fi', ''
  ].join('\n'), { mode: 0o755 })
  const llamadasOrca = () => existsSync(join(bin, 'llamadas.txt'))
    ? readFileSync(join(bin, 'llamadas.txt'), 'utf8').trim().split('\n').filter(Boolean) : []
  // Por ORCA_CLI_COMMAND y no por PATH: el env de las herramientas es una foto que toma el
  // worker al resolver la casa de Orca, y en esta prueba esa foto puede ser de antes.
  process.env.ORCA_CLI_COMMAND = join(bin, comandoOrca())
  try {
    const f = herramientasCaso('automatizaciones', { casos: {} })
    const orca = hostFalso(f.dir, { chats: [] })
    const { apagar } = await arranca(orca)
    ok('al arrancar, el worker enciende la automatizacion del plugin que Orca dejo apagada',
      await hasta(() => llamadasOrca().includes('automations edit auto-tick-2 --enabled --json'), 15000),
      JSON.stringify(llamadasOrca()))
    ok('y ninguna otra', llamadasOrca().filter((l) => l.startsWith('automations edit')).length === 1,
      JSON.stringify(llamadasOrca()))
    // Sin `syncMinutes` el ritmo es el de fabrica (5 min), el mismo del manifiesto: el
    // triage no se toca y el panel recibe a que ritmo corre.
    ok('al arrancar deja dicho a que ritmo corre el triage',
      await hasta(() => orca.store.workerBeat?.triage?.ok === true, 15000) &&
      orca.store.workerBeat?.triage.minutes === 5 && orca.store.workerBeat?.triage.cron === '*/5 * * * *' &&
      typeof orca.store.workerBeat?.at === 'string',
      JSON.stringify(orca.store.workerBeat?.triage))
    // El dueno cambia el selector: en segundos, no en la proxima vuelta de la salud.
    orca.store.syncMinutes = '2'
    ok('cambiar el selector pone el triage a ese ritmo en segundos',
      await hasta(() => llamadasOrca().includes('automations edit auto-triage-2 --trigger */2 * * * * --json'), 15000),
      JSON.stringify(llamadasOrca()))
    ok('y el panel recibe el ritmo nuevo',
      await hasta(() => orca.store.workerBeat?.triage?.minutes === 2, 15000) &&
      orca.store.workerBeat?.triage.ok === true && orca.store.workerBeat?.triage.cron === '*/2 * * * *',
      JSON.stringify(orca.store.workerBeat?.triage))
    ok('y ninguna otra automatizacion cambia de ritmo',
      llamadasOrca().filter((l) => l.includes('--trigger')).length === 1, JSON.stringify(llamadasOrca()))
    apagar()
  } finally {
    delete process.env.ORCA_CLI_COMMAND
  }
}

// ───────── las skills que el dueno instala fuera del plugin (skills-globales, S3) ─────────
// `skills.mjs` escribe `SKILL.md` en ~/.claude/skills o en un proyecto aceptado, con la
// misma regla de secciones que el arnes: lo que el dueno edito es suyo. Todo con un HOME
// temporal: nunca contra el ~/.claude de verdad.
console.log('\nworker: las skills instalables (whatsapp-avisos)')
{
  mkdirSync(RAIZ, { recursive: true })
  const skills = await import('../skills.mjs')
  const casa = join(RAIZ, 'skills-home')
  mkdirSync(casa, { recursive: true })
  const env = { HOME: casa }
  const proyecto = join(RAIZ, 'skills-proyecto-demo')
  mkdirSync(proyecto, { recursive: true })
  const PROY = { id: 'demo', name: 'Demo', path: proyecto, note: '' }
  const global = { scope: 'global' }
  const enProyecto = { scope: 'project', project: 'demo', path: proyecto, name: 'Demo' }
  const archivoGlobal = join(casa, '.claude', 'skills', 'whatsapp-avisos', 'SKILL.md')
  const archivoProyecto = join(proyecto, '.claude', 'skills', 'whatsapp-avisos', 'SKILL.md')
  const plantilla = readFileSync(join(PLUGIN_DIR, 'harness', 'skills-globales',
    'whatsapp-avisos', 'SKILL.md'), 'utf8')
  const de = (estado, objetivo) => {
    const s = (estado.skills || []).find((x) => x.name === 'whatsapp-avisos')
    return s && s.targets.find((t) => t.scope === objetivo.scope &&
      (objetivo.scope === 'global' || t.project === objetivo.project))
  }

  const cat = skills.catalogoSkills(PLUGIN_DIR)
  ok('el catalogo trae whatsapp-avisos con su descripcion, y nada del arnes interno',
    cat.length === 1 && cat[0].name === 'whatsapp-avisos' && /owner/.test(cat[0].description),
    JSON.stringify(cat))

  let e = skills.estadoSkills(PLUGIN_DIR, [PROY], env)
  ok('sin nada escrito: global y proyecto sin instalar',
    e.ok && de(e, global)?.state === 'not-installed' && de(e, enProyecto)?.state === 'not-installed',
    JSON.stringify(e))

  let r = skills.instalar(PLUGIN_DIR, { skill: 'whatsapp-avisos', target: global }, env)
  ok('instalar global escribe ~/.claude/skills/whatsapp-avisos/SKILL.md tal cual la plantilla',
    r.ok && r.code === 'skill-instalada' && existsSync(archivoGlobal) &&
    readFileSync(archivoGlobal, 'utf8') === plantilla, JSON.stringify(r))
  e = skills.estadoSkills(PLUGIN_DIR, [PROY], env)
  ok('y el estado dice instalada, con la version del plugin',
    de(e, global)?.state === 'installed' && de(e, global)?.version === e.version &&
    de(e, enProyecto)?.state === 'not-installed', JSON.stringify(de(e, global)))

  // El dueno edita una seccion: sigue instalada, y la seccion es suya.
  const editado = readFileSync(archivoGlobal, 'utf8').replace('## Rules\n', '## Rules\n\n- Mi regla demo.\n')
  writeFileSync(archivoGlobal, editado)
  e = skills.estadoSkills(PLUGIN_DIR, [PROY], env)
  ok('una seccion editada no la vuelve desactualizada, y se nombra como suya',
    de(e, global)?.state === 'installed' && JSON.stringify(de(e, global)?.yours) === '["Rules"]',
    JSON.stringify(de(e, global)))

  // Una version nueva del plugin con otra seccion "Notify him".
  const nuevo = join(RAIZ, 'skills-plugin-nuevo')
  mkdirSync(join(nuevo, 'harness', 'skills-globales', 'whatsapp-avisos'), { recursive: true })
  const man = JSON.parse(readFileSync(join(PLUGIN_DIR, 'orca-plugin.json'), 'utf8'))
  writeFileSync(join(nuevo, 'orca-plugin.json'), JSON.stringify({ ...man, version: '99.0.0' }))
  writeFileSync(join(nuevo, 'harness', 'skills-globales', 'whatsapp-avisos', 'SKILL.md'),
    plantilla.replace('## Notify him\n', '## Notify him\n\nNEW NOTIFY TEXT.\n'))
  e = skills.estadoSkills(nuevo, [PROY], env)
  ok('con la plantilla nueva, la instalada sale desactualizada',
    de(e, global)?.state === 'outdated' && e.version === '99.0.0', JSON.stringify(de(e, global)))
  const act = skills.actualizarTodas(nuevo, env)
  const tras = readFileSync(archivoGlobal, 'utf8')
  ok('actualizar trae la seccion nueva y conserva la que edito el dueno',
    act.ok && tras.includes('NEW NOTIFY TEXT.') && tras.includes('- Mi regla demo.'),
    JSON.stringify(act))
  e = skills.estadoSkills(nuevo, [PROY], env)
  ok('y queda al dia, en la version nueva',
    de(e, global)?.state === 'installed' && de(e, global)?.version === '99.0.0',
    JSON.stringify(de(e, global)))

  r = skills.quitar(nuevo, { skill: 'whatsapp-avisos', target: global }, env)
  ok('quitar un archivo con ediciones del dueno NO lo borra sin confirmar, y dice cuales',
    !r.ok && r.code === 'skill-editada' && JSON.stringify(r.yours) === '["Rules"]' &&
    existsSync(archivoGlobal), JSON.stringify(r))
  r = skills.quitar(nuevo, { skill: 'whatsapp-avisos', target: global, force: true }, env)
  ok('confirmado, lo borra con su carpeta, y deja ~/.claude/skills',
    r.ok && r.code === 'skill-quitada' && !existsSync(archivoGlobal) &&
    !existsSync(dirname(archivoGlobal)) && existsSync(join(casa, '.claude', 'skills')),
    JSON.stringify(r))

  r = skills.instalar(PLUGIN_DIR, { skill: 'whatsapp-avisos', target: enProyecto }, env)
  ok('instalar en un proyecto escribe <proyecto>/.claude/skills/whatsapp-avisos/SKILL.md',
    r.ok && existsSync(archivoProyecto) && !existsSync(archivoGlobal), JSON.stringify(r))
  e = skills.estadoSkills(PLUGIN_DIR, [PROY], env)
  ok('el estado lo dice por proyecto', de(e, enProyecto)?.state === 'installed' &&
    de(e, global)?.state === 'not-installed', JSON.stringify(e.skills))
  // Un proyecto que el dueno ya quito del catalogo sigue apareciendo mientras tenga la skill.
  e = skills.estadoSkills(PLUGIN_DIR, [], env)
  ok('una instalacion en un proyecto que salio del catalogo se sigue listando para quitarla',
    de(e, enProyecto)?.state === 'installed', JSON.stringify(e.skills))
  r = skills.quitar(PLUGIN_DIR, { skill: 'whatsapp-avisos', target: enProyecto }, env)
  ok('sin ediciones, quitar lo borra sin preguntar',
    r.ok && r.code === 'skill-quitada' && !existsSync(archivoProyecto), JSON.stringify(r))

  // Un archivo que el plugin no escribio: no se pisa ni se borra.
  mkdirSync(dirname(archivoGlobal), { recursive: true })
  writeFileSync(archivoGlobal, '---\nname: whatsapp-avisos\n---\nAjeno demo.\n')
  e = skills.estadoSkills(PLUGIN_DIR, [PROY], env)
  ok('un SKILL.md que no escribio el plugin sale como ajeno', de(e, global)?.state === 'foreign',
    JSON.stringify(de(e, global)))
  r = skills.instalar(PLUGIN_DIR, { skill: 'whatsapp-avisos', target: global }, env)
  const r2 = skills.quitar(PLUGIN_DIR, { skill: 'whatsapp-avisos', target: global, force: true }, env)
  ok('y ni instalar ni quitar lo tocan',
    !r.ok && r.code === 'skill-ajena' && !r2.ok && r2.code === 'skill-ajena' &&
    readFileSync(archivoGlobal, 'utf8').includes('Ajeno demo.'), JSON.stringify([r, r2]))
  rmSync(dirname(archivoGlobal), { recursive: true, force: true })

  // Borrada a mano: se toma como quitada y no se vuelve a escribir.
  skills.instalar(PLUGIN_DIR, { skill: 'whatsapp-avisos', target: global }, env)
  rmSync(archivoGlobal)
  const tras2 = skills.actualizarTodas(nuevo, env)
  e = skills.estadoSkills(nuevo, [PROY], env)
  ok('borrada a mano, actualizar no la vuelve a escribir y deja de figurar',
    tras2.ok && !existsSync(archivoGlobal) && de(e, global)?.state === 'not-installed',
    JSON.stringify([tras2, de(e, global)]))

  r = skills.instalar(PLUGIN_DIR, { skill: '../fuera', target: global }, env)
  const r3 = skills.instalar(PLUGIN_DIR, { skill: 'whatsapp-avisos',
    target: { scope: 'project', project: 'demo', path: 'relativo/demo' } }, env)
  ok('una skill que no esta en el catalogo, o un proyecto sin ruta absoluta, se niegan',
    !r.ok && r.code === 'skill-no-existe' && !r3.ok && r3.code === 'argumentos-invalidos',
    JSON.stringify([r, r3]))

  // Y como subproceso, que es como lo corre el worker (la valla no deja escribir).
  const salida = await new Promise((resolve) => execFileNode(process.execPath,
    [join(PLUGIN_DIR, 'skills.mjs'), PLUGIN_DIR, JSON.stringify({ op: 'instalar',
      skill: 'whatsapp-avisos', target: global, proyectos: [PROY] })],
    { env: { ...process.env, HOME: casa } }, (error, stdout) => resolve({ error, stdout })))
  let dato = null
  try { dato = JSON.parse(salida.stdout) } catch { dato = null }
  ok('`node skills.mjs` contesta el veredicto y el estado nuevo, en JSON',
    dato && dato.ok && dato.code === 'skill-instalada' && de(dato.estado, global)?.state === 'installed' &&
    existsSync(archivoGlobal), String(salida.stdout).slice(0, 300))
}


// ───────── el worker instala lo que pide el panel y mantiene al dia lo instalado (S4) ─────────
console.log('\nworker: la pestana Skills pide, el worker escribe')
{
  mkdirSync(RAIZ, { recursive: true })
  const skills = await import('../skills.mjs')
  const { huella, secciones } = await import('../harness.mjs')
  const env = { HOME: process.env.HOME }
  const archivoGlobal = join(process.env.HOME, '.claude', 'skills', 'whatsapp-avisos', 'SKILL.md')
  rmSync(dirname(archivoGlobal), { recursive: true, force: true })
  const proyecto = join(RAIZ, 'skills-worker-proyecto')
  const otraRuta = join(RAIZ, 'skills-worker-otra')
  mkdirSync(proyecto, { recursive: true })
  mkdirSync(otraRuta, { recursive: true })
  const archivoProyecto = join(proyecto, '.claude', 'skills', 'whatsapp-avisos', 'SKILL.md')

  // Una copia que escribio una version VIEJA del plugin: la seccion "Notify him" tiene otro
  // texto, y la huella anotada es la de ese texto (la escribio el plugin, no el dueno).
  skills.instalar(PLUGIN_DIR, { skill: 'whatsapp-avisos', target: { scope: 'global' } }, env)
  const actual = readFileSync(archivoGlobal, 'utf8')
  const seccion = secciones(actual).find((s) => s.nombre === 'Notify him')
  const vieja = '## Notify him\n\nOLD NOTIFY TEXT.\n'
  writeFileSync(archivoGlobal, actual.replace(seccion.texto, vieja))
  const rutaMan = join(process.env.HOME, '.wa-inbox', 'skills.json')
  const man = JSON.parse(readFileSync(rutaMan, 'utf8'))
  man.installs[0].sections['Notify him'] = huella(vieja)
  man.installs[0].version = '0.0.1'
  writeFileSync(rutaMan, JSON.stringify(man))

  const orca = hostFalso(herramientas('skills-worker', '#!/bin/sh\necho "[]"\n'), {
    chats: [], projects: [{ id: 'demo', name: 'Demo', path: proyecto, note: '' }] })
  const { apagar } = await arranca(orca)
  ok('al activarse, el worker pone al dia la copia instalada',
    await hasta(() => !readFileSync(archivoGlobal, 'utf8').includes('OLD NOTIFY TEXT.'), 20000) &&
    readFileSync(archivoGlobal, 'utf8') === actual, readFileSync(archivoGlobal, 'utf8').slice(0, 200))
  ok('y deja el estado para el panel, con la version de ahora',
    await hasta(() => orca.store.skillsStatus?.skills?.[0]?.targets?.[0]?.version ===
      orca.store.skillsStatus?.version, 20000),
    JSON.stringify(orca.store.skillsStatus).slice(0, 300))

  let v = await pideCaso(orca, { action: 'skills-estado' })
  const avisos = orca.store.skillsStatus?.skills?.find((s) => s.name === 'whatsapp-avisos')
  ok('skills-estado contesta y lista global y cada proyecto aceptado',
    v && v.ok === true && v.code === 'skills-leidas' && avisos &&
    avisos.targets.some((t) => t.scope === 'global' && t.state === 'installed') &&
    avisos.targets.some((t) => t.scope === 'project' && t.project === 'demo' &&
      t.state === 'not-installed'), JSON.stringify([v, avisos]))

  // La ruta la pone el catalogo, nunca el panel.
  v = await pideCaso(orca, { action: 'skill-instalar', skill: 'whatsapp-avisos',
    project: 'demo', path: otraRuta })
  ok('instalar en un proyecto escribe en la ruta del catalogo e ignora la del pedido',
    v && v.ok === true && v.code === 'skill-instalada' && existsSync(archivoProyecto) &&
    !existsSync(join(otraRuta, '.claude')), JSON.stringify(v))
  ok('y el estado del panel ya lo dice',
    orca.store.skillsStatus?.skills?.[0]?.targets?.some((t) => t.project === 'demo' &&
      t.state === 'installed'), JSON.stringify(orca.store.skillsStatus?.skills))

  v = await pideCaso(orca, { action: 'skill-instalar', skill: 'whatsapp-avisos', project: 'nadie' })
  ok('un proyecto que no esta en el catalogo se niega', v && v.ok === false &&
    v.code === 'proyecto-no-existe', JSON.stringify(v))

  writeFileSync(archivoProyecto, readFileSync(archivoProyecto, 'utf8')
    .replace('## Rules\n', '## Rules\n\n- Regla demo del dueno.\n'))
  v = await pideCaso(orca, { action: 'skill-quitar', skill: 'whatsapp-avisos', project: 'demo' })
  ok('quitar una copia con ediciones pide confirmar y no borra',
    v && v.ok === false && v.code === 'skill-editada' && JSON.stringify(v.yours) === '["Rules"]' &&
    existsSync(archivoProyecto), JSON.stringify(v))
  v = await pideCaso(orca, { action: 'skill-quitar', skill: 'whatsapp-avisos', project: 'demo',
    force: true })
  ok('confirmado, la quita', v && v.ok === true && v.code === 'skill-quitada' &&
    !existsSync(archivoProyecto), JSON.stringify(v))

  v = await pideCaso(orca, { action: 'skill-instalar', skill: 'whatsapp-avisos', target: 'global' })
  ok('instalar global sobre la copia al dia no cambia nada y contesta actualizada',
    v && v.ok === true && v.code === 'skill-actualizada' &&
    readFileSync(archivoGlobal, 'utf8') === actual, JSON.stringify(v))
  v = await pideCaso(orca, { action: 'skill-quitar', skill: 'whatsapp-avisos', target: 'global' })
  ok('y quitarla global la borra', v && v.ok === true && !existsSync(archivoGlobal), JSON.stringify(v))
  apagar()
}


// ───────── avisos-orca: el estado de cada agente, y el aviso cuando espera ─────────
// odd/tasks/avisos-orca.md (O2). Orca emite `agent.status.changed` en cada emision, no solo
// al cambiar: el worker guarda el ultimo estado por panel y lanza `wa-scope orca-aviso`
// solo cuando un panel PASA a `waiting` y el dueno encendio ese aviso. Los agentes de la
// carpeta del plugin no cuentan. Un `done` queda `finished` solo si venia de `working`.
console.log('\nworker: avisos-orca, el estado de cada agente')
{
  const { registrarEstado, esEspacioDelPlugin, PANELES_TOPE } = await import('../avisos-orca.mjs')
  const LLAVE = 'ab2web.orca-wa-inbox'
  const PROPIO = `repo-plugin::/tmp/ejemplo/orca/plugin-workspaces/${LLAVE}`
  ok('la carpeta del plugin es suya', esEspacioDelPlugin(PROPIO, LLAVE))
  ok('y una sesion de esa carpeta tambien',
    esEspacioDelPlugin(`${PROPIO}::workspace:12345678-1234-1234-1234-123456789abc`, LLAVE))
  ok('en Windows tambien', esEspacioDelPlugin(`r::C:\\ejemplo\\plugin-workspaces\\${LLAVE}`, LLAVE))
  ok('un proyecto cualquiera no', !esEspacioDelPlugin('repo-a::/srv/ejemplo/alfa-demo', LLAVE))
  ok('ni la carpeta de otro plugin',
    !esEspacioDelPlugin('r::/tmp/ejemplo/orca/plugin-workspaces/otro.plugin', LLAVE))
  ok('ni un agente sin espacio', !esEspacioDelPlugin(null, LLAVE))

  const ev = (state, at, extra = {}) => ({ paneKey: 'tab-1:panel-1', worktreeId: 'repo-a::/srv/ejemplo/alfa-demo',
    state, receivedAt: at, agentType: 'claude', ...extra })
  let r = registrarEstado({}, ev('working', 1000), LLAVE)
  ok('el primer estado de un panel se guarda', r.cambio && r.paneles['tab-1:panel-1']?.state === 'working' &&
    r.paneles['tab-1:panel-1'].workingAt === 1000 && r.avisar === null, JSON.stringify(r))
  const p1 = r.paneles
  r = registrarEstado(p1, ev('working', 2000), LLAVE)
  ok('el mismo estado otra vez no es un cambio', !r.cambio && r.avisar === null)
  r = registrarEstado(p1, ev('waiting', 3000), LLAVE)
  ok('pasar a esperar es un cambio que avisa', r.cambio && r.avisar === 'waiting')
  const p2 = r.paneles
  r = registrarEstado(p2, ev('waiting', 3500), LLAVE)
  ok('el mismo waiting emitido otra vez no avisa dos veces', !r.cambio && r.avisar === null)
  r = registrarEstado(registrarEstado(p2, ev('working', 4000), LLAVE).paneles, ev('done', 5000), LLAVE)
  ok('un done que viene de working queda terminado', r.paneles['tab-1:panel-1'].finished === true &&
    r.paneles['tab-1:panel-1'].state === 'done' && r.avisar === null, JSON.stringify(r.paneles))
  ok('y el panel no guarda nada que el agente escribio',
    JSON.stringify(Object.keys(r.paneles['tab-1:panel-1']).sort()) ===
    JSON.stringify(['agentType', 'at', 'finished', 'state', 'workingAt', 'worktreeId']))
  r = registrarEstado({}, ev('done', 5000), LLAVE)
  ok('un done sin trabajo antes (arranque, reanudar) no queda terminado',
    r.paneles['tab-1:panel-1'].finished === false)
  r = registrarEstado(p1, ev('done', 5000, { sessionBoundary: true }), LLAVE)
  ok('un done marcado borde de sesion no queda terminado, aunque venga de working',
    r.paneles['tab-1:panel-1'].finished === false)
  r = registrarEstado(p2, ev('done', 5000), LLAVE)
  ok('un done que viene de waiting no queda terminado', r.paneles['tab-1:panel-1'].finished === false)
  // Decision del dueno (2026-10-05): `blocked` avisa como `waiting`. Pasar de uno al otro es
  // un cambio y el worker lanza; el aviso repetido en la misma ventana lo descarta wa-scope.
  r = registrarEstado(p1, ev('blocked', 3000), LLAVE)
  ok('blocked: pasar a bloqueado es un cambio que avisa como bloqueado', r.cambio &&
    r.avisar === 'blocked', JSON.stringify(r.avisar))
  const pb = r.paneles
  ok('blocked: el mismo blocked emitido otra vez no avisa',
    !registrarEstado(pb, ev('blocked', 3500), LLAVE).cambio)
  ok('blocked: de waiting a blocked avisa como bloqueado (wa-scope descarta el de la misma ventana)',
    registrarEstado(p2, ev('blocked', 3600), LLAVE).avisar === 'blocked')
  ok('blocked: de blocked a waiting avisa como espera',
    registrarEstado(pb, ev('waiting', 3600), LLAVE).avisar === 'waiting')
  // Un done despues de bloquearse no es un turno terminado: igual que despues de esperar, solo
  // cuenta el que viene de `working` (un permiso negado deja al agente en done sin terminar).
  ok('blocked: un done que viene de blocked no queda terminado',
    registrarEstado(pb, ev('done', 5000), LLAVE).paneles['tab-1:panel-1'].finished === false)
  ok('blocked: y uno de blocked -> working -> done si',
    registrarEstado(registrarEstado(pb, ev('working', 4000), LLAVE).paneles, ev('done', 5000), LLAVE)
      .paneles['tab-1:panel-1'].finished === true)
  r = registrarEstado({}, ev('waiting', 1000, { worktreeId: PROPIO }), LLAVE)
  ok('un agente de la carpeta del plugin no se guarda ni avisa', !r.cambio && r.avisar === null &&
    Object.keys(r.paneles).length === 0)
  r = registrarEstado({ viejo: { state: 'done', at: 1 } }, ev('working', 1 + 25 * 3600 * 1000), LLAVE)
  ok('un panel quieto mas de un dia se olvida', !('viejo' in r.paneles))
  const muchos = {}
  for (let i = 0; i < PANELES_TOPE + 5; i++) muchos[`p${i}`] = { state: 'done', at: 10000 + i }
  r = registrarEstado(muchos, ev('working', 20000), LLAVE)
  ok('nunca mas paneles que el tope, y se van los mas viejos',
    Object.keys(r.paneles).length === PANELES_TOPE && !('p0' in r.paneles) &&
    'tab-1:panel-1' in r.paneles, Object.keys(r.paneles).length)
  ok('un evento sin panel o sin estado no cambia nada',
    !registrarEstado({}, { state: 'waiting', receivedAt: 1 }, LLAVE).cambio &&
    !registrarEstado({}, { paneKey: 'x', receivedAt: 1 }, LLAVE).cambio)
}
{
  // El worker entero: los eventos llegan por `orca.events.on`, el estado va a `orcaPanes` y el
  // aviso sale por un wa-scope de mentira que anota con que lo llamaron.
  const dir = herramientas('avisos-orca', [
    '#!/bin/sh',
    'if [ "$1" = "orca-aviso" ]; then printf "%s\\n" "$*" >> "$(dirname "$0")/orca-aviso.txt"; fi',
    "echo '[]'", ''].join('\n'))
  const llamadas = () => existsSync(join(dir, 'orca-aviso.txt'))
    ? readFileSync(join(dir, 'orca-aviso.txt'), 'utf8').trim().split('\n').filter(Boolean) : []
  const orca = hostFalso(dir, { chats: [] })
  const manejadores = {}
  orca.events = { on: (nombre, f) => { manejadores[nombre] = f } }
  const { apagar } = await arranca(orca)
  const emite = (p) => manejadores['agent.status.changed']?.(p)
  const PANEL = 'tab-9:panel-9'
  const base = { paneKey: PANEL, worktreeId: 'repo-a::/srv/ejemplo/alfa-demo', agentType: 'codex' }
  ok('el worker escucha el estado de los agentes', typeof manejadores['agent.status.changed'] === 'function')
  emite({ ...base, state: 'working', receivedAt: Date.now() })
  emite({ ...base, state: 'waiting', receivedAt: Date.now() })
  ok('guarda el estado de cada panel en orcaPanes',
    await hasta(() => orca.store.orcaPanes?.[PANEL]?.state === 'waiting', 8000),
    JSON.stringify(orca.store.orcaPanes))
  await dormir(500)
  ok('con el aviso apagado (de fabrica) no lanza nada', llamadas().length === 0, JSON.stringify(llamadas()))

  orca.store.orcaNotices = { waiting: 'on' }
  emite({ ...base, state: 'working', receivedAt: Date.now() })
  const at = Date.now()
  emite({ ...base, state: 'waiting', receivedAt: at })
  ok('encendido, un panel que pasa a esperar lanza wa-scope orca-aviso',
    await hasta(() => llamadas().length === 1, 8000), JSON.stringify(llamadas()))
  const l = llamadas()[0] || ''
  ok('con el panel, el estado, el momento, el espacio y el tipo de agente, y nada mas',
    l === `orca-aviso --state=waiting --pane=${PANEL} --at=${at} ` +
      '--worktree=repo-a::/srv/ejemplo/alfa-demo --agent=codex --json', l)
  emite({ ...base, state: 'waiting', receivedAt: Date.now() })
  emite({ ...base, state: 'waiting', receivedAt: Date.now() })
  await dormir(800)
  ok('el mismo waiting emitido otra vez no lanza otro aviso', llamadas().length === 1,
    JSON.stringify(llamadas()))
  const atB = Date.now()
  emite({ ...base, paneKey: 'tab-b:panel-b', state: 'blocked', receivedAt: atB })
  ok('blocked: un panel que se bloquea lanza wa-scope orca-aviso con --state=blocked',
    await hasta(() => llamadas().length === 2, 8000) &&
    llamadas()[1] === `orca-aviso --state=blocked --pane=tab-b:panel-b --at=${atB} ` +
      '--worktree=repo-a::/srv/ejemplo/alfa-demo --agent=codex --json', JSON.stringify(llamadas()))
  emite({ ...base, paneKey: 'tab-b:panel-b', state: 'blocked', receivedAt: Date.now() })
  await dormir(800)
  ok('blocked: el mismo blocked otra vez no lanza', llamadas().length === 2, JSON.stringify(llamadas()))
  emite({ paneKey: 'tab-p:panel-p', state: 'waiting', receivedAt: Date.now(),
    worktreeId: 'repo-p::/tmp/ejemplo/orca/plugin-workspaces/ab2web.orca-wa-inbox' })
  await dormir(800)
  ok('un agente del propio plugin (triage, casos) no avisa ni se guarda', llamadas().length === 2 &&
    !('tab-p:panel-p' in (orca.store.orcaPanes || {})), JSON.stringify(llamadas()))
  emite({ ...base, state: 'working', receivedAt: Date.now() })
  emite({ ...base, state: 'done', receivedAt: Date.now() })
  ok('un done despues de trabajar queda terminado para el tick',
    await hasta(() => orca.store.orcaPanes?.[PANEL]?.state === 'done' &&
      orca.store.orcaPanes[PANEL].finished === true, 8000), JSON.stringify(orca.store.orcaPanes))
  ok('el done no lanza nada: lo manda el tick despues de la espera', llamadas().length === 2)
  apagar()

  // Al volver a arrancar, lo guardado manda: un waiting que ya estaba no avisa de nuevo.
  const orca2 = hostFalso(dir, { chats: [], orcaNotices: { waiting: 'on' },
    orcaPanes: { [PANEL]: { state: 'waiting', at: Date.now(), finished: false } } })
  const manejadores2 = {}
  orca2.events = { on: (nombre, f) => { manejadores2[nombre] = f } }
  const otra = await arranca(orca2)
  manejadores2['agent.status.changed']?.({ ...base, state: 'waiting', receivedAt: Date.now() })
  await dormir(800)
  ok('despues de reiniciar, el waiting ya guardado no avisa otra vez', llamadas().length === 2,
    JSON.stringify(llamadas()))
  otra.apagar()
}

rmSync(RAIZ, { recursive: true, force: true })

console.log(`\n${pruebas - fallos}/${pruebas} en verde`)
process.exit(fallos ? 1 : 0)
