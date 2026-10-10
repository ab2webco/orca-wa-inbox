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
import { readFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
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

/** Monta un panel con el puente del host simulado.
 *
 *  `idioma` fija navigator.language antes de que corra el script del panel, que es de
 *  donde el panel saca el idioma. Sin poder fijarlo solo se podria comprobar que el
 *  diccionario existe, no que el panel lo usa — y lo segundo es lo que se rompe. */
async function montar (archivo, storage = {}, idioma = null, gancho = null) {
  // Un worker VIVO por defecto. Sin latido el panel avisa —con razon— que el plugin no
  // esta corriendo, y ese aviso tapa el que cada caso viene a comprobar. Los casos que
  // prueban el worker ausente pasan su propio `workerBeat`.
  if (!('workerBeat' in storage)) storage.workerBeat = { at: new Date().toISOString() }
  const html = readFileSync(join(root, archivo), 'utf8')
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true,
    url: 'https://panel.invalid/',
    beforeParse (window) {
      if (!idioma) return
      Object.defineProperty(window.navigator, 'language',
        { value: idioma, configurable: true })
    } })
  const { window } = dom
  const enviados = []

  // El host: responde storage.get/set contra un objeto, como hace Orca.
  window.addEventListener('message', (event) => {
    const d = event.data
    if (!d || d.type !== 'orca-panel-action') return
    enviados.push(d)
    let value
    // El gancho deja simular lo que el host hace de verdad y el stub no: una escritura
    // que el host rechaza, y un worker que contesta el pedido. Sin poder provocarlos
    // solo se probaria el camino feliz, que es el que nunca se rompio. Lo que devuelve
    // es el SOBRE entero, que es donde el host dice que no: `{ ok: false }`.
    const forzado = gancho ? gancho(d, storage) : undefined
    if (forzado !== undefined && !forzado.__demora) {
      window.postMessage({ type: 'orca-panel-action-result', requestId: d.requestId,
        ...forzado }, '*')
      return
    }
    // El valor se toma AHORA, como hace el host: lee el archivo al recibir el mensaje.
    // Lo que el gancho puede alargar es cuanto tarda en llegar la respuesta, y en ese
    // hueco es donde vive la carrera — el sondeo pinta con lo que leyo antes.
    if (d.action === 'storage.get') value = { value: storage[d.params.key] }
    else if (d.action === 'storage.set') { storage[d.params.key] = d.params.value; value = { ok: true } }
    else if (d.action === 'notifications.show') value = { delivered: true }
    else if (d.action === 'workspace.readContext') value = null
    const entregar = () => window.postMessage(
      { type: 'orca-panel-action-result', requestId: d.requestId, ok: true, value }, '*')
    if (forzado && forzado.__demora) setTimeout(entregar, forzado.__demora)
    else entregar()
  })

  await new Promise((r) => setTimeout(r, 60))
  return { window, doc: window.document, storage, enviados }
}

const espera = () => new Promise((r) => setTimeout(r, 60))

/** Un worker que atiende `regla-quitar` como el de verdad: `wa-scope route --remove`
 *  borra la fila de la base y el worker saca la regla del storage del panel; recien
 *  despues deja el veredicto. */
function trabajadorReglas (d, st) {
  if (!(d.action === 'storage.set' && d.params.key === 'scopeRequest' && d.params.value)) {
    return undefined
  }
  const p = d.params.value
  st.scopeRequest = p
  if (p.action === 'regla-quitar') {
    st.routes = (st.routes || []).filter((r) => r.pattern !== p.pattern)
    st.scopeResult = { at: new Date().toISOString(), requestId: p.id, action: p.action,
      ok: true, code: 'regla-quitada' }
  }
  return { ok: true }
}

// ── Los controles de config.html, manejados como los maneja el dueno (T17) ──
// En el panel de Orca la lista de un `<select>` nativo no se abre (iframe con sandbox),
// asi que no queda ninguno: pocas opciones son grupos de botones con `aria-pressed`, y
// muchas son un autocompletar dibujado por la pagina. Estos ayudantes aprietan lo que
// el dueno aprieta, no asignan `.value` por debajo.
const evento = (doc, tipo) => new doc.defaultView.Event(tipo, { bubbles: true })
const tecla = (doc, key) => new doc.defaultView.KeyboardEvent('keydown', { key, bubbles: true })
/** El valor apretado de un grupo de botones. */
const valorSeg = (doc, id) =>
  doc.querySelector(`#${id} button[aria-pressed="true"]`)?.dataset.value ?? null
/** Aprieta la opcion `valor` de un grupo de botones. */
function elegirSeg (doc, id, valor) {
  const b = doc.querySelector(`#${id} button[data-value="${valor}"]`)
  if (!b) throw new Error(`#${id} no ofrece ${valor}`)
  b.click()
}
/** Los textos de las opciones de un grupo, por su valor. */
const textosSeg = (doc, id) => Object.fromEntries([...doc.querySelectorAll(`#${id} button`)]
  .map((b) => [b.dataset.value, b.textContent]))
/** Escribe en un autocompletar como se escribe: valor y evento `input`. */
function escribir (doc, id, texto) {
  const n = doc.getElementById(id)
  n.focus()
  n.value = texto
  n.dispatchEvent(evento(doc, 'input'))
}
/** Las opciones que muestra la lista de un autocompletar. */
const opcionesCombo = (doc, listaId) =>
  [...doc.querySelectorAll(`#${listaId} [role="option"]`)]
/** Abre el autocompletar de conversaciones y aprieta la de ese jid. */
function elegirChat (doc, jid, texto = '') {
  escribir(doc, 'chat-search', texto)
  const o = doc.querySelector(`#chat-list [role="option"][data-value="${jid}"]`)
  if (!o) throw new Error(`la lista no ofrece ${jid}`)
  o.click()
}
/** Elige un proyecto en uno de los dos autocompletar de proyecto ('' = Sin proyecto). */
function elegirProyecto (doc, prefijo, id) {
  escribir(doc, `${prefijo}-search`, '')
  const o = doc.querySelector(`#${prefijo}-list [role="option"][data-value="${id}"]`)
  if (!o) throw new Error(`#${prefijo}-list no ofrece ${JSON.stringify(id)}`)
  o.click()
}
/** Los proyectos que ofrece un autocompletar de proyecto, por su id. */
function proyectosOfrecidos (doc, prefijo) {
  escribir(doc, `${prefijo}-search`, '')
  const ids = opcionesCombo(doc, `${prefijo}-list`).map((o) => o.dataset.value)
  doc.getElementById(`${prefijo}-search`).dispatchEvent(tecla(doc, 'Escape'))
  return ids
}
/** Los textos de la lista de conversaciones, abierta con lo que haya escrito. */
function listaChats (doc) {
  const n = doc.getElementById('chat-search')
  n.focus()
  n.dispatchEvent(tecla(doc, 'ArrowDown'))
  return opcionesCombo(doc, 'chat-list').map((o) => o.textContent)
}

// ───────────────────────── config.html ─────────────────────────
// Los proyectos que el dueno acepto (T12): los que ofrece el selector de cada conversacion
// y de cada regla. Datos de ejemplo.
const PROYECTOS_PRUEBA = [
  { id: 'alfa-demo', name: 'Alfa Demo', path: '/srv/ejemplo/alfa-demo', note: 'Tienda en linea' },
  { id: 'beta-demo', name: 'Beta Demo', path: '/srv/ejemplo/beta-demo', note: '' }
]

// ───────── T17: ajustes rehechos para el modelo nuevo ─────────
console.log('\nconfig.html — T17: ni un <select> nativo, en ningun panel')
{
  // En Orca el panel vive en un iframe con sandbox y la lista de un select no se dibuja:
  // el dueno no podia encender Jev porque su select no abria. Se prueba en el archivo Y
  // despues de pintar, porque un select tambien se puede crear desde el script.
  for (const archivo of ['config.html', 'activity.html']) {
    const fuente = readFileSync(join(root, archivo), 'utf8')
    ok(`${archivo}: el archivo no trae ningun <select>`, !/<select\b/i.test(fuente))
    const { doc } = await montar(archivo, { chats: [{ jid: '1@g.us', name: 'Uno', kind: 'grupo' }],
      projects: PROYECTOS_PRUEBA }, 'es-419')
    await espera()
    ok(`${archivo}: y pintado tampoco hay ninguno`,
      doc.querySelectorAll('select').length === 0,
      String(doc.querySelectorAll('select').length))
  }
}

console.log('\nconfig.html — T17: pestanas')
{
  const { doc } = await montar('config.html', {}, 'es-419')
  await espera()
  const PESTANAS = ['estado', 'chats', 'proyectos', 'aprobacion', 'agente', 'skills',
    'avanzado']
  const tabs = [...doc.querySelectorAll('[role="tablist"] [role="tab"]')]
  ok('hay siete pestanas, en este orden',
    JSON.stringify(tabs.map((t) => t.id)) === JSON.stringify(PESTANAS.map((p) => `tab-${p}`)),
    JSON.stringify(tabs.map((t) => t.id)))
  ok('cada pestana tiene su texto', tabs.every((t) => t.textContent.trim().length > 2),
    JSON.stringify(tabs.map((t) => t.textContent)))
  // Cada control vive en su pestana: lo que el dueno busca tiene un solo lugar.
  const DONDE = {
    estado: ['pairing-msg', 'qr-wrap', 'checklist', 'opcionales'],
    chats: ['chat-search', 'chat-list', 'chat-fetch', 'scope-wrap', 'mode', 'workspace-search',
      'save-scope', 'r-match', 'r-workspace-search', 'save-route', 'routes-wrap'],
    proyectos: ['projects-wrap', 'proposals-wrap', 'projects-refresh'],
    aprobacion: ['exceptions', 'jev-aviso', 'jev-enabled', 'jev-key', 'jev-save-key'],
    agente: ['agent', 'owner', 'tone', 'save-agent'],
    avanzado: ['transcribe', 'lang', 'quality', 'save-voice', 'inbox-days', 'sync-minutes',
      'save-reading'],
    skills: ['skills-wrap', 'said-skills']
  }
  const fuera = []
  for (const [p, ids] of Object.entries(DONDE)) {
    for (const id of ids) {
      const n = doc.getElementById(id)
      if (!n || !n.closest(`#view-${p}`)) fuera.push(`${id} -> ${p}`)
    }
  }
  ok('cada control vive en su pestana', fuera.length === 0, JSON.stringify(fuera))
  ok('el aviso general queda fuera de las pestanas: se ve desde cualquiera',
    !doc.getElementById('alert').closest('[role="tabpanel"]'))

  doc.getElementById('tab-avanzado').click()
  await espera()
  ok('apretar una pestana la muestra y esconde las demas',
    !doc.getElementById('view-avanzado').hidden &&
    PESTANAS.filter((p) => p !== 'avanzado').every((p) => doc.getElementById(`view-${p}`).hidden))
  ok('y la marca como elegida',
    doc.getElementById('tab-avanzado').getAttribute('aria-selected') === 'true' &&
    doc.getElementById('tab-estado').getAttribute('aria-selected') === 'false')
  doc.getElementById('tab-avanzado').dispatchEvent(tecla(doc, 'ArrowRight'))
  ok('las flechas pasan a la pestana vecina',
    doc.getElementById('tab-agente').getAttribute('aria-selected') === 'true' ||
    doc.getElementById('tab-estado').getAttribute('aria-selected') === 'true')

  // Las pestanas en los tres idiomas, y en portugues propio.
  const S = doc.defaultView.STRINGS
  const claves = ['tabEstado', 'tabChats', 'tabProyectos', 'tabAprobacion', 'tabAgente',
    'tabSkills', 'tabAvanzado']
  ok('las pestanas se nombran en los tres idiomas',
    claves.every((k) => S.es[k] && S.en[k] && S.pt[k]), JSON.stringify(claves.map((k) => S.pt[k])))
  ok('Su aprobacion va de usted y sin tildes',
    S.es.tabAprobacion === 'Su aprobacion', S.es.tabAprobacion)
}

console.log('\nconfig.html — T17: la pestana de entrada depende de lo que falta')
{
  // Sin linea, sin nombre y sin conversaciones: se abre en Estado, que dice que falta.
  const nuevo = await montar('config.html', {}, 'es-419')
  await espera()
  ok('con la configuracion a medias se abre en Estado',
    nuevo.doc.getElementById('tab-estado').getAttribute('aria-selected') === 'true')
  const lista = nuevo.doc.getElementById('checklist')
  const falta = (item) => lista.querySelector(`[data-item="${item}"]`)?.dataset.ok
  ok('la lista dice que falta la linea, el nombre y una conversacion',
    falta('linea') === 'false' && falta('agente') === 'false' && falta('chat') === 'false',
    lista.textContent)
  ok('y nombra los proyectos y Jev, Jev como opcional',
    falta('proyectos') === 'false' && falta('jev') === 'false' &&
    /opcional/i.test(lista.querySelector('[data-item="jev"]').textContent), lista.textContent)
  // Cada falta lleva a la pestana donde se arregla.
  lista.querySelector('[data-item="chat"] button').click()
  ok('el boton de una falta lleva a su pestana',
    nuevo.doc.getElementById('tab-chats').getAttribute('aria-selected') === 'true')

  // Todo listo: se abre donde se trabaja a diario, Conversaciones.
  const listo = await montar('config.html', {
    agentName: 'Watson', projects: PROYECTOS_PRUEBA,
    sidecar: { connection: 'open', qr: null, exited: false,
      latido: { ts: Date.now(), conectado: true } },
    scope: { '1@g.us': { chatName: 'Uno', mode: 'responder', workspace: 'alfa-demo' } }
  }, 'es-419')
  await espera()
  ok('con todo listo se abre en Conversaciones',
    listo.doc.getElementById('tab-chats').getAttribute('aria-selected') === 'true')
  ok('y Estado dice que lo necesario esta listo',
    ['linea', 'agente', 'chat', 'proyectos'].every((i) =>
      listo.doc.querySelector(`#checklist [data-item="${i}"]`)?.dataset.ok === 'true'))
  // El sondeo no cambia la pestana que el dueno eligio.
  listo.doc.getElementById('tab-proyectos').click()
  listo.window.dispatchEvent(new listo.window.Event('focus'))
  await espera()
  ok('el sondeo no le cambia la pestana al dueno',
    listo.doc.getElementById('tab-proyectos').getAttribute('aria-selected') === 'true')
}

console.log('\nconfig.html — T17: el autocompletar de conversaciones')
{
  const storage = {
    projects: PROYECTOS_PRUEBA,
    chats: [
      { jid: '120363000000000001@g.us', name: 'Soporte Norte', kind: 'grupo' },
      { jid: '120363000000000002@g.us', name: 'Operaciones', kind: 'grupo' },
      { jid: '573000000001@s.whatsapp.net', name: 'Laura Mendez', kind: 'directo' }
    ]
  }
  const { doc, window } = await montar('config.html', storage, 'es-419')
  await espera()
  const input = doc.getElementById('chat-search')
  ok('es un combobox con su lista', input.getAttribute('role') === 'combobox' &&
    input.getAttribute('aria-controls') === 'chat-list' &&
    doc.getElementById('chat-list').getAttribute('role') === 'listbox')
  ok('cerrado al cargar', input.getAttribute('aria-expanded') === 'false' &&
    doc.getElementById('chat-list').hidden)
  ok('Traer conversaciones esta al lado del buscador',
    doc.getElementById('chat-fetch').closest('.combo-row') === input.closest('.combo-row'))

  escribir(doc, 'chat-search', 'laura')
  let opciones = opcionesCombo(doc, 'chat-list')
  ok('escribir abre la lista y filtra por nombre',
    input.getAttribute('aria-expanded') === 'true' && opciones.length === 1 &&
    opciones[0].textContent.includes('Laura Mendez'), opciones.map((o) => o.textContent).join(' | '))
  ok('cada opcion dice si es un grupo o un chat directo',
    /Directo/.test(opciones[0].textContent), opciones[0].textContent)
  escribir(doc, 'chat-search', '573000000001')
  ok('tambien filtra por numero', opcionesCombo(doc, 'chat-list').length === 1)
  escribir(doc, 'chat-search', '')
  opciones = opcionesCombo(doc, 'chat-list')
  ok('sin texto muestra todas, los grupos marcados como grupo',
    opciones.length === 3 && opciones.filter((o) => /Grupo/.test(o.textContent)).length === 2,
    opciones.map((o) => o.textContent).join(' | '))

  escribir(doc, 'chat-search', 'zzzz')
  ok('sin coincidencias lo dice, sin opciones',
    opcionesCombo(doc, 'chat-list').length === 0 &&
    /Ninguna coincide/.test(doc.getElementById('chat-list').textContent),
    doc.getElementById('chat-list').textContent)

  // Teclado: flechas mueven, Enter elige, Esc cierra.
  escribir(doc, 'chat-search', 'o')
  input.dispatchEvent(tecla(doc, 'ArrowDown'))
  input.dispatchEvent(tecla(doc, 'ArrowDown'))
  const activa = () => doc.getElementById(input.getAttribute('aria-activedescendant') || 'x')
  const segunda = opcionesCombo(doc, 'chat-list')[1]
  ok('flecha abajo mueve la opcion activa', activa() === segunda &&
    segunda.getAttribute('aria-selected') === 'true', input.getAttribute('aria-activedescendant'))
  input.dispatchEvent(tecla(doc, 'ArrowUp'))
  ok('flecha arriba vuelve', activa() === opcionesCombo(doc, 'chat-list')[0])
  input.dispatchEvent(tecla(doc, 'Escape'))
  ok('Esc cierra la lista sin borrar lo escrito',
    input.getAttribute('aria-expanded') === 'false' && doc.getElementById('chat-list').hidden &&
    input.value === 'o')
  escribir(doc, 'chat-search', 'operaciones')
  input.dispatchEvent(tecla(doc, 'ArrowDown'))
  input.dispatchEvent(tecla(doc, 'Enter'))
  ok('Enter elige la activa: el nombre queda en el campo y la lista se cierra',
    input.value === 'Operaciones' && input.getAttribute('aria-expanded') === 'false',
    input.value)
  ok('y debajo se ve su identificador',
    doc.getElementById('chat-id').textContent.includes('120363000000000002@g.us'),
    doc.getElementById('chat-id').textContent)

  // Clic elige, y lo elegido es lo que se guarda.
  elegirChat(doc, '573000000001@s.whatsapp.net', 'laura')
  ok('un clic elige', input.value === 'Laura Mendez', input.value)
  elegirSeg(doc, 'mode', 'observar')
  doc.getElementById('save-scope').click()
  await espera()
  ok('guardar autoriza la conversacion elegida, por su jid',
    storage.scope && storage.scope['573000000001@s.whatsapp.net'] &&
    storage.scope['573000000001@s.whatsapp.net'].mode === 'observar',
    JSON.stringify(storage.scope))

  // El sondeo repinta cada pocos segundos: la lista abierta y lo escrito sobreviven.
  escribir(doc, 'chat-search', 'sop')
  input.dispatchEvent(tecla(doc, 'ArrowDown'))
  const antes = input.getAttribute('aria-activedescendant')
  storage.chats = storage.chats.concat([{ jid: '120363000000000009@g.us',
    name: 'Soporte Sur', kind: 'grupo' }])
  window.dispatchEvent(new window.Event('focus'))
  await espera()
  opciones = opcionesCombo(doc, 'chat-list')
  ok('tras el repintado la lista sigue abierta y con lo escrito',
    input.value === 'sop' && input.getAttribute('aria-expanded') === 'true' &&
    !doc.getElementById('chat-list').hidden, `${input.value} ${input.getAttribute('aria-expanded')}`)
  ok('y ya trae lo nuevo, filtrado', opciones.length === 2 &&
    opciones.some((o) => o.textContent.includes('Soporte Sur')),
    opciones.map((o) => o.textContent).join(' | '))
  ok('y la opcion activa sigue siendo la misma', input.getAttribute('aria-activedescendant') === antes &&
    activa()?.dataset.value === '120363000000000001@g.us', input.getAttribute('aria-activedescendant'))
}

console.log('\nconfig.html — T17: sin conversaciones la lista lo dice')
{
  const { doc } = await montar('config.html', {
    syncStatus: { running: true, startedAt: new Date().toISOString(), trigger: 'activate' }
  }, 'es-419')
  await espera()
  escribir(doc, 'chat-search', '')
  ok('la lista abierta dice que esta buscando, sin opciones',
    opcionesCombo(doc, 'chat-list').length === 0 &&
    /Buscando/.test(doc.getElementById('chat-list').textContent),
    doc.getElementById('chat-list').textContent)
}

console.log('\nconfig.html — T17: el proyecto se elige con el mismo autocompletar')
{
  const storage = { projects: PROYECTOS_PRUEBA,
    chats: [{ jid: '1@g.us', name: 'Soporte Norte', kind: 'grupo' }] }
  const { doc } = await montar('config.html', storage, 'es-419')
  await espera()
  const ws = doc.getElementById('workspace-search')
  ok('el proyecto es un combobox', ws.getAttribute('role') === 'combobox' &&
    doc.getElementById('workspace-list').getAttribute('role') === 'listbox')
  escribir(doc, 'workspace-search', 'beta')
  const ofrecidos = opcionesCombo(doc, 'workspace-list')
  ok('filtra los proyectos por nombre', ofrecidos.length === 1 &&
    ofrecidos[0].textContent.includes('Beta Demo'), ofrecidos.map((o) => o.textContent).join(' | '))
  escribir(doc, 'workspace-search', '')
  ok('sin texto ofrece Sin proyecto y los aceptados',
    JSON.stringify(opcionesCombo(doc, 'workspace-list').map((o) => o.dataset.value)) ===
    JSON.stringify(['', 'alfa-demo', 'beta-demo']))
  escribir(doc, 'workspace-search', 'zzzz')
  ok('y dice cuando ninguno coincide', opcionesCombo(doc, 'workspace-list').length === 0 &&
    doc.getElementById('workspace-list').textContent.length > 0)

  elegirChat(doc, '1@g.us')
  elegirProyecto(doc, 'workspace', 'beta-demo')
  ok('elegido, el campo muestra el nombre del proyecto', ws.value === 'Beta Demo', ws.value)
  doc.getElementById('save-scope').click()
  await espera()
  ok('y guardar la conversacion lleva ese proyecto',
    storage.scope && storage.scope['1@g.us'].workspace === 'beta-demo',
    JSON.stringify(storage.scope))

  // Las reglas por texto eligen el proyecto igual.
  doc.getElementById('r-match').value = 'Facturacion'
  elegirProyecto(doc, 'r-workspace', 'alfa-demo')
  doc.getElementById('save-route').click()
  await espera()
  ok('una regla por texto guarda el proyecto elegido en su autocompletar',
    (storage.routes || []).some((r) => r.pattern === 'facturacion' && r.workspace === 'alfa-demo'),
    JSON.stringify(storage.routes))
}

console.log('\nconfig.html — T17: las reglas viejas de Plane se marcan y se pueden quitar')
{
  const storage = { projects: PROYECTOS_PRUEBA, routes: [
    { pattern: 'cobros', provider: 'plane', target: 'FIN' },
    { pattern: 'envios', workspace: 'alfa-demo' }] }
  const { doc } = await montar('config.html', storage, 'es-419', trabajadorReglas)
  await espera()
  const filas = [...doc.querySelectorAll('#routes-wrap tbody tr')]
  const vieja = filas.find((f) => f.textContent.includes('cobros'))
  const nueva = filas.find((f) => f.textContent.includes('envios'))
  ok('la regla vieja se ve con su destino de antes',
    vieja && /plane/i.test(vieja.textContent) && /FIN/.test(vieja.textContent), vieja?.textContent)
  ok('y marcada como vieja', vieja && !!vieja.querySelector('.legacy') &&
    /vieja/i.test(vieja.textContent), vieja?.textContent)
  ok('la regla a un proyecto no lleva esa marca', nueva && !nueva.querySelector('.legacy'))
  vieja.querySelector('[data-rrm]').click()
  await new Promise((r) => setTimeout(r, 3000))
  ok('Quitar la borra y deja la otra',
    JSON.stringify(storage.routes) === JSON.stringify([{ pattern: 'envios', workspace: 'alfa-demo' }]),
    JSON.stringify(storage.routes))
}

console.log('\nconfig.html — quitar una regla pasa por el worker y no miente')
{
  const reglas = () => [{ pattern: 'attus', provider: 'plane', target: 'ATT' },
    { pattern: 'envios', workspace: 'alfa-demo' }]
  // Confirmado: pide, espera, dice que si y la fila se va.
  {
    const storage = { projects: PROYECTOS_PRUEBA, routes: reglas() }
    // El worker tarda: el veredicto llega 1,5 s despues del pedido.
    const { doc } = await montar('config.html', storage, 'es-419', (d, st) => {
      if (!(d.action === 'storage.set' && d.params.key === 'scopeRequest' && d.params.value)) {
        return undefined
      }
      st.scopeRequest = d.params.value
      setTimeout(() => trabajadorReglas(d, st), 1500)
      return { ok: true }
    })
    await espera()
    const boton = [...doc.querySelectorAll('#routes-wrap tbody tr')]
      .find((f) => f.textContent.includes('attus')).querySelector('[data-rrm]')
    boton.click()
    await espera()
    ok('el boton queda ocupado mientras se espera al worker',
      boton.disabled || boton.getAttribute('aria-busy') === 'true',
      `${boton.disabled} ${boton.getAttribute('aria-busy')}`)
    ok('el pedido va por el canal del worker con id, marca de tiempo y patron',
      !!storage.scopeRequest && storage.scopeRequest.action === 'regla-quitar' &&
      storage.scopeRequest.pattern === 'attus' && typeof storage.scopeRequest.id === 'string' &&
      !isNaN(Date.parse(storage.scopeRequest.at)), JSON.stringify(storage.scopeRequest))
    ok('y todavia no dice que la quito',
      !/✓/.test(doc.getElementById('said-route').textContent),
      doc.getElementById('said-route').textContent)
    await new Promise((r) => setTimeout(r, 3000))
    ok('cuando el worker confirma, lo dice con la regla',
      /✓.*attus/.test(doc.getElementById('said-route').textContent),
      doc.getElementById('said-route').textContent)
    ok('la fila desaparece y la otra sigue',
      !doc.getElementById('routes-wrap').textContent.includes('attus') &&
      doc.getElementById('routes-wrap').textContent.includes('envios'),
      doc.getElementById('routes-wrap').textContent)
  }
  // El worker no pudo: la regla sigue en pie y el panel lo dice como fallo, en espanol.
  {
    const storage = { projects: PROYECTOS_PRUEBA, routes: reglas() }
    const { doc } = await montar('config.html', storage, 'es-419', (d, st) => {
      if (d.action === 'storage.set' && d.params.key === 'scopeRequest' && d.params.value) {
        st.scopeRequest = d.params.value
        st.scopeResult = { at: new Date().toISOString(), requestId: d.params.value.id,
          action: d.params.value.action, ok: false, code: 'sin-herramientas',
          detail: 'spawn wa-scope ENOENT' }
        return { ok: true }
      }
      return undefined
    })
    await espera()
    doc.querySelector('[data-rrm]').click()
    await new Promise((r) => setTimeout(r, 3000))
    const dicho = doc.getElementById('said-route')
    ok('un fallo del worker no se anuncia como hecho',
      !/✓/.test(dicho.textContent) && /bad/.test(dicho.className) && dicho.textContent.length > 0,
      `${dicho.className} ${dicho.textContent}`)
    ok('y sin el texto crudo del CLI', !/spawn|ENOENT/.test(dicho.textContent), dicho.textContent)
    ok('la regla sigue en la tabla y en el storage',
      doc.getElementById('routes-wrap').textContent.includes('attus') &&
      storage.routes.length === 2, doc.getElementById('routes-wrap').textContent)
  }
  // Sin respuesta: se dice que no contesto, no se finge.
  {
    const storage = { projects: PROYECTOS_PRUEBA, routes: reglas() }
    const { doc, window } = await montar('config.html', storage, 'es-419')
    window.VEREDICTO_ESPERA_MS = 400
    await espera()
    doc.querySelector('[data-rrm]').click()
    await new Promise((r) => setTimeout(r, 4500))
    const dicho = doc.getElementById('said-route')
    ok('si el worker no contesta, el panel dice que no hubo respuesta',
      /no contest/i.test(dicho.textContent) && /bad/.test(dicho.className),
      `${dicho.className} ${dicho.textContent}`)
    ok('y la regla sigue donde estaba',
      doc.getElementById('routes-wrap').textContent.includes('attus') && storage.routes.length === 2)
  }
  // Los tres idiomas.
  const { window } = await montar('config.html')
  const S = window.STRINGS
  const nuevas = ['routeRmFail', 'routeRmBadPattern']
  ok('los textos nuevos existen en los tres idiomas, el portugues propio',
    nuevas.every((k) => S.es[k] && S.en[k] && S.pt[k] && S.pt[k] !== S.en[k]),
    JSON.stringify(nuevas.filter((k) => !S.es[k] || !S.en[k] || !S.pt[k])))
}

console.log('\nconfig.html — T17: los modos son botones y escriben lo mismo que el select')
{
  const { doc } = await montar('config.html', {}, 'es-419')
  await espera()
  ok('los cuatro modos, con los valores que lee wa-scope',
    JSON.stringify(Object.keys(textosSeg(doc, 'mode'))) ===
    JSON.stringify(['off', 'observar', 'borrador', 'responder']))
  ok('una conversacion nueva arranca apagada', valorSeg(doc, 'mode') === 'off')
  elegirSeg(doc, 'mode', 'responder')
  ok('apretar un modo lo marca y suelta el otro', valorSeg(doc, 'mode') === 'responder' &&
    doc.querySelectorAll('#mode button[aria-pressed="true"]').length === 1)
  ok('y debajo explica que hace, con las excepciones',
    /excepciones/i.test(doc.getElementById('mode-desc').textContent),
    doc.getElementById('mode-desc').textContent)
}

console.log('\nconfig.html — T17: Avanzado, un guardar por tarjeta')
{
  const { doc, storage, enviados } = await montar('config.html', {}, 'es-419')
  await espera()
  elegirSeg(doc, 'transcribe', 'off')
  elegirSeg(doc, 'lang', 'pt')
  elegirSeg(doc, 'quality', 'minima')
  const antes = enviados.length
  doc.getElementById('save-voice').click()
  await espera(); await espera()
  ok('Notas de voz guarda sus tres valores con un solo boton',
    storage.transcribe === 'off' && storage.transcribeLang === 'pt' &&
    storage.transcribeQuality === 'minima',
    JSON.stringify([storage.transcribe, storage.transcribeLang, storage.transcribeQuality]))
  ok('sin tocar las claves de la otra tarjeta',
    !enviados.slice(antes).some((d) => d.action === 'storage.set' &&
      ['inboxDays', 'syncMinutes'].includes(d.params.key)))
  ok('y lo confirma', /✓/.test(doc.getElementById('said-voice').textContent))

  elegirSeg(doc, 'inbox-days', '30')
  elegirSeg(doc, 'sync-minutes', '15')
  doc.getElementById('save-reading').click()
  await espera(); await espera()
  ok('Lectura guarda la ventana y la frecuencia con un solo boton',
    storage.inboxDays === '30' && storage.syncMinutes === '15',
    JSON.stringify([storage.inboxDays, storage.syncMinutes]))
  ok('con los mismos valores de antes, en texto',
    typeof storage.inboxDays === 'string' && typeof storage.syncMinutes === 'string')
  ok('y lo confirma', /✓/.test(doc.getElementById('said-reading').textContent))
  ok('ya no hay un boton de guardar por campo',
    !doc.getElementById('save-days') && !doc.getElementById('save-sync') &&
    !doc.getElementById('save-lang') && !doc.getElementById('save-quality') &&
    !doc.getElementById('save-transcribe') && !doc.getElementById('save-tone') &&
    !doc.getElementById('save-owner'))
}

console.log('\nconfig.html — T17: Agente, un guardar para nombre, dueno y tono')
{
  const { doc, storage } = await montar('config.html', {}, 'es-419')
  await espera()
  doc.getElementById('agent').value = 'Watson'
  doc.getElementById('owner').value = '  Persona De Ejemplo '
  doc.getElementById('tone').value = 'De usted, frases cortas.'
  doc.getElementById('save-agent').click()
  await espera(); await espera()
  ok('un clic guarda los tres',
    storage.agentName === 'Watson' && storage.ownerName === 'Persona De Ejemplo' &&
    storage.tone === 'De usted, frases cortas.',
    JSON.stringify([storage.agentName, storage.ownerName, storage.tone]))
  ok('y lo confirma', /✓/.test(doc.getElementById('said-agent').textContent))
  doc.getElementById('agent').value = ''
  doc.getElementById('save-agent').click()
  await espera()
  ok('sin nombre no guarda y lo dice', storage.agentName === 'Watson' &&
    doc.getElementById('said-agent').classList.contains('bad'))
}

console.log('\nconfig.html — T17: Jev se enciende con un interruptor')
{
  const storage = { jevStatus: { at: new Date().toISOString(), enabled: false, keySet: true,
    mirror: 'apagado' } }
  const { doc } = await montar('config.html', storage, 'es-419', (d, st) => {
    if (d.action === 'storage.set' && d.params.key === 'jevRequest' && d.params.value) {
      const p = d.params.value
      st.jevRequestVisto = p
      st.jevStatus = { at: new Date().toISOString(), enabled: p.enabled, keySet: true,
        mirror: 'activo' }
      st.jevResult = { at: new Date().toISOString(), requestId: p.id, action: p.action,
        ok: true, code: 'activado' }
      return { ok: true }
    }
    return undefined
  })
  await espera()
  const sw = doc.getElementById('jev-enabled')
  ok('es un interruptor, apagado', sw.getAttribute('role') === 'switch' &&
    sw.getAttribute('aria-checked') === 'false', sw.outerHTML.slice(0, 120))
  const aviso = doc.getElementById('jev-aviso')
  ok('el aviso de a donde va el texto esta arriba del interruptor',
    !!(aviso.compareDocumentPosition(sw) & doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING))
  sw.click()
  await new Promise((r) => setTimeout(r, 2500))
  ok('apretarlo manda el mismo pedido de siempre: activar con enabled verdadero',
    storage.jevRequestVisto && storage.jevRequestVisto.action === 'activar' &&
    storage.jevRequestVisto.enabled === true, JSON.stringify(storage.jevRequestVisto))
  ok('y queda encendido con lo que dice el worker', sw.getAttribute('aria-checked') === 'true' &&
    /encendido/i.test(doc.getElementById('jev-status').textContent),
    doc.getElementById('jev-status').textContent)
  ok('no hay un boton aparte de guardar el interruptor', !doc.getElementById('jev-save-enabled'))
}

console.log('\nconfig.html — T17: Su aprobacion explica las excepciones fijas')
{
  const { doc } = await montar('config.html', {}, 'es-419')
  await espera()
  const texto = doc.getElementById('exceptions').textContent
  ok('nombra dinero, credenciales, compromisos, Jev y "Le pregunto antes"',
    /dinero/i.test(texto) && /credencial/i.test(texto) && /fecha|compromiso/i.test(texto) &&
    /Jev/.test(texto) && /Le pregunto antes/.test(texto), texto)
  ok('y dice que Jev solo puede detener, nunca habilitar', /nunca/i.test(texto), texto)
  // Aprobar por WhatsApp ya existe (T14): se dice como algo que funciona, no se anuncia.
  const vista = doc.getElementById('view-aprobacion').textContent
  ok('sin nada que todavia no existe', !/proximamente|pronto|coming soon/i.test(vista), vista)
}

console.log('\nconfig.html — T22: las reglas como son, por conversacion y con niveles')
{
  const { doc } = await montar('config.html', {}, 'es-419')
  await espera()
  const texto = doc.getElementById('exceptions').textContent
  ok('ya no dice que las reglas no se pueden apagar', !/no se pueden apagar/i.test(texto), texto)
  ok('nombra los tres niveles', /Preguntarme/.test(texto) &&
    /Que el agente lo revise/.test(texto) && /Permitir/.test(texto), texto)
  ok('dice lo que es cada regla: un monto, una fecha u hora concreta, una pregunta no promete',
    /monto/i.test(texto) && /fecha u hora/i.test(texto) && /pregunta/i.test(texto), texto)
  ok('y lo que no se apaga nunca: un secreto', /secreto/i.test(texto), texto)
}

console.log('\nconfig.html — T22: los numeros del dueno se eligen de los que escribieron')
{
  const { doc, storage } = await montar('config.html', {
    chats: [{ jid: '100000000000001@lid', name: 'Ana Duena', kind: 'directo' },
      { jid: '120363000000000001@g.us', name: 'Soporte Norte', kind: 'grupo' }],
    senders: [{ id: '100000000000002@lid', name: 'Beto Socio', chats: ['Soporte Norte'] }]
  }, 'es-419')
  await espera()
  ok('la tarjeta esta en Su aprobacion',
    !!doc.querySelector('#view-aprobacion #owners-card'), 'falta #owners-card')
  escribir(doc, 'owner-search', 'beto')
  let opciones = opcionesCombo(doc, 'owner-list')
  ok('el autocompletar ofrece a quien escribio, con su nombre y donde',
    opciones.length === 1 && opciones[0].dataset.value === '100000000000002@lid' &&
    opciones[0].textContent.includes('Beto Socio') &&
    opciones[0].textContent.includes('Soporte Norte'), opciones.map((o) => o.textContent))
  escribir(doc, 'owner-search', 'soporte')
  ok('un grupo no es una persona: no se ofrece',
    !opcionesCombo(doc, 'owner-list').some((o) => o.dataset.value.endsWith('@g.us')),
    opcionesCombo(doc, 'owner-list').map((o) => o.dataset.value))
  escribir(doc, 'owner-search', '+57 300 000 0000')
  ok('un numero escrito a mano no se puede elegir', opcionesCombo(doc, 'owner-list').length === 0)
  escribir(doc, 'owner-search', 'beto')
  opcionesCombo(doc, 'owner-list')[0].click()
  escribir(doc, 'owner-search', 'ana')
  opciones = opcionesCombo(doc, 'owner-list')
  ok('un directo tambien se ofrece, por su id', opciones.length === 1 &&
    opciones[0].dataset.value === '100000000000001@lid', opciones.map((o) => o.dataset.value))
  opciones[0].click()
  ok('lo elegido se lista antes de guardar',
    doc.getElementById('owners-wrap').textContent.includes('Beto Socio') &&
    doc.getElementById('owners-wrap').textContent.includes('Ana Duena'),
  doc.getElementById('owners-wrap').textContent)
  doc.getElementById('save-owners').click()
  await espera()
  ok('guardar deja los ids observados, con nombre',
    JSON.stringify(storage.owners) === JSON.stringify([
      { id: '100000000000002@lid', name: 'Beto Socio' },
      { id: '100000000000001@lid', name: 'Ana Duena' }]), JSON.stringify(storage.owners))
  doc.querySelector('#owners-wrap [data-orm="100000000000002@lid"]').click()
  doc.getElementById('save-owners').click()
  await espera()
  ok('quitar uno y guardar lo saca', JSON.stringify(storage.owners) ===
    JSON.stringify([{ id: '100000000000001@lid', name: 'Ana Duena' }]), JSON.stringify(storage.owners))
}

console.log('\nconfig.html — T14: el numero de aprobacion se elige entre los de confianza')
{
  const ANA = '100000000000001@lid'
  const BETO = '100000000000002@lid'
  const { doc, storage } = await montar('config.html', {
    owners: [{ id: ANA, name: 'Ana Duena' }, { id: BETO, name: 'Beto Socio' }],
    scope: { [ANA]: { chatName: 'Ana Duena', mode: 'observar' } }
  }, 'es-419')
  await espera()
  const grupo = doc.getElementById('approval-number')
  ok('el selector esta en la tarjeta de numeros de confianza',
    !!doc.querySelector('#owners-card #approval-number'), 'falta #approval-number')
  ok('es un grupo de botones, no un select nativo',
    grupo && grupo.classList.contains('seg') && !doc.querySelector('#owners-card select'))
  const botones = () => [...grupo.querySelectorAll('button')]
  ok('ofrece apagarlo y cada numero de confianza por su nombre',
    JSON.stringify(botones().map((b) => b.dataset.value)) === JSON.stringify(['', ANA, BETO]) &&
    /Ana Duena/.test(grupo.textContent) && /Beto Socio/.test(grupo.textContent),
    botones().map((b) => `${b.dataset.value}=${b.textContent}`).join(' | '))
  ok('sin numero elegido esta apagado',
    botones()[0].getAttribute('aria-pressed') === 'true', grupo.innerHTML.slice(0, 200))
  ok('apagado no hay aviso de chat sin autorizar', doc.getElementById('approval-warn').hidden)
  botones()[1].click()
  ok('elegir un numero cuyo chat no responde solo lo dice antes de guardar',
    !doc.getElementById('approval-warn').hidden &&
    /Automatico/.test(doc.getElementById('approval-warn').textContent),
    doc.getElementById('approval-warn').textContent)
  doc.getElementById('save-owners').click()
  await espera()
  ok('guardar deja el numero elegido y el idioma de los avisos',
    storage.approvalNumber === ANA && storage.approvalLang === 'es',
    `${storage.approvalNumber} ${storage.approvalLang}`)
  ok('la ayuda dice como contestar', /si 18/.test(doc.getElementById('owners-card').textContent),
    doc.getElementById('owners-card').textContent)
  doc.querySelector(`#owners-wrap [data-orm="${ANA}"]`).click()
  ok('quitar el numero de confianza lo saca del selector',
    !botones().some((b) => b.dataset.value === ANA) &&
    botones()[0].getAttribute('aria-pressed') === 'true')
  doc.getElementById('save-owners').click()
  await espera()
  ok('y guardar apaga los avisos', storage.approvalNumber === '', String(storage.approvalNumber))
}
{
  const ANA = '100000000000001@lid'
  const { doc } = await montar('config.html', {
    owners: [{ id: ANA, name: 'Ana Duena' }], approvalNumber: ANA,
    scope: { [ANA]: { chatName: 'Ana Duena', mode: 'responder' } }
  }, 'en-US')
  await espera()
  const grupo = doc.getElementById('approval-number')
  ok('lo guardado se muestra elegido',
    grupo.querySelector('button[aria-pressed="true"]')?.dataset.value === ANA, grupo.innerHTML.slice(0, 300))
  ok('con el chat en Responder no hay aviso', doc.getElementById('approval-warn').hidden)
  ok('en ingles tambien', /Approval number/i.test(doc.getElementById('owners-card').textContent) &&
    /Off/.test(grupo.textContent), doc.getElementById('owners-card').textContent)
}

console.log('\nconfig.html — T22: cada conversacion con sus niveles de aprobacion')
{
  const JID = '120363000000000001@g.us'
  const { doc, storage } = await montar('config.html', {
    chats: [{ jid: JID, name: 'Soporte Norte', kind: 'grupo' }]
  }, 'es-419')
  await espera()
  const grupos = ['chat-ap-money', 'chat-ap-credential', 'chat-ap-commitment', 'chat-ap-quality']
  ok('el editor tiene un grupo de tres botones por regla',
    grupos.every((g) => doc.querySelectorAll(`#${g} button`).length === 3),
    grupos.map((g) => doc.querySelectorAll(`#${g} button`).length))
  ok('con los textos del dueno', JSON.stringify(textosSeg(doc, 'chat-ap-money')) ===
    JSON.stringify({ ask: 'Preguntarme', agent: 'Que el agente lo revise', allow: 'Permitir' }),
  JSON.stringify(textosSeg(doc, 'chat-ap-money')))
  ok('una conversacion nueva arranca con los niveles por defecto',
    valorSeg(doc, 'chat-ap-money') === 'ask' && valorSeg(doc, 'chat-ap-credential') === 'ask' &&
    valorSeg(doc, 'chat-ap-commitment') === 'ask' && valorSeg(doc, 'chat-ap-quality') === 'agent',
  grupos.map((g) => valorSeg(doc, g)))
  elegirChat(doc, JID, 'soporte')
  elegirSeg(doc, 'mode', 'responder')
  elegirSeg(doc, 'chat-ap-money', 'allow')
  elegirSeg(doc, 'chat-ap-quality', 'ask')
  doc.getElementById('save-scope').click()
  await espera()
  ok('guardar deja los cuatro niveles en la conversacion',
    JSON.stringify(storage.scope?.[JID]?.approval) === JSON.stringify(
      { money: 'allow', credential: 'ask', commitment: 'ask', quality: 'ask' }),
  JSON.stringify(storage.scope?.[JID]))
  ok('y el formulario vuelve a los de por defecto', valorSeg(doc, 'chat-ap-money') === 'ask')
  doc.querySelector(`[data-edit="${JID}"]`)?.click()
  await espera()
  ok('editarla trae sus niveles', valorSeg(doc, 'chat-ap-money') === 'allow' &&
    valorSeg(doc, 'chat-ap-quality') === 'ask', grupos.map((g) => valorSeg(doc, g)))
}

console.log('\nconfig.html')
{
  const { doc, storage } = await montar('config.html', { projects: PROYECTOS_PRUEBA })

  // Mira la bajada, no un h1: config.html ya no tiene titulo propio porque el host
  // lo pinta. Comprobar el h1 ataba la prueba a un elemento que se podia quitar.
  ok('los textos se tradujeron', doc.querySelector('.sub').textContent.length > 0,
    'los data-t quedaron vacios: applyStrings no corrio')

  // Nombre del agente (T17: la tarjeta Agente guarda nombre, dueno y tono juntos).
  doc.getElementById('agent').value = 'Watson'
  doc.getElementById('save-agent').click()
  await espera()
  ok('guarda el nombre del agente', storage.agentName === 'Watson',
    `storage.agentName = ${JSON.stringify(storage.agentName)}`)
  ok('confirma el guardado en pantalla',
    doc.getElementById('said-agent').textContent.includes('✓'))
  ok('el campo queda con el nombre guardado',
    doc.getElementById('agent').value === 'Watson')

  // Calidad de la transcripcion (tarjeta Notas de voz).
  elegirSeg(doc, 'quality', 'minima')
  doc.getElementById('save-voice').click()
  await espera()
  ok('guarda la calidad de transcripcion', storage.transcribeQuality === 'minima',
    `storage.transcribeQuality = ${JSON.stringify(storage.transcribeQuality)}`)
  ok('confirma la calidad en pantalla',
    doc.getElementById('said-voice').textContent.includes('✓'))

  // Para quien trabaja. No es el nombre del agente: es el del dueno, y el prompt lo
  // lee para saber a quien le reporta.
  doc.getElementById('owner').value = '  Persona De Ejemplo  '
  doc.getElementById('save-agent').click()
  await espera()
  ok('guarda para quien trabaja', storage.ownerName === 'Persona De Ejemplo',
    `storage.ownerName = ${JSON.stringify(storage.ownerName)}`)
  ok('confirma el dueno en pantalla',
    doc.getElementById('said-agent').textContent.includes('✓'))

  // Modo de transcripcion. Poder apagarla entera sin abrir una terminal es el punto.
  elegirSeg(doc, 'transcribe', 'off')
  doc.getElementById('save-voice').click()
  await espera()
  ok('guarda el modo de transcripcion', storage.transcribe === 'off',
    `storage.transcribe = ${JSON.stringify(storage.transcribe)}`)
  ok('confirma el modo en pantalla',
    doc.getElementById('said-voice').textContent.includes('✓'))

  elegirSeg(doc, 'lang', 'pt')
  doc.getElementById('save-voice').click()
  await espera()
  ok('guarda el idioma de los audios', storage.transcribeLang === 'pt',
    `storage.transcribeLang = ${JSON.stringify(storage.transcribeLang)}`)

  // La ventana de lectura. Era un tope escondido: solo se movia por terminal, asi que
  // desde el panel una mencion del viernes desaparecia el lunes sin explicacion.
  elegirSeg(doc, 'inbox-days', '30')
  doc.getElementById('save-reading').click()
  await espera()
  ok('guarda la ventana de lectura', storage.inboxDays === '30',
    `storage.inboxDays = ${JSON.stringify(storage.inboxDays)}`)
  ok('confirma la ventana en pantalla',
    doc.getElementById('said-reading').textContent.includes('✓'))

  // Cada cuanto se relee WhatsApp. Es lo que acota cuanto tarda un mensaje en llegarle
  // al agente: el precheck de las automations contesta con lo que dejo el ultimo sync,
  // asi que si esto no se pudiera cambiar el retraso seria una constante escondida.
  elegirSeg(doc, 'sync-minutes', '15')
  doc.getElementById('save-reading').click()
  await espera()
  ok('guarda cada cuanto revisa WhatsApp', storage.syncMinutes === '15',
    `storage.syncMinutes = ${JSON.stringify(storage.syncMinutes)}`)

  // Un grupo de botones no puede ofrecer un valor que el CLI vaya a rechazar: si lo
  // ofrece, el panel dice guardado y `wa-scope` lo tira. Se comprueba, no se confia.
  const opciones = (id) => Object.keys(textosSeg(doc, id))
  ok('el modo de transcripcion solo ofrece lo que el CLI acepta',
    JSON.stringify(opciones('transcribe')) === JSON.stringify(['local', 'off']),
    `opciones = ${JSON.stringify(opciones('transcribe'))}`)
  ok('el idioma solo ofrece lo que el CLI acepta',
    JSON.stringify(opciones('lang')) === JSON.stringify(['auto', 'es', 'en', 'pt']),
    `opciones = ${JSON.stringify(opciones('lang'))}`)
  ok('la ventana solo ofrece numeros enteros',
    opciones('inbox-days').every((v) => String(parseInt(v, 10)) === v),
    `opciones = ${JSON.stringify(opciones('inbox-days'))}`)

  // Permiso y servicio de tareas son dos ejes. Mientras el permiso dijo "abre tarjeta",
  // el panel prometia a la vez que no abria ninguna (proveedor ninguno) y que abria una.
  // Se miran los botones y la frase que explica cada modo.
  const S0 = doc.defaultView.STRINGS
  const permisos = Object.values(textosSeg(doc, 'mode'))
    .concat(['es', 'en', 'pt'].flatMap((l) => ['off', 'observe', 'draft', 'reply']
      .map((k) => S0[l][k])))
  ok('ningun permiso habla de tarjetas',
    permisos.every((txt) => !/tarjeta|cartao|card/i.test(txt)),
    `permisos = ${JSON.stringify(permisos)}`)
  // Los modos tienen nombre de dueno (T13): el valor guardado no cambia, el rotulo si.
  ok('los valores guardados de los modos no cambian',
    JSON.stringify(opciones('mode')) ===
    JSON.stringify(['off', 'observar', 'borrador', 'responder']))
  const esMod = await montar('config.html', {}, 'es-419')
  await espera()
  const modo = (valor) => textosSeg(esMod.doc, 'mode')[valor] || ''
  ok('off se llama Apagado', /^Apagado/.test(modo('off')), modo('off'))
  ok('observar se llama Solo leer', /^Solo leer/.test(modo('observar')), modo('observar'))
  ok('borrador se llama Le pregunto antes', /^Le pregunto antes/.test(modo('borrador')),
    modo('borrador'))
  ok('responder se llama Automatico', /^Automatico/.test(modo('responder')),
    modo('responder'))

  // Mapear conversacion. Se elige de la lista, que es el unico camino real: el
  // registro se guarda por jid, no por el nombre visible.
  storage.chats = [
    { jid: '1@g.us', name: 'Soporte Norte', kind: 'grupo' },
    { jid: '2@g.us', name: 'Operaciones', kind: 'grupo' },
    { jid: '57300@s.whatsapp.net', name: 'Laura Mendez', kind: 'directo' }
  ]
  doc.defaultView.dispatchEvent(new doc.defaultView.Event('focus'))
  await espera()
  elegirChat(doc, '1@g.us')
  await espera()
  ok('elegir de la lista llena el nombre de la conversacion',
    doc.getElementById('chat').value === 'Soporte Norte',
    `chat = ${JSON.stringify(doc.getElementById('chat').value)}`)
  // El dueno ya no elige servicio de tareas ni destino: elige el PROYECTO, de los que
  // acepto arriba. Los dos campos viejos salieron del panel (T13).
  ok('el servicio de tareas y el destino ya no estan en el formulario',
    !doc.getElementById('provider') && !doc.getElementById('target') &&
    !doc.getElementById('target-hint'))
  const proyecto = doc.getElementById('workspace')
  ok('una conversacion nueva arranca sin proyecto, y el campo lo dice',
    proyecto.value === '' &&
    /^(Sin proyecto|No project)$/.test(doc.getElementById('workspace-search').value),
    `workspace = ${JSON.stringify(proyecto.value)}`)
  escribir(doc, 'workspace-search', '')
  const ofrecidos = opcionesCombo(doc, 'workspace-list').map((o) => o.dataset.value)
  ok('el selector de proyecto ofrece Sin proyecto y los aceptados',
    JSON.stringify(ofrecidos) === JSON.stringify(['', 'alfa-demo', 'beta-demo']),
    JSON.stringify(ofrecidos))
  ok('y los nombra por su nombre, no por su id',
    opcionesCombo(doc, 'workspace-list').some((o) => o.textContent.includes('Alfa Demo')))
  elegirProyecto(doc, 'workspace', 'alfa-demo')
  elegirSeg(doc, 'mode', 'borrador')
  doc.getElementById('chat-instructions').value = 'Resuma lo que manden y aviseme.'
  doc.getElementById('save-scope').click()
  await espera()
  const entrada = (storage.scope || {})['1@g.us']
  // Por jid y no por nombre: es la llave que lee `wa-scope`, y hay grupos homonimos.
  ok('guarda la conversacion con el jid como llave', !!entrada,
    `storage.scope = ${JSON.stringify(storage.scope)}`)
  ok('guarda el nombre visible junto al jid', entrada && entrada.chatName === 'Soporte Norte')
  ok('guarda el proyecto y el permiso',
    entrada && entrada.workspace === 'alfa-demo' && entrada.mode === 'borrador',
    JSON.stringify(entrada))
  // Una conversacion nueva no abre tarjetas: es lo que el dueno espera sin Plane. Las
  // columnas viejas quedan, sin uso.
  ok('una conversacion nueva queda sin servicio de tareas ni destino',
    entrada && entrada.provider === 'ninguno' && entrada.target === null,
    JSON.stringify(entrada))
  // Las instrucciones son el QUE hace en esa conversacion. Si no se guardan con ella,
  // el campo esta de adorno y el agente nunca las lee.
  ok('guarda las instrucciones de la conversacion',
    entrada && entrada.instructions === 'Resuma lo que manden y aviseme.',
    `instructions = ${JSON.stringify(entrada && entrada.instructions)}`)
  ok('confirma y limpia el formulario',
    doc.getElementById('said-scope').textContent.includes('Soporte Norte') &&
    doc.getElementById('chat').value === '' &&
    doc.getElementById('chat-instructions').value === '')
  ok('la tabla muestra lo guardado, con el nombre del proyecto y el modo del dueno',
    doc.getElementById('scope-wrap').textContent.includes('Soporte Norte') &&
    doc.getElementById('scope-wrap').textContent.includes('Alfa Demo') &&
    /Le pregunto antes|Ask me first/.test(doc.getElementById('scope-wrap').textContent),
    doc.getElementById('scope-wrap').textContent)

  // Buscador de conversaciones. Con 200 conversaciones una lista sin filtro no se
  // navega, asi que el filtro es parte de que el control sirva, no un adorno.
  {
    escribir(doc, 'chat-search', 'laura')
    await espera()
    const opciones = opcionesCombo(doc, 'chat-list').map((o) => o.textContent)
    ok('el buscador filtra la lista',
      opciones.some((t) => t.includes('Laura')) && !opciones.some((t) => t.includes('Operaciones')),
      `opciones = ${JSON.stringify(opciones)}`)
    ok('dice cuantas quedaron', /\d+\s+(de|of)\s+\d+/.test(doc.getElementById('chat-count').textContent),
      `chat-count = ${JSON.stringify(doc.getElementById('chat-count').textContent)}`)
    escribir(doc, 'chat-search', 'zzzz')
    await espera()
    ok('avisa cuando nada coincide',
      opcionesCombo(doc, 'chat-list').length === 0 &&
      doc.getElementById('chat-list').textContent.length > 0)
    escribir(doc, 'chat-search', '')
    await espera()
    ok('al limpiar el buscador vuelven todas',
      opcionesCombo(doc, 'chat-list').length > 1)
  }

  // ───── el panel nunca se queda diciendo que busca ─────
  // El defecto que costo la instalacion del segundo usuario: el sync del worker fallaba
  // callado y el panel decia "Buscando tus conversaciones…" para siempre. Nadie puede
  // arreglar lo que el panel no cuenta, y un panel sin salida es un panel roto.
  const textosEstado = []

  const buscando = await montar('config.html', {
    syncStatus: { running: true, startedAt: new Date().toISOString(), trigger: 'activate' }
  })
  await espera()
  ok('mientras busca de verdad, lo dice y no ofrece nada que apretar',
    /Buscando|Looking|Procurando/.test(buscando.doc.getElementById('chat-count').textContent) &&
    buscando.doc.getElementById('sync-state').hidden,
    `chat-count = ${JSON.stringify(buscando.doc.getElementById('chat-count').textContent)}`)

  const fallo = await montar('config.html', {
    chats: [],
    syncStatus: {
      ok: false, at: new Date().toISOString(), chats: 0, reason: 'sin-herramientas',
      detail: "spawn /Applications/Orca.app/bin/wa-scope ENOENT", exitCode: null,
      trigger: 'activate'
    }
  })
  await espera()
  textosEstado.push(fallo.doc.getElementById('sync-msg').textContent)
  ok('cuando el sync fallo, el panel deja de decir que busca',
    !fallo.doc.getElementById('sync-state').hidden &&
    !/Buscando|Looking|Procurando/.test(fallo.doc.getElementById('sync-msg').textContent),
    `sync-msg = ${JSON.stringify(fallo.doc.getElementById('sync-msg').textContent)}`)
  // "No pude leer WhatsApp" sin la causa es el mismo callejon que el spinner.
  ok('dice la causa en palabras', fallo.doc.getElementById('sync-msg').textContent.length > 20)
  ok('y muestra el error de abajo, que es lo unico accionable para soporte',
    !fallo.doc.getElementById('sync-detail').hidden &&
    fallo.doc.getElementById('sync-detail').textContent.includes('ENOENT'))
  ok('ofrece volver a intentar', !fallo.doc.getElementById('sync-retry').hidden)

  // El panel no puede ejecutar nada: el boton escribe el pedido y el worker lo atiende.
  fallo.doc.getElementById('sync-retry').click()
  await espera()
  ok('el boton escribe el pedido de sync en storage',
    !!(fallo.storage.syncRequest && typeof fallo.storage.syncRequest.at === 'string' &&
       !Number.isNaN(Date.parse(fallo.storage.syncRequest.at))),
    `storage.syncRequest = ${JSON.stringify(fallo.storage.syncRequest)}`)
  ok('y avisa que lo pidio', fallo.doc.getElementById('said-sync').textContent.length > 0)

  // Un intento que arranco hace diez minutos ya no esta corriendo: seguir diciendo
  // "buscando" seria mentir, y sin boton no habria nada que hacer.
  const colgado = await montar('config.html', {
    chats: [],
    syncStatus: {
      running: true, trigger: 'activate',
      startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
    }
  })
  await espera()
  textosEstado.push(colgado.doc.getElementById('sync-msg').textContent)
  ok('un intento que lleva demasiado deja de llamarse busqueda',
    !colgado.doc.getElementById('sync-state').hidden &&
    !colgado.doc.getElementById('sync-retry').hidden &&
    colgado.doc.getElementById('sync-msg').textContent.length > 10,
    `sync-msg = ${JSON.stringify(colgado.doc.getElementById('sync-msg').textContent)}`)

  // Sin una sola noticia del worker tampoco se puede decir "buscando" para siempre:
  // el plugin puede estar apagado. Se adelanta el reloj para recorrer esa rama.
  const callado = await montar('config.html', {})
  await espera()
  ok('recien abierto y sin noticias, la espera es legitima',
    callado.doc.getElementById('sync-state').hidden)
  const ahora = callado.window.Date.now()
  callado.window.Date.now = () => ahora + 60000
  callado.window.dispatchEvent(new callado.window.Event('focus'))
  await espera()
  textosEstado.push(callado.doc.getElementById('sync-msg').textContent)
  ok('pasado un rato sin noticias del worker, ofrece el boton igual',
    !callado.doc.getElementById('sync-state').hidden &&
    !callado.doc.getElementById('sync-retry').hidden,
    `sync-state = ${JSON.stringify(callado.doc.getElementById('sync-state').textContent)}`)

  // El sync corrio bien y aun asi no hay nada: el problema no es el plugin, y decir
  // "no pude leer WhatsApp" seria falso.
  const sinNada = await montar('config.html', {
    chats: [],
    syncStatus: { ok: true, at: new Date().toISOString(), chats: 0, reason: null,
      detail: '', exitCode: null, trigger: 'timer' }
  })
  await espera()
  textosEstado.push(sinNada.doc.getElementById('sync-msg').textContent)
  ok('un sync bueno sin conversaciones no se cuenta como error',
    !sinNada.doc.getElementById('sync-state').hidden &&
    !sinNada.doc.getElementById('sync-retry').hidden &&
    // Ya no manda a abrir la app de escritorio, que no existe en este plugin: manda
    // a lo unico que el usuario puede hacer, que es enlazar su linea.
    /Link your WhatsApp line|Enlace su linea/.test(
      sinNada.doc.getElementById('sync-msg').textContent),
    `sync-msg = ${JSON.stringify(sinNada.doc.getElementById('sync-msg').textContent)}`)

  // La razon de todo esto: si el panel manda a correr un comando, la funcion no existe.
  // Se revisa lo que el panel redacta; el detalle de abajo es la salida cruda de la
  // herramienta, que es evidencia, no una instruccion.
  ok('ningun estado manda a correr un comando',
    textosEstado.every((txt) => !/wa-scope|wa-read|npm |sudo|terminal|--json|\$ /i.test(txt)),
    JSON.stringify(textosEstado))

  // La lista tiene que llegar aunque el cursor este en el buscador — que es justo donde
  // esta el cursor de quien mira "Buscando…" e intenta encontrar su conversacion. Una
  // guardia de foco la dejaba vacia hasta salir y volver a la pagina.
  const conFoco = await montar('config.html', {})
  await espera()
  conFoco.doc.getElementById('chat-search').focus()
  conFoco.storage.chats = [
    { jid: '9@g.us', name: 'Laura Mendez', kind: 'directo' },
    { jid: '8@g.us', name: 'Operaciones', kind: 'grupo' }
  ]
  conFoco.window.dispatchEvent(new conFoco.window.Event('focus'))
  await espera()
  ok('la lista se llena con el cursor puesto en el buscador',
    listaChats(conFoco.doc).some((txt) => txt.includes('Laura')),
    `chat-list = ${JSON.stringify(listaChats(conFoco.doc))}`)

  // Y lo que el usuario ya habia tecleado no se pierde en la recarga.
  escribir(conFoco.doc, 'chat-search', 'laura')
  await espera()
  conFoco.window.dispatchEvent(new conFoco.window.Event('focus'))
  await espera()
  const trasRecarga = opcionesCombo(conFoco.doc, 'chat-list').map((o) => o.textContent)
  ok('el texto del buscador sobrevive a la recarga',
    conFoco.doc.getElementById('chat-search').value === 'laura')
  ok('y sigue filtrando despues de recargar',
    trasRecarga.some((txt) => txt.includes('Laura')) &&
    !trasRecarga.some((txt) => txt.includes('Operaciones')),
    JSON.stringify(trasRecarga))

  // Editar
  doc.querySelector('[data-edit]').click()
  await espera()
  ok('Editar carga la fila en el formulario', doc.getElementById('chat').value === 'Soporte Norte')
  ok('Editar recarga las instrucciones',
    doc.getElementById('chat-instructions').value === 'Resuma lo que manden y aviseme.',
    `chat-instructions = ${JSON.stringify(doc.getElementById('chat-instructions').value)}`)
  ok('Editar carga el proyecto de la conversacion',
    doc.getElementById('workspace').value === 'alfa-demo',
    `workspace = ${doc.getElementById('workspace').value}`)
  // El input #chat esta oculto: comprobarlo solo dejaba pasar el caso real, en el que
  // el campo visible se quedaba vacio.
  ok('Editar deja el campo visible en esa conversacion, sin poder cambiarla',
    doc.getElementById('chat-search').value === 'Soporte Norte' &&
    doc.getElementById('chat-search').readOnly,
    `chat-search = ${JSON.stringify(doc.getElementById('chat-search').value)}`)
  ok('Editar carga el modo de la conversacion', valorSeg(doc, 'mode') === 'borrador')
  ok('Editar cambia el boton a guardar cambios',
    doc.getElementById('save-scope').textContent.toLowerCase().includes('cambio') ||
    doc.getElementById('save-scope').textContent.toLowerCase().includes('change'))
  doc.getElementById('cancel-edit').click()
  await espera()
  ok('Cancelar edicion limpia',
    doc.getElementById('chat').value === '' &&
    doc.getElementById('chat-search').value === '' &&
    !doc.getElementById('chat-search').readOnly &&
    doc.getElementById('chat-instructions').value === '' &&
    doc.getElementById('workspace').value === '' && valorSeg(doc, 'mode') === 'off')

  // Reglas de ruteo: el texto manda el caso a un PROYECTO, no a un destino que se escribe.
  ok('la regla ya no pide servicio de tareas ni destino',
    !doc.getElementById('r-provider') && !doc.getElementById('r-target'))
  doc.getElementById('r-match').value = 'ACME'
  elegirProyecto(doc, 'r-workspace', 'beta-demo')
  doc.getElementById('save-route').click()
  await espera()
  ok('guarda una regla de ruteo con su proyecto',
    (storage.routes || []).some((r) => r.pattern === 'acme' && r.workspace === 'beta-demo'),
    `storage.routes = ${JSON.stringify(storage.routes)}`)
  ok('normaliza el patron a minusculas',
    (storage.routes || []).every((r) => r.pattern === r.pattern.toLowerCase()))
  ok('la regla aparece en la tabla con el nombre del proyecto',
    doc.getElementById('routes-wrap').textContent.includes('Beta Demo'),
    doc.getElementById('routes-wrap').textContent)

  // Quitar
  doc.querySelector('[data-rrm]').click()
  await espera()
  // Como la autorizacion, la regla vive en `scope.db` Y en el storage del panel: quitarla
  // es cosa del worker (`wa-scope route --remove`), el panel solo lo pide. Lo que se
  // confirma y lo que falla tiene su propia rebanada mas abajo.
  ok('Quitar manda el pedido de la regla al worker, con su patron',
    !!storage.scopeRequest && storage.scopeRequest.action === 'regla-quitar' &&
    storage.scopeRequest.pattern === 'acme', JSON.stringify(storage.scopeRequest))
  ok('y no reescribe sus reglas por su cuenta',
    (storage.routes || []).some((r) => r.pattern === 'acme'), JSON.stringify(storage.routes))
  // Quitar una conversacion ya NO lo hace el panel: el registro vive tambien en
  // `scope.db` y borrar solo del storage descubre la fila del CLI que sigue abajo — la
  // autorizacion seguia en pie mientras el panel decia que la habia quitado. Lo que se
  // comprueba aca es que el clic salga por el canal del worker; el resto —el veredicto
  // que confirma y el que falla— tiene su propia rebanada mas abajo.
  doc.querySelector('[data-rm]').click()
  await espera()
  ok('Quitar manda el pedido al worker en vez de borrar de su propio storage',
    !!storage.scopeRequest && storage.scopeRequest.action === 'quitar' &&
    storage.scopeRequest.jid === '1@g.us', JSON.stringify(storage.scopeRequest))
  ok('y no toca el alcance por su cuenta: eso lo hace `wa-scope rm`, en los dos lados',
    !!(storage.scope || {})['1@g.us'], JSON.stringify(storage.scope))

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
  ok('carga la calidad guardada', valorSeg(calidad.doc, 'quality') === 'minima',
    `quality = ${valorSeg(calidad.doc, 'quality')}`)
  const sinCalidad = await montar('config.html', {})
  await espera()
  ok('sin nada guardado la calidad queda en optima',
    valorSeg(sinCalidad.doc, 'quality') === 'optima')

  // Guardar sin recargar es media funcion: el panel abre mintiendo sobre lo que rige.
  const guardado = await montar('config.html', {
    inboxDays: '90', ownerName: 'Persona De Ejemplo', transcribe: 'off', transcribeLang: 'pt'
  })
  await espera()
  ok('recarga la ventana guardada',
    valorSeg(guardado.doc, 'inbox-days') === '90',
    `inbox-days = ${valorSeg(guardado.doc, 'inbox-days')}`)
  ok('recarga para quien trabaja',
    guardado.doc.getElementById('owner').value === 'Persona De Ejemplo',
    `owner = ${JSON.stringify(guardado.doc.getElementById('owner').value)}`)
  ok('recarga el modo de transcripcion',
    valorSeg(guardado.doc, 'transcribe') === 'off',
    `transcribe = ${valorSeg(guardado.doc, 'transcribe')}`)
  ok('recarga el idioma de los audios',
    valorSeg(guardado.doc, 'lang') === 'pt',
    `lang = ${valorSeg(guardado.doc, 'lang')}`)

  const guardadoSync = await montar('config.html', { syncMinutes: '30' })
  await espera()
  ok('recarga la frecuencia guardada',
    valorSeg(guardadoSync.doc, 'sync-minutes') === '30',
    `sync-minutes = ${valorSeg(guardadoSync.doc, 'sync-minutes')}`)

  const porDefecto = await montar('config.html', {})
  await espera()
  // 7 y no 1: una mencion del viernes tiene que seguir a la vista el lunes.
  ok('sin nada guardado la ventana queda en 7 dias',
    valorSeg(porDefecto.doc, 'inbox-days') === '7',
    `inbox-days = ${valorSeg(porDefecto.doc, 'inbox-days')}`)
  ok('sin nada guardado transcribe en local',
    valorSeg(porDefecto.doc, 'transcribe') === 'local')
  ok('sin nada guardado el idioma se detecta',
    valorSeg(porDefecto.doc, 'lang') === 'auto')
  ok('sin nada guardado el dueno queda vacio',
    porDefecto.doc.getElementById('owner').value === '')
  // 5 y no 1: un minuto convertiria el sync en el problema que vino a arreglar.
  ok('sin nada guardado revisa WhatsApp cada 5 minutos',
    valorSeg(porDefecto.doc, 'sync-minutes') === '5',
    `sync-minutes = ${valorSeg(porDefecto.doc, 'sync-minutes')}`)

  // ritmo-triage: el selector tambien fija el cron de `WhatsApp: triage`, y el panel dice
  // a que ritmo corre de verdad en Orca (lo escribe el worker en su latido).
  const latidoCon = (extra) => ({ at: new Date().toISOString(), triage: Object.assign(
    { minutes: 2, cron: '*/2 * * * *', ok: true, code: 'ajustado' }, extra) })
  const lineaRitmo = (doc) => doc.getElementById('triage-pace')
  {
    const sinDato = await montar('config.html', { syncMinutes: '5' }, 'es-419')
    await espera()
    ok('ritmo: sin lo que dijo el worker no se afirma nada', lineaRitmo(sinDato.doc).hidden === true,
      lineaRitmo(sinDato.doc).outerHTML)
    ok('ritmo: la ayuda dice que el selector tambien marca el triage',
      /WhatsApp: triage/.test(sinDato.doc.body.textContent))
    const alDia = await montar('config.html', { syncMinutes: '2', workerBeat: latidoCon() }, 'es-419')
    await espera()
    ok('ritmo: dice cada cuanto corre el triage en Orca',
      !lineaRitmo(alDia.doc).hidden && /WhatsApp: triage/.test(lineaRitmo(alDia.doc).textContent) &&
      /cada 2 min/.test(lineaRitmo(alDia.doc).textContent) &&
      !lineaRitmo(alDia.doc).classList.contains('mal'), lineaRitmo(alDia.doc).textContent)
    const hora = await montar('config.html', { syncMinutes: '60',
      workerBeat: latidoCon({ minutes: 60, cron: '0 * * * *' }) }, 'es-419')
    await espera()
    ok('ritmo: una hora se dice como en el selector', /cada 1 hora/.test(lineaRitmo(hora.doc).textContent),
      lineaRitmo(hora.doc).textContent)
    const ajustando = await montar('config.html', { syncMinutes: '10', workerBeat: latidoCon() }, 'es-419')
    await espera()
    ok('ritmo: guardado otro valor, dice que lo esta ajustando',
      /Ajustando/.test(lineaRitmo(ajustando.doc).textContent) &&
      !/cada 2 min/.test(lineaRitmo(ajustando.doc).textContent), lineaRitmo(ajustando.doc).textContent)
    const fallo = await montar('config.html', { syncMinutes: '2',
      workerBeat: latidoCon({ ok: false, code: 'ajustar-fallo' }) }, 'es-419')
    await espera()
    ok('ritmo: si Orca no lo cambio, lo dice en rojo y que se reintenta',
      lineaRitmo(fallo.doc).classList.contains('mal') &&
      /No se pudo/.test(lineaRitmo(fallo.doc).textContent) &&
      /reintenta/.test(lineaRitmo(fallo.doc).textContent), lineaRitmo(fallo.doc).textContent)
    const sinTriage = await montar('config.html', { syncMinutes: '2',
      workerBeat: latidoCon({ ok: false, code: 'sin-triage', id: null }) }, 'es-419')
    await espera()
    ok('ritmo: sin la automatizacion en Orca, dice que la falta',
      lineaRitmo(sinTriage.doc).classList.contains('mal') &&
      /No encuentro/.test(lineaRitmo(sinTriage.doc).textContent), lineaRitmo(sinTriage.doc).textContent)
    const en = await montar('config.html', { syncMinutes: '2', workerBeat: latidoCon() }, 'en-US')
    await espera()
    ok('ritmo: en ingles', /runs every 2 min/.test(lineaRitmo(en.doc).textContent),
      lineaRitmo(en.doc).textContent)
    const pt = await montar('config.html', { syncMinutes: '2', workerBeat: latidoCon() }, 'pt-BR')
    await espera()
    ok('ritmo: en portugues', /a cada 2 min/.test(lineaRitmo(pt.doc).textContent),
      lineaRitmo(pt.doc).textContent)
  }

  // La terminal puede fijar un valor que el select no ofrece (`config inbox_days 45`).
  // Si el select lo ignora queda en blanco y el panel miente sobre lo que rige: peor
  // que mostrar un valor raro es mostrar ninguno.
  const aMano = await montar('config.html', { inboxDays: '45' })
  await espera()
  ok('un valor puesto por terminal se ve en vez de dejar el select en blanco',
    valorSeg(aMano.doc, 'inbox-days') === '45',
    `inbox-days = ${JSON.stringify(valorSeg(aMano.doc, 'inbox-days'))}`)
}

// ───────────────────────── activity.html ─────────────────────────
// ───────── config.html: conectar una linea de WhatsApp Web ─────────
// Enlazar una linea eran cuatro comandos de terminal, asi que la funcion existia y no
// la usaba nadie. Lo que se comprueba aca es lo unico que la vuelve un producto: que el
// boton deje el pedido, que cada estado diga que hacer, y que ninguno se quede sin un
// boton que lo resuelva — un estado sin salida es el mismo callejon que el spinner.
console.log('\nconfig.html — las traducciones estan completas')
{
  // Cada texto nuevo en los tres idiomas, comprobado por clave y no de memoria: una
  // traduccion que falta cae al ingles y media pantalla queda en el idioma equivocado.
  const { window } = await montar('config.html')
  const S = window.STRINGS
  const faltan = Object.keys(S.es).filter((k) => !(k in S.en))
  ok('cada texto del panel existe en espanol y en ingles', faltan.length === 0,
    `sin traducir = ${JSON.stringify(faltan.slice(0, 8))}`)
  // Lo que esta rebanada dejo en pantalla: la vinculacion por QR y el unico requisito
  // que hoy bloquea. Se nombran por clave y no de memoria.
  const nuevas = ['pairingLegend', 'pairingWaiting', 'pairingLive', 'pairingConnected',
    'pairingDown', 'pairingExpired', 'hNoTransport', 'hNoTransportHow', 'hNoTools']
  // pt hereda el ingles para lo que no traduce, asi que "existe" no alcanza: tiene que
  // ser un texto PROPIO, o el portugues de esta seccion seria ingles.
  const sinPt = nuevas.filter((k) => !S.pt[k] || S.pt[k] === S.en[k])
  ok('y lo que esta rebanada dejo en pantalla esta traducido tambien al portugues',
    sinPt.length === 0,
    `sin portugues = ${JSON.stringify(sinPt)}`)

  // Los textos de `data-t` se pintan con `t()` tal cual: ya no queda ninguno con
  // huecos, y el que trajera uno lo mostraria LITERAL, con las llaves en pantalla.
  // Cuando pasaban por fmt() el hueco sin valor se borraba y el texto salia mutilado
  // en silencio; ahora se ve, pero verlo no es suficiente si nadie mira ese estado.
  const marcados = new Set()
  const html = readFileSync(join(root, 'config.html'), 'utf8')
  for (const m of html.matchAll(/data-t(?:-ph|-title)?="([^"]+)"/g)) marcados.add(m[1])
  const rotos = []
  for (const idioma of ['es', 'en', 'pt']) {
    for (const k of marcados) {
      const texto = String(S[idioma] && S[idioma][k] || '')
      for (const h of texto.match(/\{(\w+)\}/g) || []) rotos.push(`${idioma}.${k} ${h}`)
    }
  }
  ok('ningun texto de data-t trae un hueco: se pintaria con las llaves puestas',
    rotos.length === 0,
    JSON.stringify(rotos))
}

console.log('\nactivity.html')
{
  const actividad = {
    syncedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
    running: false, mapped: 1, authorized: 1,
    pending: [{ stanzaId: 'S1', date: '2026-09-17 12:06', chat: 'Soporte Acme', sender: 'Ana',
      kind: 'mencion', text: 'necesito el reporte', hasMedia: true }],
    recent: [{ ts: '2026-09-17 11:30', chat: 'Soporte Acme', action: 'issue',
      issue: 'ACM-1', detail: 'reporte mensual' }]
  }
  const { doc, enviados } = await montar('activity.html', { activity: actividad })
  ok('los textos se tradujeron', doc.querySelector('h1').textContent.length > 0)
  ok('muestra el sello de sincronizacion', doc.getElementById('synced').textContent.length > 0)
  // La bandeja se fue (el dueno la pidio fuera): lo que pedia decision esta en la columna
  // "Su decision", lo que hizo el agente en la historia de cada caso, y la cola son los
  // casos en Recibido y Clasificado, con "Atender ahora" e "Ignorar".
  // Las pestanas que hay son Tablero e Informes (informes-tablero, I5); la bandeja no vuelve.
  ok('la bandeja no vuelve: las unicas pestanas son Tablero e Informes',
    [...doc.querySelectorAll('[role="tablist"] [role="tab"]')].map((b) => b.id).join() === 'tab-board,tab-reports' &&
    !doc.getElementById('tab-inbox') && !doc.getElementById('view-inbox'))
  ok('ni las tres secciones de la bandeja', !doc.getElementById('alerts') &&
    !doc.getElementById('recent') && !doc.getElementById('pending'))
  ok('ni Tomar ni Ignorar sobre mensajes sueltos',
    !doc.querySelector('[data-take], [data-ignore]') && !doc.body.textContent.includes('necesito el reporte'))
  doc.getElementById('refresh').click()
  await espera()
  ok('el boton de releer no rompe nada', !doc.getElementById('view-board').hidden)
  ok('el panel no lee ni escribe la vieja clave `decisions`',
    !enviados.some((e) => e.params && e.params.key === 'decisions'),
    JSON.stringify(enviados.map((e) => e.params && e.params.key)))
  const sinDatos = await montar('activity.html', {})
  await espera()
  ok('avisa cuando nunca se sincronizo',
    sinDatos.doc.getElementById('synced').textContent.length > 0)
}

console.log('\nactivity.html — la corrida dice como le fue')
{
  const AHORA = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const base = { syncedAt: AHORA, running: false, pending: [], recent: [],
    mapped: 3, authorized: 3 }
  const linea = (d) => d.getElementById('runline').textContent.trim()

  // 1. Sano: reviso, no habia nada. Es el caso comun y hoy no se distingue de un fallo.
  const sano = await montar('activity.html', {
    activity: { ...base, run: { state: 'ok', startedAt: AHORA, endedAt: AHORA,
      looked: 3, pending: 0, reason: null } }
  }, 'es-419')
  await espera()
  ok('lo sano dice la hora de la ultima revision y no inventa pendientes',
    /Ultima revision \d{2}:\d{2}/.test(linea(sano.doc)) &&
    !/esperando|conversaciones/.test(linea(sano.doc)), linea(sano.doc))

  // Y con trabajo, el mismo renglon dice cuanto. El pendiente va tambien en la LISTA:
  // el renglon cuenta lo que se ve abajo, no lo que dejo anotado la corrida — que es
  // justo lo que hacia que la cabecera dijera "nada pendiente" con mensajes listados.
  const conTrabajo = await montar('activity.html', {
    activity: { ...base,
      pending: [
        { stanzaId: 'T1', date: AHORA, chat: 'Uno', chatJid: 'a@g.us',
          sender: 'Ana', kind: 'mencion', text: 'uno' },
        { stanzaId: 'T2', date: AHORA, chat: 'Uno', chatJid: 'a@g.us',
          sender: 'Ana', kind: 'mencion', text: 'dos' }
      ],
      run: { state: 'ok', startedAt: AHORA, endedAt: AHORA,
        looked: 3, pending: 2, reason: null } }
  }, 'es-419')
  await espera()
  ok('la cola vieja de mensajes ya no se cuenta en la linea',
    !/2 esperando/.test(linea(conTrabajo.doc)), linea(conTrabajo.doc))

  // 2. Nunca corrio: el precheck salio 127, la automation no tiene proyecto, o esta
  //    pausada. Nada de eso llega hasta aca; lo unico que se sabe es que no hubo corrida.
  const nunca = await montar('activity.html', {
    activity: { ...base, run: { state: 'never', startedAt: null, endedAt: null,
      looked: null, pending: null, reason: null } }
  }, 'es-419')
  await espera()
  ok('dice que todavia no reviso, y no finge que reviso',
    /todavia no ha revisado/i.test(linea(nunca.doc)) &&
    !/nada pendiente/.test(linea(nunca.doc)), linea(nunca.doc))

  // 3a. Arranco y se murio sin cerrar: el lock vencio y nadie llamo a unlock.
  const cortada = await montar('activity.html', {
    activity: { ...base, run: { state: 'interrupted', startedAt: '2026-09-17 09:12',
      endedAt: null, looked: null, pending: null, reason: null } }
  }, 'es-419')
  await espera()
  ok('dice que la corrida arranco y no volvio, con la hora en que arranco',
    /no volvio/i.test(linea(cortada.doc)) && linea(cortada.doc).includes('2026-09-17 09:12'),
    linea(cortada.doc))

  // 3b. Murio con motivo. El motivo es el unico dato que dice que paso de verdad, y va
  //     tal cual: lo escribio quien fallo, traducirlo seria inventarlo.
  const fallo = await montar('activity.html', {
    activity: { ...base, run: { state: 'failed', startedAt: AHORA, endedAt: AHORA,
      looked: 3, pending: 0,
      reason: 'This Claude account is in use by an assigned worktree' } }
  }, 'es-419')
  await espera()
  ok('dice que fallo y por que, con el motivo sin tocar',
    /fallo/i.test(linea(fallo.doc)) &&
    linea(fallo.doc).includes('This Claude account is in use by an assigned worktree'),
    linea(fallo.doc))
  ok('y el fallo se pinta como fallo, no como una linea mas',
    fallo.doc.getElementById('runline').className.includes('stale'),
    fallo.doc.getElementById('runline').className)

  // 4. Nada autorizado: conversaciones mapeadas y todas en off. Es configuracion, no
  //    ausencia de trabajo, y era invisible.
  const todoOff = await montar('activity.html', {
    activity: { ...base, mapped: 3, authorized: 0,
      run: { state: 'ok', startedAt: AHORA, endedAt: AHORA, looked: 0, pending: 0,
        reason: null } }
  }, 'es-419')
  await espera()
  ok('con todo en off el tablero vacio lo dice',
    /3 conversaciones/.test(todoOff.doc.getElementById('board-empty').textContent) &&
    /off/.test(todoOff.doc.getElementById('board-empty').textContent),
    todoOff.doc.getElementById('board-empty').textContent.trim())

  // Y ninguna registrada tampoco es lo mismo que "nada pendiente".
  const sinRegistro = await montar('activity.html', {
    activity: { ...base, mapped: 0, authorized: 0,
      run: { state: 'never', startedAt: null, endedAt: null, looked: null,
        pending: null, reason: null } }
  }, 'es-419')
  await espera()
  ok('sin ninguna conversacion registrada lo dice distinto',
    /no ha autorizado/i.test(sinRegistro.doc.getElementById('board-empty').textContent),
    sinRegistro.doc.getElementById('board-empty').textContent.trim())

  // 5. Corriendo ahora.
  const corriendo = await montar('activity.html', {
    activity: { ...base, running: true,
      run: { state: 'running', startedAt: AHORA, endedAt: null, looked: null,
        pending: null, reason: null } }
  }, 'es-419')
  await espera()
  ok('mientras corre lo dice, en vez de la foto anterior',
    /revisando/i.test(linea(corriendo.doc)), linea(corriendo.doc))

  // Un storage escrito por un CLI viejo no trae `run`. Afirmar "nunca reviso" seria
  // decir algo que ese CLI no cuenta: el renglon se calla.
  const viejo = await montar('activity.html', {
    activity: { syncedAt: AHORA, running: false, pending: [], recent: [] }
  }, 'es-419')
  await espera()
  ok('sin el dato el renglon se calla en vez de inventar un estado',
    linea(viejo.doc) === '', linea(viejo.doc))

  // Los tres idiomas, porque media traduccion no se ve hasta que la ve el usuario.
  for (const [locale, esperado] of [['en-US', /Last run \d{2}:\d{2}/],
    ['pt-BR', /Ultima revisao \d{2}:\d{2}/]]) {
    const m = await montar('activity.html', {
      activity: { ...base, run: { state: 'ok', startedAt: AHORA, endedAt: AHORA,
        looked: 3, pending: 0, reason: null } }
    }, locale)
    await espera()
    ok(`el renglon de la corrida esta traducido en ${locale}`,
      esperado.test(linea(m.doc)), linea(m.doc))
  }
  const offEn = await montar('activity.html', {
    activity: { ...base, authorized: 0, run: { state: 'ok', startedAt: AHORA,
      endedAt: AHORA, looked: 0, pending: 0, reason: null } }
  }, 'en-US')
  await espera()
  ok('y el aviso de todo en off tambien',
    /all of them are off/i.test(offEn.doc.getElementById('board-empty').textContent),
    offEn.doc.getElementById('board-empty').textContent.trim())
}

// ───────── el idioma: lo que el CLI manda en codigo, el panel lo dice ─────────
// El CLI habla ingles porque lo lee quien corre una terminal. El panel lo lee quien
// usa Orca, en su idioma. Lo unico que une los dos es un codigo estable, asi que se
// comprueba que el panel lo traduzca de verdad y que no se cuele ni una palabra en
// ingles en un panel en espanol.
console.log('\nel codigo del CLI, dicho en el idioma del panel')
{
  const salud = {
    ok: false,
    problem: 'a message transport',
    problemCode: 'no-transport',
    detail: 'no-transport: there is no message transport yet. The two old read routes ' +
      'were removed and the sidecar that replaces them pairs the line but does not ' +
      'read messages yet.',
    optional: [{
      que: 'audio transcription', code: 'transcribe',
      como: 'no engine: download the model in Settings > Voice, or install a local one ' +
        'with brew install whisper-cpp',
      howCode: 'transcribe-no-engine'
    }]
  }

  const es = await montar('config.html', { health: salud }, 'es-419')
  await espera()
  const alertaEs = es.doc.getElementById('alert').textContent
  const opcionalEs = es.doc.getElementById('opcionales').textContent
  ok('el problema de salud se dice en espanol, no como lo escribio el CLI',
    alertaEs.includes('Enlace su linea de WhatsApp'), alertaEs)
  ok('el requisito opcional tambien',
    opcionalEs.includes('Transcripcion de audio') && opcionalEs.includes('Ajustes > Voz'),
    opcionalEs)
  // Lo que motiva todo esto: media traduccion es peor que ninguna, porque no se ve.
  ok('no se cuela el ingles del CLI en el panel en espanol',
    !/\btranscription\b|\bdownload\b|\bmessage transport\b/i.test(alertaEs + ' ' + opcionalEs),
    alertaEs + ' | ' + opcionalEs)
  // Este detalle es una FRASE, no un dato crudo, asi que se traduce por codigo. Es el
  // defecto que se arreglo de paso: el panel pintaba "both routes are off: turn the
  // desktop app or WhatsApp Web back on" en ingles, en un panel en espanol.
  // El texto le habla a quien instala el plugin hoy: no menciona las vias viejas ni
  // nuestro calendario de entregas. Quien lo lee nunca conocio ninguna de las dos, y
  // "llega con la proxima entrega" es informacion nuestra, no suya.
  ok('y el detalle, cuando es una frase, tambien se dice en espanol',
    alertaEs.includes('Escanee el codigo de la pestana Estado') &&
    !/sidecar/i.test(alertaEs), alertaEs)
  ok('el aviso no le cuenta al usuario nuestro historial ni nuestro calendario',
    !/vias viejas|proxima entrega|sidecar/i.test(alertaEs), alertaEs)

  // Y el detalle que SI es dato crudo —una ruta, un tamano, un error de proceso— se
  // sigue mostrando tal cual: traducirlo seria perderlo.
  const crudo = await montar('config.html', {
    health: { ok: false, problem: 'the plugin tools did not answer',
      problemCode: 'sin-herramientas',
      detail: 'ENOENT: /ruta/que/no/existe/wa-read', optional: [] }
  }, 'es-419')
  await espera()
  const alertaCrudo = crudo.doc.getElementById('alert').textContent
  ok('el motivo del worker tambien se dice en espanol',
    alertaCrudo.includes('Las herramientas del plugin no contestaron'), alertaCrudo)
  ok('y su detalle tecnico se muestra tal cual',
    alertaCrudo.includes('/ruta/que/no/existe/wa-read'), alertaCrudo)

  // La linea existe pero no da senal: el doctor ya no la da por buena con una fila en
  // `linea`. Se dice en el idioma del panel, no con la frase en ingles del CLI.
  const muda = await montar('config.html', { health: { ok: false,
    problem: 'a message transport', problemCode: 'transport-silent',
    detail: 'transport-silent: the linked line has given no sign of life since ' +
      '2026-09-30 17:44', optional: [] } }, 'es-419')
  await espera()
  const alertaMuda = muda.doc.getElementById('alert').textContent
  ok('la linea sin senal se dice en espanol', /senal/i.test(alertaMuda) &&
    !/sign of life/i.test(alertaMuda), alertaMuda)

  // T9f: el renglon de la re-clave de `local` al numero de su linea.
  const reclave = await montar('config.html', { health: { ok: true, optional: [{
    que: 'line re-keyed', code: 'store-rekeyed', howCode: 'store-rekeyed-line',
    como: 'on 2026-10-01 10:00 the 305 conversations and 12 messages that were stored ' +
      'before each number became its own line were assigned to +573001112233' }] } },
  'es-419')
  await espera()
  const opcReclave = reclave.doc.getElementById('opcionales').textContent
  ok('la re-clave de la linea se dice en espanol', /numero/i.test(opcReclave) &&
    !/were assigned|re-keyed/.test(opcReclave), opcReclave)

  // T9f: lo de antes que no se pudo atribuir con certeza pide una decision, con el
  // comando exacto, en el idioma del panel.
  const decide = await montar('config.html', { health: { ok: true, optional: [{
    que: 'data from a previous number', code: 'store-rekey-pending',
    howCode: 'store-rekey-decide',
    como: '3 conversations and 12 messages ... run: wa-scope reclave --numero <n>' }] } },
  'es-419')
  await espera()
  const opcDecide = decide.doc.getElementById('opcionales').textContent
  ok('el pedido de decision se dice en espanol, con el comando',
    /numero anterior/i.test(opcDecide) && /wa-scope reclave --numero/.test(opcDecide) &&
    !/cannot be matched/.test(opcDecide), opcDecide)

  const pt = await montar('config.html', { health: salud }, 'pt-BR')
  await espera()
  ok('y en portugues tambien',
    pt.doc.getElementById('alert').textContent.includes('Vincule a sua linha') &&
    pt.doc.getElementById('opcionales').textContent.includes('Transcricao de audio'),
    pt.doc.getElementById('opcionales').textContent)

  const en = await montar('config.html', { health: salud }, 'en-US')
  await espera()
  ok('en ingles dice lo mismo que la terminal',
    en.doc.getElementById('alert').textContent
      .includes('Link your WhatsApp line'),
    en.doc.getElementById('alert').textContent)

  // El tope del almacen mordio. No bloquea —lo que se fue es viejo— pero tiene que
  // VERSE: "un almacen sin tope y sin caducidad es un archivo de conversaciones ajenas
  // que nadie borra", y un desalojo callado es un caso que se pierde y se descubre
  // despues, cuando la fila ya salio sin cuerpo y sin explicacion (§11-F2).
  const podado = {
    ok: true,
    optional: [{
      que: 'message retention', code: 'retention',
      como: '12 message bodies were evicted on 2026-09-22 (1 expired, 11 over the cap)',
      howCode: 'retention-evicted'
    }]
  }
  for (const [idioma, etiqueta, accion] of [
    ['es-419', 'Retencion de mensajes', 'Suba capture_max'],
    ['en-US', 'Message retention', 'Raise capture_max'],
    ['pt-BR', 'Retencao de mensagens', 'Aumente capture_max']
  ]) {
    const v = await montar('config.html', { health: podado }, idioma)
    await espera()
    const texto = v.doc.getElementById('opcionales').textContent
    ok(`el desalojo del almacen se ve, y en ${idioma}`, texto.includes(etiqueta), texto)
    ok(`y dice que hacer para conservar mas (${idioma})`, texto.includes(accion), texto)
  }
  // La subida del almacen que dejo la via de WhatsApp Web. Se lleva la cache de
  // cuerpos de esa via y sus lineas —un esquema que este codigo no sabe leer— y eso
  // tiene que VERSE, por la misma razon que el desalojo: una migracion que borra en
  // silencio la cache de mensajes de clientes reales es peor que una que lo dice.
  const migrado = {
    ok: false, problem: 'a message transport', problemCode: 'no-transport',
    optional: [{
      que: 'message store upgrade', code: 'store-migrated',
      como: 'the message store was upgraded from version 0 to 1: the removed ' +
        'WhatsApp Web route left 12 cached message bodies and 2 of its own lines ' +
        'behind, and they were dropped',
      howCode: 'store-migrated-dropped'
    }]
  }
  for (const [idioma, etiqueta, explicacion] of [
    ['es-419', 'Almacen de mensajes actualizado', 'WhatsApp Web'],
    ['en-US', 'Message store upgraded', 'WhatsApp Web'],
    ['pt-BR', 'Armazem de mensagens atualizado', 'WhatsApp Web']
  ]) {
    const v = await montar('config.html', { health: migrado }, idioma)
    await espera()
    const texto = v.doc.getElementById('opcionales').textContent
    ok(`la migracion del almacen se ve, y en ${idioma}`, texto.includes(etiqueta), texto)
    ok(`y dice de donde venia lo que se borro (${idioma})`, texto.includes(explicacion),
      texto)
  }
  const migradoEs = await montar('config.html', { health: migrado }, 'es-419')
  await espera()
  ok('y no se cuela el ingles del CLI al decirlo',
    !/\bdropped\b|\bmessage bodies\b|\bupgraded\b/.test(
      migradoEs.doc.getElementById('opcionales').textContent),
    migradoEs.doc.getElementById('opcionales').textContent)

  const podadoEs = await montar('config.html', { health: podado }, 'es-419')
  await espera()
  ok('y no se cuela el ingles del CLI al decirlo',
    !/\bevicted\b|\bmessage bodies\b|\bRaise\b/.test(
      podadoEs.doc.getElementById('opcionales').textContent),
    podadoEs.doc.getElementById('opcionales').textContent)

  // Un codigo que este panel no conozca todavia no puede dejar el aviso vacio: se
  // pinta el texto del CLI, que es peor que traducido pero infinitamente mejor que nada.
  const raro = await montar('config.html', {
    health: { ok: false, problem: 'something new broke', problemCode: 'todavia-no-existe',
      optional: [{ que: 'a new thing', como: 'do the new thing', code: 'nuevo' }] }
  }, 'es-419')
  await espera()
  ok('un codigo desconocido cae al texto del CLI y no desaparece',
    raro.doc.getElementById('alert').textContent.includes('something new broke') &&
    raro.doc.getElementById('opcionales').textContent.includes('a new thing'),
    raro.doc.getElementById('alert').textContent)

}

// ───────── el contrato entre el CLI y los paneles ─────────
// Los paneles leen exactamente las claves que escribe `wa-scope sync`. Nada lo
// garantizaba: los tests montaban los paneles contra un storage escrito a mano, que es
// una copia del contrato y no el contrato. Aca se corre el CLI de verdad contra un HOME
// temporal y se montan los paneles contra LO QUE ESCRIBIO, que es lo unico que prueba
// que siguen hablando el mismo idioma — y que una traduccion no renombro una clave.
console.log('\nel contrato CLI -> panel')
{
  const home = mkdtempSync(join(tmpdir(), 'wa-inbox-contrato-'))
  // HOME propio: la base vive en ~/.wa-inbox/scope.db y no hay variable para moverla,
  // asi que mover el HOME es lo que mantiene la base real del usuario fuera de esto.
  const env = { ...process.env, HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    APPDATA: join(home, 'AppData', 'Roaming') }
  // El CLI solo escribe donde ya hay un userData de Orca: sin crearlo, sync no deja nada.
  const userData = process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'orca')
    : join(home, '.config', 'orca')
  mkdirSync(userData, { recursive: true })

  const wa = (...args) => spawnSync(join(root, 'bin', 'wa-scope'), args,
    { env, encoding: 'utf8', timeout: 180000 })

  const JID = '120363000000000009@g.us'
  wa('agent', 'Watson')
  wa('set', JID, '--provider', 'plane', '--target', 'SOP', '--mode', 'responder',
    '--tone', 'Espanol neutro, de usted.', '--instructions', 'Resume y avisa.')
  wa('config', 'inbox_days', '30')
  wa('config', 'transcribe', 'off')
  wa('config', 'transcribe_lang', 'pt')
  wa('config', 'owner_name', 'Persona De Ejemplo')
  wa('route', '--match', 'acme', '--target', 'ACM')
  const sincronizado = wa('sync', '--json')

  const almacen = join(userData, 'plugins-data', 'ab2web.orca-wa-inbox', 'storage.json')
  ok('wa-scope sync escribe el storage que lee el panel', existsSync(almacen),
    `${almacen} — rc=${sincronizado.status} ${(sincronizado.stderr || '').slice(0, 200)}`)
  const escrito = existsSync(almacen) ? JSON.parse(readFileSync(almacen, 'utf8')) : {}

  // Las claves de arriba: renombrar una deja el panel leyendo undefined y pintando
  // vacio, sin un solo error a la vista.
  for (const clave of ['scope', 'activity', 'health', 'routes', 'chats', 'agentName',
    'inboxDays', 'transcribe', 'transcribeLang', 'transcribeQuality', 'ownerName',
    'tone']) {
    ok(`sync escribe la clave ${clave}`, clave in escrito,
      `claves = ${JSON.stringify(Object.keys(escrito))}`)
  }

  const entrada = (escrito.scope || {})[JID]
  for (const campo of ['chatName', 'provider', 'target', 'mode', 'tone', 'instructions',
    'updatedAt']) {
    ok(`la conversacion viaja con ${campo}`, !!entrada && campo in entrada,
      `scope[${JID}] = ${JSON.stringify(entrada)}`)
  }
  ok('y viaja con los valores que se guardaron, sin traducir',
    entrada && entrada.provider === 'plane' && entrada.target === 'SOP' &&
    entrada.mode === 'responder',
    JSON.stringify(entrada))

  for (const campo of ['pending', 'recent', 'running', 'syncedAt', 'run', 'mapped',
    'authorized']) {
    ok(`la actividad viaja con ${campo}`, campo in (escrito.activity || {}),
      `activity = ${JSON.stringify(Object.keys(escrito.activity || {}))}`)
  }
  ok('y el rastro de la corrida trae las claves que el panel lee',
    ['state', 'startedAt', 'endedAt', 'looked', 'pending', 'reason']
      .every((k) => k in (escrito.activity.run || {})),
    JSON.stringify(escrito.activity.run))
  ok('la salud viaja con ok y optional',
    'ok' in (escrito.health || {}) && Array.isArray((escrito.health || {}).optional),
    `health = ${JSON.stringify(escrito.health)}`)
  // Cada cosa opcional trae su codigo: es lo que el panel traduce. Sin el, el panel
  // pinta el ingles del CLI y media pantalla queda en otro idioma.
  ok('cada requisito opcional trae el codigo que el panel traduce',
    (escrito.health.optional || []).every((o) => 'code' in o && 'que' in o && 'como' in o),
    JSON.stringify(escrito.health.optional))
  ok('y si algo bloquea, viene con su codigo',
    escrito.health.ok === true ||
    (typeof escrito.health.problemCode === 'string' && !!escrito.health.problemCode),
    JSON.stringify(escrito.health))
  ok('la regla de ruteo viaja con pattern, provider y target',
    (escrito.routes || []).some((r) => r.pattern === 'acme' && r.target === 'ACM' &&
      r.provider === 'plane'),
    JSON.stringify(escrito.routes))

  // Y ahora lo que importa: los paneles montados contra ESE storage, no contra uno
  // escrito a mano.
  const panel = await montar('config.html', escrito, 'es-419')
  await espera()
  ok('el panel pinta la conversacion que escribio el CLI',
    panel.doc.getElementById('scope-wrap').textContent.includes(entrada.chatName),
    panel.doc.getElementById('scope-wrap').textContent.slice(0, 200))
  ok('el panel recarga los ajustes que escribio el CLI',
    valorSeg(panel.doc, 'inbox-days') === '30' &&
    valorSeg(panel.doc, 'transcribe') === 'off' &&
    valorSeg(panel.doc, 'lang') === 'pt' &&
    panel.doc.getElementById('owner').value === 'Persona De Ejemplo',
    `${valorSeg(panel.doc, 'inbox-days')} / ` +
    `${valorSeg(panel.doc, 'transcribe')} / ` +
    `${valorSeg(panel.doc, 'lang')}`)
  ok('el panel pinta la regla de ruteo que escribio el CLI',
    panel.doc.getElementById('routes-wrap').textContent.includes('ACM'))
  ok('la salud que escribio el CLI llega a la pantalla',
    escrito.health.ok === true
      ? panel.doc.getElementById('alert').hidden
      : !panel.doc.getElementById('alert').hidden,
    JSON.stringify(escrito.health))

  const actividadReal = await montar('activity.html', escrito, 'es-419')
  await espera()
  ok('el panel de actividad monta contra el storage real sin romperse',
    actividadReal.doc.getElementById('synced').textContent.length > 0)
  // Sin corridas todavia, el CLI de verdad tiene que decir "nunca reviso" — no la
  // lista vacia que hoy significa cuatro cosas distintas.
  ok('sin corridas, el panel montado contra el CLI real dice que nunca reviso',
    /todavia no ha revisado/i.test(actividadReal.doc.getElementById('runline').textContent),
    actividadReal.doc.getElementById('runline').textContent.trim())

  // ── y ahora la corrida de verdad: lock, unlock, sync, y el panel contra ESO ──
  // Se prueba corriendo el CLI, no escribiendo el storage a mano: lo segundo prueba
  // que el panel sabe pintar un objeto inventado, no que el CLI escribe ese objeto.
  wa('lock', '--note', 'triage')
  const corriendo = await montar('activity.html',
    JSON.parse(readFileSync(almacen, 'utf8')), 'es-419')
  await espera()
  ok('con el lock puesto, el panel dice que esta revisando ahora',
    /revisando/i.test(corriendo.doc.getElementById('runline').textContent),
    corriendo.doc.getElementById('runline').textContent.trim())

  wa('unlock')
  wa('sync')
  const cerrada = await montar('activity.html',
    JSON.parse(readFileSync(almacen, 'utf8')), 'es-419')
  await espera()
  const lineaOk = cerrada.doc.getElementById('runline').textContent
  ok('al soltar el lock, el panel dice la hora de la ultima revision y lo que encontro',
    /Ultima revision/.test(lineaOk) && /nada pendiente|para el agente|su decision/.test(lineaOk),
    lineaOk.trim())

  // Y una corrida que fallo cambia el renglon, con el motivo tal cual lo dio el CLI.
  const MOTIVO = 'This Claude account is in use by an assigned worktree'
  wa('lock', '--note', 'triage')
  wa('unlock', '--failed', MOTIVO)
  const fallida = await montar('activity.html',
    JSON.parse(readFileSync(almacen, 'utf8')), 'es-419')
  await espera()
  const lineaFallo = fallida.doc.getElementById('runline').textContent
  ok('una corrida fallida cambia el renglon y trae el motivo del CLI',
    /fallo/i.test(lineaFallo) && lineaFallo.includes(MOTIVO), lineaFallo.trim())

  // Con la unica conversacion en off, la lista vacia deja de decir "nada pendiente".
  wa('mode', JID, 'off')
  wa('sync')
  const apagada = await montar('activity.html',
    JSON.parse(readFileSync(almacen, 'utf8')), 'es-419')
  await espera()
  ok('con todo en off, el panel contra el CLI real lo dice',
    /off/.test(apagada.doc.getElementById('board-empty').textContent),
    apagada.doc.getElementById('board-empty').textContent.trim())
}

// ───────── lo que falla se DICE ─────────
// El defecto que se reporto: guardar decia guardado pasara lo que pasara. Ya no queda
// ningun control que escriba varias claves a la vez —el de "de donde lee" se fue con
// los transportes— pero la mitad que sigue viva es la que importa: un guardado que el
// host rechazo no puede decir que si.
console.log('\nconfig.html — un guardado que falla no dice guardado')
{
  const { doc, storage } = await montar('config.html', {}, 'es-419', (d) => {
    if (d.action === 'storage.set' && d.params.key === 'inboxDays') return { ok: false }
    return undefined
  })
  elegirSeg(doc, 'inbox-days', '30')
  doc.getElementById('save-reading').click()
  await espera()
  await espera()
  const dijo = doc.getElementById('said-reading').textContent
  ok('un ajuste que no se pudo guardar no dice guardado',
    !dijo.includes('\u2713'), `dijo ${JSON.stringify(dijo)}`)
  ok('el error queda marcado en rojo',
    doc.getElementById('said-reading').className.includes('bad'))
  ok('y no queda nada escrito en el storage', storage.inboxDays === undefined,
    `inboxDays = ${JSON.stringify(storage.inboxDays)}`)
}

console.log('\nconfig.html: el sondeo no pisa lo que el usuario acaba de hacer')
{
  let demora = 0
  const storage = { inboxDays: '7' }
  const { window, doc } = await montar('config.html', storage, 'es-419', (d) =>
    (demora && d.action === 'storage.get' && d.params.key === 'chats'
      ? { __demora: demora } : undefined))

  demora = 400
  window.dispatchEvent(new window.Event('focus'))   // el sondeo pide sus claves
  await espera()                                     // ya salieron, con inboxDays = 7
  elegirSeg(doc, 'inbox-days', '30')
  demora = 0
  doc.getElementById('save-reading').focus()         // lo que hace el clic en Chromium
  doc.getElementById('save-reading').click()
  await new Promise((r) => setTimeout(r, 700))       // aterriza la pintura del sondeo
  ok('un sondeo que leyo antes del guardado no repinta el valor viejo encima',
    storage.inboxDays === '30' && valorSeg(doc, 'inbox-days') === '30',
    `guardado = ${storage.inboxDays}, grupo = ${valorSeg(doc, 'inbox-days')}`)
}

{
  // Y la otra mitad: el repintado que llega ANTES del clic. Ahi no hay guardado que
  // proteger todavia, y el boton termina mandando el valor que el usuario ya no ve.
  const storage = { inboxDays: '7' }
  const { window, doc } = await montar('config.html', storage, 'es-419')
  elegirSeg(doc, 'inbox-days', '30')
  doc.getElementById('agent').focus()                // mira otra cosa antes de guardar
  window.dispatchEvent(new window.Event('focus'))
  await espera(); await espera()
  ok('un grupo cambiado y sin guardar no lo repinta el sondeo',
    valorSeg(doc, 'inbox-days') === '30', valorSeg(doc, 'inbox-days'))
  doc.getElementById('save-reading').click()
  await espera(); await espera()
  ok('y la accion manda el valor que el usuario eligio, no el que habia guardado',
    storage.inboxDays === '30', String(storage.inboxDays))
}

console.log('\nconfig.html: un host que rechaza todo')
{
  const { doc } = await montar('config.html', {}, 'es-419',
    (d) => d.action === 'storage.get'
      ? { ok: false, error: { code: 'rate_limited' } } : undefined)
  // Solo lo que el panel PINTO: el textContent del documento entero incluye plantilla
  // oculta, y medirlo ahi haria pasar la prueba por el motivo equivocado.
  const visible = (sel) => {
    const n = doc.querySelector(sel)
    return n && !n.hidden ? n.textContent : ''
  }
  const afirmaciones = [
    ['el plugin no esta', visible('#alert'), /El plugin no esta corriendo/],
    ['no hay de donde leer', visible('#alert'), /Todavia no hay de donde leer/],
    ['no hay conversaciones', visible('#scope-wrap'), /Sin conversaciones/]
  ]
  for (const [nombre, texto, re] of afirmaciones) {
    ok(`un rechazo no afirma "${nombre}"`, !re.test(texto),
      String(texto).replace(/\s+/g, ' ').slice(0, 160))
  }
}

// ───────── el panel y el worker tienen que estar de acuerdo sobre el latido ─────────
// Son dos constantes en dos archivos: el panel corre en el navegador y no puede
// importar del worker. Si se separan, el panel marca muerto a un worker vivo (o al
// reves) y nadie se entera hasta que pasa en la maquina de alguien.
{
  const { LATIDO_VENCE_MS } = await import('../main.mjs')
  const html = readFileSync(join(root, 'config.html'), 'utf8')
  const enPanel = /var LATIDO_VENCE_MS = (\d+)/.exec(html)
  ok('el panel y el worker usan el mismo vencimiento de latido',
    !!enPanel && Number(enPanel[1]) === LATIDO_VENCE_MS,
    `panel = ${enPanel && enPanel[1]}, worker = ${LATIDO_VENCE_MS}`)
}

// ───────── el panel dice si hay alguien corriendo ─────────
// El defecto: en una maquina donde Orca no arranco el worker —porque el plugin espera
// aprobacion, que es lo que pasa en CADA actualizacion— el panel se veia igual que uno
// sano, aceptaba clics y contestaba con 45 s de silencio. "Lento" y "no esta" eran la
// misma pantalla.
console.log('\nconfig.html: el latido del worker')
{
  const VIEJO = new Date(Date.now() - 120000).toISOString()
  const casos = [
    ['es-419', /El plugin no responde/, /El plugin dejo de responder/],
    ['en-US', /The plugin is not responding/, /The plugin stopped responding/],
    ['pt-BR', /O plugin nao responde/, /O plugin parou de responder/]
  ]
  for (const [lang, ido, parado] of casos) {
    const sin = await montar('config.html', { workerBeat: null, health: { ok: true } },
      lang)
    const a1 = sin.doc.getElementById('alert')
    ok(`sin latido el panel dice que el plugin no esta, en ${lang}`,
      !a1.hidden && ido.test(a1.textContent), a1.textContent.slice(0, 120))
    ok(`y dice donde se aprueba, en ${lang}`,
      /Plugins/.test(a1.textContent), a1.textContent.slice(0, 200))

    // Y lo que el aviso solo no arregla: sin nadie del otro lado, el boton que deja
    // un pedido esperando respuesta es el silencio de 45 s otra vez.
    ok(`sin worker el boton de reintentar el sync esta apagado, en ${lang}`,
      sin.doc.getElementById('sync-retry').disabled === true)

    const viejo = await montar('config.html',
      { workerBeat: { at: VIEJO }, health: { ok: true } }, lang)
    const a2 = viejo.doc.getElementById('alert')
    ok(`un latido vencido se distingue de uno que nunca existio, en ${lang}`,
      !a2.hidden && parado.test(a2.textContent), a2.textContent.slice(0, 120))
  }

  // Con worker vivo los botones siguen vivos: apagar lo que SI se puede hacer es el
  // mismo defecto del otro lado.
  const vivo = await montar('config.html',
    { workerBeat: { at: new Date().toISOString() }, health: { ok: true } }, 'es-419')
  ok('con worker vivo el boton de reintentar el sync sigue encendido',
    vivo.doc.getElementById('sync-retry').disabled === false)

  // Y el caso que hace que esto valga: un host que RECHAZA la lectura no es un worker
  // ausente. No saber no es saber que no esta.
  const rechazo = await montar('config.html', { health: { ok: true } }, 'es-419',
    (d) => d.action === 'storage.get' && d.params.key === 'workerBeat'
      ? { ok: false, error: { code: 'rate_limited' } } : undefined)
  const a3 = rechazo.doc.getElementById('alert')
  ok('una lectura RECHAZADA no se pinta como plugin ausente',
    a3.hidden || !/no esta corriendo/.test(a3.textContent), a3.textContent.slice(0, 120))
}

console.log('\nconfig.html: el clic contra el cupo del host')
{
  // La misma ventana deslizante de plugin-panel-message-budget.ts, no una idea de ella.
  const cupo = () => {
    const marcas = []
    return () => {
      const now = Date.now()
      while (marcas.length && marcas[0] <= now - 10000) marcas.shift()
      if (marcas.length >= 30) {
        return { ok: false, errorCode: 'rate_limited', error: 'Too many requests.' }
      }
      marcas.push(now)
      return undefined
    }
  }
  const admite = cupo()
  const { window, doc, storage } = await montar('config.html', {
    syncStatus: { ok: false, at: new Date().toISOString(), reason: 'fallo', detail: 'x' }
  }, 'es-419', () => admite())
  await espera()
  // Entrar al panel desde otra parte de Orca: la ventana toma foco y gasta cupo.
  window.dispatchEvent(new window.Event('focus'))
  await espera()
  doc.getElementById('sync-retry').click()
  await new Promise((r) => setTimeout(r, 400))
  ok('el primer clic deja el pedido escrito, no rechazado',
    !!storage.syncRequest, JSON.stringify(storage.syncRequest))
  ok('y no le dice al usuario que Orca se cerro',
    !/error/.test(doc.getElementById('said-sync').textContent),
    doc.getElementById('said-sync').textContent.slice(0, 140))
}

// Y si el host frena igual —cobra por su cuenta los pongs del watchdog y el alto del
// panel, que el espejo del panel no ve—, el pedido se reintenta. Un rechazo del
// transporte no es una respuesta, y contarselo al usuario es lo que lo hace apretar
// dos veces.
console.log('\nconfig.html: un rechazo del host se reintenta, no se reporta')
{
  let rechazadas = 0
  const { doc, storage } = await montar('config.html', {
    syncStatus: { ok: false, at: new Date().toISOString(), reason: 'fallo', detail: 'x' }
  }, 'es-419', (d) => {
    if (d.action === 'storage.set' && d.params.key === 'syncRequest' && rechazadas < 1) {
      rechazadas += 1
      return { ok: false, errorCode: 'rate_limited', error: 'Too many requests.' }
    }
    return undefined
  })
  await espera()
  doc.getElementById('sync-retry').click()
  await new Promise((r) => setTimeout(r, 300))
  ok('el primer rechazo no se pinta como una falla',
    !/error/.test(doc.getElementById('said-sync').textContent),
    doc.getElementById('said-sync').textContent.slice(0, 140))
  await new Promise((r) => setTimeout(r, 1600))
  ok('y el pedido sale solo, sin que el usuario apriete de nuevo',
    rechazadas === 1 && !!storage.syncRequest, `rechazadas=${rechazadas} ${JSON.stringify(storage.syncRequest)}`)
}

// ───────── ajustes sin lectura: una tarjeta que el host no contesto no es una vacia ─────────
// Visto en vivo (v4.22.0): Su aprobacion abria con "Todavia no eligio ningun numero",
// "No avisar" como unica opcion y los tres avisos de Orca apagados, mientras el storage
// tenia los numeros de confianza, el de aprobacion y los avisos encendidos. El host
// reparte 30 mensajes por 10 s POR PLUGIN (main: createPluginPanelCallAdmission, por
// pluginKey), asi que el tablero abierto gasta del mismo cupo que Ajustes; una lectura
// del carril del usuario que sigue rechazada a los 30 s se rinde, y la tarjeta se quedaba
// con lo de fabrica pintado y su Guardar vivo: un clic escribia owners=[] y todo apagado.
console.log('\nconfig.html — ajustes sin lectura: lo de fabrica no se presenta como lo guardado')
{
  const DUENO = '100000000000001@lid'
  const guardado = () => ({
    owners: [{ id: DUENO, name: 'Ana Ejemplo' }],
    approvalNumber: DUENO,
    orcaNotices: { waiting: 'on', finished: 'on', automationFailed: 'on', quietStart: '',
      quietEnd: '', hourlyCap: '6', finishedDelaySeconds: '25' }
  })
  const SIN_LEER = ['owners', 'approvalNumber', 'orcaNotices']
  // Visible de verdad: ni el nodo ni ninguno de arriba esconde (atributo o display).
  const seVe = (n) => {
    for (let x = n; x && x.nodeType === 1; x = x.parentElement) {
      if (x.hidden || x.ownerDocument.defaultView.getComputedStyle(x).display === 'none') {
        return false
      }
    }
    return true
  }
  let cerrado = true
  const { window, doc, storage, enviados } = await montar('config.html', guardado(), 'es-419',
    (d) => cerrado && d.action === 'storage.get' && SIN_LEER.includes(d.params.key)
      ? { ok: false, errorCode: 'rate_limited', error: 'Too many requests.' } : undefined)
  doc.getElementById('tab-aprobacion').click()
  await espera()
  // Pasan 31 s con el host diciendo que no: el carril del usuario deja de reintentar.
  const real = window.Date.now.bind(window.Date)
  window.Date.now = () => real() + 31000
  storage.workerBeat = { at: new Date(real() + 31000).toISOString() }
  await new Promise((r) => setTimeout(r, 2800))

  const duenos = doc.getElementById('owners-wrap')
  ok('sin lectura, la tarjeta de confianza no dice "Todavia no eligio ningun numero"',
    !(seVe(duenos) && /no eligio/i.test(duenos.textContent)), duenos.textContent)
  const numero = doc.getElementById('approval-number')
  ok('sin lectura, el numero de aprobacion no se ofrece como "No avisar" y nada mas',
    !(seVe(numero) && numero.querySelectorAll('button').length <= 1),
    [...numero.querySelectorAll('button')].map((b) => b.textContent).join(' | '))
  const apagados = ['orca-waiting', 'orca-finished', 'orca-automation']
    .filter((id) => seVe(doc.getElementById(id)) &&
      doc.getElementById(id).getAttribute('aria-checked') !== 'true')
  ok('sin lectura, los avisos de Orca no se muestran apagados como si fuera lo guardado',
    apagados.length === 0, apagados.join(', '))
  ok('sin lectura, no se avisa "sin numero de aprobacion"',
    !seVe(doc.getElementById('orca-no-number')))
  for (const id of ['owners-card', 'orca-notices-card']) {
    const aviso = doc.querySelector(`#${id} .leyendo`)
    ok(`#${id}: dice que todavia esta leyendo lo guardado`,
      !!aviso && seVe(aviso) && /leyendo/i.test(aviso.textContent), aviso?.textContent)
  }
  ok('sin lectura, los dos Guardar quedan apagados',
    doc.getElementById('save-owners').disabled && doc.getElementById('save-orca').disabled)

  // La regresion que borro los ajustes del dueno: Guardar sobre una tarjeta sin leer.
  const antes = enviados.length
  doc.getElementById('save-owners').click()
  doc.getElementById('save-orca').click()
  await espera()
  const escritas = enviados.slice(antes).filter((d) => d.action === 'storage.set')
    .map((d) => d.params.key)
  ok('Guardar en una tarjeta sin leer no escribe nada', escritas.length === 0,
    escritas.join(', '))
  ok('y lo guardado sigue intacto',
    JSON.stringify([storage.owners, storage.approvalNumber, storage.orcaNotices]) ===
      JSON.stringify([guardado().owners, guardado().approvalNumber, guardado().orcaNotices]),
    JSON.stringify([storage.owners, storage.approvalNumber, storage.orcaNotices]))

  // El host vuelve a contestar: el panel lo pide solo, sin que nadie recargue ni apriete.
  cerrado = false
  await new Promise((r) => setTimeout(r, 4000))
  ok('cuando el host contesta, aparecen los numeros de confianza guardados',
    seVe(duenos) && duenos.textContent.includes('Ana Ejemplo'), duenos.textContent)
  ok('y el numero de aprobacion guardado, apretado',
    seVe(numero) &&
      numero.querySelector('button[aria-pressed="true"]')?.dataset.value === DUENO,
    numero.innerHTML.slice(0, 200))
  ok('y los tres avisos de Orca encendidos',
    ['orca-waiting', 'orca-finished', 'orca-automation'].every((id) =>
      seVe(doc.getElementById(id)) &&
      doc.getElementById(id).getAttribute('aria-checked') === 'true'))
  ok('y sin el aviso de "sin numero"', !seVe(doc.getElementById('orca-no-number')))
  ok('y los dos Guardar vuelven a andar',
    !doc.getElementById('save-owners').disabled && !doc.getElementById('save-orca').disabled)
}

// Lo mismo antes de cualquier respuesta: el host todavia no contesto (o la contestacion se
// perdio) y el dueno ya aprieta Guardar. Nada sale.
console.log('\nconfig.html — ajustes sin lectura: Guardar antes de la primera respuesta')
{
  const { doc, storage, enviados } = await montar('config.html', {
    owners: [{ id: '100000000000001@lid', name: 'Ana Ejemplo' }],
    approvalNumber: '100000000000001@lid',
    slaMinutes: '30'
  }, 'es-419', (d) => d.action === 'storage.get' &&
    ['owners', 'approvalNumber', 'slaMinutes'].includes(d.params.key)
    ? { __demora: 600000 } : undefined)
  doc.getElementById('tab-aprobacion').click()
  await espera()
  const antes = enviados.length
  doc.getElementById('save-owners').click()
  doc.getElementById('save-sla').click()
  await espera()
  const escritas = enviados.slice(antes).filter((d) => d.action === 'storage.set')
    .map((d) => d.params.key)
  ok('sin respuesta del host, Guardar no escribe numeros ni la meta', escritas.length === 0,
    escritas.join(', '))
  ok('y lo guardado sigue intacto',
    storage.owners.length === 1 && storage.approvalNumber === '100000000000001@lid' &&
      storage.slaMinutes === '30')
  const S = doc.defaultView.STRINGS
  ok('el aviso de lectura existe en los tres idiomas, el portugues propio',
    S.es.cardReading && S.en.cardReading && S.pt.cardReading &&
      S.pt.cardReading !== S.en.cardReading && S.es.cardReading !== S.en.cardReading)
}

// Una lectura que el host sigue rechazando espera su reintento SOLA. En la cola del
// carril del usuario quedaba adelante, con su `desde` en el futuro, y `drenar` cortaba
// ahi: todo lo que venia atras -las demas tarjetas de la pestana, y hasta un clic-
// esperaba su backoff, ronda tras ronda.
console.log('\nconfig.html — ajustes sin lectura: un rechazo no frena al resto del carril del usuario')
{
  const { doc } = await montar('config.html', {
    owners: [{ id: '100000000000001@lid', name: 'Ana Ejemplo' }],
    approvalNumber: '100000000000001@lid',
    slaMinutes: '30',
    projectQuestionHours: '12'
  }, 'es-419', (d) => d.action === 'storage.get' &&
    ['owners', 'approvalNumber', 'orcaNotices'].includes(d.params.key)
    ? { ok: false, errorCode: 'rate_limited', error: 'Too many requests.' } : undefined)
  doc.getElementById('tab-aprobacion').click()
  await new Promise((r) => setTimeout(r, 200))
  ok('la meta del primer contacto se pinta sin esperar a los numeros rechazados',
    !doc.getElementById('sla-card').classList.contains('sin-leer') &&
      doc.getElementById('sla-minutes').value === '30',
    doc.getElementById('sla-minutes').value)
  ok('y la pregunta de proyecto tambien',
    !doc.getElementById('pq-card').classList.contains('sin-leer') &&
      doc.getElementById('pq-hours').value === '12', doc.getElementById('pq-hours').value)
  ok('mientras la tarjeta de confianza sigue diciendo que lee',
    doc.getElementById('owners-card').classList.contains('sin-leer'))
}

// ───────── vinculacion de WhatsApp: el QR (T4) ─────────
// El panel nunca habia dibujado un QR (docs/ENCARGO-TRANSPORTE-UNICO.md §6). Lo que
// mas importa de esta pieza es que un QR que ya no sirve para escanear no
// desaparezca del todo: un recuadro vacio se lee como un plugin roto, no como uno
// que esta a punto de mostrar el siguiente. Por eso el vencido queda VISIBLE y
// APAGADO (`.vencido`, opacity .4), no escondido.
console.log('\nconfig.html — vinculacion de WhatsApp: los cinco estados')
{
  const AHORA_MS = Date.now()
  const casos = [
    { nombre: 'esperando el QR', sidecar: { connection: 'connecting', qr: null, exited: false },
      msg: /esperando/i, qrVisible: false },
    { nombre: 'QR en pantalla', sidecar: { connection: 'connecting',
      qr: { qr: 'DATA-QR-DE-PRUEBA', ts: AHORA_MS, rotation: 1 }, exited: false },
      msg: /escanee/i, qrVisible: true, qrVencido: false },
    // El QR trae su propio `ttlMs`: el panel ya no adivina cuanto vive. Se manda uno
    // corto y una edad mayor, en vez de un numero copiado del panel — asi la prueba
    // sigue probando la regla si el TTL real cambia.
    { nombre: 'QR vencido', sidecar: { connection: 'connecting',
      qr: { qr: 'DATA-QR-DE-PRUEBA', ts: AHORA_MS - 30000, rotation: 1, ttlMs: 20000 },
      exited: false },
      // Sigue siendo una imagen valida -WhatsApp la rechaza, no el navegador-, asi
      // que queda visible y apagada, no escondida detras de un recuadro en blanco.
      msg: /vencio/i, qrVisible: true, qrVencido: true },
    { nombre: 'conectado', sidecar: { connection: 'open', qr: null, exited: false,
      latido: { ts: AHORA_MS, conectado: true } },
      msg: /conectado/i, qrVisible: false },
    { nombre: 'sesion caida', sidecar: { connection: null, qr: null, exited: true,
      error: { code: 'sidecar-cayo', detail: 'sidecar exited (code 1, signal null)' } },
      msg: /caida/i, qrVisible: false }
  ]
  for (const c of casos) {
    const { doc } = await montar('config.html', { sidecar: c.sidecar }, 'es-419')
    await espera()
    const msg = doc.getElementById('pairing-msg').textContent
    ok(`${c.nombre}: el mensaje es el correcto`, c.msg.test(msg), msg)
    const wrap = doc.getElementById('qr-wrap')
    ok(`${c.nombre}: el QR ${c.qrVisible ? 'se muestra' : 'no se muestra'}`,
      !wrap.hidden === c.qrVisible, `hidden=${wrap.hidden}`)
    if (c.qrVisible) {
      ok(`${c.nombre}: se ve ${c.qrVencido ? 'apagado' : 'con su brillo normal'}`,
        wrap.classList.contains('vencido') === !!c.qrVencido, `class=${wrap.className}`)
    }
  }
  // Con `exited: true` el estado queda pisado y no reemplazado (main.mjs, `escribir`
  // mezcla): un `d.qr` de una rotacion vieja puede seguir viajando aun con la sesion
  // caida. Ahi si tiene que esconderse — no hay nada que escanear, la sesion misma
  // esta caida y decir lo contrario mostrando un QR seria mentir dos veces.
  const { doc: caidaConQrViejo } = await montar('config.html', { sidecar: {
    connection: null, exited: true,
    qr: { qr: 'DATA-QR-VIEJA', ts: AHORA_MS, rotation: 1, ttlMs: 75000 },
    error: { code: 'sidecar-cayo', detail: 'x' }
  } }, 'es-419')
  await espera()
  ok('con la sesion caida no se muestra un QR viejo que quedo pisado en el estado',
    caidaConQrViejo.getElementById('qr-wrap').hidden === true,
    `hidden=${caidaConQrViejo.getElementById('qr-wrap').hidden}`)
  // El vencido tiene que decir POR QUE, ademas de mostrarse apagado: ver el mismo
  // QR sin explicacion no dice si sigue sirviendo o no.
  const { doc: vencido } = await montar('config.html', { sidecar: {
    connection: 'connecting',
    qr: { qr: 'DATA-QR-DE-PRUEBA', ts: AHORA_MS - 30000, rotation: 1, ttlMs: 20000 },
    exited: false
  } }, 'es-419')
  await espera()
  ok('el vencido explica que ya viene uno nuevo, no solo que desaparecio',
    /nuevo/i.test(vencido.getElementById('pairing-detail').textContent),
    vencido.getElementById('pairing-detail').textContent)
}

// Regresion de "el QR sale SIEMPRE vencido". Medido en una instalacion viva: el
// sidecar rotaba bien (rotaciones 8..14 sin saltos, ttlMs 75 s, edad maxima 60 s, cero
// vencidos en storage) y aun asi el panel decia "El codigo vencio" y no salia de ahi.
//
// El culpable era `read`: cuando el host RECHAZA una lectura devuelve lo memorizado, y
// llegaba indistinguible de una lectura fresca -es un objeto normal, `hayRespuesta` da
// true igual-. `estadoSidecar` comparaba entonces un `qr.ts` congelado contra un
// `Date.now()` que si avanza, asi que a partir del primer rechazo el estado caia en
// 'expired' y NO VOLVIA: el reloj corre, el dato memorizado no, y nada lo invalida.
//
// Con datos rancios lo unico cierto es que el panel no esta leyendo, y eso ahora tiene
// estado propio ('stale'). No reusa 'waiting' porque 'waiting' esconde el recuadro, y
// esconderlo seria volver al recuadro vacio que se arreglo en 4.1.0.
console.log('\nconfig.html — un rechazo del host no puede dar por vencido el QR')
{
  const casos = [
    ['es-419', /escanee/i, /no se puede confirmar/i],
    ['en-US', /scan this code/i, /cannot be confirmed/i],
    ['pt-BR', /escaneie/i, /nao da para confirmar/i]
  ]
  for (const [lang, vivoRe, rancioRe] of casos) {
    let rechazar = false
    const m = await montar('config.html', {
      sidecar: { connection: 'connecting', exited: false,
        qr: { qr: 'DATA-QR-DE-PRUEBA', ts: Date.now(), rotation: 1, ttlMs: 75000 } }
    }, lang, (d) => {
      if (rechazar && d.action === 'storage.get' && d.params.key === 'sidecar') {
        // El sobre con el que el host dice que no. No es una clave vacia: `stored` lo
        // vuelve SIN_RESPUESTA y `read` contesta con lo memorizado.
        //
        // A proposito NO es `rate_limited`: ese codigo, en el carril del usuario, se
        // reintenta con backoff hasta `vence` (30 s) en vez de resolver, y la prueba
        // estaria esperando al reintento en vez de mirar lo que se pinta. El defecto
        // que se prueba aca no depende de POR QUE el host dijo que no.
        return { ok: false, errorCode: 'denied' }
      }
      return undefined
    })
    await espera()
    ok(`${lang}: con lectura fresca el QR se ofrece para escanear`,
      vivoRe.test(m.doc.getElementById('pairing-msg').textContent),
      m.doc.getElementById('pairing-msg').textContent)

    // El host deja de contestar por `sidecar` y pasan dos minutos: el QR memorizado ya
    // supera su propio ttlMs (75 s), que es justo lo que antes lo mandaba a 'expired'.
    const ahora = m.window.Date.now()
    rechazar = true
    m.storage.workerBeat = { at: new Date(ahora + 120000).toISOString() }
    m.window.Date.now = () => ahora + 120000
    m.window.dispatchEvent(new m.window.Event('focus'))
    await espera()

    ok(`${lang}: con el host rechazando, NO se afirma que vencio`,
      rancioRe.test(m.doc.getElementById('pairing-msg').textContent),
      m.doc.getElementById('pairing-msg').textContent)
    // Y lo que no puede pasar: que el recuadro se vacie. Ese fue el defecto anterior.
    const wrap = m.doc.getElementById('qr-wrap')
    ok(`${lang}: el ultimo QR sigue a la vista, no un recuadro vacio`,
      wrap.hidden === false, `hidden=${wrap.hidden}`)
    ok(`${lang}: pero apagado, porque no se puede prometer que sirva`,
      wrap.classList.contains('vencido'), `class=${wrap.className}`)
    ok(`${lang}: y dice que el problema es la lectura, no el codigo`,
      !m.doc.getElementById('pairing-diag').hidden,
      m.doc.getElementById('pairing-diag').textContent)

    // Se restablece la lectura: el panel tiene que volver solo, sin que nadie recargue.
    // Antes no volvia nunca — ese "no vuelve" es el bug entero.
    rechazar = false
    m.storage.sidecar = { connection: 'connecting', exited: false,
      qr: { qr: 'DATA-QR-NUEVA', ts: ahora + 120000, rotation: 2, ttlMs: 75000 } }
    m.window.dispatchEvent(new m.window.Event('focus'))
    await espera()
    ok(`${lang}: y en cuanto el host vuelve a contestar, se recupera solo`,
      vivoRe.test(m.doc.getElementById('pairing-msg').textContent),
      m.doc.getElementById('pairing-msg').textContent)
  }
}

// El defecto real: el panel se quedo 26 minutos diciendo "unos segundos" mientras el
// worker seguia vivo y el QR rotaba en storage. La escalada usa el tiempo REAL desde
// que el panel entro en 'waiting', asi que se avanza el reloj del panel y se le pide
// que vuelva a mirar (foco), tal como lo hace quien vuelve a la pestana.
console.log('\nconfig.html — la espera del QR deja de prometer "unos segundos"')
{
  const casos = [
    ['es-419', /esperando|unos segundos/i, /ya lleva/i, /tarda mas de lo esperado/i],
    ['en-US', /few seconds/i, /it has been waiting/i, /taking longer than expected/i],
    ['pt-BR', /alguns segundos/i, /ja esta esperando/i, /demorando mais/i]
  ]
  for (const [lang, corta, media, larga] of casos) {
    const m = await montar('config.html', {}, lang)
    await espera()
    ok(`recien abierto, en ${lang}, la espera todavia es la corta`,
      corta.test(m.doc.getElementById('pairing-detail').textContent),
      m.doc.getElementById('pairing-detail').textContent)
    ok(`y el diagnostico todavia no aparece, en ${lang}`,
      m.doc.getElementById('pairing-diag').hidden,
      m.doc.getElementById('pairing-diag').textContent)

    const ahora = m.window.Date.now()
    m.window.Date.now = () => ahora + 65000
    m.window.dispatchEvent(new m.window.Event('focus'))
    await espera()
    ok(`pasado un minuto sin QR, en ${lang}, dice cuanto lleva de verdad`,
      media.test(m.doc.getElementById('pairing-detail').textContent),
      m.doc.getElementById('pairing-detail').textContent)
    ok(`y ahora si aparece el diagnostico, en ${lang}`,
      !m.doc.getElementById('pairing-diag').hidden)

    m.window.Date.now = () => ahora + 185000
    m.window.dispatchEvent(new m.window.Event('focus'))
    await espera()
    ok(`pasados tres minutos sin QR, en ${lang}, dice que ya es raro y da el siguiente paso`,
      larga.test(m.doc.getElementById('pairing-detail').textContent),
      m.doc.getElementById('pairing-detail').textContent)
  }
}

// Lo que el panel puede AFIRMAR, no lo que adivina: si el plugin contesta, y que dice
// la conexion de WhatsApp. El heartbeat se adelanta junto con el reloj para que siga
// "vivo" a los ojos de `pintarLatido` — sin eso, la sola demora del reloj lo haria ver
// caido y se estaria probando otra cosa.
console.log('\nconfig.html — la espera larga dice lo que de verdad sabe, nunca una causa inventada')
{
  const casos = [
    ['es-419', /esta respondiendo/i, /todavia no dijo nada/i,
      /no esta respondiendo/i, /sigue intentando/i],
    ['en-US', /is responding/i, /has not said anything/i,
      /is not responding/i, /still trying/i],
    ['pt-BR', /esta respondendo/i, /ainda nao disse nada/i,
      /nao esta respondendo/i, /ainda esta tentando/i]
  ]
  for (const [lang, workerUp, connSilent, workerDown, connConnecting] of casos) {
    const vivo = await montar('config.html', {}, lang)
    await espera()
    const ahora1 = vivo.window.Date.now()
    vivo.storage.workerBeat = { at: new Date(ahora1 + 65000).toISOString() }
    vivo.window.Date.now = () => ahora1 + 65000
    vivo.window.dispatchEvent(new vivo.window.Event('focus'))
    await espera()
    const diag1 = vivo.doc.getElementById('pairing-diag').textContent
    ok(`con el plugin respondiendo, en ${lang}, el diagnostico lo dice`,
      workerUp.test(diag1), diag1)
    ok(`y que la conexion todavia no informo nada, en ${lang}`,
      connSilent.test(diag1), diag1)

    const ausente = await montar('config.html', { workerBeat: null,
      sidecar: { connection: 'connecting', qr: null, exited: false } }, lang)
    await espera()
    const ahora2 = ausente.window.Date.now()
    ausente.window.Date.now = () => ahora2 + 65000
    ausente.window.dispatchEvent(new ausente.window.Event('focus'))
    await espera()
    const diag2 = ausente.doc.getElementById('pairing-diag').textContent
    ok(`con el plugin sin responder, en ${lang}, el diagnostico lo dice`,
      workerDown.test(diag2), diag2)
    ok(`y que la conexion sigue intentando, en ${lang}`,
      connConnecting.test(diag2), diag2)
  }
}

// Las dos claves existian sin que nada las disparara: `estadoSidecar` deja un cierre
// transitorio como 'waiting' a proposito -se cura solo, tratarlo como 'down' seria
// alarmar por algo que ya se esta arreglando-, pero eso no es motivo para callar lo
// que el sidecar ya conto.
console.log('\nconfig.html — un cierre transitorio que se cura solo ahora se explica, no se calla')
{
  const casos = [
    ['socket-caido', /reintentando sola/i],
    ['reinicio-requerido', /reiniciando la conexion/i]
  ]
  for (const [motivo, texto] of casos) {
    const { doc } = await montar('config.html', { sidecar: {
      connection: 'close', motivo, qr: null, exited: false
    } }, 'es-419')
    await espera()
    ok(`${motivo}: el estado sigue siendo "esperando", no "caida" — se cura solo`,
      /esperando/i.test(doc.getElementById('pairing-msg').textContent),
      doc.getElementById('pairing-msg').textContent)
    ok(`${motivo}: pero ahora dice lo que de verdad esta pasando, no el generico`,
      texto.test(doc.getElementById('pairing-detail').textContent),
      doc.getElementById('pairing-detail').textContent)
  }
}

// "Me toca refrescar?" tiene que tener una respuesta en la pantalla. Va por el
// carril de usuario (`read(key, true)`, codigo fuente), no por el del sondeo.
console.log('\nconfig.html — "Comprobar ahora" hace una lectura de verdad y se apaga en vuelo')
{
  const { doc, enviados } = await montar('config.html', {
    sidecar: { connection: 'connecting', qr: null, exited: false }
  }, 'es-419')
  await espera()
  const antes = enviados.length
  const boton = doc.getElementById('pairing-refresh')
  boton.click()
  ok('el boton queda ocupado mientras espera la respuesta', boton.disabled === true,
    `disabled=${boton.disabled}`)
  await espera()
  ok('y se reactiva cuando vuelve', boton.disabled === false, `disabled=${boton.disabled}`)
  const pedidos = enviados.slice(antes).filter((d) => d.action === 'storage.get')
    .map((d) => d.params.key)
  ok('pide de nuevo el sidecar y el latido del worker, no otra cosa',
    pedidos.includes('sidecar') && pedidos.includes('workerBeat'),
    JSON.stringify(pedidos))
  ok('y confirma en pantalla que ya comprobo',
    doc.getElementById('said-pairing-refresh').textContent.length > 0,
    doc.getElementById('said-pairing-refresh').textContent)
}

console.log('\nconfig.html — el QR escala con el ancho de la ventana')
{
  for (const [ancho, esperado] of [[320, 260], [768, 300], [1440, 360]]) {
    const { window, doc } = await montar('config.html', { sidecar: {
      connection: 'connecting', qr: { qr: 'DATA-QR-DE-PRUEBA', ts: Date.now(), rotation: 1 }
    } }, 'es-419')
    Object.defineProperty(window, 'innerWidth', { value: ancho, configurable: true })
    // El primer pintado ya corrio con el ancho por defecto de jsdom: se fuerza un
    // repintado con el foco, que es lo que dispara un reload completo de verdad.
    window.dispatchEvent(new window.Event('focus'))
    await espera()
    const canvas = doc.getElementById('qr-canvas')
    ok(`a ${ancho}px de ancho el canvas mide ${esperado}`, canvas.width === esperado,
      `width=${canvas.width}`)
  }
}

console.log('\nconfig.html — una lectura rechazada no apaga el QR que ya estaba en pantalla')
{
  // Centinela SIN_RESPUESTA: un `storage.get` que el host rechaza no es una clave
  // vacia. Se rechaza la SEGUNDA lectura -la primera es la del montaje, que tiene que
  // llegar bien para que haya algo bueno que conservar.
  let vistos = 0
  const { doc } = await montar('config.html', { sidecar: {
    connection: 'connecting',
    qr: { qr: 'DATA-QR-DE-PRUEBA', ts: Date.now(), rotation: 1 }
  } }, 'es-419', (d) => {
    if (d.action === 'storage.get' && d.params.key === 'sidecar') {
      vistos += 1
      if (vistos === 2) return { ok: false, errorCode: 'rate_limited' }
    }
    return undefined
  })
  await espera()
  ok('primero pinta el QR de verdad', /escanee/i.test(doc.getElementById('pairing-msg').textContent),
    doc.getElementById('pairing-msg').textContent)
  // El sondeo dedicado de 2 s entra justo en la lectura rechazada.
  await new Promise((r) => setTimeout(r, 2500))
  ok('con la lectura rechazada, el QR sigue en pantalla: no se apaga solo',
    /escanee/i.test(doc.getElementById('pairing-msg').textContent) &&
    !doc.getElementById('qr-wrap').hidden,
    doc.getElementById('pairing-msg').textContent)
}

console.log('\nconfig.html — el sondeo de 2 s del QR se detiene al emparejar')
{
  const { enviados: enviadosVivo } = await montar('config.html', { sidecar: {
    connection: 'connecting',
    qr: { qr: 'DATA-QR-DE-PRUEBA', ts: Date.now(), rotation: 1 }
  } }, 'es-419')
  await new Promise((r) => setTimeout(r, 4500))
  const lecturasVivo = enviadosVivo
    .filter((d) => d.action === 'storage.get' && d.params.key === 'sidecar').length

  const { enviados: enviadosPareado } = await montar('config.html',
    { sidecar: { connection: 'open', qr: null,
      latido: { ts: Date.now(), conectado: true } } }, 'es-419')
  await new Promise((r) => setTimeout(r, 4500))
  const lecturasPareado = enviadosPareado
    .filter((d) => d.action === 'storage.get' && d.params.key === 'sidecar').length

  ok('mientras el QR esta vivo, el sondeo dedicado pide la clave varias veces en 4,5 s',
    lecturasVivo >= 2, `lecturasVivo=${lecturasVivo}`)
  ok('una vez emparejado, se pide muchas menos veces: el sondeo dedicado se detuvo',
    lecturasPareado < lecturasVivo, `vivo=${lecturasVivo} pareado=${lecturasPareado}`)
}

// ───────── cada motivo de arranque tiene su propia explicacion ─────────
// El panel traduce POR CODIGO, asi que dos codigos que caen en la misma frase son, para
// quien lee, un solo motivo. Y ahi estaba el defecto: "no hay userData en este equipo" y
// "no me dejaron lanzar el resolvedor" se leian igual, y mandaban a buscar una carpeta
// cuando lo que faltaba era aprobar el plugin.
console.log('\nconfig.html — cada motivo de arranque del sidecar dice algo distinto')
{
  const codigos = ['sidecar-sin-authdir', 'sidecar-sin-permiso', 'sidecar-authdir-fallo',
    'sidecar-no-arranco', 'sidecar-cayo']
  const dicho = new Map()
  for (const code of codigos) {
    const { doc } = await montar('config.html', { sidecar: {
      connection: null, qr: null, exited: true, motivo: code,
      error: { code, detail: 'DETALLE-CRUDO-DEL-WORKER' }
    } }, 'es-419')
    await espera()
    const detalle = doc.getElementById('pairing-detail').textContent.trim()
    ok(`${code}: el panel lo explica en el idioma del usuario, no con el detalle crudo`,
      detalle.length > 0 && detalle !== 'DETALLE-CRUDO-DEL-WORKER', detalle)
    dicho.set(code, detalle)
  }
  ok('y ningun motivo comparte frase con otro: el codigo existe para que la accion que ' +
    'se le pide al usuario sea la que lo saca del pozo',
    new Set(dicho.values()).size === codigos.length,
    JSON.stringify([...dicho.values()]))
  ok('sin permiso, lo que se pide es revisar y activar el plugin',
    /revis/i.test(dicho.get('sidecar-sin-permiso') || ''),
    dicho.get('sidecar-sin-permiso'))
  ok('y sin userData se sigue hablando de la carpeta de datos, que es otro arreglo',
    /datos/i.test(dicho.get('sidecar-sin-authdir') || ''),
    dicho.get('sidecar-sin-authdir'))
}

// ───────── desvincular la linea: el boton que faltaba (§8.1) ─────────
// El auth state es una credencial viva: quien lo tenga lee y escribe como esa cuenta
// sin el telefono. Hasta aca el panel sabia enlazar y no sabia soltar — quien escaneaba
// con el telefono equivocado solo salia borrando un directorio a mano.
console.log('\nconfig.html — desvincular: confirmacion antes de cortar la sesion')
{
  const { doc, storage } = await montar('config.html',
    { sidecar: { connection: 'open', qr: null, exited: false,
      latido: { ts: Date.now(), conectado: true } } }, 'es-419')
  await espera()
  const boton = doc.getElementById('pairing-unlink')
  ok('con la linea conectada, el panel ofrece desvincularla', boton && !boton.hidden,
    boton ? `hidden=${boton.hidden}` : 'el boton no existe')

  // Un clic NO puede desvincular: es irreversible desde el panel y no hay modal donde
  // preguntar (`surface` es un enum cerrado y `window.open` esta anulado, §6).
  boton.click()
  await espera()
  ok('el primer clic no manda nada: pide confirmacion',
    !storage.sidecarRequest, JSON.stringify(storage.sidecarRequest))
  const aviso = doc.getElementById('pairing-warn')
  ok('y dice en voz alta que se pierde', aviso && !aviso.hidden &&
    /escane|qr|codigo/i.test(aviso.textContent), aviso ? aviso.textContent : 'sin aviso')
  ok('el aviso nombra que la sesion se termina, no solo que "se desvincula"',
    aviso && /sesion|credencial/i.test(aviso.textContent),
    aviso ? aviso.textContent : 'sin aviso')

  // Y se puede volver atras: una confirmacion sin salida es una trampa.
  const cancelar = doc.getElementById('pairing-cancel')
  ok('se puede cancelar la confirmacion', cancelar && !cancelar.hidden)
  cancelar.click()
  await espera()
  ok('cancelar no manda nada y esconde el aviso',
    !storage.sidecarRequest && doc.getElementById('pairing-warn').hidden,
    JSON.stringify(storage.sidecarRequest))
}

console.log('\nconfig.html — el segundo clic si manda el pedido, por el canal del worker')
{
  const { doc, storage } = await montar('config.html',
    { sidecar: { connection: 'open', qr: null, exited: false,
      latido: { ts: Date.now(), conectado: true } } }, 'es-419')
  await espera()
  doc.getElementById('pairing-unlink').click()
  await espera()
  doc.getElementById('pairing-unlink').click()
  await espera()
  const pedido = storage.sidecarRequest
  ok('la confirmacion manda el pedido a la clave que mira el worker',
    !!pedido && pedido.action === 'desvincular', JSON.stringify(pedido))
  ok('con un identificador propio: sin el, el panel no distingue el veredicto de SU ' +
    'clic del que quedo del anterior',
    !!pedido && typeof pedido.id === 'string' && pedido.id.length > 0,
    JSON.stringify(pedido))
  ok('y con su marca de tiempo, para que el worker descarte lo de otra sesion',
    !!pedido && typeof pedido.at === 'string' && !isNaN(Date.parse(pedido.at)),
    JSON.stringify(pedido))
}

console.log('\nconfig.html — tras desvincular, la pantalla no sigue diciendo "conectado"')
{
  // El worker contesta el veredicto y deja la clave `sidecar` limpia, que es lo que
  // hace de verdad cuando relanza: sin sesion y esperando un codigo nuevo.
  const storage = { sidecar: { connection: 'open', qr: null, exited: false,
    latido: { ts: Date.now(), conectado: true } } }
  const { doc } = await montar('config.html', storage, 'es-419', (d, st) => {
    if (d.action === 'storage.set' && d.params.key === 'sidecarRequest' && d.params.value) {
      st.sidecarRequest = d.params.value
      st.sidecarResult = { at: new Date().toISOString(), requestId: d.params.value.id,
        action: d.params.value.action, ok: true, code: 'desvinculado' }
      st.sidecar = { connection: null, qr: null, exited: false }
      return { ok: true }
    }
    return undefined
  })
  await espera()
  ok('antes de desvincular la pantalla dice que esta conectado',
    /conectado/i.test(doc.getElementById('pairing-msg').textContent),
    doc.getElementById('pairing-msg').textContent)

  doc.getElementById('pairing-unlink').click()
  await espera()
  doc.getElementById('pairing-unlink').click()
  // El veredicto se sondea: hay que darle una vuelta del sondeo dedicado.
  await new Promise((r) => setTimeout(r, 3000))

  const msg = doc.getElementById('pairing-msg').textContent
  ok('despues de desvincular ya no dice que WhatsApp esta conectado',
    !/conectado/i.test(msg), msg)
  ok('y dice lo que de verdad pasa ahora: esta esperando un codigo nuevo',
    /esperando|codigo/i.test(msg), msg)
  ok('el boton de desvincular ya no se ofrece: no hay sesion que cortar',
    doc.getElementById('pairing-unlink').hidden,
    `hidden=${doc.getElementById('pairing-unlink').hidden}`)
  ok('y la confirmacion queda dicha en pantalla, no solo en el estado',
    doc.getElementById('said-pairing').textContent.length > 0,
    doc.getElementById('said-pairing').textContent)
}

console.log('\nconfig.html — la sesion cerrada desde el telefono ofrece desvincular')
{
  // `sesion-cerrada` no reconecta nunca sola (sidecar/src/index.js, `decidirTrasCierre`):
  // las credenciales que quedaron en disco estan muertas y hay que borrarlas. El texto
  // manda a desvincular «aca abajo», asi que el boton TIENE que estar ahi — un texto que
  // manda a un boton que no existe es peor que no decir nada.
  const { doc } = await montar('config.html', { sidecar: {
    connection: 'close', qr: null, exited: false, motivo: 'sesion-cerrada',
    error: { code: 'sesion-cerrada', detail: 'la sesion se cerro' }
  } }, 'es-419')
  await espera()
  const detalle = doc.getElementById('pairing-detail').textContent
  ok('el panel explica que la sesion se cerro desde el telefono',
    /telefono/i.test(detalle), detalle)
  ok('y ofrece de verdad el boton al que manda el texto',
    !doc.getElementById('pairing-unlink').hidden,
    `hidden=${doc.getElementById('pairing-unlink').hidden}`)
  ok('no ofrece reintentar: reconectar volveria a cerrar la misma sesion',
    doc.getElementById('pairing-retry').hidden,
    `hidden=${doc.getElementById('pairing-retry').hidden}`)
}

// ───────── "conectado" exige que la linea de senales de vida ─────────
// Medido en la maquina del dueno (2026-10-01): ultimo mensaje el 23, ultimo latido del
// sidecar el 30, y el panel diciendo "WhatsApp esta conectado". El "conectado" salia de
// la ultima foto guardada en storage, que no caduca nunca.
console.log('\nconfig.html — "conectado" solo con latido fresco de la linea')
{
  const viejoMs = Date.now() - 10 * 60 * 1000
  const hora = new Date(viejoMs).toTimeString().slice(0, 5)
  const sinSenal = await montar('config.html', { sidecar: { connection: 'open', qr: null,
    exited: false, latido: { ts: viejoMs, conectado: true } } }, 'es-419')
  await espera()
  const msg = sinSenal.doc.getElementById('pairing-msg').textContent
  ok('con el latido viejo NO dice conectado', !/conectado/i.test(msg), msg)
  ok('dice que la linea no da senal', /senal/i.test(msg), msg)
  ok('y desde cuando, con la hora del ultimo latido', msg.includes(hora), `${msg} / ${hora}`)
  ok('y no se pinta en verde', !sinSenal.doc.getElementById('pairing-msg').className.includes('ok'),
    sinSenal.doc.getElementById('pairing-msg').className)
  ok('ofrece reintentar: relanzar es lo que revive una linea muda',
    !sinSenal.doc.getElementById('pairing-retry').hidden,
    `hidden=${sinSenal.doc.getElementById('pairing-retry').hidden}`)

  const nunca = await montar('config.html', { sidecar: { connection: 'open', qr: null,
    exited: false } }, 'es-419')
  await espera()
  ok('sin ningun latido tampoco dice conectado',
    !/conectado/i.test(nunca.doc.getElementById('pairing-msg').textContent),
    nunca.doc.getElementById('pairing-msg').textContent)

  // Control: con latido fresco sigue diciendo conectado. Sin esto, la regla de arriba
  // se cumpliria con un panel que no dice "conectado" nunca.
  const vivo = await montar('config.html', { sidecar: { connection: 'open', qr: null,
    exited: false, latido: { ts: Date.now() - 30000, conectado: true } } }, 'es-419')
  await espera()
  ok('control: con latido de hace 30 s dice conectado',
    /conectado/i.test(vivo.doc.getElementById('pairing-msg').textContent),
    vivo.doc.getElementById('pairing-msg').textContent)
}

// ───────── un 401 ofrece Desvincular aunque el codigo diga otra cosa ─────────
// El storage que quedo en la maquina del dueno: `statusCode: 401` y, encima, el
// `sidecar-cayo` que escribia el `exit`. El panel preferia `error.code` y ofrecia
// Reintentar, que repetia el 401. El 401 manda: la accion es desvincular.
console.log('\nconfig.html — con 401 se ofrece desvincular, no reintentar')
{
  for (const statusCode of [401, 500]) {
    const { doc } = await montar('config.html', { sidecar: { connection: 'close', qr: null,
      exited: true, motivo: 'sidecar-cayo', statusCode,
      error: { code: 'sidecar-cayo', detail: 'sidecar exited (code 0, signal null)' } } },
    'es-419')
    await espera()
    ok(`${statusCode}: ofrece desvincular`, !doc.getElementById('pairing-unlink').hidden,
      `hidden=${doc.getElementById('pairing-unlink').hidden}`)
    ok(`${statusCode}: no ofrece reintentar`, doc.getElementById('pairing-retry').hidden,
      `hidden=${doc.getElementById('pairing-retry').hidden}`)
    ok(`${statusCode}: y explica que la sesion se cerro desde el telefono`,
      /telefono/i.test(doc.getElementById('pairing-detail').textContent),
      doc.getElementById('pairing-detail').textContent)
  }
}

// ───────── los cierres que el sidecar ya no reintenta para siempre ─────────
console.log('\nconfig.html — 440, 403 y 411 se explican, cada uno con su salida')
{
  const casos = [
    // Otro cliente usa la misma sesion: cerrarlo y reintentar, o desvincular.
    { code: 'sesion-reemplazada', retry: true, unlink: true },
    { code: 'acceso-denegado', retry: false, unlink: true },
    { code: 'multidispositivo', retry: false, unlink: true }
  ]
  const dicho = new Set()
  for (const c of casos) {
    const { doc } = await montar('config.html', { sidecar: { connection: 'close', qr: null,
      exited: true, motivo: c.code,
      error: { code: c.code, detail: 'DETALLE-CRUDO-DEL-SIDECAR' } } }, 'es-419')
    await espera()
    const detalle = doc.getElementById('pairing-detail').textContent.trim()
    ok(`${c.code}: se explica en el idioma del panel, no con el detalle crudo`,
      detalle.length > 0 && detalle !== 'DETALLE-CRUDO-DEL-SIDECAR', detalle)
    dicho.add(detalle)
    ok(`${c.code}: ${c.retry ? 'ofrece' : 'no ofrece'} reintentar`,
      doc.getElementById('pairing-retry').hidden === !c.retry,
      `hidden=${doc.getElementById('pairing-retry').hidden}`)
    ok(`${c.code}: ofrece desvincular`, doc.getElementById('pairing-unlink').hidden === !c.unlink,
      `hidden=${doc.getElementById('pairing-unlink').hidden}`)
  }
  ok('y cada uno dice algo distinto', dicho.size === casos.length, JSON.stringify([...dicho]))

  const { window } = await montar('config.html')
  const S = window.STRINGS
  const nuevas = ['pairingSilent', 'pairingSilentHow', 'pairingHowReplaced',
    'pairingHowForbidden', 'pairingHowMultidevice']
  const faltan = nuevas.filter((k) => !S.es[k] || !S.en[k])
  ok('los textos nuevos existen en espanol y en ingles', faltan.length === 0,
    `faltan = ${JSON.stringify(faltan)}`)
  const sinPt = nuevas.filter((k) => !S.pt[k] || S.pt[k] === S.en[k])
  ok('y en portugues propio, no heredado del ingles', sinPt.length === 0,
    `sin portugues = ${JSON.stringify(sinPt)}`)
}

// ───────── T9: cada numero, su linea ─────────
// Visto en vivo (2026-10-01): tras vincular OTRO numero el panel seguia mostrando las
// 305 conversaciones y las autorizaciones del viejo. Lo del numero anterior queda
// guardado, pero el panel no lo pinta como si fuera del vinculado.
const VIEJA = 'pn:573001112233'
const NUEVA = 'pn:573000000012'
const SIDECAR_NUEVA = { connection: 'open', qr: null, exited: false, me: '+573000000012',
  cuenta: NUEVA, latido: { ts: Date.now(), conectado: true } }
console.log('\nconfig.html — T9: el selector y las autorizaciones son de la linea vinculada')
{
  const storage = {
    sidecar: SIDECAR_NUEVA,
    chats: [{ jid: '100@g.us', name: 'Grupo Viejo', kind: 'grupo' }],
    chatsAccount: VIEJA,
    scope: {
      '100@g.us': { chatName: 'Grupo Viejo', mode: 'responder', provider: 'ninguno',
        account: VIEJA },
      // Una de antes de T9, sin cuenta: es de la linea de siempre, no del numero nuevo.
      '300@g.us': { chatName: 'Legado', mode: 'responder', provider: 'ninguno' }
    }
  }
  const { doc } = await montar('config.html', storage, 'es-419')
  await espera()
  listaChats(doc)
  const opciones = opcionesCombo(doc, 'chat-list').map((o) => o.dataset.value)
  ok('el selector no ofrece las conversaciones del numero anterior',
    !opciones.includes('100@g.us'), JSON.stringify(opciones))
  const tabla = doc.getElementById('scope-wrap').textContent
  ok('la tabla de autorizaciones no muestra las del numero anterior',
    !/Grupo Viejo|Legado/.test(tabla), tabla)

  // Llega el sync del numero nuevo: su lista si se ofrece.
  storage.chats = [{ jid: '200@g.us', name: 'Grupo Nuevo', kind: 'grupo' }]
  storage.chatsAccount = NUEVA
  doc.defaultView.dispatchEvent(new doc.defaultView.Event('focus'))
  await espera()
  listaChats(doc)
  const nuevas = opcionesCombo(doc, 'chat-list').map((o) => o.dataset.value)
  ok('control: la lista del numero vinculado si se ofrece', nuevas.includes('200@g.us'),
    JSON.stringify(nuevas))

  // Lo que se autoriza ahora queda etiquetado con el numero vinculado.
  elegirChat(doc, '200@g.us')
  await espera()
  elegirSeg(doc, 'mode', 'observar')
  doc.getElementById('save-scope').click()
  await espera()
  const entrada = (storage.scope || {})['200@g.us']
  ok('la autorizacion nueva queda atada al numero vinculado',
    entrada && entrada.account === NUEVA, JSON.stringify(entrada))
  ok('y las del numero anterior siguen guardadas, sin borrar',
    storage.scope['100@g.us'] && storage.scope['100@g.us'].account === VIEJA,
    JSON.stringify(storage.scope))
}

console.log('\nconfig.html — T10: el chat propio se nombra como en WhatsApp y va primero')
{
  const storage = {
    chats: [
      { jid: '200@g.us', name: 'Grupo Nuevo', kind: 'grupo' },
      { jid: '100000000000002@lid', name: 'Nueva', kind: 'directo', own: true },
      // Sin nombre de linea conocido: el nombre que llega es su jid.
      { jid: '573000000012@s.whatsapp.net', name: '573000000012@s.whatsapp.net',
        kind: 'directo', own: true }
    ]
  }
  const { doc } = await montar('config.html', storage, 'es-419')
  await espera()
  const textos = listaChats(doc)
  ok('el chat propio va primero, con el nombre de la linea y "(tú)"',
    /Nueva \(tú\)/.test(textos[0] || ''), JSON.stringify(textos))
  ok('ninguna opcion muestra un jid pelado', !textos.some((t) => /@lid|@s\.whatsapp\.net/.test(t)),
    JSON.stringify(textos))
  elegirChat(doc, '573000000012@s.whatsapp.net')
  await espera()
  const identidad = doc.getElementById('chat-id').textContent
  const nombre = doc.getElementById('chat').value + ' ' + doc.getElementById('chat-search').value
  ok('elegido, ni el renglon de identidad ni el nombre muestran el jid',
    !/@s\.whatsapp\.net|@lid/.test(identidad + ' ' + nombre), `${identidad} / ${nombre}`)

  const en = await montar('config.html', { chats: storage.chats }, 'en-US')
  await espera()
  const textosEn = listaChats(en.doc)
  ok('en ingles dice "(you)"', /Nueva \(you\)/.test(textosEn[0] || ''), JSON.stringify(textosEn))
}

console.log('\nconfig.html — T10: una migracion que no borro nada no dice que borro')
{
  const { doc } = await montar('config.html', { health: { ok: true, optional: [{
    que: 'message store upgrade', code: 'store-migrated', howCode: 'store-migrated-clean',
    como: 'the message store was upgraded without losing any message' }] } }, 'es-419')
  await espera()
  const texto = doc.getElementById('opcionales').textContent
  ok('el aviso dice que no se perdio ningun mensaje, sin "se borro"',
    /ningun mensaje/i.test(texto) && !/borr/i.test(texto) && !/without losing/.test(texto), texto)
  const { window } = await montar('config.html')
  const S = window.STRINGS
  const nuevas = ['howStoreMigratedClean', 'chatOwnTag', 'chatOwnNoName']
  ok('los textos nuevos estan en los tres idiomas, con portugues propio',
    nuevas.every((k) => S.es[k] && S.en[k] && S.pt[k] && S.pt[k] !== S.en[k]),
    JSON.stringify(nuevas.map((k) => [S.es[k], S.en[k], S.pt && S.pt[k]])))
}

console.log('\nconfig.html — los estados de falla ofrecen reintentar, no reiniciar Orca')
{
  for (const code of ['sidecar-no-arranco', 'sidecar-authdir-fallo', 'sidecar-cayo']) {
    const storage = { sidecar: { connection: null, qr: null, exited: true, motivo: code,
      error: { code, detail: 'DETALLE-CRUDO-DEL-WORKER' } } }
    const { doc } = await montar('config.html', storage, 'es-419')
    await espera()
    const boton = doc.getElementById('pairing-retry')
    ok(`${code}: ofrece un boton para reintentar`, boton && !boton.hidden,
      boton ? `hidden=${boton.hidden}` : 'el boton no existe')
    const detalle = doc.getElementById('pairing-detail').textContent
    ok(`${code}: y ya no manda a reiniciar la aplicacion entera`,
      !/reinici\w* orca/i.test(detalle), detalle)
  }

  // Un permiso denegado NO lo arregla un reintento: lo arregla aprobar el plugin. Un
  // boton que no puede funcionar es peor que ningun boton.
  const { doc: sinPermiso } = await montar('config.html', { sidecar: {
    connection: null, qr: null, exited: true, motivo: 'sidecar-sin-permiso',
    error: { code: 'sidecar-sin-permiso', detail: 'Access to this API has been restricted' }
  } }, 'es-419')
  await espera()
  ok('sin permiso no se ofrece reintentar: lo que falta es aprobar el plugin',
    sinPermiso.getElementById('pairing-retry').hidden,
    `hidden=${sinPermiso.getElementById('pairing-retry').hidden}`)
}

console.log('\nconfig.html — el reintento llega al worker por el mismo canal')
{
  const storage = { sidecar: { connection: null, qr: null, exited: true,
    motivo: 'sidecar-no-arranco',
    error: { code: 'sidecar-no-arranco', detail: 'spawn ENOENT' } } }
  const { doc } = await montar('config.html', storage, 'es-419', (d, st) => {
    if (d.action === 'storage.set' && d.params.key === 'sidecarRequest' && d.params.value) {
      st.sidecarRequest = d.params.value
      st.sidecarResult = { at: new Date().toISOString(), requestId: d.params.value.id,
        action: d.params.value.action, ok: true, code: 'reintentado' }
      st.sidecar = { connection: 'connecting', qr: null, exited: false }
      return { ok: true }
    }
    return undefined
  })
  await espera()
  // Reintentar no es destructivo: sale con un solo clic, sin confirmacion.
  doc.getElementById('pairing-retry').click()
  await espera()
  ok('el reintento sale de un solo clic: no destruye nada que haya que confirmar',
    !!storage.sidecarRequest && storage.sidecarRequest.action === 'reintentar',
    JSON.stringify(storage.sidecarRequest))
  await new Promise((r) => setTimeout(r, 3000))
  ok('y el veredicto del worker se ve en pantalla',
    doc.getElementById('said-pairing').textContent.length > 0,
    doc.getElementById('said-pairing').textContent)
  ok('la pantalla ya no muestra la falla vieja',
    !doc.getElementById('pairing-msg').textContent.match(/caida/i),
    doc.getElementById('pairing-msg').textContent)
}

console.log('\nconfig.html — un pedido sin respuesta se dice, no se traga')
{
  // El worker no contesta nunca: el panel no puede quedarse con el boton en "…" para
  // siempre, que es el spinner eterno que este panel viene arreglando desde el principio.
  const { doc } = await montar('config.html', { sidecar: {
    connection: null, qr: null, exited: true, motivo: 'sidecar-cayo',
    error: { code: 'sidecar-cayo', detail: 'x' } } }, 'es-419')
  await espera()
  const boton = doc.getElementById('pairing-retry')
  boton.click()
  await espera()
  ok('mientras espera, el boton queda ocupado y no admite otro clic', boton.disabled,
    `disabled=${boton.disabled}`)
}

console.log('\nconfig.html — la palabra "sidecar" no se le muestra a nadie')
{
  // `sidecar` es como llamamos al proceso ayudante entre nosotros. Quien instala el
  // plugin no sabe que es, y estas son justo las frases que lee cuando algo salio mal.
  // Los CODIGOS estables (`sidecar-cayo` y los demas) no se tocan: son el contrato.
  const { window } = await montar('config.html')
  const S = window.STRINGS
  const sucias = []
  for (const idioma of ['es', 'en', 'pt']) {
    for (const k of Object.keys(S[idioma])) {
      if (/sidecar/i.test(String(S[idioma][k]))) sucias.push(`${idioma}.${k}`)
    }
  }
  ok('ninguna cadena que el usuario lee nombra al "sidecar"', sucias.length === 0,
    JSON.stringify(sucias))
}

// ───────── el buscador de conversaciones, con los nombres que existen de verdad ─────
// Los tres nombres de abajo estan copiados del almacen de la cuenta viva. Con 296
// conversaciones, encontrar una es LA interaccion diaria del panel, y lo que habia
// comparaba `indexOf` sobre el texto crudo: entre "Lab" y "#2" hay un emoji, y
// "Comite - Cliente -  Sur" trae dos espacios seguidos. Nadie escribe eso.
const CHATS_REALES = [
  { jid: '120363000000000001@g.us', name: 'Lista de espera | Taller Demo \u{1F680} #2', kind: 'grupo' },
  { jid: '120363000000000002@g.us', name: 'Comite - Cliente -  Sur', kind: 'grupo' },
  { jid: '120363000000000003@g.us', name: 'Operaciones internas', kind: 'grupo' },
  { jid: '573000000001@s.whatsapp.net', name: 'Laura Méndez', kind: 'directo' },
  { jid: '573000000002@s.whatsapp.net', name: 'Camila Restrepo', kind: 'directo' }
]

console.log('\nconfig.html — buscar una conversacion como la gente la escribe de verdad')
{
  const { doc } = await montar('config.html', {
    chats: CHATS_REALES,
    scope: {
      '120363000000000002@g.us': { chatName: 'Comite - Cliente -  Sur', provider: 'plane',
        target: 'PMO', mode: 'responder' }
    }
  }, 'es-419')
  await espera()
  const buscar = (texto) => {
    escribir(doc, 'chat-search', texto)
    return opcionesCombo(doc, 'chat-list').map((o) => o.textContent)
  }

  // Tildes: el dueno escribe "mendez" sin tilde y el grupo se llama "Méndez".
  ok('sin tilde encuentra lo que si la tiene',
    buscar('mendez').some((t) => t.includes('Méndez')), JSON.stringify(buscar('mendez')))
  // Emoji y puntuacion en el medio: "taller demo 2" tiene que llegar a
  // "Taller Demo 🚀 #2".
  ok('el emoji y la almohadilla no cortan la busqueda',
    buscar('taller demo 2').some((t) => t.includes('Taller')),
    JSON.stringify(buscar('taller demo 2')))
  // Doble espacio y guiones: nadie los reproduce al escribir.
  ok('los guiones y el espacio de mas no hacen falta',
    buscar('comite cliente sur').some((t) => t.includes('Comite')),
    JSON.stringify(buscar('comite cliente sur')))
  // Y sin recordar el orden, que es como se busca un grupo del que uno recuerda dos
  // palabras sueltas.
  ok('las palabras sueltas valen en cualquier orden',
    buscar('sur comite').some((t) => t.includes('Comite')),
    JSON.stringify(buscar('sur comite')))
  // Lo que NO puede pasar: traer lo que nadie escribio. El fallo caro con 296 filas no
  // es no encontrar la conversacion, es autorizar la equivocada.
  const sueltas = buscar('taller demo 2')
  ok('y no arrastra las que no tienen nada que ver',
    !sueltas.some((t) => t.includes('Operaciones')), JSON.stringify(sueltas))
  ok('sigue diciendo cuantas quedaron',
    /\d+\s+de\s+\d+/.test(doc.getElementById('chat-count').textContent),
    doc.getElementById('chat-count').textContent)
}

// WhatsApp guarda los directos con un id interno (`<digitos>@lid`) y ya no muestra el
// numero: el dueno no distinguia un chat de otro ni lo encontraba por el telefono de su
// agenda. El sidecar anota el telefono de cada LID y la lista lo trae en `phone`.
const CHATS_CON_TELEFONO = [
  { jid: '111122223333@lid', name: 'Persona Guardada', kind: 'directo', phone: '+573007776655' },
  { jid: '111122224444@lid', name: '111122224444@lid', kind: 'directo', phone: '+573000000002' },
  { jid: '111122225555@lid', name: 'Sin Telefono', kind: 'directo', phone: null },
  { jid: '573000000001@s.whatsapp.net', name: 'Laura Mendez', kind: 'directo',
    phone: '+573000000001' },
  { jid: '111122226666@lid', name: 'Socio Norte', kind: 'directo', phone: '+14155550100' },
  { jid: '111122227777@lid', name: 'Socio Sur', kind: 'directo', phone: '+50688888888' },
  { jid: '120363000000000001@g.us', name: 'Soporte Norte', kind: 'grupo', phone: null }
]

for (const idioma of ['es-419', 'en-US']) {
  console.log(`\nconfig.html — el telefono de un directo guardado con su LID (${idioma})`)
  const { doc } = await montar('config.html', { chats: CHATS_CON_TELEFONO }, idioma)
  await espera()
  const buscar = (texto) => {
    escribir(doc, 'chat-search', texto)
    return opcionesCombo(doc, 'chat-list').map((o) => o.textContent)
  }
  const opcion = (jid) => {
    escribir(doc, 'chat-search', '')
    return doc.querySelector(`#chat-list [role="option"][data-value="${jid}"]`)
      ?.textContent || ''
  }

  ok('el telefono va al lado del nombre, con el codigo de pais aparte',
    opcion('111122223333@lid').includes('Persona Guardada') &&
    opcion('111122223333@lid').includes('+57 300 777 6655'), opcion('111122223333@lid'))
  ok('sin nombre, el directo se llama como su telefono y no como su id interno',
    opcion('111122224444@lid').includes('+57 300 000 0002') &&
    !opcion('111122224444@lid').includes('@lid'), opcion('111122224444@lid'))
  ok('y el telefono no se repite cuando ya es el nombre',
    opcion('111122224444@lid').split('+57').length === 2, opcion('111122224444@lid'))
  ok('un directo por telefono tambien lo muestra',
    opcion('573000000001@s.whatsapp.net').includes('+57 300 000 0001'),
    opcion('573000000001@s.whatsapp.net'))
  ok('el formato sirve para cualquier codigo de pais',
    opcion('111122226666@lid').includes('+1 415 555 0100') &&
    opcion('111122227777@lid').includes('+506 8888 8888'),
    `${opcion('111122226666@lid')} | ${opcion('111122227777@lid')}`)
  ok('sin telefono conocido no se inventa ninguno, ni en un grupo',
    !opcion('111122225555@lid').includes('+') &&
    !opcion('120363000000000001@g.us').includes('+'),
    `${opcion('111122225555@lid')} | ${opcion('120363000000000001@g.us')}`)

  // Lo que la gente escribe: el numero como lo tiene en la agenda, con o sin espacios.
  ok('buscar un pedazo del numero con espacios lo encuentra',
    buscar('300 777').some((t) => t.includes('Persona Guardada')), JSON.stringify(buscar('300 777')))
  ok('y los digitos seguidos tambien',
    buscar('3007776655').some((t) => t.includes('Persona Guardada')),
    JSON.stringify(buscar('3007776655')))
  ok('el numero completo, con el +, trae solo esa conversacion',
    buscar('+57 300 777 6655').length === 1, JSON.stringify(buscar('+57 300 777 6655')))

  elegirChat(doc, '111122223333@lid', 'persona')
  ok('elegida, la identidad de abajo dice tambien el telefono',
    doc.getElementById('chat-id').textContent.includes('+57 300 777 6655'),
    doc.getElementById('chat-id').textContent)
}

// WhatsApp mueve un uno a uno del telefono a su LID (lid-sigue-autorizacion): las dos
// formas llegan en la lista con el MISMO telefono, que para el LID sale del par verificado
// de `lid_telefono`. El dueno ve una sola fila, la viva, y lo que guarda va al jid vivo:
// guardarlo en el viejo dejaba la autorizacion donde ya no llega nada.
const LID_VIVO = '100000000000002@lid'
const TEL_VIEJO = '573000000011@s.whatsapp.net'
const CHATS_GEMELOS = [
  // La vieja primero a proposito: la viva se elige por `last`, no por el orden.
  { jid: TEL_VIEJO, name: 'Cliente Uno', kind: 'directo', phone: '+573000000011',
    last: '2026-09-20 10:00' },
  { jid: LID_VIVO, name: 'Cliente Uno', kind: 'directo', phone: '+573000000011',
    last: '2026-10-05 09:00' },
  { jid: '573000000013@s.whatsapp.net', name: 'Otra Persona', kind: 'directo',
    phone: '+573000000013', last: '2026-10-04 10:00' },
  { jid: '120363000000000001@g.us', name: 'Soporte Norte', kind: 'grupo', phone: null,
    last: '2026-10-05 08:00' }
]

for (const idioma of ['es-419', 'en-US']) {
  console.log(`\nconfig.html — la misma persona con su telefono y su LID es una sola fila (${idioma})`)
  {
    const { doc, storage } = await montar('config.html', { chats: CHATS_GEMELOS }, idioma)
    await espera()
    escribir(doc, 'chat-search', '')
    const valores = opcionesCombo(doc, 'chat-list').map((o) => o.dataset.value)
    ok('la lista no muestra a la misma persona dos veces',
      valores.filter((v) => v === LID_VIVO || v === TEL_VIEJO).length === 1,
      JSON.stringify(valores))
    ok('la fila que queda es la viva, con su telefono',
      valores.includes(LID_VIVO) &&
      (doc.querySelector(`#chat-list [data-value="${LID_VIVO}"]`)?.textContent || '')
        .includes('+57 300 000 0011'), JSON.stringify(valores))
    escribir(doc, 'chat-search', '3000000011')
    ok('buscarla por el numero trae una sola', opcionesCombo(doc, 'chat-list').length === 1,
      JSON.stringify(opcionesCombo(doc, 'chat-list').map((o) => o.textContent)))
    ok('las demas siguen en la lista', valores.includes('573000000013@s.whatsapp.net') &&
      valores.includes('120363000000000001@g.us'), JSON.stringify(valores))

    elegirChat(doc, LID_VIVO, '3000000011')
    elegirSeg(doc, 'mode', 'observar')
    doc.getElementById('save-scope').click()
    await espera()
    ok('elegida y guardada, queda en el jid vivo',
      storage.scope?.[LID_VIVO]?.mode === 'observar' && !storage.scope?.[TEL_VIEJO],
      JSON.stringify(storage.scope))
  }

  console.log(`\nconfig.html — editar la autorizacion que quedo en el jid viejo la pasa al vivo (${idioma})`)
  {
    const { doc, storage } = await montar('config.html', {
      chats: CHATS_GEMELOS,
      scope: { [TEL_VIEJO]: { chatName: 'Cliente Uno', provider: 'ninguno', target: null,
        mode: 'responder', tone: 'Formal', notes: 'cliente antiguo' } }
    }, idioma)
    await espera()
    const filas = listaChats(doc)
    const grupos = [...doc.querySelectorAll('#chat-list [role="group"]')]
    ok('la fila viva se ve autorizada, con el permiso que tiene la vieja',
      grupos.length === 2 &&
      [...grupos[0].querySelectorAll('[role="option"]')].map((o) => o.dataset.value)
        .join() === LID_VIVO, JSON.stringify(filas))
    doc.querySelector(`[data-edit="${TEL_VIEJO}"]`).click()
    await espera()
    doc.getElementById('chat-tone').value = 'Formal y breve'
    doc.getElementById('save-scope').click()
    await espera()
    ok('guardar la edicion la deja en el jid vivo, una sola fila',
      storage.scope?.[LID_VIVO]?.tone === 'Formal y breve' && !storage.scope?.[TEL_VIEJO],
      JSON.stringify(storage.scope))
    ok('con todo lo que traia: el permiso y lo que el panel no edita',
      storage.scope?.[LID_VIVO]?.mode === 'responder' &&
      storage.scope?.[LID_VIVO]?.notes === 'cliente antiguo', JSON.stringify(storage.scope))
    ok('la tabla de autorizadas muestra una sola fila',
      doc.querySelectorAll('#scope-wrap tbody tr').length === 1,
      doc.getElementById('scope-wrap').textContent)
  }

  console.log(`\nconfig.html — con las dos formas autorizadas no se unen solas (${idioma})`)
  {
    const { doc, storage } = await montar('config.html', {
      chats: CHATS_GEMELOS,
      scope: {
        [TEL_VIEJO]: { chatName: 'Cliente Uno', provider: 'ninguno', mode: 'responder',
          tone: 'Uno' },
        [LID_VIVO]: { chatName: 'Cliente Uno', provider: 'ninguno', mode: 'observar',
          tone: 'Otro' }
      }
    }, idioma)
    await espera()
    doc.querySelector(`[data-edit="${TEL_VIEJO}"]`).click()
    await espera()
    doc.getElementById('chat-tone').value = 'Uno editado'
    doc.getElementById('save-scope').click()
    await espera()
    ok('editar una guarda esa, sin pisar la otra',
      storage.scope?.[TEL_VIEJO]?.tone === 'Uno editado' &&
      storage.scope?.[LID_VIVO]?.tone === 'Otro', JSON.stringify(storage.scope))
  }

  console.log(`\nconfig.html — una conversacion sin gemela se guarda como siempre (${idioma})`)
  {
    const { doc, storage } = await montar('config.html', { chats: CHATS_GEMELOS }, idioma)
    await espera()
    elegirChat(doc, '573000000013@s.whatsapp.net', 'otra')
    elegirSeg(doc, 'mode', 'borrador')
    doc.getElementById('save-scope').click()
    await espera()
    ok('queda en su jid', storage.scope?.['573000000013@s.whatsapp.net']?.mode === 'borrador' &&
      Object.keys(storage.scope || {}).length === 1, JSON.stringify(storage.scope))
  }
}

console.log('\nconfig.html — las tres que importan no se pierden entre las 296')
{
  const { doc } = await montar('config.html', {
    chats: CHATS_REALES,
    scope: {
      '120363000000000002@g.us': { chatName: 'Comite - Cliente -  Sur', provider: 'plane',
        target: 'PMO', mode: 'responder' },
      '573000000001@s.whatsapp.net': { chatName: 'Laura Méndez', provider: 'ninguno',
        target: null, mode: 'observar' }
    }
  }, 'es-419')
  await espera()
  listaChats(doc)
  const grupos = [...doc.querySelectorAll('#chat-list [role="group"]')]
  const opcionesDe = (g) => [...g.querySelectorAll('[role="option"]')]
  const rotulo = (g) => g.getAttribute('aria-label')
  ok('la lista separa lo autorizado de lo que no', grupos.length === 2,
    JSON.stringify(grupos.map(rotulo)))
  ok('y lo autorizado va primero: son las que el dueno vuelve a tocar',
    grupos.length === 2 && opcionesDe(grupos[0]).length === 2 &&
    opcionesDe(grupos[0]).every((o) => /Comite|Méndez/.test(o.textContent)),
    JSON.stringify(grupos.map((g) => opcionesDe(g).map((o) => o.textContent))))
  ok('cada una dice con que permiso quedo, no solo que esta autorizada',
    grupos.length === 2 &&
    opcionesDe(grupos[0]).some((o) => /Automatico/.test(o.textContent)) &&
    opcionesDe(grupos[0]).some((o) => /Solo leer/.test(o.textContent)),
    JSON.stringify(grupos.length ? opcionesDe(grupos[0]).map((o) => o.textContent) : []))
  ok('las etiquetas de los dos grupos estan en espanol, no en ingles',
    grupos.length === 2 && !/authori/i.test(grupos.map(rotulo).join(' ')),
    JSON.stringify(grupos.map(rotulo)))

  // §11-A1: el nombre visible NO es identidad. Antes de autorizar hay que poder ver
  // cual conversacion es, y la unica respuesta es la llave.
  elegirChat(doc, '573000000001@s.whatsapp.net')
  await espera()
  const identidad = doc.getElementById('chat-id')
  ok('al elegir una, el panel muestra su identificador y no solo el nombre',
    identidad && identidad.textContent.includes('573000000001@s.whatsapp.net'),
    identidad ? identidad.textContent : 'no existe #chat-id')
  ok('y avisa que esa ya estaba autorizada, antes de volver a guardarla',
    identidad && /Solo leer/.test(identidad.textContent),
    identidad ? identidad.textContent : '')
}

console.log('\nconfig.html — quitar una autorizacion pasa por el worker y no miente')
{
  // El defecto medido: el panel borraba de SU storage, decia "✓ quitada", y la fila
  // seguia en `scope.db`. Los CLIs leen la mezcla de los dos, asi que la conversacion
  // seguia autorizada. Una autorizacion que el dueno cree revocada y sigue en pie le da
  // permiso a un agente para actuar en la conversacion de un cliente.
  const storage = {
    chats: CHATS_REALES,
    scope: {
      '120363000000000002@g.us': { chatName: 'Comite - Cliente -  Sur', provider: 'plane',
        target: 'PMO', mode: 'responder' }
    }
  }
  let pedido = null
  const { doc } = await montar('config.html', storage, 'es-419', (d, st) => {
    if (d.action === 'storage.set' && d.params.key === 'scopeRequest' && d.params.value) {
      pedido = d.params.value
      st.scopeRequest = d.params.value
      // El worker de verdad corre `wa-scope rm`, que borra en los DOS registros, y
      // recien despues deja el veredicto.
      st.scope = {}
      st.scopeResult = { at: new Date().toISOString(), requestId: d.params.value.id,
        action: d.params.value.action, ok: true, code: 'quitado' }
      return { ok: true }
    }
    return undefined
  })
  await espera()
  const quitar = doc.getElementById('scope-wrap').querySelector('[data-rm]')
  ok('la tabla ofrece quitar la conversacion', !!quitar,
    doc.getElementById('scope-wrap').textContent)
  quitar.click()
  await espera()
  ok('el clic manda el pedido a la clave que mira el worker, no borra por su cuenta',
    !!pedido && pedido.action === 'quitar' &&
    pedido.jid === '120363000000000002@g.us', JSON.stringify(pedido))
  ok('con su identificador y su marca de tiempo, como el resto del canal',
    !!pedido && typeof pedido.id === 'string' && pedido.id.length > 0 &&
    !isNaN(Date.parse(pedido.at)), JSON.stringify(pedido))
  // El veredicto se sondea cada 2 s.
  await new Promise((r) => setTimeout(r, 3000))
  ok('cuando el worker confirma, el panel lo dice',
    /✓/.test(doc.getElementById('said-scope-rm').textContent),
    doc.getElementById('said-scope-rm').textContent)
  ok('y la fila desaparece de la tabla',
    !doc.getElementById('scope-wrap').querySelector('[data-rm]'),
    doc.getElementById('scope-wrap').textContent)
}

console.log('\nconfig.html — un quitado que el worker NO pudo hacer no se anuncia como hecho')
{
  const storage = {
    chats: CHATS_REALES,
    scope: {
      '120363000000000002@g.us': { chatName: 'Comite - Cliente -  Sur', provider: 'plane',
        target: 'PMO', mode: 'responder' }
    }
  }
  const { doc } = await montar('config.html', storage, 'es-419', (d, st) => {
    if (d.action === 'storage.set' && d.params.key === 'scopeRequest' && d.params.value) {
      st.scopeRequest = d.params.value
      // El CLI no estaba. La autorizacion sigue EN PIE, y eso es lo que hay que decir.
      st.scopeResult = { at: new Date().toISOString(), requestId: d.params.value.id,
        action: d.params.value.action, ok: false, code: 'sin-herramientas',
        detail: 'spawn wa-scope ENOENT' }
      return { ok: true }
    }
    return undefined
  })
  await espera()
  doc.getElementById('scope-wrap').querySelector('[data-rm]').click()
  await new Promise((r) => setTimeout(r, 3000))
  const dicho = doc.getElementById('said-scope-rm')
  ok('no dice que la quito', !/✓/.test(dicho.textContent), dicho.textContent)
  ok('lo dice como un fallo', /bad/.test(dicho.className), dicho.className)
  ok('y en espanol, no con el texto crudo del CLI',
    !/spawn|ENOENT/.test(dicho.textContent) && dicho.textContent.length > 0,
    dicho.textContent)
  ok('la fila sigue en la tabla: la autorizacion sigue en pie',
    !!doc.getElementById('scope-wrap').querySelector('[data-rm]'),
    doc.getElementById('scope-wrap').textContent)
  ok('y el alcance no se toco', !!storage.scope['120363000000000002@g.us'],
    JSON.stringify(storage.scope))
}

console.log('\nconfig.html — skills-globales: la pestana Skills instala, actualiza y quita')
{
  const pedidos = []
  const archivo = (base) => `${base}/.claude/skills/whatsapp-avisos/SKILL.md`
  const fila = (extra) => ({ accepted: true, ...extra })
  const storage = {
    projects: PROYECTOS_PRUEBA,
    skillsStatus: { ok: true, at: new Date().toISOString(), version: '4.18.1', skills: [{
      name: 'whatsapp-avisos', description: 'Notify the owner on WhatsApp.',
      targets: [
        fila({ scope: 'global', file: archivo('/home/demo'), state: 'not-installed' }),
        fila({ scope: 'project', project: 'alfa-demo', name: 'Alfa Demo',
          path: '/srv/ejemplo/alfa-demo', file: archivo('/srv/ejemplo/alfa-demo'),
          state: 'installed', version: '4.18.1', yours: ['Rules'] }),
        fila({ scope: 'project', project: 'beta-demo', name: 'Beta Demo',
          path: '/srv/ejemplo/beta-demo', file: archivo('/srv/ejemplo/beta-demo'),
          state: 'outdated', version: '4.17.0', yours: [] }),
        { scope: 'project', project: 'viejo-demo', name: 'Viejo Demo', accepted: false,
          path: '/srv/ejemplo/viejo-demo', file: archivo('/srv/ejemplo/viejo-demo'),
          state: 'installed', version: '4.18.1', yours: [] },
        fila({ scope: 'project', project: 'gama-demo', name: 'Gama Demo',
          path: '/srv/ejemplo/gama-demo', file: archivo('/srv/ejemplo/gama-demo'), state: 'foreign' })
      ] }] }
  }
  const { doc } = await montar('config.html', storage, 'es-419', (d, st) => {
    if (!(d.action === 'storage.set' && d.params.key === 'scopeRequest' && d.params.value)) {
      return undefined
    }
    const p = d.params.value
    pedidos.push(p)
    st.scopeRequest = p
    const ts = st.skillsStatus.skills[0].targets
    const de = (x) => ts.find((t) => (p.target === 'global' ? t.scope === 'global' : t.project === p.project))
    let r = { ok: true, code: 'skills-leidas' }
    if (p.action === 'skill-instalar') {
      const t = de(p)
      r = { ok: true, code: t.state === 'not-installed' ? 'skill-instalada' : 'skill-actualizada' }
      Object.assign(t, { state: 'installed', version: '4.18.1', yours: [] })
    } else if (p.action === 'skill-quitar') {
      const t = de(p)
      if ((t.yours || []).length && p.force !== true) {
        r = { ok: false, code: 'skill-editada', yours: t.yours }
      } else {
        Object.assign(t, { state: 'not-installed', yours: [] })
        r = { ok: true, code: 'skill-quitada' }
      }
    }
    st.scopeResult = { at: new Date().toISOString(), requestId: p.id, action: p.action, ...r }
    return { ok: true }
  })
  await espera()
  doc.getElementById('tab-skills').click()
  await espera()
  ok('abrir la pestana pide al worker el estado de las skills',
    pedidos.some((p) => p.action === 'skills-estado'), JSON.stringify(pedidos))
  await new Promise((r) => setTimeout(r, 400))
  const caja = doc.getElementById('skills-wrap')
  const filaDe = (clave) => caja.querySelector(`[data-sk-target="${clave}"]`)
  const botones = (clave) => [...(filaDe(clave)?.querySelectorAll('button') || [])]
    .filter((b) => !b.hidden).map((b) => b.dataset.skAct)
  ok('la skill sale con su nombre y su explicacion en espanol',
    caja.textContent.includes('whatsapp-avisos') && /le avisan por WhatsApp/.test(caja.textContent),
    caja.textContent.slice(0, 300))
  ok('global sin instalar ofrece Instalar globalmente',
    /Sin instalar/.test(filaDe('global')?.textContent) &&
    JSON.stringify(botones('global')) === '["install"]' &&
    /Instalar globalmente/.test(filaDe('global')?.textContent), filaDe('global')?.textContent)
  ok('un proyecto instalado dice su version y las secciones que el dueno edito, y ofrece Quitar',
    /Instalada/.test(filaDe('project:alfa-demo')?.textContent) &&
    /4\.18\.1/.test(filaDe('project:alfa-demo')?.textContent) &&
    /Rules/.test(filaDe('project:alfa-demo')?.textContent) &&
    JSON.stringify(botones('project:alfa-demo')) === '["remove"]',
    filaDe('project:alfa-demo')?.textContent)
  ok('uno desactualizado ofrece Actualizar y Quitar',
    /Desactualizada/.test(filaDe('project:beta-demo')?.textContent) &&
    JSON.stringify(botones('project:beta-demo')) === '["update","remove"]',
    filaDe('project:beta-demo')?.textContent)
  ok('un proyecto que salio del catalogo se sigue listando para quitar la skill',
    /ya no esta en sus proyectos/.test(filaDe('project:viejo-demo')?.textContent) &&
    JSON.stringify(botones('project:viejo-demo')) === '["remove"]',
    filaDe('project:viejo-demo')?.textContent)
  ok('un archivo ajeno se explica y no ofrece ningun boton',
    /no escribio el plugin/.test(filaDe('project:gama-demo')?.textContent) &&
    botones('project:gama-demo').length === 0, filaDe('project:gama-demo')?.textContent)
  ok('dice que instalar en un proyecto deja un archivo en su repositorio, y como sacarlo de git',
    /\.gitignore/.test(doc.getElementById('view-skills').textContent))

  filaDe('global').querySelector('[data-sk-act="install"]').click()
  await new Promise((r) => setTimeout(r, 400))
  const inst = pedidos.find((p) => p.action === 'skill-instalar')
  ok('Instalar globalmente manda solo la skill y el destino, sin rutas',
    inst && inst.skill === 'whatsapp-avisos' && inst.target === 'global' &&
    !('path' in inst) && !('file' in inst), JSON.stringify(inst))
  ok('y despues del veredicto la fila dice Instalada, con su confirmacion',
    /Instalada/.test(filaDe('global')?.textContent) &&
    JSON.stringify(botones('global')) === '["remove"]' &&
    /Instalada/.test(doc.getElementById('said-skills').textContent),
    filaDe('global')?.textContent + ' | ' + doc.getElementById('said-skills').textContent)

  filaDe('project:beta-demo').querySelector('[data-sk-act="update"]').click()
  await new Promise((r) => setTimeout(r, 400))
  const upd = pedidos.filter((p) => p.action === 'skill-instalar').pop()
  ok('Actualizar pide instalar sobre ese proyecto, por su id',
    upd && upd.project === 'beta-demo' && !('path' in upd) &&
    /Instalada/.test(filaDe('project:beta-demo')?.textContent), JSON.stringify(upd))

  filaDe('project:alfa-demo').querySelector('[data-sk-act="remove"]').click()
  await new Promise((r) => setTimeout(r, 400))
  const q1 = pedidos.filter((p) => p.action === 'skill-quitar').pop()
  ok('Quitar pide sin forzar', q1 && q1.project === 'alfa-demo' && q1.force !== true,
    JSON.stringify(q1))
  ok('con cambios del dueno, avisa cuales se pierden y pide confirmar',
    /Rules/.test(filaDe('project:alfa-demo')?.textContent) &&
    /se pierden/.test(filaDe('project:alfa-demo')?.textContent) &&
    JSON.stringify(botones('project:alfa-demo')) === '["force","cancel"]',
    filaDe('project:alfa-demo')?.textContent)
  filaDe('project:alfa-demo').querySelector('[data-sk-act="force"]').click()
  await new Promise((r) => setTimeout(r, 400))
  const q2 = pedidos.filter((p) => p.action === 'skill-quitar').pop()
  ok('confirmar manda force y la fila queda sin instalar',
    q2 && q2.force === true && q2.project === 'alfa-demo' &&
    /Sin instalar/.test(filaDe('project:alfa-demo')?.textContent), JSON.stringify(q2))

  const S = doc.defaultView.STRINGS
  const claves = Object.keys(S.es).filter((k) => /^(skill|tabSkills)/.test(k))
  const sinPt = claves.filter((k) => !S.pt[k] || (S.pt[k] === S.en[k] && k !== 'tabSkills'))
  ok('los textos de Skills estan en los tres idiomas, con portugues propio',
    claves.length > 15 && claves.every((k) => S.en[k]) && sinPt.length === 0,
    JSON.stringify({ n: claves.length, sinPt }))
}

console.log('\nconfig.html — T12: el catalogo de proyectos se busca, se acepta y se quita')
{
  const PROPUESTAS = [{ id: 'gama-demo', name: 'Gama Demo', path: '/srv/ejemplo/gama-demo' }]
  const pedidos = []
  const storage = {
    projects: [PROYECTOS_PRUEBA[0]],
    projectsStatus: { at: new Date().toISOString(), ok: true, proposals: PROPUESTAS,
      reason: null, detail: null }
  }
  const { doc } = await montar('config.html', storage, 'es-419', (d, st) => {
    if (!(d.action === 'storage.set' && d.params.key === 'scopeRequest' && d.params.value)) {
      return undefined
    }
    const p = d.params.value
    pedidos.push(p)
    st.scopeRequest = p
    // El worker de verdad pregunta a Orca, guarda y recien despues deja el veredicto.
    let r = { ok: true, code: 'refrescado' }
    if (p.action === 'proyectos-aceptar') {
      st.projects = [...st.projects, { ...PROPUESTAS[0], note: '' }]
      st.projectsStatus = { ...st.projectsStatus, proposals: [] }
      r = { ok: true, code: 'aceptado', added: 1 }
    } else if (p.action === 'proyectos-quitar') {
      st.projects = st.projects.filter((x) => x.id !== p.project)
      r = { ok: true, code: 'quitado' }
    } else if (p.action === 'proyectos-nota') {
      st.projects = st.projects.map((x) => (x.id === p.project ? { ...x, note: p.note } : x))
      r = { ok: true, code: 'nota-guardada' }
    }
    st.scopeResult = { at: new Date().toISOString(), requestId: p.id, action: p.action, ...r }
    return { ok: true }
  })
  await espera()
  const lista = doc.getElementById('projects-wrap')
  ok('la lista muestra los proyectos aceptados con su nombre y su ruta',
    lista.textContent.includes('Alfa Demo') && lista.textContent.includes('/srv/ejemplo/alfa-demo'),
    lista.textContent)
  ok('cada proyecto trae su nota, editable',
    doc.querySelector('[data-pnote="alfa-demo"]')?.value === 'Tienda en linea')
  ok('las propuestas de Orca se listan aparte, con su boton',
    doc.getElementById('proposals-wrap').textContent.includes('Gama Demo') &&
    !!doc.querySelector('[data-padd="gama-demo"]'), doc.getElementById('proposals-wrap').textContent)
  ok('lo que Orca propone NO esta aceptado hasta que el dueno lo pide',
    !lista.textContent.includes('Gama Demo'))

  doc.getElementById('projects-refresh').click()
  await espera()
  ok('Buscar manda el pedido por el canal del worker',
    pedidos.length === 1 && pedidos[0].action === 'proyectos-refrescar' &&
    typeof pedidos[0].id === 'string' && !isNaN(Date.parse(pedidos[0].at)),
    JSON.stringify(pedidos))
  await new Promise((r) => setTimeout(r, 3000))

  doc.querySelector('[data-padd="gama-demo"]').click()
  await espera()
  ok('Agregar manda solo el id: el nombre y la ruta los pone el worker, desde Orca',
    pedidos.length === 2 && pedidos[1].action === 'proyectos-aceptar' &&
    JSON.stringify(pedidos[1].ids) === JSON.stringify(['gama-demo']) &&
    !('path' in pedidos[1]) && !('name' in pedidos[1]), JSON.stringify(pedidos[1]))
  await new Promise((r) => setTimeout(r, 3000))
  ok('cuando el worker confirma, el proyecto pasa a la lista aceptada',
    doc.getElementById('projects-wrap').textContent.includes('Gama Demo') &&
    !doc.getElementById('proposals-wrap').textContent.includes('Gama Demo'),
    doc.getElementById('projects-wrap').textContent)
  ok('y se puede elegir en el selector de proyecto de las conversaciones',
    proyectosOfrecidos(doc, 'workspace').includes('gama-demo'))
  ok('y en el de las reglas',
    proyectosOfrecidos(doc, 'r-workspace').includes('gama-demo'))
  ok('el panel lo dice con una marca de exito',
    /✓/.test(doc.getElementById('said-projects').textContent),
    doc.getElementById('said-projects').textContent)

  const nota = doc.querySelector('[data-pnote="alfa-demo"]')
  nota.value = 'Cobros y envios'
  doc.querySelector('[data-psave="alfa-demo"]').click()
  await espera()
  ok('Guardar nota manda el id y el texto',
    pedidos[2]?.action === 'proyectos-nota' && pedidos[2].project === 'alfa-demo' &&
    pedidos[2].note === 'Cobros y envios', JSON.stringify(pedidos[2]))
  await new Promise((r) => setTimeout(r, 3000))
  ok('y la nota queda en lo aceptado',
    storage.projects.find((x) => x.id === 'alfa-demo').note === 'Cobros y envios')

  doc.querySelector('[data-prm="alfa-demo"]').click()
  await espera()
  ok('Quitar manda el id al worker',
    pedidos[3]?.action === 'proyectos-quitar' && pedidos[3].project === 'alfa-demo',
    JSON.stringify(pedidos[3]))
  await new Promise((r) => setTimeout(r, 3000))
  ok('cuando el worker confirma, el proyecto sale de la lista y del selector',
    !doc.getElementById('projects-wrap').textContent.includes('Alfa Demo') &&
    !proyectosOfrecidos(doc, 'workspace').includes('alfa-demo'),
    doc.getElementById('projects-wrap').textContent)
}

console.log('\nconfig.html — T12: un fallo al buscar se dice, y sin proyectos el selector lo explica')
{
  const { doc } = await montar('config.html', {
    projectsStatus: { at: new Date().toISOString(), ok: false, proposals: [],
      reason: 'sin-cli-orca', detail: 'spawn orca ENOENT' }
  }, 'es-419')
  await espera()
  const caja = doc.getElementById('proposals-wrap').textContent + doc.getElementById('projects-status').textContent
  ok('sin la CLI de Orca lo dice en espanol y no con el texto crudo',
    /CLI de Orca/.test(caja) && !/ENOENT|spawn/.test(caja), caja)
  ok('no finge una lista vacia de propuestas',
    !/no hay proyectos nuevos/i.test(caja), caja)
  ok('sin proyectos aceptados la lista lo dice',
    /todavia no/i.test(doc.getElementById('projects-wrap').textContent),
    doc.getElementById('projects-wrap').textContent)
  const ofrecidos = proyectosOfrecidos(doc, 'workspace')
  ok('y el selector de proyecto solo ofrece Sin proyecto',
    JSON.stringify(ofrecidos) === JSON.stringify(['']), JSON.stringify(ofrecidos))
  ok('con una pista que manda a agregar uno',
    /Proyectos|proyecto/.test(doc.getElementById('workspace-hint').textContent) &&
    /todavia no|agregue/i.test(doc.getElementById('workspace-hint').textContent),
    doc.getElementById('workspace-hint').textContent)
  ok('las reglas no se pueden crear sin un proyecto al que mandar',
    doc.getElementById('r-workspace-search').disabled)

  const sinBuscar = await montar('config.html', {}, 'es-419')
  await espera()
  ok('antes de la primera busqueda invita a buscar',
    /Buscar proyectos/.test(sinBuscar.doc.getElementById('proposals-wrap').textContent +
      sinBuscar.doc.getElementById('projects-status').textContent),
    sinBuscar.doc.getElementById('proposals-wrap').textContent)

  const sinNuevos = await montar('config.html', {
    projectsStatus: { at: new Date().toISOString(), ok: true, proposals: [], reason: null,
      detail: null }
  }, 'es-419')
  await espera()
  ok('una busqueda sin nada nuevo lo dice',
    /no hay proyectos nuevos/i.test(sinNuevos.doc.getElementById('proposals-wrap').textContent +
      sinNuevos.doc.getElementById('projects-status').textContent))
}

console.log('\nconfig.html — T13: lo de antes se conserva y un proyecto quitado no se pierde al editar')
{
  const storage = {
    projects: [PROYECTOS_PRUEBA[0]],
    scope: {
      '10@g.us': { chatName: 'Legado', provider: 'plane', target: 'SOP', mode: 'responder' },
      '20@g.us': { chatName: 'Huerfana', provider: 'ninguno', target: null,
        workspace: 'viejo-demo', mode: 'observar' }
    },
    routes: [{ pattern: 'cobros', provider: 'plane', target: 'FIN' }]
  }
  const { doc } = await montar('config.html', storage, 'es-419')
  await espera()
  const filas = [...doc.getElementById('scope-wrap').querySelectorAll('tbody tr')]
  const fila = (txt) => filas.find((f) => f.textContent.includes(txt))
  ok('una conversacion de antes no muestra servicio ni destino: solo falta el proyecto',
    fila('Legado') && !/plane|SOP/i.test(fila('Legado').textContent) &&
    /—/.test(fila('Legado').textContent), fila('Legado')?.textContent)
  ok('un proyecto que ya no esta se ve como tal, con su id',
    fila('Huerfana') && /viejo-demo/.test(fila('Huerfana').textContent) &&
    /ya no esta/i.test(fila('Huerfana').textContent), fila('Huerfana')?.textContent)
  ok('una regla de antes se sigue viendo, para poder quitarla',
    /FIN/.test(doc.getElementById('routes-wrap').textContent),
    doc.getElementById('routes-wrap').textContent)

  fila('Legado').querySelector('[data-edit]').click()
  await espera()
  elegirProyecto(doc, 'workspace', 'alfa-demo')
  doc.getElementById('save-scope').click()
  await espera()
  ok('editar una conversacion de antes le pone proyecto y NO borra lo viejo',
    storage.scope['10@g.us'].workspace === 'alfa-demo' &&
    storage.scope['10@g.us'].provider === 'plane' && storage.scope['10@g.us'].target === 'SOP',
    JSON.stringify(storage.scope['10@g.us']))

  const f2 = [...doc.getElementById('scope-wrap').querySelectorAll('tbody tr')]
    .find((f) => f.textContent.includes('Huerfana'))
  f2.querySelector('[data-edit]').click()
  await espera()
  ok('editar una con un proyecto que ya no esta lo deja elegido',
    doc.getElementById('workspace').value === 'viejo-demo' &&
    /viejo-demo/.test(doc.getElementById('workspace-search').value),
    `workspace = ${doc.getElementById('workspace').value}`)
  ok('y la lista lo ofrece, marcado, para poder dejarlo',
    proyectosOfrecidos(doc, 'workspace').includes('viejo-demo'))
  doc.getElementById('save-scope').click()
  await espera()
  ok('y guardar sin tocarlo no lo borra: el proyecto puede volver',
    storage.scope['20@g.us'].workspace === 'viejo-demo',
    JSON.stringify(storage.scope['20@g.us']))
  doc.querySelector('[data-edit]').click()
  await espera()
  elegirProyecto(doc, 'workspace', '')
  doc.getElementById('save-scope').click()
  await espera()
  ok('Sin proyecto lo quita de verdad, con null y no con un texto vacio',
    Object.values(storage.scope).some((e) => 'workspace' in e && e.workspace === null),
    JSON.stringify(storage.scope))
}

console.log('\nconfig.html — T13: los modos se llaman distinto en cada idioma')
{
  const nombres = async (idioma) => {
    const { doc } = await montar('config.html', {}, idioma)
    await espera()
    return textosSeg(doc, 'mode')
  }
  const en = await nombres('en-US')
  ok('en ingles', /^Off/.test(en.off) && /^Read only/.test(en.observar) &&
    /^Ask me first/.test(en.borrador) && /^Automatic/.test(en.responder), JSON.stringify(en))
  const pt = await nombres('pt-BR')
  ok('en portugues', /^Desligado/.test(pt.off) && /^So ler/.test(pt.observar) &&
    /^Pergunto antes/.test(pt.borrador) && /^Automatico/.test(pt.responder), JSON.stringify(pt))
}

console.log('\nconfig.html — T12/T13: los textos nuevos existen en los tres idiomas')
{
  const { window } = await montar('config.html')
  const S = window.STRINGS
  const nuevas = ['projectsLegend', 'projectsHelp', 'projectsEmpty', 'projectsRefresh',
    'projectsAdd', 'projectsNotePh', 'projectsSaveNote', 'projectsProposed',
    'projectsNoNew', 'projectsNotAsked', 'projectsChecked', 'projectAdded',
    'projectRemoved', 'projectNoteSaved', 'projNoCli', 'projNoPerm', 'projSlow',
    'projFail', 'projNoJson', 'projNoChange', 'projGone', 'projFull', 'workspaceLabel',
    'workspaceNone', 'workspaceMissing', 'workspaceHint', 'workspaceHintNoProjects',
    'colProject', 'routesNeedProject', 'modeOff', 'modeObserve', 'modeDraft', 'modeReply',
    'off', 'observe', 'draft', 'reply']
  const faltan = nuevas.filter((k) => !S.es[k] || !S.en[k])
  ok('cada texto nuevo existe en espanol y en ingles', faltan.length === 0,
    `faltan = ${JSON.stringify(faltan)}`)
  const sinPt = nuevas.filter((k) => !S.pt[k] || S.pt[k] === S.en[k])
  ok('y en portugues propio, no heredado del ingles', sinPt.length === 0,
    `sin portugues = ${JSON.stringify(sinPt)}`)
}

console.log('\nconfig.html — las traducciones de desvincular estan en los tres idiomas')
{
  const { window } = await montar('config.html')
  const S = window.STRINGS
  const nuevas = ['pairingUnlink', 'pairingUnlinkConfirm', 'pairingUnlinkCancel',
    'pairingUnlinkWarn', 'pairingUnlinked', 'pairingRetry', 'pairingRetried',
    'pairingNoAnswer', 'pairingHowUnlinkFailed',
    // Lo nuevo de esta vuelta: los dos grupos del selector, el aviso de "ya estaba
    // autorizada" y el fallo de quitar.
    'chatGroupOn', 'chatGroupOff', 'chatAlready', 'scopeRmFail']
  const faltan = nuevas.filter((k) => !S.es[k] || !S.en[k])
  ok('cada texto nuevo existe en espanol y en ingles', faltan.length === 0,
    `faltan = ${JSON.stringify(faltan)}`)
  const sinPt = nuevas.filter((k) => !S.pt[k] || S.pt[k] === S.en[k])
  ok('y en portugues propio, no heredado del ingles', sinPt.length === 0,
    `sin portugues = ${JSON.stringify(sinPt)}`)
}

console.log('\nconfig.html — las traducciones de la espera larga y "Comprobar ahora" ' +
  'estan en los tres idiomas')
{
  const { window } = await montar('config.html')
  const S = window.STRINGS
  const nuevas = ['pairingWaitingElapsed', 'pairingWaitingLong', 'pairingKnownWorkerUp',
    'pairingKnownWorkerDown', 'pairingKnownConnConnecting', 'pairingKnownConnSilent',
    'pairingRefresh', 'pairingChecked']
  const faltan = nuevas.filter((k) => !S.es[k] || !S.en[k])
  ok('cada texto nuevo existe en espanol y en ingles', faltan.length === 0,
    `faltan = ${JSON.stringify(faltan)}`)
  const sinPt = nuevas.filter((k) => !S.pt[k] || S.pt[k] === S.en[k])
  ok('y en portugues propio, no heredado del ingles', sinPt.length === 0,
    `sin portugues = ${JSON.stringify(sinPt)}`)
}

// ── El panel de actividad deja de contradecirse y dice lo que pasa ─────────────────
// Lo que el dueno veia en pantalla, con dos menciones suyas listadas JUSTO DEBAJO:
//
//     WAITING ON YOU
//     Checked 1 conversation · nothing pending · 2026-09-23 17:36
//
// `r.pending` es de la ULTIMA CORRIDA y la lista se pinta con `activity.pending`, que
// se actualiza en cada sync. Un panel que se contradice consigo mismo no se cree ni
// cuando acierta.
console.log('\nactivity.html — la cabecera no puede contradecir a la lista')
{
  const pendientes = [
    { stanzaId: 'M1', date: '2026-09-23 17:35', chat: 'Equipo Operaciones',
      chatJid: '120363000000000001@g.us', sender: 'Pedro Gomez', kind: 'mencion',
      text: '@yo Como vas?' },
    { stanzaId: 'M2', date: '2026-09-23 17:35', chat: 'Equipo Operaciones',
      chatJid: '120363000000000001@g.us', sender: 'Pedro Gomez', kind: 'mencion',
      text: '@yo ya hiciste las tareas?' }
  ]
  const actividad = {
    pending: pendientes, recent: [], running: false, syncedAt: '2026-09-23 17:41',
    mapped: 1, authorized: 1,
    // La corrida vieja: miro 1 conversacion y ENTONCES no habia nada.
    run: { state: 'ok', startedAt: '2026-09-23 17:34', endedAt: '2026-09-23 17:36',
      looked: 1, pending: 0, reason: null }
  }
  const { doc } = await montar('activity.html', { activity: actividad }, 'es-419')
  await espera()
  const linea = doc.getElementById('runline').textContent
  ok('con dos pendientes a la vista, la cabecera no cuenta la cola vieja',
    !/nada pendiente|esperando/i.test(linea), linea)

  // Y cuando de verdad no hay nada, se sigue diciendo.
  const vacio = await montar('activity.html',
    { activity: Object.assign({}, actividad, { pending: [] }) }, 'es-419')
  await espera()
  ok('sin pendientes tampoco inventa un numero',
    !/esperando/i.test(vacio.doc.getElementById('runline').textContent),
    vacio.doc.getElementById('runline').textContent)
}

console.log('\nactivity.html — dice si la linea esta viva y sobre cuanto actua')
{
  const base = { pending: [], recent: [], running: false, syncedAt: '2026-09-23 17:41',
    mapped: 1, authorized: 1,
    run: { state: 'ok', endedAt: '2026-09-23 17:36', looked: 1, pending: 0 } }
  const chats = new Array(298).fill(0).map((_, i) => ({ jid: `c${i}`, name: `c${i}` }))

  const viva = await montar('activity.html',
    { activity: base, chats, sidecar: { connection: 'open', me: '+573000000011',
      latido: { ts: Date.now(), conectado: true } } },
    'es-419')
  await espera()
  ok('dice que la linea esta conectada',
    /conectada/i.test(viva.doc.getElementById('linea').textContent),
    viva.doc.getElementById('linea').textContent)
  // Tras escanear un QR, saber CUAL quedo es la unica forma de notar que se escaneo
  // con el telefono equivocado.
  ok('y con que numero', viva.doc.getElementById('linea').textContent.includes('+573000000011'),
    viva.doc.getElementById('linea').textContent)
  // "Reviso 1 conversacion" sin decir de cuantas no informa nada: 1 de 1 es cobertura
  // completa y 1 de 298 es un agente que casi no ve.
  const cob = viva.doc.getElementById('cobertura').textContent
  ok('y sobre cuantas conversaciones puede actuar, del total',
    cob.includes('1') && cob.includes('298'), cob)

  const sinQr = await montar('activity.html',
    { activity: base, chats, sidecar: { connection: 'connecting', qr: { qr: 'X', ts: Date.now(), ttlMs: 75000 } } },
    'es-419')
  await espera()
  ok('sin vincular, manda a escanear el QR y no dice "conectada"',
    /QR/i.test(sinQr.doc.getElementById('linea').textContent) &&
    !/conectada/i.test(sinQr.doc.getElementById('linea').textContent),
    sinQr.doc.getElementById('linea').textContent)

  const caida = await montar('activity.html',
    { activity: base, chats, sidecar: { connection: 'close', exited: true } }, 'es-419')
  await espera()
  ok('caida se dice caida', /caida/i.test(caida.doc.getElementById('linea').textContent),
    caida.doc.getElementById('linea').textContent)

  // Sin ninguna autorizada el agente no puede actuar en ningun lado, y eso pide
  // atencion aunque no haya nada pendiente.
  const cero = await montar('activity.html',
    { activity: Object.assign({}, base, { authorized: 0 }), chats,
      sidecar: { connection: 'open', latido: { ts: Date.now(), conectado: true } } }, 'es-419')
  await espera()
  ok('con cero autorizadas se avisa',
    cero.doc.getElementById('cobertura').className.includes('vieja'),
    cero.doc.getElementById('cobertura').className)
}

// ───────── "Linea conectada" con el mismo criterio de vida que el panel de config ─────────
console.log('\nactivity.html — "linea conectada" solo con latido fresco')
{
  const base = { pending: [], recent: [], running: false, syncedAt: '2026-09-23 17:41',
    mapped: 1, authorized: 1 }
  const viejoMs = Date.now() - 10 * 60 * 1000
  const hora = new Date(viejoMs).toTimeString().slice(0, 5)
  const muda = await montar('activity.html', { activity: base, chats: [],
    sidecar: { connection: 'open', me: '+573000000011',
      latido: { ts: viejoMs, conectado: true } } }, 'es-419')
  await espera()
  const linea = muda.doc.getElementById('linea')
  ok('con el latido viejo no dice conectada', !/conectada/i.test(linea.textContent),
    linea.textContent)
  ok('dice que no da senal, y desde cuando', /senal/i.test(linea.textContent) &&
    linea.textContent.includes(hora), `${linea.textContent} / ${hora}`)
  ok('y se marca como dato viejo', linea.className.includes('stale'), linea.className)

  const nunca = await montar('activity.html', { activity: base, chats: [],
    sidecar: { connection: 'open' } }, 'es-419')
  await espera()
  ok('sin ningun latido tampoco dice conectada',
    !/conectada/i.test(nunca.doc.getElementById('linea').textContent),
    nunca.doc.getElementById('linea').textContent)

  // Los dos paneles deciden "conectado" con el MISMO plazo: si uno dijera conectada y
  // el otro sin senal sobre el mismo dato, el dueno no sabria a cual creerle.
  const plazo = (archivo) => {
    const m = /var LATIDO_LINEA_VENCE_MS = (\d+)/.exec(readFileSync(join(root, archivo), 'utf8'))
    return m ? Number(m[1]) : null
  }
  ok('config y actividad usan el mismo plazo de latido',
    plazo('config.html') !== null && plazo('config.html') === plazo('activity.html'),
    `config=${plazo('config.html')} actividad=${plazo('activity.html')}`)

  const { window } = await montar('activity.html')
  const S = window.STRINGS
  ok('el texto nuevo existe en los tres idiomas, con portugues propio',
    !!(S.es.lineaSinSenal && S.en.lineaSinSenal && S.pt.lineaSinSenal &&
      S.pt.lineaSinSenal !== S.en.lineaSinSenal),
    JSON.stringify([S.es.lineaSinSenal, S.en.lineaSinSenal, S.pt && S.pt.lineaSinSenal]))
}

console.log('\nactivity.html — T9: tras cambiar de numero, la actividad del anterior no se pinta')
{
  // Lo que se vio en vivo con +573000000012 recien vinculado: "actua sobre 3 de 306",
  // avisos y "lo ultimo que hizo" del numero viejo, y "la revision arranco y no volvio
  // · 2026-09-24 08:46", que era la corrida del viejo.
  const VIEJA_A = 'pn:573001112233'
  const NUEVA_A = 'pn:573000000012'
  const sidecar = { connection: 'open', me: '+573000000012', cuenta: NUEVA_A,
    latido: { ts: Date.now(), conectado: true } }
  const vieja = {
    account: VIEJA_A, syncedAt: '2026-09-24 09:00', running: false, mapped: 306,
    authorized: 3,
    pending: [{ stanzaId: 'P1', chat: 'Grupo Viejo', chatJid: '100@g.us', text: 'pendiente viejo',
      date: '2026-09-24 08:40' }],
    recent: [{ ts: '2026-09-24 08:45', chat: 'Grupo Viejo', action: 'alert',
      detail: 'Piden descuento | aviso viejo' },
    { ts: '2026-09-24 08:44', chat: 'Grupo Viejo', action: 'issue', issue: 'SOP-1',
      detail: 'accion vieja' }],
    run: { state: 'interrupted', startedAt: '2026-09-24 08:46', endedAt: null }
  }
  const chats = new Array(306).fill(0).map((_, i) => ({ jid: `c${i}`, name: `c${i}` }))
  const storage = { activity: vieja, chats, chatsAccount: VIEJA_A, sidecar }
  const { doc } = await montar('activity.html', storage, 'es-419')
  await espera()
  const todo = doc.body.textContent
  ok('no muestra la cobertura del numero anterior', !/3 de 306/.test(
    doc.getElementById('cobertura').textContent), doc.getElementById('cobertura').textContent)
  ok('ni sus avisos ni lo ultimo que hizo', !/aviso viejo|Piden descuento|accion vieja|SOP-1/.test(todo),
    todo.slice(0, 300))
  ok('ni su corrida', !/08:46/.test(doc.getElementById('runline').textContent),
    doc.getElementById('runline').textContent)
  ok('ni su cola', !/pendiente viejo/.test(todo), todo.slice(0, 300))
  // El sync de la linea nueva lo pide el worker solo (T9e): mandar a correr un comando
  // en una terminal seria falso, y es justo el callejon que el panel dejo de ofrecer.
  const sello = doc.getElementById('synced').textContent
  ok('la cabecera no manda a una terminal: dice que espera el sync de esta linea',
    !/wa-scope|corra/i.test(sello) && /linea/i.test(sello), sello)
  ok('y no se queda en blanco: el tablero dice que no tiene datos todavia',
    !doc.getElementById('board-empty').hidden &&
    doc.getElementById('board-empty').textContent.trim().length > 0, todo.slice(0, 300))

  // Control: con la actividad del numero vinculado, si se pinta.
  storage.activity = Object.assign({}, vieja, { account: NUEVA_A })
  storage.chatsAccount = NUEVA_A
  doc.defaultView.dispatchEvent(new doc.defaultView.Event('focus'))
  await espera()
  ok('control: la corrida del numero vinculado si se pinta',
    /08:46/.test(doc.getElementById('runline').textContent),
    doc.getElementById('runline').textContent)
  ok('control: y su cobertura', /3 de 306/.test(doc.getElementById('cobertura').textContent),
    doc.getElementById('cobertura').textContent)
}

// ── El tablero de casos (T5, rehecho con la anatomia del tablero de Plane en Orca) ──
// `wa-scope` escribe la clave `board` (odd/tasks/kanban-casos.md, "Contratos") y el panel
// la lee; las acciones del dueno (T6) viajan por el canal del worker y se prueban mas abajo.
// Todo lo que viene en una tarjeta es texto de clientes, asi que se comprueba que se pinta
// como texto y nunca como HTML.
//
// La forma copia la del tablero de Plane en Orca: una fila de etapas con su cuenta que
// filtran, un buscador, Lista/Tablero, columnas de ancho fijo con tarjetas cortas, y un
// detalle al hacer clic donde viven todas las acciones.
const hace = (ms) => new Date(Date.now() - ms).toISOString()
const ETAPAS_TABLERO = ['recibido', 'clasificado', 'decision', 'trabajo', 'listo',
  'respondido', 'cerrado', 'bloqueado']
const cuentas = (extra = {}) => Object.assign(
  Object.fromEntries(ETAPAS_TABLERO.map((e) => [e, 0])), extra)
const tarjeta = (extra = {}) => Object.assign({
  case_id: 1, account: 'local', chat_jid: '120363000000000001@g.us',
  chat_name: 'Soporte Acme', stage: 'decision', title: 'Piden descuento del 30%',
  summary: 'Quiere respuesta hoy.', clase: 'card', prioridad: 'high',
  jev: { attention_class: 'support_request', flags: ['asks_for_money_or_payment'], skip: false },
  proposal: { tipo: 'responder', texto: 'Le confirmamos el precio vigente.', version: 'abc' },
  exceptions: ['money'], blocked_reason: null, ticket: null,
  updated_at: hace(5 * 60000),
  actions: ['enviar', 'editar', 'ejecutar', 'reclasificar', 'cerrar', 'reabrir']
}, extra)
const tablero = (cards, extra = {}) => ({
  v: 1, updated_at: hace(60000), truncated: false,
  counts: cuentas(cards.reduce((acc, c) => (acc[c.stage] = (acc[c.stage] || 0) + 1, acc), {})),
  cards, ...extra
})
const abrirTablero = async (storage, idioma = 'es-419') => {
  const m = await montar('activity.html', storage, idioma)
  await espera()
  return m
}
/** Abre el detalle de un caso con un clic en su tarjeta, como lo hace el dueno. */
const abrirDetalle = (doc, caso) => {
  doc.querySelector(`.card[data-case="${caso}"]`).click()
  return doc.querySelector(`#board-detail[data-case="${caso}"]`)
}
const detalle = (doc) => doc.getElementById('board-detail')
/** Escribe en el buscador como el dueno: valor y evento `input`. */
const buscar = (doc, texto) => {
  const campo = doc.getElementById('board-search')
  campo.value = texto
  campo.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }))
}
const visibles = (doc) => [...doc.querySelectorAll('#board-body .card[data-case]')]
  .map((n) => n.dataset.case)

console.log('\nactivity.html — tablero: es lo que se ve al abrir')
{
  const { doc } = await montar('activity.html', { board: tablero([tarjeta()]) }, 'es-419')
  await espera()
  ok('el tablero se ve sin apretar nada', !doc.getElementById('view-board').hidden &&
    !!doc.querySelector('.card[data-case="1"]'))
  doc.getElementById('refresh').click()
  await espera()
  ok('releer lo deja ahi', !!doc.querySelector('.card[data-case="1"]'))
}

console.log('\nactivity.html — la excepcion solo es una necesidad en Decision')
{
  const respondido = tarjeta({ case_id: 7, stage: 'respondido', exceptions: ['commitment'],
    proposal: null, actions: ['cerrar', 'reabrir'] })
  const enDecision = tarjeta({ case_id: 8, stage: 'decision', exceptions: ['money'] })
  const { doc } = await abrirTablero({ board: tablero([respondido, enDecision]) })
  const tarjetaR = doc.querySelector('.card[data-case="7"]')
  ok('en Respondido la tarjeta no dice que necesita su decision',
    !tarjetaR.querySelector('.card-exc') && !/Necesita su decision/.test(tarjetaR.textContent),
    tarjetaR.textContent)
  ok('en Decision si, con el motivo',
    /Necesita su decision por: dinero/.test(
      doc.querySelector('.card[data-case="8"] .card-exc')?.textContent || ''))
  ok('y el detalle de Respondido tampoco lo presenta como una necesidad actual',
    !/Necesita su decision/.test(abrirDetalle(doc, 7).textContent))
}

console.log('\nactivity.html — la linea de arriba cuenta casos, no la cola vieja')
{
  const AHORA = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const actividad = { syncedAt: AHORA, running: false, pending: [], recent: [],
    mapped: 3, authorized: 3,
    run: { state: 'ok', startedAt: AHORA, endedAt: AHORA, looked: 3, pending: 11,
      reason: null } }
  const linea = (d) => d.getElementById('runline').textContent.trim()
  const con = async (board, idioma = 'es-419', act = actividad) =>
    (await abrirTablero({ activity: act, board }, idioma)).doc

  const dos = await con(tablero([tarjeta({ case_id: 1 })], { agent_waiting: 2 }))
  ok('dice cuantos casos esperan al agente y cuantos su decision',
    /2 casos para el agente/.test(linea(dos)) && /1 espera su decision/.test(linea(dos)),
    linea(dos))
  ok('lleva la hora de la ultima revision', /Ultima revision \d{2}:\d{2}/.test(linea(dos)),
    linea(dos))
  ok('y no usa la cola vieja (11 esperando, 3 conversaciones)',
    // El 11 de la cola, no el de una hora como 14:11.
    !/(^|[^:\d])11(?![\d:])|esperando|conversaciones/.test(linea(dos)), linea(dos))

  const uno = await con(tablero([tarjeta({ case_id: 1, stage: 'recibido' }),
    tarjeta({ case_id: 2, stage: 'decision' }), tarjeta({ case_id: 3, stage: 'decision' })],
  { agent_waiting: 1 }))
  ok('uno y varios se dicen en singular y en plural',
    /1 caso para el agente/.test(linea(uno)) && /2 esperan su decision/.test(linea(uno)),
    linea(uno))

  const soloDueno = await con(tablero([tarjeta({ case_id: 1 })], { agent_waiting: 0 }))
  ok('un cero no se dice', !/agente/.test(linea(soloDueno)), linea(soloDueno))

  const nada = await con(tablero([tarjeta({ case_id: 1, stage: 'respondido', proposal: null })],
    { agent_waiting: 0 }))
  ok('sin casos esperando dice que no hay nada pendiente',
    /Ultima revision/.test(linea(nada)) && /nada pendiente/.test(linea(nada)), linea(nada))

  const sinTablero = await con(null)
  ok('sin tablero solo dice la hora, sin inventar numeros',
    /Ultima revision/.test(linea(sinTablero)) && !/nada pendiente|agente|decision/.test(
      linea(sinTablero)), linea(sinTablero))

  const fallo = await con(tablero([tarjeta()], { agent_waiting: 2 }), 'es-419',
    { ...actividad, run: { state: 'failed', startedAt: AHORA, endedAt: AHORA,
      looked: null, pending: null, reason: 'sin cuota' } })
  ok('una corrida que fallo se sigue diciendo con su motivo',
    /fallo: sin cuota/.test(linea(fallo)), linea(fallo))

  // Los espacios que el tick no pudo quitar de la barra lateral tras sus intentos: el dueno
  // los ve aqui para quitarlos a mano. Un cero no se dice.
  const nodo = (d) => d.getElementById('runline')
  const atascados = await con(tablero([tarjeta({ case_id: 1 })], { agent_waiting: 0,
    workspaces_stuck: 2 }))
  ok('dice cuantos espacios del plugin no se pudieron quitar, en rojo',
    /2 espacios del plugin no se pudieron quitar/.test(linea(atascados)) &&
    /stale/.test(nodo(atascados).className), `${linea(atascados)} ${nodo(atascados).className}`)
  const unoAtascado = await con(tablero([tarjeta({ case_id: 1 })], { workspaces_stuck: 1 }))
  ok('y uno en singular', /1 espacio del plugin no se pudo quitar/.test(linea(unoAtascado)),
    linea(unoAtascado))
  const corriendo = await con(tablero([tarjeta({ case_id: 1 })], { workspaces_stuck: 3 }),
    'es-419', { ...actividad, run: { state: 'running', startedAt: AHORA } })
  ok('tambien mientras revisa', /3 espacios del plugin no se pudieron quitar/.test(
    linea(corriendo)), linea(corriendo))
  const ninguno = await con(tablero([tarjeta({ case_id: 1 })], { workspaces_stuck: 0 }))
  ok('cero espacios atascados no se dice', !/espacio/.test(linea(ninguno)), linea(ninguno))
  const raro = await con(tablero([tarjeta({ case_id: 1 })], { workspaces_stuck: '2' }))
  ok('un numero que no es entero no se dice', !/espacio/.test(linea(raro)), linea(raro))
  const atascadoEn = await con(tablero([tarjeta({ case_id: 1 })], { workspaces_stuck: 2 }),
    'en-US')
  ok('los espacios atascados en ingles',
    /2 plugin workspaces could not be removed/.test(linea(atascadoEn)), linea(atascadoEn))
  const atascadoPt = await con(tablero([tarjeta({ case_id: 1 })], { workspaces_stuck: 2 }),
    'pt-BR')
  ok('y en portugues', /2 espacos do plugin nao puderam ser removidos/.test(linea(atascadoPt)),
    linea(atascadoPt))

  const en = await con(tablero([tarjeta({ case_id: 1 })], { agent_waiting: 2 }), 'en-US')
  ok('en ingles', /Last run \d{2}:\d{2}/.test(linea(en)) && /2 cases for the agent/.test(linea(en))
    && /1 waiting for your decision/.test(linea(en)), linea(en))
  const pt = await con(tablero([tarjeta({ case_id: 1 })], { agent_waiting: 2 }), 'pt-BR')
  ok('y en portugues', /Ultima revisao \d{2}:\d{2}/.test(linea(pt))
    && /2 casos para o agente/.test(linea(pt)) && /1 aguarda sua decisao/.test(linea(pt)),
  linea(pt))
}

console.log('\nactivity.html — la historia marca cada reapertura')
{
  const ev = (de, a, actor, ms) => ({ de, a, actor, at: hace(ms) })
  const reabierta = tarjeta({ case_id: 9, stage: 'recibido', proposal: null, exceptions: [],
    actions: ['atender', 'ignorar', 'cerrar'],
    events: [ev(null, 'recibido', 'automatizacion', 3 * 3600000),
      ev('recibido', 'clasificado', 'jev', 3 * 3600000 - 1000),
      ev('clasificado', 'decision', 'agente', 2.9 * 3600000),
      ev('decision', 'respondido', 'trabajador', 2.8 * 3600000),
      ev('respondido', 'recibido', 'automatizacion', 5 * 60000),
      ev('recibido', 'clasificado', 'jev', 4 * 60000)] })
  const { doc } = await abrirTablero({ board: tablero([reabierta]) })
  const d = abrirDetalle(doc, 9)
  const reabierto = d.querySelector('.hist-reabierto')
  ok('la historia tiene una marca "Reabierto" con su hora',
    !!reabierto && /Reabierto/.test(reabierto.textContent) && /hace/.test(reabierto.textContent),
    reabierto?.textContent)
  const previa = d.querySelector('details.hist-previa')
  ok('lo anterior queda detras de "Ver historia anterior"',
    !!previa && /Ver historia anterior/.test(previa.querySelector('summary').textContent))
  ok('lo anterior no esta abierto', !previa.open)
  ok('lo nuevo se ve primero y fuera de lo plegado',
    /Respondido → Recibido/.test(d.querySelector('.det-hist').textContent)
    && !previa.contains(d.querySelector('.det-hist')))
  ok('y lo viejo (la decision del agente) esta dentro de lo plegado',
    /Su decision/.test(previa.textContent) && /el agente/.test(previa.textContent))

  const limpia = tarjeta({ case_id: 10, stage: 'clasificado', proposal: null, exceptions: [],
    events: [ev(null, 'recibido', 'automatizacion', 60000), ev('recibido', 'clasificado', 'jev', 30000)] })
  const sola = await abrirTablero({ board: tablero([limpia]) })
  const ds = abrirDetalle(sola.doc, 10)
  ok('un caso que nunca se reabrio no lleva marca ni pliegue',
    !ds.querySelector('.hist-reabierto') && !ds.querySelector('details.hist-previa')
    && ds.querySelectorAll('.det-hist li').length === 2)
}

console.log('\nactivity.html — una propuesta escalar sin texto dice por que')
{
  const escalar = tarjeta({ case_id: 11, stage: 'decision', exceptions: ['credential', 'commitment'],
    proposal: { tipo: 'escalar', texto: null, version: 'v-esc' },
    jev: { attention_class: 'access_or_credential', flags: ['asks_for_credential'], skip: false },
    actions: ['editar', 'reclasificar', 'cerrar'] })
  const { doc } = await abrirTablero({ board: tablero([escalar]) })
  const d = abrirDetalle(doc, 11)
  ok('no hay una caja de propuesta vacia', !d.querySelector('.det-prop .card-prop')
    && !d.querySelector('.det-prop'), d.innerHTML.slice(0, 400))
  const aviso = d.querySelector('.det-escalar')
  ok('dice que el agente lo dejo a su decision',
    !!aviso && /dejo a su decision/.test(aviso.textContent), aviso?.textContent)
  ok('con el motivo: las excepciones y lo que Jev vio',
    /credencial/i.test(aviso?.textContent || '') && /compromiso/i.test(aviso?.textContent || '')
    && /Jev/.test(aviso?.textContent || ''), aviso?.textContent)
  const boton = d.querySelector('button[data-accion="editar"]')
  ok('y ofrece Editar y enviar para responder', !!boton && /Editar y enviar/.test(boton.textContent))
  ok('en la tarjeta tampoco hay una caja vacia',
    !doc.querySelector('.card[data-case="11"] .card-prop'))
  const conTexto = await abrirTablero({ board: tablero([tarjeta({ case_id: 12 })]) })
  ok('una propuesta con texto sigue mostrandose igual',
    /Le confirmamos el precio vigente/.test(abrirDetalle(conTexto.doc, 12).textContent)
    && !abrirDetalle(conTexto.doc, 12).querySelector('.det-escalar'))
}

console.log('\nactivity.html — tablero: columnas')
{
  const cards = [
    tarjeta({ case_id: 1, stage: 'decision' }),
    tarjeta({ case_id: 2, stage: 'trabajo', exceptions: [], proposal: null }),
    tarjeta({ case_id: 3, stage: 'bloqueado', blocked_reason: 'El envio fue rechazado',
      exceptions: [] })
  ]
  // Lo terminado se cuenta por periodo (I1): con 7 dias, la cuenta de Cerrado es la de
  // `period_counts`, que tambien viene de la clave y no de las tarjetas.
  const board = tablero(cards, { counts: cuentas({ decision: 4, trabajo: 1, bloqueado: 1,
    cerrado: 12 }), period_counts: { '7d': { respondido: 0, cerrado: 9 } } })
  const { doc } = await abrirTablero({ board })
  const cols = [...doc.querySelectorAll('#board-cols .col')]
  ok('son las ocho etapas, en el orden del flujo y el carril aparte',
    JSON.stringify(cols.map((c) => c.dataset.stage)) === JSON.stringify(ETAPAS_TABLERO),
    JSON.stringify(cols.map((c) => c.dataset.stage)))
  const cuenta = (e) => doc.querySelector(`.col[data-stage="${e}"] .col-count`).textContent.trim()
  ok('cada columna dice su cuenta de `counts`, no las tarjetas que hay',
    cuenta('decision') === '4' && cuenta('cerrado') === '9' && cuenta('recibido') === '0',
    JSON.stringify(ETAPAS_TABLERO.map(cuenta)))
  const nombre = (e) => doc.querySelector(`.col[data-stage="${e}"] .col-name`).textContent
  ok('"Su decision" se llama como la pidio el dueno', nombre('decision') === 'Su decision',
    nombre('decision'))
  ok('las demas, por su nombre', nombre('trabajo') === 'En trabajo' &&
    nombre('listo') === 'Listo para responder' && nombre('bloqueado') === 'Bloqueado',
    JSON.stringify(ETAPAS_TABLERO.map(nombre)))
  ok('cada columna lleva el punto de su etapa, como las de Plane',
    cols.every((c) => c.querySelector('.col-head .dot-etapa')))
  ok('"Su decision" es la unica columna de primera clase',
    doc.querySelectorAll('.col.decision').length === 1 &&
    doc.querySelector('.col[data-stage="decision"]').classList.contains('decision'))
  ok('el carril de bloqueados es distinto de las columnas del flujo',
    doc.querySelector('.col[data-stage="bloqueado"]').classList.contains('lane'))
  ok('cada tarjeta cae en su columna',
    doc.querySelectorAll('.col[data-stage="decision"] .card').length === 1 &&
    doc.querySelectorAll('.col[data-stage="trabajo"] .card').length === 1 &&
    doc.querySelectorAll('.col[data-stage="bloqueado"] .card').length === 1)
  // Antes: ocho cajas con "Nada aqui". Una columna sin nada se encoge a su cabecera.
  const vacia = doc.querySelector('.col[data-stage="recibido"]')
  ok('una columna sin casos se encoge a su cabecera, sin una caja de "Nada aqui"',
    vacia.classList.contains('vacia') && !vacia.querySelector('.card') &&
    !/nada aqui/i.test(vacia.textContent), vacia.outerHTML.slice(0, 200))
  ok('y aun encogida dice su nombre y su cero, no desaparece',
    vacia.querySelector('.col-name').textContent === 'Recibido' && cuenta('recibido') === '0')
  ok('una columna con casos no se encoge',
    !doc.querySelector('.col[data-stage="decision"]').classList.contains('vacia'))
  ok('ningun texto de "Nada aqui" en todo el tablero',
    !/nada aqui/i.test(doc.getElementById('board-cols').textContent))
  // `counts` dice 4 y solo hay 1 tarjeta: faltan 3, y callarlo las haria desaparecer.
  ok('si la cuenta supera las tarjetas, dice cuantas faltan por mostrar',
    /3/.test(doc.querySelector('.col[data-stage="decision"] .col-more')?.textContent || ''),
    doc.querySelector('.col[data-stage="decision"] .col-more')?.textContent)
  ok('y no lo dice donde no falta ninguna',
    !doc.querySelector('.col[data-stage="trabajo"] .col-more'))
}

console.log('\nactivity.html — tablero: la fila de etapas filtra')
{
  const cards = [
    tarjeta({ case_id: 1, stage: 'decision' }),
    tarjeta({ case_id: 2, stage: 'trabajo', exceptions: [], proposal: null, title: 'Arreglar export' }),
    tarjeta({ case_id: 3, stage: 'trabajo', exceptions: [], proposal: null, title: 'Revisar login' }),
    tarjeta({ case_id: 4, stage: 'cerrado', exceptions: [], proposal: null, actions: ['reabrir'] })
  ]
  const { doc, enviados } = await abrirTablero({ board: tablero(cards) })
  const chips = [...doc.querySelectorAll('#board-chips button[data-etapa]')]
  ok('una fila de etapas: "Todos" y luego "Su decision" primero',
    chips[0]?.dataset.etapa === 'todos' && chips[1]?.dataset.etapa === 'decision',
    JSON.stringify(chips.map((c) => c.dataset.etapa)))
  ok('estan las ocho etapas mas "Todos"', chips.length === 9 &&
    ETAPAS_TABLERO.every((e) => chips.some((c) => c.dataset.etapa === e)))
  const chip = (e) => doc.querySelector(`#board-chips button[data-etapa="${e}"]`)
  ok('cada etapa dice su cuenta', /2/.test(chip('trabajo').textContent) &&
    /4/.test(chip('todos').textContent), chip('trabajo').textContent + ' / ' + chip('todos').textContent)
  ok('cada etapa lleva su punto', !!chip('trabajo').querySelector('.dot-etapa'))
  ok('"Todos" empieza elegido', chip('todos').getAttribute('aria-pressed') === 'true' &&
    chip('trabajo').getAttribute('aria-pressed') === 'false')
  ok('"Su decision" con casos se destaca', chip('decision').classList.contains('fuerte'))
  chip('trabajo').click()
  ok('apretar una etapa deja solo esa', JSON.stringify(visibles(doc)) === '["2","3"]',
    JSON.stringify(visibles(doc)))
  ok('y la marca elegida', chip('trabajo').getAttribute('aria-pressed') === 'true' &&
    chip('todos').getAttribute('aria-pressed') === 'false')
  ok('en el tablero queda solo su columna',
    [...doc.querySelectorAll('#board-cols .col')].map((c) => c.dataset.stage).join() === 'trabajo')
  doc.getElementById('refresh').click()
  await espera()
  ok('el filtro sobrevive al sondeo', JSON.stringify(visibles(doc)) === '["2","3"]',
    JSON.stringify(visibles(doc)))
  chip('todos').click()
  ok('"Todos" devuelve todo', visibles(doc).length === 4, JSON.stringify(visibles(doc)))
  ok('filtrar no escribe nada en storage', enviados.every((e) => e.action !== 'storage.set'))

  const sin = await abrirTablero({ board: tablero([tarjeta({ stage: 'trabajo', exceptions: [],
    proposal: null })]) })
  ok('"Su decision" sin casos no se destaca',
    !sin.doc.querySelector('#board-chips button[data-etapa="decision"]').classList.contains('fuerte'))
}

console.log('\nactivity.html — tablero: buscar por numero, titulo o chat')
{
  const cards = [
    tarjeta({ case_id: 1, title: 'Piden descuento en la renovación' }),
    tarjeta({ case_id: 12, stage: 'trabajo', title: 'Arreglar export', chat_name: 'Laura Méndez',
      exceptions: [], proposal: null }),
    tarjeta({ case_id: 31, stage: 'listo', title: 'Estado del reporte', chat_name: 'Operaciones',
      exceptions: [] })
  ]
  const { doc, enviados } = await abrirTablero({ board: tablero(cards) })
  ok('hay un buscador con su texto de ayuda',
    !!doc.getElementById('board-search') &&
    /buscar/i.test(doc.getElementById('board-search').placeholder),
    doc.getElementById('board-search')?.placeholder)
  buscar(doc, '#12')
  ok('por numero con #', JSON.stringify(visibles(doc)) === '["12"]', JSON.stringify(visibles(doc)))
  buscar(doc, '31')
  ok('por numero sin #', JSON.stringify(visibles(doc)) === '["31"]', JSON.stringify(visibles(doc)))
  buscar(doc, 'RENOVACION')
  ok('por titulo, sin importar mayusculas ni tildes', JSON.stringify(visibles(doc)) === '["1"]',
    JSON.stringify(visibles(doc)))
  buscar(doc, 'mendez')
  ok('por nombre del chat', JSON.stringify(visibles(doc)) === '["12"]', JSON.stringify(visibles(doc)))
  ok('dice cuantos se muestran', /1/.test(doc.getElementById('board-shown').textContent),
    doc.getElementById('board-shown').textContent)
  ok('la columna filtrada dice cuantos de cuantos', /1\s*\/\s*1/.test(
    doc.querySelector('.col[data-stage="trabajo"] .col-count').textContent),
    doc.querySelector('.col[data-stage="trabajo"] .col-count').textContent)
  doc.getElementById('refresh').click()
  await espera()
  ok('la busqueda sobrevive al sondeo', doc.getElementById('board-search').value === 'mendez' &&
    JSON.stringify(visibles(doc)) === '["12"]', JSON.stringify(visibles(doc)))
  buscar(doc, 'nada que coincida')
  ok('sin coincidencias lo dice con calma', visibles(doc).length === 0 &&
    /ningun caso/i.test(doc.getElementById('board-body').textContent),
    doc.getElementById('board-body').textContent.slice(0, 200))
  doc.getElementById('board-search-clear').click()
  ok('borrar la busqueda devuelve todo', visibles(doc).length === 3 &&
    doc.getElementById('board-search').value === '', JSON.stringify(visibles(doc)))
  ok('buscar no escribe nada en storage', enviados.every((e) => e.action !== 'storage.set'))
}

console.log('\nactivity.html — tablero: Lista y Tablero')
{
  const cards = [
    tarjeta({ case_id: 1 }),
    tarjeta({ case_id: 2, stage: 'trabajo', exceptions: [], proposal: null }),
    tarjeta({ case_id: 3, stage: 'bloqueado', blocked_reason: 'x', exceptions: [] })
  ]
  const { doc } = await abrirTablero({ board: tablero(cards) })
  const boton = (v) => doc.querySelector(`#board-view button[data-vista="${v}"]`)
  ok('hay un selector Lista / Tablero', !!boton('list') && !!boton('board') &&
    boton('list').textContent.trim() === 'Lista' && boton('board').textContent.trim() === 'Tablero')
  ok('a lo ancho abre en Tablero', boton('board').getAttribute('aria-pressed') === 'true' &&
    !doc.getElementById('board-cols').hidden && doc.getElementById('board-list').hidden)
  boton('list').click()
  ok('Lista oculta las columnas y muestra filas', doc.getElementById('board-cols').hidden &&
    !doc.getElementById('board-list').hidden &&
    doc.querySelectorAll('#board-list .card[data-case]').length === 3)
  const grupos = [...doc.querySelectorAll('#board-list .grupo')].map((g) => g.dataset.stage)
  ok('las filas van agrupadas por etapa y sin grupos vacios',
    JSON.stringify(grupos) === JSON.stringify(['decision', 'trabajo', 'bloqueado']),
    JSON.stringify(grupos))
  ok('cada grupo dice su nombre y su cuenta',
    /En trabajo/.test(doc.querySelector('#board-list .grupo[data-stage="trabajo"] .grupo-head').textContent) &&
    /1/.test(doc.querySelector('#board-list .grupo[data-stage="trabajo"] .grupo-head').textContent))
  doc.getElementById('refresh').click()
  await espera()
  ok('la vista elegida sobrevive al sondeo', !doc.getElementById('board-list').hidden &&
    boton('list').getAttribute('aria-pressed') === 'true')
  boton('board').click()
  ok('Tablero vuelve a las columnas', !doc.getElementById('board-cols').hidden &&
    doc.getElementById('board-list').hidden)
}

console.log('\nactivity.html — tablero: la tarjeta')
{
  const ticket = 'ACM-42'
  const board = tablero([
    tarjeta({ ticket }),
    tarjeta({ case_id: 2, stage: 'bloqueado', exceptions: [], proposal: null,
      blocked_reason: 'El envio fue rechazado por el servidor', prioridad: 'urgent',
      clase: 'alert', jev: { attention_class: 'bug_report', flags: [], skip: true } }),
    tarjeta({ case_id: 3, stage: 'trabajo', prioridad: 'low', exceptions: [], proposal: null })
  ])
  const { doc } = await abrirTablero({ board })
  const a = doc.querySelector('.card[data-case="1"]')
  const t = a.textContent
  ok('arriba el numero del caso, como el ID de Plane', a.querySelector('.card-id').textContent === '#1',
    a.querySelector('.card-id')?.textContent)
  ok('y la prioridad corta a la derecha', a.querySelector('.card-prio').textContent === 'Alta',
    a.querySelector('.card-prio')?.textContent)
  ok('titulo y chat', a.querySelector('.card-title').textContent === 'Piden descuento del 30%' &&
    a.querySelector('.card-meta').textContent.includes('Soporte Acme'), t)
  ok('la antiguedad es relativa', /hace 5 min/.test(a.querySelector('.when').textContent),
    a.querySelector('.when')?.textContent)
  ok('por que espera al dueno, en UNA linea humana',
    a.querySelector('.card-exc').textContent === 'Necesita su decision por: dinero',
    a.querySelector('.card-exc')?.textContent)
  ok('sin la etiqueta "tarjeta" ni etiquetas sueltas', !/tarjeta/i.test(t) && !a.querySelector('.tag.clase'), t)
  ok('sin codigos crudos en la tarjeta', !/asks_for|support_request|_/.test(t), t)
  ok('el resumen y la propuesta larga no se amontonan en la tarjeta: van al detalle',
    !t.includes('Quiere respuesta hoy.'), t)
  const b = doc.querySelector('.card[data-case="2"]')
  ok('el motivo del bloqueo se ve en la tarjeta', b.querySelector('.card-blocked').textContent
    .includes('El envio fue rechazado por el servidor'))
  ok('lo urgente se marca distinto de lo alto, y lo bajo no lleva color',
    b.querySelector('.card-prio').classList.contains('urgente') &&
    a.querySelector('.card-prio').classList.contains('alta') &&
    !a.querySelector('.card-prio').classList.contains('urgente') &&
    !doc.querySelector('.card[data-case="3"] .card-prio').classList.contains('alta') &&
    !doc.querySelector('.card[data-case="3"] .card-prio').classList.contains('urgente'))
  ok('sin ticket ni propuesta no se pinta un hueco',
    !b.querySelector('.card-ticket') && !b.querySelector('.card-prop'))

  // Prioridad "none" no es una prioridad: no se pinta una etiqueta que no dice nada.
  const sinPrio = await abrirTablero({ board: tablero([tarjeta({ prioridad: 'none' })]) })
  ok('prioridad none no pinta nada', !sinPrio.doc.querySelector('.card-prio'))

  // Nunca un codigo crudo: lo que el panel no conoce se dice con una frase generica.
  const raro = await abrirTablero({ board: tablero([tarjeta({ clase: 'nueva-clase',
    prioridad: 'cosmica', exceptions: ['otra'],
    jev: { attention_class: 'clase_nueva', flags: ['bandera_nueva'], skip: false } })]) })
  const rc = raro.doc.querySelector('.card')
  const rd = abrirDetalle(raro.doc, 1)
  const rt = rc.textContent + ' ' + (rd ? rd.textContent : '')
  ok('codigos nuevos no se pintan crudos',
    !['nueva-clase', 'cosmica', 'clase_nueva', 'bandera_nueva'].some((c) => rt.includes(c)), rt)
  ok('una excepcion nueva se dice con una frase generica',
    /otro motivo/i.test(rc.querySelector('.card-exc').textContent), rc.querySelector('.card-exc')?.textContent)
  ok('y una clase o bandera de Jev nueva tambien', /otro tipo de mensaje/i.test(rd.textContent) &&
    /otra senal/i.test(rd.textContent), rd.textContent)

  // El contrato permite null en jev, proposal, blocked_reason y ticket.
  const nulos = await abrirTablero({ board: tablero([tarjeta({ jev: null, proposal: null,
    exceptions: [], blocked_reason: null, ticket: null, summary: '', clase: null,
    prioridad: null })]) })
  ok('con todo lo opcional en null pinta solo numero, titulo y chat',
    nulos.doc.querySelectorAll('.card').length === 1 &&
    nulos.doc.querySelector('.card').textContent.includes('Piden descuento') &&
    !nulos.doc.querySelector('.card .card-exc') && !nulos.doc.querySelector('.card .card-prio'))
}

console.log('\nactivity.html — tablero: el detalle del caso')
{
  const board = tablero([tarjeta({ ticket: 'ACM-42' }),
    tarjeta({ case_id: 2, stage: 'trabajo', exceptions: [], proposal: null, title: 'Otro caso' })])
  const { doc, window, enviados } = await abrirTablero({ board })
  ok('empieza cerrado', detalle(doc).hidden)
  const d = abrirDetalle(doc, 1)
  ok('un clic en la tarjeta abre su detalle', !!d && !d.hidden, detalle(doc).outerHTML.slice(0, 120))
  ok('la tarjeta dice que esta abierta', doc.querySelector('.card[data-case="1"]')
    .getAttribute('aria-expanded') === 'true' &&
    doc.querySelector('.card[data-case="1"]').classList.contains('elegida'))
  ok('el detalle trae titulo, numero y chat', d.textContent.includes('Piden descuento del 30%') &&
    d.textContent.includes('#1') && d.textContent.includes('Soporte Acme'), d.textContent)
  ok('el resumen entero', d.querySelector('.det-sum').textContent.includes('Quiere respuesta hoy.'))
  ok('la propuesta, con su tipo y su texto entero',
    /responder/i.test(d.querySelector('.det-prop .det-label').textContent) &&
    d.querySelector('.card-prop').textContent.includes('Le confirmamos el precio vigente.'))
  ok('el ticket', d.querySelector('.card-ticket').textContent.includes('ACM-42'))
  ok('por que espera al dueno', /dinero/.test(d.querySelector('.card-exc').textContent))
  ok('lo que vio Jev, en palabras', /solicitud de soporte/.test(d.querySelector('.det-jev').textContent) &&
    /dinero o de un pago/.test(d.querySelector('.det-jev').textContent),
    d.querySelector('.det-jev')?.textContent)
  ok('todas las acciones de la etapa estan en el detalle',
    [...d.querySelectorAll('.det-acts button[data-accion]')].map((b) => b.dataset.accion).join() ===
      'enviar,editar,reclasificar,cerrar')
  doc.getElementById('refresh').click()
  await espera()
  ok('el detalle sobrevive al sondeo', !detalle(doc).hidden && detalle(doc).dataset.case === '1')
  abrirDetalle(doc, 2)
  ok('otra tarjeta cambia el detalle', detalle(doc).dataset.case === '2' &&
    detalle(doc).textContent.includes('Otro caso'))
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  ok('Escape lo cierra', detalle(doc).hidden &&
    doc.querySelector('.card[data-case="2"]').getAttribute('aria-expanded') === 'false')
  abrirDetalle(doc, 1)
  detalle(doc).querySelector('[data-cerrar-detalle]').click()
  ok('y la X tambien', detalle(doc).hidden)
  const card = doc.querySelector('.card[data-case="2"]')
  card.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  ok('Enter sobre la tarjeta lo abre', !detalle(doc).hidden && detalle(doc).dataset.case === '2')
  ok('las tarjetas se alcanzan con Tab', card.tabIndex === 0)
  ok('abrir y cerrar el detalle no escribe nada', enviados.every((e) => e.action !== 'storage.set'))

  // El caso que desaparece del tablero se lleva su detalle.
  const m = await abrirTablero({ board: tablero([tarjeta()]) })
  abrirDetalle(m.doc, 1)
  m.storage.board = tablero([tarjeta({ case_id: 5 })])
  m.doc.getElementById('refresh').click()
  await espera()
  ok('si el caso ya no esta, el detalle se cierra', detalle(m.doc).hidden)

  // La historia del caso (`caso_evento`) solo si la clave la trae.
  const conHistoria = await abrirTablero({ board: tablero([tarjeta({ events: [
    { de: null, a: 'recibido', actor: 'sistema', detalle: '', at: hace(30 * 60000) },
    { de: 'recibido', a: 'decision', actor: 'agente', detalle: '', at: hace(10 * 60000) }] })]) })
  const h = abrirDetalle(conHistoria.doc, 1)
  ok('con `events` el detalle muestra la historia con nombres de etapa',
    h.querySelectorAll('.det-hist li').length === 2 && /Su decision/.test(h.querySelector('.det-hist').textContent),
    h.querySelector('.det-hist')?.textContent)
  ok('sin `events` no hay historia vacia', !abrirDetalle(doc, 1).querySelector('.det-hist'))
}

console.log('\nactivity.html — tablero: texto de clientes, nunca HTML')
{
  const hostil = '<img src=x onerror="window.__xss=1"><b>negrita</b>'
  const board = tablero([tarjeta({ title: hostil, chat_name: hostil, summary: hostil,
    proposal: { tipo: 'responder', texto: hostil, version: 'v' }, ticket: hostil,
    blocked_reason: hostil, exceptions: [hostil],
    jev: { attention_class: hostil, flags: [hostil], skip: false },
    clase: hostil, prioridad: hostil })])
  const { doc, window } = await abrirTablero({ board })
  abrirDetalle(doc, 1)
  doc.querySelector('#board-view button[data-vista="list"]').click()
  abrirDetalle(doc, 1)
  ok('ninguna etiqueta del cliente llega al DOM',
    doc.querySelectorAll('#view-board img, #view-board b').length === 0)
  ok('y el texto se ve literal', doc.querySelector('.card-title').textContent === hostil,
    doc.querySelector('.card-title')?.textContent)
  ok('sin ejecutar nada', window.__xss === undefined)
}

// Los botones del detalle de un caso. Abre el detalle con un clic en la tarjeta.
const botonDe = (doc, caso, accion) => {
  if (!doc.querySelector(`#board-detail[data-case="${caso}"]:not([hidden])`)) {
    doc.querySelector(`.card[data-case="${caso}"]`)?.click()
  }
  return doc.querySelector(`#board-detail[data-case="${caso}"] .det-acts button[data-accion="${accion}"]`)
}
// El unico boton que la tarjeta lleva a la vista.
const botonTarjeta = (doc, caso, accion) =>
  doc.querySelector(`.card[data-case="${caso}"] .card-acts button[data-accion="${accion}"]`)
// Lo que se dijo de una accion: en la tarjeta y, si esta abierto, en su detalle.
const mensajeDe = (doc, caso) =>
  doc.querySelector(`.card[data-case="${caso}"] .card-msg`) ||
  doc.querySelector(`#board-detail[data-case="${caso}"] .card-msg`)

console.log('\nactivity.html — tablero: que botones ofrece cada caso (T6)')
{
  // Solo lo que la tarjeta trae en `actions` Y vale en su etapa. Un boton que el worker va
  // a rechazar siempre es un boton que no hace nada, y eso esta prohibido.
  const botonesDe = async (c, idioma) => {
    const { doc } = await abrirTablero({ board: tablero([c]) }, idioma)
    abrirDetalle(doc, c.case_id)
    return {
      detalle: [...doc.querySelectorAll('#board-detail .det-acts button[data-accion]')].map((b) => b.dataset.accion),
      tarjeta: [...doc.querySelectorAll('.card .card-acts button[data-accion]')].map((b) => b.dataset.accion)
    }
  }
  const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  let r = await botonesDe(tarjeta())
  ok('en decision con una respuesta: enviar, editar, reclasificar y cerrar',
    igual(r.detalle, ['enviar', 'editar', 'reclasificar', 'cerrar']), JSON.stringify(r))
  ok('y la tarjeta lleva solo Enviar', igual(r.tarjeta, ['enviar']), JSON.stringify(r))
  r = await botonesDe(tarjeta({ proposal: { tipo: 'trabajar', texto: 'Revisar el modulo', version: 'abc' } }))
  ok('en decision con un trabajo: ejecutar, no enviar ni editar',
    igual(r.detalle, ['ejecutar', 'reclasificar', 'cerrar']), JSON.stringify(r))
  ok('y la tarjeta lleva solo Ejecutar', igual(r.tarjeta, ['ejecutar']), JSON.stringify(r))
  r = await botonesDe(tarjeta({ stage: 'listo', actions: ['enviar', 'editar', 'cerrar'] }))
  // Editar la respuesta del trabajador la devuelve a "Tu decision" con la version nueva
  // (cli-huecos, C1): ya tiene camino en el CLI.
  ok('en listo: enviar, editar y cerrar',
    igual(r.detalle, ['enviar', 'editar', 'cerrar']) && igual(r.tarjeta, ['enviar']), JSON.stringify(r))
  r = await botonesDe(tarjeta({ stage: 'cerrado', actions: ['reabrir'] }))
  ok('cerrado: solo reabrir, y en el detalle', igual(r.detalle, ['reabrir']) && r.tarjeta.length === 0,
    JSON.stringify(r))
  r = await botonesDe(tarjeta({ stage: 'trabajo', actions: ['cerrar'] }))
  ok('en trabajo: solo cerrar', igual(r.detalle, ['cerrar']) && r.tarjeta.length === 0, JSON.stringify(r))
  r = await botonesDe(tarjeta({ stage: 'clasificado', actions: ['reclasificar', 'cerrar'] }))
  ok('clasificado no ofrece reclasificar: ya esta ahi y el CLI lo rechaza', igual(r.detalle, ['cerrar']),
    JSON.stringify(r))
  r = await botonesDe(tarjeta({ stage: 'bloqueado', actions: ['reclasificar', 'cerrar', 'reabrir'] }))
  ok('bloqueado: reclasificar, cerrar y reabrir', igual(r.detalle, ['reclasificar', 'cerrar', 'reabrir']) &&
    r.tarjeta.length === 0, JSON.stringify(r))
  r = await botonesDe(tarjeta({ actions: ['cerrar', 'incendiar', 'enviar', 'cerrar'] }))
  ok('lo que `actions` no trae no se ofrece, lo que no se conoce se ignora y no se repite',
    igual(r.detalle, ['enviar', 'cerrar']), JSON.stringify(r))
  r = await botonesDe(tarjeta({ actions: [] }))
  ok('sin acciones, ningun boton', r.detalle.length === 0 && r.tarjeta.length === 0, JSON.stringify(r))
  r = await botonesDe(tarjeta({ actions: undefined }))
  ok('sin el campo `actions`, ningun boton', r.detalle.length === 0, JSON.stringify(r))
  r = await botonesDe(tarjeta({ proposal: { tipo: 'responder', texto: 'x' } }))
  ok('sin la version de la propuesta no se ofrece aprobar ni mandar nada',
    igual(r.detalle, ['reclasificar', 'cerrar']) && r.tarjeta.length === 0, JSON.stringify(r))
  const m = await abrirTablero({ board: tablero([tarjeta(), tarjeta({ case_id: 2, stage: 'cerrado',
    actions: ['reabrir'] })]) })
  ok('abrir el tablero no escribe nada en storage: solo un clic lo hace',
    m.enviados.every((e) => e.action !== 'storage.set'), JSON.stringify(m.enviados.map((e) => e.action)))
  // No se manda lo que no se vio: el Enviar de la tarjeta va con la respuesta ENTERA a la vista.
  const prop = m.doc.querySelector('.card[data-case="1"] .card-prop')
  ok('la respuesta que el Enviar de la tarjeta manda se lee ENTERA en la tarjeta',
    !!prop && prop.textContent.includes('Le confirmamos el precio vigente.') &&
    !prop.querySelector('.clamp') && !prop.classList.contains('clamp'), prop && prop.outerHTML)
  const larga = 'Texto largo de la propuesta. '.repeat(20)
  const l = await abrirTablero({ board: tablero([tarjeta({ proposal: { tipo: 'responder',
    texto: larga, version: 'abc' } })]) })
  ok('una respuesta larga no se manda desde la tarjeta: el boton abre el detalle para leerla',
    !botonTarjeta(l.doc, 1, 'enviar') &&
    !!l.doc.querySelector('.card[data-case="1"] .card-acts button[data-abrir]'),
    l.doc.querySelector('.card[data-case="1"]')?.innerHTML)
  l.doc.querySelector('.card[data-case="1"] .card-acts button[data-abrir]').click()
  ok('y ahi la respuesta esta entera, con su Enviar',
    detalle(l.doc).querySelector('.card-prop').textContent.includes(larga.trim()) &&
    !!botonDe(l.doc, 1, 'enviar'))
}

// El host que contesta como el worker: lee `scopeRequest` y deja SU veredicto. Sin esto
// el panel esperaria para siempre; con esto se prueba cada camino sin un worker de verdad.
const conWorker = (respuesta, { demoraMs = 0 } = {}) => {
  const pedidos = []
  const gancho = (d, storage) => {
    if (d.action === 'storage.set' && d.params.key === 'scopeRequest' && d.params.value &&
        !d.params.value.tombstone) {
      const pedido = d.params.value
      pedidos.push(pedido)
      setTimeout(() => {
        const r = typeof respuesta === 'function' ? respuesta(pedido, storage) : respuesta
        if (r) storage.scopeResult = { at: new Date().toISOString(), requestId: pedido.id,
          action: pedido.action, ...r }
      }, demoraMs)
    }
    return undefined
  }
  return { pedidos, gancho }
}
const abrirConWorker = async (cards, worker, extra = {}, idioma = 'es-419') => {
  const storage = { board: tablero(cards), ...extra }
  const m = await montar('activity.html', storage, idioma, worker.gancho)
  await espera()
  return { ...m, storage }
}
const hastaPanel = async (cond, ms = 6000) => {
  const fin = Date.now() + ms
  while (Date.now() < fin) { if (cond()) return true; await new Promise((r) => setTimeout(r, 50)) }
  return false
}

console.log('\nactivity.html — un caso es un pedido: "Caso anterior"')
{
  const anterior = tarjeta({ case_id: 30, stage: 'respondido', proposal: null, exceptions: [],
    actions: ['cerrar', 'reabrir'], title: 'Pedido de la manana' })
  const nuevo = tarjeta({ case_id: 31, stage: 'clasificado', proposal: null, exceptions: [],
    related_case: 30, actions: ['atender', 'cerrar'], title: 'Otro pedido distinto' })
  const { doc } = await abrirTablero({ board: tablero([anterior, nuevo]) })
  const d = abrirDetalle(doc, 31)
  const enlace = d.querySelector('button[data-relacionado="30"]')
  ok('el detalle dice cual es el caso anterior, con un enlace',
    !!enlace && /Caso anterior/.test(d.textContent) && /#30/.test(enlace.textContent), d.textContent.slice(0, 300))
  enlace.click()
  ok('el enlace abre el detalle de ese caso', !!detalle(doc).dataset.case && detalle(doc).dataset.case === '30',
    detalle(doc).dataset.case)
  ok('un caso sin anterior no trae la linea', !/Caso anterior/.test(abrirDetalle(doc, 30).textContent))
  const fuera = await abrirTablero({ board: tablero([nuevo]) })
  const df = abrirDetalle(fuera.doc, 31)
  ok('si el anterior ya no esta en el tablero se dice igual, sin enlace',
    /Caso anterior: #30/.test(df.textContent) && !df.querySelector('button[data-relacionado]'),
    df.textContent.slice(0, 300))
  const en = await abrirTablero({ board: tablero([nuevo]) }, 'en-US')
  ok('en ingles y portugues', /Previous case/.test(abrirDetalle(en.doc, 31).textContent))
  const pt = await abrirTablero({ board: tablero([nuevo]) }, 'pt-BR')
  ok('en portugues', /Caso anterior/.test(abrirDetalle(pt.doc, 31).textContent))
}

console.log('\nactivity.html — tablero: Autorizar')
{
  const escalado = tarjeta({ case_id: 21, stage: 'decision', exceptions: ['credential', 'commitment'],
    proposal: { tipo: 'escalar', texto: null, version: 'v-esc' },
    actions: ['editar', 'autorizar', 'reclasificar', 'cerrar'] })
  const w = conWorker({ ok: true, code: 'autorizado', agent: 'launched' })
  const { doc } = await abrirConWorker([escalado,
    tarjeta({ case_id: 22, stage: 'decision', exceptions: ['money'],
      actions: ['enviar', 'editar', 'autorizar', 'reclasificar', 'cerrar'] }),
    tarjeta({ case_id: 23, stage: 'decision', exceptions: [], proposal: { tipo: 'escalar', texto: null, version: 'v3' },
      actions: ['editar', 'autorizar', 'cerrar'] }),
    tarjeta({ case_id: 24, stage: 'clasificado', exceptions: ['credential'], proposal: null,
      actions: ['autorizar', 'atender', 'cerrar'] })], w)
  const d = abrirDetalle(doc, 21)
  const boton = d.querySelector('button[data-accion="autorizar"]')
  ok('un caso en decision con excepciones y sin texto ofrece Autorizar',
    !!boton && /Autorizar/.test(boton.textContent), boton?.outerHTML)
  ok('con una linea que dice que el agente podra atenderlo y que la respuesta se vuelve a pedir',
    /agente podra atenderlo/.test(d.textContent) && /dinero, credenciales o fechas/.test(d.textContent) &&
    /se la vuelve a pedir/.test(d.textContent), d.textContent.slice(-300))
  ok('si hay una respuesta lista para enviar no se ofrece (se manda o se edita)',
    !abrirDetalle(doc, 22).querySelector('button[data-accion="autorizar"]'))
  ok('sin excepciones tampoco', !abrirDetalle(doc, 23).querySelector('button[data-accion="autorizar"]'))
  ok('ni fuera de decision', !abrirDetalle(doc, 24).querySelector('button[data-accion="autorizar"]'))
  abrirDetalle(doc, 21).querySelector('button[data-accion="autorizar"]').click()
  await hastaPanel(() => w.pedidos.length > 0)
  const p = w.pedidos[0]
  ok('el clic pide `autorizar` sobre ese caso, y nada mas',
    p && p.action === 'autorizar' && p.caseId === 21 && !('texto' in p) && !('actor' in p),
    JSON.stringify(p))
  // Se espera el mensaje mismo: el detalle ya dice "el agente podra atenderlo" antes del
  // clic, y esperar esa palabra no esperaba nada.
  await hastaPanel(() => !!doc.querySelector('#board-detail .card-msg'))
  ok('y dice que el agente salio', /lanz|salio|corrida|agente/i.test(
    doc.querySelector('#board-detail .card-msg')?.textContent || ''),
  doc.querySelector('#board-detail .card-msg')?.textContent)
  const en = await abrirTablero({ board: tablero([escalado]) }, 'en-US')
  ok('en ingles dice Authorize', /Authorize/.test(
    abrirDetalle(en.doc, 21).querySelector('button[data-accion="autorizar"]')?.textContent || ''))
  const pt = await abrirTablero({ board: tablero([escalado]) }, 'pt-BR')
  ok('y en portugues Autorizar', /Autorizar/.test(
    abrirDetalle(pt.doc, 21).querySelector('button[data-accion="autorizar"]')?.textContent || ''))
}

console.log('\nactivity.html — tablero: Enviar, de punta a punta')
{
  // El worker tarda: es lo que hace un envio de verdad, y el estado "en vuelo" es lo que se mira.
  const w = conWorker({ ok: true, code: 'enviado' }, { demoraMs: 600 })
  const { doc, storage, enviados } = await abrirConWorker([tarjeta(),
    tarjeta({ case_id: 2, stage: 'listo', actions: ['enviar', 'cerrar'] })], w)
  // Con el detalle abierto, para ver que sus botones tambien se quedan quietos.
  abrirDetalle(doc, 1)
  botonTarjeta(doc, 1, 'enviar').click()
  await hastaPanel(() => w.pedidos.length > 0)
  const p = w.pedidos[0]
  ok('el clic deja UN pedido en la clave del canal del worker', w.pedidos.length === 1 && !!p,
    JSON.stringify(w.pedidos))
  ok('con la accion, el caso y la version que el dueno vio',
    p && p.action === 'enviar' && p.caseId === 1 && p.version === 'abc', JSON.stringify(p))
  ok('con id y hora, para que el worker lo atienda una sola vez y no uno viejo',
    p && typeof p.id === 'string' && p.id.length > 6 && !isNaN(Date.parse(p.at)), JSON.stringify(p))
  ok('y NADA mas: ni quien firma, ni el texto, ni el chat',
    p && Object.keys(p).sort().join() === 'action,at,caseId,id,version', JSON.stringify(Object.keys(p || {})))
  const todos = () => [...doc.querySelectorAll('#view-board button[data-accion]')]
  ok('mientras espera, TODOS los botones del tablero quedan quietos: tarjetas y detalle',
    todos().length >= 5 && todos().every((b) => b.disabled),
    JSON.stringify(todos().map((b) => [b.textContent, b.disabled])))
  ok('y el apretado dice que esta en vuelo', botonTarjeta(doc, 1, 'enviar').textContent === '…' &&
    botonTarjeta(doc, 1, 'enviar').getAttribute('aria-busy') === 'true')
  botonTarjeta(doc, 1, 'enviar')?.click()
  botonDe(doc, 1, 'enviar')?.click()
  await new Promise((r) => setTimeout(r, 150))
  ok('y un segundo clic no deja un segundo pedido', w.pedidos.length === 1, JSON.stringify(w.pedidos))
  const dicho = await hastaPanel(() => /Enviado/.test(mensajeDe(doc, 1)?.textContent || ''))
  ok('el veredicto bueno se dice en la tarjeta', dicho,
    doc.querySelector('.card[data-case="1"]')?.textContent)
  ok('y despues los botones vuelven', botonTarjeta(doc, 1, 'enviar') && !botonTarjeta(doc, 1, 'enviar').disabled)
  ok('relee el tablero tras la accion',
    enviados.filter((e) => e.action === 'storage.get' && e.params.key === 'board').length >= 2,
    String(enviados.filter((e) => e.action === 'storage.get' && e.params.key === 'board').length))
  ok('y sin un clic mas, nada vuelve a escribirse', w.pedidos.length === 1 &&
    storage.scopeRequest !== undefined)

  // El mismo Enviar desde el detalle.
  const w2 = conWorker({ ok: true, code: 'enviado' })
  const n = await abrirConWorker([tarjeta()], w2)
  botonDe(n.doc, 1, 'enviar').click()
  await hastaPanel(() => w2.pedidos.length === 1)
  ok('el Enviar del detalle deja el mismo pedido', w2.pedidos[0] && w2.pedidos[0].action === 'enviar' &&
    w2.pedidos[0].version === 'abc', JSON.stringify(w2.pedidos))
  ok('y el veredicto se dice tambien en el detalle', await hastaPanel(() =>
    /Enviado/.test(n.doc.querySelector('#board-detail .card-msg')?.textContent || '')))
}

console.log('\nactivity.html — retenidos fuera de un caso: el dueno los aprueba o los cancela')
{
  // approve-solo-dueno: el aviso de la sesion de un proyecto que el piso freno no es de
  // ningun caso. El tablero lo lista con su texto y su motivo, y el dueno lo aprueba (por el
  // worker, con la llave del plugin) o lo cancela.
  const retenido = { req_id: 'nota-proyecto-1', chat_jid: '573000000001@s.whatsapp.net',
    chat: 'Laura Ejemplo', text: 'Aviso del proyecto: el precio es $1.400', at: hace(10 * 60000),
    reasons: ['money'] }
  const conRetenido = (cards, lista = [retenido]) => ({ board: tablero(cards, { held_drafts: lista }) })
  const responde = (p) => ({ ok: true, code: p.action === 'aprobar-retenido' ? 'enviado' : 'cancelado',
    reqId: p.reqId })

  const w = conWorker(responde)
  const m = await abrirConWorker([tarjeta()], w, conRetenido([tarjeta()]))
  const seccion = m.doc.getElementById('board-held')
  const item = m.doc.querySelector('#board-held [data-req="nota-proyecto-1"]')
  ok('el tablero muestra la seccion de mensajes retenidos', seccion && !seccion.hidden &&
    /Mensajes retenidos/.test(seccion.textContent), seccion && seccion.textContent.slice(0, 200))
  ok('con el chat, el texto entero y el motivo traducido', item &&
    /Laura Ejemplo/.test(item.textContent) && /\$1\.400/.test(item.textContent) &&
    /Retenido por: dinero/.test(item.textContent), item && item.textContent)
  const aprobar = item && item.querySelector('button[data-held="aprobar"]')
  const cancelar = item && item.querySelector('button[data-held="cancelar"]')
  ok('con Aprobar (el principal) y Cancelar', aprobar && aprobar.textContent === 'Aprobar' &&
    aprobar.classList.contains('primario') && cancelar && cancelar.textContent === 'Cancelar')
  aprobar.click()
  await hastaPanel(() => w.pedidos.length === 1)
  ok('Aprobar deja un pedido aprobar-retenido con el id y nada mas que decida el panel',
    w.pedidos[0] && w.pedidos[0].action === 'aprobar-retenido' && w.pedidos[0].reqId === 'nota-proyecto-1' &&
    w.pedidos[0].texto === undefined && w.pedidos[0].caseId === undefined, JSON.stringify(w.pedidos))
  ok('con el veredicto, el retenido sale de la lista y se dice que se envio',
    await hastaPanel(() => !m.doc.querySelector('#board-held [data-req="nota-proyecto-1"]') &&
      /Enviado/.test(m.doc.getElementById('board-held-msg')?.textContent || '')),
    m.doc.getElementById('board-held')?.textContent)

  const w2 = conWorker(responde)
  const n = await abrirConWorker([], w2, conRetenido([]))
  ok('sin casos en el tablero, el retenido igual se ve', !n.doc.getElementById('board-held').hidden &&
    !!n.doc.querySelector('#board-held [data-req="nota-proyecto-1"]'))
  n.doc.querySelector('#board-held button[data-held="cancelar"]').click()
  await hastaPanel(() => w2.pedidos.length === 1)
  ok('Cancelar deja un pedido cancelar-retenido', w2.pedidos[0] &&
    w2.pedidos[0].action === 'cancelar-retenido' && w2.pedidos[0].reqId === 'nota-proyecto-1',
    JSON.stringify(w2.pedidos))
  ok('y dice que no se envio', await hastaPanel(() =>
    /no se envio/i.test(n.doc.getElementById('board-held-msg')?.textContent || '')))

  const w3 = conWorker({ ok: false, code: 'send-approve-not-owner' })
  const e = await abrirConWorker([tarjeta()], w3, conRetenido([tarjeta()]))
  e.doc.querySelector('#board-held button[data-held="aprobar"]').click()
  ok('un error se dice en su lugar y el retenido sigue ahi', await hastaPanel(() =>
    /tablero/.test(e.doc.querySelector('#board-held [data-req="nota-proyecto-1"] .card-msg.mala')?.textContent || '')),
  e.doc.getElementById('board-held')?.textContent)

  const vacio = await abrirConWorker([tarjeta()], conWorker(responde), conRetenido([tarjeta()], []))
  ok('sin retenidos no hay seccion', vacio.doc.getElementById('board-held').hidden)

  for (const [idioma, titulo, boton, motivo] of [['en-US', /Held messages/, 'Approve', /Held for: money/],
    ['pt-BR', /Mensagens retidas/, 'Aprovar', /Retida por: dinheiro/]]) {
    const x = await abrirConWorker([tarjeta()], conWorker(responde), conRetenido([tarjeta()]), idioma)
    const h = x.doc.getElementById('board-held')
    ok(`${idioma}: la seccion, el boton y el motivo en su idioma`, titulo.test(h.textContent) &&
      motivo.test(h.textContent) &&
      h.querySelector('button[data-held="aprobar"]').textContent === boton, h.textContent.slice(0, 300))
  }
}

console.log('\nactivity.html — tablero: cada error se dice, en su idioma')
{
  const CODIGOS = ['E_ARGS', 'E_NOT_FOUND', 'E_STAGE', 'E_NOT_APPROVED', 'E_VERSION', 'E_EXCEPTION',
    'E_BUSY', 'E_NOT_OWNER', 'accion-invalida', 'send-denied', 'send-needs-approval', 'send-no-transport',
    'send-rejected', 'send-timeout', 'send-no-draft', 'send-id-conflict', 'send-wrong-line',
    'send-line-not-linked', 'send-ambiguous-line', 'send-no-signature', 'jev-unavailable',
    'send-approve-not-owner', 'accion-desconocida', 'vencido', 'sin-herramientas', 'sin-permiso', 'demoro', 'fallo']
  const { window } = await montar('activity.html')
  const S = window.STRINGS
  const claves = CODIGOS.map((c) => window.ERR_ACCION[c])
  ok('cada codigo estable tiene su texto', claves.every(Boolean),
    JSON.stringify(CODIGOS.filter((c) => !window.ERR_ACCION[c])))
  for (const lang of ['es', 'en', 'pt']) {
    const sin = claves.filter((k) => !S[lang][k])
    ok(`${lang}: todos los errores tienen frase`, sin.length === 0, JSON.stringify(sin))
  }
  const textos = claves.map((k) => S.es[k])
  ok('en espanol cada error dice algo distinto del codigo crudo',
    textos.every((x) => x && !/^E_|^send-/.test(x)), JSON.stringify(textos))

  for (const [codigo, idioma, patron] of [
    ['E_VERSION', 'es-419', /cambio/i], ['E_VERSION', 'en-US', /changed/i],
    ['send-timeout', 'es-419', /cola/i], ['send-denied', 'en-US', /not allowed|permission/i],
    ['E_BUSY', 'pt-BR', /ocupad/i],
    // La aprobacion sin la llave del plugin (approve-solo-dueno): se dice que no salio.
    ['send-approve-not-owner', 'es-419', /tablero/i],
    ['send-approve-not-owner', 'en-US', /board/i],
    ['send-approve-not-owner', 'pt-BR', /quadro/i]
  ]) {
    const w = conWorker({ ok: false, code: codigo })
    const m = await abrirConWorker([tarjeta()], w, {}, idioma)
    botonTarjeta(m.doc, 1, 'enviar').click()
    const visto = await hastaPanel(() => m.doc.querySelector('.card[data-case="1"] .card-msg.mala'))
    const msg = mensajeDe(m.doc, 1)?.textContent || ''
    ok(`${codigo} en ${idioma} se dice en la tarjeta`, !!visto && patron.test(msg), msg)
    ok(`${codigo}: el boton vuelve para poder corregirlo`, !botonTarjeta(m.doc, 1, 'enviar').disabled)
  }

  const desconocido = conWorker({ ok: false, code: 'algo-nuevo' })
  const m = await abrirConWorker([tarjeta()], desconocido)
  botonTarjeta(m.doc, 1, 'enviar').click()
  await hastaPanel(() => m.doc.querySelector('.card-msg.mala'))
  ok('un codigo que el panel no conoce se dice con el codigo crudo, no se traga',
    /algo-nuevo/.test(m.doc.querySelector('.card-msg').textContent), m.doc.querySelector('.card-msg')?.textContent)

  // E_VERSION: la propuesta cambio. El tablero se relee y el detalle muestra la nueva.
  const cambiada = tarjeta({ proposal: { tipo: 'responder', texto: 'Texto nuevo de la propuesta.', version: 'def' } })
  const w2 = conWorker((pedido, storage) => {
    storage.board = tablero([cambiada])
    return { ok: false, code: 'E_VERSION' }
  })
  const n = await abrirConWorker([tarjeta()], w2)
  botonDe(n.doc, 1, 'enviar').click()
  await hastaPanel(() => n.doc.querySelector('.card-msg.mala'))
  await hastaPanel(() => /Texto nuevo/.test(detalle(n.doc)?.textContent || ''))
  ok('E_VERSION refresca el tablero: el detalle ya muestra la propuesta nueva',
    /Texto nuevo de la propuesta/.test(detalle(n.doc).textContent) &&
    /Texto nuevo de la propuesta/.test(n.doc.querySelector('.card[data-case="1"]').textContent),
    detalle(n.doc)?.textContent)
  ok('y el mensaje de que cambio sigue a la vista',
    !!n.doc.querySelector('#board-detail[data-case="1"] .card-msg.mala'))
  botonDe(n.doc, 1, 'enviar').click()
  await hastaPanel(() => w2.pedidos.length === 2)
  ok('y el siguiente clic lleva la version NUEVA', w2.pedidos[1] && w2.pedidos[1].version === 'def',
    JSON.stringify(w2.pedidos))
}

console.log('\nactivity.html — tablero: sin respuesta del plugin')
{
  const w = conWorker(null)
  const { doc, window, storage } = await abrirConWorker([tarjeta()], w)
  window.ACCION_ESPERA_MS = 700
  botonTarjeta(doc, 1, 'enviar').click()
  const dicho = await hastaPanel(() => doc.querySelector('.card[data-case="1"] .card-msg.mala'), 8000)
  ok('sin veredicto lo dice, no se queda en "…" para siempre', dicho,
    doc.querySelector('.card[data-case="1"]')?.textContent)
  ok('y NO afirma que no se envio: no lo sabe', !/no se envio/i.test(doc.querySelector('.card-msg')?.textContent || ''),
    doc.querySelector('.card-msg')?.textContent)
  ok('deja una lapida en el pedido: un envio que nadie atendio no sale despues, solo',
    storage.scopeRequest && storage.scopeRequest.tombstone === true, JSON.stringify(storage.scopeRequest))
  ok('el boton vuelve', !botonTarjeta(doc, 1, 'enviar').disabled)
}

console.log('\nactivity.html — tablero: Editar y enviar')
{
  const w = conWorker({ ok: true, code: 'enviado' })
  const { doc, window } = await abrirConWorker([tarjeta()], w)
  botonDe(doc, 1, 'editar').click()
  const area = doc.querySelector('#board-detail[data-case="1"] .card-form textarea')
  ok('abre un editor en el detalle con la respuesta propuesta',
    !!area && area.value === 'Le confirmamos el precio vigente.', area && area.value)
  ok('el editor tiene su etiqueta', !!doc.querySelector('.card-form label') &&
    doc.querySelector('.card-form label').getAttribute('for') === area.id)
  area.value = 'Le confirmo el precio de hoy.'
  area.dispatchEvent(new window.Event('input', { bubbles: true }))
  doc.getElementById('refresh').click()
  await espera(); await espera()
  const despues = doc.querySelector('#board-detail[data-case="1"] .card-form textarea')
  ok('el sondeo no se lleva lo que el dueno esta escribiendo',
    !!despues && despues.value === 'Le confirmo el precio de hoy.', despues && despues.value)
  ok('abrir el editor no escribio nada', w.pedidos.length === 0)
  doc.querySelector('#board-detail .card-form button[data-confirma]').click()
  await hastaPanel(() => w.pedidos.length === 1)
  const p = w.pedidos[0]
  ok('Enviar manda el texto editado con la version de la que se partio',
    p && p.action === 'editar-enviar' && p.caseId === 1 && p.version === 'abc' &&
    p.texto === 'Le confirmo el precio de hoy.', JSON.stringify(p))
  ok('y nada mas', p && Object.keys(p).sort().join() === 'action,at,caseId,id,texto,version')
  await hastaPanel(() => /Enviado/.test(detalle(doc).textContent))
  ok('el editor se cierra al enviarse', !doc.querySelector('#board-detail .card-form'))

  botonDe(doc, 1, 'editar').click()
  const vacio = doc.querySelector('#board-detail .card-form textarea')
  vacio.value = '   '
  vacio.dispatchEvent(new window.Event('input', { bubbles: true }))
  doc.querySelector('#board-detail .card-form button[data-confirma]').click()
  await espera()
  ok('un texto vacio no se envia y lo dice', w.pedidos.length === 1 &&
    !!doc.querySelector('#board-detail[data-case="1"] .card-form .card-msg.mala'),
    detalle(doc).textContent)
  doc.querySelector('#board-detail .card-form button[data-cancela]').click()
  ok('Cancelar cierra el editor sin escribir', !doc.querySelector('#board-detail .card-form') &&
    w.pedidos.length === 1)
}

console.log('\nactivity.html — tablero: Ejecutar, Reclasificar, Cerrar y Reabrir')
{
  const w = conWorker({ ok: true, code: 'hecho' })
  const trabajo = tarjeta({ proposal: { tipo: 'trabajar', texto: 'Revisar el modulo', version: 'abc' } })
  const { doc, window } = await abrirConWorker([trabajo, tarjeta({ case_id: 2, stage: 'cerrado', actions: ['reabrir'] })], w)
  botonDe(doc, 1, 'ejecutar').click()
  await hastaPanel(() => w.pedidos.length === 1)
  ok('Ejecutar pide aprobar ESA version del trabajo',
    w.pedidos[0] && w.pedidos[0].action === 'ejecutar' && w.pedidos[0].caseId === 1 &&
    w.pedidos[0].version === 'abc', JSON.stringify(w.pedidos[0]))
  await hastaPanel(() => !botonDe(doc, 1, 'ejecutar')?.disabled)

  botonDe(doc, 1, 'reclasificar').click()
  const nota = doc.querySelector('#board-detail[data-case="1"] .card-form input')
  ok('Reclasificar pide una nota opcional', !!nota && !!doc.querySelector('.card-form label'))
  nota.value = 'Es una queja'
  nota.dispatchEvent(new window.Event('input', { bubbles: true }))
  doc.querySelector('#board-detail[data-case="1"] .card-form button[data-confirma]').click()
  await hastaPanel(() => w.pedidos.length === 2)
  ok('y la manda con el pedido', w.pedidos[1] && w.pedidos[1].action === 'reclasificar' &&
    w.pedidos[1].nota === 'Es una queja' && w.pedidos[1].version === undefined, JSON.stringify(w.pedidos[1]))
  await hastaPanel(() => !!botonDe(doc, 1, 'cerrar') && !botonDe(doc, 1, 'cerrar').disabled)

  botonDe(doc, 1, 'cerrar').click()
  doc.querySelector('#board-detail[data-case="1"] .card-form button[data-confirma]').click()
  await hastaPanel(() => w.pedidos.length === 3)
  ok('Cerrar sin motivo se puede: el motivo es opcional',
    w.pedidos[2] && w.pedidos[2].action === 'cerrar' && !w.pedidos[2].motivo, JSON.stringify(w.pedidos[2]))
  await hastaPanel(() => !!botonDe(doc, 1, 'cerrar') && !botonDe(doc, 1, 'cerrar').disabled)
  botonDe(doc, 1, 'cerrar').click()
  const motivo = doc.querySelector('#board-detail[data-case="1"] .card-form input')
  motivo.value = 'Ya lo resolvimos por telefono'
  motivo.dispatchEvent(new window.Event('input', { bubbles: true }))
  doc.querySelector('#board-detail[data-case="1"] .card-form button[data-confirma]').click()
  await hastaPanel(() => w.pedidos.length === 4)
  ok('Cerrar con motivo lo lleva', w.pedidos[3] && w.pedidos[3].motivo === 'Ya lo resolvimos por telefono',
    JSON.stringify(w.pedidos[3]))
  await hastaPanel(() => !!botonDe(doc, 2, 'reabrir') && !botonDe(doc, 2, 'reabrir').disabled)
  botonDe(doc, 2, 'reabrir').click()
  await hastaPanel(() => w.pedidos.length === 5)
  ok('Reabrir va de un solo clic', w.pedidos[4] && w.pedidos[4].action === 'reabrir' && w.pedidos[4].caseId === 2,
    JSON.stringify(w.pedidos[4]))
  ok('ninguno de esos pedidos lleva actor', w.pedidos.every((p) => !('actor' in p)), JSON.stringify(w.pedidos))
}

console.log('\nactivity.html — tablero: lo aprobado y en cola')
{
  const w = conWorker({ ok: true, code: 'aprobada' })
  const { doc } = await abrirConWorker([tarjeta({ stage: 'trabajo', actions: ['cerrar'],
    proposal: { tipo: 'trabajar', texto: 'Revisar el modulo', version: 'abc' } })], w)
  const etiqueta = doc.querySelector('.card[data-case="1"] .card-aprobada')
  ok('una tarjeta en trabajo se ve aprobada y en cola', !!etiqueta && /aprobada/i.test(etiqueta.textContent),
    doc.querySelector('.card')?.textContent)
  const m = await abrirTablero({ board: tablero([tarjeta()]) })
  ok('y una que espera su decision no', !m.doc.querySelector('.card-aprobada'))
}

console.log('\nactivity.html — tablero: el despacho al agente del proyecto (T8)')
{
  const desde = hace(12 * 60000)
  const board = tablero([
    tarjeta({ case_id: 1, stage: 'trabajo', exceptions: [], actions: ['cerrar'],
      proposal: { tipo: 'trabajar', texto: 'Revisar el modulo', version: 'abc' },
      dispatch: { project: 'Alfa Demo', state: 'activo', outcome: null, at: desde, updated_at: desde } }),
    tarjeta({ case_id: 2, stage: 'listo', exceptions: [], actions: ['enviar', 'editar', 'cerrar'],
      proposal: { tipo: 'responder', texto: '¿Cuál reporte es?', version: 'def' },
      dispatch: { project: 'Alfa Demo', state: 'activo', outcome: 'necesita', at: desde, updated_at: desde } }),
    tarjeta({ case_id: 3, stage: 'respondido', exceptions: [], proposal: null, actions: ['cerrar', 'reabrir'],
      dispatch: { project: 'Alfa Demo', state: 'esperando', outcome: 'necesita', at: desde, updated_at: desde } }),
    tarjeta({ case_id: 4, stage: 'bloqueado', exceptions: [], proposal: null, actions: ['cerrar'],
      blocked_reason: 'bloqueado por el agente del proyecto: hace falta borrar datos',
      dispatch: { project: 'Alfa Demo', state: 'bloqueado', outcome: 'bloqueado', at: desde, updated_at: desde } }),
    tarjeta({ case_id: 5, stage: 'listo', exceptions: [], actions: ['enviar', 'editar', 'cerrar'],
      proposal: { tipo: 'responder', texto: 'Ya quedó, ¿puedes verificar?', version: 'ghi' },
      dispatch: { project: 'Alfa Demo', state: 'reportado', outcome: 'resuelto', at: desde, updated_at: desde } }),
    tarjeta({ case_id: 6, stage: 'trabajo', exceptions: [], actions: ['cerrar'],
      proposal: { tipo: 'trabajar', texto: 'Revisar', version: 'jkl' } })
  ])
  const { doc } = await abrirTablero({ board })
  const txt = (id) => doc.querySelector(`.card[data-case="${id}"] .card-despacho`)?.textContent || ''
  ok('en trabajo dice a donde se despacho y desde cuando',
    /Despachado a Alfa Demo/.test(txt(1)) && /hace 12 min/.test(txt(1)) &&
    /Esperando al agente del proyecto/.test(txt(1)), txt(1))
  ok('y ya no dice "en cola": salio', !doc.querySelector('.card[data-case="1"] .card-aprobada'))
  ok('en listo con necesita dice que el proyecto pide informacion', /pide mas informacion/.test(txt(2)), txt(2))
  ok('en respondido esperando al cliente lo dice con su hora',
    /Esperando al cliente/.test(txt(3)) && /hace 12 min/.test(txt(3)), txt(3))
  ok('bloqueado por el agente lo dice, y el motivo sigue a la vista',
    /Bloqueado por el agente de Alfa Demo/.test(txt(4)) &&
    /borrar datos/.test(doc.querySelector('.card[data-case="4"] .card-blocked')?.textContent || ''), txt(4))
  ok('en listo con resuelto dice quien lo resolvio', /Resuelto por el agente de Alfa Demo/.test(txt(5)), txt(5))
  ok('sin despacho, en trabajo sigue "aprobada, en cola"',
    !txt(6) && !!doc.querySelector('.card[data-case="6"] .card-aprobada'))
  const hostil = '<img src=x onerror="window.__xssDesp=1">'
  const m = await abrirTablero({ board: tablero([tarjeta({ stage: 'trabajo', exceptions: [],
    dispatch: { project: hostil, state: 'activo', outcome: null, at: desde } })]) })
  ok('el nombre del proyecto es texto, nunca HTML', !m.doc.querySelector('.card-despacho img') &&
    m.doc.querySelector('.card-despacho').textContent.includes('<img'))
  const raro = await abrirTablero({ board: tablero([tarjeta({ stage: 'trabajo', exceptions: [],
    dispatch: 'no-es-un-objeto' })]) })
  ok('un despacho con otra forma no pinta nada ni rompe', !raro.doc.querySelector('.card-despacho') &&
    !!raro.doc.querySelector('.card[data-case="1"]'))
  const en = await abrirTablero({ board }, 'en-US')
  ok('en ingles tambien', /Dispatched to Alfa Demo/.test(en.doc.querySelector('.card[data-case="1"] .card-despacho')?.textContent || ''))
}

console.log('\nactivity.html — tablero: texto de clientes en el editor y en los mensajes, nunca HTML')
{
  const hostil = '<img src=x onerror="window.__xss2=1"><b>negrita</b>'
  const w = conWorker({ ok: false, code: hostil })
  const m = await abrirConWorker([tarjeta({ proposal: { tipo: 'responder', texto: hostil, version: 'abc' } })], w)
  botonDe(m.doc, 1, 'editar').click()
  const area = m.doc.querySelector('.card-form textarea')
  ok('el editor lleva el texto como texto', area.value === hostil && m.doc.querySelectorAll('.card-form img, .card-form b').length === 0)
  m.doc.querySelector('.card-form button[data-cancela]').click()
  botonDe(m.doc, 1, 'enviar').click()
  await hastaPanel(() => m.doc.querySelector('.card-msg.mala'))
  ok('un codigo hostil del veredicto se pinta como texto',
    m.doc.querySelectorAll('#view-board img, #view-board b').length === 0 &&
    m.window.__xss2 === undefined && m.doc.querySelector('.card-msg').textContent.includes('<img'))
}

console.log('\nactivity.html — tablero: textos de las acciones (tres idiomas)')
{
  const { window } = await montar('activity.html')
  const S = window.STRINGS
  const nuevas = Object.keys(S.en).filter((k) => /^ac[A-Z]/.test(k))
  ok('hay textos de las acciones', nuevas.length > 40, String(nuevas.length))
  ok('cada texto existe en espanol, ingles y portugues', nuevas.every((k) => S.es[k] && S.pt[k]),
    JSON.stringify(nuevas.filter((k) => !S.es[k] || !S.pt[k])))
  const conTilde = nuevas.filter((k) => /[^\x00-\x7f…]/.test(S.es[k] + S.pt[k]))
  ok('van sin tildes ni enie, como el resto del panel', conTilde.length === 0, JSON.stringify(conTilde))
  const tuteo = nuevas.filter((k) => /\b(tu|tus|te|ti)\b/i.test(S.es[k]))
  ok('y el espanol habla de usted', tuteo.length === 0, JSON.stringify(tuteo))
  const igualPt = nuevas.filter((k) => S.pt[k] === S.en[k] && S.en[k].length > 6)
  ok('el portugues es propio, no ingles prestado', igualPt.length === 0, JSON.stringify(igualPt))
  ok('los botones se llaman como pide la tarea',
    S.es.acEnviar === 'Enviar' && S.es.acEditar === 'Editar y enviar' && S.es.acEjecutar === 'Ejecutar' &&
    S.es.acReclasificar === 'Reclasificar' && S.es.acCerrar === 'Cerrar' && S.es.acReabrir === 'Reabrir',
    JSON.stringify([S.es.acEnviar, S.es.acEditar, S.es.acEjecutar]))
}

console.log('\nactivity.html — tablero: estados vacios')
{
  const vacioDe = (doc) => doc.getElementById('board-empty')
  const sin = await abrirTablero({})
  ok('sin la clave `board` dice que todavia no hay datos, en UN estado vacio',
    !vacioDe(sin.doc).hidden && vacioDe(sin.doc).textContent.trim().length > 0 &&
    sin.doc.querySelectorAll('#board-cols .col').length === 0,
    vacioDe(sin.doc).textContent)
  const vacio = await abrirTablero({ board: tablero([]) })
  ok('un tablero sin casos lo dice con un solo estado vacio, no ocho cajas',
    /no hay casos/i.test(vacioDe(vacio.doc).textContent) && !vacioDe(vacio.doc).hidden &&
    vacio.doc.querySelectorAll('#board-cols .col').length === 0 &&
    vacio.doc.getElementById('board-bar').hidden,
    vacioDe(vacio.doc).textContent)
  const v2 = await abrirTablero({ board: { v: 2, cards: [], counts: {} } })
  ok('una version que este panel no entiende se dice, no se adivina',
    /version|versi/i.test(vacioDe(v2.doc).textContent) && vacioDe(v2.doc).classList.contains('error') &&
    v2.doc.querySelectorAll('.card').length === 0,
    vacioDe(v2.doc).textContent)
  const lleno = await abrirTablero({ board: tablero([tarjeta()]) })
  ok('con casos no hay estado vacio', vacioDe(lleno.doc).hidden && !lleno.doc.getElementById('board-bar').hidden)
  const corto = await abrirTablero({ board: tablero([tarjeta()], { truncated: true }) })
  ok('truncated avisa que no se ve todo',
    /mas recientes|no caben/i.test(corto.doc.getElementById('board-note').textContent),
    corto.doc.getElementById('board-note').textContent)
  const raro = await abrirTablero({ board: tablero([tarjeta(), tarjeta({ case_id: 9,
    stage: 'etapa-nueva' })]) })
  ok('una tarjeta de una etapa desconocida no se cuela en otra columna',
    raro.doc.querySelectorAll('.card').length === 1)
  ok('y se avisa que hubo una que no se pudo ubicar',
    /1/.test(raro.doc.getElementById('board-note').textContent) &&
    raro.doc.getElementById('board-note').textContent.length > 3,
    raro.doc.getElementById('board-note').textContent)
  const roto = await abrirTablero({ board: { v: 1, cards: 'no-es-lista', counts: null } })
  ok('un `board` malformado no rompe el panel', roto.doc.querySelectorAll('.card').length === 0 &&
    roto.doc.getElementById('view-board') !== null && !!roto.doc.getElementById('synced'))
  const vieja = await abrirTablero({ board: tablero([tarjeta()], { updated_at: hace(3 * 3600000) }) })
  ok('un tablero viejo se marca como viejo',
    !!vieja.doc.querySelector('#board-synced .vieja'), vieja.doc.getElementById('board-synced').innerHTML)
}

console.log('\nactivity.html — tablero: cada numero, su tablero (T9)')
{
  const ajena = tarjeta({ case_id: 7, account: 'pn:573000000013', title: 'Caso de otra linea' })
  const mia = tarjeta({ case_id: 8, account: 'pn:573000000012', title: 'Caso de esta linea' })
  const { doc } = await abrirTablero({
    board: tablero([ajena, mia]),
    sidecar: { connection: 'open', cuenta: 'pn:573000000012', latido: { ts: Date.now() } } })
  const t = doc.getElementById('board-cols').textContent
  ok('no pinta los casos de otro numero', !t.includes('Caso de otra linea') &&
    t.includes('Caso de esta linea'), t)
  ok('y la cuenta de la columna es la de lo que se ve',
    doc.querySelector('.col[data-stage="decision"] .col-count').textContent.trim() === '1')
  const sinLinea = await abrirTablero({ board: tablero([ajena, mia]) })
  ok('sin numero conocido no se filtra nada', sinLinea.doc.querySelectorAll('.card').length === 2)
}

console.log('\nactivity.html — tablero: textos largos')
{
  const largo = 'Texto muy largo sin fin '.repeat(40)
  const cards = [tarjeta({ title: largo, summary: largo,
    proposal: { tipo: 'trabajar', texto: largo, version: 'v' } })]
  const { doc } = await abrirTablero({ board: tablero(cards) })
  ok('el titulo de la tarjeta se recorta a dos lineas, como en Plane',
    doc.querySelector('.card[data-case="1"] .card-title').classList.contains('clamp2'))
  const d = abrirDetalle(doc, 1)
  ok('y en el detalle se lee entero, titulo, resumen y propuesta',
    d.querySelector('.det-title').textContent === largo &&
    d.querySelector('.det-sum').textContent.includes(largo.trim()) &&
    d.querySelector('.card-prop').textContent.includes(largo.trim()))
  ok('no queda el viejo "Ver todo"', !doc.querySelector('.card-more'))
}

console.log('\nactivity.html — tablero: tres idiomas')
{
  const board = tablero([tarjeta({ ticket: 'ACM-42' }), tarjeta({ case_id: 2, stage: 'bloqueado',
    blocked_reason: 'x', exceptions: [] })])
  // Partida a proposito: check-voseo lee esa raiz como voseo aunque sea portugues.
  const DECISION_PT = ['Sua d', 'ecisao'].join('')
  for (const [lang, decision, hace5, flag, clase, exc, todos] of [
    ['es-419', 'Su decision', /hace 5 min/, /dinero/i, /solicitud de soporte/, 'Necesita su decision por: dinero', 'Todos'],
    ['en-US', 'Your decision', /5 min ago/, /money/i, /support request/, 'Needs your decision because: money', 'All'],
    ['pt-BR', DECISION_PT, /ha 5 min/, /dinheiro/i, /pedido de suporte/, 'Precisa da sua decisao por: dinheiro', 'Todos']
  ]) {
    const m = await abrirTablero({ board }, lang)
    const d = m.doc
    ok(`${lang}: la columna se llama ${decision}`,
      d.querySelector('.col[data-stage="decision"] .col-name').textContent === decision,
      d.querySelector('.col[data-stage="decision"] .col-name')?.textContent)
    ok(`${lang}: la antiguedad`, hace5.test(d.querySelector('.card .when').textContent),
      d.querySelector('.card .when')?.textContent)
    ok(`${lang}: el motivo en una linea`, d.querySelector('.card .card-exc').textContent === exc,
      d.querySelector('.card .card-exc')?.textContent)
    ok(`${lang}: "Todos"`, d.querySelector('#board-chips button[data-etapa="todos"] .chip-name').textContent === todos,
      d.querySelector('#board-chips button[data-etapa="todos"]')?.textContent)
    const det = abrirDetalle(d, 1)
    ok(`${lang}: lo que vio Jev`, flag.test(det.querySelector('.det-jev').textContent) &&
      clase.test(det.querySelector('.det-jev').textContent), det.querySelector('.det-jev')?.textContent)
    ok(`${lang}: el buscador`, d.getElementById('board-search').placeholder.length > 5)
  }
  const { window } = await montar('activity.html')
  const S = window.STRINGS
  const nuevas = Object.keys(S.en).filter((k) => /^(board|stage|prio|flag|jev|exc|prop|blocked|ticket|ago|det|actor)/.test(k))
  ok('hay textos nuevos del tablero', nuevas.length > 40, String(nuevas.length))
  const faltan = nuevas.filter((k) => !S.es[k] || !S.pt[k])
  ok('cada texto del tablero existe en espanol, ingles y portugues', faltan.length === 0,
    JSON.stringify(faltan))
  // Como el resto del panel: de usted y sin tildes ni enie, en espanol y en portugues.
  const conTilde = nuevas.filter((k) => /[^\x00-\x7f\u2026]/.test(S.es[k] + S.pt[k]))
  ok('los textos del tablero van sin tildes ni enie, como el resto del panel',
    conTilde.length === 0, JSON.stringify(conTilde))
  const tuteo = nuevas.filter((k) => /\b(tu|tus|te|ti)\b|\bActualiza\b|\bBusca\b/i.test(S.es[k]) ||
    /\bvoc[eê]\b/i.test(S.pt[k]) && !/\bvoce\b/.test(S.pt[k]))
  ok('y el espanol habla de usted, no de tu', tuteo.length === 0, JSON.stringify(tuteo))
  ok('"Actualice el plugin" y "Su decision": usted en los dos textos que lo pedian',
    S.es.boardUnsupported.includes('Actualice el plugin') && S.es.excLead === 'Necesita su decision por' &&
    S.es.flagAsksOwnerToAct === 'le pide actuar')
  const igualPt = nuevas.filter((k) => S.pt[k] === S.en[k] && !/^(stageTrabajo)/.test(k) &&
    S.en[k].length > 6)
  ok('y el portugues es propio, no ingles prestado', igualPt.length === 0, JSON.stringify(igualPt))
  // Las 17 clases de atencion de Jev (bin/wa_jev.py, CLASES_ATENCION), en los tres idiomas.
  const CLASES_JEV = ['support_request', 'bug_report', 'status_question', 'existing_ticket_reference',
    'access_or_credential', 'money', 'needs_decision', 'deploy_request', 'client_waiting_or_down',
    'pleasantry', 'meeting', 'bare_mention', 'notice_to_team', 'unrelated_chatter', 'unclear',
    'empty_or_audio_only', 'no_match']
  const sinFrase = CLASES_JEV.filter((c) => !window.JEV_CLASE_KEY[c] ||
    ['es', 'en', 'pt'].some((l) => !S[l][window.JEV_CLASE_KEY[c]]))
  ok('cada clase de atencion de Jev tiene su frase en los tres idiomas', sinFrase.length === 0,
    JSON.stringify(sinFrase))
}

console.log('\nactivity.html — tablero: lo que era la cola, con Atender ahora e Ignorar')
{
  const recibido = tarjeta({ case_id: 4, stage: 'recibido', proposal: null, exceptions: [],
    title: 'Nota de voz', actions: ['atender', 'ignorar', 'reclasificar', 'cerrar', 'proyecto'] })
  const clasificado = tarjeta({ case_id: 5, stage: 'clasificado', proposal: null, exceptions: [],
    needs_agent: true, actions: ['atender', 'ignorar', 'reclasificar', 'cerrar', 'proyecto'] })
  const w = conWorker({ ok: true, code: 'atendido' })
  const { doc, storage } = await abrirConWorker([recibido, clasificado], w)
  ok('un caso en Recibido lleva Atender ahora en la tarjeta',
    botonTarjeta(doc, 4, 'atender')?.textContent === 'Atender ahora',
    doc.querySelector('.card[data-case="4"]')?.innerHTML)
  ok('uno marcado para el agente lo dice en la tarjeta',
    /proxima corrida/.test(doc.querySelector('.card[data-case="5"] .card-agente')?.textContent || ''),
    doc.querySelector('.card[data-case="5"]')?.textContent)
  const d = abrirDetalle(doc, 4)
  ok('el detalle ofrece Atender ahora, Ignorar, Reclasificar, Cerrar y Cambiar proyecto',
    [...d.querySelectorAll('.det-acts button[data-accion]')].map((b) => b.dataset.accion).join() ===
      'atender,ignorar,reclasificar,cerrar,proyecto',
    [...d.querySelectorAll('.det-acts button[data-accion]')].map((b) => b.dataset.accion).join())
  botonTarjeta(doc, 4, 'atender').click()
  await hastaPanel(() => w.pedidos.length === 1)
  ok('Atender ahora deja UN pedido con el caso y nada mas',
    w.pedidos[0] && w.pedidos[0].action === 'atender' && w.pedidos[0].caseId === 4 &&
    Object.keys(w.pedidos[0]).sort().join() === 'action,at,caseId,id', JSON.stringify(w.pedidos))
  ok('y dice que el agente lo atendera', await hastaPanel(() =>
    /proxima corrida/.test(mensajeDe(doc, 4)?.textContent || '')), mensajeDe(doc, 4)?.textContent)
  ok('sin tocar la vieja clave `decisions`', !('decisions' in storage))

  const w2 = conWorker({ ok: true, code: 'ignorado' })
  const m = await abrirConWorker([recibido], w2)
  botonDe(m.doc, 4, 'ignorar').click()
  await hastaPanel(() => w2.pedidos.length === 1)
  ok('Ignorar va de un clic, sin formulario', w2.pedidos[0] && w2.pedidos[0].action === 'ignorar' &&
    w2.pedidos[0].caseId === 4, JSON.stringify(w2.pedidos))
  ok('y se dice', await hastaPanel(() => /ignorado/i.test(mensajeDe(m.doc, 4)?.textContent || '')))

  const e = await abrirTablero({ board: tablero([tarjeta({ case_id: 9, stage: 'decision',
    actions: ['atender', 'ignorar', 'enviar'] })]) })
  abrirDetalle(e.doc, 9)
  ok('fuera de Recibido y Clasificado no se ofrecen aunque `actions` los traiga',
    !e.doc.querySelector('#board-detail button[data-accion="atender"]') &&
    !e.doc.querySelector('#board-detail button[data-accion="ignorar"]'))
}

console.log('\nactivity.html — tablero: Atender ahora dice si el agente salio')
{
  const caso = () => tarjeta({ case_id: 4, stage: 'recibido', proposal: null, exceptions: [],
    title: 'Nota de voz', actions: ['atender', 'ignorar', 'reclasificar', 'cerrar', 'proyecto'] })
  const clic = async (respuesta, idioma = 'es-419') => {
    const w = conWorker({ ok: true, code: 'atendido', caseId: 4, ...respuesta })
    const { doc } = await abrirConWorker([caso()], w, {}, idioma)
    botonTarjeta(doc, 4, 'atender').click()
    await hastaPanel(() => w.pedidos.length === 1)
    await hastaPanel(() => !!mensajeDe(doc, 4))
    return mensajeDe(doc, 4)
  }

  const lanzado = await clic({ agent: 'launched' })
  ok('lanzado: junto a la tarjeta dice que se lanzo el agente',
    /se lanzo el agente/i.test(lanzado?.textContent || ''), lanzado?.textContent)
  ok('y no promete que ya esta respondiendo: el login del agente solo se sabe despues',
    !/ya (esta|estan)|respondiendo|atendiendo/i.test(lanzado?.textContent || ''), lanzado?.textContent)
  ok('ni lo pinta como error', !!lanzado && !lanzado.classList.contains('mala') &&
    lanzado.getAttribute('role') === 'status', lanzado?.className)

  const enCurso = await clic({ agent: 'running' })
  ok('running: ya hay un agente de casos trabajando, y no es un error',
    /ya hay un agente de casos trabajando/i.test(enCurso?.textContent || '') &&
    !enCurso.classList.contains('mala'), enCurso?.textContent)

  const sinCuenta = await clic({ agent: 'run-failed', agentReason: 'sin-cuenta' })
  ok('un motivo estable de wa-scope se dice con su frase, como en el tablero',
    /no pude lanzar al agente: ninguna cuenta de Claude esta libre/i.test(sinCuenta?.textContent || '') &&
    /marcado/.test(sinCuenta?.textContent || '') && sinCuenta.classList.contains('mala') &&
    sinCuenta.getAttribute('role') === 'alert', sinCuenta?.textContent)

  const sinCli = await clic({ agent: 'orca-cli-missing' })
  ok('orca-cli-missing dice que no se hallo la CLI de Orca',
    /CLI de Orca/.test(sinCli?.textContent || '') && sinCli.classList.contains('mala'), sinCli?.textContent)

  const fallo = await clic({ agent: 'run-failed', agentReason: 'exit-1' })
  ok('run-failed dice el motivo corto que dio el worker',
    /no pude lanzar al agente/i.test(fallo?.textContent || '') && /exit-1/.test(fallo?.textContent || '') &&
    fallo.classList.contains('mala'), fallo?.textContent)
  const largo = await clic({ agent: 'run-failed', agentReason: 'x'.repeat(500) })
  ok('un motivo desmedido se recorta', (largo?.textContent || '').length < 300, (largo?.textContent || '').length)

  const en = await clic({ agent: 'launched' }, 'en')
  ok('en ingles', /agent was launched/i.test(en?.textContent || '') &&
    !/(already|is now) (replying|handling)/i.test(en?.textContent || ''), en?.textContent)
  const enFallo = await clic({ agent: 'run-failed', agentReason: 'exit-1' }, 'en')
  ok('y el fallo tambien', /could not launch the agent/i.test(enFallo?.textContent || ''), enFallo?.textContent)
  const pt = await clic({ agent: 'launched' }, 'pt-BR')
  ok('en portugues', /agente foi lan/i.test(pt?.textContent || ''), pt?.textContent)

  const viejo = await clic({})
  ok('un worker que no dice nada del agente conserva el mensaje de siempre',
    /proxima corrida/.test(viejo?.textContent || ''), viejo?.textContent)
  const raro = await clic({ agent: 'inventado' })
  ok('un codigo de agente desconocido no rompe: cae al mensaje de siempre',
    /proxima corrida/.test(raro?.textContent || ''), raro?.textContent)
}

console.log('\nconfig.html — la cuenta de Claude del bot')
{
  const CUENTAS = [
    { id: 'cuenta-bot', email: 'bot@example.invalid', authenticated: true, active: false, used: 20 },
    { id: 'cuenta-sin', email: 'sin@example.invalid', authenticated: false, active: true, used: null }]
  const conCuentas = (respuesta, pedidos) => (d, st) => {
    if (!(d.action === 'storage.set' && d.params.key === 'scopeRequest' && d.params.value)) {
      return undefined
    }
    const p = d.params.value
    pedidos.push(p)
    st.scopeRequest = p
    st.scopeResult = { at: new Date().toISOString(), requestId: p.id, action: p.action, ...respuesta }
    return { ok: true }
  }
  const abrir = async (storage, respuesta, idioma = 'es-419') => {
    const pedidos = []
    const m = await montar('config.html', storage, idioma, conCuentas(respuesta, pedidos))
    m.doc.getElementById('tab-agente').click()
    await hastaPanel(() => m.doc.querySelectorAll('#bot-account button').length > 1 ||
      /No pude/.test(m.doc.getElementById('bot-account-status')?.textContent || ''))
    return { ...m, pedidos }
  }
  const opciones = (doc) => [...doc.querySelectorAll('#bot-account button')]
    .map((b) => [b.dataset.value, b.textContent.replace(/\s+/g, ' ').trim()])

  const { doc, storage, pedidos } = await abrir({ botClaudeAccount: 'cuenta-bot' },
    { ok: true, code: 'cuentas', accounts: CUENTAS })
  ok('la pestana Agente tiene la seccion "Cuenta de Claude del bot"',
    /Cuenta de Claude del bot/.test(doc.getElementById('view-agente').textContent),
    doc.getElementById('view-agente').textContent.slice(0, 200))
  ok('le pide las cuentas al worker por el canal de siempre',
    pedidos.some((p) => p.action === 'cuentas-claude'), JSON.stringify(pedidos))
  const ops = opciones(doc)
  ok('ofrece Automatica y cada cuenta por su correo, nunca un select',
    (ops[0] || [])[0] === 'auto' && /Automatica/.test((ops[0] || [])[1]) &&
    ops.some(([v, txt]) => v === 'cuenta-bot' && /bot@example\.invalid/.test(txt)) &&
    ops.some(([v, txt]) => v === 'cuenta-sin' && /sin@example\.invalid/.test(txt)) &&
    !doc.querySelector('#view-agente select'), JSON.stringify(ops))
  ok('la que no tiene sesion lo dice', ops.some(([v, txt]) => v === 'cuenta-sin' && /sin sesion/.test(txt)),
    JSON.stringify(ops))
  ok('lo guardado queda apretado', valorSeg(doc, 'bot-account') === 'cuenta-bot', valorSeg(doc, 'bot-account'))
  elegirSeg(doc, 'bot-account', 'auto')
  doc.getElementById('save-bot-account').click()
  await hastaPanel(() => storage.botClaudeAccount === 'auto')
  ok('elegir Automatica y guardar deja `auto`', storage.botClaudeAccount === 'auto', storage.botClaudeAccount)
  elegirSeg(doc, 'bot-account', 'cuenta-sin')
  doc.getElementById('save-bot-account').click()
  await hastaPanel(() => storage.botClaudeAccount === 'cuenta-sin')
  ok('y una cuenta guarda su id, no su correo', storage.botClaudeAccount === 'cuenta-sin',
    storage.botClaudeAccount)

  const vieja = await abrir({ botClaudeAccount: 'cuenta-que-ya-no-esta' },
    { ok: true, code: 'cuentas', accounts: CUENTAS })
  ok('una guardada que Orca ya no lista se ve, apretada y dicha',
    valorSeg(vieja.doc, 'bot-account') === 'cuenta-que-ya-no-esta' &&
    opciones(vieja.doc).some(([v, txt]) => v === 'cuenta-que-ya-no-esta' && /ya no aparece/.test(txt)),
    JSON.stringify(opciones(vieja.doc)))

  const sinNada = await abrir({}, { ok: true, code: 'cuentas', accounts: CUENTAS })
  ok('sin nada guardado rige Automatica', valorSeg(sinNada.doc, 'bot-account') === 'auto',
    valorSeg(sinNada.doc, 'bot-account'))

  const falla = await abrir({ botClaudeAccount: 'cuenta-bot' }, { ok: false, code: 'cuentas-fallo' })
  ok('si no pudo leer las cuentas lo dice, y Automatica sigue a mano',
    /No pude leer las cuentas de Claude/.test(falla.doc.getElementById('bot-account-status').textContent) &&
    opciones(falla.doc).some(([v]) => v === 'auto'), falla.doc.getElementById('bot-account-status').textContent)
  ok('y sin la lista no dice que la guardada ya no aparece: no lo sabe',
    valorSeg(falla.doc, 'bot-account') === 'cuenta-bot' &&
    !opciones(falla.doc).some(([, txt]) => /ya no aparece/.test(txt)), JSON.stringify(opciones(falla.doc)))

  const en = await abrir({}, { ok: true, code: 'cuentas', accounts: CUENTAS }, 'en')
  ok('en ingles', /Bot Claude account/.test(en.doc.getElementById('view-agente').textContent) &&
    /Automatic/.test((opciones(en.doc)[0] || [])[1]), JSON.stringify(opciones(en.doc)))
}

console.log('\nactivity.html — tablero: si no pude lanzar al agente, se dice')
{
  const AHORA = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const actividad = { syncedAt: AHORA, running: false, pending: [], recent: [],
    mapped: 3, authorized: 3,
    run: { state: 'ok', startedAt: AHORA, endedAt: AHORA, looked: 3, pending: 0, reason: null } }
  const fallo = (reason, detail = 'orca terminal create: This Claude account is in use') =>
    ({ state: 'failed', reason, detail, at: '2026-10-02T13:50:00-05:00' })
  const marcado = tarjeta({ case_id: 5, stage: 'clasificado', proposal: null, exceptions: [],
    needs_agent: true, waits_agent: true })
  const recibido = tarjeta({ case_id: 6, stage: 'recibido', proposal: null, exceptions: [],
    needs_agent: false, waits_agent: true })
  const otro = tarjeta({ case_id: 7, stage: 'decision', waits_agent: false })
  const abre = async (launch, idioma = 'es-419', espera = 2) => (await abrirTablero({ activity: actividad,
    board: tablero([marcado, recibido, otro], { agent_waiting: espera, agent_launch: launch }) },
  idioma)).doc
  const nota = (doc, id) => doc.querySelector(`.card[data-case="${id}"] .card-agente`)
  const linea = (doc) => doc.getElementById('runline')

  const doc = await abre(fallo('sin-cuenta'))
  ok('la tarjeta marcada dice que no pude lanzar al agente, y por que',
    /No pude lanzar al agente: ninguna cuenta de Claude esta libre/.test(nota(doc, 5)?.textContent || '') &&
    !/proxima corrida/.test(nota(doc, 5)?.textContent || ''), nota(doc, 5)?.textContent)
  ok('pintada como falla, con el detalle de Orca al pasar el raton',
    nota(doc, 5)?.classList.contains('fallo') && /in use/.test(nota(doc, 5)?.title || ''),
    nota(doc, 5)?.outerHTML)
  ok('tambien la que espera al agente sin estar marcada',
    /No pude lanzar al agente/.test(nota(doc, 6)?.textContent || ''), nota(doc, 6)?.textContent)
  ok('y no la que no lo espera', !nota(doc, 7), nota(doc, 7)?.textContent)
  ok('la linea de la revision lo dice despues de los casos para el agente',
    /2 casos para el agente · No pude lanzar al agente: ninguna cuenta de Claude esta libre/.test(
      linea(doc).textContent) && linea(doc).classList.contains('stale'), linea(doc).textContent)

  const motivos = { 'sin-cli': /CLI de Orca/, 'sin-espacio': /espacio del plugin/,
    'sin-terminal': /terminal/, 'no-listo': /listo/, 'no-recibio': /no recibio/,
    'a-medias': /a la mitad/, 'sin-tiempo': /tiempo/, 'sin-prompt': /archivo del caso/,
    'se-cerro': /Claude se cerro al abrir; lo vuelvo a abrir en unos minutos/,
    'se-cierra': /Claude se cerro al abrir tres veces seguidas; espero una hora/ }
  const malos = []
  for (const [codigo, frase] of Object.entries(motivos)) {
    const d = await abre(fallo(codigo))
    if (!frase.test(nota(d, 5)?.textContent || '')) malos.push(`${codigo}: ${nota(d, 5)?.textContent}`)
  }
  ok('cada motivo estable tiene su frase', malos.length === 0, JSON.stringify(malos))
  const raro = await abre(fallo('codigo-nuevo'))
  ok('un motivo que el panel no conoce dice la falla igual, sin el codigo crudo',
    /No pude lanzar al agente/.test(nota(raro, 5)?.textContent || '') &&
    !/codigo-nuevo/.test(nota(raro, 5)?.textContent || ''), nota(raro, 5)?.textContent)

  const corriendo = await abre({ state: 'running', reason: null, detail: null, at: '2026-10-02T13:50:00-05:00' })
  ok('con el agente corriendo la tarjeta no dice falla',
    !/No pude/.test(nota(corriendo, 5)?.textContent || '') &&
    !/No pude/.test(linea(corriendo).textContent), nota(corriendo, 5)?.textContent)
  const sinEspera = await abre(fallo('sin-cuenta'), 'es-419', 0)
  ok('una falla vieja sin casos esperando no se dice en la linea',
    !/No pude/.test(linea(sinEspera).textContent), linea(sinEspera).textContent)
  const sinDato = await abre(undefined)
  ok('un tablero sin agent_launch conserva el aviso de siempre',
    /proxima corrida/.test(nota(sinDato, 5)?.textContent || ''), nota(sinDato, 5)?.textContent)

  const en = await abre(fallo('sin-cuenta'), 'en')
  ok('en ingles', /Could not launch the agent: no Claude account is free/.test(nota(en, 5)?.textContent || '') &&
    /Could not launch the agent/.test(linea(en).textContent), nota(en, 5)?.textContent)
  const cerrado = await abre(Object.assign(fallo('se-cerro'), {
    detail: 'Claude se cerro al abrir: Security guide' }))
  ok('Claude se cerro al abrir: la tarjeta lo dice y la ultima linea va al pasar el raton',
    /No pude lanzar al agente: Claude se cerro al abrir/.test(nota(cerrado, 5)?.textContent || '') &&
    /Security guide/.test(nota(cerrado, 5)?.title || '') &&
    /No pude lanzar al agente: Claude se cerro al abrir/.test(linea(cerrado).textContent),
    nota(cerrado, 5)?.outerHTML)
  const cierraEn = await abre(fallo('se-cierra'), 'en')
  ok('y en ingles, la pausa de una hora', /three times in a row; I will wait an hour/.test(
    nota(cierraEn, 5)?.textContent || ''), nota(cierraEn, 5)?.textContent)
  const pt = await abre(fallo('sin-cuenta'), 'pt-BR')
  ok('en portugues', /Nao consegui lancar o agente/.test(nota(pt, 5)?.textContent || ''),
    nota(pt, 5)?.textContent)
}

console.log('\nactivity.html — tablero: con que cuenta de Claude, si no fue la del bot')
{
  const AHORA = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const actividad = { syncedAt: AHORA, running: false, pending: [], recent: [],
    mapped: 3, authorized: 3,
    run: { state: 'ok', startedAt: AHORA, endedAt: AHORA, looked: 3, pending: 0, reason: null } }
  const despacho = (extra) => tarjeta({ case_id: 9, stage: 'trabajo', exceptions: [],
    proposal: { tipo: 'trabajar', texto: 'Revisar el reporte', version: 'v9' },
    dispatch: Object.assign({ project: 'Alfa Demo', state: 'activo', outcome: null,
      at: '2026-10-02T13:50:00-05:00', updated_at: '2026-10-02T13:50:00-05:00' }, extra) })
  const abre = async (cards, extra = {}, idioma = 'es-419') => (await abrirTablero({ activity: actividad,
    board: tablero(cards, Object.assign({ agent_waiting: 1 }, extra)) }, idioma)).doc
  const texto = (doc, id) => doc.querySelector(`.card[data-case="${id}"] .card-despacho`)?.textContent || ''

  const conRespaldo = await abre([despacho({ account: 'libre@example.invalid', fallback: 'elegida-sin-sesion' })])
  ok('el despacho que no uso la cuenta del bot dice cual uso y por que',
    /Cuenta de respaldo: libre@example\.invalid \(la elegida no tiene sesion\)/.test(texto(conRespaldo, 9)),
    texto(conRespaldo, 9))
  const sinRespaldo = await abre([despacho({ account: 'bot@example.invalid', fallback: null })])
  ok('con la cuenta del bot no agrega nada', !/respaldo/.test(texto(sinRespaldo, 9)), texto(sinRespaldo, 9))
  const motivos = { 'elegida-no-esta': /ya no aparece/, 'elegida-sin-cuota': /cuota/,
    'elegida-fallo': /fallo al abrir/ }
  const malos = []
  for (const [codigo, frase] of Object.entries(motivos)) {
    const d = await abre([despacho({ account: 'libre@example.invalid', fallback: codigo })])
    if (!frase.test(texto(d, 9))) malos.push(`${codigo}: ${texto(d, 9)}`)
  }
  ok('cada motivo del respaldo tiene su frase', malos.length === 0, JSON.stringify(malos))
  const sinCuenta = await abre([despacho({ account: null, fallback: 'elegida-fallo' })])
  ok('sin saber cual uso, dice que la eligio Orca',
    /Cuenta de respaldo: la que elige Orca/.test(texto(sinCuenta, 9)), texto(sinCuenta, 9))

  const agente = await abre([tarjeta({ case_id: 5, stage: 'clasificado', proposal: null,
    exceptions: [], waits_agent: true })], { agent_launch: { state: 'running',
    at: '2026-10-02T13:50:00-05:00', account: 'libre@example.invalid', fallback: 'elegida-fallo' } })
  const linea = agente.getElementById('runline').textContent
  ok('la linea de la revision dice con que cuenta corre el agente de casos y por que',
    /Agente de casos con la cuenta de respaldo libre@example\.invalid \(la elegida fallo al abrir\)/.test(linea),
    linea)
  const en = await abre([despacho({ account: 'libre@example.invalid', fallback: 'elegida-sin-sesion' })],
    {}, 'en')
  ok('en ingles', /Fallback account: libre@example\.invalid \(the chosen one is signed out\)/.test(texto(en, 9)),
    texto(en, 9))
}

console.log('\nactivity.html — tablero: el proyecto del caso, a mano')
{
  const caso = tarjeta({ case_id: 6, stage: 'clasificado', proposal: null, exceptions: [],
    project: { id: 'alfa-demo', name: 'Alfa Demo' },
    actions: ['atender', 'ignorar', 'reclasificar', 'cerrar', 'proyecto'] })
  const w = conWorker({ ok: true, code: 'proyecto-cambiado' })
  const { doc, window } = await abrirConWorker([caso], w, { projects: PROYECTOS_PRUEBA })
  const d = abrirDetalle(doc, 6)
  ok('el detalle dice el proyecto del caso', /Alfa Demo/.test(d.querySelector('.det-proyecto')?.textContent || ''),
    d.querySelector('.det-proyecto')?.textContent)
  botonDe(doc, 6, 'proyecto').click()
  const campo = doc.querySelector('#board-detail .card-form input[role="combobox"]')
  ok('Cambiar proyecto abre un autocompletar, no un select', !!campo &&
    !doc.querySelector('select') && campo.getAttribute('aria-expanded') === 'false', !!campo)
  campo.focus()
  campo.value = 'bet'
  campo.dispatchEvent(new window.Event('input', { bubbles: true }))
  const opciones = () => [...doc.querySelectorAll('#board-detail [role="listbox"] [role="option"]')]
  ok('escribir filtra el catalogo aceptado', opciones().map((o) => o.dataset.value).join() === 'beta-demo' &&
    campo.getAttribute('aria-expanded') === 'true', opciones().map((o) => o.textContent).join())
  doc.getElementById('refresh').click()
  await espera(); await espera()
  ok('el sondeo no se lleva lo escrito', doc.querySelector('#board-detail .card-form input[role="combobox"]')?.value === 'bet')
  const c2 = doc.querySelector('#board-detail .card-form input[role="combobox"]')
  c2.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  c2.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  ok('flechas y Enter eligen, y el campo dice lo elegido',
    doc.querySelector('#board-detail .card-form input[role="combobox"]').value === 'Beta Demo')
  ok('elegir no escribe nada todavia', w.pedidos.length === 0)
  doc.querySelector('#board-detail .card-form button[data-confirma]').click()
  await hastaPanel(() => w.pedidos.length === 1)
  ok('Guardar manda el id del proyecto elegido', w.pedidos[0] && w.pedidos[0].action === 'proyecto' &&
    w.pedidos[0].caseId === 6 && w.pedidos[0].proyecto === 'beta-demo' &&
    Object.keys(w.pedidos[0]).sort().join() === 'action,at,caseId,id,proyecto', JSON.stringify(w.pedidos))
  await hastaPanel(() => /actualizado/i.test(mensajeDe(doc, 6)?.textContent || ''))

  botonDe(doc, 6, 'proyecto').click()
  const c3 = doc.querySelector('#board-detail .card-form input[role="combobox"]')
  c3.focus()
  c3.dispatchEvent(new window.Event('click', { bubbles: true }))
  const ninguno = opciones().find((o) => o.dataset.value === '')
  ok('la lista ofrece quedar sin proyecto', !!ninguno && /sin proyecto/i.test(ninguno.textContent),
    opciones().map((o) => o.textContent).join())
  ninguno.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  doc.querySelector('#board-detail .card-form button[data-confirma]').click()
  await hastaPanel(() => w.pedidos.length === 2)
  ok('y se pide con el id vacio', w.pedidos[1] && w.pedidos[1].proyecto === '', JSON.stringify(w.pedidos[1]))

  await hastaPanel(() => !!botonDe(doc, 6, 'proyecto') && !botonDe(doc, 6, 'proyecto').disabled)
  botonDe(doc, 6, 'proyecto').click()
  const c4 = doc.querySelector('#board-detail .card-form input[role="combobox"]')
  c4.value = 'algo que no es'
  c4.dispatchEvent(new window.Event('input', { bubbles: true }))
  doc.querySelector('#board-detail .card-form button[data-confirma]').click()
  await espera()
  ok('sin elegir de la lista no se manda nada y lo dice', w.pedidos.length === 2 &&
    !!doc.querySelector('#board-detail .card-form .card-msg.mala'), detalle(doc).textContent)

  const sinCat = await abrirConWorker([caso], conWorker(null), {})
  botonDe(sinCat.doc, 6, 'proyecto').click()
  const c5 = sinCat.doc.querySelector('#board-detail .card-form input[role="combobox"]')
  c5.dispatchEvent(new sinCat.window.Event('click', { bubbles: true }))
  ok('sin catalogo aceptado manda a Ajustes', /Ajustes/.test(detalle(sinCat.doc).textContent),
    detalle(sinCat.doc).textContent.slice(0, 300))
}

console.log('\nactivity.html — tablero: lo que hizo el agente, en la historia del caso')
{
  const caso = tarjeta({ case_id: 3, events: [
    { de: null, a: 'recibido', actor: 'automatizacion', at: hace(40 * 60000) },
    { de: 'recibido', a: 'clasificado', actor: 'jev', at: hace(39 * 60000) },
    { de: 'clasificado', a: 'decision', actor: 'agente', at: hace(10 * 60000) },
    { de: 'decision', a: 'decision', actor: 'dueno', at: hace(5 * 60000) },
    { de: 'decision', a: 'decision', actor: 'actor_nuevo', at: hace(4 * 60000) }] })
  const { doc } = await abrirTablero({ board: tablero([caso]) })
  const h = abrirDetalle(doc, 3).querySelector('.det-hist')
  const filas = [...h.querySelectorAll('li')].map((li) => li.textContent)
  ok('cada paso con quien lo hizo, en palabras', filas.length === 5 &&
    /el agente/.test(filas[2]) && /Jev/.test(filas[1]) && /usted/.test(filas[3]),
    JSON.stringify(filas))
  ok('lo que no movio la etapa se dice como actualizado', /actualizado/.test(filas[3]), filas[3])
  ok('un actor que el panel no conoce no sale crudo', !/actor_nuevo/.test(h.textContent) &&
    /otro/.test(filas[4]), filas[4])
}

console.log('\nactivity.html — T14: la historia dice lo que paso por WhatsApp')
{
  const caso = tarjeta({ case_id: 5, events: [
    { de: null, a: 'recibido', actor: 'automatizacion', que: 'message', at: hace(50 * 60000) },
    { de: 'decision', a: 'decision', actor: 'regla', que: 'reply_waits', args: ['money'],
      at: hace(45 * 60000) },
    { de: 'decision', a: 'decision', actor: 'automatizacion', que: 'wa_notice', at: hace(44 * 60000) },
    { de: 'decision', a: 'clasificado', actor: 'dueno', que: 'wa_correction', at: hace(43 * 60000) },
    { de: 'decision', a: 'decision', actor: 'dueno', que: 'wa_approved', at: hace(42 * 60000) },
    { de: 'decision', a: 'cerrado', actor: 'dueno', que: 'wa_rejected', at: hace(41 * 60000) }] })
  for (const [idioma, re] of [['es-419', [/la respuesta espera su firma: dinero/, /aviso enviado por WhatsApp/,
    /correccion por WhatsApp/, /aprobada por WhatsApp/, /rechazada por WhatsApp/]],
  ['en-US', [/the reply waits for your signature: money/, /notice sent on WhatsApp/,
    /correction on WhatsApp/, /approved on WhatsApp/, /rejected on WhatsApp/]]]) {
    const { doc } = await abrirTablero({ board: tablero([caso]) }, idioma)
    const h = abrirDetalle(doc, 5).querySelector('.det-hist')
    const filas = [...h.querySelectorAll('li')].map((li) => li.textContent)
    ok(`${idioma}: cada paso por WhatsApp en palabras`, re.every((r) => filas.some((f) => r.test(f))) &&
      !/actualizado|updated/.test(filas.slice(1).join(' ')), JSON.stringify(filas))
  }
}

console.log('\nactivity.html — casos-cli K5: una nota se lee en la historia')
{
  const caso = tarjeta({ case_id: 6, events: [
    { de: null, a: 'recibido', actor: 'automatizacion', que: 'message', at: hace(50 * 60000) },
    { de: 'recibido', a: 'recibido', actor: 'dueno', que: 'note',
      nota: 'El cliente llamo: lo quiere antes del viernes', at: hace(40 * 60000) },
    { de: 'recibido', a: 'recibido', actor: 'agente', que: 'note', at: hace(30 * 60000) }] })
  for (const [idioma, re] of [['es-419', /nota: El cliente llamo: lo quiere antes del viernes/],
    ['en-US', /note: El cliente llamo: lo quiere antes del viernes/],
    ['pt-BR', /nota: El cliente llamo: lo quiere antes del viernes/]]) {
    const { doc } = await abrirTablero({ board: tablero([caso]) }, idioma)
    const h = abrirDetalle(doc, 6).querySelector('.det-hist')
    const filas = [...h.querySelectorAll('li')].map((li) => li.textContent)
    ok(`${idioma}: la nota se lee con su texto`, filas.some((f) => re.test(f)), JSON.stringify(filas))
    ok(`${idioma}: una nota sin texto dice nota, nunca el codigo crudo`,
      /nota|note/.test(filas[filas.length - 1]) && !/"note"|\bnote\b:\s*$/.test(filas[filas.length - 1]),
      filas[filas.length - 1])
  }
}

console.log('\nactivity.html — casos-cli K7: una edicion dice que cambio')
{
  const caso = tarjeta({ case_id: 7, events: [
    { de: null, a: 'recibido', actor: 'automatizacion', que: 'message', at: hace(50 * 60000) },
    { de: 'recibido', a: 'recibido', actor: 'dueno', que: 'edited', args: ['priority', 'title'],
      at: hace(40 * 60000) }] })
  for (const [idioma, re] of [['es-419', /editado: prioridad, titulo/],
    ['en-US', /edited: priority, title/], ['pt-BR', /editado: prioridade, titulo/]]) {
    const { doc } = await abrirTablero({ board: tablero([caso]) }, idioma)
    const h = abrirDetalle(doc, 7).querySelector('.det-hist')
    const filas = [...h.querySelectorAll('li')].map((li) => li.textContent)
    ok(`${idioma}: la edicion dice que cambio`, filas.some((f) => re.test(f)), JSON.stringify(filas))
  }
}

console.log('\nactivity.html — casos-cli K10: recordatorios y posponer en la tarjeta')
{
  const pronto = new Date(Date.now() + 2 * 3600000).toISOString()
  const caso = tarjeta({ case_id: 8, reminder: { at: pronto, snoozed_until: null }, events: [
    { de: null, a: 'recibido', actor: 'automatizacion', que: 'message', at: hace(50 * 60000) },
    { de: 'recibido', a: 'recibido', actor: 'dueno', que: 'reminder_set', at: hace(40 * 60000) },
    { de: 'recibido', a: 'recibido', actor: 'dueno', que: 'reminder', at: hace(30 * 60000) },
    { de: 'recibido', a: 'recibido', actor: 'dueno', que: 'reminder_cancelled', at: hace(20 * 60000) },
    { de: 'recibido', a: 'recibido', actor: 'automatizacion', que: 'snooze_ended', at: hace(10 * 60000) }] })
  const pospuesto = tarjeta({ case_id: 9, reminder: { at: pronto, snoozed_until: pronto } })
  for (const [idioma, rec, pos, hist] of [
    ['es-419', /Recordatorio:/, /Pospuesto hasta/, [/recordatorio puesto/, /recordatorio vencido/,
      /recordatorios cancelados/, /posposicion terminada/]],
    ['en-US', /Reminder:/, /Snoozed until/, [/reminder set/, /reminder due/, /reminders cancelled/,
      /snooze ended/]],
    ['pt-BR', /Lembrete:/, /Adiado ate/, [/lembrete criado/, /lembrete vencido/,
      /lembretes cancelados/, /adiamento terminado/]]]) {
    const { doc } = await abrirTablero({ board: tablero([caso, pospuesto]) }, idioma)
    const nodo = (id) => doc.querySelector(`.card[data-case="${id}"]`)
    const chip = nodo(8) && nodo(8).querySelector('.card-recordatorio')
    ok(`${idioma}: la tarjeta dice el proximo recordatorio`, chip && rec.test(chip.textContent),
      chip ? chip.textContent : 'sin chip')
    const chip2 = nodo(9) && nodo(9).querySelector('.card-recordatorio')
    ok(`${idioma}: y la posposicion`, chip2 && pos.test(chip2.textContent),
      chip2 ? chip2.textContent : 'sin chip')
    const det = abrirDetalle(doc, 8)
    const enDetalle = det.querySelector('.card-recordatorio')
    ok(`${idioma}: el detalle tambien lo dice`, enDetalle && rec.test(enDetalle.textContent),
      enDetalle ? enDetalle.textContent : 'sin linea')
    const h = det.querySelector('.det-hist')
    const filas = [...h.querySelectorAll('li')].map((li) => li.textContent)
    ok(`${idioma}: la historia dice los recordatorios en palabras`,
      hist.every((r) => filas.some((f) => r.test(f))), JSON.stringify(filas))
  }
  const { doc } = await abrirTablero({ board: tablero([tarjeta({ case_id: 10 })]) })
  ok('una tarjeta sin recordatorio no lleva la linea', !doc.querySelector('.card-recordatorio'))
}

console.log('\nactivity.html — T22: la historia dice que paso, y agrupa lo repetido')
{
  const caso = tarjeta({ case_id: 4, events: [
    { de: null, a: 'recibido', actor: 'automatizacion', que: 'message', at: hace(50 * 60000) },
    { de: 'recibido', a: 'recibido', actor: 'automatizacion', que: 'sticker', at: hace(49 * 60000) },
    { de: 'recibido', a: 'recibido', actor: 'automatizacion', que: 'message', at: hace(48 * 60000) },
    { de: 'recibido', a: 'recibido', actor: 'automatizacion', que: 'message', at: hace(47 * 60000) },
    { de: 'recibido', a: 'recibido', actor: 'automatizacion', que: 'message', at: hace(46 * 60000) },
    { de: 'recibido', a: 'recibido', actor: 'jev', que: 'jev', args: ['agent'], at: hace(45 * 60000) },
    { de: 'recibido', a: 'recibido', actor: 'regla', que: 'rule', args: ['money'], at: hace(44 * 60000) },
    { de: 'decision', a: 'decision', actor: 'automatizacion', que: 'held',
      args: ['money', 'states_status_not_verified'], at: hace(43 * 60000) },
    { de: 'clasificado', a: 'clasificado', actor: 'automatizacion', que: 'revision',
      args: ['commitment'], at: hace(42 * 60000) },
    { de: 'decision', a: 'decision', actor: 'regla', que: 'work_waits', args: ['delete'],
      at: hace(41 * 60000) },
    { de: 'decision', a: 'decision', actor: 'automatizacion', que: 'algo_nuevo', at: hace(40 * 60000) }] })
  const { doc } = await abrirTablero({ board: tablero([caso]) })
  const h = abrirDetalle(doc, 4).querySelector('.det-hist')
  const filas = [...h.querySelectorAll('li')].map((li) => li.textContent)
  ok('un sticker dice que llego un sticker', filas.some((f) => /llego un sticker/.test(f)),
    JSON.stringify(filas))
  ok('tres mensajes seguidos van en una fila con su cuenta',
    filas.filter((f) => /llego un mensaje ×3/.test(f)).length === 1 && filas.length === 9,
    JSON.stringify(filas))
  ok('lo que dijo Jev', filas.some((f) => /Jev: necesita agente/.test(f)), JSON.stringify(filas))
  ok('lo que marco la regla fija', filas.some((f) => /regla fija: dinero/.test(f)),
    JSON.stringify(filas))
  ok('un envio retenido, con sus motivos en palabras',
    filas.some((f) => /envio retenido: dinero/.test(f) && !/states_status/.test(f)),
    JSON.stringify(filas))
  ok('lo que volvio al agente para reescribir', filas.some((f) => /el agente lo reescribe/.test(f)),
    JSON.stringify(filas))
  ok('un trabajo que espera al dueno', filas.some((f) => /espera su firma: borrar/.test(f)),
    JSON.stringify(filas))
  ok('lo que el panel no conoce sigue diciendo actualizado, sin el codigo crudo',
    /actualizado/.test(filas[filas.length - 1]) && !/algo_nuevo/.test(h.textContent),
    filas[filas.length - 1])
  ok('la primera fila sigue siendo la llegada al tablero', /Recibido/.test(filas[0]) &&
    /llego un mensaje/.test(filas[0]), filas[0])
}

console.log('\nactivity.html — tablero: la ultima corrida del agente, en una linea')
{
  const AHORA = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const { doc } = await abrirTablero({ board: tablero([tarjeta()]), activity: { syncedAt: AHORA,
    pending: [], recent: [], mapped: 2, authorized: 2,
    run: { state: 'ok', startedAt: AHORA, endedAt: AHORA, looked: 2, pending: 0, reason: null } } })
  const linea = doc.getElementById('runline')
  ok('la linea de la corrida vive en el tablero', doc.getElementById('view-board').contains(linea) &&
    /Ultima revision/.test(linea.textContent), linea.textContent)
}

console.log('\nactivity.html — tablero: composicion (los anchos los mira shots)')
{
  const html = readFileSync(join(root, 'activity.html'), 'utf8')
  ok('hay un corte a 768 px que pasa el tablero a lista por etapa',
    /@media\s*\(max-width:\s*768px\)/.test(html))
  ok('las columnas se desplazan dentro de su contenedor y no la pagina',
    /\.board-cols\s*\{[^}]*overflow-x:\s*auto/.test(html))
  ok('el texto del cliente parte las palabras largas', /overflow-wrap:\s*anywhere/.test(html))
  ok('el titulo de la tarjeta se recorta a dos lineas', /\.clamp2\s*\{[^}]*-webkit-line-clamp:\s*2/.test(html))
  ok('las columnas tienen ancho fijo, como las de Plane', /\.col\s*\{[^}]*flex:\s*0 0 \d+px/.test(html))
}

// ───────── Jev: opcional, apagado de fabrica, con el aviso a la vista ─────────
// Es lo unico del plugin que manda el texto de los clientes fuera del equipo. Lo que se
// prueba es lo que importa de verdad: que el aviso este en los tres idiomas y diga a
// donde va, que venga apagado, que la llave viaje por el canal del worker y NUNCA vuelva
// a la pantalla, y que cada falla se diga.
console.log('\nconfig.html — Jev: el aviso esta en los tres idiomas y dice a donde va el texto')
{
  for (const [lang, apagado, masc] of [
    ['es-419', /apagado de f/i, /enmascaran/i],
    ['en-US', /off by default/i, /masked/i],
    ['pt-BR', /desligado por padr/i, /mascaradas/i]
  ]) {
    const { doc } = await montar('config.html', {}, lang)
    const aviso = doc.getElementById('jev-aviso').textContent
    ok(`${lang}: el aviso nombra el destino del texto`, /api\.typesafe\.ai/.test(aviso), aviso)
    ok(`${lang}: dice que viene apagado`, apagado.test(aviso), aviso)
    ok(`${lang}: dice que las credenciales se enmascaran`, masc.test(aviso), aviso)
    ok(`${lang}: el interruptor viene apagado`,
      doc.getElementById('jev-enabled').getAttribute('aria-checked') === 'false',
      doc.getElementById('jev-enabled').getAttribute('aria-checked'))
    ok(`${lang}: la llave se pide en un campo que no la muestra`,
      doc.getElementById('jev-key').type === 'password', doc.getElementById('jev-key').type)
    const sinTraducir = Array.prototype.filter.call(
      doc.querySelectorAll('[data-t^="jev"]'), (n) => /^jev[A-Z]/.test(n.textContent))
    ok(`${lang}: ningun texto de Jev quedo sin traducir`, sinTraducir.length === 0,
      sinTraducir.map((n) => n.textContent).join(', '))
  }
}

console.log('\nconfig.html — Jev: de usted y sin tildes ni enie, como el resto del panel')
{
  const { window } = await montar('config.html')
  const S = window.STRINGS
  const claves = Object.keys(S.en).filter((k) => /^jev/.test(k))
  ok('hay textos de Jev', claves.length > 20, String(claves.length))
  const conTilde = claves.filter((k) => /[^\x00-\x7f\u00b7]/.test(S.es[k] + S.pt[k]))
  ok('los textos de Jev van sin tildes ni enie en espanol y portugues', conTilde.length === 0,
    JSON.stringify(conTilde))
  const tuteo = claves.filter((k) => /\b(tu|tus|te|ti|enciendes|escribe|pega|intenta|revisa|verás|veras)\b/i
    .test(S.es[k].replace(/<[^>]*>/g, '')))
  ok('el espanol de Jev habla de usted, no de tu', tuteo.length === 0, JSON.stringify(tuteo))
  ok('el aviso dice "Si lo enciende" y la ayuda de la llave "solo vera"',
    S.es.jevDisclosure.includes('Si lo enciende') && S.es.jevDisclosure.includes('su atencion') &&
    S.es.jevKeyHelp.includes('solo vera') && S.es.jevKeyPh === 'Pegue su llave aqui')
}

/** El worker de mentira para Jev: hace lo que el de verdad —toma el pedido de storage,
 *  lo borra, contesta con codigo y deja el estado— sin tocar disco. `resultado` decide
 *  que contesta. */
function trabajadorJev (resultado) {
  return (d, st) => {
    if (d.action === 'storage.set' && d.params.key === 'jevRequest' && d.params.value &&
        !d.params.value.tombstone) {
      const pedido = d.params.value
      st.jevRequestVisto = pedido
      st.jevRequest = null
      const r = resultado(pedido, st)
      st.jevResult = { at: new Date().toISOString(), requestId: pedido.id,
        action: pedido.action, ...r }
      return { ok: true }
    }
    return undefined
  }
}

const LLAVE_JEV = 'tsk-FALSA-0000000000000000'

console.log('\nconfig.html — Jev: guardar la llave va por el worker y no vuelve a la pantalla')
{
  const storage = {}
  const { doc, window } = await montar('config.html', storage, 'es-419',
    trabajadorJev((pedido, st) => {
      st.jevStatus = { at: new Date().toISOString(), enabled: false, keySet: true,
        mirror: 'apagado' }
      return { ok: true, code: 'guardada', mirror: 'apagado' }
    }))
  ok('sin estado dice apagado y sin llave',
    /apagado/i.test(doc.getElementById('jev-status').textContent) &&
    /sin llave/i.test(doc.getElementById('jev-status').textContent),
    doc.getElementById('jev-status').textContent)
  ok('sin llave no se ofrece quitarla', doc.getElementById('jev-remove-key').hidden)

  doc.getElementById('jev-save-key').click()
  await espera()
  ok('con el campo vacio no manda nada y lo dice',
    !storage.jevRequestVisto && doc.getElementById('said-jev-key').textContent.length > 0,
    JSON.stringify(storage.jevRequestVisto))

  doc.getElementById('jev-key').value = `  ${LLAVE_JEV}  `
  doc.getElementById('jev-save-key').click()
  await new Promise((r) => setTimeout(r, 3500))
  const pedido = storage.jevRequestVisto
  ok('manda el pedido a la clave del worker, con id y marca de tiempo',
    !!pedido && pedido.action === 'guardar-llave' && typeof pedido.id === 'string' &&
    !isNaN(Date.parse(pedido.at)), JSON.stringify(pedido))
  ok('y lleva la llave sin los espacios', !!pedido && pedido.value === LLAVE_JEV,
    JSON.stringify(pedido))
  ok('el campo queda vacio: la llave no se queda en pantalla',
    doc.getElementById('jev-key').value === '', doc.getElementById('jev-key').value)
  ok('la llave no aparece en ningun lugar de la pagina',
    !doc.documentElement.outerHTML.includes(LLAVE_JEV) &&
    !doc.body.textContent.includes(LLAVE_JEV))
  ok('la pantalla dice que esta guardada', /llave guardada/i.test(
    doc.getElementById('jev-status').textContent), doc.getElementById('jev-status').textContent)
  ok('confirma el guardado al lado del boton',
    doc.getElementById('said-jev-key').textContent.includes('✓'),
    doc.getElementById('said-jev-key').textContent)
  ok('ahora ofrece quitarla', !doc.getElementById('jev-remove-key').hidden)
  ok('y el campo avisa que ya hay una, sin decir cual',
    /guardada/i.test(doc.getElementById('jev-key').placeholder),
    doc.getElementById('jev-key').placeholder)
  ok('encender Jev no pasa solo por guardar la llave',
    doc.getElementById('jev-enabled').getAttribute('aria-checked') === 'false',
    doc.getElementById('jev-enabled').getAttribute('aria-checked'))
  void window
}

console.log('\nconfig.html — Jev: encender, quitar la llave y lo que dice cada estado')
{
  const storage = { jevStatus: { at: new Date().toISOString(), enabled: false, keySet: true,
    mirror: 'apagado' } }
  const { doc } = await montar('config.html', storage, 'es-419',
    trabajadorJev((pedido, st) => {
      if (pedido.action === 'activar') {
        st.jevStatus = { at: new Date().toISOString(), enabled: pedido.enabled, keySet: true,
          mirror: pedido.enabled ? 'activo' : 'apagado' }
        return { ok: true, code: pedido.enabled ? 'activado' : 'desactivado' }
      }
      st.jevStatus = { at: new Date().toISOString(), enabled: st.jevStatus.enabled,
        keySet: false, mirror: 'sin-llave' }
      return { ok: true, code: 'quitada' }
    }))
  ok('con llave guardada y Jev apagado: apagado y llave guardada',
    /apagado.*llave guardada/i.test(doc.getElementById('jev-status').textContent),
    doc.getElementById('jev-status').textContent)

  doc.getElementById('jev-enabled').click()
  await new Promise((r) => setTimeout(r, 3500))
  ok('encender manda activar con enabled verdadero',
    storage.jevRequestVisto && storage.jevRequestVisto.action === 'activar' &&
    storage.jevRequestVisto.enabled === true, JSON.stringify(storage.jevRequestVisto))
  ok('y la pantalla dice encendido con llave',
    /encendido.*llave guardada/i.test(doc.getElementById('jev-status').textContent),
    doc.getElementById('jev-status').textContent)

  doc.getElementById('jev-remove-key').click()
  await new Promise((r) => setTimeout(r, 3500))
  ok('quitar la llave manda quitar-llave',
    storage.jevRequestVisto && storage.jevRequestVisto.action === 'quitar-llave',
    JSON.stringify(storage.jevRequestVisto))
  ok('y la pantalla dice que esta encendido pero no se envia nada',
    /sin llave/i.test(doc.getElementById('jev-status').textContent) &&
    /no se envia|no se envía/i.test(doc.getElementById('jev-status').textContent),
    doc.getElementById('jev-status').textContent)
  ok('sin llave ya no se ofrece quitarla', doc.getElementById('jev-remove-key').hidden)
}

console.log('\nconfig.html — Jev: lo que falla se dice, y un archivo ajeno se explica')
{
  const storage = { jevStatus: { at: new Date().toISOString(), enabled: true, keySet: true,
    mirror: 'ajeno' } }
  const { doc } = await montar('config.html', storage, 'es-419',
    trabajadorJev(() => ({ ok: false, code: 'llave-invalida' })))
  const nota = doc.getElementById('jev-mirror-note')
  ok('con un archivo ajeno y una llave ya guardada lo explica SIN pedir que la reescriba',
    !nota.hidden && /jev\.env/.test(nota.textContent) &&
    !/escriba la llave/i.test(nota.textContent) && /guardada/i.test(nota.textContent),
    `hidden=${nota.hidden} ${nota.textContent}`)
  const usar = doc.getElementById('jev-use-saved')
  ok('y ofrece usar la llave guardada con un boton visible',
    !!usar && !usar.hidden && /usar la llave guardada/i.test(usar.textContent),
    usar ? `${usar.hidden} ${usar.textContent}` : 'no existe #jev-use-saved')
  doc.getElementById('jev-key').value = 'dos palabras'
  doc.getElementById('jev-save-key').click()
  await new Promise((r) => setTimeout(r, 3500))
  const dicho = doc.getElementById('said-jev-key')
  ok('una llave invalida se dice con la frase del panel, no con el codigo',
    dicho.className.includes('bad') && /no es v/i.test(dicho.textContent) &&
    !/llave-invalida/.test(dicho.textContent), dicho.textContent)
  ok('y la llave tecleada se queda para corregirla',
    doc.getElementById('jev-key').value === 'dos palabras')
}

console.log('\nconfig.html — Jev: "Usar la llave guardada" reemplaza el archivo ajeno sin mostrar la llave')
{
  const storage = { jevStatus: { at: new Date().toISOString(), enabled: true, keySet: true,
    mirror: 'ajeno' } }
  const { doc } = await montar('config.html', storage, 'es-419',
    trabajadorJev((pedido, st) => {
      st.jevStatus = { at: new Date().toISOString(), enabled: true, keySet: true,
        mirror: 'activo' }
      return { ok: true, code: 'activado', mirror: 'activo', pedido: pedido.action }
    }))
  doc.getElementById('jev-use-saved').click()
  await new Promise((r) => setTimeout(r, 3500))
  const pedido = storage.jevRequestVisto
  ok('el boton manda activar con enabled verdadero: lo mismo que encender el interruptor',
    !!pedido && pedido.action === 'activar' && pedido.enabled === true &&
    typeof pedido.id === 'string' && !isNaN(Date.parse(pedido.at)), JSON.stringify(pedido))
  ok('el pedido no lleva ninguna llave', !!pedido && !('value' in pedido), JSON.stringify(pedido))
  ok('al confirmarse el worker, la nota y el boton desaparecen',
    doc.getElementById('jev-mirror-note').hidden && doc.getElementById('jev-use-saved').hidden,
    `${doc.getElementById('jev-mirror-note').hidden} ${doc.getElementById('jev-use-saved').hidden}`)
  ok('y lo dice con un veredicto, no en silencio',
    doc.getElementById('said-jev-key').textContent.includes('✓'),
    doc.getElementById('said-jev-key').textContent)
}

console.log('\nconfig.html — Jev: archivo ajeno SIN llave guardada pide la llave, y no ofrece el boton')
{
  const storage = { jevStatus: { at: new Date().toISOString(), enabled: true, keySet: false,
    mirror: 'ajeno' } }
  const { doc } = await montar('config.html', storage, 'es-419', trabajadorJev(() => ({ ok: true })))
  ok('la nota manda a escribir la llave',
    /escriba la llave/i.test(doc.getElementById('jev-mirror-note').textContent),
    doc.getElementById('jev-mirror-note').textContent)
  ok('y el boton de usar la guardada no se ofrece: no hay guardada',
    doc.getElementById('jev-use-saved').hidden)
}

for (const [loc, nota, boton] of [['en', /already a saved key/i, /use the saved key/i],
  ['pt-BR', /ja ha uma chave salva/i, /usar a chave salva/i]]) {
  console.log(`\nconfig.html — Jev: archivo ajeno con llave guardada, en ${loc}`)
  const storage = { jevStatus: { at: new Date().toISOString(), enabled: true, keySet: true,
    mirror: 'ajeno' } }
  const { doc } = await montar('config.html', storage, loc, trabajadorJev(() => ({ ok: true })))
  ok(`la nota esta traducida (${loc})`, nota.test(doc.getElementById('jev-mirror-note').textContent),
    doc.getElementById('jev-mirror-note').textContent)
  ok(`y el boton tambien (${loc})`, boton.test(doc.getElementById('jev-use-saved').textContent),
    doc.getElementById('jev-use-saved').textContent)
}

console.log('\nconfig.html — Jev: si el worker no contesta, la llave no queda esperando en storage')
{
  const storage = {}
  const { doc, window } = await montar('config.html', storage, 'es-419')
  window.VEREDICTO_ESPERA_MS = 400
  doc.getElementById('jev-key').value = LLAVE_JEV
  doc.getElementById('jev-save-key').click()
  await new Promise((r) => setTimeout(r, 4500))
  ok('el panel dice que el plugin no contesto',
    /no contest/i.test(doc.getElementById('said-jev-key').textContent),
    doc.getElementById('said-jev-key').textContent)
  ok('y el pedido con la llave se reemplaza por una lapida SIN la llave',
    !!storage.jevRequest && storage.jevRequest.tombstone === true &&
    !JSON.stringify(storage.jevRequest).includes(LLAVE_JEV),
    JSON.stringify(storage.jevRequest))
}

console.log('\nconfig.html — Avanzado: lo que el intervalo controla y cuando se transcribe')
for (const [idioma, nombre, minuto, caso] of [
  ['es-419', 'ES', /cada minuto/i, /llegan a un caso/i],
  ['en', 'EN', /every minute/i, /reach a case/i],
  ['pt-BR', 'PT', /cada minuto/i, /chegam a um caso/i]]) {
  const { doc } = await montar('config.html', {}, idioma)
  await espera()
  const sync = doc.querySelector('[data-t="syncHelp"]').textContent
  const voz = doc.querySelector('[data-t="transcribeHelp"]').textContent
  ok(`${nombre}: el intervalo dice que gobierna la lista de conversaciones y el tablero`,
    /(conversa|chat)/i.test(sync) && /(tablero|board|quadro)/i.test(sync), sync)
  ok(`${nombre}: y que los mensajes nuevos se procesan cada minuto, sea cual sea`,
    minuto.test(sync), sync)
  ok(`${nombre}: ya no promete que es lo que mas tarda un mensaje nuevo`,
    !/(mas puede tardar|longest a new message|maximo que uma mensagem)/i.test(sync), sync)
  ok(`${nombre}: las notas de voz se transcriben al llegar a un caso`, caso.test(voz), voz)
  ok(`${nombre}: y dice que pasa con no transcribir`,
    /(no transcribir|do not transcribe|nao transcrever)/i.test(voz), voz)
}

console.log('\nconfig.html — respuestas automaticas: acuse de recibo y saludo')
{
  const { doc, storage } = await montar('config.html', {
    chats: [{ jid: '1@g.us', name: 'Soporte Norte', kind: 'grupo' }] }, 'es-419')
  await espera()
  doc.getElementById('tab-aprobacion').click()
  await espera()
  ok('el acuse y el saludo se eligen con botones, no con un select',
    !doc.querySelector('select') && doc.querySelectorAll('#ack-mode button').length === 2 &&
    doc.querySelectorAll('#greeting-mode button').length === 2 &&
    doc.querySelectorAll('#chat-ack button').length === 3 &&
    doc.querySelectorAll('#chat-greeting button').length === 3)
  ok('por defecto estan activados', valorSeg(doc, 'ack-mode') === 'on' &&
    valorSeg(doc, 'greeting-mode') === 'on', `${valorSeg(doc, 'ack-mode')} ${valorSeg(doc, 'greeting-mode')}`)
  elegirSeg(doc, 'ack-mode', 'off')
  escribir(doc, 'greeting-text', 'Hola, con gusto le atendemos.')
  doc.getElementById('save-auto').click()
  await espera(); await espera()
  ok('la tarjeta guarda el interruptor y el texto de cada una, con un solo boton',
    storage.ackMode === 'off' && storage.greetingMode === 'on' && storage.ackText === '' &&
    storage.greetingText === 'Hola, con gusto le atendemos.',
    JSON.stringify([storage.ackMode, storage.ackText, storage.greetingMode, storage.greetingText]))
  ok('y lo confirma', /✓/.test(doc.getElementById('said-auto').textContent))

  elegirChat(doc, '1@g.us')
  await espera()
  ok('una conversacion nueva usa el general', valorSeg(doc, 'chat-ack') === 'default' &&
    valorSeg(doc, 'chat-greeting') === 'default')
  elegirSeg(doc, 'chat-ack', 'on')
  escribir(doc, 'chat-ack-text', 'Recibido, lo vemos.')
  elegirSeg(doc, 'chat-greeting', 'off')
  doc.getElementById('save-scope').click()
  await espera(); await espera()
  const e = (storage.scope || {})['1@g.us']
  ok('la conversacion guarda su acuse y su saludo, con el jid como llave',
    e && e.ack === 'on' && e.ackText === 'Recibido, lo vemos.' && e.greeting === 'off' &&
    e.greetingText === null, JSON.stringify(e))
  doc.querySelector('#scope-wrap [data-edit]')?.click()
  await espera()
  ok('al editarla vuelve a mostrar lo guardado', valorSeg(doc, 'chat-ack') === 'on' &&
    doc.getElementById('chat-ack-text').value === 'Recibido, lo vemos.' &&
    valorSeg(doc, 'chat-greeting') === 'off', `${valorSeg(doc, 'chat-ack')}`)
}
console.log('\nconfig.html — el primer mensaje (beta): modos, respaldo y ritmo')
{
  const { doc, storage } = await montar('config.html', {
    chats: [{ jid: '1@g.us', name: 'Soporte Norte', kind: 'grupo' }] }, 'es-419')
  await espera()
  doc.getElementById('tab-aprobacion').click()
  await espera()
  const visible = (id) => !doc.getElementById(id).hidden &&
    !doc.getElementById(id).closest('[hidden]')
  const botones = [...doc.querySelectorAll('#first-reply button')]
  ok('los tres modos del primer mensaje son botones, no un select',
    !doc.querySelector('select') &&
    botones.map((b) => b.dataset.value).join() === 'ack,model,model_with_ack_fallback',
    botones.map((b) => b.dataset.value).join())
  ok('los dos del agente llevan la marca Beta y el acuse no',
    botones.filter((b) => b.querySelector('.beta')).map((b) => b.dataset.value).join() ===
      'model,model_with_ack_fallback' && /Beta/.test(botones[1].textContent) &&
      !/Beta/.test(botones[0].textContent), botones.map((b) => b.textContent).join(' | '))
  ok('por defecto es el acuse, sin numeros ni aviso', valorSeg(doc, 'first-reply') === 'ack' &&
    !visible('fr-nums') && !visible('first-reply-warn'), valorSeg(doc, 'first-reply'))
  elegirSeg(doc, 'first-reply', 'model')
  ok('en model avisa que sin respaldo el cliente no recibe nada si Orca o el triage caen',
    visible('first-reply-warn') &&
    /no recibe nada/.test(doc.getElementById('first-reply-warn').textContent),
    doc.getElementById('first-reply-warn').textContent)
  ok('y muestra el ritmo y el tope de los avances, sin los minutos del respaldo',
    visible('fr-every-row') && visible('fr-max-row') && !visible('fr-fallback-row'))
  elegirSeg(doc, 'first-reply', 'model_with_ack_fallback')
  ok('con respaldo: los minutos del respaldo, el ritmo y el tope, y sin el aviso',
    visible('fr-fallback-row') && visible('fr-every-row') && visible('fr-max-row') &&
    !visible('first-reply-warn'))
  ok('cada numero dice su rango', doc.getElementById('fr-fallback').max === '60' &&
    doc.getElementById('fr-every').max === '120' && doc.getElementById('fr-max').max === '10')
  escribir(doc, 'fr-fallback', '8')
  escribir(doc, 'fr-every', '15')
  escribir(doc, 'fr-max', '4')
  doc.getElementById('save-auto').click()
  await espera(); await espera()
  ok('la tarjeta guarda los cuatro valores en UNA clave',
    JSON.stringify(storage.firstReply) === JSON.stringify({ mode: 'model_with_ack_fallback',
      fallbackMinutes: '8', everyMinutes: '15', max: '4' }), JSON.stringify(storage.firstReply))
  ok('y el acuse de siempre se guarda igual que antes', storage.ackMode === 'on' &&
    /✓/.test(doc.getElementById('said-auto').textContent))
  escribir(doc, 'fr-max', '40')
  doc.getElementById('save-auto').click()
  await espera(); await espera()
  ok('un numero fuera de rango no se guarda, y lo dice',
    storage.firstReply.max === '4' && doc.getElementById('said-auto').className.includes('bad'),
    `${JSON.stringify(storage.firstReply)} ${doc.getElementById('said-auto').textContent}`)

  doc.getElementById('tab-chats').click()
  elegirChat(doc, '1@g.us')
  await espera()
  ok('en la conversacion: usar el general y los tres modos',
    [...doc.querySelectorAll('#chat-first-reply button')].map((b) => b.dataset.value).join() ===
      'default,ack,model,model_with_ack_fallback' &&
    valorSeg(doc, 'chat-first-reply') === 'default')
  elegirSeg(doc, 'chat-first-reply', 'model')
  ok('el aviso de model tambien en la conversacion', visible('chat-first-reply-warn'))
  doc.getElementById('save-scope').click()
  await espera(); await espera()
  const e = (storage.scope || {})['1@g.us']
  ok('la conversacion guarda su modo', e && e.firstReply === 'model', JSON.stringify(e))
  doc.querySelector('#scope-wrap [data-edit]')?.click()
  await espera()
  ok('al editarla vuelve a mostrarlo', valorSeg(doc, 'chat-first-reply') === 'model')
}
{
  const { doc } = await montar('config.html', {
    firstReply: { mode: 'model', fallbackMinutes: '7', everyMinutes: '12', max: '2' } }, 'es-419')
  await espera()
  doc.getElementById('tab-aprobacion').click()
  await espera(); await espera()
  ok('al abrir la pestana pinta lo guardado', valorSeg(doc, 'first-reply') === 'model' &&
    doc.getElementById('fr-fallback').value === '7' && doc.getElementById('fr-every').value === '12' &&
    doc.getElementById('fr-max').value === '2', `${valorSeg(doc, 'first-reply')}`)
}
for (const [idioma, nombre, aviso] of [['es-419', 'ES', /no recibe nada/],
  ['en', 'EN', /gets nothing/], ['pt-BR', 'PT', /nao recebe nada/]]) {
  const { doc } = await montar('config.html', {}, idioma)
  await espera()
  const ids = ['first-reply-label', 'chat-first-reply-label', 'fr-fallback-label',
    'fr-every-label', 'fr-max-label']
  ok(`${nombre}: los textos del primer mensaje existen y estan pintados`,
    ids.every((i) => (doc.getElementById(i)?.textContent || '').trim().length > 3) &&
    [...doc.querySelectorAll('#first-reply button')].every((b) => b.textContent.trim().length > 3),
    ids.map((i) => doc.getElementById(i)?.textContent).join('|'))
  ok(`${nombre}: el aviso de model dice que el cliente no recibe nada`,
    aviso.test(doc.getElementById('first-reply-warn')?.textContent || ''),
    doc.getElementById('first-reply-warn')?.textContent)
}
for (const [idioma, nombre] of [['es-419', 'ES'], ['en', 'EN'], ['pt-BR', 'PT']]) {
  const { doc } = await montar('config.html', {}, idioma)
  await espera()
  const ids = ['auto-legend-h', 'ack-mode-label', 'greeting-mode-label', 'chat-ack-label',
    'chat-greeting-label']
  ok(`${nombre}: los textos de las respuestas automaticas existen y estan pintados`,
    ids.every((i) => (doc.getElementById(i)?.textContent || '').trim().length > 3) &&
    !/\{\{|undefined/.test(doc.getElementById('view-aprobacion').textContent),
    ids.map((i) => doc.getElementById(i)?.textContent).join('|'))
  const texto = doc.getElementById('view-aprobacion').textContent
}

// ── acuse-inteligente: el silencio del acuse despues de que la linea escribio ──
// Decision c del dueno (2026-10-05): el acuse no cae en medio de una conversacion. Un ajuste
// global en minutos (0..240, 30 de fabrica, 0 lo apaga) en la clave plana `ackQuietMinutes`,
// en texto como el resto, junto al acuse en la tarjeta de las respuestas automaticas.
console.log('\nconfig.html — acuse-inteligente: el silencio del acuse')
{
  const { doc, storage } = await montar('config.html', {}, 'es-419')
  await espera()
  doc.getElementById('tab-aprobacion').click()
  await espera(); await espera()
  const campo = doc.getElementById('ack-quiet')
  ok('el campo esta en la tarjeta de las respuestas automaticas, junto al acuse',
    !!campo && campo.closest('section') === doc.getElementById('ack-mode').closest('section'),
    String(!!campo))
  ok('es un numero entero de 0 a 240 minutos, sin select',
    campo?.type === 'number' && campo.min === '0' && campo.max === '240' && campo.step === '1' &&
    !doc.querySelector('select'))
  ok('sin nada guardado muestra 30', campo?.value === '30', campo?.value)
  ok('tiene etiqueta y una pista que dice que hace y que 0 lo apaga',
    (doc.querySelector('label[for="ack-quiet"]')?.textContent || '').trim().length > 3 &&
    /acuse/i.test(doc.getElementById('ack-quiet-help')?.textContent || '') &&
    /\b0\b/.test(doc.getElementById('ack-quiet-help')?.textContent || ''),
    doc.getElementById('ack-quiet-help')?.textContent)
  escribir(doc, 'ack-quiet', '45')
  doc.getElementById('save-auto').click()
  await espera(); await espera()
  ok('guardar escribe la clave plana en texto', storage.ackQuietMinutes === '45',
    String(storage.ackQuietMinutes))
  ok('y lo confirma', /✓/.test(doc.getElementById('said-auto').textContent))
  escribir(doc, 'ack-quiet', '0')
  doc.getElementById('save-auto').click()
  await espera(); await espera()
  ok('0 se guarda: apaga el silencio', storage.ackQuietMinutes === '0',
    String(storage.ackQuietMinutes))
  for (const malo of ['241', '-1', '7.5', 'media hora', '']) {
    escribir(doc, 'ack-quiet', malo)
    doc.getElementById('save-auto').click()
    await espera(); await espera()
    ok(`"${malo}" no se guarda y lo dice`, storage.ackQuietMinutes === '0' &&
      doc.getElementById('said-auto').className.includes('bad') &&
      /240/.test(doc.getElementById('said-auto').textContent),
    `${storage.ackQuietMinutes} ${doc.getElementById('said-auto').textContent}`)
  }
}
for (const [guardado, esperado] of [['10', '10'], ['0', '0'], [null, '30']]) {
  const { doc } = await montar('config.html', guardado === null ? {} : { ackQuietMinutes: guardado },
    'es-419')
  await espera()
  doc.getElementById('tab-aprobacion').click()
  await espera(); await espera()
  ok(`al abrir la pestana pinta ${esperado} con ${guardado} guardado`,
    doc.getElementById('ack-quiet').value === esperado, doc.getElementById('ack-quiet').value)
}
{
  // Un host que rechaza la escritura: no dice guardado.
  const { doc } = await montar('config.html', {}, 'es-419',
    (d) => d.action === 'storage.set' && d.params.key === 'ackQuietMinutes' ? { ok: false } : undefined)
  await espera()
  doc.getElementById('tab-aprobacion').click()
  await espera()
  escribir(doc, 'ack-quiet', '20')
  doc.getElementById('save-auto').click()
  await espera(); await espera()
  ok('si el host no guarda el silencio, no dice guardado',
    doc.getElementById('said-auto').className.includes('bad'),
    doc.getElementById('said-auto').textContent)
}
for (const [idioma, nombre, etiqueta, pista] of [
  ['es-419', 'ES', /acuse/i, /conversaci[oó]n/i],
  ['en', 'EN', /acknowledg/i, /conversation/i],
  ['pt-BR', 'PT', /aviso/i, /conversa/i]]) {
  const { doc } = await montar('config.html', {}, idioma)
  await espera()
  const label = doc.querySelector('label[for="ack-quiet"]')?.textContent || ''
  const ayuda = doc.getElementById('ack-quiet-help')?.textContent || ''
  ok(`${nombre}: el silencio del acuse en su idioma`,
    etiqueta.test(label) && pista.test(ayuda) && ayuda.trim().length > 40, `${label} | ${ayuda}`)
  ok(`${nombre}: sin voseo y tratando de usted`,
    !/\b(ten[eé]s|pod[eé]s|escrib[ií]s|quer[eé]s)\b/i.test(label + ayuda), `${label} | ${ayuda}`)
  // En 0 solo se apaga el silencio: el acuse no sale "siempre" (el del dueno sigue sin el, y
  // el respaldo no sale si al cliente ya le llego algo del caso), y no hay un "antes" que un
  // usuario nuevo conozca.
  ok(`${nombre}: la pista no promete que en 0 el acuse sale siempre`,
    !/\b(siempre|always|sempre)\b/i.test(ayuda) && !/como antes|as before/i.test(ayuda), ayuda)
  // avisos-retenidos A2: el respaldo sale mientras al cliente no le haya llegado nada del
  // caso; esperar la aprobacion o estar en marcha ya no lo omite.
  ok(`${nombre}: la pista dice que el respaldo solo falta si al cliente ya le llego algo`,
    /(no le llego nada|nothing from the case has reached|nada do caso chegou)/i.test(ayuda) &&
    !/(en marcha|under way|em andamento)/i.test(ayuda), ayuda)
  const intro = doc.querySelector('[data-t="autoIntro"]')?.textContent || ''
  ok(`${nombre}: la intro ya no promete un acuse al instante a todo pedido`,
    /(salvo si la linea|unless the line|salvo se a linha)/i.test(intro), intro)
  // avisos-retenidos A1: en un grupo, el pedido que abre un caso sin mencionar al asistente
  // tambien recibe el acuse.
  ok(`${nombre}: la intro dice que en un grupo el pedido que abre un caso tambien recibe el acuse`,
    /(grupo|group)/i.test(intro) && /(abre un caso|opens a case|abre um caso)/i.test(intro), intro)
}

console.log('\nactivity.html — un caso cerrado sin agente dice por que regla')
for (const [idioma, nombre, lead, regla] of [
  ['es-419', 'ES', /No requiere agente/, /grupo que no es para el asistente/],
  ['en', 'EN', /No agent needed/, /group chatter not meant for the assistant/i],
  ['pt-BR', 'PT', /Nao requer agente/, /conversa de um grupo que nao e para o assistente/]]) {
  const cerrada = tarjeta({ case_id: 4, stage: 'cerrado', proposal: null, exceptions: [],
    no_agent_rule: 'charla_de_grupo', actions: ['reabrir'] })
  const { doc } = await abrirTablero({ board: tablero([cerrada]) }, idioma)
  const d = abrirDetalle(doc, 4)
  const caja = d?.querySelector('.card-noagent')
  ok(`${nombre}: el detalle dice "No requiere agente" y la regla`,
    !!caja && lead.test(caja.textContent) && regla.test(caja.textContent), caja?.textContent)
  ok(`${nombre}: una regla que el panel no conoce no sale cruda`, (() => {
    const otra = tarjeta({ case_id: 5, stage: 'cerrado', proposal: null, exceptions: [],
      no_agent_rule: 'regla_nueva', actions: ['reabrir'] })
    return true && !JSON.stringify(otra).includes('undefined')
  })())
}
{
  const abierta = tarjeta({ case_id: 6, stage: 'cerrado', proposal: null, exceptions: [],
    no_agent_rule: null, actions: ['reabrir'] })
  const { doc } = await abrirTablero({ board: tablero([abierta]) })
  ok('un cerrado de otra forma no dice que no requeria agente',
    !abrirDetalle(doc, 6).querySelector('.card-noagent'))
}

console.log('\nactivity.html — un caso de un chat observar dice Solo leer')
for (const [idioma, nombre, re] of [['es-419', 'ES', /Solo leer/], ['en', 'EN', /Read only/],
  ['pt-BR', 'PT', /So leitura/]]) {
  const c = tarjeta({ case_id: 8, stage: 'clasificado', proposal: null, exceptions: [],
    read_only: true, actions: ['atender', 'ignorar'] })
  const { doc } = await abrirTablero({ board: tablero([c]) }, idioma)
  ok(`${nombre}: la tarjeta lleva la nota de solo leer`,
    re.test(doc.querySelector('.card[data-case="8"] .card-solo-leer')?.textContent || ''))
}
{
  const c = tarjeta({ case_id: 9, stage: 'clasificado', proposal: null, exceptions: [],
    read_only: false, actions: ['atender', 'ignorar'] })
  const { doc } = await abrirTablero({ board: tablero([c]) })
  ok('sin read_only no hay nota', !doc.querySelector('.card-solo-leer'))
}

// ── El primer clic en el tablero ──
// Entrar al panel desde otra parte de Orca le da foco a la ventana, y el foco relee el
// storage y repintaba el tablero entero. Si esa repintada cae entre que el dueno aprieta
// y suelta, la tarjeta bajo el puntero ya no es la misma y el navegador no le manda el
// `click`: el primer clic no hacia nada y habia que apretar dos veces.
/** Un clic como lo da el navegador: aprieta, deja pasar lo que pase en el medio
 *  (`entre`), suelta, y solo si el nodo apretado sigue en la pagina le llega el `click`.
 *  Si lo reemplazaron, el navegador lo manda al ancestro comun, que no es la tarjeta. */
async function clicReal (window, nodo, entre) {
  const opc = { bubbles: true, cancelable: true, button: 0 }
  const Puntero = window.PointerEvent || window.MouseEvent
  nodo.dispatchEvent(new Puntero('pointerdown', opc))
  nodo.dispatchEvent(new window.MouseEvent('mousedown', opc))
  await entre()
  nodo.dispatchEvent(new Puntero('pointerup', opc))
  nodo.dispatchEvent(new window.MouseEvent('mouseup', opc))
  if (nodo.isConnected) nodo.dispatchEvent(new window.MouseEvent('click', opc))
}

console.log('\nactivity.html — tablero: el primer clic no se pierde por la recarga al tomar foco')
{
  const { window, doc } = await abrirTablero({ board: tablero([tarjeta({ case_id: 3 })]) })
  const card = doc.querySelector('.card[data-case="3"]')
  window.dispatchEvent(new window.Event('focus'))
  await espera()
  ok('el foco con el mismo tablero no reconstruye las tarjetas',
    doc.querySelector('.card[data-case="3"]') === card)
  let seguia = null
  await clicReal(window, card, async () => {
    window.dispatchEvent(new window.Event('focus'))   // el clic que entra al panel
    await espera()                                     // la relectura ya aterrizo
    seguia = doc.querySelector('.card[data-case="3"]') === card
  })
  // Lo que se mira es el momento de soltar: despues del clic el detalle abierto repinta
  // el tablero, y eso es legitimo (la seleccion cambio).
  ok('y la tarjeta apretada es la que sigue en la pagina al soltar', seguia === true)
  ok('el primer clic en la tarjeta abre su detalle',
    !!doc.querySelector('#board-detail[data-case="3"]:not([hidden])'),
    doc.getElementById('board-detail')?.outerHTML.slice(0, 120))
}
{
  const recibido = tarjeta({ case_id: 4, stage: 'recibido', proposal: null, exceptions: [],
    title: 'Nota de voz', actions: ['atender', 'ignorar', 'reclasificar', 'cerrar', 'proyecto'] })
  const w = conWorker({ ok: true, code: 'atendido' })
  const { window, doc } = await abrirConWorker([recibido], w)
  const boton = botonTarjeta(doc, 4, 'atender')
  await clicReal(window, boton, async () => {
    window.dispatchEvent(new window.Event('focus'))
    await espera()
  })
  ok('el primer clic en Atender ahora deja su pedido',
    await hastaPanel(() => w.pedidos.length === 1, 2000), JSON.stringify(w.pedidos))
}

console.log('\nactivity.html — tablero: lo que llega con el puntero apretado se pinta al soltar')
{
  const storage = { board: tablero([tarjeta({ case_id: 3 })]) }
  const { window, doc } = await abrirTablero(storage)
  const card = doc.querySelector('.card[data-case="3"]')
  let durante = null
  await clicReal(window, card, async () => {
    storage.board = tablero([tarjeta({ case_id: 3 }), tarjeta({ case_id: 6, title: 'Caso nuevo' })])
    window.dispatchEvent(new window.Event('focus'))
    await espera()
    durante = { misma: doc.querySelector('.card[data-case="3"]') === card,
      nueva: !!doc.querySelector('.card[data-case="6"]') }
  })
  ok('con el puntero apretado el tablero nuevo no se pinta todavia',
    durante && durante.misma && !durante.nueva, JSON.stringify(durante))
  ok('y el clic llega a la tarjeta apretada',
    !!doc.querySelector('#board-detail[data-case="3"]:not([hidden])'))
  await espera()
  ok('al soltar se pinta lo que llego, no se pierde',
    !!doc.querySelector('.card[data-case="6"]'), visibles(doc).join())
}
{
  // Un puntero que nunca suelta (el arrastre sale del panel) no deja el tablero congelado.
  const storage = { board: tablero([tarjeta({ case_id: 3 })]) }
  const { window, doc } = await abrirTablero(storage)
  const card = doc.querySelector('.card[data-case="3"]')
  card.dispatchEvent(new (window.PointerEvent || window.MouseEvent)('pointerdown', { bubbles: true }))
  storage.board = tablero([tarjeta({ case_id: 3 }), tarjeta({ case_id: 6 })])
  window.dispatchEvent(new window.Event('focus'))
  await espera()
  window.dispatchEvent(new window.Event('blur'))
  await espera()
  ok('si la ventana pierde el foco con el puntero apretado, lo pendiente se pinta igual',
    !!doc.querySelector('.card[data-case="6"]'), visibles(doc).join())
}
{
  // Un gesto del sistema (o un toque que se vuelve desplazamiento) cancela el puntero:
  // no llega `pointerup`, llega `pointercancel`, y eso tambien suelta.
  const storage = { board: tablero([tarjeta({ case_id: 3 })]) }
  const { window, doc } = await abrirTablero(storage)
  const card = doc.querySelector('.card[data-case="3"]')
  const Puntero = window.PointerEvent || window.MouseEvent
  card.dispatchEvent(new Puntero('pointerdown', { bubbles: true }))
  storage.board = tablero([tarjeta({ case_id: 3 }), tarjeta({ case_id: 6 })])
  window.dispatchEvent(new window.Event('focus'))
  await espera()
  card.dispatchEvent(new Puntero('pointercancel', { bubbles: true }))
  await espera()
  ok('si el puntero se cancela, lo pendiente se pinta igual',
    !!doc.querySelector('.card[data-case="6"]'), visibles(doc).join())
}
{
  // El veredicto de una accion repinta el tablero a la fuerza. Si cae con el puntero
  // apretado sobre otra tarjeta, esa tarjeta se reconstruia bajo el puntero y el primer
  // clic se perdia igual que con el foco.
  const recibido = tarjeta({ case_id: 4, stage: 'recibido', proposal: null, exceptions: [],
    title: 'Nota de voz', actions: ['atender', 'ignorar', 'reclasificar', 'cerrar', 'proyecto'] })
  const w = conWorker({ ok: true, code: 'atendido' }, { demoraMs: 200 })
  const { window, doc, storage } = await abrirConWorker([recibido, tarjeta({ case_id: 3 })], w)
  botonTarjeta(doc, 4, 'atender').click()
  const card = doc.querySelector('.card[data-case="3"]')
  let durante = null
  await clicReal(window, card, async () => {
    await hastaPanel(() => !!storage.scopeResult, 3000)
    // El panel sondea el veredicto cada segundo: pasado uno y medio ya lo leyo.
    await new Promise((r) => setTimeout(r, 1500))
    durante = { misma: doc.querySelector('.card[data-case="3"]') === card,
      veredicto: !!storage.scopeResult }
  })
  ok('un veredicto que llega con el puntero apretado no reconstruye la tarjeta apretada',
    durante && durante.veredicto && durante.misma, JSON.stringify(durante))
  ok('y el primer clic en esa tarjeta abre su detalle',
    !!doc.querySelector('#board-detail[data-case="3"]:not([hidden])'),
    doc.getElementById('board-detail')?.outerHTML.slice(0, 120))
  ok('al soltar se pinta lo que dijo el veredicto, no se pierde',
    await hastaPanel(() => /atendera/.test(mensajeDe(doc, 4)?.textContent || ''), 2000),
    mensajeDe(doc, 4)?.textContent)
}

console.log('\nactivity.html — tablero: lo que depende del reloj se repinta aunque nada mas cambie')
/** Corre el reloj del panel `ms` hacia adelante (solo `Date.now`, que es lo que lee). */
const adelantarReloj = (window, ms) => {
  const real = window.Date.now.bind(window.Date)
  window.Date.now = () => real() + ms
}
{
  const { window, doc } = await abrirTablero({ board: tablero([tarjeta({ case_id: 3 })]) })
  const antes = doc.querySelector('.card[data-case="3"]').textContent
  // 10 minutos: "hace 5 min" pasa a "hace 15 min" y el tablero sigue sin estar viejo.
  adelantarReloj(window, 10 * 60000)
  window.dispatchEvent(new window.Event('focus'))
  await espera()
  const despues = doc.querySelector('.card[data-case="3"]').textContent
  ok('el "hace N min" de la tarjeta avanza con el reloj', /hace 5 min/.test(antes) &&
    /hace 15 min/.test(despues), JSON.stringify({ antes, despues }))
}
{
  const { window, doc } = await abrirTablero({ board: tablero([tarjeta({ case_id: 3 })]) })
  const sello = () => doc.getElementById('board-synced')
  const antes = !!sello().querySelector('.vieja')
  adelantarReloj(window, 40 * 60000)
  window.dispatchEvent(new window.Event('focus'))
  await espera()
  ok('el sello del tablero se marca viejo cuando pasa la media hora',
    !antes && !!sello().querySelector('.vieja'), sello().outerHTML)
}
{
  const recibido = tarjeta({ case_id: 4, stage: 'recibido', proposal: null, exceptions: [],
    title: 'Nota de voz', actions: ['atender', 'ignorar', 'reclasificar', 'cerrar', 'proyecto'] })
  const w = conWorker({ ok: true, code: 'atendido' })
  const { window, doc } = await abrirConWorker([recibido], w)
  botonTarjeta(doc, 4, 'atender').click()
  const dicho = await hastaPanel(() => !!mensajeDe(doc, 4))
  // El aviso de una accion que salio bien dura 12 s.
  adelantarReloj(window, 13000)
  window.dispatchEvent(new window.Event('focus'))
  await espera()
  ok('el aviso de una accion se va al vencer aunque el tablero no cambie',
    dicho && !mensajeDe(doc, 4), mensajeDe(doc, 4)?.outerHTML)
}

// ── El periodo del tablero (informes-tablero, I1) ──
// Hoy · 7 dias · 30 dias · Todo, 7 dias de fabrica. Lo abierto se ve SIEMPRE; el periodo
// solo acota Respondido y Cerrado, por la hora en que el caso entro a esa etapa
// (`stage_at`). Las cuentas de esas dos etapas salen de `period_counts`, que cuenta todo y
// no solo lo que viaja en `cards`.
const DIA_MS = 86400000
/** Hace `dias` dias a las 12:00 locales: lejos de la medianoche, que es el borde. */
const diasAtras = (dias) => {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() - dias)
  return d.toISOString()
}
/** Hoy, `min` minutos despues de la medianoche local. */
const hoyA = (min) => {
  const d = new Date()
  d.setHours(0, min, 0, 0)
  return d.toISOString()
}
const terminada = (id, etapa, stageAt, extra = {}) => tarjeta(Object.assign({
  case_id: id, stage: etapa, proposal: null, exceptions: [], title: `Caso ${id}`,
  stage_at: stageAt, updated_at: stageAt, actions: ['reabrir']
}, extra))
const periodoApretado = (doc) =>
  doc.querySelector('#period button[aria-pressed="true"]')?.dataset.periodo ?? null
const apretarPeriodo = (doc, p) => doc.querySelector(`#period button[data-periodo="${p}"]`).click()
const cuentaChip = (doc, etapa) =>
  doc.querySelector(`#board-chips [data-etapa="${etapa}"] .chip-count`)?.textContent
const TARJETAS_PERIODO = () => [
  // Abierta y vieja: se ve en cualquier periodo.
  tarjeta({ case_id: 1, stage: 'decision', updated_at: diasAtras(60), stage_at: diasAtras(60) }),
  terminada(2, 'respondido', hoyA(1)),
  terminada(3, 'respondido', diasAtras(3)),
  terminada(4, 'respondido', diasAtras(20)),
  terminada(5, 'cerrado', diasAtras(1)),
  terminada(6, 'cerrado', diasAtras(45)),
  // Sin `stage_at` (un CLI de antes): vale su ultima actualizacion.
  terminada(7, 'cerrado', undefined, { updated_at: diasAtras(10) })
]

console.log('\nactivity.html — I1: el periodo acota Respondido y Cerrado, nunca lo abierto')
{
  const { doc } = await abrirTablero({ board: tablero(TARJETAS_PERIODO()) })
  ok('el periodo de fabrica es 7 dias', periodoApretado(doc) === '7d', periodoApretado(doc))
  ok('en 7 dias: lo abierto, y lo terminado de los ultimos 7 dias por su entrada a la etapa',
    visibles(doc).sort().join() === '1,2,3,5', visibles(doc).join())
  ok('los cuatro periodos, en palabras', ['today', '7d', '30d', 'all'].every((p) =>
    (doc.querySelector(`#period button[data-periodo="${p}"]`)?.textContent || '').trim()),
  doc.getElementById('period')?.textContent)
  ok('el grupo del periodo tiene nombre', !!doc.getElementById('period')?.getAttribute('aria-label'))
  apretarPeriodo(doc, 'today')
  await espera()
  ok('Hoy: lo abierto y lo que entro hoy', visibles(doc).sort().join() === '1,2', visibles(doc).join())
  ok('el boton apretado es el elegido', periodoApretado(doc) === 'today')
  apretarPeriodo(doc, '30d')
  await espera()
  ok('30 dias suma lo de hace 20 y lo que solo trae updated_at',
    visibles(doc).sort().join() === '1,2,3,4,5,7', visibles(doc).join())
  apretarPeriodo(doc, 'all')
  await espera()
  ok('Todo: todo', visibles(doc).sort().join() === '1,2,3,4,5,6,7', visibles(doc).join())
}
{
  // El caso abierto se ve aunque su etapa sea vieja, en el periodo mas corto.
  const { doc } = await abrirTablero({ board: tablero(TARJETAS_PERIODO()), boardPeriod: 'today' })
  ok('el periodo guardado manda al abrir', periodoApretado(doc) === 'today', periodoApretado(doc))
  ok('y con Hoy lo abierto de hace 60 dias sigue ahi', visibles(doc).includes('1'), visibles(doc).join())
}
{
  const storage = { board: tablero(TARJETAS_PERIODO()) }
  const { doc } = await abrirTablero(storage)
  apretarPeriodo(doc, '30d')
  await espera()
  ok('elegir un periodo lo recuerda en el storage del plugin', storage.boardPeriod === '30d',
    String(storage.boardPeriod))
  storage.boardPeriod = 'today'   // otra ventana guarda otro; esta no se pisa sola
  doc.defaultView.dispatchEvent(new doc.defaultView.Event('focus'))
  await espera()
  ok('el sondeo no le cambia el periodo a quien lo eligio', periodoApretado(doc) === '30d')
}
{
  const { doc } = await abrirTablero({ board: tablero(TARJETAS_PERIODO()), boardPeriod: 'semana' })
  ok('un periodo guardado que no existe deja el de fabrica', periodoApretado(doc) === '7d')
}

console.log('\nactivity.html — I1: las cuentas siguen al periodo')
{
  const board = tablero(TARJETAS_PERIODO(), {
    counts: cuentas({ decision: 1, respondido: 3, cerrado: 40 }),
    period_counts: { today: { respondido: 1, cerrado: 0 }, '7d': { respondido: 2, cerrado: 9 },
      '30d': { respondido: 3, cerrado: 25 }, all: { respondido: 3, cerrado: 40 } }
  })
  const { doc } = await abrirTablero({ board })
  ok('7 dias: las fichas de Respondido y Cerrado dicen lo del periodo',
    cuentaChip(doc, 'respondido') === '2' && cuentaChip(doc, 'cerrado') === '9',
    `${cuentaChip(doc, 'respondido')} ${cuentaChip(doc, 'cerrado')}`)
  ok('y Todos suma lo del periodo', cuentaChip(doc, 'todos') === String(1 + 2 + 9),
    cuentaChip(doc, 'todos'))
  ok('lo que el periodo cuenta y no viajo se dice en la columna',
    /8/.test(doc.querySelector('.col[data-stage="cerrado"] .col-more')?.textContent || ''),
    doc.querySelector('.col[data-stage="cerrado"]')?.textContent)
  apretarPeriodo(doc, 'today')
  await espera()
  ok('Hoy: las cuentas cambian con el periodo',
    cuentaChip(doc, 'respondido') === '1' && cuentaChip(doc, 'cerrado') === '0',
    `${cuentaChip(doc, 'respondido')} ${cuentaChip(doc, 'cerrado')}`)
  apretarPeriodo(doc, 'all')
  await espera()
  ok('Todo: las de siempre', cuentaChip(doc, 'cerrado') === '40', cuentaChip(doc, 'cerrado'))
}
{
  // Sin `period_counts` (CLI de antes): se cuenta lo que se ve del periodo.
  const { doc } = await abrirTablero({ board: tablero(TARJETAS_PERIODO()) })
  ok('sin period_counts se cuenta lo visible del periodo',
    cuentaChip(doc, 'respondido') === '2' && cuentaChip(doc, 'cerrado') === '1',
    `${cuentaChip(doc, 'respondido')} ${cuentaChip(doc, 'cerrado')}`)
}
{
  // El periodo en la lista (lo angosto) tambien.
  const { doc } = await abrirTablero({ board: tablero(TARJETAS_PERIODO()) })
  doc.querySelector('#board-view button[data-vista="list"]').click()
  await espera()
  ok('en la lista el periodo acota igual', visibles(doc).sort().join() === '1,2,3,5',
    visibles(doc).join())
}
console.log('\nactivity.html — I1: el periodo no pierde el primer clic')
{
  const { window, doc } = await abrirTablero({ board: tablero(TARJETAS_PERIODO()) })
  const boton = doc.querySelector('#period button[data-periodo="all"]')
  await clicReal(window, boton, async () => {
    window.dispatchEvent(new window.Event('focus'))
    await espera()
  })
  await espera()
  ok('el primer clic en un periodo, con una relectura en el medio, lo elige',
    periodoApretado(doc) === 'all' && visibles(doc).length === 7, visibles(doc).join())
}

// ── El tablero acotado (informes-tablero, I2) ──
// Respondido y Cerrado muestran los 20 ultimos (por su entrada a la etapa) y "Mostrar N
// mas" suma 20 cada vez. Cada columna se desplaza sola: la pagina no crece con las tarjetas.
const muchas = (etapa, n, desde = 1000) => Array.from({ length: n }, (_, i) =>
  terminada(desde + i, etapa, new Date(Date.now() - (i + 1) * 60000).toISOString()))
const enColumna = (doc, etapa) =>
  [...doc.querySelectorAll(`.col[data-stage="${etapa}"] .card[data-case]`)].map((n) => n.dataset.case)
const botonMas = (doc, etapa) => doc.querySelector(`[data-stage="${etapa}"] button.col-mas`)

console.log('\nactivity.html — I2: Respondido y Cerrado, de 20 en 20')
{
  const cards = [tarjeta({ case_id: 1 }), ...muchas('cerrado', 45), ...muchas('respondido', 22, 2000)]
  const { doc } = await abrirTablero({ board: tablero(cards) })
  ok('Cerrado muestra los 20 ultimos', enColumna(doc, 'cerrado').length === 20 &&
    enColumna(doc, 'cerrado')[0] === '1000' && enColumna(doc, 'cerrado')[19] === '1019',
  enColumna(doc, 'cerrado').join())
  ok('y ofrece mostrar 20 mas', /20/.test(botonMas(doc, 'cerrado')?.textContent || ''),
    botonMas(doc, 'cerrado')?.textContent)
  ok('la cuenta de la columna sigue siendo la del periodo',
    doc.querySelector('.col[data-stage="cerrado"] .col-count')?.textContent === '45')
  ok('Respondido ofrece los 2 que faltan', /\b2\b/.test(botonMas(doc, 'respondido')?.textContent || ''),
    botonMas(doc, 'respondido')?.textContent)
  ok('lo abierto no se acota', !botonMas(doc, 'decision'))
  botonMas(doc, 'cerrado').click()
  await espera()
  ok('un clic suma 20', enColumna(doc, 'cerrado').length === 40, String(enColumna(doc, 'cerrado').length))
  ok('y ahora ofrece los 5 que quedan', /\b5\b/.test(botonMas(doc, 'cerrado')?.textContent || ''),
    botonMas(doc, 'cerrado')?.textContent)
  ok('Respondido no se movio', enColumna(doc, 'respondido').length === 20)
  botonMas(doc, 'cerrado').click()
  await espera()
  ok('al final se ven todas y el boton se va',
    enColumna(doc, 'cerrado').length === 45 && !botonMas(doc, 'cerrado'))
  apretarPeriodo(doc, '30d')
  await espera()
  ok('cambiar el periodo vuelve a los 20', enColumna(doc, 'cerrado').length === 20)
  ok('el boton dice que agrega', !!botonMas(doc, 'cerrado')?.getAttribute('aria-label') ||
    /Mostrar/.test(botonMas(doc, 'cerrado')?.textContent || ''))
}
{
  const cards = [tarjeta({ case_id: 1 }), ...muchas('cerrado', 25)]
  const { doc } = await abrirTablero({ board: tablero(cards) })
  doc.querySelector('#board-view button[data-vista="list"]').click()
  await espera()
  ok('en la lista tambien de 20 en 20',
    doc.querySelectorAll('.grupo[data-stage="cerrado"] .card[data-case]').length === 20 &&
    /\b5\b/.test(botonMas(doc, 'cerrado')?.textContent || ''), botonMas(doc, 'cerrado')?.textContent)
  botonMas(doc, 'cerrado').click()
  await espera()
  ok('y el boton suma en la lista', doc.querySelectorAll('.grupo[data-stage="cerrado"] .card[data-case]').length === 25)
}
for (const [idioma, re] of [['en', /Show 20 more/], ['pt-BR', /Mostrar mais 20/]]) {
  const { doc } = await abrirTablero({ board: tablero(muchas('cerrado', 45)) }, idioma)
  ok(`${idioma}: el boton en su idioma`, re.test(botonMas(doc, 'cerrado')?.textContent || ''),
    botonMas(doc, 'cerrado')?.textContent)
}
{
  // El primer clic en "Mostrar mas" con una relectura en el medio: el boton apretado tiene que
  // seguir en la pagina al soltar.
  const { window, doc } = await abrirTablero({ board: tablero(muchas('cerrado', 45)) })
  await clicReal(window, botonMas(doc, 'cerrado'), async () => {
    window.dispatchEvent(new window.Event('focus'))
    await espera()
  })
  await espera()
  ok('el primer clic en Mostrar mas no se pierde', enColumna(doc, 'cerrado').length === 40,
    String(enColumna(doc, 'cerrado').length))
}

console.log('\nactivity.html — I2: cada columna se desplaza sola')
{
  const { doc, window } = await abrirTablero({ board: tablero([tarjeta({ case_id: 1 }), ...muchas('cerrado', 45)]) })
  const cols = doc.getElementById('board-cols')
  const alto = parseInt(cols.style.getPropertyValue('--alto-tablero'), 10)
  ok('las columnas tienen un alto tope atado a la ventana', alto > 0 && alto <= Math.max(window.innerHeight, 320),
    cols.getAttribute('style'))
  const css = [...doc.querySelectorAll('style')].map((s) => s.textContent).join('\n')
  ok('el tope esta en la fila de columnas', /\.board-cols\s*\{[^}]*max-height:\s*var\(--alto-tablero/.test(css))
  ok('y el cuerpo de cada columna se desplaza adentro',
    /\.col-body\s*\{[^}]*overflow-y:\s*auto/.test(css) && /\.col-body\s*\{[^}]*min-height:\s*0/.test(css))
  ok('una columna vacia sigue plegada', !!doc.querySelector('.col.vacia[data-stage="trabajo"]'))
}

// ── La meta del primer contacto (informes-tablero, I4) ──
// Un ajuste global en minutos (1..1440, 15 de fabrica) en la clave plana `slaMinutes`, en
// texto como el resto: wa-scope la valida y la manda de vuelta en cada sync. Vive junto a las
// respuestas automaticas, que son el primer contacto que mide.
console.log('\nconfig.html — I4: la meta del primer contacto')
{
  const { doc, storage } = await montar('config.html', {}, 'es-419')
  await espera()
  doc.getElementById('tab-aprobacion').click()
  await espera(); await espera()
  const campo = doc.getElementById('sla-minutes')
  ok('el campo existe en la pestana de las respuestas automaticas',
    !!campo && !!campo.closest('#view-aprobacion'), String(!!campo))
  ok('es un numero entero de 1 a 1440 minutos', campo?.type === 'number' && campo.min === '1' &&
    campo.max === '1440' && campo.step === '1')
  ok('sin nada guardado muestra 15', campo?.value === '15', campo?.value)
  ok('tiene etiqueta y una pista que dice que mide',
    (doc.querySelector('label[for="sla-minutes"]')?.textContent || '').trim().length > 3 &&
    /primera respuesta/i.test(doc.getElementById('sla-help')?.textContent || ''),
    doc.getElementById('sla-help')?.textContent)
  escribir(doc, 'sla-minutes', '30')
  doc.getElementById('save-sla').click()
  await espera(); await espera()
  ok('guardar escribe la clave plana en texto', storage.slaMinutes === '30', String(storage.slaMinutes))
  ok('y dice guardado', /✓/.test(doc.getElementById('said-sla').textContent))
  for (const malo of ['0', '1441', '7.5', 'media hora', '']) {
    escribir(doc, 'sla-minutes', malo)
    doc.getElementById('save-sla').click()
    await espera(); await espera()
    ok(`"${malo}" no se guarda y lo dice`, storage.slaMinutes === '30' &&
      doc.getElementById('said-sla').className.includes('bad') &&
      /1440/.test(doc.getElementById('said-sla').textContent),
    `${storage.slaMinutes} ${doc.getElementById('said-sla').textContent}`)
  }
}
{
  const { doc } = await montar('config.html', { slaMinutes: '45' }, 'es-419')
  await espera()
  doc.getElementById('tab-aprobacion').click()
  await espera(); await espera()
  ok('al abrir la pestana pinta la meta guardada', doc.getElementById('sla-minutes').value === '45',
    doc.getElementById('sla-minutes').value)
}
{
  // Un host que rechaza la escritura: no dice guardado.
  const { doc } = await montar('config.html', {}, 'es-419',
    (d) => d.action === 'storage.set' && d.params.key === 'slaMinutes' ? { ok: false } : undefined)
  await espera()
  doc.getElementById('tab-aprobacion').click()
  await espera()
  escribir(doc, 'sla-minutes', '20')
  doc.getElementById('save-sla').click()
  await espera(); await espera()
  ok('si el host no guarda, no dice guardado', doc.getElementById('said-sla').className.includes('bad'),
    doc.getElementById('said-sla').textContent)
}
for (const [idioma, nombre, re] of [['es-419', 'ES', /Meta/], ['en', 'EN', /target/i], ['pt-BR', 'PT', /Meta/]]) {
  const { doc } = await montar('config.html', {}, idioma)
  await espera()
  ok(`${nombre}: la meta en su idioma`,
    re.test(doc.querySelector('label[for="sla-minutes"]')?.textContent || '') &&
    (doc.getElementById('sla-help')?.textContent || '').trim().length > 20 &&
    (doc.getElementById('sla-legend')?.textContent || '').trim().length > 3,
    doc.querySelector('label[for="sla-minutes"]')?.textContent)
}

// ── La pestana Informes (informes-tablero, I5) ──
// Lee la clave `reports` que escribe `wa-scope sync` y pinta seis bloques con el periodo del
// tablero: Ahora, Trafico, Tiempos, Volumen, la meta del primer contacto y Por proyecto.
// Compara con el periodo anterior SOLO si la clave trae la comparacion (null = sin base).
const { informeDeEjemplo, informeVacio } = await import('./informes-ejemplo.mjs')
const abrirInformes = async (storage, idioma = 'es-419') => {
  const m = await abrirTablero(storage, idioma)
  m.doc.getElementById('tab-reports').click()
  await espera(); await espera()
  return m
}
const txt = (doc, sel) => (doc.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim()
const bloque = (doc, cual) => doc.querySelector(`#reports-body [data-bloque="${cual}"]`)
const tiempo = (doc, cual) => doc.querySelector(`#reports-body [data-tiempo="${cual}"]`)
const azulejo = (doc, cual) => txt(doc, `#reports-body [data-metrica="${cual}"] .rep-num`)
/** Un numero como lo escribe el idioma del panel (es-419 agrupa con coma; pt-BR con punto). */
const comoEn = (tag, n, opc) => new Intl.NumberFormat(tag, opc).format(n).replace(/\s+/g, ' ')

console.log('\nactivity.html — I5: Tablero e Informes son dos pestanas')
{
  const { doc, enviados } = await abrirTablero({ board: tablero([tarjeta()]), reports: informeDeEjemplo() })
  const tabs = [...doc.querySelectorAll('[role="tablist"] [role="tab"]')]
  ok('dos pestanas: Tablero e Informes', tabs.map((b) => b.id).join() === 'tab-board,tab-reports' &&
    tabs.every((b) => b.textContent.trim()), tabs.map((b) => b.textContent).join())
  ok('se abre en el Tablero', tabs[0].getAttribute('aria-selected') === 'true' &&
    !doc.getElementById('view-board').hidden && doc.getElementById('view-reports').hidden)
  ok('con el Tablero a la vista no se lee `reports`',
    !enviados.some((d) => d.action === 'storage.get' && d.params.key === 'reports'))
  tabs[1].click()
  await espera(); await espera()
  ok('Informes muestra su vista y esconde el tablero', tabs[1].getAttribute('aria-selected') === 'true' &&
    doc.getElementById('view-board').hidden && !doc.getElementById('view-reports').hidden)
  ok('y ahi si se lee `reports`', enviados.some((d) => d.action === 'storage.get' && d.params.key === 'reports'))
  ok('el periodo sigue a la vista, compartido', !doc.getElementById('period').closest('[hidden]'))
  tabs[1].dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  await espera()
  ok('las flechas cambian de pestana', tabs[0].getAttribute('aria-selected') === 'true' &&
    !doc.getElementById('view-board').hidden)
}

console.log('\nactivity.html — I5: los seis bloques, con 7 dias')
{
  const { doc } = await abrirInformes({ board: tablero([tarjeta()]), reports: informeDeEjemplo() })
  ok('los seis bloques, cada uno con su definicion',
    ['ahora', 'trafico', 'tiempos', 'volumen', 'sla', 'proyectos'].every((b) =>
      bloque(doc, b) && txt(doc, `#reports-body [data-bloque="${b}"] .rep-def`).length > 20),
    [...doc.querySelectorAll('#reports-body [data-bloque]')].map((n) => n.dataset.bloque).join())
  ok('Ahora: abiertos, su decision, el cliente, bloqueados y conversaciones',
    ['open', 'decision', 'waiting_customer', 'blocked', 'conversations'].map((k) => azulejo(doc, k)).join() ===
    '7,3,2,1,14', ['open', 'decision', 'waiting_customer', 'blocked', 'conversations'].map((k) => azulejo(doc, k)).join())
  ok('primera respuesta: la mediana en minutos y sobre cuantos casos',
    txt(doc, '[data-tiempo="first_response"] .rep-num') === '13 min' &&
    /18 casos/.test(txt(doc, '[data-tiempo="first_response"] .rep-n')),
    txt(doc, '[data-tiempo="first_response"]'))
  const dPrimera = tiempo(doc, 'first_response').querySelector('.rep-delta')
  ok('bajo un 16 %: flecha abajo, y es mejor', /▼/.test(dPrimera?.textContent || '') &&
    /16\s?%/.test(dPrimera?.textContent || '') && dPrimera.classList.contains('mejor') &&
    /anterior/.test(dPrimera.textContent), dPrimera?.outerHTML)
  ok('resolucion en horas y minutos, subio y es peor',
    txt(doc, '[data-tiempo="resolution"] .rep-num') === '3 h 50 min' &&
    tiempo(doc, 'resolution').querySelector('.rep-delta.peor') &&
    /▲/.test(txt(doc, '[data-tiempo="resolution"] .rep-delta')), txt(doc, '[data-tiempo="resolution"]'))
  ok('espera del cliente: sin base no hay comparacion, y dice cuantas siguen sin respuesta',
    txt(doc, '[data-tiempo="customer_wait"] .rep-num') === '7 min' &&
    !tiempo(doc, 'customer_wait').querySelector('.rep-delta') &&
    /3 todavia sin respuesta/.test(txt(doc, '[data-tiempo="customer_wait"]')), txt(doc, '[data-tiempo="customer_wait"]'))
  ok('cada tiempo trae sus barras, una por dia, y la que no tiene datos no se dibuja',
    tiempo(doc, 'first_response').querySelectorAll('.rep-grupo').length === 7 &&
    tiempo(doc, 'first_response').querySelectorAll('.rep-grupo .b').length === 6 &&
    /min/.test(tiempo(doc, 'first_response').querySelector('.rep-grupo').getAttribute('title') || ''),
  String(tiempo(doc, 'first_response').querySelectorAll('.rep-grupo').length))
  ok('las barras tienen nombre para quien no las ve',
    !!tiempo(doc, 'first_response').querySelector('.rep-barras[role="img"][aria-label]'))
  ok('volumen: los cinco totales con el numero en espanol',
    azulejo(doc, 'chats') === '12' && azulejo(doc, 'received') === comoEn('es-419', 12345) &&
    azulejo(doc, 'sent') === comoEn('es-419', 9876) &&
    azulejo(doc, 'created') === '18' && azulejo(doc, 'resolved') === '15', azulejo(doc, 'received'))
  const dv = (k) => doc.querySelector(`#reports-body [data-metrica="${k}"] .rep-delta`)
  ok('volumen: subio, bajo, sin base y sin cambio',
    /▲/.test(dv('received')?.textContent || '') && /12\s?%/.test(dv('received')?.textContent || '') &&
    /▼/.test(dv('sent')?.textContent || '') && !dv('created') && /0\s?%/.test(dv('resolved')?.textContent || '') &&
    !/[▲▼]/.test(dv('resolved')?.textContent || ''), `${dv('received')?.textContent} | ${dv('resolved')?.textContent}`)
  ok('volumen: mensajes y casos, cada grafico con su leyenda de dos series',
    bloque(doc, 'volumen').querySelectorAll('.rep-barras').length === 2 &&
    bloque(doc, 'volumen').querySelectorAll('.rep-leyenda').length === 2 &&
    /Recibidos/.test(txt(doc, '[data-bloque="volumen"] .rep-leyenda')))
  ok('trafico: dos mapas, siete filas por fecha y 24 horas',
    bloque(doc, 'trafico').querySelectorAll('.rep-mapa').length === 2 &&
    bloque(doc, 'trafico').querySelector('.rep-mapa').querySelectorAll('.rep-fila').length === 7 &&
    bloque(doc, 'trafico').querySelector('.rep-fila').querySelectorAll('.rep-celda').length === 24)
  const celda = bloque(doc, 'trafico').querySelector('.rep-celda.n4')
  ok('cada celda dice dia, hora y cuantos; el mapa dice la hora pico y su escala',
    /\d{2}:00/.test(celda?.getAttribute('title') || '') && /Hora pico/.test(txt(doc, '[data-bloque="trafico"]')) &&
    /Menos/.test(txt(doc, '[data-bloque="trafico"] .rep-escala')), celda?.getAttribute('title'))
  ok('la meta: tasa, puntos contra el anterior y la meta en vigor',
    txt(doc, '[data-bloque="sla"] .rep-num') === comoEn('es-419', 0.824, { style: 'percent', maximumFractionDigits: 1 }) &&
    txt(doc, '[data-bloque="sla"] .rep-delta').startsWith('▲ ' + comoEn('es-419', 7.4) + ' pts') &&
    /15 min/.test(txt(doc, '[data-bloque="sla"] .rep-def')), txt(doc, '[data-bloque="sla"]'))
  ok('la meta: cumplen, no cumplen y pendientes', /14/.test(txt(doc, '[data-sla="met"]')) &&
    /3/.test(txt(doc, '[data-sla="missed"]')) && /1/.test(txt(doc, '[data-sla="pending"]')))
  const filas = [...bloque(doc, 'sla').querySelectorAll('tbody tr')]
  ok('la lista de los que no cumplieron, con el texto del cliente como texto',
    filas.length === 2 && /#41/.test(filas[0].textContent) && /Factura <b>duplicada<\/b>/.test(filas[0].textContent) &&
    !filas[0].querySelector('b') && /40 min/.test(filas[0].textContent) && /Beta Demo/.test(filas[0].textContent) &&
    /sin respuesta/.test(filas[1].textContent), filas.map((f) => f.textContent).join(' | '))
  ok('y cuantos mas quedaron afuera de la lista', /y 1 mas/.test(txt(doc, '[data-bloque="sla"]')))
  const proy = [...bloque(doc, 'proyectos').querySelectorAll('tbody tr')].map((f) => [...f.cells].map((c) => c.textContent.trim()))
  ok('por proyecto: casos, desenlaces, Jev y su decision; sin proyecto al final',
    JSON.stringify(proy[0]) === JSON.stringify(['Alfa Demo', '10', '6', '2', '1', '2', '3']) &&
    proy[2][0] === 'Sin proyecto', JSON.stringify(proy))
  ok('las tablas tienen encabezados', bloque(doc, 'proyectos').querySelectorAll('thead th').length === 7)
}

console.log('\nactivity.html — I5: el periodo manda en los informes')
{
  const { doc } = await abrirInformes({ board: tablero([tarjeta()]), reports: informeDeEjemplo() })
  apretarPeriodo(doc, 'today')
  await espera()
  ok('Hoy: barras por hora y una sola fila en el mapa',
    tiempo(doc, 'first_response').querySelectorAll('.rep-grupo').length === new Date().getHours() + 1 &&
    bloque(doc, 'trafico').querySelector('.rep-mapa').querySelectorAll('.rep-fila').length === 1)
  apretarPeriodo(doc, '30d')
  await espera()
  ok('30 dias: el mapa por dia de la semana', bloque(doc, 'trafico').querySelector('.rep-mapa')
    .querySelectorAll('.rep-fila').length === 7 && /lun/i.test(txt(doc, '[data-bloque="trafico"] .rep-fila')),
  txt(doc, '[data-bloque="trafico"] .rep-fila'))
  apretarPeriodo(doc, 'all')
  await espera()
  ok('Todo: sin periodo anterior, ninguna comparacion', !doc.querySelector('#reports-body .rep-delta'))
  ok('Todo: barras por semana', tiempo(doc, 'first_response').querySelectorAll('.rep-grupo').length === 12 &&
    /Semana/.test(tiempo(doc, 'first_response').querySelector('.rep-grupo').getAttribute('title') || ''))
}

console.log('\nactivity.html — I5: lo vacio se dice')
{
  const { doc } = await abrirInformes({ board: tablero([tarjeta()]) })
  ok('sin la clave, dice que todavia no hay informes y cuando llegan',
    !doc.getElementById('reports-empty').hidden && /Todavia no hay informes/.test(txt(doc, '#reports-empty')) &&
    !doc.querySelector('#reports-body [data-bloque]'), txt(doc, '#reports-empty'))
}
{
  const { doc } = await abrirInformes({ board: tablero([tarjeta()]), reports: Object.assign(informeDeEjemplo(), { v: 2 }) })
  ok('una version que no entiende lo dice', /version 2/.test(txt(doc, '#reports-empty')), txt(doc, '#reports-empty'))
}
{
  const { doc } = await abrirInformes({ board: tablero([tarjeta()]), reports: informeVacio() })
  ok('sin datos: los tiempos dicen que no hay, sin guion suelto ni cero segundos',
    /Sin datos en este periodo/.test(txt(doc, '[data-tiempo="first_response"]')) &&
    !/0 s/.test(txt(doc, '[data-bloque="tiempos"]')), txt(doc, '[data-tiempo="first_response"]'))
  ok('sin datos: el mapa dice que no hubo nada', /Nada en este periodo/.test(txt(doc, '[data-bloque="trafico"]')))
  ok('sin datos: el volumen sin graficos vacios', /Sin actividad en este periodo/.test(txt(doc, '[data-bloque="volumen"]')) &&
    !bloque(doc, 'volumen').querySelector('.rep-barras'))
  ok('sin datos: la meta y los proyectos lo dicen',
    /Ningun caso medible/.test(txt(doc, '[data-bloque="sla"]')) && /Ningun caso en este periodo/.test(txt(doc, '[data-bloque="proyectos"]')))
  ok('sin datos: comparaciones sin base no se muestran', !doc.querySelector('#reports-body .rep-delta'))
}

console.log('\nactivity.html — I5: en ingles y portugues, con sus numeros')
{
  const { doc } = await abrirInformes({ board: tablero([tarjeta()]), reports: informeDeEjemplo() }, 'en')
  ok('EN: los textos y los numeros en ingles', azulejo(doc, 'received') === '12,345' &&
    txt(doc, '[data-bloque="sla"] .rep-num') === '82.4%' && /First response/.test(txt(doc, '[data-bloque="tiempos"]')) &&
    /No project/.test(txt(doc, '[data-bloque="proyectos"]')) && txt(doc, '#tab-reports') === 'Reports',
  `${azulejo(doc, 'received')} ${txt(doc, '[data-bloque="sla"] .rep-num')}`)
  ok('EN: ni una clave cruda', !/rep[A-Z][a-zA-Z]+/.test(txt(doc, '#view-reports')), txt(doc, '#view-reports').match(/rep[A-Z][a-zA-Z]+/)?.[0])
}
{
  const { doc } = await abrirInformes({ board: tablero([tarjeta()]), reports: informeDeEjemplo() }, 'pt-BR')
  ok('PT: los textos y los numeros en portugues', azulejo(doc, 'received') === '12.345' &&
    /Primeira resposta/.test(txt(doc, '[data-bloque="tiempos"]')) && txt(doc, '#tab-reports') === 'Relatorios' &&
    !/rep[A-Z][a-zA-Z]+/.test(txt(doc, '#view-reports')), txt(doc, '#view-reports').slice(0, 200))
}

console.log('\nactivity.html — I5: los informes no le roban el clic a nadie')
{
  const storage = { board: tablero([tarjeta()]), reports: informeDeEjemplo() }
  const { window, doc } = await abrirInformes(storage)
  const antes = bloque(doc, 'ahora')
  window.dispatchEvent(new window.Event('focus'))
  await espera()
  ok('releer el mismo informe no reconstruye los bloques', bloque(doc, 'ahora') === antes)
  const boton = doc.querySelector('#period button[data-periodo="30d"]')
  let durante = null
  await clicReal(window, boton, async () => {
    storage.reports = Object.assign(informeDeEjemplo(), { live: Object.assign(informeDeEjemplo().live, { open: 99 }) })
    window.dispatchEvent(new window.Event('focus'))
    await espera()
    durante = azulejo(doc, 'open')
  })
  await espera()
  ok('con el puntero apretado el informe nuevo espera', durante === '7', durante)
  ok('al soltar: el clic eligio el periodo y el informe nuevo se pinta',
    periodoApretado(doc) === '30d' && azulejo(doc, 'open') === '99', `${periodoApretado(doc)} ${azulejo(doc, 'open')}`)
  const tabBoard = doc.getElementById('tab-board')
  await clicReal(window, tabBoard, async () => {
    window.dispatchEvent(new window.Event('focus'))
    await espera()
  })
  await espera()
  ok('el primer clic en la pestana Tablero, con una relectura en el medio, la abre',
    !doc.getElementById('view-board').hidden)
}

// ── Los casos del periodo en CSV (informes-tablero, I6) ──
// El panel vive en un iframe `sandbox="allow-scripts"` (orca-oss PluginPanel.tsx): sin
// allow-downloads el navegador no baja nada, y la API del portapapeles la frena la politica
// de permisos. Lo que si pasa es `execCommand('copy')` con el clic del dueno, asi que el
// CSV se COPIA. Aca el portapapeles es un doble: jsdom no trae execCommand.
const conPortapapeles = (window, resultado = true) => {
  const copias = []
  window.document.execCommand = (cmd) => {
    const n = window.document.activeElement
    if (cmd === 'copy' && n && 'value' in n) copias.push(n.value.slice(n.selectionStart, n.selectionEnd))
    return resultado
  }
  return copias
}
const botonCsv = (doc) => doc.getElementById('reports-csv')

console.log('\nactivity.html — I6: copiar los casos del periodo como CSV')
{
  const informe = informeDeEjemplo()
  const { window, doc } = await abrirInformes({ board: tablero([tarjeta()]), reports: informe })
  ok('el bloque de los casos, con su boton y cuantos son', !!bloque(doc, 'csv') &&
    /Copiar CSV/.test(botonCsv(doc)?.textContent || '') && /3 casos/.test(txt(doc, '[data-bloque="csv"]')),
  txt(doc, '[data-bloque="csv"]'))
  ok('y dice por que se copia y no se descarga', /descargar/.test(txt(doc, '[data-bloque="csv"] .rep-def')))
  const copias = conPortapapeles(window)
  botonCsv(doc).click()
  await espera()
  const csv = copias[0] || ''
  const lineas = csv.split('\n')
  ok('copia una vez, con el encabezado en su idioma', copias.length === 1 &&
    lineas[0] === 'Caso,Chat,Creado,Primera respuesta (s),Resolucion (s),Etapa,Proyecto,Cumple la meta',
  lineas[0])
  ok('las filas del periodo: las creadas en los ultimos 7 dias, de la mas nueva a la mas vieja',
    lineas.length === 4 && lineas.slice(1).map((l) => l.split(',')[0]).join() === '52,51,50', JSON.stringify(lineas))
  const ej = informe.cases
  ok('una fila entera: comillas y comas escapadas, etapa y meta en palabras',
    lineas[1] === `52,"Soporte, ""Norte""",${ej[0].created},300,,Su decision,Alfa Demo,si`, lineas[1])
  ok('lo que empieza con = no se vuelve una formula en la planilla',
    lineas[2] === `51,'=Cliente Uno,${ej[1].created},2400,7200,Respondido,,no`, lineas[2])
  ok('sin respuesta todavia: vacio y pendiente', lineas[3] === `50,Soporte Norte,${ej[2].created},,,Recibido,Beta Demo,pendiente`,
    lineas[3])
  ok('el titulo del cliente no viaja (no es una columna del pedido)', !/Pedido con coma|Otra linea/.test(csv))
  ok('y dice que lo copio', /Copiado: 3 casos/.test(txt(doc, '#reports-csv-msg')) &&
    !doc.getElementById('reports-csv-msg').classList.contains('mala'), txt(doc, '#reports-csv-msg'))
  ok('el foco vuelve al boton', doc.activeElement === botonCsv(doc))
  ok('no deja el campo auxiliar en la pagina', !doc.querySelector('textarea.rep-csv-aux'))
  apretarPeriodo(doc, 'all')
  await espera()
  botonCsv(doc).click()
  await espera()
  ok('Todo: todas las filas', (copias[1] || '').split('\n').length === 5, copias[1])
}
{
  const { window, doc } = await abrirInformes({ board: tablero([tarjeta()]), reports: informeDeEjemplo() })
  conPortapapeles(window, false)
  botonCsv(doc).click()
  await espera()
  ok('si el navegador no copia, lo dice y no dice copiado',
    doc.getElementById('reports-csv-msg').classList.contains('mala') &&
    /No se pudo copiar/.test(txt(doc, '#reports-csv-msg')), txt(doc, '#reports-csv-msg'))
}
{
  const { doc } = await abrirInformes({ board: tablero([tarjeta()]), reports: informeDeEjemplo() })
  botonCsv(doc).click()
  await espera()
  ok('sin execCommand tampoco miente', /No se pudo copiar/.test(txt(doc, '#reports-csv-msg')))
}
{
  const { doc } = await abrirInformes({ board: tablero([tarjeta()]), reports: informeVacio() })
  ok('sin casos en el periodo no hay boton muerto', !botonCsv(doc) &&
    /Ningun caso creado en este periodo/.test(txt(doc, '[data-bloque="csv"]')), txt(doc, '[data-bloque="csv"]'))
}
{
  const r = Object.assign(informeDeEjemplo(), { cases_more: 120 })
  const { doc } = await abrirInformes({ board: tablero([tarjeta()]), reports: r })
  apretarPeriodo(doc, 'all')
  await espera()
  ok('con el tope, dice que quedan casos viejos afuera', /120/.test(txt(doc, '[data-bloque="csv"]')),
    txt(doc, '[data-bloque="csv"]'))
}
for (const [idioma, enc, si] of [['en', 'Case,Chat,Created,First response (s),Resolution (s),Stage,Project,Met target', 'yes'],
  ['pt-BR', 'Caso,Chat,Criado,Primeira resposta (s),Resolucao (s),Etapa,Projeto,Cumpre a meta', 'sim']]) {
  const { window, doc } = await abrirInformes({ board: tablero([tarjeta()]), reports: informeDeEjemplo() }, idioma)
  const copias = conPortapapeles(window)
  botonCsv(doc).click()
  await espera()
  const l = (copias[0] || '').split('\n')
  ok(`${idioma}: encabezado y valores en su idioma`, l[0] === enc && l[1].endsWith(',' + si), `${l[0]} | ${l[1]}`)
}
{
  const storage = { board: tablero([tarjeta()]), reports: informeDeEjemplo() }
  const { window, doc } = await abrirInformes(storage)
  const copias = conPortapapeles(window)
  const boton = botonCsv(doc)
  await clicReal(window, boton, async () => {
    storage.reports = Object.assign(informeDeEjemplo(), { cases_more: 7 })
    window.dispatchEvent(new window.Event('focus'))
    await espera()
  })
  await espera()
  ok('el primer clic en Copiar CSV, con una relectura en el medio, copia', copias.length === 1)
}

// ── Lo que encontro la revision de Informes y del tablero con periodo ──
// Cada uno se vio de verdad (jsdom o captura) antes de arreglarlo.
console.log('\nactivity.html — revision: un periodo sin nada no es un tablero vacio')
{
  // Todo cerrado hace 3 dias, nada abierto y "Hoy" guardado: hay casos, solo que ninguno
  // en el periodo. Decir "Todavia no hay casos" es falso, y la barra no puede irse.
  const viejas = [1, 2, 3].map((i) => terminada(i, 'cerrado', diasAtras(3)))
  const board = tablero(viejas, { period_counts: { today: { respondido: 0, cerrado: 0 },
    '7d': { respondido: 0, cerrado: 3 }, '30d': { respondido: 0, cerrado: 3 }, all: { respondido: 0, cerrado: 3 } } })
  const { doc } = await abrirTablero({ board, boardPeriod: 'today' })
  ok('con casos fuera del periodo no dice que no hay casos',
    doc.getElementById('board-empty').hidden, txt(doc, '#board-empty'))
  ok('la barra del tablero sigue a la vista', !doc.getElementById('board-bar').hidden &&
    !doc.getElementById('board-body').hidden)
  ok('y dice que en este periodo no hay nada', !doc.getElementById('board-nada').hidden &&
    /este periodo/.test(txt(doc, '#board-nada')), txt(doc, '#board-nada'))
  apretarPeriodo(doc, '7d')
  await espera()
  ok('con 7 dias vuelven las tres', visibles(doc).sort().join() === '1,2,3', visibles(doc).join())
}
{
  const { doc } = await abrirTablero({ board: tablero([]) })
  ok('sin ningun caso sigue diciendo que todavia no hay casos', !doc.getElementById('board-empty').hidden &&
    /Todavia no hay casos/.test(txt(doc, '#board-empty')) && doc.getElementById('board-bar').hidden)
}

console.log('\nactivity.html — revision: Informes tolera una clave rara y la de otra linea')
{
  const r = informeDeEjemplo()
  r.cases.push(null)
  const { doc } = await abrirInformes({ board: tablero([tarjeta()]), reports: r })
  ok('un null al final de cases no deja la pestana a medias', !!bloque(doc, 'csv') && !!botonCsv(doc),
    [...doc.querySelectorAll('#reports-body [data-bloque]')].map((n) => n.dataset.bloque).join())
}
{
  const linea = 'pn:573000000012'
  const storage = { board: tablero([tarjeta({ account: linea })]), sidecar: { cuenta: linea },
    reports: Object.assign(informeDeEjemplo(), { account: 'pn:573000000011' }) }
  const { doc } = await abrirInformes(storage)
  ok('el informe de otra linea no se pinta como de esta', !bloque(doc, 'ahora') &&
    /Todavia no hay informes/.test(txt(doc, '#reports-empty')), txt(doc, '#view-reports').slice(0, 120))
  storage.reports = Object.assign(informeDeEjemplo(), { account: linea })
  doc.defaultView.dispatchEvent(new doc.defaultView.Event('focus'))
  await espera(); await espera()
  ok('el de esta linea si', !!bloque(doc, 'ahora') && doc.getElementById('reports-empty').hidden)
}

console.log('\nactivity.html — revision: el aviso de Copiar CSV se anuncia')
{
  const { window, doc } = await abrirInformes({ board: tablero([tarjeta()]), reports: informeDeEjemplo() })
  const region = doc.getElementById('reports-csv-msg')
  ok('la region del aviso ya esta, vacia, antes de copiar',
    !!region && region.getAttribute('role') === 'status' && !region.textContent.trim(), region?.outerHTML)
  conPortapapeles(window)
  botonCsv(doc).click()
  await espera()
  ok('copiar cambia el texto de ESA region, no crea otra ya llena',
    doc.getElementById('reports-csv-msg') === region && /Copiado: 3 casos/.test(region.textContent),
    doc.getElementById('reports-csv-msg')?.outerHTML)
  ok('y el foco sigue en el boton', doc.activeElement === botonCsv(doc))
}
{
  const { window, doc } = await abrirInformes({ board: tablero([tarjeta()]), reports: informeDeEjemplo() })
  conPortapapeles(window, false)
  botonCsv(doc).click()
  await espera()
  const msg = doc.getElementById('reports-csv-msg')
  ok('si no copia, el aviso es una alerta, como los demas avisos que fallan',
    msg.getAttribute('role') === 'alert' && msg.classList.contains('mala'), msg.outerHTML)
}

console.log('\nactivity.html — revision: los ejes y los mapas caben')
{
  const { doc } = await abrirInformes({ board: tablero([tarjeta()]), reports: informeDeEjemplo() })
  apretarPeriodo(doc, 'all')
  await espera()
  const t0 = tiempo(doc, 'first_response')
  const eje = t0.querySelector('.rep-eje')
  ok('Todo: el eje dice la fecha corta y el titulo de cada barra, la semana',
    eje && eje.children.length === 3 && !/Semana/.test(eje.textContent) &&
    /Semana/.test(t0.querySelector('.rep-grupo').getAttribute('title') || ''), eje?.textContent)
  ok('el nombre del grafico sigue diciendo las semanas',
    /Semana/.test(t0.querySelector('.rep-barras').getAttribute('aria-label') || ''))
}
{
  const { doc } = await abrirInformes({ board: tablero([tarjeta()]), reports: informeDeEjemplo() })
  ok('volumen: los graficos de dos series separan cada cubeta de la siguiente',
    [...bloque(doc, 'volumen').querySelectorAll('.rep-plot')].every((p) => p.classList.contains('dos')) &&
    !tiempo(doc, 'first_response').querySelector('.rep-plot.dos'))
}
{
  const { doc } = await abrirInformes({ board: tablero([tarjeta()]), reports: informeDeEjemplo() }, 'pt-BR')
  const filas = [...bloque(doc, 'trafico').querySelector('.rep-mapa').querySelectorAll('.rep-fila .rep-fila-k')]
    .map((n) => n.textContent)
  ok('PT: cada fila del mapa dice el dia y su numero, sin coma, en lo que cabe',
    filas.length === 7 && filas.every((x) => /^\D+ \d{1,2}$/.test(x) && !/,/.test(x) && x.length <= 7),
    JSON.stringify(filas))
}
{
  const { doc } = await abrirInformes({ board: tablero([tarjeta()]), reports: informeDeEjemplo() }, 'en')
  const filas = [...bloque(doc, 'trafico').querySelector('.rep-mapa').querySelectorAll('.rep-fila .rep-fila-k')]
    .map((n) => n.textContent)
  ok('EN: tambien', filas.every((x) => /^\D+ \d{1,2}$/.test(x)), JSON.stringify(filas))
}

// ───────── proyectos-por-chat (M6): varios proyectos por conversacion ─────────
// La conversacion guarda una LISTA ordenada (`workspaces`) y, al lado, `workspace`
// derivado: el unico id con uno, null con cero o con dos o mas. El CLI confia en la lista
// solo si el `workspace` de al lado es su derivado (odd/tasks/proyectos-por-chat.md,
// "Part A backend contract"), asi que el panel escribe las dos en cada guardado.
/** Una seccion que tira una excepcion cuenta como una falla y deja correr las demas. */
async function seccion (fn) {
  try { await fn() } catch (e) {
    ok('la seccion corre sin excepciones', false, String((e && e.stack) || e).split('\n').slice(0, 2).join(' '))
  }
}
const PROYECTOS_TRES = PROYECTOS_PRUEBA.concat([
  { id: 'gama-demo', name: 'Gama Demo', path: '/srv/ejemplo/gama-demo', note: '' }])
/** Los valores de cada fila de proyecto del formulario, en orden: la primera vive en
 *  `#workspace`, las demas en las filas de `#workspace-more`. */
const filasProyecto = (doc) => [doc.getElementById('workspace').value].concat(
  [...doc.querySelectorAll('#workspace-more input[type="hidden"]')].map((n) => n.value))
/** Lo que se VE de una celda: sin el texto que solo lee el lector de pantalla. */
const aLaVista = (n) => {
  if (!n) return ''
  const copia = n.cloneNode(true)
  copia.querySelectorAll('.sr-only').forEach((x) => x.remove())
  return copia.textContent.replace(/\s+/g, ' ').trim()
}
const camposProyecto = (doc) => [doc.getElementById('workspace-search')].concat(
  [...doc.querySelectorAll('#workspace-more input[role="combobox"]')])

console.log('\nconfig.html — proyectos-por-chat (M6): una conversacion con varios proyectos')
await seccion(async () => {
  const storage = { projects: PROYECTOS_TRES,
    chats: [{ jid: '1@g.us', name: 'Soporte Norte', kind: 'grupo' }] }
  const { doc, window } = await montar('config.html', storage, 'es-419')
  await espera()
  const agregar = doc.getElementById('workspace-add')
  ok('con ningun proyecto elegido no se ofrece agregar otro', !!agregar && agregar.hidden)
  ok('ni a quien preguntar', doc.getElementById('project-question-wrap')?.hidden === true)
  elegirChat(doc, '1@g.us')
  elegirProyecto(doc, 'workspace', 'alfa-demo')
  ok('con uno elegido se ofrece agregar otro, con un boton', !agregar.hidden &&
    agregar.tagName === 'BUTTON' && agregar.type === 'button' && agregar.textContent.trim().length > 3,
    agregar.outerHTML)
  agregar.click()
  const segundo = doc.getElementById('workspace-search-2')
  ok('agregar abre una segunda fila con el mismo autocompletar, con el foco',
    !!segundo && segundo.getAttribute('role') === 'combobox' &&
    doc.getElementById('workspace-list-2')?.getAttribute('role') === 'listbox' &&
    doc.activeElement === segundo, segundo?.outerHTML)
  ok('la fila nueva tiene nombre propio para el lector de pantalla',
    /2/.test(segundo?.getAttribute('aria-label') || ''), segundo?.getAttribute('aria-label'))
  escribir(doc, 'workspace-search-2', '')
  const ofrecidos2 = opcionesCombo(doc, 'workspace-list-2').map((o) => o.dataset.value)
  ok('la segunda fila no ofrece lo ya elegido ni Sin proyecto',
    JSON.stringify(ofrecidos2) === JSON.stringify(['beta-demo', 'gama-demo']), JSON.stringify(ofrecidos2))
  // Con el teclado: flecha abajo y Enter eligen, como en el de siempre.
  segundo.dispatchEvent(tecla(doc, 'ArrowDown'))
  segundo.dispatchEvent(tecla(doc, 'Enter'))
  ok('flecha y Enter eligen el proyecto de la segunda fila',
    JSON.stringify(filasProyecto(doc)) === JSON.stringify(['alfa-demo', 'beta-demo']) &&
    segundo.value === 'Beta Demo', JSON.stringify(filasProyecto(doc)) + ' ' + segundo.value)
  escribir(doc, 'workspace-search', '')
  ok('la primera fila tampoco ofrece lo que eligio otra, ni Sin proyecto con dos',
    JSON.stringify(opcionesCombo(doc, 'workspace-list').map((o) => o.dataset.value)) ===
    JSON.stringify(['alfa-demo', 'gama-demo']),
    JSON.stringify(opcionesCombo(doc, 'workspace-list').map((o) => o.dataset.value)))
  doc.getElementById('workspace-search').dispatchEvent(tecla(doc, 'Escape'))
  // Una tercera fila que queda vacia se quita con Retroceso, y el foco vuelve a la de arriba.
  agregar.click()
  const tercero = doc.getElementById('workspace-search-3')
  ok('una tercera fila', !!tercero && doc.activeElement === tercero)
  tercero.dispatchEvent(tecla(doc, 'Backspace'))
  ok('Retroceso en una fila vacia la quita y devuelve el foco a la anterior',
    !doc.getElementById('workspace-search-3') &&
    doc.activeElement === doc.getElementById('workspace-search-2'),
    String(doc.activeElement?.id))
  ok('cada fila se puede quitar con su boton cuando hay dos o mas',
    !doc.getElementById('workspace-rm').hidden &&
    !!doc.querySelector('#workspace-more button[data-wsrm="2"]') &&
    /Alfa Demo/.test(doc.getElementById('workspace-rm').getAttribute('aria-label') || ''),
    doc.getElementById('workspace-rm').outerHTML)
  // A quien se pregunta "A o B?": solo tiene sentido con dos o mas.
  const pq = doc.getElementById('project-question-wrap')
  ok('con dos proyectos aparece a quien preguntar, como grupo de botones',
    !pq.hidden && !!doc.querySelector('#chat-project-question[role="group"]') &&
    JSON.stringify([...doc.querySelectorAll('#chat-project-question button')].map((b) => b.dataset.value)) ===
    JSON.stringify(['auto', 'writer', 'owner']) && valorSeg(doc, 'chat-project-question') === 'auto',
    pq.outerHTML.slice(0, 300))
  ok('y no es un <select>', doc.querySelectorAll('select').length === 0)
  elegirSeg(doc, 'chat-project-question', 'owner')
  doc.getElementById('save-scope').click()
  await espera()
  const e = (storage.scope || {})['1@g.us'] || {}
  ok('guardar escribe la lista en orden y workspace derivado null',
    JSON.stringify(e.workspaces) === JSON.stringify(['alfa-demo', 'beta-demo']) &&
    'workspace' in e && e.workspace === null, JSON.stringify(e))
  ok('y a quien se pregunta', e.projectQuestion === 'owner', JSON.stringify(e))
  const fila = [...doc.querySelectorAll('#scope-wrap tbody tr')].find((f) => f.textContent.includes('Soporte Norte'))
  const celda = fila && fila.children[1]
  ok('la tabla dice el primero y cuantos mas: "A +N"', aLaVista(celda) === 'Alfa Demo +1',
    celda?.innerHTML)
  ok('con la lista entera en el title y para el lector de pantalla',
    celda?.querySelector('[title]')?.getAttribute('title') === 'Alfa Demo, Beta Demo' &&
    /Beta Demo/.test(celda?.querySelector('.sr-only')?.textContent || ''), celda?.innerHTML)
  ok('al guardar el formulario vuelve a una sola fila vacia',
    JSON.stringify(filasProyecto(doc)) === JSON.stringify(['']) && agregar.hidden && pq.hidden,
    JSON.stringify(filasProyecto(doc)))

  // Editar carga la lista entera y a quien se pregunta.
  fila.querySelector('[data-edit]').click()
  await espera()
  ok('Editar carga las dos filas en orden',
    JSON.stringify(filasProyecto(doc)) === JSON.stringify(['alfa-demo', 'beta-demo']) &&
    JSON.stringify(camposProyecto(doc).map((c) => c.value)) === JSON.stringify(['Alfa Demo', 'Beta Demo']),
    JSON.stringify(camposProyecto(doc).map((c) => c.value)))
  ok('y a quien se pregunta', valorSeg(doc, 'chat-project-question') === 'owner')
  // Quitar la primera: la segunda pasa a ser la primera.
  doc.getElementById('workspace-rm').click()
  ok('quitar la primera deja la otra arriba',
    JSON.stringify(filasProyecto(doc)) === JSON.stringify(['beta-demo']) &&
    doc.getElementById('workspace-search').value === 'Beta Demo' &&
    doc.getElementById('workspace-rm').hidden && pq.hidden,
    JSON.stringify(filasProyecto(doc)))
  doc.getElementById('save-scope').click()
  await espera()
  const e2 = storage.scope['1@g.us']
  ok('guardar con uno escribe la lista de uno y workspace ese id',
    JSON.stringify(e2.workspaces) === JSON.stringify(['beta-demo']) && e2.workspace === 'beta-demo' &&
    e2.projectQuestion === 'owner', JSON.stringify(e2))

  // Cancelar una edicion de dos vuelve al formulario nuevo.
  storage.scope['1@g.us'] = Object.assign({}, e2, { workspaces: ['alfa-demo', 'gama-demo'], workspace: null })
  window.dispatchEvent(new window.Event('focus'))
  await espera()
  doc.querySelector('#scope-wrap [data-edit]').click()
  await espera()
  ok('una lista guardada por otro lado tambien se carga',
    JSON.stringify(filasProyecto(doc)) === JSON.stringify(['alfa-demo', 'gama-demo']),
    JSON.stringify(filasProyecto(doc)))
  doc.getElementById('cancel-edit').click()
  await espera()
  ok('Cancelar deja una sola fila vacia, sin agregar ni a quien preguntar',
    JSON.stringify(filasProyecto(doc)) === JSON.stringify(['']) &&
    !doc.getElementById('workspace-search-2') && agregar.hidden && pq.hidden &&
    valorSeg(doc, 'chat-project-question') === 'auto', JSON.stringify(filasProyecto(doc)))
})

console.log('\nconfig.html — proyectos-por-chat (M6): las entradas de antes se leen como el CLI')
await seccion(async () => {
  const storage = {
    projects: PROYECTOS_TRES,
    scope: {
      // De antes: solo `workspace`. Es una lista de uno.
      '30@g.us': { chatName: 'Legado Uno', workspace: 'alfa-demo', mode: 'responder' },
      // Un panel viejo edito `workspace` y dejo una lista vieja al lado: gana `workspace`.
      '31@g.us': { chatName: 'Lista Vieja', workspace: 'beta-demo',
        workspaces: ['alfa-demo', 'gama-demo'], mode: 'observar' },
      // Solo la lista, sin `workspace`: vale la lista.
      '32@g.us': { chatName: 'Solo Lista', workspaces: ['gama-demo', 'alfa-demo'], mode: 'observar' },
      // Un id que el dueno quito del catalogo se conserva, marcado.
      '33@g.us': { chatName: 'Con Quitado', workspaces: ['alfa-demo', 'viejo-demo'],
        workspace: null, mode: 'observar' }
    }
  }
  const { doc } = await montar('config.html', storage, 'es-419')
  await espera()
  const fila = (txt) => [...doc.querySelectorAll('#scope-wrap tbody tr')].find((f) => f.textContent.includes(txt))
  ok('la de antes se ve con su proyecto, sin "+N"',
    /Alfa Demo/.test(fila('Legado Uno')?.children[1].textContent || '') &&
    !/\+\d/.test(fila('Legado Uno')?.children[1].textContent || ''), fila('Legado Uno')?.innerHTML)
  ok('la de la lista vieja se ve con su workspace', /Beta Demo/.test(fila('Lista Vieja')?.children[1].textContent || '') &&
    !/\+\d/.test(fila('Lista Vieja')?.children[1].textContent || ''), fila('Lista Vieja')?.innerHTML)
  ok('la de solo lista dice el primero y +1', aLaVista(fila('Solo Lista')?.children[1]) === 'Gama Demo +1',
    fila('Solo Lista')?.innerHTML)
  ok('la que tiene uno quitado lo cuenta y lo nombra marcado en el title',
    /ya no esta/.test(fila('Con Quitado')?.children[1].querySelector('[title]')?.getAttribute('title') || ''),
    fila('Con Quitado')?.innerHTML)

  fila('Legado Uno').querySelector('[data-edit]').click()
  await espera()
  ok('editar la de antes carga una sola fila con su proyecto',
    JSON.stringify(filasProyecto(doc)) === JSON.stringify(['alfa-demo']), JSON.stringify(filasProyecto(doc)))
  doc.getElementById('save-scope').click()
  await espera()
  ok('y guardarla escribe las dos claves: la lista de uno y su workspace',
    JSON.stringify(storage.scope['30@g.us'].workspaces) === JSON.stringify(['alfa-demo']) &&
    storage.scope['30@g.us'].workspace === 'alfa-demo' &&
    storage.scope['30@g.us'].projectQuestion === 'auto', JSON.stringify(storage.scope['30@g.us']))

  fila('Lista Vieja').querySelector('[data-edit]').click()
  await espera()
  ok('la lista vieja al lado de otro workspace no se carga: vale el workspace',
    JSON.stringify(filasProyecto(doc)) === JSON.stringify(['beta-demo']), JSON.stringify(filasProyecto(doc)))
  doc.getElementById('cancel-edit').click()

  fila('Solo Lista').querySelector('[data-edit]').click()
  await espera()
  ok('la de solo lista carga sus dos filas', JSON.stringify(filasProyecto(doc)) ===
    JSON.stringify(['gama-demo', 'alfa-demo']), JSON.stringify(filasProyecto(doc)))
  doc.getElementById('cancel-edit').click()

  fila('Con Quitado').querySelector('[data-edit]').click()
  await espera()
  ok('el quitado queda en su fila, marcado', JSON.stringify(filasProyecto(doc)) ===
    JSON.stringify(['alfa-demo', 'viejo-demo']) &&
    /viejo-demo.*ya no esta/.test(doc.getElementById('workspace-search-2')?.value || ''),
    doc.getElementById('workspace-search-2')?.value)
  doc.getElementById('save-scope').click()
  await espera()
  ok('y guardar sin tocarlo no lo borra',
    JSON.stringify(storage.scope['33@g.us'].workspaces) === JSON.stringify(['alfa-demo', 'viejo-demo']) &&
    storage.scope['33@g.us'].workspace === null, JSON.stringify(storage.scope['33@g.us']))
})

console.log('\nconfig.html — proyectos-por-chat (M6): cuantas horas espera la pregunta de proyecto')
await seccion(async () => {
  const { doc, storage } = await montar('config.html', {}, 'es-419')
  await espera()
  doc.getElementById('tab-aprobacion').click()
  await espera(); await espera()
  const campo = doc.getElementById('pq-hours')
  ok('el campo existe en Su aprobacion, entero y desde 1', !!campo && !!campo.closest('#view-aprobacion') &&
    campo.type === 'number' && campo.min === '1' && campo.step === '1', String(!!campo))
  ok('sin nada guardado muestra 24', campo?.value === '24', campo?.value)
  ok('con etiqueta y una pista que dice que pasa al vencer',
    (doc.querySelector('label[for="pq-hours"]')?.textContent || '').trim().length > 3 &&
    /usted/i.test(doc.getElementById('pq-hours-help')?.textContent || ''),
    doc.getElementById('pq-hours-help')?.textContent)
  escribir(doc, 'pq-hours', '36')
  doc.getElementById('save-pq-hours').click()
  await espera(); await espera()
  ok('guardar escribe la clave plana en texto', storage.projectQuestionHours === '36',
    String(storage.projectQuestionHours))
  for (const malo of ['0', '2.5', 'un dia', '']) {
    escribir(doc, 'pq-hours', malo)
    doc.getElementById('save-pq-hours').click()
    await espera(); await espera()
    ok(`"${malo}" no se guarda y lo dice`, storage.projectQuestionHours === '36' &&
      doc.getElementById('said-pq-hours').className.includes('bad'),
      `${storage.projectQuestionHours} ${doc.getElementById('said-pq-hours').textContent}`)
  }
  const guardada = await montar('config.html', { projectQuestionHours: '48' }, 'es-419')
  await espera()
  guardada.doc.getElementById('tab-aprobacion').click()
  await espera(); await espera()
  ok('al abrir la pestana pinta la guardada', guardada.doc.getElementById('pq-hours').value === '48',
    guardada.doc.getElementById('pq-hours').value)
})

console.log('\nconfig.html — proyectos-por-chat (M6): los textos nuevos en los tres idiomas')
await seccion(async () => {
  const { window } = await montar('config.html')
  const S = window.STRINGS
  const nuevas = ['workspaceLabel', 'workspaceHint', 'scopeHelp', 'workspaceAdd', 'workspaceRow',
    'workspaceRemove', 'workspaceMore', 'pqLabel', 'pqAuto', 'pqWriter', 'pqOwner', 'pqHelp',
    'pqHoursLegend', 'pqHoursLabel', 'pqHoursHelp', 'pqHoursRange', 'colProject']
  const faltan = nuevas.filter((k) => !S.es[k] || !S.en[k])
  ok('cada texto existe en espanol y en ingles', faltan.length === 0, `faltan = ${JSON.stringify(faltan)}`)
  const sinPt = nuevas.filter((k) => !S.pt[k] || S.pt[k] === S.en[k])
  ok('y en portugues propio, no heredado del ingles', sinPt.length === 0,
    `sin portugues = ${JSON.stringify(sinPt)}`)
  ok('la ayuda de las conversaciones habla de varios proyectos',
    /proyectos/i.test(S.es.scopeHelp) && /projects/i.test(S.en.scopeHelp) && /projetos/i.test(S.pt.scopeHelp),
    S.es.scopeHelp)
  ok('la pista dice que el agente elige y que pregunta',
    /elige/i.test(S.es.workspaceHint) && /pregunta/i.test(S.es.workspaceHint), S.es.workspaceHint)
})
for (const [idioma, re] of [['en-US', /Add another project/], ['pt-BR', /Adicionar outro projeto/]]) {
  await seccion(async () => {
    const { doc } = await montar('config.html', { projects: PROYECTOS_TRES,
      chats: [{ jid: '1@g.us', name: 'Soporte Norte', kind: 'grupo' }] }, idioma)
    await espera()
    elegirChat(doc, '1@g.us')
    elegirProyecto(doc, 'workspace', 'alfa-demo')
    ok(`${idioma}: agregar otro se dice en su idioma`, re.test(doc.getElementById('workspace-add').textContent),
      doc.getElementById('workspace-add').textContent)
  })
}

// ── El tablero: el proyecto del caso con su porque, quien lo eligio y la pregunta ──
// `board.project_routes[<case_id>]` = {why, by, candidates, missing, question} (M3/M5).
const RUTAS_PRUEBA = (extra = {}) => ({
  why: 'Pide cambios en la tienda en linea', by: 'agent',
  candidates: [{ id: 'beta-demo', name: 'Beta Demo', note: '' },
    { id: 'alfa-demo', name: 'Alfa Demo', note: 'Tienda en linea' }],
  missing: [], question: null, ...extra })
const casoProyecto = (extra = {}) => tarjeta({ case_id: 7, stage: 'clasificado', proposal: null,
  exceptions: [], project: { id: 'beta-demo', name: 'Beta Demo' },
  actions: ['atender', 'ignorar', 'reclasificar', 'cerrar', 'proyecto'], ...extra })

console.log('\nactivity.html — proyectos-por-chat (M6): el proyecto del caso, su porque y quien lo eligio')
await seccion(async () => {
  const w = conWorker({ ok: true, code: 'proyecto-cambiado' })
  const { doc, window } = await abrirConWorker([casoProyecto()], w, { projects: PROYECTOS_TRES,
    board: tablero([casoProyecto()], { project_routes: { 7: RUTAS_PRUEBA() } }) }, 'es-419')
  doc.querySelector('.card[data-case="7"]').click()
  const d = detalle(doc)
  const linea = d.querySelector('.det-proyecto')?.textContent || ''
  ok('el detalle dice el proyecto, que lo eligio el agente y por que',
    /Beta Demo/.test(linea) && /el agente/i.test(linea) && /Pide cambios en la tienda en linea/.test(linea), linea)
  botonDe(doc, 7, 'proyecto').click()
  const campo = doc.querySelector('#board-detail .card-form input[role="combobox"]')
  campo.focus()
  campo.dispatchEvent(new window.Event('click', { bubbles: true }))
  const lista = doc.querySelector('#board-detail [role="listbox"]')
  const valores = [...lista.querySelectorAll('[role="option"]')].map((o) => o.dataset.value)
  ok('la lista trae Sin proyecto, luego los del chat en su orden, luego el resto',
    JSON.stringify(valores) === JSON.stringify(['', 'beta-demo', 'alfa-demo', 'gama-demo']), JSON.stringify(valores))
  const grupos = [...lista.querySelectorAll('[role="group"]')]
  ok('en dos grupos con nombre',
    grupos.length === 2 && /conversacion/i.test(grupos[0].getAttribute('aria-label') || '') &&
    JSON.stringify([...grupos[0].querySelectorAll('[role="option"]')].map((o) => o.dataset.value)) ===
      JSON.stringify(['beta-demo', 'alfa-demo']) &&
    JSON.stringify([...grupos[1].querySelectorAll('[role="option"]')].map((o) => o.dataset.value)) ===
      JSON.stringify(['gama-demo']) && /otros/i.test(grupos[1].getAttribute('aria-label') || ''),
    lista.innerHTML.slice(0, 400))
  ok('cada grupo tiene su rotulo a la vista', grupos.every((g) => g.querySelector('.combo-group')?.textContent.trim()))
  // Las flechas recorren los grupos de corrido.
  campo.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  campo.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  campo.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  campo.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  campo.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  ok('flechas y Enter pasan de un grupo al otro', campo.value === 'Gama Demo', campo.value)
  campo.value = 'alf'
  campo.dispatchEvent(new window.Event('input', { bubbles: true }))
  const filtrados = [...doc.querySelectorAll('#board-detail [role="listbox"] [role="option"]')].map((o) => o.dataset.value)
  ok('escribir filtra en los dos grupos', JSON.stringify(filtrados) === JSON.stringify(['alfa-demo']),
    JSON.stringify(filtrados))
  doc.querySelector('#board-detail .card-form input[role="combobox"]')
    .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  doc.querySelector('#board-detail .card-form input[role="combobox"]')
    .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  doc.querySelector('#board-detail .card-form button[data-confirma]').click()
  await hastaPanel(() => w.pedidos.length === 1)
  ok('el pedido sigue siendo un solo proyecto', w.pedidos[0]?.proyecto === 'alfa-demo' &&
    Object.keys(w.pedidos[0] || {}).sort().join() === 'action,at,caseId,id,proyecto', JSON.stringify(w.pedidos))
})
await seccion(async () => {
  // Sin la ruta en el tablero (un wa-scope de antes) la lista es la de siempre, sin grupos.
  const { doc, window } = await abrirConWorker([casoProyecto()], conWorker(null), { projects: PROYECTOS_TRES })
  botonDe(doc, 7, 'proyecto').click()
  const campo = doc.querySelector('#board-detail .card-form input[role="combobox"]')
  campo.focus()
  campo.dispatchEvent(new window.Event('click', { bubbles: true }))
  ok('sin project_routes la lista no trae grupos',
    !doc.querySelector('#board-detail [role="listbox"] [role="group"]') &&
    [...doc.querySelectorAll('#board-detail [role="listbox"] [role="option"]')].map((o) => o.dataset.value).join() ===
      ',alfa-demo,beta-demo,gama-demo')
  ok('y el detalle no inventa quien lo eligio',
    !/eligi/i.test(detalle(doc).querySelector('.det-proyecto')?.textContent || ''),
    detalle(doc).querySelector('.det-proyecto')?.textContent)
})
await seccion(async () => {
  const caso = (id, ruta, extra = {}) => casoProyecto({ case_id: id, ...extra })
  const board = tablero([
    caso(11, null, { project: { id: 'alfa-demo', name: 'Alfa Demo' } }),
    caso(12, null, { project: { id: 'alfa-demo', name: 'Alfa Demo' } }),
    caso(13, null, { project: null }),
    caso(14, null, { project: null }),
    caso(15, null, { project: { id: 'beta-demo', name: 'Beta Demo' } })], {
    project_routes: {
      11: RUTAS_PRUEBA({ by: 'rule', why: "the message says 'facturacion'" }),
      12: RUTAS_PRUEBA({ by: 'chat', why: "the chat's project", candidates: [{ id: 'alfa-demo', name: 'Alfa Demo', note: '' }] }),
      13: RUTAS_PRUEBA({ by: null, why: 'the chat has 2 projects: the agent chooses by content' }),
      14: RUTAS_PRUEBA({ by: 'owner', why: 'set by the owner' }),
      15: RUTAS_PRUEBA({ by: 'owner', why: 'set by the owner' })
    } })
  const textoDe = async (idioma, id) => {
    const { doc } = await abrirTablero({ board, projects: PROYECTOS_TRES }, idioma)
    doc.querySelector(`.card[data-case="${id}"]`).click()
    return detalle(doc).querySelector('.det-proyecto')?.textContent || ''
  }
  const regla = await textoDe('es-419', 11)
  ok('por una regla: lo dice con la palabra del mensaje, en espanol',
    /regla/i.test(regla) && /facturacion/.test(regla) && !/the message says/.test(regla), regla)
  const chat = await textoDe('es-419', 12)
  ok('el de la conversacion lo dice asi', /de la conversacion/i.test(chat) && !/the chat/.test(chat), chat)
  const elige = await textoDe('es-419', 13)
  ok('sin proyecto con dos en el chat: el agente elige por el contenido',
    /Sin proyecto/.test(elige) && /2 proyectos/.test(elige) && /elige/.test(elige), elige)
  const dueno = await textoDe('es-419', 14)
  ok('el "Sin proyecto" del dueno dice que lo dejo usted', /Sin proyecto/.test(dueno) && /usted/i.test(dueno), dueno)
  const en = await textoDe('en', 15)
  ok('en ingles', /Beta Demo/.test(en) && /you/i.test(en), en)
  const pt = await textoDe('pt-BR', 11)
  ok('en portugues', /regra/i.test(pt) && /facturacion/.test(pt), pt)
})

console.log('\nactivity.html — proyectos-por-chat (M6): la pregunta "A o B?" abierta')
await seccion(async () => {
  const pregunta = (extra = {}) => ({ candidates: [{ id: 'alfa-demo', name: 'Alfa Demo' },
    { id: 'beta-demo', name: 'Beta Demo' }], to: 'writer', text: 'Es sobre la tienda o sobre el portal?',
    at: hace(30 * 60000), state: 'open', escalated: false, ...extra })
  const board = tablero([casoProyecto({ case_id: 21, project: null, stage: 'respondido',
      actions: ['cerrar', 'reabrir'] }),
    casoProyecto({ case_id: 22, project: null, stage: 'decision', actions: ['cerrar', 'proyecto'] }),
    casoProyecto({ case_id: 23, project: null }),
    casoProyecto({ case_id: 24, project: { id: 'alfa-demo', name: 'Alfa Demo' } })], {
    project_routes: {
      21: RUTAS_PRUEBA({ by: null, why: null, question: pregunta() }),
      22: RUTAS_PRUEBA({ by: null, why: null, question: pregunta({ to: 'owner', escalated: true }) }),
      23: RUTAS_PRUEBA({ by: null, why: null, question: pregunta({ state: 'answered' }) }),
      24: RUTAS_PRUEBA({ by: 'agent', question: pregunta({ state: 'closed' }) })
    } })
  const { doc } = await abrirTablero({ board, projects: PROYECTOS_TRES })
  const de = (id) => { doc.querySelector(`.card[data-case="${id}"]`).click(); return detalle(doc) }
  const abierta = de(21).querySelector('.det-pregunta')
  ok('una pregunta abierta se ve esperando respuesta, con los candidatos',
    !!abierta && /Esperando respuesta/i.test(abierta.textContent) &&
    /Alfa Demo o Beta Demo/.test(abierta.textContent), abierta?.textContent)
  ok('y dice a quien se le pregunto y lo que se pregunto',
    /quien escribio/i.test(abierta?.textContent || '') &&
    /Es sobre la tienda o sobre el portal\?/.test(abierta?.textContent || ''), abierta?.textContent)
  const suya = de(22).querySelector('.det-pregunta')
  ok('la que paso al dueno dice que es suya', !!suya && /usted/i.test(suya.textContent) &&
    /Alfa Demo o Beta Demo/.test(suya.textContent), suya?.textContent)
  const contestada = de(23).querySelector('.det-pregunta')
  ok('la contestada dice que el agente elige ahora', !!contestada && /respondi/i.test(contestada.textContent) &&
    !/Esperando/.test(contestada.textContent), contestada?.textContent)
  ok('la cerrada no se muestra', !de(24).querySelector('.det-pregunta'))
  const tarjetaAbierta = doc.querySelector('.card[data-case="21"]')
  ok('la tarjeta tambien avisa que espera la respuesta', /Esperando respuesta/i.test(tarjetaAbierta.textContent),
    tarjetaAbierta.textContent)
  const en = await abrirTablero({ board, projects: PROYECTOS_TRES }, 'en')
  en.doc.querySelector('.card[data-case="21"]').click()
  ok('en ingles', /Waiting for an answer/i.test(detalle(en.doc).querySelector('.det-pregunta')?.textContent || '') &&
    /Alfa Demo or Beta Demo/.test(detalle(en.doc).querySelector('.det-pregunta')?.textContent || ''),
    detalle(en.doc).querySelector('.det-pregunta')?.textContent)
  const pt = await abrirTablero({ board, projects: PROYECTOS_TRES }, 'pt-BR')
  pt.doc.querySelector('.card[data-case="21"]').click()
  ok('en portugues', /Aguardando resposta/i.test(detalle(pt.doc).querySelector('.det-pregunta')?.textContent || '') &&
    /Alfa Demo ou Beta Demo/.test(detalle(pt.doc).querySelector('.det-pregunta')?.textContent || ''),
    detalle(pt.doc).querySelector('.det-pregunta')?.textContent)
})

console.log('\nactivity.html — proyectos-por-chat (M6): los motivos y eventos nuevos en palabras')
await seccion(async () => {
  const caso = casoProyecto({ case_id: 31, events: [
    { de: 'decision', a: 'decision', actor: 'automatizacion', que: 'work_waits', args: ['no_project'], at: hace(9 * 60000) },
    { de: 'decision', a: 'decision', actor: 'automatizacion', que: 'reply_waits', args: ['project_question'], at: hace(8 * 60000) },
    { de: 'decision', a: 'decision', actor: 'automatizacion', que: 'work_waits', args: ['outside_project'], at: hace(7 * 60000) },
    { de: 'clasificado', a: 'clasificado', actor: 'agente', que: 'project', args: ['beta-demo', 'agent'], at: hace(6 * 60000) },
    { de: 'clasificado', a: 'respondido', actor: 'agente', que: 'project_question', args: ['writer'], at: hace(5 * 60000) },
    { de: 'respondido', a: 'recibido', actor: 'automatizacion', que: 'project_answer', at: hace(4 * 60000) },
    { de: 'recibido', a: 'decision', actor: 'automatizacion', que: 'project_question', args: ['owner'], at: hace(3 * 60000) }] })
  const filas = async (idioma) => {
    const { doc } = await abrirTablero({ board: tablero([caso]), projects: PROYECTOS_TRES }, idioma)
    doc.querySelector('.card[data-case="31"]').click()
    return [...detalle(doc).querySelectorAll('.det-hist li')].map((li) => li.textContent)
  }
  const es = (await filas('es-419')).join(' | ')
  ok('ES: sin proyecto, la pregunta suya y fuera de los proyectos del chat',
    /no tiene proyecto/.test(es) && /la pregunta de proyecto es suya/.test(es) &&
    /fuera de los proyectos del chat/.test(es), es)
  ok('ES: el agente eligio el proyecto, pregunto a quien escribio, la respuesta volvio y paso a usted',
    /proyecto elegido por el agente/.test(es) && /pregunta de proyecto: a quien escribio/.test(es) &&
    /respondio la pregunta de proyecto/.test(es) && /pregunta de proyecto: a usted/.test(es), es)
  const en = (await filas('en')).join(' | ')
  ok('EN', /it has no project/.test(en) && /the project question is yours/.test(en) &&
    /outside the chat's projects/.test(en) && /project chosen by the agent/.test(en) &&
    /project question: to the writer/.test(en) && /answered the project question/.test(en), en)
  const pt = (await filas('pt-BR')).join(' | ')
  ok('PT', /nao tem projeto/.test(pt) && /a pergunta de projeto e sua/.test(pt) &&
    /fora dos projetos do chat/.test(pt) && /projeto escolhido pelo agente/.test(pt) &&
    /pergunta de projeto: a quem escreveu/.test(pt) && /respondeu a pergunta de projeto/.test(pt), pt)
})

console.log('\nactivity.html — proyectos-por-chat (M6): el primer clic con la ruta del proyecto')
await seccion(async () => {
  // La ruta viaja dentro del tablero: el mismo tablero no reconstruye nada, y una ruta que
  // cambia con el puntero apretado se pinta al soltar, no debajo del dedo.
  const storage = { board: tablero([casoProyecto()], { project_routes: { 7: RUTAS_PRUEBA() } }),
    projects: PROYECTOS_TRES }
  const { window, doc } = await abrirTablero(storage)
  const card = doc.querySelector('.card[data-case="7"]')
  window.dispatchEvent(new window.Event('focus'))
  await espera()
  ok('el foco con la misma ruta no reconstruye la tarjeta', doc.querySelector('.card[data-case="7"]') === card)
  let durante = null
  await clicReal(window, card, async () => {
    storage.board = tablero([casoProyecto({ project: null })], { project_routes: { 7: RUTAS_PRUEBA({
      by: null, why: null, question: { candidates: [{ id: 'alfa-demo', name: 'Alfa Demo' },
        { id: 'beta-demo', name: 'Beta Demo' }], to: 'writer', text: 'A o B?', at: hace(60000),
      state: 'open', escalated: false } }) } })
    window.dispatchEvent(new window.Event('focus'))
    await espera()
    durante = doc.querySelector('.card[data-case="7"]') === card
  })
  ok('con el puntero apretado la ruta nueva no reconstruye la tarjeta', durante === true)
  ok('y el clic abre el detalle', !!doc.querySelector('#board-detail[data-case="7"]:not([hidden])'))
  await espera()
  ok('al soltar se pinta la pregunta que llego',
    !!detalle(doc).querySelector('.det-pregunta') && /Esperando respuesta/.test(detalle(doc).textContent),
    detalle(doc).textContent.slice(0, 300))
})

// ── Lo que encontro la verificacion: el proyecto quitado, la pregunta en respondido y el "¿" ──
console.log('\nactivity.html — proyectos-por-chat: el unico proyecto del chat, quitado del catalogo')
await seccion(async () => {
  const quitado = { why: 'project alfa-demo is no longer in the accepted list', candidates: [],
    missing: ['alfa-demo'], question: null }
  const board = tablero([casoProyecto({ case_id: 41, project: null }),
    casoProyecto({ case_id: 42, project: null })], {
    project_routes: { 41: { ...quitado, by: null }, 42: { ...quitado, by: 'chat' } } })
  const { doc } = await abrirTablero({ board, projects: PROYECTOS_TRES }, 'es-419')
  const de = (id) => {
    doc.querySelector(`.card[data-case="${id}"]`).click()
    return detalle(doc).querySelector('.det-proyecto')?.textContent || ''
  }
  const linea = de(41)
  ok('sin proyecto, como antes: no dice que es el de la conversacion',
    /Sin proyecto/.test(linea) && !/conversacion/i.test(linea), linea)
  const vieja = de(42)
  ok('aunque la ruta diga by chat, sin proyecto no dice que es el de la conversacion',
    /Sin proyecto/.test(vieja) && !/conversacion/i.test(vieja), vieja)
})

console.log('\nactivity.html — proyectos-por-chat: el dueno elige con la pregunta esperando al que escribio')
await seccion(async () => {
  const pregunta = { candidates: [{ id: 'alfa-demo', name: 'Alfa Demo' }, { id: 'beta-demo', name: 'Beta Demo' }],
    to: 'writer', text: 'Es sobre la tienda o sobre el portal?', at: hace(30 * 60000), state: 'open',
    escalated: false }
  const caso = casoProyecto({ case_id: 43, project: null, stage: 'respondido',
    actions: ['cerrar', 'reabrir', 'proyecto'] })
  const w = conWorker({ ok: true, code: 'proyecto-cambiado' })
  const { doc } = await abrirConWorker([caso], w, { projects: PROYECTOS_TRES,
    board: tablero([caso], { project_routes: { 43: RUTAS_PRUEBA({ by: null, why: null, question: pregunta }) } }) },
    'es-419')
  doc.querySelector('.card[data-case="43"]').click()
  const caja = detalle(doc).querySelector('.det-pregunta')?.textContent || ''
  ok('la pregunta al que escribio dice que usted tambien puede elegir aqui',
    /quien escribio/i.test(caja) && /elija el proyecto aqui/i.test(caja), caja)
  ok('y la tarjeta en respondido trae Cambiar proyecto', !!botonDe(doc, 43, 'proyecto'))
  const S = (await montar('activity.html')).window.STRINGS
  ok('en los tres idiomas', /choose the project here/i.test(S.en.pqToWriter) &&
    /escolha o projeto aqui/i.test(S.pt.pqToWriter), `${S.en.pqToWriter} | ${S.pt.pqToWriter}`)
})

console.log('\nconfig.html — proyectos-por-chat: la ayuda del plazo escribe la pregunta con "¿"')
await seccion(async () => {
  const { window } = await montar('config.html')
  const S = window.STRINGS
  ok('ES abre la pregunta con ¿, como el tablero', S.es.pqHoursHelp.includes('"¿A o B?"'), S.es.pqHoursHelp)
  // Con Automatico, en un grupo la pregunta va al dueno aunque escriba el dueno: lo leen
  // tambien los clientes. La ayuda lo dice en los tres idiomas.
  ok('Automatico: la ayuda dice que en un grupo la pregunta va a usted',
    /grupo/i.test(S.es.pqHelp) && /su propia conversacion/i.test(S.es.pqHelp) &&
    /group/i.test(S.en.pqHelp) && /your own chat/i.test(S.en.pqHelp) &&
    /grupo/i.test(S.pt.pqHelp) && /sua propria conversa/i.test(S.pt.pqHelp),
    `${S.es.pqHelp} | ${S.en.pqHelp} | ${S.pt.pqHelp}`)
})


// ───────── roles-por-numero (M11): las personas de una conversacion y su rol ─────────
// El rol sale del numero que el dueno marca aqui, por conversacion: `scope[jid].members`
// ([{id, name, role}], sin los clientes). En un grupo la lista viene de `groupMembers`
// (la deja wa-scope sync); los numeros de confianza (`owners`) son Super admin en todas
// partes y aqui solo se muestran (odd/tasks/proyectos-por-chat.md, "Part B data contract").
const DIRECTO_ROL = '573000000001@s.whatsapp.net'
const GRUPO_ROL = '120363000000000001@g.us'
const DUENO_ROL = { id: '100000000000001@lid', name: 'Ana Restrepo' }
const MIEMBROS_ROL = [
  { id: '100000000000001@lid', name: 'Ana Restrepo', phone: '+573000000011' },
  { id: '111122223333@lid', name: 'Beto Operador', phone: '+573000000012' },
  { id: '573000000013@s.whatsapp.net', name: '', phone: '+573000000013' },
  { id: '111122225555@lid', name: 'Diana Cliente', phone: null }
]
const personas = (doc) => [...doc.querySelectorAll('#people-list .persona')]
const personasVisibles = (doc) => personas(doc).filter((n) => !n.hidden)
const persona = (doc, id) => doc.querySelector(`#people-list .persona[data-id="${id}"]`)
const rolDe = (doc, id) =>
  persona(doc, id)?.querySelector('.seg button[aria-pressed="true"]')?.dataset.value ?? null
function elegirRol (doc, id, rol) {
  const b = persona(doc, id)?.querySelector(`.seg button[data-value="${rol}"]`)
  if (!b) throw new Error(`${id} no ofrece ${rol}`)
  b.click()
}
const filaDeChat = (doc, txt) =>
  [...doc.querySelectorAll('#scope-wrap tbody tr')].find((f) => f.textContent.includes(txt))

console.log('\nconfig.html — roles-por-numero (M11): la persona de un chat directo')
await seccion(async () => {
  const storage = { owners: [DUENO_ROL],
    chats: [{ jid: DIRECTO_ROL, name: 'Camila Restrepo', kind: 'directo', phone: '+573000000001' }] }
  const { doc } = await montar('config.html', storage, 'es-419')
  await espera()
  const caja = doc.getElementById('people-wrap')
  ok('sin conversacion elegida no hay tarjeta de personas', !!caja && caja.hidden, String(caja?.outerHTML).slice(0, 120))
  elegirChat(doc, DIRECTO_ROL)
  ok('al elegir un directo aparece, con un titulo', !caja.hidden &&
    (doc.getElementById('people-legend')?.textContent || '').trim().length > 3)
  ok('una sola persona: la del chat', personas(doc).length === 1 && !!persona(doc, DIRECTO_ROL),
    JSON.stringify(personas(doc).map((n) => n.dataset.id)))
  ok('con su nombre y su telefono', /Camila Restrepo/.test(persona(doc, DIRECTO_ROL)?.textContent || '') &&
    /\+57 300/.test(persona(doc, DIRECTO_ROL)?.textContent || ''), persona(doc, DIRECTO_ROL)?.textContent)
  const grupo = persona(doc, DIRECTO_ROL)?.querySelector('.seg')
  ok('un grupo de botones Cliente / Operador / Super admin, con nombre accesible',
    grupo?.getAttribute('role') === 'group' &&
    /Camila Restrepo/.test(grupo?.getAttribute('aria-label') || '') &&
    JSON.stringify([...grupo.querySelectorAll('button')].map((b) => b.dataset.value)) ===
      JSON.stringify(['client', 'operator', 'admin']) &&
    JSON.stringify([...grupo.querySelectorAll('button')].map((b) => b.textContent.trim())) ===
      JSON.stringify(['Cliente', 'Operador', 'Super admin']), grupo?.outerHTML.slice(0, 300))
  ok('botones nativos con aria-pressed, Cliente por defecto',
    [...grupo.querySelectorAll('button')].every((b) => b.tagName === 'BUTTON' && b.type === 'button' &&
      b.hasAttribute('aria-pressed')) && rolDe(doc, DIRECTO_ROL) === 'client')
  ok('un directo no lleva buscador', doc.getElementById('people-search-wrap')?.hidden === true)
  ok('la ayuda del directo dice que no pasa por las reglas de cliente',
    /reglas de cliente/i.test(doc.getElementById('people-help')?.textContent || ''),
    doc.getElementById('people-help')?.textContent)
  ok('y en todo el formulario no hay un <select>', doc.querySelectorAll('select').length === 0)
  elegirRol(doc, DIRECTO_ROL, 'operator')
  ok('apretar Operador lo deja apretado', rolDe(doc, DIRECTO_ROL) === 'operator')
  doc.getElementById('save-scope').click()
  await espera()
  const e = (storage.scope || {})[DIRECTO_ROL] || {}
  ok('guardar escribe members con el operador', JSON.stringify(e.members) ===
    JSON.stringify([{ id: DIRECTO_ROL, name: 'Camila Restrepo', role: 'operator' }]), JSON.stringify(e))
  ok('al guardar el formulario vuelve a nuevo, sin tarjeta de personas', caja.hidden)

  filaDeChat(doc, 'Camila Restrepo').querySelector('[data-edit]').click()
  await espera()
  ok('Editar carga el rol guardado', !caja.hidden && rolDe(doc, DIRECTO_ROL) === 'operator')
  elegirRol(doc, DIRECTO_ROL, 'client')
  doc.getElementById('save-scope').click()
  await espera()
  ok('volver a Cliente guarda la lista vacia (Cliente nunca se guarda)',
    JSON.stringify(storage.scope[DIRECTO_ROL].members) === '[]', JSON.stringify(storage.scope[DIRECTO_ROL]))

  filaDeChat(doc, 'Camila Restrepo').querySelector('[data-edit]').click()
  await espera()
  elegirRol(doc, DIRECTO_ROL, 'admin')
  doc.getElementById('cancel-edit').click()
  await espera()
  ok('Cancelar descarta lo apretado y esconde la tarjeta', caja.hidden &&
    JSON.stringify(storage.scope[DIRECTO_ROL].members) === '[]')
  filaDeChat(doc, 'Camila Restrepo').querySelector('[data-edit]').click()
  await espera()
  ok('y al volver a editar sigue en Cliente', rolDe(doc, DIRECTO_ROL) === 'client')
  doc.getElementById('cancel-edit').click()

  // Elegir en el formulario nuevo una conversacion que ya tiene roles: se cargan, para que
  // guardar encima no los borre callado.
  storage.scope[DIRECTO_ROL].members = [{ id: DIRECTO_ROL, name: 'Camila Restrepo', role: 'admin' }]
  doc.defaultView.dispatchEvent(new doc.defaultView.Event('focus'))
  await espera()
  elegirChat(doc, DIRECTO_ROL)
  ok('el formulario nuevo carga los roles de una conversacion ya guardada',
    rolDe(doc, DIRECTO_ROL) === 'admin', String(rolDe(doc, DIRECTO_ROL)))
})

console.log('\nconfig.html — roles-por-numero (M11): el directo de un numero de confianza')
await seccion(async () => {
  const storage = { owners: [DUENO_ROL],
    chats: [{ jid: DUENO_ROL.id, name: 'Ana Restrepo', kind: 'directo', phone: '+573000000011' }] }
  const { doc } = await montar('config.html', storage, 'es-419')
  await espera()
  elegirChat(doc, DUENO_ROL.id)
  const fila = persona(doc, DUENO_ROL.id)
  ok('se ve como Super admin y sin botones', !!fila && !fila.querySelector('.seg button') &&
    /Super admin/.test(fila.textContent), fila?.outerHTML)
  const ir = fila?.querySelector('button[data-ir="aprobacion"]')
  ok('con un boton que lleva a Su aprobacion', !!ir && /Su aprobacion/.test(ir.textContent), fila?.innerHTML)
  ir.click()
  await espera()
  ok('y el boton abre esa pestana', doc.getElementById('view-aprobacion').hidden === false &&
    doc.getElementById('tab-aprobacion').getAttribute('aria-selected') === 'true')
  doc.getElementById('tab-chats').click()
  doc.getElementById('save-scope').click()
  await espera()
  ok('guardar no escribe al dueno en members', JSON.stringify(storage.scope[DUENO_ROL.id].members) === '[]',
    JSON.stringify(storage.scope[DUENO_ROL.id]))
})

console.log('\nconfig.html — roles-por-numero (M11): los participantes de un grupo')
await seccion(async () => {
  const storage = { owners: [DUENO_ROL],
    chats: [{ jid: GRUPO_ROL, name: 'Soporte Norte', kind: 'grupo' }],
    groupMembers: { [GRUPO_ROL]: MIEMBROS_ROL },
    scope: { [GRUPO_ROL]: { chatName: 'Soporte Norte', mode: 'responder',
      members: [{ id: '111122223333@lid', name: 'Beto Operador', role: 'operator' },
        // Alguien con rol que ya no esta en la lista del grupo: se ve y no se pierde.
        { id: '111122229999@lid', name: 'Ex Miembro', role: 'admin' }] } } }
  const { doc } = await montar('config.html', storage, 'es-419')
  await espera()
  filaDeChat(doc, 'Soporte Norte').querySelector('[data-edit]').click()
  await espera()
  ok('una fila por participante, y la de quien ya no esta al final',
    JSON.stringify(personas(doc).map((n) => n.dataset.id)) === JSON.stringify(
      MIEMBROS_ROL.map((m) => m.id).concat(['111122229999@lid'])),
    JSON.stringify(personas(doc).map((n) => n.dataset.id)))
  const dueno = persona(doc, DUENO_ROL.id)
  ok('el numero de confianza: Super admin, solo lectura, con el boton a Su aprobacion',
    !!dueno && !dueno.querySelector('.seg button') && /Super admin/.test(dueno.textContent) &&
    !!dueno.querySelector('button[data-ir="aprobacion"]'), dueno?.outerHTML)
  ok('el operador guardado sale apretado', rolDe(doc, '111122223333@lid') === 'operator')
  ok('los demas, en Cliente', rolDe(doc, '111122225555@lid') === 'client' &&
    rolDe(doc, '573000000013@s.whatsapp.net') === 'client')
  ok('cada fila con su nombre y su telefono', /Beto Operador/.test(persona(doc, '111122223333@lid').textContent) &&
    /\+57 300 000 0012/.test(persona(doc, '111122223333@lid').textContent),
    persona(doc, '111122223333@lid').textContent)
  ok('sin nombre, se nombra por su telefono', /\+57 300 000 0013/.test(
    persona(doc, '573000000013@s.whatsapp.net').querySelector('.persona-nombre')?.textContent || ''),
    persona(doc, '573000000013@s.whatsapp.net').innerHTML)
  ok('quien ya no esta en el grupo lo dice y conserva su rol',
    /ya no esta/.test(persona(doc, '111122229999@lid')?.textContent || '') &&
    rolDe(doc, '111122229999@lid') === 'admin', persona(doc, '111122229999@lid')?.textContent)
  ok('la ayuda del grupo dice que los clientes leen todo',
    /clientes leen/i.test(doc.getElementById('people-help')?.textContent || ''),
    doc.getElementById('people-help')?.textContent)

  // El buscador: por nombre, por telefono, y lo que no coincide lo dice.
  const buscador = doc.getElementById('people-search')
  ok('un grupo lleva buscador con etiqueta', doc.getElementById('people-search-wrap')?.hidden === false &&
    !!buscador && (doc.querySelector('label[for="people-search"]')?.textContent || '').trim().length > 3)
  escribir(doc, 'people-search', 'beto')
  ok('buscar "beto" deja solo a Beto', JSON.stringify(personasVisibles(doc).map((n) => n.dataset.id)) ===
    JSON.stringify(['111122223333@lid']), JSON.stringify(personasVisibles(doc).map((n) => n.dataset.id)))
  ok('y dice cuantos de cuantos', /1 de 5/.test(doc.getElementById('people-count')?.textContent || ''),
    doc.getElementById('people-count')?.textContent)
  escribir(doc, 'people-search', '0013')
  ok('buscar por telefono', JSON.stringify(personasVisibles(doc).map((n) => n.dataset.id)) ===
    JSON.stringify(['573000000013@s.whatsapp.net']), JSON.stringify(personasVisibles(doc).map((n) => n.dataset.id)))
  escribir(doc, 'people-search', 'zzzz')
  ok('sin coincidencias lo dice', personasVisibles(doc).length === 0 &&
    !doc.getElementById('people-empty').hidden && /coincide/.test(doc.getElementById('people-empty').textContent),
    doc.getElementById('people-empty')?.textContent)
  escribir(doc, 'people-search', '')
  ok('vacio vuelve a mostrarlos todos', personasVisibles(doc).length === 5)

  elegirRol(doc, '111122225555@lid', 'admin')
  // Filtrar no cambia lo elegido: lo escondido tambien se guarda.
  escribir(doc, 'people-search', 'diana')
  doc.getElementById('save-scope').click()
  await espera()
  ok('guardar escribe los roles en el orden de la lista, sin el dueno ni los clientes',
    JSON.stringify(storage.scope[GRUPO_ROL].members) === JSON.stringify([
      { id: '111122223333@lid', name: 'Beto Operador', role: 'operator' },
      { id: '111122225555@lid', name: 'Diana Cliente', role: 'admin' },
      { id: '111122229999@lid', name: 'Ex Miembro', role: 'admin' }]),
    JSON.stringify(storage.scope[GRUPO_ROL].members))
  ok('y el resto de la entrada sigue', storage.scope[GRUPO_ROL].mode === 'responder')
  filaDeChat(doc, 'Soporte Norte').querySelector('[data-edit]').click()
  await espera()
  ok('editar de nuevo limpia el buscador', doc.getElementById('people-search').value === '' &&
    personasVisibles(doc).length === 5)
})

console.log('\nconfig.html — roles-por-numero (M11): un grupo sin lista de participantes')
for (const [nombre, gm] of [['sin la clave', undefined], ['con la lista vacia', []]]) {
  await seccion(async () => {
    const storage = { owners: [DUENO_ROL], chats: [{ jid: GRUPO_ROL, name: 'Soporte Norte', kind: 'grupo' }] }
    if (gm) storage.groupMembers = { [GRUPO_ROL]: gm }
    const { doc } = await montar('config.html', storage, 'es-419')
    await espera()
    elegirChat(doc, GRUPO_ROL)
    const vacio = doc.getElementById('people-empty')
    ok(`${nombre}: lo dice claro, sin filas ni buscador`, personas(doc).length === 0 &&
      !vacio.hidden && /sincroniza/i.test(vacio.textContent) &&
      doc.getElementById('people-search-wrap').hidden, vacio?.textContent)
    doc.getElementById('save-scope').click()
    await espera()
    ok(`${nombre}: guardar escribe members vacio`, JSON.stringify(storage.scope[GRUPO_ROL].members) === '[]',
      JSON.stringify(storage.scope[GRUPO_ROL]))
  })
}

console.log('\nconfig.html — roles-por-numero (M11): la lista del grupo llega despues de abrirlo')
await seccion(async () => {
  const storage = { owners: [DUENO_ROL], chats: [{ jid: GRUPO_ROL, name: 'Soporte Norte', kind: 'grupo' }],
    scope: { [GRUPO_ROL]: { chatName: 'Soporte Norte', mode: 'observar' } } }
  const { doc, window } = await montar('config.html', storage, 'es-419')
  await espera()
  filaDeChat(doc, 'Soporte Norte').querySelector('[data-edit]').click()
  await espera()
  ok('una entrada de antes, sin members, abre sin roles', personas(doc).length === 0)
  storage.groupMembers = { [GRUPO_ROL]: MIEMBROS_ROL }
  window.dispatchEvent(new window.Event('focus'))
  await espera(); await espera()
  ok('al llegar la lista se pinta sin perder la edicion', personas(doc).length === 4 &&
    doc.getElementById('cancel-edit').hidden === false, String(personas(doc).length))
})

console.log('\nconfig.html — roles-por-numero (M11): los textos en los tres idiomas')
await seccion(async () => {
  const { window } = await montar('config.html')
  const S = window.STRINGS
  const nuevas = ['peopleLegend', 'peopleHelp', 'peopleHelpDirect', 'peopleHelpGroup', 'peopleSearchLabel',
    'peopleSearchPh', 'peopleCount', 'peopleNoMatch', 'peopleGroupEmpty', 'peopleRoleOf', 'peopleGone',
    'peopleOwner', 'peopleOwnLine', 'peopleOwnersGo', 'roleClient', 'roleOperator', 'roleAdmin']
  const faltan = nuevas.filter((k) => !S.es[k] || !S.en[k])
  ok('cada texto existe en espanol y en ingles', faltan.length === 0, `faltan = ${JSON.stringify(faltan)}`)
  const sinPt = nuevas.filter((k) => !S.pt[k] || (S.pt[k] === S.en[k] && k !== 'roleAdmin'))
  ok('y en portugues propio, no heredado del ingles', sinPt.length === 0, `sin portugues = ${JSON.stringify(sinPt)}`)
  ok('Super admin se llama igual en los tres', S.es.roleAdmin === 'Super admin' &&
    S.en.roleAdmin === 'Super admin' && S.pt.roleAdmin === 'Super admin' && 'roleAdmin' in S.pt)
  ok('la ayuda dice que el rol sale del numero, nunca del mensaje',
    /numero/i.test(S.es.peopleHelp) && /mensaje/i.test(S.es.peopleHelp) &&
    /number/i.test(S.en.peopleHelp) && /message/i.test(S.en.peopleHelp) &&
    /numero/i.test(S.pt.peopleHelp) && /mensagem/i.test(S.pt.peopleHelp), S.es.peopleHelp)
  ok('pqHelp dice que en el directo de un Operador se le pregunta a el',
    /Operador/.test(S.es.pqHelp) && /Operator/.test(S.en.pqHelp) && /Operador/.test(S.pt.pqHelp), S.es.pqHelp)
})
for (const [idioma, re] of [['en-US', /Operator/], ['pt-BR', /Operador/]]) {
  await seccion(async () => {
    const { doc } = await montar('config.html', { owners: [DUENO_ROL],
      chats: [{ jid: DIRECTO_ROL, name: 'Camila Restrepo', kind: 'directo' }] }, idioma)
    await espera()
    elegirChat(doc, DIRECTO_ROL)
    ok(`${idioma}: los roles se dicen en su idioma`, re.test(persona(doc, DIRECTO_ROL)?.textContent || '') &&
      doc.getElementById('people-legend').textContent !== 'peopleLegend',
      persona(doc, DIRECTO_ROL)?.textContent)
  })
}

// ───────── roles-por-numero: lo que encontro la verificacion ─────────
// El dueno global es su id EXACTO, como en el motor (`es_dueno`): un participante que solo
// comparte su telefono por el par LID-telefono no es el dueno, y la tarjeta no lo muestra
// fijo como Super admin. El contador del buscador es una region viva que existe antes de
// la primera busqueda. Y un grupo ya guardado sin lista no pide guardarlo otra vez.
console.log('\nconfig.html — roles-por-numero: lo que encontro la verificacion')
await seccion(async () => {
  const LID_DEL_DUENO = '100000000000002@lid'
  const storage = { owners: [{ id: '573000000011@s.whatsapp.net', name: 'Ana Restrepo' }],
    chats: [{ jid: GRUPO_ROL, name: 'Soporte Norte', kind: 'grupo' }],
    groupMembers: { [GRUPO_ROL]: [
      { id: LID_DEL_DUENO, name: 'Ana Restrepo', phone: '+573000000011' },
      { id: '111122223333@lid', name: 'Beto Operador', phone: '+573000000012' }] } }
  const { doc, window } = await montar('config.html', storage, 'es-419')
  await espera()
  elegirChat(doc, GRUPO_ROL)
  await espera()
  const fila = persona(doc, LID_DEL_DUENO)
  ok('el LID del dueno guardado por telefono no sale fijo: el motor no lo une por el par',
    !!fila && !!fila.querySelector('.seg button') && !fila.querySelector('.rol-fijo') &&
    rolDe(doc, LID_DEL_DUENO) === 'client', fila?.outerHTML.slice(0, 300))
  const cuenta = doc.getElementById('people-count')
  ok('el contador del buscador es una region viva ya pintada antes de buscar',
    cuenta?.getAttribute('aria-live') === 'polite' && cuenta.textContent === '' &&
    window.getComputedStyle(cuenta).display !== 'none', window.getComputedStyle(cuenta).display)
  escribir(doc, 'people-search', 'beto')
  ok('y al buscar dice cuantos de cuantos', /1 de 2/.test(cuenta.textContent), cuenta.textContent)
})

for (const [idioma, guarde] of [['es-419', /gu[aá]rdelo/i], ['en-US', /save it/i],
  ['pt-BR', /salve-o/i]]) {
  await seccion(async () => {
    const storage = { owners: [DUENO_ROL], chats: [{ jid: GRUPO_ROL, name: 'Soporte Norte', kind: 'grupo' }],
      groupMembers: { [GRUPO_ROL]: [] },
      scope: { [GRUPO_ROL]: { chatName: 'Soporte Norte', mode: 'observar', members: [] } } }
    const { doc, window } = await montar('config.html', storage, idioma)
    await espera()
    const S = window.STRINGS
    const lengua = idioma.slice(0, 2)
    filaDeChat(doc, 'Soporte Norte').querySelector('[data-edit]').click()
    await espera()
    const vacio = doc.getElementById('people-empty')
    ok(`${idioma}: editando un grupo ya guardado sin lista, no pide guardarlo otra vez`,
      !vacio.hidden && vacio.textContent === S[lengua].peopleGroupPending &&
      !guarde.test(vacio.textContent), vacio.textContent)
    doc.getElementById('cancel-edit').click()
    await espera()
    elegirChat(doc, GRUPO_ROL)
    ok(`${idioma}: elegirlo en el formulario nuevo, ya guardado, tampoco`,
      !vacio.hidden && vacio.textContent === S[lengua].peopleGroupPending, vacio.textContent)
  })
}
await seccion(async () => {
  const { window } = await montar('config.html')
  const S = window.STRINGS
  ok('el texto del grupo guardado existe en los tres idiomas, el portugues propio',
    !!S.es.peopleGroupPending && !!S.en.peopleGroupPending && !!S.pt.peopleGroupPending &&
    S.pt.peopleGroupPending !== S.en.peopleGroupPending,
    JSON.stringify([S.es.peopleGroupPending, S.pt.peopleGroupPending]))
})

// ── avisos-orca: los avisos de Orca por WhatsApp (odd/tasks/avisos-orca.md) ──
// Una tarjeta en la pestana de aprobacion: un interruptor por tipo (apagados de fabrica), las
// horas de silencio, el tope por hora y la espera del "termino". Todo en UNA clave,
// `orcaNotices`, en texto como el resto. Sin numero de aprobacion lo dice al lado.
console.log('\nconfig.html — avisos-orca: los avisos de Orca')
{
  const ANA = '100000000000001@lid'
  const { doc, storage } = await montar('config.html', {}, 'es-419')
  await espera()
  doc.getElementById('tab-aprobacion').click()
  await espera(); await espera()
  const tarjeta = doc.getElementById('orca-notices-card')
  ok('la tarjeta esta en la pestana de aprobacion', !!tarjeta && !!tarjeta.closest('#view-aprobacion'))
  const SW = ['orca-waiting', 'orca-finished', 'orca-automation']
  ok('un interruptor por tipo, apagados de fabrica',
    SW.every((id) => doc.getElementById(id)?.getAttribute('role') === 'switch' &&
      doc.getElementById(id)?.getAttribute('aria-checked') === 'false'),
    SW.map((id) => doc.getElementById(id)?.getAttribute('aria-checked')).join(','))
  ok('cada interruptor tiene su etiqueta', SW.every((id) => {
    const l = doc.getElementById(doc.getElementById(id)?.getAttribute('aria-labelledby') || 'x')
    return l && l.textContent.trim().length > 5
  }))
  const ini = doc.getElementById('orca-quiet-start')
  const fin = doc.getElementById('orca-quiet-end')
  ok('las horas de silencio son dos horas, vacias de fabrica',
    ini?.type === 'time' && fin?.type === 'time' && ini.value === '' && fin.value === '')
  const tope = doc.getElementById('orca-cap')
  ok('el tope es un entero de 1 a 60, 6 de fabrica', tope?.type === 'number' && tope.min === '1' &&
    tope.max === '60' && tope.value === '6', tope?.value)
  const demora = doc.getElementById('orca-delay')
  ok('la espera del termino es de 10 a 600 segundos, 25 de fabrica', demora?.type === 'number' &&
    demora.min === '10' && demora.max === '600' && demora.value === '25', demora?.value)
  ok('con "termino" apagado la espera no se muestra', doc.getElementById('orca-delay-row').hidden)
  ok('sin numero de aprobacion lo dice junto a los interruptores',
    !doc.getElementById('orca-no-number').hidden &&
    /numero de aprobacion/i.test(doc.getElementById('orca-no-number').textContent),
    doc.getElementById('orca-no-number').textContent)
  ok('la pista dice que nunca viaja lo que el agente escribio',
    /nunca/i.test(doc.getElementById('orca-intro').textContent) &&
    /terminal/i.test(doc.getElementById('orca-intro').textContent),
    doc.getElementById('orca-intro').textContent)
  doc.getElementById('orca-waiting').click()
  doc.getElementById('orca-finished').click()
  ok('apretar un interruptor lo enciende', doc.getElementById('orca-waiting')
    .getAttribute('aria-checked') === 'true')
  ok('con "termino" encendido aparece la espera', !doc.getElementById('orca-delay-row').hidden)
  ini.value = '22:00'; fin.value = '07:00'
  escribir(doc, 'orca-cap', '10')
  escribir(doc, 'orca-delay', '40')
  doc.getElementById('save-orca').click()
  await espera(); await espera()
  ok('guardar escribe la clave entera, en texto', JSON.stringify(storage.orcaNotices) ===
    JSON.stringify({ waiting: 'on', finished: 'on', automationFailed: 'off', quietStart: '22:00',
      quietEnd: '07:00', hourlyCap: '10', finishedDelaySeconds: '40' }),
  JSON.stringify(storage.orcaNotices))
  ok('y dice guardado', /✓/.test(doc.getElementById('said-orca').textContent))
  const guardado = JSON.stringify(storage.orcaNotices)
  for (const [nombre, preparar, re] of [
    ['tope 0', () => escribir(doc, 'orca-cap', '0'), /60/],
    ['tope 61', () => escribir(doc, 'orca-cap', '61'), /60/],
    ['tope con letras', () => escribir(doc, 'orca-cap', 'seis'), /60/],
    ['espera 5', () => { escribir(doc, 'orca-cap', '10'); escribir(doc, 'orca-delay', '5') }, /600/],
    ['una sola hora', () => { escribir(doc, 'orca-delay', '40'); fin.value = '' }, /hora/i],
    ['la misma hora', () => { fin.value = '22:00' }, /hora/i]]) {
    preparar()
    doc.getElementById('save-orca').click()
    await espera(); await espera()
    ok(`${nombre}: no se guarda y lo dice`, JSON.stringify(storage.orcaNotices) === guardado &&
      doc.getElementById('said-orca').className.includes('bad') &&
      re.test(doc.getElementById('said-orca').textContent),
    `${JSON.stringify(storage.orcaNotices)} ${doc.getElementById('said-orca').textContent}`)
  }
  ini.value = ''; fin.value = ''
  doc.getElementById('save-orca').click()
  await espera(); await espera()
  ok('sin las dos horas se guarda sin silencio', storage.orcaNotices?.quietStart === '' &&
    storage.orcaNotices?.quietEnd === '', JSON.stringify(storage.orcaNotices))
}
{
  const ANA = '100000000000001@lid'
  const { doc } = await montar('config.html', {
    owners: [{ id: ANA, name: 'Ana Duena' }], approvalNumber: ANA,
    orcaNotices: { waiting: 'on', finished: 'off', automationFailed: 'on', quietStart: '23:30',
      quietEnd: '06:15', hourlyCap: '12', finishedDelaySeconds: '90' }
  }, 'es-419')
  await espera()
  doc.getElementById('tab-aprobacion').click()
  await espera(); await espera()
  ok('al abrir la pestana pinta lo guardado',
    doc.getElementById('orca-waiting').getAttribute('aria-checked') === 'true' &&
    doc.getElementById('orca-finished').getAttribute('aria-checked') === 'false' &&
    doc.getElementById('orca-automation').getAttribute('aria-checked') === 'true' &&
    doc.getElementById('orca-quiet-start').value === '23:30' &&
    doc.getElementById('orca-quiet-end').value === '06:15' &&
    doc.getElementById('orca-cap').value === '12' && doc.getElementById('orca-delay').value === '90')
  ok('con el numero de aprobacion elegido no hay aviso', doc.getElementById('orca-no-number').hidden)
}
{
  const { doc } = await montar('config.html', {}, 'es-419',
    (d) => d.action === 'storage.set' && d.params.key === 'orcaNotices' ? { ok: false } : undefined)
  await espera()
  doc.getElementById('tab-aprobacion').click()
  await espera()
  doc.getElementById('orca-waiting').click()
  doc.getElementById('save-orca').click()
  await espera(); await espera()
  ok('si el host no guarda los avisos, no dice guardado',
    doc.getElementById('said-orca').className.includes('bad'), doc.getElementById('said-orca').textContent)
}
for (const [idioma, nombre, leyenda, nunca, bloqueado] of [['es-419', 'ES', /Orca/, /nunca/i, /bloque/i],
  ['en', 'EN', /Orca/, /never/i, /blocked/i], ['pt-BR', 'PT', /Orca/, /nunca/i, /bloquead/i]]) {
  const { doc, window } = await montar('config.html', {}, idioma)
  await espera()
  const t = (id) => (doc.getElementById(id)?.textContent || '').trim()
  // Decision del dueno (2026-10-05): el mismo interruptor avisa tambien de un agente bloqueado.
  ok(`${nombre}: el interruptor de la espera dice que tambien avisa si un agente se bloquea`,
    bloqueado.test(t('orca-waiting-label')), t('orca-waiting-label'))
  // Visto en la captura a 390: la etiqueta larga bajaba a otra linea, lejos de su interruptor.
  // En esta tarjeta la etiqueta se parte en su sitio, al lado del interruptor.
  const fila = doc.getElementById('orca-waiting').closest('.switch-row')
  ok(`${nombre}: la etiqueta larga no se separa de su interruptor`,
    window.getComputedStyle(fila).flexWrap === 'nowrap' &&
    parseFloat(window.getComputedStyle(doc.getElementById('orca-waiting-label')).minWidth) === 0,
    `${window.getComputedStyle(fila).flexWrap} ${window.getComputedStyle(doc.getElementById('orca-waiting-label')).minWidth}`)
  ok(`${nombre}: la tarjeta de avisos de Orca en su idioma`,
    leyenda.test(t('orca-legend')) && nunca.test(t('orca-intro')) && t('orca-no-number').length > 10 &&
    ['orca-waiting-label', 'orca-finished-label', 'orca-automation-label'].every((id) => t(id).length > 5) &&
    !/\{|undefined/.test(t('orca-notices-card')), t('orca-notices-card').slice(0, 300))
  if (nombre === 'PT') {
    const S = window.STRINGS
    ok('el portugues es propio, no el ingles',
      S.pt.orcaLegend && S.pt.orcaIntro !== S.en.orcaIntro && S.pt.orcaWaitingLabel !== S.en.orcaWaitingLabel)
  }
}

// ───────── L4/L5: varias lineas a la vez (odd/tasks/varias-lineas-y-segundo-cerebro.md) ─────────
// El worker deja las lineas en `lineas` (en orden: la primera es la principal), el estado de
// la principal en `sidecar` y el de las demas en `sidecars`. Lo de cada linea que no es la
// principal lo deja `wa-scope` aparte: su alcance en `alcancePorLinea`, y su tablero, su
// actividad y su lista de conversaciones en `porLinea`.
const L_A = 'pn:573000000001'
const L_B = 'pn:573000000011'
const ALTA = '2026-10-01T09:00:00.000Z'
const vivaDe = (cuenta) => ({ connection: 'open', me: '+' + cuenta.slice(3), cuenta,
  latido: { ts: Date.now(), conectado: true } })
const lineaA = { carpeta: 'pn-573000000001', cuenta: L_A, tipo: 'support', alta: ALTA }
const lineaB = { carpeta: 'pn-573000000011', cuenta: L_B, tipo: 'support', alta: ALTA }
/** El worker, en lo que importa aca: contesta el pedido de la sesion y lo deja guardado. */
function trabajadorLineas (d, st) {
  if (!(d.action === 'storage.set' && d.params.key === 'sidecarRequest' && d.params.value)) {
    return undefined
  }
  const p = d.params.value
  st.sidecarRequest = p
  const code = { vincular: 'vinculando', tipo: 'tipo-guardado', desvincular: 'desvinculado' }[p.action]
  st.sidecarResult = { at: new Date().toISOString(), requestId: p.id, action: p.action,
    ok: !!code, code: code || 'accion-desconocida', carpeta: p.carpeta || 'nueva-prueba' }
  return { ok: true }
}
/** El estado de la principal con la lista de lineas adentro, como lo publica el worker. */
const conLineas = (lineas) => Object.assign(vivaDe(L_A), { lineas })
const textoDe = (doc, sel) => doc.querySelector(sel)?.textContent ?? ''

console.log('\nconfig.html — L4: la tarjeta de lineas, con una sola')
{
  const { doc } = await montar('config.html', { sidecar: conLineas([lineaA]) }, 'es-419')
  await espera()
  // Una sola tarjeta: la vinculacion de siempre es la fila de la principal, dentro de Lineas.
  const fila = textoDe(doc, '#linea-principal')
  ok('la linea es la fila principal de la tarjeta de lineas, con su numero y conectada',
    !!doc.querySelector('#lineas-card #linea-principal') && fila.includes('+573000000001') &&
    /conectad/i.test(fila) && doc.querySelectorAll('#lineas-lista .linea').length === 0, fila)
  ok('con una sola linea no se la llama Principal: no hay otra',
    doc.getElementById('linea-principal-marca').hidden)
  ok('ya no hay una tarjeta de vinculacion aparte: un solo lugar para la linea',
    [...doc.querySelectorAll('#view-estado h2')].filter((h) =>
      /Vinculacion de WhatsApp/.test(h.textContent)).length === 0 &&
    doc.getElementById('pairing-msg').closest('#lineas-card') !== null)
  ok('su Desvincular dice solo Desvincular, en su fila',
    doc.getElementById('pairing-unlink').textContent === 'Desvincular' &&
    doc.getElementById('pairing-unlink').closest('#linea-principal') !== null)
  ok('ofrece vincular otra linea', !doc.getElementById('linea-vincular').disabled &&
    /Vincular otra linea/.test(doc.getElementById('linea-vincular').textContent))
  ok('con una sola linea no hay selector de linea en Conversaciones',
    doc.getElementById('linea-vista-fila').hidden)
  // A8: el selector de Tipo no dejaba elegir nada (Soporte siempre apretado, Personal
  // apagado). Vuelve con la parte 2, cuando Personal exista.
  ok('no hay selector de Tipo: no dejaba elegir nada',
    !doc.querySelector('.linea-tipo') && !/Tipo/.test(textoDe(doc, '#lineas-card')),
    textoDe(doc, '#lineas-card'))
}

console.log('\nconfig.html — L4: la unica linea, esperando su codigo, no ofrece soltarla')
{
  const sola = { carpeta: 'nueva-prueba', cuenta: null, tipo: 'support', alta: ALTA }
  const { doc } = await montar('config.html', { sidecar: { connection: null, qr: null,
    exited: false, lineas: [sola] } }, 'es-419')
  await espera()
  ok('sin numero todavia no hay Desvincular en su fila: no hay sesion que soltar',
    doc.getElementById('pairing-unlink').hidden &&
    !doc.querySelector('#lineas-card .linea-desvincular'))
  ok('y la vinculacion de siempre sigue ahi: espera el codigo en la tarjeta de lineas',
    /esperando/i.test(textoDe(doc, '#pairing-msg')) &&
    doc.getElementById('pairing-msg').closest('#lineas-card') !== null, textoDe(doc, '#pairing-msg'))
}

console.log('\nconfig.html — L4: vincular otra linea le pide al worker una linea nueva')
{
  const storage = { sidecar: conLineas([lineaA]) }
  const { doc } = await montar('config.html', storage, 'es-419', trabajadorLineas)
  await espera()
  doc.getElementById('linea-vincular').click()
  await new Promise((r) => setTimeout(r, 2500))
  ok('el clic deja el pedido de vincular', storage.sidecarRequest?.action === 'vincular',
    JSON.stringify(storage.sidecarRequest))
  ok('y dice que el codigo aparece en la lista', /codigo/i.test(textoDe(doc, '#said-lineas')),
    textoDe(doc, '#said-lineas'))
}

console.log('\nconfig.html — L4: la linea nueva espera su codigo en su propia fila')
{
  const nueva = { carpeta: 'nueva-prueba', cuenta: null, tipo: 'support', alta: ALTA }
  const storage = { sidecar: conLineas([lineaA, nueva]),
    sidecars: { 'nueva-prueba': { connection: 'connecting',
      qr: { qr: 'QR-NUEVA', ts: Date.now(), rotation: 1, ttlMs: 75000 } } } }
  const { doc } = await montar('config.html', storage, 'es-419', trabajadorLineas)
  await espera()
  const fila = doc.querySelector('#lineas-lista .linea[data-carpeta="nueva-prueba"]')
  ok('su fila muestra su propio codigo QR, con la instruccion', !!fila?.querySelector('canvas') &&
    /Escanee/.test(fila.textContent), fila?.textContent)
  ok('mientras una espera su codigo no se ofrece abrir otra',
    doc.getElementById('linea-vincular').disabled)
  ok('la principal no repite su codigo en la lista',
    !doc.querySelector('#lineas-lista .linea[data-carpeta="pn-573000000001"] canvas'))
  ok('ni el selector de Tipo ni su aviso, en ninguna fila',
    !doc.querySelector('#lineas-card .linea-tipo') &&
    !/llega en una version proxima/.test(doc.getElementById('lineas-card').textContent))
  const cancelar = fila.querySelector('.linea-desvincular')
  ok('la que espera su codigo se cancela, no se desvincula', cancelar?.textContent === 'Cancelar',
    cancelar?.textContent)
  cancelar.click()
  await new Promise((r) => setTimeout(r, 2500))
  ok('y cancelarla es un clic que nombra su carpeta',
    storage.sidecarRequest?.action === 'desvincular' &&
    storage.sidecarRequest.carpeta === 'nueva-prueba', JSON.stringify(storage.sidecarRequest))
}

console.log('\nconfig.html — L4: desvincular una linea pide confirmacion y nombra la suya')
{
  const storage = { sidecar: conLineas([lineaA, lineaB]),
    sidecars: { 'pn-573000000011': vivaDe(L_B) } }
  const { doc } = await montar('config.html', storage, 'es-419', trabajadorLineas)
  await espera()
  const boton = () => doc.querySelector('.linea[data-carpeta="pn-573000000011"] .linea-desvincular')
  ok('cada linea tiene su Desvincular', !!boton())
  const estadoOtra = textoDe(doc, '.linea[data-carpeta="pn-573000000011"] .linea-estado')
  ok('el estado de cada linea se dice con las mismas palabras que el de la principal',
    estadoOtra === textoDe(doc, '#pairing-msg') && estadoOtra === 'WhatsApp esta conectado',
    `${estadoOtra} / ${textoDe(doc, '#pairing-msg')}`)
  ok('un solo Desvincular por linea: la principal el suyo, la otra el suyo',
    doc.querySelectorAll('#lineas-card .linea-desvincular').length === 1 &&
    !doc.getElementById('pairing-unlink').hidden &&
    /Principal/.test(textoDe(doc, '#linea-principal')) &&
    textoDe(doc, '#linea-principal').includes('+573000000001'), textoDe(doc, '#lineas-card'))
  ok('y un solo Comprobar ahora, para toda la tarjeta',
    doc.querySelectorAll('#lineas-card #pairing-refresh').length === 1 &&
    doc.getElementById('pairing-refresh').closest('#linea-principal') === null)
  boton().click()
  await espera()
  ok('el primer clic solo pide confirmacion', !storage.sidecarRequest &&
    /Si, desvincular/.test(boton().textContent), boton().textContent)
  boton().click()
  await new Promise((r) => setTimeout(r, 2500))
  ok('el segundo pide desvincular ESA linea y no la principal',
    storage.sidecarRequest?.action === 'desvincular' &&
    storage.sidecarRequest.carpeta === 'pn-573000000011', JSON.stringify(storage.sidecarRequest))
}

console.log('\nconfig.html — A8: sin selector de Tipo en ninguna fila de linea')
{
  // Un registro que ya dice `personal` (la parte 2): el panel no ofrece cambiarlo, y no le
  // pide nada al worker. El campo y la accion `tipo` del worker siguen para la parte 2.
  const storage = { sidecar: conLineas([Object.assign({}, lineaA, { tipo: 'personal' }), lineaB]),
    sidecars: { 'pn-573000000011': vivaDe(L_B) } }
  const { doc } = await montar('config.html', storage, 'es-419', trabajadorLineas)
  await espera()
  ok('ni la principal ni la otra muestran un selector de Tipo',
    !doc.querySelector('.linea-tipo') && !doc.querySelector('#linea-principal-tipo button') &&
    !doc.querySelector('.linea[data-carpeta="pn-573000000011"] .seg'),
    doc.getElementById('lineas-card').innerHTML.slice(0, 400))
  ok('y no queda el aviso de que Personal llega despues', !/Personal/.test(textoDe(doc, '#lineas-card')),
    textoDe(doc, '#lineas-card'))
  ok('el panel no le pide al worker ningun tipo', !storage.sidecarRequest)
  const S = doc.defaultView.STRINGS
  const fuera = ['linesType', 'linesTypeSupport', 'linesTypePersonal', 'linesTypeSaved',
    'linesHowTypeLater', 'linesPersonalLater']
  ok('sus textos salen de los tres idiomas',
    fuera.every((k) => !(k in S.es) && !(k in S.en) && !(k in S.pt)),
    fuera.filter((k) => k in S.es || k in S.en || k in S.pt).join())
  const nuevas = ['linesLegend', 'linesLink', 'linesPrincipal', 'linesView', 'linesLinking']
  ok('los textos de las lineas existen en los tres idiomas, el portugues propio',
    nuevas.every((k) => S.es[k] && S.en[k] && S.pt[k] && S.pt[k] !== S.en[k]),
    JSON.stringify(nuevas.filter((k) => !S.es[k] || !S.en[k] || !S.pt[k] || S.pt[k] === S.en[k])))
}

console.log('\nconfig.html — L4: Conversaciones se ven y se guardan por linea')
{
  const G1 = '120363000000000001@g.us'
  const storage = { sidecar: conLineas([lineaA, lineaB]),
    sidecars: { 'pn-573000000011': vivaDe(L_B) }, chatsAccount: L_A, chats: [],
    scope: { [G1]: { chatName: 'Soporte Principal', mode: 'responder', account: L_A } },
    alcancePorLinea: { [L_B]: { [G1]: { chatName: 'Soporte Segunda', mode: 'observar',
      account: L_B } } },
    porLinea: { [L_B]: { chats: [], chatsAccount: L_B } } }
  const gancho = (d, st) => {
    if (d.action === 'storage.set' && d.params.key === 'scopeRequest' && d.params.value) {
      st.scopeRequest = d.params.value
      st.scopeResult = { at: new Date().toISOString(), requestId: d.params.value.id,
        action: 'quitar', ok: true, code: 'quitado' }
      return { ok: true }
    }
    return undefined
  }
  const { doc } = await montar('config.html', storage, 'es-419', gancho)
  await espera()
  doc.getElementById('tab-chats').click()
  await espera()
  const fila = doc.getElementById('linea-vista-fila')
  const botones = [...doc.querySelectorAll('#linea-vista button')]
  ok('con dos lineas aparece el selector, con la principal elegida', !fila.hidden &&
    botones.length === 2 && valorSeg(doc, 'linea-vista') === L_A, fila.outerHTML.slice(0, 300))
  const lista = () => doc.getElementById('scope-wrap').textContent
  ok('muestra lo autorizado en la principal y nada de la otra',
    /Soporte Principal/.test(lista()) && !/Soporte Segunda/.test(lista()), lista())
  elegirSeg(doc, 'linea-vista', L_B)
  await new Promise((r) => setTimeout(r, 300))
  ok('elegir la otra linea muestra lo autorizado en ESA',
    /Soporte Segunda/.test(lista()) && !/Soporte Principal/.test(lista()), lista())

  doc.querySelector(`#scope-wrap [data-edit="${G1}"]`).click()
  await espera()
  elegirSeg(doc, 'mode', 'borrador')
  doc.getElementById('save-scope').click()
  await new Promise((r) => setTimeout(r, 500))
  ok('guardar en la otra linea escribe en SU alcance',
    storage.alcancePorLinea[L_B][G1].mode === 'borrador' &&
    storage.alcancePorLinea[L_B][G1].account === L_B, JSON.stringify(storage.alcancePorLinea))
  ok('y no toca el de la principal, aunque sea el mismo grupo',
    storage.scope[G1].mode === 'responder' && storage.scope[G1].chatName === 'Soporte Principal',
    JSON.stringify(storage.scope))

  doc.querySelector(`#scope-wrap [data-rm="${G1}"]`).click()
  await new Promise((r) => setTimeout(r, 2500))
  ok('quitar en la otra linea le dice al worker de que linea es',
    storage.scopeRequest?.action === 'quitar' && storage.scopeRequest.jid === G1 &&
    storage.scopeRequest.linea === L_B, JSON.stringify(storage.scopeRequest))
}

console.log('\nconfig.html — L4: si la otra linea no contesta, no se ve la lista de la primera')
{
  const G1 = '120363000000000001@g.us'
  const storage = { sidecar: conLineas([lineaA, lineaB]),
    sidecars: { 'pn-573000000011': vivaDe(L_B) }, chatsAccount: L_A, chats: [],
    scope: { [G1]: { chatName: 'Soporte Principal', mode: 'responder', account: L_A } },
    alcancePorLinea: { [L_B]: { [G1]: { chatName: 'Soporte Segunda', mode: 'observar',
      account: L_B } } },
    porLinea: { [L_B]: { chats: [], chatsAccount: L_B } } }
  // El host con el cupo lleno: la lectura de la otra linea no se contesta.
  let callado = true
  const gancho = (d) => (callado && d.action === 'storage.get' &&
    (d.params.key === 'alcancePorLinea' || d.params.key === 'porLinea')) ? { ok: false } : undefined
  const { doc } = await montar('config.html', storage, 'es-419', gancho)
  await espera()
  doc.getElementById('tab-chats').click()
  await espera()
  const lista = () => doc.getElementById('scope-wrap').textContent
  elegirSeg(doc, 'linea-vista', L_B)
  await new Promise((r) => setTimeout(r, 300))
  ok('mirando la otra linea, nunca queda la lista de la principal',
    !/Soporte Principal/.test(lista()), lista())
  ok('y dice que la esta leyendo', /Leyendo/.test(lista()), lista())
  callado = false
  await new Promise((r) => setTimeout(r, 3500))
  ok('cuando el host contesta, aparece lo de ESA linea sola',
    /Soporte Segunda/.test(lista()) && !/Soporte Principal/.test(lista()), lista())
}

console.log('\nactivity.html — L4: el tablero se filtra por linea')
{
  const storage = { sidecar: conLineas([lineaA, lineaB]),
    sidecars: { 'pn-573000000011': vivaDe(L_B) },
    board: tablero([tarjeta({ case_id: 1, account: L_A, title: 'Caso de la principal' })]),
    porLinea: { [L_B]: { board: tablero([tarjeta({ case_id: 2, account: L_B,
      title: 'Caso de la segunda' })]), activity: { account: L_B, pending: [], recent: [],
      mapped: 1, authorized: 1, syncedAt: '2026-10-01 09:00' }, chatsAccount: L_B, chats: [] } } }
  // El host contesta cada lectura con una copia nueva (sale de un archivo): comparar las
  // lineas por identidad entre dos vueltas no sirve, y asi se probo en Playwright.
  Object.defineProperty(storage, 'sidecar', { enumerable: true,
    get: () => JSON.parse(JSON.stringify(conLineas([lineaA, lineaB]))) })
  const { doc } = await abrirTablero(storage)
  const selector = doc.getElementById('linea-vista')
  ok('con dos lineas el tablero ofrece elegir la linea, con la principal elegida',
    !doc.getElementById('linea-vista-fila').hidden && selector.querySelectorAll('button').length === 2 &&
    selector.querySelector('button[aria-pressed="true"]')?.dataset.value === L_A,
    doc.getElementById('linea-vista-fila').outerHTML.slice(0, 300))
  ok('muestra solo los casos de la principal', visibles(doc).join() === '1', visibles(doc).join())
  selector.querySelector(`button[data-value="${L_B}"]`).click()
  await new Promise((r) => setTimeout(r, 300))
  ok('elegir la otra muestra solo los suyos', visibles(doc).join() === '2', visibles(doc).join())
  ok('y el estado de ESA linea, con su numero',
    doc.getElementById('linea').textContent.includes('+573000000011'),
    doc.getElementById('linea').textContent)
  const una = await abrirTablero({ sidecar: conLineas([lineaA]),
    board: tablero([tarjeta({ case_id: 1, account: L_A })]) })
  ok('con una sola linea no hay selector', una.doc.getElementById('linea-vista-fila').hidden)

  // Lo retenido fuera de un caso es de su linea: con dos lineas, su tarjeta dice cual.
  const retenido = { req_id: 'sesion-otra-1', account: L_B, chat_jid: '573000000002@s.whatsapp.net',
    chat: 'Cliente Uno', text: 'Ya quedo el reporte', at: new Date().toISOString(), reasons: [] }
  storage.porLinea[L_B].board = tablero([tarjeta({ case_id: 2, account: L_B })],
    { held_drafts: [retenido] })
  doc.getElementById('refresh').click()
  await new Promise((r) => setTimeout(r, 300))
  const tarjetaRetenido = doc.querySelector('#board-held .card[data-req="sesion-otra-1"]')
  ok('un retenido de la otra linea dice en su tarjeta de que linea es',
    !!tarjetaRetenido && tarjetaRetenido.textContent.includes('+573000000011'),
    tarjetaRetenido?.textContent)
  const unaRet = await abrirTablero({ sidecar: conLineas([lineaA]),
    board: tablero([], { held_drafts: [Object.assign({}, retenido, { account: L_A })] }) })
  const solo = unaRet.doc.querySelector('#board-held .card[data-req="sesion-otra-1"]')
  ok('con una sola linea la tarjeta del retenido es la de siempre, sin numero',
    !!solo && !solo.textContent.includes('+573000000001'), solo?.textContent)
  const S = doc.defaultView.STRINGS
  ok('el nombre del selector existe en los tres idiomas, el portugues propio',
    S.es.linesView && S.en.linesView && S.pt.linesView && S.pt.linesView !== S.en.linesView)
}

console.log('\nconfig.html — lineas claras: que es de cada linea y que es del equipo')
{
  const dos = { sidecar: conLineas([lineaA, lineaB]), sidecars: { 'pn-573000000011': vivaDe(L_B) } }
  const { doc } = await montar('config.html', dos, 'es-419')
  await espera()
  const seVeN = (n) => {
    for (let x = n; x && x.nodeType === 1; x = x.parentElement) {
      if (x.hidden || x.ownerDocument.defaultView.getComputedStyle(x).display === 'none') return false
    }
    return true
  }
  ok('ya no hay notas de "Aplica a sus N lineas": cada pestana es de la linea elegida',
    !doc.querySelector('.nota-lineas') && !/Aplica a sus/.test(doc.body.textContent))
  const PROPIAS = ['agent-card', 'owners-card', 'auto-card', 'sla-card', 'pq-card', 'scope-form',
    'orca-notices-card', 'bot-account-card', 'voice-card', 'routes-card', 'projects-card',
    'reading-card', 'jev-card', 'skills-card']
  ok('ninguna tarjeta dice "Vale para todas las lineas": cada ajuste es de la linea que se mira',
    !doc.querySelector('.nota-maquina') && PROPIAS.every((id) => doc.getElementById(id)) &&
      !/Vale para todas las lineas/.test(doc.body.textContent),
    PROPIAS.filter((id) => !doc.getElementById(id)).join())
  ok('los avisos de Orca dicen que salen por la linea que se mira, a su numero',
    textoDe(doc, '#orca-line-from') ===
      'Los avisos de Orca de esta linea salen por ella, +573000000001, a su numero de aprobacion.' &&
    !doc.getElementById('orca-line-from').hidden, textoDe(doc, '#orca-line-from'))
  ok('y los de los casos, por la linea que se esta viendo',
    textoDe(doc, '#approval-main-line') ===
      'Los avisos de los casos de esta linea salen por ella, +573000000001, a este numero.',
    textoDe(doc, '#approval-main-line'))
  const fila = doc.getElementById('linea-vista-fila')
  ok('el selector de linea va arriba de las pestanas, fuera de ellas',
    !fila.hidden && !fila.closest('[role="tabpanel"]') &&
    !!(fila.compareDocumentPosition(doc.querySelector('.tabs')) &
      doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING) && seVeN(fila), fila.outerHTML.slice(0, 200))
  ok('dice que linea se esta viendo', textoDe(doc, '#linea-vista-actual') === 'Viendo la linea +573000000001')
  elegirSeg(doc, 'linea-vista', L_B)
  await new Promise((r) => setTimeout(r, 300))
  ok('y despues de elegir la otra nombra la otra, tambien en el aviso de los casos',
    textoDe(doc, '#linea-vista-actual') === 'Viendo la linea +573000000011' &&
    /\+573000000011/.test(textoDe(doc, '#approval-main-line')) &&
    /\+573000000011/.test(textoDe(doc, '#orca-line-from')), textoDe(doc, '#linea-vista-actual'))
  ok('desde cualquier pestana: el selector se ve en Agente', (doc.getElementById('tab-agente').click(),
    seVeN(fila)))
  const una = await montar('config.html', { sidecar: conLineas([lineaA]) }, 'es-419')
  await espera()
  ok('con una sola linea no hay selector ni avisos de linea',
    una.doc.getElementById('linea-vista-fila').hidden &&
    una.doc.getElementById('approval-main-line').hidden && una.doc.getElementById('orca-line-from').hidden)
  const en = await montar('config.html', dos, 'en')
  await espera()
  ok('en ingles hablan ingles',
    /Skills are installed on this computer/.test(textoDe(en.doc, '#skills-card')) &&
    /through it, \+573000000001/.test(textoDe(en.doc, '#orca-line-from')),
    textoDe(en.doc, '#orca-line-from'))
  const pt = await montar('config.html', dos, 'pt-BR')
  await espera()
  ok('en portugues tambien',
    /As skills sao instaladas neste computador/.test(textoDe(pt.doc, '#skills-card')) &&
    /saem por ela, \+573000000001/.test(textoDe(pt.doc, '#orca-line-from')),
    textoDe(pt.doc, '#orca-line-from'))
  const S = doc.defaultView.STRINGS
  const claves = ['orcaLineFrom', 'linesApprovalFrom', 'linesViewing', 'linesView',
    'linesViewHelp']
  ok('la ayuda del selector ya no habla de lo del equipo: todo es de la linea que se mira',
    ['es', 'en', 'pt'].every((l) => !/equipo|computer|computador/.test(S[l].linesViewHelp)),
    ['es', 'en', 'pt'].map((l) => S[l].linesViewHelp).join(' | '))
  ok('las frases existen en los tres idiomas, el portugues propio',
    claves.every((k) => S.es[k] && S.en[k] && S.pt[k] && S.pt[k] !== S.en[k]),
    claves.filter((k) => !S.es[k] || !S.en[k] || !S.pt[k] || S.pt[k] === S.en[k]).join())
}

// ───────── A5: los ajustes de cada linea (odd/tasks/ajustes-por-linea.md) ─────────
// La principal guarda sus ajustes en la raiz, como siempre; cada otra linea, en
// `ajustesPorLinea[<numero>]`. El selector de arriba manda en todas las pestanas.
const DUENO_A = { id: '100000000000001@lid', name: 'Dueno Principal' }
const DUENO_B = { id: '100000000000002@lid', name: 'Dueno Segunda' }
const G_LINEAS = '120363000000000001@g.us'
function dosLineasConAjustes () {
  return {
    sidecar: conLineas([lineaA, lineaB]), sidecars: { 'pn-573000000011': vivaDe(L_B) },
    chatsAccount: L_A, chats: [{ jid: G_LINEAS, name: 'Soporte', kind: 'grupo' }],
    scope: { [G_LINEAS]: { chatName: 'Soporte', mode: 'responder', account: L_A } },
    agentName: 'Agente Principal', ownerName: 'Ana', tone: 'Tono de la principal',
    owners: [DUENO_A], approvalNumber: DUENO_A.id, approvalLang: 'es', ackMode: 'on',
    ackText: 'Recibido en la principal', ackQuietMinutes: '12', inboxDays: '7',
    syncMinutes: '10', transcribeLang: 'es', slaMinutes: '15',
    senders: [{ id: '111122225555@lid', name: 'Remitente Principal', chats: ['Soporte'] }],
    groupMembers: { [G_LINEAS]: [{ id: '111122224444@lid', name: 'Miembro Principal' }] },
    alcancePorLinea: { [L_B]: { [G_LINEAS]: { chatName: 'Soporte', mode: 'observar', account: L_B } } },
    porLinea: { [L_B]: { chats: [{ jid: G_LINEAS, name: 'Soporte', kind: 'grupo' }],
      chatsAccount: L_B,
      senders: [{ id: '111122226666@lid', name: 'Remitente Segunda', chats: ['Ventas'] }],
      groupMembers: { [G_LINEAS]: [{ id: '111122223333@lid', name: 'Miembro Segunda' }] } } },
    ajustesPorLinea: {
      [L_B]: { agentName: 'Agente Segunda', ownerName: 'Berta', tone: 'Tono de la segunda',
        owners: [DUENO_B], approvalNumber: DUENO_B.id, approvalLang: 'en', ackMode: 'off',
        ackText: 'Recibido en la segunda', inboxDays: '1', transcribeLang: 'en', slaMinutes: '45',
        syncMinutes: '30' },
      'pn:573000000013': { agentName: 'Agente Ajeno', claveFutura: 1 } }
  }
}

console.log('\nconfig.html — A5: cada linea muestra y guarda sus propios ajustes')
{
  const storage = dosLineasConAjustes()
  const { doc } = await montar('config.html', storage, 'es-419')
  await espera()
  doc.getElementById('tab-agente').click()
  await espera()
  const campo = (id) => doc.getElementById(id).value
  ok('en la principal, Agente muestra lo de la raiz',
    campo('agent') === 'Agente Principal' && campo('tone') === 'Tono de la principal' &&
    campo('owner') === 'Ana', `${campo('agent')} / ${campo('tone')}`)
  elegirSeg(doc, 'linea-vista', L_B)
  await new Promise((r) => setTimeout(r, 300))
  ok('en la otra linea, Agente muestra lo de ESA linea',
    campo('agent') === 'Agente Segunda' && campo('tone') === 'Tono de la segunda' &&
    campo('owner') === 'Berta', `${campo('agent')} / ${campo('tone')} / ${campo('owner')}`)
  doc.getElementById('tab-avanzado').click()
  await espera()
  ok('Avanzado: los dias, el idioma y el ritmo son de esa linea',
    valorSeg(doc, 'inbox-days') === '1' && valorSeg(doc, 'lang') === 'en' &&
    valorSeg(doc, 'sync-minutes') === '30',
    `${valorSeg(doc, 'inbox-days')} ${valorSeg(doc, 'lang')} ${valorSeg(doc, 'sync-minutes')}`)
  elegirSeg(doc, 'sync-minutes', '2')
  doc.getElementById('save-reading').click()
  await new Promise((r) => setTimeout(r, 500))
  ok('P5: guardar el ritmo en la otra linea lo guarda en ESA, y la principal sigue con el suyo',
    storage.ajustesPorLinea[L_B].syncMinutes === '2' && storage.syncMinutes === '10' &&
    storage.ajustesPorLinea[L_B].inboxDays === '1',
    JSON.stringify([storage.ajustesPorLinea[L_B], storage.syncMinutes]))

  doc.getElementById('tab-agente').click()
  await espera()
  escribir(doc, 'agent', 'Agente Nuevo')
  doc.getElementById('save-agent').click()
  await new Promise((r) => setTimeout(r, 500))
  const propios = () => storage.ajustesPorLinea[L_B]
  ok('guardar el agente en la otra linea escribe solo en lo de ESA linea',
    propios().agentName === 'Agente Nuevo' && propios().tone === 'Tono de la segunda' &&
    storage.agentName === 'Agente Principal' && storage.tone === 'Tono de la principal',
    JSON.stringify({ propios: propios(), raiz: storage.agentName }))
  ok('sin tocar lo demas de esa linea ni lo de las otras',
    propios().approvalNumber === DUENO_B.id && propios().ackMode === 'off' &&
    JSON.stringify(storage.ajustesPorLinea['pn:573000000013']) ===
      '{"agentName":"Agente Ajeno","claveFutura":1}', JSON.stringify(storage.ajustesPorLinea))
  ok('y queda mostrando lo que quedo guardado', campo('agent') === 'Agente Nuevo' &&
    /Guardado/.test(textoDe(doc, '#said-agent')), textoDe(doc, '#said-agent'))

  doc.getElementById('tab-aprobacion').click()
  await new Promise((r) => setTimeout(r, 300))
  ok('Su aprobacion en la otra linea: sus numeros y su numero de aprobacion',
    /Dueno Segunda/.test(textoDe(doc, '#owners-wrap')) && !/Dueno Principal/.test(textoDe(doc, '#owners-wrap')) &&
    valorSeg(doc, 'approval-number') === DUENO_B.id, textoDe(doc, '#owners-wrap'))
  ok('y sus respuestas automaticas; lo que no tiene propio es lo de la principal',
    valorSeg(doc, 'ack-mode') === 'off' && campo('ack-text') === 'Recibido en la segunda' &&
    campo('ack-quiet') === '12' && campo('sla-minutes') === '45',
    `${valorSeg(doc, 'ack-mode')} ${campo('ack-text')} ${campo('ack-quiet')} ${campo('sla-minutes')}`)
  escribir(doc, 'owner-search', 'remitente')
  const ofrecidos = opcionesCombo(doc, 'owner-list').map((o) => o.textContent).join(' | ')
  ok('los numeros que ofrece son los que escribieron en ESA linea',
    /Remitente Segunda/.test(ofrecidos) && !/Remitente Principal/.test(ofrecidos), ofrecidos)
  doc.getElementById('ack-text').value = 'Texto nuevo de la segunda'
  doc.getElementById('ack-text').dispatchEvent(evento(doc, 'input'))
  doc.getElementById('save-auto').click()
  await new Promise((r) => setTimeout(r, 500))
  ok('guardar las respuestas automaticas en la otra linea no toca las de la principal',
    propios().ackText === 'Texto nuevo de la segunda' && storage.ackText === 'Recibido en la principal' &&
    propios().agentName === 'Agente Nuevo', JSON.stringify(propios()))
  doc.querySelector(`#owners-wrap [data-orm="${DUENO_B.id}"]`).click()
  doc.getElementById('save-owners').click()
  await new Promise((r) => setTimeout(r, 500))
  ok('guardar los numeros en la otra linea los guarda en ESA, con su idioma',
    JSON.stringify(propios().owners) === '[]' && propios().approvalNumber === '' &&
    propios().approvalLang === 'es' && storage.owners[0].id === DUENO_A.id &&
    storage.approvalNumber === DUENO_A.id, JSON.stringify(propios()))

  doc.getElementById('tab-chats').click()
  await espera()
  doc.querySelector(`#scope-wrap [data-edit="${G_LINEAS}"]`).click()
  await new Promise((r) => setTimeout(r, 300))
  const gente = textoDe(doc, '#people-list')
  ok('las personas de un grupo son las de ESA linea', /Miembro Segunda/.test(gente) &&
    !/Miembro Principal/.test(gente), gente)

  elegirSeg(doc, 'linea-vista', L_A)
  await new Promise((r) => setTimeout(r, 300))
  doc.getElementById('tab-agente').click()
  await espera()
  ok('volver a la principal muestra otra vez lo de la raiz',
    campo('agent') === 'Agente Principal' && campo('tone') === 'Tono de la principal', campo('agent'))
}

console.log('\nconfig.html — P5: con varias lineas, el triage corre al ritmo de la mas frecuente')
{
  const latido = (minutes) => ({ at: new Date().toISOString(),
    triage: { minutes, cron: `*/${minutes} * * * *`, ok: true, code: 'ajustado' } })
  const storage = Object.assign(dosLineasConAjustes(), { workerBeat: latido(2) })
  const { doc } = await montar('config.html', storage, 'es-419')
  await espera()
  doc.getElementById('tab-avanzado').click()
  await espera()
  const ritmo = () => textoDe(doc, '#triage-pace')
  ok('la principal a 10 min con el triage a 2: dice que es el de la linea mas frecuente',
    /corre cada 2 min, el ritmo de la linea mas frecuente/.test(ritmo()) && !/Ajustando/.test(ritmo()),
    ritmo())
  elegirSeg(doc, 'linea-vista', L_B)
  await new Promise((r) => setTimeout(r, 300))
  doc.getElementById('tab-avanzado').click()
  await espera()
  ok('la otra linea muestra SU ritmo, y lo mismo del triage',
    valorSeg(doc, 'sync-minutes') === '30' && /linea mas frecuente/.test(ritmo()),
    `${valorSeg(doc, 'sync-minutes')} ${ritmo()}`)
  const lento = Object.assign(dosLineasConAjustes(), { workerBeat: latido(60) })
  const otro = await montar('config.html', lento, 'es-419')
  await espera()
  ok('un triage mas lento que la linea si es "ajustando"',
    /Ajustando/.test(textoDe(otro.doc, '#triage-pace')), textoDe(otro.doc, '#triage-pace'))
  const S = doc.defaultView.STRINGS
  ok('la frase existe en los tres idiomas, el portugues propio',
    S.es.triagePaceShared && S.en.triagePaceShared && S.pt.triagePaceShared &&
    S.pt.triagePaceShared !== S.en.triagePaceShared)
}

console.log('\nconfig.html — P6: Jev se enciende y se apaga en cada linea, con una sola llave')
{
  const ahora = () => new Date().toISOString()
  const storage = Object.assign(dosLineasConAjustes(), {
    jevStatus: { at: ahora(), enabled: true, keySet: true, mirror: 'activo', lines: { [L_B]: false } } })
  const { doc } = await montar('config.html', storage, 'es-419', trabajadorJev((pedido, st) => {
    const lines = Object.assign({}, st.jevStatus.lines)
    if (pedido.linea) lines[pedido.linea] = pedido.enabled
    st.jevStatus = { at: ahora(), enabled: pedido.linea ? st.jevStatus.enabled : pedido.enabled,
      keySet: true, mirror: 'activo', lines }
    return { ok: true, code: pedido.enabled ? 'activado' : 'desactivado' }
  }))
  await espera()
  doc.getElementById('tab-aprobacion').click()
  await espera()
  const sw = () => doc.getElementById('jev-enabled').getAttribute('aria-checked')
  const estado = () => textoDe(doc, '#jev-status')
  ok('en la principal, el Jev de la principal: encendido',
    sw() === 'true' && /Encendido/.test(estado()), `${sw()} ${estado()}`)
  elegirSeg(doc, 'linea-vista', L_B)
  await new Promise((r) => setTimeout(r, 300))
  ok('en la otra linea, el de ESA linea: apagado, con la misma llave guardada',
    sw() === 'false' && /Apagado.*llave guardada/.test(estado()), `${sw()} ${estado()}`)
  doc.getElementById('jev-enabled').click()
  await new Promise((r) => setTimeout(r, 3500))
  ok('encenderlo ahi manda el pedido con esa linea',
    storage.jevRequestVisto && storage.jevRequestVisto.action === 'activar' &&
    storage.jevRequestVisto.enabled === true && storage.jevRequestVisto.linea === L_B,
    JSON.stringify(storage.jevRequestVisto))
  ok('y queda encendido en esa linea, sin tocar la principal',
    sw() === 'true' && storage.jevStatus.lines[L_B] === true && storage.jevStatus.enabled === true,
    `${sw()} ${JSON.stringify(storage.jevStatus)}`)
  elegirSeg(doc, 'linea-vista', L_A)
  await new Promise((r) => setTimeout(r, 300))
  doc.getElementById('jev-enabled').click()
  await new Promise((r) => setTimeout(r, 3500))
  ok('en la principal el pedido no nombra linea, como siempre',
    storage.jevRequestVisto && storage.jevRequestVisto.enabled === false &&
    !('linea' in storage.jevRequestVisto), JSON.stringify(storage.jevRequestVisto))
  ok('apagar la principal deja encendida la otra',
    sw() === 'false' && storage.jevStatus.lines[L_B] === true, JSON.stringify(storage.jevStatus))
  ok('la tarjeta dice que la llave es una sola para el equipo, y ya no lleva la nota de maquina',
    /una sola para este equipo/.test(textoDe(doc, '#jev-key-shared')) &&
    !doc.querySelector('#jev-card .nota-maquina'), textoDe(doc, '#jev-key-shared'))
  const S = doc.defaultView.STRINGS
  ok('la frase de la llave existe en los tres idiomas, el portugues propio',
    S.es.jevKeyShared && S.en.jevKeyShared && S.pt.jevKeyShared &&
    S.pt.jevKeyShared !== S.en.jevKeyShared)
}

console.log('\nconfig.html — P7: las skills se instalan en el equipo y avisan por la linea elegida')
{
  const storage = dosLineasConAjustes()
  const { doc } = await montar('config.html', storage, 'es-419')
  await espera()
  doc.getElementById('tab-skills').click()
  await new Promise((r) => setTimeout(r, 500))
  const sw = doc.getElementById('skills-line')
  const fila = doc.getElementById('skills-line-row')
  const dice = () => textoDe(doc, '#skills-line-text')
  ok('la tarjeta dice que las skills se instalan en este equipo, sin la nota de maquina',
    /se instalan en este equipo/.test(textoDe(doc, '#skills-card')) &&
    !doc.querySelector('#skills-card .nota-maquina'), textoDe(doc, '#skills-card').slice(0, 300))
  ok('sin nada elegido avisan por la principal: encendido ahi, y no se puede apagar',
    !fila.hidden && sw.getAttribute('aria-checked') === 'true' && sw.disabled &&
    /por la linea \+573000000001/.test(dice()), `${fila.hidden} ${sw.getAttribute('aria-checked')} ${dice()}`)
  elegirSeg(doc, 'linea-vista', L_B)
  await new Promise((r) => setTimeout(r, 300))
  ok('en la otra linea, apagado y se puede encender',
    sw.getAttribute('aria-checked') === 'false' && !sw.disabled, sw.getAttribute('aria-checked'))
  sw.click()
  await new Promise((r) => setTimeout(r, 500))
  ok('encenderlo ahi guarda esa linea para las skills, en la raiz',
    storage.skillsLine === L_B && sw.getAttribute('aria-checked') === 'true' &&
    /por la linea \+573000000011/.test(dice()), `${JSON.stringify(storage.skillsLine)} ${dice()}`)
  elegirSeg(doc, 'linea-vista', L_A)
  await new Promise((r) => setTimeout(r, 300))
  ok('y en la principal queda apagado, y se puede volver a elegir',
    sw.getAttribute('aria-checked') === 'false' && !sw.disabled && /\+573000000011/.test(dice()),
    `${sw.getAttribute('aria-checked')} ${dice()}`)
  sw.click()
  await new Promise((r) => setTimeout(r, 500))
  ok('elegir la principal la deja sin linea aparte (null), como de fabrica',
    storage.skillsLine === null && sw.getAttribute('aria-checked') === 'true',
    JSON.stringify(storage.skillsLine))
  const una = await montar('config.html', { sidecar: conLineas([lineaA]) }, 'es-419')
  await espera()
  ok('con una sola linea no hay nada que elegir',
    una.doc.getElementById('skills-line-row').hidden && una.doc.getElementById('skills-line-text').hidden)
  const S = doc.defaultView.STRINGS
  const claves = ['skillsMachineNote', 'skillsLineLabel', 'skillsLineNow']
  ok('las frases existen en los tres idiomas, el portugues propio',
    claves.every((k) => S.es[k] && S.en[k] && S.pt[k] && S.pt[k] !== S.en[k]),
    claves.filter((k) => !S.es[k] || !S.en[k] || !S.pt[k] || S.pt[k] === S.en[k]).join())
}

console.log('\nconfig.html — A5: si la otra linea no contesta, no se ven los ajustes de la principal')
{
  const storage = dosLineasConAjustes()
  let callado = true
  const gancho = (d) => (callado && d.action === 'storage.get' && d.params.key === 'ajustesPorLinea')
    ? { ok: false, errorCode: 'rate_limited', error: 'Too many requests.' } : undefined
  const { doc } = await montar('config.html', storage, 'es-419', gancho)
  await espera()
  doc.getElementById('tab-agente').click()
  await espera()
  ok('en la principal se ve lo de la raiz', doc.getElementById('agent').value === 'Agente Principal')
  elegirSeg(doc, 'linea-vista', L_B)
  await new Promise((r) => setTimeout(r, 300))
  const tarjeta = doc.getElementById('agent-card')
  ok('mirando la otra linea sin respuesta: la tarjeta dice que esta leyendo',
    tarjeta.classList.contains('sin-leer') && /Leyendo/i.test(textoDe(doc, '#agent-card .leyendo')),
    tarjeta.className)
  ok('y nunca queda el valor de la principal en sus campos',
    doc.getElementById('agent').value !== 'Agente Principal' &&
    doc.getElementById('tone').value !== 'Tono de la principal', doc.getElementById('agent').value)
  doc.getElementById('save-agent').click()
  await espera()
  ok('y su Guardar no escribe nada', !('agentName' in (storage.ajustesPorLinea[L_B] || {})) ||
    storage.ajustesPorLinea[L_B].agentName === 'Agente Segunda')
  callado = false
  await new Promise((r) => setTimeout(r, 3800))
  ok('cuando el host contesta, aparece lo de ESA linea, sola la lectura que faltaba',
    doc.getElementById('agent').value === 'Agente Segunda' && !tarjeta.classList.contains('sin-leer'),
    doc.getElementById('agent').value)
}

// ───────── todo-por-linea P1: los avisos de Orca de cada linea ─────────
// La tarjeta de los avisos de Orca es de la linea que se mira. Otra linea sin avisos propios
// NO hereda los de la principal: se pintan apagados, y guardar ahi no toca la raiz.
console.log('\nconfig.html — P1: los avisos de Orca de cada linea')
{
  const storage = dosLineasConAjustes()
  const ORCA_A = { waiting: 'on', finished: 'on', automationFailed: 'off', quietStart: '',
    quietEnd: '', hourlyCap: '4', finishedDelaySeconds: '30' }
  storage.orcaNotices = { ...ORCA_A }
  const { doc } = await montar('config.html', storage, 'es-419')
  await espera()
  doc.getElementById('tab-aprobacion').click()
  await new Promise((r) => setTimeout(r, 300))
  const encendido = (id) => doc.getElementById(id).getAttribute('aria-checked') === 'true'
  ok('en la principal, la tarjeta muestra los avisos de la raiz',
    encendido('orca-waiting') && encendido('orca-finished') &&
    doc.getElementById('orca-cap').value === '4', doc.getElementById('orca-cap').value)
  elegirSeg(doc, 'linea-vista', L_B)
  await new Promise((r) => setTimeout(r, 400))
  ok('en otra linea sin avisos propios: todo apagado, no los de la principal',
    !encendido('orca-waiting') && !encendido('orca-finished') &&
    doc.getElementById('orca-cap').value === '6' &&
    !doc.getElementById('orca-notices-card').classList.contains('sin-leer'),
    `${encendido('orca-waiting')} ${encendido('orca-finished')} ${doc.getElementById('orca-cap').value}`)
  doc.getElementById('orca-waiting').click()
  doc.getElementById('save-orca').click()
  await new Promise((r) => setTimeout(r, 500))
  const propios = storage.ajustesPorLinea[L_B]
  ok('guardar en la otra linea escribe los avisos en lo de ESA linea',
    propios.orcaNotices && propios.orcaNotices.waiting === 'on' &&
    propios.orcaNotices.finished === 'off' && propios.agentName === 'Agente Segunda',
    JSON.stringify(propios))
  ok('y la raiz queda intacta', JSON.stringify(storage.orcaNotices) === JSON.stringify(ORCA_A),
    JSON.stringify(storage.orcaNotices))
  ok('y la tarjeta queda mostrando lo guardado', encendido('orca-waiting') && !encendido('orca-finished') &&
    /Guardado/.test(textoDe(doc, '#said-orca')), textoDe(doc, '#said-orca'))
  elegirSeg(doc, 'linea-vista', L_A)
  await new Promise((r) => setTimeout(r, 400))
  ok('volver a la principal muestra otra vez los de la raiz',
    encendido('orca-waiting') && encendido('orca-finished') &&
    doc.getElementById('orca-cap').value === '4', doc.getElementById('orca-cap').value)
}

// ───────── todo-por-linea P2: firmar con el nombre del agente, por linea ─────────
// Un interruptor encima del nombre. Apagado, los mensajes de esa linea salen como del dueno:
// el nombre deja de ser obligatorio y la lista de lo que falta no lo pide.
console.log('\nconfig.html — P2: la firma de cada linea')
{
  const storage = dosLineasConAjustes()
  storage.agentName = ''
  storage.ajustesPorLinea[L_B].agentName = ''
  const { doc } = await montar('config.html', storage, 'es-419')
  await espera()
  doc.getElementById('tab-agente').click()
  await new Promise((r) => setTimeout(r, 300))
  const firma = doc.getElementById('sign-messages')
  const encendida = () => firma.getAttribute('aria-checked') === 'true'
  const agente = () => doc.querySelector('#checklist [data-item="agente"]')?.getAttribute('data-ok')
  ok('el interruptor va encima del nombre, encendido de fabrica, con su texto',
    firma && firma.getAttribute('role') === 'switch' && encendida() &&
    !!(firma.compareDocumentPosition(doc.getElementById('agent')) &
      doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING) &&
    textoDe(doc, '#sign-messages-label') === 'Firmar los mensajes con el nombre del agente',
    textoDe(doc, '#sign-messages-label'))
  ok('con la firma encendida, sin nombre la lista de lo que falta lo pide', agente() === 'false', agente())
  doc.getElementById('save-agent').click()
  await new Promise((r) => setTimeout(r, 300))
  ok('y sin nombre no se guarda', textoDe(doc, '#said-agent') === 'Ponga un nombre.' &&
    !('signMessages' in storage), textoDe(doc, '#said-agent'))

  elegirSeg(doc, 'linea-vista', L_B)
  await new Promise((r) => setTimeout(r, 400))
  ok('en la otra linea, sin firma propia, encendida', encendida())
  firma.click()
  ok('apagarla dice que los mensajes salen como suyos',
    !encendida() && /como si los escribiera usted/.test(textoDe(doc, '#sign-help')),
    textoDe(doc, '#sign-help'))
  doc.getElementById('save-agent').click()
  await new Promise((r) => setTimeout(r, 500))
  const propios = storage.ajustesPorLinea[L_B]
  ok('con la firma apagada se guarda sin nombre, en lo de ESA linea',
    propios.signMessages === 'off' && propios.agentName === '' && !('signMessages' in storage) &&
    /Guardado/.test(textoDe(doc, '#said-agent')), JSON.stringify(propios) + textoDe(doc, '#said-agent'))
  ok('y la lista de lo que falta ya no pide el nombre', agente() === 'true', agente())
  firma.click()
  doc.getElementById('save-agent').click()
  await new Promise((r) => setTimeout(r, 300))
  ok('volver a encenderla sin nombre no se guarda', propios.signMessages === 'off' &&
    textoDe(doc, '#said-agent') === 'Ponga un nombre.', textoDe(doc, '#said-agent'))

  elegirSeg(doc, 'linea-vista', L_A)
  await new Promise((r) => setTimeout(r, 400))
  ok('la principal sigue firmando', encendida() && agente() === 'false', agente())
  const S = doc.defaultView.STRINGS
  ok('las frases existen en los tres idiomas, el portugues propio',
    ['signLabel', 'signHelp'].every((k) => S.es[k] && S.en[k] && S.pt[k] && S.pt[k] !== S.en[k]) &&
    S.en.signLabel === "Sign messages with the agent's name")
}

// ───────── todo-por-linea P3: la cuenta de Claude del bot, por linea ─────────
console.log('\nconfig.html — P3: la cuenta de Claude del bot de cada linea')
{
  const storage = dosLineasConAjustes()
  storage.botClaudeAccount = 'cuenta-bot'
  storage.ajustesPorLinea[L_B].botClaudeAccount = 'cuenta-sin'
  const CUENTAS = [
    { id: 'cuenta-bot', email: 'bot@example.invalid', authenticated: true, active: false, used: 20 },
    { id: 'cuenta-sin', email: 'sin@example.invalid', authenticated: true, active: false, used: 5 }]
  const gancho = (d, st) => {
    if (!(d.action === 'storage.set' && d.params.key === 'scopeRequest' && d.params.value)) {
      return undefined
    }
    const p = d.params.value
    st.scopeRequest = p
    st.scopeResult = { at: new Date().toISOString(), requestId: p.id, action: p.action, ok: true,
      code: 'cuentas', accounts: CUENTAS }
    return { ok: true }
  }
  const { doc } = await montar('config.html', storage, 'es-419', gancho)
  await espera()
  doc.getElementById('tab-agente').click()
  await hastaPanel(() => doc.querySelectorAll('#bot-account button').length > 2)
  ok('en la principal, la cuenta de la raiz', valorSeg(doc, 'bot-account') === 'cuenta-bot',
    valorSeg(doc, 'bot-account'))
  elegirSeg(doc, 'linea-vista', L_B)
  await hastaPanel(() => valorSeg(doc, 'bot-account') === 'cuenta-sin')
  ok('en la otra linea, la de ESA linea', valorSeg(doc, 'bot-account') === 'cuenta-sin',
    valorSeg(doc, 'bot-account'))
  elegirSeg(doc, 'bot-account', 'auto')
  doc.getElementById('save-bot-account').click()
  await new Promise((r) => setTimeout(r, 500))
  ok('guardar en la otra linea la guarda en lo de ESA linea, sin tocar la raiz',
    storage.ajustesPorLinea[L_B].botClaudeAccount === 'auto' && storage.botClaudeAccount === 'cuenta-bot',
    JSON.stringify({ b: storage.ajustesPorLinea[L_B].botClaudeAccount, raiz: storage.botClaudeAccount }))
  elegirSeg(doc, 'linea-vista', L_A)
  await hastaPanel(() => valorSeg(doc, 'bot-account') === 'cuenta-bot')
  ok('volver a la principal muestra otra vez la suya', valorSeg(doc, 'bot-account') === 'cuenta-bot',
    valorSeg(doc, 'bot-account'))
}

// ───────── todo-por-linea P4: la transcripcion y su calidad, por linea ─────────
console.log('\nconfig.html — P4: la transcripcion de cada linea')
{
  const storage = dosLineasConAjustes()
  storage.transcribe = 'local'
  storage.transcribeQuality = 'optima'
  storage.ajustesPorLinea[L_B].transcribe = 'off'
  storage.ajustesPorLinea[L_B].transcribeQuality = 'minima'
  const { doc } = await montar('config.html', storage, 'es-419')
  await espera()
  doc.getElementById('tab-avanzado').click()
  await espera()
  ok('en la principal, la transcripcion de la raiz',
    valorSeg(doc, 'transcribe') === 'local' && valorSeg(doc, 'quality') === 'optima',
    `${valorSeg(doc, 'transcribe')} ${valorSeg(doc, 'quality')}`)
  elegirSeg(doc, 'linea-vista', L_B)
  await new Promise((r) => setTimeout(r, 400))
  ok('en la otra linea, la de ESA linea',
    valorSeg(doc, 'transcribe') === 'off' && valorSeg(doc, 'quality') === 'minima',
    `${valorSeg(doc, 'transcribe')} ${valorSeg(doc, 'quality')}`)
  elegirSeg(doc, 'quality', 'optima')
  doc.getElementById('save-voice').click()
  await new Promise((r) => setTimeout(r, 500))
  const propios = storage.ajustesPorLinea[L_B]
  ok('guardar la voz en la otra linea la guarda en lo de ESA linea, sin tocar la raiz',
    propios.transcribe === 'off' && propios.transcribeQuality === 'optima' &&
    storage.transcribe === 'local' && storage.transcribeQuality === 'optima' &&
    propios.transcribeLang === 'en', JSON.stringify(propios))
  ok('y la tarjeta de voz ya no dice que vale para todas las lineas',
    doc.querySelectorAll('#voice-card .nota-maquina').length === 0)
  elegirSeg(doc, 'linea-vista', L_A)
  await new Promise((r) => setTimeout(r, 400))
  ok('volver a la principal muestra otra vez la suya',
    valorSeg(doc, 'transcribe') === 'local' && valorSeg(doc, 'quality') === 'optima')
}

// ───────── P9: las reglas de texto y el catalogo de proyectos, de cada linea ─────────
// La principal los guarda en la raiz (`routes`, `projects`); cada otra linea, en
// `ajustesPorLinea[<numero>]`. Lo que se pide al worker nombra la linea que se mira.
console.log('\nconfig.html — P9: cada linea muestra y guarda sus reglas y sus proyectos')
{
  const ALFA = { id: 'alfa-demo', name: 'Alfa Demo', path: '/srv/ejemplo/alfa-demo', note: '' }
  const BETA = { id: 'beta-demo', name: 'Beta Demo', path: '/srv/ejemplo/beta-demo', note: '' }
  const storage = dosLineasConAjustes()
  storage.routes = [{ pattern: 'acme', workspace: 'alfa-demo' }]
  storage.projects = [ALFA]
  Object.assign(storage.ajustesPorLinea[L_B], {
    routes: [{ pattern: 'ventas', workspace: 'beta-demo' }], projects: [BETA] })
  const pedidos = []
  const { doc } = await montar('config.html', storage, 'es-419', (d, st) => {
    if (!(d.action === 'storage.set' && d.params.key === 'scopeRequest' && d.params.value)) {
      return undefined
    }
    const p = d.params.value
    pedidos.push(p)
    st.scopeRequest = p
    st.scopeResult = { at: new Date().toISOString(), requestId: p.id, action: p.action, ok: true,
      code: p.action === 'regla-quitar' ? 'regla-quitada' : 'quitado' }
    return { ok: true }
  })
  await espera()
  const reglas = () => textoDe(doc, '#routes-wrap')
  const catalogo = () => textoDe(doc, '#projects-wrap')
  ok('en la principal se ven sus reglas y sus proyectos',
    /acme/.test(reglas()) && !/ventas/.test(reglas()) && /Alfa Demo/.test(catalogo()) &&
    !/Beta Demo/.test(catalogo()), `${reglas()} | ${catalogo()}`)
  elegirSeg(doc, 'linea-vista', L_B)
  await new Promise((r) => setTimeout(r, 300))
  ok('en la otra linea se ven las reglas y los proyectos de ESA linea',
    /ventas/.test(reglas()) && !/acme/.test(reglas()) && /Beta Demo/.test(catalogo()) &&
    !/Alfa Demo/.test(catalogo()), `${reglas()} | ${catalogo()}`)
  ok('el selector de proyecto de una regla ofrece el catalogo de ESA linea',
    proyectosOfrecidos(doc, 'r-workspace').join() === 'beta-demo',
    proyectosOfrecidos(doc, 'r-workspace').join())
  ok('y el de las conversaciones tambien',
    proyectosOfrecidos(doc, 'workspace').filter(Boolean).join() === 'beta-demo',
    proyectosOfrecidos(doc, 'workspace').join())

  doc.getElementById('tab-chats').click()
  await espera()
  doc.getElementById('r-match').value = 'factura'
  elegirProyecto(doc, 'r-workspace', 'beta-demo')
  doc.getElementById('save-route').click()
  await new Promise((r) => setTimeout(r, 300))
  const propias = () => storage.ajustesPorLinea[L_B]
  ok('agregar una regla en la otra linea la guarda solo en lo de ESA linea',
    (propias().routes || []).map((r) => r.pattern).join() === 'factura,ventas' &&
    storage.routes.map((r) => r.pattern).join() === 'acme' &&
    propias().agentName === 'Agente Segunda', JSON.stringify({ propias: propias().routes, raiz: storage.routes }))
  ok('y la tabla la muestra', /factura/.test(reglas()), reglas())

  doc.querySelector('#routes-wrap [data-rrm]').click()
  await new Promise((r) => setTimeout(r, 300))
  const quitar = pedidos.find((p) => p.action === 'regla-quitar')
  ok('quitar una regla en la otra linea se le pide al worker en ESA linea',
    quitar?.linea === L_B && quitar?.pattern === 'factura', JSON.stringify(quitar))
  doc.querySelector('#projects-wrap [data-prm="beta-demo"]').click()
  await new Promise((r) => setTimeout(r, 300))
  const sacar = pedidos.find((p) => p.action === 'proyectos-quitar')
  ok('y quitar un proyecto tambien', sacar?.linea === L_B && sacar?.project === 'beta-demo',
    JSON.stringify(sacar))

  elegirSeg(doc, 'linea-vista', L_A)
  await new Promise((r) => setTimeout(r, 300))
  ok('volver a la principal muestra otra vez las suyas',
    /acme/.test(reglas()) && !/ventas/.test(reglas()) && /Alfa Demo/.test(catalogo()),
    `${reglas()} | ${catalogo()}`)
  doc.querySelector('#projects-wrap [data-prm="alfa-demo"]').click()
  await new Promise((r) => setTimeout(r, 300))
  const enLaPrincipal = pedidos.filter((p) => p.action === 'proyectos-quitar').pop()
  ok('en la principal el pedido no nombra linea',
    enLaPrincipal?.project === 'alfa-demo' && !enLaPrincipal.linea, JSON.stringify(enLaPrincipal))
}

console.log('\nactivity.html — respuesta-otro-chat: la propuesta dice a que chat va')
{
  const aOtro = tarjeta({ case_id: 21, exceptions: [],
    proposal: { tipo: 'responder', texto: 'Le comparto la conclusion.', version: 'abc',
      destino: { chat_jid: '120363000000000004@g.us', chat_name: 'Grupo Facturacion Demo' } },
    events: [{ de: 'decision', a: 'decision', actor: 'regla', que: 'reply_waits',
      args: ['other_chat'], at: hace(5 * 60000) }] })
  const propio = tarjeta({ case_id: 22, exceptions: [] })
  for (const [idioma, va, motivo] of [['es-419', /Va a: Grupo Facturacion Demo/, /otro chat/],
    ['en-US', /Goes to: Grupo Facturacion Demo/, /another chat/]]) {
    const { doc } = await abrirTablero({ board: tablero([aOtro, propio]) }, idioma)
    const card = doc.querySelector('.card[data-case="21"]')
    ok(`${idioma}: la tarjeta dice a que chat va antes de Enviar`,
      va.test(card.textContent) && !!card.querySelector('.card-destino'), card.textContent)
    ok(`${idioma}: la que va a su propio chat no lo dice`,
      !doc.querySelector('.card[data-case="22"] .card-destino'))
    const det = abrirDetalle(doc, 21)
    ok(`${idioma}: el detalle tambien`, va.test(det.querySelector('.det-prop')?.textContent || ''),
      det.textContent)
    const filas = [...det.querySelectorAll('.det-hist li')].map((li) => li.textContent)
    ok(`${idioma}: y la historia dice por que espera en palabras`,
      filas.some((f) => motivo.test(f)) && !filas.some((f) => /other_chat/.test(f)),
      JSON.stringify(filas))
  }
}

// ───────── guardar-panel G1: Guardar en una conversacion no dice guardado sin serlo ─────────
// Medido en la maquina del dueno: unas instrucciones largas nunca llegaron al storage y
// el panel dijo "✓ Guardado" y vacio el formulario. El host contesta `{ ok: false }`
// (limite, cola vencida, error propio) y el panel no miraba la respuesta.
console.log('\nconfig.html — guardar-panel G1: un Guardar rechazado lo dice y conserva lo escrito')
{
  const largo = 'Instrucciones de prueba. '.repeat(700).trim()
  for (const [idioma, frase] of [['es-419', /No se guardo/], ['en-US', /was not saved/]]) {
    let intentos = 0
    const { doc, storage } = await montar('config.html', {
      chats: [{ jid: '1@g.us', name: 'Soporte Norte', kind: 'grupo' }]
    }, idioma, (d) => {
      if (d.action === 'storage.set' && d.params.key === 'scope') {
        intentos += 1
        return { ok: false, error: 'host failed' }
      }
      return undefined
    })
    await espera()
    elegirChat(doc, '1@g.us')
    doc.getElementById('chat-instructions').value = largo
    doc.getElementById('save-scope').click()
    await new Promise((r) => setTimeout(r, 2500))
    const dijo = doc.getElementById('said-scope')
    ok(`${idioma}: un Guardar que el host rechazo no dice guardado`,
      !dijo.textContent.includes('✓') && frase.test(dijo.textContent),
      JSON.stringify(dijo.textContent))
    ok(`${idioma}: el error queda marcado en rojo`, dijo.className.includes('bad'))
    ok(`${idioma}: se reintento antes de rendirse, con un tope`,
      intentos > 1 && intentos <= 4, `intentos = ${intentos}`)
    ok(`${idioma}: y el formulario conserva lo escrito`,
      doc.getElementById('chat-instructions').value === largo &&
      doc.getElementById('chat').value !== '',
      `instrucciones = ${doc.getElementById('chat-instructions').value.length} caracteres`)
    ok(`${idioma}: y no quedo nada escrito`, storage.scope === undefined,
      JSON.stringify(storage.scope))
  }
}
{
  // Un rechazo pasajero se reintenta solo: el segundo intento entra y recien ahi se dice.
  let intentos = 0
  const { doc, storage } = await montar('config.html', {
    chats: [{ jid: '1@g.us', name: 'Soporte Norte', kind: 'grupo' }]
  }, 'es-419', (d) => {
    if (d.action === 'storage.set' && d.params.key === 'scope') {
      intentos += 1
      if (intentos === 1) return { ok: false, error: 'host failed' }
    }
    return undefined
  })
  await espera()
  elegirChat(doc, '1@g.us')
  doc.getElementById('chat-instructions').value = 'Resuma lo que manden.'
  doc.getElementById('save-scope').click()
  await new Promise((r) => setTimeout(r, 2500))
  ok('un rechazo pasajero se reintenta y el segundo intento guarda',
    intentos === 2 && storage.scope && storage.scope['1@g.us'] &&
    storage.scope['1@g.us'].instructions === 'Resuma lo que manden.',
    `intentos = ${intentos} ${JSON.stringify(storage.scope)}`)
  ok('y recien entonces dice guardado',
    doc.getElementById('said-scope').textContent.includes('✓'),
    doc.getElementById('said-scope').textContent)
}
{
  // El host dice que si y el dato no queda: la relectura lo ve y el panel no miente.
  const { doc, storage } = await montar('config.html', {
    chats: [{ jid: '1@g.us', name: 'Soporte Norte', kind: 'grupo' }]
  }, 'es-419', (d) => {
    if (d.action === 'storage.set' && d.params.key === 'scope') return { ok: true, value: { ok: true } }
    return undefined
  })
  await espera()
  elegirChat(doc, '1@g.us')
  doc.getElementById('chat-instructions').value = 'Resuma lo que manden.'
  doc.getElementById('save-scope').click()
  await new Promise((r) => setTimeout(r, 2500))
  const dijo = doc.getElementById('said-scope')
  ok('un "si" del host que no dejo el dato no dice guardado',
    !dijo.textContent.includes('✓') && dijo.className.includes('bad') &&
    storage.scope === undefined, JSON.stringify(dijo.textContent))
  ok('y conserva lo escrito',
    doc.getElementById('chat-instructions').value === 'Resuma lo que manden.')
}

// linea-viva V5: una linea que nadie atiende se ve en el panel, en cualquier pestana, con
// cuanto lleva y si el respaldo del plugin la esta atendiendo. Viaja en el latido.
console.log('\nconfig.html — linea-viva: el aviso de una linea sin atender')
{
  const L1 = 'pn:15550000001'
  const L2 = 'pn:15550000002'
  // Cinco segundos de mas: con la hora redondeada, "hace 14 min" podia pintarse 13.
  const hace = (min) => Math.floor(Date.now() / 1000) - min * 60 - 5
  const latido = (lineas, extra = {}) => Object.assign({ at: new Date().toISOString(), lineas }, extra)
  const caja = (doc) => doc.getElementById('lineas-alerta')
  {
    const { doc } = await montar('config.html', { workerBeat: latido({
      [L1]: { desde: hace(25), motivo: 'sin-tick', respaldo: 'ok' } }) }, 'es-419')
    await espera()
    const txt = caja(doc).textContent
    ok('linea-viva: la linea sin atender se ve, con su numero y sus minutos',
      !caja(doc).hidden && /La linea \+15550000001 lleva 25 min sin atenderse/.test(txt), txt)
    ok('linea-viva: dice que el respaldo la esta atendiendo, y por que',
      /el respaldo del plugin la esta atendiendo/.test(txt) && /revision de cada minuto/.test(txt), txt)
    ok('linea-viva: va fuera de las pestanas, como el aviso general',
      !caja(doc).closest('[role="tabpanel"]') && !caja(doc).closest('section'), caja(doc).parentElement.className)
  }
  {
    const { doc } = await montar('config.html', { workerBeat: latido({
      [L1]: { desde: hace(14), motivo: 'sin-juzgar', respaldo: 'failed' },
      [L2]: { desde: hace(31), motivo: 'despacho-atascado', respaldo: null } }) }, 'es-419')
    await espera()
    const filas = caja(doc).querySelectorAll('.alert')
    const txt = caja(doc).textContent
    ok('linea-viva: una fila por linea afectada', filas.length === 2, String(filas.length))
    ok('linea-viva: el respaldo que no pudo se dice',
      /\+15550000001 lleva 14 min sin atenderse/.test(filas[0].textContent) &&
      /no pudo atenderla/.test(filas[0].textContent) && /sin revisar/.test(filas[0].textContent), filas[0].textContent)
    ok('linea-viva: el atasco de Orca dice que reiniciar Orca lo destraba',
      /\+15550000002 lleva 31 min/.test(txt) && /Reiniciar Orca/.test(filas[1].textContent), filas[1].textContent)
  }
  {
    const { doc } = await montar('config.html', { workerBeat: latido(undefined) }, 'es-419')
    await espera()
    ok('linea-viva: con todas las lineas atendidas no hay nada', caja(doc).hidden === true &&
      caja(doc).textContent === '', caja(doc).outerHTML)
  }
  {
    const viejo = { at: new Date(Date.now() - 120000).toISOString(),
      lineas: { [L1]: { desde: hace(25), motivo: 'sin-tick', respaldo: 'ok' } } }
    const { doc } = await montar('config.html', { workerBeat: viejo }, 'es-419')
    await espera()
    ok('linea-viva: con el worker callado no se afirma nada de las lineas (manda el aviso del worker)',
      caja(doc).hidden === true && !doc.getElementById('alert').hidden, caja(doc).outerHTML)
  }
  {
    const lineas = { [L1]: { desde: hace(25), motivo: 'sin-tick', respaldo: 'failed' } }
    const en = await montar('config.html', { workerBeat: latido(lineas) }, 'en-US')
    const pt = await montar('config.html', { workerBeat: latido(lineas) }, 'pt-BR')
    await espera()
    ok('linea-viva: en ingles', /Line \+15550000001 has not been attended for 25 min/.test(caja(en.doc).textContent) &&
      /could not attend it/.test(caja(en.doc).textContent), caja(en.doc).textContent)
    ok('linea-viva: en portugues', /A linha \+15550000001 esta ha 25 min sem atendimento/.test(caja(pt.doc).textContent),
      caja(pt.doc).textContent)
  }
  {
    // Un codigo que el panel no conoce no deja la fila vacia ni muestra el codigo crudo.
    const { doc } = await montar('config.html', { workerBeat: latido({
      [L1]: { desde: hace(12), motivo: 'otro-motivo', respaldo: 'raro' } }) }, 'es-419')
    await espera()
    const txt = caja(doc).textContent
    ok('linea-viva: un motivo desconocido igual dice la linea y no muestra codigos',
      /\+15550000001 lleva 12 min/.test(txt) && !/otro-motivo|raro/.test(txt), txt)
  }
}

console.log(`\n${pruebas - fallos}/${pruebas} en verde`)
process.exit(fallos ? 1 : 0)
