// Como se lanza una herramienta del plugin (`bin/wa-*`), en cada sistema.
//
// Las herramientas son guiones de Python sin extension con `#!/usr/bin/env python3`. En
// macOS y Linux el sistema lee esa primera linea y busca el interprete; Windows no la lee,
// y `execFile` contesta ENOENT aunque el archivo este ahi. En Windows, y SOLO ahi, se
// lanzan con el interprete delante: en los otros dos el mando queda como siempre.
//
// Lo usan el worker (main.mjs) y el sidecar (alcance.js). El interprete lo resuelve el
// worker y se lo pasa al sidecar por env (`PYTHON_ENV`): el sidecar no adivina, como no
// adivina donde estan las herramientas (§11-E4).
import { execFileSync } from 'node:child_process'
import { basename, win32 } from 'node:path'

/** El interprete que el worker resolvio, para el sidecar: un arreglo JSON (`["py","-3"]`). */
export const PYTHON_ENV = 'WA_SIDECAR_PYTHON'

const HERRAMIENTAS = new Set(['wa-read', 'wa-scope', 'wa-send', 'wa-transcribe'])

/** `{ cmd, args }` para lanzar `cmd args`. Solo cambia en Windows y solo para una
 *  herramienta del plugin; todo lo demas (la CLI de Orca, Node) pasa igual. */
export function mandoHerramienta (cmd, args, { plataforma = process.platform, python = ['python'] } = {}) {
  if (plataforma !== 'win32') return { cmd, args }
  if (!HERRAMIENTAS.has(win32.basename(cmd)) && !HERRAMIENTAS.has(basename(cmd))) {
    return { cmd, args }
  }
  return { cmd: python[0], args: [...python.slice(1), cmd, ...args] }
}

/** Contesta si `cmd args` arranca. Corto: es una sola vez por proceso. */
function contesta (cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 5000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

/** El interprete de Python en Windows, como arreglo `[cmd, ...args]`.
 *
 *  `WA_INBOX_PYTHON` manda si esta puesto. Si no, `py -3` antes que `python`: el lanzador
 *  `py` viene con el instalador de python.org, y el `python.exe` de WindowsApps puede ser
 *  el atajo que abre la tienda en vez de un interprete. Si ninguno contesta queda `python`,
 *  y el fallo aparece al lanzar con su motivo, como cualquier otra herramienta que falta. */
export function resolverPython ({ env = process.env, probar = contesta } = {}) {
  const declarado = String(env.WA_INBOX_PYTHON ?? '').trim()
  if (declarado) return [declarado]
  for (const candidato of [['py', '-3'], ['python']]) {
    if (probar(candidato[0], [...candidato.slice(1), '--version'])) return candidato
  }
  return ['python']
}

/** El interprete que el worker paso por env. Un valor roto no tumba a nadie: `python`. */
export function pythonDeEnv (env = process.env) {
  try {
    const valor = JSON.parse(env[PYTHON_ENV] ?? 'null')
    if (Array.isArray(valor) && valor.length && valor.every((v) => typeof v === 'string' && v)) {
      return valor
    }
  } catch {
    // Cae al de fabrica.
  }
  return ['python']
}
