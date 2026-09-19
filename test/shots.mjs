#!/usr/bin/env node
// Fotografia los dos paneles y deja los PNG en docs/capturas/.
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
const SALIDA = join(RAIZ, 'docs', 'capturas')

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
  chats: [
    { jid: '120363000000000001@g.us', name: 'Soporte — Cliente Norte' },
    { jid: '120363000000000002@g.us', name: 'Operaciones internas' },
    { jid: '120363000000000003@g.us', name: 'Proyecto Andes — QA' },
    { jid: '573000000000@s.whatsapp.net', name: 'Laura Mendez' }
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
      chatName: 'Laura Mendez', provider: 'ninguno', target: null,
      mode: 'responder', tone: 'Cercano pero de usted. Frases cortas.',
      instructions: 'Lee lo que manda y dejame un resumen. Si pregunta por algo que ya ' +
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
  const veredicto = opciones && opciones.veredicto
  window.addEventListener('message', function (event) {
    const d = event.data
    if (!d || d.type !== 'orca-panel-action') return
    let respuesta = { ok: false, error: 'unsupported' }
    if (d.action === 'storage.get') {
      const v = datos[d.params && d.params.key]
      respuesta = { ok: true, value: v === undefined ? null : { value: v } }
    } else if (d.action === 'storage.set') {
      // El host que rechaza una escritura: es el caso que el panel decia guardado igual.
      if (falla.indexOf(d.params.key) >= 0) {
        respuesta = { ok: false, error: 'denied' }
      } else {
        datos[d.params.key] = d.params.value
        // Y el worker contestando el pedido, que es lo que decide si el campo se vacia.
        if (veredicto && d.params.key === 'webRequest' && d.params.value) {
          datos.webStatus = Object.assign({ at: new Date().toISOString(),
            requestAt: d.params.value.at, action: d.params.value.action }, veredicto)
        }
        respuesta = { ok: true }
      }
    } else if (d.action === 'notifications.show') {
      respuesta = { ok: true }
    }
    window.postMessage(
      Object.assign({ type: 'orca-panel-action-result', requestId: d.requestId }, respuesta), '*')
  })
}

// Los tres finales de la busqueda de conversaciones. Se fotografian porque son
// exactamente lo que el segundo usuario vio — un panel que decia "Buscando…" para
// siempre — y un estado sin salida no se detecta leyendo el codigo. Van a 1440 y 320,
// los dos extremos: en el medio no cambia la composicion.
const ANCHOS_ESTADO = [1440, 320]
const HACE_DIEZ_MINUTOS = new Date(Date.now() - 10 * 60 * 1000).toISOString()
const SIN_CHATS = Object.assign({}, DATOS, { chats: [], scope: {} })

// Las lineas de WhatsApp Web, en los tres estados que el usuario no puede ver mientras
// programa. Los campos son los que escribe refrescarLineas() en main.mjs: con otros
// nombres se fotografiaria el stub y no el panel.
const AHORA_ISO = new Date().toISOString()
// El lugar viaja en la FILA: es lo que el worker calcula contra la pestana de verdad
// en cada vuelta, y por eso es lo que la captura tiene que ejercitar.
const LINEA_ESPERANDO = {
  id: 'web:pending:9f2c', label: 'Soporte Norte', profile: '9f2c', pending: true,
  linkedAt: null, authorizedChats: 0, pageId: 'page-1', state: 'esperando',
  placement: 'proyecto', project: 'alfred-soporte', worktreeId: 'wt-9'
}
const LINEA_ENLAZADA = {
  id: 'web:573000000000', label: 'Soporte Norte', profile: '9f2c', pending: false,
  linkedAt: '2026-09-17 09:12', authorizedChats: 2, pageId: 'page-1',
  state: 'enlazada', placement: 'proyecto', project: 'alfred-soporte',
  worktreeId: 'wt-9'
}
const LINEA_CAIDA = Object.assign({}, LINEA_ENLAZADA,
  { id: 'web:573111111111', label: 'Ventas', profile: 'a71b', state: 'caida' })

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
    // 1. Antes de conectar nada: el estado de casi todo el mundo. Lo que se mira es que
    //    la accion primaria se vea y que el vacio no parezca una falla.
    nombre: 'config-conectar', archivo: 'config.html', anchos: ANCHOS_ESTADO,
    datos: Object.assign({}, DATOS, { webLines: { at: AHORA_ISO, lines: [] } })
  },
  {
    // 2. Esperando el escaneo. El mensaje tiene que decir que hacer y donde quedo la
    //    pestana: "donde se abre" fue la pregunta real, dos veces.
    nombre: 'config-esperando', archivo: 'config.html', anchos: ANCHOS_ESTADO,
    datos: Object.assign({}, DATOS, {
      webLines: { at: AHORA_ISO, lines: [LINEA_ESPERANDO] }
    })
  },
  {
    // 3. Enlazada, y con el fallback: este Orca no sabe abrir la pestana en el espacio
    //    flotante, asi que quedo dentro de un proyecto y eso se dice con el nombre.
    nombre: 'config-enlazada', archivo: 'config.html', anchos: ANCHOS_ESTADO,
    datos: Object.assign({}, DATOS, {
      webLines: { at: AHORA_ISO, lines: [LINEA_ENLAZADA] }
    })
  },
  {
    // 3b. La MISMA linea enlazada pero con la pestana en el espacio flotante. Va a la
    //     captura porque es la frase que mando al usuario a un panel vacio: tiene que
    //     decir que ese panel no se abre desde aca y como lo abre el. Y la fila de
    //     abajo esta en un proyecto: las dos frases conviven, que es lo que pasa en
    //     cuanto hay dos lineas.
    nombre: 'config-linea-flotante', archivo: 'config.html', anchos: ANCHOS_ESTADO,
    datos: Object.assign({}, DATOS, {
      readWeb: 'on',
      webLines: { at: AHORA_ISO, lines: [
        Object.assign({}, LINEA_ENLAZADA, { label: 'Soporte Norte',
          placement: 'flotante', project: null, worktreeId: null }),
        Object.assign({}, LINEA_ESPERANDO, { id: 'web:pending:a71b', label: 'Ventas',
          profile: 'a71b', pageId: 'page-2' })
      ] }
    })
  },
  {
    // 4. La sesion se cayo. Es el estado que el CLI ya sabia contar y el panel no: una
    //    linea registrada que no lee nada y no dice por que.
    nombre: 'config-caida', archivo: 'config.html', anchos: ANCHOS_ESTADO,
    datos: Object.assign({}, DATOS, {
      webLines: { at: AHORA_ISO,
        lines: [LINEA_CAIDA, Object.assign({}, LINEA_ENLAZADA, { state: 'sin-pestana' })] }
    })
  },
  {
    // TODOS los estados de una linea, juntos y en una sola tabla. Van juntos a
    // proposito: lo que hay que mirar no es cada fila sino que ninguna se parezca a
    // otra — el defecto reportado fue una fila que decia "Esperando el escaneo" y
    // ofrecia "Ver la pestana" sin ninguna pestana detras, y eso solo se ve al lado
    // de la fila que SI tiene pestana. Las dos ultimas son las que no se pueden
    // escribir a mano en el worker: una linea a medias cuya pestana murio con el
    // reinicio de Orca, y un estado que este panel todavia no conoce.
    nombre: 'config-lineas-todos-los-estados', archivo: 'config.html',
    anchos: ANCHOS_ESTADO,
    datos: Object.assign({}, DATOS, {
      readWeb: 'on',
      webLines: { at: AHORA_ISO, lines: [
        Object.assign({}, LINEA_ESPERANDO, { label: 'Esperando' }),
        Object.assign({}, LINEA_ESPERANDO, { label: 'Abriendo', state: 'cargando' }),
        Object.assign({}, LINEA_ENLAZADA, { label: 'Enlazada' }),
        Object.assign({}, LINEA_CAIDA, { label: 'Caida' }),
        Object.assign({}, LINEA_ENLAZADA, { label: 'Sin pestana', pageId: null,
          state: 'sin-pestana' }),
        Object.assign({}, LINEA_ESPERANDO, { label: 'Sin escanear y sin pestana',
          pageId: null, state: 'sin-pestana' }),
        Object.assign({}, LINEA_ENLAZADA, { label: 'Sin Orca', pageId: null,
          state: 'sin-orca' }),
        Object.assign({}, LINEA_ENLAZADA, { label: 'Estado nuevo', pageId: null,
          state: 'algo-que-este-panel-no-conoce' })
      ] }
    })
  },
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
  {
    // La sesion web caida es el texto opcional mas largo que produce el CLI, y el unico
    // que trae una instruccion con mayusculas en medio de la frase. Va a la captura
    // porque un parrafo que desborda a 320 se ve perfecto en el JSON.
    nombre: 'config-web-caida', archivo: 'config.html', anchos: ANCHOS_ESTADO,
    datos: Object.assign({}, DATOS, {
      health: {
        ok: true,
        optional: [{
          que: 'WhatsApp Web as a second line', code: 'web',
          como: 'WhatsApp Web: that WhatsApp Web session is not linked — the QR code is ' +
            'on screen, scan it with the phone of THAT number',
          howCode: 'web-logged-out'
        }]
      }
    })
  },
  {
    // La linea A MEDIAS, que es el estado en el que estaba el dueno: `read_web on`, la
    // linea registrada y sin escanear, y el plugin leyendo su WhatsApp PERSONAL por la
    // primera pestana que encontro. Ahora no lee nada y lo dice. Va a la captura porque
    // son DOS mensajes que tienen que leerse juntos y no repetirse: la fila de la tabla
    // ("Esperando el escaneo") y el renglon opcional que explica que, hasta terminarla,
    // la via web no lee nada.
    nombre: 'config-linea-a-medias', archivo: 'config.html', anchos: ANCHOS_ESTADO,
    datos: Object.assign({}, DATOS, {
      readWeb: 'on',
      webLines: { at: AHORA_ISO, lines: [LINEA_ESPERANDO] },
      health: {
        ok: true,
        optional: [{
          que: 'WhatsApp Web as a second line', code: 'web',
          como: "NoVa: the web route is on, but the only line(s) registered — 'NoVa' — " +
            'never finished linking: the QR code was not scanned, so there is no ' +
            'session of that number to read',
          howCode: 'web-line-pending'
        }]
      }
    })
  },
  {
    // La maquina de Linux o Windows que lee SOLO por la sesion web. Aca el panel decia
    // "WhatsApp no esta conectado" en rojo con la sesion leyendo perfecto, porque los
    // cinco chequeos de la base local salian como requisito sin condicion. Ahora no
    // bloquean y se colapsan en una fila: por eso va a la captura, para verla una sola
    // y no cinco circulos grises ofreciendo activar un sistema operativo.
    nombre: 'config-solo-web', archivo: 'config.html', anchos: ANCHOS_ESTADO,
    datos: Object.assign({}, DATOS, {
      readWeb: 'on', readWebText: 'memoria',
      webLines: { at: AHORA_ISO, lines: [LINEA_ENLAZADA] },
      health: {
        ok: true,
        optional: [{
          que: 'local WhatsApp database', code: 'local',
          como: 'Linux; no official app for this system; missing; does not exist',
          howCode: 'local-covered-by-web'
        }]
      }
    })
  },
  // Los cuatro de abajo van a los CUATRO anchos y no a los dos extremos: son los
  // estados que se entregaron rotos, y el mensaje de error es texto largo que se
  // reacomoda distinto en cada ancho.
  {
    // Lo que el usuario vio y no pudo ver: guardar de donde lee fallando. El panel
    // decia "Fuentes guardadas" con la escritura rechazada, porque de las tres
    // encadenadas solo se miraba el resultado de la ultima.
    nombre: 'config-fuente-fallo', archivo: 'config.html', anchos: ANCHOS,
    datos: Object.assign({}, DATOS, { readLocal: 'on', readWeb: 'off' }),
    stub: { falla: ['readWeb'] },
    espera: 900,
    guion: () => {
      document.getElementById('read-local').value = 'off'
      document.getElementById('read-web').value = 'on'
      document.getElementById('save-source').click()
      document.getElementById('said-source').scrollIntoView({ block: 'center' })
    }
  },
  {
    // Y conectar una linea que falla: el nombre tipeado TIENE que seguir ahi. Se
    // perdia, junto con el motivo, y el usuario se quedaba mirando un formulario vacio.
    nombre: 'config-linea-fallo', archivo: 'config.html', anchos: ANCHOS,
    datos: Object.assign({}, DATOS, { webLines: { at: AHORA_ISO, lines: [] } }),
    stub: { veredicto: { ok: false, code: 'sin-orca', detail: 'spawn orca ENOENT' } },
    espera: 2500,
    guion: () => {
      document.getElementById('line-label').value = 'Linea del bot'
      document.getElementById('link-line').click()
      document.getElementById('said-line').scrollIntoView({ block: 'center' })
    }
  },
  {
    // La configuracion que el dueno queria: la app de escritorio apagada y la lectura
    // por la sesion web. Lo que se mira es que los dos selectores digan eso y que el
    // panel NO este pintado de rojo pidiendo la app que acaba de apagar.
    nombre: 'config-escritorio-off', archivo: 'config.html', anchos: ANCHOS,
    datos: Object.assign({}, DATOS, {
      readLocal: 'off', readWeb: 'on', readWebText: 'memoria',
      webLines: { at: AHORA_ISO, lines: [LINEA_ENLAZADA] },
      health: {
        ok: true,
        optional: [{
          que: 'local WhatsApp database', code: 'local',
          como: 'Darwin; the desktop app is turned off for reading',
          howCode: 'local-covered-by-web'
        }]
      }
    })
  },
  {
    // Y la que pidio de verdad: las DOS encendidas en el mismo Mac — la app leyendo su
    // numero personal y una sesion web leyendo la del bot. Dos lineas, una bandeja.
    nombre: 'config-dos-lineas', archivo: 'config.html', anchos: ANCHOS,
    datos: Object.assign({}, DATOS, {
      readLocal: 'on', readWeb: 'on', readWebText: 'memoria',
      webLines: { at: AHORA_ISO,
        lines: [Object.assign({}, LINEA_ENLAZADA, { label: 'Linea del bot' })] }
    })
  },
  {
    // Lo que la bandeja ve cuando la linea es web: el cuerpo casi nunca llega y el
    // adjunto no deja ruta. El panel mostraba el marcador crudo del CLI.
    nombre: 'actividad-sin-texto', archivo: 'activity.html', anchos: ANCHOS_ESTADO,
    datos: Object.assign({}, DATOS, {
      activity: Object.assign({}, DATOS.activity, {
        mapped: 4, authorized: 4,
        run: { state: 'ok', startedAt: AHORA_CORTO, endedAt: AHORA_CORTO,
          looked: 4, pending: 3, reason: null },
        pending: [
          { stanzaId: 'W1', date: AHORA_CORTO, chat: 'Soporte — Cliente Norte',
            sender: 'Ana Restrepo', kind: 'mencion', text: '',
            noText: 'not-loaded', mediaKind: 'image', hasMedia: true },
          { stanzaId: 'W2', date: AHORA_CORTO, chat: 'Operaciones internas',
            sender: 'Beto Ramirez', kind: 'mencion', text: '',
            noText: 'off', mediaKind: null, hasMedia: false },
          { stanzaId: 'W3', date: AHORA_CORTO, chat: 'Laura Mendez',
            sender: 'Laura Mendez', kind: 'directo', text: '',
            noText: 'no-body', mediaKind: 'ptt', hasMedia: true }
        ]
      })
    })
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
        await pagina.addInitScript(`(${stub.toString()})(${JSON.stringify(panel.datos)}, ` +
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

  console.log(`\n${tomadas} capturas en docs/capturas/`)
  if (problemas.length) {
    console.error('\nProblemas:')
    for (const p of problemas) console.error(`  ${p}`)
    process.exit(1)
  }
  console.log('sin desbordes ni errores de JS')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
