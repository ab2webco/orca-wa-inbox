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
import sys

# El prefijo "orca-" no es decorativo: la identidad oficial de un plugin se calcula
# como <publisher>.<prefijo><resto>. El nombre viejo se sigue leyendo para no perder
# lo ya guardado.
PLUGIN_ID = "ab2web.orca-wa-inbox"
PLUGIN_ID_ANTERIOR = "ab2web.wa-inbox"


def user_data_roots():
    """Donde Electron guarda el userData, que cambia por sistema. Tenerlo fijo a la
    ruta de macOS hacia que en Windows y Linux el panel y el CLI leyeran archivos
    distintos y pareciera que nada se guarda."""
    if sys.platform == "darwin":
        base = os.path.expanduser("~/Library/Application Support")
    elif sys.platform == "win32":
        base = os.environ.get("APPDATA") or os.path.expanduser("~/AppData/Roaming")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return [os.path.join(base, d) for d in ("orca", "orca-dev", "zzorcanametest")]


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
