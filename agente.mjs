/**
 * Lanzar el agente en el momento: lo que hace "Atender ahora" despues de marcar el caso.
 *
 * `wa-scope caso atender` solo deja el caso en `necesita_agente`. Para que el clic no
 * parezca no hacer nada, el worker abre al agente de casos ya, por el MISMO camino que el
 * tick: `wa-scope agente lanzar`, que lo abre por terminal en el espacio del plugin con una
 * cuenta de Claude que sirva. Antes se le pedia a Orca `automations run`, y Orca lanza las
 * automatizaciones con la cuenta activa sin dejar elegir otra: con esa cuenta tomada, cada
 * clic terminaba en `dispatch_failed` y nadie lo decia.
 *
 * `wa-scope` nunca abre un segundo agente (si ya hay uno contesta `running`) y tiene su
 * propio plazo, menor que el de este llamado: el panel espera 90 s el veredicto. Corre
 * por `correr`, el mando sin la valla de permisos del worker (`mandoSinValla`): el hijo
 * ejecuta la CLI de Orca, y con el `NODE_OPTIONS` del worker la CLI naceria vallada.
 *
 * El resultado es un codigo estable que el panel traduce. Nunca lleva texto de un mensaje:
 * el motivo de un fallo es uno de los codigos de `wa-scope` o sale del codigo de salida.
 */

/** Lo que el panel lee en `agent`. Renombrar uno rompe el canal en silencio. */
export const AGENTE_VEREDICTO = Object.freeze({
  LANZADO: 'launched',
  EN_CURSO: 'running',
  SIN_CLI: 'orca-cli-missing',
  FALLO: 'run-failed'
})

/** Lo que `wa-scope agente lanzar` tiene para abrir al agente, y lo que se le espera. */
export const AGENTE_PLAZO_S = 60
const LANZAR_PLAZO_MS = 75000
const CODIGO = /^[a-z0-9-]{1,40}$/

const esRegistro = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** El motivo corto de un fallo del subproceso: un codigo, jamas el texto que dijo. */
function motivoCorto (error) {
  if (error?.timedOut) return 'timeout'
  if (Number.isInteger(error?.exitCode)) return `exit-${error.exitCode}`
  return 'failed'
}

/**
 * @param {{ correr: (cmd: string, args: readonly string[], opts?: { timeoutMs: number }) =>
 *             Promise<{ stdout: string }>,
 *           herramienta: (nombre: string) => Promise<string> }} deps
 * @returns {() => Promise<{ agent: string, agentReason?: string }>}
 */
export function crearLanzadorTriage ({ correr, herramienta }) {
  return async function lanzarTriage () {
    let salida
    try {
      const cmd = await herramienta('wa-scope')
      salida = await correr(cmd, ['agente', 'lanzar', '--plazo-s', String(AGENTE_PLAZO_S), '--json'],
        { timeoutMs: LANZAR_PLAZO_MS })
    } catch (error) {
      return { agent: AGENTE_VEREDICTO.FALLO, agentReason: motivoCorto(error) }
    }
    let r = null
    try { r = JSON.parse(String(salida?.stdout ?? '').trim().split('\n').pop() || 'null') } catch { /* cae abajo */ }
    if (!esRegistro(r)) return { agent: AGENTE_VEREDICTO.FALLO, agentReason: 'no-json' }
    if (r.agent === 'launched') return { agent: AGENTE_VEREDICTO.LANZADO }
    // `nothing`: entre el clic y el lanzamiento el caso dejo de esperar al agente (otro
    // agente lo tomo). `running`: ya hay uno, y ese lo va a ver.
    if (r.agent === 'running' || r.agent === 'nothing') return { agent: AGENTE_VEREDICTO.EN_CURSO }
    const motivo = typeof r.reason === 'string' && CODIGO.test(r.reason) ? r.reason : 'failed'
    if (motivo === 'sin-cli') return { agent: AGENTE_VEREDICTO.SIN_CLI }
    return { agent: AGENTE_VEREDICTO.FALLO, agentReason: motivo }
  }
}
