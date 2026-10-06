/**
 * Las skills que el dueno instala FUERA del plugin (skills-globales, T24): hoy
 * `whatsapp-avisos`, para que un agente de cualquier proyecto le avise y espere su
 * respuesta. Salen de `harness/skills-globales/<nombre>/SKILL.md` y se escriben donde el
 * dueno eligio en la pestana Skills: en `~/.claude/skills/<nombre>/` (global) o en
 * `<proyecto>/.claude/skills/<nombre>/` de un proyecto que ya acepto. En ningun otro lado.
 *
 * La regla de las secciones es la del arnes (`juntar` de harness.mjs): una seccion `##`
 * que el dueno edito es suya y una actualizacion no la toca. Las huellas de lo que el
 * plugin escribio viven en `skills.json` de la carpeta de estado (`dirEstado`), no al lado
 * del archivo: en un proyecto eso seria un archivo mas en el repo del dueno.
 *
 * Escribir no se puede dentro de la valla del worker: esto corre como subproceso
 * (`node skills.mjs <pluginDir> <pedido JSON>`), igual que la siembra del arnes.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync,
  writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dirEstado, huella, juntar, manifiesto, secciones } from './harness.mjs'

/** Lo que el worker deja para el panel: el estado de cada skill en cada destino. */
export const SKILLS_STATUS_KEY = 'skillsStatus'

/** Las acciones del panel, por el canal del alcance (`scopeRequest`). */
export const SKILLS_ACCION = Object.freeze({
  ESTADO: 'skills-estado',
  INSTALAR: 'skill-instalar',
  QUITAR: 'skill-quitar'
})

/** Codigos estables que lee el panel; las frases las arma el panel. */
export const SKILLS_VEREDICTO = Object.freeze({
  LEIDAS: 'skills-leidas',
  ACTUALIZADAS: 'skills-actualizadas',
  INSTALADA: 'skill-instalada',
  ACTUALIZADA: 'skill-actualizada',
  QUITADA: 'skill-quitada',
  // El archivo tiene secciones que edito el dueno: se borra solo si lo confirma.
  EDITADA: 'skill-editada',
  // Hay un SKILL.md que no escribio el plugin: no se pisa ni se borra.
  AJENA: 'skill-ajena',
  SIN_INSTALAR: 'skill-sin-instalar',
  NO_EXISTE: 'skill-no-existe',
  PROYECTO_NO_EXISTE: 'proyecto-no-existe',
  ARGUMENTOS: 'argumentos-invalidos',
  FALLO: 'skills-fallo'
})

/** Los estados de una skill en un destino, tal como los pinta el panel. */
export const SKILL_ESTADO = Object.freeze({
  NO: 'not-installed',
  SI: 'installed',
  VIEJA: 'outdated',
  AJENA: 'foreign'
})

const FUENTE = join('harness', 'skills-globales')
const MANIFIESTO = 'skills.json'
const NOMBRE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** La carpeta de las skills globales de Claude Code. El HOME del entorno manda: las
 *  pruebas lo mueven, y la carpeta real del dueno no se toca nunca desde una prueba. */
export function dirSkillsGlobal(env = process.env) {
  return join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'skills')
}

/** Las skills instalables del plugin: [{ name, description, origen }]. */
export function catalogoSkills(pluginDir) {
  const raiz = join(pluginDir, FUENTE)
  if (!existsSync(raiz)) return []
  return readdirSync(raiz).sort()
    .filter((n) => NOMBRE_RE.test(n) && existsSync(join(raiz, n, 'SKILL.md')))
    .map((n) => {
      const origen = join(raiz, n, 'SKILL.md')
      const m = /^description:\s*(.+)$/m.exec(readFileSync(origen, 'utf8').split('\n---')[0])
      return { name: n, description: m ? m[1].trim() : '', origen }
    })
}

/** El destino, validado: `{ scope: 'global' }` o `{ scope: 'project', project, path }` con
 *  una ruta absoluta. Null si no tiene esa forma. */
function destinoValido(target) {
  if (!target || typeof target !== 'object') return null
  if (target.scope === 'global') return { scope: 'global' }
  if (target.scope !== 'project') return null
  const { project, path } = target
  if (typeof project !== 'string' || !project.trim() || project.length > 64) return null
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return null
  const name = typeof target.name === 'string' ? target.name.slice(0, 120) : project
  return { scope: 'project', project, path: resolve(path), name }
}

function archivoDe(destino, skill, env) {
  const base = destino.scope === 'global'
    ? dirSkillsGlobal(env)
    : join(destino.path, '.claude', 'skills')
  return join(base, skill, 'SKILL.md')
}

function rutaManifiesto(env) {
  return join(dirEstado(env), MANIFIESTO)
}

/** Las instalaciones anotadas. Un archivo que existe y no se puede leer SUBE: leerlo como
 *  vacio volveria "ajeno" todo lo que el plugin escribio, y quitar dejaria de funcionar. */
function leerInstalaciones(env) {
  const ruta = rutaManifiesto(env)
  if (!existsSync(ruta)) return []
  const dato = JSON.parse(readFileSync(ruta, 'utf8'))
  return Array.isArray(dato?.installs) ? dato.installs.filter((i) => i && typeof i.file === 'string') : []
}

function guardarInstalaciones(env, lista) {
  const ruta = rutaManifiesto(env)
  mkdirSync(dirname(ruta), { recursive: true })
  writeFileSync(ruta, `${JSON.stringify({ installs: lista }, null, 2)}\n`, 'utf8')
}

/** Lo que quedaria en el archivo con la plantilla de ahora, sin escribir nada. */
function fusion(plantilla, previo, marcas) {
  if (previo === null) {
    return { texto: plantilla, tuyas: [],
      marcas: Object.fromEntries(secciones(plantilla).map((s) => [s.nombre, huella(s.texto)])) }
  }
  return juntar(secciones(plantilla), secciones(previo), marcas || {})
}

const leerSiHay = (ruta) => (existsSync(ruta) ? readFileSync(ruta, 'utf8') : null)

/** El estado de un destino: instalada, desactualizada, ajena o sin instalar. */
function estadoDe(plantilla, archivo, anotada) {
  const previo = leerSiHay(archivo)
  if (previo === null) return { state: SKILL_ESTADO.NO }
  if (!anotada) return { state: SKILL_ESTADO.AJENA }
  const f = fusion(plantilla, previo, anotada.sections)
  return { state: f.texto === previo ? SKILL_ESTADO.SI : SKILL_ESTADO.VIEJA,
    yours: f.tuyas, version: anotada.version ?? null, at: anotada.at ?? null }
}

/**
 * El estado de cada skill del catalogo en cada destino posible: global, cada proyecto
 * aceptado, y cada proyecto que ya no esta en el catalogo pero sigue teniendo la skill (si
 * no, no habria desde donde quitarla).
 */
export function estadoSkills(pluginDir, proyectos, env = process.env) {
  const { version } = manifiesto(pluginDir)
  const instalaciones = leerInstalaciones(env)
  const aceptados = (Array.isArray(proyectos) ? proyectos : [])
    .map((p) => destinoValido({ scope: 'project', project: p?.id, path: p?.path, name: p?.name }))
    .filter(Boolean)
  const skills = catalogoSkills(pluginDir).map(({ name, description, origen }) => {
    const plantilla = readFileSync(origen, 'utf8')
    const destinos = [{ scope: 'global' }, ...aceptados]
    for (const i of instalaciones) {
      if (i.skill !== name || i.scope !== 'project') continue
      if (destinos.some((d) => d.scope === 'project' && d.path === i.path)) continue
      destinos.push({ scope: 'project', project: i.project, path: i.path, name: i.name,
        accepted: false })
    }
    const targets = destinos.map((d) => {
      const file = archivoDe(d, name, env)
      const anotada = instalaciones.find((i) => i.skill === name && i.file === file)
      return { ...d, accepted: d.accepted ?? true, file, ...estadoDe(plantilla, file, anotada) }
    })
    return { name, description, targets }
  })
  return { ok: true, at: new Date().toISOString(), version, skills }
}

/** Valida el pedido y devuelve con que trabajar, o el veredicto que lo niega. */
function preparar(pluginDir, pedido, env) {
  const skill = catalogoSkills(pluginDir).find((s) => s.name === pedido?.skill)
  if (!skill) return { niega: { ok: false, code: SKILLS_VEREDICTO.NO_EXISTE } }
  const destino = destinoValido(pedido?.target)
  if (!destino) return { niega: { ok: false, code: SKILLS_VEREDICTO.ARGUMENTOS } }
  const archivo = archivoDe(destino, skill.name, env)
  return { skill, destino, archivo }
}

/** Instala o actualiza la skill en un destino. Nunca pisa un archivo que no escribio. */
export function instalar(pluginDir, pedido, env = process.env) {
  const p = preparar(pluginDir, pedido, env)
  if (p.niega) return p.niega
  const { skill, destino, archivo } = p
  if (destino.scope === 'project' && !existsSync(destino.path)) {
    return { ok: false, code: SKILLS_VEREDICTO.PROYECTO_NO_EXISTE }
  }
  const instalaciones = leerInstalaciones(env)
  const anotada = instalaciones.find((i) => i.skill === skill.name && i.file === archivo)
  const previo = leerSiHay(archivo)
  if (previo !== null && !anotada) return { ok: false, code: SKILLS_VEREDICTO.AJENA, file: archivo }
  const f = fusion(readFileSync(skill.origen, 'utf8'), previo, anotada?.sections)
  mkdirSync(dirname(archivo), { recursive: true })
  if (f.texto !== previo) writeFileSync(archivo, f.texto, 'utf8')
  const { version } = manifiesto(pluginDir)
  const fila = { skill: skill.name, ...destino, file: archivo, version,
    at: new Date().toISOString(), sections: f.marcas }
  guardarInstalaciones(env, [...instalaciones.filter((i) => i !== anotada), fila])
  return { ok: true, code: previo === null ? SKILLS_VEREDICTO.INSTALADA : SKILLS_VEREDICTO.ACTUALIZADA,
    file: archivo, yours: f.tuyas }
}

/** Quita lo que el plugin escribio. Con secciones del dueno, solo si `force` (lo confirmo). */
export function quitar(pluginDir, pedido, env = process.env) {
  const p = preparar(pluginDir, pedido, env)
  if (p.niega) return p.niega
  const { skill, archivo } = p
  const instalaciones = leerInstalaciones(env)
  const anotada = instalaciones.find((i) => i.skill === skill.name && i.file === archivo)
  const previo = leerSiHay(archivo)
  if (!anotada) {
    return previo === null
      ? { ok: false, code: SKILLS_VEREDICTO.SIN_INSTALAR }
      : { ok: false, code: SKILLS_VEREDICTO.AJENA, file: archivo }
  }
  if (previo !== null) {
    const f = fusion(readFileSync(skill.origen, 'utf8'), previo, anotada.sections)
    if (f.tuyas.length && pedido.force !== true) {
      return { ok: false, code: SKILLS_VEREDICTO.EDITADA, yours: f.tuyas, file: archivo }
    }
    unlinkSync(archivo)
    // Solo la carpeta de la skill, y solo si quedo vacia: lo demas no lo creo el plugin.
    try { rmdirSync(dirname(archivo)) } catch { /* tiene otros archivos: se queda */ }
  }
  guardarInstalaciones(env, instalaciones.filter((i) => i !== anotada))
  return { ok: true, code: SKILLS_VEREDICTO.QUITADA, file: archivo }
}

/**
 * Lo que corre en cada activacion del plugin: cada copia instalada se pone al dia con las
 * mismas reglas de secciones. Una borrada a mano se toma como quitada (se olvida, no se
 * vuelve a escribir); una que falla se cuenta y no tumba a las demas.
 */
export function actualizarTodas(pluginDir, env = process.env) {
  const catalogo = catalogoSkills(pluginDir)
  const { version } = manifiesto(pluginDir)
  const quedan = []
  const hechas = []
  const fallidas = []
  for (const i of leerInstalaciones(env)) {
    const skill = catalogo.find((s) => s.name === i.skill)
    const previo = leerSiHay(i.file)
    if (previo === null) { hechas.push({ file: i.file, action: 'olvidada' }); continue }
    // Una skill que esta version ya no trae se deja como esta: no hay plantilla nueva.
    if (!skill) { quedan.push(i); continue }
    try {
      const f = fusion(readFileSync(skill.origen, 'utf8'), previo, i.sections)
      if (f.texto !== previo) writeFileSync(i.file, f.texto, 'utf8')
      quedan.push({ ...i, version, at: f.texto !== previo ? new Date().toISOString() : i.at,
        sections: f.marcas })
      hechas.push({ file: i.file, action: f.texto !== previo ? 'actualizada' : 'igual',
        yours: f.tuyas })
    } catch (error) {
      quedan.push(i)
      fallidas.push({ file: i.file, detail: String(error?.message ?? error).slice(0, 200) })
    }
  }
  guardarInstalaciones(env, quedan)
  return { ok: fallidas.length === 0, code: SKILLS_VEREDICTO.ACTUALIZADAS, files: hechas,
    failed: fallidas }
}

/** Un pedido entero, como lo manda el worker: el veredicto mas el estado de despues. */
export function atender(pluginDir, pedido, env = process.env) {
  const op = pedido?.op
  let r
  if (op === 'instalar') r = instalar(pluginDir, pedido, env)
  else if (op === 'quitar') r = quitar(pluginDir, pedido, env)
  else if (op === 'actualizar') r = actualizarTodas(pluginDir, env)
  else if (op === 'estado') r = { ok: true, code: SKILLS_VEREDICTO.LEIDAS }
  else r = { ok: false, code: SKILLS_VEREDICTO.ARGUMENTOS }
  return { ...r, estado: estadoSkills(pluginDir, pedido?.proyectos, env) }
}

// Como subproceso: `node skills.mjs <pluginDir> <pedido JSON>` imprime `atender()`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [pluginDir, pedidoJson] = process.argv.slice(2)
  let salida
  try {
    salida = atender(pluginDir, JSON.parse(pedidoJson || '{}'))
  } catch (error) {
    salida = { ok: false, code: SKILLS_VEREDICTO.FALLO,
      detail: String(error?.message ?? error).slice(0, 300) }
  }
  process.stdout.write(JSON.stringify(salida))
}
