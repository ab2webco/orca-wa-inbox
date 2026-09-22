import json, os, sys
# Resuelve el bin del plugin sin confiar en PATH ni en el directorio actual.
#
# Este texto es la UNICA copia editable: scripts/check-resolver exige que las cinco
# copias publicadas (los dos precheck de orca-plugin.json, los dos de automations/ y el
# bloque de cada prompt) sean este mismo texto, caracter por caracter. No se puede
# importar: un precheck es una cadena de shell dentro de un JSON y un prompt es texto
# que lee un modelo, asi que se inlinea; lo que no se puede evitar se comprueba.
# Por eso mismo el texto no usa comillas dobles, ni pesos, ni comillas invertidas, ni
# contrabarras: el precheck lo mete entero dentro de un python3 -c entrecomillado en
# una linea de shell, y cualquiera de esos cuatro caracteres lo partiria ahi.
#
# Solo la identidad actual. La anterior, ab2web.wa-inbox, se dejo de mirar a proposito:
# esa build 3.0.1 manda WhatsApp conduciendo la app de escritorio por accesibilidad, un
# camino que este plugin borro y que wa-send hoy rechaza con send-no-transport.
# Resolver hacia alla no es correr una version vieja, es correr OTRO producto que hace
# justo lo que este se niega a hacer. Ya paso: el agente del dueno mando un mensaje de
# verdad por ese camino. Por eso no queda ni como ultimo recurso: sin candidatos WA sale
# vacio y el prompt para, que es el desenlace barato.
LLAVE = 'ab2web.orca-wa-inbox'
PERFILES = ('profiles/local-default/orca-data.json', 'orca-data.json')


def version(raiz):
    # Se ordena por la VERSION del manifiesto, no por la fecha del directorio. Ordenar
    # por getmtime hacia ganar a la copia instalada mas RECIENTEMENTE, que no es la mas
    # nueva: una 3.0.1 recien bajada le ganaba a una 3.13.0 de la semana pasada. Y se
    # comparan los componentes como numeros, nunca como texto, porque alfabeticamente
    # 3.13.0 va ANTES que 3.9.0.
    try:
        with open(os.path.join(raiz, 'orca-plugin.json')) as fh:
            crudo = json.load(fh).get('version') or ''
    except Exception:
        return None
    partes = []
    for pedazo in str(crudo).replace('-', '.').split('.'):
        if not pedazo.isdigit():
            break
        partes.append(int(pedazo))
    return tuple(partes + [0, 0, 0])[:3] if partes else None


def candidato(raiz):
    # Valido = manifiesto legible con version Y bin/ usable, la misma vara con la que
    # Orca decide si un plugin de desarrollo cuenta.
    b = os.path.join(raiz, 'bin')
    v = version(raiz)
    if not v or not os.path.isdir(b):
        return None
    # La fecha va de TERCERA y solo desempata entre dos copias de la MISMA version,
    # donde ya no puede confundir un producto viejo con uno nuevo.
    return (v, os.path.getmtime(b), b)


base = (os.path.expanduser('~/Library/Application Support') if sys.platform == 'darwin'
        else os.environ.get('APPDATA') or os.path.expanduser('~/.config'))
dev, instalados = [], []
for carpeta in (os.listdir(base) if os.path.isdir(base) else []):
    raiz = os.path.join(base, carpeta)
    # Instalado: plugins/<llave>/<hash>/, con el hash vivo en el archivo current.
    p = os.path.join(raiz, 'plugins', LLAVE)
    cur = os.path.join(p, 'current')
    if os.path.isfile(cur):
        c = candidato(os.path.join(p, open(cur).read().strip()))
        if c:
            instalados.append(c)
    # En desarrollo: la ruta que el usuario registro en los ajustes.
    for perfil in PERFILES:
        f = os.path.join(raiz, perfil)
        if not os.path.isfile(f):
            continue
        try:
            with open(f) as fh:
                ajustes = json.load(fh).get('settings') or {}
        except Exception:
            continue
        for ruta in ajustes.get('devPluginPaths') or []:
            c = candidato(ruta)
            if c:
                dev.append(c)
# Un dev valido gana de plano sobre cualquier instalado, sin comparar versiones: es el
# punto del modo desarrollo y es lo que hace el descubrimiento de Orca, que saca al
# instalado cuando el dev de la misma identidad es valido. Solo si ninguno califica se
# miran los instalados.
print(max(dev or instalados)[2] if (dev or instalados) else '')
