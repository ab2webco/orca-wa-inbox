/**
 * Las acciones del dueno sobre una tarjeta del tablero (kanban-casos, T6).
 *
 * El panel no ejecuta nada: deja un pedido en storage y el worker lo atiende por el
 * mismo canal que ya usan el alcance y la sesion (`crearVigia`, en main.mjs). Este
 * modulo es lo que el worker hace con ese pedido: llamar a `wa-scope caso` y, para
 * mandar, a `wa-send`.
 *
 * Tres reglas que no se negocian, y por eso viven en codigo y no en el panel:
 *
 *   - El actor es SIEMPRE `dueno` y lo pone este modulo. El pedido trae un id de caso,
 *     una version y a lo sumo un texto: lo que diga de quien lo firma, del chat o de
 *     lo que hay que mandar se ignora. Un panel es una pagina; lo que firma una
 *     aprobacion no puede salir de ahi.
 *   - Se manda lo que dice el CASO. El texto sale de la propuesta guardada y la version
 *     que el dueno vio tiene que ser la vigente (`E_VERSION` si triage re-propuso
 *     mientras miraba la tarjeta): aprobar lo que no vio es justo lo que el tablero
 *     existe para impedir.
 *   - Un envio es UNO. El id de la peticion a `wa-send` sale del caso y su version, no
 *     del pedido: dos clics sobre la misma tarjeta entregan una vez.
 */
import { join } from 'node:path'
import { VARIABLE_APROBADOR } from './aprobador.mjs'

/** Lo que el panel puede pedir. Son codigos estables: el panel los escribe y el worker
 *  los lee, asi que renombrar uno rompe el canal en silencio. */
export const CASO_ACCION = Object.freeze({
  ENVIAR: 'enviar',
  EDITAR_ENVIAR: 'editar-enviar',
  EJECUTAR: 'ejecutar',
  RECLASIFICAR: 'reclasificar',
  CERRAR: 'cerrar',
  REABRIR: 'reabrir',
  // Lo que era la bandeja (T7 quito "Tomar"): que el agente lo atienda en su proxima
  // corrida, dejarlo de lado, y el proyecto del caso puesto a mano.
  ATENDER: 'atender',
  AUTORIZAR: 'autorizar',
  IGNORAR: 'ignorar',
  PROYECTO: 'proyecto'
})

/** Los veredictos buenos y los malos propios de este canal. Los errores de `wa-scope
 *  caso` (E_*) y los de `wa-send` (send-*) viajan con su codigo tal cual. */
export const CASO_VEREDICTO = Object.freeze({
  ENVIADO: 'enviado',
  APROBADA: 'aprobada',
  RECLASIFICADO: 'reclasificado',
  CERRADO: 'cerrado',
  REABIERTO: 'reabierto',
  ATENDIDO: 'atendido',
  AUTORIZADO: 'autorizado',
  IGNORADO: 'ignorado',
  PROYECTO_CAMBIADO: 'proyecto-cambiado',
  ARGS: 'E_ARGS',
  VERSION: 'E_VERSION',
  // La accion no corresponde a lo que el caso propone (enviar un trabajo, ejecutar una
  // respuesta). No es un error del CLI: es un pedido que no tiene sentido.
  ACCION_INVALIDA: 'accion-invalida',
  // `wa-send` se niega a mandar sin la firma del agente y lo dice en una frase, no con
  // un codigo: se reconoce y se traduce a uno.
  SIN_FIRMA: 'send-no-signature'
})

// Los codigos estables de `wa-scope caso` (bin/wa-scope, ERRORES_CASO).
const CODIGOS_CASO = new Set(['E_ARGS', 'E_NOT_FOUND', 'E_STAGE', 'E_NOT_APPROVED',
  'E_VERSION', 'E_EXCEPTION', 'E_REVISION', 'E_BUSY'])
// Los motivos estables de `wa-send` (y el de Jev) que el panel sabe decir.
const CODIGO_SEND = /^(send-[a-z-]+|jev-unavailable)$/

const ACTOR = 'dueno'
const VERSION = /^[0-9a-f]{64}$/
const TEXTO_MAX = 4096
const NOTA_MAX = 500
// El CLI no deja cerrar una tarjeta sin decir por que; si el dueno no lo dice, lo dice
// el worker. Va en ingles: es el texto de un evento, no de la pantalla.
const MOTIVO_CIERRE = 'closed by the owner'
const MOTIVO_IGNORADO = 'ignored by the owner'
// La forma de un id de proyecto, la misma que valida `wa-scope` (ID_PROYECTO). Lo que no
// la tiene no llega al CLI: un valor con guion al principio seria otra bandera.
const ID_PROYECTO = /^[a-z0-9][a-z0-9-]*$/
// Cuanto espera `wa-send` el veredicto del sidecar, y cuanto el proceso en total. Va por
// debajo del tiempo que el panel espera su respuesta: un envio que tarda mas queda en
// cola con su id, y volver a apretar pregunta por el mismo.
const ENVIO_PLAZO_S = 25
const ENVIO_TOPE_MS = 45 * 1000

/** Un pedido que no se puede cumplir, con el codigo que el panel traduce. */
class Rechazo extends Error {
  constructor (code, detail = '') {
    super(detail || code)
    this.code = code
    this.detail = String(detail).slice(0, 300)
  }
}

const primeraLinea = (texto) =>
  String(texto ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''

/** De lo que fallo al codigo estable. `run` deja la primera linea de stderr como mensaje:
 *  en `wa-scope caso` es el JSON `{"error", "detail"}`, en `wa-send` es `wa-send: <codigo>`. */
function aRechazo (error, motivoDe) {
  if (error instanceof Rechazo) return error
  const texto = String(error?.message ?? error ?? '')
  try {
    const dicho = JSON.parse(texto)
    if (dicho && typeof dicho.error === 'string') {
      return CODIGOS_CASO.has(dicho.error)
        ? new Rechazo(dicho.error, String(dicho.detail ?? ''))
        : new Rechazo('fallo', texto)
    }
  } catch { /* no era JSON */ }
  const send = /^wa-send: (\S+)/.exec(texto)
  if (send) {
    return CODIGO_SEND.test(send[1]) ? new Rechazo(send[1], texto) : new Rechazo('fallo', texto)
  }
  if (/no agent name is configured/.test(texto)) {
    return new Rechazo(CASO_VEREDICTO.SIN_FIRMA, texto)
  }
  return new Rechazo(motivoDe(error), texto)
}

const idDeCaso = (pedido) => {
  const n = pedido?.caseId
  if (!Number.isInteger(n) || n <= 0 || n > 1e9) {
    throw new Rechazo(CASO_VEREDICTO.ARGS, 'caseId')
  }
  return n
}

const versionDe = (pedido) => {
  const v = pedido?.version
  if (typeof v !== 'string' || !VERSION.test(v)) throw new Rechazo(CASO_VEREDICTO.ARGS, 'version')
  return v
}

/** Un texto opcional del dueno (la nota de reclasificar, el motivo de cerrar). */
const opcional = (valor, campo) => {
  if (valor === undefined || valor === null) return ''
  if (typeof valor !== 'string') throw new Rechazo(CASO_VEREDICTO.ARGS, campo)
  const limpio = valor.trim()
  if (limpio.length > NOTA_MAX) throw new Rechazo(CASO_VEREDICTO.ARGS, campo)
  return limpio
}

/**
 * Las acciones, listas para el `acciones` de un vigia.
 *
 * `run` y `motivoDe` son los del worker (mismo env, mismo tope de salida, mismos motivos
 * estables); `herramienta(nombre)` resuelve la ruta de un CLI en el directorio de
 * herramientas vigente. `lanzarTriage` (opcional) lanza la automatizacion del agente
 * (`agente.mjs`); sin el, "Atender ahora" solo marca el caso. `llaveAprobador()` da la
 * llave del plugin (aprobador.mjs), que viaja SOLO al hijo `wa-send --approve`: sin ella
 * `wa-send` niega la aprobacion.
 */
export function crearAccionesCaso ({ run, herramienta, motivoDe, lanzarTriage, llaveAprobador }) {
  /** `wa-scope caso <sub> ...`: devuelve las filas del JSON o lanza el rechazo. */
  async function caso (args) {
    const cmd = await herramienta('wa-scope')
    let salida
    try {
      salida = await run(cmd, ['caso', ...args, '--json'])
    } catch (error) {
      throw aRechazo(error, motivoDe)
    }
    try {
      const filas = JSON.parse(salida.stdout || 'null')
      if (Array.isArray(filas) && filas[0] && typeof filas[0] === 'object') return filas[0]
    } catch { /* cae al rechazo */ }
    throw new Rechazo('fallo', `wa-scope caso ${args[0]} returned no case`)
  }

  /** `wa-send ...`. Sale 3 y 4 son negativas con motivo (`run` solo rechaza lo que no es
   *  3), asi que cualquier salida distinta de 0 es un fallo. */
  async function enviar (args, env = null) {
    const cmd = await herramienta('wa-send')
    let r
    try {
      r = await run(cmd, args, { timeoutMs: ENVIO_TOPE_MS, ...(env ? { env } : {}) })
    } catch (error) {
      throw aRechazo(error, motivoDe)
    }
    if (r.code !== 0) throw aRechazo(new Error(primeraLinea(r.stderr)), motivoDe)
  }

  const ver = (id) => caso(['ver', String(id)])

  const aprobar = (id, version) =>
    caso(['aprobar', String(id), '--version', version, '--actor', ACTOR])

  const mover = (id, etapa, motivo = '') =>
    caso(['mover', String(id), etapa, ...(motivo ? [`--motivo=${motivo}`] : []),
      '--actor', ACTOR])

  /** Lo que el dueno vio tiene que ser lo vigente. Se mira ANTES de escribir nada: un
   *  rechazo no deja la tarjeta a medias. */
  const exigirVersion = (c, version) => {
    if (c.propuesta_version !== version) {
      throw new Rechazo(CASO_VEREDICTO.VERSION,
        `the proposal changed: it is now ${String(c.propuesta_version).slice(0, 12)}`)
    }
  }

  /** Deja el texto como borrador y lo aprueba. El borrador NUNCA pide `--send`: sobre un
   *  chat en `responder` eso lo mandaria antes de la aprobacion, y lo que lo manda es la
   *  del dueno. `--` antes de la conversacion y el texto: uno que empieza con guion no
   *  es una bandera. */
  async function entregar (c, version, texto) {
    const id = `caso-${c.case_id}-${version.slice(0, 12)}`
    await enviar([`--id=${id}`, ...(c.account ? [`--line=${c.account}`] : []),
      `--timeout=${ENVIO_PLAZO_S}`, '--json', '--', c.chat_jid, texto])
    // La aprobacion es del dueno y la dice el tablero: la llave del plugin va SOLO a este
    // hijo. Sin llave `wa-send` la niega (`send-approve-not-owner`) y el panel lo dice.
    const llave = llaveAprobador ? await llaveAprobador() : null
    await enviar(['--approve', id, '--by', 'board', `--timeout=${ENVIO_PLAZO_S}`, '--json'],
      llave ? { [VARIABLE_APROBADOR]: llave } : null)
    // Salio. Si dar el caso por respondido falla, el mensaje ya esta en la linea: se
    // dice que salio y que el tablero quedo atras. Apretar de nuevo es seguro: el id es
    // el mismo y no se entrega dos veces.
    if (c.etapa === 'respondido') return { ok: true, code: CASO_VEREDICTO.ENVIADO, caseId: c.case_id }
    try {
      await mover(c.case_id, 'respondido')
    } catch (error) {
      return { ok: true, code: CASO_VEREDICTO.ENVIADO, caseId: c.case_id,
        warn: aRechazo(error, motivoDe).code }
    }
    return { ok: true, code: CASO_VEREDICTO.ENVIADO, caseId: c.case_id }
  }

  const aceptarRechazo = (hacer) => async (pedido) => {
    try {
      return await hacer(pedido)
    } catch (error) {
      if (!(error instanceof Rechazo)) throw error
      return { ok: false, code: error.code, detail: error.detail }
    }
  }

  return {
    [CASO_ACCION.ENVIAR]: aceptarRechazo(async (pedido) => {
      const id = idDeCaso(pedido)
      const version = versionDe(pedido)
      const c = await ver(id)
      exigirVersion(c, version)
      const texto = c.propuesta?.respuesta
      if (c.propuesta?.tipo !== 'responder' || typeof texto !== 'string' || !texto) {
        throw new Rechazo(CASO_VEREDICTO.ACCION_INVALIDA, 'the proposal is not a reply')
      }
      await aprobar(id, version)
      return entregar(c, version, texto)
    }),

    [CASO_ACCION.EDITAR_ENVIAR]: aceptarRechazo(async (pedido) => {
      const id = idDeCaso(pedido)
      const version = versionDe(pedido)
      const texto = typeof pedido.texto === 'string' ? pedido.texto.trim() : ''
      if (!texto || texto.length > TEXTO_MAX) throw new Rechazo(CASO_VEREDICTO.ARGS, 'texto')
      const c = await ver(id)
      exigirVersion(c, version)
      // El texto del dueno es una propuesta NUEVA, con su propia version: la que se firma
      // y la que sale. `--respuesta=` en una sola bandera: un texto con guion al
      // principio no se confunde con otra opcion.
      const nueva = await caso(['propuesta', String(id), '--tipo=responder',
        `--respuesta=${texto}`, '--actor', ACTOR])
      if (typeof nueva.propuesta_version !== 'string' || !VERSION.test(nueva.propuesta_version)) {
        throw new Rechazo('fallo', 'wa-scope caso propuesta returned no version')
      }
      await aprobar(id, nueva.propuesta_version)
      return entregar({ ...c, ...nueva }, nueva.propuesta_version,
        nueva.propuesta?.respuesta || texto)
    }),

    [CASO_ACCION.EJECUTAR]: aceptarRechazo(async (pedido) => {
      const id = idDeCaso(pedido)
      const version = versionDe(pedido)
      const c = await ver(id)
      exigirVersion(c, version)
      // Aprobar una respuesta no la manda, y presentarlo como "ejecutar" seria decir
      // que algo corre cuando no corre. Solo se ejecuta un trabajo.
      if (c.propuesta?.tipo !== 'trabajar') {
        throw new Rechazo(CASO_VEREDICTO.ACCION_INVALIDA, 'the proposal is not a job')
      }
      await aprobar(id, version)
      return { ok: true, code: CASO_VEREDICTO.APROBADA, caseId: id }
    }),

    [CASO_ACCION.RECLASIFICAR]: aceptarRechazo(async (pedido) => {
      const id = idDeCaso(pedido)
      await mover(id, 'clasificado', opcional(pedido.nota, 'nota'))
      return { ok: true, code: CASO_VEREDICTO.RECLASIFICADO, caseId: id }
    }),

    [CASO_ACCION.CERRAR]: aceptarRechazo(async (pedido) => {
      const id = idDeCaso(pedido)
      await mover(id, 'cerrado', opcional(pedido.motivo, 'motivo') || MOTIVO_CIERRE)
      return { ok: true, code: CASO_VEREDICTO.CERRADO, caseId: id }
    }),

    [CASO_ACCION.REABRIR]: aceptarRechazo(async (pedido) => {
      const id = idDeCaso(pedido)
      await mover(id, 'recibido')
      return { ok: true, code: CASO_VEREDICTO.REABIERTO, caseId: id }
    }),

    // Marca el caso para el agente: `pending --needs-agent` lo cuenta y triage lo toma en
    // su proxima corrida. El CLI dice E_STAGE fuera de recibido y clasificado.
    [CASO_ACCION.ATENDER]: aceptarRechazo(async (pedido) => {
      const id = idDeCaso(pedido)
      await caso(['atender', String(id), '--actor', ACTOR])
      // El caso ya esta marcado: pase lo que pase al lanzar, la corrida programada lo toma.
      // `lanzarTriage` nunca lanza; dice como le fue y el panel lo muestra.
      const agente = lanzarTriage ? await lanzarTriage() : {}
      return { ok: true, code: CASO_VEREDICTO.ATENDIDO, caseId: id, ...agente }
    }),

    // El dueno suelta las excepciones de ENTRADA de un caso en decision: el CLI las quita,
    // lo marca para el agente y lo devuelve a clasificado (E_STAGE si no esta en decision o
    // no trae excepciones). Lo que el agente redacte sigue pasando por el piso de salida.
    // Despierta al agente igual que Atender ahora, y con la misma salvedad.
    [CASO_ACCION.AUTORIZAR]: aceptarRechazo(async (pedido) => {
      const id = idDeCaso(pedido)
      await caso(['autorizar', String(id), '--actor', ACTOR])
      const agente = lanzarTriage ? await lanzarTriage() : {}
      return { ok: true, code: CASO_VEREDICTO.AUTORIZADO, caseId: id, ...agente }
    }),

    [CASO_ACCION.IGNORAR]: aceptarRechazo(async (pedido) => {
      const id = idDeCaso(pedido)
      await mover(id, 'cerrado', MOTIVO_IGNORADO)
      return { ok: true, code: CASO_VEREDICTO.IGNORADO, caseId: id }
    }),

    // El proyecto en UNA bandera `--proyecto=`: vacio es "sin proyecto". Que este en el
    // catalogo aceptado lo decide el CLI (E_ARGS si no).
    [CASO_ACCION.PROYECTO]: aceptarRechazo(async (pedido) => {
      const id = idDeCaso(pedido)
      const p = pedido.proyecto ?? ''
      if (typeof p !== 'string' || (p !== '' && !ID_PROYECTO.test(p)) || p.length > 120) {
        throw new Rechazo(CASO_VEREDICTO.ARGS, 'proyecto')
      }
      await caso(['proyecto', String(id), `--proyecto=${p}`, '--actor', ACTOR])
      return { ok: true, code: CASO_VEREDICTO.PROYECTO_CAMBIADO, caseId: id }
    })
  }
}
