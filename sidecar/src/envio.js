// El envio: lo unico que le faltaba a una linea que ya sabia escuchar.
//
// La linea quedo conectada y leyendo —296 conversaciones en el almacen— y sin manera de
// contestar: el camino de escritura se fue con los dos transportes viejos (la app de
// escritorio por accesibilidad y una pestana de WhatsApp Web conducida por el DOM) y no
// se rehizo. Con Baileys mandar es una sola llamada, `sock.sendMessage(jid, { text })`,
// y el socket lo tiene el sidecar. El problema no era mandar: era como le llega la
// peticion al sidecar desde un proceso que no es el.
//
// POR DONDE VIAJA LA PETICION, y por que no por el canal del panel. `sidecarRequest` /
// `sidecarResult` (main.mjs) son claves del `storage` del plugin: ahi solo escribe el
// worker, a traves del host de Orca. `bin/wa-send` no es el worker —es Python, lo corre
// el agente en una terminal y tiene que andar con Orca cerrado, la misma razon por la
// que el almacen no vive en `plugins-data/`— asi que por ese canal el camino serian
// cuatro saltos (CLI -> CLI de Orca -> worker -> sidecar), cada uno capaz de no estar.
// El almacen, en cambio, ya lo abren los dos extremos: `wa-send` para leer el registro
// y el sidecar para escribir lo que llega. Se encola ahi, en la tabla `envio`.
//
// Y esa eleccion es la que da lo que este canal no puede fallar: ENTREGAR UNA SOLA VEZ.
// La llave es el `req_id` de quien pide, asi que un reintento no duplica la fila; la
// toma es un `update ... where estado='pendiente'` (`tomarEnvio` en almacen.js), asi que
// dos drenados no pueden mandar lo mismo dos veces. Un mensaje repetido a un grupo de un
// cliente no se retira con una disculpa.

// Los estados de una peticion. Son contrato con `bin/wa-send`, que los lee del mismo
// archivo: el panel y los CLI traducen por codigo, nunca por texto (§11-E1).
export const ENVIO = Object.freeze({
  // Espera la aprobacion del dueno. El sidecar NO lo toca: WhatsApp no tiene borradores
  // del lado del servidor, asi que "dejarlo escrito en el chat" no existe; lo que existe
  // es dejarlo escrito DONDE EL DUENO LO VE, y que salga solo cuando el diga.
  BORRADOR: 'borrador',
  PENDIENTE: 'pendiente',
  // Tomado por el sidecar. Si el sidecar muere a mitad, la fila se queda aca a
  // proposito: no se reintenta sola. Reintentar sin saber si el mensaje salio es
  // exactamente como se manda dos veces.
  ENVIANDO: 'enviando',
  ENVIADO: 'enviado',
  RECHAZADO: 'rechazado'
})

// Cada cuanto el sidecar mira la bandeja de salida y publica su latido. `wa-send` es un
// proceso corto esperando un veredicto: un segundo es lo que separa "contesto enseguida"
// de "parece colgado", y es un `select` sobre un indice, no una llamada al host.
export const ENVIO_LATIDO_MS = 1000

// Cuanto vale el latido antes de que `bin/wa-send` de al sidecar por muerto. Es amplio a
// proposito: quince segundos de socket ocupado no son un sidecar caido, y decirle al
// dueno que arranque algo que ya esta corriendo lo manda a arreglar lo que no esta roto.
// El MISMO numero vive en `bin/wa-send` (LATIDO_VENCE_S) y `scripts/check-clis` compara
// los dos: dos constantes que nadie obliga a coincidir terminan no coincidiendo.
export const LATIDO_VENCE_MS = 15000

// Cuantas peticiones se atienden por vuelta. Un tope existe porque el drenado corre
// dentro del mismo proceso que ingiere mensajes: una bandeja de salida larga no puede
// dejar de leer WhatsApp mientras se vacia.
const POR_VUELTA = 20

/** El motivo de un rechazo, sin contenido y sin nombres.
 *
 *  Lo que sale de aca termina en la primera linea de stderr de `wa-send`, que es lo que
 *  el agente reporta y lo que puede terminar en un log. Un error de Baileys puede traer
 *  el jid destino adentro del texto, asi que se recorta y se limpia: ni un telefono, ni
 *  un lid, ni un cuerpo. */
export function motivoDeFallo (error) {
  const crudo = String(error?.message ?? error ?? 'sin motivo')
  return crudo.replace(/\S+@(s\.whatsapp\.net|g\.us|lid|c\.us|broadcast)/g, '<jid>')
    .replace(/\d{7,}/g, '<numero>')
    .slice(0, 160)
}

/**
 * Vacia la bandeja de salida contra el socket, y deja el veredicto de cada peticion.
 *
 * `enviar` es `sock.sendMessage` y nada mas: toda la libreria entra por ahi, que es lo
 * que deja probar este camino entero con un socket de mentira y sin una cuenta de
 * WhatsApp.
 *
 * Con el socket caido NO se toca nada. Una peticion que no se pudo intentar tiene que
 * quedar pendiente y esperar a que vuelva la conexion: cerrarla como rechazada le diria
 * al dueno que WhatsApp se nego a un mensaje que nunca lo vio.
 */
export async function atenderSalida ({ almacen, enviar, conectado = true,
  ahora = () => Date.now(), maximo = POR_VUELTA } = {}) {
  if (!almacen || typeof enviar !== 'function' || !conectado) return { enviados: 0, rechazados: 0 }
  let enviados = 0
  let rechazados = 0
  for (let i = 0; i < maximo; i += 1) {
    const fila = almacen.tomarEnvio(ahora())
    if (!fila) break
    try {
      const r = await enviar(fila.chat_jid, { text: fila.body })
      almacen.resolverEnvio(fila.req_id, { estado: ENVIO.ENVIADO,
        stanzaId: r?.key?.id || null, ahora: ahora() })
      enviados += 1
    } catch (error) {
      // Se cierra como rechazada y NO se reintenta: el intento ya salio por el socket y
      // nadie puede decir desde aca si llego. Quien pidio se entera con un motivo, y
      // reintentar es una decision suya, con un `req_id` nuevo.
      almacen.resolverEnvio(fila.req_id, { estado: ENVIO.RECHAZADO,
        motivo: motivoDeFallo(error), ahora: ahora() })
      rechazados += 1
    }
  }
  return { enviados, rechazados }
}
