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
      // Una cuenta de endpoint propio no tiene sesion que Orca vigile: vale tal cual.
      authenticated: c.authMethod === 'custom-endpoint' ||
        (esRegistro(c.auth) && c.auth.state === 'authenticated'),
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

/**
 * Las automatizaciones del plugin, encendidas solas. Cada vez que el dueno vuelve a aprobar
 * el plugin (una actualizacion), Orca las recrea APAGADAS y con ids nuevos, y el tick y el
 * triage quedan sin correr hasta que alguien las enciende a mano. El worker las enciende al
 * arrancar y en cada vuelta de la salud: `orca automations list`, y `automations edit <id>
 * --enabled` para cada una apagada que sea de este plugin.
 *
 * Se reconocen por lo que declara el manifiesto, nunca por un id: el plugin
 * (`<publisher>.<id>`, el `pluginOrigin.pluginKey` que Orca anota) y el id de cada
 * automatizacion (`pluginOrigin.automationId`). Una del dueno, de otro plugin, o una vieja
 * que el manifiesto ya no declara no se toca nunca. Solo se enciende la que Orca dice
 * apagada (`enabled: false`): sin el dato, no se adivina. Y solo un id que nunca se vio
 * encendido: la que el dueno apaga a mano despues de verla andar se queda apagada.
 */
const esTexto = (v) => typeof v === 'string' && v.trim().length > 0

/** @returns {{ pluginKey: string | null, ids: string[] }} */
export function automatizacionesDelManifiesto (manifiesto) {
  const m = esRegistro(manifiesto) ? manifiesto : {}
  const pluginKey = esTexto(m.publisher) && esTexto(m.id) ? `${m.publisher}.${m.id}` : null
  const lista = esRegistro(m.contributes) && Array.isArray(m.contributes.automations)
    ? m.contributes.automations : []
  return { pluginKey, ids: lista.filter((a) => esRegistro(a) && esTexto(a.id)).map((a) => a.id) }
}

const delPlugin = (a, { pluginKey, ids }) => esRegistro(a) && esTexto(a.id) &&
  esRegistro(a.pluginOrigin) && a.pluginOrigin.pluginKey === pluginKey &&
  ids.includes(a.pluginOrigin.automationId)

const listaDe = (payload) =>
  esRegistro(payload) && esRegistro(payload.result) && Array.isArray(payload.result.automations)
    ? payload.result.automations : []

/** Los ids de Orca de las automatizaciones de este plugin que estan apagadas. */
export function apagadasDelPlugin (payload, propias) {
  if (!propias.pluginKey) return []
  return listaDe(payload).filter((a) => delPlugin(a, propias) && a.enabled === false).map((a) => a.id)
}

// La automatizacion del manifiesto que sigue el ritmo del selector del panel
// (`syncMinutes`): la que lanza el agente cuando un caso lo necesita.
export const AUTOMATIZACION_CON_RITMO = 'triage'

/** El cron de "cada N minutos", o null fuera de 1 a 60 minutos enteros. */
export function cronDeMinutos (minutos) {
  if (!Number.isInteger(minutos) || minutos < 1 || minutos > 60) return null
  return minutos === 60 ? '0 * * * *' : `*/${minutos} * * * *`
}

/**
 * Pone la automatizacion `triage` del plugin al ritmo del selector. Solo la del plugin,
 * reconocida por el manifiesto; nada si ya corre a ese ritmo.
 * @param {{ correr: (cmd: string, args: readonly string[], opts?: { timeoutMs: number }) =>
 *             Promise<{ stdout: string }>, manifiesto: unknown, plataforma?: string,
 *           env?: Record<string, string | undefined> }} deps
 * @returns {(minutos: number) => Promise<{ ok: boolean, code: string, minutes: number,
 *            cron: string | null, id: string | null }>}
 */
export function crearAjustadorRitmo ({ correr, manifiesto, plataforma = process.platform, env = process.env }) {
  const propias = automatizacionesDelManifiesto(manifiesto)
  const triage = { pluginKey: propias.pluginKey, ids: propias.ids.filter((id) => id === AUTOMATIZACION_CON_RITMO) }
  return async function ajustar (minutos) {
    const cron = cronDeMinutos(minutos)
    const fuera = (code, id = null) => ({ ok: false, code, minutes: minutos, cron, id })
    if (!cron) return fuera('ritmo-invalido')
    const cmd = comandoOrca(plataforma, env)
    let sobre = null
    try {
      const salida = await correr(cmd, ['automations', 'list', '--json'], { timeoutMs: 15000 })
      sobre = JSON.parse(String(salida?.stdout ?? '') || 'null')
    } catch {
      sobre = null
    }
    if (!esRegistro(sobre) || sobre.ok === false || !esRegistro(sobre.result)) {
      return fuera('automatizaciones-fallo')
    }
    const a = triage.pluginKey ? listaDe(sobre).find((x) => delPlugin(x, triage)) : undefined
    if (!a) return fuera('sin-triage')
    if (a.rrule === cron) return { ok: true, code: 'al-dia', minutes: minutos, cron, id: a.id }
    let respuesta = null
    try {
      const salida = await correr(cmd, ['automations', 'edit', a.id, '--trigger', cron, '--json'],
        { timeoutMs: 15000 })
      try { respuesta = JSON.parse(String(salida?.stdout ?? '') || 'null') } catch { /* sin sobre */ }
    } catch {
      return fuera('ajustar-fallo', a.id)
    }
    // Orca puede contestar `ok: false` con salida 0: eso no lo cambio.
    if (esRegistro(respuesta) && respuesta.ok === false) return fuera('ajustar-fallo', a.id)
    return { ok: true, code: 'ajustado', minutes: minutos, cron, id: a.id }
  }
}

/**
 * @param {{ correr: (cmd: string, args: readonly string[], opts?: { timeoutMs: number }) =>
 *             Promise<{ stdout: string }>, manifiesto: unknown, plataforma?: string,
 *           env?: Record<string, string | undefined> }} deps
 * @returns {() => Promise<{ ok: boolean, code: string, enabled: string[], failed: string[] }>}
 */
export function crearEncendedor ({ correr, manifiesto, plataforma = process.platform, env = process.env }) {
  const propias = automatizacionesDelManifiesto(manifiesto)
  // Los ids que ya se vieron encendidos en esta activacion.
  const vistasEncendidas = new Set()
  return async function encender () {
    const cmd = comandoOrca(plataforma, env)
    let sobre = null
    try {
      const salida = await correr(cmd, ['automations', 'list', '--json'], { timeoutMs: 15000 })
      sobre = JSON.parse(String(salida?.stdout ?? '') || 'null')
    } catch {
      sobre = null
    }
    if (!esRegistro(sobre) || sobre.ok === false || !esRegistro(sobre.result)) {
      return { ok: false, code: 'automatizaciones-fallo', enabled: [], failed: [] }
    }
    const enabled = []
    const failed = []
    for (const a of listaDe(sobre)) {
      if (delPlugin(a, propias) && a.enabled === true) vistasEncendidas.add(a.id)
    }
    for (const id of apagadasDelPlugin(sobre, propias).filter((id) => !vistasEncendidas.has(id))) {
      let respuesta = null
      try {
        const salida = await correr(cmd, ['automations', 'edit', id, '--enabled', '--json'],
          { timeoutMs: 15000 })
        try { respuesta = JSON.parse(String(salida?.stdout ?? '') || 'null') } catch { /* sin sobre */ }
      } catch {
        failed.push(id)
        continue
      }
      // Orca puede contestar `ok: false` con salida 0: eso no la encendio.
      if (esRegistro(respuesta) && respuesta.ok === false) failed.push(id)
      else {
        enabled.push(id)
        vistasEncendidas.add(id)
      }
    }
    return failed.length
      ? { ok: false, code: 'encender-fallo', enabled, failed }
      : { ok: true, code: enabled.length ? 'encendidas' : 'al-dia', enabled, failed }
  }
}
