/**
 * El arnes del agente: los archivos que el plugin deja puestos en su carpeta de
 * trabajo para que el agente haga bien el trabajo con cualquier modelo.
 *
 * Todo lo que sabe el agente vive hoy en el prompt, que se lee una vez por corrida.
 * Un modelo mas chico improvisa. Un archivo en el directorio de trabajo es contexto
 * persistente que todo agente lee sin que haya que pedirselo — y Orca ya le mete el
 * AGENTS.md de la carpeta al contexto — asi que la doctrina vive aca y el prompt
 * queda con los pasos.
 *
 * La carpeta la crea Orca en <userData>/plugin-workspaces/<llave>. Todavia no esta
 * en todas las instalaciones: si no se puede resolver, esto falla callado y deja el
 * motivo escrito, como hace `syncStatus`. El plugin sigue andando igual que hoy.
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// El estado del arnes va por el mismo canal que el del sync: el panel no puede
// ejecutar nada, asi que sin esto no hay forma de saber si la carpeta se sembro.
export const HARNESS_KEY = 'harnessStatus'
// Donde queda anotado que escribio el plugin la ultima vez. Sin esto no se puede
// distinguir "lo cambio el plugin" de "lo edito el usuario", que es justo la
// diferencia que decide si un archivo se reescribe o se respeta.
const MANIFIESTO = '.harness.json'
const MARCA_HELP = '<!-- HARNESS:HELP -->'

/** Donde Electron guarda el userData. Es la misma tabla que `user_data_roots()` de
 *  bin/wa-scope: dos esquemas distintos serian dos verdades que se desincronizan. */
function userDataRoots() {
  const home = homedir()
  let base
  if (process.platform === 'darwin') {
    base = join(home, 'Library', 'Application Support')
  } else if (process.platform === 'win32') {
    base = process.env.APPDATA || join(home, 'AppData', 'Roaming')
  } else {
    base = process.env.XDG_CONFIG_HOME || join(home, '.config')
  }
  return ['orca', 'orca-dev', 'zzorcanametest'].map((d) => join(base, d))
}

function esDirectorio(ruta) {
  try {
    return existsSync(ruta) && readdirSync(ruta) !== null
  } catch {
    return false
  }
}

/** El manifiesto del plugin, que es de donde salen la llave y la version. Copiarlas
 *  a mano aca es lo que hizo fallar un chequeo cuando el plugin se renombro. */
export function manifiesto(pluginDir) {
  const man = JSON.parse(readFileSync(join(pluginDir, 'orca-plugin.json'), 'utf8'))
  return { key: `${man.publisher}.${man.id}`, version: String(man.version ?? '0.0.0') }
}

/**
 * La carpeta de trabajo del plugin, o null si en esta maquina no se puede decir cual
 * es. Se elige el userData donde el plugin YA vive: con el instalado y un build dev
 * abiertos, sembrar en el otro deja el arnes donde nadie lo lee.
 */
export function workspaceDir(pluginDir) {
  const { key } = manifiesto(pluginDir)
  const raices = userDataRoots().filter(esDirectorio)
  if (!raices.length) return null
  const yaSembrada = raices.find((r) => esDirectorio(join(r, 'plugin-workspaces', key)))
  const conDatos = raices.find((r) => esDirectorio(join(r, 'plugins-data', key)))
  return join(yaSembrada ?? conDatos ?? raices[0], 'plugin-workspaces', key)
}

/** sha256 en hex, sobre los bytes que de verdad quedan en el archivo. Es la misma
 *  huella que usa Orca para los campos de una automatizacion del plugin. */
function huella(texto) {
  return createHash('sha256').update(texto, 'utf8').digest('hex')
}

/** Un archivo partido en secciones `##`. Lo de antes del primer `##` es el
 *  encabezado y se trata como una seccion mas, con nombre vacio. */
export function secciones(texto) {
  const salida = []
  let nombre = ''
  let buffer = []
  for (const linea of String(texto).split('\n')) {
    if (/^## /.test(linea)) {
      salida.push({ nombre, texto: buffer.join('\n') })
      nombre = linea.slice(3).trim()
      buffer = [linea]
      continue
    }
    buffer.push(linea)
  }
  salida.push({ nombre, texto: buffer.join('\n') })
  return salida
}

/**
 * Junta lo que el plugin declara ahora con lo que hay en disco, seccion por seccion.
 *
 * Es la regla de las huellas por campo de las automatizaciones, aplicada a secciones
 * de un archivo: si la huella anotada sigue coincidiendo con lo que hay en disco, esa
 * seccion es del plugin y se reescribe; si no coincide, la edito el usuario, se
 * respeta, y se CONSERVA la huella vieja del plugin para que siga divergente en todas
 * las corridas siguientes y nunca se readopte en silencio.
 */
export function juntar(declaradas, enDisco, marcas) {
  const mapa = new Map()
  const repetidas = []
  for (const s of enDisco) {
    if (mapa.has(s.nombre)) { repetidas.push(s); continue }
    mapa.set(s.nombre, s)
  }
  const partes = []
  const nuevasMarcas = {}
  const tuyas = []
  const refrescadas = []
  for (const d of declaradas) {
    const vieja = mapa.get(d.nombre)
    mapa.delete(d.nombre)
    if (!vieja) {
      partes.push(d.texto)
      nuevasMarcas[d.nombre] = huella(d.texto)
      refrescadas.push(d.nombre)
      continue
    }
    const marca = marcas[d.nombre]
    const enDiscoH = huella(vieja.texto)
    if (marca !== undefined && marca !== enDiscoH) {
      partes.push(vieja.texto)
      nuevasMarcas[d.nombre] = marca
      tuyas.push(d.nombre || '(encabezado)')
      continue
    }
    const declaradaH = huella(d.texto)
    if (enDiscoH !== declaradaH) refrescadas.push(d.nombre)
    partes.push(d.texto)
    nuevasMarcas[d.nombre] = declaradaH
  }
  // Lo que el plugin ya no declara. Si la huella anotada coincide, es una seccion
  // suya que dejo de existir y se va; si no, la escribio el usuario y se queda.
  for (const s of [...mapa.values(), ...repetidas]) {
    if (marcas[s.nombre] !== undefined && marcas[s.nombre] === huella(s.texto)) continue
    partes.push(s.texto)
    tuyas.push(s.nombre || '(encabezado)')
  }
  return { texto: partes.join('\n'), marcas: nuevasMarcas, tuyas, refrescadas }
}

function corre(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !stdout) { reject(error); return }
        resolve(String(stdout ?? '') || String(stderr ?? ''))
      })
  })
}

// Los subcomandos de wa-scope que usan los prompts. Es la unica lista escrita a mano
// y lo que trae cada uno sale de argparse, no de una transcripcion: una bandera que
// cambie se ve en la proxima siembra en vez de envejecer en silencio.
const SUBCOMANDOS = ['voice', 'check', 'lock', 'work', 'closing', 'where', 'route',
  'decisions', 'record', 'alert', 'config', 'agent']

/** La referencia de comandos, sacada del `--help` de las propias herramientas. */
export async function referencia(toolsDir) {
  const bloques = []
  for (const tool of ['wa-scope', 'wa-read', 'wa-send', 'wa-transcribe']) {
    const texto = await corre(join(toolsDir, tool), ['--help'])
    bloques.push(`### \`${tool}\`\n\n\`\`\`\n${texto.trimEnd()}\n\`\`\``)
  }
  for (const sub of SUBCOMANDOS) {
    const texto = await corre(join(toolsDir, 'wa-scope'), [sub, '--help'])
    bloques.push(`### \`wa-scope ${sub}\`\n\n\`\`\`\n${texto.trimEnd()}\n\`\`\``)
  }
  return bloques.join('\n\n')
}

function leerManifiesto(dir) {
  try {
    const dato = JSON.parse(readFileSync(join(dir, MANIFIESTO), 'utf8'))
    return dato && typeof dato === 'object' && dato.files ? dato.files : {}
  } catch {
    return {}
  }
}

/**
 * Deja el arnes puesto en la carpeta de trabajo del plugin.
 *
 * No lanza nunca: devuelve por que no pudo. Una maquina donde la carpeta no existe
 * tiene que seguir usando el plugin exactamente igual que hoy.
 */
export async function sembrar(pluginDir, toolsDir) {
  const at = new Date().toISOString()
  let dir = null
  let version = '0.0.0'
  try {
    version = manifiesto(pluginDir).version
    dir = workspaceDir(pluginDir)
    if (!dir) {
      return { ok: false, at, reason: 'sin-userdata',
        detail: 'no userData directory was found for Orca on this machine' }
    }
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    return { ok: false, at, dir, reason: 'sin-carpeta',
      detail: String(error?.message ?? error).slice(0, 300) }
  }

  // La referencia sale del `--help` de verdad. Si las herramientas no corren, se
  // siembra el resto igual: media doctrina puesta vale mas que ninguna.
  let ayuda = null
  let motivoAyuda = ''
  try {
    ayuda = await referencia(toolsDir)
  } catch (error) {
    motivoAyuda = String(error?.message ?? error).slice(0, 200)
  }

  const marcas = leerManifiesto(dir)
  const archivos = []
  const nuevoManifiesto = {}
  const fuente = join(pluginDir, 'harness')
  try {
    sembrarArchivos({ fuente, dir, ayuda, motivoAyuda, marcas, archivos, nuevoManifiesto })
    writeFileSync(join(dir, MANIFIESTO),
      `${JSON.stringify({ plugin: manifiesto(pluginDir).key, version, at, files: nuevoManifiesto }, null, 2)}\n`,
      'utf8')
  } catch (error) {
    return { ok: false, at, dir, reason: 'fallo',
      detail: String(error?.message ?? error).slice(0, 300) }
  }
  return { ok: true, at, dir, version, files: archivos }
}

/** El grueso de la siembra, aparte para que `sembrar` pueda devolver el motivo en vez
 *  de lanzar: una carpeta que no se puede escribir no puede tumbar la activacion. */
function sembrarArchivos({ fuente, dir, ayuda, motivoAyuda, marcas, archivos, nuevoManifiesto }) {
  for (const nombre of readdirSync(fuente).filter((f) => f.endsWith('.md')).sort()) {
    let plantilla = readFileSync(join(fuente, nombre), 'utf8')
    if (plantilla.includes(MARCA_HELP)) {
      if (ayuda === null) {
        archivos.push({ name: nombre, action: 'sin-herramientas', detail: motivoAyuda })
        // Sin ayuda no se escribe una referencia que no dice nada, pero la huella
        // anotada se conserva: perderla convertiria el archivo en "del usuario".
        if (marcas[nombre]) nuevoManifiesto[nombre] = marcas[nombre]
        continue
      }
      plantilla = plantilla.replace(MARCA_HELP, ayuda)
    }
    const destino = join(dir, nombre)
    const previo = existsSync(destino) ? readFileSync(destino, 'utf8') : null
    const anotadas = marcas[nombre]?.sections ?? {}
    const junto = previo === null
      ? { texto: plantilla, marcas: Object.fromEntries(
          secciones(plantilla).map((s) => [s.nombre, huella(s.texto)])), tuyas: [], refrescadas: [] }
      : juntar(secciones(plantilla), secciones(previo), anotadas)
    let action = 'igual'
    if (previo === null) {
      action = 'creado'
    } else if (junto.texto !== previo) {
      action = 'actualizado'
    }
    if (action !== 'igual') writeFileSync(destino, junto.texto, 'utf8')
    nuevoManifiesto[nombre] = { sections: junto.marcas }
    archivos.push({
      name: nombre,
      bytes: Buffer.byteLength(junto.texto, 'utf8'),
      action,
      yours: junto.tuyas,
      refreshed: junto.refrescadas
    })
  }
}
