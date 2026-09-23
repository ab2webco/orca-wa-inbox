#!/usr/bin/env node
// Fotografia los dos paneles y deja los PNG en ../.orca-wa-inbox-capturas/.
//
// Existe porque un panel puede pasar los 35 tests y verse roto: el que se entrego
// con 12 px de ancho los pasaba. Los tests dicen que los handlers responden; esto
// dice como se ve. Los dos hacen falta.
//
// El panel real vive en un iframe con origen opaco y habla con el host por
// postMessage. Aca se carga como pagina de primer nivel, asi que window.parent es
// window misma y el stub de abajo contesta igual que el host. Los datos son de
// ejemplo a proposito: estas capturas se muestran, y los nombres de los grupos
// reales son de clientes.

// Las dependencias del arnes viven FUERA de la raiz del plugin: Orca hashea todo
// lo que hay bajo ella y rechaza symlinks, y node_modules/.bin son symlinks — con
// node_modules aca el plugin queda "No valido". NODE_PATH no sirve para ESM, asi
// que se resuelve con createRequire contra el directorio hermano.
import { createRequire } from 'node:module'

const DEPS = process.env.WA_INBOX_DEPS ??
  new URL('../../.orca-wa-inbox-deps/package.json', import.meta.url).pathname
const req = createRequire(DEPS)
const { chromium } = req('playwright')
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')
// Las capturas viven FUERA de la raiz del plugin, igual que las dependencias del
// arnes y por la misma razon: Orca hashea todo lo que hay bajo la raiz y rechaza
// el arbol entero si pasa de 50 MB, sin decir cual archivo sobra. Con las
// capturas adentro, correr este mismo arnes dejaba el plugin en "No valido" —
// 328 PNG son 207 MB — y el sintoma aparecia en Orca, lejos de la causa. La
// verificacion no puede romper lo que verifica.
const SALIDA = join(RAIZ, '..', '.orca-wa-inbox-capturas')

const ANCHOS = [1440, 768, 390, 320]

// El panel saca el idioma de navigator.language, asi que el idioma de la captura es el
// locale del contexto. Se fotografia en espanol y en ingles porque el defecto que esto
// tiene que delatar es media pantalla en el idioma equivocado: el CLI habla ingles y
// manda codigos, y si el panel no los traduce se ve — pero solo si alguien mira el
// panel en el otro idioma. En ingles bastan los dos extremos: la composicion no cambia
// con el idioma, lo que cambia es el texto.
const IDIOMAS = [
  { tag: 'es', locale: 'es-419', anchos: ANCHOS },
  { tag: 'en', locale: 'en-US', anchos: [1440, 320] }
]

// El host no deja que el panel vea su documento: le inyecta esta lista corta de
// tokens en el <style> del shell (PANEL_DESIGN_TOKEN_ALLOWLIST en orca-oss,
// src/shared/plugins/plugin-panel-shell.ts:34). Sin inyectarlos aca se fotografian
// los fallbacks del CSS, que son oscuros, y el tema claro sale ilegible por culpa
// del arnes y no del panel.
const TOKENS = {
  dark: {
    '--background': '#0a0a0a', '--foreground': '#fafafa',
    '--primary': '#e5e5e5', '--primary-foreground': '#171717',
    '--secondary': '#262626', '--secondary-foreground': '#fafafa',
    '--muted': '#262626', '--muted-foreground': '#a1a1a1',
    '--accent': '#404040', '--accent-foreground': '#fafafa',
    '--destructive': '#ff6568',
    '--border': 'rgb(255 255 255 / 0.07)', '--input': 'rgb(255 255 255 / 0.15)',
    '--ring': '#737373', '--radius': '0.625rem'
  },
  light: {
    '--background': '#fff', '--foreground': '#0a0a0a',
    '--primary': '#171717', '--primary-foreground': '#fafafa',
    '--secondary': '#f5f5f5', '--secondary-foreground': '#171717',
    '--muted': '#f5f5f5', '--muted-foreground': '#737373',
    '--accent': '#f5f5f5', '--accent-foreground': '#171717',
    '--destructive': '#e40014',
    '--border': '#e5e5e5', '--input': '#e5e5e5',
    '--ring': '#a1a1a1', '--radius': '0.625rem'
  }
}
const TEMAS = Object.keys(TOKENS)

// Lo que el host devolveria. Un solo objeto para los dos paneles: cada uno pide
// las claves que le importan.
const DATOS = {
  agentName: 'Watson',
  tone: 'Espanol neutro. Trata de usted. Frases cortas, sin modismos.',
  transcribeQuality: 'optima',
  ownerName: 'Fabiana Olivar',
  inboxDays: '7',
  transcribe: 'local',
  transcribeLang: 'auto',
  // Los requisitos opcionales que faltan: es texto que produce el CLI en ingles y que
  // el panel dice en el idioma del usuario. Van en la captura justamente para que se
  // vea si alguno se cuela sin traducir.
  health: {
    ok: true,
    optional: [{
      que: 'audio transcription', code: 'transcribe',
      como: 'no engine: download the model in Settings > Voice, or install a local one ' +
        'with brew install whisper-cpp',
      howCode: 'transcribe-no-engine'
    }]
  },
  // Con `kind` y `last`, que es lo que publica `wa-read chats`: sin `kind` el selector
  // pintaba TODAS con el circulo de "directo", y sin `last` el renglon de identidad
  // sale a medias. Las dos ultimas no estan autorizadas a proposito — sin ninguna sin
  // permiso, la captura no muestra que la lista se parte en dos.
  //
  // Los nombres llevan tilde, emoji, barras y un espacio doble porque asi son los
  // reales: es lo que el buscador tiene que tolerar, y una captura con nombres limpios
  // fotografia un caso que no existe. Los de verdad son de clientes y no van aca.
  chats: [
    { jid: '120363000000000001@g.us', name: 'Soporte — Cliente Norte', kind: 'grupo',
      last: '2026-09-17 14:02', unread: 3 },
    { jid: '120363000000000002@g.us', name: 'Operaciones internas', kind: 'grupo',
      last: '2026-09-17 13:12', unread: 0 },
    { jid: '120363000000000003@g.us', name: 'Proyecto Andes — QA', kind: 'grupo',
      last: '2026-09-16 18:20', unread: 1 },
    { jid: '573000000000@s.whatsapp.net', name: 'Laura M\u00e9ndez', kind: 'directo',
      last: '2026-09-17 13:30', unread: 0 },
    { jid: '120363000000000004@g.us', name: 'Lista de espera | IA Builder Lab \u{1F680} #2',
      kind: 'grupo', last: '2026-09-15 09:04', unread: 12 },
    { jid: '120363000000000005@g.us', name: 'PMO - Ab2Web -  NetSat', kind: 'grupo',
      last: '2026-09-14 16:48', unread: 0 },
    { jid: '573000000001@s.whatsapp.net', name: 'Camila Restrepo', kind: 'directo',
      last: '2026-09-13 11:22', unread: 2 }
  ],
  // Una de las conversaciones va en "ninguno": es el caso que motivo la opcion — un
  // uno a uno que solo quiere lectura y respuesta, sin tablero.
  scope: {
    '120363000000000001@g.us': {
      chatName: 'Soporte — Cliente Norte', provider: 'plane',
      target: 'SOP', mode: 'responder', updatedAt: '2026-09-17T14:02:00Z'
    },
    '120363000000000002@g.us': {
      chatName: 'Operaciones internas', provider: 'plane',
      target: 'OPS', mode: 'borrador', updatedAt: '2026-09-17T09:41:00Z'
    },
    '120363000000000003@g.us': {
      chatName: 'Proyecto Andes — QA', provider: 'github',
      target: 'acme/andes', mode: 'observar', updatedAt: '2026-09-16T18:20:00Z'
    },
    '573000000000@s.whatsapp.net': {
      chatName: 'Laura M\u00e9ndez', provider: 'ninguno', target: null,
      mode: 'responder', tone: 'Cercano pero de usted. Frases cortas.',
      instructions: 'Lea lo que manda y dejeme un resumen. Si pregunta por algo que ya ' +
        'esta en el board, contestale con el estado. No abras tarjetas aca.',
      updatedAt: '2026-09-17T13:30:00Z'
    }
  },
  routes: [
    { pattern: 'andes', provider: 'github', target: 'acme/andes' },
    { pattern: 'facturacion', provider: 'plane', target: 'FIN' }
  ],
  decisions: {},
  // Las claves salen de build_activity() en wa-scope, no de lo que parezca razonable:
  // un stub con otros nombres fotografia el stub, no el panel.
  activity: {
    syncedAt: '2026-09-17 14:02',
    running: false,
    pending: [
      {
        stanzaId: 'AAA1', date: '2026-09-17 13:58', chat: 'Soporte — Cliente Norte',
        chatJid: '120363000000000001@g.us', sender: 'Cliente Norte', kind: 'mencion',
        text: 'El reporte de ayer salio en blanco, lo necesitamos hoy.',
        hasMedia: false, decision: null
      },
      {
        stanzaId: 'AAA2', date: '2026-09-17 13:12', chat: 'Operaciones internas',
        chatJid: '120363000000000002@g.us', sender: 'Laura Mendez', kind: 'respuesta',
        text: 'Nota de voz (0:36) transcrita: pide el acceso al tablero de Andes.',
        hasMedia: true, decision: null
      },
      {
        stanzaId: 'AAA3', date: '2026-09-17 12:55', chat: 'Soporte — Cliente Norte',
        chatJid: '120363000000000001@g.us', sender: 'Cliente Norte', kind: 'directo',
        text: 'Adjunto el pantallazo del error al exportar.',
        hasMedia: true, decision: 'take'
      }
    ],
    recent: [
      // Los tres finales del aviso de cierre: el que salio, el que no salio por
      // permiso y el que no se pudo mandar. El del permiso es el que solo se ve aca:
      // en el chat, por definicion, no queda nada.
      // `detail` es lo que anoto quien hizo la accion: el agente en sus palabras, o
      // nada cuando el codigo de la accion ya lo dice todo. Lo que se ve traducido es
      // la accion, que es la etiqueta.
      { ts: '2026-09-17 13:52', chat: 'Soporte — Cliente Norte', action: 'closed',
        issue: 'SOP-211', detail: '' },
      { ts: '2026-09-17 13:44', chat: 'Proyecto Andes — QA', action: 'skipped',
        issue: 'AND-18', detail: 'AND-18 · observar · Proyecto Andes — QA' },
      { ts: '2026-09-17 13:30', chat: 'Operaciones internas', action: 'failed',
        issue: 'OPS-77', detail: 'el grupo ya no existe' },
      { ts: '2026-09-17 13:05', chat: 'Soporte — Cliente Norte', action: 'issue',
        issue: 'SOP-214', detail: 'Reporte en blanco al exportar' },
      { ts: '2026-09-17 12:40', chat: 'Operaciones internas', action: 'draft',
        issue: null, detail: '' },
      { ts: '2026-09-17 11:58', chat: 'Proyecto Andes — QA', action: 'denied',
        issue: null, detail: 'responder · observar' }
    ]
  }
}

// El stub corre dentro de la pagina. Contesta el mismo protocolo que el host:
// orca-panel-action -> orca-panel-action-result, y storage.get envuelve en value.
function stub(datos, opciones) {
  const falla = (opciones && opciones.falla) || []
  // El host RECHAZANDO una lectura, que es distinto de contestar vacio: admite 30
  // mensajes por 10 s y el sondeo pide 18. `window.__rechazar` deja que el guion lo
  // encienda DESPUES del primer pintado, que es la unica forma de fotografiar el
  // parpadeo: lo que hay que ver es la seccion entera, no el estado inicial.
  const rechazado = (key) =>
    ((opciones && opciones.rechazaGet) || []).indexOf(key) >= 0 ||
    ((window.__rechazar || []).indexOf(key) >= 0)
  // Cuanto tarda el host en contestar. Sin poder hacerlo tardar no se puede fotografiar
  // un guardado EN VUELO, que es justo el momento en que el panel mentia.
  const demoraSet = (opciones && opciones.demoraSet) || 0
  window.addEventListener('message', function (event) {
    const d = event.data
    if (!d || d.type !== 'orca-panel-action') return
    let respuesta = { ok: false, error: 'unsupported' }
    if (d.action === 'storage.get') {
      const key = d.params && d.params.key
      if (rechazado(key)) respuesta = { ok: false, errorCode: 'rate_limited' }
      else {
        const v = datos[key]
        respuesta = { ok: true, value: v === undefined ? null : { value: v } }
      }
    } else if (d.action === 'storage.set') {
      // El host que rechaza una escritura: es el caso que el panel decia guardado igual.
      if (falla.indexOf(d.params.key) >= 0) {
        respuesta = { ok: false, error: 'denied' }
      } else {
        datos[d.params.key] = d.params.value
        respuesta = { ok: true }
      }
    } else if (d.action === 'notifications.show') {
      respuesta = { ok: true }
    }
    const entregar = () => window.postMessage(
      Object.assign({ type: 'orca-panel-action-result', requestId: d.requestId }, respuesta), '*')
    if (demoraSet && d.action === 'storage.set') setTimeout(entregar, demoraSet)
    else entregar()
  })
}

// Los tres finales de la busqueda de conversaciones. Se fotografian porque son
// exactamente lo que el segundo usuario vio — un panel que decia "Buscando…" para
// siempre — y un estado sin salida no se detecta leyendo el codigo. Van a 1440 y 320,
// los dos extremos: en el medio no cambia la composicion.
const ANCHOS_ESTADO = [1440, 320]
const HACE_DIEZ_MINUTOS = new Date(Date.now() - 10 * 60 * 1000).toISOString()
const SIN_CHATS = Object.assign({}, DATOS, { chats: [], scope: {} })

const AHORA_MS = Date.now()

// Los cinco finales de una corrida. Se fotografian porque son la razon de ser del
// renglon: en pantalla los cuatro primeros eran la MISMA lista vacia, y el dueno
// concluia que el plugin no funcionaba mientras funcionaba bien. Un renglon que dice
// algo distinto en cada caso solo se puede comprobar mirandolo.
const AHORA_CORTO = new Date().toISOString().slice(0, 16).replace('T', ' ')
const SIN_PENDIENTES = Object.assign({}, DATOS.activity,
  { syncedAt: AHORA_CORTO, pending: [], mapped: 4, authorized: 4 })
const corrida = (run, extra) => Object.assign({}, DATOS,
  { decisions: {}, activity: Object.assign({}, SIN_PENDIENTES, extra, { run }) })

const PANELES = [
  { nombre: 'config', archivo: 'config.html', anchos: ANCHOS, datos: DATOS },
  {
    nombre: 'actividad',
    archivo: 'activity.html',
    anchos: ANCHOS,
    datos: Object.assign({}, DATOS, {
      activity: Object.assign({}, DATOS.activity, {
        mapped: 4,
        authorized: 4,
        run: { state: 'ok', startedAt: '2026-09-17 14:01', endedAt: '2026-09-17 14:02',
          looked: 4, pending: 3, reason: null }
      })
    })
  },
  // 1. Reviso y no habia nada: el caso comun y sano.
  {
    nombre: 'actividad-sin-nada', archivo: 'activity.html', anchos: ANCHOS_ESTADO,
    datos: corrida({ state: 'ok', startedAt: AHORA_CORTO, endedAt: AHORA_CORTO,
      looked: 4, pending: 0, reason: null })
  },
  // 2. Nunca corrio: el precheck salio 127, la automation no tiene proyecto, o esta
  //    pausada. Ninguna de esas tres llega hasta aca; lo unico cierto es que no corrio.
  {
    nombre: 'actividad-sin-corrida', archivo: 'activity.html', anchos: ANCHOS_ESTADO,
    datos: corrida({ state: 'never', startedAt: null, endedAt: null, looked: null,
      pending: null, reason: null })
  },
  // 3a. Arranco y no volvio: el lock vencio y nadie llamo a unlock.
  {
    nombre: 'actividad-cortada', archivo: 'activity.html', anchos: ANCHOS_ESTADO,
    datos: corrida({ state: 'interrupted', startedAt: '2026-09-17 09:12', endedAt: null,
      looked: null, pending: null, reason: null })
  },
  // 3b. Murio con motivo. El texto es real, de una corrida que se cayo asi.
  {
    nombre: 'actividad-fallo', archivo: 'activity.html', anchos: ANCHOS_ESTADO,
    datos: corrida({ state: 'failed', startedAt: AHORA_CORTO, endedAt: AHORA_CORTO,
      looked: 4, pending: 0,
      reason: 'This Claude account is in use by an assigned worktree' })
  },
  // 4. Nada autorizado: mapeadas y todas en off. Es configuracion, no falta de trabajo.
  {
    nombre: 'actividad-todo-off', archivo: 'activity.html', anchos: ANCHOS_ESTADO,
    datos: corrida({ state: 'ok', startedAt: AHORA_CORTO, endedAt: AHORA_CORTO,
      looked: 0, pending: 0, reason: null }, { authorized: 0 })
  },
  // Los cuatro momentos de conectar una linea de WhatsApp Web. Van a la captura porque
  // el unico que se ve al programar es el ultimo: los otros tres pasan mientras el
  // usuario mira OTRA ventana — la del QR —, y el que se entrega roto es siempre uno de
  // esos. A 320 ademas la fila se parte en bloques y el aviso de desvincular es el
  // parrafo mas largo del panel.
  {
    nombre: 'config-buscando', archivo: 'config.html', anchos: ANCHOS_ESTADO,
    datos: Object.assign({}, SIN_CHATS, {
      syncStatus: { running: true, startedAt: new Date().toISOString(), trigger: 'activate' }
    })
  },
  {
    nombre: 'config-fallo', archivo: 'config.html', anchos: ANCHOS_ESTADO,
    datos: Object.assign({}, SIN_CHATS, {
      syncStatus: {
        ok: false, at: new Date().toISOString(), chats: 0, reason: 'sin-herramientas',
        detail: 'spawn /Applications/Orca.app/plugins/ab2web.orca-wa-inbox/bin/wa-scope ENOENT',
        exitCode: null, trigger: 'activate'
      }
    })
  },
  {
    nombre: 'config-sin-respuesta', archivo: 'config.html', anchos: ANCHOS_ESTADO,
    datos: Object.assign({}, SIN_CHATS, {
      syncStatus: { running: true, startedAt: HACE_DIEZ_MINUTOS, trigger: 'activate' }
    })
  },
  // Los cuatro de abajo van a los CUATRO anchos y no a los dos extremos: son los
  // estados que se entregaron rotos, y el mensaje de error es texto largo que se
  // reacomoda distinto en cada ancho.
  {
    // El plugin que Orca NO arranco. En una maquina nueva, y en CADA actualizacion
    // mientras el usuario no vuelva a aprobarlo, esto es lo que hay: nadie corriendo.
    // Antes se veia igual que un panel sano y contestaba con 45 s de silencio.
    nombre: 'config-sin-worker', archivo: 'config.html', anchos: ANCHOS_ESTADO,
    datos: Object.assign({}, DATOS, { workerBeat: null, health: null, chats: [] })
  },
  {
    // El worker que latia y dejo de hacerlo. Es otro estado y otra accion: aca no hay
    // nada que aprobar, hay que reiniciar Orca.
    nombre: 'config-worker-parado', archivo: 'config.html', anchos: ANCHOS_ESTADO,
    datos: Object.assign({}, DATOS,
      { workerBeat: { at: new Date(Date.now() - 180000).toISOString() } })
  },
  {
    // El sistema que no puede leer, DICHO. Es lo que hoy ve TODO el mundo: los dos
    // transportes viejos se fueron y el sidecar todavia solo empareja. Va a los cuatro
    // anchos y en los dos idiomas porque el detalle del CLI es una FRASE en ingles, y
    // esta captura es lo unico que delata si se cuela sin traducir — el defecto que ya
    // se vio con "both routes are off: turn the desktop app or WhatsApp Web back on".
    nombre: 'config-sin-transporte', archivo: 'config.html', anchos: ANCHOS,
    datos: Object.assign({}, DATOS, {
      // La forma EXACTA que publica checkSystem con el doctor de hoy.
      health: { ok: false, problem: 'a message transport',
        problemCode: 'no-transport',
        detail: 'no-transport: there is no message transport yet. The two old read ' +
          'routes were removed and the sidecar that replaces them pairs the line but ' +
          'does not read messages yet.',
        optional: [{ que: 'audio transcription', code: 'transcribe',
          como: 'no engine: download the model in Settings > Voice',
          howCode: 'transcribe-no-engine' }] }
    })
  },
  {
    // El plugin LEYENDO, que es lo que este trabajo vino a conseguir: linea enlazada,
    // salud en verde, y el tope del almacen avisando que mordio. Va a los cuatro anchos
    // y en los dos idiomas porque el renglon del desalojo es texto nuevo, y un texto
    // nuevo en ingles dentro de un panel en espanol no lo delata ninguna prueba de
    // codigo: solo mirarlo. Es el mismo defecto de "both routes are off".
    nombre: 'config-leyendo', archivo: 'config.html', anchos: ANCHOS,
    datos: Object.assign({}, DATOS, {
      sidecar: { connection: 'open', qr: null, exited: false },
      // La forma EXACTA que publica checkSystem con el doctor del almacen.
      health: { ok: true, optional: [
        { que: 'message retention', code: 'retention',
          como: '12 message bodies were evicted on 2026-09-22 (1 expired, 11 over the cap)',
          howCode: 'retention-evicted' },
        { que: 'audio transcription', code: 'transcribe',
          como: 'no engine: download the model in Settings > Voice',
          howCode: 'transcribe-no-engine' }] }
    })
  },
  {
    // La maquina que viene de la via de WhatsApp Web, el primer arranque despues de
    // actualizar: el almacen acaba de subir de esquema y la linea de hoy todavia no
    // conecto. Es el estado EXACTO medido en la maquina del dueno, y va a los cuatro
    // anchos y en los dos idiomas porque el renglon de la migracion es texto nuevo:
    // un texto nuevo en ingles dentro de un panel en espanol no lo delata ninguna
    // prueba de codigo, solo mirarlo.
    nombre: 'config-almacen-migrado', archivo: 'config.html', anchos: ANCHOS,
    datos: Object.assign({}, DATOS, {
      sidecar: { connection: 'connecting', qr: null, exited: false },
      // La forma EXACTA que publica checkSystem con el doctor de una maquina recien
      // migrada (medido: `bin/wa-read doctor --json` sobre ~/.wa-inbox/capture.db).
      health: { ok: false, problem: 'a message transport',
        problemCode: 'no-transport',
        detail: 'no linked WhatsApp line can be read yet. Link a line from the plugin ' +
          'settings, with the QR code.',
        optional: [
          { que: 'message store upgrade', code: 'store-migrated',
            como: 'the message store was upgraded from version 0 to 1: the removed ' +
              'WhatsApp Web route left 0 cached message bodies and 2 of its own lines ' +
              'behind, and they were dropped',
            howCode: 'store-migrated-dropped' },
          { que: 'audio transcription', code: 'transcribe',
            como: 'no engine: download the model in Settings > Voice',
            howCode: 'transcribe-no-engine' }] }
    })
  },
  {
    // Un guardado que el host RECHAZO. Se fotografia porque el defecto que motivo esto
    // era visual: el panel decia "guardado" con un tilde verde sobre una escritura que
    // no ocurrio, y eso no lo delata ninguna prueba de codigo, solo mirarlo.
    nombre: 'config-guardado-fallo', archivo: 'config.html', anchos: ANCHOS_ESTADO,
    datos: DATOS, stub: { falla: ['inboxDays'] },
    guion: `document.getElementById('inbox-days').value = '30';
            document.getElementById('save-days').click()`
  },
  {
    // Y el guardado EN VUELO: el boton ocupado mientras el host todavia no contesta.
    // Sin poder verlo, un boton que se queda muerto y uno que esta trabajando son la
    // misma imagen.
    nombre: 'config-guardado-en-vuelo', archivo: 'config.html', anchos: ANCHOS_ESTADO,
    datos: DATOS, stub: { demoraSet: 4000 },
    guion: `document.getElementById('inbox-days').value = '30';
            document.getElementById('save-days').click()`,
    espera: 600
  },

  // La vinculacion de WhatsApp (T3/T4, docs/ENCARGO-TRANSPORTE-UNICO.md §6 y §12): los
  // cuatro estados que el criterio de aceptacion pide ver, a los cuatro anchos y en los
  // dos temas — no solo a 1440/320 como el resto de los estados de mas arriba, porque
  // esta seccion es la primera del panel y es la que decide si el plugin sirve de algo.
  {
    nombre: 'config-sidecar-esperando', archivo: 'config.html', anchos: ANCHOS,
    datos: Object.assign({}, DATOS,
      { sidecar: { connection: 'connecting', qr: null, exited: false } })
  },
  {
    nombre: 'config-sidecar-qr', archivo: 'config.html', anchos: ANCHOS,
    datos: Object.assign({}, DATOS, { sidecar: {
      connection: 'connecting',
      // Contenido real de un QR multi-dispositivo (docs/ENCARGO...§3: "QR emitido
      // contra WhatsApp real, si, 237 caracteres"): un texto corto fotografiaria un
      // QR mas simple que el que realmente hay que escanear.
      qr: { qr: '2@' + 'A'.repeat(180) + ',B'.repeat(28) + '==', ts: AHORA_MS, rotation: 3 },
      exited: false
    } })
  },
  {
    nombre: 'config-sidecar-conectado', archivo: 'config.html', anchos: ANCHOS,
    datos: Object.assign({}, DATOS,
      { sidecar: { connection: 'open', qr: null, exited: false } })
  },
  {
    nombre: 'config-sidecar-caido', archivo: 'config.html', anchos: ANCHOS,
    datos: Object.assign({}, DATOS, { sidecar: {
      connection: null, qr: null, exited: true,
      error: { code: 'sidecar-cayo', detail: 'sidecar exited (code 1, signal null)' }
    } })
  },
  // El plugin sin `process:spawn` concedido: la pantalla que de verdad vio el usuario
  // cuando la tarjeta decia "Requiere revision". Se fotografia aparte de "caido"
  // porque el texto es lo unico que cambia, y un texto que manda a la accion
  // equivocada no lo delata ninguna prueba de codigo — solo mirarlo.
  {
    nombre: 'config-sidecar-sin-permiso', archivo: 'config.html', anchos: ANCHOS,
    datos: Object.assign({}, DATOS, { sidecar: {
      connection: null, qr: null, exited: true, motivo: 'sidecar-sin-permiso',
      error: { code: 'sidecar-sin-permiso',
        detail: 'Access to this API has been restricted. Use --allow-child-process ' +
          'to manage permissions.' }
    } })
  },
  // Desvincular (§8.1). Los tres estados que solo existen por este boton, a los cuatro
  // anchos y en los dos temas: son los que deciden si alguien que escaneo con el
  // telefono equivocado sale del pozo o se queda mirando una sesion que no es la suya.
  {
    nombre: 'config-sidecar-desvincular', archivo: 'config.html', anchos: ANCHOS,
    datos: Object.assign({}, DATOS,
      { sidecar: { connection: 'open', qr: null, exited: false } }),
    // La confirmacion NO existe al cargar: es el segundo estado del boton, y
    // fotografiar el panel recien abierto nunca la muestra. Es justo lo que hay que
    // mirar — un aviso que no cabe, o que se lee flojo, no lo delata ninguna prueba.
    guion: "document.getElementById('pairing-unlink').click()",
    espera: 400
  },
  {
    nombre: 'config-sidecar-desvinculado', archivo: 'config.html', anchos: ANCHOS,
    // Lo que queda despues: sin sesion y esperando el codigo nuevo. El veredicto va
    // puesto para que la confirmacion quede tambien en pantalla.
    datos: Object.assign({}, DATOS, {
      sidecar: { connection: null, qr: null, exited: false },
      sidecarResult: { at: new Date().toISOString(), requestId: 'wa-de-ejemplo',
        action: 'desvincular', ok: true, code: 'desvinculado' }
    })
  },
  {
    // La sesion cerrada desde el telefono: el texto manda a desvincular «aca abajo», y
    // que el boton este de verdad ahi no lo delata ninguna prueba de composicion — se
    // mira. Es el estado que deja credenciales muertas en disco.
    nombre: 'config-sidecar-sesion-cerrada', archivo: 'config.html', anchos: ANCHOS,
    datos: Object.assign({}, DATOS, { sidecar: {
      connection: 'close', qr: null, exited: false, motivo: 'sesion-cerrada',
      error: { code: 'sesion-cerrada',
        detail: 'la sesion se cerro; hace falta escanear un QR nuevo' }
    } })
  },
  // El selector de conversaciones, que es la interaccion diaria del panel. Va a los
  // cuatro anchos y en los dos temas porque de esta seccion solo se ve, con el select
  // cerrado, lo que la captura tiene que delatar: la etiqueta de lo elegido con su
  // permiso, el conteo del filtro, y el renglon de identidad —un jid no tiene espacios
  // donde partir y a 320 px es lo primero que se sale del panel.
  //
  // El estado se arma con un guion porque NINGUNA de esas tres cosas existe al cargar:
  // hay que escribir en el buscador y elegir de la lista, que es exactamente lo que el
  // dueno hace todos los dias y lo que nadie fotografia.
  {
    // Un uno a uno YA autorizado, buscado SIN la tilde que el nombre si tiene: se ve
    // de una sola vez que la busqueda la tolera, que la etiqueta dice con que permiso
    // quedo, y que debajo esta la llave. Una lista desplegada no se puede fotografiar
    // —la pinta el sistema— asi que lo que se mira es lo que si queda en la pagina.
    nombre: 'config-elegir-autorizada', archivo: 'config.html', anchos: ANCHOS,
    datos: DATOS,
    guion: `const b = document.getElementById('chat-search');
            b.value = 'laura mendez';
            b.dispatchEvent(new Event('input'));
            const s = document.getElementById('chat-pick');
            s.value = '573000000000@s.whatsapp.net';
            s.dispatchEvent(new Event('change'));`,
    espera: 400
  },
  {
    // Y el contraste: un uno a uno SIN autorizar. Es el caso que hasta ahora no podia
    // existir —no habia un solo directo en la lista— y el que el dueno vino a pedir.
    // Sin permiso no hay insignia ni aviso, y el renglon de identidad es lo unico que
    // dice cual conversacion es antes de darle permiso a un agente sobre ella.
    nombre: 'config-elegir-sin-autorizar', archivo: 'config.html', anchos: ANCHOS,
    datos: DATOS,
    guion: `const b = document.getElementById('chat-search');
            b.value = 'ia builder lab 2';
            b.dispatchEvent(new Event('input'));
            const s = document.getElementById('chat-pick');
            s.value = '120363000000000004@g.us';
            s.dispatchEvent(new Event('change'));`,
    espera: 400
  },
  {
    nombre: 'config-sidecar-reintentar', archivo: 'config.html', anchos: ANCHOS,
    datos: Object.assign({}, DATOS, { sidecar: {
      connection: null, qr: null, exited: true, motivo: 'sidecar-no-arranco',
      error: { code: 'sidecar-no-arranco', detail: 'spawn /bin/false ENOENT' }
    } })
  }
]

async function main() {
  await rm(SALIDA, { recursive: true, force: true })
  await mkdir(SALIDA, { recursive: true })

  const navegador = await chromium.launch()
  const problemas = []
  let tomadas = 0

  for (const idioma of IDIOMAS) {
   for (const tema of TEMAS) {
    for (const ancho of idioma.anchos) {
      const contexto = await navegador.newContext({
        viewport: { width: ancho, height: 900 },
        colorScheme: tema,
        locale: idioma.locale,
        deviceScaleFactor: 2
      })
      for (const panel of PANELES) {
        if (!panel.anchos.includes(ancho)) continue
        const pagina = await contexto.newPage()
        const errores = []
        pagina.on('pageerror', (e) => errores.push(String(e)))
        // El latido se sella AQUI y no en DATOS: una corrida entera dura mas que los
        // 30 s de vencimiento, y las capturas del final salian con el aviso de "el
        // plugin no esta corriendo" encima del estado que venian a mostrar.
        let datos = 'workerBeat' in panel.datos
          ? panel.datos
          : Object.assign({}, panel.datos, { workerBeat: { at: new Date().toISOString() } })
        // Mismo defecto, mas apretado: el QR vive solo ~20 s (QR_VIGENCIA_MS en
        // config.html) y `AHORA_MS` se calculo UNA vez al arrancar este guion. Sin
        // esto, "config-sidecar-qr" salia pintando "el codigo vencio" en vez del QR —
        // se vio recien mirando la captura, que es justo la razon de que exista esta
        // regla del proyecto.
        if (datos.sidecar && datos.sidecar.qr) {
          datos = Object.assign({}, datos, { sidecar: Object.assign({}, datos.sidecar,
            { qr: Object.assign({}, datos.sidecar.qr, { ts: Date.now() }) }) })
        }
        await pagina.addInitScript(`(${stub.toString()})(${JSON.stringify(datos)}, ` +
          `${JSON.stringify(panel.stub || {})})`)
        await pagina.goto('file://' + join(RAIZ, panel.archivo))
        await pagina.waitForLoadState('load')
        const declaraciones = Object.entries(TOKENS[tema])
          .map(([k, v]) => `${k}:${v}`).join(';')
        await pagina.addStyleTag({ content: `:root{${declaraciones};color-scheme:${tema}}` })
        // El panel pinta despues de resolver storage.get; sin esto se fotografia vacio.
        const donde = `${panel.nombre} ${idioma.tag} ${tema} ${ancho}px`
        await pagina.waitForFunction(
          () => document.body && document.body.innerText.trim().length > 40,
          null, { timeout: 5000 }
        ).catch(() => problemas.push(`${donde}: quedo vacio`))

        // Los estados que solo existen despues de un clic. Fotografiar el panel recien
        // cargado nunca los muestra, y son justo los dos que se entregaron rotos.
        if (panel.guion) {
          await pagina.evaluate(panel.guion)
          await pagina.waitForTimeout(panel.espera || 1500)
        }

        // Scroll horizontal = algo no cabe. Es exactamente el defecto que las
        // capturas tienen que delatar, asi que se mide, no se mira.
        const desborde = await pagina.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          ventana: window.innerWidth
        }))
        if (desborde.scroll > desborde.ventana + 1) {
          problemas.push(
            `${donde}: desborda a lo ancho ` +
            `(${desborde.scroll} > ${desborde.ventana})`)
        }
        if (errores.length) {
          problemas.push(`${donde}: error JS — ${errores[0]}`)
        }

        // La lista desplegada de un select, en Linux, la pinta el motor de render con
        // el color del control: un fondo transparente ahi es blanco sobre blanco y no
        // se ve en ninguna captura, porque la captura fotografia el control cerrado.
        // Por eso se mide en vez de mirarse, y en los dos temas.
        for (const malo of await pagina.evaluate(() => {
          const opaco = (c) => {
            const m = /rgba?\(([^)]+)\)/.exec(c || '')
            return m ? Number((m[1].split(',')[3] ?? '1').trim()) > 0.99 : false
          }
          const salida = []
          for (const el of document.querySelectorAll('select, select option')) {
            const e = getComputedStyle(el)
            const que = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
            if (!opaco(e.backgroundColor)) salida.push(`${que} sin fondo propio (${e.backgroundColor})`)
            else if (e.backgroundColor === e.color) salida.push(`${que} con el texto del color del fondo`)
            if (!opaco(e.color)) salida.push(`${que} con el texto transparente (${e.color})`)
          }
          return salida
        })) {
          problemas.push(`${donde}: ${malo}`)
        }

        const nombre = `${panel.nombre}-${idioma.tag}-${tema}-${ancho}.png`
        await pagina.screenshot({ path: join(SALIDA, nombre), fullPage: true })
        tomadas += 1
        console.log(`  ${nombre}`)
        await pagina.close()
      }
      await contexto.close()
    }
   }
  }
  await navegador.close()

  console.log(`\n${tomadas} capturas en ${SALIDA}`)
  if (problemas.length) {
    console.error('\nProblemas:')
    for (const p of problemas) console.error(`  ${p}`)
    process.exit(1)
  }
  console.log('sin desbordes, sin errores de JS y con los select legibles')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
