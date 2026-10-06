/**
 * WhatsApp Inbox — worker del plugin.
 *
 * Corre en el worker out-of-process de Orca (Node plano, sin Electron). Es el unico
 * lado del plugin que puede tocar disco, asi que aca vive todo lo que necesita leer
 * la base de WhatsApp o persistir el registro.
 *
 * No reimplementa la lectura de WhatsApp: delega en los CLIs (`wa-read`, `wa-scope`,
 * `wa-send`). Duplicar esa logica aca seria tener dos verdades que se desincronizan.
 *
 * Hoy el unico transporte es el sidecar de Baileys, y todavia solo empareja: los CLIs
 * contestan `no-transport` a todo lo que pida mensajes. Los dos transportes viejos —la
 * app de escritorio y una sesion de WhatsApp Web conducida por el navegador— se
 * quitaron enteros, y con ellos el despachador de pestanas que vivia en este archivo.
 */
import { execFile, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { HARNESS_KEY } from './harness.mjs'
import { llaveValida } from './jev-espejo.mjs'
import { crearAccionesCaso } from './acciones.mjs'
import {
  CUENTAS_ACCION, crearAjustadorRitmo, crearEncendedor, crearLanzadorTriage, crearListaCuentas
} from './agente.mjs'
import { crearCatalogo, curarCatalogo, leerCatalogo, PROJECTS_KEY } from './catalogo.mjs'
import { SKILLS_ACCION, SKILLS_STATUS_KEY, SKILLS_VEREDICTO } from './skills.mjs'
import { AVISO_PLAZO_MS, crearAvisosOrca } from './avisos-orca.mjs'

// Las herramientas viajan dentro del plugin. Antes se buscaban en el PATH del usuario,
// lo que solo funcionaba en la maquina donde alguien las habia enlazado a mano.
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const TOOLS = join(PLUGIN_DIR, 'bin')
const SCOPE_KEY = 'scope'          // { [chatJid]: ScopeEntry }
const ROUTES_KEY = 'routes'        // [{ pattern, workspace }]: las reglas de texto del panel
// Como le fue al ultimo sync. El panel no puede ejecutar nada, asi que sin esto no
// tiene forma de distinguir "todavia buscando" de "fallo hace media hora".
const STATUS_KEY = 'syncStatus'
// Que puede leer este sistema. El panel lo lee y hasta ahora no lo escribia NADIE: una
// maquina sin WhatsApp instalado se veia igual que una sana.
const HEALTH_KEY = 'health'
// La senal de vida del worker. Sin ella "el plugin no contesto" y "el plugin no esta"
// son el mismo silencio de 45 s, y el usuario no puede distinguirlos.
const AUTOPSIA_KEY = 'workerAutopsia'
const BEAT_KEY = 'workerBeat'
// La via de vuelta: el panel deja aca un pedido de sync y el worker lo atiende. Es el
// mismo camino que usan Tomar/Ignorar con `decisions`.
const REQUEST_KEY = 'syncRequest'
const CHATS_KEY = 'chats'
// El estado del sidecar de Baileys (T3): conexion, ultimo QR con su `ts`, y el
// motivo cuando algo no llega a hablar. El panel dibuja el QR desde aca
// (docs/ENCARGO-TRANSPORTE-UNICO.md §6-7); es el UNICO canal, igual que el resto.
const SIDECAR_KEY = 'sidecar'
// La via de vuelta para la vinculacion: el panel deja aca lo que quiere que pase con
// la sesion -desvincularla, o reintentar el arranque- y el worker lo atiende. Es el
// mismo camino que `syncRequest`, porque es el unico que hay: el panel solo llama
// `storage.get`/`storage.set` y no existe evento de cambio de storage
// (docs/ENCARGO-TRANSPORTE-UNICO.md §6). Dos claves y no una: el veredicto no puede
// vivir dentro del pedido, porque el pedido se borra al atenderlo.
const SIDECAR_REQUEST_KEY = 'sidecarRequest'
const SIDECAR_RESULT_KEY = 'sidecarResult'
// Varias lineas a la vez (odd/tasks/varias-lineas-y-segundo-cerebro.md, L2). `sidecar`
// sigue siendo la linea PRINCIPAL, tal cual: con una sola linea el panel no ve nada
// distinto. El estado de cada linea que no es la principal va en `sidecars`, por carpeta,
// y la lista de lineas en orden —la primera es la principal— con su numero y su tipo, en
// `lineas`.
const SIDECARS_KEY = 'sidecars'
const LINEAS_KEY = 'lineas'
// La MISMA via, para lo que el panel pide sobre el alcance. Dos claves propias y no las
// del sidecar: son dos vidas distintas -una sesion de WhatsApp y una autorizacion- y
// meterlas en la misma clave haria que el veredicto de una pisara el de la otra, que es
// justo lo que el `requestId` existe para evitar.
//
// Existe porque el panel NO puede borrar una autorizacion el solo. El registro vive en
// dos lados -`scope.db` del CLI y el `storage.json` del plugin- y los CLIs leen la
// MEZCLA (`merged_scope`, bin/wa-scope:622-653). Con la mezcla, agregar y editar desde
// el panel funcionan porque lo del panel MANDA sobre lo del CLI; borrar no, porque
// quitar la fila del panel solo descubre la del CLI que sigue abajo. Medido en la
// maquina del dueno: el panel decia "✓ quitada" y la conversacion volvia a aparecer,
// autorizada. Solo `wa-scope rm` borra en los dos (bin/wa-scope:858-865), y solo el
// worker puede ejecutarlo.
const SCOPE_REQUEST_KEY = 'scopeRequest'
const SCOPE_RESULT_KEY = 'scopeResult'
const MODES = ['off', 'observar', 'borrador', 'responder']

// La llave de Jev (TypeSafe), secreto PROPIO del plugin. Cuatro claves y no una: el panel
// no puede llamar a `secrets.*` (solo storage), asi que escribe un pedido y el worker lo
// atiende, igual que `scopeRequest`; el veredicto va en otra clave porque el pedido se
// borra al leerlo. El estado es lo unico que el panel pinta, y nunca lleva la llave, ni
// siquiera sus ultimos caracteres: solo "guardada" o "sin llave".
const JEV_REQUEST_KEY = 'jevRequest'
const JEV_RESULT_KEY = 'jevResult'
const JEV_STATUS_KEY = 'jevStatus'
// El interruptor. Apagado de fabrica: encenderlo es lo que manda el texto de los clientes
// a api.typesafe.ai, y lo decide el dueno con el aviso a la vista.
const JEV_ENABLED_KEY = 'jevEnabled'
const JEV_SECRET_NAME = 'jevKey'
const JEV_ACCION = Object.freeze({
  GUARDAR: 'guardar-llave', QUITAR: 'quitar-llave', ACTIVAR: 'activar'
})
const JEV_VEREDICTO = Object.freeze({
  GUARDADA: 'guardada',
  QUITADA: 'quitada',
  ACTIVADO: 'activado',
  DESACTIVADO: 'desactivado',
  VENCIDO: 'vencido',
  ACCION_DESCONOCIDA: 'accion-desconocida',
  LLAVE_INVALIDA: 'llave-invalida',
  ARGUMENTOS_INVALIDOS: 'argumentos-invalidos',
  BOVEDA_FALLO: 'boveda-fallo',
  ESPEJO_FALLO: 'espejo-fallo'
})
const JEV_ESPEJO_SCRIPT = join(PLUGIN_DIR, 'jev-espejo.mjs')
// La llave del aprobador (approve-solo-dueno): la crea y la devuelve este script, sin valla.
const APROBADOR_SCRIPT = join(PLUGIN_DIR, 'aprobador.mjs')
// Cuantas veces se registra que la boveda no contesta: la revision corre cada 5 minutos
// y cada registro es una llamada al host.
const JEV_AVISOS_MAX = 3

/** El nombre del agente lo define quien usa el plugin. No viene con uno puesto.
 *
 *  `sidecarPath` y `authDirResolverPath` son internos, como `toolsDir`: no los pisa el
 *  usuario, existen para que las pruebas puedan apuntar el lanzamiento a un guion de
 *  mentira en vez del bundle real de Baileys o del resolvedor real. Hace falta uno por
 *  cada hijo porque fallan por motivos distintos y el panel los traduce distinto. */
const DEFAULT_SETTINGS = { agentName: '', signMessages: true, toolsDir: TOOLS,
  sidecarPath: join(PLUGIN_DIR, 'sidecar', 'sidecar.cjs'),
  authDirResolverPath: join(PLUGIN_DIR, 'sidecar', 'resolve-auth-dir.mjs') }

// Los codigos del doctor que bloquean pero NO notifican: el panel los pinta al lado del
// QR, que es justo donde esta la accion. Una notificacion del sistema por esto saldria
// en cada revision de una maquina recien instalada, o con la linea caida.
const SIN_AVISO = new Set(['no-transport', 'transport-silent'])

// Cada cuanto se vuelve a correr el doctor. Antes corria UNA vez, al activar: un sidecar
// que moria despues dejaba el diagnostico en verde para siempre. Cinco minutos: el
// doctor es un proceso de Python y la caida que importa ya la pinta el panel por el
// latido de la linea en menos de tres.
export const SALUD_MS = 5 * 60 * 1000

/** Repite `correr` cada `cadaMs`, sin encimar una vuelta con la siguiente (el doctor
 *  puede tardar). Devuelve con que pararlo. */
export function programarSalud(correr, cadaMs = SALUD_MS) {
  let enVuelo = false
  const timer = setInterval(() => {
    if (enVuelo) return
    enVuelo = true
    Promise.resolve().then(correr).catch(() => {}).finally(() => { enVuelo = false })
  }, cadaMs)
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}

/** Corre `wa-read doctor` y avisa por notificacion si algo falta.
 *
 *  `memoria` recuerda lo ultimo que se aviso: repetida la revision, el MISMO problema no
 *  vuelve a sacar la misma notificacion. Avisa cuando el problema cambia. */
export async function checkSystem(orca, toolsDir = TOOLS, memoria = {}) {
  // El motivo se conserva: "no pude comprobar el sistema" sin la causa deja al usuario
  // en el mismo callejon que el spinner eterno.
  let porque = ''
  // `doctor` sale con 1 cuando falta algo REQUERIDO — que es justo lo que se le esta
  // preguntando. Rechazar por el codigo de salida tiraba su respuesta entera y una
  // maquina sin WhatsApp instalado se reportaba como "las herramientas no contestaron".
  const result = await run(join(toolsDir, 'wa-read'), ['doctor', '--json'],
    { timeoutMs: 30000 }).catch((error) => {
      porque = String(error?.message ?? error).slice(0, 200)
      return error?.stdout ? { stdout: error.stdout } : null
    })
  let checks = []
  let legible = false
  try {
    const leido = JSON.parse(result?.stdout || 'null')
    if (Array.isArray(leido)) { checks = leido; legible = true }
  } catch {
    // Cae al estado de abajo: un stdout que no es JSON es "no contestaron".
  }
  if (!legible) {
    porque = porque || `doctor returned no JSON: ${String(result?.stdout).slice(0, 120)}`
  }
  const opcional = checks.filter((c) => c.requerido === false && !c.ok)
    .map((c) => ({ que: c.check, code: c.code,
                   como: c.detalle, howCode: c.detailCode || null }))
  // Solo lo REQUERIDO avisa. Lo opcional siempre tiene algo apagado — la segunda
  // linea, por ejemplo — y avisarlo pondria una notificacion en cada arranque de una
  // maquina que lee perfecto, que es la manera mas rapida de que dejen de leerse.
  const failed = checks.filter((c) => !c.ok && c.requerido !== false)
  // Que no haya linea enlazada bloquea —el plugin no puede leer— pero la accion esta a
  // dos centimetros: el codigo QR vive en el mismo panel donde se pinta este aviso. Una
  // notificacion del sistema ademas de eso saldria en cada arranque de una maquina
  // recien instalada, que es la manera mas rapida de enseniar a ignorarlas. El motivo
  // viaja a `health`, que el panel pinta al lado del QR, y no a una notificacion.
  const accionables = failed.filter((c) => !SIN_AVISO.has(c.code))

  // El estado se PUBLICA siempre. El panel lo lee en `health` y no lo escribia nadie:
  // una maquina que no puede leer WhatsApp se veia exactamente igual que una sana.
  const salud = !legible
    ? { ok: false, problem: 'the plugin tools did not answer',
        problemCode: 'sin-herramientas', detail: porque, optional: [] }
    : failed.length
      ? { ok: false,
          problem: failed[0].check,
          problemCode: failed[0].code || null,
          detail: failed.map((c) => `${c.code || c.check}: ${c.detalle}`).join('; ')
            .slice(0, 300),
          optional: opcional }
      : { ok: true, optional: opcional }
  await guardar(orca, HEALTH_KEY, salud)

  const clave = !legible ? 'sin-herramientas'
    : accionables.map((c) => c.code || c.check).sort().join(',')
  const repetido = memoria.avisado === clave
  memoria.avisado = clave

  if (!legible) {
    if (repetido) return
    await orca.host.call('notifications.show', {
      title: 'Could not check the system',
      body: `Could not run the plugin tools. Check that ${toolsDir} is executable.` +
        (porque ? ` ${porque}` : '')
    }).catch((error) => orca.log(`notification failed: ${error.message}`))
    orca.log(`check: the tools did not answer${porque ? ` — ${porque}` : ''}`)
    return
  }
  // El log si lo dice siempre: es donde se mira cuando algo no anda, y callarlo ahi
  // seria esconder justo lo que explica una bandeja vacia.
  if (failed.length) orca.log(`check: missing ${failed.map((c) => c.code || c.check).join(', ')}`)
  if (!accionables.length || repetido) return

  await orca.host.call('notifications.show', {
    // El worker no tiene forma de saber en que idioma esta el usuario — el host no se
    // lo dice y no hay navigator aca — asi que una notificacion no se puede traducir.
    // Va en ingles, como todo lo que no puede llevar traduccion; el detalle esta a un
    // clic, en el panel, que si esta en su idioma.
    title: 'WhatsApp Inbox needs something else',
    body: 'Open the plugin settings to see what is missing.'
  }).catch((error) => orca.log(`notification failed: ${error.message}`))
}

/** La linea de stderr que sirve. En un traceback de Python la primera es el
 *  encabezado y lo util es la ultima; en todo lo demas la primera es el mensaje. */
function lineaUtil(stderr) {
  const lineas = String(stderr ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  if (!lineas.length) return ''
  return /^Traceback/.test(lineas[0]) ? lineas[lineas.length - 1] : lineas[0]
}

// El env con que corren las herramientas. Se completa al resolver la casa de Orca:
// wa-read y wa-send terminan ejecutando la CLI de Orca, y con la variable puesta no
// tienen que volver a buscarla cada uno por su lado.
let ENV_HERRAMIENTAS = null

/** `env` suma variables SOLO a este hijo: la llave del aprobador viaja asi, al
 *  `wa-send --approve` del tablero y a nadie mas (approve-solo-dueno). */
function run(cmd, args, { timeoutMs = 20000, env = null } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
        env: env ? { ...(ENV_HERRAMIENTAS || process.env), ...env } : (ENV_HERRAMIENTAS || process.env) },
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
          // Lo que alcanzo a decir sobrevive al rechazo: `wa-read doctor` sale con 1
          // cuando falta algo requerido y su JSON en stdout es justo la respuesta.
          fallo.stdout = stdout ?? ''
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
  // ERR_ACCESS_DENIED es como DENIEGA la valla de permisos de Node, y es el permiso
  // denegado que el worker se encuentra de verdad: EACCES/EPERM vienen del sistema de
  // archivos, la valla tiene su propio codigo. Sin esta linea, un plugin sin
  // `process:spawn` concedido se contaba como 'fallo' generico.
  if (error?.spawnCode === 'ERR_ACCESS_DENIED' ||
      error?.spawnCode === 'EACCES' || error?.spawnCode === 'EPERM') return 'sin-permiso'
  if (error?.timedOut) return 'demoro'
  return 'fallo'
}

/** El mismo motivo, pero para un error de `execFile` en crudo.
 *
 *  `motivoDe` espera la forma que arma `run()` -`spawnCode` y `timedOut` separados-, y
 *  `execFile` no la da: mete el codigo de spawn y el de salida en el mismo `code`, y
 *  marca el timeout como `killed`. Pasarle el error tal cual devolvia 'fallo' SIEMPRE,
 *  asi que un permiso denegado y un guion que reviento eran el mismo motivo. */
function motivoDeCrudo(error) {
  if (!error) return 'fallo'
  return motivoDe({
    spawnCode: typeof error.code === 'string' ? error.code : null,
    timedOut: !!(error.timedOut || error.killed)
  })
}

// La entrada de los casos (kanban-casos, T2): cuando el sidecar guarda mensajes nuevos, un
// `wa-scope ingest` los vuelve casos sin esperar al reloj de 5 minutos ni despertar a
// ningun agente. El rebote junta una rafaga en UNA corrida: el sidecar ya saca los
// conteos con freno de 30 s, y aun asi un mensaje y el chat que lo rodea llegan juntos.
export const INGESTA_ESPERA_MS = 5 * 1000
const INGESTA_TIMEOUT_MS = 60 * 1000
// Cada `orca.log` es una llamada al host y Orca mata al worker a los 64 sin confirmar
// (ver STDERR_MAX_LINEAS): una ingesta que falla en cada mensaje no puede llevarselo.
export const INGESTA_AVISOS_MAX = 5

/** Convierte "pasaron cosas" en UNA corrida de `correr`, despues de que se calma.
 *
 *  `pedir()` reinicia la espera, asi que una rafaga es una sola corrida; si llega un
 *  pedido con una corrida en curso no arranca otra encima —dos ingestas a la vez se
 *  disputarian la base—, queda anotado y corre UNA vez mas al terminar la actual. Una
 *  corrida que falla no apaga nada: `correr` dice lo suyo, esto sigue. Pura como
 *  `programarSalud`, para probar la regla sin esperar los segundos reales. */
export function programarIngesta(correr, { esperaMs = INGESTA_ESPERA_MS } = {}) {
  let timer = null
  let enVuelo = false
  let otraVez = false
  let parado = false

  const lanzar = () => {
    timer = null
    if (parado) return
    enVuelo = true
    Promise.resolve().then(correr).catch(() => {}).finally(() => {
      enVuelo = false
      if (otraVez && !parado) { otraVez = false; lanzar() }
    })
  }

  return {
    pedir() {
      if (parado) return
      if (enVuelo) { otraVez = true; return }
      clearTimeout(timer)
      timer = setTimeout(lanzar, esperaMs)
      if (typeof timer.unref === 'function') timer.unref()
    },
    parar() {
      parado = true
      clearTimeout(timer)
      timer = null
    }
  }
}

/** Una corrida de `wa-scope ingest`. Es un proceso hijo y no toca el host: ni el
 *  directorio de herramientas se pregunta a `settings.get` —llega ya resuelto—, ni una
 *  corrida buena escribe en el log. Solo la falla se dice, con tope. */
export async function correrIngesta(orca, toolsDir, estado) {
  try {
    await run(join(toolsDir, 'wa-scope'), ['ingest', '--json'],
      { timeoutMs: INGESTA_TIMEOUT_MS })
  } catch (error) {
    estado.avisos += 1
    if (estado.avisos > INGESTA_AVISOS_MAX) return
    const cola = estado.avisos === INGESTA_AVISOS_MAX ? ' (no se registran mas)' : ''
    orca.log(`ingest failed (${motivoDe(error)}): ${String(error?.message ?? error).slice(0, 200)}${cola}`)
  }
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

/** El espejo de la llave en `~/.wa-inbox/jev.env`, escrito en un SUBPROCESO.
 *
 *  Es lo que leen los CLIs de Python, que no pueden abrir la boveda `secrets`. El worker
 *  no escribe disco -su valla no tiene permiso de escritura-, asi que el subproceso sin
 *  valla (`mandoSinValla`) es la unica escritura. La llave viaja por STDIN: nunca por
 *  argv, que cualquier `ps` ve. `modo`: guardar | sincronizar | borrar | estado. Nunca
 *  rechaza: un fallo vuelve como `{ ok: false, motivo }`. */
function espejoJev(modo, llave) {
  return new Promise((resolve) => {
    try {
      const m = mandoSinValla(process.execPath, [JEV_ESPEJO_SCRIPT, modo])
      const hijo = execFile(m.cmd, m.args,
        { timeout: 10000, maxBuffer: 64 * 1024,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
        (error, stdout) => {
          try {
            const r = JSON.parse(stdout || 'null')
            if (r && typeof r === 'object' && typeof r.ok === 'boolean') { resolve(r); return }
          } catch {
            // Cae al motivo de abajo.
          }
          resolve({ ok: false, motivo: 'sin-json',
            detalle: String(error?.code ?? error?.name ?? '').slice(0, 60) })
        })
      // Un hijo que muere antes de leer su stdin da EPIPE como EVENTO del stream: sin un
      // escucha seria una excepcion no atrapada, y tumbaria al worker entero.
      hijo.stdin.on('error', (error) => resolve({ ok: false, motivo: 'stdin',
        detalle: String(error?.code ?? '').slice(0, 60) }))
      hijo.stdin.end(typeof llave === 'string' ? llave : '')
    } catch (error) {
      resolve({ ok: false, motivo: 'no-arranco',
        detalle: String(error?.code ?? error?.name ?? '').slice(0, 60) })
    }
  })
}

/** La llave del aprobador, o null. La pide a `aprobador.mjs` en un SUBPROCESO sin valla:
 *  el worker no puede leer ni escribir `~/.wa-inbox`. La crea la primera vez y despues
 *  devuelve siempre la misma, que es la que lee el tick. Nunca rechaza y nunca la registra:
 *  solo viaja al env del hijo `wa-send --approve` (acciones.mjs). */
function llaveAprobador() {
  return new Promise((resolve) => {
    try {
      const m = mandoSinValla(process.execPath, [APROBADOR_SCRIPT])
      execFile(m.cmd, m.args,
        { timeout: 10000, maxBuffer: 64 * 1024,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
        (_error, stdout) => {
          try {
            const r = JSON.parse(stdout || 'null')
            resolve(r?.ok === true && typeof r.llave === 'string' ? r.llave : null)
          } catch {
            resolve(null)
          }
        })
    } catch {
      resolve(null)
    }
  })
}

/** La llave guardada, o null. El motivo de un fallo se registra una vez y sin valores. */
async function leerLlaveJev(orca, estado) {
  try {
    const r = await orca.host.call('secrets.get', { key: JEV_SECRET_NAME })
    return typeof r?.value === 'string' && r.value.length > 0 ? r.value : null
  } catch (error) {
    estado.avisos += 1
    if (estado.avisos <= JEV_AVISOS_MAX) {
      orca.log(`secrets.get failed (${motivoDe(error)}): ${String(error?.message ?? '').slice(0, 120)}`)
    }
    return null
  }
}

/** Deja el espejo como dicen los ajustes y publica el estado para el panel.
 *
 *  Con Jev encendido y llave, el espejo existe; en cualquier otro caso no. `forzar` solo
 *  lo piden los gestos explicitos del dueno en el panel —guardar la llave y encender el
 *  interruptor—: son lo unico que puede pisar un archivo que no escribio el plugin. Lo
 *  que corre por su cuenta (arranque, revision de salud) lo respeta y lo dice en el
 *  estado (`ajeno`), porque el lector de Python lo trata como "sin llave" y el usuario
 *  tiene que saber por que. */
async function aplicarJev(orca, habilitado, llave, { forzar = false } = {}) {
  const activo = habilitado && llave !== null
  const r = activo
    ? await espejoJev(forzar ? 'guardar' : 'sincronizar', llave)
    : await espejoJev('borrar')
  let espejo
  if (!r.ok) {
    espejo = 'fallo'
    orca.log(`jev mirror failed (${r.motivo}): ${r.detalle ?? ''}`)
  } else if (activo) {
    espejo = r.estado === 'ajeno' ? 'ajeno' : 'activo'
  } else {
    espejo = habilitado ? 'sin-llave' : 'apagado'
  }
  const estado = { at: new Date().toISOString(), enabled: habilitado,
    keySet: llave !== null, mirror: espejo }
  await guardar(orca, JEV_STATUS_KEY, estado)
  return estado
}

/** Lo que dicen los ajustes ahora mismo, aplicado: al arrancar y en cada revision de
 *  salud, que ya existe. No hay un bucle propio: un espejo que alguien borro o copio a
 *  mano se nota en la proxima vuelta, sin otra llamada al host por tick. */
async function reconciliarJev(orca, estado) {
  const habilitado = (await leer(orca, JEV_ENABLED_KEY)) === true
  return aplicarJev(orca, habilitado, await leerLlaveJev(orca, estado))
}

/** Cuanto se espera a que el sidecar muera por las buenas antes de forzarlo. */
const APAGADO_PLAZO_MS = 3000

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

/** Donde vive el Orca que esta contestando, preguntado a un subproceso.
 *
 *  El worker no lo puede resolver el mismo: corre tras la valla de permisos de Node y
 *  no ve ~/.config. Y no lo puede heredar: Orca arranca el worker con una lista blanca
 *  de variables que no incluye ORCA_USER_DATA_PATH —medido en la maquina del usuario,
 *  su /proc/<pid>/environ traia PATH, HOME y nada mas—, asi que la CLI de Orca caia en
 *  la carpeta por defecto. En Linux esa carpeta es `~/.config/orca` y la app publicada
 *  escribe en `~/.config/orca-ide`: la CLI leia un runtime.json de dos meses atras y
 *  se quedaba pegada contra un socket muerto.
 *
 *  `wa-scope runtime-home` no adivina el nombre de la carpeta: prueba cual CONTESTA. */
async function resolverCasaOrca(waScope) {
  try {
    const { stdout } = await run(waScope, ['runtime-home', '--json'], { timeoutMs: 8000 })
    const casa = JSON.parse(stdout || 'null')?.[0] || null
    if (!casa) return null
    const env = casa.path
      ? { ...process.env, ORCA_USER_DATA_PATH: casa.path }
      : { ...process.env }
    ENV_HERRAMIENTAS = env
    return casa
  } catch (error) {
    // Que no se pueda resolver no apaga nada: la CLI sigue con su carpeta por
    // defecto, que es lo que hacia hasta hoy.
    return { path: null, tried: [], error: error.message }
  }
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
function sembrarFuera(toolsDir, proyectos = null) {
  const guion = join(PLUGIN_DIR, 'harness.mjs')
  return new Promise((resolve) => {
    // Los proyectos aceptados viajan por argv: el subproceso no los puede leer del
    // storage con la misma garantia, y el worker no puede dejarlos en un archivo.
    const mSiembra = mandoSinValla(process.execPath,
      [guion, PLUGIN_DIR, toolsDir, ...(proyectos ? [JSON.stringify(proyectos)] : [])])
    execFile(mSiembra.cmd, mSiembra.args,
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

/** Las skills que el dueno instala fuera del plugin (skills-globales), en un SUBPROCESO por
 *  la misma razon que la siembra: dentro de la valla no se escribe nada. El pedido viaja por
 *  argv, ya validado y con la ruta del proyecto sacada del catalogo, nunca del panel. */
function skillsFuera(pedido) {
  const guion = join(PLUGIN_DIR, 'skills.mjs')
  return new Promise((resolve) => {
    const m = mandoSinValla(process.execPath, [guion, PLUGIN_DIR, JSON.stringify(pedido)])
    execFile(m.cmd, m.args,
      { timeout: 60000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
      (error, stdout) => {
        try {
          const r = JSON.parse(stdout || 'null')
          if (r && typeof r === 'object') { resolve(r); return }
        } catch {
          // Cae al motivo de abajo, como en `sembrarFuera`.
        }
        resolve({ ok: false, code: SKILLS_VEREDICTO.FALLO,
          detail: String(error?.message ?? stdout ?? '').slice(0, 300) })
      })
  })
}

/** Motivos ESTABLES para cuando el sidecar no llega a hablar: el panel los traduce
 *  por codigo, nunca por texto (docs/ENCARGO...§11-E1: "cambiar el texto no rompe
 *  nada; renombrar el codigo desincroniza el panel en silencio"). Son del WORKER -que
 *  el sidecar no arranco, o que se cayo estando vivo- y se distinguen del `MOTIVO` que
 *  exporta `sidecar/src/index.js`, que es del socket de WhatsApp y no del proceso. */
// Tope de lineas de stderr que se registran por vida del sidecar. Cada registro es
// una llamada al host, y el host mata al worker si se le acumulan sin confirmar.
const STDERR_MAX_LINEAS = 20

const SIDECAR_MOTIVO = Object.freeze({
  SIN_AUTHDIR: 'sidecar-sin-authdir',
  SIN_PERMISO: 'sidecar-sin-permiso',
  AUTHDIR_FALLO: 'sidecar-authdir-fallo',
  NO_ARRANCO: 'sidecar-no-arranco',
  CAYO: 'sidecar-cayo',
  // El borrado de las credenciales no ocurrio. Codigo propio y no `AUTHDIR_FALLO`
  // porque lo que hay del otro lado es distinto: aca la sesion SIGUE VIVA, y decirle
  // al usuario cualquier otra cosa es dejarlo creyendo que revoco algo que no revoco.
  DESVINCULAR_FALLO: 'desvincular-fallo'
})

/** El motivo del SIDECAR que dice "la sesion guardada murio" (`MOTIVO.SESION_CERRADA`
 *  en sidecar/src/index.js). Se nombra aca porque el worker NO puede taparlo: es lo
 *  unico que separa "hay que tirar la credencial" de "el proceso se cayo", y las dos
 *  cosas piden botones distintos en el panel. */
const MOTIVO_SESION_CERRADA = 'sesion-cerrada'

/** Los codigos con que el sidecar sale A PROPOSITO. Es la otra punta de `SALIDA` en
 *  sidecar/src/index.js, y la prueba del worker compara las dos: dos constantes que
 *  nadie obliga a coincidir terminan no coincidiendo. */
export const SIDECAR_SALIDA = Object.freeze({
  CREDENCIALES_MUERTAS: 3,
  RENDIDO: 4
})

/** Que significa que el sidecar haya terminado, y que queda escrito para el panel.
 *
 *  Antes cualquier salida se escribia como `sidecar-cayo`, y eso tapaba el motivo que
 *  el propio sidecar acababa de mandar: con la sesion cerrada desde el telefono el
 *  panel dejaba de ofrecer Desvincular -la unica salida- y ofrecia Reintentar, que
 *  repetia el mismo 401. Se mira el codigo de salida Y el motivo ya escrito, porque
 *  cualquiera de los dos alcanza para saber que la credencial murio. */
export function clasificarSalida ({ code, signal, estado }) {
  const detalle = `sidecar exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`
  if (code === SIDECAR_SALIDA.CREDENCIALES_MUERTAS || estado?.motivo === MOTIVO_SESION_CERRADA) {
    const propio = estado?.error?.code === MOTIVO_SESION_CERRADA ? estado.error : null
    return { tipo: 'credenciales-muertas', motivo: MOTIVO_SESION_CERRADA,
      error: propio || { code: MOTIVO_SESION_CERRADA, detail: detalle } }
  }
  // Se rindio a proposito (403/411/440 repetidos): su motivo ya llego por stdout y es
  // el que el panel tiene que traducir. Sin ese motivo escrito no se inventa uno.
  if (code === SIDECAR_SALIDA.RENDIDO && estado?.error?.code) {
    return { tipo: 'rendido', motivo: estado.motivo ?? estado.error.code, error: estado.error }
  }
  return { tipo: 'caida', motivo: SIDECAR_MOTIVO.CAYO,
    error: { code: SIDECAR_MOTIVO.CAYO, detail: detalle } }
}

// Cuanto se espera, tras la salida del hijo, a que su stdout termine de entregar. El
// evento de salida puede llegar ANTES que las ultimas lineas, y esas son justo las que
// dicen por que se fue. Con tope: un nieto que heredo la tuberia no puede dejar la
// salida sin reportar.
const STDOUT_DRENAJE_MS = 1000

/** Lo que el panel puede pedirle al worker sobre la sesion, y como se contesta.
 *
 *  `desvincular` es irreversible: borra una CREDENCIAL VIVA
 *  (docs/ENCARGO-TRANSPORTE-UNICO.md §11-F1). `reintentar` no destruye nada, solo
 *  vuelve a lanzar lo que no arranco. Se nombran en el mismo idioma que el resto de
 *  los codigos estables del contrato, y no en el del panel, porque el panel los
 *  traduce por codigo (§11-E1). */
const SIDECAR_ACCION = Object.freeze({
  DESVINCULAR: 'desvincular',
  REINTENTAR: 'reintentar',
  // Traer la libreta: los contactos y las conversaciones uno a uno. Reusa el
  // relanzamiento porque el sidecar pide `resyncAppState` al conectar y su stdin esta
  // cerrado -no hay por donde mandarle una orden a uno ya corriendo-. Es una ACCION
  // PROPIA y no el mismo `reintentar` porque lo que el usuario pide es distinto y el
  // panel tiene que poder decirselo con sus palabras: reintentar es para una sesion
  // caida, esto es para una lista a la que le faltan personas.
  LIBRETA: 'libreta',
  // Vincular una linea MAS, al lado de las que ya estan: su propia carpeta y su QR.
  VINCULAR: 'vincular',
  // El tipo de una linea (L5): `support` o, desde la parte 2, `personal`.
  TIPO: 'tipo'
})

/** Codigos del veredicto que el worker deja para el panel. `vencido` no es un fallo
 *  del worker: es un pedido de otra sesion, que no se atiende pero tampoco se calla —
 *  callarlo deja al panel esperando una respuesta que no va a llegar. */
const SIDECAR_VEREDICTO = Object.freeze({
  DESVINCULADO: 'desvinculado',
  REINTENTADO: 'reintentado',
  VENCIDO: 'vencido',
  ACCION_DESCONOCIDA: 'accion-desconocida',
  // Una linea nueva esperando su QR (la recien abierta, o la que ya esperaba).
  VINCULANDO: 'vinculando',
  // El pedido nombra una carpeta que no es de ninguna linea.
  LINEA_DESCONOCIDA: 'linea-desconocida',
  // Todavia no se sabe donde viven las lineas (el resolvedor no contesto): no hay donde
  // abrir otra.
  SIN_LINEAS: 'sin-lineas',
  TIPO_GUARDADO: 'tipo-guardado',
  TIPO_INVALIDO: 'tipo-invalido',
  // Un tipo que existe pero todavia no se puede elegir (`personal`, parte 2).
  TIPO_NO_DISPONIBLE: 'tipo-no-disponible'
})

/** Lo que el panel puede pedirle al worker sobre el alcance, y como se contesta. Mismos
 *  codigos estables que el resto del contrato: el panel los traduce por codigo y nunca
 *  por el texto (§11-E1). */
const SCOPE_ACCION = Object.freeze({ QUITAR: 'quitar', REGLA_QUITAR: 'regla-quitar' })

const SCOPE_VEREDICTO = Object.freeze({
  QUITADO: 'quitado',
  VENCIDO: 'vencido',
  ACCION_DESCONOCIDA: 'accion-desconocida',
  // `wa-scope rm` acepta tambien un trozo de NOMBRE y ahi resuelve por parecido. El
  // nombre visible no es identidad -cambia y se repite (§11-A1)-, asi que lo que no sea
  // un jid se rechaza en vez de adivinar cual conversacion se queria quitar.
  JID_INVALIDO: 'jid-invalido',
  // Una regla de texto quitada de la base y del storage del panel.
  REGLA_QUITADA: 'regla-quitada',
  // Lo que llega como patron de una regla no es un texto acotado y legible: no llega a la
  // linea de comandos.
  PATRON_INVALIDO: 'patron-invalido',
  // La linea que nombra el pedido no tiene forma de cuenta (`pn:<digitos>`).
  LINEA_INVALIDA: 'linea-invalida'
})

/** Una cuenta de linea: lo unico que llega a `--line`. */
const LINEA_RE = /^pn:\d{6,}$/

/** Lo mas largo que puede ser el patron de una regla de texto. Un texto que tiene que
 *  aparecer en un mensaje no pasa de unas palabras; sin tope seria un lugar donde dejar
 *  cualquier cosa. */
const PATRON_MAX = 120
// Sin caracteres de control: un salto de linea en un patron seria una segunda linea que
// nadie pidio, y `wa-scope` lo guardaria tal cual.
const PATRON_RE = /^[^\u0000-\u001f\u007f]+$/

/** Del motivo que devolvio el resolvedor al codigo estable que lee el panel.
 *
 *  Los tres eran uno solo -SIN_AUTHDIR- y el panel le decia a todo el mundo que en
 *  este equipo no se encontro la carpeta de datos de Orca. Visto en el producto: el
 *  plugin estaba en "Requiere revision", el worker arranca ahi SIN
 *  `--allow-child-process` y el resolvedor ni se puede lanzar, pero corrido a mano
 *  contestaba la ruta perfecta. El mensaje era falso y mandaba a mirar una carpeta que
 *  estaba bien. Son tres arreglos distintos -aprobar el plugin, ver donde guarda Orca
 *  sus datos, leer el log- y por eso son tres codigos
 *  (docs/ENCARGO-TRANSPORTE-UNICO.md §11 E2: "la accion del usuario es distinta en
 *  cada uno").
 *
 *  Un timeout no se separa de un reventon: `demoro` y `fallo` le piden lo MISMO a quien
 *  lee el panel, y un codigo que nadie puede distinguir en pantalla es un codigo que
 *  solo agrega ruido al contrato. */
function motivoAuthDir(resuelto) {
  // 'sin-userdata' lo escribe el propio `resolve-auth-dir.mjs`: es el unico motivo que
  // significa que el resolvedor CONTESTO.
  if (resuelto?.reason === 'sin-userdata') return SIDECAR_MOTIVO.SIN_AUTHDIR
  if (resuelto?.reason === 'sin-permiso') return SIDECAR_MOTIVO.SIN_PERMISO
  return SIDECAR_MOTIVO.AUTHDIR_FALLO
}

/**
 * Como lanzar un hijo que tiene que correr FUERA de la valla de permisos.
 *
 * Node NO deja escapar por el entorno: cuando el proceso vallado lanza otro, le
 * inyecta el mismo `--permission` y la misma allowlist en el `NODE_OPTIONS` del hijo,
 * y lo hace aunque uno borre la variable o pase un entorno minimo. Es a proposito —
 * si bastara con spawnear, la valla no valdria nada. Medido: con el entorno tal cual,
 * borrado, vacio o reducido a PATH y HOME, el hijo nace con `process.permission`
 * activo en los cuatro casos.
 *
 * La salida es no ser Node en el medio. `/usr/bin/env -u NODE_OPTIONS` no es un
 * proceso de Node, asi que Node no le inyecta nada; `env` borra la variable y ejecuta
 * el binario ya limpio. Sin esto, el hijo hereda `--allow-fs-read` sobre la raiz del
 * plugin y NINGUN permiso de escritura, con lo cual el sidecar no podria ni guardar
 * el auth state ni averiguar donde guardarlo (docs/ENCARGO-TRANSPORTE-UNICO.md §2).
 *
 * En Windows no hay `/usr/bin/env`; alli se lanza directo y el hijo queda vallado,
 * que es una limitacion conocida y no un descuido.
 */
export function mandoSinValla (ejecutable, args) {
  if (process.platform === 'win32') return { cmd: ejecutable, args }
  return { cmd: '/usr/bin/env', args: ['-u', 'NODE_OPTIONS', ejecutable, ...args] }
}


/** Donde vive el auth state del sidecar, preguntado a un subproceso.
 *
 *  El worker no lo puede resolver el mismo: su valla de permisos solo declara
 *  `--allow-fs-read` sobre la raiz del plugin y la carpeta del host
 *  (docs/ENCARGO...§1), nunca sobre el userData de Orca, asi que `existsSync` ahi
 *  adentro lanza en vez de contestar. Mismo patron que `resolverCasaOrca` y
 *  `sembrarFuera`: la decision se hace del otro lado, sin la valla. */
function resolverAuthDir(pluginDir, guion = join(pluginDir, 'sidecar', 'resolve-auth-dir.mjs'),
  extra = []) {
  return new Promise((resolve) => {
    // El detalle se corta largo y a proposito. Con 300 caracteres el mensaje util
    // quedaba fuera: los primeros doscientos los gasta el SecurityWarning que Node
    // imprime sobre `--allow-child-process`, y lo que de verdad fallo venia despues.
    // Un detalle que se trunca antes del error no es un detalle, es ruido.
    const noContesto = (error, stderr = '') => resolve({ ok: false, dir: null,
      reason: motivoDeCrudo(error),
      detail: [String(error?.message ?? ''), String(stderr ?? '')]
        .filter(Boolean).join(' | ').slice(0, 1200) })
    try {
      const m = mandoSinValla(process.execPath, [guion, pluginDir, ...extra])
      execFile(m.cmd, m.args,
        { timeout: 15000, maxBuffer: 1024 * 1024,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
        (error, stdout, stderr) => {
          try {
            const estado = JSON.parse(stdout || 'null')
            if (estado && typeof estado === 'object') { resolve(estado); return }
          } catch {
            // Cae al motivo de abajo: un stdout que no es JSON es tan fallo como un
            // exit distinto de cero.
          }
          noContesto(error ?? new Error('el resolvedor no contesto JSON'), stderr)
        })
    } catch (error) {
      // La valla de permisos de Node no contesta por callback: `execFile` LANZA en el
      // acto cuando falta `--allow-child-process`, que es como arranca el worker de un
      // plugin al que todavia no se le concedio `process:spawn`. Sin este catch la
      // promesa se rechazaba, el motivo moria en un `orca.log` y el panel se quedaba
      // esperando un QR que no iba a llegar nunca.
      noContesto(error)
    }
  })
}

/**
 * Lanza el sidecar de Baileys y espeja su protocolo JSON-lines a storage, que es el
 * UNICO canal con el panel (docs/ENCARGO...§6). Consume el contrato que define
 * `sidecar/src/index.js` -`type: 'qr'|'connection'|'error'`, siempre con `ts` en el
 * QR- tal cual llega: no lo redefine.
 *
 * Devuelve una funcion para apagarlo a proposito. Si el proceso muere solo -crash, o
 * nunca llega a arrancar- el motivo llega a storage con un CODIGO ESTABLE y no solo
 * texto libre: un camino de falla que ninguna prueba recorre es un camino que nadie
 * sabe si existe (mismo principio que `sync`, arriba, aplicado a un proceso que corre
 * indefinidamente en vez de una corrida puntual).
 */
export function lanzarSidecar({ orca, scriptPath, authDir, toolsDir = TOOLS,
  spawnFn = spawn, env = process.env, alSalir = () => {}, alLinea = () => {},
  alAlmacen = () => {}, alConectar = () => {}, alLibreta = () => {},
  // Donde queda el estado que lee el panel. Con una linea, la clave de siempre; con
  // varias, la de cada linea (`publicarEstado` en activate). Y lo que el worker le dice al
  // sidecar de SU linea (secundaria, el numero que tenia).
  publicar = (estado) => guardar(orca, SIDECAR_KEY, estado), envLinea = {},
  alCuenta = () => {} }) {
  const nacioMs = Date.now()
  let estado = { at: new Date().toISOString(), connection: null, qr: null,
    motivo: null, statusCode: null, error: null, exited: false,
    // El numero de la linea vinculada, cuando el sidecar lo sabe.
    me: null,
    // Si la lista de personas -la libreta- llego a sincronizarse.
    libreta: null,
    // Lo que el sidecar guardo y lo que desalojo, en CONTEOS. Un tope de retencion que
    // muerde en silencio deja mensajes sin cuerpo sin que nadie sepa por que
    // (docs/ENCARGO-TRANSPORTE-UNICO.md §11-F2), y "llegaron 40 y se guardaron 0" es
    // lo unico que distingue "no hay ninguna conversacion autorizada" de "esto no
    // funciona". Nunca lleva contenido: ni un cuerpo, ni un numero, ni un remitente.
    store: null,
    // El ultimo "sigo aca" del sidecar (`mensajeLatido` en sidecar/src/index.js). Sin
    // esto el "conectado" de los paneles era una foto que no caducaba nunca.
    latido: null,
    // De que numero es la linea (`pn:<digitos>`), cuando el sidecar lo sabe.
    cuenta: null,
    startedAt: new Date().toISOString() }
  // Las escrituras se ENCADENAN sobre una sola promesa. `guardar` es async y nada
  // garantiza que dos `storage.set` en vuelo resuelvan en el orden en que se
  // pidieron -la cola de CUPO del host reordena bajo carga
  // (docs/ENCARGO...§H2-H3)-. Sin esto, dos lineas de stdout seguidas (tipico de un
  // QR que rota justo cuando cae la conexion) disparan dos `escribir()` sin esperar
  // el uno al otro; si la SEGUNDA resuelve antes que la PRIMERA, la primera llega
  // despues y PISA a la segunda en storage — el estado en memoria (`estado`, arriba)
  // queda bien, pero lo que el panel lee no. Asi desaparecio una rotacion entera de
  // QR en una instalacion viva. Encadenar fuerza a cada `storage.set` a esperar a
  // que el anterior haya terminado -exito o fallo, `guardar` nunca rechaza- antes de
  // arrancar, asi que quedan en storage en el mismo orden en que se pidieron.
  let cadenaEscritura = Promise.resolve()
  const escribir = (parcial) => {
    estado = { ...estado, ...parcial, at: new Date().toISOString() }
    const propio = estado
    cadenaEscritura = cadenaEscritura.then(() => publicar(propio))
    return cadenaEscritura
  }

  let detenidoPorWorker = false
  let proceso
  try {
    // Mismo patron que `sembrarFuera`: el worker es el helper de Electron, y sin
    // ELECTRON_RUN_AS_NODE arrancaria una ventana en vez de un Node pelado. Y va por
    // `mandoSinValla` porque el sidecar tiene que ESCRIBIR el auth state: heredando la
    // valla no podria, y ese es el motivo entero de que sea un proceso aparte.
    // El sidecar NO adivina el directorio de auth (sidecar/src/index.js): llega por
    // env, nunca por argv, para que el contrato viva en un solo lugar.
    const mando = mandoSinValla(process.execPath, [scriptPath])
    proceso = spawnFn(mando.cmd, mando.args, {
      // `WA_SIDECAR_TOOLS_DIR` es donde vive `wa-scope`, que es quien sabe que
      // conversaciones estan autorizadas. El sidecar NO adivina esa ruta ni la busca
      // en el PATH: las herramientas viajan juntas, y buscarlas afuera ya habia
      // mandado a una a la instalacion equivocada (§11-E4).
      env: { ...env, ELECTRON_RUN_AS_NODE: '1', WA_SIDECAR_AUTH_DIR: authDir,
        WA_SIDECAR_TOOLS_DIR: toolsDir, ...envLinea },
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    escribir({ exited: true, motivo: SIDECAR_MOTIVO.NO_ARRANCO,
      error: { code: SIDECAR_MOTIVO.NO_ARRANCO,
        detail: String(error?.message ?? error).slice(0, 300) } })
    return () => {}
  }

  escribir({ connection: 'connecting' })

  // El protocolo es un objeto JSON por linea (sidecar/src/index.js:7-8): un chunk de
  // stdout no respeta los saltos de linea, asi que lo que no cierra en `\n` se guarda
  // para la proxima vuelta en vez de intentar parsearlo a medias.
  let restante = ''
  // Los conteos del sidecar son ACUMULADOS desde que arranco: lo que dice que llegaron
  // mensajes es que `guardados` cambio, no que sea mayor que cero. Cambiar y no solo
  // crecer, porque un sidecar relanzado cuenta otra vez desde cero.
  let guardadosVistos = null
  // Un aviso al worker nunca puede tumbar la lectura del protocolo: una falla de quien
  // escucha se registra y la linea siguiente se sigue leyendo.
  const avisar = (cb, que) => {
    try { cb() } catch (error) {
      orca.log(`sidecar ${que} handling failed: ${error.message}`)
    }
  }
  proceso.stdout.on('data', (chunk) => {
    restante += chunk.toString('utf8')
    const lineas = restante.split('\n')
    restante = lineas.pop() ?? ''
    for (const linea of lineas) {
      if (!linea.trim()) continue
      let mensaje
      try {
        mensaje = JSON.parse(linea)
      } catch {
        // El sidecar solo emite JSON por stdout: una linea que no lo es no es parte
        // del protocolo. Se deja rastro y se sigue — cortarlo por una linea rara
        // perderia la sesion por algo que no era del socket.
        orca.log(`sidecar stdout no es JSON: ${linea.slice(0, 200)}`)
        continue
      }
      if (mensaje?.type === 'qr') {
        escribir({ qr: { qr: mensaje.qr, ts: mensaje.ts, rotation: mensaje.rotation,
          // El TTL viaja con el QR: el panel no puede saberlo solo y adivinarlo fue
          // lo que lo dejaba diciendo "vencido" dos tercios del tiempo.
          ttlMs: mensaje.ttlMs } })
      } else if (mensaje?.type === 'connection') {
        escribir({
          connection: mensaje.state ?? null,
          motivo: mensaje.motivo ?? null,
          statusCode: mensaje.statusCode ?? null,
          // Al abrir se descarta el QR: uno vencido no tiene por que seguir pintado
          // detras de una sesion ya conectada (docs/ENCARGO...§6).
          ...(mensaje.state === 'open' ? { qr: null } : {})
        })
        if (mensaje.state === 'open') avisar(alConectar, 'connection')
      } else if (mensaje?.type === 'identidad') {
        // Quien quedo vinculado. El panel de actividad lo pinta al lado de
        // "conectado": tras escanear un QR, saber CUAL linea quedo es la unica forma
        // de notar que se escaneo con el telefono equivocado. Solo el numero visible;
        // el sidecar no manda ni el LID ni nada mas.
        escribir({ me: typeof mensaje.me === 'string' ? mensaje.me : null,
          ...(typeof mensaje.cuenta === 'string' ? { cuenta: mensaje.cuenta } : {}) })
      } else if (mensaje?.type === 'linea') {
        // De que NUMERO es la linea vinculada (`pn:<digitos>`). Cada numero es su linea:
        // el panel lo compara con lo que tiene guardado para no pintar lo del numero
        // anterior como si fuera del nuevo, y etiqueta con esto lo que autoriza.
        const cuenta = typeof mensaje.cuenta === 'string' ? mensaje.cuenta : null
        escribir({ cuenta })
        // De que numero es esta linea, siempre que se sabe: el registro de lineas lo anota.
        if (cuenta) avisar(() => alCuenta(cuenta), 'cuenta')
        if (cuenta && mensaje.cambio === true) {
          try { alLinea(cuenta) } catch (error) {
            orca.log(`sidecar line change handling failed: ${error.message}`)
          }
        }
      } else if (mensaje?.type === 'latido') {
        // La hora del SIDECAR, no la de esta escritura: lo que el panel quiere saber es
        // cuando dio senales de vida la linea, no cuando el worker las copio.
        const escrito = escribir({ latido: { ts: Number(mensaje.ts) || Date.now(),
          conectado: mensaje.conectado === true } })
        // El aviso espera a que el latido este EN storage: quien lo recibe pide un sync,
        // y el sync lee la salud de la linea de ahi. Avisar antes dejaba una ventana en la
        // que el sync todavia veia el latido de antes.
        if (mensaje.conectado === true) escrito.then(() => avisar(alConectar, 'latido'))
      } else if (mensaje?.type === 'libreta') {
        // Si la lista de personas llego. Hasta aca, una libreta que nunca se
        // sincronizo se veia EXACTAMENTE igual que "no tiene conversaciones
        // directas": 296 grupos y ningun nombre, sin una sola senal de que faltaba
        // media lista.
        escribir({ libreta: { ok: mensaje.ok === true, at: new Date().toISOString() } })
        if (mensaje.ok === true) avisar(alLibreta, 'libreta')
      } else if (mensaje?.type === 'store') {
        // Solo numeros y banderas, nunca una cadena. El protocolo del almacen no trae
        // texto de nadie, y esto termina en `storage`, que lee el panel.
        escribir({ store: {
          at: mensaje.at ?? null,
          llegaron: Number(mensaje.llegaron) || 0,
          guardados: Number(mensaje.guardados) || 0,
          sinAutorizar: Number(mensaje.sinAutorizar) || 0,
          actualizados: Number(mensaje.actualizados) || 0,
          autorizadas: Number(mensaje.autorizadas) || 0,
          desalojados: Number(mensaje.desalojados) || 0,
          caducados: Number(mensaje.caducados) || 0,
          // Lo que se llevo la subida de esquema del almacen, el arranque en que
          // ocurre. El renglon del `doctor` lo ve quien entra al panel; esto lo ve
          // quien mire el storage o el log el dia que pregunte adonde fueron a parar
          // los mensajes de la via vieja. Son numeros, como todo lo de aca.
          migradoCuerpos: Number(mensaje.migradoCuerpos) || 0,
          migradoLineas: Number(mensaje.migradoLineas) || 0,
          // Cuantas conversaciones dejo la sincronizacion inicial, y si el telefono ya
          // mando todo lo que tenia. Es la UNICA manera de distinguir "el telefono no
          // mando la lista" de "la mando y no quedo nada": las dos se ven igual — una
          // lista con solo grupos —, y esa confusion es la que costo este arreglo. Son
          // numeros, como todo lo de aca.
          chatsHistorial: Number(mensaje.chatsHistorial) || 0,
          historialCompleto: mensaje.historialCompleto === true
        } })
        const guardados = Number(mensaje.guardados) || 0
        if (guardados > 0 && guardados !== guardadosVistos) {
          try { alAlmacen() } catch (error) {
            orca.log(`sidecar store handling failed: ${error.message}`)
          }
        }
        guardadosVistos = guardados
      } else if (mensaje?.type === 'error') {
        escribir({ error: { code: mensaje.code ?? null,
          detail: String(mensaje.detail ?? '').slice(0, 300) } })
      }
    }
  })

  // El stderr del sidecar se registra CON FRENO. Baileys es hablador, y cada
  // `orca.log` es una llamada al host: Orca mata al worker a los 64 eventos sin
  // confirmar en vuelo (plugin-host-process.ts). Un sidecar charlatan se llevaba
  // puesto al worker, y con el worker moria el grupo de procesos entero — incluido
  // el propio sidecar. El sintoma no se parecia en nada a la causa: el panel se
  // quedaba con un QR vencido para siempre y `exited` decia false, porque nadie
  // llego a ver el final.
  let stderrRegistradas = 0
  proceso.stderr.on('data', (chunk) => {
    stderrRegistradas += 1
    if (stderrRegistradas > STDERR_MAX_LINEAS) return
    const cola = stderrRegistradas === STDERR_MAX_LINEAS ? ' (no se registran mas)' : ''
    orca.log(`sidecar stderr: ${chunk.toString('utf8').trim().slice(0, 300)}${cola}`)
  })

  // Un EPIPE en una tuberia del hijo llega como evento `error` del stream, no del
  // proceso. Sin oyente, Node lo convierte en excepcion no atrapada y se lleva al
  // worker: la muerte del sidecar mataba a quien tenia que reportarla.
  for (const flujo of [proceso.stdout, proceso.stderr]) {
    flujo.on('error', (error) => {
      orca.log(`sidecar stream error: ${String(error?.message ?? error).slice(0, 200)}`)
    })
  }

  proceso.on('error', (error) => {
    escribir({ exited: true, motivo: SIDECAR_MOTIVO.NO_ARRANCO,
      error: { code: SIDECAR_MOTIVO.NO_ARRANCO,
        detail: String(error?.message ?? error).slice(0, 300) } })
  })

  const stdoutTermino = new Promise((resolve) => {
    proceso.stdout.once('end', resolve)
    proceso.stdout.once('close', resolve)
  })

  proceso.on('exit', (code, signal) => {
    // Que el worker lo haya apagado a proposito no es una caida: `apagar()` marca esta
    // bandera ANTES de matarlo. Sin la distincion, un apagado normal del plugin se
    // veia igual que un crash del sidecar en el panel.
    if (detenidoPorWorker) return
    const vidaMs = Date.now() - nacioMs
    let plazo
    const drenado = Promise.race([stdoutTermino, new Promise((resolve) => {
      plazo = setTimeout(resolve, STDOUT_DRENAJE_MS)
      if (typeof plazo.unref === 'function') plazo.unref()
    })])
    drenado.then(() => {
      clearTimeout(plazo)
      if (detenidoPorWorker) return
      const salida = clasificarSalida({ code, signal, estado })
      // `alSalir` corre DESPUES de que la escritura quedo en storage: lo que haga el
      // worker a continuacion -relanzar, limpiar el estado- no puede quedar pisado por
      // la ultima escritura de este proceso, que llega tarde.
      escribir({ exited: true, motivo: salida.motivo, error: salida.error })
        .then(() => alSalir({ ...salida, code: code ?? null, signal: signal ?? null, vidaMs }))
        .catch((error) => orca.log(`sidecar exit handling failed: ${error.message}`))
    })
  })

  // Devuelve una PROMESA que resuelve cuando el proceso murio de verdad, no cuando se
  // mando la senal. Baileys escribe su auth state al cerrar: si el worker borra
  // `wa-auth` mientras el viejo agoniza, el moribundo recrea archivos dentro de la
  // carpeta recien borrada y el siguiente arranca sobre una credencial a medias, no
  // autentica, y se cae. Reintentar cae igual, porque la mezcla sigue ahi. Ese era el
  // "desvinculo y ya no conecta" reportado en produccion.
  return () => {
    detenidoPorWorker = true
    if (!proceso || proceso.exitCode !== null || proceso.signalCode !== null) {
      return Promise.resolve()
    }
    const murio = new Promise((resolve) => { proceso.once('exit', () => resolve()) })
    proceso.kill()
    // Un sidecar que ignora SIGTERM no puede dejar el desvincular colgado para siempre:
    // pasado el plazo se fuerza, y aun asi se espera a `exit` para no seguir con un
    // proceso vivo sobre el mismo auth state.
    const forzado = new Promise((resolve) => {
      const t = setTimeout(() => {
        if (proceso && proceso.exitCode === null && proceso.signalCode === null) {
          proceso.kill('SIGKILL')
        }
        resolve(murio)
      }, APAGADO_PLAZO_MS)
      if (typeof t.unref === 'function') t.unref()
      murio.then(() => { clearTimeout(t); resolve() })
    })
    return forzado
  }
}

// Cada cuanto late el worker, y a partir de cuando el panel lo da por ido. El panel
// relee cada 8 s, asi que 5 s de latido y 30 s de tolerancia no marcan muerto a un
// worker que solo estaba ocupado en una llamada de 30 s a la CLI de Orca.
const LATIDO_MS = 5 * 1000
export const LATIDO_VENCE_MS = 30 * 1000

// Cuanto tiene que vivir un sidecar para que su salida no cuente como "otra vez lo
// mismo". Por debajo de esto, salir de nuevo es un bucle; por encima, es un evento
// nuevo que merece el mismo trato que el primero.
const SIDECAR_VIDA_ESTABLE_MS = 2 * 60 * 1000
const SIDECAR_RENOVACIONES_TOPE = 2

// El reinicio de una caida: espera creciente y tope. Sin tope, un sidecar que revienta
// al nacer (una dependencia que falta, un permiso) se relanzaria cada minuto para
// siempre, y cada vida es un proceso de Node y varias escrituras al host.
const REINICIO_BASE_MS = 2000
const REINICIO_MAX_MS = 60000
const REINICIO_TOPE = 5

/** Si se reinicia el sidecar tras su caida numero `intento` (1-based), y cuanto se
 *  espera. Pura, como `decidirTrasCierre` en el sidecar, para probar la regla sin
 *  esperar los minutos que tarda en cumplirse. */
export function decidirReinicio (intento) {
  if (intento > REINICIO_TOPE) return { reiniciar: false, esperaMs: 0 }
  const paso = Math.max(1, intento)
  return { reiniciar: true,
    esperaMs: Math.min(REINICIO_BASE_MS * 2 ** (paso - 1), REINICIO_MAX_MS) }
}

// Los ajustes que cada linea tiene propios (odd/tasks/ajustes-por-linea.md). La MISMA lista
// que `AJUSTES_DE_LINEA` de bin/wa_settings.py y que la del panel (config.html): la principal
// los tiene en la raiz, cada otra linea en `ajustesPorLinea[<numero>]`.
export const AJUSTES_DE_LINEA = Object.freeze(['agentName', 'ownerName', 'tone', 'owners',
  'approvalNumber', 'approvalLang', 'ackMode', 'ackText', 'ackQuietMinutes', 'greetingMode',
  'greetingText', 'firstReply', 'slaMinutes', 'projectQuestionHours', 'inboxDays',
  'transcribeLang'])
export const AJUSTES_POR_LINEA_KEY = 'ajustesPorLinea'

/** Los ajustes propios de una linea que empieza: una copia de los de la principal (`raiz`).
 *  Pura. Devuelve el contenedor entero con la linea sembrada, o null si no hay nada que
 *  hacer.
 *
 *  Solo se suma lo que la linea NO tiene: una linea que ya estuvo vinculada tiene todos los
 *  suyos y no se copia otra vez, y lo que el dueno o el sync ya le escribieron nunca se pisa.
 *  Lo que la principal no tiene queda en null, que es "sin valor" y no "ausente": asi la
 *  linea nueva no hereda lo que la principal elija despues. La copia es profunda: cambiar
 *  la lista de duenos de una no cambia la de la otra. Lo de las demas lineas, y las claves
 *  que este codigo no conoce, quedan tal cual. */
export function sembrarAjustesDeLinea (contenedor, cuenta, raiz) {
  const todo = contenedor && typeof contenedor === 'object' && !Array.isArray(contenedor)
    ? contenedor : {}
  const previos = todo[cuenta] && typeof todo[cuenta] === 'object' && !Array.isArray(todo[cuenta])
    ? todo[cuenta] : {}
  const faltan = AJUSTES_DE_LINEA.filter((k) => !(k in previos))
  if (!faltan.length) return null
  const propios = { ...previos }
  for (const k of faltan) {
    const valor = raiz ? raiz[k] : undefined
    propios[k] = valor === undefined ? null : JSON.parse(JSON.stringify(valor))
  }
  return { ...todo, [cuenta]: propios }
}

/** Los tipos de linea (L5). `support` es la de siempre y el tipo de toda linea existente;
 *  `personal` existe en el contrato pero queda apagado hasta la parte 2 del plan. */
export const TIPOS_DE_LINEA = Object.freeze(['support', 'personal'])
export const TIPOS_HABILITADOS = Object.freeze(['support'])
const PREFIJO_NUEVA = 'nueva-'

/** La carpeta de una linea que se empieza a vincular. El resolvedor la pasa a la de su
 *  numero en el proximo arranque, cuando ningun sidecar la esta usando. */
export function carpetaNueva (ahoraMs = Date.now()) {
  return `${PREFIJO_NUEVA}${ahoraMs.toString(36)}`
}

/** El registro de lineas que guardo el panel, validado: lo que no tiene forma se descarta. */
export function leerRegistro (valor) {
  if (!Array.isArray(valor)) return []
  return valor.filter((l) => l && typeof l === 'object' && typeof l.carpeta === 'string')
    .map((l) => ({ carpeta: l.carpeta,
      cuenta: typeof l.cuenta === 'string' ? l.cuenta : null,
      tipo: TIPOS_DE_LINEA.includes(l.tipo) ? l.tipo : 'support',
      alta: typeof l.alta === 'string' ? l.alta : null }))
}

/** Junta el registro guardado con las lineas que hay en disco. Pura.
 *
 *  El orden del registro manda —la primera es la principal— y una linea que el resolvedor
 *  paso de `nueva-...` a la carpeta de su numero se reconoce por el numero. Lo que ya no
 *  esta en disco sale; lo que aparece se suma al final, salvo la que se acaba de mudar del
 *  auth state plano (`mudada`): esa era la unica linea, y es la principal. */
export function reconciliarLineas (previo, enDisco, { mudada = null,
  ahora = new Date().toISOString() } = {}) {
  const disco = Array.isArray(enDisco) ? enDisco : []
  const usadas = new Set()
  const salida = []
  for (const p of leerRegistro(previo)) {
    const d = disco.find((x) => !usadas.has(x.carpeta) &&
      (x.carpeta === p.carpeta || (p.cuenta && x.cuenta === p.cuenta)))
    if (!d) continue
    usadas.add(d.carpeta)
    salida.push({ ...p, carpeta: d.carpeta, cuenta: d.cuenta ?? p.cuenta })
  }
  for (const d of disco.filter((x) => !usadas.has(x.carpeta))) {
    const linea = { carpeta: d.carpeta, cuenta: d.cuenta ?? null, tipo: 'support', alta: ahora }
    if (d.carpeta === mudada) salida.unshift(linea)
    else salida.push(linea)
  }
  return salida
}

export default function activate(orca) {
  // ANTES QUE NADA: la autopsia. Un worker que muere de una excepcion no atrapada se
  // lleva consigo el motivo — Orca lo manda a su propio registro, que desde aca no se
  // puede leer, y lo unico que queda visible es un latido congelado y un plugin que se
  // desactiva solo. Sin esto el diagnostico es adivinar; con esto el motivo sobrevive
  // al proceso que lo produjo, en la unica superficie que el worker puede escribir.
  //
  // Se registra al entrar y no al final: un fallo durante la propia activacion es
  // justamente el que hoy no deja rastro.
  const autopsia = (clase) => (error) => {
    const detalle = String(error?.stack ?? error?.message ?? error).slice(0, 1500)
    try { orca.log(`worker ${clase}: ${detalle}`) } catch { /* el log tambien puede irse */ }
    // Sin await: el proceso se esta muriendo y esperar no es una opcion. `storage.set`
    // sale por IPC y en la practica alcanza a salir antes del cierre.
    guardar(orca, AUTOPSIA_KEY, { at: new Date().toISOString(), clase, detalle })
      .catch(() => {})
  }
  process.on('uncaughtException', autopsia('uncaughtException'))
  process.on('unhandledRejection', autopsia('unhandledRejection'))

  // LO PRIMERO, y sin depender de nada: si el worker no arranca no hay quien escriba
  // ninguna otra clave, y "el plugin no contesto" se veia igual que "el plugin no esta
  // aprobado y no existe". El latido es lo que separa esas dos cosas.
  // El latido lleva tambien a que ritmo quedo el triage en Orca (ritmo-triage): el panel
  // ya lo sondea, y una clave aparte le gastaria cupo de mensajes al host.
  let ritmoTriage = null
  const latir = () => guardar(orca, BEAT_KEY,
    ritmoTriage ? { at: new Date().toISOString(), triage: ritmoTriage } : { at: new Date().toISOString() })
    .catch((error) => orca.log(`heartbeat failed: ${error.message}`))
  latir()
  const latidoTimer = setInterval(latir, LATIDO_MS)
  if (typeof latidoTimer.unref === 'function') latidoTimer.unref()

  // Declarado ACA arriba, y no mas abajo junto a `syncTimer`: lo necesitan tambien las
  // cadenas asincronas de mas arriba -el sidecar entre ellas-, y sin la bandera un
  // `apagar()` que llega antes de que una de esas termine dejaria un proceso lanzado
  // DESPUES de que el plugin ya dijo que se apagaba.
  let detenido = false

  const dirHerramientas = async () => (await settings()).toolsDir || TOOLS

  // La entrada de los casos. El directorio de herramientas lo deja resuelto
  // `arrancarSidecar`, que ya lee los ajustes: preguntarlo en cada ingesta seria una
  // llamada al host por mensaje nuevo.
  let dirIngesta = TOOLS
  const estadoIngesta = { avisos: 0 }
  const ingesta = programarIngesta(
    () => detenido ? null : correrIngesta(orca, dirIngesta, estadoIngesta))

  // El sync automatico sale del mismo directorio que los comandos. Antes iba fijo a
  // bin/: quien movia toolsDir tenia la mitad del plugin leyendo de otro lado.
  const sincronizar = async (trigger) =>
    sync(orca, { toolsDir: await dirHerramientas(), trigger })

  // Antes que nada lo que necesita todo lo demas: donde esta el Orca vivo. Se vuelve a
  // resolver en cada arranque porque el runtime cambia de socket en cada arranque.
  const casaResuelta = dirHerramientas()
    .then((dir) => resolverCasaOrca(join(dir, 'wa-scope')))
    .then((casa) => orca.log(casa && casa.path
      ? `orca runtime home: ${casa.path} (${casa.source || 'probe'})`
      : `orca runtime home not resolved; tried: ${(casa && casa.tried || []).join(', ') || 'nothing'}`))
    .catch((error) => orca.log(`orca runtime home failed: ${error.message}`))

  // Al activarse, lo primero es decir si este sistema puede leer WhatsApp. Si no puede,
  // el usuario se tiene que enterar ahora y no cuando una automatizacion lleve una
  // semana sin correr sin explicar por que.
  const memoriaSalud = {}
  dirHerramientas().then((dir) => checkSystem(orca, dir, memoriaSalud))
    .catch((error) => orca.log(`initial check failed: ${error.message}`))
  // La llave de Jev: el espejo que leen los CLIs se deja como dicen los ajustes desde el
  // primer momento, sin esperar a que alguien abra el panel.
  const estadoJev = { avisos: 0 }
  reconciliarJev(orca, estadoJev)
    .catch((error) => orca.log(`jev reconcile failed: ${error.message}`))
  // Y despues se repite: la salud de la linea cambia sola, y un diagnostico que solo se
  // mira al arrancar es una foto que no caduca. El espejo de Jev usa esta misma vuelta.
  const pararSalud = programarSalud(() => detenido ? null
    : Promise.all([
      dirHerramientas().then((dir) => checkSystem(orca, dir, memoriaSalud))
        .catch((error) => orca.log(`health check failed: ${error.message}`)),
      reconciliarJev(orca, estadoJev)
        .catch((error) => orca.log(`jev reconcile failed: ${error.message}`))
    ]))

  // El arnes del agente. Todo lo que sabe hoy vive en el prompt, que se lee una vez
  // por corrida: un modelo mas chico improvisa. En la carpeta de trabajo del plugin
  // esos archivos son contexto persistente que se lee siempre, y Orca ademas le mete
  // el AGENTS.md de la carpeta al contexto sin que haya que pedirselo.
  //
  // La carpeta la crea una version de Orca que no todos tienen todavia, asi que esto
  // falla callado y deja el motivo escrito, como el sync. Sin ella el plugin anda
  // exactamente igual que antes.
  //
  // Con los proyectos que el dueno acepto: PROJECTS.md se genera de esa lista, y vuelve
  // a sembrarse cada vez que el catalogo cambia (`crearCatalogo`, abajo). Las siembras
  // van en fila: una lenta del arranque que terminara DESPUES de la de un cambio dejaria
  // el archivo con la lista vieja hasta el proximo cambio.
  let siembra = Promise.resolve()
  const resembrar = (lista) => {
    siembra = siembra.then(async () => {
      const proyectos = lista ?? leerCatalogo(await leer(orca, PROJECTS_KEY))
      const estado = await sembrarFuera(await dirHerramientas(), proyectos)
      await guardar(orca, HARNESS_KEY, estado)
      orca.log(estado.ok
        ? `harness: ${estado.files.map((f) => `${f.name} ${f.action}`).join(', ')} in ${estado.dir}`
        : `harness not seeded (${estado.reason}): ${estado.detail}`)
      // Las skills que el dueno instalo fuera del plugin (skills-globales): en la primera
      // siembra de cada activacion se ponen al dia con las reglas de secciones, y en cada
      // cambio del catalogo se relee su estado, que lista un destino por proyecto aceptado.
      const r = await skillsFuera({ op: primeraSiembra ? 'actualizar' : 'estado', proyectos })
      primeraSiembra = false
      if (r.estado) await guardar(orca, SKILLS_STATUS_KEY, r.estado)
      const cambiadas = (r.files || []).filter((f) => f.action !== 'igual')
      if (!r.ok || cambiadas.length) {
        orca.log(`skills: ${r.code}; ${cambiadas.map((f) => f.action).join(', ') || 'none'}` +
          (r.detail ? ` (${r.detail})` : ''))
      }
    }).catch((error) => orca.log(`harness failed: ${error.message}`))
    return siembra
  }
  let primeraSiembra = true
  // Antes de la primera siembra: si el catalogo se perdio del storage, vuelve del espejo
  // de wa-scope y PROJECTS.md nace con los proyectos de verdad, no con "ninguno".
  curarCatalogo({
    leerCrudo: () => orca.host.call('storage.get', { key: PROJECTS_KEY })
      .then((r) => ({ ok: true, value: r?.value }), () => ({ ok: false })),
    espejo: async () => {
      const { stdout } = await run(join(await dirHerramientas(), 'wa-scope'),
        ['projects', '--json'], { timeoutMs: 15000 })
      return JSON.parse(stdout || 'null')
    },
    guardar: (k, v) => guardar(orca, k, v),
    log: (m) => orca.log(m)
  }).catch((error) => orca.log(`projects catalog check failed: ${error.message}`))
    .then(() => resembrar())

  // El sidecar de Baileys (T3): el UNICO transporte de esta rebanada. El directorio de
  // auth se resuelve en un subproceso -mismo motivo que el arnes, arriba: el worker no
  // puede leer el userData- y recien con eso se lanza. `sidecarPath` sale de settings
  // para que las pruebas lo apunten a un guion de mentira; en producción nunca se pisa
  // y cae al bundle real (`DEFAULT_SETTINGS.sidecarPath`).
  /** El estado limpio de una linea: sin sesion, sin QR y sin falla.
   *
   *  Se escribe ANTES de cualquier relanzamiento, y no se deja para que lo pise el
   *  `lanzarSidecar` de despues: entre apagar el sidecar viejo y tener el nuevo hay un
   *  viaje a un subproceso, y en ese hueco el panel sondea. Sin esto, desvincular
   *  dejaba la pantalla diciendo "WhatsApp esta conectado" durante ese hueco, que es
   *  justo lo que el usuario acababa de pedir que dejara de ser cierto. */
  const estadoLimpio = () => ({
    at: new Date().toISOString(), connection: null, qr: null, motivo: null,
    statusCode: null, error: null, exited: false, latido: null, cuenta: null,
    startedAt: null
  })
  const sinArrancar = { ok: false, code: SIDECAR_MOTIVO.NO_ARRANCO, detail: 'plugin detenido' }

  // ── Las lineas (varias lineas a la vez, L2) ─────────────────────────────────────
  // Una linea es una carpeta de auth y un sidecar, con su propia salud y su propio
  // reinicio: la caida de una no toca a las demas. La primera del registro es la
  // principal, y su estado sigue en la clave de siempre (`sidecar`).
  const lineas = new Map()
  let registro = []
  // `wa-auth`, o null cuando el resolvedor no sabe de lineas: entonces la carpeta que
  // contesta es la UNICA linea, como siempre, y no hay donde abrir otra.
  let baseAuth = null
  let lineasListas = false
  const estadosSecundarios = {}
  let cadenaSecundarios = Promise.resolve()

  const principal = () => (registro.length ? registro[0].carpeta : null)
  const entradaDe = (linea) => registro.find((r) => r.carpeta === linea.carpeta)
  const viva = (linea) => lineas.get(linea.carpeta) === linea
  const nuevaLinea = (carpeta, dir) => ({ carpeta, dir, apagar: () => {}, renovaciones: 0,
    reinicios: 0, reinicioTimer: null })

  /** Donde va el estado de una linea: la principal en `sidecar`, las demas en
   *  `sidecars`. Se decide al escribir y no al lanzar: si la principal se desvincula, la
   *  que la reemplaza empieza a escribir en `sidecar` sin relanzarse. */
  function publicarEstado (linea, estado) {
    if (linea.carpeta === principal()) return publicarPrincipal(estado)
    estadosSecundarios[linea.carpeta] = estado
    return publicarSecundarios()
  }
  function publicarSecundarios () {
    const copia = { ...estadosSecundarios }
    cadenaSecundarios = cadenaSecundarios.then(() => guardar(orca, SIDECARS_KEY, copia))
    return cadenaSecundarios
  }
  /** El estado de la principal, con la lista de lineas adentro: los paneles ya leen
   *  `sidecar` en cada vuelta, y una clave mas en su sondeo se come el cupo de mensajes del
   *  host que necesita el clic del dueno. Todas las escrituras de `sidecar` van por UNA
   *  cadena, en el orden en que se pidieron, sea el estado o la lista lo que cambio. */
  let ultimoPrincipal = null
  let cadenaPrincipal = Promise.resolve()
  function publicarPrincipal (estado) {
    if (estado) ultimoPrincipal = estado
    if (!ultimoPrincipal) return cadenaPrincipal
    const valor = { ...ultimoPrincipal, lineas: registro.map((r) => ({ ...r })) }
    cadenaPrincipal = cadenaPrincipal.then(() => guardar(orca, SIDECAR_KEY, valor))
    return cadenaPrincipal
  }
  const publicarRegistro = () => Promise.all([
    guardar(orca, LINEAS_KEY, registro.map((r) => ({ ...r }))),
    publicarPrincipal(null)
  ])

  /** Una linea nueva esperando su QR, al final del registro. */
  function agregarLinea () {
    const carpeta = carpetaNueva()
    registro.push({ carpeta, cuenta: null, tipo: 'support', alta: new Date().toISOString() })
    const linea = nuevaLinea(carpeta, join(baseAuth, carpeta))
    lineas.set(carpeta, linea)
    return linea
  }

  /** Donde viven las lineas, preguntado al resolvedor. Es el UNICO momento en que el
   *  resolvedor mueve carpetas (la de siempre a la de su numero, una `nueva-...` ya
   *  vinculada a la suya), y por eso se pide solo con ningun sidecar corriendo. */
  async function resolverLineas (s) {
    const resuelto = await resolverAuthDir(PLUGIN_DIR, s.authDirResolverPath, ['--lineas'])
    if (!resuelto.ok || !resuelto.dir) return resuelto
    const previo = leerRegistro(await leer(orca, LINEAS_KEY))
    lineas.clear()
    if (!Array.isArray(resuelto.lineas)) {
      // Un resolvedor que no sabe de lineas: la carpeta que contesta es la unica.
      baseAuth = null
      registro = [{ carpeta: '', cuenta: previo[0]?.cuenta ?? null,
        tipo: previo[0]?.tipo ?? 'support', alta: previo[0]?.alta ?? new Date().toISOString() }]
      lineas.set('', nuevaLinea('', resuelto.dir))
    } else {
      baseAuth = resuelto.dir
      registro = reconciliarLineas(previo, resuelto.lineas, { mudada: resuelto.mudada ?? null })
      for (const r of registro) lineas.set(r.carpeta, nuevaLinea(r.carpeta, join(baseAuth, r.carpeta)))
      // Ninguna linea vinculada: se espera un QR, como siempre.
      if (!registro.length) agregarLinea()
    }
    for (const carpeta of Object.keys(estadosSecundarios)) {
      if (!lineas.has(carpeta) || carpeta === principal()) delete estadosSecundarios[carpeta]
    }
    lineasListas = true
    await publicarRegistro()
    await publicarSecundarios()
    return resuelto
  }

  /** Lanza el sidecar de UNA linea (apagando antes el que tuviera). */
  async function arrancarLinea (linea) {
    // Cualquier arranque -el automatico, un clic, un desvincular- deja sin efecto el
    // reinicio que estuviera esperando: cumplido despues, apagaria al recien lanzado.
    clearTimeout(linea.reinicioTimer)
    linea.reinicioTimer = null
    if (detenido) return sinArrancar
    const s = await settings()
    if (detenido || !viva(linea)) return sinArrancar
    // El de antes se apaga a proposito: `lanzarSidecar` marca la bandera para que ese
    // final no se reporte como una caida. Dos sidecars vivos sobre el mismo auth state
    // se pisarian las credenciales.
    await linea.apagar()
    // `s.toolsDir` y no `TOOLS`: quien mueve el directorio de herramientas tiene que
    // moverlo entero, o el sidecar le pregunta por el alcance a una instalacion
    // distinta de la que lee el resto del plugin (§11-E4).
    dirIngesta = s.toolsDir || TOOLS
    primeraConexionPendiente = true
    // La principal es la que fija la linea activa del almacen; las demas se suman sin
    // tocarla, y dicen que numero tenian por si se re-vinculan con otro.
    const cuentaPrevia = entradaDe(linea)?.cuenta
    const envLinea = linea.carpeta === principal() ? {}
      : { WA_SIDECAR_LINEA_SECUNDARIA: '1',
          ...(cuentaPrevia ? { WA_SIDECAR_CUENTA_PREVIA: cuentaPrevia } : {}) }
    linea.apagar = lanzarSidecar({ orca, scriptPath: s.sidecarPath, authDir: linea.dir,
      toolsDir: dirIngesta, alSalir: (salida) => alSalirSidecar(linea, salida),
      alLinea: alCambiarLinea, alCuenta: (cuenta) => alSaberCuenta(linea, cuenta),
      alAlmacen: () => ingesta.pedir(), alConectar: alConectarLibreta,
      alLibreta: alLlegarLibreta, publicar: (estado) => publicarEstado(linea, estado), envLinea })
    return { ok: true, dir: linea.dir }
  }

  /** Resuelve donde viven las lineas (si todavia no se sabe) y lanza todas. Una sola
   *  implementacion para el arranque del plugin y para lo que pida el panel: si el
   *  reintento tomara otro camino, seria otro arranque, con otros motivos, y el panel los
   *  traduciria distinto. */
  async function arrancarSidecar () {
    for (const linea of lineas.values()) {
      clearTimeout(linea.reinicioTimer)
      linea.reinicioTimer = null
    }
    if (detenido) return sinArrancar
    const s = await settings()
    if (detenido) return sinArrancar
    if (!lineasListas) {
      const resuelto = await resolverLineas(s)
      if (detenido) return sinArrancar
      if (!resuelto.ok || !resuelto.dir) {
        const motivo = motivoAuthDir(resuelto)
        await publicarPrincipal({
          at: new Date().toISOString(), connection: null, qr: null,
          motivo, statusCode: null,
          error: { code: motivo,
            detail: resuelto.detail || 'could not resolve the auth directory' },
          exited: true, startedAt: new Date().toISOString()
        })
        orca.log(`sidecar not started (${motivo}): ${resuelto.detail || ''}`)
        return { ok: false, code: motivo, detail: resuelto.detail || '' }
      }
    }
    let primero = null
    for (const linea of [...lineas.values()]) {
      const arranque = await arrancarLinea(linea)
      primero = primero ?? arranque
    }
    return primero ?? sinArrancar
  }

  /** El numero de una linea, cada vez que su sidecar lo dice: el registro lo anota (el
   *  panel lo muestra, y es el que se saca del almacen al desvincularla). Una linea que no
   *  es la principal, ademas, nace con los ajustes de la principal (A4). */
  function alSaberCuenta (linea, cuenta) {
    const entrada = entradaDe(linea)
    if (!entrada) return
    if (linea.carpeta !== principal()) sembrarAjustes(cuenta)
    if (entrada.cuenta === cuenta) return
    entrada.cuenta = cuenta
    publicarRegistro().catch((error) => orca.log(`lines registry failed: ${error.message}`))
  }

  // Los ajustes propios de cada linea (ajustes-por-linea, A4). Una cadena: dos lineas que
  // dicen su numero a la vez leerian el mismo contenedor y la segunda borraria a la primera.
  // `sembradas` evita releer en cada reconexion lo que ya quedo completo: cada lectura gasta
  // del cupo de mensajes del host, que es el mismo que usa el panel.
  const sembradas = new Set()
  let cadenaAjustes = Promise.resolve()
  function sembrarAjustes (cuenta) {
    if (typeof cuenta !== 'string' || !cuenta || sembradas.has(cuenta)) return cadenaAjustes
    cadenaAjustes = cadenaAjustes.then(() => sembrarAhora(cuenta)).catch((error) =>
      orca.log(`line settings not copied for ${cuenta}: ${error.message}`))
    return cadenaAjustes
  }
  async function sembrarAhora (cuenta) {
    if (sembradas.has(cuenta)) return
    // Una lectura que falla no es "vacio": sin saber que hay no se escribe nada, y se
    // vuelve a intentar la proxima vez que la linea diga su numero.
    const leerSeguro = async (key) => (await orca.host.call('storage.get', { key }))?.value
    const contenedor = await leerSeguro(AJUSTES_POR_LINEA_KEY)
    const previos = contenedor && typeof contenedor === 'object' ? contenedor[cuenta] : null
    if (previos && typeof previos === 'object' &&
        AJUSTES_DE_LINEA.every((k) => k in previos)) {
      sembradas.add(cuenta)
      return
    }
    const raiz = {}
    for (const k of AJUSTES_DE_LINEA) raiz[k] = await leerSeguro(k)
    // Se relee justo antes de escribir: el panel pudo guardar algo de esta linea mientras
    // se leia la raiz, y eso manda sobre la copia.
    const nuevo = sembrarAjustesDeLinea(await leerSeguro(AJUSTES_POR_LINEA_KEY), cuenta, raiz)
    if (nuevo) await orca.host.call('storage.set', { key: AJUSTES_POR_LINEA_KEY, value: nuevo })
    sembradas.add(cuenta)
  }

  /** Se vinculo un numero distinto (o el primero): lo que muestran los paneles —
   *  conversaciones, actividad, insignia— es del numero anterior hasta el proximo sync,
   *  asi que se pide uno ya en vez de esperar al reloj. Si hay otro sync corriendo, se
   *  reintenta: el que corre puede estar leyendo con la linea de antes. */
  function alCambiarLinea () { sincronizarPronto('linea') }

  /** Pide un sync YA y lo reintenta mientras otro este corriendo: el que corre puede estar
   *  leyendo lo de antes del cambio que motivo este. */
  function sincronizarPronto (trigger) {
    let intentos = 0
    const intentar = () => {
      if (detenido) return
      intentos += 1
      // Ocupado no es fallido: un sync que fallo ya dejo su motivo en `syncStatus` y
      // repetirlo no lo arregla.
      if (sincronizando) {
        if (intentos < 20) {
          const t = setTimeout(intentar, 3000)
          if (typeof t.unref === 'function') t.unref()
        }
        return
      }
      sincronizar(trigger)
        .catch((error) => orca.log(`${trigger} sync failed: ${error.message}`))
    }
    intentar()
  }

  // "Traer conversaciones" (T16): el boton relanza la sesion y las conversaciones llegan
  // DESPUES, cuando la linea conecta y el telefono manda la libreta. La lista que lee el
  // panel solo se rearmaba en el sync de 5 minutos, asi que una conversacion nueva no
  // aparecia hasta entonces. Mientras la peticion esta viva (`libretaHasta`) se pide un sync
  // al conectar y otro cuando la libreta llega; no se pide nada por cuenta propia ni en
  // cada latido: son avisos que el sidecar ya manda, sin una sola llamada nueva al host.
  const LIBRETA_VENTANA_MS = 3 * 60 * 1000
  let libretaHasta = 0
  let libretaConectada = false
  const libretaViva = () => Date.now() < libretaHasta
  // Tras cada (re)arranque del sidecar, UN sync cuando llega el primer latido conectado.
  // El sync del arranque corre ~0.5 s despues de lanzarlo, antes de que haya latido: la
  // salud sale `transport-silent` ("sin senal desde <hora vieja>") y el aviso rojo se
  // quedaba hasta el sync de 5 minutos con la linea ya conectada. Es un sync por arranque
  // y no uno por latido: el aviso que ya manda el sidecar, sin una llamada nueva al host.
  let primeraConexionPendiente = false
  function alConectarLibreta () {
    const primera = primeraConexionPendiente
    primeraConexionPendiente = false
    // Si ademas hay una peticion de libreta viva, ese sync ya cubre la conexion.
    if (libretaViva() && !libretaConectada) {
      libretaConectada = true
      sincronizarPronto('libreta')
      return
    }
    if (primera) sincronizarPronto('conexion')
  }
  function alLlegarLibreta () {
    if (!libretaViva()) return
    libretaHasta = 0
    sincronizarPronto('libreta')
  }

  // Las acciones sobre la vida del sidecar van EN FILA: un desvincular automatico y un
  // clic del panel al mismo tiempo lanzarian dos sidecars sobre el mismo auth state, y
  // dos procesos escribiendo la misma credencial la dejan a medias.
  let colaSidecar = Promise.resolve()
  const enFila = (accion) => {
    const turno = colaSidecar.then(accion)
    colaSidecar = turno.catch(() => {})
    return turno
  }

  // Cada linea lleva sus cuentas (`nuevaLinea`): `renovaciones`, cuantas veces seguidas se
  // tiraron credenciales muertas sin que el sidecar llegara a vivir un rato —una credencial
  // recien borrada no puede volver a dar 401: sin `me` Baileys registra, no hace login—, y
  // `reinicios`, las caidas seguidas (`decidirReinicio`), con el reinicio que espera su
  // turno. Son de la linea y no del plugin: la caida de una no gasta el tope de otra.

  /** Que hacer cuando el sidecar de una linea termino solo. Lo llama `lanzarSidecar`
   *  cuando lo que el panel tiene que leer ya quedo escrito. */
  function alSalirSidecar (linea, salida) {
    if (detenido || !viva(linea)) return
    if (salida.vidaMs >= SIDECAR_VIDA_ESTABLE_MS) { linea.renovaciones = 0; linea.reinicios = 0 }
    if (salida.tipo === 'credenciales-muertas') {
      if (linea.renovaciones >= SIDECAR_RENOVACIONES_TOPE) {
        orca.log('sidecar: WhatsApp closed the session again right after relinking; ' +
          'leaving it for the user to unlink')
        return
      }
      linea.renovaciones += 1
      orca.log('sidecar: WhatsApp closed the session; removing the dead credentials to show a new QR')
      enFila(() => detenido || !viva(linea) ? null : desvincularLinea(linea, { porElDueno: false }))
        .then((r) => { if (r && !r.ok) orca.log(`sidecar relink failed (${r.code})`) })
        .catch((error) => orca.log(`sidecar relink failed: ${error.message}`))
      return
    }
    // Se rindio a proposito (403/411/440): relanzar es el reintento que se acaba de
    // agotar. Queda el motivo escrito y lo decide el dueno desde el panel.
    if (salida.tipo !== 'caida') return
    linea.reinicios += 1
    const decision = decidirReinicio(linea.reinicios)
    if (!decision.reiniciar) {
      orca.log(`sidecar: crashed ${linea.reinicios - 1} times in a row; not restarting it again`)
      return
    }
    orca.log(`sidecar: exited unexpectedly (${salida.error.detail}); restart ${linea.reinicios} ` +
      `in ${Math.round(decision.esperaMs / 1000)}s`)
    linea.reinicioTimer = setTimeout(() => {
      linea.reinicioTimer = null
      enFila(() => detenido || !viva(linea) ? null : arrancarLinea(linea))
        .catch((error) => orca.log(`sidecar restart failed: ${error.message}`))
    }, decision.esperaMs)
    if (typeof linea.reinicioTimer.unref === 'function') linea.reinicioTimer.unref()
  }

  /** Lo que pide el dueno empieza de cero: un clic en Reintentar no hereda las caidas
   *  de antes, ni deja vivo un reinicio automatico que lo pisaria al cumplirse. El pedido
   *  viaja entero: con varias lineas, `carpeta` dice cual. */
  const pedidoDelPanel = (accion) => (pedido) => enFila(() => {
    for (const linea of lineas.values()) { linea.reinicios = 0; linea.renovaciones = 0 }
    return accion(pedido)
  })

  /** La linea de un pedido del panel: la que nombra `carpeta`, o la principal si no
   *  nombra ninguna (el panel de una sola linea nunca la nombra). */
  const lineaDelPedido = (pedido) => {
    const carpeta = typeof pedido?.carpeta === 'string' ? pedido.carpeta : principal()
    return carpeta === null ? null : lineas.get(carpeta) ?? null
  }
  const lineaDesconocida = (pedido) => ({ ok: false, code: SIDECAR_VEREDICTO.LINEA_DESCONOCIDA,
    detail: String(pedido?.carpeta ?? '').slice(0, 60) })

  arrancarSidecar().catch((error) => orca.log(`sidecar launch failed: ${error.message}`))

  // Y traer las conversaciones ya: en una instalacion nueva el panel arranca vacio y
  // el usuario no tiene de donde sacarlas.
  sincronizar('activate').catch((error) => orca.log(`first sync failed: ${error.message}`))
  // La llave del aprobador existe desde el arranque: el tick la lee para entregar lo que el
  // dueno aprueba por WhatsApp, antes de que nadie apriete nada en el tablero.
  llaveAprobador().then((llave) => {
    if (!llave) orca.log('approver key unavailable: board approvals will be refused')
  })

  // Se reprograma en cada vuelta en vez de fijar el intervalo una sola vez: es el
  // ajuste que acota cuanto tarda un mensaje en llegarle al precheck, y cambiarlo en
  // el panel tiene que valer ya, no al proximo arranque de Orca.
  let syncTimer = null
  async function programarSync() {
    if (detenido) return
    const ms = await intervaloSync(orca).catch(() => SYNC_MS)
    if (detenido) return
    // Un cambio del selector reprograma mientras una lectura sigue en curso: una sola cadena.
    if (syncTimer) clearTimeout(syncTimer)
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
  /** Desvincular: apagar, borrar la credencial, y recien entonces volver a empezar.
   *
   *  Se relanza en vez de quedarse apagado porque desvincular existe para volver a
   *  vincular —quien escaneo con el telefono equivocado quiere escanear con el otro—,
   *  y un estado que exige un segundo boton para seguir es un estado donde hay que
   *  explicarle al usuario que hacer. Relanzando, la pantalla vuelve exactamente al
   *  estado que ya sabe dibujar: esperando el codigo, y despues el codigo. */
  async function desvincularSidecar (pedido) {
    // Sin saber todavia donde viven las lineas no hay una que desvincular: se resuelve
    // primero, igual que un reintento, sin lanzar nada.
    if (!lineasListas) {
      const s = await settings()
      const resuelto = await resolverLineas(s)
      if (!resuelto.ok || !resuelto.dir) {
        const motivo = motivoAuthDir(resuelto)
        return { ok: false, code: motivo, detail: resuelto.detail || '' }
      }
    }
    const linea = lineaDelPedido(pedido)
    if (!linea) return lineaDesconocida(pedido)
    return desvincularLinea(linea, { porElDueno: true })
  }

  /** Desvincular UNA linea. `porElDueno` es el boton: la linea sale del registro y del
   *  conjunto de activas del almacen. Sin el es la credencial muerta: se tira y la MISMA
   *  linea vuelve a pedir su QR en su lugar. Con una sola linea las dos terminan igual que
   *  siempre: esperando el codigo. */
  async function desvincularLinea (linea, { porElDueno }) {
    clearTimeout(linea.reinicioTimer)
    linea.reinicioTimer = null
    await linea.apagar()
    linea.apagar = () => {}
    await publicarEstado(linea, estadoLimpio())
    const s = await settings()
    const cuenta = entradaDe(linea)?.cuenta
    const extra = ['--borrar']
    if (linea.carpeta) extra.push('--carpeta', linea.carpeta)
    if (porElDueno && linea.carpeta && cuenta) extra.push('--cuenta', cuenta)
    const borrado = await resolverAuthDir(PLUGIN_DIR, s.authDirResolverPath, extra)
    if (!borrado.ok) {
      // NO se relanza: con las credenciales intactas, el sidecar volveria a conectar la
      // MISMA sesion que el usuario acaba de pedir cortar, y el panel diria "conectado"
      // como si nada hubiera pasado. Es la peor mentira que este panel podria contar.
      const motivo = borrado.reason === 'borrado-fallo'
        ? SIDECAR_MOTIVO.DESVINCULAR_FALLO
        : motivoAuthDir(borrado)
      await publicarEstado(linea, {
        at: new Date().toISOString(), connection: null, qr: null, motivo,
        statusCode: null,
        error: { code: motivo, detail: borrado.detail || 'could not delete the auth state' },
        exited: true, startedAt: new Date().toISOString()
      })
      orca.log(`sidecar not unlinked (${motivo}): ${borrado.detail || ''}`)
      return { ok: false, code: motivo, detail: borrado.detail || '' }
    }
    orca.log(`sidecar unlinked: auth state removed from ${borrado.dir}`)
    let relanzar = linea
    if (porElDueno && linea.carpeta) {
      // La linea sale. Si era la principal, la siguiente pasa a serlo: su estado se muda a
      // la clave de siempre. Si era la ultima, se espera un QR nuevo, como siempre.
      const eraPrincipal = principal() === linea.carpeta
      lineas.delete(linea.carpeta)
      registro = registro.filter((r) => r.carpeta !== linea.carpeta)
      delete estadosSecundarios[linea.carpeta]
      relanzar = registro.length ? null : agregarLinea()
      const nueva = principal()
      if (eraPrincipal) {
        ultimoPrincipal = (nueva !== null && estadosSecundarios[nueva]) || estadoLimpio()
        if (nueva !== null) delete estadosSecundarios[nueva]
      }
      await publicarRegistro()
      await publicarSecundarios()
    }
    if (!relanzar) return { ok: true, code: SIDECAR_VEREDICTO.DESVINCULADO }
    const arranque = await arrancarLinea(relanzar)
    // El borrado SI ocurrio: la sesion quedo revocada aunque el relanzamiento falle.
    // Se contesta que si, y el motivo del arranque fallido ya viaja en la clave
    // `sidecar` con su propio codigo, que es donde el panel lo sabe leer.
    return arranque.ok
      ? { ok: true, code: SIDECAR_VEREDICTO.DESVINCULADO }
      : { ok: true, code: SIDECAR_VEREDICTO.DESVINCULADO, arranque: arranque.code }
  }

  async function reintentarSidecar (pedido) {
    // Lo que no llego a resolverse se resuelve y se lanza entero, como al arrancar.
    const linea = lineasListas ? lineaDelPedido(pedido) : null
    if (lineasListas && !linea) return lineaDesconocida(pedido)
    const arranque = linea ? await arrancarLinea(linea) : await arrancarSidecar()
    return arranque.ok
      ? { ok: true, code: SIDECAR_VEREDICTO.REINTENTADO }
      : { ok: false, code: arranque.code, detail: arranque.detail || '' }
  }

  /** El tipo de una linea, en su entrada del registro. Solo los tipos habilitados: el
   *  personal existe en el contrato y se rechaza con su codigo hasta la parte 2. */
  async function cambiarTipo (pedido) {
    const tipo = pedido?.tipo
    if (!TIPOS_DE_LINEA.includes(tipo)) {
      return { ok: false, code: SIDECAR_VEREDICTO.TIPO_INVALIDO,
        detail: String(tipo ?? '').slice(0, 40) }
    }
    if (!TIPOS_HABILITADOS.includes(tipo)) {
      return { ok: false, code: SIDECAR_VEREDICTO.TIPO_NO_DISPONIBLE }
    }
    const linea = lineasListas ? lineaDelPedido(pedido) : null
    const entrada = linea ? entradaDe(linea) : null
    if (!entrada) return lineaDesconocida(pedido)
    entrada.tipo = tipo
    await publicarRegistro()
    return { ok: true, code: SIDECAR_VEREDICTO.TIPO_GUARDADO, carpeta: entrada.carpeta, tipo }
  }

  /** Vincular una linea MAS: su carpeta `nueva-...` y su sidecar, que pide su QR. Nunca
   *  dos a la vez: si ya hay una esperando su QR, se contesta esa. */
  async function vincularLinea () {
    if (!lineasListas || baseAuth === null) {
      return { ok: false, code: SIDECAR_VEREDICTO.SIN_LINEAS, detail: '' }
    }
    const esperando = registro.find((r) => !r.cuenta)
    if (esperando) return { ok: true, code: SIDECAR_VEREDICTO.VINCULANDO, carpeta: esperando.carpeta }
    const linea = agregarLinea()
    await publicarRegistro()
    const arranque = await arrancarLinea(linea)
    return arranque.ok
      ? { ok: true, code: SIDECAR_VEREDICTO.VINCULANDO, carpeta: linea.carpeta }
      : { ok: false, code: arranque.code, detail: arranque.detail || '', carpeta: linea.carpeta }
  }

  /** El vigia de un canal panel -> worker, con su disciplina de exactamente una vez.
   *
   *  Se escribio UNA vez y la usan los dos canales -la sesion y el alcance- porque las
   *  dos acciones que viajan por aca son irreversibles desde el panel: desvincular
   *  borra una credencial viva, y quitar una autorizacion borra una fila que el CLI no
   *  puede reponer. Una segunda copia de esta disciplina es una segunda copia que se
   *  desincroniza, y el sintoma seria un borrado de mas.
   *
   *  `nombre` solo va al log del plugin. `acciones` es {accion -> funcion}; lo que no
   *  este ahi se contesta con `accion-desconocida`, nunca se calla: callarlo deja al
   *  panel esperando una respuesta que no va a llegar. */
  function crearVigia ({ nombre, requestKey, resultKey, vencido, desconocida, acciones }) {
    // Lo ultimo que se atendio, para que el mismo pedido no se ejecute dos veces en la
    // misma sesion del worker. Sola no alcanza: vive en RAM y un worker que se reinicio
    // la perdio, asi que el veredicto ya escrito manda sobre ella.
    let ultimoPedido = null
    let atendiendo = false

    /** Como le fue al pedido, en una clave propia que el pedido no pisa. Va emparejado
     *  al `id` del pedido: sin eso el panel no podria distinguir la respuesta a SU clic
     *  de la que quedo del clic anterior, y un "listo" viejo se leeria como el de ahora. */
    const veredicto = (pedido, extra) => guardar(orca, resultKey, {
      at: new Date().toISOString(), requestId: pedido?.id ?? null,
      action: pedido?.action ?? null, ...extra
    })

    return async function atender () {
      if (atendiendo) return
      const pedido = await leer(orca, requestKey)
      if (!pedido || typeof pedido !== 'object') return
      if (typeof pedido.id !== 'string' || typeof pedido.at !== 'string') return
      // La lapida que deja un panel que se rindio: es un pedido ya vacio, sin nada que
      // atender ni que contestar. Se limpia y listo.
      if (pedido.tombstone === true) { await guardar(orca, requestKey, null); return }
      if (pedido.id === ultimoPedido) return
      // La memoria de verdad es el veredicto, no la variable: un worker que se reinicio
      // con el pedido todavia escrito lo volveria a ejecutar, y eso es exactamente el
      // borrado de mas que no se puede permitir.
      const previo = await leer(orca, resultKey)
      if (previo && typeof previo === 'object' && previo.requestId === pedido.id) {
        ultimoPedido = pedido.id
        await guardar(orca, requestKey, null)
        return
      }
      ultimoPedido = pedido.id
      // Se borra ANTES de actuar, igual que el pedido de sync: la accion tarda un viaje
      // a un subproceso, y en ese rato el vigia vuelve a mirar.
      await guardar(orca, requestKey, null)

      const edad = Date.now() - Date.parse(pedido.at)
      if (!(edad >= 0) || edad > PETICION_TTL_MS) {
        await veredicto(pedido, { ok: false, code: vencido, detail: '' })
        return
      }

      atendiendo = true
      try {
        const accion = acciones[pedido.action]
        const r = accion
          ? await accion(pedido)
          : { ok: false, code: desconocida, detail: String(pedido.action ?? '').slice(0, 60) }
        await veredicto(pedido, r)
      } catch (error) {
        // Lo que reviente aca tiene que llegar al panel. Sin esto una excepcion a mitad
        // de la accion se la come el catch del setInterval, y el clic no deja rastro:
        // el usuario queda mirando un boton que ya volvio de "…" sin decir nada.
        orca.log(`${nombre} request ${pedido.action} failed: ${error.message}`)
        await veredicto(pedido, { ok: false, code: motivoDe(error),
          detail: String(error?.message ?? error).slice(0, 300) })
      } finally {
        atendiendo = false
      }
    }
  }

  /** Lo que el panel pidio sobre la sesion. Desvincular DOS veces no es desvincular:
   *  la segunda se lleva puesta la sesion nueva que el usuario acaba de escanear, asi
   *  que "una sola vez" es una condicion de correccion y no una optimizacion. */
  const atenderPedidoSidecar = crearVigia({
    nombre: 'sidecar',
    requestKey: SIDECAR_REQUEST_KEY,
    resultKey: SIDECAR_RESULT_KEY,
    vencido: SIDECAR_VEREDICTO.VENCIDO,
    desconocida: SIDECAR_VEREDICTO.ACCION_DESCONOCIDA,
    acciones: {
      [SIDECAR_ACCION.DESVINCULAR]: pedidoDelPanel((pedido) => desvincularSidecar(pedido)),
      [SIDECAR_ACCION.REINTENTAR]: pedidoDelPanel((pedido) => reintentarSidecar(pedido)),
      [SIDECAR_ACCION.VINCULAR]: pedidoDelPanel(() => vincularLinea()),
      [SIDECAR_ACCION.TIPO]: pedidoDelPanel((pedido) => cambiarTipo(pedido)),
      [SIDECAR_ACCION.LIBRETA]: pedidoDelPanel(async (pedido) => {
        const r = await reintentarSidecar(pedido)
        // Solo si la sesion se relanzo: sin sidecar nuevo no llega ninguna libreta.
        if (r.ok) {
          libretaHasta = Date.now() + LIBRETA_VENTANA_MS
          libretaConectada = false
        }
        return r
      })
    }
  })

  /** Quitar una autorizacion, de verdad y en los dos registros.
   *
   *  El panel no puede: solo ve su `storage.json`, y borrar ahi descubre la fila de
   *  `scope.db` que sigue abajo — la conversacion reaparece autorizada mientras el panel
   *  dice que la quito. `wa-scope rm` borra en los dos (bin/wa-scope:858-865).
   *
   *  El CLI corre PRIMERO y el storage se reconcilia despues: al reves, un CLI que falla
   *  dejaria el panel sin la fila y el alcance con ella, que es la misma mentira con
   *  otra cara. */
  async function quitarAlcance (pedido) {
    const jid = pedido?.jid
    // El nombre visible no es identidad: cambia y se repite (§11-A1), y `wa-scope rm`
    // resuelve un nombre por parecido. Adivinar aca seria quitarle el permiso a la
    // conversacion equivocada sin decirlo.
    if (typeof jid !== 'string' || !jid.includes('@') || jid.length > 160) {
      return { ok: false, code: SCOPE_VEREDICTO.JID_INVALIDO,
        detail: String(jid ?? '').slice(0, 60) }
    }
    // Con varias lineas el panel quita en la linea que esta mirando (`linea`). Solo una
    // cuenta con forma de cuenta llega a la linea de comandos.
    const linea = pedido?.linea
    if (linea !== undefined && linea !== null &&
      (typeof linea !== 'string' || !LINEA_RE.test(linea))) {
      return { ok: false, code: SCOPE_VEREDICTO.LINEA_INVALIDA, detail: String(linea).slice(0, 40) }
    }
    const s = await settings()
    // Quitar lo que ya no esta no es un error: `wa-scope rm` con un jid que no esta en
    // el registro borra cero filas y sale con 0. El usuario pidio que no estuviera.
    await run(join(s.toolsDir || TOOLS, 'wa-scope'), ['rm', jid, ...(linea ? ['--line', linea] : [])])
    // El alcance de otra linea vive aparte en el storage, y el CLI ya lo quito de ahi: el
    // de la principal (`scope`) no se toca aunque tenga el mismo jid.
    if (linea) return { ok: true, code: SCOPE_VEREDICTO.QUITADO }
    const actual = await scope()
    // SOLO si la llave esta. Una lectura que el host rechazo devuelve `{}`, y guardar
    // eso borraria TODAS las autorizaciones por culpa de una lectura fallida.
    if (jid in actual) {
      delete actual[jid]
      await saveScope(actual)
    }
    orca.log(`scope removed for one chat (${Object.keys(actual).length} left)`)
    return { ok: true, code: SCOPE_VEREDICTO.QUITADO }
  }

  /** Quitar una regla de texto, de verdad y en los dos registros.
   *
   *  Las reglas que se crean con el CLI viven en `scope.db` (tabla `route`) y cada sync las
   *  vuelve a empujar al panel (`rutas_efectivas`, bin/wa-scope). Quitarla solo del storage
   *  del panel dejaba la fila de la base debajo: la regla reaparecia en el siguiente sync,
   *  igual que una autorizacion que se creia revocada. `wa-scope route --remove` borra la
   *  de la base y solo el worker puede ejecutarlo.
   *
   *  El CLI corre PRIMERO y el storage se reconcilia despues: al reves, un CLI que falla
   *  dejaria el panel sin la regla y la base con ella. */
  async function quitarRegla (pedido) {
    const patron = typeof pedido?.pattern === 'string' ? pedido.pattern.trim().toLowerCase() : ''
    if (patron.length === 0 || patron.length > PATRON_MAX || !PATRON_RE.test(patron)) {
      return { ok: false, code: SCOPE_VEREDICTO.PATRON_INVALIDO }
    }
    const s = await settings()
    // La forma `--remove=<patron>` y no dos argumentos: un patron que empiece por `-` se
    // leeria como otra bandera. Quitar lo que ya no esta no es un error: borra cero filas
    // y sale con 0.
    await run(join(s.toolsDir || TOOLS, 'wa-scope'), ['route', `--remove=${patron}`])
    const reglas = await leer(orca, ROUTES_KEY)
    // SOLO si la lista se leyo. Una lectura que el host rechazo devuelve null, y guardar
    // una lista vacia borraria TODAS las reglas por culpa de una lectura fallida.
    if (Array.isArray(reglas)) {
      const quedan = reglas.filter((r) =>
        String(r?.pattern ?? '').trim().toLowerCase() !== patron)
      // Sin `guardar()`, que se traga el fallo: una regla que sigue en el storage no se
      // puede contar como quitada.
      if (quedan.length !== reglas.length) {
        await orca.host.call('storage.set', { key: ROUTES_KEY, value: quedan })
      }
    }
    orca.log('route rule removed')
    return { ok: true, code: SCOPE_VEREDICTO.REGLA_QUITADA }
  }

  // El catalogo de proyectos: lo que el panel pide (buscar, aceptar, quitar, anotar) entra
  // por el MISMO canal que el alcance, que es de la misma familia -a que conversacion y a
  // que proyecto se le deja actuar- y asi no se suma un sondeo al host cada 3 s: el worker
  // muere a los 64 llamados sin confirmar. `orca` corre sin la valla, como el resto de lo
  // que no es del plugin.
  const correrOrca = (cmd, args, { timeoutMs = 15000 } = {}) => {
    const m = mandoSinValla(cmd, args)
    return run(m.cmd, m.args, { timeoutMs })
  }
  const catalogo = crearCatalogo({
    orca, leer: (key) => leer(orca, key), guardar: (key, value) => guardar(orca, key, value),
    correr: (cmd, args) => correrOrca(cmd, args),
    motivoDe, resembrar
  })
  // "Atender ahora" abre al agente de casos en el momento, por el mismo camino que el tick
  // (`wa-scope agente lanzar`), sin la valla: el hijo ejecuta la CLI de Orca.
  const lanzarTriage = crearLanzadorTriage({ correr: correrOrca, herramienta: (nombre) => tool(nombre) })
  // Las cuentas de Claude que Ajustes ofrece para el bot, por la misma CLI.
  const listarCuentas = crearListaCuentas({ correr: correrOrca })
  // Las automatizaciones del plugin (tick y triage): Orca las recrea apagadas tras cada
  // nueva aprobacion. Se encienden al arrancar y en cada vuelta de la salud, las que el
  // manifiesto declara y ninguna otra. La carpeta del plugin se lee dentro de la valla.
  let manifiesto = null
  try {
    manifiesto = JSON.parse(readFileSync(join(PLUGIN_DIR, 'orca-plugin.json'), 'utf8'))
  } catch (error) {
    orca.log(`automations: manifest not readable: ${String(error?.message ?? error).slice(0, 160)}`)
  }
  const encender = crearEncendedor({ correr: correrOrca, manifiesto })
  const encenderAutomatizaciones = () => detenido ? null : encender().then((r) => {
    if (r.enabled.length || !r.ok) {
      orca.log(`automations: ${r.code}; enabled ${r.enabled.join(', ') || 'none'}` +
        (r.failed.length ? `; failed ${r.failed.join(', ')}` : ''))
    }
  }).catch((error) => orca.log(`automations failed: ${error.message}`))
  // Despues de resolver la casa de Orca: sin ella la CLI le preguntaria a otro runtime.
  // El ritmo de la atencion (ritmo-triage): el selector del panel (`syncMinutes`) fija
  // tambien el cron de la automatizacion `triage`. Orca la recrea con el cron del
  // manifiesto en cada aprobacion, asi que se vuelve a poner al arrancar y en cada vuelta
  // de la salud; un cambio en el panel vale en segundos. El panel lo lee en el latido.
  const ajustarRitmo = crearAjustadorRitmo({ correr: correrOrca, manifiesto })
  let ritmoEnVuelo = false
  let ritmoPedido = null
  let ritmoDicho = ''
  async function ajustarTriage () {
    if (detenido || ritmoEnVuelo) return
    ritmoEnVuelo = true
    try {
      const minutos = Math.round((await intervaloSync(orca).catch(() => SYNC_MS)) / 60000)
      ritmoPedido = minutos
      const r = await ajustarRitmo(minutos)
      if (detenido) return
      const dicho = JSON.stringify([r.minutes, r.cron, r.ok, r.ok ? 'ok' : r.code])
      if (r.code === 'ajustado' || !r.ok) {
        orca.log(`automations: triage ${r.code}; ${r.cron ?? 'no cron'}`)
      }
      if (dicho === ritmoDicho) return
      ritmoDicho = dicho
      ritmoTriage = { minutes: r.minutes, cron: r.cron, ok: r.ok, code: r.code }
      await latir()
    } finally {
      ritmoEnVuelo = false
    }
  }
  const automatizacionesAlDia = () => Promise.resolve(encenderAutomatizaciones())
    .then(() => ajustarTriage())
    .catch((error) => orca.log(`automations pace failed: ${error.message}`))
  // Un cambio del selector: se mira con los pedidos del panel, y tambien se reprograma la
  // lectura de WhatsApp para que no espere el intervalo viejo.
  async function vigilarRitmo () {
    if (detenido || ritmoPedido === null || ritmoEnVuelo) return
    const minutos = Math.round((await intervaloSync(orca).catch(() => SYNC_MS)) / 60000)
    if (minutos === ritmoPedido) return
    programarSync().catch((error) => orca.log(`sync scheduling failed: ${error.message}`))
    await ajustarTriage()
  }
  casaResuelta.then(automatizacionesAlDia)
  const pararAutomatizaciones = programarSalud(automatizacionesAlDia)

  const atenderPedidoScope = crearVigia({
    nombre: 'scope',
    requestKey: SCOPE_REQUEST_KEY,
    resultKey: SCOPE_RESULT_KEY,
    vencido: SCOPE_VEREDICTO.VENCIDO,
    desconocida: SCOPE_VEREDICTO.ACCION_DESCONOCIDA,
    // Las acciones del dueno sobre el tablero (T6) viajan por este mismo canal: otra
    // clave de pedido seria otra lectura de storage en cada vuelta del vigia, y el
    // worker tiene un presupuesto de llamadas al host.
    acciones: {
      [SCOPE_ACCION.QUITAR]: (pedido) => quitarAlcance(pedido),
      [SCOPE_ACCION.REGLA_QUITAR]: (pedido) => quitarRegla(pedido),
      ...crearAccionesCaso({ run, motivoDe, lanzarTriage, llaveAprobador,
        herramienta: (nombre) => tool(nombre) }),
      [CUENTAS_ACCION]: () => listarCuentas(),
      ...catalogo.acciones,
      [SKILLS_ACCION.ESTADO]: () => pedirSkills({ op: 'estado' }),
      [SKILLS_ACCION.INSTALAR]: (pedido) => pedirSkills({ op: 'instalar' }, pedido),
      [SKILLS_ACCION.QUITAR]: (pedido) => pedirSkills({ op: 'quitar' }, pedido)
    }
  })

  /** Lo que la pestana Skills pide. El destino es `target: 'global'` o el id de un proyecto:
   *  la ruta sale del catalogo aceptado y nunca del pedido, asi que el panel no puede hacer
   *  escribir en una carpeta que el dueno no eligio. Un proyecto que ya salio del catalogo
   *  se busca en el estado que dejo el worker, solo para quitar: `skills.mjs` borra
   *  unicamente lo que el plugin anoto que escribio. */
  async function pedirSkills (base, pedido = {}) {
    const proyectos = leerCatalogo(await leer(orca, PROJECTS_KEY))
    const op = { ...base, proyectos }
    if (base.op !== 'estado') {
      if (typeof pedido.skill !== 'string' || pedido.skill.length > 64) {
        return { ok: false, code: SKILLS_VEREDICTO.ARGUMENTOS }
      }
      op.skill = pedido.skill
      if (pedido.target === 'global') {
        op.target = { scope: 'global' }
      } else {
        let p = proyectos.find((x) => x.id === pedido.project)
        if (!p && base.op === 'quitar') {
          const estado = await leer(orca, SKILLS_STATUS_KEY)
          const t = (estado?.skills || []).flatMap((s) => s?.targets || [])
            .find((x) => x?.scope === 'project' && x.project === pedido.project)
          if (t && typeof t.path === 'string') p = { id: t.project, name: t.name, path: t.path }
        }
        if (!p || typeof pedido.project !== 'string') {
          return { ok: false, code: SKILLS_VEREDICTO.PROYECTO_NO_EXISTE }
        }
        op.target = { scope: 'project', project: p.id, path: p.path, name: p.name }
      }
      if (base.op === 'quitar') op.force = pedido.force === true
    }
    const r = await skillsFuera(op)
    if (r.estado) await guardar(orca, SKILLS_STATUS_KEY, r.estado)
    if (base.op !== 'estado') orca.log(`skills: ${base.op} ${op.skill} -> ${r.code}`)
    const { estado, ...veredicto } = r
    return veredicto
  }

  /** Lo que el panel pide sobre la llave de Jev. La llave llega en el pedido y nada mas:
   *  el vigia lo borra de storage ANTES de actuar, asi que en disco vive solo el rato
   *  entre la escritura del panel y la siguiente vuelta (3 s). Ni el veredicto ni el
   *  estado ni un log la repiten. */
  async function guardarLlaveJev (pedido) {
    const valor = typeof pedido.value === 'string' ? pedido.value.trim() : ''
    if (!llaveValida(valor)) return { ok: false, code: JEV_VEREDICTO.LLAVE_INVALIDA }
    try {
      await orca.host.call('secrets.set', { key: JEV_SECRET_NAME, value: valor })
    } catch (error) {
      // Sin el mensaje del host: a una llave no se le da la oportunidad de aparecer en un
      // log por la puerta de un error.
      orca.log(`secrets.set failed (${motivoDe(error)})`)
      return { ok: false, code: JEV_VEREDICTO.BOVEDA_FALLO }
    }
    const habilitado = (await leer(orca, JEV_ENABLED_KEY)) === true
    const st = await aplicarJev(orca, habilitado, valor, { forzar: true })
    return st.mirror === 'fallo'
      ? { ok: false, code: JEV_VEREDICTO.ESPEJO_FALLO, mirror: st.mirror }
      : { ok: true, code: JEV_VEREDICTO.GUARDADA, mirror: st.mirror }
  }

  async function quitarLlaveJev () {
    try {
      await orca.host.call('secrets.delete', { key: JEV_SECRET_NAME })
    } catch (error) {
      orca.log(`secrets.delete failed (${motivoDe(error)})`)
      return { ok: false, code: JEV_VEREDICTO.BOVEDA_FALLO }
    }
    const habilitado = (await leer(orca, JEV_ENABLED_KEY)) === true
    const st = await aplicarJev(orca, habilitado, null)
    return st.mirror === 'fallo'
      ? { ok: false, code: JEV_VEREDICTO.ESPEJO_FALLO, mirror: st.mirror }
      : { ok: true, code: JEV_VEREDICTO.QUITADA, mirror: st.mirror }
  }

  async function activarJev (pedido) {
    if (typeof pedido.enabled !== 'boolean') {
      return { ok: false, code: JEV_VEREDICTO.ARGUMENTOS_INVALIDOS }
    }
    await guardar(orca, JEV_ENABLED_KEY, pedido.enabled)
    // Encender es un gesto explicito del dueno, igual que guardar la llave: con la llave
    // ya en la boveda reemplaza un `jev.env` escrito a mano antes de que el plugin lo
    // administrara. Sin esto el dueno guardaba la llave con Jev apagado, lo encendia, y
    // se quedaba en `ajeno` sin nada que escribir en el campo.
    const st = await aplicarJev(orca, pedido.enabled, await leerLlaveJev(orca, estadoJev),
      { forzar: pedido.enabled })
    const code = pedido.enabled ? JEV_VEREDICTO.ACTIVADO : JEV_VEREDICTO.DESACTIVADO
    return st.mirror === 'fallo'
      ? { ok: false, code: JEV_VEREDICTO.ESPEJO_FALLO, mirror: st.mirror }
      : { ok: true, code, mirror: st.mirror }
  }

  const atenderPedidoJev = crearVigia({
    nombre: 'jev',
    requestKey: JEV_REQUEST_KEY,
    resultKey: JEV_RESULT_KEY,
    vencido: JEV_VEREDICTO.VENCIDO,
    desconocida: JEV_VEREDICTO.ACCION_DESCONOCIDA,
    acciones: {
      [JEV_ACCION.GUARDAR]: (pedido) => guardarLlaveJev(pedido),
      [JEV_ACCION.QUITAR]: () => quitarLlaveJev(),
      [JEV_ACCION.ACTIVAR]: (pedido) => activarJev(pedido)
    }
  })

  const pedidoTimer = setInterval(() => {
    atenderPedido().catch((error) => orca.log(`sync request failed: ${error.message}`))
    atenderPedidoSidecar()
      .catch((error) => orca.log(`sidecar request failed: ${error.message}`))
    atenderPedidoScope()
      .catch((error) => orca.log(`scope request failed: ${error.message}`))
    atenderPedidoJev()
      .catch((error) => orca.log(`jev request failed: ${error.message}`))
    vigilarRitmo().catch((error) => orca.log(`automations pace failed: ${error.message}`))
  }, PETICION_MS)
  if (typeof pedidoTimer.unref === 'function') pedidoTimer.unref()

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

  // Los avisos de Orca por WhatsApp (avisos-orca): el estado de cada agente de los OTROS
  // proyectos, y `wa-scope orca-aviso` cuando uno pasa a esperar y el dueno lo encendio.
  const avisosOrca = crearAvisosOrca({
    leer: (key) => leer(orca, key),
    guardar: (key, value) => guardar(orca, key, value),
    lanzar: async (args) => run(await tool('wa-scope'), args, { timeoutMs: AVISO_PLAZO_MS }),
    llave: manifiesto && manifiesto.publisher && manifiesto.id
      ? `${manifiesto.publisher}.${manifiesto.id}` : null,
    log: (m) => orca.log(m)
  })

  orca.events.on('agent.status.changed', (payload) => {
    orca.log(`agent ${payload.state} in ${payload.worktreeId ?? 'no worktree'}`)
    avisosOrca.recibir(payload)
  })

  // Al desactivar el plugin los timers se van con el: si no, siguen leyendo WhatsApp
  // despues de que el usuario dijo que no. El sidecar tambien: el grupo de procesos ya
  // lo mata Orca si el WORKER muere entero (docs/ENCARGO...§2), pero un apagado
  // normal del plugin no mata al worker, asi que aca se lo pide explicito.
  return () => {
    detenido = true
    clearTimeout(syncTimer)
    clearInterval(pedidoTimer)
    clearInterval(latidoTimer)
    pararSalud()
    pararAutomatizaciones()
    ingesta.parar()
    avisosOrca.parar()
    // Todas las lineas, cada una con su reinicio pendiente.
    for (const linea of lineas.values()) {
      clearTimeout(linea.reinicioTimer)
      linea.apagar()
    }
  }
}
