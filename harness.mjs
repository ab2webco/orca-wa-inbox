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
import { pathToFileURL } from 'node:url'

// El estado del arnes va por el mismo canal que el del sync: el panel no puede
// ejecutar nada, asi que sin esto no hay forma de saber si la carpeta se sembro.
export const HARNESS_KEY = 'harnessStatus'
// Donde queda anotado que escribio el plugin la ultima vez. Sin esto no se puede
// distinguir "lo cambio el plugin" de "lo edito el usuario", que es justo la
// diferencia que decide si un archivo se reescribe o se respeta.
const MANIFIESTO = '.harness.json'
const MARCA_HELP = '<!-- HARNESS:HELP -->'

/** El archivo que Orca deja en SU userData para decir por donde contesta. Aca solo se
 *  usa como senal de "esta carpeta es un userData de Orca": es el mismo marcador que
 *  mira `user_data_roots()` de bin/wa_settings.py. */
const RUNTIME_FILE = 'orca-runtime.json'

/** Nombres con los que Orca ha guardado su userData, del mas probable al menos. NO son
 *  la regla: son por donde se mira primero. El nombre lo decide como se empaqueto —la
 *  app publicada de Linux usa `orca-ide`, la de macOS `orca`— y por eso ademas se
 *  descubre (ver `userDataRoots`).
 *
 *  `orca` sigue PRIMERO y eso no es cosmetico: cuando no existe ninguna de estas
 *  carpetas, `raizDelPlugin` cae en `raices[0]`, que es donde nacerian el arnes y el
 *  auth state. Mover el primero cambiaria esa carpeta en macOS y en Windows, que hoy
 *  funcionan. */
const NOMBRES_USER_DATA = ['orca', 'orca-ide', 'orca-dev', 'zzorcanametest']

/** La carpeta donde Electron pone los userData de esta maquina.
 *
 *  `env` y `plataforma` entran por argumento —igual que en `user_data_base()` de
 *  bin/wa_settings.py— para poder probar las tres formas desde una sola maquina: el
 *  defecto que esto arregla es de Linux y quien lo escribio no tiene una macOS donde
 *  correr la prueba contraria. */
export function userDataBase(env = process.env, plataforma = process.platform) {
  const home = homedir()
  if (plataforma === 'darwin') return join(home, 'Library', 'Application Support')
  if (plataforma === 'win32') return env.APPDATA || join(home, 'AppData', 'Roaming')
  return env.XDG_CONFIG_HOME || join(home, '.config')
}

/**
 * Los userData que esta maquina podria tener, del mas probable al menos. Es la misma
 * tabla que `user_data_roots()` de bin/wa_settings.py: dos esquemas distintos serian
 * dos verdades que se desincronizan — y lo estuvieron.
 *
 * Tenerlo fijo a una LISTA DE NOMBRES ya habia fallado en Linux, donde la app
 * publicada guarda en `orca-ide`: en una Fedora recien instalada NINGUNO de los tres
 * nombres viejos existe, `raizDelPlugin` devuelve null, `dataDir` devuelve null, y
 * `arrancarSidecar` (main.mjs) corta con SIN_AUTHDIR ANTES de lanzar el sidecar. El
 * sintoma es que el QR no aparece nunca, sobre una maquina que esta perfecta. Por eso,
 * ademas de los nombres conocidos, se descubre cualquier carpeta de `base` que tenga
 * adentro un runtime de Orca o datos de plugins.
 *
 * ORCA_USER_DATA_PATH NO entra aca, a proposito y por la misma razon que en el lado
 * Python (bin/wa_settings.py): apunta al Orca que esta corriendo y la exporta cada
 * terminal de Orca, asi que meterla en la busqueda haria que una prueba con HOME de
 * mentira escribiera en la carpeta real del usuario.
 */
export function userDataRoots(env = process.env, plataforma = process.platform) {
  const base = userDataBase(env, plataforma)
  const salida = NOMBRES_USER_DATA.map((d) => join(base, d))
  let nombres
  try {
    nombres = readdirSync(base).sort()
  } catch (error) {
    // Un acceso denegado SUBE, igual que en `esDirectorio`: "no existe" y "no lo puedo
    // ver" tienen arreglos opuestos, y tratarlos igual es el defecto que esa funcion
    // documenta. Que la carpeta base no exista si es un no-hay, y ahi quedan los
    // nombres conocidos como unica respuesta.
    if (error?.code === 'ERR_ACCESS_DENIED') throw error
    return salida
  }
  for (const nombre of nombres) {
    const ruta = join(base, nombre)
    if (salida.includes(ruta)) continue
    if (!esDirectorio(ruta)) continue
    if (existsSync(join(ruta, RUNTIME_FILE)) || esDirectorio(join(ruta, 'plugins-data'))) {
      salida.push(ruta)
    }
  }
  return salida
}

/** El modelo de permisos de Node no contesta `false` a lo que no puede ver: LANZA
 *  ERR_ACCESS_DENIED. Tratar las dos cosas igual era el defecto: el worker decia que
 *  esta maquina no tiene userData teniendolo, y "no existe" y "no lo puedo ver" tienen
 *  arreglos opuestos. El acceso denegado sube; lo que no esta devuelve false. */
function esDirectorio(ruta) {
  try {
    return existsSync(ruta) && readdirSync(ruta) !== null
  } catch (error) {
    if (error?.code === 'ERR_ACCESS_DENIED') throw error
    return false
  }
}

/** Si este proceso corre tras la valla de permisos de Node. El worker del plugin arranca
 *  con `--permission --allow-fs-read=<carpeta del plugin>` y SIN ningun `--allow-fs-write`:
 *  ahi dentro no hay decision de ruta ni escritura posible, y preguntarselo al disco solo
 *  da un motivo falso. Los subprocesos NO heredan la valla — por eso la siembra corre en
 *  uno, y por eso el doctor, que es un subproceso, siempre dio ok. */
export function vallado() {
  const p = process.permission
  if (!p || typeof p.has !== 'function') return false
  return !p.has('fs.write')
}

/** El manifiesto del plugin, que es de donde salen la llave y la version. Copiarlas
 *  a mano aca es lo que hizo fallar un chequeo cuando el plugin se renombro. */
export function manifiesto(pluginDir) {
  const man = JSON.parse(readFileSync(join(pluginDir, 'orca-plugin.json'), 'utf8'))
  return { key: `${man.publisher}.${man.id}`, version: String(man.version ?? '0.0.0') }
}

/** La raiz de userData elegida para ESTE plugin, y su llave. La comparten
 *  `workspaceDir` (el arnes) y `dataDir` (el auth state del sidecar, T3): dos
 *  carpetas del mismo plugin en raices de userData distintas -con el instalado y un
 *  build dev abiertos a la vez- serian la misma clase de bug de identidad que
 *  `bin/wa-scope` ya evito con `(cuenta, jid)`. Null si esta maquina no tiene ningun
 *  userData de Orca. */
function raizDelPlugin(pluginDir) {
  const { key } = manifiesto(pluginDir)
  const raices = userDataRoots().filter(esDirectorio)
  if (!raices.length) return null
  // El orden de precedencia NO se toca: ya sembrada, si no con datos, si no la primera
  // de la lista. Desempatar por fecha de modificacion elegiria mejor cuando hay dos
  // builds vivos, pero MUEVE la carpeta de una instalacion que hoy funciona -medido: en
  // un macOS con release y dev, el auth state se va de `orca` a `orca-dev`- y mover un
  // auth state ya vinculado es pedirle al usuario un QR nuevo sin avisarle. Es un
  // cambio aparte, con su propia migracion; este arreglo es el nombre que faltaba.
  const yaSembrada = raices.find((r) => esDirectorio(join(r, 'plugin-workspaces', key)))
  const conDatos = raices.find((r) => esDirectorio(join(r, 'plugins-data', key)))
  return { raiz: yaSembrada ?? conDatos ?? raices[0], key }
}

/**
 * La carpeta de trabajo del plugin, o null si en esta maquina no se puede decir cual
 * es. Se elige el userData donde el plugin YA vive: con el instalado y un build dev
 * abiertos, sembrar en el otro deja el arnes donde nadie lo lee.
 */
export function workspaceDir(pluginDir) {
  const elegida = raizDelPlugin(pluginDir)
  return elegida ? join(elegida.raiz, 'plugin-workspaces', elegida.key) : null
}

/** `<userData>/plugins-data/<publisher>.<id>/`, la misma carpeta donde Orca ya
 *  guarda `storage.json`, y donde desde T3 vive tambien el auth state del sidecar de
 *  Baileys: FUERA del arbol del plugin, que esta verificado por content-hash
 *  (docs/ENCARGO-TRANSPORTE-UNICO.md §7 — escribir adentro cambia el hash). `...sub`
 *  se une detras para pedir una subcarpeta -`wa-auth`- sin que quien llama arme la
 *  ruta a mano. Null en la misma condicion que `workspaceDir`. */
export function dataDir(pluginDir, ...sub) {
  const elegida = raizDelPlugin(pluginDir)
  return elegida ? join(elegida.raiz, 'plugins-data', elegida.key, ...sub) : null
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
const SUBCOMANDOS = ['voice', 'check', 'lock', 'unlock', 'work', 'closing', 'where',
  'route', 'decisions', 'record', 'alert', 'config', 'agent', 'list', 'set', 'accounts',
  'pending', 'run', 'sync', 'rotate']

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

/** Las huellas anotadas. Sin archivo son {} — es la primera siembra —, pero un archivo
 *  que EXISTE y no se puede leer no puede leerse como {}: sin huellas toda seccion
 *  parece del plugin y las ediciones del usuario se reescriben en silencio, que es
 *  justo lo contrario de lo que el manifiesto existe para impedir. */
function leerManifiesto(dir) {
  const ruta = join(dir, MANIFIESTO)
  if (!existsSync(ruta)) return {}
  const dato = JSON.parse(readFileSync(ruta, 'utf8'))
  return dato && typeof dato === 'object' && dato.files ? dato.files : {}
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
  // Nada de esto puede correr dentro del worker, y decirlo aca es lo que impide volver
  // a inventar un motivo mirando el disco. Quien llama lo corre en un subproceso.
  if (vallado()) {
    return { ok: false, at, reason: 'vallado',
      detail: 'this process runs behind Node\'s permission fence and cannot write: ' +
              'the seeding has to run in a subprocess' }
  }
  try {
    version = manifiesto(pluginDir).version
    dir = workspaceDir(pluginDir)
    if (!dir) {
      return { ok: false, at, reason: 'sin-userdata',
        detail: 'no userData directory was found for Orca on this machine' }
    }
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    if (error?.code === 'ERR_ACCESS_DENIED') {
      return { ok: false, at, dir, reason: 'sin-acceso',
        detail: String(error?.message ?? error).slice(0, 300) }
    }
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

  const archivos = []
  const nuevoManifiesto = {}
  const fuente = join(pluginDir, 'harness')
  try {
    const marcas = leerManifiesto(dir)
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


// Y como subproceso: `node harness.mjs <pluginDir> <toolsDir>` imprime el mismo estado
// que devuelve sembrar(). Es la unica forma de que el worker siembre — dentro de la
// valla no hay permiso de escritura ninguno — y deja una sola implementacion en vez de
// una copia en Python que se desincronizaria.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [pluginDir, toolsDir] = process.argv.slice(2)
  sembrar(pluginDir, toolsDir || join(pluginDir, 'bin'))
    .then((estado) => process.stdout.write(JSON.stringify(estado)))
    .catch((error) => process.stdout.write(JSON.stringify({
      ok: false, at: new Date().toISOString(), reason: 'fallo',
      detail: String(error?.message ?? error).slice(0, 300)
    })))
}
