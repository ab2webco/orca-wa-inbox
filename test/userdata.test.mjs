#!/usr/bin/env node
// Donde el plugin decide que userData de Orca es el suyo.
//
// Existe porque el defecto salio caro y el sintoma no se parecia a la causa: en una
// Fedora recien instalada el panel se quedaba SIN QR para siempre. La app publicada de
// Linux guarda su userData en `~/.config/orca-ide`, la tabla de `harness.mjs` solo
// conocia `orca`, `orca-dev` y `zzorcanametest`, y entonces:
//
//   userDataRoots() -> ninguna existe
//   raizDelPlugin() -> null
//   dataDir()       -> null
//   resolve-auth-dir.mjs contesta { ok:false, reason:'sin-userdata' }
//   arrancarSidecar() (main.mjs) corta con SIN_AUTHDIR y NO lanza el sidecar
//   -> el sidecar nunca corre -> nunca emite un `qr` -> el panel espera para siempre
//
// Nada de eso se ve como "falta el nombre de una carpeta". Por eso se clava aca.
//
// Lo que queda fijado:
//   1. una maquina que SOLO tiene `orca-ide` resuelve el auth dir (el caso Fedora);
//   2. macOS y Windows resuelven exactamente donde resolvian antes (no hay regresion);
//   3. `orca` sigue PRIMERO en la lista, que es donde NACE la carpeta en una
//      instalacion limpia — moverlo cambiaria eso en macOS y en Windows;
//   4. con dos userData presentes la precedencia NO se mueve -ya sembrada, si no con
//      datos, si no la primera-, aunque la otra sea la que esta corriendo: desempatar
//      por fecha MUEVE un auth state ya vinculado, que es un QR nuevo sin avisar;
//   5. una build con un nombre que nadie contemplo se DESCUBRE por su runtime;
//   6. sin ningun userData se sigue contestando null, para que el motivo SIN_AUTHDIR
//      siga siendo cierto cuando de verdad no hay donde escribir.
//   7. el plugin INSTALADO siembra el arnes en el userData donde esta instalado, que es
//      donde Orca corre sus automatizaciones, y el auth state no se mueve de su sitio.
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const RAIZ = mkdtempSync(join(tmpdir(), 'wa-inbox-userdata-'))
const CLAVE = 'ab2web.orca-wa-inbox'

// ANTES de importar: `homedir()` de Node lee $HOME en POSIX, y con el HOME de verdad
// estas pruebas mirarian —y sembrarian en— la carpeta del usuario.
const HOME_REAL = process.env.HOME
process.env.HOME = join(RAIZ, 'home')
mkdirSync(process.env.HOME, { recursive: true })

const { dataDir, userDataRoots, workspaceDir } = await import('../harness.mjs')

let fallos = 0
let pruebas = 0

function ok (nombre, condicion, detalle = '') {
  pruebas += 1
  if (condicion) return console.log(`  ok    ${nombre}`)
  fallos += 1
  console.log(`  FALLA ${nombre}${detalle ? ` — ${detalle}` : ''}`)
}

/** Una maquina de mentira: plataforma, carpeta base y los userData que tiene.
 *
 *  `process.platform` se pisa de verdad y no se pasa por argumento porque el camino que
 *  importa es el que recorre el plugin: `raizDelPlugin` llama a `userDataRoots()` SIN
 *  argumentos. Una prueba que solo ejercite la version con parametros dejaria sin
 *  cubrir justo la linea que fallo. */
function maquina (nombre, plataforma, userdatas) {
  const casa = join(RAIZ, nombre)
  rmSync(casa, { recursive: true, force: true })
  mkdirSync(casa, { recursive: true })
  process.env.HOME = casa
  Object.defineProperty(process, 'platform', { value: plataforma, configurable: true })

  let base
  if (plataforma === 'darwin') {
    base = join(casa, 'Library', 'Application Support')
    delete process.env.XDG_CONFIG_HOME
    delete process.env.APPDATA
  } else if (plataforma === 'win32') {
    base = join(casa, 'AppData', 'Roaming')
    process.env.APPDATA = base
    delete process.env.XDG_CONFIG_HOME
  } else {
    base = join(casa, '.config')
    process.env.XDG_CONFIG_HOME = base
    delete process.env.APPDATA
  }
  mkdirSync(base, { recursive: true })

  for (const ud of userdatas) {
    const raiz = join(base, ud.nombre)
    mkdirSync(raiz, { recursive: true })
    if (ud.runtime) {
      writeFileSync(join(raiz, 'orca-runtime.json'), JSON.stringify({ transports: [] }))
    }
    if (ud.atendido != null) {
      const carpeta = join(raiz, 'plugins-data', CLAVE)
      mkdirSync(carpeta, { recursive: true })
      const archivo = join(carpeta, 'storage.json')
      writeFileSync(archivo, '{}')
      // Segundos hacia atras: cuanto hace que el host escribio ahi.
      const cuando = new Date(Date.now() - ud.atendido * 1000)
      utimesSync(archivo, cuando, cuando)
    }
    if (ud.sembrado) mkdirSync(join(raiz, 'plugin-workspaces', CLAVE), { recursive: true })
  }
  return base
}

// ───────── 1. el caso Fedora: la app publicada guarda en `orca-ide` ─────────
console.log('\nuserData: una Linux que solo tiene el userData de la app publicada')
{
  const base = maquina('fedora', 'linux', [{ nombre: 'orca-ide', runtime: true, atendido: 0 }])
  const dir = dataDir(PLUGIN_DIR, 'wa-auth')
  ok('dataDir() resuelve — sin esto arrancarSidecar corta con SIN_AUTHDIR y no hay QR',
    dir === join(base, 'orca-ide', 'plugins-data', CLAVE, 'wa-auth'), `${dir}`)
  ok('el arnes se siembra en el MISMO userData que el auth state',
    workspaceDir(PLUGIN_DIR) === join(base, 'orca-ide', 'plugin-workspaces', CLAVE),
    `${workspaceDir(PLUGIN_DIR)}`)
}

// ───────── 2. macOS y Windows siguen exactamente donde estaban ─────────
console.log('\nuserData: macOS y Windows no se mueven')
{
  const base = maquina('mac', 'darwin', [{ nombre: 'orca', atendido: 0 }])
  ok('macOS: el auth state sigue bajo ~/Library/Application Support/orca',
    dataDir(PLUGIN_DIR, 'wa-auth') === join(base, 'orca', 'plugins-data', CLAVE, 'wa-auth'),
    `${dataDir(PLUGIN_DIR, 'wa-auth')}`)
}
{
  const base = maquina('win', 'win32', [{ nombre: 'orca', atendido: 0 }])
  ok('Windows: el auth state sigue bajo %APPDATA%\\orca',
    dataDir(PLUGIN_DIR, 'wa-auth') === join(base, 'orca', 'plugins-data', CLAVE, 'wa-auth'),
    `${dataDir(PLUGIN_DIR, 'wa-auth')}`)
}

// ───────── 3. `orca` sigue primero: es donde NACE la carpeta en limpio ─────────
console.log('\nuserData: en una instalacion limpia la carpeta nace donde nacia')
for (const [plataforma, nombre] of [['darwin', 'mac-limpia'], ['win32', 'win-limpia'],
  ['linux', 'linux-limpia']]) {
  // Las cuatro carpetas existen y NINGUNA fue atendida todavia: es el arranque de un
  // plugin recien instalado, donde no hay `storage.json` que desempate.
  const base = maquina(nombre, plataforma, [
    { nombre: 'orca-ide' }, { nombre: 'orca-dev' }, { nombre: 'orca' }])
  ok(`${plataforma}: sin ningun storage.json la carpeta nace en 'orca'`,
    dataDir(PLUGIN_DIR, 'wa-auth') === join(base, 'orca', 'plugins-data', CLAVE, 'wa-auth'),
    `${dataDir(PLUGIN_DIR, 'wa-auth')}`)
  ok(`${plataforma}: 'orca' es el primero de la lista`,
    userDataRoots()[0] === join(base, 'orca'), `${userDataRoots()[0]}`)
}

// ───────── 4. con dos builds presentes, la precedencia NO se toca ─────────
// Es la parte que protege a quien hoy esta vinculado. Elegir por fecha de modificacion
// acertaria mas seguido -el build que escribio hace cinco segundos es el que corre-,
// pero MUEVE la carpeta del auth state de una instalacion que ya funciona, y un auth
// state que cambia de sitio es un QR nuevo que el usuario no pidio. Medido sobre un
// macOS simulado con release y dev: el auth se iba de `orca` a `orca-dev`. Ese cambio
// necesita su propia migracion y no entra de contrabando en el arreglo de un nombre.
console.log('\nuserData: con dos builds instalados la precedencia no se mueve')
{
  const base = maquina('dos-builds', 'linux', [
    { nombre: 'orca', atendido: 60 * 60 * 24, sembrado: true },
    { nombre: 'orca-ide', runtime: true, atendido: 5 }])
  ok('sigue ganando la que YA estaba sembrada, aunque la otra sea la que corre',
    dataDir(PLUGIN_DIR, 'wa-auth') === join(base, 'orca', 'plugins-data', CLAVE, 'wa-auth'),
    `${dataDir(PLUGIN_DIR, 'wa-auth')}`)
}
{
  const base = maquina('dos-mac', 'darwin', [
    { nombre: 'orca', atendido: 60 * 60 * 24 },
    { nombre: 'orca-dev', atendido: 5 }])
  ok('macOS con release y dev: el auth state NO se va a `orca-dev`',
    dataDir(PLUGIN_DIR, 'wa-auth') === join(base, 'orca', 'plugins-data', CLAVE, 'wa-auth'),
    `${dataDir(PLUGIN_DIR, 'wa-auth')}`)
}

// ───────── 5. una build con otro nombre se descubre ─────────
console.log('\nuserData: una build con un nombre que nadie contemplo')
{
  const base = maquina('nombre-raro', 'linux', [
    { nombre: 'orca-canary-2027', runtime: true, atendido: 0 }])
  ok('se descubre por su orca-runtime.json, sin esperar a que alguien la agregue',
    dataDir(PLUGIN_DIR, 'wa-auth') ===
      join(base, 'orca-canary-2027', 'plugins-data', CLAVE, 'wa-auth'),
    `${dataDir(PLUGIN_DIR, 'wa-auth')}`)
}
{
  const base = maquina('vecinos', 'linux', [{ nombre: 'orca-ide', runtime: true, atendido: 0 }])
  // Carpetas de OTRAS apps en ~/.config. Que el descubrimiento sea generoso no puede
  // significar que cualquier carpeta del vecino pase por un userData de Orca.
  for (const ajeno of ['Code', 'gtk-3.0', 'pulse']) mkdirSync(join(base, ajeno), { recursive: true })
  const raices = userDataRoots()
  ok('las carpetas de otras apps NO entran: hace falta runtime o plugins-data',
    !raices.some((r) => /\/(Code|gtk-3\.0|pulse)$/.test(r)), raices.join(', '))
}

// ───────── 6. sin userData se sigue diciendo que no hay ─────────
console.log('\nuserData: cuando de verdad no hay donde escribir')
{
  maquina('sin-nada', 'linux', [])
  ok('dataDir() devuelve null, y SIN_AUTHDIR sigue siendo una afirmacion cierta',
    dataDir(PLUGIN_DIR, 'wa-auth') === null, `${dataDir(PLUGIN_DIR, 'wa-auth')}`)
}

// ───────── 7. el plugin instalado siembra en el userData del Orca que lo corre ─────────
// Medido en una Linux de un usuario: `orca` ya sembrada (de una instalacion vieja) y la
// app publicada corriendo desde `orca-ide`. Orca crea la carpeta de las automatizaciones
// en SU userData (orca-oss plugin-owned-workspace.ts), y el arnes, que preferia la raiz
// "ya sembrada", sembraba en `orca`: el tick salia con 1 en una carpeta vacia cada minuto.
// El plugin instalado vive en `<userData>/plugins/<llave>/<hash>` (plugin-discovery.ts),
// asi que de su propia carpeta sale cual es ese userData. El auth state NO se mueve.
console.log('\nuserData: el plugin instalado siembra donde Orca corre sus automatizaciones')

/** Una instalacion de mentira con la forma de Orca: `<raiz>/plugins/<llave>/<hash>`, con
 *  el manifiesto de verdad adentro (de ahi sale la llave). */
function instalado (raiz, llave = CLAVE) {
  const dir = join(raiz, 'plugins', llave, 'a'.repeat(64))
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(PLUGIN_DIR, 'orca-plugin.json'), join(dir, 'orca-plugin.json'))
  return dir
}

for (const [plataforma, nombre, vieja, corre] of [
  ['linux', 'linux-ide', 'orca', 'orca-ide'],
  ['darwin', 'mac-dev-sembrado', 'orca-dev', 'orca'],
  ['win32', 'win-ide', 'orca', 'orca-ide']]) {
  const base = maquina(nombre, plataforma, [
    { nombre: vieja, atendido: 60 * 60 * 24, sembrado: true },
    { nombre: corre, runtime: true, atendido: 5 }])
  const plugin = instalado(join(base, corre))
  ok(`${plataforma}: la carpeta de trabajo es la de '${corre}', donde corren las automatizaciones`,
    workspaceDir(plugin) === join(base, corre, 'plugin-workspaces', CLAVE),
    `${workspaceDir(plugin)}`)
  ok(`${plataforma}: el auth state se queda en '${vieja}' — moverlo pide un QR nuevo sin avisar`,
    dataDir(plugin, 'wa-auth') === join(base, vieja, 'plugins-data', CLAVE, 'wa-auth'),
    `${dataDir(plugin, 'wa-auth')}`)
  ok(`${plataforma}: un checkout de desarrollo resuelve como antes ('${vieja}', ya sembrada)`,
    workspaceDir(PLUGIN_DIR) === join(base, vieja, 'plugin-workspaces', CLAVE),
    `${workspaceDir(PLUGIN_DIR)}`)
}
{
  // Una carpeta `plugins/<otra llave>/...` no es la instalacion de ESTE plugin: no se le
  // cree la forma y se resuelve como siempre.
  const base = maquina('otra-llave', 'linux', [
    { nombre: 'orca', atendido: 60, sembrado: true },
    { nombre: 'orca-ide', runtime: true, atendido: 5 }])
  const ajena = join(base, 'orca-ide', 'plugins', 'otro.plugin', 'b'.repeat(64))
  mkdirSync(ajena, { recursive: true })
  copyFileSync(join(PLUGIN_DIR, 'orca-plugin.json'), join(ajena, 'orca-plugin.json'))
  ok('con otra llave en la ruta no se deriva nada: gana la ya sembrada, como hoy',
    workspaceDir(ajena) === join(base, 'orca', 'plugin-workspaces', CLAVE),
    `${workspaceDir(ajena)}`)
}

process.env.HOME = HOME_REAL
rmSync(RAIZ, { recursive: true, force: true })
console.log(`\n${pruebas - fallos}/${pruebas} ok`)
assert.equal(fallos, 0, `${fallos} prueba(s) de userData fallaron`)
