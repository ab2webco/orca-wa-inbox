// El sidecar de WhatsApp: vive FUERA de la valla de permisos del worker
// (`plugin-host-preload.ts` borra `WebSocket` y `net`/`tls` quedan prohibidos ahi
// adentro, docs/ENCARGO-TRANSPORTE-UNICO.md §1). El worker lo lanza como hijo con
// `process:spawn`, igual que `sembrarFuera` en main.mjs:689-710, pero este hijo SI
// tiene sockets reales.
//
// Todo lo que habla con el worker va por stdout: un objeto JSON por linea. El
// protocolo esta documentado en cada `emitir*` de aca abajo.
//
// Nada de esto importa Baileys arriba de todo: se resuelve adentro de `iniciar()`,
// con `import()` dinamico. Asi este archivo se puede importar solo por sus
// funciones puras -que es lo que hace la prueba- sin que haga falta resolver una
// libreria que vive en el directorio hermano de dependencias
// (`../.orca-wa-inbox-deps`, docs/ENCARGO...§3) ni abrir un socket.

import { mkdirSync, chmodSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { abrirAlmacen, rutaAlmacen, rutaMedia } from './almacen.js'
import { crearAlcance } from './alcance.js'
import { atenderSalida, ENVIO_LATIDO_MS } from './envio.js'
import { INGESTA, ingerirActualizacion, ingerirChats, ingerirContactos,
  ingerirMensaje } from './ingesta.js'
import { cuentaDeIdentidad, identidadDeSesion, identidadesPropias,
  identidadPropia } from './mensajes.js'

// El auth state es una credencial viva (docs/ENCARGO...§11-F1): en un equipo
// compartido el umask por defecto lo deja legible para cualquiera. Esto tiene que
// correr ANTES de que se cree un solo archivo.
process.umask(0o077)

// ── Motivos estables ─────────────────────────────────────────────────────────────
// El panel los traduce por codigo, nunca por el texto (bin/wa-read:126-131):
// "Cambiar el texto no rompe nada; renombrar el codigo desincroniza el panel en
// silencio." QR pendiente, sesion cerrada, sin sesion y socket caido son CUATRO
// acciones distintas que el usuario tiene que tomar, no un fallo generico
// (docs/ENCARGO-TRANSPORTE-UNICO.md §11 E2).
export const MOTIVO = Object.freeze({
  QR_PENDIENTE: 'qr-pendiente',
  SESION_CERRADA: 'sesion-cerrada',
  SIN_SESION: 'sin-sesion',
  SOCKET_CAIDO: 'socket-caido',
  REINICIO_REQUERIDO: 'reinicio-requerido',
  // Tres cierres que reintentar no cura, cada uno con su accion: 440 es otro cliente
  // usando esta misma sesion (cerrarlo, o desvincular), 403 es WhatsApp negando el
  // acceso a la cuenta, y 411 es un desacuerdo de multidispositivo que solo arregla
  // vincular de nuevo.
  SESION_REEMPLAZADA: 'sesion-reemplazada',
  ACCESO_DENEGADO: 'acceso-denegado',
  MULTIDISPOSITIVO: 'multidispositivo',
  DESCONOCIDO: 'desconocido'
})

// Los `statusCode` de `DisconnectReason` en Baileys 6.7.24 que necesita la decision
// de reconectar. Se replican como constantes locales -no se importa `DisconnectReason`
// de la libreria aca- para que `decidirTrasCierre` sea una funcion pura, probable sin
// resolver Baileys.
const CIERRE = Object.freeze({
  LOGGED_OUT: 401,
  // `badSession`: WhatsApp ya no reconoce la sesion guardada. Para el dueno es lo
  // mismo que un 401 -hay que volver a vincular- y por eso se trata igual.
  BAD_SESSION: 500,
  // connectionLost Y timedOut comparten ESTE MISMO codigo en esta version de
  // Baileys. Inventar cual de los dos fue seria mentirle al motivo que el panel
  // traduce; se lo llama por lo que es, un socket caido.
  SOCKET_CAIDO_408: 408,
  RESTART_REQUIRED: 515,
  FORBIDDEN: 403,
  MULTIDEVICE_MISMATCH: 411,
  CONNECTION_REPLACED: 440
})

// Los cierres que se reintentan un poco y despues no: con su motivo propio.
const CIERRE_CON_TOPE = Object.freeze({
  [CIERRE.CONNECTION_REPLACED]: 'sesion-reemplazada',
  [CIERRE.FORBIDDEN]: 'acceso-denegado',
  [CIERRE.MULTIDEVICE_MISMATCH]: 'multidispositivo'
})

/** Cuantas veces seguidas puede repetirse uno de esos cierres antes de rendirse. Tres
 *  alcanza para que un tropiezo aislado se cure solo y no tanto como para que un 440
 *  le arrebate la sesion al otro cliente durante horas. */
export const CIERRES_REPETIDOS_TOPE = 3

/** Que tan juntos tienen que estar para contar como "seguidos". Un 440 hoy y otro
 *  manana son dos eventos, no un bucle. */
export const CIERRES_VENTANA_MS = 10 * 60 * 1000

/** La cuenta de cierres repetidos tras un cierre nuevo. NO la reinicia un `open`, y
 *  eso es a proposito: un 440 conecta, el otro cliente reclama, cierra y vuelve a
 *  conectar. Si `open` la bajara -como baja `intento`-, el tope no llegaria nunca. */
export function repetidosTrasCierre (previo, statusCode, ahoraMs = Date.now()) {
  const mismo = previo && previo.codigo === statusCode &&
    ahoraMs - previo.ts <= CIERRES_VENTANA_MS
  return { codigo: statusCode, veces: mismo ? previo.veces + 1 : 1, ts: ahoraMs }
}

/** Como termina el sidecar cuando decide no seguir. Es CONTRATO con el worker
 *  (`SIDECAR_SALIDA` en main.mjs, y la prueba del worker compara los dos): el codigo
 *  de salida llega siempre, y la ultima linea de stdout puede llegar despues del evento
 *  de salida o no llegar.
 *
 *  Ninguno es 0 ni 1: 0 es "termino sin decir por que" y 1 es un reventon, y los dos
 *  siguen siendo caidas que el worker reinicia. */
export const SALIDA = Object.freeze({
  // La sesion guardada esta muerta (401/500). El worker borra `wa-auth` por el mismo
  // camino que el boton Desvincular y relanza: el sidecar nuevo arranca sin `me`,
  // Baileys registra en vez de hacer login, y el QR aparece solo.
  CREDENCIALES_MUERTAS: 3,
  // Un cierre que reintentar no cura (403/411/440) se repitio hasta el tope. El motivo
  // ya salio por stdout; el worker lo deja escrito y NO relanza, porque relanzar es
  // exactamente el reintento que se acaba de agotar.
  RENDIDO: 4
})

/** El codigo con que sale el sidecar tras un cierre, o `null` si sigue vivo. Pura,
 *  como `decidirTrasCierre`, para que el contrato con el worker se pruebe sin socket. */
export function salidaTrasCierre (decision) {
  if (decision.reconectar) return null
  if (decision.borrarCredenciales) return SALIDA.CREDENCIALES_MUERTAS
  return SALIDA.RENDIDO
}

const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 30000

/** Cuanto esperar antes del intento N (1-based): exponencial y acotado. Un backoff
 *  sin tope reintentaria cada vez mas lento para siempre sobre una caida que ya se
 *  resolvio hace rato. */
export function calcularEsperaMs (intento) {
  const paso = Math.max(1, intento)
  return Math.min(BACKOFF_BASE_MS * 2 ** (paso - 1), BACKOFF_MAX_MS)
}

/** Como queda el contador de intentos tras un evento del socket. Es una funcion pura y
 *  no tres asignaciones sueltas dentro del escuchador porque la regla tiene un caso que
 *  no es obvio y que ya se equivoco una vez: un **QR tambien lo reinicia**.
 *
 *  Emparejando no hay ningun 'open' -ese es justo el estado al que todavia no se
 *  llego-, asi que si solo 'open' baja el contador, `intento` unicamente sube mientras
 *  el usuario mira el QR. WhatsApp entrega refs de emparejamiento en lotes finitos:
 *  agotado el lote Baileys CIERRA y hay que reconectar para pedir otro. Ese cierre es
 *  el ciclo normal del emparejamiento, no una caida, pero contaba como intento fallido
 *  y empujaba la espera por 1s, 2s, 4s, 8s, 16s hasta el tope de 30s. Medido en una
 *  instalacion viva: pasado el margen (QR_VIGENCIA_MS - QR_ROTACION_MS) el QR se veia
 *  vencido el resto de cada ciclo, y empeoraba cuanto mas tiempo llevaba el panel
 *  abierto. Que llegue un QR prueba que el socket llego hasta donde WhatsApp entrega
 *  refs: lo anterior funciono. */
export function intentoTrasEvento (intento, evento) {
  if (evento === 'qr' || evento === 'open') return 0
  if (evento === 'close') return intento + 1
  return intento
}

/** La decision pura tras un cierre de socket: reconectar o no, con que espera y por
 *  que motivo. No toca la red ni el disco -eso lo hace quien la llama- para que se
 *  pueda probar sin un socket vivo. */
export function decidirTrasCierre (statusCode, intento = 1, repetidos = 1) {
  if (statusCode === CIERRE.BAD_SESSION && repetidos <= CIERRES_REPETIDOS_TOPE) {
    // Baileys tambien cierra con 500 por un error pasajero del servidor ("Stream
    // Errored"): borrar al primero dejaba al dueno escaneando un QR sin motivo. Se
    // reintenta; si se repite seguido, la sesion si esta mala y abajo se tira.
    return { reconectar: true, borrarCredenciales: false,
      esperaMs: calcularEsperaMs(intento), motivo: MOTIVO.DESCONOCIDO }
  }
  if (statusCode === CIERRE.LOGGED_OUT || statusCode === CIERRE.BAD_SESSION) {
    // Reconectar con ESTAS credenciales reproduciria el mismo cierre en bucle, y
    // conservarlas es peor: con `creds.me` puesto Baileys hace login y nunca registro
    // (lib/Socket/socket.js:157-162), asi que ningun reinicio produce un QR. Hay que
    // tirarlas; lo hace el worker cuando este proceso ya murio (ver `SALIDA`).
    return { reconectar: false, borrarCredenciales: true, esperaMs: 0,
      motivo: MOTIVO.SESION_CERRADA }
  }
  if (statusCode === CIERRE.RESTART_REQUIRED) {
    // Baileys lo pide tras el primer QR escaneado. Esperar aca solo demora el
    // emparejamiento sin ganar nada.
    return { reconectar: true, borrarCredenciales: false, esperaMs: 0,
      motivo: MOTIVO.REINICIO_REQUERIDO }
  }
  const conTope = CIERRE_CON_TOPE[statusCode]
  if (conTope) {
    // Antes caian en el "cualquier otro codigo" de abajo y reconectaban para siempre.
    if (repetidos > CIERRES_REPETIDOS_TOPE) {
      return { reconectar: false, borrarCredenciales: false, esperaMs: 0, motivo: conTope }
    }
    return { reconectar: true, borrarCredenciales: false,
      esperaMs: calcularEsperaMs(intento), motivo: conTope }
  }
  if (statusCode === CIERRE.SOCKET_CAIDO_408) {
    return { reconectar: true, borrarCredenciales: false,
      esperaMs: calcularEsperaMs(intento), motivo: MOTIVO.SOCKET_CAIDO }
  }
  // Cualquier otro codigo -o ninguno- reconecta igual, con el mismo backoff: negar
  // la reconexion por defecto dejaria colgada una caida que nadie previo a mano.
  return { reconectar: true, borrarCredenciales: false,
    esperaMs: calcularEsperaMs(intento), motivo: MOTIVO.DESCONOCIDO }
}

// Cada cuanto Baileys genera un QR nuevo. NO son los ~20 s que tarda el cliente web
// en redibujarlo -eso es cosmetico-, es `qrTimeout`: con el valor de fabrica, 60 s,
// un panel que los vencia a los 20 mostraba "el codigo vencio" durante 40 de cada 60
// segundos. Sonaba a fallo y era la regla mal copiada.
// Las colecciones de app state que traen la LIBRETA: los contactos y la lista de
// conversaciones uno a uno. Es `ALL_WA_PATCH_NAMES` de Baileys, replicado aca por lo
// mismo que los `statusCode` de `CIERRE`: para que el modulo se pueda importar por sus
// funciones puras sin resolver la libreria.
export const PARCHES_DE_LIBRETA = Object.freeze([
  'critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'
])

export const QR_ROTACION_MS = 60000

// Cuanto vale un QR para el panel, su `ttlMs`. Tiene que ser MAYOR que
// QR_ROTACION_MS y no el MISMO numero: igualarlos -el arreglo anterior de esta
// constante- hace que un QR venza en el instante exacto en que nace el siguiente, y
// cualquier demora de entrega cae justo ahi. Medido en una instalacion viva con las
// dos iguales a 60 s: el QR aparecia vencido ~40 de cada ~92 s, y una rotacion
// entera (la numero 4) ni siquiera llego a storage — el hueco no era cosmetico, era
// el mismo panel en blanco que motivo este arreglo.
//
// El margen (15 s) tiene que cubrir la demora mas larga entre que Baileys genera el
// QR y que el panel lo lee: el salto por stdout a `escribir()` (main.mjs, un solo
// `await` de storage), el sondeo dedicado de la vinculacion cada 2 s
// (`VEREDICTO_SONDEO_MS`/`vigilarSidecar` en config.html) y, detras de esos dos, la
// cola de CUPO del host cuando el sondeo general ya gasto su presupuesto de 10 s
// (docs/ENCARGO...§H2-H3). Ninguna de esas demoras suma quince segundos por si
// sola; juntas, con la maquina mas lenta que la de la medicion, es el margen que no
// se vio agotar en la instalacion viva.
//
// Se fija aca y viaja CON cada QR (`ttlMs`), en vez de repetirse a mano en el panel:
// dos constantes que nadie obliga a coincidir terminan no coincidiendo. Si el dia de
// manana se vuelven a igualar sin querer, el sintoma es EXACTAMENTE este: un QR que
// se ve vencido justo cuando debia rotar.
export const QR_VIGENCIA_MS = QR_ROTACION_MS + 15000

/** El mensaje de QR que se emite por stdout: siempre con `ts` y el numero de
 *  rotacion, nunca un QR "pelado". */
export function mensajeQr (qr, rotacion, ts = Date.now(), ttlMs = QR_VIGENCIA_MS) {
  return { type: 'qr', qr, ts, rotation: rotacion, ttlMs }
}

/** La misma regla que usara el panel para descartar un QR vencido, escrita una sola
 *  vez para que las dos puntas -sidecar y panel- decidan igual. */
export function qrVencido (ts, ahoraMs = Date.now(), vigenciaMs = QR_VIGENCIA_MS) {
  return ahoraMs - ts > vigenciaMs
}

// Las opciones con que se abre el socket. Vive aparte y es PURA para poder probarse
// sin resolver Baileys ni abrir nada: las dos banderas de abajo deciden si la lista de
// conversaciones llega o no, y eso no se puede verificar mirando el codigo.
//
// `shouldSyncHistoryMessage` es la que arregla el defecto medido en la cuenta viva:
// 296 grupos en el almacen y CERO uno a uno. La lista inicial de conversaciones NO
// viene por `chats.upsert` -eso es una conversacion NUEVA- sino por
// `messaging-history.set`, y Baileys 6.7.24 solo emite ese evento cuando esta funcion
// contesta que si (lib/Socket/chats.js:778-780 -> lib/Utils/process-message.js:150,168).
// Sin ponerla, `makeWASocket` la deriva de `syncFullHistory`
// (lib/Socket/index.js:11-12): con `false`, el socket ni siquiera espera la
// notificacion (chats.js:869-877) y el evento no se emite NUNCA. Poner el escuchador
// sin esto no arregla nada — se ve exactamente igual que un telefono que no mando la
// lista.
//
// Y `syncFullHistory` se queda en `false`, que es OTRA cosa: viaja como
// `requireFullSync` dentro del nodo de registro que Baileys manda al vincular
// (`generateRegistrationNode`) y le pide al telefono que vuelque el archivo entero.
// El intercambio es real: mas historia es un primer arranque mas lento y muchisimo mas texto ajeno cruzando el proceso, y
// §11-F2 dice que "un almacen sin tope y sin caducidad es un archivo de conversaciones
// ajenas que nadie borra". Con `false` el telefono manda igual su lote reciente —que
// es de donde sale la lista— y no se pide el archivo. Los mensajes que vengan en ese
// lote no se miran: el escuchador de abajo solo lee `chats`.
export function opcionesDeSocket ({ version, auth, browser }) {
  return {
    version,
    auth,
    browser,
    printQRInTerminal: false,
    // La ROTACION, no la vigencia: son dos numeros distintos a proposito (ver el
    // comentario de QR_VIGENCIA_MS). Dejarlo implicito ata la UI a un valor de
    // fabricante.
    qrTimeout: QR_ROTACION_MS,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => true
  }
}

// ── Protocolo por stdout ─────────────────────────────────────────────────────────
function emitir (mensaje) {
  process.stdout.write(JSON.stringify(mensaje) + '\n')
}

function emitirQr (qr, rotacion) {
  emitir(mensajeQr(qr, rotacion))
}

function emitirConexion (state, extra = {}) {
  emitir({ type: 'connection', state, ...extra })
}

function emitirError (code, detail) {
  emitir({ type: 'error', code, detail: String(detail ?? '').slice(0, 300) })
}

/** Lo que paso con el almacen, en CONTEOS y nunca en contenido.
 *
 *  Nada de lo que sale por aca puede nombrar a nadie: ni un cuerpo, ni un telefono, ni
 *  un jid de remitente. Esto es una cuenta real con conversaciones de clientes reales,
 *  y stdout del sidecar termina en el `orca.log`.
 *
 *  Pero los numeros SI tienen que salir. "Llegaron 40 y se guardaron 0" es la unica
 *  manera de distinguir "no hay ninguna conversacion autorizada" de "el almacen esta
 *  roto", y un desalojo callado es un caso que se pierde sin explicacion (§11-F2). */
function emitirAlmacen (conteos) {
  emitir({ type: 'store', at: Date.now(), ...conteos })
}

// Cada mensaje `store` que sale por aca termina en un `storage.set` del worker, y Orca
// mata al worker a los 64 eventos sin confirmar en vuelo (plugin-host-process.ts). Es
// el MISMO mecanismo que ya se llevo puesto al worker una vez por lo hablador que es
// Baileys en stderr, y el sintoma no se parecia en nada a la causa: el panel se quedaba
// con un QR vencido para siempre porque nadie llego a ver el final. Una cuenta ocupada
// emite varios `messages.upsert` por segundo durante la sincronizacion inicial, asi que
// los conteos salen con freno.
export const ALMACEN_LATIDO_MS = 30000

// Cada cuanto el sidecar dice "sigo aca" por stdout. Es lo que deja caducar el
// "conectado" del panel: sin latido, la ultima foto guardada en storage no vencia nunca,
// y con el worker o este proceso muertos el panel seguia diciendo "conectado" una semana
// despues. Un minuto y no un segundo: cada linea es un `storage.set` del worker, y el
// host lo mata a los 64 sin confirmar en vuelo (ver ALMACEN_LATIDO_MS). El latido de
// cada segundo que lee `bin/wa-send` es OTRO, va al almacen y no cruza el host.
export const LATIDO_LINEA_MS = 60000

/** El latido que sale por stdout: la hora y si el socket esta abierto. Nada mas — esto
 *  termina en storage, que lee el panel. */
export function mensajeLatido (conectado, ts = Date.now()) {
  return { type: 'latido', ts, conectado: conectado === true }
}

/** Si toca sacar los conteos. Un desalojo fuerza la salida: es lo unico que no se puede
 *  perder, porque perderlo significa que el usuario se entera cuando una fila sale sin
 *  cuerpo y sin explicacion (docs/ENCARGO-TRANSPORTE-UNICO.md §11-F2). */
export function tocaEmitirAlmacen (ultimoMs, ahoraMs, forzar = false) {
  return forzar || ahoraMs - ultimoMs >= ALMACEN_LATIDO_MS
}

// Tope por adjunto. Un video de 60 MB en `~/.wa-inbox` no lo pidio nadie: la fila se
// guarda igual, con su tipo, y sin ruta — que es exactamente el marcador tipado que
// §11-C4 manda dejar en vez de una ruta que no se puede respaldar.
const MEDIA_MAX_BYTES = 25 * 1024 * 1024

/** El arranque real: abre el socket, guarda credenciales, reconecta segun
 *  `decidirTrasCierre`. Async de punta a punta, SIN `await` de nivel superior -el
 *  `--format=cjs` de esbuild no lo soporta- por eso todo cuelga de esta funcion,
 *  invocada al final sin esperarla arriba. */
async function iniciar () {
  // El worker pasa el directorio de auth, NUNCA se adivina aca (`fork()` no fija
  // `cwd`: el hijo hereda el de Orca, no la raiz del plugin -
  // docs/ENCARGO...§2). Env primero, argv como respaldo.
  const authDir = process.env.WA_SIDECAR_AUTH_DIR || process.argv[2]
  if (!authDir || !isAbsolute(authDir)) {
    emitirError(MOTIVO.SIN_SESION,
      'el directorio de auth tiene que venir del worker como ruta absoluta (env WA_SIDECAR_AUTH_DIR o argv[2])')
    process.exitCode = 1
    return
  }

  mkdirSync(authDir, { recursive: true, mode: 0o700 })
  // `mkdirSync` con `mode` no ajusta un directorio que ya existia con otro permiso:
  // se fuerza aparte para que una carpeta vieja no quede mas abierta de lo debido.
  chmodSync(authDir, 0o700)

  const { default: makeWASocket, useMultiFileAuthState, Browsers,
    downloadMediaMessage, fetchLatestBaileysVersion } =
    await import('@whiskeysockets/baileys')

  const { state, saveCreds } = await useMultiFileAuthState(authDir)
  const { version } = await fetchLatestBaileysVersion()

  // ── El almacen y el alcance ──────────────────────────────────────────────────────
  // El almacen vive en `~/.wa-inbox/capture.db`, al lado del registro de alcance y
  // FUERA del arbol del plugin, que esta verificado por content-hash (§7). El porque
  // entero esta en sidecar/src/almacen.js.
  const almacen = abrirAlmacen(rutaAlmacen(process.env))
  // La cuenta de esta linea es el TELEFONO vinculado (`cuentaDeIdentidad`), no la `local`
  // fija de antes: con la fija, vincular otro numero le daba al nuevo las conversaciones
  // y las autorizaciones del viejo. Con credenciales ya guardadas se sabe desde el
  // arranque; emparejando es `null` hasta que WhatsApp diga quien es, y en ese rato no
  // se guarda ni se manda nada a nombre de nadie.
  const mediaDir = rutaMedia(process.env)
  // Las herramientas las pasa el worker: buscarlas en el PATH ya habia mandado a una
  // a la instalacion equivocada (§11-E4).
  const alcance = crearAlcance({ toolsDir: process.env.WA_SIDECAR_TOOLS_DIR })
  alcance.refrescar(true)

  /** Lo que quedo de antes de T9 bajo la cuenta fija `local`. Se pasa a su numero solo
   *  con evidencia, o por decision del dueno (`wa-scope reclave --numero`, que llega por
   *  el alcance); si no, queda guardado y oculto y `wa-read doctor` pide la decision
   *  (falla cerrada: `resolverLocal` en almacen.js). Un fallo aca no tumba la linea. */
  const resolverLegado = () => {
    try {
      const r = almacen.resolverLocal({ emparejada: cuenta, decidida: alcance.reclaveDecidida() })
      // Solo que paso, sin numeros de nadie: va al log del worker.
      if (r.accion === 'movida' || r.accion === 'bloqueada') {
        process.stderr.write(`legado: ${r.accion} (${r.motivo})\n`)
      }
    } catch (error) {
      emitirError('legado-sin-resolver', error?.message || error)
    }
  }

  let cuenta = null
  const fijarCuenta = (pn) => {
    const nueva = cuentaDeIdentidad(pn)
    if (!nueva || nueva === cuenta) return
    cuenta = nueva
    // Cambiar de numero cambia de cajon: no se copia ni se pisa nada de la otra linea.
    const { cambio, antes } = almacen.activarLinea(cuenta)
    // Sin numero ni contenido: solo que la linea activa cambio, para el log del worker.
    if (cambio && antes) process.stderr.write('linea: cambio la linea activa\n')
    emitir({ type: 'linea', cuenta, cambio, ts: Date.now() })
    // Con el numero emparejado conocido recien se puede decidir sobre lo de antes.
    resolverLegado()
  }
  fijarCuenta(state.creds?.me?.id)

  let identidades = identidadesPropias(null, null)
  const nombresDeChat = new Map()
  const conteos = { llegaron: 0, guardados: 0, sinAutorizar: 0, actualizados: 0 }
  let ultimoAlmacenMs = 0
  // Cuantas conversaciones dejo la sincronizacion inicial, acumuladas: el telefono
  // manda su lista en VARIOS lotes, no en uno.
  let historialChats = 0
  let historialDicho = false

  // Un fallo de ingesta rara vez es de UN mensaje: el disco lleno, la base ilegible o
  // un permiso perdido fallan para todos. Sin tope, un error por mensaje es la misma
  // avalancha de llamadas al host que el freno de los conteos evita, por el mismo
  // camino. Se dicen los primeros —que es donde esta la causa— y despues se callan.
  let fallosDichos = 0
  const AVISOS_MAX = 10
  function avisarFallo (code, error) {
    fallosDichos += 1
    if (fallosDichos > AVISOS_MAX) return
    const cola = fallosDichos === AVISOS_MAX ? ' (no se avisan mas)' : ''
    emitirError(code, `${error?.message || error}${cola}`)
  }

  function reportarAlmacen (extra = {}, forzar = false) {
    const ahora = Date.now()
    if (!tocaEmitirAlmacen(ultimoAlmacenMs, ahora, forzar)) return
    ultimoAlmacenMs = ahora
    emitirAlmacen({ ...conteos, autorizadas: alcance.autorizadas(),
      chatsHistorial: historialChats, ...extra })
  }

  // La subida de esquema se dice EN CUANTO ocurre, sin esperar al latido de 30 s y sin
  // esperar a que conecte el socket: en una maquina que venia de la via de WhatsApp
  // Web, este arranque es el que se llevo su cache de cuerpos, y eso no se puede perder
  // porque el socket tardara en abrir o nunca abra. Mismo trato que el desalojo, por el
  // mismo motivo (§11-F2): callarlo es perder el caso sin explicacion. Solo numeros, y
  // la frase entera con el que y el por que la publica `wa-read doctor`, que es lo que
  // llega al panel.
  //
  // Va por `store` y por stderr, NUNCA por `error`: el panel lee `sidecar.error` como
  // la causa de una sesion caida, y una subida de esquema que salio bien se leeria ahi
  // como el motivo de una falla que no ocurrio.
  if (almacen.migracion) {
    process.stderr.write(
      `almacen: subido de la version ${almacen.migracion.desde} a la ` +
      `${almacen.migracion.hasta}; se fueron ${almacen.migracion.cuerpos} cuerpos y ` +
      `${almacen.migracion.lineas} lineas de la via vieja\n`)
    reportarAlmacen({ migradoCuerpos: almacen.migracion.cuerpos,
      migradoLineas: almacen.migracion.lineas }, true)
  }

  // T16b: los directos que se guardaron con dispositivo (`:N`) se juntaron en su chat
  // de siempre. Va por stderr y solo con numeros: es una nota para quien mire el log el
  // dia que pregunte adonde se fue la fila duplicada, no una falla.
  if (almacen.dispositivosUnidos) {
    process.stderr.write(
      `almacen: ${almacen.dispositivosUnidos.chats} chats directos con dispositivo ` +
      `juntados en el chat sin dispositivo; ${almacen.dispositivosUnidos.mensajes} ` +
      'mensajes movidos\n')
  }

  /** Los bytes de un adjunto, ya descifrados por Baileys. Devuelve `null` cuando no se
   *  pueden bajar o son demasiados: la fila se guarda igual, SIN ruta, porque una ruta
   *  que no se puede respaldar falla con "no such file" lejos de aca (§11-C4). */
  async function bajar (sock, wa) {
    const bytes = await downloadMediaMessage(wa, 'buffer', {},
      { reuploadRequest: sock.updateMediaMessage })
    if (!bytes || bytes.length > MEDIA_MAX_BYTES) return null
    return bytes
  }

  let intento = 0
  // Los cierres repetidos del mismo codigo (`repetidosTrasCierre`). Vive fuera de
  // `conectar()` porque tiene que sobrevivir a la reconexion: es lo que la cuenta mide.
  let cierres = null
  let rotacion = 0
  // El socket vivo y si esta abierto. Los guarda el arranque y los mira el drenado de
  // la bandeja de salida, que corre en su propio reloj y no dentro de `conectar()`: una
  // peticion que llega con el socket caido tiene que ESPERAR, no fallar. Decirle al
  // dueno que WhatsApp rechazo un mensaje que nunca lo vio es peor que tardar.
  let socket = null
  let conectado = false

  function conectar () {
    const sock = makeWASocket(opcionesDeSocket({
      version, auth: state, browser: Browsers.appropriate('Chrome')
    }))
    socket = sock
    conectado = false

    // El numero como lo reconoce una persona: `573000000011:7@s.whatsapp.net` no le
    // dice nada a nadie. Se corta el sufijo de dispositivo y el servidor.
    const numeroVisible = (pn) => {
      const usuario = String(pn || '').split('@')[0].split(':')[0]
      return /^\d{6,}$/.test(usuario) ? `+${usuario}` : null
    }

    // Si este jid es el dueno. Se calcula contra `identidades`, que es la MISMA fuente
    // con la que se decide "me nombraron": una segunda lista de jids propios se
    // desincroniza de la primera y entonces el panel y la bandeja discrepan sobre quien
    // es uno.
    const esPropio = (jid) => identidades.has(identidadPropia(jid))

    // Quien soy yo, a los efectos de "me nombraron" y "contestaron algo mio". Se
    // pregunta en CADA `creds.update` y no una sola vez en el `open`, porque ahi la
    // respuesta todavia esta incompleta: ver `identidadDeSesion` en mensajes.js.
    //
    // Se compara contra lo ultimo escrito para no tocar la base en cada `creds.update`
    // -que llegan de a muchos- y, cuando el LID aparece por primera vez, se repara lo
    // que ya estaba guardado sin el: los mensajes que nombran al dueno se ingirieron
    // con `menciona_me = 0` porque en ese momento nadie sabia que ese numero era el
    // suyo. Sin la reparacion esos mensajes no salen en la bandeja NUNCA, y son justo
    // los primeros que llegan tras vincular la linea.
    let identidadUlt = null
    const refrescarIdentidad = () => {
      const yo = identidadDeSesion(sock.authState?.creds, sock.user)
      // La identidad decide la cuenta ANTES de escribir nada: la fila de `linea` es de
      // ESTE telefono, y nunca pisa la de otro numero.
      fijarCuenta(yo.pn)
      if (!cuenta) return
      const huella = `${yo.lid}|${yo.pn}|${yo.nombre}`
      if (huella === identidadUlt) return
      const teniaLid = identidadUlt !== null && identidades.size > 1
      identidadUlt = huella
      identidades = identidadesPropias(yo.lid, yo.pn)
      almacen.registrarLinea({ cuenta, lid: yo.lid, pn: yo.pn, nombre: yo.nombre })
      // Quien quedo vinculado viaja al panel. Sin esto, tras escanear un QR no hay
      // forma de notar que se escaneo con el telefono equivocado: el panel dice
      // "conectado" y no con cual. Va el numero visible y NADA mas — ni el LID, que no
      // le dice nada a nadie, ni claves.
      const reparados = yo.lid && !teniaLid
        ? almacen.repararMenciones({ cuenta, lid: yo.lid })
        : 0
      emitir({ type: 'identidad', me: numeroVisible(yo.pn), cuenta, reparados,
        ts: Date.now() })
    }

    // `useMultiFileAuthState` escribe las claves en archivos: `saveCreds` los
    // regenera. Sin `chmodSync` en cada uno, un umask distinto en otra maquina los
    // dejaria legibles de nuevo tras la primera escritura.
    sock.ev.on('creds.update', async () => {
      await saveCreds()
      // `creds.update` es JUSTO donde aparece el LID: en el `open` todavia no esta.
      // Sin este refresco la identidad se quedaba con el telefono y nada mas, y las
      // menciones -que viajan en @lid- no se reconocian NUNCA (ver `identidadDeSesion`).
      refrescarIdentidad()
    })

    sock.ev.on('connection.update', (actualizacion) => {
      const { connection, lastDisconnect, qr } = actualizacion
      if (qr) {
        // Un QR nuevo reinicia el contador: ver `intentoTrasEvento`. El backoff
        // exponencial esta para una caida de red, no para la rotacion esperada del QR.
        intento = intentoTrasEvento(intento, 'qr')
        rotacion += 1
        emitirQr(qr, rotacion)
        return
      }
      if (connection === 'open') {
        intento = intentoTrasEvento(intento, 'open')
        conectado = true
        emitirConexion('open')
        // Quien soy yo, a los efectos de "me nombraron" y "contestaron algo mio". El
        // LID y el TELEFONO son numeros DISTINTOS y llegan cada uno por su lado: mirar
        // uno solo pierde las respuestas viejas sin un solo error (§11-B1/B2).
        refrescarIdentidad()
        // Los asuntos de los grupos: sin esto cada conversacion se llamaria como la
        // primera persona que escribio en ella.
        sock.groupFetchAllParticipating()
          .then((grupos) => {
            // Por el mismo camino que todo lo demas: `groupFetchAllParticipating`
            // devuelve un mapa jid -> metadata, asi que se le pone el `id` adentro y ya
            // es la misma forma que leen los otros tres eventos.
            anotarChats(Object.entries(grupos || {})
              .map(([jid, meta]) => ({ ...meta, id: jid })))
            if (cuenta) almacen.registrarLinea({ cuenta, grupos: Object.keys(grupos || {}).length })
          })
          .catch((error) => emitirError('grupos-sin-leer', error?.message || error))

        // Y LAS PERSONAS, por la misma via explicita que los grupos.
        //
        // Sin esto la lista sale con 296 grupos y CERO directos, que es la queja
        // medida. La causa esta en Baileys y no en el telefono: la libreta y la lista
        // de uno a uno llegan por `resyncAppState` —las colecciones
        // `critical_unblock_low` y `regular*`— y eso corre en UN SOLO sitio,
        // `doAppStateSync`, que se auto-anula si no esta en `SyncState.Syncing`
        // (lib/Socket/chats.js). A ese estado solo se entra si en la ventana de la
        // sincronizacion inicial llega un mensaje de historial procesable; si no llega,
        // pasa a `Online` y la libreta NO se pide nunca mas en esa sesion.
        //
        // Medido en la cuenta del dueno: 378 `app-state-sync-key-*` en disco -o sea, el
        // telefono SI mando las llaves- y CERO `app-state-sync-version-*`, con
        // `accountSyncCounter` en 0. Las llaves llegaron y el estado no se sincronizo
        // jamas. Ese es todo el defecto, y explica por que la misma cuenta si muestra
        // personas en otra maquina: ahi la ventana se completo.
        //
        // Pedirlo a mano no necesita desvincular ni volver a escanear. Es exactamente
        // lo que ya se hace con los grupos, que tampoco se esperan: se piden.
        sock.resyncAppState(PARCHES_DE_LIBRETA, true)
          .then(() => emitir({ type: 'libreta', ok: true, ts: Date.now() }))
          // Que falle no tumba la sesion: los grupos y los mensajes siguen entrando.
          // Pero se dice, porque una libreta que no llego es una lista sin personas, y
          // eso hasta hoy se veia igual que "no tienes conversaciones directas".
          .catch((error) => emitirError('libreta-sin-leer', error?.message || error))
        return
      }
      if (connection === 'connecting') {
        emitirConexion('connecting')
        return
      }
      if (connection === 'close') {
        conectado = false
        const statusCode = lastDisconnect?.error?.output?.statusCode
        intento = intentoTrasEvento(intento, 'close')
        cierres = repetidosTrasCierre(cierres, statusCode)
        const decision = decidirTrasCierre(statusCode, intento, cierres.veces)
        emitirConexion('close', { motivo: decision.motivo, statusCode: statusCode ?? null })
        if (!decision.reconectar) {
          emitirError(decision.motivo, decision.borrarCredenciales
            ? 'la sesion se cerro; las credenciales guardadas ya no sirven'
            : 'el socket no va a reintentar mas')
          // Salir A PROPOSITO y con codigo, en vez de quedarse sin socket esperando a
          // que el bucle de eventos se vacie solo: asi salia con 0, y un 0 no le decia
          // al worker que la sesion habia muerto — lo pintaba como "se cayo" y el panel
          // ofrecia Reintentar, que repetia el mismo 401 sin un solo QR.
          terminar(salidaTrasCierre(decision))
          return
        }
        setTimeout(conectar, decision.esperaMs)
      }
    })

    // ── Los mensajes ───────────────────────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const wa of messages || []) {
        conteos.llegaron += 1
        // Sin identidad no hay cajon donde guardarlo: nada se escribe a nombre de nadie.
        if (!cuenta) continue
        try {
          // El alcance se refresca con su propio TTL: el usuario autoriza un chat en
          // el panel y espera que el proximo mensaje ya entre.
          alcance.refrescar()
          const { motivo } = await ingerirMensaje({
            almacen,
            alcance: alcance.modo,
            cuenta,
            identidades,
            wa,
            mediaDir,
            descargarMedia: (mensaje) => bajar(sock, mensaje),
            nombreDeChat: (jid) => nombresDeChat.get(jid) || null
          })
          if (motivo === INGESTA.GUARDADO) conteos.guardados += 1
          else if (motivo === INGESTA.SIN_AUTORIZAR) conteos.sinAutorizar += 1
        } catch (error) {
          // Un mensaje raro no puede llevarse la linea entera: se cuenta el fallo y se
          // sigue. El detalle NO lleva contenido, solo el mensaje del error.
          avisarFallo('mensaje-sin-guardar', error)
        }
      }
      reportarAlmacen()
    })

    // Borrados y editados: el hueco que el lector viejo no llenaba en ningun lado
    // (§11-B4). Un mensaje borrado se quedaba en la bandeja para siempre, y uno
    // editado se atendia por lo que decia antes.
    sock.ev.on('messages.update', (eventos) => {
      if (!cuenta) return
      for (const evento of eventos || []) {
        try {
          const { motivo } = ingerirActualizacion({
            almacen, alcance: alcance.modo, cuenta, evento
          })
          if (motivo === INGESTA.GUARDADO) conteos.actualizados += 1
        } catch (error) {
          avisarFallo('cambio-sin-aplicar', error)
        }
      }
    })

    // Las conversaciones que existen, con su nombre y sus no leidos. Es CONTABILIDAD:
    // sin esto, una conversacion en la que todavia nadie escribio no se puede ni
    // ofrecer para autorizarla, y la lista del panel nace vacia (§11-F3).
    //
    // La normalizacion entera -que nombre usar, como sacar un `Long`, que jid NO es una
    // conversacion- vive en `filaDeChat` y no aca: los tres eventos de abajo traen la
    // misma cosa en tres formas distintas, y tres copias de la regla son tres reglas
    // que se desincronizan. Lo que estaba escrito aca leia solo `chat.name` y solo
    // `typeof === 'number'`, que es exactamente lo que un uno a uno del historial NO
    // trae.
    const anotarChats = (chats) => {
      if (!cuenta) return { anotados: 0, omitidos: 0 }
      try {
        return ingerirChats({
          almacen,
          cuenta,
          chats,
          nombreDeChat: (jid) => nombresDeChat.get(jid) || null,
          recordarNombre: (jid, nombre) => nombresDeChat.set(jid, nombre),
          esPropio
        })
      } catch (error) {
        avisarFallo('chat-sin-anotar', error)
        return { anotados: 0, omitidos: 0 }
      }
    }
    sock.ev.on('chats.upsert', anotarChats)
    sock.ev.on('chats.update', anotarChats)

    // La LIBRETA DE NOMBRES. Los grupos traen su asunto por su propio evento; las
    // conversaciones directas NO -su nombre vive en la agenda del telefono- y este
    // canal no se escuchaba. Medido en la cuenta del dueno: de tres directas, dos se
    // llamaban como su numero. Un directo que se llama como su numero es inelegible en
    // la practica aunque este en la lista, que era la queja.
    //
    // Se lee el nombre Y NADA MAS: es la misma contabilidad que ya se guarda de cada
    // grupo, no contenido de nadie (§5).
    const anotarContactos = (contactos) => {
      if (!cuenta) return { nombrados: 0 }
      try {
        return ingerirContactos({
          almacen,
          cuenta,
          contactos,
          recordarNombre: (jid, nombre) => nombresDeChat.set(jid, nombre),
          esPropio
        })
      } catch (error) {
        avisarFallo('contacto-sin-anotar', error)
        return { nombrados: 0 }
      }
    }
    sock.ev.on('contacts.upsert', anotarContactos)
    sock.ev.on('contacts.set', ({ contacts }) => anotarContactos(contacts))

    // La lista INICIAL de conversaciones. Es el unico evento que la trae: `chats.upsert`
    // avisa de una conversacion NUEVA y `groupFetchAllParticipating` devuelve grupos por
    // definicion, asi que sin esto un uno a uno solo aparece si alguien escribe mientras
    // el plugin corre — medido en la cuenta del dueno: 296 grupos y CERO directos, y un
    // directo que no esta en la lista no se puede autorizar.
    //
    // Del lote se leen `chats` y NADA MAS. Trae tambien `messages` y `contacts`, y no se
    // miran a proposito: listar una conversacion no puede guardar una palabra de nadie.
    // El unico camino que escribe un cuerpo sigue siendo `ingerirMensaje`, que le
    // pregunta al alcance antes (§5).
    sock.ev.on('messaging-history.set', ({ chats, contacts, isLatest }) => {
      // Los contactos ANTES que los chats: asi las filas que nacen en este mismo lote
      // ya encuentran su nombre en `nombresDeChat` en vez de nacer llamandose como su
      // jid y depender de que otro lote las repare despues.
      anotarContactos(contacts)
      const { anotados } = anotarChats(chats)
      historialChats += anotados
      // El PRIMER lote se fuerza y los demas no. Forzarlo una vez es lo que distingue
      // "el telefono no mando la lista" de "la mando y el almacen la rechazo" — las dos
      // se ven igual, y ese silencio es el que costo este arreglo —, y llega justo
      // cuando el freno de 30 s esta recien puesto por la avalancha de
      // `messages.upsert` de la sincronizacion.
      //
      // Pero solo una vez: el telefono manda su lista en VARIOS lotes, y un `store`
      // por lote es un `storage.set` del worker por lote. Orca mata al worker a los 64
      // eventos sin confirmar en vuelo, y ese mecanismo YA se llevo puesto a este
      // worker una vez por lo hablador que es Baileys. El resto de los lotes suma al
      // conteo y sale con el latido normal.
      reportarAlmacen({ chatsHistorial: historialChats,
        historialCompleto: isLatest === true }, !historialDicho)
      historialDicho = true
    })
    sock.ev.on('groups.update', (grupos) => {
      for (const g of grupos || []) {
        if (g?.id && g?.subject) nombresDeChat.set(g.id, g.subject)
      }
    })
  }

  // ── La bandeja de salida ─────────────────────────────────────────────────────────
  // Lo que `bin/wa-send` dejo encolado, y el latido que le dice que hay alguien de este
  // lado. Los dos en el mismo reloj a proposito: un latido que sigue saliendo mientras
  // el drenado esta trabado seria una senal de vida que miente.
  //
  // El drenado no se solapa consigo mismo (`drenando`): `sendMessage` es asincrono y
  // dos vueltas encimadas sobre la misma fila son justo la carrera que `tomarEnvio`
  // existe para cerrar. Aca se cierra tambien del lado del reloj, que es mas barato.
  //
  // Esto NO emite nada por stdout. Un `store` por envio seria un `storage.set` del
  // worker por mensaje enviado, y Orca mata al worker a los 64 eventos sin confirmar en
  // vuelo — el mismo mecanismo que ya se llevo puesto al worker una vez. El veredicto
  // lo lee quien pidio, en la fila, que es donde lo espera.
  let drenando = false
  const salidaTimer = setInterval(() => {
    try {
      almacen.latir()
    } catch (error) {
      avisarFallo('latido-sin-escribir', error)
      return
    }
    if (drenando) return
    drenando = true
    // Solo lo encolado para ESTE numero (`cuenta`): lo de otra linea espera a su numero.
    atenderSalida({ almacen, conectado, cuenta,
      enviar: (jid, contenido) => socket.sendMessage(jid, contenido) })
      .catch((error) => avisarFallo('salida-sin-atender', error))
      .finally(() => { drenando = false })
  }, ENVIO_LATIDO_MS)
  if (typeof salidaTimer.unref === 'function') salidaTimer.unref()

  // El latido de la linea hacia el panel (ver LATIDO_LINEA_MS). Sale uno ya, para que el
  // panel no tenga que esperar un minuto entero para creer lo que ve.
  const latirLinea = () => {
    emitir(mensajeLatido(conectado))
    // En el mismo reloj, la decision del dueno sobre lo de antes (`wa-scope reclave
    // --numero`): se aplica en menos de un minuto, sin reiniciar nada. Con la linea
    // conectada el panel no ofrece Reintentar, y mandar a apretarlo seria mandar a
    // un boton que no esta. Sin nada en `local`, `resolverLocal` no hace nada.
    if (cuenta) {
      alcance.refrescar()
      resolverLegado()
    }
  }
  latirLinea()
  const lineaTimer = setInterval(latirLinea, LATIDO_LINEA_MS)
  if (typeof lineaTimer.unref === 'function') lineaTimer.unref()

  // La poda corre sola y REPORTA. "Un almacen sin tope y sin caducidad es un archivo de
  // conversaciones ajenas que nadie borra" (§11-F2), y lo que se desaloja se dice: el
  // conteo viaja al worker, al panel y al `doctor`.
  const podaTimer = setInterval(() => {
    try {
      const { max, dias } = alcance.topes()
      const podado = almacen.podar({ max, dias })
      // El desalojo se fuerza: el freno de arriba no puede tragarselo.
      if (podado.caducados || podado.desalojados) reportarAlmacen(podado, true)
    } catch (error) {
      emitirError('poda-fallida', error?.message || error)
    }
  }, 60 * 60 * 1000)
  if (typeof podaTimer.unref === 'function') podaTimer.unref()

  /** Irse con un codigo que el worker sabe leer (`SALIDA`). Lo ultimo que se emitio
   *  tiene que llegar antes: la escritura vacia resuelve cuando stdout ya entrego todo
   *  lo anterior, y recien ahi se sale. */
  function terminar (codigo) {
    clearInterval(salidaTimer)
    clearInterval(lineaTimer)
    clearInterval(podaTimer)
    almacen.cerrar()
    process.stdout.write('', () => process.exit(codigo ?? 1))
  }

  conectar()
}

// Solo arranca de verdad cuando este archivo es el punto de entrada -el proceso que
// el worker forkea-, nunca cuando otro modulo lo importa por sus funciones puras
// (asi lo hace la prueba de emparejamiento). Este modulo SIEMPRE corre como el
// `sidecar.cjs` que arma esbuild (`--format=cjs`): ahi `require`/`module` son los
// parametros reales del wrapper de CommonJS, asi que `require.main === module` es
// el chequeo de siempre. `import.meta` no sirve aca -esbuild lo deja vacio en
// salida cjs- y nunca hace falta: el archivo fuente sin empaquetar no es un punto
// de entrada soportado, solo algo que las pruebas importan por sus funciones.
const esPuntoDeEntrada = typeof require !== 'undefined' && typeof module !== 'undefined' &&
  require.main === module

if (esPuntoDeEntrada) {
  iniciar().catch((error) => {
    emitirError(MOTIVO.DESCONOCIDO, error?.message || error)
    process.exitCode = 1
  })
}
