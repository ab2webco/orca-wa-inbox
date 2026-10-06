/**
 * Los avisos de Orca por WhatsApp, del lado del worker (odd/tasks/avisos-orca.md).
 *
 * Orca le avisa al plugin cada estado de cada agente (`agent.status.changed`): en cada
 * emision, no solo cuando cambia. Aca se guarda el ultimo estado de cada panel para saber
 * cuando CAMBIO, y con eso dos cosas:
 *
 *  - un agente que pasa a `waiting` (pide permiso o pregunta algo) o a `blocked` (decision
 *    del dueno, 2026-10-05): si el dueno encendio ese aviso, se lanza `wa-scope orca-aviso`,
 *    que decide el resto (numero, silencio, tope, la ventana compartida) y lo manda;
 *  - un `done` que viene de `working`: queda marcado `finished` en `orcaPanes`, y el tick
 *    avisa despues de la espera si el panel no volvio a trabajar. Un `done` sin trabajo
 *    antes (arranque, reanudar, limpiar) o marcado `sessionBoundary` nunca avisa.
 *
 * Los agentes del propio plugin (triage y el de casos) corren en su carpeta de trabajo, y
 * esos no se miran: el dueno ya se entera de ellos por el tablero.
 *
 * Nada de lo que el agente escribio llega hasta aca: el payload es una proyeccion acotada
 * de Orca (panel, espacio, estado, tipo de agente). Esto tampoco lo guarda.
 */

// La clave de storage con el estado de cada panel, que el tick lee para el "termino".
export const PANELES_KEY = 'orcaPanes'
// Los ajustes del panel (una sola clave, como `firstReply`). La principal los tiene en la raiz
// y cada otra linea en `ajustesPorLinea[<numero>].orcaNotices` (todo-por-linea, P1).
export const AVISOS_ORCA_KEY = 'orcaNotices'
export const AJUSTES_POR_LINEA_KEY = 'ajustesPorLinea'
// Un panel que no se movio en un dia ya no importa: se olvida.
export const PANELES_VIDA_MS = 24 * 60 * 60 * 1000
// Y nunca mas de estos: el storage entero viaja en cada lectura del panel.
export const PANELES_TOPE = 200
// Cuanto se juntan los cambios antes de escribirlos: el host admite 30 mensajes por 10 s,
// y varios agentes trabajando cambian de estado varias veces por segundo.
export const GUARDAR_CADA_MS = 2000
// `wa-scope orca-aviso` le pregunta a Orca los nombres y espera a `wa-send`.
export const AVISO_PLAZO_MS = 90 * 1000

// Los estados que avisan, por el mismo interruptor (`waiting` del panel): esperar y bloquearse
// son lo mismo para el dueno, alguien tiene que mirar ese agente.
export const ESTADOS_QUE_AVISAN = ['waiting', 'blocked']

const SEPARADOR = '::'
const INSTANCIA = /::workspace:[0-9a-f-]{36}$/

/** Si el espacio de ese agente es la carpeta de trabajo del plugin (`llave` es
 *  `<publisher>.<id>`). El id de Orca es `<repoId>::<ruta>`, y una sesion de una carpeta
 *  le suma `::workspace:<uuid>`: la ruta es lo que va despues del primer separador. */
export function esEspacioDelPlugin (worktreeId, llave) {
  if (typeof worktreeId !== 'string' || !llave) return false
  const i = worktreeId.indexOf(SEPARADOR)
  if (i === -1) return false
  const ruta = worktreeId.slice(i + SEPARADOR.length).replace(INSTANCIA, '')
    .replace(/[\\/]+$/, '')
  const partes = ruta.split(/[\\/]/)
  return partes.length >= 2 && partes[partes.length - 1] === llave &&
    partes[partes.length - 2] === 'plugin-workspaces'
}

const texto = (v) => typeof v === 'string' && v.trim() ? v.trim() : null

/** Si alguna linea tiene encendido el aviso de espera: la principal (`raiz`, lo de la raiz)
 *  o cualquier otra en su contenedor. Es solo la compuerta para no lanzar un proceso por
 *  nada: `wa-scope orca-aviso` corre en cada linea y cada una decide con lo suyo. */
export function algunaLineaEspera (raiz, contenedor) {
  if (raiz?.waiting === 'on') return true
  const lineas = contenedor && typeof contenedor === 'object' ? Object.values(contenedor) : []
  return lineas.some((l) => l && typeof l === 'object' && l.orcaNotices?.waiting === 'on')
}

/** El estado nuevo de los paneles con un evento: `{ paneles, cambio, avisar }`.
 *
 *  `cambio` dice si hay que escribir; `avisar` es `waiting` o `blocked` cuando el panel acaba
 *  de pasar a uno de los dos. No muta lo que recibe. */
export function registrarEstado (paneles, payload, llave) {
  const actuales = paneles && typeof paneles === 'object' ? paneles : {}
  const pane = texto(payload?.paneKey)
  const estado = texto(payload?.state)
  const at = typeof payload?.receivedAt === 'number' && Number.isFinite(payload.receivedAt)
    ? payload.receivedAt : null
  if (!pane || !estado || at === null || esEspacioDelPlugin(payload?.worktreeId, llave)) {
    return { paneles: actuales, cambio: false, avisar: null }
  }
  const previo = actuales[pane]
  if (previo && previo.state === estado) {
    return { paneles: actuales, cambio: false, avisar: null }
  }
  const nuevo = {
    state: estado,
    at,
    worktreeId: texto(payload.worktreeId),
    agentType: texto(payload.agentType),
    workingAt: estado === 'working' ? at : (previo?.workingAt ?? null),
    // Solo un turno que termino: venia trabajando y no es un borde de sesion.
    finished: estado === 'done' && previo?.state === 'working' && payload.sessionBoundary !== true
  }
  const salida = { ...actuales, [pane]: nuevo }
  for (const [k, v] of Object.entries(salida)) {
    if (!v || typeof v.at !== 'number' || at - v.at > PANELES_VIDA_MS) delete salida[k]
  }
  const claves = Object.keys(salida)
  if (claves.length > PANELES_TOPE) {
    claves.sort((a, b) => salida[a].at - salida[b].at)
      .slice(0, claves.length - PANELES_TOPE).forEach((k) => { delete salida[k] })
  }
  return { paneles: salida, cambio: true, avisar: ESTADOS_QUE_AVISAN.includes(estado) ? estado : null }
}

/** Los argumentos de `wa-scope orca-aviso` para un panel que paso a esperar o a bloqueado.
 *  Con `=`: un valor que empezara con un guion no se puede leer como otra opcion. */
export function argsDeAviso (payload) {
  const args = ['orca-aviso', `--state=${payload.state}`, `--pane=${payload.paneKey}`,
    `--at=${payload.receivedAt}`]
  if (texto(payload.worktreeId)) args.push(`--worktree=${payload.worktreeId}`)
  if (texto(payload.agentType)) args.push(`--agent=${payload.agentType}`)
  args.push('--json')
  return args
}

/** El que atiende los eventos: carga lo guardado una vez, procesa los eventos en fila y
 *  junta las escrituras. `leer`/`guardar` son del storage del host; `lanzar(args)` corre
 *  `wa-scope`. Devuelve `{ recibir, parar, listo }`. */
export function crearAvisosOrca ({ leer, guardar, lanzar, llave, log = () => {},
  guardarCadaMs = GUARDAR_CADA_MS }) {
  let paneles = {}
  let sucio = false
  let timer = null
  let detenido = false
  const cargado = Promise.resolve(leer(PANELES_KEY)).then((v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) paneles = v
  }).catch(() => {})
  let fila = cargado

  const escribir = () => {
    timer = null
    if (!sucio) return Promise.resolve()
    sucio = false
    return Promise.resolve(guardar(PANELES_KEY, paneles)).catch(() => {})
  }
  const programar = () => {
    sucio = true
    if (timer || detenido) return
    timer = setTimeout(escribir, guardarCadaMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function recibir (payload) {
    if (detenido) return fila
    fila = fila.then(async () => {
      const r = registrarEstado(paneles, payload, llave)
      if (!r.cambio) return
      paneles = r.paneles
      programar()
      if (!r.avisar) return
      const raiz = await leer(AVISOS_ORCA_KEY)
      const contenedor = raiz?.waiting === 'on' ? null : await leer(AJUSTES_POR_LINEA_KEY)
      if (!algunaLineaEspera(raiz, contenedor) || detenido) return
      await lanzar(argsDeAviso(payload))
    }).catch((error) => log(`orca notice failed: ${String(error?.message ?? error).slice(0, 200)}`))
    return fila
  }

  function parar () {
    detenido = true
    clearTimeout(timer)
    timer = null
    return escribir()
  }

  return { recibir, parar, listo: cargado, estado: () => paneles }
}
