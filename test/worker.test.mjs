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
 * Nada de esto toca WhatsApp ni la base del usuario: las herramientas son guiones
 * falsos en un directorio temporal y el host es un objeto en memoria.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import activate from '../main.mjs'

let fallos = 0
let pruebas = 0

function ok (nombre, condicion, detalle = '') {
  pruebas += 1
  if (condicion) return console.log(`  ok    ${nombre}`)
  fallos += 1
  console.log(`  FALLA ${nombre}${detalle ? ` — ${detalle}` : ''}`)
}

const RAIZ = mkdtempSync(join(tmpdir(), 'wa-inbox-worker-'))

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

rmSync(RAIZ, { recursive: true, force: true })
console.log(`\n${pruebas - fallos}/${pruebas} en verde`)
process.exit(fallos ? 1 : 0)
