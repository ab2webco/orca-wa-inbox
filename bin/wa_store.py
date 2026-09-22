"""wa_store — el almacen de mensajes, visto desde el lado que LEE.

El sidecar escribe (`sidecar/src/almacen.js`); esto consulta. Son dos procesos, dos
lenguajes y un solo archivo: `~/.wa-inbox/capture.db`, al lado de `scope.db`.

Por que aca y no dentro del plugin: el arbol del plugin esta verificado por content-hash
(docs/ENCARGO-TRANSPORTE-UNICO.md §7) y un archivo que aparece despues de instalarlo
deja el plugin en "No valido". Por que aca y no en `<userData>/plugins-data/`, que es
donde SI vive el auth state: esa ruta solo se resuelve preguntandole a Orca, en un
subproceso, y puede no existir; estos CLI tienen que poder correr desde una terminal con
Orca cerrado. Y sobre todo, la autorizacion vive en `~/.wa-inbox/scope.db` con la llave
`(cuenta, chat_jid)`: el almacen con `(cuenta, chat_jid, stanza_id)` es la misma llave
mas el mensaje, y las dos bases separadas no significan nada.

El nombre tampoco es nuevo: `bin/wa-scope:987` ya declaraba sus dos topes de retencion
diciendo "El almacen de cuerpos de mensajes (~/.wa-inbox/capture.db)".

Este modulo NO escribe nunca. Si el archivo no esta, o no tiene ninguna linea enlazada,
lo dice con un motivo estable en vez de devolver una lista vacia: una bandeja vacia se
lee como "no hay nada que atender", que es lo contrario de "no puedo leer nada"
(§11-E5).
"""
import os
import sqlite3
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wa_settings import settings_from_plugin  # noqa: E402

# La version del esquema la escribe el sidecar en `store_meta`. Si no coincide, se
# NIEGA con un motivo propio en vez de contestar filas a medias: un lector que consulta
# columnas que ya no existen no devuelve un error, devuelve menos mensajes (§11-E5).
ESQUEMA_VERSION = 1

# Motivos estables. El panel los traduce por codigo, nunca por el texto: cambiar el
# texto no rompe nada, renombrar el codigo desincroniza el panel en silencio (§11-E1).
SIN_TRANSPORTE = "no-transport"
ESQUEMA_AJENO = "store-schema"

# Lo que `state` devuelve cuando NO hay firma que devolver. Son contrato con wa-scope
# (`SIN_FIRMA` en bin/wa-scope:112): tratarlas como una firma cualquiera es lo que
# congelaba la bandeja para siempre (§11-E6).
ESTADO_SIN_BASE = "missing"

# Los mismos arranques que `DEFAULT_CONFIG` en bin/wa-scope. Van repetidos aca y no
# importados porque `wa-scope` es un ejecutable sin extension: `scripts/check-clis`
# compara las dos tablas para que no puedan discrepar en silencio.
DEFAULTS = {
    # 7 y no 1: con un dia, una mencion del viernes que nadie contesto ya no aparece el
    # lunes y parece que no hubo nada (§11-B6).
    "inbox_days": "7",
    "capture_max": "20000",
    "capture_days": "90",
}


class SinFuente(Exception):
    """No hay de donde leer, con el motivo que el panel traduce."""

    def __init__(self, reason, detail, code=4):
        super().__init__(reason)
        self.reason = reason
        self.detail = detail
        self.code = code


def inbox_dir():
    """El directorio de estado de las herramientas. La MISMA tabla que `scope_db_path()`
    en bin/wa-scope y bin/wa_settings.py, y que `rutaInbox()` del sidecar."""
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or os.path.expanduser("~/AppData/Roaming")
        return os.path.join(base, "wa-inbox")
    return os.path.expanduser("~/.wa-inbox")


def store_db_path():
    return os.path.join(inbox_dir(), "capture.db")


def scope_db_path():
    return os.path.join(inbox_dir(), "scope.db")


def media_dir():
    return os.path.join(inbox_dir(), "media")


def ajustes():
    """Los ajustes efectivos, con la misma regla que `merged_settings` de wa-scope: lo
    del panel manda sobre lo del CLI, porque el panel es lo que el usuario acaba de
    tocar. Se leen los dos origenes directo y no por subproceso para no meter un
    `wa-scope` mas en cada lectura: `wa_settings` existe justo por esto, y su linea 54
    lo dice — "vive en wa_settings.py porque wa-read tiene que leerla igual"."""
    valores = dict(DEFAULTS)
    ruta = scope_db_path()
    if os.path.exists(ruta):
        try:
            con = sqlite3.connect(f"file:{ruta}?mode=ro", uri=True, timeout=5)
            for key, value in con.execute("select key, value from settings"):
                if value:
                    valores[key] = value
            con.close()
        except sqlite3.Error:
            # Un registro ilegible no puede dejar sin bandeja: se sigue con los
            # arranques de fabrica, que es el comportamiento de siempre.
            pass
    valores.update(settings_from_plugin())
    return valores


def entero(valores, clave, minimo=1):
    try:
        return max(minimo, int(str(valores.get(clave, DEFAULTS.get(clave, "0"))).strip()))
    except (TypeError, ValueError):
        return max(minimo, int(DEFAULTS.get(clave, "1")))


def abrir():
    """El almacen, en solo lectura, o `SinFuente` con el motivo.

    Tres negativas distintas y no una, porque lo que el usuario tiene que hacer es
    distinto en cada una (§11-E2): no hay archivo (nadie enlazo nunca), hay archivo y
    ninguna linea (el emparejamiento no termino), o el esquema es de otra version (el
    sidecar y el CLI no viajan juntos)."""
    ruta = store_db_path()
    if not os.path.exists(ruta):
        raise SinFuente(SIN_TRANSPORTE, SIN_TRANSPORTE_DETALLE)
    try:
        # Solo lectura, y explicito: este proceso NUNCA escribe aca. El unico escritor
        # es el sidecar, que corre fuera de la valla de permisos.
        con = sqlite3.connect(f"file:{ruta}?mode=ro", uri=True, timeout=10)
        con.row_factory = sqlite3.Row
        con.execute("pragma busy_timeout=5000")
    except sqlite3.Error as exc:
        raise SinFuente(SIN_TRANSPORTE, f"the message store could not be opened: {exc}")

    try:
        fila = con.execute("select value from store_meta where key='schema_version'").fetchone()
        version = int(fila["value"]) if fila else 0
    except (sqlite3.Error, TypeError, ValueError):
        version = 0
    if version != ESQUEMA_VERSION:
        con.close()
        raise SinFuente(ESQUEMA_AJENO,
                        f"the message store is version {version} and this tool reads "
                        f"version {ESQUEMA_VERSION}. Update the plugin, or remove "
                        f"{ruta} to let the linked line fill it again.")
    try:
        lineas = con.execute("select count(*) c from linea").fetchone()["c"]
    except sqlite3.Error:
        lineas = 0
    if not lineas:
        con.close()
        raise SinFuente(SIN_TRANSPORTE, SIN_TRANSPORTE_DETALLE)
    return con


SIN_TRANSPORTE_DETALLE = (
    "no linked WhatsApp line can be read yet. Link a line from the plugin settings, "
    "with the QR code.")


def ts(epoch):
    """La fecha, en la hora del equipo. Saber de que epoca es un timestamp no es un
    detalle: con la epoca equivocada la fecha sale 31 anios adelantada y el JSON se ve
    perfecto igual (§11-B5). El almacen guarda segundos de epoch unix, y punto."""
    if not epoch:
        return ""
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(int(epoch)))


def nombre_de(fila):
    """El nombre visible de una conversacion. Los nombres cambian y se repiten, asi que
    el jid es la llave; esto es solo para mostrar."""
    return fila["chat_name"] or fila["chat_jid"]


def quien(fila):
    """Quien escribio. El nombre visible primero; si no hay, el numero pelado, que es
    mas util que un jid entero con su servidor."""
    if fila["from_me"]:
        return "YO"
    if fila["sender_name"]:
        return fila["sender_name"]
    jid = fila["sender_jid"] or ""
    return jid.split("@")[0].split(":")[0] or "?"


def clase_de(fila):
    """`directo` | `mencion` | `respuesta`. La misma regla que publicaba el lector
    viejo: en un uno a uno todo mensaje ajeno es para usted; en un grupo cuenta si lo
    nombran o si contestan algo suyo, y lo demas es conversacion ajena (§11-A4)."""
    if not fila["is_group"]:
        return "directo"
    return "mencion" if fila["menciona_me"] else "respuesta"


def filtro_linea(linea, prefijo="m"):
    if not linea:
        return "", []
    return f" and {prefijo}.account = ?", [linea]


# ── Consultas ───────────────────────────────────────────────────────────────────────

# Mi ultima respuesta en cada chat, calculada UNA vez y agrupada. El lector viejo lo
# hacia con una subconsulta CORRELACIONADA por fila candidata, y sin limite inferior
# tardaba MINUTOS: el panel quedaba inservible. Agrupada usa el indice
# `ix_mensaje_mios` y la consulta de afuera queda libre de recorrer por fecha al reves
# y cortar en el tope (§11-D1).
ULTIMA_MIA = """
left join (select account, chat_jid, max(ts) mine from mensaje
           where from_me = 1 and revocado = 0
           group by account, chat_jid) lm
       on lm.account = m.account and lm.chat_jid = m.chat_jid
"""


def inbox(con, dias, limite, ventana, solo="todos", linea=None):
    """Lo que le hablo a usted y todavia no contesto."""
    corte = int(time.time()) - dias * 86400
    donde, args = filtro_linea(linea)
    if solo == "grupos":
        donde += " and c.is_group = 1"
    elif solo == "directos":
        donde += " and c.is_group = 0"
    sql = f"""
        select m.account, m.chat_jid, m.stanza_id, m.ts, m.from_me, m.sender_jid,
               m.sender_name, m.body, m.media_type, m.media_path, m.menciona_me,
               m.cita_me, c.rowid chat_id, c.chat_name, c.is_group
        from mensaje m
        join chat c on c.account = m.account and c.chat_jid = m.chat_jid
        {ULTIMA_MIA}
        where m.from_me = 0 and m.revocado = 0 and m.ts > ?
          -- Deja de contar si ya escribio despues: si contesto en ese chat, la mencion
          -- ya la atendio. Sin esto una mencion vieja se queda para siempre (§11-D1).
          and m.ts > coalesce(lm.mine, 0)
          -- En un chat uno a uno todo mensaje es para usted. En grupo solo cuenta si lo
          -- nombran o responden algo suyo.
          and (c.is_group = 0 or m.menciona_me = 1 or m.cita_me = 1)
          {donde}
        order by m.ts desc
        limit ?"""
    filas = con.execute(sql, [corte] + args + [limite]).fetchall()

    salida = []
    for r in filas:
        item = {
            "date": ts(r["ts"]),
            "stanza_id": r["stanza_id"],
            "chat": nombre_de(r),
            "chat_id": r["chat_id"],
            "chat_jid": r["chat_jid"],
            # La linea viaja con cada fila: la MISMA conversacion puede estar en dos
            # lineas propias, y contestar desde la equivocada no se deshace (§11-A1).
            "account": r["account"],
            "sender": quien(r),
            "kind": clase_de(r),
            "text": (r["body"] or "").replace("\n", " "),
            "media": r["media_path"] or None,
        }
        item["adjuntos_cerca"] = adjuntos_cerca(con, r["account"], r["chat_jid"],
                                                r["ts"], ventana)
        item["audios"] = [a["path"] for a in item["adjuntos_cerca"] if a["type"] == "audio"]
        cerca = texto_cerca(con, r["account"], r["chat_jid"], r["ts"], ventana,
                            r["stanza_id"])
        if cerca:
            item["contexto_cerca"] = cerca
        salida.append(item)
    return salida


def adjuntos_cerca(con, cuenta, chat_jid, cuando, minutos):
    """Adjuntos del mismo chat dentro de +/- N minutos.

    §11-C5: "el pie casi nunca llega en el mismo mensaje que la mencion: se manda la
    imagen y dos lineas despues el '@fulano mira esto' — sin esta ventana el agente lee
    'mira esto' sin idea de que." La ventana esta acotada por los dos lados y corre
    sobre `ix_mensaje_chat`, no sobre la tabla entera."""
    if not minutos:
        return []
    filas = con.execute(
        """select ts, sender_name, sender_jid, from_me, media_type, media_path, body
           from mensaje
           where account = ? and chat_jid = ? and revocado = 0
                 and media_path is not null and media_path <> ''
                 and ts between ? and ?
           order by ts""",
        (cuenta, chat_jid, cuando - minutos * 60, cuando + minutos * 60)).fetchall()
    return [{"date": ts(r["ts"]), "sender": quien(r), "type": r["media_type"],
             "caption": (r["body"] or "").replace("\n", " "), "path": r["media_path"]}
            for r in filas]


def texto_cerca(con, cuenta, chat_jid, cuando, minutos, excepto):
    """Lo que se dijo alrededor. Un problema contado en cinco mensajes tiene que
    llegarle al agente como UNA conversacion: sin los vecinos, cada mensaje se lee como
    un caso aparte y se abren cinco tarjetas donde va una (§11-B3)."""
    if not minutos:
        return []
    filas = con.execute(
        """select ts, sender_name, sender_jid, from_me, body from mensaje
           where account = ? and chat_jid = ? and revocado = 0
                 and body <> '' and stanza_id <> ? and ts between ? and ?
           order by ts limit 20""",
        (cuenta, chat_jid, excepto, cuando - minutos * 60, cuando + minutos * 60)).fetchall()
    return [{"date": ts(r["ts"]), "sender": quien(r),
             "text": (r["body"] or "").replace("\n", " ")} for r in filas]


def chats(con, limite, query=None, solo_no_leidos=False, linea=None):
    """Las conversaciones que existen, autorizadas o no.

    Las que estan en `off` TAMBIEN se listan: sin eso una conversacion que nadie
    registro no se puede ni ofrecer para autorizarla, y el panel nace con la lista
    vacia para siempre. Un jid, un nombre y una hora no son el texto de nadie
    (§11-F3)."""
    donde, args = filtro_linea(linea, "c")
    if query:
        donde += " and lower(c.chat_name) like ?"
        args.append(f"%{query.lower()}%")
    if solo_no_leidos:
        donde += " and c.unread > 0"
    filas = con.execute(
        f"""select c.rowid id, c.account, c.chat_jid, c.chat_name, c.is_group,
                   c.unread, c.last_ts
            from chat c where 1 = 1 {donde}
            order by coalesce(c.last_ts, 0) desc, c.rowid
            limit ?""", args + [limite]).fetchall()
    return [{"id": r["id"], "jid": r["chat_jid"],
             "kind": "grupo" if r["is_group"] else "directo",
             "unread": r["unread"], "last": ts(r["last_ts"]),
             "name": nombre_de(r), "account": r["account"]}
            for r in filas]


def resolver_chat(con, ref, linea=None):
    """Acepta el JID, el id de la lista, o parte del nombre. Devuelve la fila del chat.

    La ambiguedad se RECHAZA, nunca se resuelve en silencio (§11-D4): dos conversaciones
    con el mismo nombre en dos lineas propias son dos conversaciones, y elegir una es
    contestar sobre la ajena."""
    donde, args = filtro_linea(linea, "c")
    filas = con.execute(
        f"""select c.rowid id, c.account, c.chat_jid, c.chat_name, c.is_group
            from chat c where 1 = 1 {donde}""", args).fetchall()
    if "@" in ref:
        hits = [r for r in filas if r["chat_jid"] == ref]
    else:
        hits = [r for r in filas if str(r["id"]) == ref
                or ref.lower() in (r["chat_name"] or "").lower()]
        exactos = [r for r in hits if (r["chat_name"] or "").lower() == ref.lower()]
        hits = exactos or hits
    if not hits:
        sys.exit(f"no chat matches {ref!r}")
    if len(hits) > 1:
        print(f"{ref!r} is ambiguous:", file=sys.stderr)
        for r in hits[:12]:
            print(f"  {r['account']}\t{r['chat_jid']}\t{r['chat_name']}", file=sys.stderr)
        sys.exit(2)
    return hits[0]


def chat(con, fila, limite, dias=None):
    """Los ultimos mensajes de una conversacion, del mas viejo al mas nuevo."""
    args = [fila["account"], fila["chat_jid"]]
    donde = ""
    if dias:
        donde = " and ts > ?"
        args.append(int(time.time()) - dias * 86400)
    filas = con.execute(
        f"""select ts, from_me, sender_name, sender_jid, body, media_path
            from mensaje
            where account = ? and chat_jid = ? and revocado = 0 {donde}
            order by ts desc limit ?""", args + [limite]).fetchall()
    return [{"date": ts(r["ts"]), "chat": nombre_de(fila), "chat_id": fila["id"],
             "sender": quien(r), "text": (r["body"] or "").replace("\n", " "),
             "media": r["media_path"] or None}
            for r in reversed(filas)]


def media(con, fila, limite):
    """Los adjuntos de una conversacion, con la ruta en disco.

    `exists` no es cosmetica: `bin/wa-transcribe` recibe una RUTA y nada mas, y una ruta
    que no se puede respaldar falla con "no such file" lejos de aca (§11-C4)."""
    filas = con.execute(
        """select ts, from_me, sender_name, sender_jid, media_type, media_bytes,
                  media_path, body
           from mensaje
           where account = ? and chat_jid = ? and revocado = 0
                 and media_path is not null and media_path <> ''
           order by ts desc limit ?""",
        (fila["account"], fila["chat_jid"], limite)).fetchall()
    return [{"date": ts(r["ts"]), "chat": nombre_de(fila), "sender": quien(r),
             "type": r["media_type"], "bytes": r["media_bytes"],
             "caption": (r["body"] or "").replace("\n", " "),
             "path": r["media_path"], "exists": os.path.exists(r["media_path"] or "")}
            for r in filas]


def whoami(con, linea=None):
    """Quien es cada linea enlazada, y cuantos grupos ve.

    Una fila POR LINEA, nunca fundidas: el producto soporta varias lineas
    independientes a la vez —un numero personal y uno de soporte— y colapsarlas borra
    la identidad de la segunda (§11-I1/I2)."""
    donde, args = ("", [])
    if linea:
        donde, args = " where account = ?", [linea]
    filas = con.execute(
        f"select account, lid, pn, name, groups_n from linea{donde} order by account",
        args).fetchall()
    salida = []
    for r in filas:
        grupos = con.execute(
            "select count(*) c from chat where account = ? and is_group = 1",
            (r["account"],)).fetchone()["c"]
        salida.append({"lid": r["lid"], "name": r["name"],
                       "grupos": grupos or r["groups_n"] or 0,
                       "account": r["account"], "phone": r["pn"]})
    return salida


def ultima_migracion():
    """Que se llevo la subida de esquema del almacen, o None.

    Abre por su cuenta y NO usa `abrir()`, a proposito. La migracion borra las lineas
    de la via de WhatsApp Web —que es un transporte que ya no existe— y despues de eso
    `abrir()` se niega con `no-transport` hasta que el sidecar enlace la linea de hoy.
    Si esto colgara de `abrir()`, el aviso solo se veria en la maquina donde todo lo
    demas ya anda, o sea: nunca en la maquina que acaba de migrar, que es la unica
    donde hace falta.

    Escribir no escribe, como todo este modulo: `mode=ro`. La migracion es del
    escritor, y un lector que migrara dejaria a dos `wa-read` en paralelo subiendo el
    mismo archivo a la vez."""
    ruta = store_db_path()
    if not os.path.exists(ruta):
        return None
    try:
        con = sqlite3.connect(f"file:{ruta}?mode=ro", uri=True, timeout=5)
        con.row_factory = sqlite3.Row
        r = con.execute("select at, desde, hasta, cuerpos, lineas from migracion "
                        "order by at desc limit 1").fetchone()
        con.close()
    except sqlite3.Error:
        # Sin tabla `migracion` no hubo ninguna migracion que contar: un almacen nuevo,
        # o uno de la version vieja que todavia no subio. Ni una cosa ni la otra es un
        # fallo del que haya que hablar aca.
        return None
    if not r:
        return None
    return {"at": r["at"], "desde": r["desde"], "hasta": r["hasta"],
            "cuerpos": r["cuerpos"], "lineas": r["lineas"]}


def ultimo_desalojo(con):
    """Cuanto se desalojo la ultima vez. §11-F2: "un desalojo callado es un caso que se
    pierde y se descubre despues, cuando la fila ya salio sin explicacion"."""
    try:
        r = con.execute("select at, caducados, desalojados, archivos from desalojo "
                        "order by at desc limit 1").fetchone()
    except sqlite3.Error:
        return None
    if not r:
        return None
    return {"at": r["at"], "caducados": r["caducados"],
            "desalojados": r["desalojados"], "archivos": r["archivos"]}


def state(con, linea=None):
    """Cuanto cambio el almacen, sin recorrerlo.

    Una firma por linea. Va el mtime del archivo —que cambia con cada escritura— Y el
    conteo y la ultima fecha de esa linea, porque con el archivo solo, dos lineas
    devuelven la misma firma y una bandeja que no cambio se ve igual que una que si.
    `missing` y `live` son centinelas de wa-scope y no se pueden devolver como firma de
    verdad: leerlas como una firma cualquiera es lo que congelaba la bandeja (§11-E6)."""
    ruta = store_db_path()
    existe = os.path.exists(ruta)
    try:
        st = os.stat(ruta)
        mtime, size = int(st.st_mtime), st.st_size
    except OSError:
        mtime, size = None, None
    try:
        wal = os.stat(ruta + "-wal")
        cola = f"|{int(wal.st_mtime)}:{wal.st_size}"
    except OSError:
        cola = ""

    desalojo = ultimo_desalojo(con) or {}
    donde, args = ("", [])
    if linea:
        donde, args = " where account = ?", [linea]
    filas = con.execute(f"select account from linea{donde} order by account", args).fetchall()
    salida = []
    for r in filas:
        conteo = con.execute(
            "select count(*) c, coalesce(max(ts),0) t from mensaje where account = ?",
            (r["account"],)).fetchone()
        firma = (f"{mtime}:{size}:{conteo['c']}:{conteo['t']}{cola}"
                 if existe else ESTADO_SIN_BASE)
        salida.append({
            "account": r["account"], "db": ruta, "exists": existe,
            "mtime": mtime, "size": size, "fingerprint": firma,
            # El desalojo viaja con el estado porque es donde wa-scope y el panel ya
            # miran. Es global al almacen, no por linea: la poda corre sobre la tabla.
            "evicted": (desalojo.get("caducados", 0) + desalojo.get("desalojados", 0)),
            "evictedAt": ts(desalojo.get("at")) or None,
            "evictedFiles": desalojo.get("archivos", 0),
        })
    return salida
