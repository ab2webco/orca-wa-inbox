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

// ───────────────────────── config.html ─────────────────────────
console.log('\nconfig.html')
{
  const { doc, storage } = await montar('config.html')

  // Mira la bajada, no un h1: config.html ya no tiene titulo propio porque el host
  // lo pinta. Comprobar el h1 ataba la prueba a un elemento que se podia quitar.
  ok('los textos se tradujeron', doc.querySelector('.sub').textContent.length > 0,
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

  // Para quien trabaja. No es el nombre del agente: es el del dueno, y el prompt lo
  // lee para saber a quien le reporta.
  doc.getElementById('owner').value = '  Fabiana Olivar  '
  doc.getElementById('save-owner').click()
  await espera()
  ok('guarda para quien trabaja', storage.ownerName === 'Fabiana Olivar',
    `storage.ownerName = ${JSON.stringify(storage.ownerName)}`)
  ok('confirma el dueno en pantalla',
    doc.getElementById('said-owner').textContent.includes('✓'))

  // Modo de transcripcion. Poder apagarla entera sin abrir una terminal es el punto.
  doc.getElementById('transcribe').value = 'off'
  doc.getElementById('save-transcribe').click()
  await espera()
  ok('guarda el modo de transcripcion', storage.transcribe === 'off',
    `storage.transcribe = ${JSON.stringify(storage.transcribe)}`)
  ok('confirma el modo en pantalla',
    doc.getElementById('said-transcribe').textContent.includes('✓'))

  doc.getElementById('lang').value = 'pt'
  doc.getElementById('save-lang').click()
  await espera()
  ok('guarda el idioma de los audios', storage.transcribeLang === 'pt',
    `storage.transcribeLang = ${JSON.stringify(storage.transcribeLang)}`)
  ok('confirma el idioma en pantalla',
    doc.getElementById('said-lang').textContent.includes('✓'))

  // La ventana de lectura. Era un tope escondido: solo se movia por terminal, asi que
  // desde el panel una mencion del viernes desaparecia el lunes sin explicacion.
  doc.getElementById('inbox-days').value = '30'
  doc.getElementById('save-days').click()
  await espera()
  ok('guarda la ventana de lectura', storage.inboxDays === '30',
    `storage.inboxDays = ${JSON.stringify(storage.inboxDays)}`)
  ok('confirma la ventana en pantalla',
    doc.getElementById('said-days').textContent.includes('✓'))

  // Cada cuanto se relee WhatsApp. Es lo que acota cuanto tarda un mensaje en llegarle
  // al agente: el precheck de las automations contesta con lo que dejo el ultimo sync,
  // asi que si esto no se pudiera cambiar el retraso seria una constante escondida.
  doc.getElementById('sync-minutes').value = '15'
  doc.getElementById('save-sync').click()
  await espera()
  ok('guarda cada cuanto revisa WhatsApp', storage.syncMinutes === '15',
    `storage.syncMinutes = ${JSON.stringify(storage.syncMinutes)}`)
  ok('confirma la frecuencia en pantalla',
    doc.getElementById('said-sync').textContent.includes('✓'))

  // Un select no puede ofrecer un valor que el CLI vaya a rechazar: si lo ofrece, el
  // panel dice guardado y `wa-scope` lo tira. Las listas se comprueban, no se confian.
  const opciones = (id) => [...doc.getElementById(id).options].map((o) => o.value)
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
  const permisos = [...doc.getElementById('mode').options].map((o) => o.textContent)
  ok('ningun permiso habla de tarjetas',
    permisos.every((txt) => !/tarjeta|cartao|card/i.test(txt)),
    `permisos = ${JSON.stringify(permisos)}`)
  ok('observar dice que solo lee',
    /solo lee|reads only|so le/i.test(permisos.find((txt) => /observ/i.test(txt)) || ''),
    `permisos = ${JSON.stringify(permisos)}`)

  // Mapear conversacion. Se elige de la lista, que es el unico camino real: el
  // registro se guarda por jid, no por el nombre visible.
  storage.chats = [
    { jid: '1@g.us', name: 'Soporte Norte', kind: 'grupo' },
    { jid: '2@g.us', name: 'Operaciones', kind: 'grupo' },
    { jid: '57300@s.whatsapp.net', name: 'Laura Mendez', kind: 'directo' }
  ]
  doc.defaultView.dispatchEvent(new doc.defaultView.Event('focus'))
  await espera()
  doc.getElementById('chat-pick').value = '1@g.us'
  doc.getElementById('chat-pick').dispatchEvent(new doc.defaultView.Event('change'))
  await espera()
  ok('elegir de la lista llena el nombre de la conversacion',
    doc.getElementById('chat').value === 'Soporte Norte',
    `chat = ${JSON.stringify(doc.getElementById('chat').value)}`)
  ok('una conversacion nueva arranca sin servicio de tareas',
    doc.getElementById('provider').value === 'ninguno',
    `provider = ${doc.getElementById('provider').value}`)
  doc.getElementById('provider').value = 'linear'
  doc.getElementById('target').value = 'ENG'
  doc.getElementById('mode').value = 'borrador'
  doc.getElementById('chat-instructions').value = 'Resuma lo que manden y aviseme.'
  doc.getElementById('save-scope').click()
  await espera()
  const entrada = (storage.scope || {})['1@g.us']
  // Por jid y no por nombre: es la llave que lee `wa-scope`, y hay grupos homonimos.
  ok('guarda la conversacion con el jid como llave', !!entrada,
    `storage.scope = ${JSON.stringify(storage.scope)}`)
  ok('guarda el nombre visible junto al jid', entrada && entrada.chatName === 'Soporte Norte')
  ok('guarda proveedor, destino y permiso',
    entrada && entrada.provider === 'linear' && entrada.target === 'ENG' && entrada.mode === 'borrador')
  // Las instrucciones son el QUE hace en esa conversacion. Si no se guardan con ella,
  // el campo esta de adorno y el agente nunca las lee.
  ok('guarda las instrucciones de la conversacion',
    entrada && entrada.instructions === 'Resuma lo que manden y aviseme.',
    `instructions = ${JSON.stringify(entrada && entrada.instructions)}`)
  ok('confirma y limpia el formulario',
    doc.getElementById('said-scope').textContent.includes('Soporte Norte') &&
    doc.getElementById('chat').value === '' &&
    doc.getElementById('chat-instructions').value === '')
  ok('la tabla muestra lo guardado',
    doc.getElementById('scope-wrap').textContent.includes('Soporte Norte'))

  // "ninguno" tiene que dejar el destino inservible A LA VISTA. Un campo que sigue
  // pareciendo editable pero que nadie mira es el mismo defecto que un boton muerto.
  const destino = doc.getElementById('target')
  const pista = doc.getElementById('target-hint')
  doc.getElementById('provider').value = 'plane'
  doc.getElementById('provider').dispatchEvent(new doc.defaultView.Event('change'))
  await espera()
  const pistaConTablero = pista.textContent
  destino.value = 'OPS'
  ok('con un servicio de tareas el destino se puede escribir', !destino.disabled)
  doc.getElementById('provider').value = 'ninguno'
  doc.getElementById('provider').dispatchEvent(new doc.defaultView.Event('change'))
  await espera()
  ok('ninguno apaga el destino', destino.disabled)
  ok('ninguno vacia el destino', destino.value === '', `target = ${JSON.stringify(destino.value)}`)
  ok('ninguno cambia la pista del destino',
    pista.textContent.length > 0 && pista.textContent !== pistaConTablero)
  // Un hecho en un solo lugar: la pista del proveedor habla de tarjetas, el permiso
  // habla de escribir. Cuando la pista contaba los dos, los dos se contradecian.
  ok('la pista del proveedor no describe el permiso',
    !/permiso|permission|permissao/i.test(pista.textContent),
    `pista = ${JSON.stringify(pista.textContent)}`)

  // Buscador de conversaciones. Con 200 conversaciones un select nativo no se
  // navega, asi que el filtro es parte de que el control sirva, no un adorno.
  if (doc.getElementById('chat-search')) {
    doc.getElementById('chat-search').value = 'laura'
    doc.getElementById('chat-search').dispatchEvent(new doc.defaultView.Event('input'))
    await espera()
    const opciones = [...doc.getElementById('chat-pick').options].map((o) => o.textContent)
    ok('el buscador filtra la lista',
      opciones.some((t) => t.includes('Laura')) && !opciones.some((t) => t.includes('Operaciones')),
      `opciones = ${JSON.stringify(opciones)}`)
    ok('dice cuantas quedaron', /\d+\s+(de|of)\s+\d+/.test(doc.getElementById('chat-count').textContent),
      `chat-count = ${JSON.stringify(doc.getElementById('chat-count').textContent)}`)
    doc.getElementById('chat-search').value = 'zzzz'
    doc.getElementById('chat-search').dispatchEvent(new doc.defaultView.Event('input'))
    await espera()
    ok('avisa cuando nada coincide',
      doc.getElementById('chat-pick').options.length === 1 &&
      doc.getElementById('chat-pick').options[0].textContent.length > 0)
    doc.getElementById('chat-search').value = ''
    doc.getElementById('chat-search').dispatchEvent(new doc.defaultView.Event('input'))
    await espera()
    ok('al limpiar el buscador vuelven todas',
      doc.getElementById('chat-pick').options.length > 1)
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
    /Buscando|Looking|Procurando/.test(buscando.doc.getElementById('chat-pick').textContent) &&
    buscando.doc.getElementById('sync-state').hidden,
    `chat-pick = ${JSON.stringify(buscando.doc.getElementById('chat-pick').textContent)}`)

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
    [...conFoco.doc.getElementById('chat-pick').options].some((o) => o.textContent.includes('Laura')),
    `chat-pick = ${JSON.stringify([...conFoco.doc.getElementById('chat-pick').options].map((o) => o.textContent))}`)

  // Y lo que el usuario ya habia tecleado no se pierde en la recarga.
  conFoco.doc.getElementById('chat-search').value = 'laura'
  conFoco.doc.getElementById('chat-search').dispatchEvent(new conFoco.window.Event('input'))
  await espera()
  conFoco.window.dispatchEvent(new conFoco.window.Event('focus'))
  await espera()
  const trasRecarga = [...conFoco.doc.getElementById('chat-pick').options].map((o) => o.textContent)
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
  ok('Editar devuelve el destino a editable cuando hay servicio de tareas',
    !doc.getElementById('target').disabled && doc.getElementById('target').value === 'ENG')
  // El input #chat esta oculto: comprobarlo solo dejaba pasar el caso real, en el que
  // el select visible se quedaba en "Elija una conversacion".
  ok('Editar deja el select visible en esa conversacion',
    doc.getElementById('chat-pick').value === '1@g.us',
    `chat-pick = ${JSON.stringify(doc.getElementById('chat-pick').value)}`)
  ok('Editar cambia el boton a guardar cambios',
    doc.getElementById('save-scope').textContent.toLowerCase().includes('cambio') ||
    doc.getElementById('save-scope').textContent.toLowerCase().includes('change'))
  doc.getElementById('cancel-edit').click()
  await espera()
  ok('Cancelar edicion limpia',
    doc.getElementById('chat').value === '' &&
    doc.getElementById('chat-instructions').value === '' &&
    doc.getElementById('provider').value === 'ninguno')

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
  ok('carga la calidad guardada', calidad.doc.getElementById('quality').value === 'minima',
    `quality = ${calidad.doc.getElementById('quality').value}`)
  const sinCalidad = await montar('config.html', {})
  await espera()
  ok('sin nada guardado la calidad queda en optima',
    sinCalidad.doc.getElementById('quality').value === 'optima')

  // Guardar sin recargar es media funcion: el panel abre mintiendo sobre lo que rige.
  const guardado = await montar('config.html', {
    inboxDays: '90', ownerName: 'Fabiana Olivar', transcribe: 'off', transcribeLang: 'pt'
  })
  await espera()
  ok('recarga la ventana guardada',
    guardado.doc.getElementById('inbox-days').value === '90',
    `inbox-days = ${guardado.doc.getElementById('inbox-days').value}`)
  ok('recarga para quien trabaja',
    guardado.doc.getElementById('owner').value === 'Fabiana Olivar',
    `owner = ${JSON.stringify(guardado.doc.getElementById('owner').value)}`)
  ok('recarga el modo de transcripcion',
    guardado.doc.getElementById('transcribe').value === 'off',
    `transcribe = ${guardado.doc.getElementById('transcribe').value}`)
  ok('recarga el idioma de los audios',
    guardado.doc.getElementById('lang').value === 'pt',
    `lang = ${guardado.doc.getElementById('lang').value}`)

  const guardadoSync = await montar('config.html', { syncMinutes: '30' })
  await espera()
  ok('recarga la frecuencia guardada',
    guardadoSync.doc.getElementById('sync-minutes').value === '30',
    `sync-minutes = ${guardadoSync.doc.getElementById('sync-minutes').value}`)

  const porDefecto = await montar('config.html', {})
  await espera()
  // 7 y no 1: una mencion del viernes tiene que seguir a la vista el lunes.
  ok('sin nada guardado la ventana queda en 7 dias',
    porDefecto.doc.getElementById('inbox-days').value === '7',
    `inbox-days = ${porDefecto.doc.getElementById('inbox-days').value}`)
  ok('sin nada guardado transcribe en local',
    porDefecto.doc.getElementById('transcribe').value === 'local')
  ok('sin nada guardado el idioma se detecta',
    porDefecto.doc.getElementById('lang').value === 'auto')
  ok('sin nada guardado el dueno queda vacio',
    porDefecto.doc.getElementById('owner').value === '')
  // 5 y no 1: un minuto convertiria el sync en el problema que vino a arreglar.
  ok('sin nada guardado revisa WhatsApp cada 5 minutos',
    porDefecto.doc.getElementById('sync-minutes').value === '5',
    `sync-minutes = ${porDefecto.doc.getElementById('sync-minutes').value}`)

  // La terminal puede fijar un valor que el select no ofrece (`config inbox_days 45`).
  // Si el select lo ignora queda en blanco y el panel miente sobre lo que rige: peor
  // que mostrar un valor raro es mostrar ninguno.
  const aMano = await montar('config.html', { inboxDays: '45' })
  await espera()
  ok('un valor puesto por terminal se ve en vez de dejar el select en blanco',
    aMano.doc.getElementById('inbox-days').value === '45',
    `inbox-days = ${JSON.stringify(aMano.doc.getElementById('inbox-days').value)}`)
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
    running: false,
    pending: [
      { stanzaId: 'S1', date: '2026-09-17 12:06', chat: 'Soporte Acme', sender: 'Ana',
        kind: 'mencion', text: 'necesito el reporte', hasMedia: true },
      { stanzaId: 'S2', date: '2026-09-17 11:00', chat: 'Soporte Acme', sender: 'Beto',
        kind: 'directo', text: 'hola', hasMedia: false }
    ],
    recent: [{ ts: '2026-09-17 11:30', chat: 'Soporte Acme', action: 'issue',
      issue: 'ACM-1', detail: 'reporte mensual' },
    // El cierre que no se avisa por permiso no deja rastro en el chat: este renglon
    // es el UNICO lugar donde el dueno se entera de que la tarjeta se cerro y su
    // cliente no lo supo. Si el panel no lo pinta, la decision es invisible.
    { ts: '2026-09-17 11:40', chat: 'Andes QA', action: 'skipped',
      issue: 'AND-7', detail: 'AND-7 · observar · Andes QA' }]
  }
  const { doc, storage } = await montar('activity.html', { activity: actividad })

  ok('los textos se tradujeron', doc.querySelector('h1').textContent.length > 0)
  ok('lista los pendientes', doc.getElementById('pending').textContent.includes('necesito el reporte'))
  ok('marca los que traen imagen', doc.getElementById('pending').textContent.toLowerCase().includes('imagen') ||
    doc.getElementById('pending').textContent.toLowerCase().includes('image'))
  ok('muestra lo ultimo que hizo', doc.getElementById('recent').textContent.includes('ACM-1'))
  ok('muestra el cierre que no se aviso por permiso',
    doc.getElementById('recent').textContent.includes('AND-7') &&
    doc.getElementById('recent').textContent.includes('observar'),
    doc.getElementById('recent').textContent.slice(0, 200))
  ok('muestra el sello de sincronizacion', doc.getElementById('synced').textContent.length > 0)
  // Tomar no abre tarjeta por si mismo: eso lo decide el servicio de tareas de esa
  // conversacion. Prometerla aca era la misma contradiccion que en los permisos.
  ok('la pista de actividad no promete una tarjeta',
    !/tarjeta|cartao|card/i.test(doc.querySelector('[data-t="hint"]').textContent),
    doc.querySelector('[data-t="hint"]').textContent)

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
  ok('lo sano dice sobre cuantas reviso y que no habia nada',
    /3 conversaciones/.test(linea(sano.doc)) && /nada pendiente/.test(linea(sano.doc)),
    linea(sano.doc))

  // Y con trabajo, el mismo renglon dice cuanto.
  const conTrabajo = await montar('activity.html', {
    activity: { ...base, run: { state: 'ok', startedAt: AHORA, endedAt: AHORA,
      looked: 3, pending: 2, reason: null } }
  }, 'es-419')
  await espera()
  ok('con trabajo dice cuantas quedaron esperando',
    /2 esperando/.test(linea(conTrabajo.doc)), linea(conTrabajo.doc))

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
  ok('con todo en off la lista vacia lo dice',
    /3 conversaciones/.test(todoOff.doc.getElementById('pending').textContent) &&
    /off/.test(todoOff.doc.getElementById('pending').textContent),
    todoOff.doc.getElementById('pending').textContent.trim())

  // Y ninguna registrada tampoco es lo mismo que "nada pendiente".
  const sinRegistro = await montar('activity.html', {
    activity: { ...base, mapped: 0, authorized: 0,
      run: { state: 'never', startedAt: null, endedAt: null, looked: null,
        pending: null, reason: null } }
  }, 'es-419')
  await espera()
  ok('sin ninguna conversacion registrada lo dice distinto',
    /no ha autorizado/i.test(sinRegistro.doc.getElementById('pending').textContent),
    sinRegistro.doc.getElementById('pending').textContent.trim())

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
  for (const [locale, esperado] of [['en-US', /Checked 3 conversations/],
    ['pt-BR', /Revisou 3 conversas/]]) {
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
    /all of them are off/i.test(offEn.doc.getElementById('pending').textContent),
    offEn.doc.getElementById('pending').textContent.trim())
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
    alertaEs.includes('Escanee el codigo de aca arriba') &&
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

  const actividad = {
    syncedAt: '2026-09-17 14:02', running: false,
    pending: [{ stanzaId: 'K1', date: '2026-09-17 13:58', chat: 'Soporte', sender: 'Ana',
      kind: 'mencion', text: 'el reporte', hasMedia: false }],
    recent: [{ ts: '2026-09-17 13:52', chat: 'Soporte', action: 'closed',
      issue: 'SOP-1', detail: '' }]
  }
  const actEs = await montar('activity.html', { activity: actividad }, 'es-419')
  await espera()
  ok('el tipo de mensaje se dice en espanol',
    actEs.doc.getElementById('pending').textContent.includes('mencion'),
    actEs.doc.getElementById('pending').textContent)
  ok('y la accion de la bitacora tambien',
    actEs.doc.getElementById('recent').textContent.includes('cierre avisado'),
    actEs.doc.getElementById('recent').textContent)

  const actEn = await montar('activity.html', { activity: actividad }, 'en-US')
  await espera()
  ok('en ingles, mention y closing announced',
    actEn.doc.getElementById('pending').textContent.includes('mention') &&
    actEn.doc.getElementById('recent').textContent.includes('closing announced'),
    actEn.doc.getElementById('recent').textContent)

  const actPt = await montar('activity.html', { activity: actividad }, 'pt-BR')
  await espera()
  ok('en portugues, mencao y fecho avisado',
    actPt.doc.getElementById('pending').textContent.includes('mencao') &&
    actPt.doc.getElementById('recent').textContent.includes('fecho avisado'),
    actPt.doc.getElementById('recent').textContent)

  const actRaro = await montar('activity.html', {
    activity: { syncedAt: '2026-09-17 14:02', running: false,
      pending: [{ stanzaId: 'K2', date: '2026-09-17 13:00', chat: 'Soporte',
        sender: 'Ana', kind: 'todavia-no-existe', text: 'x', hasMedia: false }],
      recent: [{ ts: '2026-09-17 13:00', chat: 'Soporte', action: 'tampoco-existe',
        issue: null, detail: '' }] }
  }, 'es-419')
  await espera()
  ok('un kind o un action nuevos se pintan tal cual y no desaparecen',
    actRaro.doc.getElementById('pending').textContent.includes('todavia-no-existe') &&
    actRaro.doc.getElementById('recent').textContent.includes('tampoco-existe'))
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
  wa('config', 'owner_name', 'Fabiana Olivar')
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
    panel.doc.getElementById('scope-wrap').textContent.includes('SOP'),
    panel.doc.getElementById('scope-wrap').textContent.slice(0, 200))
  ok('el panel recarga los ajustes que escribio el CLI',
    panel.doc.getElementById('inbox-days').value === '30' &&
    panel.doc.getElementById('transcribe').value === 'off' &&
    panel.doc.getElementById('lang').value === 'pt' &&
    panel.doc.getElementById('owner').value === 'Fabiana Olivar',
    `${panel.doc.getElementById('inbox-days').value} / ` +
    `${panel.doc.getElementById('transcribe').value} / ` +
    `${panel.doc.getElementById('lang').value}`)
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
  ok('al soltar el lock, el panel dice sobre cuantas reviso y que encontro',
    /1 conversacion/.test(lineaOk) && /nada pendiente|esperando/.test(lineaOk),
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
    /off/.test(apagada.doc.getElementById('pending').textContent),
    apagada.doc.getElementById('pending').textContent.trim())
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
  doc.getElementById('inbox-days').value = '30'
  doc.getElementById('save-days').click()
  await espera()
  await espera()
  const dijo = doc.getElementById('said-days').textContent
  ok('un ajuste que no se pudo guardar no dice guardado',
    !dijo.includes('\u2713'), `dijo ${JSON.stringify(dijo)}`)
  ok('el error queda marcado en rojo',
    doc.getElementById('said-days').className.includes('bad'))
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
  doc.getElementById('inbox-days').value = '30'
  doc.getElementById('inbox-days').dispatchEvent(new window.Event('change'))
  demora = 0
  doc.getElementById('save-days').focus()            // lo que hace el clic en Chromium
  doc.getElementById('save-days').click()
  await new Promise((r) => setTimeout(r, 700))       // aterriza la pintura del sondeo
  ok('un sondeo que leyo antes del guardado no repinta el valor viejo encima',
    storage.inboxDays === '30' && doc.getElementById('inbox-days').value === '30',
    `guardado = ${storage.inboxDays}, select = ${doc.getElementById('inbox-days').value}`)
}

{
  // Y la otra mitad: el repintado que llega ANTES del clic. Ahi no hay guardado que
  // proteger todavia, y el boton termina mandando el valor que el usuario ya no ve.
  const storage = { inboxDays: '7' }
  const { window, doc } = await montar('config.html', storage, 'es-419')
  doc.getElementById('inbox-days').value = '30'
  doc.getElementById('inbox-days').dispatchEvent(new window.Event('change'))
  doc.getElementById('inbox-days').blur()            // mira otra cosa antes de guardar
  window.dispatchEvent(new window.Event('focus'))
  await espera(); await espera()
  ok('un select cambiado y sin guardar no lo repinta el sondeo',
    doc.getElementById('inbox-days').value === '30',
    doc.getElementById('inbox-days').value)
  doc.getElementById('save-days').click()
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
    { nombre: 'conectado', sidecar: { connection: 'open', qr: null, exited: false },
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
    { sidecar: { connection: 'open', qr: null } }, 'es-419')
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
    { sidecar: { connection: 'open', qr: null, exited: false } }, 'es-419')
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
    { sidecar: { connection: 'open', qr: null, exited: false } }, 'es-419')
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
  const storage = { sidecar: { connection: 'open', qr: null, exited: false } }
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
// "PMO - Ab2Web -  NetSat" trae dos espacios seguidos. Nadie escribe eso.
const CHATS_REALES = [
  { jid: '120363000000000001@g.us', name: 'Lista de espera | IA Builder Lab \u{1F680} #2', kind: 'grupo' },
  { jid: '120363000000000002@g.us', name: 'PMO - Ab2Web -  NetSat', kind: 'grupo' },
  { jid: '120363000000000003@g.us', name: 'Operaciones internas', kind: 'grupo' },
  { jid: '573000000001@s.whatsapp.net', name: 'Laura Méndez', kind: 'directo' },
  { jid: '573000000002@s.whatsapp.net', name: 'Camila Restrepo', kind: 'directo' }
]

console.log('\nconfig.html — buscar una conversacion como la gente la escribe de verdad')
{
  const { doc } = await montar('config.html', {
    chats: CHATS_REALES,
    scope: {
      '120363000000000002@g.us': { chatName: 'PMO - Ab2Web -  NetSat', provider: 'plane',
        target: 'PMO', mode: 'responder' }
    }
  }, 'es-419')
  await espera()
  const buscar = (texto) => {
    doc.getElementById('chat-search').value = texto
    doc.getElementById('chat-search').dispatchEvent(new doc.defaultView.Event('input'))
    return [...doc.getElementById('chat-pick').options].map((o) => o.textContent)
  }

  // Tildes: el dueno escribe "mendez" sin tilde y el grupo se llama "Méndez".
  ok('sin tilde encuentra lo que si la tiene',
    buscar('mendez').some((t) => t.includes('Méndez')), JSON.stringify(buscar('mendez')))
  // Emoji y puntuacion en el medio: "ia builder lab 2" tiene que llegar a
  // "IA Builder Lab 🚀 #2".
  ok('el emoji y la almohadilla no cortan la busqueda',
    buscar('ia builder lab 2').some((t) => t.includes('Builder')),
    JSON.stringify(buscar('ia builder lab 2')))
  // Doble espacio y guiones: nadie los reproduce al escribir.
  ok('los guiones y el espacio de mas no hacen falta',
    buscar('pmo ab2web netsat').some((t) => t.includes('Ab2Web')),
    JSON.stringify(buscar('pmo ab2web netsat')))
  // Y sin recordar el orden, que es como se busca un grupo del que uno recuerda dos
  // palabras sueltas.
  ok('las palabras sueltas valen en cualquier orden',
    buscar('netsat pmo').some((t) => t.includes('Ab2Web')),
    JSON.stringify(buscar('netsat pmo')))
  // Lo que NO puede pasar: traer lo que nadie escribio. El fallo caro con 296 filas no
  // es no encontrar la conversacion, es autorizar la equivocada.
  const sueltas = buscar('ia builder lab 2')
  ok('y no arrastra las que no tienen nada que ver',
    !sueltas.some((t) => t.includes('Operaciones')), JSON.stringify(sueltas))
  ok('sigue diciendo cuantas quedaron',
    /\d+\s+de\s+\d+/.test(doc.getElementById('chat-count').textContent),
    doc.getElementById('chat-count').textContent)
}

console.log('\nconfig.html — las tres que importan no se pierden entre las 296')
{
  const { doc } = await montar('config.html', {
    chats: CHATS_REALES,
    scope: {
      '120363000000000002@g.us': { chatName: 'PMO - Ab2Web -  NetSat', provider: 'plane',
        target: 'PMO', mode: 'responder' },
      '573000000001@s.whatsapp.net': { chatName: 'Laura Méndez', provider: 'ninguno',
        target: null, mode: 'observar' }
    }
  }, 'es-419')
  await espera()
  const sel = doc.getElementById('chat-pick')
  const grupos = [...sel.querySelectorAll('optgroup')]
  ok('la lista separa lo autorizado de lo que no', grupos.length === 2,
    JSON.stringify(grupos.map((g) => g.label)))
  ok('y lo autorizado va primero: son las que el dueno vuelve a tocar',
    grupos.length === 2 && grupos[0].children.length === 2 &&
    [...grupos[0].children].every((o) => /Ab2Web|Méndez/.test(o.textContent)),
    JSON.stringify(grupos.map((g) => [...g.children].map((o) => o.textContent))))
  ok('cada una dice con que permiso quedo, no solo que esta autorizada',
    grupos.length === 2 &&
    [...grupos[0].children].some((o) => /responder/i.test(o.textContent)) &&
    [...grupos[0].children].some((o) => /observ/i.test(o.textContent)),
    JSON.stringify(grupos.length ? [...grupos[0].children].map((o) => o.textContent) : []))
  ok('las etiquetas de los dos grupos estan en espanol, no en ingles',
    grupos.length === 2 && !/authori/i.test(grupos.map((g) => g.label).join(' ')),
    JSON.stringify(grupos.map((g) => g.label)))

  // §11-A1: el nombre visible NO es identidad. Antes de autorizar hay que poder ver
  // cual conversacion es, y la unica respuesta es la llave.
  sel.value = '573000000001@s.whatsapp.net'
  sel.dispatchEvent(new doc.defaultView.Event('change'))
  await espera()
  const identidad = doc.getElementById('chat-id')
  ok('al elegir una, el panel muestra su identificador y no solo el nombre',
    identidad && identidad.textContent.includes('573000000001@s.whatsapp.net'),
    identidad ? identidad.textContent : 'no existe #chat-id')
  ok('y avisa que esa ya estaba autorizada, antes de volver a guardarla',
    identidad && /observ/i.test(identidad.textContent),
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
      '120363000000000002@g.us': { chatName: 'PMO - Ab2Web -  NetSat', provider: 'plane',
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
    /✓/.test(doc.getElementById('said-scope').textContent),
    doc.getElementById('said-scope').textContent)
  ok('y la fila desaparece de la tabla',
    !doc.getElementById('scope-wrap').querySelector('[data-rm]'),
    doc.getElementById('scope-wrap').textContent)
}

console.log('\nconfig.html — un quitado que el worker NO pudo hacer no se anuncia como hecho')
{
  const storage = {
    chats: CHATS_REALES,
    scope: {
      '120363000000000002@g.us': { chatName: 'PMO - Ab2Web -  NetSat', provider: 'plane',
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
  const dicho = doc.getElementById('said-scope')
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

console.log(`\n${pruebas - fallos}/${pruebas} en verde`)
process.exit(fallos ? 1 : 0)
