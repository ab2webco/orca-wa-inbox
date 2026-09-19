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

import { HARNESS_KEY } from './harness.mjs'
import {
  conectarLinea, estadoDeLineas, identificarLinea, olvidarLinea, reabrirPestana,
  verPestana
} from './web-lines.mjs'

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
// Las lineas de WhatsApp Web: el panel deja el pedido en una clave y lee el estado en
// la otra. Misma via que el sync — un panel no puede ejecutar nada, y enlazar una linea
// es justamente ejecutar cuatro comandos.
const WEB_REQUEST_KEY = 'webRequest'
const WEB_LINES_KEY = 'webLines'
// Como le fue a lo ULTIMO que pidio el panel, en su propia clave. Vivia dentro de
// `webLines`, que el sondeo reescribe cada pocos segundos: el motivo de un fallo
// duraba lo que tardaba la siguiente vuelta y el usuario no llegaba a verlo nunca.
// Aca no lo pisa nadie hasta el proximo pedido.
const WEB_STATUS_KEY = 'webStatus'
const MODES = ['off', 'observar', 'borrador', 'responder']

/** El nombre del agente lo define quien usa el plugin. No viene con uno puesto. */
const DEFAULT_SETTINGS = { agentName: '', signMessages: true, toolsDir: TOOLS }

/** Corre `wa-read doctor` y avisa por notificacion si algo falta. */
async function checkSystem(orca, toolsDir = TOOLS) {
  // El motivo se conserva: "no pude comprobar el sistema" sin la causa deja al usuario
  // en el mismo callejon que el spinner eterno.
  let porque = ''
  const result = await run(join(toolsDir, 'wa-read'), ['doctor', '--json'],
    { timeoutMs: 30000 }).catch((error) => {
      porque = String(error?.message ?? error).slice(0, 200)
      return null
    })
  let checks = []
  try {
    checks = JSON.parse(result?.stdout || '[]')
  } catch (error) {
    porque = porque || `doctor returned no JSON: ${String(result?.stdout).slice(0, 120)}`
    checks = []
  }
  // Solo lo REQUERIDO avisa. Lo opcional siempre tiene algo apagado — la segunda
  // linea, por ejemplo — y avisarlo pondria una notificacion en cada arranque de una
  // maquina que lee perfecto, que es la manera mas rapida de que dejen de leerse.
  const failed = checks.filter((c) => !c.ok && c.requerido !== false)
  if (!checks.length) {
    await orca.host.call('notifications.show', {
      title: 'Could not check the system',
      body: `Could not run the plugin tools. Check that ${toolsDir} is executable.` +
        (porque ? ` ${porque}` : '')
    }).catch((error) => orca.log(`notification failed: ${error.message}`))
    orca.log(`check: the tools did not answer${porque ? ` — ${porque}` : ''}`)
    return
  }
  if (!failed.length) return

  // El primer chequeo es si hay base local en este sistema; distinguirlo de "falta
  // instalar WhatsApp" importa, porque uno se arregla y el otro no. Se mira el codigo y
  // no el nombre: el nombre es texto para leer y se puede reescribir, el codigo es el
  // contrato. Si llega aca es que la via web tampoco esta contestando — cuando contesta,
  // los chequeos de la base local vienen con requerido en false y no se cuentan.
  const unsupported = failed.some((c) => c.code === 'system')
  await orca.host.call('notifications.show', {
    // El worker no tiene forma de saber en que idioma esta el usuario — el host no se
    // lo dice y no hay navigator aca — asi que una notificacion no se puede traducir.
    // Va en ingles, como todo lo que no puede llevar traduccion; el detalle esta a un
    // clic, en el panel, que si esta en su idioma.
    title: unsupported
      ? 'WhatsApp Inbox has no read source on this system'
      : 'WhatsApp Inbox needs something else',
    body: unsupported
      ? 'There is no local WhatsApp database here — that route is only verified on ' +
        'macOS. A WhatsApp Web session is the route that applies, and it reads the ' +
        'chat list, the line identity and the inbox. Connect a line in the plugin ' +
        'settings.'
      : 'Open the plugin settings to see what is missing.'
  }).catch((error) => orca.log(`notification failed: ${error.message}`))
  orca.log(`check: missing ${failed.map((c) => c.code || c.check).join(', ')}`)
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
    throw new Error(`${cmd} returned no JSON: ${stdout.slice(0, 200)}`)
  }
}

// El sync es el UNICO momento en que se abre la base de WhatsApp, asi que este
// intervalo es tambien el peor caso para que un mensaje nuevo se vea: el precheck de
// las automations contesta con lo que dejo el ultimo sync. Por eso no es una constante
// escondida — se lee de `syncMinutes`, que el panel muestra y deja cambiar.
const SYNC_MS = 5 * 60 * 1000
// Cotas. Por debajo de un minuto el sync seria el problema que vino a arreglar: una
// lectura de 260 MB por minuto. Por encima de una hora el precheck se queda sin datos
// frescos de los que hablar y empieza a salir bloqueado.
const SYNC_MIN_MS = 60 * 1000
const SYNC_MAX_MS = 60 * 60 * 1000
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

/** Cada cuanto releer WhatsApp, segun lo que el usuario dejo puesto. */
export async function intervaloSync(orca) {
  const minutos = parseInt(String((await leer(orca, 'syncMinutes')) ?? ''), 10)
  if (!Number.isFinite(minutos) || minutos <= 0) return SYNC_MS
  return Math.min(SYNC_MAX_MS, Math.max(SYNC_MIN_MS, minutos * 60000))
}

// El storage es el UNICO canal con el panel. Tragarse un fallo aca deja al panel
// mostrando lo de hace media hora sin nada que lo delate, asi que el motivo va al log
// del plugin aunque la funcion siga devolviendo un valor utilizable.
async function leer(orca, key) {
  const stored = await orca.host.call('storage.get', { key })
    .catch((error) => {
      orca.log(`storage.get ${key} failed: ${error.message}`)
      return null
    })
  return stored?.value ?? null
}

function guardar(orca, key, value) {
  return orca.host.call('storage.set', { key, value })
    .catch((error) => orca.log(`storage.set ${key} failed: ${error.message}`))
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
    orca.log(`sync failed (${estado.reason}, code ${estado.exitCode}): ${estado.detail}`)
  } finally {
    sincronizando = false
  }
  await guardar(orca, STATUS_KEY, estado)
  return estado.ok
}

/** El binario de la CLI de Orca, que en Linux NO se llama `orca`: ahi ese nombre es el
 *  lector de pantalla de GNOME. Misma regla que wa-read. */
function orcaCli() {
  const declarado = String(process.env.ORCA_CLI_COMMAND ?? '').trim()
  if (declarado) return declarado.split(' ')[0]
  return process.platform === 'linux' ? 'orca-ide' : 'orca'
}

/** Las lineas registradas, tal como las ve el registro. */
async function cuentasWeb(waScope) {
  const { stdout } = await run(waScope, ['accounts', '--json'])
  let filas
  try {
    filas = JSON.parse(stdout || '[]')
  } catch {
    // Leerlo como "no hay lineas" es peor que fallar: con cero lineas el camino de
    // desconectar apaga la via web, o sea que un registro ilegible terminaba apagando
    // la lectura del usuario sin decir nada.
    throw new Error(`wa-scope accounts returned no JSON: ${String(stdout).slice(0, 200)}`)
  }
  return (Array.isArray(filas) ? filas : []).filter((c) => c.kind === 'web')
}

// Mientras una linea no este enlazada, el estado tiene que seguir a la realidad sin que
// el usuario haga nada: escanear el QR y que el panel siga diciendo "esperando" es el
// mismo callejon que el spinner eterno. Enlazadas, se mira de tanto en tanto.
const WEB_SONDEO_RAPIDO_MS = 3 * 1000
const WEB_SONDEO_LENTO_MS = 60 * 1000
// Sin ninguna linea conectada no hay nada que sondear, y la inmensa mayoria de las
// instalaciones estan asi: mirar cada minuto seria un proceso por minuto para nada.
const WEB_SONDEO_OCIOSO_MS = 5 * 60 * 1000

/** Deja escrito el estado real de cada linea, y asciende la que ya termino de escanear.
 *
 *  Devuelve las lineas, o `null` cuando el registro no se pudo leer. Son dos respuestas
 *  distintas y antes eran la misma —lista vacia—: el que desvincula apagaba la ruta web
 *  porque "no quedan lineas", cuando lo unico que habia pasado es que wa-scope no
 *  contesto. Una lectura fallida no puede deshacer lo que el usuario acaba de conectar. */
async function refrescarLineas(orca, waScope, { motivo = 'timer' } = {}) {
  const exe = orcaCli()
  const previo = (await leer(orca, WEB_LINES_KEY)) ?? {}
  // Donde quedo la pestana lo sabe SOLO quien la abrio, y el sondeo pisa esta clave
  // cada tres segundos: sin arrastrarlo, la frase que dice donde buscar el QR vivia
  // esos tres segundos y desaparecia justo cuando el usuario la iba a leer.
  const lugar = previo.placement
    ? { placement: previo.placement, project: previo.project ?? null }
    : {}
  let cuentas = []
  try {
    cuentas = await cuentasWeb(waScope)
  } catch (error) {
    // Las filas de antes se quedan: publicar una lista vacia por una lectura que fallo
    // le dice al usuario que no tiene ninguna linea, que es exactamente lo contrario.
    await guardar(orca, WEB_LINES_KEY, { ...lugar, at: new Date().toISOString(),
      lines: Array.isArray(previo.lines) ? previo.lines : [],
      error: 'sin-registro', detail: String(error?.message ?? '').slice(0, 200) })
    return null
  }
  if (!cuentas.length) {
    await guardar(orca, WEB_LINES_KEY,
      { at: new Date().toISOString(), lines: [], motivo })
    return []
  }
  const lineas = await estadoDeLineas(exe, cuentas)
  // La identidad la pone la SESION. Aca es el unico momento en que se conoce: la fila
  // nacio con un id provisional sobre el perfil y recien ahora hay lid que ponerle.
  let sinIdentidad = null
  for (const linea of lineas) {
    if (!linea.pending || linea.state !== 'enlazada' || !linea.lid) continue
    try {
      const fila = await identificarLinea({ waScope, run, id: linea.id, lid: linea.lid })
      if (fila) {
        linea.id = fila.id
        linea.pending = false
        linea.linkedAt = fila.linked_at || linea.linkedAt
      }
    } catch (error) {
      // La sesion esta enlazada de verdad y el registro no la pudo ascender. Sin esto
      // la fila se quedaba en "esperando el escaneo" para siempre y sin motivo.
      sinIdentidad = String(error?.message ?? error).slice(0, 200)
      orca.log(`web line identify failed: ${sinIdentidad}`)
    }
  }
  await guardar(orca, WEB_LINES_KEY, {
    ...lugar, at: new Date().toISOString(), lines: lineas, motivo,
    ...(sinIdentidad ? { error: 'sin-identidad', detail: sinIdentidad } : {})
  })
  return lineas
}

/** Como le fue al pedido, en la clave que el sondeo no toca. El panel lo empareja por
 *  `requestAt`: sin eso no podria distinguir la respuesta a SU clic de la anterior. */
function veredicto(orca, pedido, extra) {
  return guardar(orca, WEB_STATUS_KEY, {
    at: new Date().toISOString(), requestAt: pedido?.at ?? null,
    action: pedido?.action ?? null, ...extra
  })
}

/** Atiende lo que el panel pidio sobre las lineas web.
 *
 *  Todas las salidas dejan veredicto. Antes varias no dejaban ninguna — ver una pestana
 *  que no existe, o un `run` que rechazaba a mitad del enlace — y el usuario se quedaba
 *  con el campo vacio, sin fila y sin motivo. */
async function atenderWeb(orca, waScope, pedido, contexto) {
  const exe = orcaCli()
  const fin = (extra) => guardar(orca, WEB_LINES_KEY, extra)
  if (pedido.action === 'link') {
    const label = String(pedido.label || '').trim() || 'WhatsApp Web'
    const r = await conectarLinea({ exe, waScope, run, label, contextoActivo: contexto })
    if (!r.ok) {
      await veredicto(orca, pedido, { ok: false, code: r.code, detail: String(r.detail || '').slice(0, 300) })
      await fin({ at: new Date().toISOString(), lines: [], error: r.code,
        detail: String(r.detail || '').slice(0, 200) })
      return
    }
    await guardar(orca, 'readWeb', 'on')
    await refrescarLineas(orca, waScope, { motivo: 'link' })
    const previo = (await leer(orca, WEB_LINES_KEY)) ?? {}
    await fin({ ...previo, placement: r.donde, project: r.proyecto || null })
    await veredicto(orca, pedido, { ok: true, placement: r.donde,
      project: r.proyecto || null })
    return
  }
  if (pedido.action === 'show' && pedido.pageId) {
    const r = await verPestana(exe, pedido.pageId)
    // Fallaba callado: se resondeaba y nada mas. Un boton que no hace nada y no dice
    // por que es el mismo callejon que el spinner eterno.
    await veredicto(orca, pedido, r.ok ? { ok: true }
      : { ok: false, code: r.code, detail: String(r.detail || '').slice(0, 300) })
    if (!r.ok) await refrescarLineas(orca, waScope, { motivo: 'show' })
    return
  }
  if (pedido.action === 'reopen' && pedido.profile) {
    const r = await reabrirPestana({ exe, profile: pedido.profile, contextoActivo: contexto })
    const previo = (await leer(orca, WEB_LINES_KEY)) ?? {}
    if (!r.ok) {
      await veredicto(orca, pedido, { ok: false, code: r.code, detail: String(r.detail || '').slice(0, 300) })
      await fin({ ...previo, error: r.code, detail: String(r.detail || '').slice(0, 200) })
      return
    }
    await refrescarLineas(orca, waScope, { motivo: 'reopen' })
    const ahora = (await leer(orca, WEB_LINES_KEY)) ?? {}
    await fin({ ...ahora, placement: r.donde, project: r.proyecto || null })
    await veredicto(orca, pedido, { ok: true, placement: r.donde,
      project: r.proyecto || null })
    return
  }
  if (pedido.action === 'unlink' && pedido.id) {
    const borrado = await olvidarLinea({ exe, waScope, run, id: pedido.id,
      profile: pedido.profile, pageId: pedido.pageId })
    const quedan = await refrescarLineas(orca, waScope, { motivo: 'unlink' })
    // Sin ninguna linea, la ruta web no tiene de donde leer: dejarla encendida haria
    // que `sources()` se colgara de cualquier pestana de WhatsApp Web que hubiera.
    // `null` es "no pude leer el registro", y ahi NO se apaga nada: apagar por una
    // lectura fallida deshacia una linea sana que el usuario nunca toco.
    let apagado = null
    if (quedan && !quedan.length) {
      // Se dice si no se pudo apagar. Tragarselo dejaba al plugin leyendo por una via
      // sin linea — cualquier pestana de WhatsApp Web abierta — despues de que el
      // usuario dijo justo que no.
      apagado = await run(waScope, ['config', 'read_web', 'off'])
        .then(() => null).catch((error) => error)
      await guardar(orca, 'readWeb', 'off')
    }
    const sobras = [...(borrado.sobras ?? [])]
    if (apagado) sobras.push({ que: 'read_web', detail: apagado.message })
    if (!quedan) {
      sobras.push({ que: 'read_web',
        detail: 'the registry did not answer, so the web route was left as it was' })
    }
    await veredicto(orca, pedido, sobras.length
      ? { ok: false,
          code: 'a-medias',
          detail: sobras.map((x) => `${x.que}: ${x.detail}`).join('; ').slice(0, 300) }
      : { ok: true })
    return
  }
  await refrescarLineas(orca, waScope, { motivo: 'refresh' })
  await veredicto(orca, pedido, { ok: true })
}

/** La siembra del arnes, en un SUBPROCESO.
 *
 *  El worker corre tras la valla de permisos de Node: `--permission` con lectura solo de
 *  la carpeta del plugin y NINGUN permiso de escritura. Ahi dentro `existsSync` no
 *  devuelve false sino que lanza, asi que preguntarle al disco donde esta el userData
 *  daba un motivo falso ("esta maquina no tiene userData") sobre una maquina que lo
 *  tiene — y aunque lo hubiera encontrado, no habria podido escribir una sola linea.
 *
 *  Los subprocesos NO heredan la valla — es lo mismo que hace que `wa-read doctor` si
 *  conteste — asi que la decision de ruta y la escritura se hacen del otro lado. Es el
 *  mismo modulo corriendo como script: una sola implementacion. */
function sembrarFuera(toolsDir) {
  const guion = join(PLUGIN_DIR, 'harness.mjs')
  return new Promise((resolve) => {
    execFile(process.execPath, [guion, PLUGIN_DIR, toolsDir],
      // El worker es el helper de Electron: sin esto arrancaria una ventana en vez de
      // un Node. Con node pelado —los chequeos— la variable sobra y no molesta.
      { timeout: 120000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
      (error, stdout) => {
        const at = new Date().toISOString()
        try {
          const estado = JSON.parse(stdout || 'null')
          if (estado && typeof estado === 'object') { resolve(estado); return }
        } catch {
          // Cae al motivo de abajo: un stdout que no es JSON es tan fallo como un exit
          // distinto de cero, y el detalle tiene que decir cual de los dos fue.
        }
        resolve({ ok: false, at, reason: error ? motivoDe(error) : 'fallo',
          detail: String(error?.message ?? stdout ?? '').slice(0, 300) })
      })
  })
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
    .catch((error) => orca.log(`initial check failed: ${error.message}`))

  // El arnes del agente. Todo lo que sabe hoy vive en el prompt, que se lee una vez
  // por corrida: un modelo mas chico improvisa. En la carpeta de trabajo del plugin
  // esos archivos son contexto persistente que se lee siempre, y Orca ademas le mete
  // el AGENTS.md de la carpeta al contexto sin que haya que pedirselo.
  //
  // La carpeta la crea una version de Orca que no todos tienen todavia, asi que esto
  // falla callado y deja el motivo escrito, como el sync. Sin ella el plugin anda
  // exactamente igual que antes.
  dirHerramientas()
    .then((dir) => sembrarFuera(dir))
    .then(async (estado) => {
      await guardar(orca, HARNESS_KEY, estado)
      orca.log(estado.ok
        ? `harness: ${estado.files.map((f) => `${f.name} ${f.action}`).join(', ')} in ${estado.dir}`
        : `harness not seeded (${estado.reason}): ${estado.detail}`)
    })
    .catch((error) => orca.log(`harness failed: ${error.message}`))

  // Y traer las conversaciones ya: en una instalacion nueva el panel arranca vacio y
  // el usuario no tiene de donde sacarlas.
  sincronizar('activate').catch((error) => orca.log(`first sync failed: ${error.message}`))

  // Se reprograma en cada vuelta en vez de fijar el intervalo una sola vez: es el
  // ajuste que acota cuanto tarda un mensaje en llegarle al precheck, y cambiarlo en
  // el panel tiene que valer ya, no al proximo arranque de Orca.
  let detenido = false
  let syncTimer = null
  async function programarSync() {
    if (detenido) return
    const ms = await intervaloSync(orca).catch(() => SYNC_MS)
    if (detenido) return
    syncTimer = setTimeout(() => {
      sincronizar('timer')
        .catch((error) => orca.log(`sync failed: ${error.message}`))
        .then(() => programarSync()
          .catch((error) => orca.log(`sync scheduling failed: ${error.message}`)))
    }, ms)
    if (typeof syncTimer.unref === 'function') syncTimer.unref()
  }
  programarSync().catch((error) => orca.log(`sync scheduling failed: ${error.message}`))

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
  const pedidoTimer = setInterval(() => {
    atenderPedido().catch((error) => orca.log(`sync request failed: ${error.message}`))
  }, PETICION_MS)
  if (typeof pedidoTimer.unref === 'function') pedidoTimer.unref()

  // Las lineas web. El pedido del panel se atiende igual que el de sync, pero el estado
  // ademas se resondea solo: el momento que importa — escanear el QR — pasa en otra
  // ventana, y un estado que solo se actualiza al volver al panel llega tarde siempre.
  let ultimoWeb = null
  let proximaSonda = 0
  let sondeando = false
  // Enlazar una linea son dos llamadas a la CLI de Orca con 30 s de tope cada una, y
  // el sondeo sigue latiendo cada tres segundos mientras tanto: sin esta bandera, la
  // vuelta de en medio leia un registro donde la linea TODAVIA no estaba y publicaba
  // "no conectaste ninguna linea" encima del enlace en curso. Eso es el "aparece y
  // desaparece" que se reporto.
  let atendiendo = false
  async function contextoActivo() {
    const r = await orca.host.call('workspace.readContext', {}).catch(() => null)
    return r && typeof r === 'object' ? (r.value ?? r) : null
  }
  async function atenderWebLineas() {
    const pedido = await leer(orca, WEB_REQUEST_KEY)
    if (pedido && typeof pedido === 'object' && typeof pedido.at === 'string' &&
        pedido.at !== ultimoWeb) {
      ultimoWeb = pedido.at
      await guardar(orca, WEB_REQUEST_KEY, null)
      const edad = Date.now() - Date.parse(pedido.at)
      if (edad >= 0 && edad <= PETICION_TTL_MS) {
        // Lo que reviente aca tiene que llegar al panel. Sin esto una excepcion a mitad
        // del enlace —un `run` que rechaza, el CLI de Orca que no esta— se la comia el
        // catch del setInterval y el clic no dejaba rastro ninguno.
        atendiendo = true
        try {
          await atenderWeb(orca, await tool('wa-scope'), pedido, await contextoActivo())
        } catch (error) {
          orca.log(`web request ${pedido.action} failed: ${error.message}`)
          await veredicto(orca, pedido, { ok: false, code: motivoDe(error),
            detail: String(error?.message ?? error).slice(0, 300) })
        } finally {
          atendiendo = false
        }
        proximaSonda = 0
        return
      }
      // Un pedido viejo es de otra sesion y no se atiende, pero callarlo deja al panel
      // esperando una respuesta que no va a llegar.
      await veredicto(orca, pedido, { ok: false, code: 'vencido', detail: '' })
    }
    if (atendiendo || sondeando || Date.now() < proximaSonda) return
    sondeando = true
    try {
      const lineas = await refrescarLineas(orca, await tool('wa-scope'))
      // Rapido mientras algo este a medias — esperando el escaneo, cargando, sin
      // pestana —; lento cuando todo esta enlazado y no hay nada que mirar. Un registro
      // que no contesto (null) tampoco es un estado en reposo: se vuelve a mirar ya.
      const aMedias = !lineas || lineas.some((l) => l.state !== 'enlazada')
      proximaSonda = Date.now() + (aMedias ? WEB_SONDEO_RAPIDO_MS
        : lineas.length ? WEB_SONDEO_LENTO_MS : WEB_SONDEO_OCIOSO_MS)
    } catch (error) {
      proximaSonda = Date.now() + WEB_SONDEO_LENTO_MS
      orca.log(`web lines refresh failed: ${error.message}`)
    } finally {
      sondeando = false
    }
  }
  const webTimer = setInterval(() => {
    atenderWebLineas().catch((error) => orca.log(`web lines loop failed: ${error.message}`))
  }, PETICION_MS)
  if (typeof webTimer.unref === 'function') webTimer.unref()

  const tool = async (name) => join(await dirHerramientas(), name)

  async function settings() {
    const stored = await orca.host.call('settings.get', { key: 'config' })
      .catch((error) => { orca.log(`settings.get failed: ${error.message}`); return null })
    return { ...DEFAULT_SETTINGS, ...(stored?.value ?? {}) }
  }

  // Un alcance que no se pudo leer se ve igual que uno vacio, y vacio significa que
  // ninguna conversacion esta autorizada: el plugin entero se apaga en silencio.
  async function scope() {
    const stored = await orca.host.call('storage.get', { key: SCOPE_KEY })
      .catch((error) => { orca.log(`storage.get scope failed: ${error.message}`); return null })
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
    if (!chatJid) throw new Error('chatJid is missing')
    if (!MODES.includes(mode)) throw new Error(`invalid mode: ${mode}`)
    if (mode !== 'off' && !planeProject) {
      throw new Error('an active chat needs planeProject')
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
        '--mode', mode]).catch((error) => orca.log(`wa-scope set failed: ${error.message}`))
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
        // Igual que el resto del worker: sin idioma del host, la notificacion va en ingles.
        title: s.agentName ? `${s.agentName}: ${rows.length} pending`
                           : `${rows.length} messages mention you`,
        body: rows.slice(0, 3).map((r) => `${r.chat}: ${r.text}`.slice(0, 90)).join('\n')
      }).catch((error) => orca.log(`notification failed: ${error.message}`))
    }
    return rows
  })

  /** Preflight: que el usuario sepa que le falta antes de depender de esto. */
  // Se le pregunta al CLI en TODAS las plataformas. Antes se cortaba aca fuera de
  // macOS con una nota fija: eso escondia la unica respuesta util en Linux, que es que
  // si hay una via — la sesion web — y lo que falta es construirla. Una nota escrita
  // aca ademas se desincroniza del doctor de verdad en cuanto una de las dos cambia.
  orca.commands.register('wa-inbox.doctor', async () => {
    // El motivo viaja: devolver ok:false con la lista vacia y sin causa es lo que hacia
    // que el panel dijera "algo falta" sin poder decir que.
    let error = null
    const { data } = await runJson(await tool('wa-read'), ['doctor', '--json'])
      .catch((e) => {
        error = { reason: motivoDe(e), detail: String(e?.message ?? e).slice(0, 300) }
        return { data: null }
      })
    // Lo opcional no hace fallar: sin la segunda linea se lee igual, y pintar de rojo
    // una funcion que falta es lo que hacia parecer rota una maquina que anda bien.
    const required = (data ?? []).filter((c) => c.requerido !== false)
    return { ok: !!data && required.every((c) => c.ok), checks: data ?? [], error }
  })

  orca.commands.register('wa-inbox.settings', async (args) => {
    if (!args || args.read) return settings()
    const next = { ...(await settings()), ...args }
    await orca.host.call('settings.set', { key: 'config', value: next })
    return next
  })

  orca.events.on('agent.status.changed', (payload) => {
    orca.log(`agent ${payload.state} in ${payload.worktreeId ?? 'no worktree'}`)
  })

  // Al desactivar el plugin los timers se van con el: si no, siguen leyendo WhatsApp
  // despues de que el usuario dijo que no.
  return () => {
    detenido = true
    clearTimeout(syncTimer)
    clearInterval(pedidoTimer)
    clearInterval(webTimer)
  }
}
