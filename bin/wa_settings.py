"""Los ajustes efectivos del plugin, en un solo lugar para las dos herramientas.

Existe porque estaban en dos: `wa-scope` mezclaba lo que el panel guarda con lo que
tiene su base, y `wa-read` leia solo la base. Las dos contestaban distinto sobre el
MISMO ajuste — el panel guardaba un valor, `wa-scope config` lo confirmaba, y la
herramienta que de verdad lo usaba seguia con el valor viejo. Cambiarlo en el panel no
cambiaba nada y no lo decia nadie. Por eso un ajuste se agrega en UN lugar: el que se
suma a la mitad de las tres tablas de abajo es el mismo defecto otra vez.

El panel manda sobre la base: es lo que el usuario acaba de tocar. La base es la via de
la terminal, y `wa-scope config` la mantiene espejada hacia el panel en cada escritura.
"""
import json
import re
import os
import shutil
import socket
import sqlite3
import sys

# El prefijo "orca-" no es decorativo: la identidad oficial de un plugin se calcula
# como <publisher>.<prefijo><resto>. El nombre viejo se sigue leyendo para no perder
# lo ya guardado.
PLUGIN_ID = "ab2web.orca-wa-inbox"
PLUGIN_ID_ANTERIOR = "ab2web.wa-inbox"


RUNTIME_FILE = "orca-runtime.json"

# Nombres con los que Orca ha guardado su userData. NO son la regla: son por donde se
# mira primero. El nombre lo decide como se empaqueto —la app publicada de Linux usa
# `orca-ide`, la de macOS `orca`— asi que ademas se descubre, o la lista fija deja
# afuera la instalacion del proximo usuario.
NOMBRES_USER_DATA = ("orca", "orca-ide", "orca-dev", "zzorcanametest")


def user_data_base(env=None, sistema=None):
    """La carpeta donde Electron pone los userData de esta maquina.

    `sistema` existe para poder probar las tres formas desde una sola maquina: el
    defecto que esto arregla es de Linux y aca no hay ninguna Linux donde correrlo."""
    env = os.environ if env is None else env
    sistema = sistema or sys.platform
    if sistema.startswith("darwin"):
        return os.path.expanduser("~/Library/Application Support")
    if sistema.startswith("win"):
        return env.get("APPDATA") or os.path.expanduser("~/AppData/Roaming")
    return env.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")


def user_data_roots(env=None, sistema=None):
    """Los userData que esta maquina podria tener, del mas probable al menos.

    Tenerlo fijo a la ruta de macOS hacia que en Windows y Linux el panel y el CLI
    leyeran archivos distintos y pareciera que nada se guarda. Tenerlo fijo a una
    LISTA DE NOMBRES hacia lo mismo en Linux, donde la app publicada guarda en
    `orca-ide`: por eso, ademas de los conocidos, se descubre cualquier carpeta que
    tenga adentro un runtime o datos de plugins."""
    env = os.environ if env is None else env
    base = user_data_base(env, sistema)
    salida = []
    # ORCA_USER_DATA_PATH NO entra aca a proposito: apunta al userData del Orca que
    # esta corriendo y la exporta cada terminal de Orca, asi que meterla en la busqueda
    # del ALMACEN hacia que un chequeo con HOME de mentira leyera los ajustes reales del
    # usuario — se vio: once casos rojos por su configuracion, no por el codigo. Para
    # encontrar el runtime si manda, y eso vive en orca_runtime_home().
    for nombre in NOMBRES_USER_DATA:
        ruta = os.path.join(base, nombre)
        if ruta not in salida:
            salida.append(ruta)
    try:
        for nombre in sorted(os.listdir(base)):
            ruta = os.path.join(base, nombre)
            if ruta in salida or not os.path.isdir(ruta):
                continue
            if (os.path.exists(os.path.join(ruta, RUNTIME_FILE))
                    or os.path.isdir(os.path.join(ruta, "plugins-data"))):
                salida.append(ruta)
    except OSError:
        pass
    return salida


def _transportes(ruta):
    """Los transportes anotados en el runtime de esa carpeta, o []. Se aceptan las dos
    formas del archivo: `transports` (hoy) y `transport` (Orca viejo)."""
    try:
        with open(os.path.join(ruta, RUNTIME_FILE), encoding="utf-8") as fh:
            meta = json.load(fh)
    except (OSError, ValueError):
        return []
    ts = meta.get("transports")
    if not isinstance(ts, list):
        uno = meta.get("transport")
        ts = [uno] if isinstance(uno, dict) else []
    return [t for t in ts if isinstance(t, dict) and t.get("endpoint")]


def transporte_vivo(transporte, timeout=0.25):
    """Si ese transporte CONTESTA. Es la unica prueba que sirve: un runtime.json de
    hoy puede apuntar a un socket muerto y uno de hace dos meses puede estar vivo, asi
    que la fecha no decide nada — a lo sumo desempata."""
    endpoint = str(transporte.get("endpoint") or "")
    if not endpoint:
        return False
    if transporte.get("kind") == "named-pipe":
        return os.path.exists(endpoint)
    if transporte.get("kind") == "websocket":
        # Un ws:// no se toca sin hablar su protocolo: no se afirma nada.
        return False
    familia = getattr(socket, "AF_UNIX", None)
    if familia is None:
        return False
    s = socket.socket(familia, socket.SOCK_STREAM)
    try:
        s.settimeout(timeout)
        s.connect(endpoint)
        return True
    except OSError:
        return False
    finally:
        s.close()


def orca_runtime_home(env=None, sistema=None):
    """El userData del Orca que esta contestando AHORA.

    Existe porque en Linux la CLI de Orca busca su runtime en `~/.config/orca` por
    defecto y la app publicada lo escribe en `~/.config/orca-ide`: con las dos
    carpetas presentes —una vieja, otra viva— la CLI tomaba la muerta y contestaba
    "Could not connect to the Orca Lab runtime transport from this shell". Aca no se
    adivina el nombre: se prueba cual contesta.

    Devuelve {"path": ruta|None, "tried": [...], "reachable": bool, "source": str}."""
    env = os.environ if env is None else env
    fijado = (env.get("ORCA_USER_DATA_PATH") or "").strip()
    if fijado:
        return {"path": fijado, "tried": [fijado], "reachable": None, "source": "env"}
    intentadas, vivas = [], []
    for ruta in user_data_roots(env, sistema):
        transportes = _transportes(ruta)
        if not transportes:
            continue
        intentadas.append(ruta)
        if any(transporte_vivo(t) for t in transportes):
            try:
                cuando = os.path.getmtime(os.path.join(ruta, RUNTIME_FILE))
            except OSError:
                cuando = 0
            vivas.append((cuando, ruta))
    if vivas:
        vivas.sort()
        return {"path": vivas[-1][1], "tried": intentadas, "reachable": True,
                "source": "probe"}
    # Sin ninguna viva no se fija nada: apuntar a una carpeta muerta es lo que ya
    # falla. Lo que si viaja es la lista, que es lo unico accionable para el usuario.
    return {"path": None, "tried": intentadas, "reachable": False, "source": "probe"}


# Donde mirar cuando el PATH del proceso no trae la CLI. El worker del plugin hereda
# un PATH recortado, y en Linux el instalador deja el binario en ~/.local/bin: buscarlo
# solo en el PATH hacia que el plugin dijera "la CLI de Orca no esta" con la CLI puesta.
DIRS_CLI = ("~/.local/bin", "/usr/local/bin", "/usr/bin", "/opt/homebrew/bin",
            "/snap/bin")


def orca_cli_path(env=None, sistema=None):
    """El binario de la CLI de Orca, resuelto a una ruta o None.

    En Linux `orca` es el lector de pantalla de GNOME: buscar ese nombre lo encuentra,
    el doctor dice que se puede enviar, y la primera corrida real le pone a hablar la
    maquina a una persona ciega. Ahi el binario es `orca-ide` y NO hay respaldo al
    nombre corto — mejor decir que falta que arrancar otro programa. Quien empaqueta
    fija el suyo con ORCA_CLI_COMMAND."""
    env = os.environ if env is None else env
    sistema = sistema or sys.platform
    declarado = (env.get("ORCA_CLI_COMMAND") or "").strip()
    if declarado:
        uno = declarado.split()[0]
        return shutil.which(uno, path=env.get("PATH")) or uno
    nombre = "orca-ide" if sistema.startswith("linux") else "orca"
    hallado = shutil.which(nombre, path=env.get("PATH"))
    if hallado:
        return hallado
    for d in DIRS_CLI:
        ruta = os.path.join(os.path.expanduser(d), nombre)
        if os.path.isfile(ruta) and os.access(ruta, os.X_OK):
            return ruta
    return None


def orca_env(env=None, sistema=None):
    """El env para un hijo que va a ejecutar la CLI de Orca.

    El worker del plugin arranca con un env filtrado por Orca y ORCA_USER_DATA_PATH no
    esta en la lista blanca, asi que heredarlo no es una opcion: se resuelve y se pasa.
    Medido en la maquina del usuario: /proc/<pid>/environ del worker traia PATH, HOME y
    nada mas."""
    env = os.environ if env is None else env
    hijo = dict(env)
    casa = orca_runtime_home(env, sistema)
    if casa["path"]:
        hijo["ORCA_USER_DATA_PATH"] = casa["path"]
    return hijo


def plugin_stores():
    return [os.path.join(r, "plugins-data", PLUGIN_ID, "storage.json")
            for r in user_data_roots()]


def plugin_stores_anteriores():
    """Solo para leer: si el usuario ya tenia alcance y tono guardados con el nombre
    anterior, renombrar el plugin no puede parecer que se borro todo."""
    return [os.path.join(r, "plugins-data", PLUGIN_ID_ANTERIOR, "storage.json")
            for r in user_data_roots()]


# La casa del Orca vivo, por proceso: plugin_store_raw() se llama decenas de veces por
# comando y cada sondeo abre el socket del runtime. La llave es lo que la decide.
_CASA_VIVA = {}


def userdata_del_orca_vivo():
    """El userData del Orca que corre, si es uno de los de esta maquina; si no, None.

    Solo cuenta si esta entre user_data_roots(): ORCA_USER_DATA_PATH lo exporta cada
    terminal de Orca, y aceptarlo fuera de esa lista haria que un chequeo con HOME de
    mentira leyera los ajustes reales del usuario."""
    raices = user_data_roots()
    llave = (os.environ.get("ORCA_USER_DATA_PATH") or "", tuple(raices))
    if llave not in _CASA_VIVA:
        casa = orca_runtime_home()["path"]
        reales = {os.path.realpath(r): r for r in raices}
        _CASA_VIVA[llave] = reales.get(os.path.realpath(casa)) if casa else None
    return _CASA_VIVA[llave]


def plugin_store_path():
    """De donde se LEE. El nombre nuevo manda siempre: mezclar por fecha dejaba el
    CLI escribiendo en la ruta nueva y leyendo de la vieja, asi que un ajuste
    guardado no se veia nunca. El anterior solo entra si el nuevo no existe.

    Entre los userData manda el del Orca que corre, y sin uno conocido un orden fijo
    con orca primero. Nunca la fecha: cada escritura de Python toca TODOS los destinos,
    asi que el mas nuevo podia ser el de orca-dev, sin las claves del panel, y el sync
    reexportaba los avisos de Orca apagados."""
    vivo = userdata_del_orca_vivo()
    for rutas in (plugin_stores(), plugin_stores_anteriores()):
        existing = [p for p in rutas if os.path.exists(p)]
        if not existing:
            continue
        for p in existing:
            if vivo and os.path.dirname(os.path.dirname(os.path.dirname(p))) == vivo:
                return p
        return existing[0]
    return plugin_stores()[0]


def plugin_store_targets():
    """Escribe en TODOS los userData que existan (orca, orca-dev, ...). Si el usuario
    trabaja en el build dev y solo escribieramos en el de produccion, el panel abriria
    vacio y pareceria que no se guardo nada."""
    out = []
    for path in plugin_stores():
        userdata = os.path.dirname(os.path.dirname(os.path.dirname(path)))
        if os.path.isdir(userdata):
            out.append(path)
    # Y tambien donde ya habia datos con el nombre anterior: si el usuario todavia
    # corre un Orca que carga el plugin viejo, su panel tiene que seguir al dia.
    for path in plugin_stores_anteriores():
        if os.path.exists(path):
            out.append(path)
    return out or [plugin_stores()[0]]


def plugin_store_raw():
    try:
        with open(plugin_store_path(), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


# Varias lineas a la vez: las claves del storage que son de UNA linea. La principal las
# tiene en la raiz, como siempre; cada otra linea, aparte, para que nunca pise las de la
# principal (el alcance es un permiso: pisarlo es abrir o cerrar la conversacion
# equivocada). Las demas claves —ajustes, nombre del agente, decisiones, que ya dicen su
# `account`— son de todas.
#
# Aparte quiere decir tres lugares y no uno: el alcance de cada linea en
# `alcancePorLinea[<cuenta>]` (lo escribe tambien el panel, y asi no pisa nada mas), los
# informes en `informesPorLinea[<cuenta>]` (son la clave mas grande y el panel los lee solo
# con su pestana), y lo demas en `porLinea[<cuenta>][<clave>]`. `lineas` no: esa es la
# lista de lineas que escribe el worker.
CLAVES_DE_LINEA = ("scope", "activity", "health", "board", "reports", "chats",
                   "chatsAccount", "senders", "groupMembers")
CONTENEDOR_PROPIO = {"scope": "alcancePorLinea", "reports": "informesPorLinea"}
CONTENEDOR_DE_LINEA = "porLinea"
CONTENEDORES = (CONTENEDOR_DE_LINEA, *CONTENEDOR_PROPIO.values())


def de_otra_linea(cuenta, principal):
    """Si `cuenta` es una linea que NO es la principal (con una sola linea, nunca)."""
    return bool(cuenta) and bool(principal) and cuenta != principal


def _contenedor(datos, nombre, crear=False):
    valor = datos.get(nombre)
    if isinstance(valor, dict):
        return valor
    if crear:
        datos[nombre] = {}
        return datos[nombre]
    return {}


def valor_de_linea(datos, cuenta, clave):
    """(hay, valor) de una clave de linea de otra linea, en el lugar que le toca."""
    if clave in CONTENEDOR_PROPIO:
        contenedor = _contenedor(datos, CONTENEDOR_PROPIO[clave])
        return cuenta in contenedor, contenedor.get(cuenta)
    propio = _contenedor(datos, CONTENEDOR_DE_LINEA).get(cuenta)
    propio = propio if isinstance(propio, dict) else {}
    return clave in propio, propio.get(clave)


def vista_de_linea(datos, cuenta, principal):
    """El storage como lo ve la linea `cuenta`: la raiz para la principal; para otra, las
    claves globales de la raiz con las suyas encima."""
    if not de_otra_linea(cuenta, principal):
        return datos
    vista = {k: v for k, v in datos.items() if k not in CLAVES_DE_LINEA and k not in CONTENEDORES}
    for clave in CLAVES_DE_LINEA:
        hay, valor = valor_de_linea(datos, cuenta, clave)
        if hay:
            vista[clave] = valor
    return vista


def escribir_en_linea(datos, cambios, cuenta, principal):
    """Aplica `cambios` al storage de la linea `cuenta`: las claves de linea de otra linea
    van a su lugar aparte, y lo demas a la raiz."""
    if not de_otra_linea(cuenta, principal):
        datos.update(cambios)
        return datos
    for clave, valor in cambios.items():
        if clave not in CLAVES_DE_LINEA:
            datos[clave] = valor
        elif clave in CONTENEDOR_PROPIO:
            _contenedor(datos, CONTENEDOR_PROPIO[clave], crear=True)[cuenta] = valor
        else:
            de_lineas = _contenedor(datos, CONTENEDOR_DE_LINEA, crear=True)
            if not isinstance(de_lineas.get(cuenta), dict):
                de_lineas[cuenta] = {}
            de_lineas[cuenta][clave] = valor
    return datos


def tableros_de_lineas(datos):
    """Los tableros de las lineas que no son la principal, para la insignia de todas."""
    return [propio.get("board") for propio in _contenedor(datos, CONTENEDOR_DE_LINEA).values()
            if isinstance(propio, dict)]


def alcances_de_lineas(datos):
    """Los alcances del panel de las lineas que no son la principal: `[(cuenta, {jid:
    entrada})]`. Quien escribe (`wa-send`) los cruza todos, cada uno con su cuenta."""
    return [(cuenta, alcance) for cuenta, alcance
            in _contenedor(datos, CONTENEDOR_PROPIO["scope"]).items() if isinstance(alcance, dict)]


# El panel solo sabe escribir storage, y lo hace con claves planas. Traducirlas a
# los nombres de settings es lo que evita que un tono guardado ahi no llegue nunca.
PANEL_SETTINGS = {"tone": "tone", "agentName": "agent_name",
                  "transcribeQuality": "transcribe_quality",
                  # La ventana de lectura vivia solo en la terminal: desde el panel era
                  # un tope escondido, y una mencion del viernes desaparecia el lunes
                  # sin que nada lo dijera. Un limite invisible es peor que uno visible.
                  "inboxDays": "inbox_days",
                  "ownerName": "owner_name",
                  "transcribe": "transcribe",
                  "transcribeLang": "transcribe_lang",
                  # Cada cuanto el worker relee WhatsApp. Sale al panel porque es lo
                  # que acota cuanto puede tardar un mensaje en aparecer: el precheck
                  # contesta sobre el ultimo sync, asi que si esto fuera una constante
                  # escondida el retraso tambien lo seria.
                  "syncMinutes": "sync_minutes",
                  # Respuestas automaticas del motor: el acuse de recibo a un pedido nuevo
                  # y el saludo a un saludo. El valor de una conversacion pisa estos.
                  "ackMode": "ack", "ackText": "ack_text",
                  # Cuantos minutos despues de que la linea escribio en un chat el acuse ya
                  # no sale ahi: no cae en medio de una conversacion (decision c del dueno).
                  "ackQuietMinutes": "ack_quiet_minutes",
                  "greetingMode": "greeting", "greetingText": "greeting_text",
                  # Con que cuenta de Claude abre el bot sus agentes (el de casos y el de
                  # cada proyecto): un id de `orca account list`, o `auto`.
                  "botClaudeAccount": "bot_claude_account",
                  # La meta del primer contacto de los informes, en minutos: un caso cumple
                  # si su primera respuesta salio dentro de este plazo (informes-tablero, I4).
                  "slaMinutes": "sla_first_reply_minutes",
                  # Cuantas horas espera una pregunta "A o B?" al que escribio antes de pasar
                  # al dueno (proyectos-por-chat, M5).
                  "projectQuestionHours": "project_question_hours"}

# El primer mensaje (Beta): quien lo escribe y el ritmo de los avances del agente. Viaja en
# UNA clave del panel con sus cuatro valores, y no en cuatro claves planas: el host admite
# 30 mensajes por 10 s y cada clave es una lectura y una escritura mas contra ese cupo.
PANEL_PRIMER = "firstReply"
PANEL_PRIMER_CAMPOS = {"mode": "first_reply_mode", "fallbackMinutes": "ack_fallback_minutes",
                       "everyMinutes": "update_every_minutes", "max": "updates_max"}
# `ack` es el acuse fijo de siempre; los otros dos los escribe el agente (Beta).
MODOS_PRIMER = ("ack", "model", "model_with_ack_fallback")

# Los avisos de Orca por WhatsApp (odd/tasks/avisos-orca.md): un agente que espera, uno que
# termino y una automatizacion que fallo, al numero de aprobacion. Viajan en UNA clave del
# panel, como el primer mensaje, por el mismo cupo del host. Todo apagado de fabrica.
PANEL_ORCA = "orcaNotices"
PANEL_ORCA_CAMPOS = {"waiting": "orca_notice_waiting", "finished": "orca_notice_finished",
                     "automationFailed": "orca_notice_automation",
                     "quietStart": "orca_quiet_start", "quietEnd": "orca_quiet_end",
                     "hourlyCap": "orca_notice_hourly_cap",
                     "finishedDelaySeconds": "orca_finished_delay_s"}
# Las horas de silencio, en hora local de la maquina: `HH:MM` de 24 horas, o vacio. Vaciar
# una es una eleccion (quita el silencio), no un valor que falta.
CONFIG_HORAS = ("orca_quiet_start", "orca_quiet_end")
HORA_LOCAL = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

# Lo que cada ajuste acepta. Un valor invalido no revienta al guardarse: revienta
# despues, en la corrida del agente, lejos de donde se tipeo — o peor, no revienta y
# transcribe en el idioma equivocado sin decirlo.
CONFIG_OPCIONES = {
    # local no manda el audio a ningun lado. off apaga la transcripcion. `api` se
    # ofrecia y no existe: wa-transcribe sale con "not implemented yet" en cada audio,
    # asi que elegirlo solo podia apagar la transcripcion sin decirlo.
    "transcribe": ("local", "off"),
    "transcribe_quality": ("optima", "minima"),
    # Solo los idiomas que el panel ofrece y con los que se probo. Un codigo sin probar
    # degrada la transcripcion en silencio, y eso se descubre tres audios despues.
    "transcribe_lang": ("auto", "es", "en", "pt"),
    "ack": ("on", "off"),
    "greeting": ("on", "off"),
    "first_reply_mode": MODOS_PRIMER,
    "orca_notice_waiting": ("on", "off"),
    "orca_notice_finished": ("on", "off"),
    "orca_notice_automation": ("on", "off"),
}
CONFIG_NUMERICOS = ("inbox_days", "lock_ttl_s", "sync_minutes",
                    "capture_max", "capture_days", "case_window_hours", "approval_hours",
                    "ack_fallback_minutes", "update_every_minutes", "updates_max",
                    "sla_first_reply_minutes", "project_question_hours",
                    "ack_quiet_minutes", "orca_notice_hourly_cap", "orca_finished_delay_s")
# Los numericos con un rango cerrado. Un respaldo de cero minutos es el acuse fijo de
# siempre con otro nombre, y uno de un dia deja al cliente sin nada; un tope de avances
# de cien es un cliente con el telefono sonando.
CONFIG_RANGOS = {"ack_fallback_minutes": (1, 60), "update_every_minutes": (1, 120),
                 "updates_max": (1, 10),
                 # Una meta de cero minutos la incumple todo caso; una de mas de un dia ya no
                 # es una meta de primer contacto.
                 "sla_first_reply_minutes": (1, 1440),
                 # Cero apaga el silencio del acuse (no se mira lo que la linea escribio); mas
                 # de cuatro horas ya no es una conversacion en curso, es un cliente que vuelve.
                 "ack_quiet_minutes": (0, 240),
                 # Un tope de cero no avisa nunca; mas de uno por minuto ya no es un aviso.
                 "orca_notice_hourly_cap": (1, 60),
                 # Menos de diez segundos avisa de cada pausa entre dos turnos; mas de diez
                 # minutos ya no es "termino", es una noticia vieja.
                 "orca_finished_delay_s": (10, 600)}
# Los numericos que ademas tienen que ser mayores que cero. Una ventana de agrupacion de
# cero horas no agrupa nunca: abre una tarjeta por mensaje sin decir por que. Un aviso de
# aprobacion que vence a las cero horas no se podria contestar nunca (T14).
CONFIG_POSITIVOS = ("case_window_hours", "approval_hours", "project_question_hours")


# Un id (o correo) de cuenta de `orca account list`: viaja como argumento a la CLI de Orca.
CUENTA_CLAUDE = re.compile(r"^(auto|[A-Za-z0-9][A-Za-z0-9._@+:-]{0,199})$")


def valida_ajuste(key, value):
    """Devuelve el motivo del rechazo, o None si el valor sirve."""
    if key == "bot_claude_account" and not CUENTA_CLAUDE.match(str(value)):
        return f"{key} has to be auto or the id of an account from `orca account list`"
    if key in CONFIG_HORAS and str(value).strip() and not HORA_LOCAL.match(str(value).strip()):
        return f"{key} has to be a 24-hour time like 22:00, or empty"
    if key in CONFIG_OPCIONES and value not in CONFIG_OPCIONES[key]:
        return f"{key} only accepts: {', '.join(CONFIG_OPCIONES[key])}"
    if key in CONFIG_NUMERICOS:
        try:
            numero = int(str(value).strip())
        except (TypeError, ValueError):
            return f"{key} has to be a whole number, not {value!r}"
        if key in CONFIG_POSITIVOS and numero <= 0:
            return f"{key} has to be greater than zero, not {value!r}"
        if key in CONFIG_RANGOS and not (CONFIG_RANGOS[key][0] <= numero
                                         <= CONFIG_RANGOS[key][1]):
            return (f"{key} has to be between {CONFIG_RANGOS[key][0]} and "
                    f"{CONFIG_RANGOS[key][1]}, not {value!r}")
    return None


def settings_from_plugin():
    """Los ajustes que el panel dejo en sus claves planas, con el nombre del CLI. Una
    cadena vacia no es una eleccion: se ignora para no pisar el valor del CLI.

    Lo invalido tambien se ignora: el panel escribe en el store del host sin pasar por
    aca, asi que este es el unico lugar donde un valor sucio puede dejar de llegarle al
    agente. Ignorarlo lo deja con el valor del CLI, que es una eleccion real."""
    raw = plugin_store_raw()
    out = {}
    for flat, name in PANEL_SETTINGS.items():
        value = raw.get(flat)
        if isinstance(value, str) and value.strip() and not valida_ajuste(name, value):
            out[name] = value
    # El primer mensaje viene agrupado; cada valor se valida solo, igual que los planos.
    primer = raw.get(PANEL_PRIMER)
    for campo, name in (PANEL_PRIMER_CAMPOS.items() if isinstance(primer, dict) else ()):
        value = primer.get(campo)
        if isinstance(value, bool) or not isinstance(value, (str, int)):
            continue
        value = str(value).strip()
        if value and not valida_ajuste(name, value):
            out[name] = value
    # Los avisos de Orca, igual; aca una hora vacia si vale: el dueno quito el silencio.
    orca = raw.get(PANEL_ORCA)
    for campo, name in (PANEL_ORCA_CAMPOS.items() if isinstance(orca, dict) else ()):
        value = orca.get(campo)
        if isinstance(value, bool) or not isinstance(value, (str, int)):
            continue
        value = str(value).strip()
        if (value or name in CONFIG_HORAS) and not valida_ajuste(name, value):
            out[name] = value
    return out


def scope_from_plugin():
    """El alcance que el panel dejo en su almacen: `{jid: {chatName, mode, ...}}`.

    Vive aca por la misma razon que `ajuste()`: el panel es lo que el usuario acaba de
    tocar y manda sobre la base, y tener ese cruce copiado en cada CLI es como nacio el
    defecto del nombre del agente — `wa-scope` veia lo del panel y quien escribe no.
    `merged_scope` de wa-scope lee este mismo archivo.

    Un store ilegible o con otra forma devuelve `{}`: no saber que dice el panel no
    puede ABRIR permisos, solo dejarlos como los tenga la base."""
    alcance = plugin_store_raw().get("scope")
    return alcance if isinstance(alcance, dict) else {}


def scope_db():
    """El registro del plugin. Estaba escrito en cada CLI por separado."""
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or os.path.expanduser("~/AppData/Roaming")
        return os.path.join(base, "wa-inbox", "scope.db")
    return os.path.expanduser("~/.wa-inbox/scope.db")


# La llave del aprobador (approve-solo-dueno): la que separa la aprobacion del dueno —el
# tablero, o su respuesta por WhatsApp— de la de un agente. La escribe SOLO
# `aprobador.mjs` (el worker la pide ahi); aca solo se lee. Viaja a `wa-send --approve` en
# esta variable, y solo al env de ese hijo.
VARIABLE_APROBADOR = "WA_INBOX_APPROVER"
_LLAVE_APROBADOR = re.compile(r"^[0-9a-f]{64}$")


def ruta_llave_aprobador():
    """`approver.key`, junto a `scope.db`: la misma carpeta que `rutaLlave` de aprobador.mjs."""
    return os.path.join(os.path.dirname(scope_db()), "approver.key")


def llave_aprobador():
    """La llave del aprobador, o None si no hay una valida. Nunca la crea."""
    try:
        with open(ruta_llave_aprobador(), encoding="utf-8") as fh:
            texto = fh.read().strip()
    except OSError:
        return None
    return texto if _LLAVE_APROBADOR.match(texto) else None


def trae_llave_aprobador(env=None):
    """Si este proceso recibio la llave del plugin en su env: lo pide el tablero o la
    respuesta del dueno por WhatsApp, no un agente. Sin archivo no hay con que comparar, y
    eso es un no: la llave la crea el plugin, no las CLIs."""
    import hmac
    env = os.environ if env is None else env
    dada = env.get(VARIABLE_APROBADOR) or ""
    propia = llave_aprobador()
    return bool(dada and propia) and hmac.compare_digest(dada.encode(), propia.encode())


def ajuste(key, fallback=None):
    """El valor efectivo de un ajuste: el panel y la base del CLI, en ese orden.

    El panel manda sobre la base porque es lo que el usuario acaba de tocar. Vive aca
    porque tenerlo copiado es como nacio el defecto: `wa-send` se habia quedado con su
    lector privado de la base, asi que el nombre del agente puesto desde el panel lo
    veia `wa-scope` y no lo veia quien escribe.

    Sin `fallback` el valor sale tal cual; con uno, convertido a su tipo — un valor que
    no se puede convertir se ignora y se pasa a la fuente siguiente.
    """
    def convertido(valor):
        if fallback is None:
            return valor
        try:
            return type(fallback)(valor)
        except (TypeError, ValueError):
            return None

    try:
        del_panel = settings_from_plugin().get(key)
    except Exception:                     # noqa: BLE001 - un store ilegible no manda
        del_panel = None
    if del_panel not in (None, "") and (v := convertido(del_panel)) is not None:
        return v
    try:
        con = sqlite3.connect(f"file:{scope_db()}?mode=ro", uri=True)
        row = con.execute("select value from settings where key=?", (key,)).fetchone()
        con.close()
        if row and row[0] not in (None, "") and (v := convertido(row[0])) is not None:
            return v
    except Exception:                     # noqa: BLE001 - sin registro manda el default
        pass
    return fallback


def duenos():
    """Los remitentes de confianza que el dueno eligio en ajustes (T22.1): sus ids tal
    como WhatsApp los deja en el almacen (`<usuario>@lid`, o `@s.whatsapp.net` si asi
    llegan), sin el dispositivo. Nunca un numero escrito a mano ni adivinado: el panel
    solo ofrece los que vio en las conversaciones.

    Viven en el almacen del plugin, por instalacion, en `owners`: `[{id, name}]`. Lo que
    no tiene forma de id se ignora: un valor sucio no puede volver dueno a nadie."""
    lista = plugin_store_raw().get("owners")
    salida = []
    for d in lista if isinstance(lista, list) else []:
        jid = d.get("id") if isinstance(d, dict) else None
        if not isinstance(jid, str) or "@" not in jid:
            continue
        usuario, _, servidor = jid.strip().partition("@")
        usuario = usuario.split(":")[0]
        if usuario and servidor and f"{usuario}@{servidor}" not in salida:
            salida.append(f"{usuario}@{servidor}")
    return salida


# Los idiomas en que sale un aviso por WhatsApp (T14). El panel guarda el suyo al elegir el
# numero: el motor no tiene otra forma de saber en que idioma trabaja el usuario.
IDIOMAS_AVISO = ("es", "en")


def numero_aprobacion():
    """El numero al que el plugin le escribe cuando un caso espera al dueno (T14), o None.

    Lo elige el usuario en ajustes entre SUS numeros de confianza: vale solo mientras siga
    en `duenos()`. Sacarlo de la lista apaga los avisos; nunca se adivina ni se escribe a
    mano. Sin numero elegido, el plugin se porta como antes."""
    jid = plugin_store_raw().get("approvalNumber")
    if not isinstance(jid, str) or "@" not in jid:
        return None
    usuario, _, servidor = jid.strip().partition("@")
    propio = f"{usuario.split(':')[0]}@{servidor}"
    return propio if propio in duenos() else None


def idioma_aprobacion():
    """`es` o `en`: el idioma del panel cuando se eligio el numero. Ingles si no se sabe."""
    idioma = plugin_store_raw().get("approvalLang")
    return idioma if idioma in IDIOMAS_AVISO else "en"
