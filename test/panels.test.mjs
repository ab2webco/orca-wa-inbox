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

  // De donde lee. Son DOS interruptores porque las fuentes se suman: la app de
  // escritorio lee una sola linea y cada sesion de WhatsApp Web seria otra. Un solo
  // control de tres valores obligaria a elegir una y perder la otra.
  doc.getElementById('read-local').value = 'off'
  doc.getElementById('read-web').value = 'on'
  // El texto de los mensajes es una eleccion APARTE de leer la linea: la bandeja web
  // trae quien te nombro y cuando sin abrir nada, y el cuerpo solo si se pide. Si este
  // control no llegara al storage, el panel diria guardado y el CLI seguiria en `off`.
  doc.getElementById('read-web-text').value = 'memoria'
  doc.getElementById('save-source').click()
  await espera()
  ok('guarda que no lea la app de escritorio', storage.readLocal === 'off',
    `storage.readLocal = ${JSON.stringify(storage.readLocal)}`)
  ok('guarda que sume WhatsApp Web', storage.readWeb === 'on',
    `storage.readWeb = ${JSON.stringify(storage.readWeb)}`)
  ok('guarda el texto de los mensajes web', storage.readWebText === 'memoria',
    `storage.readWebText = ${JSON.stringify(storage.readWebText)}`)
  ok('confirma las fuentes en pantalla',
    doc.getElementById('said-source').textContent.includes('✓'))
  // Los valores son los que valida `wa-scope`: si el select ofreciera otro, el panel
  // diria guardado y el CLI lo tiraria sin que nadie se entere.
  const valores = (id) => [...doc.getElementById(id).options].map((o) => o.value).sort()
  ok('las fuentes solo ofrecen on/off',
    JSON.stringify(valores('read-local')) === JSON.stringify(['off', 'on']) &&
    JSON.stringify(valores('read-web')) === JSON.stringify(['off', 'on']),
    `local = ${JSON.stringify(valores('read-local'))}, web = ${JSON.stringify(valores('read-web'))}`)
  ok('el texto web solo ofrece off/memoria',
    JSON.stringify(valores('read-web-text')) === JSON.stringify(['memoria', 'off']),
    `texto = ${JSON.stringify(valores('read-web-text'))}`)
  // Y se deja como estaba: lo de abajo comprueba el panel entero, no este ajuste. El
  // texto vuelve a `off`, que es donde tiene que arrancar.
  doc.getElementById('read-local').value = 'on'
  doc.getElementById('read-web').value = 'off'
  doc.getElementById('read-web-text').value = 'off'
  doc.getElementById('save-source').click()
  await espera()

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
  doc.getElementById('chat-instructions').value = 'Resume lo que manden y avisame.'
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
    entrada && entrada.instructions === 'Resume lo que manden y avisame.',
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
    /WhatsApp Desktop/.test(sinNada.doc.getElementById('sync-msg').textContent),
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
    doc.getElementById('chat-instructions').value === 'Resume lo que manden y avisame.',
    `chat-instructions = ${JSON.stringify(doc.getElementById('chat-instructions').value)}`)
  ok('Editar devuelve el destino a editable cuando hay servicio de tareas',
    !doc.getElementById('target').disabled && doc.getElementById('target').value === 'ENG')
  // El input #chat esta oculto: comprobarlo solo dejaba pasar el caso real, en el que
  // el select visible se quedaba en "Elegi una conversacion".
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
console.log('\nconfig.html — lineas de WhatsApp Web')
{
  const linea = (extra) => ({
    id: 'web:pending:p-1', label: 'Soporte', profile: 'p-1', pending: true,
    linkedAt: null, authorizedChats: 0, pageId: 'page-1', ...extra
  })

  const { doc, storage } = await montar('config.html', {}, 'es-419')
  await espera()

  ok('sin ninguna linea el panel lo dice en vez de quedar vacio',
    /ninguna linea/i.test(doc.getElementById('lines-wrap').textContent),
    doc.getElementById('lines-wrap').textContent.trim())

  // Un boton que no valida manda al worker a crear un perfil sin nombre, que despues
  // no se puede distinguir de los otros en la lista del navegador.
  storage.webRequest = null
  doc.getElementById('line-label').value = '   '
  doc.getElementById('link-line').click()
  await espera()
  ok('conectar sin nombre no manda nada y lo dice',
    !storage.webRequest && doc.getElementById('said-line').textContent.length > 0,
    `webRequest = ${JSON.stringify(storage.webRequest)}`)

  doc.getElementById('line-label').value = '  Soporte  '
  doc.getElementById('link-line').click()
  await espera()
  ok('conectar deja el pedido que atiende el worker',
    storage.webRequest && storage.webRequest.action === 'link' &&
    storage.webRequest.label === 'Soporte',
    `webRequest = ${JSON.stringify(storage.webRequest)}`)
  ok('y mientras tanto dice lo que esta pasando, no que ya esta conectada',
    /perfil/i.test(doc.getElementById('said-line').textContent),
    doc.getElementById('said-line').textContent)
}

{
  // Esperando el escaneo: el estado que el usuario ve mas tiempo y el unico en el que
  // la accion pasa en OTRA ventana. Sin un boton que lleve a la pestana, dos veces la
  // pregunta fue "donde se abre".
  const { doc, storage } = await montar('config.html', {
    // `placement` arriba es el valor viejo que el worker ya no escribe; la fila trae el
    // suyo. El panel tiene que pintar el de la fila: al reves es como el usuario abrio
    // el espacio flotante vacio con la pestana en un proyecto.
    webLines: { at: new Date().toISOString(), placement: 'proyecto', project: 'viejo',
      lines: [{ id: 'web:pending:p-1', label: 'Soporte', profile: 'p-1', pending: true,
        linkedAt: null, authorizedChats: 0, pageId: 'page-1', state: 'esperando',
        placement: 'flotante' }] }
  }, 'es-419')
  await espera()
  const wrap = doc.getElementById('lines-wrap')
  ok('la linea esperando dice que escanear y con que telefono',
    /escanea/i.test(wrap.textContent) && /QR/i.test(wrap.textContent),
    wrap.textContent.trim().slice(0, 160))
  ok('y dice donde esta la pestana, tomandolo de la fila',
    /flotante/i.test(doc.getElementById('lines-place').textContent),
    doc.getElementById('lines-place').textContent)
  ok('sin repetir el lugar viejo que quedo guardado arriba',
    !/viejo/.test(doc.getElementById('lines-place').textContent),
    doc.getElementById('lines-place').textContent)
  // El atajo se dice con la tecla de ESTA plataforma: Cmd en macOS, Ctrl en el resto.
  // Un texto fijo le diria Cmd a quien esta en Linux, que es mandarlo a la nada.
  ok('y dice con que atajo abrir ese panel, con la tecla de esta plataforma',
    /(Cmd|Ctrl)\+Alt\+A/.test(doc.getElementById('lines-place').textContent),
    doc.getElementById('lines-place').textContent)
  ok('y no ofrece el atajo que solo existe en macOS y solo maximiza',
    !/Shift/.test(doc.getElementById('lines-place').textContent),
    doc.getElementById('lines-place').textContent)

  const ver = wrap.querySelector('[data-lact]')
  ok('ofrece llevar a la pestana', !!ver && /pestana/i.test(ver.textContent),
    ver && ver.textContent)
  ver.click()
  await espera()
  ok('y ese boton le pide al worker que la ponga delante',
    storage.webRequest && storage.webRequest.action === 'show' &&
    storage.webRequest.pageId === 'page-1',
    `webRequest = ${JSON.stringify(storage.webRequest)}`)
}

{
  // La pestana cerrada NO es una linea perdida: la sesion vive en el perfil. Ofrecer
  // abrirla otra vez es la diferencia entre un estado y un callejon.
  const { doc, storage } = await montar('config.html', {
    webLines: { at: new Date().toISOString(),
      lines: [{ id: 'web:57300', label: 'Soporte', profile: 'p-1', pending: false,
        linkedAt: '2026-09-18 10:00', authorizedChats: 2, state: 'sin-pestana' }] }
  }, 'es-419')
  await espera()
  const boton = doc.getElementById('lines-wrap').querySelector('[data-lact]')
  boton.click()
  await espera()
  ok('una pestana cerrada se puede volver a abrir desde el panel',
    storage.webRequest && storage.webRequest.action === 'reopen' &&
    storage.webRequest.profile === 'p-1',
    `webRequest = ${JSON.stringify(storage.webRequest)}`)
  ok('y avisa que no va a pedir escanear de nuevo',
    /escanear|scan/i.test(doc.getElementById('lines-wrap').textContent),
    doc.getElementById('lines-wrap').textContent.trim().slice(0, 200))
}

{
  // Desvincular borra el perfil y las autorizaciones: un clic de inercia no puede
  // alcanzar. Se pide confirmacion Y se dice que se pierde, con el numero real.
  const { doc, storage } = await montar('config.html', {
    webLines: { at: new Date().toISOString(), placement: 'flotante',
      lines: [{ id: 'web:57300', label: 'Soporte', profile: 'p-1', pending: false,
        linkedAt: '2026-09-18 10:00', authorizedChats: 3, pageId: 'page-1',
        state: 'enlazada', placement: 'proyecto', project: 'alfred',
        worktreeId: 'wt-1' }] }
  }, 'es-419')
  await espera()
  const wrap = doc.getElementById('lines-wrap')
  ok('la linea enlazada dice cuantas conversaciones ve',
    /3/.test(wrap.textContent), wrap.textContent.trim().slice(0, 160))
  ok('dice en que proyecto esta la pestana y como llegar, no el lugar guardado',
    /alfred/.test(doc.getElementById('lines-place').textContent) &&
    !/flotante/i.test(doc.getElementById('lines-place').textContent),
    doc.getElementById('lines-place').textContent)

  storage.webRequest = null
  wrap.querySelector('[data-lrm]').click()
  await espera()
  ok('el primer clic en desvincular no borra nada', !storage.webRequest,
    `webRequest = ${JSON.stringify(storage.webRequest)}`)
  const aviso = doc.querySelector('.confirm')
  ok('avisa que se pierden las 3 conversaciones y el puesto de dispositivo',
    !!aviso && /3/.test(aviso.textContent) && /dispositivo/i.test(aviso.textContent),
    aviso && aviso.textContent.trim().slice(0, 200))

  doc.querySelector('[data-lyes]').click()
  await espera()
  ok('confirmar si lo pide', storage.webRequest &&
    storage.webRequest.action === 'unlink' && storage.webRequest.id === 'web:57300',
    `webRequest = ${JSON.stringify(storage.webRequest)}`)
}

{
  // Ningun estado sin salida, y ninguno vestido con la ropa de otro. Es la regla entera
  // de esta seccion: el panel tiene que pintar EL estado que el worker calculo — el
  // defecto reportado fue una fila que decia "Esperando el escaneo" y ofrecia "Ver la
  // pestana" sin ninguna pestana detras.
  //
  // La lista no se escribe a mano: se saca de web-lines.mjs, que es el unico lado que
  // emite estados. Un estado nuevo en el worker rompe esta prueba hasta que el panel
  // lo sepa decir, que es justo lo que no paso la primera vez.
  const fuente = readFileSync(join(root, 'web-lines.mjs'), 'utf8')
  const estados = [...new Set(fuente.split('\n')
    .filter((l) => /\bstate:/.test(l))
    .flatMap((l) => [...l.slice(l.indexOf('state:')).matchAll(/'([a-z-]+)'/g)]
      .map((m) => m[1])))]
  ok('la lista de estados sale del worker y no de esta prueba',
    estados.length === 6 && estados.includes('sin-pestana') &&
    estados.includes('esperando'), estados.join(', '))

  /** Como se ve una linea en ese estado: pastilla, que hacer, y botones. */
  async function pintar (state, extra = {}) {
    const { doc } = await montar('config.html', {
      webLines: { at: new Date().toISOString(),
        lines: [{ id: 'web:x', label: 'Soporte', profile: 'p-1', pending: false,
          linkedAt: '2026-09-18 10:00', authorizedChats: 0, pageId: 'page-1',
          state, ...extra }] }
    }, 'es-419')
    await espera()
    const wrap = doc.getElementById('lines-wrap')
    return {
      pastilla: (wrap.querySelector('.pill') || {}).textContent || '',
      como: (wrap.querySelector('.how') || {}).textContent || '',
      accion: (wrap.querySelector('[data-lact]') || {}).textContent || '',
      texto: wrap.textContent.trim()
    }
  }

  const vistos = []
  for (const state of estados) {
    const v = await pintar(state)
    ok(`el estado ${state} ofrece una accion y no solo un diagnostico`,
      !!v.accion && v.texto.length > 20, v.texto.slice(0, 120))
    vistos.push(v)
  }
  // El control que se pone rojo si un estado cae en la copia de otro: con el default
  // silencioso de antes, dos estados compartian pastilla y texto y cada uno pasaba
  // su comprobacion por separado.
  ok('cada estado tiene su propia pastilla',
    new Set(vistos.map((v) => v.pastilla)).size === estados.length,
    vistos.map((v) => v.pastilla).join(' | '))
  ok('cada estado dice algo distinto sobre que hacer',
    new Set(vistos.map((v) => v.como)).size === estados.length,
    vistos.map((v) => v.como.slice(0, 40)).join(' | '))

  // Un estado que este panel no conoce: antes `lineHow` reventaba antes de pintar y la
  // tabla entera quedaba VACIA, y el default se ponia la ropa de "Orca no contesta".
  const raro = await pintar('un-estado-que-no-existe')
  ok('un estado desconocido se pinta, no vacia la tabla', raro.texto.length > 20,
    raro.texto.slice(0, 120))
  ok('y se ve desconocido: dice cual es y no se disfraza de otro estado',
    /un-estado-que-no-existe/.test(raro.texto) &&
    !vistos.some((v) => v.pastilla === raro.pastilla),
    `${raro.pastilla} — ${raro.como.slice(0, 80)}`)

  // Y el callejon del reporte: sin pestana, "Ver la pestana" no se puede ofrecer.
  for (const state of estados) {
    const v = await pintar(state, { pageId: null })
    ok(`${state} sin pestana no ofrece llevar a una pestana que no existe`,
      v.accion !== 'Ver la pestana', `${state} -> ${v.accion}`)
    ok(`${state} sin pestana tampoco manda a apretar ese boton`,
      !/Ver la pestana/.test(v.como), `${state} -> ${v.como.slice(0, 80)}`)
  }

  // Una linea que nunca escaneo no tiene sesion que reanudar: el texto que le promete
  // que no le van a pedir el QR es el que lo dejo dando vueltas.
  const nueva = await pintar('sin-pestana', { pageId: null, pending: true, linkedAt: null })
  ok('una linea a medias sin pestana avisa que va a tener que escanear',
    /escanealo|escanear/.test(nueva.como) && /QR/.test(nueva.como),
    nueva.como.slice(0, 160))
  const vieja = await pintar('sin-pestana', { pageId: null })
  ok('y una que si estuvo enlazada avisa lo contrario: que no se lo van a pedir',
    /no te va a pedir escanear/.test(vieja.como), vieja.como.slice(0, 160))
  ok('las dos son frases distintas', nueva.como !== vieja.como, nueva.como.slice(0, 60))
  // Las pestanas mueren en cada actualizacion de Orca: si el texto no lo dice, el
  // usuario lee "la pestana esta cerrada" y cree que la cerro el.
  ok('y las dos dicen por que se cerro la pestana',
    /reiniciar|actualizar/.test(nueva.como) && /reiniciar|actualizar/.test(vieja.como),
    `${nueva.como.slice(0, 60)} | ${vieja.como.slice(0, 60)}`)
}

{
  // Los tres idiomas. Media traduccion no se ve hasta que la ve el usuario, y aca el
  // texto que importa es justamente el que dice que hacer.
  for (const [locale, esperado] of [['es-419', /escanea/i], ['en-US', /scan the QR/i],
    ['pt-BR', /escaneie/i]]) {
    const { doc } = await montar('config.html', {
      webLines: { at: new Date().toISOString(),
        lines: [{ id: 'web:pending:p-1', label: 'Soporte', profile: 'p-1', pending: true,
          linkedAt: null, authorizedChats: 0, pageId: 'page-1', state: 'esperando' }] }
    }, locale)
    await espera()
    ok(`el que hacer de la linea esta traducido en ${locale}`,
      esperado.test(doc.getElementById('lines-wrap').textContent),
      doc.getElementById('lines-wrap').textContent.trim().slice(0, 140))
  }
}

{
  // Un fallo con lineas sanas en la tabla: sin este renglon, el clic que fallo no dice
  // absolutamente nada y el usuario lo vuelve a apretar.
  const { doc } = await montar('config.html', {
    webLines: { at: new Date().toISOString(), error: 'sin-orca',
      lines: [{ id: 'web:x', label: 'Soporte', profile: 'p-1', pending: false,
        linkedAt: '2026-09-18 10:00', authorizedChats: 1, pageId: 'p', state: 'enlazada' }] }
  }, 'es-419')
  await espera()
  ok('lo que fallo se cuenta aunque la tabla tenga lineas sanas',
    !doc.getElementById('lines-error').hidden &&
    /Orca/i.test(doc.getElementById('lines-error').textContent),
    doc.getElementById('lines-error').textContent)
}

{
  // Una lectura que el host RECHAZA no puede vaciar la seccion. Es el parpadeo que el
  // dueno reporto tres versiones seguidas: la tabla decia "Enlazada", unos segundos
  // despues decia "Todavia no conectaste ninguna linea" y volvia. La causa no estaba en
  // lo que el worker publica —eso se midio estable— sino en el lote de 18 lecturas del
  // sondeo: el host admite 30 mensajes por 10 s, dos vueltas de 8 s caian en la misma
  // ventana, y la COLA del lote —`webLines` y `syncMinutes` entre ellas— volvia
  // `rate_limited`. Las dos se aplastaban en `null` y el panel pintaba el defecto: la
  // tabla vacia y el select en "cada 5 minutos — recomendado", que es el segundo
  // sintoma de sus capturas y lo que delata que el rechazo es del LOTE y no de la linea.
  const RECHAZADAS = ['webLines', 'webStatus', 'syncMinutes', 'readWebText']
  let rechazando = false
  const linea = (id, label) => ({ id, label, profile: 'p-1', pending: false,
    linkedAt: '2026-09-18 10:00', authorizedChats: 2, pageId: 'page-1',
    state: 'enlazada', placement: 'flotante' })
  const { window, doc } = await montar('config.html', {
    syncMinutes: '2',
    webLines: { at: new Date().toISOString(),
      lines: [linea('web:1', 'Soporte'), linea('web:2', 'Ventas')] }
  }, 'es-419', (d) => (rechazando && d.action === 'storage.get' &&
    RECHAZADAS.indexOf(d.params.key) >= 0
    ? { ok: false, errorCode: 'rate_limited', error: 'Too many requests.' }
    : undefined))
  await espera()
  const filas = () => doc.querySelectorAll('#lines-wrap tbody tr').length
  ok('parte con las dos lineas en la tabla', filas() === 2, `filas = ${filas()}`)
  ok('parte con el valor guardado del sondeo',
    doc.getElementById('sync-minutes').value === '2',
    doc.getElementById('sync-minutes').value)

  rechazando = true
  window.dispatchEvent(new window.Event('focus'))
  await espera()
  await espera()
  ok('un storage.get rechazado NO vacia las lineas conectadas', filas() === 2,
    `la tabla quedo en ${filas()} filas: ${doc.getElementById('lines-wrap').textContent.trim().slice(0, 90)}`)
  ok('un storage.get rechazado NO devuelve el select a su defecto',
    doc.getElementById('sync-minutes').value === '2',
    `el select volvio a ${doc.getElementById('sync-minutes').value}`)

  rechazando = false
  window.dispatchEvent(new window.Event('focus'))
  await espera()
  ok('y cuando el host vuelve a contestar la tabla sigue entera', filas() === 2,
    `filas = ${filas()}`)
}

{
  // Cada texto nuevo en los tres idiomas, comprobado por clave y no de memoria: una
  // traduccion que falta cae al ingles y media pantalla queda en el idioma equivocado.
  const { window } = await montar('config.html')
  const S = window.STRINGS
  const faltan = Object.keys(S.es).filter((k) => !(k in S.en))
  ok('cada texto del panel existe en espanol y en ingles', faltan.length === 0,
    `sin traducir = ${JSON.stringify(faltan.slice(0, 8))}`)
  const nuevas = ['linesLegend', 'linesHelp', 'linkLine', 'noLines', 'seeTab', 'openTab',
    'unlink', 'unlinkYes', 'stWaiting', 'stWaitingHow', 'stLinked', 'stLinkedNone',
    'stLinkedSome', 'stDropped', 'stDroppedHow', 'stNoTab', 'stNoTabHow', 'stNoOrca',
    'stNoOrcaHow', 'linePlacedFloating', 'linePlacedProject', 'unlinkWarn',
    'unlinkWarn0', 'lineWorking', 'needLineLabel',
    'lineWhereLabel', 'lineWhereProject', 'lineWhereFloating', 'lineWhereHelp',
    'errFlotanteSinVia', 'errSinFlotante', 'lineShownIn', 'lineStagedIn',
    'howWebLinePending', 'howWebNoLine', 'howWebProfileAmbiguous']
  // pt hereda el ingles para lo que no traduce, asi que "existe" no alcanza: tiene que
  // ser un texto PROPIO, o el portugues de esta seccion seria ingles.
  const sinPt = nuevas.filter((k) => !S.pt[k] || S.pt[k] === S.en[k])
  ok('y la seccion de lineas esta traducida tambien al portugues', sinPt.length === 0,
    `sin portugues = ${JSON.stringify(sinPt)}`)

  // Los textos de `data-t` se pintan con fmt(), que BORRA todo `{x}` que no reciba
  // valor. Hoy el unico hueco es `{k}`, el atajo del espacio flotante. Un texto nuevo
  // con otro hueco no fallaria: se quedaria sin esa palabra, callado.
  const HUECOS = ['k']
  const marcados = new Set()
  const html = readFileSync(join(root, 'config.html'), 'utf8')
  for (const m of html.matchAll(/data-t(?:-ph|-title)?="([^"]+)"/g)) marcados.add(m[1])
  const rotos = []
  for (const idioma of ['es', 'en', 'pt']) {
    for (const k of marcados) {
      const texto = String(S[idioma] && S[idioma][k] || '')
      for (const h of texto.match(/\{(\w+)\}/g) || []) {
        if (!HUECOS.includes(h.slice(1, -1))) rotos.push(`${idioma}.${k} ${h}`)
      }
    }
  }
  ok('ningun texto de data-t trae un hueco que nadie llena', rotos.length === 0,
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

// ───────── los cinco finales de una corrida ─────────
// El defecto que esto existe para tapar: "no habia nada que hacer", "nunca corrio",
// "arranco y se murio" y "no hay nada autorizado" se veian IGUAL — una lista vacia. El
// dueno miraba eso y concluia lo unico que se puede concluir mirando: que no funciona.
// Se comprueba lo que se lee en pantalla, no la forma del objeto.
console.log('\nactivity.html — un mensaje que llego sin cuerpo')
{
  // Por la via web el cuerpo casi nunca llega y el adjunto no deja ruta. El panel
  // mostraba el marcador crudo — "[web:no-text reason=not-loaded media=image]" — que no
  // es una frase, y no marcaba la fila como que traia algo, porque miraba solo `media`.
  const AHORA = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const conMarcador = {
    syncedAt: AHORA, running: false, mapped: 1, authorized: 1, recent: [],
    pending: [
      { stanzaId: 'W1', date: '2026-09-17 12:06', chat: 'Soporte Acme', sender: 'Ana',
        kind: 'mencion', text: '', noText: 'not-loaded', mediaKind: 'image',
        hasMedia: true },
      { stanzaId: 'W2', date: '2026-09-17 12:07', chat: 'Soporte Acme', sender: 'Beto',
        kind: 'mencion', text: '', noText: 'off', mediaKind: null, hasMedia: false },
      { stanzaId: 'W3', date: '2026-09-17 12:08', chat: 'Soporte Acme', sender: 'Caro',
        kind: 'directo', text: '', noText: 'no-body', mediaKind: 'ptt', hasMedia: true }
    ]
  }
  for (const [lang, frase, tipo] of [['es-419', /no ten[ií]a ese mensaje cargado/i, /nota de voz/i],
                                     ['en-US', /did not have that message loaded/i, /voice note/i],
                                     ['pt-BR', /n[aã]o tinha essa mensagem carregada/i, /nota de voz/i]]) {
    const { doc } = await montar('activity.html', { activity: conMarcador }, lang)
    await espera()
    const txt = doc.getElementById('pending').textContent
    ok(`el marcador de la via web no se muestra crudo en ${lang}`,
      !/web:no-text|reason=|media=/.test(txt), txt.slice(0, 220))
    ok(`y se dice en palabras en ${lang}`, frase.test(txt), txt.slice(0, 220))
    ok(`el tipo del adjunto se dice por su nombre en ${lang}`, tipo.test(txt),
      txt.slice(0, 220))
  }
  const { doc } = await montar('activity.html', { activity: conMarcador }, 'es-419')
  await espera()
  // Las tres razones piden acciones distintas y en el JSON se ven iguales.
  const txt = doc.getElementById('pending').textContent
  ok('la razon `off` dice que el texto no se pidio, no que el mensaje estaba vacio',
    /no se pidio el cuerpo/i.test(txt), txt.slice(0, 400))
  ok('la razon `no-body` si dice que no traia texto',
    /no tra[ií]a texto/i.test(txt), txt.slice(0, 400))
  ok('un mensaje sin cuerpo se distingue de uno leido',
    doc.querySelectorAll('.text.sin-texto').length === 3,
    String(doc.querySelectorAll('.text.sin-texto').length))
}

console.log('\nconfig.html — una maquina que lee solo por la via web')
{
  // Los cinco chequeos de la base local fallan y ninguno bloquea: la sesion web
  // contesta. El panel no puede decir que WhatsApp no esta conectado, y tampoco puede
  // ofrecer "activar" un sistema operativo en cinco circulos grises.
  const salud = {
    ok: true,
    optional: [{ que: 'local WhatsApp database', code: 'local',
      como: 'Linux; no official app for this system; missing; does not exist',
      howCode: 'local-covered-by-web' }]
  }
  for (const [lang, frase] of [['es-419', /sesion de WhatsApp Web esta contestando/i],
                               ['en-US', /WhatsApp Web session is answering/i],
                               ['pt-BR', /sess[aã]o do WhatsApp Web est[aá] respondendo/i]]) {
    const { doc } = await montar('config.html', { health: salud }, lang)
    await espera()
    ok(`no dice que WhatsApp no esta conectado en ${lang}`,
      doc.getElementById('alert').hidden, doc.getElementById('alert').textContent)
    const opc = doc.getElementById('opcionales').textContent
    ok(`y explica de donde se esta leyendo, en ${lang}`, frase.test(opc), opc.slice(0, 220))
    ok(`sin colar el ingles del CLI en ${lang}`,
      lang === 'en-US' || !/no official app for this system/.test(opc), opc.slice(0, 220))
  }
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
    /no autorizaste/i.test(sinRegistro.doc.getElementById('pending').textContent),
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
    problem: 'WhatsApp Desktop installed',
    problemCode: 'whatsapp',
    detail: '/Users/quien-sea/Library/Group Containers/group.net.whatsapp.WhatsApp.shared',
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
    alertaEs.includes('WhatsApp Desktop instalado'), alertaEs)
  ok('el requisito opcional tambien',
    opcionalEs.includes('Transcripcion de audio') && opcionalEs.includes('Ajustes > Voz'),
    opcionalEs)
  // Lo que motiva todo esto: media traduccion es peor que ninguna, porque no se ve.
  ok('no se cuela el ingles del CLI en el panel en espanol',
    !/\btranscription\b|\bdownload\b|\binstalled\b/i.test(alertaEs + ' ' + opcionalEs),
    alertaEs + ' | ' + opcionalEs)
  // El detalle SI es el dato crudo de la herramienta —una ruta, un tamano, un error de
  // sqlite—, no una frase: se muestra tal cual, igual que el detalle del sync fallido.
  ok('el detalle tecnico se muestra tal cual', alertaEs.includes('Group Containers'),
    alertaEs)

  const pt = await montar('config.html', { health: salud }, 'pt-BR')
  await espera()
  ok('y en portugues tambien',
    pt.doc.getElementById('alert').textContent.includes('WhatsApp Desktop instalado') &&
    pt.doc.getElementById('opcionales').textContent.includes('Transcricao de audio'),
    pt.doc.getElementById('opcionales').textContent)

  const en = await montar('config.html', { health: salud }, 'en-US')
  await espera()
  ok('en ingles dice lo mismo que la terminal',
    en.doc.getElementById('alert').textContent.includes('WhatsApp Desktop installed'),
    en.doc.getElementById('alert').textContent)

  // El permiso del disco es lo que explica el cartel que macOS levanta cuatro veces
  // por minuto. Si llegara sin traducir, el usuario lee una instruccion en ingles
  // justo en el momento en que esta buscando por que le preguntan tanto.
  const fda = {
    ok: true,
    optional: [{ que: 'Full Disk Access', como: 'optional \u2014 macOS asks ...',
      code: 'fulldisk', howCode: 'fulldisk-missing' }]
  }
  for (const [lang, titulo, accion] of [
    ['es-419', 'Acceso total al disco', 'Acceso total al disco > agregar Orca Lab'],
    ['en-US', 'Full Disk Access', 'Full Disk Access > add Orca Lab'],
    ['pt-BR', 'Acesso total ao disco', 'Acesso total ao disco > adicionar Orca Lab']
  ]) {
    const panel = await montar('config.html', { health: fda }, lang)
    await espera()
    const texto = panel.doc.getElementById('opcionales').textContent
    ok(`el permiso del disco se explica en ${lang}`,
      texto.includes(titulo) && texto.includes(accion), texto)
  }

  // Los finales de la via web se cuentan APARTE porque la accion del usuario es
  // distinta en cada uno: abrir Orca, abrir la pestana, escanear el QR, esperar. Con un
  // solo texto para los cuatro, el que tiene que escanear el QR lee "abri Orca Lab" y
  // no encuentra nada que abrir.
  const WEB_FINALES = [
    ['web-off', 'Lineas conectadas', 'Connected lines'],
    ['web-no-orca', 'ORCA_CLI_COMMAND', 'ORCA_CLI_COMMAND'],
    ['web-no-session', 'pestana', 'tab'],
    ['web-logged-out', 'QR', 'QR'],
    ['web-eval-timeout', 'no contesto a tiempo', 'did not answer in time'],
    ['web-read-failed', 'Recarga', 'Reload'],
    // Los tres de abajo son la diferencia entre "termina de enlazar NoVa", "no tenes
    // ninguna linea" y "hay dos perfiles con el mismo nombre". Con un solo texto para
    // los tres, quien tiene la linea a medias no se entera de que le falta escanear.
    ['web-line-pending', 'todavia no escaneo el QR', 'has not scanned its QR code yet'],
    ['web-no-line', 'no hay ninguna linea enlazada', 'no line is linked'],
    ['web-profile-ambiguous', 'dos perfiles del navegador con el mismo nombre',
      'Two browser profiles share the same name']
  ]
  const dichos = new Set()
  for (const [code, marcaEs, marcaEn] of WEB_FINALES) {
    const salud = { ok: true, optional: [{ que: 'WhatsApp Web as a second line',
      como: 'the CLI text', code: 'web', howCode: code }] }
    const es = await montar('config.html', { health: salud }, 'es-419')
    await espera()
    const texto = es.doc.getElementById('opcionales').textContent
    ok(`${code} se dice en espanol y no como lo escribio el CLI`,
      texto.includes(marcaEs) && !texto.includes('the CLI text'), texto.slice(0, 160))
    dichos.add(texto)
    const en = await montar('config.html', { health: salud }, 'en-US')
    await espera()
    ok(`${code} tambien tiene su texto en ingles`,
      en.doc.getElementById('opcionales').textContent.includes(marcaEn),
      en.doc.getElementById('opcionales').textContent.slice(0, 160))
  }
  // Y que sean TODOS textos distintos: dos claves que resolvieran a la misma frase
  // pasarian las comprobaciones de arriba una por una y no le dirian nada al usuario.
  ok('cada final de la via web dice algo distinto',
    dichos.size === WEB_FINALES.length, `textos distintos = ${dichos.size}`)

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

// ───────── lo que falla se DICE, y no se lleva puesto lo tipeado ─────────
// Los dos defectos que se reportaron: guardar de donde lee decia guardado pase lo que
// pase, y "Conectar cuenta" vaciaba el nombre antes de saber si la linea existia.
console.log('\nconfig.html — un guardado que falla no dice guardado')
{
  // El host rechaza UNA de las tres escrituras. Encadenadas como estaban, el resultado
  // que llegaba al final era el de la tercera y el panel decia guardado igual.
  const { doc, storage } = await montar('config.html', {}, 'es-419', (d) => {
    if (d.action === 'storage.set' && d.params.key === 'readWeb') return { ok: false }
    return undefined
  })
  doc.getElementById('read-local').value = 'off'
  doc.getElementById('read-web').value = 'on'
  doc.getElementById('save-source').click()
  await espera()
  await espera()
  const dijo = doc.getElementById('said-source').textContent
  ok('una fuente que no se pudo guardar no dice guardado',
    !dijo.includes('\u2713'), `dijo ${JSON.stringify(dijo)}`)
  // Nombrado como el usuario lo ve, no como se llama la clave del storage.
  ok('y nombra el control que fallo, con su etiqueta',
    dijo.includes('WhatsApp Web') && !dijo.includes('readWeb'),
    `dijo ${JSON.stringify(dijo)}`)
  ok('el error queda marcado en rojo',
    doc.getElementById('said-source').className.includes('bad'))
  ok('lo que si se pudo guardar quedo guardado', storage.readLocal === 'off',
    `readLocal = ${JSON.stringify(storage.readLocal)}`)
}

{
  // Y el camino feliz: las tres guardadas, y ademas se le pide al worker que relea, si
  // no el aviso rojo sigue reclamando la app que el usuario acaba de apagar.
  const { doc, storage } = await montar('config.html', {}, 'es-419')
  doc.getElementById('read-local').value = 'off'
  doc.getElementById('read-web').value = 'on'
  doc.getElementById('read-web-text').value = 'memoria'
  doc.getElementById('save-source').click()
  await espera()
  await espera()
  ok('las tres fuentes se guardan',
    storage.readLocal === 'off' && storage.readWeb === 'on' &&
    storage.readWebText === 'memoria', JSON.stringify(storage))
  ok('y lo confirma en pantalla',
    doc.getElementById('said-source').textContent.includes('\u2713'))
  ok('y pide una relectura para que la alerta deje de reclamar lo apagado',
    !!storage.syncRequest, JSON.stringify(storage.syncRequest))
}

console.log('\nconfig.html — conectar una linea que falla conserva lo tipeado')
{
  // El worker contesta que no pudo. Antes el campo ya estaba vacio para cuando llegaba
  // la respuesta — se vaciaba al mandar el pedido — y nada mostraba el motivo.
  const { doc, storage } = await montar('config.html', {}, 'es-419', (d, store) => {
    if (d.action === 'storage.set' && d.params.key === 'webRequest' && d.params.value) {
      store.webStatus = { at: new Date().toISOString(), requestAt: d.params.value.at,
        action: d.params.value.action, ok: false, code: 'sin-orca', detail: 'ENOENT' }
    }
    return undefined
  })
  doc.getElementById('line-label').value = 'Linea del bot'
  doc.getElementById('link-line').click()
  await new Promise((r) => setTimeout(r, 1500))
  ok('el pedido se mando', !!storage.webRequest || !!storage.webStatus)
  ok('el nombre tipeado sobrevive al fallo',
    doc.getElementById('line-label').value === 'Linea del bot',
    `quedo ${JSON.stringify(doc.getElementById('line-label').value)}`)
  const dijo = doc.getElementById('said-line').textContent
  ok('y dice que lo tipeado sigue ahi', /quedo puesto/.test(dijo),
    `dijo ${JSON.stringify(dijo)}`)
  ok('marcado como error', doc.getElementById('said-line').className.includes('bad'))
  const arriba = doc.getElementById('lines-error')
  ok('y el motivo se dice UNA vez, en el renglon de la seccion',
    !arriba.hidden && /CLI de Orca/.test(arriba.textContent) &&
    !/CLI de Orca/.test(dijo), arriba.textContent)
  ok('el boton vuelve a quedar usable',
    doc.getElementById('link-line').disabled === false)
}

{
  // Y cuando si se conecta, el campo se vacia: es la senal de que la linea existe.
  const { doc } = await montar('config.html', {}, 'es-419', (d, store) => {
    if (d.action === 'storage.set' && d.params.key === 'webRequest' && d.params.value) {
      store.webStatus = { at: new Date().toISOString(), requestAt: d.params.value.at,
        action: d.params.value.action, ok: true, placement: 'flotante' }
    }
    return undefined
  })
  doc.getElementById('line-label').value = 'Linea del bot'
  doc.getElementById('link-line').click()
  await new Promise((r) => setTimeout(r, 1500))
  ok('con la linea conectada el campo se vacia',
    doc.getElementById('line-label').value === '',
    `quedo ${JSON.stringify(doc.getElementById('line-label').value)}`)
  ok('y lo confirma', doc.getElementById('said-line').textContent.includes('\u2713'),
    doc.getElementById('said-line').textContent)
}

{
  // "Ver la pestana" sobre una pestana que ya no esta: fallaba y el boton no decia
  // nada. Es el mismo defecto que conectar, en el otro boton de la seccion.
  const LINEA = {
    id: 'web:573000000000', label: 'Linea del bot', profile: '9f2c', pending: false,
    linkedAt: '2026-09-17 09:12', authorizedChats: 2, pageId: 'page-1', state: 'enlazada'
  }
  const { doc } = await montar('config.html',
    { webLines: { at: new Date().toISOString(), lines: [LINEA] } }, 'es-419',
    (d, store) => {
      if (d.action === 'storage.set' && d.params.key === 'webRequest' && d.params.value) {
        store.webStatus = { at: new Date().toISOString(), requestAt: d.params.value.at,
          action: d.params.value.action, ok: false, code: 'sin-orca', detail: 'ENOENT' }
      }
      return undefined
    })
  await espera()
  const ver = doc.querySelector('[data-lact]')
  ok('la linea enlazada ofrece ver su pestana', !!ver,
    doc.getElementById('lines-wrap').textContent.slice(0, 80))
  ver.click()
  await new Promise((r) => setTimeout(r, 1500))
  const err = doc.getElementById('lines-error')
  ok('una pestana que no se puede abrir lo dice en el acto',
    !err.hidden && /CLI de Orca/.test(err.textContent), err.textContent)
}

{
  // Y con el veredicto en la mano el estado se RELEE. El worker recalcula las lineas
  // antes de contestar, y el panel repintaba las que tenia en memoria: la fila seguia
  // diciendo "Esperando el escaneo" y ofreciendo "Ver la pestana" sobre una pestana
  // que el worker ya sabia muerta. Es el estado que el usuario reporto.
  const VIVA = {
    id: 'web:pending:9f2c', label: 'NoVa', profile: '9f2c', pending: true,
    linkedAt: null, authorizedChats: 0, pageId: 'page-1', state: 'esperando'
  }
  const MUERTA = { ...VIVA, pageId: null, state: 'sin-pestana' }
  const { doc } = await montar('config.html',
    { webLines: { at: new Date().toISOString(), lines: [VIVA] } }, 'es-419',
    (d, store) => {
      if (d.action === 'storage.set' && d.params.key === 'webRequest' && d.params.value) {
        // Lo que hace el worker de verdad: recalcula y recien despues contesta.
        store.webLines = { at: new Date().toISOString(), lines: [MUERTA] }
        store.webStatus = { at: new Date().toISOString(), requestAt: d.params.value.at,
          action: d.params.value.action, ok: false, code: 'sin-pestana', detail: '' }
      }
      return undefined
    })
  await espera()
  const wrap = doc.getElementById('lines-wrap')
  ok('antes del clic la fila dice lo que el worker sabia: esperando el escaneo',
    /Esperando el escaneo/.test(wrap.textContent) &&
    /Ver la pestana/.test(wrap.querySelector('[data-lact]').textContent),
    wrap.textContent.trim().slice(0, 120))
  wrap.querySelector('[data-lact]').click()
  await new Promise((r) => setTimeout(r, 1500))
  const ahora = doc.getElementById('lines-wrap')
  ok('con el veredicto el panel pinta el estado nuevo, no el que tenia guardado',
    /Sin pestana/.test(ahora.textContent) &&
    /Abrir la pestana/.test(ahora.querySelector('[data-lact]').textContent),
    ahora.textContent.trim().slice(0, 160))
  ok('y el motivo del fallo se dice traducido',
    /pestana ya no existe/.test(doc.getElementById('lines-error').textContent),
    doc.getElementById('lines-error').textContent)
}

// ───────── el sondeo contra lo que el usuario acaba de hacer ─────────
// Lo reportado: "al guardar, algunos select cambian de valor y vuelve".
//
// El sondeo LEE y PINTA en dos momentos distintos: sus 18 lecturas se contestan con lo
// que hay, y recien pinta cuando llega la ultima — `chats` son 52 KB en el Mac del
// dueno y siempre llega ultima. Un guardado que aterriza en ese hueco queda pisado por
// el valor de ANTES. La guardia que habia —"no pintes el control que tiene el foco"—
// no cubre nada: Chromium enfoca el boton al hacer clic, asi que el select ya lo perdio.
console.log('\nconfig.html: el sondeo no pisa lo que el usuario acaba de hacer')
{
  let demora = 0
  const storage = { readLocal: 'on', readWeb: 'off', readWebText: 'off' }
  const { window, doc } = await montar('config.html', storage, 'es-419', (d) =>
    (demora && d.action === 'storage.get' && d.params.key === 'chats'
      ? { __demora: demora } : undefined))

  demora = 400
  window.dispatchEvent(new window.Event('focus'))   // el sondeo pide sus 18 claves
  await espera()                                     // ya salieron, con readWeb = off
  doc.getElementById('read-web').value = 'on'
  doc.getElementById('read-web').dispatchEvent(new window.Event('change'))
  demora = 0
  doc.getElementById('save-source').focus()          // lo que hace el clic en Chromium
  doc.getElementById('save-source').click()
  await new Promise((r) => setTimeout(r, 700))       // aterriza la pintura del sondeo
  ok('un sondeo que leyo antes del guardado no repinta el valor viejo encima',
    storage.readWeb === 'on' && doc.getElementById('read-web').value === 'on',
    `guardado = ${storage.readWeb}, select = ${doc.getElementById('read-web').value}`)
}

{
  // Y la otra mitad: el repintado que llega ANTES del clic. Ahi no hay guardado que
  // proteger todavia, y el boton termina mandando el valor que el usuario ya no ve.
  const storage = { readLocal: 'on', readWeb: 'off', readWebText: 'off' }
  const { window, doc } = await montar('config.html', storage, 'es-419')
  doc.getElementById('read-web').value = 'on'
  doc.getElementById('read-web').dispatchEvent(new window.Event('change'))
  doc.getElementById('read-web').blur()              // mira otra cosa antes de guardar
  window.dispatchEvent(new window.Event('focus'))
  await espera(); await espera()
  ok('un select cambiado y sin guardar no lo repinta el sondeo',
    doc.getElementById('read-web').value === 'on',
    doc.getElementById('read-web').value)
  doc.getElementById('save-source').click()
  await espera(); await espera()
  ok('y la accion manda el valor que el usuario eligio, no el que habia guardado',
    storage.readWeb === 'on', String(storage.readWeb))
}

// ───────── desvincular no hereda el veredicto del clic anterior ─────────
// Lo reportado: "cuando trate de borrar la anterior dijo que no podia, le doy de nuevo
// y la borra". Medido en su Mac: 1,49 s entre el pedido y su veredicto. En ese hueco el
// sondeo de 2 s tomaba CUALQUIER `webStatus` y lo pintaba como respuesta a este clic —
// y el que habia era el de "Ver la pestana" sobre una linea flotante, que siempre falla.
console.log('\nconfig.html: el veredicto que se muestra es el del clic que se hizo')
{
  const AHORA = new Date().toISOString()
  // Con la linea a medias el sondeo de 2 s ya esta latiendo antes del clic: es la
  // situacion en la que el veredicto ajeno alcanzaba a pintarse.
  const LINEA = { id: 'web:57300', label: 'Soporte', profile: 'p1', pending: true,
    linkedAt: null, authorizedChats: 0, pageId: 'pg1',
    state: 'esperando', placement: 'flotante', project: null }
  let pedidoUnlink = null
  const storage = {
    webLines: { at: AHORA, lines: [LINEA] },
    webStatus: { at: AHORA, requestAt: '2026-01-01T00:00:00.000Z', action: 'show',
      ok: false, code: 'flotante-sin-via', detail: '', placement: 'flotante' }
  }
  const { doc } = await montar('config.html', storage, 'es-419', (d, store) => {
    if (d.action === 'storage.set' && d.params.key === 'webRequest' &&
        d.params.value && d.params.value.action === 'unlink') {
      pedidoUnlink = d.params.value
      // 3 s: el worker recoge el pedido en su vuelta de 3 s y recien despues trabaja.
      // Medido en el Mac del dueno, entre clic y veredicto propio pasaron 1,49 s con
      // el pedido escrito justo antes de una vuelta; el tope de recogida es 3 s mas.
      setTimeout(() => {
        store.webLines = { at: new Date().toISOString(), lines: [], motivo: 'unlink' }
        store.webStatus = { at: new Date().toISOString(), requestAt: d.params.value.at,
          action: 'unlink', ok: true }
      }, 3000)
    }
    return undefined
  })
  await espera()
  doc.querySelector('[data-lrm]').click()
  await espera()
  const aviso0 = doc.getElementById('lines-error')
  ok('antes del clic el panel muestra el veredicto del clic anterior, que es de el',
    !aviso0.hidden && /No pude abrir la pestana/.test(aviso0.textContent),
    aviso0.textContent)
  doc.querySelector('[data-lyes]').click()
  await espera()
  ok('y al apretar desvincular ese aviso se baja en el acto',
    aviso0.hidden || !aviso0.textContent.trim(), aviso0.textContent)
  // 2,2 s: una vuelta entera del sondeo de 2 s con el veredicto propio todavia sin
  // llegar. Menos que eso y la prueba pasa sin haber dejado latir al sondeo, que es
  // justo lo que hay que comprobar.
  await new Promise((r) => setTimeout(r, 2200))
  const aviso = doc.getElementById('lines-error')
  ok('mientras el desvincular corre no se muestra el veredicto del clic anterior',
    aviso.hidden || !aviso.textContent.trim(), aviso.textContent)
  ok('y el pedido lleva la fila TAL CUAL la vio el usuario',
    !!pedidoUnlink && pedidoUnlink.desde === AHORA &&
    pedidoUnlink.visto && pedidoUnlink.visto.state === 'esperando' &&
    pedidoUnlink.visto.pageId === 'pg1', JSON.stringify(pedidoUnlink))
  await new Promise((r) => setTimeout(r, 3000))
  ok('y con SU veredicto la linea ya no esta y no quedo ningun aviso de fallo',
    !doc.querySelector('[data-lrm]') && (aviso.hidden || !aviso.textContent.trim()),
    `${aviso.textContent} | filas = ${doc.querySelectorAll('[data-lrm]').length}`)
}


// ───────── un host que rechaza TODO no pinta ningun defecto ─────────
// La propiedad de v3.12.3, comprobada sobre el panel entero y no sobre una funcion:
// `read()` memoriza lo ultimo que el host CONTESTO, asi que un rechazo repinta eso y
// nunca un valor por defecto. Se prueba con el host negandose a todo desde el arranque,
// que es el unico momento en que no hay nada memorizado.
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
    ['no tenes lineas', visible('#lines-wrap'), /Todavia no conectaste ninguna linea/],
    ['el plugin no esta', visible('#alert'), /El plugin no esta corriendo/],
    ['no hay de donde leer', visible('#alert'), /No hay de donde leer/],
    ['un fallo de lectura', visible('#lines-error'), /./]
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
    ['es-419', /El plugin no esta corriendo/, /El plugin dejo de responder/],
    ['en-US', /The plugin is not running/, /The plugin stopped responding/],
    ['pt-BR', /O plugin nao esta rodando/, /O plugin parou de responder/]
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
    ok(`sin worker el boton de conectar esta apagado, en ${lang}`,
      sin.doc.getElementById('link-line').disabled === true)

    const viejo = await montar('config.html',
      { workerBeat: { at: VIEJO }, health: { ok: true } }, lang)
    const a2 = viejo.doc.getElementById('alert')
    ok(`un latido vencido se distingue de uno que nunca existio, en ${lang}`,
      !a2.hidden && parado.test(a2.textContent), a2.textContent.slice(0, 120))
  }

  // Y sobrevive al repintado: la tabla la vuelven a dibujar el vigia de 2 s y el
  // veredicto de un clic, no solo reload().
  {
    const { doc, window } = await montar('config.html', {
      workerBeat: null,
      webLines: { at: new Date().toISOString(), lines: [{
        id: 'web:1', label: 'Soporte', profile: 'p1', state: 'esperando',
        pageId: 'pg1', placement: 'proyecto', project: 'x', authorizedChats: 0 }] }
    }, 'es-419')
    ok('sin worker los botones de la tabla nacen apagados',
      [...doc.querySelectorAll('#lines-wrap button')].every((b) => b.disabled),
      doc.querySelector('#lines-wrap').innerHTML.slice(0, 160))
    // 2,4 s: una vuelta entera del vigia de 2 s, que repinta la tabla entera.
    await new Promise((r) => setTimeout(r, 2400))
    ok('y siguen apagados despues de que el vigia la repinta',
      [...doc.querySelectorAll('#lines-wrap button')].every((b) => b.disabled),
      doc.querySelector('#lines-wrap').innerHTML.slice(0, 160))
    window.close()
  }

  // Con worker vivo los botones siguen vivos: apagar lo que SI se puede hacer es el
  // mismo defecto del otro lado.
  const vivo = await montar('config.html',
    { workerBeat: { at: new Date().toISOString() }, health: { ok: true } }, 'es-419')
  ok('con worker vivo el boton de conectar sigue encendido',
    vivo.doc.getElementById('link-line').disabled === false)

  // Y el caso que hace que esto valga: un host que RECHAZA la lectura no es un worker
  // ausente. No saber no es saber que no esta.
  const rechazo = await montar('config.html', { health: { ok: true } }, 'es-419',
    (d) => d.action === 'storage.get' && d.params.key === 'workerBeat'
      ? { ok: false, error: { code: 'rate_limited' } } : undefined)
  const a3 = rechazo.doc.getElementById('alert')
  ok('una lectura RECHAZADA no se pinta como plugin ausente',
    a3.hidden || !/no esta corriendo/.test(a3.textContent), a3.textContent.slice(0, 120))
}

// ───────── una pestana que aparecio en otro lado es una decision, no un arreglo ─────────
console.log('\nconfig.html: la linea que se movio de lugar')
{
  const FILA = {
    id: 'web:1', label: 'Soporte', profile: 'perfil-1', state: 'enlazada',
    pageId: 'pg1', placement: 'proyecto', project: 'donde-aparecio',
    worktreeId: 'wt-otro', host: 'runtime-A', authorizedChats: 2,
    homeState: 'mudada',
    casa: { host: 'runtime-A', donde: 'proyecto', worktreeId: 'wt-casa',
      proyecto: 'su-casa' }
  }
  const { doc } = await montar('config.html',
    { webLines: { at: new Date().toISOString(), lines: [FILA] } }, 'es-419')
  const fila = doc.querySelector('#lines-wrap tbody').textContent
  ok('la fila nombra los DOS lugares, el suyo y donde esta',
    /su-casa/.test(fila) && /donde-aparecio/.test(fila), fila.slice(0, 220))
  ok('y ofrece volverla a su lugar', !!doc.querySelector('[data-lhome]'))
  ok('y ofrece dejarla donde esta', !!doc.querySelector('[data-ladopt]'))

  // Una linea en su casa no ofrece ninguna de las dos: un boton que no corresponde es
  // tan malo como uno que falta.
  const sana = await montar('config.html',
    { webLines: { at: new Date().toISOString(),
      lines: [Object.assign({}, FILA, { homeState: 'en-casa', casa: null })] } }, 'es-419')
  ok('una linea en su casa no ofrece mudarse',
    !sana.doc.querySelector('[data-lhome]') && !sana.doc.querySelector('[data-ladopt]'))
}

// ───────── una linea de otro Orca no ofrece abrir nada ─────────
// Su perfil de navegador vive en la otra maquina: escanear un QR aca quemaria un
// dispositivo vinculado sobre una sesion que este Orca no va a poder leer nunca.
console.log('\nconfig.html: la linea de otro host')
{
  const { doc } = await montar('config.html', {
    webLines: { at: new Date().toISOString(), lines: [{
      id: 'web:1', label: 'Soporte', profile: 'perfil-1', state: 'sin-pestana',
      pageId: null, host: 'runtime-A', authorizedChats: 0, homeState: 'otro-host',
      casa: { host: 'runtime-B', donde: 'flotante', worktreeId: null, proyecto: null }
    }] }
  }, 'es-419')
  ok('no ofrece abrir ni reabrir una pestana que no puede existir aca',
    !doc.querySelector('[data-lact]'),
    doc.querySelector('#lines-wrap tbody').innerHTML.slice(0, 200))
  ok('pero si deja sacarla', !!doc.querySelector('[data-lrm]'))
  ok('y explica por que',
    /otro Orca/.test(doc.querySelector('#lines-wrap tbody').textContent),
    doc.querySelector('#lines-wrap tbody').textContent.slice(0, 200))
}

console.log(`\n${pruebas - fallos}/${pruebas} en verde`)
process.exit(fallos ? 1 : 0)
