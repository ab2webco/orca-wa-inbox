#!/usr/bin/env node
// Como las automations y el prompt encuentran las herramientas: leyendo `.wa-bin`, el
// archivo donde el worker escribe la ruta de su propio `bin/`, y si ahi no hay un
// `wa-scope` ejecutable, el puntero estable `bin-path` de la carpeta de estado. Se prueba
// sobre el ARTEFACTO publicado (el `command` de tick, el `precheck` de triage y el bloque
// del prompt) corrido con `sh` en una carpeta de mentira, y no sobre una copia.
//
// Lo que queda clavado:
//   1. con `.wa-bin` apuntando a un bin con wa-scope ejecutable, corre ESE wa-scope;
//   2. sin `.wa-bin` (o vacio, o a un bin sin wa-scope ejecutable) corre el de
//      `$HOME/.wa-inbox/bin-path`, y si no, el de `$APPDATA/wa-inbox/bin-path`: la carpeta
//      que Orca crea puede estar vacia (medido en una Linux con dos userData) y el tick
//      no puede quedarse parado por eso;
//   3. sin ninguno, la automation sale con 1, no corre nada y dice POR QUE en una linea
//      de stderr: callada, una carpeta vacia era un tick muerto cada minuto sin pista;
//   4. un `wa-scope` pelado en PATH no se usa nunca: puede ser una copia vieja que lee
//      otra base.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RAIZ = new URL('..', import.meta.url).pathname
const manifiesto = JSON.parse(readFileSync(join(RAIZ, 'orca-plugin.json'), 'utf8'))
const lineaDe = (auto) => auto.command ?? auto.precheck

const COPIAS = new Map()
for (const auto of manifiesto.contributes.automations) {
  COPIAS.set(`orca-plugin.json (${auto.id})`, lineaDe(auto))
}
for (const nombre of ['whatsapp-triage.json', 'whatsapp-tick.json']) {
  const auto = JSON.parse(readFileSync(join(RAIZ, 'automations', nombre), 'utf8'))
  COPIAS.set(`automations/${nombre}`, lineaDe(auto))
}
const prompt = readFileSync(join(RAIZ, 'prompts', 'triage.md'), 'utf8')
const bloque = prompt.match(/```sh\n(WA=[\s\S]*?)\n```/)
assert.ok(bloque, 'prompts/triage.md: no trae el bloque que resuelve el bin')

// Un wa-scope de mentira que dice quien es; sirve para ver CUAL se corrio.
function binCon (raiz, etiqueta, ejecutable = true) {
  const bin = join(raiz, `bin-${etiqueta}`)
  mkdirSync(bin, { recursive: true })
  const wa = join(bin, 'wa-scope')
  writeFileSync(wa, `#!/bin/sh\necho "corrio ${etiqueta}: $*"\n`)
  chmodSync(wa, ejecutable ? 0o755 : 0o644)
  return bin
}

function corre (linea, cwd, env = {}) {
  const p = spawnSync('sh', ['-c', linea], {
    cwd, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 30000
  })
  return { codigo: p.status, salida: p.stdout, error: p.stderr }
}

let hechas = 0
const fallos = []
const verifica = (cond, mensaje) => { hechas += 1; if (!cond) fallos.push(mensaje) }

const casa = mkdtempSync(join(tmpdir(), 'wa-bin-'))
try {
  const bueno = binCon(casa, 'bueno')
  const ajeno = binCon(casa, 'ajeno') // el que estaria en PATH
  const sinPermiso = binCon(casa, 'sinpermiso', false)
  const PATH = `${ajeno}:${process.env.PATH}`

  // [nombre, contenido de .wa-bin (null: no existe), bin-path en HOME, bin-path en
  //  APPDATA (null: la variable no esta), debe correr]
  const escenarios = [
    ['con .wa-bin corre el wa-scope de esa ruta', `${bueno}\n`, null, null, true],
    ['sin salto de linea al final tambien', bueno, null, null, true],
    ['.wa-bin manda sobre bin-path', `${bueno}\n`, `${sinPermiso}\n`, null, true],
    ['sin .wa-bin corre el de ~/.wa-inbox/bin-path', null, `${bueno}\n`, null, true],
    ['con .wa-bin vacio cae en bin-path', '', `${bueno}\n`, null, true],
    ['con .wa-bin a un bin sin wa-scope ejecutable cae en bin-path',
      `${sinPermiso}\n`, `${bueno}\n`, null, true],
    ['sin nada en HOME cae en %APPDATA%/wa-inbox/bin-path', null, null, `${bueno}\n`, true],
    ['sin .wa-bin ni bin-path no corre nada', null, null, null, false],
    ['con el archivo vacio y sin bin-path no corre nada', '', null, null, false],
    ['con un bin sin wa-scope ejecutable en los dos no corre nada',
      `${sinPermiso}\n`, `${sinPermiso}\n`, `${sinPermiso}\n`, false],
    ['con rutas que no existen no corre nada', `${casa}/no-existe\n`, `${casa}/tampoco\n`,
      null, false]
  ]
  for (const [nombre, waBin, enHome, enAppdata, debeCorrer] of escenarios) {
    const carpeta = mkdtempSync(join(casa, 'ws-'))
    if (waBin !== null) writeFileSync(join(carpeta, '.wa-bin'), waBin)
    const home = mkdtempSync(join(casa, 'home-'))
    if (enHome !== null) {
      mkdirSync(join(home, '.wa-inbox'))
      writeFileSync(join(home, '.wa-inbox', 'bin-path'), enHome)
    }
    const env = { PATH, HOME: home }
    if (enAppdata !== null) {
      const appdata = mkdtempSync(join(casa, 'appdata-'))
      mkdirSync(join(appdata, 'wa-inbox'))
      writeFileSync(join(appdata, 'wa-inbox', 'bin-path'), enAppdata)
      env.APPDATA = appdata
    }
    for (const [origen, linea] of COPIAS) {
      const r = corre(linea, carpeta, env)
      if (debeCorrer) {
        verifica(r.codigo === 0 && r.salida.startsWith('corrio bueno:'),
          `${origen} / ${nombre}: salio ${r.codigo} con "${r.salida.trim()}${r.error.trim()}"`)
      } else {
        const lineas = r.error.split('\n').filter(Boolean)
        verifica(r.codigo === 1 && r.salida === '' && lineas.length === 1 &&
          /wa-scope not found/.test(lineas[0]) && [carpeta, realpathSync(carpeta)].some((c) => lineas[0].includes(c)),
          `${origen} / ${nombre}: tenia que salir 1 con una linea de motivo en stderr, salio `
          + `${r.codigo} con "${r.salida.trim()}" / "${r.error.trim()}"`)
      }
    }
    const p = corre(`${bloque[1]}\necho "WA=$WA"`, carpeta, env)
    verifica(debeCorrer ? p.salida.trim() === `WA=${bueno}` : /wa-scope not found/.test(p.salida),
      `el bloque del prompt / ${nombre}: ${p.salida.trim()}`)
  }
} finally {
  rmSync(casa, { recursive: true, force: true })
}

if (fallos.length) {
  console.error('Las herramientas no se encuentran como dicen `.wa-bin` y `bin-path`:')
  for (const f of fallos) console.error(`  ${f}`)
  process.exit(1)
}
console.log(`${hechas}/${hechas} las herramientas salen de .wa-bin o de bin-path y nunca de PATH`)
