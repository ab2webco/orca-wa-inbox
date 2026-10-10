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
import { informeDeEjemplo, informeVacio } from './informes-ejemplo.mjs'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')
// Las capturas viven FUERA de la raiz del plugin, igual que las dependencias del
// arnes y por la misma razon: Orca hashea todo lo que hay bajo la raiz y rechaza
// el arbol entero si pasa de 50 MB, sin decir cual archivo sobra. Con las
// capturas adentro, correr este mismo arnes dejaba el plugin en "No valido" —
// 328 PNG son 207 MB — y el sintoma aparecia en Orca, lejos de la causa. La
// verificacion no puede romper lo que verifica.
//
// WA_INBOX_CAPTURAS cambia la carpeta: dos copias del repo (un worktree por rama) que
// comparten la de arriba se borran las capturas una a la otra, porque cada corrida la
// vacia antes de empezar.
const SALIDA = process.env.WA_INBOX_CAPTURAS ??
  join(RAIZ, '..', '.orca-wa-inbox-capturas')
// WA_INBOX_SOLO="tablero,config-sidecar" fotografia solo los paneles cuyo nombre empieza
// asi: para mirar un estado sin esperar las cientos de capturas de los demas.
const SOLO = (process.env.WA_INBOX_SOLO ?? '').split(',').map((x) => x.trim()).filter(Boolean)

const ANCHOS = [1440, 768, 390, 320]
// Para mirar un solo cambio sin sacar los demas: WA_INBOX_TEMA=dark, WA_INBOX_ANCHO=1440 y
// WA_INBOX_IDIOMA=es dejan solo ese tema, ese ancho y ese idioma.
const SOLO_TEMA = process.env.WA_INBOX_TEMA ?? ''
const SOLO_ANCHO = Number(process.env.WA_INBOX_ANCHO ?? 0)
const SOLO_IDIOMA = process.env.WA_INBOX_IDIOMA ?? ''

// El panel saca el idioma de navigator.language, asi que el idioma de la captura es el
// locale del contexto. Se fotografia en espanol y en ingles porque el defecto que esto
// tiene que delatar es media pantalla en el idioma equivocado: el CLI habla ingles y
// manda codigos, y si el panel no los traduce se ve — pero solo si alguien mira el
// panel en el otro idioma. En ingles bastan los dos extremos: la composicion no cambia
// con el idioma, lo que cambia es el texto.
// En portugues solo los estados que lo piden (`idiomas`): los informes, donde las fechas
// de pt-BR ("seg., 28", "Semana de 28 de set.") son las mas largas y ya desbordaron.
const IDIOMAS = [
  { tag: 'es', locale: 'es-419', anchos: ANCHOS },
  { tag: 'en', locale: 'en-US', anchos: [1440, 320] },
  { tag: 'pt', locale: 'pt-BR', anchos: ANCHOS, soloSiLoPide: true }
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
  ownerName: 'Persona De Ejemplo',
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
    { jid: '120363000000000004@g.us', name: 'Lista de espera | Taller Demo \u{1F680} #2',
      kind: 'grupo', last: '2026-09-15 09:04', unread: 12 },
    { jid: '120363000000000005@g.us', name: 'Comite - Cliente -  Sur', kind: 'grupo',
      last: '2026-09-14 16:48', unread: 0 },
    { jid: '573000000001@s.whatsapp.net', name: 'Camila Restrepo', kind: 'directo',
      last: '2026-09-13 11:22', unread: 2 }
  ],
  // T22.1: quienes escribieron (ids de prueba, sin texto) y el numero del dueno ya elegido.
  senders: [
    { id: '100000000000001@lid', name: 'Ana Restrepo', chats: ['Soporte — Cliente Norte'] },
    { id: '100000000000002@lid', name: 'Beto Socio',
      chats: ['Operaciones internas', 'Proyecto Andes — QA'] }
  ],
  owners: [{ id: '100000000000001@lid', name: 'Ana Restrepo' }],
  // Los proyectos que el dueno acepto (T12) y lo que Orca propone todavia (T12). Rutas y
  // nombres de ejemplo: ninguno existe en ninguna maquina.
  projects: [
    { id: 'alfa-demo', name: 'Alfa Demo', path: '/srv/ejemplo/alfa-demo',
      note: 'Tienda en linea: cobros, envios y facturas' },
    { id: 'beta-demo', name: 'Beta Demo', path: '/srv/ejemplo/beta-demo', note: '' }
  ],
  projectsStatus: {
    at: new Date().toISOString(), ok: true, reason: null, detail: null,
    proposals: [
      { id: 'gama-demo', name: 'Gama Demo', path: '/srv/ejemplo/gama-demo' },
      { id: 'delta-servicio-con-un-nombre-largo',
        name: 'Delta Servicio Con Un Nombre Largo De Verdad',
        path: '/srv/ejemplo/clientes/region-andina/delta-servicio-con-un-nombre-largo' }
    ]
  },
  // Dos conversaciones ya con proyecto; una de antes de T13, que sigue con su servicio y
  // destino viejos y se ve sin proyecto; y una en "ninguno": el caso que motivo la opcion —
  // un uno a uno que solo quiere lectura y respuesta, sin tablero.
  scope: {
    '120363000000000001@g.us': {
      chatName: 'Soporte — Cliente Norte', provider: 'ninguno', target: null,
      workspace: 'alfa-demo', mode: 'responder', updatedAt: '2026-09-17T14:02:00Z'
    },
    '120363000000000002@g.us': {
      chatName: 'Operaciones internas', provider: 'ninguno', target: null,
      workspace: 'beta-demo', mode: 'borrador', updatedAt: '2026-09-17T09:41:00Z'
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
    { pattern: 'andes', workspace: 'beta-demo' },
    { pattern: 'facturacion', workspace: 'alfa-demo' },
    // Una regla de antes de T13: sigue mostrando su destino viejo para poder quitarla.
    { pattern: 'cobros', provider: 'plane', target: 'FIN' }
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
      // Dos avisos, que son lo UNICO de esta lista que espera algo del dueno: el
      // agente los levanta porque no le toca decidirlos. Van al fixture porque la
      // seccion que los muestra abre el panel, y sin una sola alerta esa seccion sale
      // vacia en TODAS las capturas — que es justo la unica forma en que no se puede
      // comprobar. `detail` va en el formato real que escribe `wa-scope alert`,
      // "titulo | cuerpo", para que la captura pruebe que se parte y no sale la barra
      // cruda en pantalla.
      { ts: '2026-09-17 14:01', chat: 'Soporte — Cliente Norte', action: 'alert',
        issue: '', detail: 'Piden descuento del 30% | Dice que otro proveedor se lo ' +
          'deja en 1.400 y quiere respuesta hoy. El precio no lo decido yo.' },
      { ts: '2026-09-17 13:58', chat: 'Operaciones internas', action: 'alert',
        issue: '', detail: 'Piden acceso al tablero de Andes | Es una persona que no ' +
          'esta en el equipo. No doy accesos sin que usted lo diga.' },
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

// Varias lineas a la vez (L4): el worker siempre publica la lista de lineas, dentro del
// estado de la principal (`sidecar.lineas`). Sin linea vinculada es UNA, esperando su
// codigo; con la linea vinculada (`CON_LINEA`, abajo), su numero. Numeros de prueba.
const LINEA_PRINCIPAL = { carpeta: 'pn-573000000001', cuenta: 'pn:573000000001',
  tipo: 'support', alta: '2026-09-01T09:00:00.000Z' }
const LINEA_SEGUNDA = { carpeta: 'pn-573000000011', cuenta: 'pn:573000000011',
  tipo: 'support', alta: '2026-10-01T09:00:00.000Z' }
const LINEA_NUEVA = { carpeta: 'nueva-mg7x2k', cuenta: null, tipo: 'support',
  alta: '2026-10-05T09:00:00.000Z' }
// Estado sin linea vinculada, como lo deja el worker: la primera espera su codigo.
const SIN_VINCULAR = Object.assign({}, DATOS, { sidecar: { connection: null, qr: null,
  exited: false, lineas: [Object.assign({}, LINEA_NUEVA, { carpeta: 'nueva-mg7x1a' })] } })

// El stub corre dentro de la pagina. Contesta el mismo protocolo que el host:
// orca-panel-action -> orca-panel-action-result, y storage.get envuelve en value.
function stub(datos, opciones) {
  const falla = (opciones && opciones.falla) || []
  // El host RECHAZANDO una lectura, que es distinto de contestar vacio: admite 30
  // mensajes por 10 s y el sondeo pide 18. `window.__rechazar` deja que el guion lo
  // encienda DESPUES del primer pintado, que es la unica forma de fotografiar el
  // parpadeo: lo que hay que ver es la seccion entera, no el estado inicial.
  // `rechazaHastaMs`: el host vuelve a contestar pasado ese tiempo, para fotografiar la
  // tarjeta que estaba sin leer ya con lo guardado (ajustes-sin-lectura).
  const hasta = opciones && opciones.rechazaHastaMs ? Date.now() + opciones.rechazaHastaMs : 0
  const rechazado = (key) =>
    (((opciones && opciones.rechazaGet) || []).indexOf(key) >= 0 &&
      (!hasta || Date.now() < hasta)) ||
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
        // El worker contestando una accion del tablero: deja SU veredicto, emparejado por el
        // id del pedido, despues de `demoraVeredicto`. Sin poder tardar no se fotografia lo
        // que esta en vuelo; sin poder fallar, tampoco un error.
        const v = opciones && opciones.veredictoAccion
        if (d.params.key === 'scopeRequest' && v && d.params.value && !d.params.value.tombstone) {
          const id = d.params.value.id
          setTimeout(function () {
            datos.scopeResult = Object.assign({ at: new Date().toISOString(), requestId: id }, v)
          }, opciones.demoraVeredicto || 0)
        }
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

// El latido de la linea (`sidecar.latido`): "conectado" ya no se dice sin uno fresco.
// `LATIDO_FRESCO` es un marcador y no una hora: la hora se sella al fotografiar, igual
// que el `ts` del QR, porque una corrida entera dura mas que los 150 s que vale un
// latido, y las capturas del final salian "sin senal" sobre un estado conectado.
const LATIDO_FRESCO = { fresco: true }
// El latido viejo, de la linea muda: 25 minutos antes de arrancar el guion. Relativo y
// no una fecha fija, para que el panel muestre la hora sola (pasado un dia muestra la
// fecha entera, y eso es otro estado).
const LATIDO_VIEJO = { ts: Date.now() - 25 * 60 * 1000, conectado: true }

// Los cinco finales de una corrida. Se fotografian porque son la razon de ser del
// renglon: en pantalla los cuatro primeros eran la MISMA lista vacia, y el dueno
// concluia que el plugin no funcionaba mientras funcionaba bien. Un renglon que dice
// algo distinto en cada caso solo se puede comprobar mirandolo.
const AHORA_CORTO = new Date().toISOString().slice(0, 16).replace('T', ' ')
const SIN_PENDIENTES = Object.assign({}, DATOS.activity,
  { syncedAt: AHORA_CORTO, pending: [], mapped: 4, authorized: 4 })
const corrida = (run, extra) => Object.assign({}, DATOS,
  { decisions: {}, activity: Object.assign({}, SIN_PENDIENTES, extra, { run }) })

// Lo mismo para el renglon de la linea: una corrida sana y limpia, y lo unico que
// cambia entre captura y captura es el estado del sidecar.
const conLinea = (sidecar) => Object.assign({},
  corrida({ state: 'ok', startedAt: AHORA_CORTO, endedAt: AHORA_CORTO,
    looked: 4, pending: 0, reason: null }),
  { sidecar })

// El tablero de casos (T5). La clave `board` la escribe `wa-scope` (odd/tasks/kanban-casos.md,
// "Contratos"): estas tarjetas tienen esa forma exacta y datos INVENTADOS. Los nombres
// de los chats y los textos de las propuestas son de ejemplo, igual que arriba.
const minutos = (n) => new Date(AHORA_MS - n * 60000).toISOString()
const CUENTAS_VACIAS = { recibido: 0, clasificado: 0, decision: 0, trabajo: 0, listo: 0,
  respondido: 0, cerrado: 0, bloqueado: 0 }
const ACCIONES = ['atender', 'ignorar', 'enviar', 'editar', 'ejecutar', 'reclasificar', 'cerrar',
  'reabrir', 'proyecto']
const caso = (id, etapa, extra) => Object.assign({
  case_id: id, account: 'local', chat_jid: `1203630000000000${10 + id}@g.us`,
  chat_name: 'Soporte — Cliente Norte', stage: etapa, title: 'Caso de ejemplo',
  summary: '', clase: 'card', prioridad: 'none', jev: null, proposal: null,
  exceptions: [], blocked_reason: null, ticket: null, updated_at: minutos(5),
  actions: ACCIONES
}, extra)
// Los retenidos fuera de un caso que el tablero lista (approve-solo-dueno). Datos de
// mentira: ningun numero ni nombre real.
const RETENIDOS = [
  { req_id: 'nota-proyecto-1', chat_jid: '573000000001@s.whatsapp.net', chat: 'Laura Ejemplo',
    text: 'Aviso del proyecto Alfa Demo: la renovacion queda en $1.400 y la publicamos el viernes a las 10:00.',
    at: minutos(25), reasons: ['money', 'commitment'] },
  { req_id: 'b7c1e0aa42', chat_jid: '120363000000000009@g.us', chat: 'Comite - Cliente - Sur',
    text: 'Listo: el informe quedo publicado.', at: minutos(7), reasons: ['jev'] }
]
const TABLERO_CASOS = [
  caso(1, 'decision', {
    title: 'Piden descuento del 30% en la renovación', prioridad: 'high',
    chat_name: 'Soporte — Cliente Norte', updated_at: minutos(3),
    summary: 'Dice que otro proveedor se lo deja en 1.400 y quiere respuesta hoy.',
    jev: { attention_class: 'money', skip: false,
      flags: ['asks_for_money_or_payment', 'client_waiting_or_service_down'] },
    proposal: { tipo: 'responder', version: 'v1f3a',
      texto: 'Hola, gracias por avisar. El precio de renovación es el vigente; ' +
        'si quieres, lo revisamos en una llamada esta semana.' },
    exceptions: ['money'], project: { id: 'alfa-demo', name: 'Alfa Demo' },
    // La historia del caso (`caso_evento`): lo que hizo el agente con el, paso a paso.
    // T22: lo que no mueve la etapa dice que paso, y lo repetido va con su cuenta.
    events: [
      { de: null, a: 'recibido', actor: 'automatizacion', que: 'message', at: minutos(30) },
      { de: 'recibido', a: 'recibido', actor: 'automatizacion', que: 'message', at: minutos(30) },
      { de: 'recibido', a: 'recibido', actor: 'automatizacion', que: 'message', at: minutos(29) },
      { de: 'recibido', a: 'recibido', actor: 'automatizacion', que: 'sticker', at: minutos(29) },
      { de: 'recibido', a: 'clasificado', actor: 'jev', que: 'classified', args: ['card'],
        at: minutos(29) },
      { de: 'clasificado', a: 'clasificado', actor: 'jev', que: 'jev', args: ['agent'],
        at: minutos(29) },
      { de: 'clasificado', a: 'decision', actor: 'agente', que: 'proposal', args: ['responder'],
        at: minutos(3) },
      { de: 'decision', a: 'decision', actor: 'regla', que: 'rule', args: ['money'],
        at: minutos(3) },
      { de: 'decision', a: 'decision', actor: 'automatizacion', que: 'held',
        args: ['money', 'states_status_not_verified'], at: minutos(2) },
      // T14: el aviso al numero de aprobacion del dueno.
      { de: 'decision', a: 'decision', actor: 'automatizacion', que: 'wa_notice',
        at: minutos(2) }] }),
  caso(2, 'decision', {
    title: 'Pide el acceso al tablero de Andes', clase: 'alert', prioridad: 'urgent',
    chat_name: 'Operaciones internas', updated_at: minutos(22),
    summary: 'Es una persona que no está en el equipo.',
    jev: { attention_class: 'access_or_credential', skip: false, flags: ['asks_for_credential'] },
    proposal: { tipo: 'escalar', version: 'v2b71', texto: 'Escalar al responsable de accesos.' },
    exceptions: ['credential', 'jev'] }),
  caso(3, 'decision', {
    title: 'Promete entrega el viernes', prioridad: 'medium', chat_name: 'Laura Méndez',
    updated_at: minutos(48),
    proposal: { tipo: 'responder', version: 'v3c09',
      texto: 'Te confirmo que lo tendrás el viernes a primera hora.' },
    jev: { attention_class: 'needs_decision', skip: false, flags: ['promises_a_date'] },
    exceptions: ['commitment'] }),
  caso(4, 'recibido', { title: 'Nota de voz sin transcribir', clase: 'doubtful',
    chat_name: 'Proyecto Andes — QA', updated_at: minutos(1) }),
  caso(5, 'clasificado', { title: 'El reporte de ayer salió en blanco', prioridad: 'high',
    chat_name: 'Soporte — Cliente Norte', updated_at: minutos(9),
    summary: 'Lo necesitan hoy.', needs_agent: true,
    jev: { attention_class: 'bug_report', skip: false, flags: ['urgency_pressure'] } }),
  caso(6, 'clasificado', { title: 'Saludo de buenos días', clase: 'nothing',
    chat_name: 'Comite - Cliente -  Sur', updated_at: minutos(14),
    jev: { attention_class: 'pleasantry', skip: true, flags: [] } }),
  caso(7, 'trabajo', { title: 'Reporte en blanco al exportar', prioridad: 'high',
    chat_name: 'Soporte — Cliente Norte', updated_at: minutos(35), ticket: 'SOP-214',
    proposal: { tipo: 'trabajar', version: 'v7d20',
      texto: 'Reproducir el error de exportación y corregirlo en el repositorio del reporte.' },
    dispatch: { project: 'Alfa Demo', state: 'activo', outcome: null, at: minutos(33),
      updated_at: minutos(33) } }),
  caso(8, 'listo', { title: 'Estado de la exportación', prioridad: 'low',
    chat_name: 'Soporte — Cliente Norte', updated_at: minutos(70), ticket: 'SOP-211',
    proposal: { tipo: 'responder', version: 'v8e11',
      texto: 'Ya quedó corregido; la exportación funciona de nuevo.' } }),
  caso(9, 'respondido', { title: 'Consulta por el horario', chat_name: 'Laura Méndez',
    updated_at: minutos(130) }),
  caso(10, 'cerrado', { title: 'Cotización aprobada', chat_name: 'Operaciones internas',
    updated_at: minutos(60 * 26), ticket: 'OPS-77' }),
  caso(11, 'bloqueado', { title: 'No se pudo enviar la respuesta', prioridad: 'medium',
    chat_name: 'Lista de espera | Taller Demo \u{1F680} #2', updated_at: minutos(41),
    blocked_reason: 'El envío fue rechazado: el grupo ya no existe.',
    proposal: { tipo: 'responder', version: 'v9f42', texto: 'Gracias, ya quedó listo.' } })
]
// T8: lo que pasa con un trabajo despachado al agente del proyecto, una tarjeta por
// estado: trabajando, pidio informacion, espera al cliente, resuelto y bloqueado por el agente.
const despacho = (estado, resultado, hace) => ({ project: 'Alfa Demo', state: estado,
  outcome: resultado, at: minutos(hace + 20), updated_at: minutos(hace) })
// respuesta-otro-chat: el dueno pidio en su chat reportarle al cliente en su grupo; la
// propuesta dice a que chat va, en la tarjeta y en el detalle, antes de Enviar.
const TABLERO_OTRO_CHAT = [
  caso(31, 'decision', {
    title: 'Reportar al cliente la conclusion del informe', prioridad: 'medium',
    chat_name: 'Dueno Demo', updated_at: minutos(2), exceptions: [],
    summary: 'El dueno pide pasarle la conclusion al grupo del cliente.',
    jev: null,
    proposal: { tipo: 'responder', version: 'v9c1d',
      texto: 'Le comparto la conclusion del informe de ventas: el filtro ya cuadra con el total.',
      destino: { chat_jid: '120363000000000004@g.us',
        chat_name: 'Facturacion — Cliente Norte con un nombre de grupo bastante largo' } },
    events: [
      { de: null, a: 'recibido', actor: 'automatizacion', que: 'message', at: minutos(6) },
      { de: 'clasificado', a: 'decision', actor: 'agente', que: 'proposal', args: ['responder'],
        at: minutos(2) },
      { de: 'decision', a: 'decision', actor: 'regla', que: 'reply_waits', args: ['other_chat'],
        at: minutos(2) }]
  }),
  caso(32, 'decision', {
    title: 'Pregunta por el estado del pedido', chat_name: 'Cliente Uno', updated_at: minutos(4),
    exceptions: [], proposal: { tipo: 'responder', version: 'v7a2b',
      texto: 'Hola, ya revisamos su pedido y sale hoy.' }
  })
]

// casos-cli: una nota y una edicion en la historia, un recordatorio y un caso pospuesto.
const enMinutos = (n) => new Date(AHORA_MS + n * 60000).toISOString()
const TABLERO_CASOS_CLI = [
  caso(41, 'clasificado', {
    title: 'Revisar la factura de octubre', prioridad: 'urgent', chat_name: 'Cliente Uno',
    updated_at: minutos(3), exceptions: [], proposal: null, jev: null,
    reminder: { at: enMinutos(120), snoozed_until: null },
    events: [
      { de: null, a: 'recibido', actor: 'automatizacion', que: 'message', at: minutos(30) },
      { de: 'recibido', a: 'clasificado', actor: 'agente', que: 'classified', args: ['card'],
        at: minutos(25) },
      { de: 'clasificado', a: 'clasificado', actor: 'dueno', que: 'edited',
        args: ['priority', 'title'], at: minutos(10) },
      { de: 'clasificado', a: 'clasificado', actor: 'dueno', que: 'note',
        nota: 'El cliente llamo: la necesita antes del viernes, con el detalle por sede.',
        at: minutos(5) },
      { de: 'clasificado', a: 'clasificado', actor: 'agente', que: 'reminder_set', at: minutos(3) }]
  }),
  caso(42, 'recibido', {
    title: 'La nota credito del pedido anterior', chat_name: 'Facturacion — Cliente Norte',
    updated_at: minutos(15), exceptions: [], proposal: null, jev: null,
    reminder: { at: enMinutos(900), snoozed_until: enMinutos(900) }
  })
]

const TABLERO_DESPACHO = [
  caso(31, 'trabajo', { title: 'El reporte de ventas sale en blanco', prioridad: 'high',
    updated_at: minutos(12),
    proposal: { tipo: 'trabajar', version: 'vT1', texto: 'Reproducir el reporte y corregirlo.' },
    dispatch: despacho('activo', null, 12) }),
  caso(32, 'listo', { title: 'No carga el inventario', chat_name: 'Laura Méndez',
    updated_at: minutos(4),
    proposal: { tipo: 'responder', version: 'vT2', texto: 'Para revisarlo, ¿cuál bodega es?' },
    dispatch: despacho('activo', 'necesita', 4) }),
  caso(33, 'respondido', { title: 'Error al exportar facturas', updated_at: minutos(25),
    dispatch: despacho('esperando', 'necesita', 25) }),
  caso(34, 'listo', { title: 'El filtro de fechas no responde', updated_at: minutos(2),
    proposal: { tipo: 'responder', version: 'vT4',
      texto: 'Ya quedó corregido, ¿puedes verificarlo?' },
    dispatch: despacho('reportado', 'resuelto', 2) }),
  caso(35, 'bloqueado', { title: 'Borrar los pedidos de prueba', prioridad: 'medium',
    updated_at: minutos(8),
    blocked_reason: 'bloqueado por el agente del proyecto: hace falta borrar datos en producción',
    dispatch: despacho('bloqueado', 'bloqueado', 8) })
]
// proyectos-por-chat (M6): el proyecto que eligio el agente con su porque, y una pregunta
// "A o B?" abierta. `project_routes` tiene la forma de `ruta_de_tablero` (bin/wa-scope).
const CANDIDATOS_NORTE = [{ id: 'beta-demo', name: 'Beta Demo', note: '' },
  { id: 'alfa-demo', name: 'Alfa Demo', note: 'Tienda en linea: cobros, envios y facturas' }]
const RUTAS_PROYECTO = {
  5: { why: 'El reporte que falla es el del portal de clientes, que vive en Beta Demo.',
    by: 'agent', candidates: CANDIDATOS_NORTE, missing: [], question: null },
  12: { why: null, by: null, candidates: CANDIDATOS_NORTE, missing: [],
    question: { candidates: [{ id: 'alfa-demo', name: 'Alfa Demo' }, { id: 'beta-demo', name: 'Beta Demo' }],
      to: 'writer', text: '¿Es sobre la tienda en línea o sobre el portal de clientes?',
      at: minutos(18), state: 'open', escalated: false } }
}
const TABLERO_PROYECTOS = TABLERO_CASOS.map((c) => c.case_id === 5
  ? Object.assign({}, c, { project: { id: 'beta-demo', name: 'Beta Demo' } }) : c).concat([
  caso(12, 'respondido', { title: 'Cambiar el formulario de pedidos', updated_at: minutos(18),
    summary: 'Pide agregar un campo al formulario.', project: null,
    // Con la pregunta esperando al que escribio, el dueno tambien puede elegir el proyecto.
    actions: ['cerrar', 'reabrir', 'proyecto'] })])
const tableroDe = (cards, extra) => Object.assign({ v: 1, updated_at: minutos(1),
  truncated: false,
  counts: cards.reduce((acc, c) => Object.assign(acc, { [c.stage]: acc[c.stage] + 1 }),
    Object.assign({}, CUENTAS_VACIAS)),
  cards }, extra)
const conTablero = (board) => Object.assign({}, DATOS, { board })
// I2: muchas terminadas. Las columnas no pasan del alto de la ventana y se desplazan solas;
// Respondido y Cerrado muestran 20 y "Mostrar N mas".
const TITULOS_TERMINADOS = ['Consulta por el horario', 'Cotización aprobada',
  'Cambio de contraseña del portal', 'Factura del mes pasado', 'No llegan los correos',
  'Agregar un usuario nuevo', 'Duda con el reporte semanal']
const terminados = (etapa, n, desde) => Array.from({ length: n }, (_, i) => caso(desde + i, etapa, {
  title: TITULOS_TERMINADOS[i % TITULOS_TERMINADOS.length],
  chat_name: i % 2 ? 'Operaciones internas' : 'Soporte — Cliente Norte',
  updated_at: minutos(40 + i * 95), stage_at: minutos(40 + i * 95),
  actions: etapa === 'cerrado' ? ['reabrir'] : ['cerrar', 'reabrir'] }))
const TABLERO_MUCHOS = tableroDe(TABLERO_CASOS.filter((c) => c.stage !== 'respondido' &&
  c.stage !== 'cerrado').concat(terminados('respondido', 26, 200), terminados('cerrado', 34, 100)), {
  period_counts: { today: { respondido: 8, cerrado: 11 }, '7d': { respondido: 26, cerrado: 34 },
    '30d': { respondido: 41, cerrado: 77 }, all: { respondido: 41, cerrado: 130 } } })
// I5: la pestana Informes, con datos de ejemplo (test/informes-ejemplo.mjs), vacia y sin clave.
const ABRIR_INFORMES = "document.getElementById('tab-reports').click()"
const ELEGIR_PERIODO = (p) => `; document.querySelector('#period button[data-periodo="${p}"]').click()`
// Todo terminado hace 3 dias, nada abierto, y "Hoy" guardado: hay casos, ninguno del periodo.
const TABLERO_PERIODO_VACIO = tableroDe(terminados('cerrado', 3, 300).map((c) =>
  Object.assign(c, { updated_at: minutos(3 * 1440), stage_at: minutos(3 * 1440) })), {
  period_counts: { today: { respondido: 0, cerrado: 0 }, '7d': { respondido: 0, cerrado: 3 },
    '30d': { respondido: 0, cerrado: 3 }, all: { respondido: 0, cerrado: 3 } } })
// El panel ES el tablero (la bandeja se fue): no hay pestana que apretar. Queda como
// primer paso de los guiones para que cada uno diga desde donde arranca.
const ABRIR_TABLERO = 'void 0'

// Textos de la longitud y la forma de los de verdad: un nombre sin espacios donde partir,
// un parrafo largo y una URL. Es lo que desborda una columna de 160 px.
const LARGO = 'Necesitamos que revisen la integración completa del módulo de ' +
  'facturación antes del cierre de mes, porque los totales no coinciden con lo que ' +
  'reporta el banco y el cliente ya preguntó dos veces por la diferencia. '
const TABLERO_LARGO = tableroDe([
  caso(21, 'decision', {
    title: 'Revisión_de_la_integración_de_facturación_con_el_banco_antes_del_cierre_de_mes',
    chat_name: 'Grupo_de_operaciones_y_finanzas_de_la_región_andina_con_nombre_larguisimo',
    summary: LARGO.repeat(2), prioridad: 'urgent', updated_at: minutos(12),
    proposal: { tipo: 'responder', version: 'vL1', texto: LARGO.repeat(3) +
      'https://ejemplo.invalid/reportes/facturacion/2026/09/conciliacion-completa-del-banco' },
    jev: { attention_class: 'support_request', skip: false,
      flags: ['asks_for_money_or_payment', 'promises_a_date', 'states_status_not_verified',
        'una_bandera_que_el_panel_no_conoce'] },
    exceptions: ['money', 'commitment', 'jev'] }),
  caso(22, 'bloqueado', { title: 'Cierre del mes', updated_at: minutos(50),
    blocked_reason: LARGO + 'ENVIO_RECHAZADO_CODIGO_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    ticket: 'FIN-1234567890-ejemplo-de-ticket-con-nombre-largo' })
])

// Los proyectos (T12/T13), que solo se ven recien con estos datos: sin proyectos aceptados,
// con la busqueda de Orca fallida, y con una conversacion en edicion.
const SIN_PROYECTOS = Object.assign({}, DATOS, { projects: [], projectsStatus: null })
const BUSQUEDA_FALLIDA = Object.assign({}, SIN_PROYECTOS, {
  projectsStatus: { at: new Date().toISOString(), ok: false, proposals: [],
    reason: 'sin-cli-orca', detail: 'spawn orca ENOENT' }
})
// Editar la primera conversacion: el formulario por chat con su proyecto elegido.
const EDITAR_CONVERSACION = "document.querySelector('[data-edit]').click()"


// T17: los ajustes van en seis pestanas. Cada captura de config.html dice en cual se
// fotografia (`pestana`); sin decirlo es Estado, que es donde viven la linea y los avisos.
// Escribir en un autocompletar como lo hace el dueno: foco, texto y el evento `input`.
const escribirEn = (id, texto) => `const c = document.getElementById('${id}');
  c.focus(); c.value = ${JSON.stringify(texto)};
  c.dispatchEvent(new Event('input', { bubbles: true }));`
// Y elegir una opcion de su lista con un clic.
const elegirEn = (id, lista, texto, valor) => escribirEn(id, texto) +
  `document.querySelector('#${lista} [role="option"][data-value="${valor}"]').click();`
// Todo listo (linea, nombre y una conversacion): la pestana de entrada es Conversaciones.
const CON_LINEA = Object.assign({}, DATOS,
  { sidecar: { connection: 'open', qr: null, exited: false, latido: LATIDO_FRESCO,
    lineas: [LINEA_PRINCIPAL] } })
// Dos lineas vinculadas a la vez (L4): la principal y una segunda con lo suyo aparte — su
// alcance, su lista de conversaciones, su actividad y su tablero.
const SEGUNDA_GRUPO = '120363000000000021@g.us'
const SEGUNDA_DIRECTO = '573000000013@s.whatsapp.net'
const DOS_LINEAS = Object.assign({}, CON_LINEA, {
  sidecar: { connection: 'open', qr: null, exited: false, latido: LATIDO_FRESCO,
    me: '+573000000001', lineas: [LINEA_PRINCIPAL, LINEA_SEGUNDA] },
  sidecars: { [LINEA_SEGUNDA.carpeta]: { connection: 'open', qr: null, exited: false,
    latido: LATIDO_FRESCO, me: '+573000000011', cuenta: LINEA_SEGUNDA.cuenta } },
  alcancePorLinea: { [LINEA_SEGUNDA.cuenta]: {
    [SEGUNDA_GRUPO]: { chatName: 'Ventas — Linea Dos', mode: 'borrador', account: LINEA_SEGUNDA.cuenta,
      workspaces: [], provider: 'ninguno' },
    [SEGUNDA_DIRECTO]: { chatName: 'Cliente De La Segunda', mode: 'observar',
      account: LINEA_SEGUNDA.cuenta, workspaces: [], provider: 'ninguno' } } },
  porLinea: { [LINEA_SEGUNDA.cuenta]: {
    chatsAccount: LINEA_SEGUNDA.cuenta,
    chats: [{ jid: SEGUNDA_GRUPO, name: 'Ventas — Linea Dos', kind: 'grupo', last: '2026-10-05 09:12', unread: 2 },
      { jid: SEGUNDA_DIRECTO, name: 'Cliente De La Segunda', kind: 'directo', last: '2026-10-05 08:40', unread: 0 }] } }
})
// La segunda linea esperando su codigo, al lado de la principal ya conectada.
const LINEA_ESPERANDO = Object.assign({}, CON_LINEA, {
  sidecar: Object.assign({}, CON_LINEA.sidecar, { lineas: [LINEA_PRINCIPAL, LINEA_NUEVA] }),
  sidecars: { [LINEA_NUEVA.carpeta]: { connection: 'connecting', exited: false,
    qr: { qr: '2@SEGUNDA-LINEA-DE-PRUEBA,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=,' +
      'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=,CCCCCCCCCCCCCCCCCCCCCCCCC=', ts: 0,
      rotation: 1, ttlMs: 75000 } } }
})
// El tablero de cada linea: la principal con sus casos y la segunda con los suyos.
const TABLERO_DOS_LINEAS = Object.assign({}, DOS_LINEAS, {
  board: tableroDe(TABLERO_CASOS),
  porLinea: { [LINEA_SEGUNDA.cuenta]: Object.assign({}, DOS_LINEAS.porLinea[LINEA_SEGUNDA.cuenta], {
    activity: Object.assign({}, DATOS.activity, { account: LINEA_SEGUNDA.cuenta,
      syncedAt: AHORA_CORTO, pending: [], mapped: 2, authorized: 2,
      run: { state: 'ok', startedAt: AHORA_CORTO, endedAt: AHORA_CORTO, looked: 2, pending: 1 } }),
    board: tableroDe([
      caso(41, 'decision', { account: LINEA_SEGUNDA.cuenta, chat_jid: SEGUNDA_GRUPO,
        chat_name: 'Ventas — Linea Dos', title: 'Piden la cotizacion de 20 licencias',
        prioridad: 'high', exceptions: ['money'], updated_at: minutos(4),
        proposal: { tipo: 'responder', version: 'v2a1',
          texto: 'Hola, le enviamos la cotizacion hoy mismo por este medio.' } }),
      caso(42, 'recibido', { account: LINEA_SEGUNDA.cuenta, chat_jid: SEGUNDA_DIRECTO,
        chat_name: 'Cliente De La Segunda', title: 'Pregunta por el horario de soporte',
        updated_at: minutos(9) })
    ], { counts: Object.assign({}, CUENTAS_VACIAS, { decision: 1, recibido: 1 }),
      // Lo retenido de esta linea (approve-solo-dueno): su tarjeta dice de que linea es.
      held_drafts: [{ req_id: 'sesion-linea-dos-1', account: LINEA_SEGUNDA.cuenta,
        chat_jid: SEGUNDA_DIRECTO, chat: 'Cliente De La Segunda', at: minutos(6),
        text: 'Ya quedo listo el reporte que pidio, se lo enviamos por aca.', reasons: [] }] })
  }) }
})
// Ajustes por linea (odd/tasks/ajustes-por-linea.md): la segunda linea con los suyos aparte,
// en `ajustesPorLinea[<numero>]` — otro agente, otro tono, otro numero de aprobacion y el
// acuse apagado. Nombres e ids de prueba.
const DOS_LINEAS_AJUSTES = Object.assign({}, DOS_LINEAS, {
  owners: [{ id: '100000000000001@lid', name: 'Ana Restrepo' }],
  approvalNumber: '100000000000001@lid',
  ajustesPorLinea: { [LINEA_SEGUNDA.cuenta]: {
    agentName: 'Asistente Personal', ownerName: 'Beto Socio',
    tone: 'Cercano y breve. Trata de usted.',
    owners: [{ id: '100000000000002@lid', name: 'Beto Socio' }],
    approvalNumber: '100000000000002@lid', approvalLang: 'es', ackMode: 'off',
    ackText: 'Gracias por escribir, le respondo en un momento.', ackQuietMinutes: '15',
    greetingMode: 'on', greetingText: '', firstReply: null, slaMinutes: '30',
    projectQuestionHours: '12', inboxDays: '3', transcribeLang: 'es' } }
})
// Elegir la segunda linea en el selector, como lo hace el dueno.
const ELEGIR_SEGUNDA = `document.querySelector('#linea-vista button[data-value="${LINEA_SEGUNDA.cuenta}"]').click()`
// Con directos guardados con su LID (ids y telefonos de prueba): el sidecar anota el
// telefono de cada uno y la lista lo trae en `phone`.
const CON_TELEFONOS = Object.assign({}, CON_LINEA, {
  chats: CON_LINEA.chats.map((c) => c.kind === 'directo'
    ? Object.assign({}, c, { phone: '+' + c.jid.split('@')[0] }) : c).concat([
    { jid: '111122223333@lid', name: 'Persona Guardada', kind: 'directo',
      last: '2026-09-17 12:40', unread: 1, phone: '+573007776655' },
    { jid: '111122224444@lid', name: '111122224444@lid', kind: 'directo',
      last: '2026-09-16 10:05', unread: 0, phone: '+573000000002' },
    { jid: '111122226666@lid', name: 'Socio Norte', kind: 'directo',
      last: '2026-09-12 08:15', unread: 0, phone: '+14155550100' }
  ])
})

// La misma persona con su telefono y su LID (lid-sigue-autorizacion): WhatsApp movio la
// conversacion y la autorizacion quedo en la forma vieja. La lista ofrece una sola fila, la
// viva, con el permiso que tiene la vieja; editarla la guarda en la viva.
const TEL_GEMELO = '573000000011@s.whatsapp.net'
const CON_GEMELOS = Object.assign({}, CON_TELEFONOS, {
  chats: CON_TELEFONOS.chats.concat([
    { jid: TEL_GEMELO, name: 'Cliente Uno', kind: 'directo', last: '2026-09-20 10:00',
      unread: 0, phone: '+573000000011' },
    { jid: '100000000000002@lid', name: 'Cliente Uno', kind: 'directo',
      last: '2026-10-05 09:00', unread: 2, phone: '+573000000011' }
  ]),
  scope: Object.assign({}, CON_TELEFONOS.scope, {
    [TEL_GEMELO]: { chatName: 'Cliente Uno', provider: 'ninguno', target: null,
      mode: 'responder', tone: 'Formal y breve' }
  })
})

// proyectos-por-chat (M6): conversaciones con varios proyectos. La primera con dos (uno de
// nombre largo) y la segunda con tres: la tabla dice "A +N" y el formulario, una fila por
// proyecto con a quien se pregunta "A o B?". Proyectos de ejemplo, ninguno existe.
const PROYECTOS_VARIOS = DATOS.projects.concat([
  { id: 'gama-demo', name: 'Gama Demo', path: '/srv/ejemplo/gama-demo', note: '' },
  { id: 'delta-servicio-con-un-nombre-largo', name: 'Delta Servicio Con Un Nombre Largo De Verdad',
    path: '/srv/ejemplo/clientes/region-andina/delta-servicio-con-un-nombre-largo', note: '' }])
const CON_VARIOS = Object.assign({}, CON_LINEA, {
  projects: PROYECTOS_VARIOS,
  projectsStatus: Object.assign({}, DATOS.projectsStatus, { proposals: [] }),
  scope: Object.assign({}, CON_LINEA.scope, {
    '120363000000000001@g.us': Object.assign({}, CON_LINEA.scope['120363000000000001@g.us'], {
      workspaces: ['alfa-demo', 'delta-servicio-con-un-nombre-largo'], workspace: null,
      projectQuestion: 'auto' }),
    '120363000000000002@g.us': Object.assign({}, CON_LINEA.scope['120363000000000002@g.us'], {
      workspaces: ['beta-demo', 'alfa-demo', 'gama-demo'], workspace: null,
      projectQuestion: 'owner' })
  })
})

// roles-por-numero (M11): las personas de una conversacion y su rol. Un directo marcado
// Operador; un grupo con su lista de participantes (`groupMembers`, la deja wa-scope sync)
// con el numero de confianza fijo, un Operador, un Super admin de nombre largo, uno sin
// nombre (se ve su telefono) y uno con rol que ya no esta en el grupo; y un grupo cuya lista
// todavia no llego. Ids, telefonos y nombres de prueba.
const MIEMBROS_SOPORTE = [
  { id: '100000000000001@lid', name: 'Ana Restrepo', phone: '+573000000011' },
  { id: '100000000000002@lid', name: 'Beto Socio', phone: '+573000000012' },
  { id: '111122223333@lid', name: 'Carolina Fern\u00e1ndez de la Torre Villalobos',
    phone: '+573007776655' },
  { id: '573000000013@s.whatsapp.net', name: '', phone: '+573000000013' },
  { id: '111122224444@lid', name: 'Diego Ram\u00edrez', phone: null },
  { id: '111122225555@lid', name: 'Elena Soto \u{1F33B}', phone: '+573009998877' }
]
const CON_PERSONAS = Object.assign({}, CON_LINEA, {
  groupMembers: { '120363000000000001@g.us': MIEMBROS_SOPORTE },
  scope: Object.assign({}, CON_LINEA.scope, {
    '120363000000000001@g.us': Object.assign({}, CON_LINEA.scope['120363000000000001@g.us'], {
      members: [{ id: '100000000000002@lid', name: 'Beto Socio', role: 'operator' },
        { id: '111122223333@lid', name: 'Carolina Fern\u00e1ndez de la Torre Villalobos', role: 'admin' },
        { id: '111122226666@lid', name: 'Fabio Antiguo', role: 'operator' }] }),
    '573000000000@s.whatsapp.net': Object.assign({}, CON_LINEA.scope['573000000000@s.whatsapp.net'], {
      members: [{ id: '573000000000@s.whatsapp.net', name: 'Laura M\u00e9ndez', role: 'operator' }] })
  })
})
const EDITAR_CHAT = (jid) => `document.querySelector('[data-edit="${jid}"]').click();` +
  "setTimeout(function () { document.getElementById('people-wrap').scrollIntoView() }, 150)"

// Las cuentas de Claude que el worker lee de `orca account list` (de ejemplo).
const CUENTAS_CLAUDE = [
  { id: 'cuenta-bot', email: 'bot.whatsapp@example.invalid', authenticated: true, active: false, used: 12 },
  { id: 'cuenta-equipo', email: 'equipo.soporte.con.un.correo.largo@example.invalid',
    authenticated: true, active: true, used: 64 },
  { id: 'cuenta-vieja', email: 'vieja@example.invalid', authenticated: false, active: false, used: null }
]

// Lo que deja el worker en `skillsStatus` (skills-globales), con rutas de ejemplo.
const SKILL_EN = (base) => `${base}/.claude/skills/whatsapp-avisos/SKILL.md`
const SKILLS_EJEMPLO = { ok: true, at: new Date().toISOString(), version: '4.18.1', skills: [{
  name: 'whatsapp-avisos', description: 'Notify the owner on WhatsApp.',
  targets: [
    { scope: 'global', accepted: true, file: SKILL_EN('/home/demo'), state: 'installed',
      version: '4.18.1', yours: ['Rules'] },
    { scope: 'project', project: 'alfa-demo', name: 'Alfa Demo', accepted: true,
      path: '/srv/ejemplo/alfa-demo', file: SKILL_EN('/srv/ejemplo/alfa-demo'),
      state: 'outdated', version: '4.17.0', yours: [] },
    { scope: 'project', project: 'beta-demo', name: 'Beta Demo', accepted: true,
      path: '/srv/ejemplo/beta-demo', file: SKILL_EN('/srv/ejemplo/beta-demo'),
      state: 'not-installed' },
    { scope: 'project', project: 'viejo-demo', name: 'Viejo Demo', accepted: false,
      path: '/srv/ejemplo/viejo-demo', file: SKILL_EN('/srv/ejemplo/viejo-demo'),
      state: 'installed', version: '4.18.1', yours: [] },
    { scope: 'project', project: 'gama-demo', name: 'Gama Demo', accepted: true,
      path: '/srv/ejemplo/gama-demo', file: SKILL_EN('/srv/ejemplo/gama-demo'),
      state: 'foreign' }
  ] }] }

const PANELES = [
  // Las seis pestanas, a los cuatro anchos, en los dos idiomas y los dos temas.
  { nombre: 'config-tab-estado', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, datos: SIN_VINCULAR, pestana: 'estado' },
  // Varias lineas a la vez (L4/L5): la tarjeta de lineas con una linea conectada, con una
  // segunda esperando su codigo, con dos conectadas y el Desvincular de la segunda por
  // confirmar, y Conversaciones mirando la segunda.
  { nombre: 'config-lineas-una', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, datos: CON_LINEA, pestana: 'estado' },
  { nombre: 'config-lineas-esperando', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, datos: LINEA_ESPERANDO, pestana: 'estado' },
  { nombre: 'config-lineas-dos', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, datos: DOS_LINEAS, pestana: 'estado', espera: 400,
    guion: `document.querySelector('.linea[data-carpeta="${LINEA_SEGUNDA.carpeta}"] .linea-desvincular').click()` },
  // Con dos lineas, Su aprobacion es de la linea elegida; lo del equipo lo dice su tarjeta.
  { nombre: 'config-lineas-aprobacion', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, datos: DOS_LINEAS, pestana: 'aprobacion', espera: 400 },
  { nombre: 'config-lineas-chats', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, datos: DOS_LINEAS, pestana: 'chats', espera: 800,
    guion: ELEGIR_SEGUNDA },
  // Ajustes por linea (A7): el selector arriba de las pestanas, Agente en la principal y en
  // la segunda, y Su aprobacion de la segunda con sus propios numeros.
  { nombre: 'config-ajustes-selector', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, datos: DOS_LINEAS_AJUSTES, pestana: 'estado', espera: 400 },
  { nombre: 'config-ajustes-agente-principal', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, datos: DOS_LINEAS_AJUSTES, pestana: 'agente', espera: 400 },
  { nombre: 'config-ajustes-agente-segunda', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, datos: DOS_LINEAS_AJUSTES, pestana: 'agente', espera: 800,
    guion: ELEGIR_SEGUNDA },
  { nombre: 'config-ajustes-aprobacion-segunda', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, datos: DOS_LINEAS_AJUSTES, pestana: 'aprobacion', espera: 1200,
    guion: ELEGIR_SEGUNDA },
  // Conversaciones trae la regla vieja de Plane (`cobros`) marcada.
  { nombre: 'config-tab-chats', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, datos: CON_LINEA, pestana: 'chats' },
  { nombre: 'config-tab-proyectos', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, datos: DATOS, pestana: 'proyectos' },
  { nombre: 'config-tab-aprobacion', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, datos: DATOS, pestana: 'aprobacion' },
  // Agente trae la cuenta de Claude del bot: la lista la contesta el worker.
  { nombre: 'config-tab-agente', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, pestana: 'agente', guion: 'void 0', espera: 2500,
    datos: Object.assign({}, DATOS, { botClaudeAccount: 'cuenta-bot' }),
    stub: { veredictoAccion: { ok: true, code: 'cuentas', accounts: CUENTAS_CLAUDE } } },
  // Sin poder leer las cuentas: lo dice, y Automatica sigue a mano.
  { nombre: 'config-cuenta-bot-fallo', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, pestana: 'agente', guion: 'void 0', espera: 2500,
    datos: Object.assign({}, DATOS, { botClaudeAccount: 'cuenta-que-ya-no-esta' }),
    stub: { veredictoAccion: { ok: false, code: 'cuentas-fallo' } } },
  { nombre: 'config-tab-avanzado', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, datos: DATOS, pestana: 'avanzado' },
  // Skills (skills-globales): global instalada con una seccion editada, un proyecto
  // desactualizado, otro sin instalar, uno que salio del catalogo y un archivo ajeno.
  { nombre: 'config-tab-skills', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, pestana: 'skills', guion: 'void 0', espera: 1500,
    datos: Object.assign({}, DATOS, { skillsStatus: SKILLS_EJEMPLO }),
    stub: { veredictoAccion: { ok: true, code: 'skills-leidas' } } },
  // Con dos lineas, el dueno elige por cual le avisan las skills (todo-por-linea, P7).
  { nombre: 'config-skills-dos-lineas', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, pestana: 'skills', espera: 1500, guion: ELEGIR_SEGUNDA,
    datos: Object.assign({}, DOS_LINEAS_AJUSTES, { skillsStatus: SKILLS_EJEMPLO }),
    stub: { veredictoAccion: { ok: true, code: 'skills-leidas' } } },
  // Quitar una copia con cambios del dueno: avisa que se pierden y pide confirmar.
  { nombre: 'config-skills-confirmar', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, pestana: 'skills', espera: 1500,
    datos: Object.assign({}, DATOS, { skillsStatus: SKILLS_EJEMPLO }),
    guion: "setTimeout(function () { document.querySelector('[data-sk-target=\"global\"] " +
      "[data-sk-act=\"remove\"]').click() }, 600)",
    stub: { veredictoAccion: { ok: false, code: 'skill-editada', yours: ['Rules'] } } },
  // La pestana de entrada sin tocar nada: con todo listo, Conversaciones.
  { nombre: 'config-entrada-lista', archivo: 'config.html', anchos: ANCHOS_ESTADO,
    datos: CON_LINEA, pestana: null },
  // El autocompletar abierto con resultados, sin ninguno, y el de proyecto.
  { nombre: 'config-combo-abierto', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, datos: CON_LINEA, pestana: 'chats',
    guion: escribirEn('chat-search', 'o') +
      "c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))",
    espera: 300 },
  // Los directos guardados con su LID, con su telefono al lado y buscados por el numero:
  // "+57 300" trae los que lo tienen, con nombre y sin el (ese se llama como su
  // telefono). Solo "300" traeria tambien los grupos: sus ids de prueba lo contienen.
  { nombre: 'config-combo-telefono', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, datos: CON_TELEFONOS, pestana: 'chats',
    guion: escribirEn('chat-search', '+57 300'), espera: 300 },
  // lid-sigue-autorizacion: una sola fila por persona, la viva, con el permiso de la vieja;
  // y la edicion de la vieja, que dice abajo la llave viva donde se va a guardar.
  { nombre: 'config-combo-gemelos', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, datos: CON_GEMELOS, pestana: 'chats',
    guion: escribirEn('chat-search', 'cliente uno'), espera: 300 },
  { nombre: 'config-conversacion-gemela', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, datos: CON_GEMELOS, pestana: 'chats', espera: 400,
    guion: `document.querySelector('[data-edit="${TEL_GEMELO}"]').click()` },
  { nombre: 'config-combo-sin-coincidencias', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, datos: CON_LINEA, pestana: 'chats',
    guion: escribirEn('chat-search', 'zzzz'), espera: 300 },
  { nombre: 'config-combo-proyecto', archivo: 'config.html', anchos: ANCHOS,
    datos: CON_LINEA, pestana: 'chats', guion: escribirEn('workspace-search', ''),
    espera: 300 },
  // Jev encendido, con llave.
  { nombre: 'config-jev-encendido', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, pestana: 'aprobacion',
    datos: Object.assign({}, DATOS, { jevStatus: { at: new Date().toISOString(),
      enabled: true, keySet: true, mirror: 'activo' } }) },
  // Jev encendido con la llave guardada, pero con un `jev.env` que el plugin no escribio:
  // la nota no manda a reescribir la llave y ofrece usar la guardada.
  { nombre: 'config-jev-ajeno', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, pestana: 'aprobacion',
    datos: Object.assign({}, DATOS, { jevStatus: { at: new Date().toISOString(),
      enabled: true, keySet: true, mirror: 'ajeno' } }) },
  { nombre: 'config-proyectos-vacio', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, datos: SIN_PROYECTOS, pestana: 'proyectos' },
  { nombre: 'config-proyectos-fallo', archivo: 'config.html', anchos: ANCHOS_ESTADO,
    datos: BUSQUEDA_FALLIDA, pestana: 'proyectos' },
  { nombre: 'config-conversacion-editar', archivo: 'config.html', anchos: ANCHOS,
    guion: EDITAR_CONVERSACION, espera: 400, datos: CON_LINEA, pestana: 'chats' },
  // T22.3: los niveles de aprobacion del chat, debajo de las respuestas automaticas.
  { nombre: 'config-conversacion-niveles', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 400, datos: CON_LINEA, pestana: 'chats',
    guion: EDITAR_CONVERSACION + ";document.getElementById('chat-ap-money').scrollIntoView()" },
  // proyectos-por-chat (M6): la tabla con "A +N" y el formulario de una conversacion con dos
  // proyectos, una fila por proyecto y a quien se pregunta "A o B?".
  { nombre: 'config-proyectos-varios', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, idiomas: ['pt'], espera: 400, datos: CON_VARIOS, pestana: 'chats',
    guion: EDITAR_CONVERSACION + ";document.getElementById('workspace-search').scrollIntoView()" },
  // roles-por-numero (M11): la tarjeta de personas en un directo, en un grupo con varios
  // participantes y en un grupo cuya lista todavia no llego.
  { nombre: 'config-personas-directo', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, idiomas: ['pt'], espera: 500, datos: CON_PERSONAS, pestana: 'chats',
    guion: EDITAR_CHAT('573000000000@s.whatsapp.net') },
  { nombre: 'config-personas-grupo', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, idiomas: ['pt'], espera: 500, datos: CON_PERSONAS, pestana: 'chats',
    guion: EDITAR_CHAT('120363000000000001@g.us') },
  { nombre: 'config-personas-vacio', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, idiomas: ['pt'], espera: 500, datos: CON_PERSONAS, pestana: 'chats',
    guion: EDITAR_CHAT('120363000000000002@g.us') },
  // T22.1: elegir los numeros del dueno de quienes escribieron.
  { nombre: 'config-duenos-combo', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 300, datos: CON_LINEA, pestana: 'aprobacion',
    guion: "document.getElementById('owners-card').scrollIntoView();" +
      escribirEn('owner-search', '') },
  // T14: el numero de aprobacion, elegido entre los de confianza, con el aviso de que su
  // chat todavia no esta en Automatico.
  { nombre: 'config-numero-aprobacion', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 300, pestana: 'aprobacion',
    datos: Object.assign({}, CON_LINEA, {
      owners: [{ id: '100000000000001@lid', name: 'Ana Restrepo' },
        { id: '100000000000002@lid', name: 'Beto Socio' }],
      approvalNumber: '100000000000001@lid' }),
    guion: "document.getElementById('approval-number').scrollIntoView()" },
  // avisos-orca: los avisos de Orca por WhatsApp, encendidos con horas de silencio y con el
  // numero de aprobacion elegido; y apagados, sin numero, con el aviso de que no saldria nada.
  { nombre: 'config-avisos-orca', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, idiomas: ['pt'], espera: 300, pestana: 'aprobacion',
    datos: Object.assign({}, CON_LINEA, {
      owners: [{ id: '100000000000001@lid', name: 'Ana Restrepo' }],
      approvalNumber: '100000000000001@lid',
      orcaNotices: { waiting: 'on', finished: 'on', automationFailed: 'off', quietStart: '22:00',
        quietEnd: '07:00', hourlyCap: '6', finishedDelaySeconds: '25' } }),
    guion: "document.getElementById('orca-notices-card').scrollIntoView()" },
  { nombre: 'config-avisos-orca-sin-numero', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 300, pestana: 'aprobacion', datos: DATOS,
    guion: "document.getElementById('orca-notices-card').scrollIntoView()" },
  // ajustes-sin-lectura: el host todavia no contesto por los numeros ni por los avisos (el
  // cupo es por plugin y el tablero gasta del mismo). Las dos tarjetas dicen que estan
  // leyendo, sin los controles de fabrica a la vista y con Guardar apagado; y cuando el
  // host vuelve a contestar, las mismas dos con lo guardado.
  { nombre: 'config-aprobacion-leyendo', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, idiomas: ['pt'], espera: 300, pestana: 'aprobacion',
    datos: Object.assign({}, CON_LINEA, {
      owners: [{ id: '100000000000001@lid', name: 'Ana Restrepo' }],
      approvalNumber: '100000000000001@lid',
      orcaNotices: { waiting: 'on', finished: 'on', automationFailed: 'on', quietStart: '',
        quietEnd: '', hourlyCap: '6', finishedDelaySeconds: '25' } }),
    stub: { rechazaGet: ['owners', 'approvalNumber', 'orcaNotices'] },
    guion: "document.getElementById('owners-card').scrollIntoView()" },
  { nombre: 'config-aprobacion-releida', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 1500, pestana: 'aprobacion',
    datos: Object.assign({}, CON_LINEA, {
      owners: [{ id: '100000000000001@lid', name: 'Ana Restrepo' }],
      approvalNumber: '100000000000001@lid',
      orcaNotices: { waiting: 'on', finished: 'on', automationFailed: 'on', quietStart: '',
        quietEnd: '', hourlyCap: '6', finishedDelaySeconds: '25' } }),
    stub: { rechazaGet: ['owners', 'approvalNumber', 'orcaNotices'], rechazaHastaMs: 500 },
    guion: "document.getElementById('owners-card').scrollIntoView()" },
  // acuse-inteligente: los minutos sin acuse despues de que la linea escribio en el chat,
  // junto al acuse, con su pista. En portugues tambien: la etiqueta es la mas larga.
  { nombre: 'config-acuse-silencio', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, idiomas: ['pt'], espera: 300, pestana: 'aprobacion',
    datos: Object.assign({}, DATOS, { ackQuietMinutes: '45' }),
    guion: "document.getElementById('ack-mode').scrollIntoView()" },
  // primer-mensaje-beta: quien escribe el primer mensaje. El acuse de siempre, el agente sin
  // respaldo (con el aviso de que sin el el cliente puede no recibir nada), el agente con
  // respaldo (con sus tres numeros) y lo propio de una conversacion.
  { nombre: 'config-primer-acuse', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 300, pestana: 'aprobacion', datos: DATOS,
    guion: "document.getElementById('first-reply').scrollIntoView()" },
  { nombre: 'config-primer-agente', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 300, pestana: 'aprobacion',
    datos: Object.assign({}, DATOS, { firstReply: { mode: 'model', fallbackMinutes: '5',
      everyMinutes: '10', max: '3' } }),
    guion: "document.getElementById('first-reply').scrollIntoView()" },
  { nombre: 'config-primer-respaldo', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 300, pestana: 'aprobacion',
    datos: Object.assign({}, DATOS, { firstReply: { mode: 'model_with_ack_fallback',
      fallbackMinutes: '5', everyMinutes: '10', max: '3' } }),
    guion: "document.getElementById('first-reply').scrollIntoView()" },
  { nombre: 'config-primer-conversacion', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 400, datos: CON_LINEA, pestana: 'chats',
    guion: EDITAR_CONVERSACION + ";document.querySelector('#chat-first-reply " +
      "button[data-value=\"model\"]').click();" +
      "document.getElementById('chat-first-reply').scrollIntoView()" },
  // ritmo-triage: bajo el selector, a que ritmo corre el triage en Orca, o que no se pudo.
  { nombre: 'config-ritmo-triage', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 300, pestana: 'avanzado',
    datos: Object.assign({}, DATOS, { syncMinutes: '2',
      workerBeat: { at: new Date().toISOString(),
        triage: { minutes: 2, cron: '*/2 * * * *', ok: true, code: 'ajustado' } } }),
    guion: "document.getElementById('triage-pace').scrollIntoView()" },
  { nombre: 'config-ritmo-triage-fallo', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 300, pestana: 'avanzado',
    datos: Object.assign({}, DATOS, { syncMinutes: '2',
      workerBeat: { at: new Date().toISOString(),
        triage: { minutes: 2, cron: '*/2 * * * *', ok: false, code: 'ajustar-fallo' } } }),
    guion: "document.getElementById('triage-pace').scrollIntoView()" },
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
  // El tablero de casos (T5, con la anatomia del de Plane en Orca) y las acciones del dueno
  // (T6). Los estados que pide el rediseno van a los cuatro anchos, en los dos idiomas y los
  // dos temas: a lo ancho son columnas y desde 768 hacia abajo la lista por etapa, que es
  // donde se rompe. La bandeja de siempre queda detras de la otra pestana.
  {
    nombre: 'tablero-poblado', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, guion: ABRIR_TABLERO, espera: 400,
    datos: conTablero(tableroDe(TABLERO_CASOS, {
      // Hay mas casos de los que caben: lo dice el aviso y "+n mas sin mostrar".
      truncated: true,
      counts: Object.assign({}, CUENTAS_VACIAS, { recibido: 1, clasificado: 2, decision: 3,
        trabajo: 1, listo: 1, respondido: 1, cerrado: 12, bloqueado: 1 })
    }))
  },
  {
    // Lo retenido que no es de ningun caso (approve-solo-dueno): el aviso de la sesion de un
    // proyecto que el piso freno, arriba del tablero, con Aprobar y Cancelar.
    nombre: 'tablero-retenidos', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, guion: ABRIR_TABLERO, espera: 400,
    datos: conTablero(tableroDe(TABLERO_CASOS, { held_drafts: RETENIDOS }))
  },
  {
    // Aprobar no pudo confirmar que viene del tablero: el error en su tarjeta.
    nombre: 'tablero-retenidos-error', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 1500,
    datos: conTablero(tableroDe(TABLERO_CASOS, { held_drafts: RETENIDOS })),
    guion: ABRIR_TABLERO + `;
      document.querySelector('#board-held button[data-held="aprobar"]').click()`,
    stub: { veredictoAccion: { ok: false, code: 'send-approve-not-owner' }, demoraVeredicto: 0 }
  },
  {
    // Varias lineas a la vez (L4): el tablero con el selector de linea, mirando la segunda.
    nombre: 'tablero-lineas', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 800, datos: TABLERO_DOS_LINEAS,
    guion: ABRIR_TABLERO + ';' + ELEGIR_SEGUNDA
  },
  {
    // Y la principal, con el mismo selector: lo de siempre, con su linea elegida.
    nombre: 'tablero-lineas-principal', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 400, datos: TABLERO_DOS_LINEAS, guion: ABRIR_TABLERO
  },
  {
    // Una etapa elegida en la fila de arriba: queda solo "Su decision".
    nombre: 'tablero-filtrado', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 400, datos: conTablero(tableroDe(TABLERO_CASOS)),
    guion: ABRIR_TABLERO + `;
      document.querySelector('#board-chips button[data-etapa="decision"]').click()`
  },
  {
    // Buscar por el chat, sin la tilde: los casos de "Soporte — Cliente Norte".
    nombre: 'tablero-busqueda', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 400, datos: conTablero(tableroDe(TABLERO_CASOS)),
    guion: ABRIR_TABLERO + `;
      const c = document.getElementById('board-search');
      c.value = 'norte'; c.dispatchEvent(new Event('input', { bubbles: true }))`
  },
  {
    // La lista elegida a mano, tambien a lo ancho.
    nombre: 'tablero-lista', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 400, datos: conTablero(tableroDe(TABLERO_CASOS)),
    guion: ABRIR_TABLERO + `;
      document.querySelector('#board-view button[data-vista="list"]').click()`
  },
  {
    // El detalle de un caso abierto, con su texto entero, Jev y todas las acciones.
    nombre: 'tablero-detalle', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 400, datos: conTablero(tableroDe(TABLERO_CASOS)),
    guion: ABRIR_TABLERO + `;
      document.querySelector('.card[data-case="1"]').click()`
  },
  {
    // Un caso en "Listo para responder": Enviar, Editar (cli-huecos, C1) y Cerrar.
    nombre: 'tablero-detalle-listo', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 400, datos: conTablero(tableroDe(TABLERO_CASOS)),
    guion: ABRIR_TABLERO + `;
      document.querySelector('.card[data-case="8"]').click()`
  },
  {
    // respuesta-otro-chat: la tarjeta dice a que otro chat va la respuesta.
    nombre: 'tablero-otro-chat', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, guion: ABRIR_TABLERO, espera: 400,
    datos: conTablero(tableroDe(TABLERO_OTRO_CHAT))
  },
  {
    // Y su detalle, con la historia que dice por que espera.
    nombre: 'tablero-otro-chat-detalle', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 400, datos: conTablero(tableroDe(TABLERO_OTRO_CHAT)),
    guion: ABRIR_TABLERO + `;
      document.querySelector('.card[data-case="31"]').click()`
  },
  {
    // casos-cli: el recordatorio y el caso pospuesto en sus tarjetas.
    nombre: 'tablero-recordatorio', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, guion: ABRIR_TABLERO, espera: 400,
    datos: conTablero(tableroDe(TABLERO_CASOS_CLI))
  },
  {
    // Y el detalle, con la nota y la edicion en la historia.
    nombre: 'tablero-nota-detalle', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 400, datos: conTablero(tableroDe(TABLERO_CASOS_CLI)),
    guion: ABRIR_TABLERO + `;
      document.querySelector('.card[data-case="41"]').click()`
  },
  {
    // T8: el despacho al agente del proyecto en cada estado.
    nombre: 'tablero-despacho', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, guion: ABRIR_TABLERO, espera: 400,
    datos: conTablero(tableroDe(TABLERO_DESPACHO))
  },
  {
    // El despacho y el agente de casos que no se abrieron con la cuenta del bot: con cual y
    // por que.
    nombre: 'tablero-cuenta-respaldo', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, guion: ABRIR_TABLERO, espera: 400,
    datos: Object.assign(corrida({ state: 'ok', startedAt: AHORA_CORTO, endedAt: AHORA_CORTO,
      looked: 4, pending: 0, reason: null }), { board: tableroDe(TABLERO_DESPACHO.map((c) => (
      c.case_id === 31 ? Object.assign({}, c, { dispatch: Object.assign({}, c.dispatch,
        { account: 'equipo.soporte@example.invalid', fallback: 'elegida-sin-sesion' }) }) : c)), {
      agent_waiting: 1,
      agent_launch: { state: 'running', at: minutos(1), account: 'equipo.soporte@example.invalid',
        fallback: 'elegida-sin-sesion' }
    }) })
  },
  {
    nombre: 'tablero-vacio', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, guion: ABRIR_TABLERO, espera: 400, datos: conTablero(tableroDe([]))
  },
  {
    // El estado de error: una version del tablero que este panel no entiende.
    nombre: 'tablero-version', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, guion: ABRIR_TABLERO, espera: 400,
    datos: conTablero({ v: 2, updated_at: minutos(1), cards: [], counts: {} })
  },
  {
    // Lo que era la cola: un caso en Recibido, con Atender ahora e Ignorar en el detalle.
    nombre: 'tablero-recibido', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 400, datos: conTablero(tableroDe(TABLERO_CASOS)),
    guion: ABRIR_TABLERO + `;
      document.querySelector('.card[data-case="4"]').click()`
  },
  {
    // Cambiar el proyecto: el autocompletar abierto con el catalogo aceptado.
    nombre: 'tablero-proyecto', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 400, datos: conTablero(tableroDe(TABLERO_CASOS)),
    guion: ABRIR_TABLERO + `;
      document.querySelector('.card[data-case="5"]').click();
      document.querySelector('#board-detail button[data-accion="proyecto"]').click();
      const c = document.querySelector('#board-detail input[role="combobox"]');
      c.focus(); c.click()`
  },
  {
    // proyectos-por-chat (M6): el detalle dice que el agente eligio el proyecto y por que, y
    // Cambiar proyecto lista primero los de la conversacion y despues el resto.
    nombre: 'tablero-proyecto-agente', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 400, idiomas: ['pt'],
    datos: Object.assign({}, DATOS, { projects: PROYECTOS_VARIOS,
      board: tableroDe(TABLERO_PROYECTOS, { project_routes: RUTAS_PROYECTO }) }),
    guion: ABRIR_TABLERO + `;
      document.querySelector('.card[data-case="5"]').click();
      document.querySelector('#board-detail button[data-accion="proyecto"]').click();
      const c = document.querySelector('#board-detail input[role="combobox"]');
      c.focus(); c.click()`
  },
  {
    // La pregunta "A o B?" abierta: la tarjeta lo avisa y el detalle dice a quien y que.
    nombre: 'tablero-pregunta-abierta', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 400, idiomas: ['pt'],
    datos: Object.assign({}, DATOS, { projects: PROYECTOS_VARIOS,
      board: tableroDe(TABLERO_PROYECTOS, { project_routes: RUTAS_PROYECTO }) }),
    guion: ABRIR_TABLERO + `;
      document.querySelector('.card[data-case="12"]').click()`
  },
  {
    // Una tarjeta en cada etapa menos "Su decision": el estado sano y el mas comun.
    nombre: 'tablero-sin-decisiones', archivo: 'activity.html', anchos: ANCHOS_ESTADO,
    guion: ABRIR_TABLERO, espera: 400,
    datos: conTablero(tableroDe(TABLERO_CASOS.filter((c) => c.stage !== 'decision')))
  },
  {
    // Antes de que `wa-scope` escriba nada: no hay clave `board`.
    nombre: 'tablero-sin-datos', archivo: 'activity.html', anchos: ANCHOS_ESTADO,
    guion: ABRIR_TABLERO, espera: 400, datos: DATOS
  },
  {
    nombre: 'tablero-textos-largos', archivo: 'activity.html', anchos: ANCHOS,
    guion: ABRIR_TABLERO, espera: 400, datos: conTablero(TABLERO_LARGO)
  },
  {
    // Lo largo se lee entero en el detalle.
    nombre: 'tablero-detalle-largo', archivo: 'activity.html', anchos: ANCHOS_ESTADO,
    guion: ABRIR_TABLERO + "; document.querySelector('.card[data-case=\"21\"]').click()",
    espera: 400, datos: conTablero(TABLERO_LARGO)
  },
  // Las acciones del dueno (T6) en cada uno de sus estados: desde el detalle, salvo el
  // Enviar de la tarjeta, que es el unico boton que la tarjeta lleva a la vista.
  {
    // Editar y enviar: el editor abierto en el detalle, con lo que el dueno esta escribiendo.
    nombre: 'tablero-accion-editar', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true,
    guion: ABRIR_TABLERO + `;
      document.querySelector('.card[data-case="1"]').click();
      document.querySelector('#board-detail button[data-accion="editar"]').click();
      const area = document.querySelector('.card-form textarea');
      area.value = 'Hola, gracias por avisar. El precio de renovación es el vigente y no ' +
        'podemos bajarlo; si quieres, lo revisamos en una llamada esta semana.';
      area.dispatchEvent(new Event('input', { bubbles: true }))`,
    espera: 400, datos: conTablero(tableroDe(TABLERO_CASOS))
  },
  {
    // Cerrar con motivo: el segundo formulario, el de un solo renglon.
    nombre: 'tablero-accion-cerrar', archivo: 'activity.html', anchos: ANCHOS_ESTADO,
    guion: ABRIR_TABLERO + `;
      document.querySelector('.card[data-case="5"]').click();
      document.querySelector('#board-detail button[data-accion="cerrar"]').click();
      const motivo = document.querySelector('.card-form input');
      motivo.value = 'Ya lo resolvimos por teléfono';
      motivo.dispatchEvent(new Event('input', { bubbles: true }))`,
    espera: 400, datos: conTablero(tableroDe(TABLERO_CASOS))
  },
  {
    // Reclasificar: la nota opcional, vacia.
    nombre: 'tablero-accion-reclasificar', archivo: 'activity.html', anchos: ANCHOS_ESTADO,
    guion: ABRIR_TABLERO + `;
      document.querySelector('.card[data-case="2"]').click();
      document.querySelector('#board-detail button[data-accion="reclasificar"]').click()`,
    espera: 400, datos: conTablero(tableroDe(TABLERO_CASOS))
  },
  {
    // Enviando desde la tarjeta: el worker tarda y todos los botones quedan quietos.
    nombre: 'tablero-accion-enviando', archivo: 'activity.html', anchos: ANCHOS_ESTADO,
    guion: ABRIR_TABLERO + `;
      document.querySelector('.card[data-case="1"] .card-acts button[data-accion="enviar"]').click()`,
    espera: 500, datos: conTablero(tableroDe(TABLERO_CASOS)),
    stub: { veredictoAccion: { ok: true, code: 'enviado' }, demoraVeredicto: 600000 }
  },
  {
    // La propuesta cambio mientras el dueno la miraba: el error dicho en la tarjeta y en el
    // detalle abierto.
    nombre: 'tablero-accion-error', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true,
    guion: ABRIR_TABLERO + `;
      document.querySelector('.card[data-case="1"]').click();
      document.querySelector('#board-detail button[data-accion="enviar"]').click()`,
    espera: 1500, datos: conTablero(tableroDe(TABLERO_CASOS)),
    stub: { veredictoAccion: { ok: false, code: 'E_VERSION' }, demoraVeredicto: 0 }
  },
  {
    // La linea de WhatsApp no esta: otro error, de wa-send y no del CLI de casos.
    nombre: 'tablero-accion-sin-linea', archivo: 'activity.html', anchos: ANCHOS_ESTADO,
    guion: ABRIR_TABLERO + `;
      document.querySelector('.card[data-case="3"] .card-acts button[data-accion="enviar"]').click()`,
    espera: 1500, datos: conTablero(tableroDe(TABLERO_CASOS)),
    stub: { veredictoAccion: { ok: false, code: 'send-no-transport' }, demoraVeredicto: 0 }
  },
  {
    // Enviado: lo bueno tambien se dice.
    nombre: 'tablero-accion-enviado', archivo: 'activity.html', anchos: ANCHOS_ESTADO,
    guion: ABRIR_TABLERO + `;
      document.querySelector('.card[data-case="3"] .card-acts button[data-accion="enviar"]').click()`,
    espera: 1500, datos: conTablero(tableroDe(TABLERO_CASOS)),
    stub: { veredictoAccion: { ok: true, code: 'enviado' }, demoraVeredicto: 0 }
  },
  {
    // Atender ahora: el agente salio. Dice "lanzado", no "ya responde".
    nombre: 'tablero-atender-lanzado', archivo: 'activity.html', anchos: ANCHOS,
    guion: ABRIR_TABLERO + `;
      document.querySelector('.card[data-case="4"] .card-acts button[data-accion="atender"]').click()`,
    espera: 1500, datos: conTablero(tableroDe(TABLERO_CASOS)),
    stub: { veredictoAccion: { ok: true, code: 'atendido', agent: 'launched' }, demoraVeredicto: 0 }
  },
  {
    // Atender ahora: el caso quedo marcado pero el agente no se pudo lanzar.
    nombre: 'tablero-atender-fallo', archivo: 'activity.html', anchos: ANCHOS,
    guion: ABRIR_TABLERO + `;
      document.querySelector('.card[data-case="4"] .card-acts button[data-accion="atender"]').click()`,
    espera: 1500, datos: conTablero(tableroDe(TABLERO_CASOS)),
    stub: { veredictoAccion: { ok: true, code: 'atendido', agent: 'run-failed', agentReason: 'sin-cuenta' },
      demoraVeredicto: 0 }
  },
  {
    // El ultimo lanzamiento del agente de casos fallo: lo dicen las tarjetas que lo esperan
    // y la linea de la revision, en vez de prometer la proxima corrida.
    nombre: 'tablero-agente-fallo', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, guion: ABRIR_TABLERO, espera: 400,
    datos: Object.assign(corrida({ state: 'ok', startedAt: AHORA_CORTO, endedAt: AHORA_CORTO,
      looked: 4, pending: 0, reason: null }), { board: tableroDe(TABLERO_CASOS.map((c) => (
      c.stage === 'recibido' || c.stage === 'clasificado'
        ? Object.assign({}, c, { waits_agent: true }) : c)), {
      agent_waiting: TABLERO_CASOS.filter((c) => c.stage === 'recibido' ||
        c.stage === 'clasificado').length,
      agent_launch: { state: 'failed', reason: 'sin-cuenta', at: minutos(2),
        detail: 'orca terminal create: This Claude account is in use by an assigned worktree' }
    }) })
  },
  {
    // Claude se cerro al abrir tres veces seguidas: el tick espera una hora y lo dice.
    nombre: 'tablero-agente-se-cierra', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, guion: ABRIR_TABLERO, espera: 400,
    datos: Object.assign(corrida({ state: 'ok', startedAt: AHORA_CORTO, endedAt: AHORA_CORTO,
      looked: 4, pending: 0, reason: null }), { board: tableroDe(TABLERO_CASOS.map((c) => (
      c.stage === 'recibido' || c.stage === 'clasificado'
        ? Object.assign({}, c, { waits_agent: true }) : c)), {
      agent_waiting: TABLERO_CASOS.filter((c) => c.stage === 'recibido' ||
        c.stage === 'clasificado').length,
      agent_launch: { state: 'failed', reason: 'se-cierra', at: minutos(2),
        detail: 'Claude se cerro al abrir: Security guide' }
    }) })
  },
  {
    // El tick no pudo quitar de la barra lateral dos espacios que dejaron las corridas del
    // plugin: lo dice la linea de la revision, para que el dueno los quite a mano.
    nombre: 'tablero-espacios-atascados', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, guion: ABRIR_TABLERO, espera: 400,
    datos: Object.assign(corrida({ state: 'ok', startedAt: AHORA_CORTO, endedAt: AHORA_CORTO,
      looked: 4, pending: 0, reason: null }), { board: tableroDe(TABLERO_CASOS, {
      agent_waiting: 1, workspaces_stuck: 2
    }) })
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
  // 5. Los tres finales del renglon de la linea. Van a la captura por la misma razon
  //    que los cuatro de arriba: en pantalla "no hay nada pendiente" y "no estoy
  //    conectado" se leian IGUAL -una lista vacia- y son lo contrario. Cual de las dos
  //    sea decide si el dueno tiene algo que hacer.
  //
  //    El numero es inventado a proposito, igual que los nombres de los chats: una
  //    captura no lleva la linea real de nadie.
  //
  // 5a. Vinculada: dice que si, y CUAL. Tras escanear un QR es la unica forma de notar
  //     que se escaneo con el telefono equivocado.
  {
    nombre: 'actividad-linea-viva', archivo: 'activity.html', anchos: ANCHOS_ESTADO,
    datos: conLinea({ connection: 'open', qr: null, exited: false, me: '+573001112233',
      latido: LATIDO_FRESCO })
  },
  // 5b. Sin vincular: la lista esta vacia porque no hay linea, no porque no haya
  //     trabajo. Manda a Ajustes, que es donde vive el QR.
  {
    nombre: 'actividad-sin-vincular', archivo: 'activity.html', anchos: ANCHOS_ESTADO,
    datos: conLinea({ connection: 'connecting', qr: 'x'.repeat(120), qrAt: Date.now(),
      ttlMs: 75000, exited: false, me: null })
  },
  // 5c. Caida: es un fallo y se pinta como fallo, no como "todavia no".
  {
    nombre: 'actividad-linea-caida', archivo: 'activity.html', anchos: ANCHOS_ESTADO,
    datos: conLinea({ connection: 'close', qr: null, exited: true, me: null,
      motivo: 'sesion-cerrada' })
  },
  // Los cuatro momentos de conectar una linea de WhatsApp Web. Van a la captura porque
  // el unico que se ve al programar es el ultimo: los otros tres pasan mientras el
  // usuario mira OTRA ventana — la del QR —, y el que se entrega roto es siempre uno de
  // esos. A 320 ademas la fila se parte en bloques y el aviso de desvincular es el
  // parrafo mas largo del panel.
  {
    nombre: 'config-buscando', archivo: 'config.html', anchos: ANCHOS_ESTADO, pestana: 'chats',
    datos: Object.assign({}, SIN_CHATS, {
      syncStatus: { running: true, startedAt: new Date().toISOString(), trigger: 'activate' }
    })
  },
  {
    nombre: 'config-fallo', archivo: 'config.html', anchos: ANCHOS_ESTADO, pestana: 'chats',
    datos: Object.assign({}, SIN_CHATS, {
      syncStatus: {
        ok: false, at: new Date().toISOString(), chats: 0, reason: 'sin-herramientas',
        detail: 'spawn /Applications/Orca.app/plugins/ab2web.orca-wa-inbox/bin/wa-scope ENOENT',
        exitCode: null, trigger: 'activate'
      }
    })
  },
  {
    nombre: 'config-sin-respuesta', archivo: 'config.html', anchos: ANCHOS_ESTADO, pestana: 'chats',
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
  // linea-viva: una linea que nadie atiende, arriba de todo y en cualquier pestana, con sus
  // minutos y si el respaldo del plugin la esta atendiendo. Una, y dos con motivos distintos:
  // a 320 px el numero y la frase larga tienen que partirse sin desbordar.
  { nombre: 'config-linea-sin-atender', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 300,
    datos: Object.assign({}, DATOS, { workerBeat: { at: new Date().toISOString(),
      lineas: { 'pn:15550000001': { desde: Math.round(Date.now() / 1000) - 25 * 60,
        motivo: 'sin-tick', respaldo: 'ok' } } } }) },
  { nombre: 'config-lineas-sin-atender-varias', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 300, idiomas: ['pt'],
    datos: Object.assign({}, DATOS, { workerBeat: { at: new Date().toISOString(),
      lineas: {
        'pn:15550000001': { desde: Math.round(Date.now() / 1000) - 14 * 60,
          motivo: 'sin-juzgar', respaldo: 'failed' },
        'pn:15550000002': { desde: Math.round(Date.now() / 1000) - 31 * 60,
          motivo: 'despacho-atascado', respaldo: 'busy' } } } }) },
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
      sidecar: { connection: 'open', qr: null, exited: false, latido: LATIDO_FRESCO },
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
    datos: DATOS, stub: { falla: ['inboxDays'] }, pestana: 'avanzado',
    guion: `document.querySelector('#inbox-days [data-value="30"]').click();
            document.getElementById('save-reading').click()`
  },
  {
    // Y el guardado EN VUELO: el boton ocupado mientras el host todavia no contesta.
    // Sin poder verlo, un boton que se queda muerto y uno que esta trabajando son la
    // misma imagen.
    nombre: 'config-guardado-en-vuelo', archivo: 'config.html', anchos: ANCHOS_ESTADO,
    datos: DATOS, stub: { demoraSet: 4000 }, pestana: 'avanzado',
    guion: `document.querySelector('#inbox-days [data-value="30"]').click();
            document.getElementById('save-reading').click()`,
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
  // El defecto real: 26 minutos diciendo "unos segundos" mientras el worker seguia
  // vivo y el QR rotaba en storage. Se adelanta el reloj del panel bien pasado el
  // segundo umbral (UMBRAL_ESPERA_LARGA_MS, config.html) y se lo hace volver a mirar
  // (foco), para fotografiar lo que de verdad ve alguien que vuelve a la pestana
  // despues de un rato largo: cuanto lleva, y lo unico que el panel puede afirmar
  // del plugin y de la conexion.
  {
    nombre: 'config-sidecar-esperando-largo', archivo: 'config.html', anchos: ANCHOS,
    datos: Object.assign({}, DATOS,
      { sidecar: { connection: 'connecting', qr: null, exited: false } }),
    guion: 'window.__ahora = Date.now(); window.Date.now = () => window.__ahora + 185000; ' +
      "window.dispatchEvent(new Event('focus'))",
    espera: 400
  },
  {
    nombre: 'config-sidecar-qr', archivo: 'config.html', anchos: ANCHOS,
    // Es lo que aparece solo tras un 401 ahora: por eso va tambien a todo ancho en ingles.
    enTodosLosAnchos: true,
    datos: Object.assign({}, DATOS, { sidecar: {
      connection: 'connecting',
      // Contenido real de un QR multi-dispositivo (docs/ENCARGO...§3: "QR emitido
      // contra WhatsApp real, si, 237 caracteres"): un texto corto fotografiaria un
      // QR mas simple que el que realmente hay que escanear.
      qr: { qr: '2@' + 'A'.repeat(180) + ',B'.repeat(28) + '==', ts: AHORA_MS, rotation: 3 },
      exited: false
    } })
  },
  // El QR vencido ya no se esconde (config.html, `estado === 'expired'`): sigue
  // siendo una imagen valida -WhatsApp la rechaza, no el navegador- y un recuadro
  // vacio se lee como un plugin roto. Se fotografia APAGADO (`.vencido`, opacity
  // .4) y no ausente. El `ttlMs` es el real que manda el sidecar (QR_VIGENCIA_MS,
  // sidecar/src/index.js) y el reloj se adelanta mas alla de el, igual que arriba.
  {
    nombre: 'config-sidecar-qr-vencido', archivo: 'config.html', anchos: ANCHOS,
    datos: Object.assign({}, DATOS, { sidecar: {
      connection: 'connecting',
      qr: { qr: '2@' + 'A'.repeat(180) + ',B'.repeat(28) + '==', ts: AHORA_MS, rotation: 3,
        ttlMs: 75000 },
      exited: false
    } }),
    guion: 'window.__ahora = Date.now(); window.Date.now = () => window.__ahora + 80000; ' +
      "window.dispatchEvent(new Event('focus'))",
    espera: 400
  },
  {
    nombre: 'config-sidecar-conectado', archivo: 'config.html', anchos: ANCHOS,
    datos: Object.assign({}, DATOS,
      { sidecar: { connection: 'open', qr: null, exited: false, latido: LATIDO_FRESCO } })
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
      { sidecar: { connection: 'open', qr: null, exited: false, latido: LATIDO_FRESCO } }),
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
    enTodosLosAnchos: true,
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
    datos: DATOS, pestana: 'chats',
    guion: elegirEn('chat-search', 'chat-list', 'laura mendez', '573000000000@s.whatsapp.net'),
    espera: 400
  },
  {
    // Y el contraste: un uno a uno SIN autorizar. Es el caso que hasta ahora no podia
    // existir —no habia un solo directo en la lista— y el que el dueno vino a pedir.
    // Sin permiso no hay insignia ni aviso, y el renglon de identidad es lo unico que
    // dice cual conversacion es antes de darle permiso a un agente sobre ella.
    nombre: 'config-elegir-sin-autorizar', archivo: 'config.html', anchos: ANCHOS,
    datos: DATOS, pestana: 'chats',
    guion: elegirEn('chat-search', 'chat-list', 'taller demo 2', '120363000000000004@g.us'),
    espera: 400
  },
  // ── La linea muerta (odd/tasks/linea-muerta.md) ──────────────────────────────────
  // Los estados nuevos van a los cuatro anchos, en los dos idiomas y en los dos temas
  // (`enTodosLosAnchos`): son texto nuevo, y un texto nuevo que no cabe o que se cuela
  // en el idioma equivocado no lo delata ninguna prueba de codigo.
  //
  // La linea que dejo de latir: el estado que el panel tapaba con "conectado". Con el
  // renglon de salud que publica el doctor en el mismo momento (`transport-silent`).
  {
    nombre: 'config-sidecar-sin-senal', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true,
    datos: Object.assign({}, DATOS, {
      sidecar: { connection: 'open', qr: null, exited: false, me: '+573001112233',
        latido: LATIDO_VIEJO },
      health: { ok: false, problem: 'a message transport', problemCode: 'transport-silent',
        detail: 'transport-silent: the linked line has given no sign of life since ' +
          '2026-09-30 17:44: nothing is reading WhatsApp right now.',
        optional: [] }
    })
  },
  // El storage EXACTO que quedo en la maquina del dueno: 401, y encima el
  // `sidecar-cayo` que escribia el `exit` del worker viejo. Tiene que ofrecer
  // Desvincular y no Reintentar.
  {
    nombre: 'config-sidecar-401-tapado', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true,
    datos: Object.assign({}, DATOS, { sidecar: {
      connection: 'close', qr: null, exited: true, motivo: 'sidecar-cayo', statusCode: 401,
      error: { code: 'sidecar-cayo', detail: 'sidecar exited (code 0, signal null)' }
    } })
  },
  // Otro equipo usando la misma sesion (440), despues de que el sidecar se rindio.
  {
    nombre: 'config-sidecar-reemplazada', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true,
    datos: Object.assign({}, DATOS, { sidecar: {
      connection: 'close', qr: null, exited: true, motivo: 'sesion-reemplazada',
      statusCode: 440,
      error: { code: 'sesion-reemplazada', detail: 'el socket no va a reintentar mas' }
    } })
  },
  // Y el panel de actividad sobre la misma linea muda.
  {
    nombre: 'actividad-linea-muda', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true,
    datos: conLinea({ connection: 'open', qr: null, exited: false, me: '+573001112233',
      latido: LATIDO_VIEJO })
  },
  // T9: cada numero, su linea. Lo que se vio en vivo tras vincular +573000000012: el
  // panel seguia ofreciendo las conversaciones y mostrando las autorizaciones y la
  // actividad del numero anterior. El storage TODAVIA trae lo del numero viejo (el sync
  // del nuevo no paso), y el panel no lo pinta como si fuera del vinculado.
  {
    nombre: 'config-numero-nuevo', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true, pestana: 'chats',
    datos: Object.assign({}, DATOS, {
      sidecar: { connection: 'open', qr: null, exited: false, me: '+573000000012',
        cuenta: 'pn:573000000012', latido: LATIDO_FRESCO },
      chatsAccount: 'pn:573001112233',
      scope: Object.fromEntries(Object.entries(DATOS.scope).map(([jid, e]) =>
        [jid, Object.assign({}, e, { account: 'pn:573001112233' })]))
    })
  },
  {
    nombre: 'actividad-numero-nuevo', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true,
    datos: Object.assign({}, DATOS, {
      sidecar: { connection: 'open', qr: null, exited: false, me: '+573000000012',
        cuenta: 'pn:573000000012', latido: LATIDO_FRESCO },
      chatsAccount: 'pn:573001112233',
      activity: Object.assign({}, DATOS.activity, { account: 'pn:573001112233',
        mapped: 306, authorized: 3,
        run: { state: 'interrupted', startedAt: '2026-09-24 08:46', endedAt: null } })
    })
  },
  // T10: el chat de la linea consigo misma se llamaba como su jid pelado. Ahora va
  // primero y como en WhatsApp, "<nombre> (tu)". Se fotografia elegido, que es lo que
  // queda a la vista (la lista desplegada la pinta el sistema).
  {
    nombre: 'config-chat-propio', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true,
    datos: Object.assign({}, DATOS, {
      chats: [{ jid: '100000000000002@lid', name: 'Nueva', kind: 'directo', own: true,
        last: '2026-09-17 14:05', unread: 0 }].concat(DATOS.chats)
    }),
    pestana: 'chats',
    guion: elegirEn('chat-search', 'chat-list', 'nueva', '100000000000002@lid'),
    espera: 400
  },
  // T10: una subida de esquema que no borro ningun mensaje no dice "se borro".
  {
    nombre: 'config-migracion-limpia', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true,
    datos: Object.assign({}, DATOS, {
      health: { ok: true, optional: [
        { que: 'message store upgrade', code: 'store-migrated',
          como: 'the message store was upgraded without losing any message',
          howCode: 'store-migrated-clean' }] }
    })
  },
  // T9f: lo de antes que no se pudo atribuir con certeza a un numero. No se movio nada
  // y el panel pide la decision con el comando exacto.
  {
    nombre: 'config-legado-pendiente', archivo: 'config.html', anchos: ANCHOS,
    enTodosLosAnchos: true,
    datos: Object.assign({}, DATOS, {
      health: { ok: true, optional: [
        { que: 'data from a previous number', code: 'store-rekey-pending',
          como: 'conversations stored before each number had its own line stay hidden',
          howCode: 'store-rekey-decide' }] }
    })
  },
  {
    // Un caso reabierto por un seguimiento: su historia partida en tramos con "Reabierto", el
    // caso anterior enlazado, y la excepcion que ya no es una necesidad en Respondido.
    nombre: 'tablero-nuevo-reabierto', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 400,
    datos: Object.assign(conTablero(tableroDe([
      caso(41, 'clasificado', {
        title: 'No funcionó lo que me mandaron ayer', prioridad: 'medium', related_case: 40,
        summary: 'No funcionó lo que me mandaron ayer.', needs_agent: true,
        actions: ['atender', 'ignorar', 'reclasificar', 'cerrar', 'proyecto'],
        events: [
          { de: null, a: 'recibido', actor: 'automatizacion', at: minutos(60 * 3) },
          { de: 'recibido', a: 'clasificado', actor: 'jev', at: minutos(60 * 3 - 1) },
          { de: 'clasificado', a: 'decision', actor: 'agente', at: minutos(60 * 2) },
          { de: 'decision', a: 'respondido', actor: 'dueno', at: minutos(60 * 2 - 3) },
          { de: 'respondido', a: 'recibido', actor: 'automatizacion', at: minutos(6) },
          { de: 'recibido', a: 'clasificado', actor: 'jev', at: minutos(5) }] }),
      caso(40, 'respondido', {
        title: 'Pedido del reporte mensual', exceptions: ['commitment'],
        actions: ['cerrar', 'reabrir'], updated_at: minutos(60 * 2) }),
      caso(42, 'decision', { title: 'Piden su acceso al proyecto', exceptions: ['credential', 'commitment'],
        proposal: { tipo: 'escalar', texto: null, version: 'v-esc' },
        jev: { attention_class: 'access_or_credential', skip: false, flags: ['asks_for_credential'] },
        actions: ['editar', 'autorizar', 'reclasificar', 'cerrar', 'proyecto'] })
    ], { agent_waiting: 2 })), { activity: Object.assign({}, DATOS.activity, {
      run: { state: 'ok', startedAt: '2026-09-17 14:01', endedAt: '2026-09-17 14:02',
        looked: 3, pending: 0, reason: null } }) }),
    guion: ABRIR_TABLERO + `;
      document.querySelector('.card[data-case="41"]').click()`
  },
  {
    // La propuesta escalar sin texto: dice por que, y ofrece Autorizar y Editar y enviar.
    nombre: 'tablero-nuevo-autorizar', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 400,
    datos: conTablero(tableroDe([
      caso(42, 'decision', { title: 'Piden su acceso al proyecto', exceptions: ['credential', 'commitment'],
        summary: 'Dice que necesita acceso al proyecto para revisar el reporte.',
        proposal: { tipo: 'escalar', texto: null, version: 'v-esc' },
        jev: { attention_class: 'access_or_credential', skip: false, flags: ['asks_for_credential'] },
        actions: ['editar', 'autorizar', 'reclasificar', 'cerrar', 'proyecto'] })
    ], { agent_waiting: 2 })),
    guion: ABRIR_TABLERO + `;
      document.querySelector('.card[data-case="42"]').click()`
  },
  {
    // Corrido hasta las terminadas: Respondido y Cerrado con 20 tarjetas cada una.
    nombre: 'tablero-muchas', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 400, datos: conTablero(TABLERO_MUCHOS),
    guion: ABRIR_TABLERO + `; document.getElementById('board-cols').scrollLeft = 1e6`
  },
  {
    // Solo Cerrado, con su cuerpo desplazado hasta el final: el "Mostrar 14 mas".
    nombre: 'tablero-muchas-cerrado', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 400, datos: conTablero(TABLERO_MUCHOS),
    guion: ABRIR_TABLERO + `; document.querySelector('#board-chips [data-etapa="cerrado"]').click();
      setTimeout(() => document.querySelectorAll('.col-body, #board-list').forEach((n) => { n.scrollTop = 1e6 }), 50)`
  },
  {
    // El tablero elegido a mano en lo angosto: las columnas acotadas tambien ahi.
    nombre: 'tablero-muchas-columnas', archivo: 'activity.html', anchos: [390, 320],
    enTodosLosAnchos: true, espera: 400, datos: conTablero(TABLERO_MUCHOS),
    guion: `document.querySelector('#board-view button[data-vista="board"]').click()`
  },
  {
    nombre: 'informes', archivo: 'activity.html', anchos: ANCHOS, enTodosLosAnchos: true,
    espera: 500, guion: ABRIR_INFORMES, idiomas: ['pt'],
    datos: Object.assign(conTablero(tableroDe(TABLERO_CASOS)), { reports: informeDeEjemplo() })
  },
  {
    nombre: 'informes-hoy', archivo: 'activity.html', anchos: ANCHOS_ESTADO, espera: 500,
    guion: ABRIR_INFORMES + ELEGIR_PERIODO('today'), idiomas: ['pt'],
    datos: Object.assign(conTablero(tableroDe(TABLERO_CASOS)), { reports: informeDeEjemplo() })
  },
  {
    // 30 cubetas por dia y "Todo" por semana: las barras mas angostas y las marcas del eje
    // mas largas ("Semana de 28 de set." desbordaba a 768 y a 320).
    nombre: 'informes-30d', archivo: 'activity.html', anchos: ANCHOS, enTodosLosAnchos: true,
    espera: 500, guion: ABRIR_INFORMES + ELEGIR_PERIODO('30d'), idiomas: ['pt'],
    datos: Object.assign(conTablero(tableroDe(TABLERO_CASOS)), { reports: informeDeEjemplo() })
  },
  {
    nombre: 'informes-todo', archivo: 'activity.html', anchos: ANCHOS, enTodosLosAnchos: true,
    espera: 500, guion: ABRIR_INFORMES + ELEGIR_PERIODO('all'), idiomas: ['pt'],
    datos: Object.assign(conTablero(tableroDe(TABLERO_CASOS)), { reports: informeDeEjemplo() })
  },
  {
    // Un periodo sin nada: el tablero lo dice y la barra queda.
    nombre: 'tablero-periodo-vacio', archivo: 'activity.html', anchos: ANCHOS,
    enTodosLosAnchos: true, espera: 400, guion: ABRIR_TABLERO,
    datos: Object.assign(conTablero(TABLERO_PERIODO_VACIO), { boardPeriod: 'today' })
  },
  {
    nombre: 'informes-vacio', archivo: 'activity.html', anchos: ANCHOS, enTodosLosAnchos: true,
    espera: 500, guion: ABRIR_INFORMES,
    datos: Object.assign(conTablero(tableroDe(TABLERO_CASOS)), { reports: informeVacio() })
  },
  {
    nombre: 'informes-sin-clave', archivo: 'activity.html', anchos: ANCHOS_ESTADO, espera: 500,
    guion: ABRIR_INFORMES, datos: conTablero(tableroDe(TABLERO_CASOS))
  },
  {
    // I4: la meta del primer contacto, en Su aprobacion.
    nombre: 'config-sla', archivo: 'config.html', anchos: ANCHOS, enTodosLosAnchos: true,
    datos: DATOS, pestana: 'aprobacion', espera: 300,
    guion: "document.getElementById('sla-minutes').scrollIntoView({ block: 'center' })"
  },
  {
    // proyectos-por-chat (M5/M6): cuantas horas espera la pregunta "A o B?" a quien escribio.
    nombre: 'config-pregunta-horas', archivo: 'config.html', anchos: ANCHOS, enTodosLosAnchos: true,
    idiomas: ['pt'], datos: DATOS, pestana: 'aprobacion', espera: 300,
    guion: "document.getElementById('pq-hours').scrollIntoView({ block: 'center' })"
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
   if (SOLO_IDIOMA && idioma.tag !== SOLO_IDIOMA) continue
   for (const tema of TEMAS) {
    if (SOLO_TEMA && tema !== SOLO_TEMA) continue
    for (const ancho of ANCHOS) {
      if (SOLO_ANCHO && ancho !== SOLO_ANCHO) continue
      const contexto = await navegador.newContext({
        viewport: { width: ancho, height: 900 },
        colorScheme: tema,
        locale: idioma.locale,
        deviceScaleFactor: 2
      })
      for (const panel of PANELES) {
        if (SOLO.length && !SOLO.some((p) => panel.nombre.startsWith(p))) continue
        if (!panel.anchos.includes(ancho)) continue
        if (idioma.soloSiLoPide && !(panel.idiomas || []).includes(idioma.tag)) continue
        // En ingles, por defecto, solo los extremos; los estados marcados van a todos.
        if (!panel.enTodosLosAnchos && !idioma.anchos.includes(ancho)) continue
        const pagina = await contexto.newPage()
        const errores = []
        pagina.on('pageerror', (e) => errores.push(String(e)))
        // El latido se sella AQUI y no en DATOS: una corrida entera dura mas que los
        // 30 s de vencimiento, y las capturas del final salian con el aviso de "el
        // plugin no esta corriendo" encima del estado que venian a mostrar.
        let datos = 'workerBeat' in panel.datos
          ? panel.datos
          : Object.assign({}, panel.datos, { workerBeat: { at: new Date().toISOString() } })
        // Mismo defecto, mas apretado: el QR vive QR_VIGENCIA_MS (sidecar/src/index.js)
        // y `AHORA_MS` se calculo UNA vez al arrancar este guion. Sin esto,
        // "config-sidecar-qr" salia pintando "el codigo vencio" en vez del QR — se vio
        // recien mirando la captura, que es justo la razon de que exista esta regla
        // del proyecto. (El vencido de proposito, "config-sidecar-qr-vencido", pisa
        // este `ts` de nuevo el mismo, y lo envejece de verdad con su propio `guion`.)
        if (datos.sidecar && datos.sidecar.qr) {
          datos = Object.assign({}, datos, { sidecar: Object.assign({}, datos.sidecar,
            { qr: Object.assign({}, datos.sidecar.qr, { ts: Date.now() }) }) })
        }
        if (datos.sidecar && datos.sidecar.latido && datos.sidecar.latido.fresco) {
          datos = Object.assign({}, datos, { sidecar: Object.assign({}, datos.sidecar,
            { latido: { ts: Date.now() - 20000, conectado: true } }) })
        }
        // Lo mismo para cada linea que no es la principal (L4): su QR y su latido.
        if (datos.sidecars) {
          const sellados = {}
          for (const [carpeta, d] of Object.entries(datos.sidecars)) {
            sellados[carpeta] = Object.assign({}, d,
              d.qr ? { qr: Object.assign({}, d.qr, { ts: Date.now() }) } : {},
              d.latido && d.latido.fresco ? { latido: { ts: Date.now() - 20000, conectado: true } } : {})
          }
          datos = Object.assign({}, datos, { sidecars: sellados })
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

        // La pestana de la captura (T17). `null` deja la que el panel elige solo.
        const pestana = panel.archivo === 'config.html' && panel.pestana !== null
          ? (panel.pestana || 'estado') : null
        if (pestana) {
          await pagina.click(`#tab-${pestana}`)
          await pagina.waitForTimeout(100)
        }

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

        // T17: ni un select nativo (su lista no se abre en el panel de Orca). Y la lista
        // del autocompletar flota sobre lo que sigue: con fondo transparente se leeria
        // el texto de abajo a traves de ella. Se mide en vez de mirarse, en los dos temas.
        for (const malo of await pagina.evaluate(() => {
          const opaco = (c) => {
            const m = /rgba?\(([^)]+)\)/.exec(c || '')
            return m ? Number((m[1].split(',')[3] ?? '1').trim()) > 0.99 : false
          }
          const salida = []
          if (document.querySelector('select')) salida.push('hay un <select> nativo')
          for (const el of document.querySelectorAll('.combo-list:not([hidden])')) {
            const e = getComputedStyle(el)
            if (!opaco(e.backgroundColor)) salida.push(`#${el.id} sin fondo propio (${e.backgroundColor})`)
            else if (e.backgroundColor === e.color) salida.push(`#${el.id} con el texto del color del fondo`)
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
  console.log('sin desbordes, sin errores de JS, sin selects y con las listas opacas')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
