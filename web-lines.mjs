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
        resolve({ ok: true, result: data.result || {} })
      })
  })
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

/**
 * Donde va a vivir la pestana, y como se llama ese lugar para decirselo al usuario.
 *
 * El flotante es el unico sitio que sobrevive a cerrar un proyecto, que es justo lo que
 * esta sesion necesita. Sin el, la pestana cae en un proyecto de verdad y eso se dice:
 * dejarla caer en "el que estuviera activo" sin nombrarlo es como se pierde una pestana.
 */
export async function dondeVaLaPestana(exe, contextoActivo) {
  const soporte = await soportaFlotante(exe)
  if (!soporte.ok) return { ok: false, code: soporte.code, message: soporte.message }
  if (soporte.flotante) return { ok: true, donde: 'flotante', selector: 'floating' }

  const lista = await orcaJson(exe, ['worktree', 'list'])
  const arboles = Array.isArray(lista.result) ? lista.result
    : (lista.result?.worktrees || [])
  if (!arboles.length) {
    return { ok: false, code: 'sin-proyecto',
             message: 'no Orca worktree is open to hold the tab' }
  }
  // El que el usuario esta mirando, por nombre; si el host no lo dice, el de actividad
  // mas reciente. Se resuelve a id y no a `name:` porque dos ramas pueden llamarse igual.
  const visible = contextoActivo?.displayName
  const elegido = arboles.find((w) => w.displayName === visible) ||
    arboles.slice().sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))[0]
  return { ok: true, donde: 'proyecto', selector: `id:${elegido.id}`,
           proyecto: elegido.displayName || elegido.path }
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

/** La pestana abierta en WhatsApp Web para ese perfil, si la hay. */
async function pestanaDe(exe, profile) {
  const r = await orcaJson(exe, ['tab', 'list', '--worktree', 'all'])
  if (!r.ok) return { ok: false, code: r.code, message: r.message }
  const tabs = r.result.tabs || []
  const suya = tabs.find((t) => (t.url || '').includes('web.whatsapp.com') &&
    (t.profileId === profile || t.profileLabel === profile))
  return { ok: true, tab: suya || null }
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
  for (const cuenta of cuentas) {
    const base = { id: cuenta.id, label: cuenta.label, profile: cuenta.profile,
                   pending: !!cuenta.pending, linkedAt: cuenta.linked_at || null,
                   authorizedChats: cuenta.authorized_chats || 0 }
    const p = await pestanaDe(exe, cuenta.profile)
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
export async function conectarLinea({ exe, waScope, run, label, contextoActivo }) {
  const destino = await dondeVaLaPestana(exe, contextoActivo)
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
           donde: destino.donde, proyecto: destino.proyecto || null, cuenta }
}

/** Pone esa pestana delante del usuario. Es la respuesta a "donde se abre". */
export async function verPestana(exe, pageId) {
  const r = await orcaJson(exe, ['tab', 'switch', '--page', pageId, '--focus'])
  return r.ok ? { ok: true } : { ok: false, code: r.code, detail: r.message }
}

/** Vuelve a abrir la pestana de una linea ya registrada, en su mismo perfil. */
export async function reabrirPestana({ exe, profile, contextoActivo }) {
  const destino = await dondeVaLaPestana(exe, contextoActivo)
  if (!destino.ok) return { ok: false, code: destino.code, detail: destino.message }
  const r = await orcaJson(exe, ['tab', 'create', '--url', WA_URL, '--profile', profile,
                                 '--worktree', destino.selector])
  if (!r.ok) return { ok: false, code: r.code, detail: r.message }
  return { ok: true, pageId: r.result.browserPageId || null, donde: destino.donde,
           proyecto: destino.proyecto || null }
}

/** Saca la linea del registro, cierra su pestana y borra su perfil. */
export async function olvidarLinea({ exe, waScope, run, id, profile, pageId }) {
  const salida = await run(waScope, ['accounts', '--forget', id, '--json'])
  let quitada = null
  try {
    quitada = JSON.parse(salida.stdout || 'null')?.[0] || null
  } catch {
    quitada = null
  }
  if (pageId) await orcaJson(exe, ['tab', 'close', '--page', pageId])
  // El perfil se borra con la linea: dejarlo deja la sesion enlazada en disco, que es
  // justo lo que el usuario acaba de decir que no quiere.
  if (profile) await orcaJson(exe, ['tab', 'profile', 'delete', '--profile', profile])
  return { ok: true, quitada }
}

/** Promueve a su identidad real la linea que acaba de terminar de escanear. */
export async function identificarLinea({ waScope, run, id, lid, label }) {
  const args = ['accounts', '--identify', id, '--lid', lid, '--json']
  if (label) args.splice(args.length - 1, 0, '--label', label)
  const salida = await run(waScope, args)
  try {
    return JSON.parse(salida.stdout || 'null')?.[0] || null
  } catch {
    return null
  }
}
