#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'))
const processSpawn = manifest.capabilities.filter(({ kind }) => kind === 'process:spawn')

assert.deepEqual(processSpawn, [{ kind: 'process:spawn' }],
  'the worker requires the process:spawn capability to execute wa-scope')

// La descripcion es lo UNICO que el usuario lee antes de instalar: no puede prometer
// una funcion que el plugin ya no tiene. Prometia "conecta lineas de WhatsApp Web
// lanzando la CLI de Orca" mucho despues de que eso dejara de existir, y nada lo
// delataba — no hay chequeo que lea prosa.
for (const muerto of ['WhatsApp Web', 'browser tab', 'Orca CLI']) {
  assert.ok(!manifest.description.includes(muerto),
    `the description still promises "${muerto}", which the plugin no longer does`)
}
// Y tiene que decir lo que SI hace hoy, o el usuario instala a ciegas.
assert.match(manifest.description, /QR/,
  'the description does not say the line is paired with a QR code, which is what it does today')

console.log('2/2 manifest contract in green')
