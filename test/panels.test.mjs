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
async function montar (archivo, storage = {}, idioma = null) {
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
  doc.getElementById('save-source').click()
  await espera()
  ok('guarda que no lea la app de escritorio', storage.readLocal === 'off',
    `storage.readLocal = ${JSON.stringify(storage.readLocal)}`)
  ok('guarda que sume WhatsApp Web', storage.readWeb === 'on',
    `storage.readWeb = ${JSON.stringify(storage.readWeb)}`)
  ok('confirma las fuentes en pantalla',
    doc.getElementById('said-source').textContent.includes('✓'))
  // Los valores son los que valida `wa-scope`: si el select ofreciera otro, el panel
  // diria guardado y el CLI lo tiraria sin que nadie se entere.
  const valores = (id) => [...doc.getElementById(id).options].map((o) => o.value).sort()
  ok('las fuentes solo ofrecen on/off',
    JSON.stringify(valores('read-local')) === JSON.stringify(['off', 'on']) &&
    JSON.stringify(valores('read-web')) === JSON.stringify(['off', 'on']),
    `local = ${JSON.stringify(valores('read-local'))}, web = ${JSON.stringify(valores('read-web'))}`)
  // Y se deja como estaba: lo de abajo comprueba el panel entero, no este ajuste.
  doc.getElementById('read-local').value = 'on'
  doc.getElementById('read-web').value = 'off'
  doc.getElementById('save-source').click()
  await espera()

  // Un select no puede ofrecer un valor que el CLI vaya a rechazar: si lo ofrece, el
  // panel dice guardado y `wa-scope` lo tira. Las listas se comprueban, no se confian.
  const opciones = (id) => [...doc.getElementById(id).options].map((o) => o.value)
  ok('el modo de transcripcion solo ofrece lo que el CLI acepta',
    JSON.stringify(opciones('transcribe')) === JSON.stringify(['local', 'off', 'api']),
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

console.log(`\n${pruebas - fallos}/${pruebas} en verde`)
process.exit(fallos ? 1 : 0)
