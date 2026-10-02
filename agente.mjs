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

import { comandoOrca } from './catalogo.mjs'

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

/**
 * Las cuentas de Claude que Ajustes ofrece para el bot ("Cuenta de Claude del bot"): las de
 * `orca account list`, con lo que el panel muestra y nada mas. La CLI nunca imprime
 * credenciales, y aun asi solo pasan cinco campos: lo demas no tiene por que llegar al
 * storage del panel. Lo elegido lo guarda el panel (`botClaudeAccount`) y lo usa `wa-scope`.
 */
export const CUENTAS_ACCION = 'cuentas-claude'
const CUENTAS_MAX = 50
const TEXTO_MAX = 200

const textoCorto = (v) => (typeof v === 'string' && v.trim() && v.length <= TEXTO_MAX ? v.trim() : null)

/** @param {unknown} payload @returns {Array<{ id: string, email: string | null,
 *  authenticated: boolean, active: boolean, used: number | null }> | null} */
export function cuentasDe (payload) {
  const lista = esRegistro(payload) && esRegistro(payload.result) ? payload.result.accounts : null
  if (!Array.isArray(lista)) return null
  return lista.filter((c) => esRegistro(c) && String(c.provider ?? '').toLowerCase() === 'claude' &&
    textoCorto(c.id)).slice(0, CUENTAS_MAX).map((c) => {
    const usado = esRegistro(c.quota) && esRegistro(c.quota.session) ? c.quota.session.usedPercent : null
    return {
      id: textoCorto(c.id),
      email: textoCorto(c.email),
      authenticated: esRegistro(c.auth) && c.auth.state === 'authenticated',
      active: c.active === true,
      used: typeof usado === 'number' && Number.isFinite(usado) ? Math.round(usado) : null
    }
  })
}

/**
 * @param {{ correr: (cmd: string, args: readonly string[], opts?: { timeoutMs: number }) =>
 *             Promise<{ stdout: string }>, plataforma?: string,
 *           env?: Record<string, string | undefined> }} deps
 */
export function crearListaCuentas ({ correr, plataforma = process.platform, env = process.env }) {
  return async function listarCuentas () {
    let salida
    try {
      salida = await correr(comandoOrca(plataforma, env), ['account', 'list', '--json'],
        { timeoutMs: 15000 })
    } catch (error) {
      const sinCli = error?.exitCode === 127 || error?.spawnCode === 'ENOENT'
      return { ok: false, code: sinCli ? 'orca-cli-missing' : 'cuentas-fallo' }
    }
    let sobre = null
    try { sobre = JSON.parse(String(salida?.stdout ?? '') || 'null') } catch { /* cae abajo */ }
    const cuentas = esRegistro(sobre) && sobre.ok !== false ? cuentasDe(sobre) : null
    if (!cuentas) return { ok: false, code: 'cuentas-fallo' }
    return { ok: true, code: 'cuentas', accounts: cuentas }
  }
}
