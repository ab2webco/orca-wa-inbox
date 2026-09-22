#!/usr/bin/env node
/**
 * Verifica el bundle del sidecar y el tope de tamano del arbol del plugin.
 *
 * Existe porque HOY ya paso: una tarde se perdio con 169 MB de capturas que dejaron
 * el plugin invalido, y Orca lo rechazo entero sin decir mas que eso. El sidecar
 * agrega una libreria pesada (Baileys + libsignal) al arbol, asi que el guardia
 * tiene que vivir en el chequeo automatico, no en la memoria de quien construye.
 *
 * El recorrido imita al validador de Orca (`plugin-content-hash.ts:15-16,50-52`):
 * sin mecanismo de exclusion, solo `.git` en la raiz se salta, y los symlinks se
 * rechazan de plano en vez de seguirse.
 */
import { existsSync, statSync, lstatSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

const MAX_PLUGIN_FILES = 2000
const MAX_PLUGIN_TOTAL_BYTES = 50 * 1024 * 1024

/** Recorre el arbol como lo hace el validador: cuenta archivos, bytes y symlinks,
 *  sin seguir directorios simbolicos y saltando SOLO `.git` en la raiz. */
function recorrerArbol (raiz) {
  let archivos = 0
  let bytes = 0
  let symlinks = 0
  const pila = [{ ruta: raiz, profundidad: 0 }]
  while (pila.length) {
    const { ruta, profundidad } = pila.pop()
    for (const nombre of readdirSync(ruta)) {
      if (profundidad === 0 && nombre === '.git') continue
      const completa = join(ruta, nombre)
      const info = lstatSync(completa)
      if (info.isSymbolicLink()) { symlinks += 1; continue }
      if (info.isDirectory()) {
        pila.push({ ruta: completa, profundidad: profundidad + 1 })
        continue
      }
      archivos += 1
      bytes += info.size
    }
  }
  return { archivos, bytes, symlinks }
}

const mb = (n) => (n / (1024 * 1024)).toFixed(2)

let fallos = 0
let pruebas = 0
function ok (nombre, condicion, detalle = '') {
  pruebas += 1
  if (condicion) return console.log(`  ok    ${nombre}`)
  fallos += 1
  console.log(`  FALLA ${nombre}${detalle ? ` — ${detalle}` : ''}`)
}

console.log('\nsidecar: el bundle')
{
  const ruta = join(PLUGIN_DIR, 'sidecar', 'sidecar.cjs')
  const existe = existsSync(ruta)
  ok('sidecar/sidecar.cjs existe', existe, ruta)
  ok('y es un solo archivo, no un directorio',
    existe && statSync(ruta).isFile(), existe ? '' : 'no se pudo comprobar: falta el archivo')
}

console.log('\nsidecar: el arbol del plugin sigue dentro del tope de Orca')
{
  const { archivos, bytes, symlinks } = recorrerArbol(PLUGIN_DIR)
  ok(`bajo ${MAX_PLUGIN_FILES} archivos (van ${archivos})`,
    archivos <= MAX_PLUGIN_FILES,
    archivos > MAX_PLUGIN_FILES
      ? `${archivos} archivos: ${archivos - MAX_PLUGIN_FILES} de mas sobre el tope de ${MAX_PLUGIN_FILES}`
      : '')
  ok(`bajo ${mb(MAX_PLUGIN_TOTAL_BYTES)} MB (van ${mb(bytes)} MB)`,
    bytes <= MAX_PLUGIN_TOTAL_BYTES,
    bytes > MAX_PLUGIN_TOTAL_BYTES
      ? `${mb(bytes)} MB: ${mb(bytes - MAX_PLUGIN_TOTAL_BYTES)} MB de mas sobre el tope de ${mb(MAX_PLUGIN_TOTAL_BYTES)} MB`
      : '')
  ok('sin symlinks en todo el arbol (Orca los rechaza de plano)',
    symlinks === 0, `${symlinks} symlinks encontrados`)
}

console.log(`\n${pruebas - fallos}/${pruebas} en verde`)
process.exit(fallos ? 1 : 0)
