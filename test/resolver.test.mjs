#!/usr/bin/env node
// El resolvedor que eligen las automations y los prompts, probado sobre el ARTEFACTO
// que se publica y no sobre una copia.
//
// Existe porque el defecto ya salio caro: el agente del dueno mando un WhatsApp de
// verdad conduciendo la app de escritorio por accesibilidad, un camino que este
// repositorio borro. Lo mando porque el resolvedor ordenaba los candidatos por
// `os.path.getmtime` —la fecha del directorio— y en esa maquina habia una copia 3.0.1
// instalada mas RECIENTEMENTE que la 3.13.0. La fecha de instalacion no es la version.
//
// Lo que queda clavado aca:
//   1. una version vieja instalada despues NO le gana a una mas nueva;
//   2. la ruta de desarrollo le gana a las dos, como hace el descubrimiento de Orca;
//   3. la identidad anterior `ab2web.wa-inbox` no se resuelve nunca.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RAIZ = new URL('..', import.meta.url).pathname

// ── Las cinco copias del resolvedor, sacadas de donde se publican de verdad.
const HEREDOC = /WA=\$\(python3 - <<'PY'\n([\s\S]*?)\nPY\n\)/
const PRECHECK = /^WA=\$\(python3 -c "([^"]*)"\)/

function delPrompt (nombre) {
  const cuerpo = readFileSync(join(RAIZ, 'prompts', nombre), 'utf8')
  const m = cuerpo.match(HEREDOC)
  assert.ok(m, `prompts/${nombre}: no trae el bloque que resuelve el bin del plugin`)
  return m[1]
}

function delPrecheck (origen, precheck) {
  const m = precheck.match(PRECHECK)
  assert.ok(m, `${origen}: el precheck ya no resuelve el bin con python3`)
  return m[1]
}

const manifiesto = JSON.parse(readFileSync(join(RAIZ, 'orca-plugin.json'), 'utf8'))
const COPIAS = new Map()
for (const auto of manifiesto.contributes.automations) {
  COPIAS.set(`orca-plugin.json (${auto.id})`, delPrecheck(`orca-plugin.json (${auto.id})`, auto.precheck))
}
for (const nombre of ['whatsapp-triage.json', 'whatsapp-tomar-lo-marcado.json']) {
  const auto = JSON.parse(readFileSync(join(RAIZ, 'automations', nombre), 'utf8'))
  COPIAS.set(`automations/${nombre}`, delPrecheck(`automations/${nombre}`, auto.precheck))
}
for (const nombre of ['take.md', 'triage.md']) {
  COPIAS.set(`prompts/${nombre}`, delPrompt(nombre))
}

// ── El escenario: un userData de mentira colgado de un HOME de mentira.
const BASE_POR_SISTEMA = process.platform === 'darwin'
  ? ['Library', 'Application Support']
  : ['.config']

function siembraBin (raiz, version, edad) {
  // edad en segundos hacia atras: mientras mas chica, mas RECIENTE es el directorio.
  mkdirSync(join(raiz, 'bin'), { recursive: true })
  const wa = join(raiz, 'bin', 'wa-scope')
  writeFileSync(wa, '#!/bin/sh\nexit 0\n')
  chmodSync(wa, 0o755)
  if (version !== null) {
    writeFileSync(join(raiz, 'orca-plugin.json'), JSON.stringify({ version }))
  }
  const cuando = new Date(Date.now() - edad * 1000)
  utimesSync(join(raiz, 'bin'), cuando, cuando)
  return join(raiz, 'bin')
}

function instala (base, userData, llave, hash, version, edad) {
  const p = join(base, userData, 'plugins', llave)
  mkdirSync(p, { recursive: true })
  writeFileSync(join(p, 'current'), `${hash}\n`)
  return siembraBin(join(p, hash), version, edad)
}

function registraDev (base, userData, rutas) {
  const p = join(base, userData)
  mkdirSync(p, { recursive: true })
  writeFileSync(join(p, 'orca-data.json'),
    JSON.stringify({ settings: { devPluginPaths: rutas } }))
}

function resuelve (cuerpo, home) {
  return execFileSync('python3', ['-c', cuerpo], {
    env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 60000
  }).trim()
}

// Cada escenario devuelve [home, esperado, por que].
const ESCENARIOS = []

function escenario (nombre, armar) {
  const home = mkdtempSync(join(tmpdir(), 'wa-resolver-'))
  const base = join(home, ...BASE_POR_SISTEMA)
  mkdirSync(base, { recursive: true })
  ESCENARIOS.push({ nombre, home, ...armar(base, home) })
}

// A — el defecto medido: la 3.0.1 y la 3.9.0 se instalaron DESPUES que la 3.13.0.
escenario('la version manda sobre la fecha de instalacion', (base) => {
  const nueva = instala(base, 'orca', 'ab2web.orca-wa-inbox', 'h3130', '3.13.0', 86400 * 7)
  instala(base, 'orca-ide', 'ab2web.orca-wa-inbox', 'h390', '3.9.0', 60)
  instala(base, 'orca-dev', 'ab2web.wa-inbox', 'h301', '3.0.1', 10)
  return { esperado: nueva, porque: '3.13.0 le gana a 3.9.0 aunque sea mas vieja en disco' }
})

// B — la ruta de desarrollo gana de plano, incluso con la version mas baja de todas
//     y el directorio mas viejo. Es el punto del modo desarrollo.
escenario('la ruta de desarrollo gana de plano', (base, home) => {
  instala(base, 'orca', 'ab2web.orca-wa-inbox', 'h3130', '3.13.0', 60)
  instala(base, 'orca-dev', 'ab2web.wa-inbox', 'h301', '3.0.1', 10)
  const arbol = join(home, 'checkout')
  const dev = siembraBin(arbol, '1.0.0', 86400 * 30)
  registraDev(base, 'orca', [arbol])
  return { esperado: dev, porque: 'un dev valido gana aunque su version sea la mas baja' }
})

// C — un dev sin bin/ ni manifiesto no es un dev valido: ahi si mandan los instalados.
escenario('un dev invalido no secuestra la resolucion', (base, home) => {
  const nueva = instala(base, 'orca', 'ab2web.orca-wa-inbox', 'h3130', '3.13.0', 86400)
  const vacio = join(home, 'checkout-a-medias')
  mkdirSync(vacio, { recursive: true })
  registraDev(base, 'orca', [vacio])
  return { esperado: nueva, porque: 'sin bin/ usable el dev no cuenta' }
})

// D — solo existe la identidad anterior: mejor vacio que otro producto.
escenario('la identidad anterior no se resuelve', (base) => {
  instala(base, 'orca-dev', 'ab2web.wa-inbox', 'h301', '3.0.1', 10)
  return { esperado: '', porque: 'esa build 3.0.1 manda conduciendo la pantalla' }
})

// E — nada instalado: vacio, y el prompt para.
escenario('sin candidatos contesta vacio', () => {
  return { esperado: '', porque: 'sin nada que resolver no se inventa una ruta' }
})

let hechas = 0
const fallos = []

// Las cinco copias tienen que ser el MISMO resolvedor: una correccion aplicada a
// cuatro se ve bien y falla en la quinta. Se comparan sin comentarios porque el
// precheck viaja sin ellos —la cadena de shell del JSON ya es larga de por si— y el
// prompt si los lleva, que es a quien los comentarios le sirven. Que cada copia
// derive del canonico caracter por caracter lo exige scripts/check-resolver.
const codigo = (texto) => texto.split('\n')
  .filter((l) => l.trim() && !l.trimStart().startsWith('#')).join('\n')
const textos = [...COPIAS.entries()]
const [nombreBase, textoBase] = textos[0]
for (const [nombre, texto] of textos.slice(1)) {
  hechas += 1
  if (codigo(texto) !== codigo(textoBase)) {
    fallos.push(`${nombre} no es el mismo resolvedor que ${nombreBase}`)
  }
}

for (const [nombre, texto] of COPIAS) {
  // Sobre el CODIGO, no sobre los comentarios: los comentarios nombran la identidad
  // anterior justamente para explicar por que ya no se resuelve, y ese parrafo es lo
  // que evita que alguien la vuelva a agregar creyendo que solo falta compatibilidad.
  hechas += 1
  if (codigo(texto).includes('ab2web.wa-inbox')) {
    fallos.push(`${nombre} todavia busca ab2web.wa-inbox, que es el producto que conduce la pantalla`)
  }
  for (const { nombre: caso, home, esperado, porque } of ESCENARIOS) {
    hechas += 1
    let obtenido
    try {
      obtenido = resuelve(texto, home)
    } catch (error) {
      fallos.push(`${nombre} / ${caso}: el resolvedor reviento — ${error.message.split('\n').pop()}`)
      continue
    }
    if (obtenido !== esperado) {
      fallos.push(`${nombre} / ${caso}: eligio ${obtenido || '(vacio)'} y tenia que elegir `
        + `${esperado || '(vacio)'} — ${porque}`)
    }
  }
}

for (const { home } of ESCENARIOS) rmSync(home, { recursive: true, force: true })

if (fallos.length) {
  console.error('El resolvedor elige la instalacion equivocada:')
  for (const f of fallos) console.error(`  ${f}`)
  console.error('\nUna version vieja instalada hoy no es la mas nueva, y `ab2web.wa-inbox` '
    + 'es otro producto: manda WhatsApp por un camino que este plugin borro.')
  process.exit(1)
}
console.log(`${hechas}/${hechas} el resolvedor elige por version, con el dev de primero`)
