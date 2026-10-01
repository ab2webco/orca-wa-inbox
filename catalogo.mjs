/**
 * El catalogo de proyectos: las carpetas donde el dueno quiere que se haga el trabajo
 * de cada conversacion. Es la lista que el orquestador del plugin reparte.
 *
 * El plugin NO conoce los proyectos de nadie: los pregunta a Orca. `orca worktree ps
 * --json` dice que worktrees hay y `orca repo list --json` como se llama cada repo, y de
 * ahi salen PROPUESTAS. Una propuesta no es un proyecto: solo lo es lo que el dueno
 * acepta en los ajustes. Es el mismo reparto del plugin de Jev (catalogo propuesto,
 * dueno decide), con una diferencia: aqui el proyecto es el repo, no cada worktree.
 *
 * Dos lugares guardan el catalogo, como el alcance: el storage del plugin (clave
 * `projects`, lo escribe el worker y lo lee el panel) y `scope.db` (lo espeja `wa-scope`
 * al leerlo, para que los CLIs no dependan de que el storage exista).
 *
 * Todo lo que toca el host o un proceso entra por `crearCatalogo`: las pruebas le pasan
 * funciones falsas. Lo puro (`proponer`, los lectores) se prueba solo.
 */

export const PROJECTS_KEY = 'projects'
export const PROJECTS_STATUS_KEY = 'projectsStatus'
/** Un tope, no una cuenta: el catalogo viaja entero por storage y por argv. */
export const PROJECTS_MAX = 100
export const NOTE_MAX = 300
const NAME_MAX = 120
const ID_MAX = 48
const ACEPTAR_MAX = 50

/** Los argumentos son literales a proposito: nada que venga del panel, de un repo o de
 *  una rama llega a la linea de comandos. */
export const ORCA_ARGS = Object.freeze({
  worktrees: Object.freeze(['worktree', 'ps', '--json']),
  repos: Object.freeze(['repo', 'list', '--json'])
})

export const PROYECTOS_ACCION = Object.freeze({
  REFRESCAR: 'proyectos-refrescar',
  ACEPTAR: 'proyectos-aceptar',
  QUITAR: 'proyectos-quitar',
  NOTA: 'proyectos-nota'
})

/** Codigos estables que lee el panel; las frases las arma el panel. */
export const PROYECTOS_VEREDICTO = Object.freeze({
  REFRESCADO: 'refrescado',
  ACEPTADO: 'aceptado',
  QUITADO: 'quitado',
  NOTA_GUARDADA: 'nota-guardada',
  SIN_CAMBIOS: 'sin-cambios',
  NO_EXISTE: 'proyecto-no-existe',
  ARGUMENTOS_INVALIDOS: 'argumentos-invalidos',
  LLENO: 'catalogo-lleno',
  SIN_JSON: 'sin-json',
  // La CLI de Orca no esta: `env` sale con 127 cuando no halla el comando, y ENOENT es
  // lo mismo donde no hay `env` (Windows). No es "sin herramientas": esas son las del
  // plugin, y esta es otra.
  SIN_CLI: 'sin-cli-orca'
})

/**
 * @typedef {{ id: string, name: string, path: string, note: string }} Proyecto
 * @typedef {{ id: string, name: string, path: string }} Propuesta
 * @typedef {{ repoId: string | null, repo: string, path: string,
 *             isArchived: boolean, isMainWorktree: boolean }} Worktree
 * @typedef {{ id: string, path: string, displayName: string | null }} Repo
 */

/** El nombre de la CLI. En Linux es `orca-ide`: un `orca` pelado es el lector de
 *  pantalla de GNOME y arrancarlo habla. ORCA_CLI_COMMAND, cuando esta, manda. */
export function comandoOrca (plataforma = process.platform, env = process.env) {
  const declarado = String(env.ORCA_CLI_COMMAND ?? '').trim()
  if (declarado) return declarado
  return plataforma === 'linux' ? 'orca-ide' : 'orca'
}

const esRegistro = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const esTexto = (v) => typeof v === 'string' && v.trim().length > 0

/** @returns {Worktree[]} la lista del sobre `{ result: { worktrees } }`; lo demas, vacia. */
export function leerWorktrees (payload) {
  const lista = esRegistro(payload) && esRegistro(payload.result)
    ? payload.result.worktrees : null
  if (!Array.isArray(lista)) return []
  return lista.filter((w) => esRegistro(w) && esTexto(w.repo) && esTexto(w.path))
    .map((w) => ({
      repoId: esTexto(w.repoId) ? w.repoId : null,
      repo: w.repo,
      path: w.path.trim(),
      isArchived: w.isArchived === true,
      isMainWorktree: w.isMainWorktree === true
    }))
}

/** @returns {Repo[]} */
export function leerRepos (payload) {
  const lista = esRegistro(payload) && esRegistro(payload.result) ? payload.result.repos : null
  if (!Array.isArray(lista)) return []
  return lista.filter((r) => esRegistro(r) && esTexto(r.id) && esTexto(r.path))
    .map((r) => ({
      id: r.id,
      path: r.path.trim(),
      displayName: esTexto(r.displayName) ? r.displayName.trim() : null
    }))
}

function sinSeparadorFinal (ruta) {
  return ruta.length > 1 ? ruta.replace(/[/\\]+$/, '') || ruta : ruta
}

/** `candidata` esta DENTRO de `ancestro`: por segmentos enteros, para que `/a/repo-2` no
 *  cuente como parte de `/a/repo`. Igual de estricto en Windows. */
export function estaDentro (candidata, ancestro) {
  const a = sinSeparadorFinal(ancestro)
  const c = sinSeparadorFinal(candidata)
  if (a === c) return false
  const sep = a.includes('\\') || c.includes('\\') ? '\\' : '/'
  return c.startsWith(a.endsWith(sep) ? a : `${a}${sep}`)
}

/** Minusculas y sin signos: es la llave que guardan las conversaciones, asi que no
 *  puede cambiar de una corrida a otra. */
export function idDe (nombre) {
  const slug = String(nombre).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return (slug || 'project').slice(0, ID_MAX).replace(/-+$/, '') || 'project'
}

/** Una linea, sin controles, con tope: nombres, rutas y notas acaban en un archivo que
 *  lee un agente, y un salto de linea ahi dentro es una instruccion nueva. */
export function limpiarLinea (valor, max) {
  // eslint-disable-next-line no-control-regex
  return String(valor ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ')
    .trim().slice(0, max)
}

/**
 * Los proyectos que Orca conoce y el catalogo todavia no cubre.
 *
 * Un proyecto es un REPO con al menos un worktree vivo (los archivados no cuentan), en
 * la ruta del repo: la de `repo list` si la hay, si no la del worktree principal, si no
 * la mas corta. Lo que queda dentro de otro proyecto -propuesto o ya aceptado- no se
 * propone: el que lo cubre ya lo incluye, igual que el resolvedor del plugin de Jev.
 *
 * @param {Worktree[]} worktrees
 * @param {Repo[]} repos
 * @param {Proyecto[]} aceptados
 * @returns {Propuesta[]}
 */
export function proponer (worktrees, repos, aceptados) {
  const porRepo = new Map()
  for (const w of worktrees) {
    if (w.isArchived || !w.path) continue
    const llave = w.repoId ?? `nombre:${w.repo}`
    const grupo = porRepo.get(llave) ?? []
    grupo.push(w)
    porRepo.set(llave, grupo)
  }
  const candidatos = []
  for (const [llave, grupo] of porRepo) {
    const repo = repos.find((r) => r.id === grupo[0].repoId)
    const principal = grupo.find((w) => w.isMainWorktree)
    const masCorta = [...grupo].sort((a, b) => a.path.length - b.path.length)[0]
    const ruta = sinSeparadorFinal(repo?.path ?? principal?.path ?? masCorta.path)
    candidatos.push({ llave, ruta, nombre: limpiarLinea(repo?.displayName ?? grupo[0].repo, NAME_MAX) })
  }
  // Una sola vuelta por ruta, en orden de ruta: con el orden de Orca los sufijos de los
  // ids cambiarian segun que worktree se abrio primero.
  candidatos.sort((a, b) => (a.ruta < b.ruta ? -1 : a.ruta > b.ruta ? 1 : 0))
  const unicos = []
  for (const c of candidatos) {
    if (unicos.some((u) => u.ruta === c.ruta)) continue
    unicos.push(c)
  }
  const rutasAceptadas = aceptados.map((p) => sinSeparadorFinal(p.path))
  const cubiertos = unicos.filter((c) =>
    !unicos.some((otro) => estaDentro(c.ruta, otro.ruta)) &&
    !rutasAceptadas.some((r) => r === c.ruta || estaDentro(c.ruta, r)))
  const usados = new Set(aceptados.map((p) => p.id))
  const salida = []
  for (const c of cubiertos) {
    const base = idDe(c.nombre)
    let id = base
    let n = 2
    while (usados.has(id)) id = `${base.slice(0, ID_MAX - String(n).length - 1)}-${n++}`
    usados.add(id)
    salida.push({ id, name: c.nombre, path: c.ruta })
  }
  return salida.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** El catalogo guardado, validado: una entrada mal formada se descarta en vez de
 *  tumbar el panel o el arnes. @returns {Proyecto[]} */
export function leerCatalogo (valor) {
  if (!Array.isArray(valor)) return []
  const vistos = new Set()
  const salida = []
  for (const p of valor) {
    if (!esRegistro(p) || !esTexto(p.id) || !esTexto(p.path)) continue
    if (!/^[a-z0-9][a-z0-9-]*$/.test(p.id) || vistos.has(p.id)) continue
    vistos.add(p.id)
    salida.push({
      id: p.id,
      name: limpiarLinea(p.name, NAME_MAX) || p.id,
      path: limpiarLinea(p.path, 1024),
      note: limpiarLinea(p.note, NOTE_MAX)
    })
  }
  return salida
}

/**
 * El catalogo del worker: lo que el panel puede pedir y como se contesta.
 *
 * `correr(cmd, args)` ejecuta un proceso y devuelve `{ stdout }`; rechaza con
 * `spawnCode`/`exitCode`/`timedOut` como `run()` de main.mjs. `motivoDe` traduce ese
 * rechazo a un codigo estable. `resembrar(lista)` deja PROJECTS.md al dia con esa lista
 * en la carpeta del orquestador.
 *
 * @param {{ orca: { log: (m: string) => void },
 *           leer: (key: string) => Promise<unknown>,
 *           guardar: (key: string, value: unknown) => Promise<unknown>,
 *           correr: (cmd: string, args: readonly string[]) => Promise<{ stdout: string }>,
 *           motivoDe: (error: unknown) => string,
 *           resembrar: (lista: Proyecto[]) => Promise<unknown>,
 *           plataforma?: string,
 *           env?: Record<string, string | undefined>,
 *           ahora?: () => string }} deps
 */
export function crearCatalogo ({ orca, leer, guardar, correr, motivoDe, resembrar,
  plataforma = process.platform, env = process.env, ahora = () => new Date().toISOString() }) {
  const catalogo = async () => leerCatalogo(await leer(PROJECTS_KEY))

  const codigoDeFallo = (error) => {
    if (error instanceof SyntaxError) return PROYECTOS_VEREDICTO.SIN_JSON
    if (error?.exitCode === 127 || error?.spawnCode === 'ENOENT') return PROYECTOS_VEREDICTO.SIN_CLI
    return motivoDe(error)
  }

  /** Pregunta a Orca. Sin worktrees no hay nada que proponer y se dice por que; sin
   *  `repo list` si hay: solo se pierden los nombres bonitos. */
  async function preguntar () {
    const cmd = comandoOrca(plataforma, env)
    let worktrees
    try {
      const { stdout } = await correr(cmd, ORCA_ARGS.worktrees)
      worktrees = leerWorktrees(JSON.parse(stdout || 'null'))
    } catch (error) {
      const code = codigoDeFallo(error)
      orca.log(`orca worktree ps failed (${code}): ${String(error?.message ?? error).slice(0, 160)}`)
      return { ok: false, code, detail: String(error?.message ?? error).slice(0, 200) }
    }
    let repos = []
    try {
      const { stdout } = await correr(cmd, ORCA_ARGS.repos)
      repos = leerRepos(JSON.parse(stdout || 'null'))
    } catch (error) {
      orca.log(`orca repo list failed, names fall back to the repo name: ${String(error?.message ?? error).slice(0, 120)}`)
    }
    return { ok: true, worktrees, repos }
  }

  const publicar = (estado) => guardar(PROJECTS_STATUS_KEY, { at: ahora(), ...estado })

  /** Refresca la lista de propuestas del panel. Un fallo NO es "no hay propuestas": el
   *  estado dice que no se pudo preguntar, para que el panel no mienta con una lista
   *  vacia. */
  async function refrescar () {
    const visto = await preguntar()
    if (!visto.ok) {
      await publicar({ ok: false, proposals: [], reason: visto.code, detail: visto.detail })
      return { ok: false, code: visto.code, detail: visto.detail }
    }
    const propuestas = proponer(visto.worktrees, visto.repos, await catalogo())
    await publicar({ ok: true, proposals: propuestas, reason: null, detail: null })
    return { ok: true, code: PROYECTOS_VEREDICTO.REFRESCADO, proposals: propuestas.length }
  }

  /** Guarda el catalogo y deja el arnes al dia. El arnes es de mejor esfuerzo: si la
   *  carpeta no existe, el catalogo ya quedo guardado y el estado del arnes dice por
   *  que no se sembro. */
  async function cambiar (siguiente) {
    await guardar(PROJECTS_KEY, siguiente)
    try {
      await resembrar(siguiente)
    } catch (error) {
      orca.log(`harness reseed after catalog change failed: ${String(error?.message ?? error).slice(0, 160)}`)
    }
  }

  /** Acepta lo que el dueno marco. NO se confia en lo que manda el panel: se pregunta de
   *  nuevo a Orca y solo entra lo que sigue siendo una propuesta; el nombre y la ruta
   *  salen de Orca, nunca del pedido. */
  async function aceptar (pedido) {
    const ids = Array.isArray(pedido.ids) ? pedido.ids : null
    if (!ids || ids.length === 0 || ids.length > ACEPTAR_MAX || !ids.every(esTexto)) {
      return { ok: false, code: PROYECTOS_VEREDICTO.ARGUMENTOS_INVALIDOS }
    }
    const visto = await preguntar()
    if (!visto.ok) {
      await publicar({ ok: false, proposals: [], reason: visto.code, detail: visto.detail })
      return { ok: false, code: visto.code, detail: visto.detail }
    }
    const actual = await catalogo()
    const vigentes = new Map(proponer(visto.worktrees, visto.repos, actual).map((p) => [p.id, p]))
    const nuevos = []
    for (const id of new Set(ids)) {
      const p = vigentes.get(id)
      if (p) nuevos.push({ ...p, note: '' })
    }
    if (nuevos.length === 0) return { ok: false, code: PROYECTOS_VEREDICTO.SIN_CAMBIOS }
    if (actual.length + nuevos.length > PROJECTS_MAX) {
      return { ok: false, code: PROYECTOS_VEREDICTO.LLENO }
    }
    const siguiente = [...actual, ...nuevos].sort((a, b) => (a.id < b.id ? -1 : 1))
    await cambiar(siguiente)
    await publicar({ ok: true, proposals: proponer(visto.worktrees, visto.repos, siguiente),
      reason: null, detail: null })
    return { ok: true, code: PROYECTOS_VEREDICTO.ACEPTADO, added: nuevos.length }
  }

  // El proyecto va en `project` y no en `id`: `id` es el del PEDIDO (el panel lo pone para
  // reconocer su veredicto), y un campo con el mismo nombre pisaria uno con el otro.
  async function quitar (pedido) {
    if (!esTexto(pedido.project)) return { ok: false, code: PROYECTOS_VEREDICTO.ARGUMENTOS_INVALIDOS }
    const actual = await catalogo()
    if (!actual.some((p) => p.id === pedido.project)) {
      return { ok: false, code: PROYECTOS_VEREDICTO.NO_EXISTE }
    }
    await cambiar(actual.filter((p) => p.id !== pedido.project))
    return { ok: true, code: PROYECTOS_VEREDICTO.QUITADO }
  }

  async function nota (pedido) {
    if (!esTexto(pedido.project) || typeof pedido.note !== 'string') {
      return { ok: false, code: PROYECTOS_VEREDICTO.ARGUMENTOS_INVALIDOS }
    }
    const actual = await catalogo()
    if (!actual.some((p) => p.id === pedido.project)) {
      return { ok: false, code: PROYECTOS_VEREDICTO.NO_EXISTE }
    }
    const texto = limpiarLinea(pedido.note, NOTE_MAX)
    await cambiar(actual.map((p) => (p.id === pedido.project ? { ...p, note: texto } : p)))
    return { ok: true, code: PROYECTOS_VEREDICTO.NOTA_GUARDADA }
  }

  return {
    catalogo,
    acciones: {
      [PROYECTOS_ACCION.REFRESCAR]: () => refrescar(),
      [PROYECTOS_ACCION.ACEPTAR]: (pedido) => aceptar(pedido),
      [PROYECTOS_ACCION.QUITAR]: (pedido) => quitar(pedido),
      [PROYECTOS_ACCION.NOTA]: (pedido) => nota(pedido)
    }
  }
}
