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
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { HARNESS_KEY } from './harness.mjs'

// Las herramientas viajan dentro del plugin. Antes se buscaban en el PATH del usuario,
// lo que solo funcionaba en la maquina donde alguien las habia enlazado a mano.
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const TOOLS = join(PLUGIN_DIR, 'bin')
const SCOPE_KEY = 'scope'          // { [chatJid]: ScopeEntry }
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

/** El nombre del agente lo define quien usa el plugin. No viene con uno puesto.
 *
 *  `sidecarPath` y `authDirResolverPath` son internos, como `toolsDir`: no los pisa el
 *  usuario, existen para que las pruebas puedan apuntar el lanzamiento a un guion de
 *  mentira en vez del bundle real de Baileys o del resolvedor real. Hace falta uno por
 *  cada hijo porque fallan por motivos distintos y el panel los traduce distinto. */
const DEFAULT_SETTINGS = { agentName: '', signMessages: true, toolsDir: TOOLS,
  sidecarPath: join(PLUGIN_DIR, 'sidecar', 'sidecar.cjs'),
  authDirResolverPath: join(PLUGIN_DIR, 'sidecar', 'resolve-auth-dir.mjs') }

/** Corre `wa-read doctor` y avisa por notificacion si algo falta. */
async function checkSystem(orca, toolsDir = TOOLS) {
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
  const accionables = failed.filter((c) => c.code !== 'no-transport')

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

  if (!legible) {
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
  if (!accionables.length) return

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

function run(cmd, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
        env: ENV_HERRAMIENTAS || process.env },
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
function sembrarFuera(toolsDir) {
  const guion = join(PLUGIN_DIR, 'harness.mjs')
  return new Promise((resolve) => {
    const mSiembra = mandoSinValla(process.execPath, [guion, PLUGIN_DIR, toolsDir])
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

/** Lo que el panel puede pedirle al worker sobre la sesion, y como se contesta.
 *
 *  `desvincular` es irreversible: borra una CREDENCIAL VIVA
 *  (docs/ENCARGO-TRANSPORTE-UNICO.md §11-F1). `reintentar` no destruye nada, solo
 *  vuelve a lanzar lo que no arranco. Se nombran en el mismo idioma que el resto de
 *  los codigos estables del contrato, y no en el del panel, porque el panel los
 *  traduce por codigo (§11-E1). */
const SIDECAR_ACCION = Object.freeze({
  DESVINCULAR: 'desvincular',
  REINTENTAR: 'reintentar'
})

/** Codigos del veredicto que el worker deja para el panel. `vencido` no es un fallo
 *  del worker: es un pedido de otra sesion, que no se atiende pero tampoco se calla —
 *  callarlo deja al panel esperando una respuesta que no va a llegar. */
const SIDECAR_VEREDICTO = Object.freeze({
  DESVINCULADO: 'desvinculado',
  REINTENTADO: 'reintentado',
  VENCIDO: 'vencido',
  ACCION_DESCONOCIDA: 'accion-desconocida'
})

/** Lo que el panel puede pedirle al worker sobre el alcance, y como se contesta. Mismos
 *  codigos estables que el resto del contrato: el panel los traduce por codigo y nunca
 *  por el texto (§11-E1). */
const SCOPE_ACCION = Object.freeze({ QUITAR: 'quitar' })

const SCOPE_VEREDICTO = Object.freeze({
  QUITADO: 'quitado',
  VENCIDO: 'vencido',
  ACCION_DESCONOCIDA: 'accion-desconocida',
  // `wa-scope rm` acepta tambien un trozo de NOMBRE y ahi resuelve por parecido. El
  // nombre visible no es identidad -cambia y se repite (§11-A1)-, asi que lo que no sea
  // un jid se rechaza en vez de adivinar cual conversacion se queria quitar.
  JID_INVALIDO: 'jid-invalido'
})

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
  spawnFn = spawn, env = process.env }) {
  let estado = { at: new Date().toISOString(), connection: null, qr: null,
    motivo: null, statusCode: null, error: null, exited: false,
    // Lo que el sidecar guardo y lo que desalojo, en CONTEOS. Un tope de retencion que
    // muerde en silencio deja mensajes sin cuerpo sin que nadie sepa por que
    // (docs/ENCARGO-TRANSPORTE-UNICO.md §11-F2), y "llegaron 40 y se guardaron 0" es
    // lo unico que distingue "no hay ninguna conversacion autorizada" de "esto no
    // funciona". Nunca lleva contenido: ni un cuerpo, ni un numero, ni un remitente.
    store: null,
    startedAt: new Date().toISOString() }
  const escribir = (parcial) => {
    estado = { ...estado, ...parcial, at: new Date().toISOString() }
    return guardar(orca, SIDECAR_KEY, estado)
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
        WA_SIDECAR_TOOLS_DIR: toolsDir },
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

  proceso.on('exit', (code, signal) => {
    // Que el worker lo haya apagado a proposito no es una caida: `apagar()` marca esta
    // bandera ANTES de matarlo. Sin la distincion, un apagado normal del plugin se
    // veia igual que un crash del sidecar en el panel.
    if (detenidoPorWorker) return
    escribir({ exited: true, motivo: SIDECAR_MOTIVO.CAYO,
      error: { code: SIDECAR_MOTIVO.CAYO,
        detail: `sidecar exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})` } })
  })

  return () => {
    detenidoPorWorker = true
    if (proceso && !proceso.killed) proceso.kill()
  }
}

// Cada cuanto late el worker, y a partir de cuando el panel lo da por ido. El panel
// relee cada 8 s, asi que 5 s de latido y 30 s de tolerancia no marcan muerto a un
// worker que solo estaba ocupado en una llamada de 30 s a la CLI de Orca.
const LATIDO_MS = 5 * 1000
export const LATIDO_VENCE_MS = 30 * 1000

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
  const latir = () => guardar(orca, BEAT_KEY,
    { at: new Date().toISOString() })
    .catch((error) => orca.log(`heartbeat failed: ${error.message}`))
  latir()
  const latidoTimer = setInterval(latir, LATIDO_MS)
  if (typeof latidoTimer.unref === 'function') latidoTimer.unref()

  // Declarado ACA arriba, y no mas abajo junto a `syncTimer`: lo necesitan tambien las
  // cadenas asincronas de mas arriba -el sidecar entre ellas-, y sin la bandera un
  // `apagar()` que llega antes de que una de esas termine dejaria un proceso lanzado
  // DESPUES de que el plugin ya dijo que se apagaba.
  let detenido = false
  let apagarSidecar = () => {}

  const dirHerramientas = async () => (await settings()).toolsDir || TOOLS

  // El sync automatico sale del mismo directorio que los comandos. Antes iba fijo a
  // bin/: quien movia toolsDir tenia la mitad del plugin leyendo de otro lado.
  const sincronizar = async (trigger) =>
    sync(orca, { toolsDir: await dirHerramientas(), trigger })

  // Antes que nada lo que necesita todo lo demas: donde esta el Orca vivo. Se vuelve a
  // resolver en cada arranque porque el runtime cambia de socket en cada arranque.
  dirHerramientas()
    .then((dir) => resolverCasaOrca(join(dir, 'wa-scope')))
    .then((casa) => orca.log(casa && casa.path
      ? `orca runtime home: ${casa.path} (${casa.source || 'probe'})`
      : `orca runtime home not resolved; tried: ${(casa && casa.tried || []).join(', ') || 'nothing'}`))
    .catch((error) => orca.log(`orca runtime home failed: ${error.message}`))

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

  // El sidecar de Baileys (T3): el UNICO transporte de esta rebanada. El directorio de
  // auth se resuelve en un subproceso -mismo motivo que el arnes, arriba: el worker no
  // puede leer el userData- y recien con eso se lanza. `sidecarPath` sale de settings
  // para que las pruebas lo apunten a un guion de mentira; en producción nunca se pisa
  // y cae al bundle real (`DEFAULT_SETTINGS.sidecarPath`).
  /** El estado limpio de la clave que lee el panel: sin sesion, sin QR y sin falla.
   *
   *  Se escribe ANTES de cualquier relanzamiento, y no se deja para que lo pise el
   *  `lanzarSidecar` de despues: entre apagar el sidecar viejo y tener el nuevo hay un
   *  viaje a un subproceso, y en ese hueco el panel sondea. Sin esto, desvincular
   *  dejaba la pantalla diciendo "WhatsApp esta conectado" durante ese hueco, que es
   *  justo lo que el usuario acababa de pedir que dejara de ser cierto. */
  const limpiarEstadoSidecar = () => guardar(orca, SIDECAR_KEY, {
    at: new Date().toISOString(), connection: null, qr: null, motivo: null,
    statusCode: null, error: null, exited: false, startedAt: null
  })

  /** Resuelve el auth dir y lanza el sidecar. Una sola implementacion para el arranque
   *  del plugin y para lo que pida el panel: si el reintento tomara otro camino, seria
   *  otro arranque, con otros motivos, y el panel los traduciria distinto. */
  async function arrancarSidecar () {
    if (detenido) return { ok: false, code: SIDECAR_MOTIVO.NO_ARRANCO, detail: 'plugin detenido' }
    const s = await settings()
    if (detenido) return { ok: false, code: SIDECAR_MOTIVO.NO_ARRANCO, detail: 'plugin detenido' }
    const resuelto = await resolverAuthDir(PLUGIN_DIR, s.authDirResolverPath)
    if (detenido) return { ok: false, code: SIDECAR_MOTIVO.NO_ARRANCO, detail: 'plugin detenido' }
    if (!resuelto.ok || !resuelto.dir) {
      const motivo = motivoAuthDir(resuelto)
      await guardar(orca, SIDECAR_KEY, {
        at: new Date().toISOString(), connection: null, qr: null,
        motivo, statusCode: null,
        error: { code: motivo,
          detail: resuelto.detail || 'could not resolve the auth directory' },
        exited: true, startedAt: new Date().toISOString()
      })
      orca.log(`sidecar not started (${motivo}): ${resuelto.detail || ''}`)
      return { ok: false, code: motivo, detail: resuelto.detail || '' }
    }
    // El de antes se apaga a proposito: `lanzarSidecar` marca la bandera para que ese
    // final no se reporte como una caida. Dos sidecars vivos sobre el mismo auth state
    // se pisarian las credenciales.
    apagarSidecar()
    // `s.toolsDir` y no `TOOLS`: quien mueve el directorio de herramientas tiene que
    // moverlo entero, o el sidecar le pregunta por el alcance a una instalacion
    // distinta de la que lee el resto del plugin (§11-E4).
    apagarSidecar = lanzarSidecar({ orca, scriptPath: s.sidecarPath, authDir: resuelto.dir,
      toolsDir: s.toolsDir || TOOLS })
    return { ok: true, dir: resuelto.dir }
  }

  arrancarSidecar().catch((error) => orca.log(`sidecar launch failed: ${error.message}`))

  // Y traer las conversaciones ya: en una instalacion nueva el panel arranca vacio y
  // el usuario no tiene de donde sacarlas.
  sincronizar('activate').catch((error) => orca.log(`first sync failed: ${error.message}`))

  // Se reprograma en cada vuelta en vez de fijar el intervalo una sola vez: es el
  // ajuste que acota cuanto tarda un mensaje en llegarle al precheck, y cambiarlo en
  // el panel tiene que valer ya, no al proximo arranque de Orca.
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
  /** Desvincular: apagar, borrar la credencial, y recien entonces volver a empezar.
   *
   *  Se relanza en vez de quedarse apagado porque desvincular existe para volver a
   *  vincular —quien escaneo con el telefono equivocado quiere escanear con el otro—,
   *  y un estado que exige un segundo boton para seguir es un estado donde hay que
   *  explicarle al usuario que hacer. Relanzando, la pantalla vuelve exactamente al
   *  estado que ya sabe dibujar: esperando el codigo, y despues el codigo. */
  async function desvincularSidecar () {
    apagarSidecar()
    apagarSidecar = () => {}
    await limpiarEstadoSidecar()
    const s = await settings()
    const borrado = await resolverAuthDir(PLUGIN_DIR, s.authDirResolverPath, ['--borrar'])
    if (!borrado.ok) {
      // NO se relanza: con las credenciales intactas, el sidecar volveria a conectar la
      // MISMA sesion que el usuario acaba de pedir cortar, y el panel diria "conectado"
      // como si nada hubiera pasado. Es la peor mentira que este panel podria contar.
      const motivo = borrado.reason === 'borrado-fallo'
        ? SIDECAR_MOTIVO.DESVINCULAR_FALLO
        : motivoAuthDir(borrado)
      await guardar(orca, SIDECAR_KEY, {
        at: new Date().toISOString(), connection: null, qr: null, motivo,
        statusCode: null,
        error: { code: motivo, detail: borrado.detail || 'could not delete the auth state' },
        exited: true, startedAt: new Date().toISOString()
      })
      orca.log(`sidecar not unlinked (${motivo}): ${borrado.detail || ''}`)
      return { ok: false, code: motivo, detail: borrado.detail || '' }
    }
    orca.log(`sidecar unlinked: auth state removed from ${borrado.dir}`)
    const arranque = await arrancarSidecar()
    // El borrado SI ocurrio: la sesion quedo revocada aunque el relanzamiento falle.
    // Se contesta que si, y el motivo del arranque fallido ya viaja en la clave
    // `sidecar` con su propio codigo, que es donde el panel lo sabe leer.
    return arranque.ok
      ? { ok: true, code: SIDECAR_VEREDICTO.DESVINCULADO }
      : { ok: true, code: SIDECAR_VEREDICTO.DESVINCULADO, arranque: arranque.code }
  }

  async function reintentarSidecar () {
    const arranque = await arrancarSidecar()
    return arranque.ok
      ? { ok: true, code: SIDECAR_VEREDICTO.REINTENTADO }
      : { ok: false, code: arranque.code, detail: arranque.detail || '' }
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
      [SIDECAR_ACCION.DESVINCULAR]: () => desvincularSidecar(),
      [SIDECAR_ACCION.REINTENTAR]: () => reintentarSidecar()
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
    const s = await settings()
    // Quitar lo que ya no esta no es un error: `wa-scope rm` con un jid que no esta en
    // el registro borra cero filas y sale con 0. El usuario pidio que no estuviera.
    await run(join(s.toolsDir || TOOLS, 'wa-scope'), ['rm', jid])
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

  const atenderPedidoScope = crearVigia({
    nombre: 'scope',
    requestKey: SCOPE_REQUEST_KEY,
    resultKey: SCOPE_RESULT_KEY,
    vencido: SCOPE_VEREDICTO.VENCIDO,
    desconocida: SCOPE_VEREDICTO.ACCION_DESCONOCIDA,
    acciones: { [SCOPE_ACCION.QUITAR]: (pedido) => quitarAlcance(pedido) }
  })

  const pedidoTimer = setInterval(() => {
    atenderPedido().catch((error) => orca.log(`sync request failed: ${error.message}`))
    atenderPedidoSidecar()
      .catch((error) => orca.log(`sidecar request failed: ${error.message}`))
    atenderPedidoScope()
      .catch((error) => orca.log(`scope request failed: ${error.message}`))
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

  orca.events.on('agent.status.changed', (payload) => {
    orca.log(`agent ${payload.state} in ${payload.worktreeId ?? 'no worktree'}`)
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
    apagarSidecar()
  }
}
