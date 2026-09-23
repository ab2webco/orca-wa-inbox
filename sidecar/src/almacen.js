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
// `chat`, `mensaje`, `desalojo`, `migracion`. El worker corre tras la valla de permisos
// de Node y NO tiene `--allow-fs-write` (no existe en todo orca-oss, §1): no puede
// escribir aca ni debe intentarlo. `wa-read`, que es Python y por eso no hereda la
// valla, solo lee.
//
// La UNICA excepcion es `envio`, la bandeja de salida, donde `bin/wa-send` inserta su
// peticion y el sidecar escribe el veredicto. Son dos escritores sobre una tabla, que
// es justo por lo que esa tabla es una tabla y no un archivo: la llave `req_id` y el
// `update ... where estado='pendiente'` hacen que dos escritores no puedan entregar el
// mismo mensaje dos veces. El detalle entero esta en el comentario de `envio`.
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

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
`

// Las cuentas que estreno la via de WhatsApp Web y que hoy no escribe NADIE. El
// registro de alcance ya nombra las dos formas —`bin/wa-scope`, tabla `wa_account`:
// "'local', o 'web:<lid>' cuando enlaza"—, asi que esto no inventa un criterio: usa el
// que el propio registro declara.
const CUENTAS_VIA_MUERTA = "account = 'web' or account like 'web:%'"

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
  con.exec('begin immediate')
  try {
    migracion = migrar(con)
    con.exec(ESQUEMA)
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
  return new Almacen(con, ruta, migracion)
}

class Almacen {
  constructor (con, ruta, migracion = null) {
    this.con = con
    this.ruta = ruta
    /** Que se llevo la subida de esquema al abrir, o `null` si no hubo ninguna. Lo
     *  publica el sidecar en cuanto abre: el renglon del `doctor` lo va a ver quien
     *  entre al panel, y esto lo ve quien mire el log el dia que pregunte adonde se
     *  fueron los mensajes viejos. */
    this.migracion = migracion
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
  tomarEnvio (ahora = Date.now()) {
    const segundos = Math.floor(ahora / 1000)
    for (;;) {
      const fila = this.con.prepare(
        "select * from envio where estado='pendiente' order by created_at, rowid limit 1")
        .get()
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
