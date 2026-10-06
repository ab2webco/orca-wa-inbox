/**
 * El registro de Baileys, en un archivo por linea y SIN contenido.
 *
 * Sin `logger`, Baileys escribe con su pino de fabrica a stdout, que es el canal del
 * protocolo con el host: lo que dice ahi no lo guarda nadie. Asi una linea que no puede
 * descifrar lo que le mandan se ve solo como mensajes vacios, y el motivo (sin sesion,
 * MAC invalido, mensaje ausente del nodo) se pierde.
 *
 * Se escribe solo lo que explica por que un mensaje no se pudo leer: los avisos y
 * errores, y los pasos de reintento y de reenvio desde el telefono. De cada linea salen
 * el momento, el nivel, la frase, el mensaje del error y la llave del mensaje (id, chat,
 * participante). NUNCA el nodo ni el mensaje: el nodo trae el cifrado entero.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

const NIVELES = Object.freeze({ trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 })

// Los pasos de depuracion que si explican un mensaje sin leer. El resto del nivel debug
// es ruido de cada stanza.
const PASOS_DE_REINTENTO = [
  'failed to decrypt',
  'retry',
  'resend',
  'unavailable',
  'PDO'
]

export const REGISTRO_MAX_BYTES = 512 * 1024

/** El mensaje que Baileys deja al no poder descifrar. Es contrato con la cuenta del
 *  sidecar: `alFallarDescifrado` se llama solo con este. */
export const FALLO_DE_DESCIFRADO = 'failed to decrypt message'

function vale (nivel, frase) {
  if (NIVELES[nivel] >= NIVELES.warn) return true
  return PASOS_DE_REINTENTO.some((paso) => frase.includes(paso))
}

/** La linea que se escribe: solo campos sin contenido. */
export function lineaDeRegistro (nivel, obj, frase, ahora = new Date()) {
  const datos = obj && typeof obj === 'object' ? obj : {}
  const llave = datos.key || datos.messageKey || datos.msgKey || null
  const fila = { at: ahora.toISOString(), nivel, msg: frase }
  const error = datos.err || datos.error
  if (error) fila.err = String(error.message || error).slice(0, 200)
  if (llave && typeof llave === 'object') {
    fila.id = llave.id || null
    fila.chat = llave.remoteJid || null
    if (llave.participant) fila.participante = llave.participant
  } else if (typeof datos.msgId === 'string') {
    fila.id = datos.msgId
  }
  if (typeof datos.retryCount === 'number') fila.intento = datos.retryCount
  return JSON.stringify(fila)
}

/**
 * Un logger con la forma que Baileys espera de pino (`level`, `child`, un metodo por
 * nivel). `alFallarDescifrado(motivo)` se llama por cada mensaje que no se pudo
 * descifrar, para que el sidecar lo cuente.
 */
export function crearRegistro ({ ruta, maxBytes = REGISTRO_MAX_BYTES,
  alFallarDescifrado = null, ahora = () => new Date() } = {}) {
  let listo = false
  function escribir (linea) {
    try {
      if (!listo) {
        mkdirSync(dirname(ruta), { recursive: true, mode: 0o700 })
        listo = true
      }
      try {
        if (statSync(ruta).size > maxBytes) renameSync(ruta, `${ruta}.1`)
      } catch {}
      appendFileSync(ruta, linea + '\n', { mode: 0o600 })
    } catch {
      // Un registro que no se puede escribir no puede tumbar la linea.
    }
  }

  const registro = { level: 'debug' }
  for (const nivel of Object.keys(NIVELES)) {
    registro[nivel] = (obj, frase) => {
      const texto = typeof obj === 'string' ? obj : String(frase ?? '')
      const datos = typeof obj === 'string' ? {} : obj
      if (texto === FALLO_DE_DESCIFRADO && typeof alFallarDescifrado === 'function') {
        const error = datos?.err || datos?.error
        alFallarDescifrado(String(error?.message || error || 'sin motivo').slice(0, 120))
      }
      if (!vale(nivel, texto)) return
      escribir(lineaDeRegistro(nivel, datos, texto, ahora()))
    }
  }
  registro.child = () => registro
  return registro
}
