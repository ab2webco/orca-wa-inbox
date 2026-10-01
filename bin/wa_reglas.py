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
  - It leans to false positives on purpose. Asking the owner one time too many is
    acceptable; letting a price, a password or a promised date through is not.
  - It returns only exception NAMES, the same identifiers as
    `wa_jev.ORDEN_EXCEPCIONES`, in that order. It never returns or logs the text that
    matched: a matched secret must not end up in an event or a log.
  - `commitment` applies only to what goes OUT (`salida`): a client asking for
    something by Friday is not the assistant promising it.

Spanish, English and Portuguese; accents and case do not matter. Python stdlib only.
"""
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


# ── money ────────────────────────────────────────────────────────────────────────────
DINERO_SIMBOLO = re.compile(
    r"(?:r\$|us\$|[$€£])\s?\d|\d\s?(?:[$€£])")
DINERO_CODIGO = _palabras(
    r"cop", r"usd", r"eur", r"mxn", r"brl", r"ars", r"clp", r"pen", r"gbp", r"cad",
    r"dolar(?:es)?", r"dollars?", r"euros?", r"pesos", r"reais", r"reales", r"soles",
    r"bucks")
# 1.400 / 250.000 / 1,250.50 / 1.250,50: thousands with a separator. An IP address
# (192.168.1.10) does not match: the lookarounds refuse a longer run of groups.
DINERO_CIFRA = re.compile(
    r"(?<![\d.,])\d{1,3}(?:([.,])\d{3})(?:\1\d{3})*(?:[.,]\d{2})?(?![.,]?\d)")
DINERO_MAGNITUD = re.compile(r"\b\d+(?:[.,]\d+)?\s?(?:k|mil|millon(?:es)?|lucas|palos)\b")
DINERO_PALABRA = _palabras(
    # es
    r"precios?", r"cobr\w*", r"pag(?:o|os|a|an|ar|amos|aste|aron|ue|uen|ues|ado|ada|"
    r"ados|adas|ando|ara|aran|are|aremos|ue|uemos|aria|arian)",
    r"transferencias?", r"transferi(?:r|mos|do|da)?", r"consignaci(?:on|ones)",
    r"consign(?:ar|e|o|amos|aron|ado|ada)", r"factur\w*", r"descuentos?",
    r"cotiz\w*", r"tarifas?", r"valor(?:es)?", r"reembols\w*", r"deudas?", r"abon\w*",
    r"costos?", r"coste", r"cuestan?", r"cuanto\s+(?:vale|valen|sale|salen|cobra\w*)",
    r"presupuestos?", r"saldos?", r"plata", r"dinero", r"honorarios", r"mensualidad(?:es)?",
    r"cuotas?", r"iva", r"nequi", r"daviplata", r"tarjeta de credito",
    # en
    r"prices?", r"pricing", r"priced", r"pay", r"pays", r"paying", r"paid",
    r"payments?", r"invoices?", r"invoiced", r"refunds?", r"refunded", r"discounts?",
    r"quotes?", r"quoted", r"quotation", r"fees?", r"costs?", r"billing", r"billed",
    r"charged?", r"charges", r"budget", r"wire transfer", r"deposit",
    # pt
    r"precos?", r"pagamentos?", r"faturas?", r"faturamento", r"descontos?",
    r"boletos?", r"pix", r"orcamentos?", r"cobranca", r"custos?", r"custa",
    r"quanto\s+(?:custa|e|fica)", r"dinheiro", r"reembolsos?")


def _dinero(t):
    return bool(DINERO_SIMBOLO.search(t) or DINERO_CODIGO.search(t)
                or DINERO_CIFRA.search(t) or DINERO_MAGNITUD.search(t)
                or DINERO_PALABRA.search(t))


# ── credential ───────────────────────────────────────────────────────────────────────
# The value-shaped patterns are Jev's masking patterns, reused as they are: the text
# that would be masked before going to Jev is exactly a credential here.
CREDENCIAL_FORMA = (wa_jev.RE_LABELLED, wa_jev.RE_PREFIXED, wa_jev.RE_JWT, wa_jev.RE_PEM,
                    wa_jev.RE_QUERY_SECRET, wa_jev.RE_OTP)
# And asking for one, or naming one, without the value.
CREDENCIAL_PALABRA = _palabras(
    r"contrasenas?", r"claves?", r"passwords?", r"passwd", r"senhas?", r"pin",
    r"tokens?", r"credencial(?:es)?", r"credentials?", r"credenciais", r"otp", r"2fa",
    r"api[ _-]?keys?", r"apikey", r"secret", r"codigo de (?:verificacion|verificacao|"
    r"acceso|acesso|seguridad|seguranca)", r"verification code", r"access code",
    r"usuario y clave", r"user(?:name)? and password")


def _credencial(original, t):
    return (any(p.search(original) or p.search(t) for p in CREDENCIAL_FORMA)
            or bool(CREDENCIAL_PALABRA.search(t)))


# ── commitment (only what goes out) ──────────────────────────────────────────────────
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
    # when
    r"manana|hoy|pasado manana|esta (?:tarde|noche|semana)|"
    r"(?:la )?(?:proxima|siguiente) semana|fin de semana|ahorita|en un rato|"
    r"tomorrow|today|tonight|this (?:afternoon|evening|week)|next week|eod|"
    r"end of (?:the )?(?:day|week)|asap|"
    r"amanha|hoje|depois de amanha|esta (?:tarde|noite)|(?:a )?proxima semana|"
    r"(?:" + _DIAS + r")(?:-feira)?|"
    r"(?:" + _MESES + r")|fecha|deadline|prazo|"
    r"para el|a mas tardar|"
    r"by (?:the end|end of|eod|tomorrow|tonight|today|next|this|(?:" + _DIAS + r")|\d)|"
    r"ate (?:amanha|hoje|o fim|o final|a proxima|o dia|(?:" + _DIAS + r")|\d)|"
    r"(?:en|in|within|em) (?:\d+|un|una|unos|unas|dos|tres|pocos|pocas|par de|a|an|"
    r"a few|um|uma|alguns|algumas) ?(?:" + _UNIDADES + r")|"
    r"a las \d|at \d|"
    # what
    r"queda(?:ra|n|rian?)? list[oa]s?|estara list[oa]s?|va a quedar|"
    r"(?:te|se|le|les) (?:lo |la |los |las )?(?:envio|enviamos|envia|mando|mandamos|"
    # "te aviso" stays out on purpose: it promises news, not a date or a delivery,
    # and it ends most support replies.
    r"paso|pasamos|confirmo|confirmamos|entrego|entregamos)|"
    r"(?:le|te|les) confirm\w*|nos comprometemos|sin falta|"
    r"lo tendr\w*|la tendr\w*|tendr(?:e|emos) list\w*|"
    r"will be (?:ready|done|fixed|sent|delivered)|"
    r"(?:i|we)(?:'ll| will) (?:send|have|get|confirm|deliver|fix|finish)|"
    r"fica(?:ra)? pront[oa]|estara pront[oa]|(?:te|lhe) (?:envio|enviamos|mando|"
    r"confirmo|confirmamos)"
    r")\b"
    # dd/mm, dd-mm-yyyy and clock times
    r"|(?<!\d)\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?(?!\d)"
    r"|\b\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.|hs|hrs)\b"
    r"|(?<!\d)\d{1,2}:\d{2}(?!\d)")


def excepciones(texto, direccion):
    """The exception names that `texto` raises, in `wa_jev.ORDEN_EXCEPCIONES` order.

    `direccion` is `entrada` (a message that came in) or `salida` (a reply that would go
    out). Only `salida` can raise `commitment`. Never returns the matched text."""
    if direccion not in DIRECCIONES:
        raise ValueError(f"unknown direction {direccion!r}: use one of {DIRECCIONES}")
    original = texto or ""
    if not original.strip():
        return []
    t = normaliza(original)
    halladas = set()
    if _dinero(t):
        halladas.add("money")
    if _credencial(original, t):
        halladas.add("credential")
    if direccion == SALIDA and COMPROMISO.search(t):
        halladas.add("commitment")
    return [e for e in wa_jev.ORDEN_EXCEPCIONES if e in halladas]
