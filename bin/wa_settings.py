"""Los ajustes efectivos del plugin, en un solo lugar para las dos herramientas.

Existe porque estaban en dos: `wa-scope` mezclaba lo que el panel guarda con lo que
tiene su base, y `wa-read` leia solo la base. Las dos contestaban distinto sobre el
MISMO ajuste — el panel decia `read_web on`, `wa-scope config` lo confirmaba, y
`wa-read`, que es quien de verdad lee WhatsApp, seguia con la via web apagada. Cambiar
de donde lee en el panel no cambiaba nada y no lo decia nadie.

El panel manda sobre la base: es lo que el usuario acaba de tocar. La base es la via de
la terminal, y `wa-scope config` la mantiene espejada hacia el panel en cada escritura.
"""
import json
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


def plugin_store_path():
    """De donde se LEE. El nombre nuevo manda siempre: mezclar por fecha dejaba el
    CLI escribiendo en la ruta nueva y leyendo de la vieja, asi que un ajuste
    guardado no se veia nunca. El anterior solo entra si el nuevo no existe."""
    existing = [p for p in plugin_stores() if os.path.exists(p)]
    if existing:
        return max(existing, key=os.path.getmtime)
    viejos = [p for p in plugin_stores_anteriores() if os.path.exists(p)]
    if viejos:
        return max(viejos, key=os.path.getmtime)
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
                  "readLocal": "read_local",
                  # Cada cuanto el worker relee WhatsApp. Sale al panel porque es lo
                  # que acota cuanto puede tardar un mensaje en aparecer: el precheck
                  # contesta sobre el ultimo sync, asi que si esto fuera una constante
                  # escondida el retraso tambien lo seria.
                  "syncMinutes": "sync_minutes",
                  "readWeb": "read_web",
                  "readWebText": "read_web_text"}

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
    # De donde lee. Son dos interruptores y no una lista de tres porque las fuentes se
    # SUMAN: apagar la local en un equipo que la tiene es una eleccion real (leer solo
    # la linea de la empresa), y encender la web no apaga la del escritorio. Las dos
    # encendidas es el caso normal de un Mac con la app en el numero personal y una
    # sesion web en el del bot.
    "read_local": ("on", "off"),
    "read_web": ("on", "off"),
    # El TEXTO de los mensajes que trae la via web, que es una eleccion aparte de
    # leerla. `memoria` no abre ninguna conversacion y no marca nada como leido: lee el
    # cuerpo de lo que esa pestana ya tenia cargado y deja el marcador `[web:no-text]`
    # en lo demas. El modo que si abriria los chats no existe a proposito — abrir una
    # conversacion en WhatsApp Web la marca leida tambien en el telefono del usuario.
    "read_web_text": ("off", "memoria"),
}
CONFIG_NUMERICOS = ("inbox_days", "lock_ttl_s", "sync_minutes", "web_timeout_s",
                    "capture_max", "capture_days")


def valida_ajuste(key, value):
    """Devuelve el motivo del rechazo, o None si el valor sirve."""
    if key in CONFIG_OPCIONES and value not in CONFIG_OPCIONES[key]:
        return f"{key} only accepts: {', '.join(CONFIG_OPCIONES[key])}"
    if key in CONFIG_NUMERICOS:
        try:
            int(str(value).strip())
        except (TypeError, ValueError):
            return f"{key} has to be a whole number, not {value!r}"
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
    return out


def scope_db():
    """El registro del plugin. Estaba escrito en cada CLI por separado."""
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or os.path.expanduser("~/AppData/Roaming")
        return os.path.join(base, "wa-inbox", "scope.db")
    return os.path.expanduser("~/.wa-inbox/scope.db")


def ajuste(key, fallback=None, env_prefix=None):
    """El valor efectivo de un ajuste: entorno, panel y base del CLI, en ese orden.

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

    if env_prefix:
        forzado = os.environ.get(f"{env_prefix}{key.upper()}")
        if forzado and (v := convertido(forzado)) is not None:
            return v
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
