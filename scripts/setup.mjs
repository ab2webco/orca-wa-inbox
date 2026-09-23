#!/usr/bin/env node
/**
 * Deja el arnes de verificacion listo en un clon limpio.
 *
 * Existe porque `npm run setup` era `npm --prefix ../.orca-wa-inbox-deps install`, y
 * eso da por hecho que ese directorio YA tiene un package.json. En un clon limpio no
 * existe -vive fuera del arbol, que es justo el punto- asi que el primer comando del
 * README fallaba con un ENOENT sobre un archivo que nadie dice como crear:
 *
 *     npm error enoent Could not read package.json:
 *     .../.orca-wa-inbox-capturas/../.orca-wa-inbox-deps/package.json
 *
 * Quien clonaba tenia que deducir las cuatro dependencias leyendo los `req(...)` de
 * test/panels.test.mjs, test/shots.mjs y sidecar/build.mjs. La lista vive ahora en
 * `scripts/deps.package.json`, que es la unica fuente, y este script la copia.
 *
 * Por que FUERA del arbol: Orca hashea todo lo que hay bajo la raiz del plugin y
 * rechaza symlinks -y `node_modules/.bin` son symlinks-. Con node_modules aca adentro
 * el plugin queda "No valido" (docs/ENCARGO-TRANSPORTE-UNICO.md §3).
 *
 * Es node y no python3 como el resto de `scripts/`: esto corre desde `npm run`, asi
 * que node esta garantizado, y el arnes pide python >= 3.10 que puede no ser el
 * `python3` del sistema. Un setup que falla por la version de python es justo el
 * problema que este script viene a quitar.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)))
const PLANTILLA = join(RAIZ, 'scripts', 'deps.package.json')
const DEPS = join(dirname(RAIZ), '.orca-wa-inbox-deps')

/** Corre un comando heredando la salida. Devuelve el codigo, sin lanzar: cada paso
 *  decide que hacer con su fallo y el mensaje util lo escribe este script, no una
 *  traza de node. */
function correr (cmd, args, opciones = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opciones })
  if (r.error) {
    console.error(`\nNo se pudo ejecutar ${cmd}: ${r.error.message}`)
    return 1
  }
  return r.status ?? 1
}

if (!existsSync(PLANTILLA)) {
  console.error(`Falta ${PLANTILLA}: es la lista de dependencias del arnes.`)
  process.exit(1)
}

mkdirSync(DEPS, { recursive: true })

// Se SOBREESCRIBE a proposito. Ese directorio no es del usuario: lo genera este
// script, y la lista de dependencias tiene una sola fuente. Respetar un package.json
// que quedo ahi de una version anterior es como se llega a un arnes que instala algo
// distinto de lo que el repo dice que usa.
// Se copia la plantilla ENTERA, `overrides` incluido. Ese override no es cosmetico:
// baileys 6.7.24 declara `libsignal` como URL de git, y sin el el lock queda con un
// commit fijado pero SIN hash de integridad — los bytes nunca se verifican. Con el,
// viene del registro con sha512, y se comprobo que el codigo es identico byte a byte.
// Importa despues del paquete malicioso que imito a baileys en diciembre de 2025.
copyFileSync(PLANTILLA, join(DEPS, 'package.json'))
const deps = JSON.parse(readFileSync(PLANTILLA, 'utf8')).dependencies ?? {}
console.log(`Dependencias del arnes -> ${DEPS}`)
for (const [nombre, version] of Object.entries(deps)) console.log(`  ${nombre} ${version}`)

const instalado = correr('npm', ['--prefix', DEPS, 'install'], { shell: process.platform === 'win32' })
if (instalado !== 0) process.exit(instalado)

// `chromium-headless-shell` y no `chromium` entero: `test/shots.mjs` lanza
// `chromium.launch()` sin `headless: false`, asi que el shell alcanza y son ~100 MB
// en vez de ~170. El README pedia ademas un `npx playwright install chromium` suelto
// que ya no hace falta.
const navegador = join(DEPS, 'node_modules', '.bin', 'playwright')
process.exit(correr(navegador, ['install', 'chromium-headless-shell']))
