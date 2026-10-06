// El almacen de mensajes: lo unico que separa a este plugin de "conecta y se detiene".
//
// DONDE VIVE, y por que. `~/.wa-inbox/capture.db`, al lado de `scope.db`:
//
//  - NO puede ir dentro del arbol del plugin: esta verificado por content-hash
//    (docs/ENCARGO-TRANSPORTE-UNICO.md §7), y un archivo que aparece despues de la
//    instalacion deja el plugin en "No valido".
//  - No va en `<userData>/plugins-data/<publisher>.<id>/` —donde SI vive el auth
//    state— porque ese directorio solo se puede resolver preguntandole a Orca, en un
//    subproceso, y puede no existir (`sin-userdata`). El auth state es una credencial
//    de Orca y ahi pertenece; el almacen lo tienen que poder abrir los CLI de Python
//    corridos a mano, desde una terminal, con Orca cerrado. `wa-read` y `wa-scope`
//    resuelven `~/.wa-inbox` sin depender de nadie.
//  - Y sobre todo: el ALCANCE vive en `~/.wa-inbox/scope.db`. La llave del almacen es
//    `(cuenta, chat_jid, stanza_id)` y la de la autorizacion es `(cuenta, chat_jid)`;
//    que las dos bases esten en el mismo directorio y se respalden juntas no es
//    comodidad, es que una sin la otra no significa nada.
//
// Y `capture.db` ya estaba nombrado ahi: `bin/wa-scope:987` declara sus dos topes de
// retencion —`capture_max`, `capture_days`— diciendo "El almacen de cuerpos de mensajes
// (~/.wa-inbox/capture.db)". Esto no elige un lugar nuevo: ocupa el que el registro ya
// reservo, con los topes que el panel ya sabe guardar.
//
// QUIEN ESCRIBE. El sidecar, y solo el, en todo lo que es CONTENIDO RECIBIDO: `linea`,
// `chat`, `grupo_miembro`, `mensaje`, `desalojo`, `migracion`. El worker corre tras la
// valla de permisos de Node y NO tiene `--allow-fs-write` (no existe en todo orca-oss,
// §1): no puede escribir aca ni debe intentarlo. `wa-read`, que es Python y por eso no
// hereda la valla, solo lee.
//
// La UNICA excepcion es `envio`, la bandeja de salida, donde `bin/wa-send` inserta su
// peticion y el sidecar escribe el veredicto. Son dos escritores sobre una tabla, que
// es justo por lo que esa tabla es una tabla y no un archivo: la llave `req_id` y el
// `update ... where estado='pendiente'` hacen que dos escritores no puedan entregar el
// mismo mensaje dos veces. El detalle entero esta en el comentario de `envio`.
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { cuentaDeIdentidad, jidDeChat, parLidTelefono } from './mensajes.js'

// El esquema lo crea el escritor y lo LEE `bin/wa_store.py`. Si algun dia divergen, el
// lector tiene que decirlo en voz alta en vez de contestar filas incompletas: por eso
// la version viaja en una tabla y no en un comentario (§11-E5, y E1: un codigo estable
// es lo que el panel traduce).
export const ESQUEMA_VERSION = 1

// CONTABILIDAD. Desde cuando esta enlazada cada linea y quien es. Sobrevive a apagar
// la captura: no es contenido de nadie (§11-F3).
//
// Va parametrizada por el nombre porque la migracion la REHACE con otro nombre y
// despues la renombra: la forma vieja de esta tabla tiene dos columnas y esta tiene
// siete, y `create table if not exists` sobre la vieja no agrega ninguna. Una segunda
// copia de estas columnas escrita a mano en la migracion es la manera conocida de que
// las dos terminen discrepando sin que nadie lo vea.
const LINEA = (nombre) => `
create table if not exists ${nombre} (
  account    text primary key,
  first_seen integer not null,
  lid        text,
  pn         text,
  name       text,
  groups_n   integer not null default 0,
  updated_at integer
);`

const COLUMNAS_LINEA = ['account', 'first_seen', 'lid', 'pn', 'name', 'groups_n',
  'updated_at']

const ESQUEMA = `
create table if not exists store_meta (key text primary key, value text not null);
${LINEA('linea')}

-- CONTABILIDAD. Que conversaciones existen. Se anota SIEMPRE, incluso para un chat en
-- 'off': sin esto una conversacion que nadie autorizo nunca se puede ofrecer para
-- autorizarla, y la lista del panel nace vacia para siempre. Nombre, si es grupo y
-- cuando se la vio por ultima vez no son el texto de nadie.
create table if not exists chat (
  account    text not null,
  chat_jid   text not null,
  chat_name  text not null default '',
  is_group   integer not null default 0,
  unread     integer not null default 0,
  last_ts    integer,
  first_seen integer not null,
  primary key (account, chat_jid)
);

-- CONTABILIDAD. El telefono de cada LID. WhatsApp guarda los directos con un id
-- interno (<digitos>@lid) y ya no muestra el numero: sin esto el dueno no distingue
-- un chat de otro ni lo encuentra por el telefono de su agenda. Un jid y un numero,
-- por linea, de la libreta, de los mensajes y del historial: nunca un cuerpo. Nueva
-- tabla y no una columna de chat: el par existe aunque la conversacion no.
create table if not exists lid_telefono (
  account    text not null,
  lid        text not null,
  pn         text not null,
  updated_at integer not null,
  primary key (account, lid)
);

-- CONTABILIDAD. Quien esta en cada grupo (roles-por-numero, M8): el dueno marca desde el
-- panel a cada persona Operador o Super admin de ESE grupo, y sin la lista no tiene a quien
-- marcar. Ids y si es admin de WhatsApp, nunca un cuerpo; se anota aunque el grupo este en
-- 'off', como chat. La linea misma no se guarda: no es nadie a quien darle un rol.
-- admin es 1 para admin y superadmin de WhatsApp. No es el rol del plugin: ese lo pone
-- el dueno (chat_scope.miembros, en scope.db), nunca WhatsApp ni el texto de un mensaje.
create table if not exists grupo_miembro (
  account    text not null,
  chat_jid   text not null,
  member_jid text not null,
  admin      integer not null default 0,
  updated_at integer not null,
  primary key (account, chat_jid, member_jid)
);

-- CONTENIDO. Solo de conversaciones autorizadas. La llave lleva la CUENTA adelante
-- (§11-F4): "servir el cuerpo de la otra linea es contestar sobre la conversacion
-- ajena". Dos lineas propias pueden tener el mismo jid de contacto con la misma
-- persona, y con el jid solo esas dos filas se colapsan en una (§11-A1).
create table if not exists mensaje (
  account     text not null,
  chat_jid    text not null,
  stanza_id   text not null,
  ts          integer not null,
  from_me     integer not null default 0,
  sender_jid  text,
  sender_name text,
  body        text not null default '',
  media_type  text,
  media_path  text,
  media_bytes integer,
  menciona_me integer not null default 0,
  cita_me     integer not null default 0,
  -- Revocado: la fila queda como lapida con el cuerpo vacio, y no se borra. Borrarla
  -- dejaria que la proxima sincronizacion la volviera a insertar con su texto, o sea
  -- que el mensaje que alguien borro reapareceria en la bandeja.
  revocado    integer not null default 0,
  editado_at  integer,
  captured_at integer not null,
  primary key (account, chat_jid, stanza_id)
);
-- La bandeja recorre por chat y fecha; la poda por edad de captura. Los dos indices
-- existen para que "ya contestado" NO tenga que ser una subconsulta correlacionada por
-- fila, que es lo que tardaba minutos y dejaba el panel inservible (§11-D1).
create index if not exists ix_mensaje_chat on mensaje (account, chat_jid, ts);
create index if not exists ix_mensaje_mios on mensaje (account, chat_jid, from_me, ts);
create index if not exists ix_mensaje_edad on mensaje (captured_at);

-- El desalojo, escrito para que se pueda MIRAR. "Un almacen sin tope y sin caducidad
-- es un archivo de conversaciones ajenas que nadie borra" (§11-F2), y un desalojo
-- callado es un caso que se pierde y se descubre despues, sin explicacion.
create table if not exists desalojo (
  at          integer not null,
  caducados   integer not null,
  desalojados integer not null,
  archivos    integer not null
);

-- LA BANDEJA DE SALIDA. Lo que bin/wa-send quiere mandar, y como le fue.
--
-- POR QUE VIVE ACA, y no en el canal sidecarRequest/sidecarResult que el panel ya
-- usa para desvincular y reintentar. Ese canal es el storage del plugin, y al
-- storage solo llega el worker, a traves del host de Orca. wa-send no es el worker:
-- es un proceso de Python que el agente corre en una terminal, y que tiene que
-- funcionar con Orca cerrado — la misma razon por la que este almacen no vive en
-- <userData>/plugins-data/ (ver la cabecera de este archivo). Pasar por el worker
-- serian tres saltos —CLI, host, worker, sidecar— y cada uno puede no estar; aca los
-- dos extremos ya abren el mismo archivo.
--
-- Y sobre todo: SQLite da gratis lo unico que este canal no puede fallar. La llave es
-- el req_id de quien pide, asi que un reintento no puede duplicar la fila; la toma es
-- un update ... where estado='pendiente', asi que dos drenados no pueden mandar lo
-- mismo dos veces. Un mensaje repetido a un grupo de un cliente NO se retira.
--
-- El cuerpo es texto que va a salir a una conversacion: se poda con los mismos topes
-- que mensaje, y el archivo entero es 0600.
create table if not exists envio (
  req_id     text primary key,   -- lo elige quien pide; el mismo id entrega UNA vez
  account    text not null,
  chat_jid   text not null,
  chat_name  text not null default '',
  body       text not null,
  -- borrador  espera aprobacion del dueno y el sidecar NO lo toca
  -- pendiente espera al sidecar
  -- enviando  tomado por el sidecar (se queda asi si el sidecar muere a mitad: no se
  --           reintenta solo, porque reintentar a ciegas es el duplicado)
  -- enviado / rechazado son finales
  estado     text not null default 'pendiente',
  motivo     text,               -- por que lo rechazo WhatsApp, sin contenido
  stanza_id  text,               -- el id que contesto WhatsApp, para cruzarlo con mensaje
  created_at integer not null,
  claimed_at integer,
  settled_at integer
);
create index if not exists ix_envio_estado on envio (estado, created_at);

-- La subida desde el almacen de la via vieja, escrita para que se pueda MIRAR. Misma
-- regla que la tabla desalojo, por el mismo motivo: §11-F2 pide que un desalojo se
-- reporte cuando de verdad desaloja algo, y una migracion que se lleva en silencio la
-- cache de cuerpos de una cuenta real es exactamente eso, una vez y sin aviso. La lee
-- bin/wa_store.py, que la publica en "wa-read doctor".
create table if not exists migracion (
  at      integer not null,
  desde   integer not null,
  hasta   integer not null,
  cuerpos integer not null,
  lineas  integer not null
);

-- Cada numero, su linea (T9): lo que colgaba de la cuenta fija 'local' paso al numero
-- de su linea. Se anota para que se pueda MIRAR (la lee "wa-read doctor"), y es la
-- fuente de la que 'wa-scope' saca a que numero mover lo suyo en scope.db.
create table if not exists reclave (
  at       integer not null,
  desde    text not null,
  hacia    text not null,
  chats    integer not null,
  mensajes integer not null,
  envios   integer not null default 0
);
`

// Las cuentas que estreno la via de WhatsApp Web y que hoy no escribe NADIE. El
// registro de alcance ya nombra las dos formas —`bin/wa-scope`, tabla `wa_account`:
// "'local', o 'web:<lid>' cuando enlaza"—, asi que esto no inventa un criterio: usa el
// que el propio registro declara.
const CUENTAS_VIA_MUERTA = "account = 'web' or account like 'web:%'"

/** (usuario, servidor) de un jid, sin dispositivo: `X:3@lid` y `X@lid` son el mismo. */
function usuarioDe (jid) {
  const [usuario = '', servidor = ''] = String(jid || '').split('@')
  return `${usuario.split(':')[0]}@${servidor}`
}

/**
 * Si lo que quedo bajo la cuenta fija `local` se puede pasar SOLO al numero de su
 * linea (T9). Pura: decide con los datos que se le pasan.
 *
 * Falla cerrada. Otros usuarios pueden tener la fila `local` de `linea` pisada por OTRO
 * numero —le paso al dueno—, y ahi re-clavar le daria al numero nuevo lo del viejo. Se
 * mueve solo con evidencia de que la identidad de `local` es la que produjo los datos:
 *   - su telefono es el numero emparejado AHORA, y
 *   - todo mensaje propio con remitente conocido (los de grupo; en un directo el
 *     remitente propio es null y no prueba nada) lo firmo su LID o su telefono.
 * Si no, `bloquear`: no se mueve nada y el dueno decide (`wa-scope reclave --numero`).
 * Sin numero emparejado todavia (emparejando), `esperar`: no se decide a ciegas.
 */
export function decidirReclave ({ lineaLocal, remitentesPropios = [], emparejada }) {
  if (!emparejada) return { accion: 'esperar', hacia: null, motivo: 'sin-emparejar' }
  const hacia = cuentaDeIdentidad(lineaLocal?.pn)
  if (!hacia) return { accion: 'bloquear', hacia: null, motivo: 'sin-telefono' }
  if (hacia !== emparejada) return { accion: 'bloquear', hacia, motivo: 'otro-numero' }
  const propios = new Set([lineaLocal?.lid, lineaLocal?.pn].filter(Boolean).map(usuarioDe))
  const ajeno = remitentesPropios.filter(Boolean).some((j) => !propios.has(usuarioDe(j)))
  if (ajeno) return { accion: 'bloquear', hacia, motivo: 'remitentes-ajenos' }
  return { accion: 'mover', hacia, motivo: 'identidad-comprobada' }
}

/** Las columnas que tiene HOY una tabla. Se pregunta en vez de asumirse porque la
 *  migracion tiene que poder correr sobre dos formas distintas del mismo nombre. */
function columnasDe (con, tabla) {
  return con.prepare(`pragma table_info(${tabla})`).all().map((f) => f.name)
}

function tablasDe (con) {
  return new Set(con.prepare("select name from sqlite_master where type='table'")
    .all().map((f) => f.name))
}

/** Con que version quedo sellado el almacen. Cero es "de antes de que hubiera sello",
 *  que es justo el caso que hay que subir. */
function versionDe (con, tablas) {
  if (!tablas.has('store_meta')) return 0
  try {
    const fila = con.prepare("select value from store_meta where key='schema_version'")
      .get()
    return fila ? Number(fila.value) || 0 : 0
  } catch {
    // Una `store_meta` con otra forma es un almacen que no se sabe leer: se trata como
    // version 0 y la migracion decidira. Adivinar que esta al dia seria lo unico
    // imperdonable aca.
    return 0
  }
}

/**
 * Sube el almacen de la via vieja al esquema de hoy. Devuelve que se llevo, o `null`
 * cuando no habia nada que subir.
 *
 * POR QUE EXISTE. En toda maquina que alguna vez uso la via de WhatsApp Web,
 * `~/.wa-inbox/capture.db` YA existe: `capturado` (su cache de cuerpos, con tope de
 * 20000 y 90 dias) y una `linea` de dos columnas, sin `store_meta`. El lector se niega
 * con `store-schema`, que es la respuesta correcta —contestar filas a medias es peor
 * que no contestar (§11-E5)—, pero sin camino de subida el plugin se instala, empareja
 * y despues contesta `store-schema` a todo. Negarse esta bien; no tener salida, no.
 *
 * QUE PASA CON LOS CUERPOS VIEJOS, y por que. Se BORRAN. La regla del proyecto ya
 * estaba escrita y no se inventa una nueva: apagar la captura borra los cuerpos y
 * conserva la contabilidad, "porque no es contenido de nadie" (§11-F3, `olvidarCuerpos`
 * aca abajo). Un cuerpo de `capturado` es texto de un cliente real guardado por una via
 * que ya no existe, en un esquema que este codigo no sabe leer —otra llave, otras
 * columnas, sin `revocado` ni `chat`—: no se puede servir sin mentir sobre de que
 * conversacion es, y conservarlo sin poder servirlo es exactamente "un archivo de
 * conversaciones ajenas que nadie borra" (§11-F2). Se van, y se DICE cuantos: ese es el
 * resto de la regla.
 *
 * QUE PASA CON LAS LINEAS VIEJAS. Tambien se van, y esto si es una decision. §11-F3
 * conserva el `first_seen` por linea porque apagar la captura no desenlaza la linea: la
 * linea sigue ahi. Aca no. Las cuentas `web` y `web:<lid>` nombran un transporte que se
 * quito entero; nadie las escribe ya —el sidecar escribe `local`— y ninguna
 * autorizacion las referencia (`chat_scope.account` es `local`). Conservarlas no seria
 * conservar contabilidad: `wa_store.abrir()` cuenta las filas de `linea` para decidir
 * si hay linea enlazada, asi que dos filas muertas dejarian el doctor en verde
 * diciendo "2 lineas enlazadas (web, web:...)", el panel dejaria de pedir el QR y
 * `wa-scope pending` soltaria al agente sobre una bandeja que va a estar vacia para
 * siempre. Eso es una bandeja rota que se lee como una tranquila, que es lo unico que
 * §11-E5 prohibe. Una fila de `linea` que NO sea de la via muerta se conserva con su
 * `first_seen`, que es §11-F3 aplicado donde §11-F3 aplica.
 *
 * `chat` y `mensaje` no se tocan porque la via muerta no los tenia: sus dos unicas
 * tablas eran `capturado` y `linea`.
 *
 * QUIEN LA CORRE. El escritor, y solo el. `bin/wa_store.py` abre en `mode=ro` y no
 * puede arreglar nada; si migrara el lector, dos `wa-read` en paralelo migrarian a la
 * vez sobre el mismo archivo.
 */
function migrar (con) {
  const tablas = tablasDe(con)
  // Un archivo recien creado no tiene ninguna tabla: no hay nada de donde subir.
  if (!tablas.size) return null
  const desde = versionDe(con, tablas)
  if (desde >= ESQUEMA_VERSION) return null

  let cuerpos = 0
  if (tablas.has('capturado')) {
    cuerpos = Number(con.prepare('select count(*) c from capturado').get()?.c) || 0
    con.exec('drop table capturado')
  }

  let lineas = 0
  if (tablas.has('linea')) {
    lineas = Number(con.prepare(
      `select count(*) c from linea where ${CUENTAS_VIA_MUERTA}`).get()?.c) || 0
    // La tabla se REHACE en vez de parchearse con `alter table`: la forma vieja tiene
    // dos columnas y la de hoy siete, y copiar solo las que existen en las dos deja el
    // mismo resultado con una sola regla, sirva la forma que sirva el archivo de
    // entrada. `create table if not exists` no habria cambiado nada: la tabla ya
    // existia, y por eso `registrarLinea` reventaba con "no such column: lid".
    const viejas = new Set(columnasDe(con, 'linea'))
    const comunes = COLUMNAS_LINEA.filter((c) => viejas.has(c))
    con.exec(LINEA('linea_migrada'))
    con.exec(`insert into linea_migrada (${comunes.join(',')})
      select ${comunes.join(',')} from linea where not (${CUENTAS_VIA_MUERTA})`)
    con.exec('drop table linea')
    con.exec('alter table linea_migrada rename to linea')
  }

  return { desde, hasta: ESQUEMA_VERSION, cuerpos, lineas }
}

/**
 * Junta los directos guardados CON dispositivo (`X:90@lid`) en el mismo chat sin el
 * (`X@lid`). Devuelve `{ chats, mensajes }` lo que movio, o `null` si no habia nada.
 *
 * POR QUE EXISTE. Hasta T16b el sidecar guardaba el jid tal como llegaba, y WhatsApp
 * manda el mismo directo con y sin sufijo de dispositivo segun el evento: en una linea
 * enlazada la lista traia a la misma persona dos veces, la de siempre con su nombre y
 * la `:90` sin nombre. Arreglar la ingesta (`jidDeChat`) evita filas nuevas, pero las
 * que ya estaban se quedarian duplicando para siempre.
 *
 * QUE CONSERVA. La fila SIN dispositivo manda —es la que tiene el nombre, y la que el
 * dueno ya autorizo—: se queda con su no leido, y de la otra solo toma el nombre si ella
 * no tenia, la ultima actividad mas reciente y la primera vez que se la vio mas vieja.
 * Un chat que solo existia con dispositivo se RENOMBRA, no se pierde. Los mensajes
 * pasan al jid limpio; si la llave `(cuenta, chat_jid, stanza_id)` ya existe ahi gana el
 * que ya estaba, y el repetido NO se borra: queda bajo el jid viejo, que sin fila de
 * `chat` ya no sale en ninguna lista. Lo unico que se borra es la fila de chat duplicada.
 * Los grupos (`@g.us`) no se tocan, y cada cuenta se junta en la suya.
 *
 * IDEMPOTENTE: se guia por las filas de `chat` con dispositivo, y despues de correr no
 * queda ninguna. Corre dentro de la misma transaccion que el sello de esquema.
 */
function unirDispositivos (con) {
  const filas = con.prepare(
    "select account, chat_jid from chat where chat_jid like '%:%@%'").all()
  let chats = 0
  let mensajes = 0
  for (const { account, chat_jid: jid } of filas) {
    const limpio = jidDeChat(jid)
    if (limpio === jid) continue
    const existe = con.prepare('select 1 from chat where account=? and chat_jid=?')
      .get(account, limpio)
    if (existe) {
      con.prepare(`update chat set
          chat_name = case when chat_name = '' or chat_name = chat_jid
            then (select chat_name from chat where account=? and chat_jid=?)
            else chat_name end,
          last_ts = nullif(max(coalesce(last_ts, 0), coalesce(
            (select last_ts from chat where account=? and chat_jid=?), 0)), 0),
          first_seen = min(first_seen,
            (select first_seen from chat where account=? and chat_jid=?))
        where account=? and chat_jid=?`)
        .run(account, jid, account, jid, account, jid, account, limpio)
      con.prepare('delete from chat where account=? and chat_jid=?').run(account, jid)
    } else {
      con.prepare('update chat set chat_jid=? where account=? and chat_jid=?')
        .run(limpio, account, jid)
    }
    mensajes += Number(con.prepare(
      'update or ignore mensaje set chat_jid=? where account=? and chat_jid=?')
      .run(limpio, account, jid).changes) || 0
    chats += 1
  }
  return chats ? { chats, mensajes } : null
}

/** El directorio de estado de las herramientas. La MISMA tabla que `scope_db_path()` en
 *  `bin/wa-scope:42-46` y `bin/wa_settings.py:320-323`. Que sean dos implementaciones es
 *  un riesgo real —discrepar sobre esta ruta es escribir en una base que nadie lee— y
 *  por eso `scripts/check-clis` compara las dos contra el mismo entorno. */
export function rutaInbox (env = process.env) {
  if (env.WA_INBOX_DIR) return env.WA_INBOX_DIR
  if (process.platform === 'win32') {
    return join(env.APPDATA || join(env.USERPROFILE || '', 'AppData', 'Roaming'), 'wa-inbox')
  }
  return join(env.HOME || '', '.wa-inbox')
}

export function rutaAlmacen (env = process.env) {
  return join(rutaInbox(env), 'capture.db')
}

export function rutaMedia (env = process.env) {
  return join(rutaInbox(env), 'media')
}

/** Los bytes de un adjunto son texto ajeno igual que el cuerpo: 0600, y el directorio
 *  0700. En un equipo compartido el umask por defecto los deja legibles para todos
 *  (§11-F1). `mkdirSync` con `mode` no ajusta un directorio que ya existia, por eso se
 *  reafirma. */
export function asegurarDirectorio (ruta) {
  mkdirSync(ruta, { recursive: true, mode: 0o700 })
  try {
    chmodSync(ruta, 0o700)
  } catch {
    // Un directorio de otro dueno no se puede chmodear y tampoco hace falta: lo que
    // importa es que el nuestro no quede abierto.
  }
}

/** Abre —y crea, si hace falta— el almacen. Devuelve el objeto con el que escribe el
 *  sidecar: es el UNICO escritor. */
export function abrirAlmacen (ruta = rutaAlmacen()) {
  asegurarDirectorio(join(ruta, '..'))
  const con = new DatabaseSync(ruta)
  // WAL: el escritor es un proceso y los lectores son otros (`wa-read`, corrido por el
  // worker y por `wa-scope` a la vez). Sin esto un `select` largo bloquea la ingesta.
  con.exec('pragma journal_mode=wal')
  con.exec('pragma busy_timeout=5000')

  // TODO junto o NADA: la subida de esquema, las tablas y el sello de version van en
  // UNA transaccion. No es prolijidad. Hasta aca eran tres pasos sueltos que se
  // confirmaban por separado, y sobre el almacen de la via vieja el resultado era el
  // peor posible: la tabla vieja sobrevivia a `create table if not exists`, el sello
  // decia "version de hoy" igual, y el almacen quedaba diciendo que estaba al dia con
  // la forma de ayer adentro. Un corte de luz a mitad tiene que dejar el archivo como
  // estaba —y el lector negandose con `store-schema`, cerrado— y no contestando datos
  // incompletos (§11-E5).
  let migracion = null
  let dispositivosUnidos = null
  con.exec('begin immediate')
  try {
    migracion = migrar(con)
    con.exec(ESQUEMA)
    dispositivosUnidos = unirDispositivos(con)
    if (dispositivosUnidos) {
      // Aparte de `migracion`, a proposito: esa tabla es la de la subida de esquema y
      // `wa-read doctor` arma su renglon con la ULTIMA fila, que hablaria de cuerpos y
      // lineas de una via que esto no toca. Solo numeros, como `reclave_pendiente`.
      con.prepare('insert into store_meta (key,value) values (?,?) ' +
        'on conflict(key) do update set value=excluded.value')
        .run('jid_dispositivo_unido', JSON.stringify({ at: Math.floor(Date.now() / 1000),
          chats: dispositivosUnidos.chats, mensajes: dispositivosUnidos.mensajes }))
    }
    if (migracion && (migracion.cuerpos || migracion.lineas)) {
      // Se anota solo cuando de verdad se llevo algo, la misma regla que `desalojo`:
      // §11-F2 pide reportar el desalojo cuando desaloja, no anunciar cada arranque.
      con.prepare(
        'insert into migracion (at, desde, hasta, cuerpos, lineas) values (?,?,?,?,?)')
        .run(Math.floor(Date.now() / 1000), migracion.desde, migracion.hasta,
          migracion.cuerpos, migracion.lineas)
    }
    con.prepare('insert into store_meta (key,value) values (?,?) ' +
      'on conflict(key) do update set value=excluded.value')
      .run('schema_version', String(ESQUEMA_VERSION))
    // El MISMO numero, tambien en la cabecera del archivo. `store_meta` es el sello que
    // lee `bin/wa_store.py`, pero `pragma user_version` es lo que contesta un `sqlite3`
    // corrido a mano en una terminal — que es justo como se diagnostico este bloqueo, y
    // el unico sello que se podia mirar sin el plugin decia 0 sobre un archivo lleno.
    con.exec(`pragma user_version = ${ESQUEMA_VERSION}`)
    con.exec('commit')
  } catch (error) {
    try {
      con.exec('rollback')
    } catch { /* si ya no hay transaccion abierta, no hay nada que deshacer */ }
    con.close()
    throw error
  }

  // 0600 se fuerza DESPUES de crear: el archivo nace con el umask del proceso.
  for (const sufijo of ['', '-wal', '-shm']) {
    try {
      if (existsSync(ruta + sufijo)) chmodSync(ruta + sufijo, 0o600)
    } catch { /* ver asegurarDirectorio */ }
  }
  return new Almacen(con, ruta, migracion, dispositivosUnidos)
}

class Almacen {
  constructor (con, ruta, migracion = null, dispositivosUnidos = null) {
    this.con = con
    this.ruta = ruta
    /** Que se llevo la subida de esquema al abrir, o `null` si no hubo ninguna. Lo
     *  publica el sidecar en cuanto abre: el renglon del `doctor` lo va a ver quien
     *  entre al panel, y esto lo ve quien mire el log el dia que pregunte adonde se
     *  fueron los mensajes viejos. */
    this.migracion = migracion
    /** Cuantos directos con dispositivo (`:N`) junto al abrir y cuantos mensajes movio,
     *  o `null` si no habia ninguno (T16b). */
    this.dispositivosUnidos = dispositivosUnidos
  }

  /** Una linea enlazada. Es la contabilidad que distingue "todavia no hay de donde
   *  leer" de "no hubo mensajes": sin una fila aca, `wa-read` se NIEGA con
   *  `no-transport`, y con ella contesta una lista vacia (§11-E5). */
  registrarLinea ({ cuenta, lid = null, pn = null, nombre = null, grupos = null,
    ahora = Date.now() }) {
    const segundos = Math.floor(ahora / 1000)
    // TODOS los campos con `coalesce`, `groups_n` incluido. Esta funcion la llaman dos
    // sitios con mitades distintas -la identidad por un lado, el conteo de grupos por
    // otro- asi que el que no trae un dato NO puede borrar el que ya estaba. `groups_n`
    // era el unico que se pisaba a secas: funcionaba de casualidad porque el conteo
    // llegaba siempre de ultimo, y con la identidad refrescandose en cada
    // `creds.update` habria dejado el conteo en 0 a la primera.
    this.con.prepare(`insert into linea (account, first_seen, lid, pn, name, groups_n, updated_at)
      values (?,?,?,?,?,coalesce(?,0),?)
      on conflict(account) do update set
        lid=coalesce(excluded.lid, linea.lid),
        pn=coalesce(excluded.pn, linea.pn),
        name=coalesce(excluded.name, linea.name),
        groups_n=coalesce(?, linea.groups_n),
        updated_at=excluded.updated_at`)
      .run(cuenta, segundos, lid, pn, nombre, grupos, segundos, grupos)
  }

  /** La linea que esta vinculada AHORA (`store_meta.linea_activa`), o `null` si este
   *  almacen nunca vio una. Los lectores (`bin/wa_store.py`) miran solo esta: las demas
   *  lineas siguen guardadas, intactas, para el dia que ese numero se vuelva a
   *  vincular. */
  lineaActiva () {
    const fila = this.con.prepare(
      "select value from store_meta where key='linea_activa'").get()
    return fila ? fila.value : null
  }

  /**
   * Pasa lo que colgaba de la cuenta fija `local` al numero de SU linea (T9).
   *
   * Antes de T9 todo se guardaba bajo `local`, fuera cual fuera el telefono. La fila
   * `local` de `linea` dice cual era (`pn`), y ese es el unico dato que permite
   * atribuirlo: sin telefono no se inventa un numero y no se toca nada.
   *
   * EXPLICITA y no automatica: no la llama `abrirAlmacen`. En una maquina donde la fila
   * `local` ya se piso con OTRO numero (el caso visto en vivo el 2026-10-01), correrla
   * le daria al numero nuevo las conversaciones del viejo, que es exactamente la fuga
   * que T9 cierra. Se conecta al arranque cuando no quede ninguna maquina asi.
   *
   * Atomica: todo o nada, en una transaccion. Si el numero ya tenia filas propias (el
   * sidecar nuevo ya anoto el mismo grupo), la suya manda y la copia `local` se
   * descarta: es la misma conversacion o el mismo mensaje, no contenido distinto.
   * Devuelve que movio, o `null` si no habia nada que mover.
   */
  reclavarLocal ({ hacia: elegida = null, ahora = Date.now() } = {}) {
    const fila = this.con.prepare("select pn from linea where account='local'").get()
    // `elegida` es la decision del dueno (`wa-scope reclave --numero`): manda sobre lo
    // que diga la fila `local`, que puede estar pisada por otro numero.
    const hacia = elegida || cuentaDeIdentidad(fila?.pn)
    if (!hacia) return null
    const hayAlgo = ['chat', 'mensaje', 'envio', 'linea'].some((t) => Number(this.con
      .prepare(`select count(*) c from ${t} where account='local'`).get().c) > 0)
    if (!hayAlgo) return null
    const contar = (tabla) => Number(this.con.prepare(
      `select count(*) c from ${tabla} where account='local'`).get().c) || 0
    this.con.exec('begin immediate')
    try {
      const chats = contar('chat')
      const mensajes = contar('mensaje')
      const envios = contar('envio')
      for (const tabla of ['chat', 'mensaje']) {
        this.con.prepare(`update or ignore ${tabla} set account=? where account='local'`)
          .run(hacia)
        // Lo que no se pudo mover ya existia en el numero: es un duplicado.
        this.con.exec(`delete from ${tabla} where account='local'`)
      }
      this.con.prepare("update envio set account=? where account='local'").run(hacia)
      const yaEstaba = this.con.prepare('select 1 from linea where account=?').get(hacia)
      if (yaEstaba) {
        // El numero ya tenia su fila: se queda con lo que ella no sabia, y con el
        // `first_seen` mas viejo, que es desde cuando esta enlazada de verdad.
        this.con.prepare(`update linea set
            first_seen=min(first_seen, (select first_seen from linea where account='local')),
            lid=coalesce(lid, (select lid from linea where account='local')),
            name=coalesce(name, (select name from linea where account='local'))
          where account=?`).run(hacia)
        this.con.exec("delete from linea where account='local'")
      } else {
        this.con.prepare("update linea set account=? where account='local'").run(hacia)
      }
      this.con.prepare('insert into reclave (at, desde, hacia, chats, mensajes, envios) ' +
        "values (?, 'local', ?, ?, ?, ?)")
        .run(Math.floor(ahora / 1000), hacia, chats, mensajes, envios)
      this.con.exec('commit')
      return { desde: 'local', hacia, chats, mensajes, envios }
    } catch (error) {
      try { this.con.exec('rollback') } catch { /* nada abierto */ }
      throw error
    }
  }

  /**
   * Lo que el sidecar corre al saber que numero esta emparejado: decide con
   * `decidirReclave` si lo de `local` pasa solo a su numero, y si no, lo deja como
   * esta y anota que hace falta una decision (`store_meta.reclave_pendiente`, que
   * muestra `wa-read doctor` con el comando exacto). `decidida` es la decision del
   * dueno, que manda sobre la evidencia.
   */
  resolverLocal ({ emparejada = null, decidida = null, ahora = Date.now() } = {}) {
    const contar = (sql) => Number(this.con.prepare(sql).get().c) || 0
    const chats = contar("select count(*) c from chat where account='local'")
    const mensajes = contar("select count(*) c from mensaje where account='local'")
    const hayLinea = contar("select count(*) c from linea where account='local'") > 0
    const borrarPendiente = () =>
      this.con.prepare("delete from store_meta where key='reclave_pendiente'").run()
    if (!chats && !mensajes && !hayLinea) {
      borrarPendiente()
      return { accion: 'nada' }
    }
    if (decidida && cuentaDeIdentidad(String(decidida).replace(/^pn:/, ''))) {
      const r = this.reclavarLocal({ hacia: decidida, ahora })
      borrarPendiente()
      return { accion: 'movida', hacia: decidida, motivo: 'decidida', ...r }
    }
    const lineaLocal = this.con.prepare("select lid, pn from linea where account='local'")
      .get() || {}
    const remitentesPropios = this.con.prepare(
      "select distinct sender_jid j from mensaje where account='local' and from_me=1 " +
      'and sender_jid is not null').all().map((f) => f.j)
    const d = decidirReclave({ lineaLocal, remitentesPropios, emparejada })
    if (d.accion === 'mover') {
      const r = this.reclavarLocal({ hacia: d.hacia, ahora })
      borrarPendiente()
      return { accion: 'movida', hacia: d.hacia, motivo: d.motivo, ...r }
    }
    if (d.accion === 'bloquear') {
      // Solo numeros y el motivo: nada de quien es ni de que se hablo.
      this.con.prepare('insert into store_meta (key,value) values (?,?) ' +
        'on conflict(key) do update set value=excluded.value')
        .run('reclave_pendiente', JSON.stringify({ motivo: d.motivo, chats, mensajes,
          at: Math.floor(ahora / 1000) }))
      return { accion: 'bloqueada', motivo: d.motivo, chats, mensajes }
    }
    return { accion: d.accion, motivo: d.motivo }
  }

  /** Deja `cuenta` como linea activa. NO copia nada ni toca las filas de otra cuenta:
   *  cambiar de numero es cambiar de cajon, no mudar el contenido. Devuelve si hubo
   *  cambio y cual era la anterior, para que el sidecar lo pueda decir. */
  activarLinea (cuenta) {
    const antes = this.lineaActiva()
    // La principal entra al conjunto de activas (`lineasActivas`) en el MISMO lugar que la
    // de antes: es la misma linea del plugin con otro numero, no una mas.
    this.anotarActivas(reemplazada(this.lineasActivas(), antes, cuenta))
    if (antes === cuenta) return { cambio: false, antes }
    this.anotarMeta('linea_activa', cuenta)
    return { cambio: true, antes }
  }

  /** Las lineas vinculadas AHORA, en orden: la principal y las que se le sumaron (varias
   *  lineas a la vez). Un almacen de antes de esto solo anoto `linea_activa`, y entonces
   *  el conjunto es esa linea; uno que nunca vio una, ninguna. */
  lineasActivas () {
    const fila = this.con.prepare(
      "select value from store_meta where key='lineas_activas'").get()
    if (!fila) {
      const principal = this.lineaActiva()
      return principal ? [principal] : []
    }
    try {
      const lista = JSON.parse(fila.value)
      return Array.isArray(lista) ? lista.filter((c) => typeof c === 'string' && c) : []
    } catch {
      return []
    }
  }

  /** Suma una linea que NO es la principal: entra al conjunto y no toca `linea_activa`,
   *  que es de la principal. `antes` es el numero que esa misma linea tenia, si se
   *  re-vinculo con otro: ese sale, porque ya no esta vinculado. */
  sumarLinea (cuenta, { antes = null } = {}) {
    const actuales = this.lineasActivas()
    const nueva = !actuales.includes(cuenta)
    this.anotarActivas(reemplazada(actuales, antes, cuenta))
    return { nueva }
  }

  /** Saca una linea del conjunto al desvincularla. Si era la principal, la principal
   *  pasa a la primera que queda; si no queda ninguna, `linea_activa` se conserva: un
   *  lector sin linea anotada lee TODAS, y eso es mezclar lo de un numero con otro. */
  retirarLinea (cuenta) {
    const actuales = this.lineasActivas()
    if (!actuales.includes(cuenta)) return { retirada: false }
    const quedan = actuales.filter((c) => c !== cuenta)
    this.anotarActivas(quedan)
    if (this.lineaActiva() === cuenta && quedan.length) this.anotarMeta('linea_activa', quedan[0])
    return { retirada: true }
  }

  anotarActivas (lista) {
    this.anotarMeta('lineas_activas', JSON.stringify(lista))
  }

  anotarMeta (llave, valor) {
    this.con.prepare('insert into store_meta (key,value) values (?,?) ' +
      'on conflict(key) do update set value=excluded.value').run(llave, valor)
  }

  /**
   * Marca como mencion los mensajes guardados que nombran al dueno, ahora que se sabe
   * cual es su LID.
   *
   * Existe por una ventana real y no hipotetica: entre que se vincula la linea y que
   * Baileys entrega el LID por `creds.update` pasan segundos, y los mensajes que
   * llegan en medio se ingieren con `menciona_me = 0` porque en ese momento nadie sabe
   * que ese numero es el del dueno. Esos mensajes no vuelven a pasar por la ingesta, y
   * `wa-read inbox` cruza contra esa columna: sin reparar, no salen NUNCA. Medido en
   * una instalacion viva, fueron los dos primeros mensajes tras escanear el QR.
   *
   * Se mira el CUERPO y no `contextInfo`, que no se guarda: WhatsApp escribe la mencion
   * en el texto como `@<usuario del lid>`, que es exactamente lo que se busca. Por eso
   * el patron lleva el numero completo y un limite a la derecha — sin el, un LID que
   * sea prefijo de otro marcaria mensajes que nombran a otra persona.
   */
  repararMenciones ({ cuenta, lid }) {
    const usuario = String(lid || '').split('@')[0].split(':')[0]
    if (!/^\d+$/.test(usuario)) return 0
    const r = this.con.prepare(
      `update mensaje set menciona_me = 1
       where account = ? and menciona_me = 0 and from_me = 0
         and body like ?
         and substr(body, instr(body, ?) + ?, 1) not glob '[0-9]'`)
      .run(cuenta, `%@${usuario}%`, `@${usuario}`, usuario.length + 1)
    return r.changes || 0
  }

  /**
   * Le pone nombre a una conversacion que ya existe, si todavia no tiene uno de verdad.
   *
   * Devuelve `true` solo si de verdad cambio algo, para poder CONTAR cuantas se
   * nombraron — "llego la libreta" y "la libreta sirvio de algo" son dos cosas
   * distintas, y confundirlas es lo que deja un defecto en silencio.
   *
   * Un chat cuyo nombre es su propio jid NO esta nombrado: es el marcador de que nadie
   * supo como se llamaba. Por eso cuenta como vacio y la libreta puede pisarlo; un
   * nombre de verdad, en cambio, no se degrada nunca.
   */
  nombrarChat ({ cuenta, chatJid, nombre }) {
    const limpio = typeof nombre === 'string' ? nombre.trim() : ''
    if (!limpio || limpio === chatJid) return false
    const r = this.con.prepare(
      `update chat set chat_name = ?
       where account = ? and chat_jid = ?
         and (chat_name is null or chat_name = '' or chat_name = chat_jid)`)
      .run(limpio, cuenta, chatJid)
    return (r.changes || 0) > 0
  }

  /** El telefono de un LID. Contabilidad, como el nombre: se anota aunque el chat este
   *  en `off` o todavia no exista. Devuelve si cambio algo; lo que no es un LID y un
   *  telefono, en ese orden, no se anota. */
  anotarTelefono ({ cuenta, lid, pn, ahora = Date.now() }) {
    const par = parLidTelefono(lid, pn)
    if (!cuenta || !par) return false
    const r = this.con.prepare(`insert into lid_telefono (account, lid, pn, updated_at)
      values (?,?,?,?)
      on conflict(account, lid) do update set pn=excluded.pn, updated_at=excluded.updated_at
        where lid_telefono.pn <> excluded.pn`)
      .run(cuenta, par.lid, par.pn, Math.floor(ahora / 1000))
    return (r.changes || 0) > 0
  }

  /** Corre `fn` en UNA transaccion (un savepoint, que tambien anida): el fetch de los
   *  grupos trae cientos de una vez, y una confirmacion por grupo es un fsync por grupo
   *  con la ingesta esperando. Si `fn` lanza, no queda nada a medias. */
  lote (fn) {
    this.con.exec('savepoint lote')
    try {
      const r = fn()
      this.con.exec('release lote')
      return r
    } catch (error) {
      try { this.con.exec('rollback to lote'); this.con.exec('release lote') } catch {
        /* nada abierto */
      }
      throw error
    }
  }

  /** La lista ENTERA de un grupo, de un fetch: queda exactamente esa, y el que ya no esta
   *  se va. `miembros` es `[{ jid, admin }]` (ver `miembrosDeGrupo`). Atomica: una lista a
   *  medias es un grupo con gente que no esta o sin gente que si. Devuelve cuantos quedaron. */
  reemplazarMiembros ({ cuenta, chatJid, miembros, ahora = Date.now() }) {
    if (!cuenta || !chatJid || !Array.isArray(miembros)) return 0
    const segundos = Math.floor(ahora / 1000)
    return this.lote(() => {
      this.con.prepare('delete from grupo_miembro where account=? and chat_jid=?')
        .run(cuenta, chatJid)
      const poner = this.con.prepare('insert or replace into grupo_miembro ' +
        '(account, chat_jid, member_jid, admin, updated_at) values (?,?,?,?,?)')
      for (const m of miembros) poner.run(cuenta, chatJid, m.jid, m.admin ? 1 : 0, segundos)
      return miembros.length
    })
  }

  /** Un cambio de la lista (`cambioDeMiembros`): add suma sin admin, remove saca, promote y
   *  demote ponen o quitan el admin de WhatsApp (sumando al que no estaba: el aviso dice que
   *  esta). Si sacaron a la linea misma, la lista del grupo entera se va: ya no se puede
   *  mantener. Devuelve cuantas filas cambio. */
  cambiarMiembros ({ cuenta, chatJid, accion, miembros = [], salioLaLinea = false,
    ahora = Date.now() }) {
    if (!cuenta || !chatJid) return 0
    if (salioLaLinea) {
      return Number(this.con.prepare(
        'delete from grupo_miembro where account=? and chat_jid=?')
        .run(cuenta, chatJid).changes) || 0
    }
    const segundos = Math.floor(ahora / 1000)
    const sql = {
      remove: 'delete from grupo_miembro where account=? and chat_jid=? and member_jid=?',
      add: 'insert into grupo_miembro (account, chat_jid, member_jid, admin, updated_at) ' +
        'values (?,?,?,0,?) on conflict(account, chat_jid, member_jid) do update set ' +
        'admin=0, updated_at=excluded.updated_at',
      promote: 'insert into grupo_miembro (account, chat_jid, member_jid, admin, updated_at) ' +
        'values (?,?,?,1,?) on conflict(account, chat_jid, member_jid) do update set ' +
        'admin=1, updated_at=excluded.updated_at',
      demote: 'insert into grupo_miembro (account, chat_jid, member_jid, admin, updated_at) ' +
        'values (?,?,?,0,?) on conflict(account, chat_jid, member_jid) do update set ' +
        'admin=0, updated_at=excluded.updated_at'
    }[accion]
    if (!sql) return 0
    const paso = this.con.prepare(sql)
    let cambios = 0
    for (const jid of miembros) {
      const args = accion === 'remove' ? [cuenta, chatJid, jid] : [cuenta, chatJid, jid, segundos]
      cambios += Number(paso.run(...args).changes) || 0
    }
    return cambios
  }

  /** Que esta conversacion existe. Contabilidad, no contenido: se anota aunque el chat
   *  este en `off`. */
  anotarChat ({ cuenta, chatJid, nombre = '', esGrupo = 0, ts = null, unread = null,
    ahora = Date.now() }) {
    const segundos = Math.floor(ahora / 1000)
    this.con.prepare(`insert into chat (account, chat_jid, chat_name, is_group, unread, last_ts, first_seen)
      values (?,?,?,?,?,?,?)
      on conflict(account, chat_jid) do update set
        -- Un nombre vacio no es una eleccion: no puede borrar el que ya se sabia.
        chat_name=case when excluded.chat_name <> '' then excluded.chat_name else chat.chat_name end,
        is_group=excluded.is_group,
        unread=case when excluded.unread is null then chat.unread else excluded.unread end,
        last_ts=max(coalesce(chat.last_ts, 0), coalesce(excluded.last_ts, 0))`)
      .run(cuenta, chatJid, nombre || '', esGrupo ? 1 : 0, unread === null ? 0 : unread,
        ts, segundos)
  }

  /** El cuerpo de un mensaje de una conversacion AUTORIZADA. */
  guardarMensaje (fila, { mediaPath = null, ahora = Date.now() } = {}) {
    this.con.prepare(`insert into mensaje
      (account, chat_jid, stanza_id, ts, from_me, sender_jid, sender_name, body,
       media_type, media_path, media_bytes, menciona_me, cita_me, revocado, editado_at,
       captured_at)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,0,null,?)
      on conflict(account, chat_jid, stanza_id) do update set
        ts=excluded.ts, sender_jid=excluded.sender_jid, sender_name=excluded.sender_name,
        body=excluded.body, media_type=excluded.media_type,
        media_path=coalesce(excluded.media_path, mensaje.media_path),
        media_bytes=excluded.media_bytes, menciona_me=excluded.menciona_me,
        cita_me=excluded.cita_me
      -- Una lapida no se resucita: lo que alguien borro no puede volver porque el
      -- mensaje llegue otra vez por una re-sincronizacion.
      where mensaje.revocado = 0`)
      .run(fila.cuenta, fila.chatJid, fila.stanzaId, fila.ts, fila.fromMe,
        fila.senderJid, fila.senderName, fila.body || '', fila.mediaTipo, mediaPath,
        fila.mediaBytes, fila.mencionaMe, fila.citaMe, Math.floor(ahora / 1000))
  }

  /** Un borrado o una edicion (§11-B4). */
  aplicarActualizacion (cuenta, cambio) {
    if (cambio.revocado) {
      // El archivo del adjunto se va con el cuerpo: dejarlo en disco seria conservar
      // exactamente lo que el remitente pidio borrar.
      const fila = this.con.prepare(
        'select media_path from mensaje where account=? and chat_jid=? and stanza_id=?')
        .get(cuenta, cambio.chatJid, cambio.stanzaId)
      if (fila?.media_path) borrarArchivo(fila.media_path)
      this.con.prepare(`update mensaje set revocado=1, body='', media_type=null,
        media_path=null, media_bytes=null where account=? and chat_jid=? and stanza_id=?`)
        .run(cuenta, cambio.chatJid, cambio.stanzaId)
      return
    }
    this.con.prepare(`update mensaje set body=?, editado_at=?
      where account=? and chat_jid=? and stanza_id=? and revocado=0`)
      .run(cambio.body || '', cambio.ts, cuenta, cambio.chatJid, cambio.stanzaId)
  }

  /** Apagar la captura, o un chat: se van los CUERPOS y queda la contabilidad
   *  (§11-F3). "No es contenido de nadie", y perderla haria que la bandeja del dia
   *  siguiente volviera a arrastrar menciones viejas sin texto posible. */
  olvidarCuerpos ({ cuenta, chatJid = null }) {
    const donde = chatJid ? 'account=? and chat_jid=?' : 'account=?'
    const args = chatJid ? [cuenta, chatJid] : [cuenta]
    const rutas = this.con.prepare(
      `select media_path from mensaje where ${donde} and media_path is not null`).all(...args)
    for (const r of rutas) borrarArchivo(r.media_path)
    this.con.prepare(`delete from mensaje where ${donde}`).run(...args)
    return { archivos: rutas.length }
  }

  /** La senal de vida del sidecar, para quien no puede verlo correr.
   *
   *  `bin/wa-send` es un proceso corto y ajeno: sin esto, un sidecar apagado y un
   *  sidecar ocupado se ven igual —una fila que no avanza— y la CLI solo podria
   *  contestar "se vencio el plazo" a las dos cosas. Son acciones DISTINTAS del dueno
   *  (arrancar Orca, o mirar por que WhatsApp rechazo), asi que son codigos distintos
   *  (§11-E2), y esto es lo que los separa. Un solo `update`, sin contenido. */
  latir (ahora = Date.now()) {
    this.con.prepare('insert into store_meta (key,value) values (?,?) ' +
      'on conflict(key) do update set value=excluded.value')
      .run('sidecar_beat', String(Math.floor(ahora / 1000)))
  }

  /** Una peticion de envio. La usa el sidecar solo en pruebas —quien encola de verdad
   *  es `bin/wa-send`— pero vive aca, junto al esquema, para que la forma de la fila
   *  tenga una sola definicion. `do nothing` y no `do update`: el mismo `req_id` es el
   *  MISMO pedido, y pisarlo con otro cuerpo seria entregar algo que nadie pidio. */
  encolarEnvio ({ reqId, cuenta, chatJid, chatNombre = '', cuerpo, estado = 'pendiente',
    ahora = Date.now() }) {
    this.con.prepare(`insert into envio
      (req_id, account, chat_jid, chat_name, body, estado, created_at)
      values (?,?,?,?,?,?,?) on conflict(req_id) do nothing`)
      .run(reqId, cuenta, chatJid, chatNombre || '', cuerpo, estado,
        Math.floor(ahora / 1000))
    return this.verEnvio(reqId)
  }

  verEnvio (reqId) {
    return this.con.prepare('select * from envio where req_id=?').get(reqId) || null
  }

  /**
   * Toma la proxima peticion pendiente, o `null`.
   *
   * La toma y el cambio de estado son UN paso, no dos: `update ... where
   * estado='pendiente'` solo cambia filas si nadie se adelanto, y `changes()` dice si
   * esta es nuestra. Leer primero y marcar despues es exactamente la carrera que
   * entrega el mismo mensaje dos veces — y un mensaje repetido a un grupo de un cliente
   * no se retira.
   *
   * Los `borrador` NO entran: esperan la aprobacion del dueno, no un turno.
   */
  tomarEnvio (ahora = Date.now(), cuenta) {
    const segundos = Math.floor(ahora / 1000)
    for (;;) {
      // Con `cuenta`, solo lo de esa linea (ver `atenderSalida`).
      const fila = cuenta === undefined
        ? this.con.prepare(
          "select * from envio where estado='pendiente' order by created_at, rowid limit 1")
          .get()
        : this.con.prepare("select * from envio where estado='pendiente' and account=? " +
          'order by created_at, rowid limit 1').get(cuenta)
      if (!fila) return null
      const r = this.con.prepare(
        "update envio set estado='enviando', claimed_at=? " +
        "where req_id=? and estado='pendiente'").run(segundos, fila.req_id)
      if (Number(r.changes) === 1) return { ...fila, estado: 'enviando' }
      // Otro se la llevo entre el select y el update: se mira la siguiente. No se
      // reintenta la misma, que es como se vuelve a mandar lo ya mandado.
    }
  }

  /** El veredicto, que es lo que la CLI esta esperando. Solo cierra lo que esta en
   *  vuelo: una fila ya cerrada no se reabre, porque su dueno ya se fue con la
   *  respuesta. */
  resolverEnvio (reqId, { estado, motivo = null, stanzaId = null, ahora = Date.now() }) {
    this.con.prepare(`update envio set estado=?, motivo=?, stanza_id=?, settled_at=?
      where req_id=? and estado in ('pendiente','enviando')`)
      .run(estado, motivo, stanzaId, Math.floor(ahora / 1000), reqId)
    return this.verEnvio(reqId)
  }

  /**
   * El tope y la caducidad, con el desalojo anotado para que se pueda mirar.
   *
   * §11-F2: "un almacen sin tope y sin caducidad es un archivo de conversaciones ajenas
   * que nadie borra". Los dos numeros son AJUSTES (`capture_max`, `capture_days`) y no
   * constantes: son retencion de texto ajeno, no rendimiento, y bajarlos tiene que
   * poder hacerse desde el panel sin tocar codigo.
   */
  podar ({ max, dias, ahora = Date.now() }) {
    const segundos = Math.floor(ahora / 1000)
    const tope = Math.max(1, Number(max) || 1)
    const edad = Math.max(1, Number(dias) || 1)
    const corte = segundos - edad * 86400

    const viejos = this.con.prepare(
      'select rowid, media_path from mensaje where captured_at < ?').all(corte)
    this.con.prepare('delete from mensaje where captured_at < ?').run(corte)

    const sobrantes = this.con.prepare(
      `select rowid, media_path from mensaje where rowid not in
       (select rowid from mensaje order by captured_at desc, rowid desc limit ?)`).all(tope)
    this.con.prepare(
      `delete from mensaje where rowid not in
       (select rowid from mensaje order by captured_at desc, rowid desc limit ?)`).run(tope)

    let archivos = 0
    for (const fila of [...viejos, ...sobrantes]) {
      if (fila.media_path && borrarArchivo(fila.media_path)) archivos += 1
    }
    // La bandeja de salida guarda texto que iba a salir a una conversacion: es
    // contenido y caduca con la MISMA regla, no con una propia. Lo que sigue esperando
    // —borrador sin aprobar, pendiente sin sidecar— no se toca: borrarlo seria perder
    // en silencio algo que su dueno todavia no vio.
    const envios = this.con.prepare(
      "delete from envio where settled_at is not null and settled_at < ?").run(corte)

    const resultado = { caducados: viejos.length, desalojados: sobrantes.length, archivos,
      enviosPodados: Number(envios.changes) || 0 }
    if (resultado.caducados || resultado.desalojados) {
      this.con.prepare(
        'insert into desalojo (at, caducados, desalojados, archivos) values (?,?,?,?)')
        .run(segundos, resultado.caducados, resultado.desalojados, archivos)
      // El historial de desalojos tampoco crece para siempre.
      this.con.exec('delete from desalojo where rowid not in ' +
        '(select rowid from desalojo order by at desc limit 50)')
    }
    return resultado
  }

  cerrar () {
    try {
      this.con.close()
    } catch { /* cerrar dos veces no es un error que nadie pueda arreglar */ }
  }
}

/** La lista de lineas activas con `cuenta` en el lugar de `antes` (o al final si `antes`
 *  no estaba), sin repetidos. Pura: el orden es el de la vinculacion, y la primera es la
 *  principal. */
function reemplazada (lista, antes, cuenta) {
  const salida = []
  let puesta = false
  for (const c of lista) {
    if (c === antes || c === cuenta) {
      if (!puesta) { salida.push(cuenta); puesta = true }
      continue
    }
    salida.push(c)
  }
  if (!puesta) salida.push(cuenta)
  return salida
}

function borrarArchivo (ruta) {
  try {
    if (!ruta || !existsSync(ruta)) return false
    rmSync(ruta, { force: true })
    return true
  } catch {
    // Un archivo que no se puede borrar no puede tumbar la ingesta entera: la fila ya
    // se fue, y el huerfano lo levanta la proxima poda.
    return false
  }
}
