/**
 * Ejercita los paneles de verdad: carga el HTML, simula el puente del host con un
 * storage en memoria, y aprieta cada control.
 *
 * Existe porque `check-panels` solo valida sintaxis, y dos veces se publicaron paneles
 * que parseaban pero no hacian nada: una vez porque una edicion se llevo los handlers
 * de guardar, otra porque el resultado de storage.get venia envuelto dos veces. Los dos
 * casos se ven identicos a la vista — un panel que no responde y no dice por que.
 */
// Las dependencias del arnes viven FUERA de la raiz del plugin: Orca hashea todo
// lo que hay bajo ella y rechaza symlinks, y node_modules/.bin son symlinks — con
// node_modules aca el plugin queda "No valido". NODE_PATH no sirve para ESM, asi
// que se resuelve con createRequire contra el directorio hermano.
import { createRequire } from 'node:module'

const DEPS = process.env.WA_INBOX_DEPS ??
  new URL('../../.orca-wa-inbox-deps/package.json', import.meta.url).pathname
const req = createRequire(DEPS)
const { JSDOM } = req('jsdom')
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fallos = 0
let pruebas = 0

function ok (nombre, condicion, detalle = '') {
  pruebas += 1
  if (condicion) return console.log(`  ok    ${nombre}`)
  fallos += 1
  console.log(`  FALLA ${nombre}${detalle ? ` — ${detalle}` : ''}`)
}

/** Monta un panel con el puente del host simulado. */
async function montar (archivo, storage = {}) {
  const html = readFileSync(join(root, archivo), 'utf8')
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true,
    url: 'https://panel.invalid/' })
  const { window } = dom
  const enviados = []

  // El host: responde storage.get/set contra un objeto, como hace Orca.
  window.addEventListener('message', (event) => {
    const d = event.data
    if (!d || d.type !== 'orca-panel-action') return
    enviados.push(d)
    let value
    if (d.action === 'storage.get') value = { value: storage[d.params.key] }
    else if (d.action === 'storage.set') { storage[d.params.key] = d.params.value; value = { ok: true } }
    else if (d.action === 'notifications.show') value = { delivered: true }
    else if (d.action === 'workspace.readContext') value = null
    window.postMessage({ type: 'orca-panel-action-result', requestId: d.requestId,
      ok: true, value }, '*')
  })

  await new Promise((r) => setTimeout(r, 60))
  return { window, doc: window.document, storage, enviados }
}

const espera = () => new Promise((r) => setTimeout(r, 60))

// ───────────────────────── config.html ─────────────────────────
console.log('\nconfig.html')
{
  const { doc, storage } = await montar('config.html')

  ok('los textos se tradujeron', doc.querySelector('h1').textContent.length > 0,
    'los data-t quedaron vacios: applyStrings no corrio')

  // Nombre del agente
  doc.getElementById('agent').value = 'Watson'
  doc.getElementById('save-agent').click()
  await espera()
  ok('guarda el nombre del agente', storage.agentName === 'Watson',
    `storage.agentName = ${JSON.stringify(storage.agentName)}`)
  ok('confirma el guardado en pantalla',
    doc.getElementById('said-agent').textContent.includes('Watson'))
  ok('bloquea el campo y ofrece editar',
    doc.getElementById('agent').disabled && !doc.getElementById('edit-agent').hidden)

  // Calidad de la transcripcion
  doc.getElementById('quality').value = 'minima'
  doc.getElementById('save-quality').click()
  await espera()
  ok('guarda la calidad de transcripcion', storage.transcribeQuality === 'minima',
    `storage.transcribeQuality = ${JSON.stringify(storage.transcribeQuality)}`)
  ok('confirma la calidad en pantalla',
    doc.getElementById('said-quality').textContent.includes('✓'))

  // Mapear conversacion
  doc.getElementById('chat').value = 'Soporte Acme'
  doc.getElementById('provider').value = 'linear'
  doc.getElementById('target').value = 'ENG'
  doc.getElementById('mode').value = 'borrador'
  doc.getElementById('save-scope').click()
  await espera()
  const entrada = (storage.scope || {})['Soporte Acme']
  ok('guarda la conversacion', !!entrada, `storage.scope = ${JSON.stringify(storage.scope)}`)
  ok('guarda proveedor, destino y permiso',
    entrada && entrada.provider === 'linear' && entrada.target === 'ENG' && entrada.mode === 'borrador')
  ok('confirma y limpia el formulario',
    doc.getElementById('said-scope').textContent.includes('Soporte Acme') &&
    doc.getElementById('chat').value === '')
  ok('la tabla muestra lo guardado',
    doc.getElementById('scope-wrap').textContent.includes('Soporte Acme'))

  // Editar
  doc.querySelector('[data-edit]').click()
  await espera()
  ok('Editar carga la fila en el formulario', doc.getElementById('chat').value === 'Soporte Acme')
  // El input #chat esta oculto: comprobarlo solo dejaba pasar el caso real, en el que
  // el select visible se quedaba en "Elegi una conversacion".
  ok('Editar deja el select visible en esa conversacion',
    doc.getElementById('chat-pick').value === 'Soporte Acme',
    `chat-pick = ${JSON.stringify(doc.getElementById('chat-pick').value)}`)
  ok('Editar cambia el boton a guardar cambios',
    doc.getElementById('save-scope').textContent.toLowerCase().includes('cambio') ||
    doc.getElementById('save-scope').textContent.toLowerCase().includes('change'))
  doc.getElementById('cancel-edit').click()
  await espera()
  ok('Cancelar edicion limpia', doc.getElementById('chat').value === '')

  // Reglas de ruteo
  doc.getElementById('r-match').value = 'ACME'
  doc.getElementById('r-target').value = 'ACM'
  doc.getElementById('save-route').click()
  await espera()
  ok('guarda una regla de ruteo', (storage.routes || []).some((r) => r.pattern === 'acme'),
    `storage.routes = ${JSON.stringify(storage.routes)}`)
  ok('normaliza el patron a minusculas',
    (storage.routes || []).every((r) => r.pattern === r.pattern.toLowerCase()))
  ok('la regla aparece en la tabla',
    doc.getElementById('routes-wrap').textContent.includes('ACM'))

  // Quitar
  doc.querySelector('[data-rrm]').click()
  await espera()
  ok('Quitar borra la regla', (storage.routes || []).length === 0)
  doc.querySelector('[data-rm]').click()
  await espera()
  ok('Quitar borra la conversacion', Object.keys(storage.scope || {}).length === 0)

  // Validaciones
  doc.getElementById('save-scope').click()
  await espera()
  ok('no guarda sin conversacion',
    doc.getElementById('said-scope').classList.contains('bad'))

  // Salud
  const roto = await montar('config.html', { health: { ok: false, problem: 'x' } })
  await espera()
  ok('avisa cuando WhatsApp no esta listo', !roto.doc.getElementById('alert').hidden)
  const sano = await montar('config.html', { health: { ok: true } })
  await espera()
  ok('no avisa nada cuando todo anda', sano.doc.getElementById('alert').hidden,
    'la barra roja aparece vacia')

  // Que el select llegue con lo guardado puesto: si el orden del Promise.all de
  // reload() se corre, cada campo se llena con el dato del vecino y no se nota.
  const calidad = await montar('config.html', { transcribeQuality: 'minima' })
  await espera()
  ok('carga la calidad guardada', calidad.doc.getElementById('quality').value === 'minima',
    `quality = ${calidad.doc.getElementById('quality').value}`)
  const sinCalidad = await montar('config.html', {})
  await espera()
  ok('sin nada guardado la calidad queda en optima',
    sinCalidad.doc.getElementById('quality').value === 'optima')
}

// ───────────────────────── activity.html ─────────────────────────
console.log('\nactivity.html')
{
  const actividad = {
    syncedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
    running: false,
    pending: [
      { stanzaId: 'S1', date: '2026-09-17 12:06', chat: 'Soporte Acme', sender: 'Ana',
        kind: 'mencion', text: 'necesito el reporte', hasMedia: true },
      { stanzaId: 'S2', date: '2026-09-17 11:00', chat: 'Soporte Acme', sender: 'Beto',
        kind: 'directo', text: 'hola', hasMedia: false }
    ],
    recent: [{ ts: '2026-09-17 11:30', chat: 'Soporte Acme', action: 'issue',
      issue: 'ACM-1', detail: 'reporte mensual' }]
  }
  const { doc, storage } = await montar('activity.html', { activity: actividad })

  ok('los textos se tradujeron', doc.querySelector('h1').textContent.length > 0)
  ok('lista los pendientes', doc.getElementById('pending').textContent.includes('necesito el reporte'))
  ok('marca los que traen imagen', doc.getElementById('pending').textContent.toLowerCase().includes('imagen') ||
    doc.getElementById('pending').textContent.toLowerCase().includes('image'))
  ok('muestra lo ultimo que hizo', doc.getElementById('recent').textContent.includes('ACM-1'))
  ok('muestra el sello de sincronizacion', doc.getElementById('synced').textContent.length > 0)

  doc.querySelector('[data-take]').click()
  await espera()
  ok('Tomar guarda la decision', (storage.decisions || {}).S1?.decision === 'take',
    `storage.decisions = ${JSON.stringify(storage.decisions)}`)
  ok('Tomar se ve marcado en la lista',
    doc.getElementById('pending').textContent.includes('✓'))

  doc.querySelector('[data-ignore]').click()
  await espera()
  ok('Ignorar guarda la decision', (storage.decisions || {}).S2?.decision === 'ignore')
  ok('lo ignorado desaparece de la lista',
    !doc.getElementById('pending').textContent.includes('hola'))

  doc.getElementById('refresh').click()
  await espera()
  ok('el boton de releer no rompe nada',
    doc.getElementById('pending').textContent.includes('necesito el reporte'))

  const vacio = await montar('activity.html', { activity: { pending: [], recent: [], syncedAt: '2026-09-17 12:00' } })
  await espera()
  ok('dice algo cuando no hay nada pendiente',
    vacio.doc.getElementById('pending').textContent.trim().length > 0)
  const sinDatos = await montar('activity.html', {})
  await espera()
  ok('avisa cuando nunca se sincronizo',
    sinDatos.doc.getElementById('synced').textContent.length > 0)
}

console.log(`\n${pruebas - fallos}/${pruebas} en verde`)
process.exit(fallos ? 1 : 0)
