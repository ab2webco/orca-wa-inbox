#!/usr/bin/env node
/**
 * Empaqueta `sidecar/src/index.js` en `sidecar/sidecar.cjs`: un solo archivo, sin
 * `node_modules`, para que el arbol del plugin nunca cargue Baileys crudo
 * (docs/ENCARGO-TRANSPORTE-UNICO.md §3: "El node_modules crudo NO pasa: supera el
 * tope de 50 MB y roza el de 2.000 archivos. Empaquetar no es una optimizacion, es
 * requisito de instalacion.").
 *
 * `esbuild` vive en el directorio hermano de dependencias (../.orca-wa-inbox-deps),
 * igual que jsdom y playwright en test/panels.test.mjs y test/shots.mjs: NODE_PATH
 * no sirve para ESM, asi que se resuelve con `createRequire` contra ese directorio.
 * Por la misma razon, la resolucion de Baileys durante el bundle necesita que
 * esbuild sepa buscar en ese `node_modules` -el `nodePaths` de su API de JS hace
 * eso; la CLI no tiene un flag equivalente.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIDECAR_DIR = fileURLToPath(new URL('.', import.meta.url))
const DEPS_PKG = fileURLToPath(new URL('../../.orca-wa-inbox-deps/package.json', import.meta.url))
const DEPS_NODE_MODULES = join(dirname(DEPS_PKG), 'node_modules')

const req = createRequire(DEPS_PKG)
const esbuild = req('esbuild')

const resultado = await esbuild.build({
  entryPoints: [join(SIDECAR_DIR, 'src', 'index.js')],
  outfile: join(SIDECAR_DIR, 'sidecar.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  minify: true,
  external: ['sharp'],
  nodePaths: [DEPS_NODE_MODULES],
  logLevel: 'info'
})

if (resultado.errors.length) {
  process.exitCode = 1
}
