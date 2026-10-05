"""wa_reglas — the fixed floor of exceptions: money, credentials and commitments.

This is a FLOOR, not a classifier. The owner's model is that the assistant answers on
its own and asks the owner only for the exceptions: money, a credential, a reply that
promises a date or a delivery, a Jev flag or failure, and chats on `borrador`. Jev
judges the first three, but only when its key is set; without a key nothing detected
them, and a reply with a price could go out on a rule approval. This module closes
that gap with plain patterns that always run, with or without Jev.

How it is meant to be read:

  - It only ADDS. Its exceptions are unioned with Jev's, and nothing removes an
    exception already on a case. Jev, when on, refines by adding what this misses.
  - It is precise, not eager (T22.2). It used to lean to false positives on purpose,
    and the owner saw almost every hold of a day be one: a question with the word
    "fecha", "¿me mandas la URL?", a notice to himself. What it catches now is what the
    owner named: an amount or a price in what goes out, a value shaped like a secret or
    someone asking for a password, key, token or code, and a concrete date or time
    promised in what goes out (never in a question).
  - It returns only exception NAMES, the same identifiers as
    `wa_jev.ORDEN_EXCEPCIONES`, in that order. It never returns or logs the text that
    matched: a matched secret must not end up in an event or a log.
  - `money` and `commitment` apply only to what goes OUT (`salida`): a client asking
    for a price or for something by Friday is not the assistant quoting or promising it.
  - `secreto` is the destructive control: a secret-shaped value in what goes out is held
    whatever the chat's levels say, and also for the owner's own chats.

Spanish, English and Portuguese; accents and case do not matter. Python stdlib only.
"""
import json
import os
import re
import sys
import unicodedata

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wa_jev  # noqa: E402  (the credential patterns live there, once)

ENTRADA = "entrada"   # a message that came in
SALIDA = "salida"     # a reply about to go out (a proposal, or wa-send)
DIRECCIONES = (ENTRADA, SALIDA)

# What this floor can raise. `jev` (a Jev flag or failure) is Jev's alone.
EXCEPCIONES_PISO = ("money", "credential", "commitment")


def normaliza(texto):
    """Lowercase, without accents: "Cotización" and "cotizacion" are the same word."""
    descompuesto = unicodedata.normalize("NFKD", texto or "")
    return "".join(c for c in descompuesto if not unicodedata.combining(c)).lower()


def _palabras(*formas):
    """One regex that matches any of the forms as whole words."""
    return re.compile(r"\b(?:" + "|".join(formas) + r")\b")


# ── money (only what goes out) ───────────────────────────────────────────────────────
# T22.2: money is an AMOUNT or a PRICE in the reply, not a word. "le paso la cotizacion"
# or "we'll check the invoice" promise no figure, and holding them was a false positive.
# A client asking what something costs is not an exception either: the reply that
# answers with a figure is, and that is what this catches.
DINERO_SIMBOLO = re.compile(
    r"(?:r\$|us\$|[$€£])\s?\d|\d\s?(?:[$€£])")
DINERO_CODIGO = re.compile(
    r"\d(?:[\d.,]*\d)?\s?(?:k\s)?(?:mil\s|millon(?:es)?\s(?:de\s)?)?"
    r"(?:cop|usd|eur|mxn|brl|ars|clp|pen|gbp|cad|dolar(?:es)?|dollars?|euros?|pesos|"
    r"reais|reales|soles|bucks|lucas|palos)\b")
DINERO_MAGNITUD = re.compile(r"\b\d+(?:[.,]\d+)?\s?(?:mil|millon(?:es)?|lucas|palos)\b")
# A price word and a figure in the same sentence: "cuesta 50 al mes", "un descuento del
# 10%", "o orcamento fica em 1.200".
DINERO_PALABRA = _palabras(
    # es
    r"precios?", r"cuestan?", r"vale", r"valen", r"cobr\w*", r"pag(?:o|os|a|an|ar|amos)",
    r"factur\w*", r"descuentos?", r"cotiz\w*", r"tarifas?", r"valor(?:es)?",
    r"reembols\w*", r"deudas?", r"abon\w*", r"costos?", r"coste", r"presupuestos?",
    r"saldos?", r"honorarios", r"mensualidad(?:es)?", r"cuotas?", r"iva", r"total",
    # en
    r"prices?", r"pricing", r"priced", r"costs?", r"fees?", r"invoices?", r"quotes?",
    r"quoted", r"discounts?", r"refunds?", r"charged?", r"charges", r"budget",
    # pt
    r"precos?", r"custa", r"custos?", r"orcamentos?", r"faturas?", r"descontos?",
    r"pagamentos?", r"boletos?", r"cobranca")
CIFRA = re.compile(r"\d")
FRASES = re.compile(r"[^.!?\n]+[.!?]*")


def _dinero(t):
    if DINERO_SIMBOLO.search(t) or DINERO_CODIGO.search(t) or DINERO_MAGNITUD.search(t):
        return True
    return any(DINERO_PALABRA.search(f) and CIFRA.search(f) for f in FRASES.findall(t))


# ── credential ───────────────────────────────────────────────────────────────────────
# The value-shaped patterns are Jev's masking patterns, reused as they are: the text
# that would be masked before going to Jev is exactly a credential here.
CREDENCIAL_FORMA = (wa_jev.RE_LABELLED, wa_jev.RE_PREFIXED, wa_jev.RE_JWT, wa_jev.RE_PEM,
                    wa_jev.RE_QUERY_SECRET, wa_jev.RE_OTP)
# And asking for one, or naming one, without the value. T22.2: "acceso" alone, a URL or a
# link are not a credential, and "clave" only is one as a password ("la clave del
# panel"), not as "key" in "es clave que...".
CREDENCIAL_PALABRA = _palabras(
    r"contrasenas?", r"(?:la|las|tu|tus|su|sus|mi|mis|una|nueva|nuevas|esa|esta) claves?",
    r"claves? (?:de|del|para|es|son)", r"usuario y clave", r"passwords?", r"passwd",
    r"senhas?", r"pin", r"tokens?", r"credencial(?:es)?", r"credentials?", r"credenciais",
    r"otp", r"2fa", r"api[ _-]?keys?", r"apikey", r"secret", r"codigo de (?:verificacion|"
    r"verificacao|acceso|acesso|seguridad|seguranca)", r"verification code", r"access code",
    r"user(?:name)? and password",
    # orden-del-dueno: "rota las llaves", "las llaves filtradas", "rotate the keys". Una
    # llave sola (la de la casa) no lo es: solo la que se rota o la de la API, SSH o acceso.
    r"(?:rot\w*|regener\w*|revoc\w*|revok\w*) (?:(?:las|los|la|el|the|all|todas las|as|os|a|o) )?"
    r"(?:llaves|keys|claves|chaves|secrets?|secretos|credenciales|credentials)",
    r"llaves? (?:de (?:la )?api|de acceso|privadas?|secretas?|ssh|filtradas?)")


def _secreto(original, t):
    return any(p.search(original) or p.search(t) for p in CREDENCIAL_FORMA)


def secreto(texto):
    """If `texto` carries a value shaped like a secret (a password after its label, a
    token, a key, a one-time code). This is the destructive control of T22.1: no level of
    a chat and no owner turns it off in what goes out. Never returns the value."""
    original = texto or ""
    return bool(original.strip()) and _secreto(original, normaliza(original))


# ── commitment (only what goes out) ──────────────────────────────────────────────────
# T22.2: a CONCRETE date or time promised in the reply. The word "fecha", "te confirmo"
# or "para el" alone promise nothing, and a question ("¿te sirve el viernes?") asks.
_DIAS = (r"lunes|martes|miercoles|jueves|viernes|sabado|domingo|"
         r"monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
         r"segunda|terca|quarta|quinta|sexta")
_MESES = (r"enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|"
          r"octubre|noviembre|diciembre|january|february|april|june|july|august|"
          r"september|october|november|december|janeiro|fevereiro|maio|junho|"
          r"julho|setembro|outubro|novembro|dezembro")
_UNIDADES = (r"minutos?|horas?|dias?|semanas?|meses|mes|minutes?|hours?|days?|weeks?|"
             r"months?")
COMPROMISO = re.compile(
    r"\b(?:"
    r"manana|hoy|pasado manana|esta (?:tarde|noche|semana)|"
    r"(?:la )?(?:proxima|siguiente) semana|fin de semana|"
    r"tomorrow|today|tonight|this (?:afternoon|evening|week)|next week|eod|"
    r"end of (?:the )?(?:day|week)|"
    r"amanha|hoje|depois de amanha|esta (?:tarde|noite)|(?:a )?proxima semana|"
    r"(?:" + _DIAS + r")(?:-feira)?|"
    r"(?:" + _MESES + r")|"
    r"by (?:the end|end of|eod|tomorrow|tonight|today|next|this|(?:" + _DIAS + r")|\d)|"
    r"ate (?:amanha|hoje|o fim|o final|a proxima|o dia|(?:" + _DIAS + r")|\d)|"
    r"(?:en|in|within|em) (?:\d+|un|una|unos|unas|dos|tres|pocos|pocas|par de|a|an|"
    r"a few|um|uma|alguns|algumas) ?(?:" + _UNIDADES + r")|"
    r"a las \d|at \d"
    r")\b"
    # dd/mm, dd-mm-yyyy and clock times
    r"|(?<!\d)\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?(?!\d)"
    r"|\b\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.|hs|hrs)\b"
    r"|(?<!\d)\d{1,2}:\d{2}(?!\d)")
PREGUNTA = re.compile(r"\?\s*$|^\s*[¿?]")


def _compromiso(original):
    """A sentence that is not a question and names a concrete date or time. The original
    text is split, not the normalized one: "¿" survives only there."""
    for frase in FRASES.findall(original):
        if PREGUNTA.search(frase):
            continue
        if COMPROMISO.search(normaliza(frase)):
            return True
    return False


# ── Lo que se menciona sin pedirlo (orden-del-dueno) ─────────────────────────────────
# Las reglas juzgan hechos, no palabras. Caso vivo: el brief de "que hay pendiente" decia
# "nunca incluyas una credencial" y el trabajo espero el clic del dueno por "hay una
# credencial"; otro decia "no deploy", nombraba la rama fix/...-secret-leak y listaba lo
# pendiente ("production audit, deploy"), y espero por desplegar. Dos reglas, no una:
#   - Lo que se MENCIONA en un brief (una credencial, dinero, una fecha) se busca en
#     `sin_menciones`, que tapa con espacios (el largo no cambia) lo negado en su clausula
#     ("never include a credential", "da sin fecha ni precio"), "solo di que existe", los
#     identificadores (una rama, una ruta, una URL) y lo que se informa como pendiente.
#   - Lo DESTRUCTIVO (borrar, desplegar, forzar un push, pagar) falla seguro: solo se
#     descuenta el verbo sobre el que la negacion manda ("no deploy", "never delete", "do
#     not create, edit or delete"). "No olvides desplegar", "sin falta borra", "sin
#     preguntar borra" o "make sure nothing breaks before you deploy" siguen siendo la orden.
# Lo que SALE a un cliente no pasa por aca para el dinero y la fecha: una cifra o un dia en
# la respuesta es un hecho de la respuesta. Solo la palabra de una credencial negada ("nunca
# le pediremos su clave") se descuenta ahi. Un valor con forma de secreto NO pasa por aca:
# `_secreto` mira el texto entero, negado o no.

# Lo que parece una negacion y no lo es: "no dudes en X" y "no olvides X" son hacer X, "sin
# falta" es seguro, "no later than" pone un tope, "no hay problema" no niega lo que sigue, y
# el "no" portugues ante un dia, un mes o un medio es "en el". Se quita antes de buscarla.
AFIRMATIVAS = re.compile(
    r"\b(?:no (?:dudes?|duden|dudar) (?:en|de)|"
    r"no (?:(?:se )?(?:te|le|les|nos) )?olvid\w*(?: de)?|no se olvid\w*(?: de)?|"
    r"(?:no|nunca) (?:dejes?|dejen|deje) de|no solo|no solamente|sin falta|sin embargo|"
    r"sin problemas?|no (?:hay|habra) (?:ningun )?problemas?|no te preocupes|"
    r"no se preocupen?|"
    r"(?:don[\u2019']?t|do not|never|not to) (?:hesitate|forget)(?: to)?|not only|not just|"
    r"feel free to|no (?:later|more|less|sooner|earlier) than|no problems?|no worries|"
    r"nao (?:hesite|deixe|esqueca) (?:em|de)|nao (?:se )?esquec\w*(?: de)?|nao so|nao apenas|"
    r"sem falta|sem problemas?|nao se preocupe|"
    r"no(?= (?:dia|proximo|proxima|final|fim|inicio|comeco|sabado|domingo|email|e-mail|site|"
    r"app|aplicativo|link|portal|painel|sistema|celular|telefone|whatsapp|mes|ano|banco|"
    r"cartao|pix|endereco|servidor|ambiente|cadastro)\b))\b")
NEGACION = re.compile(
    r"\b(?:no|nunca|jamas|sin|ni|nada|ningun[oa]?|tampoco|evit\w*|prohib\w*|"
    r"never|not|cannot|without|nor|nothing|none|neither|avoid\w*|forbid\w*|"
    r"(?:don|doesn|didn|won|mustn|shouldn|can|isn|aren)[\u2019']?t|"
    r"nao|nem|sem|nenhum[a]?)\b")
# Una lista corta que sigue a la negacion por comas ("a credential, token or secret value")
# la hereda hasta su disyuncion; sin una, o con un segmento largo (otra frase, no un item),
# la coma corta ("hoy no puedo, manana lo tienes").
DISYUNCION = re.compile(r"\b(?:o|u|or|ni|nor|ou|nem|neither)\b")
PALABRAS_DE_ITEM = 6
# Lo que corta una clausula: un ": ", un "y"/"and"/"e", o un "pero", "luego", "then".
CORTE = re.compile(
    r":\s|\b(?:y|e|and|pero|but|sino|however|instead|aunque|although|though|luego|then|"
    r"despues|afterwards|porque|because|mientras|while)\b")
SOLO_EXISTE = re.compile(
    r"\b(?:only|just|solo|solamente|unicamente|apenas|so)\s+(?:say|mention|note|report|state|"
    r"indicate|tell|di|diga|digas|decir|menciona|mencione|indica|indique|avisa|avise|dizer|"
    r"mencionar|informa|informe)\b.{0,40}?\b(?:exists?|existen?|existem|there is|hay)\b")
# Lo que se informa como pendiente, en una frase de estado ("what is still pending (...)",
# "lo pendiente: ..."). Un rotulo suelto ("Pending:", "Next steps:", "Remaining work:")
# encabeza una lista de ordenes y no se tapa. "todo" no: en espanol es "all".
PENDIENTE = re.compile(
    r"\b(?:what(?:'s| is| was| are| remains)? (?:still )?(?:left|missing|remaining|pending|"
    r"outstanding)|(?:is|are|was|were|remains?|still) (?:still )?pending|"
    r"lo (?:que (?:esta|sigue|queda) )?pendiente|(?:esta|estan|sigue|siguen|queda|quedan) "
    r"pendientes?|lo que (?:falta|queda)(?: por hacer)?|"
    r"o que (?:falta|esta pendente|ficou pendente)|(?:esta|estao|fica|ficam) pendentes?)\b")
# Un identificador: una URL, una ruta que empieza con "/", una rama con su prefijo
# (fix/demo-secret-leak, origin/main), una ruta de tres partes o un archivo (src/app.py), o
# un nombre con dos guiones o mas (demo-api-secret-leak). No lo es lo que se parece: "$50/mes",
# "usuario/contrasena", "borra/elimina" o "production/eu" son palabras; una fecha 15-10-2026
# no tiene letras; un nombre con guiones que lleva un destino o un verbo destructivo
# ("prod-us-east-1", "drop-old-users") se queda, y una bandera (--force) no se toca.
_RAMA = r"(?:fix|feat|feature|hotfix|bugfix|chore|refactor|docs|test|tests|release|origin|" \
        r"upstream|refs|heads|wip)"
_EXTENSION = r"(?:py|js|mjs|cjs|ts|tsx|jsx|json|md|html|css|sql|sh|ya?ml|txt|toml|rb|go|rs|java)"
IDENTIFICADOR = re.compile(
    r"(?<![\w-])(?:[a-z][a-z0-9+.-]*://\S+|"
    r"(?<![\w.$])/(?=[\w.@~:/\\-]*[a-z])[\w.@~:/\\-]+|"
    + _RAMA + r"/[\w.@~/-]+|"
    r"(?=[\w.@~-]*[a-z])[\w.@~-]+(?:/[\w.@~-]+){2,}|"
    r"[\w.@~-]+/[\w.@~/-]*\." + _EXTENSION + r"\b|"
    r"(?P<guiones>(?=[a-z0-9-]*[a-z])[a-z0-9]+(?:-[a-z0-9]+){2,}))")
UNIDADES = re.compile(r"[^.!?;\n]+")


def _tapa(chars, desde, hasta):
    for i in range(desde, hasta):
        chars[i] = " "


def _tapa_identificadores(t):
    def tapa(m):
        if m.group("guiones") and _destructivo_o_destino(m.group()):
            return m.group()
        return " " * len(m.group())
    return IDENTIFICADOR.sub(tapa, t)


def _lleva_orden(segmento):
    """Si el segmento lleva una orden destructiva: no hereda la negacion de antes."""
    return any(r.search(segmento) for r in (TRABAJO_BORRA, TRABAJO_VERBO_DESPLIEGUE,
                                            TRABAJO_FUERZA, TRABAJO_PAGO))


def _tapa_negacion(chars, texto, desde, hasta):
    """Dentro de una clausula: desde cada negacion hasta el fin de su segmento (entre
    comas), mas los segmentos cortos de la lista que la siguen hasta su disyuncion."""
    cortes = [desde] + [desde + m.end() for m in re.finditer(",", texto[desde:hasta])]
    segmentos = [(a, (cortes[i + 1] if i + 1 < len(cortes) else hasta))
                 for i, a in enumerate(cortes)]
    i = 0
    while i < len(segmentos):
        a, b = segmentos[i]
        neg = NEGACION.search(texto, a, b)
        if not neg:
            i += 1
            continue
        _tapa(chars, neg.start(), b)
        siguiente = i + 1
        for j in range(i + 1, len(segmentos)):
            x, y = segmentos[j]
            if (_lleva_orden(texto[x:y])
                    or len(texto[x:y].split()) > PALABRAS_DE_ITEM):
                break
            if DISYUNCION.search(texto, x, y):
                for k in range(i + 1, j + 1):
                    _tapa(chars, *segmentos[k])
                siguiente = j + 1
                break
        i = siguiente


def _tapa_pendiente(chars, t, a, b):
    """Lo que se informa como pendiente: desde la marca hasta el proximo "y"/"and" o el fin
    de la frase; un ": " no lo corta ("lo pendiente: auditoria, desplegar")."""
    for m in PENDIENTE.finditer(t, a, b):
        corte = next((c.start() for c in CORTE.finditer(t, m.end(), b)
                      if not c.group().startswith(":")), b)
        _tapa(chars, m.start(), corte)


def sin_menciones(texto, informe=True):
    """El texto normalizado, con lo que no es una orden tapado con espacios (mismo largo):
    lo negado o prohibido y los identificadores; con `informe` (un brief), tambien "solo di
    que existe" y lo que se informa como pendiente. Lo usan las menciones de un brief
    (`trabajo_comprometido`) y, sin `informe`, la palabra de una credencial en lo que sale."""
    t = normaliza(texto)
    t = AFIRMATIVAS.sub(lambda m: " " * len(m.group()), t)
    t = _tapa_identificadores(t)
    chars = list(t)
    for unidad in UNIDADES.finditer(t):
        a, b = unidad.span()
        if informe and SOLO_EXISTE.search(t, a, b):
            _tapa(chars, a, b)
            continue
        if informe:
            _tapa_pendiente(chars, t, a, b)
        limites = [a] + [c.start() for c in CORTE.finditer(t, a, b)] + [b]
        for desde, hasta in zip(limites, limites[1:]):
            _tapa_negacion(chars, t, desde, hasta)
    return "".join(chars)


def excepciones(texto, direccion):
    """The exception names that `texto` raises, in `wa_jev.ORDEN_EXCEPCIONES` order.

    `direccion` is `entrada` (a message that came in) or `salida` (a reply that would go
    out). Only `salida` can raise `money` and `commitment`: what a client asks for is not
    what the assistant promises. Never returns the matched text."""
    if direccion not in DIRECCIONES:
        raise ValueError(f"unknown direction {direccion!r}: use one of {DIRECCIONES}")
    original = texto or ""
    if not original.strip():
        return []
    t = normaliza(original)
    halladas = set()
    # Una cifra o un dia en lo que sale es un hecho de la respuesta, la preceda lo que la
    # preceda: el dinero y la fecha se juzgan en el texto entero. Solo la palabra de una
    # credencial negada no cuenta ("nunca le pediremos su clave", orden-del-dueno); lo que
    # entra, entero: un cliente que dice que no tiene la clave sigue siendo una credencial
    # para el dueno. El secreto mira siempre el texto entero.
    if direccion == SALIDA and _dinero(t):
        halladas.add("money")
    palabras = sin_menciones(original, informe=False) if direccion == SALIDA else t
    if _secreto(original, t) or CREDENCIAL_PALABRA.search(palabras):
        halladas.add("credential")
    if direccion == SALIDA and _compromiso(original):
        halladas.add("commitment")
    return [e for e in wa_jev.ORDEN_EXCEPCIONES if e in halladas]


def _menciones(texto):
    """Lo que un brief MENCIONA (credencial, dinero, fecha), sin lo negado, lo pendiente,
    "solo di que existe" ni los identificadores (orden-del-dueno). El secreto, entero."""
    original = texto or ""
    if not original.strip():
        return []
    palabras = sin_menciones(original)
    halladas = set()
    if _dinero(palabras):
        halladas.add("money")
    if _secreto(original, normaliza(original)) or CREDENCIAL_PALABRA.search(palabras):
        halladas.add("credential")
    if _compromiso(palabras):
        halladas.add("commitment")
    return [e for e in wa_jev.ORDEN_EXCEPCIONES if e in halladas]


# Un valor junto a la palabra de una credencial: "contrasena nueva Perro123", "pin 4821". No
# tiene la forma de un secreto (`secreto` no lo ve) y aun asi no se puede mostrar.
VALOR_CERCA = re.compile(r"[^\s.,;:!?()\[\]\"'<>]*\d[^\s.,;:!?()\[\]\"'<>]*")
VENTANA_VALOR = 40


def valor_de_credencial(texto):
    """Si `texto` lleva el VALOR de una credencial, no solo su nombre: un valor con forma de
    secreto, o una palabra de credencial seguida (en la misma frase, a pocas palabras) de algo
    con una cifra de cuatro caracteres o mas. Nunca devuelve el valor."""
    original = texto or ""
    if not original.strip():
        return False
    if secreto(original):
        return True
    t = normaliza(original)
    for m in CREDENCIAL_PALABRA.finditer(t):
        tramo = re.split(r"[.!?\n]", t[m.end():m.end() + VENTANA_VALOR])[0]
        if any(len(v.group()) >= 4 for v in VALOR_CERCA.finditer(tramo)):
            return True
    return False


# ── The levels of each chat (T22.3) ──────────────────────────────────────────────────
# Per chat, each rule has one of three levels: ask the owner, let the agent revise the
# reply, or allow it. Defaults: money, credential and commitment ask; the quality of the
# reply (what Jev flags as a status nobody verified) goes back to the agent, which is the
# revision loop of tablero-w7. The destructive control (`secreto`) has no level.
PREGUNTAR, AGENTE, PERMITIR = "ask", "agent", "allow"
NIVELES = (PREGUNTAR, AGENTE, PERMITIR)
REGLAS_CON_NIVEL = ("money", "credential", "commitment", "quality")
NIVELES_DEFECTO = {"money": PREGUNTAR, "credential": PREGUNTAR, "commitment": PREGUNTAR,
                   "quality": AGENTE}
# What each hold reason is about. `rule` is this floor, `jev` is Jev's draft review (the
# reasons `wa-send` writes as `rule: a, b; jev: c`). A reason that is not here has no
# level and always asks: `secret` (a secret-shaped value), Jev's `contains_credential` and
# `jev-unavailable` (Jev fails closed).
REGLA_DE_MOTIVO = {("rule", "money"): "money", ("rule", "credential"): "credential",
                   ("rule", "commitment"): "commitment",
                   ("jev", "promises_a_date"): "commitment",
                   ("jev", "states_status_not_verified"): "quality"}
SECRETO = "secret"


def niveles(dato):
    """The four levels of a chat, from what its settings hold: a dict, its JSON, or
    nothing. Anything unknown or invalid falls back to the default: a typo in a stored
    value can never open a rule the owner did not open."""
    if isinstance(dato, str):
        try:
            dato = json.loads(dato)
        except ValueError:
            dato = None
    dato = dato if isinstance(dato, dict) else {}
    return {r: (dato.get(r) if dato.get(r) in NIVELES else NIVELES_DEFECTO[r])
            for r in REGLAS_CON_NIVEL}


def nivel_de_motivo(quien, codigo, niv):
    """The level that applies to one hold reason in a chat with levels `niv`."""
    regla = REGLA_DE_MOTIVO.get((quien, codigo))
    return niv[regla] if regla else PREGUNTAR


# ── Work that waits for the owner (T22.9) ────────────────────────────────────────────
# Approval gates what is SENT, not what is DONE: a `trabajar` proposal goes to the
# project's agent without a click unless the work itself destroys or commits something.
# These are the reasons it still waits. When in doubt, wait: the patterns lean wide.
TRABAJO_BORRA = _palabras(
    r"borr(?:ar|a|en|e|o|amos|ando)", r"elimin\w*", r"suprim\w*", r"purg\w*", r"vaci(?:ar|a)",
    r"dar de baja", r"delete\w*", r"remove", r"drop", r"truncate", r"wipe", r"purge",
    r"rm -rf", r"apag(?:ar|a) (?:el|la) (?:servidor|servicio|base)")
TRABAJO_DESPLIEGA = re.compile(
    r"\b(?:produccion|prod|production|live|en vivo)\b")
TRABAJO_VERBO_DESPLIEGUE = _palabras(
    r"despleg\w*", r"desplieg\w*", r"deploy\w*", r"publica\w*", r"sub(?:ir|e|a|amos)",
    r"lanza\w*", r"release\w*", r"merge\w*", r"pasa\w*", r"llev\w*", r"ship\w*", r"push\w*")
TRABAJO_FUERZA = re.compile(
    r"push\s+(?:-f\b|--force)|force[- ]push|push forzado|forzar (?:el )?push|"
    r"reset --hard|--force-with-lease")
TRABAJO_PAGO = _palabras(
    r"pag(?:o|os|ar|a|amos|ue)", r"cobr\w*", r"factur\w*", r"reembols\w*", r"refund\w*",
    r"payments?", r"pay", r"charge\w*", r"invoic\w*", r"transferenc\w*", r"transferi\w*",
    r"consign\w*", r"billing", r"suscripci\w*", r"subscription\w*", r"tarjeta de credito")
ORDEN_TRABAJO = ("delete", "deploy", "force_push", "payment", "credential", "commitment",
                 "money")


# Lo que hace que la negacion MANDE sobre un verbo destructivo (orden-del-dueno): la negacion,
# y entre ella y el verbo solo auxiliares, pronombres y articulos ("no lo borres", "do not
# ever delete", "nao pode apagar"), o una lista de verbos que cierra con su disyuncion ("do
# not create, edit or delete", "no copies ni borres"). "No olvides borrar", "sin falta
# borra", "sin preguntar borra" o "no esperes, borra" no la tienen: siguen siendo la orden.
_NEGACION_DIRECTA = (
    r"(?:no|nunca|jamas|sin|ni|never|not|without|nor|cannot|"
    r"(?:don|doesn|didn|won|mustn|shouldn|can|isn|aren)[\u2019']?t|nao|nem|sem|"
    r"evit\w*|avoid\w*|prohib\w*|forbid\w*|refrain from|abstente de|abstenerse de)")
_RELLENO = (
    r"(?:se|le|les|lo|la|los|las|me|te|nos|debes|debe|deben|debemos|debo|deberias|deberia|"
    r"puedes|puede|pueden|podemos|vayas a|vaya a|vayan a|vamos a|hay que|tienes que|"
    r"tiene que|tienen que|hagas|haga|hagan|hacer|intentes|intente|intenten|trates de|"
    r"trate de|todavia|aun|ya|un|una|el|ningun|ninguna|otra vez|de nuevo|"
    r"do|does|did|you|we|they|to|be|ever|yet|should|must|will|would|can|could|may|might|"
    r"need to|needs to|have to|has to|try to|attempt to|go|run|perform|make|a|an|the|any|"
    r"accidentally|even|again|"
    r"deve|devem|pode|podem|voce|voces|o|os|as|va|vai|faca|facam|fazer|um|uma|ainda|git)")
_LISTA_DE_VERBOS = (r"(?:[\w-]+(?:\s*,\s*[\w-]+)*\s*,?\s+(?:or|o|u|ni|nor|ou|nem)\s+"
                    r"(?:" + _RELLENO + r"\s+)*)")
GOBIERNA = re.compile(r"\b" + _NEGACION_DIRECTA + r"(?:\s+" + _RELLENO + r")*\s+"
                      + _LISTA_DE_VERBOS + r"?$")
# El verbo en medio de esa lista ("do not modify, delete or deploy"): antes, la negacion y
# los items con su coma; despues, mas items hasta la disyuncion.
GOBIERNA_EN_LISTA = re.compile(r"\b" + _NEGACION_DIRECTA + r"(?:\s+" + _RELLENO + r")*\s+"
                               r"(?:[\w-]+\s*,\s*)+$")
SIGUE_LA_LISTA = re.compile(r"(?:\s*,\s*[\w-]+)*\s*,?\s+(?:or|o|u|ni|nor|ou|nem)\s+[\w-]")
# Hasta donde se mira hacia atras desde el verbo.
ALCANCE_NEGACION = 80


def _gobernado(t, inicio, fin):
    """Si la negacion manda sobre lo que va de `inicio` a `fin`."""
    antes = t[max(0, inicio - ALCANCE_NEGACION):inicio]
    return bool(GOBIERNA.search(antes) or (GOBIERNA_EN_LISTA.search(antes)
                                           and SIGUE_LA_LISTA.match(t, fin)))


def _destructivo_o_destino(texto):
    """Si `texto` nombra un destino de despliegue o un verbo destructivo."""
    return any(r.search(texto) for r in (TRABAJO_DESPLIEGA, TRABAJO_VERBO_DESPLIEGUE,
                                         TRABAJO_BORRA, TRABAJO_FUERZA, TRABAJO_PAGO))


def _ordenes(texto):
    """El texto normalizado en que se buscan las ordenes destructivas: sin los
    identificadores, sin lo que se informa como pendiente y sin los verbos destructivos sobre
    los que manda una negacion. Nada mas se tapa: lo destructivo falla seguro."""
    t = _tapa_identificadores(normaliza(texto))
    chars = list(t)
    for unidad in UNIDADES.finditer(t):
        _tapa_pendiente(chars, t, *unidad.span())
    for patron in (TRABAJO_BORRA, TRABAJO_FUERZA, TRABAJO_VERBO_DESPLIEGUE, TRABAJO_PAGO):
        for m in patron.finditer(t):
            if _gobernado(t, m.start(), m.end()):
                _tapa(chars, m.start(), m.end())
    return "".join(chars)

# The customer's messages as a work brief quotes them: `> ` lines and the
# `[YYYY-MM-DD HH:MM] Name:` stamp above each one.
CITA = re.compile(r"^\s*(?:>.*|\[\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}\][^\n]*)$", re.MULTILINE)


# A full date with its time (`2026-10-03 07:39`) records when something happened; a promise
# names a day or an hour, never both stamped together.
SELLO = re.compile(r"\b\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?\b")


def sin_citas(texto):
    return SELLO.sub("", CITA.sub("", texto or ""))


def trabajo_comprometido(texto):
    """Why a piece of work must wait for the owner instead of going to the project's agent
    without a click (T22.9), in a stable order; an empty list is work that can go. Only the
    reason NAMES, never the text."""
    original = texto or ""
    if not original.strip():
        return []
    # Lo destructivo falla seguro: solo se descuenta el verbo que la negacion gobierna, lo
    # que se informa como pendiente y los identificadores (orden-del-dueno).
    t = _ordenes(original)
    halladas = set()
    if TRABAJO_BORRA.search(t):
        halladas.add("delete")
    if TRABAJO_FUERZA.search(t):
        halladas.add("force_push")
    if any(TRABAJO_DESPLIEGA.search(f) and TRABAJO_VERBO_DESPLIEGUE.search(f)
           for f in FRASES.findall(t)):
        halladas.add("deploy")
    if TRABAJO_PAGO.search(t):
        halladas.add("payment")
    # A date or an amount the customer wrote, quoted in the work, is what was asked, not
    # what the work commits to; the quote's arrival stamp is not a promised time either.
    for e in _menciones(sin_citas(original)):
        halladas.add(e)
    return [r for r in ORDEN_TRABAJO if r in halladas]
