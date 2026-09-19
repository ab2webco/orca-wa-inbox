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
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile as execFileNode } from 'node:child_process'

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

const { default: activate, intervaloSync } = await import('../main.mjs')
const { workspaceDir } = await import('../harness.mjs')

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

/** El host, en memoria: responde storage y settings como Orca. */
function hostFalso (toolsDir, store = {}) {
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
        if (action === 'settings.get') return { value: { toolsDir } }
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
    `${antes.replace('## Where the tools are', '## Where the tools are\n\nESTO LO ESCRIBI YO')}\n## Mia\n\nmis notas\n`)
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
  ok('y no se lo pisa la actualizacion', final.includes('ESTO LO ESCRIBI YO'))
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
// ───────── conectar una linea de WhatsApp Web ─────────
// El flujo que el usuario aprieta desde el panel: perfil, pestana, registro, ruta
// encendida. Se recorre entero contra una CLI de Orca falsa porque la de verdad abre
// pestanas en la maquina de quien corra las pruebas — y porque el caso que importa,
// que este Orca no conozca `--worktree floating`, no se puede provocar con la real.
console.log('\nworker: conectar una linea de WhatsApp Web')
{
  const { conectarLinea, dondeVaLaPestana, estadoDeLineas } =
    await import('../web-lines.mjs')

  /** Una CLI de Orca falsa. `flotante` decide si conoce el selector nuevo; cada
   *  llamada queda anotada en un archivo para poder mirar el ORDEN. */
  function orcaFalso (nombre, { flotante = true, fallaTab = false, eval_ = null } = {}) {
    const dir = join(RAIZ, nombre)
    mkdirSync(dir, { recursive: true })
    const bitacora = join(dir, 'llamadas.txt')
    const guion = `#!/usr/bin/env node
const fs = require('fs')
const a = process.argv.slice(2).filter((x) => x !== '--json')
fs.appendFileSync(${JSON.stringify(bitacora)}, a.join(' ') + '\\n')
const ok = (result) => { console.log(JSON.stringify({ ok: true, result })); process.exit(0) }
const no = (code) => { console.log(JSON.stringify({ ok: false, error: { code } })); process.exit(0) }
const cmd = a.join(' ')
if (cmd.startsWith('tab list') && a.includes('floating')) {
  return ${flotante} ? ok({ tabs: [] }) : no('selector_not_found')
}
if (cmd.startsWith('tab list')) {
  return ok({ tabs: [{ browserPageId: 'page-1', url: 'https://web.whatsapp.com/',
    profileId: 'perfil-1', profileLabel: 'Soporte' }] })
}
if (cmd.startsWith('worktree list')) {
  return ok([{ id: 'wt-9', displayName: 'alfred-soporte', lastActivityAt: 9 },
             { id: 'wt-1', displayName: 'otro', lastActivityAt: 1 }])
}
if (cmd.startsWith('tab profile create')) return ok({ profile: { id: 'perfil-1' } })
if (cmd.startsWith('tab profile delete')) return ok({ deleted: true })
if (cmd.startsWith('tab create')) {
  return ${fallaTab} ? no('selector_not_found') : ok({ browserPageId: 'page-1' })
}
if (cmd.startsWith('eval')) return ok({ result: ${JSON.stringify(eval_ ?? '{"linked":false,"qr":true}')} })
no('unsupported')
`
    const exe = join(dir, 'orca')
    writeFileSync(exe, guion, { mode: 0o755 })
    return { exe, llamadas: () => {
      try { return readFileSync(bitacora, 'utf8').trim().split('\n') } catch { return [] }
    } }
  }

  // Un wa-scope falso que solo anota lo que le pidieron: lo que se comprueba aca es el
  // orden de las llamadas, no lo que hace el registro, que tiene su propio chequeo.
  function scopeFalso (nombre) {
    const dir = join(RAIZ, nombre)
    mkdirSync(dir, { recursive: true })
    const bitacora = join(dir, 'scope.txt')
    const exe = join(dir, 'wa-scope')
    writeFileSync(exe, `#!/usr/bin/env node
const fs = require('fs')
fs.appendFileSync(${JSON.stringify(bitacora)}, process.argv.slice(2).join(' ') + '\\n')
console.log(JSON.stringify([{ id: 'web:pending:perfil-1', label: 'Soporte',
  profile: 'perfil-1', kind: 'web', pending: true, enabled: false, authorized_chats: 0 }]))
`, { mode: 0o755 })
    return { exe, llamadas: () => {
      try { return readFileSync(bitacora, 'utf8').trim().split('\n') } catch { return [] }
    } }
  }

  const { execFile } = await import('node:child_process')
  const corre = (cmd, args) => new Promise((res, rej) => {
    execFile(cmd, args, (e, stdout, stderr) =>
      e ? rej(e) : res({ stdout: stdout ?? '', stderr: stderr ?? '' }))
  })

  {
    const o = orcaFalso('orca-flotante', { flotante: true })
    const destino = await dondeVaLaPestana(o.exe, null)
    ok('con soporte, la pestana va al espacio flotante',
      destino.ok && destino.selector === 'floating' && destino.donde === 'flotante',
      JSON.stringify(destino))
  }

  {
    // El caso que importa: este Orca no conoce el selector. La pestana NO puede caer
    // en silencio en cualquier lado — tiene que caer en un proyecto con nombre, para
    // que el panel pueda decir cual y avisar que se cierra con el.
    const o = orcaFalso('orca-viejo', { flotante: false })
    const solo = await dondeVaLaPestana(o.exe, null)
    ok('sin soporte cae en el proyecto de actividad mas reciente, y lo nombra',
      solo.ok && solo.selector === 'id:wt-9' && solo.proyecto === 'alfred-soporte',
      JSON.stringify(solo))
    const mirando = await dondeVaLaPestana(o.exe, { displayName: 'otro' })
    ok('y si el host dice cual esta mirando el usuario, gana ese',
      mirando.ok && mirando.selector === 'id:wt-1' && mirando.proyecto === 'otro',
      JSON.stringify(mirando))
  }

  {
    const o = orcaFalso('orca-conecta', { flotante: true })
    const w = scopeFalso('scope-conecta')
    const r = await conectarLinea({ exe: o.exe, waScope: w.exe, run: corre,
      label: 'Soporte', contextoActivo: null })
    ok('conectar devuelve el perfil y la pestana que creo',
      r.ok && r.profileId === 'perfil-1' && r.pageId === 'page-1', JSON.stringify(r))
    const c = o.llamadas()
    ok('crea el perfil AISLADO: dos sesiones en el mismo perfil se desloguean',
      c.some((l) => l.startsWith('tab profile create') && l.includes('isolated')),
      JSON.stringify(c))
    ok('y abre la pestana en el espacio flotante con ese perfil',
      c.some((l) => l.startsWith('tab create') && l.includes('--worktree floating') &&
        l.includes('perfil-1') && l.includes('web.whatsapp.com')),
      JSON.stringify(c))
    const s = w.llamadas()
    ok('anota la linea contra su perfil antes de encender la ruta',
      s[0] && s[0].startsWith('accounts --connect perfil-1'), JSON.stringify(s))
    ok('y recien despues enciende read_web: encenderlo antes deja a sources() ' +
       'colgado de cualquier pestana abierta',
      s.some((l) => l.startsWith('config read_web on')) &&
      s.findIndex((l) => l.startsWith('config read_web on')) >
      s.findIndex((l) => l.startsWith('accounts --connect')),
      JSON.stringify(s))
  }

  {
    // Si la pestana no se puede abrir, el perfil recien creado no puede quedar
    // colgado: ocuparia un nombre en la lista del navegador del usuario para siempre.
    const o = orcaFalso('orca-sin-tab', { flotante: true, fallaTab: true })
    const w = scopeFalso('scope-sin-tab')
    const r = await conectarLinea({ exe: o.exe, waScope: w.exe, run: corre,
      label: 'Soporte', contextoActivo: null })
    ok('si la pestana falla, conectar falla con motivo', !r.ok && !!r.code,
      JSON.stringify(r))
    ok('y borra el perfil huerfano que acababa de crear',
      o.llamadas().some((l) => l.startsWith('tab profile delete')),
      JSON.stringify(o.llamadas()))
    ok('y no registra ni enciende nada', w.llamadas().length === 0,
      JSON.stringify(w.llamadas()))
  }

  {
    // El estado sale de la SESION, no del registro: la fila dice que la linea existe,
    // no que el telefono siga del otro lado.
    const cuenta = [{ id: 'web:pending:perfil-1', label: 'Soporte', profile: 'perfil-1',
      pending: true, linked_at: null, authorized_chats: 0 }]
    const esperando = await estadoDeLineas(
      orcaFalso('orca-qr', { eval_: '{"linked":false,"qr":true}' }).exe, cuenta)
    ok('con el QR en pantalla la linea esta esperando el escaneo',
      esperando[0].state === 'esperando', JSON.stringify(esperando))

    const linked = await estadoDeLineas(
      orcaFalso('orca-lid', { eval_: '{"linked":true,"lid":"57300"}' }).exe, cuenta)
    ok('con lid la linea esta enlazada, y trae la identidad que reporto la sesion',
      linked[0].state === 'enlazada' && linked[0].lid === '57300', JSON.stringify(linked))

    // Una sesion que YA estuvo enlazada y ahora muestra el QR no es una que espera:
    // es una que se cayo, y el mensaje del usuario es otro.
    const caida = await estadoDeLineas(
      orcaFalso('orca-caida', { eval_: '{"linked":false,"qr":true}' }).exe,
      [{ ...cuenta[0], pending: false, linked_at: '2026-09-18 10:00' }])
    ok('una sesion que ya estuvo enlazada y muestra el QR se cayo, no espera',
      caida[0].state === 'caida', JSON.stringify(caida))

    const sinPestana = await estadoDeLineas(
      orcaFalso('orca-sin-pestana').exe,
      [{ ...cuenta[0], profile: 'otro-perfil' }])
    ok('sin pestana para ese perfil el estado lo dice, y no se inventa una sesion',
      sinPestana[0].state === 'sin-pestana', JSON.stringify(sinPestana))
  }
}

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

// ───────── un pedido del panel que falla DEJA MOTIVO ─────────
// Es el defecto que se reporto: se apretaba "Conectar cuenta", no aparecia ninguna
// fila, no salia ningun error, y el nombre tipeado se perdia. Tres caminos distintos
// se comian el motivo — el `catch` del setInterval, el `show` que solo resondeaba, y
// el sondeo que tres segundos despues pisaba `webLines` con el estado limpio.
console.log('\nworker: un pedido del panel que falla deja motivo')
{
  /** Un wa-scope que contesta el listado vacio, y lo que se le pida romper. */
  function scopeWeb (nombre, { conectaFalla = false } = {}) {
    const dir = join(RAIZ, nombre)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'wa-scope'), `#!/usr/bin/env node
const a = process.argv.slice(2)
if (a.includes('--connect') && ${conectaFalla}) {
  process.stderr.write('sqlite3.OperationalError: database is locked\\n')
  process.exit(1)
}
console.log('[]')
`, { mode: 0o755 })
    // wa-read tiene que existir: al activarse el worker corre el doctor.
    writeFileSync(join(dir, 'wa-read'), '#!/usr/bin/env node\nconsole.log("[]")\n',
      { mode: 0o755 })
    return dir
  }

  /** Deja el pedido en el storage como lo deja el panel, y espera el veredicto. */
  async function pedir (orca, pedido, limiteMs = 20000) {
    const at = new Date().toISOString()
    orca.store.webRequest = { at, ...pedido }
    await hasta(() => orca.store.webStatus && orca.store.webStatus.requestAt === at,
      limiteMs)
    return orca.store.webStatus
  }

  const previo = process.env.ORCA_CLI_COMMAND

  {
    // Sin CLI de Orca no hay con que abrir la pestana. Antes esto escribia el motivo en
    // `webLines` y el sondeo lo borraba en la vuelta siguiente.
    process.env.ORCA_CLI_COMMAND = join(RAIZ, 'no-existe-este-orca')
    const orca = hostFalso(scopeWeb('web-sin-orca'), { chats: [] })
    const apagar = activate(orca)
    const st = await pedir(orca, { action: 'link', label: 'Linea del bot' })
    ok('conectar sin CLI de Orca deja veredicto', !!st, JSON.stringify(orca.store.webStatus))
    ok('y el veredicto dice que fallo', st && st.ok === false, JSON.stringify(st))
    ok('con el motivo en codigo, que el panel traduce',
      st && st.code === 'sin-orca', `code = ${st && st.code}`)
    ok('y dice a que pedido contesta', st && st.action === 'link',
      JSON.stringify(st))
    // Lo que se perdia: el sondeo corre cada 3 s y reescribia `webLines` sin error.
    const antes = JSON.stringify(orca.store.webStatus)
    await new Promise((r) => setTimeout(r, 7000))
    ok('y el motivo sobrevive a dos vueltas del sondeo',
      JSON.stringify(orca.store.webStatus) === antes,
      `quedo ${JSON.stringify(orca.store.webStatus)}`)
    apagar()
  }

  {
    // El camino que se comia el `catch` del setInterval: `run()` rechaza a mitad del
    // enlace y la excepcion salia del worker sin dejar una sola linea escrita.
    process.env.ORCA_CLI_COMMAND = join(RAIZ, 'orca-conecta', 'orca')
    const orca = hostFalso(scopeWeb('web-registro-roto', { conectaFalla: true }),
      { chats: [] })
    const apagar = activate(orca)
    const st = await pedir(orca, { action: 'link', label: 'Linea del bot' })
    ok('un registro que revienta a mitad del enlace deja veredicto', !!st,
      JSON.stringify(orca.store.webStatus))
    ok('y no se lo come el catch del timer', st && st.ok === false, JSON.stringify(st))
    ok('y guarda la causa real, no solo que fallo',
      st && /database is locked/.test(st.detail || ''), `detail = ${st && st.detail}`)
    apagar()
  }

  {
    // Ver una pestana que ya no esta: fallaba y solo resondeaba.
    process.env.ORCA_CLI_COMMAND = join(RAIZ, 'no-existe-este-orca')
    const orca = hostFalso(scopeWeb('web-sin-pestana'), { chats: [] })
    const apagar = activate(orca)
    const st = await pedir(orca, { action: 'show', pageId: 'page-que-no-esta' })
    ok('ver una pestana que no se puede abrir deja veredicto',
      st && st.ok === false && st.action === 'show', JSON.stringify(st))
    apagar()
  }

  {
    // Y un `show` SIN pageId: caia al refresco del final y contestaba ok. El usuario
    // apretaba "Ver la pestana", no se abria nada, y el panel decia que habia salido
    // bien — el callejon que reporto.
    process.env.ORCA_CLI_COMMAND = join(RAIZ, 'no-existe-este-orca')
    const orca = hostFalso(scopeWeb('web-show-sin-page'), { chats: [] })
    const apagar = activate(orca)
    const st = await pedir(orca, { action: 'show', pageId: null })
    ok('un show sin pestana NO contesta ok',
      st && st.ok === false && st.action === 'show', JSON.stringify(st))
    ok('y dice que el motivo es que no hay pestana, para que el panel lo traduzca',
      st && st.code === 'sin-pestana', `code = ${st && st.code}`)
    apagar()
  }

  if (previo === undefined) delete process.env.ORCA_CLI_COMMAND
  else process.env.ORCA_CLI_COMMAND = previo
}

// ───────── una linea conectada no se puede borrar sola ─────────
// El defecto reportado: la fila aparecia "esperando el escaneo" y desaparecia sola, y
// la ruta web volvia a "no" sin que el usuario tocara nada. Tres caminos distintos
// publicaban "no hay ninguna linea" sin que eso fuera cierto — el sondeo corriendo en
// medio de un enlace, una lectura del registro que fallo, y el desvincular que apagaba
// la ruta por esa misma lista vacia.
console.log('\nworker: una linea conectada no se puede borrar sola')
{
  /** Un wa-scope con registro de verdad en un archivo: conecta, lista, olvida. */
  function scopeConRegistro (nombre, { fallaListado = 0, inicial = [] } = {}) {
    const dir = join(RAIZ, nombre)
    mkdirSync(dir, { recursive: true })
    const estado = join(dir, 'registro.json')
    const bitacora = join(dir, 'llamadas.txt')
    writeFileSync(estado, JSON.stringify({ cuentas: inicial, listados: 0 }))
    writeFileSync(join(dir, 'wa-scope'), `#!/usr/bin/env node
const fs = require('fs')
const EST = ${JSON.stringify(estado)}
const a = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(bitacora)}, a.join(' ') + '\\n')
const s = JSON.parse(fs.readFileSync(EST, 'utf8'))
const guardar = () => fs.writeFileSync(EST, JSON.stringify(s))
const arg = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : null }
if (a[0] === 'accounts' && arg('--connect')) {
  const p = arg('--connect')
  // Igual que cuenta_conectar: nace apagada y con id provisional sobre el perfil.
  const fila = { id: 'web:pending:' + p, kind: 'web', label: arg('--label') || p,
    profile: p, enabled: false, pending: true, linked_at: null, authorized_chats: 0 }
  s.cuentas.push(fila); guardar()
  console.log(JSON.stringify([fila])); process.exit(0)
}
if (a[0] === 'accounts' && arg('--forget')) {
  const id = arg('--forget')
  const fila = s.cuentas.find((c) => c.id === id) || null
  s.cuentas = s.cuentas.filter((c) => c.id !== id); guardar()
  console.log(JSON.stringify(fila ? [fila] : [])); process.exit(0)
}
if (a[0] === 'accounts') {
  s.listados += 1; guardar()
  // El listado numero N revienta: es la lectura que falla a mitad de una sesion sana.
  if (${fallaListado} && s.listados === ${fallaListado}) {
    process.stderr.write('sqlite3.OperationalError: database is locked\\n')
    process.exit(1)
  }
  console.log(JSON.stringify(s.cuentas)); process.exit(0)
}
if (a[0] === 'sync') { console.log(JSON.stringify([{ synced: true }])); process.exit(0) }
console.log('[]')
`, { mode: 0o755 })
    writeFileSync(join(dir, 'wa-read'), '#!/usr/bin/env node\nconsole.log("[]")\n',
      { mode: 0o755 })
    return { dir, llamadas: () => {
      try { return readFileSync(bitacora, 'utf8').trim().split('\n') } catch { return [] }
    } }
  }

  /** La CLI de Orca: pestana y perfil en memoria, y `tab create` todo lo lenta que haga falta. */
  function orcaWeb (nombre, { lentoMs = 0 } = {}) {
    const dir = join(RAIZ, nombre)
    mkdirSync(dir, { recursive: true })
    const estado = join(dir, 'tabs.json')
    writeFileSync(estado, JSON.stringify({ tabs: [] }))
    const exe = join(dir, 'orca')
    writeFileSync(exe, `#!/usr/bin/env node
const fs = require('fs')
const EST = ${JSON.stringify(estado)}
const a = process.argv.slice(2)
const s = JSON.parse(fs.readFileSync(EST, 'utf8'))
const ok = (result) => { console.log(JSON.stringify({ ok: true, result })); process.exit(0) }
const arg = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : null }
const cmd = a.join(' ')
if (cmd.startsWith('tab list')) return ok({ tabs: s.tabs })
if (cmd.startsWith('tab profile create')) return ok({ profile: { id: 'perfil-1' } })
if (cmd.startsWith('tab create')) {
  if (${lentoMs}) require('child_process').execSync('sleep ' + (${lentoMs} / 1000))
  const id = 'page-' + (s.tabs.length + 1)
  s.tabs.push({ browserPageId: id, url: arg('--url'), profileId: arg('--profile') })
  fs.writeFileSync(EST, JSON.stringify(s))
  return ok({ browserPageId: id })
}
if (cmd.startsWith('tab close')) {
  s.tabs = s.tabs.filter((t) => t.browserPageId !== arg('--page'))
  fs.writeFileSync(EST, JSON.stringify(s)); return ok({ closed: true })
}
if (cmd.startsWith('tab switch')) return ok({ switched: 1, browserPageId: arg('--page') })
if (cmd.startsWith('tab profile delete')) return ok({ deleted: true })
if (cmd.startsWith('eval')) return ok({ result: '{"linked":false,"qr":true}' })
console.log(JSON.stringify({ ok: false, error: { code: 'unsupported' } }))
`, { mode: 0o755 })
    return exe
  }

  async function pedir (orca, pedido, limiteMs = 30000) {
    const at = new Date().toISOString()
    orca.store.webRequest = { at, ...pedido }
    await hasta(() => orca.store.webStatus && orca.store.webStatus.requestAt === at,
      limiteMs)
    return orca.store.webStatus
  }

  const previo = process.env.ORCA_CLI_COMMAND

  {
    // Lo que se reporto: se aprieta Conectar, el enlace tarda —dos llamadas a la CLI de
    // Orca con 30 s de tope cada una— y el sondeo, que late cada 3 s, lee un registro
    // donde la linea todavia no esta y publica "no conectaste ninguna linea". El panel
    // lo pinta encima del enlace en curso. Control: si el sondeo vuelve a poder
    // publicar durante un pedido, aca aparece una lista vacia.
    process.env.ORCA_CLI_COMMAND = orcaWeb('orca-lento', { lentoMs: 9000 })
    const reg = scopeConRegistro('reg-lento')
    const orca = hostFalso(reg.dir, { chats: [] })
    const apagar = activate(orca)
    const vacios = []
    const mirando = setInterval(() => {
      const wl = orca.store.webLines
      if (wl && Array.isArray(wl.lines) && !wl.lines.length && !wl.error) vacios.push(wl)
    }, 200)
    const st = await pedir(orca, { action: 'link', label: 'NoVa' }, 60000)
    clearInterval(mirando)
    ok('el enlace lento termina bien', st && st.ok === true, JSON.stringify(st))
    ok('y el sondeo NO publica "no hay ninguna linea" mientras el enlace corre',
      vacios.length === 0, `${vacios.length} vueltas con la lista vacia`)
    ok('la fila pendiente queda publicada',
      orca.store.webLines && orca.store.webLines.lines.length === 1 &&
      orca.store.webLines.lines[0].state === 'esperando',
      JSON.stringify(orca.store.webLines))
    // Donde se abrio la pestana: lo sabe solo quien la abrio, y el sondeo pisa esa
    // clave cada 3 s. Duraba tres segundos y desaparecia justo cuando el usuario
    // buscaba el QR. Control: sin arrastrarlo, aca queda sin placement.
    ok('y dice donde quedo la pestana apenas termina',
      orca.store.webLines.placement === 'flotante',
      JSON.stringify(orca.store.webLines))
    await new Promise((r) => setTimeout(r, 7000))
    ok('y lo sigue diciendo dos vueltas del sondeo despues, con la linea esperando',
      orca.store.webLines.placement === 'flotante' &&
      orca.store.webLines.lines[0].state === 'esperando',
      JSON.stringify(orca.store.webLines))
    apagar()
  }

  {
    // Una lectura del registro que falla NO es "no hay lineas". Publicarla vacia le
    // dice al usuario que perdio la linea que acaba de conectar.
    process.env.ORCA_CLI_COMMAND = orcaWeb('orca-lectura')
    const reg = scopeConRegistro('reg-lectura', { fallaListado: 3 })
    const orca = hostFalso(reg.dir, { chats: [] })
    const apagar = activate(orca)
    await pedir(orca, { action: 'link', label: 'NoVa' })
    const conFila = JSON.parse(JSON.stringify(orca.store.webLines))
    await hasta(() => orca.store.webLines && orca.store.webLines.error === 'sin-registro',
      20000)
    const roto = orca.store.webLines
    ok('una lectura fallida del registro se anuncia como tal',
      roto && roto.error === 'sin-registro', JSON.stringify(roto))
    ok('y NO borra la fila que ya estaba: no hay lectura que desconecte una linea',
      roto && Array.isArray(roto.lines) && roto.lines.length === 1 &&
      roto.lines[0].label === 'NoVa',
      `${JSON.stringify(roto)} — antes ${JSON.stringify(conFila.lines)}`)
    apagar()
  }

  {
    // Desvincular una de dos lineas con el registro mudo: "no quedan lineas" era una
    // lista vacia que en realidad queria decir "no pude leer". Apagaba read_web y
    // dejaba sin fuente a la linea sana que nadie toco.
    process.env.ORCA_CLI_COMMAND = orcaWeb('orca-desv')
    const reg = scopeConRegistro('reg-desv', {
      // La PRIMERA lectura tras el olvido es la que decide si se apaga la ruta.
      fallaListado: 1,
      inicial: [{ id: 'web:1', kind: 'web', label: 'NoVa', profile: 'p1', enabled: true,
        pending: false, linked_at: '2026-09-18 10:00', authorized_chats: 2 },
      { id: 'web:2', kind: 'web', label: 'Otra', profile: 'p2', enabled: true,
        pending: false, linked_at: '2026-09-18 10:00', authorized_chats: 0 }]
    })
    const orca = hostFalso(reg.dir, { chats: [], readWeb: 'on' })
    const apagar = activate(orca)
    await pedir(orca, { action: 'unlink', id: 'web:2', profile: 'p2' })
    ok('con el registro mudo, desvincular NO apaga la ruta web',
      !reg.llamadas().some((l) => l.startsWith('config read_web off')),
      JSON.stringify(reg.llamadas()))
    ok('y el panel sigue viendo la ruta encendida', orca.store.readWeb === 'on',
      `readWeb = ${orca.store.readWeb}`)
    apagar()
  }

  if (previo === undefined) delete process.env.ORCA_CLI_COMMAND
  else process.env.ORCA_CLI_COMMAND = previo
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

rmSync(RAIZ, { recursive: true, force: true })
console.log(`\n${pruebas - fallos}/${pruebas} en verde`)
process.exit(fallos ? 1 : 0)
