/**
 * Lanzar el agente en el momento: lo que hace "Atender ahora" despues de marcar el caso.
 *
 * `wa-scope caso atender` solo deja el caso en `necesita_agente`; la automatizacion
 * `triage` corre cada 5 minutos. Para que el clic no parezca no hacer nada, el worker le
 * pide a Orca que corra esa automatizacion ya, con la misma CLI que usa el catalogo
 * (`comandoOrca`): `orca automations list --json` para hallarla y `orca automations run
 * <id> --json` para lanzarla. Son DOS llamadas por clic y no se guarda nada entre clics.
 *
 * Se halla por su ORIGEN (`pluginOrigin`), nunca por el nombre: el dueno la puede
 * renombrar, y otro plugin puede tener una con el mismo nombre.
 *
 * El resultado es un codigo estable que el panel traduce. Nunca lleva texto de un mensaje:
 * el motivo de un fallo sale del codigo de salida o del codigo de error de la CLI.
 */
import { comandoOrca } from './catalogo.mjs'

/** Lo que el panel lee en `agent`. Renombrar uno rompe el canal en silencio. */
export const AGENTE_VEREDICTO = Object.freeze({
  LANZADO: 'launched',
  SIN_TRIAGE: 'triage-not-found',
  SIN_CLI: 'orca-cli-missing',
  FALLO: 'run-failed'
})

const PLUGIN_KEY = 'ab2web.orca-wa-inbox'
const AUTOMATION_ID = 'triage'
const LISTAR_PLAZO_MS = 15000
const LANZAR_PLAZO_MS = 30000
const CODIGO_CLI = /^[A-Za-z0-9_-]{1,40}$/

const esRegistro = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** @returns {string | null} el id de la automatizacion `triage` de ESTE plugin. */
export function hallarTriage (payload) {
  const lista = esRegistro(payload) && esRegistro(payload.result) ? payload.result.automations : null
  if (!Array.isArray(lista)) return null
  const hallada = lista.find((a) => esRegistro(a) && typeof a.id === 'string' && a.id &&
    esRegistro(a.pluginOrigin) && a.pluginOrigin.pluginKey === PLUGIN_KEY &&
    a.pluginOrigin.automationId === AUTOMATION_ID)
  return hallada ? hallada.id : null
}

/** El motivo corto de un fallo: un codigo, jamas el texto que dijo la CLI. */
function motivoCorto (error) {
  if (error?.timedOut) return 'timeout'
  if (Number.isInteger(error?.exitCode)) return `exit-${error.exitCode}`
  return 'failed'
}

const sinCli = (error) => error?.exitCode === 127 || error?.spawnCode === 'ENOENT'

/** Lo que dice la CLI en el sobre `{ ok: false, error: { code } }`, si lo dice. */
function motivoDeSobre (sobre) {
  const codigo = esRegistro(sobre?.error) ? sobre.error.code : null
  return typeof codigo === 'string' && CODIGO_CLI.test(codigo) ? codigo : 'rejected'
}

/**
 * @param {{ correr: (cmd: string, args: readonly string[], opts?: { timeoutMs: number }) =>
 *             Promise<{ stdout: string }>,
 *           plataforma?: string,
 *           env?: Record<string, string | undefined> }} deps
 * @returns {() => Promise<{ agent: string, agentReason?: string }>}
 */
export function crearLanzadorTriage ({ correr, plataforma = process.platform, env = process.env }) {
  return async function lanzarTriage () {
    const cmd = comandoOrca(plataforma, env)
    let id
    try {
      const { stdout } = await correr(cmd, ['automations', 'list', '--json'],
        { timeoutMs: LISTAR_PLAZO_MS })
      let sobre
      try {
        sobre = JSON.parse(stdout || 'null')
      } catch {
        return { agent: AGENTE_VEREDICTO.FALLO, agentReason: 'no-json' }
      }
      if (esRegistro(sobre) && sobre.ok === false) {
        return { agent: AGENTE_VEREDICTO.FALLO, agentReason: motivoDeSobre(sobre) }
      }
      id = hallarTriage(sobre)
    } catch (error) {
      return sinCli(error)
        ? { agent: AGENTE_VEREDICTO.SIN_CLI }
        : { agent: AGENTE_VEREDICTO.FALLO, agentReason: motivoCorto(error) }
    }
    if (!id) return { agent: AGENTE_VEREDICTO.SIN_TRIAGE }
    try {
      const { stdout } = await correr(cmd, ['automations', 'run', id, '--json'],
        { timeoutMs: LANZAR_PLAZO_MS })
      let sobre = null
      try { sobre = JSON.parse(stdout || 'null') } catch { /* sin JSON: salio 0, se da por lanzado */ }
      if (esRegistro(sobre) && sobre.ok === false) {
        return { agent: AGENTE_VEREDICTO.FALLO, agentReason: motivoDeSobre(sobre) }
      }
      return { agent: AGENTE_VEREDICTO.LANZADO }
    } catch (error) {
      return sinCli(error)
        ? { agent: AGENTE_VEREDICTO.SIN_CLI }
        : { agent: AGENTE_VEREDICTO.FALLO, agentReason: motivoCorto(error) }
    }
  }
}
