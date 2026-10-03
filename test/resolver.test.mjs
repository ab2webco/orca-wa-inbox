#!/usr/bin/env node
// Como las automations y el prompt encuentran las herramientas: leyendo `.wa-bin`, el
// archivo donde el worker escribe la ruta de su propio `bin/`. Se prueba sobre el
// ARTEFACTO publicado (el `command` de tick, el `precheck` de triage y el bloque del
// prompt) corrido en una carpeta de mentira, y no sobre una copia.
//
// Lo que queda clavado:
//   1. con `.wa-bin` apuntando a un bin con wa-scope ejecutable, corre ESE wa-scope;
//   2. sin `.wa-bin`, con el archivo vacio o con un bin sin wa-scope ejecutable, la
//      automation sale con 1 y no corre nada, callada;
//   3. un `wa-scope` pelado en PATH no se usa nunca: puede ser una copia vieja que lee
//      otra base.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  const escenarios = [
    ['con .wa-bin corre el wa-scope de esa ruta', `${bueno}\n`, true],
    ['sin salto de linea al final tambien', bueno, true],
    ['con el archivo vacio no corre nada', '', false],
    ['con un bin sin wa-scope ejecutable no corre nada', `${sinPermiso}\n`, false],
    ['con una ruta que no existe no corre nada', `${casa}/no-existe\n`, false]
  ]
  for (const [nombre, contenido, debeCorrer] of escenarios) {
    const carpeta = mkdtempSync(join(casa, 'ws-'))
    writeFileSync(join(carpeta, '.wa-bin'), contenido)
    for (const [origen, linea] of COPIAS) {
      const r = corre(linea, carpeta, { PATH: `${ajeno}:${process.env.PATH}` })
      if (debeCorrer) {
        verifica(r.codigo === 0 && r.salida.startsWith('corrio bueno:'),
          `${origen} / ${nombre}: salio ${r.codigo} con "${r.salida.trim()}"`)
      } else {
        verifica(r.codigo === 1 && r.salida === '' && r.error === '',
          `${origen} / ${nombre}: tenia que salir 1 y callada, salio ${r.codigo} con `
          + `"${r.salida.trim()}${r.error.trim()}"`)
      }
    }
    const p = corre(`${bloque[1]}\necho "WA=$WA"`, carpeta, { PATH: `${ajeno}:${process.env.PATH}` })
    verifica(debeCorrer ? p.salida.trim() === `WA=${bueno}` : /wa-scope not found/.test(p.salida),
      `el bloque del prompt / ${nombre}: ${p.salida.trim()}`)
  }

  // Sin archivo alguno.
  const vacia = mkdtempSync(join(casa, 'ws-'))
  for (const [origen, linea] of COPIAS) {
    const r = corre(linea, vacia, { PATH: `${ajeno}:${process.env.PATH}` })
    verifica(r.codigo === 1 && r.salida === '',
      `${origen} / sin .wa-bin: no puede caer en el wa-scope de PATH (salio ${r.codigo}, `
      + `"${r.salida.trim()}")`)
  }
} finally {
  rmSync(casa, { recursive: true, force: true })
}

if (fallos.length) {
  console.error('Las herramientas no se encuentran como dice `.wa-bin`:')
  for (const f of fallos) console.error(`  ${f}`)
  process.exit(1)
}
console.log(`${hechas}/${hechas} las herramientas salen de .wa-bin y nunca de PATH`)
