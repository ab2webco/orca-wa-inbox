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
import { existsSync, statSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync,
  writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

console.log('\nsidecar: el bundle trae Baileys 7, el que descifra en LID')
{
  // Con Baileys 6.7.24 una linea guardaba TODOS los mensajes vacios: las sesiones de
  // signal quedaban partidas entre el telefono (`<pn>.0`) y el LID (`<lid>.0`), el
  // telefono contestaba en una y Baileys buscaba en la otra ("No matching sessions
  // found for message"). Baileys 7 pasa el remitente a su LID antes de descifrar
  // (`getDecryptionJid`), guarda el par LID-telefono que trae cada stanza y migra la
  // sesion. Lo que se mira son frases y llaves que sobreviven a la minificacion y que
  // 6.7.24 no tiene: si alguien reinstala la version vieja, esto se pone rojo.
  const ruta = join(PLUGIN_DIR, 'sidecar', 'sidecar.cjs')
  const texto = existsSync(ruta) ? readFileSync(ruta, 'utf8') : ''
  ok('guarda el par LID-telefono que trae el stanza (storeMappingFromEnvelope)',
    texto.includes('Stored LID mapping from envelope'))
  ok('tiene el almacen de pares LID-telefono (`lid-mapping`)', texto.includes('lid-mapping'))
  ok('la llave del mensaje trae la forma alterna (`remoteJidAlt`)',
    texto.includes('remoteJidAlt'))
}

console.log('\nsidecar: una linea vinculada con Baileys 6.7.24 sigue cargando con Baileys 7')
{
  // Subir de version no puede obligar a re-vincular una linea que funciona. La carpeta
  // `wa-auth` la escribio `useMultiFileAuthState` de 6.7.24; la de 7 tiene que leer las
  // credenciales (con `me` puesto Baileys hace login, no pide QR) y encontrar las
  // sesiones de signal por telefono. La carpeta es de mentira (test/auth-baileys-6.json)
  // y se carga con el Baileys del directorio de dependencias, que es el que se empaqueta.
  const DEPS = join(dirname(PLUGIN_DIR), '.orca-wa-inbox-deps', 'node_modules',
    '@whiskeysockets', 'baileys', 'lib')
  const fixture = JSON.parse(readFileSync(join(PLUGIN_DIR, 'test', 'auth-baileys-6.json'), 'utf8'))
  const dir = mkdtempSync(join(tmpdir(), 'wa-auth-6-'))
  try {
    for (const [archivo, contenido] of Object.entries(fixture.files)) {
      writeFileSync(join(dir, archivo), JSON.stringify(contenido))
    }
    const b = await import(pathToFileURL(join(DEPS, 'index.js')).href)
    const { makeLibSignalRepository } = await import(pathToFileURL(join(DEPS, 'Signal', 'libsignal.js')).href)
    const { state } = await b.useMultiFileAuthState(dir)
    ok('las credenciales de 6.7.24 cargan con `me` y registradas: login, no QR',
      state.creds.me?.id === '573000000011:7@s.whatsapp.net' &&
      state.creds.me?.lid === '100000000000001:7@lid' && state.creds.registered === true,
      JSON.stringify(state.creds.me))
    const callado = { level: 'silent', child () { return callado } }
    for (const n of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) callado[n] = () => {}
    const keys = b.addTransactionCapability(b.makeCacheableSignalKeyStore(state.keys, callado),
      callado, { maxCommitRetries: 1, delayBetweenTriesMs: 1 })
    const repo = makeLibSignalRepository({ creds: state.creds, keys }, callado)
    const porTel = await repo.validateSession('573000000012@s.whatsapp.net')
    ok('la sesion de signal por telefono que dejo 6.7.24 se encuentra', porTel.exists === true,
      JSON.stringify(porTel))
    // Lo que NO pasa, escrito para que nadie lo descubra en vivo: 6.7.24 guardaba la
    // sesion de un LID como `<lid>.<disp>` y Baileys 7 la busca como `<lid>_1.<disp>`.
    // Esas sesiones (las que la linea no podia usar) se rehacen con el primer reintento.
    const porLid = await repo.validateSession('100000000000002@lid')
    ok('la sesion por LID de 6.7.24 NO se reusa: Baileys 7 la nombra distinto',
      porLid.exists === false, JSON.stringify(porLid))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
