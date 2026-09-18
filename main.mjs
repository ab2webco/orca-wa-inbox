/**
 * WhatsApp Inbox — worker del plugin.
 *
 * Corre en el worker out-of-process de Orca (Node plano, sin Electron). Es el unico
 * lado del plugin que puede tocar disco, asi que aca vive todo lo que necesita leer
 * la base de WhatsApp o persistir el registro.
 *
 * No reimplementa la lectura de WhatsApp: delega en los CLIs (`wa-read`, `wa-scope`,
 * `wa-send`), que ya resuelven el WAL, el epoch de Core Data y la resolucion de LIDs.
 * Duplicar esa logica aca seria tener dos verdades que se desincronizan.
 */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Las herramientas viajan dentro del plugin. Antes se buscaban en el PATH del usuario,
// lo que solo funcionaba en la maquina donde alguien las habia enlazado a mano.
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const TOOLS = join(PLUGIN_DIR, 'bin')
const SCOPE_KEY = 'scope'          // { [chatJid]: ScopeEntry }
// Como le fue al ultimo sync. El panel no puede ejecutar nada, asi que sin esto no
// tiene forma de distinguir "todavia buscando" de "fallo hace media hora".
const STATUS_KEY = 'syncStatus'
// La via de vuelta: el panel deja aca un pedido de sync y el worker lo atiende. Es el
// mismo camino que usan Tomar/Ignorar con `decisions`.
const REQUEST_KEY = 'syncRequest'
const CHATS_KEY = 'chats'
const MODES = ['off', 'observar', 'borrador', 'responder']

/** El nombre del agente lo define quien usa el plugin. No viene con uno puesto. */
const DEFAULT_SETTINGS = { agentName: '', signMessages: true, toolsDir: TOOLS }

/** Corre `wa-read doctor` y avisa por notificacion si algo falta. */
async function checkSystem(orca, toolsDir = TOOLS) {
  const result = await run(join(toolsDir, 'wa-read'), ['doctor', '--json'],
    { timeoutMs: 30000 }).catch(() => null)
  let checks = []
  try {
    checks = JSON.parse(result?.stdout || '[]')
  } catch {
    checks = []
  }
  const failed = checks.filter((c) => !c.ok)
  if (!checks.length) {
    await orca.host.call('notifications.show', {
      title: 'No pude verificar el sistema',
      body: `No pude correr las herramientas del plugin. Revisa que ${toolsDir} sea ejecutable.`
    }).catch(() => {})
    return
  }
  if (!failed.length) return

  // El primer chequeo es si el sistema esta soportado; distinguirlo de "falta instalar
  // WhatsApp" importa, porque uno se arregla y el otro no.
  const unsupported = failed.some((c) => /sistema|system/i.test(c.check))
  await orca.host.call('notifications.show', {
    title: unsupported
      ? 'WhatsApp Inbox no puede leer en este sistema'
      : 'WhatsApp Inbox necesita algo mas',
    body: unsupported
      ? 'La lectura de WhatsApp solo esta verificada en macOS con WhatsApp Desktop. ' +
        'El resto del plugin funciona; las automatizaciones no van a correr.'
      : `${failed[0].check}: ${failed[0].detalle}. Abri los ajustes del plugin para ver el detalle.`
  }).catch(() => {})
  orca.log(`chequeo: faltan ${failed.map((c) => c.check).join(', ')}`)
}

/** La linea de stderr que sirve. En un traceback de Python la primera es el
 *  encabezado y lo util es la ultima; en todo lo demas la primera es el mensaje. */
function lineaUtil(stderr) {
  const lineas = String(stderr ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  if (!lineas.length) return ''
  return /^Traceback/.test(lineas[0]) ? lineas[lineas.length - 1] : lineas[0]
}

function run(cmd, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // wa-scope check sale con 3 cuando deniega: es una respuesta, no una falla.
        if (error && error.code !== 3) {
          // El motivo tiene que sobrevivir al reject: "no pude leer WhatsApp" sin la
          // causa deja al usuario en el mismo callejon que el spinner eterno.
          const fallo = new Error(lineaUtil(stderr) || error.message)
          // execFile pone un string ('ENOENT') cuando ni arranco y un numero cuando
          // arranco y salio mal. Son dos problemas distintos y se cuentan distinto.
          fallo.spawnCode = typeof error.code === 'string' ? error.code : null
          fallo.exitCode = typeof error.code === 'number' ? error.code : null
          fallo.timedOut = !!error.killed
          reject(fallo)
          return
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: error?.code ?? 0 })
      })
  })
}

async function runJson(cmd, args) {
  const { stdout, code } = await run(cmd, args)
  try {
    return { code, data: JSON.parse(stdout || 'null') }
  } catch {
    throw new Error(`${cmd} no devolvio JSON: ${stdout.slice(0, 200)}`)
  }
}

const SYNC_MS = 5 * 60 * 1000
const SYNC_TIMEOUT_MS = 120000
// Un pedido del panel no puede esperar al ciclo de 5 minutos: nadie aprieta un boton
// y se queda mirando cinco minutos.
const PETICION_MS = 3 * 1000
// Un pedido viejo es de una sesion anterior: atenderlo seria leer WhatsApp porque
// alguien apreto un boton ayer.
const PETICION_TTL_MS = 10 * 60 * 1000

/** El motivo, en codigo corto. Las frases las arma el panel: el worker no sabe en
 *  que idioma esta el usuario, y una frase en el storage se congela en ese idioma. */
function motivoDe(error) {
  if (error?.spawnCode === 'ENOENT') return 'sin-herramientas'
  if (error?.spawnCode === 'EACCES' || error?.spawnCode === 'EPERM') return 'sin-permiso'
  if (error?.timedOut) return 'demoro'
  return 'fallo'
}

async function leer(orca, key) {
  const stored = await orca.host.call('storage.get', { key }).catch(() => null)
  return stored?.value ?? null
}

function guardar(orca, key, value) {
  return orca.host.call('storage.set', { key, value }).catch(() => {})
}

// Dos syncs a la vez leerian la misma base dos veces y se pisarian el estado.
let sincronizando = false

/** Deja el panel al dia y deja escrito como le fue. Lo hace el worker porque el panel
 *  no puede ejecutar nada: solo sabe leer y escribir storage. Sin esto el panel abria
 *  diciendo "corre este comando", que en una interfaz no es una instruccion, es un
 *  callejon; y cuando el sync fallaba callado, el callejon era el spinner eterno. */
async function sync(orca, { toolsDir = TOOLS, trigger = 'timer' } = {}) {
  if (sincronizando) return false
  sincronizando = true
  // Se anota el intento ANTES de arrancar: "nadie lo intento" y "esta corriendo" son
  // dos mensajes distintos, y el panel solo puede distinguirlos si el worker lo dice.
  await guardar(orca, STATUS_KEY, {
    running: true, startedAt: new Date().toISOString(), trigger
  })
  let estado
  try {
    const { stdout } = await run(join(toolsDir, 'wa-scope'), ['sync', '--json'],
      { timeoutMs: SYNC_TIMEOUT_MS })
    let escrito = false
    try {
      const filas = JSON.parse(stdout || 'null')
      escrito = !!(Array.isArray(filas) ? filas[0]?.synced : filas?.synced)
    } catch {
      escrito = false
    }
    const chats = await leer(orca, CHATS_KEY)
    estado = {
      ok: escrito,
      at: new Date().toISOString(),
      chats: Array.isArray(chats) ? chats.length : 0,
      reason: escrito ? null : 'sin-registro',
      detail: escrito ? '' : String(stdout ?? '').trim().slice(0, 200),
      exitCode: null,
      trigger
    }
  } catch (error) {
    estado = {
      ok: false,
      at: new Date().toISOString(),
      chats: 0,
      reason: motivoDe(error),
      detail: String(error?.message ?? '').slice(0, 300),
      exitCode: error?.exitCode ?? null,
      trigger
    }
    orca.log(`sync fallo (${estado.reason}, code ${estado.exitCode}): ${estado.detail}`)
  } finally {
    sincronizando = false
  }
  await guardar(orca, STATUS_KEY, estado)
  return estado.ok
}

export default function activate(orca) {
  const dirHerramientas = async () => (await settings()).toolsDir || TOOLS

  // El sync automatico sale del mismo directorio que los comandos. Antes iba fijo a
  // bin/: quien movia toolsDir tenia la mitad del plugin leyendo de otro lado.
  const sincronizar = async (trigger) =>
    sync(orca, { toolsDir: await dirHerramientas(), trigger })

  // Al activarse, lo primero es decir si este sistema puede leer WhatsApp. Si no puede,
  // el usuario se tiene que enterar ahora y no cuando una automatizacion lleve una
  // semana sin correr sin explicar por que.
  dirHerramientas().then((dir) => checkSystem(orca, dir))
    .catch((error) => orca.log(`chequeo inicial fallo: ${error.message}`))

  // Y traer las conversaciones ya: en una instalacion nueva el panel arranca vacio y
  // el usuario no tiene de donde sacarlas.
  sincronizar('activate').catch(() => {})
  const syncTimer = setInterval(() => { sincronizar('timer').catch(() => {}) }, SYNC_MS)
  if (typeof syncTimer.unref === 'function') syncTimer.unref()

  // El boton del panel escribe un pedido; esto lo atiende. Se mira cada pocos segundos
  // y no en el ciclo de 5 minutos porque un boton que tarda cinco minutos en hacer
  // algo se lee como un boton roto.
  let ultimoPedido = null
  async function atenderPedido() {
    const pedido = await leer(orca, REQUEST_KEY)
    if (!pedido || typeof pedido !== 'object' || typeof pedido.at !== 'string') return
    if (pedido.at === ultimoPedido) return
    ultimoPedido = pedido.at
    // Se borra antes de sincronizar: un clic tiene que causar un sync, no una cadena
    // de syncs si la lectura tarda mas que el proximo vistazo.
    await guardar(orca, REQUEST_KEY, null)
    const edad = Date.now() - Date.parse(pedido.at)
    if (!(edad >= 0) || edad > PETICION_TTL_MS) return
    await sincronizar('peticion')
  }
  const pedidoTimer = setInterval(() => { atenderPedido().catch(() => {}) }, PETICION_MS)
  if (typeof pedidoTimer.unref === 'function') pedidoTimer.unref()

  const tool = async (name) => join(await dirHerramientas(), name)

  async function settings() {
    const stored = await orca.host.call('settings.get', { key: 'config' }).catch(() => null)
    return { ...DEFAULT_SETTINGS, ...(stored?.value ?? {}) }
  }

  async function scope() {
    const stored = await orca.host.call('storage.get', { key: SCOPE_KEY }).catch(() => null)
    return stored?.value && typeof stored.value === 'object' ? stored.value : {}
  }

  async function saveScope(next) {
    await orca.host.call('storage.set', { key: SCOPE_KEY, value: next })
    return next
  }

  /** Conversaciones de WhatsApp, ya cruzadas con lo que el usuario mapeo. */
  orca.commands.register('wa-inbox.sync', async (args) => {
    const { data } = await runJson(await tool('wa-read'),
      ['chats', '-n', String(args?.limit ?? 200), '--json'])
    const mapped = await scope()
    return (data ?? []).map((chat) => ({
      ...chat,
      scope: mapped[chat.jid] ?? { mode: 'off', planeProject: null }
    }))
  })

  orca.commands.register('wa-inbox.scope.list', async () => {
    const mapped = await scope()
    return Object.entries(mapped).map(([jid, value]) => ({ chatJid: jid, ...value }))
  })

  /**
   * Un chat activo exige proyecto de Plane: sin el, el agente no sabria donde abrir
   * el issue, y adivinar el proyecto es peor que no actuar.
   */
  orca.commands.register('wa-inbox.scope.set', async (args) => {
    const { chatJid, chatName, planeProject, mode = 'off', initialState, hours } = args ?? {}
    if (!chatJid) throw new Error('falta chatJid')
    if (!MODES.includes(mode)) throw new Error(`modo invalido: ${mode}`)
    if (mode !== 'off' && !planeProject) {
      throw new Error('un chat activo necesita planeProject')
    }
    const next = await scope()
    if (mode === 'off' && !planeProject) {
      delete next[chatJid]
    } else {
      next[chatJid] = {
        chatName: chatName ?? next[chatJid]?.chatName ?? chatJid,
        planeProject: planeProject ?? next[chatJid]?.planeProject ?? null,
        mode,
        initialState: initialState ?? next[chatJid]?.initialState ?? null,
        hours: hours ?? next[chatJid]?.hours ?? 'L-V 08:00-18:00',
        updatedAt: new Date().toISOString()
      }
    }
    await saveScope(next)
    // El registro del CLI es la fuente que leen las automations; mantenerlos alineados.
    if (next[chatJid]) {
      await run(await tool('wa-scope'), ['set', chatJid,
        '--project', String(next[chatJid].planeProject ?? ''),
        '--mode', mode]).catch((error) => orca.log(`wa-scope set fallo: ${error.message}`))
    }
    return next[chatJid] ?? { chatJid, mode: 'off' }
  })

  /** Mensajes dirigidos al usuario, filtrados a los chats que el mismo autorizo. */
  orca.commands.register('wa-inbox.inbox', async (args) => {
    const { data } = await runJson(await tool('wa-read'),
      ['inbox', '--days', String(args?.days ?? 1), '--json'])
    const mapped = await scope()
    const rows = (data ?? []).filter((m) => (mapped[m.chat_jid]?.mode ?? 'off') !== 'off')
    if (rows.length && args?.notify !== false) {
      const s = await settings()
      await orca.host.call('notifications.show', {
        title: s.agentName ? `${s.agentName}: ${rows.length} pendientes`
                           : `${rows.length} mensajes te mencionan`,
        body: rows.slice(0, 3).map((r) => `${r.chat}: ${r.text}`.slice(0, 90)).join('\n')
      }).catch(() => {})
    }
    return rows
  })

  /** Preflight: que el usuario sepa que le falta antes de depender de esto. */
  orca.commands.register('wa-inbox.doctor', async () => {
    if (process.platform !== 'darwin') {
      return {
        ok: false,
        checks: [{ check: 'sistema operativo', ok: false, detalle: process.platform }],
        nota: 'Solo macOS. WhatsApp Web no deja base local y en Windows la base esta ' +
              'en otro formato, sin verificar.'
      }
    }
    const { data } = await runJson(await tool('wa-read'), ['doctor', '--json'])
      .catch(() => ({ data: null }))
    return { ok: !!data && data.every((c) => c.ok), checks: data ?? [] }
  })

  orca.commands.register('wa-inbox.settings', async (args) => {
    if (!args || args.read) return settings()
    const next = { ...(await settings()), ...args }
    await orca.host.call('settings.set', { key: 'config', value: next })
    return next
  })

  orca.events.on('agent.status.changed', (payload) => {
    orca.log(`agente ${payload.state} en ${payload.worktreeId ?? 'sin worktree'}`)
  })

  // Al desactivar el plugin los timers se van con el: si no, siguen leyendo WhatsApp
  // despues de que el usuario dijo que no.
  return () => { clearInterval(syncTimer); clearInterval(pedidoTimer) }
}
