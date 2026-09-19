/**
 * Conectar una linea de WhatsApp Web sin abrir una terminal.
 *
 * Hasta aca enlazar una linea eran cuatro comandos: crear el perfil, abrir la pestana,
 * escanear, encender la ruta. Un usuario no corre eso, asi que la funcion existia y no
 * la usaba nadie. El panel solo sabe escribir storage, y el worker es el unico lado que
 * puede ejecutar algo — por eso el flujo entero vive aca y el panel solo deja un pedido.
 *
 * Lo que NO hace: leer conversaciones. Eso es de wa-read. Aca solo se conduce la CLI de
 * Orca (perfil, pestana, foco) y se le dice al registro de wa-scope que esa linea existe.
 */
import { execFile } from 'node:child_process'

const WA_URL = 'https://web.whatsapp.com'
// La pestana tarda en cargar y la CLI a veces arranca el runtime; 30 s es lo que usa
// wa-read para lo mismo.
const ORCA_TIMEOUT_MS = 30000

/** Una llamada a la CLI de Orca. Devuelve el `result`, o el motivo en `error`.
 *
 *  No lanza cuando la CLI contesta mal a proposito: `selector_not_found` es la
 *  respuesta con la que se detecta que este Orca no conoce el espacio flotante, y una
 *  excepcion la convertiria en una falla en vez de en un dato. */
function orcaJson(exe, args, { timeoutMs = ORCA_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(exe, [...args, '--json'], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          resolve({ ok: false, code: error.code === 'ENOENT' ? 'sin-orca' : 'fallo',
                    message: String(stderr || error.message).trim().slice(0, 300) })
          return
        }
        let data = null
        try {
          data = JSON.parse(stdout || 'null')
        } catch {
          resolve({ ok: false, code: 'fallo',
                    message: String(stdout || stderr).trim().slice(0, 300) })
          return
        }
        if (!data || data.ok !== true) {
          resolve({ ok: false, code: data?.error?.code || 'fallo',
                    message: String(data?.error?.message || '').slice(0, 300) })
          return
        }
        // El runtime que contesto viaja con cada respuesta: es la identidad del HOST
        // y es lo unico que distingue el espacio flotante de esta maquina del de otra.
        resolve({ ok: true, result: data.result || {},
                  runtimeId: data._meta?.runtimeId || null })
      })
  })
}

/**
 * Que runtime contesta a esta CLI. Es la identidad del host de una linea.
 *
 * La CLI a secas SIEMPRE habla con el runtime local de esta maquina: solo `--environment`
 * la manda a uno remoto, y el worker del plugin no recibe esa variable (orca-oss,
 * plugin-worker-env.ts: la lista de env es una allowlist sin ORCA_ENVIRONMENT). Asi que
 * una linea vive donde corre Orca, y esto lo deja ESCRITO en vez de supuesto.
 */
export async function hostActual(exe) {
  const r = await orcaJson(exe, ['tab', 'list', '--worktree', 'all'])
  if (!r.ok) return { ok: false, code: r.code, message: r.message }
  return { ok: true, runtimeId: r.runtimeId }
}

/**
 * Si este Orca sabe resolver `--worktree floating`.
 *
 * Se pregunta con una lectura, no leyendo el `--help`: el selector lo resuelve el
 * runtime (orca-oss PR #410), asi que un binario nuevo contra un runtime viejo miente
 * en el texto de ayuda y no en la respuesta. `selector_not_found` es el no.
 */
export async function soportaFlotante(exe) {
  const r = await orcaJson(exe, ['tab', 'list', '--worktree', 'floating'])
  if (r.ok) return { ok: true, flotante: true }
  if (r.code === 'selector_not_found') return { ok: true, flotante: false }
  return { ok: false, code: r.code, message: r.message }
}

/** El worktree del espacio flotante. Es una constante del runtime, no un id que
 *  cambie por instalacion (orca-oss, src/shared/floating-workspace-selector.ts). */
export const FLOTANTE_WORKTREE_ID = 'global-floating-terminal'

/** Los arboles que Orca conoce ahora mismo, tal cual los lista. */
async function arbolesDe(exe) {
  const lista = await orcaJson(exe, ['worktree', 'list'])
  if (!lista.ok) return { ok: false, code: lista.code, message: lista.message }
  const arboles = Array.isArray(lista.result) ? lista.result
    : (lista.result?.worktrees || [])
  return { ok: true, arboles }
}

/**
 * Donde va a vivir la pestana, y como se llama ese lugar para decirselo al usuario.
 *
 * El flotante ya NO es el destino por defecto. Sobrevive a cerrar un proyecto, si, pero
 * su panel no se puede abrir desde ningun comando y su atajo solo existe en macOS
 * (`defaultBindings` de floatingWorkspace.maximize: darwin si, linux y win32 vacios):
 * en la segunda maquina no habia NINGUNA forma de llegar al QR. Una pestana prolija que
 * el usuario no puede mirar vale menos que una que se cierra con el proyecto.
 */
export async function dondeVaLaPestana(exe, contextoActivo, preferencia = 'proyecto') {
  if (preferencia === 'flotante') {
    const soporte = await soportaFlotante(exe)
    if (!soporte.ok) return { ok: false, code: soporte.code, message: soporte.message }
    if (!soporte.flotante) {
      return { ok: false, code: 'sin-flotante',
               message: 'this Orca cannot open a tab in the floating workspace' }
    }
    return { ok: true, donde: 'flotante', selector: 'floating',
             worktreeId: FLOTANTE_WORKTREE_ID }
  }

  const lista = await arbolesDe(exe)
  if (!lista.ok) return { ok: false, code: lista.code, message: lista.message }
  if (!lista.arboles.length) {
    return { ok: false, code: 'sin-proyecto',
             message: 'no Orca worktree is open to hold the tab' }
  }
  // El que el usuario esta mirando, por nombre; si el host no lo dice, el de actividad
  // mas reciente. Se resuelve a id y no a `name:` porque dos ramas pueden llamarse igual.
  const visible = contextoActivo?.displayName
  const elegido = lista.arboles.find((w) => w.displayName === visible) ||
    lista.arboles.slice()
      .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))[0]
  // El id concreto viaja con el destino. Devolver solo "proyecto" es lo que hacia que
  // reabrir cayera en el arbol de actividad mas reciente y no en el de ESA linea.
  return { ok: true, donde: 'proyecto', selector: `id:${elegido.id}`,
           worktreeId: elegido.id, proyecto: elegido.displayName || elegido.path }
}

/**
 * El destino de una linea que YA tiene casa. No elige: resuelve la que esta anotada.
 *
 * Es la diferencia entre "donde va la proxima" y "donde vive esta". Mezclarlas era el
 * defecto: reabrir leia el selector global y una linea creada en el flotante volvia en
 * un proyecto — o en OTRO proyecto, el de actividad mas reciente.
 *
 * Cuando la casa ya no existe no se cae a ningun otro lado: eso es un estado con nombre
 * (`casa-ausente`, `otro-host`) y una accion que pide el usuario, no una mudanza muda.
 */
export async function destinoDeCasa(exe, casa) {
  if (!casa || !casa.donde) return { ok: false, code: 'sin-casa', message: '' }
  const host = await hostActual(exe)
  if (!host.ok) return { ok: false, code: host.code, message: host.message }
  if (casa.host && host.runtimeId && casa.host !== host.runtimeId) {
    return { ok: false, code: 'otro-host', message: casa.host }
  }
  if (casa.donde === 'flotante') {
    const soporte = await soportaFlotante(exe)
    if (!soporte.ok) return { ok: false, code: soporte.code, message: soporte.message }
    if (!soporte.flotante) {
      return { ok: false, code: 'sin-flotante',
               message: 'this Orca cannot open a tab in the floating workspace' }
    }
    return { ok: true, donde: 'flotante', selector: 'floating',
             worktreeId: FLOTANTE_WORKTREE_ID }
  }
  const lista = await arbolesDe(exe)
  if (!lista.ok) return { ok: false, code: lista.code, message: lista.message }
  const suyo = lista.arboles.find((w) => w.id === casa.worktreeId)
  if (!suyo) return { ok: false, code: 'casa-ausente', message: casa.proyecto || '' }
  return { ok: true, donde: 'proyecto', selector: `id:${suyo.id}`, worktreeId: suyo.id,
           proyecto: suyo.displayName || suyo.path }
}

// La sonda de estado es propia y minima a proposito: la de wa-read baja la lista de
// conversaciones entera, y aca la pregunta es otra — si esa sesion esta enlazada, si
// tiene el QR en pantalla, y con que identidad. Nada de esto abre una conversacion.
const SONDA_ESTADO = `(() => {
  try {
    const lid = String(JSON.parse(localStorage.getItem('WALid') || 'null') || '')
      .split(':')[0].split('@')[0];
    if (lid) return { linked: true, lid: lid };
    return { linked: false, qr: !!document.querySelector('canvas[aria-label]') };
  } catch (e) { return { linked: false, qr: false, error: String(e) }; }
})()`

/**
 * Todas las pestanas abiertas, vivan donde vivan.
 *
 * Es una union y no una sola llamada porque cada listado tiene su punto ciego. El
 * listado pelado —el que corria wa-read— se acota al worktree que CONTIENE el cwd
 * (orca-oss, src/cli/selectors.ts): parado en un proyecto no devuelve nada del espacio
 * flotante, y ese cero se leia como "no hay pestana" sobre una linea cuya pestana
 * estaba abierta y cargada. `all` cubre el resto, y `floating` queda de cinturon para
 * la version donde `all` no lo incluya.
 *
 * Falla solo si fallan TODOS: que un selector no exista en este Orca no puede borrar lo
 * que los otros ya encontraron.
 */
async function listarPestanas(exe) {
  const vistas = [[], ['--worktree', 'all'], ['--worktree', 'floating']]
  const porPagina = new Map()
  let ultimo = null
  let alguna = false
  let runtimeId = null
  for (const extra of vistas) {
    const r = await orcaJson(exe, ['tab', 'list', ...extra])
    if (!r.ok) { ultimo = r; continue }
    alguna = true
    runtimeId = runtimeId || r.runtimeId
    for (const t of r.result.tabs || []) {
      if (t.browserPageId && !porPagina.has(t.browserPageId)) {
        porPagina.set(t.browserPageId, t)
      }
    }
  }
  if (!alguna) {
    return { ok: false, code: ultimo?.code || 'fallo', message: ultimo?.message || '' }
  }
  return { ok: true, tabs: [...porPagina.values()], runtimeId }
}

/** La pestana abierta en WhatsApp Web para ese perfil, si la hay. */
async function pestanaDe(exe, profile) {
  const r = await listarPestanas(exe)
  if (!r.ok) return { ok: false, code: r.code, message: r.message }
  const runtimeId = r.runtimeId
  const abiertas = r.tabs.filter((t) => (t.url || '').includes('web.whatsapp.com'))
  // El id primero y la etiqueta despues, nunca mezclados: una etiqueta que coincide con
  // el id de OTRO perfil ganaba por orden de pestana, y mandaba al usuario a la sesion
  // de otro numero. Lo mismo hace web_page() en wa-read.
  let suyas = abiertas.filter((t) => t.profileId === profile)
  if (!suyas.length) {
    suyas = abiertas.filter((t) => t.profileLabel === profile)
    if (new Set(suyas.map((t) => t.profileId)).size > 1) suyas = []
  }
  return { ok: true, tab: suyas[0] || null, runtimeId }
}

/**
 * Donde esta esa pestana AHORA, leido de la pestana misma.
 *
 * El `placement` era un valor guardado: lo escribia el que abria la pestana y despues
 * se arrastraba de refresco en refresco. Con la pestana movida a un proyecto, el panel
 * seguia diciendo "vive en el espacio flotante" y mandaba al usuario a un panel vacio.
 * El worktree de la pestana es el unico dato que no puede quedar viejo.
 */
function ubicacionDe(tab, nombreDeArbol) {
  const wt = String(tab?.worktreeId || '')
  if (!wt) return { placement: null, project: null }
  if (wt === FLOTANTE_WORKTREE_ID) return { placement: 'flotante', project: null }
  return { placement: 'proyecto', project: nombreDeArbol(wt), worktreeId: wt }
}

/**
 * En que estado esta cada linea registrada, preguntandoselo a la sesion de verdad.
 *
 * Afirmar el estado desde el registro es lo que hacia que el panel dijera "enlazada"
 * con el QR en pantalla: la fila dice que la linea existe, no que el telefono siga
 * del otro lado.
 */
export async function estadoDeLineas(exe, cuentas) {
  const salida = []
  // El host sale del listado de pestanas que igual hay que hacer: preguntarlo aparte
  // seria un subproceso mas por vuelta del sondeo, cada 3 s, para siempre.
  let runtimeId = null
  // Una sola lectura de arboles para todas las lineas: el nombre del proyecto se
  // resuelve por linea y pedirlo por linea seria un subproceso por fila y por vuelta.
  const lista = await arbolesDe(exe)
  const nombres = new Map()
  for (const w of (lista.ok ? lista.arboles : [])) {
    nombres.set(w.id, w.displayName || w.path || '')
  }
  const nombreDeArbol = (id) => nombres.get(id) || ''
  for (const cuenta of cuentas) {
    const p = await pestanaDe(exe, cuenta.profile)
    runtimeId = runtimeId || p.runtimeId || null
    const base = { id: cuenta.id, label: cuenta.label, profile: cuenta.profile,
                   pending: !!cuenta.pending, linkedAt: cuenta.linked_at || null,
                   authorizedChats: cuenta.authorized_chats || 0, host: runtimeId }
    if (!p.ok) {
      salida.push({ ...base, state: p.code === 'sin-orca' ? 'sin-orca' : 'sin-pestana',
                    detail: p.message })
      continue
    }
    if (!p.tab) {
      salida.push({ ...base, state: 'sin-pestana' })
      continue
    }
    const pageId = p.tab.browserPageId
    // Se calcula por fila y en cada vuelta: es la respuesta a "donde miro el QR", y una
    // respuesta vieja manda al usuario a un panel vacio.
    Object.assign(base, ubicacionDe(p.tab, nombreDeArbol))
    const ev = await orcaJson(exe, ['eval', '--page', pageId, '--expression', SONDA_ESTADO])
    if (!ev.ok) {
      // La pestana esta y no contesta: casi siempre sigue cargando. Es un estado
      // distinto de "no hay pestana" porque la accion es esperar, no abrir nada.
      salida.push({ ...base, pageId, state: 'cargando', detail: ev.message })
      continue
    }
    // `orca eval` devuelve el valor ya serializado en `result.result`; leerlo como
    // objeto dejaba todo en "esperando" con la sesion enlazada del otro lado.
    let v = {}
    try {
      const crudo = ev.result?.result
      v = typeof crudo === 'string' ? JSON.parse(crudo) : (crudo || {})
    } catch {
      v = {}
    }
    if (v.linked && v.lid) {
      salida.push({ ...base, pageId, state: 'enlazada', lid: v.lid })
    } else {
      // Con QR en pantalla y sin enlace previo esta esperando el escaneo; con enlace
      // previo es una sesion que se cayo. La misma pantalla, dos mensajes distintos.
      salida.push({ ...base, pageId, state: base.linkedAt ? 'caida' : 'esperando' })
    }
  }
  return salida
}

/** Crea el perfil aislado y la pestana, y anota la linea en el registro. */
export async function conectarLinea({ exe, waScope, run, label, contextoActivo, donde }) {
  const destino = await dondeVaLaPestana(exe, contextoActivo, donde)
  if (!destino.ok) return { ok: false, code: destino.code, detail: destino.message }

  // Aislado y no importado: dos sesiones de WhatsApp Web en el mismo perfil se
  // desloguean entre si, asi que el perfil ES lo que separa una linea de otra.
  const perfil = await orcaJson(exe, ['tab', 'profile', 'create', '--label', label,
                                      '--scope', 'isolated'])
  if (!perfil.ok) return { ok: false, code: perfil.code, detail: perfil.message }
  const profileId = perfil.result.profile?.id || perfil.result.id
  if (!profileId) {
    return { ok: false, code: 'fallo', detail: 'the Orca CLI created no profile id' }
  }

  const pestana = await orcaJson(exe, ['tab', 'create', '--url', WA_URL,
                                       '--profile', profileId,
                                       '--worktree', destino.selector])
  if (!pestana.ok) {
    // Sin pestana el perfil queda huerfano y ocuparia un nombre en la lista del usuario.
    await orcaJson(exe, ['tab', 'profile', 'delete', '--profile', profileId])
    return { ok: false, code: pestana.code, detail: pestana.message }
  }

  const fila = await run(waScope, ['accounts', '--connect', profileId,
                                   '--label', label, '--json'])
  let cuenta = null
  try {
    cuenta = JSON.parse(fila.stdout || 'null')?.[0] || null
  } catch {
    cuenta = null
  }
  // La ruta web se enciende recien ahora: encenderla antes de que exista una linea deja
  // a `sources()` leyendo cualquier pestana de WhatsApp Web que hubiera abierta.
  await run(waScope, ['config', 'read_web', 'on'])
  return { ok: true, profileId, pageId: pestana.result.browserPageId || null,
           donde: destino.donde, proyecto: destino.proyecto || null, cuenta,
           // La casa nace aca y con el host adentro: el perfil del navegador vive en UN
           // runtime, asi que la sesion escaneada no existe en ningun otro.
           casa: { host: pestana.runtimeId || null, donde: destino.donde,
                   worktreeId: destino.worktreeId || null,
                   proyecto: destino.proyecto || null } }
}

/**
 * Pone esa pestana delante del usuario, y dice la verdad sobre si lo logro.
 *
 * `tab switch --focus` no revela nada por si solo: el renderer lo aplica SOLO si el
 * usuario ya esta parado en el worktree de la pestana, y si no lo deja preparado en
 * silencio (orca-oss, useIpcEvents: "--focus must NOT call setActiveWorktree"). Medido:
 * parado en otro proyecto devuelve ok y no se ve nada — el "presiono y no abre nada".
 * Por eso primero se hace activo ese worktree con la unica via que existe, un
 * `terminal switch` sobre una terminal suya, y recien despues se enfoca la pestana.
 *
 * En el espacio flotante no hay ninguna via: su panel es estado del renderer, sin RPC
 * ni comando. Ahi se devuelve `flotante-sin-via` en vez de un ok mentiroso.
 */
export async function verPestana(exe, pageId, ubicacion = {}) {
  if (ubicacion.placement === 'flotante') {
    return { ok: false, code: 'flotante-sin-via', detail: '' }
  }
  let alFrente = false
  if (ubicacion.worktreeId) {
    const t = await orcaJson(exe, ['terminal', 'list', '--worktree',
                                   `id:${ubicacion.worktreeId}`, '--limit', '1'])
    const mango = t.ok ? (t.result.terminals || [])[0]?.handle : null
    if (mango) {
      const s = await orcaJson(exe, ['terminal', 'switch', '--terminal', mango])
      alFrente = s.ok
    }
  }
  const r = await orcaJson(exe, ['tab', 'switch', '--page', pageId, '--focus'])
  if (!r.ok) return { ok: false, code: r.code, detail: r.message }
  // Sin haber podido traer el worktree al frente, el foco pudo quedar preparado y
  // nada mas. Se dice cual de las dos cosas paso: un ok a secas es el defecto.
  return { ok: true, surfaced: alFrente, project: ubicacion.project || null }
}

/** Vuelve a abrir la pestana de una linea ya registrada, en SU casa y su mismo perfil.
 *
 *  `casa` manda; el selector global del panel no se mira. Mirarlo era lo que mudaba de
 *  superficie una sesion que el usuario habia puesto en una a proposito. */
export async function reabrirPestana({ exe, profile, casa }) {
  const destino = await destinoDeCasa(exe, casa)
  if (!destino.ok) return { ok: false, code: destino.code, detail: destino.message }
  const r = await orcaJson(exe, ['tab', 'create', '--url', WA_URL, '--profile', profile,
                                 '--worktree', destino.selector])
  if (!r.ok) return { ok: false, code: r.code, detail: r.message }
  return { ok: true, pageId: r.result.browserPageId || null, donde: destino.donde,
           worktreeId: destino.worktreeId || null, proyecto: destino.proyecto || null }
}

/** Cierra una pestana y dice si pudo. */
export async function cerrarPestana(exe, pageId) {
  const r = await orcaJson(exe, ['tab', 'close', '--page', pageId])
  return r.ok ? { ok: true } : { ok: false, code: r.code, detail: r.message }
}

/** Lleva la pestana de una linea a otra casa. Es la UNICA via que la relocaliza.
 *
 *  Se cierra la vieja antes de abrir la nueva: dos pestanas de WhatsApp Web en el mismo
 *  perfil se desloguean entre si, y perder la sesion enlazada es peor que quedar un
 *  momento sin pestana — `sin-pestana` ya ofrece volver a abrirla. */
export async function mudarPestana({ exe, profile, contextoActivo, donde, pageId }) {
  const destino = await dondeVaLaPestana(exe, contextoActivo, donde)
  if (!destino.ok) return { ok: false, code: destino.code, detail: destino.message }
  if (pageId) await orcaJson(exe, ['tab', 'close', '--page', pageId])
  const r = await orcaJson(exe, ['tab', 'create', '--url', WA_URL, '--profile', profile,
                                 '--worktree', destino.selector])
  if (!r.ok) return { ok: false, code: r.code, detail: r.message }
  return { ok: true, pageId: r.result.browserPageId || null, donde: destino.donde,
           worktreeId: destino.worktreeId || null, proyecto: destino.proyecto || null,
           casa: { host: r.runtimeId || null, donde: destino.donde,
                   worktreeId: destino.worktreeId || null,
                   proyecto: destino.proyecto || null } }
}

/** Saca la linea del registro, cierra su pestana y borra su perfil.
 *
 *  Lo que no se pudo borrar se devuelve en `sobras`. Callarlo dejaba la sesion enlazada
 *  en disco despues de que el usuario dijo que la queria fuera, y el panel diciendo que
 *  la linea ya no estaba. */
export async function olvidarLinea({ exe, waScope, run, id, profile, pageId }) {
  const salida = await run(waScope, ['accounts', '--forget', id, '--json'])
  let quitada = null
  try {
    quitada = JSON.parse(salida.stdout || 'null')?.[0] || null
  } catch {
    quitada = null
  }
  const sobras = []
  if (pageId) {
    const r = await orcaJson(exe, ['tab', 'close', '--page', pageId])
    if (!r.ok) sobras.push({ que: 'pestana', code: r.code, detail: r.message })
  }
  // El perfil se borra con la linea: dejarlo deja la sesion enlazada en disco, que es
  // justo lo que el usuario acaba de decir que no quiere.
  if (profile) {
    const r = await orcaJson(exe, ['tab', 'profile', 'delete', '--profile', profile])
    if (!r.ok) sobras.push({ que: 'perfil', code: r.code, detail: r.message })
  }
  return { ok: !sobras.length, quitada, sobras }
}

/** Promueve a su identidad real la linea que acaba de terminar de escanear.
 *
 *  Lanza si el registro no contesta algo legible. Devolver null la dejaba `pending`
 *  para siempre: el usuario escaneaba el QR, la sesion quedaba enlazada de verdad, y el
 *  panel seguia diciendo "esperando el escaneo" sin motivo ninguno. */
export async function identificarLinea({ waScope, run, id, lid, label }) {
  const args = ['accounts', '--identify', id, '--lid', lid, '--json']
  if (label) args.splice(args.length - 1, 0, '--label', label)
  const salida = await run(waScope, args)
  try {
    return JSON.parse(salida.stdout || 'null')?.[0] || null
  } catch {
    throw new Error('wa-scope accounts --identify returned no JSON: ' +
      String(salida.stdout).slice(0, 200))
  }
}
