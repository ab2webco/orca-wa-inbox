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
import json
import os
import re
import sqlite3
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wa_settings import duenos, settings_from_plugin  # noqa: E402

# La version del esquema la escribe el sidecar en `store_meta`. Si no coincide, se
# NIEGA con un motivo propio en vez de contestar filas a medias: un lector que consulta
# columnas que ya no existen no devuelve un error, devuelve menos mensajes (§11-E5).
ESQUEMA_VERSION = 1

# Motivos estables. El panel los traduce por codigo, nunca por el texto: cambiar el
# texto no rompe nada, renombrar el codigo desincroniza el panel en silencio (§11-E1).
SIN_TRANSPORTE = "no-transport"
# Hay linea enlazada pero el sidecar no late: nadie esta leyendo WhatsApp AHORA. Codigo
# propio y no `no-transport`, porque la accion del dueno es otra: no escanear un QR,
# sino relanzar la conexion desde el panel.
LINEA_MUDA = "transport-silent"
# Cuanto vale el latido que el sidecar escribe en `store_meta` cada segundo (`latir()`
# en sidecar/src/almacen.js). El MISMO numero que `LATIDO_VENCE_MS` de
# sidecar/src/envio.js, y `scripts/check-clis` compara los dos (via `bin/wa-send`).
LATIDO_VENCE_S = 15
# Cuanto sin latir antes de que el DOCTOR diga que la linea esta muda. Es otra pregunta
# que la de `LATIDO_VENCE_S`: `wa-send` espera un veredicto y necesita saber ya si hay
# alguien; el doctor diagnostica, y un diagnostico falso manda al dueno a relanzar lo
# que ya esta arrancando. Un sidecar que reinicia (el boton "Traer conversaciones", una
# caida con su espera de hasta 60 s) deja de latir lo que tarda en cargar Baileys,
# preguntar la version y abrir el almacen: visto en vivo, el sync de 5 minutos cayo en
# esa ventana y dijo "ninguna senal de vida" sobre una linea que estaba recibiendo.
# NO es la constante que `scripts/check-clis` compara con el sidecar: esa es la de arriba.
LATIDO_MUDO_S = 120
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

# El mismo vocabulario cerrado que valida `wa-scope juicio` (CLASES_JUICIO y
# ORIGENES_JUICIO en bin/wa-scope). Repetido aca y no importado por la misma razon que
# DEFAULTS diez lineas arriba: `wa-scope` es un ejecutable sin extension, y
# scripts/check-clis compara las dos listas para que no puedan discrepar en silencio.
# Una clase o un origen que no esten aca no son un veredicto: son ruido que esta fila
# no muestra (T6, odd/tasks/juicio-cacheado.md).
CLASES_JUICIO = ("card", "alert", "nothing", "doubtful")
ORIGENES_JUICIO = ("agente", "jev")


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


def veredictos_cacheados():
    """El juicio que `wa-scope juicio` ya guardo, si scope.db y su tabla existen.

    Misma regla que `ajustes()`: se abre en solo lectura y cualquier tropiezo se lee
    como "no hay veredicto todavia", nunca como un error que bloquea la bandeja. Sin
    archivo, sin tabla, sin fila para esa llave o con una clase u origen que no estan
    en el vocabulario cerrado, la respuesta es que ese mensaje no tiene veredicto — y
    el agente clasifica como si esto no existiera (T6, odd/tasks/juicio-cacheado.md)."""
    ruta = scope_db_path()
    veredictos = {}
    if not os.path.exists(ruta):
        return veredictos
    try:
        con = sqlite3.connect(f"file:{ruta}?mode=ro", uri=True, timeout=5)
        con.row_factory = sqlite3.Row
        filas = con.execute(
            "select account, chat_jid, stanza_id, clase, origen from juicio").fetchall()
        con.close()
    except sqlite3.Error:
        # Sin la tabla (una base de antes de esta tarea), base corrupta o candado: como
        # si no hubiera ningun veredicto guardado.
        return veredictos
    for r in filas:
        if r["clase"] not in CLASES_JUICIO or r["origen"] not in ORIGENES_JUICIO:
            continue
        veredictos[(r["account"], r["chat_jid"], r["stanza_id"])] = {
            "clase": r["clase"], "origen": r["origen"]}
    return veredictos


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


def linea_activa(con):
    """La linea vinculada AHORA (`store_meta.linea_activa`, la escribe el sidecar al
    abrir), o None en un almacen que nunca la anoto.

    Cada numero es su linea: vincular otro numero NO hereda las conversaciones ni las
    autorizaciones del anterior, y lo del anterior sigue guardado para el dia que se
    vuelva a vincular. Los lectores miran solo esta; None —un almacen de antes de que
    hubiera lineas por numero— lee todas, que es lo que hacia siempre."""
    try:
        fila = con.execute(
            "select value from store_meta where key='linea_activa'").fetchone()
        return fila[0] if fila and fila[0] else None
    except sqlite3.Error:
        return None


# Varias lineas a la vez (odd/tasks/varias-lineas-y-segundo-cerebro.md). La variable con
# que se nombra la linea de una corrida: la pone el proceso de cada linea (el tick, la
# entrada) y la heredan sus hijos (`wa-send`, `wa-read`). Es contrato con
# `sidecar/src/alcance.js` (`LINEA_ENV`), que la usa para preguntar el alcance de SU linea.
LINEA_ENV = "WA_INBOX_LINEA"
# Una linea es un telefono (`pn:<digitos>`) o la de siempre, `local`.
_LINEA_RE = re.compile(r"^(pn:\d{6,}|local)$")


class LineaInvalida(ValueError):
    """`WA_INBOX_LINEA` (o `--line`) no nombra una linea. Es un error y no un "sin linea":
    caer a la principal seria leer y escribir en la linea equivocada."""


def linea_valida(valor):
    """`valor` si nombra una linea; si no, `LineaInvalida`."""
    texto = (valor or "").strip()
    if not _LINEA_RE.match(texto):
        raise LineaInvalida(f"{valor!r} is not a line (use pn:<digits>)")
    return texto


def linea_pedida():
    """La linea que nombra `WA_INBOX_LINEA`, o None si no nombra ninguna."""
    valor = os.environ.get(LINEA_ENV)
    return linea_valida(valor) if valor is not None and valor.strip() else None


def lineas_activas(con):
    """Las lineas vinculadas AHORA, en orden (la primera es la principal), de
    `store_meta.lineas_activas`, que anota cada sidecar. Un almacen de antes de esto solo
    anoto `linea_activa`: entonces es esa sola."""
    try:
        fila = con.execute(
            "select value from store_meta where key='lineas_activas'").fetchone()
    except sqlite3.Error:
        fila = None
    if fila is None:
        principal = linea_activa(con)
        return [principal] if principal else []
    try:
        lista = json.loads(fila[0])
    except (TypeError, ValueError):
        return []
    return [c for c in lista if isinstance(c, str) and c] if isinstance(lista, list) else []


def lineas_activas_en_disco():
    """`lineas_activas` sin pedir un almacen valido, como `linea_activa_en_disco`."""
    ruta = store_db_path()
    if not os.path.exists(ruta):
        return []
    try:
        con = sqlite3.connect(f"file:{ruta}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error:
        return []
    try:
        return lineas_activas(con)
    finally:
        con.close()


def linea_activa_en_disco():
    """`linea_activa` sin pedir un almacen valido: la usa `wa-scope`, que tiene que
    saber de que linea es cada autorizacion aunque el almacen no exista todavia. Solo
    lectura, como todo este modulo."""
    ruta = store_db_path()
    if not os.path.exists(ruta):
        return None
    try:
        con = sqlite3.connect(f"file:{ruta}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error:
        return None
    try:
        return linea_activa(con)
    finally:
        con.close()


def ultimo_latido(con):
    """El ultimo latido del sidecar en el almacen, en segundos de epoch, o None si
    nunca latio (o la base no lo sabe decir)."""
    try:
        fila = con.execute(
            "select value from store_meta where key='sidecar_beat'").fetchone()
        return int(fila[0]) if fila else None
    except (sqlite3.Error, TypeError, ValueError):
        return None


def sidecar_vivo(con):
    """Si hay alguien del otro lado AHORA. Una fila en `linea` dice que alguna vez hubo
    una linea; esto dice que el sidecar sigue corriendo. Es la regla de `wa-send` y la
    del `doctor`, escrita una sola vez."""
    latido = ultimo_latido(con)
    return latido is not None and (time.time() - latido) <= LATIDO_VENCE_S


def sidecar_mudo(con):
    """Si el sidecar lleva tanto sin latir que ya no es un reinicio: es la regla del
    doctor (`LATIDO_MUDO_S`). Nunca haber latido tambien es mudo: nadie leyo esta linea
    desde que se enlazo."""
    latido = ultimo_latido(con)
    return latido is None or (time.time() - latido) > LATIDO_MUDO_S


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
    """`directo` | `mencion` | `respuesta` | `grupo`.

    En un uno a uno todo mensaje ajeno es para usted. En un grupo, que lo nombren o que
    contesten algo suyo sigue siendo lo mas directo que hay y por eso se distingue —
    pero ya no es lo UNICO que llega: un mensaje de un grupo autorizado que no hace ni
    lo uno ni lo otro sale como `grupo`, en vez de no salir.

    Se distingue y no se aplana en una sola clase porque el agente prioriza con esto:
    una mencion pide respuesta y una linea suelta del grupo puede no pedir nada. Esa
    decision es suya; antes se la tomaba el SQL escondiendole la fila."""
    if not fila["is_group"]:
        return "directo"
    if fila["menciona_me"]:
        return "mencion"
    if fila["cita_me"]:
        return "respuesta"
    return "grupo"


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
               m.cita_me, c.rowid chat_id, c.chat_name, c.is_group, lm.mine
        from mensaje m
        join chat c on c.account = m.account and c.chat_jid = m.chat_jid
        {ULTIMA_MIA}
        where m.from_me = 0 and m.revocado = 0 and m.ts > ?
          -- Aca ANTES habia dos filtros que escondian trabajo real, y los dos se
          -- quitaron por lo mismo: el almacen SOLO guarda mensajes de chats que el
          -- dueno autorizo (`ingerirMensaje` le pregunta al alcance antes de escribir
          -- una sola palabra). El permiso ya es el consentimiento; volver a filtrar
          -- aca era decidir por el dueno sobre algo que el ya decidio.
          --
          -- 1) "en grupo solo si lo nombran o citan algo suyo". Medido en la cuenta
          --    del dueno: le escriben "pilas tu. o quieres que te suba a cliente?" en
          --    un grupo AUTORIZADO, sin @, y la bandeja salia vacia. El agente no leia
          --    la pregunta que tenia delante.
          --
          -- 2) "deja de contar si ya escribio despues". Cualquier cosa que el dueno
          --    escribiera limpiaba la bandeja entera del chat. Medido: tres mensajes
          --    suyos a las 18:55 que no contestaban nada borraron dos menciones
          --    directas de las 17:35. haber escrito no es haber atendido.
          --
          -- Lo que se sabia NO se perdio: `kind` sigue diciendo si es mencion, cita o
          -- conversacion del chat, y `escribio_despues` dice si el dueno hablo
          -- despues. El agente decide con eso; antes ni se enteraba. Informar en vez
          -- de esconder es la misma regla que el resto del plugin: una lista vacia
          -- tiene que significar que no hay nada, no que no se miro.
          {donde}
        order by m.ts desc, m.rowid desc
        limit ?"""
    filas = con.execute(sql, [corte] + args + [limite]).fetchall()

    # Una sola lectura de scope.db para toda la bandeja, no una por fila: la tabla
    # `juicio` es chica frente al limite de la bandeja y abrir un archivo aparte por
    # mensaje seria el mismo costo que el cache existe para evitar.
    veredictos = veredictos_cacheados()

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
            # El id del remitente, sin el dispositivo: es lo que dice si escribio uno de
            # los numeros del dueno (T22.1). El nombre se repite y cambia; esto no.
            "sender_jid": jid_sin_dispositivo(r["sender_jid"]),
            "kind": clase_de(r),
            # Si el dueno escribio en ese chat DESPUES de este mensaje. Antes esto
            # borraba la fila; ahora la acompana, que es lo que deja al agente decidir
            # si ya quedo atendida o si escribio de otra cosa.
            "escribio_despues": bool(r["mine"] and r["ts"] <= r["mine"]),
            "text": (r["body"] or "").replace("\n", " "),
            "media": r["media_path"] or None,
            "media_type": r["media_type"] or None,
        }
        # El veredicto cacheado, la misma llave que identifica el mensaje. Es una
        # PISTA mas, junto a `kind` y `escribio_despues`: informa, no decide, y su
        # ausencia es normal — significa "todavia no juzgado", nunca "juzgado como
        # nada" (T5/T6, odd/tasks/juicio-cacheado.md).
        juicio = veredictos.get((r["account"], r["chat_jid"], r["stanza_id"]))
        if juicio:
            item["juicio"] = juicio
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
    propios = chats_propios(con)
    pares = telefonos_de_lid(con)
    out = []
    for r in filas:
        item = {"id": r["id"], "jid": r["chat_jid"],
                "kind": "grupo" if r["is_group"] else "directo",
                "unread": r["unread"], "last": ts(r["last_ts"]),
                "name": nombre_de(r), "account": r["account"],
                "phone": telefono_de(r["account"], r["chat_jid"], pares)}
        # El "mensaje a uno mismo" de la linea (T10): se llamaba como su jid pelado.
        # Se marca y se llama como la linea, que es como lo muestra WhatsApp.
        propio = propios.get((r["account"], usuario_de(r["chat_jid"])))
        if propio is not None:
            item["own"] = True
            if propio:
                item["name"] = propio
        out.append(item)
    return out


def telefonos_de_lid(con):
    """El telefono de cada LID, por linea: `{(cuenta, lid): pn}`. Lo anota el sidecar
    (`lid_telefono`); un almacen de antes de esa tabla no tiene ninguno, y eso no es un
    error: el telefono es un dato de mas, no una condicion para listar."""
    try:
        filas = con.execute("select account, lid, pn from lid_telefono").fetchall()
    except sqlite3.Error:
        return {}
    return {(f["account"], f["lid"]): f["pn"] for f in filas}


def telefono_de(cuenta, chat_jid, pares):
    """El telefono de un directo en formato E.164 (`+<digitos>`), o None. Un directo por
    telefono lo lleva en su jid; uno por LID, en el par que anoto el sidecar. Un grupo
    no tiene telefono."""
    jid = jid_sin_dispositivo(chat_jid) or ""
    if jid.endswith("@lid"):
        jid = pares.get((cuenta, jid)) or ""
    usuario, _, servidor = jid.partition("@")
    if servidor == "s.whatsapp.net" and usuario.isdigit():
        return f"+{usuario}"
    return None


def usuario_de(jid):
    """(usuario, servidor) de un jid, sin el dispositivo: `X:7@lid` y `X@lid` son el
    mismo usuario. El servidor va en la llave porque un LID y un telefono son numeros
    distintos que no se pueden confundir."""
    texto = str(jid or "")
    usuario, _, servidor = texto.partition("@")
    return (usuario.split(":")[0], servidor)


def jid_sin_dispositivo(jid):
    """`X:7@lid` -> `X@lid`. None sin jid."""
    usuario, servidor = usuario_de(jid)
    return f"{usuario}@{servidor}" if usuario and servidor else None


def es_dueno(jid, ids=None):
    """Si `jid` es uno de los numeros del dueno (T22.1). La autoridad sale de aca: del id
    que dejo WhatsApp, nunca del texto del mensaje."""
    ids = duenos() if ids is None else ids
    propio = jid_sin_dispositivo(jid)
    return bool(propio) and propio in ids


# Los roles por numero (roles-por-numero, M9), de menor a mayor. `client` es lo de siempre
# y no se guarda nunca: un numero sin rol es un cliente. El rol sale del id que dejo
# WhatsApp y de lo que el dueno guardo para ESA conversacion, nunca del texto.
ROL_CLIENTE = "client"
ROL_OPERADOR = "operator"
ROL_ADMIN = "admin"
ROLES = (ROL_CLIENTE, ROL_OPERADOR, ROL_ADMIN)
# Lo que se guarda en `chat_scope.miembros`.
ROLES_GUARDADOS = (ROL_OPERADOR, ROL_ADMIN)


def rol_menor(roles):
    """El rol mas bajo de una lista; cliente si esta vacia."""
    return min(roles, key=ROLES.index, default=ROL_CLIENTE)


def id_de_persona(valor):
    """El id de una persona sin el dispositivo (`<digitos>@lid` o
    `<digitos>@s.whatsapp.net`), o None. Un grupo, un nombre o un numero escrito a mano no
    es una persona: no puede tener rol."""
    jid = jid_sin_dispositivo(valor) if isinstance(valor, str) else None
    usuario, _, servidor = (jid or "").partition("@")
    if usuario.isdigit() and servidor in ("lid", "s.whatsapp.net"):
        return jid
    return None


def rol_de(con, cuenta, chat_jid, sender_jid, owners, miembros, pares=None):
    """El rol de quien escribio en una conversacion: `admin`, `operator` o `client`.

    - Un dueno global (`owners`, los de `duenos()`) es admin en TODAS las conversaciones,
      por su id EXACTO, como `es_dueno`, `chat_del_dueno` y `caso_del_dueno`: el par
      LID-telefono no lo vuelve dueno por el otro id. Asi una conversacion sin roles
      guardados queda como en v4.16.0 (el dueno o cualquier otro) y el dueno es el mismo
      para todas las reglas: su caso nunca se presenta como el de un operador.
    - Si no, el rol que el dueno guardo para ESTA conversacion y para ninguna otra:
      `miembros` es `{chat_jid: {id: operator|admin}}` (`chat_scope.miembros` de cada
      chat), y solo se mira `miembros[chat_jid]`. Un operador de un grupo es un cliente en
      cualquier otro chat.
    - Para ese rol guardado, un LID y un telefono son la misma persona SOLO por un par de
      `lid_telefono` de esa linea (`con` es el almacen, o None: sin almacen no hay pares).
      Nunca se adivina por los digitos. `pares` son esos pares ya leidos
      (`telefonos_de_lid`), para quien juzga muchos mensajes de una vez; sin ellos se leen
      de `con`.

    Sin remitente, en un directo escribe la conversacion; en un grupo, nadie: cliente. Si la
    persona tiene dos ids con roles distintos, vale el menor."""
    jid = sender_jid or (chat_jid if chat_jid and not str(chat_jid).endswith("@g.us")
                         else None)
    if not jid_sin_dispositivo(jid):
        return ROL_CLIENTE
    if es_dueno(jid, {jid_sin_dispositivo(o) for o in owners or () if o}):
        return ROL_ADMIN
    if pares is None:
        pares = telefonos_de_lid(con) if con is not None else {}
    ids = companeros_de(cuenta, jid, pares)
    del_chat = (miembros or {}).get(chat_jid) if isinstance(miembros, dict) else None
    if not isinstance(del_chat, dict):
        return ROL_CLIENTE
    guardados = {id_de_persona(k): v for k, v in del_chat.items() if id_de_persona(k)}
    roles = [guardados[i] for i in ids if guardados.get(i) in ROLES_GUARDADOS]
    return rol_menor(roles) if roles else ROL_CLIENTE


def directo_sin_reglas(con, cuenta, chat_jid, owners, miembros):
    """Si la conversacion es el directo con un operador o un admin de ELLA (roles-por-numero,
    M10, decision 3 del dueno): lo que se le contesta ahi no lo lee ningun cliente, asi que
    no pasa por los niveles del cliente ni por la revision de Jev. Un grupo nunca: ahi leen
    los clientes. El rol sale de `rol_de` sobre la persona del directo (la conversacion
    misma), nunca del texto. El secreto lo sigue frenando quien llama."""
    if not chat_jid or str(chat_jid).endswith("@g.us"):
        return False
    return rol_de(con, cuenta, chat_jid, None, owners, miembros) in ROLES_GUARDADOS


def miembros_de_columna(valor):
    """Los roles guardados de una conversacion (`chat_scope.miembros`): `{id: operator|admin}`
    con ids de persona sin dispositivo. Lo que no es un id o un rol guardable se ignora: un
    valor sucio no le puede dar un rol a nadie. Una base de antes (null) no tiene ninguno."""
    try:
        datos = json.loads(valor) if isinstance(valor, str) else valor
    except ValueError:
        return {}
    if not isinstance(datos, dict):
        return {}
    salida = {}
    for clave, rol in datos.items():
        jid = id_de_persona(clave)
        if jid and rol in ROLES_GUARDADOS:
            salida[jid] = rol
    return salida


def miembros_del_panel(lista):
    """Los roles que dice `scope[jid].members` del panel (`[{id, name, role}]`), como se
    guardan: `{id: operator|admin}`. `client` no se guarda (es no tener rol), y un id sin
    forma de id de persona o un rol que no existe se descartan."""
    salida = {}
    for m in lista if isinstance(lista, list) else []:
        if isinstance(m, dict):
            jid = id_de_persona(m.get("id"))
            if jid and m.get("role") in ROLES_GUARDADOS:
                salida[jid] = m["role"]
    return salida


def chat_del_dueno(con, cuenta, chat_jid, ids=None):
    """Si la conversacion es del dueno: el directo con uno de sus numeros, o el chat de
    la linea consigo misma. Lo que se le manda ahi no protege a ningun tercero."""
    if es_dueno(chat_jid, ids):
        return True
    if con is None:
        return False
    return (cuenta, usuario_de(chat_jid)) in chats_propios(con)


def remitentes(con, linea=None, limite=400):
    """Quienes escribieron en las conversaciones autorizadas, para que el panel ofrezca
    elegir los numeros del dueno por su nombre: [{id, name, chats, last}], del mas
    reciente al mas viejo. Solo ids y nombres, nunca el texto de nadie."""
    donde, args = filtro_linea(linea)
    filas = con.execute(
        f"""select m.sender_jid, m.sender_name, m.ts, c.chat_name, c.chat_jid
            from mensaje m join chat c on c.account = m.account and c.chat_jid = m.chat_jid
            where m.from_me = 0 and m.sender_jid is not null {donde}
            order by m.ts desc limit 20000""", args).fetchall()
    vistos = {}
    for r in filas:
        jid = jid_sin_dispositivo(r["sender_jid"])
        if not jid:
            continue
        item = vistos.get(jid)
        if item is None:
            if len(vistos) >= limite:
                continue
            item = vistos[jid] = {"id": jid, "name": r["sender_name"] or "", "chats": [],
                                  "last": ts(r["ts"])}
        if not item["name"] and r["sender_name"]:
            item["name"] = r["sender_name"]
        nombre = r["chat_name"] or r["chat_jid"]
        if nombre not in item["chats"] and len(item["chats"]) < 3:
            item["chats"].append(nombre)
    return list(vistos.values())


def companeros_de(cuenta, jid, pares, inversos=None):
    """Los ids de la MISMA persona: el suyo y, solo si el sidecar anoto el par en
    `lid_telefono`, el otro (su telefono para un LID, su LID para un telefono). Nunca se
    adivina por los digitos: un LID y un telefono son numeros distintos (roles-por-numero).
    `inversos` es `{(cuenta, pn): lid}`; sin el se arma de `pares`."""
    propio = jid_sin_dispositivo(jid)
    if not propio:
        return []
    if inversos is None:
        inversos = {(c, pn): lid for (c, lid), pn in pares.items()}
    otro = pares.get((cuenta, propio)) if propio.endswith("@lid") else \
        inversos.get((cuenta, propio))
    return [propio] + ([otro] if otro and otro != propio else [])


class _Libreta:
    """Lo que hace falta para nombrar a los miembros de los grupos de una linea, leido UNA
    vez: los pares LID-telefono, el ultimo `sender_name` de cada remitente y el nombre de
    cada directo (la libreta). Ids y nombres, nunca un cuerpo."""

    def __init__(self, con, cuenta):
        self.cuenta = cuenta
        self.pares = telefonos_de_lid(con)
        self.inversos = {(c, pn): lid for (c, lid), pn in self.pares.items()}
        self.propios = chats_propios(con)
        self.por_mensaje = {}
        for r in con.execute(
                "select sender_jid, sender_name from mensaje where account = ? and "
                "from_me = 0 and sender_jid is not null and coalesce(sender_name, '') <> '' "
                "order by ts desc", (cuenta,)):
            jid = jid_sin_dispositivo(r["sender_jid"])
            if jid and jid not in self.por_mensaje:
                self.por_mensaje[jid] = r["sender_name"]
        self.por_libreta = {}
        for r in con.execute("select chat_jid, chat_name from chat where account = ? and "
                             "is_group = 0", (cuenta,)):
            nombre = r["chat_name"] or ""
            jid = jid_sin_dispositivo(r["chat_jid"])
            if jid and nombre and nombre != r["chat_jid"]:
                self.por_libreta[jid] = nombre

    def fila(self, jid, admin):
        ids = companeros_de(self.cuenta, jid, self.pares, self.inversos)
        nombre = next((self.por_mensaje[i] for i in ids if i in self.por_mensaje), "") or \
            next((self.por_libreta[i] for i in ids if i in self.por_libreta), "")
        telefono = next((t for t in (telefono_de(self.cuenta, i, self.pares) for i in ids)
                         if t), None)
        return {"id": ids[0], "name": nombre, "phone": telefono, "wa_admin": bool(admin)}

    def propio(self, jid):
        return (self.cuenta, usuario_de(jid)) in self.propios


def miembros(con, cuenta, chat_jid, es_grupo, libreta=None):
    """Quienes estan en una conversacion, para que el dueno les de un rol (roles-por-numero,
    M8): `[{id, name, phone, wa_admin}]`, por nombre.

    En un grupo, la lista que guardo el sidecar (`grupo_miembro`), sin la linea. En un
    directo, la persona del otro lado. El nombre es el del ultimo mensaje que mando o, si
    no mando ninguno, el de su directo; el telefono, el de su propio jid o el del par
    LID-telefono, y si no hay par, null. `wa_admin` es lo que dice WhatsApp, no el rol del
    plugin. Un almacen de antes de la tabla no tiene miembros, y eso no es un error."""
    libreta = libreta or _Libreta(con, cuenta)
    if not es_grupo:
        jid = jid_sin_dispositivo(chat_jid)
        return [] if not jid or libreta.propio(jid) else [libreta.fila(jid, False)]
    try:
        filas = con.execute("select member_jid, admin from grupo_miembro where account = ? "
                            "and chat_jid = ?", (cuenta, chat_jid)).fetchall()
    except sqlite3.Error:
        return []
    salida = [libreta.fila(r["member_jid"], r["admin"]) for r in filas
              if not libreta.propio(r["member_jid"])]
    return sorted(salida, key=lambda f: ((f["name"] or "").lower() or "\uffff", f["id"]))


def miembros_de_grupos(con, cuenta, jids):
    """`{jid: [{id, name, phone, wa_admin}]}` de varios grupos de una linea, con UNA lectura
    de los nombres: es lo que `wa-scope sync` lleva al panel (`groupMembers`)."""
    libreta = _Libreta(con, cuenta)
    return {jid: miembros(con, cuenta, jid, True, libreta) for jid in jids}


def chats_propios(con):
    """{(cuenta, (usuario, servidor)): nombre de la linea} con el LID y el telefono de
    cada linea: son los jids de su chat consigo misma."""
    propios = {}
    try:
        filas = con.execute("select account, lid, pn, name from linea").fetchall()
    except sqlite3.Error:
        return propios
    for f in filas:
        for jid in (f["lid"], f["pn"]):
            if jid:
                propios[(f["account"], usuario_de(jid))] = f["name"] or ""
    return propios


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


def desde_donde(con, fila, despues=None):
    """El punto de partida de `wa-read wait` en una conversacion: lo que llegue despues de
    esto es nuevo. Sin `despues`, lo ultimo que ya esta guardado: se espera lo que llegue
    a partir de ahora. Con el id de un mensaje de ESTE chat, lo posterior a ese mensaje.
    Con un numero, lo posterior a ese instante (segundos de epoch). Otra cosa sale con el
    motivo: esperar desde un mensaje que no es de este chat es esperar desde nada."""
    if despues is None:
        fila_max = con.execute(
            "select max(rowid) from mensaje where account = ? and chat_jid = ?",
            (fila["account"], fila["chat_jid"])).fetchone()
        return {"rowid": fila_max[0] or 0}
    propio = con.execute(
        "select rowid, ts from mensaje where account = ? and chat_jid = ? and stanza_id = ?",
        (fila["account"], fila["chat_jid"], despues)).fetchone()
    if propio:
        return {"ts": propio["ts"], "rowid": propio["rowid"]}
    # Lo que `wa-send` acaba de mandar y cuyo eco todavia no guardo el sidecar (T18): quien
    # pregunta y enseguida espera la respuesta pasa el stanza que le devolvio el envio, y
    # negarse ahi es una carrera que pierde siempre. Vale desde que salio, el mismo segundo
    # incluido (`rowid` 0): una respuesta no llega antes que la pregunta.
    try:
        enviado = con.execute(
            "select coalesce(settled_at, created_at) ts from envio where account = ? "
            "and chat_jid = ? and stanza_id = ?",
            (fila["account"], fila["chat_jid"], despues)).fetchone()
    except sqlite3.Error:
        enviado = None
    if enviado and enviado["ts"] is not None:
        return {"ts": enviado["ts"], "rowid": 0}
    if str(despues).isdigit():
        return {"ts": int(despues)}
    sys.exit(f"no message {despues!r} in {nombre_de(fila)!r}: --after takes the stanza_id "
             f"of a message of that chat, or a time in epoch seconds")


def nuevos(con, fila, base):
    """Los mensajes de la OTRA persona que llegaron despues de `base` (`desde_donde`), del
    mas viejo al mas nuevo. Lo propio no cuenta: quien espera una respuesta no la recibe
    en lo que acaba de mandar. Lo borrado tampoco.

    En el chat de la linea consigo misma (el del dueno, T22.1) todo llega como propio,
    tambien lo que el dueno escribe desde su telefono. Ahi "lo propio" es lo que mando la
    linea, que esta en la bandeja de salida con su stanza; lo demas es la respuesta (T18)."""
    if "ts" in base:
        corte = "and (m.ts > ? or (m.ts = ? and m.rowid > ?))"
        args = [base["ts"], base["ts"], base.get("rowid", 1 << 62)]
    else:
        corte = "and m.rowid > ?"
        args = [base["rowid"]]
    otro = "m.from_me = 0"
    if (fila["account"], usuario_de(fila["chat_jid"])) in chats_propios(con):
        otro = ("(m.from_me = 0 or m.stanza_id not in (select e.stanza_id from envio e "
                "where e.account = m.account and e.stanza_id is not null))")
    filas = con.execute(
        f"""select m.stanza_id, m.ts, m.from_me, m.sender_name, m.sender_jid, m.body,
                   m.media_path
            from mensaje m
            where m.account = ? and m.chat_jid = ? and m.revocado = 0 and {otro}
                  {corte}
            order by m.ts, m.rowid""",
        [fila["account"], fila["chat_jid"]] + args).fetchall()
    return [{"date": ts(r["ts"]), "ts": r["ts"], "stanza_id": r["stanza_id"],
             "chat": nombre_de(fila), "chat_id": fila["id"], "chat_jid": fila["chat_jid"],
             "account": fila["account"], "sender": quien(r),
             "text": (r["body"] or "").replace("\n", " "), "media": r["media_path"] or None}
            for r in filas]


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


def reclaves():
    """Las re-claves de `local` al numero de su linea (T9), de la mas vieja a la mas
    nueva, o []. Las anota el sidecar en capture.db (`reclavarLocal`); `wa-scope` las
    lee de aca para mover lo suyo al MISMO numero, y el doctor las muestra. Solo
    lectura, y sin `abrir()` por lo mismo que `ultima_migracion`."""
    ruta = store_db_path()
    if not os.path.exists(ruta):
        return []
    try:
        con = sqlite3.connect(f"file:{ruta}?mode=ro", uri=True, timeout=5)
        con.row_factory = sqlite3.Row
        filas = con.execute("select at, desde, hacia, chats, mensajes from reclave "
                            "order by at, rowid").fetchall()
        con.close()
    except sqlite3.Error:
        return []
    return [dict(r) for r in filas]


def reclave_pendiente():
    """Lo de antes de T9 que el sidecar NO pudo atribuir con certeza a un numero, o None.

    Lo anota el sidecar (`resolverLocal`) cuando la evidencia no alcanza —por ejemplo,
    la fila `local` de `linea` pisada por otro numero—: no mueve nada y espera la
    decision del dueno. Trae solo cuantas conversaciones y mensajes y por que."""
    ruta = store_db_path()
    if not os.path.exists(ruta):
        return None
    try:
        con = sqlite3.connect(f"file:{ruta}?mode=ro", uri=True, timeout=5)
        fila = con.execute(
            "select value from store_meta where key='reclave_pendiente'").fetchone()
        con.close()
        datos = json.loads(fila[0]) if fila and fila[0] else None
    except (sqlite3.Error, ValueError, TypeError):
        return None
    return datos if isinstance(datos, dict) else None


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
