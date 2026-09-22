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
  DESCONOCIDO: 'desconocido'
})

// Los `statusCode` de `DisconnectReason` en Baileys 6.7.24 que necesita la decision
// de reconectar. Se replican como constantes locales -no se importa `DisconnectReason`
// de la libreria aca- para que `decidirTrasCierre` sea una funcion pura, probable sin
// resolver Baileys.
const CIERRE = Object.freeze({
  LOGGED_OUT: 401,
  // connectionLost Y timedOut comparten ESTE MISMO codigo en esta version de
  // Baileys. Inventar cual de los dos fue seria mentirle al motivo que el panel
  // traduce; se lo llama por lo que es, un socket caido.
  SOCKET_CAIDO_408: 408,
  RESTART_REQUIRED: 515
})

const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 30000

/** Cuanto esperar antes del intento N (1-based): exponencial y acotado. Un backoff
 *  sin tope reintentaria cada vez mas lento para siempre sobre una caida que ya se
 *  resolvio hace rato. */
export function calcularEsperaMs (intento) {
  const paso = Math.max(1, intento)
  return Math.min(BACKOFF_BASE_MS * 2 ** (paso - 1), BACKOFF_MAX_MS)
}

/** La decision pura tras un cierre de socket: reconectar o no, con que espera y por
 *  que motivo. No toca la red ni el disco -eso lo hace quien la llama- para que se
 *  pueda probar sin un socket vivo. */
export function decidirTrasCierre (statusCode, intento = 1) {
  if (statusCode === CIERRE.LOGGED_OUT) {
    // Reconectar aca reproduciria el mismo cierre en bucle: el usuario tiene que
    // escanear un QR nuevo, no esperar a que el sidecar lo resuelva solo.
    return { reconectar: false, esperaMs: 0, motivo: MOTIVO.SESION_CERRADA }
  }
  if (statusCode === CIERRE.RESTART_REQUIRED) {
    // Baileys lo pide tras el primer QR escaneado. Esperar aca solo demora el
    // emparejamiento sin ganar nada.
    return { reconectar: true, esperaMs: 0, motivo: MOTIVO.REINICIO_REQUERIDO }
  }
  if (statusCode === CIERRE.SOCKET_CAIDO_408) {
    return { reconectar: true, esperaMs: calcularEsperaMs(intento), motivo: MOTIVO.SOCKET_CAIDO }
  }
  // Cualquier otro codigo -o ninguno- reconecta igual, con el mismo backoff: negar
  // la reconexion por defecto dejaria colgada una caida que nadie prevfunciono a
  // mano.
  return { reconectar: true, esperaMs: calcularEsperaMs(intento), motivo: MOTIVO.DESCONOCIDO }
}

// Cuanto vale un QR. NO son los ~20 s que tarda el cliente web en redibujarlo: eso
// es cosmetico. Quien manda es `qrTimeout` de Baileys, que es cada cuanto genera uno
// nuevo — y con el valor de fabrica, 60 s, un panel que los vencia a los 20 mostraba
// "el codigo vencio" durante 40 de cada 60 segundos. Sonaba a fallo y era la regla
// mal copiada.
//
// Se fija aca y viaja CON cada QR (`ttlMs`), en vez de repetirse a mano en el panel:
// dos constantes que nadie obliga a coincidir terminan no coincidiendo.
export const QR_VIGENCIA_MS = 60000

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

  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers,
    fetchLatestBaileysVersion } = await import('@whiskeysockets/baileys')

  const { state, saveCreds } = await useMultiFileAuthState(authDir)
  const { version } = await fetchLatestBaileysVersion()

  let intento = 0
  let rotacion = 0

  function conectar () {
    const sock = makeWASocket({
      version,
      auth: state,
      browser: Browsers.appropriate('Chrome'),
      printQRInTerminal: false,
      // Explicito: de el sale el `ttlMs` que viaja con cada QR y con el que el panel
      // decide si lo pinta. Dejarlo implicito ata la UI a un valor de fabricante.
      qrTimeout: QR_VIGENCIA_MS,
      syncFullHistory: false
    })

    // `useMultiFileAuthState` escribe las claves en archivos: `saveCreds` los
    // regenera. Sin `chmodSync` en cada uno, un umask distinto en otra maquina los
    // dejaria legibles de nuevo tras la primera escritura.
    sock.ev.on('creds.update', async () => {
      await saveCreds()
    })

    sock.ev.on('connection.update', (actualizacion) => {
      const { connection, lastDisconnect, qr } = actualizacion
      if (qr) {
        rotacion += 1
        emitirQr(qr, rotacion)
        return
      }
      if (connection === 'open') {
        intento = 0
        emitirConexion('open')
        return
      }
      if (connection === 'connecting') {
        emitirConexion('connecting')
        return
      }
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode
        intento += 1
        const decision = decidirTrasCierre(statusCode, intento)
        emitirConexion('close', { motivo: decision.motivo, statusCode: statusCode ?? null })
        if (!decision.reconectar) {
          emitirError(decision.motivo, statusCode === DisconnectReason.loggedOut
            ? 'la sesion se cerro; hace falta escanear un QR nuevo'
            : 'el socket no va a reintentar mas')
          return
        }
        setTimeout(conectar, decision.esperaMs)
      }
    })
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
