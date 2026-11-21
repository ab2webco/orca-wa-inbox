"""Real @mentions in a group reply (odd/tasks/group-mentions.md, WAINBOX-124).

WhatsApp notifies a person only when the text carries `@<user part>` of their jid AND the
message lists that jid in `mentions`. A name written as `@Ana` is plain text: nobody is
notified. This module turns who the agent means into both halves, against the members of
the group (`wa_store.miembros`: `[{id, name, phone, wa_admin}]`).

It never guesses. An explicit `--mention` that matches nobody, or more than one member, is
refused (`MencionInvalida`). An `@Name` written in the text becomes a mention only when it
matches exactly one member; otherwise it stays as the agent wrote it.

The `<user part>` is the one of the id the group addresses (`member_jid`): a LID in a LID
group, a phone in a phone group. That is what WhatsApp renders as the person's name.
"""
import re
import unicodedata

DESCONOCIDA = "mention-unknown"
AMBIGUA = "mention-ambiguous"
# Fewer digits than this is not a phone or a LID: it is a number in the text ("@10").
DIGITOS_MIN = 6
NOMBRE_MIN = 2


class MencionInvalida(Exception):
    """An explicit mention that cannot be resolved. The message names no member: it ends up
    in the agent's stderr and in logs."""

    def __init__(self, codigo, detalle):
        super().__init__(detalle)
        self.codigo = codigo


def _plegar(c):
    """One character, lowercase and without accents, always one character long so that a
    position in the folded text is the same position in the original."""
    base = "".join(x for x in unicodedata.normalize("NFKD", c) if not unicodedata.combining(x))
    base = base.lower()
    return base if len(base) == 1 else c.lower()[:1] or c


def plegar(texto):
    return "".join(_plegar(c) for c in texto or "")


def _nombre(miembro):
    return " ".join(plegar(miembro.get("name") or "").split())


def usuario(jid):
    """The user part of a jid, without the device suffix: `573..:7@s.whatsapp.net` → `573..`."""
    return (jid or "").split("@")[0].split(":")[0]


def _digitos(texto):
    return re.sub(r"[\s+\-().]", "", texto or "")


def _numeros(miembro):
    """The numbers that name a member: the user part of its id and its phone."""
    return {n for n in (usuario(miembro.get("id")), miembro.get("phone") or "") if n}


def _formas(miembro, primeros):
    """The ways the text can name a member after an `@`: its full name, its first name when
    no other member shares it (`primeros`: first name → how many members), and its numbers."""
    formas = set(_numeros(miembro))
    nombre = _nombre(miembro)
    if len(nombre) >= NOMBRE_MIN:
        formas.add(nombre)
        primero = nombre.split(" ")[0]
        if len(primero) >= NOMBRE_MIN and primeros.get(primero, 0) == 1:
            formas.add(primero)
    return formas


def _primeros(miembros):
    cuenta = {}
    for m in miembros:
        nombre = _nombre(m)
        if nombre:
            primero = nombre.split(" ")[0]
            cuenta[primero] = cuenta.get(primero, 0) + 1
    return cuenta


def resolver(quien, miembros):
    """The ONE member `quien` names (a name, a phone, a jid or a LID), or `MencionInvalida`."""
    q = (quien or "").strip()
    if "@" in q:
        q = usuario(q)
    digitos = _digitos(q)
    if digitos.isdigit() and len(digitos) >= DIGITOS_MIN:
        hallados = [m for m in miembros if digitos in _numeros(m)]
    else:
        nombre = " ".join(plegar(q).split())
        hallados = [m for m in miembros if nombre and
                    (_nombre(m) == nombre or _nombre(m).split(" ")[0] == nombre)]
    if len(hallados) > 1:
        raise MencionInvalida(AMBIGUA, "that mention matches more than one member of the "
                                       "group; pass the phone or the id from `wa-read members`.")
    if not hallados:
        raise MencionInvalida(DESCONOCIDA, "that mention matches no member of the group; "
                                           "check the name with `wa-read members`.")
    return hallados[0]


def aplicar(texto, miembros, pedidas=()):
    """`(text, jids)`: the text with each mention as `@<user part>` and the jids to list.

    `pedidas` are the members of explicit `--mention`s (already resolved): each one is
    mentioned, where the text names it after an `@`, or at the start when it does not. Any
    other `@<name or number>` is a mention only when it names exactly one member."""
    texto = texto or ""
    primeros = _primeros(miembros)
    duenos = {}
    for m in miembros:
        for forma in _formas(m, primeros):
            duenos.setdefault(forma, []).append(m)
    # A form that names two members names nobody; an explicit one names its member.
    formas = {f: ms[0] for f, ms in duenos.items() if len(ms) == 1}
    for m in pedidas:
        for forma in _formas(m, primeros) | {_nombre(m)}:
            if forma:
                formas[forma] = m
    ordenadas = sorted(formas, key=len, reverse=True)

    plegado = plegar(texto)
    partes, jids, i = [], [], 0
    for marca in re.finditer("@", texto):
        p = marca.start()
        if p < i or (p > 0 and (plegado[p - 1].isalnum() or plegado[p - 1] == "_")):
            continue
        for forma in ordenadas:
            fin = p + 1 + len(forma)
            if plegado[p + 1:fin] != forma:
                continue
            if fin < len(plegado) and (plegado[fin].isalnum() or plegado[fin] == "_"):
                continue
            miembro = formas[forma]
            partes.append(texto[i:p] + "@" + usuario(miembro["id"]))
            if miembro["id"] not in jids:
                jids.append(miembro["id"])
            i = fin
            break
    partes.append(texto[i:])
    salida = "".join(partes)
    faltan = [m for m in pedidas if m["id"] not in jids]
    if faltan:
        salida = " ".join("@" + usuario(m["id"]) for m in faltan) + " " + salida
        jids = [m["id"] for m in faltan] + jids
    return salida, jids


def legible(texto, jids, miembros):
    """The text as the owner should read it before approving: each mentioned `@<user part>`
    back as `@<name>`. What goes out to WhatsApp keeps the number (that is the mention);
    this is only for the board and the owner's notice. A member with no known name, or a
    number that was not mentioned, is left as it is."""
    texto = texto or ""
    for jid in jids or ():
        miembro = next((m for m in miembros if m.get("id") == jid), None)
        nombre = " ".join((miembro or {}).get("name", "").split())
        if not nombre:
            continue
        texto = re.sub("@" + re.escape(usuario(jid)) + r"(?!\d)", lambda _: "@" + nombre, texto)
    return texto
