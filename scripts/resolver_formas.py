"""Las dos formas publicadas del resolvedor, derivadas de `scripts/resolver.py`.

El resolvedor vive en un solo archivo legible y se publica en cinco lugares que no
pueden importarlo: los dos `precheck` de `orca-plugin.json`, los dos de `automations/`
y el bloque de cada prompt. Este modulo es el que las emite, para que "derivar" sea una
funcion y no una costumbre.

Son dos formas porque los dos destinos tienen restricciones opuestas:

  - `legible()` — el texto tal cual, con comentarios. Va a los prompts. Un prompt es
    texto que lee un modelo: acortarlo cuesta comprension y no ahorra nada.

  - `compacto()` — el mismo programa, minificado. Va al `precheck`, y ahi SI hay un
    techo: `z.string().min(1).max(1024)` en el esquema de Orca
    (orca-oss/src/shared/plugins/plugin-automation-contribution.ts:57). Pasarse no
    degrada nada: Orca no puede leer el manifiesto, y el plugin entero aparece como
    `invalid-development-plugin`. Ya paso — la version legible del resolvedor media
    1700 caracteres de codigo y el manifiesto quedo invalido de un commit al otro.

La minificacion es mecanica y sin tabla que mantener: renombra solo los nombres que el
propio modulo define (los detecta el AST, no una lista), deja los literales intactos
—se trabaja sobre tokens, asi que `'version'` no se toca cuando se renombra la funcion
`version`—, baja la sangria a un espacio, sube a la misma linea los cuerpos de una sola
sentencia y junta con `;` las sentencias simples seguidas. No cambia el programa: la
prueba `test/resolver.test.mjs` corre las seis copias contra los mismos cinco
escenarios, y `scripts/check-resolver` compila lo que sale de aca.
"""
import ast
import builtins
import io
import pathlib
import tokenize
from typing import Callable

RAIZ = pathlib.Path(__file__).resolve().parent.parent
CANONICO = RAIZ / "scripts" / "resolver.py"

# Sentencias simples que terminan el bloque: nada puede seguirlas con `;`.
TERMINALES = frozenset(("return", "break", "continue", "pass", "raise"))
# Alfabeto de nombres cortos, en orden de primera aparicion. Sin `l` ni `O`, que a ojo
# se confunden con 1 y 0 cuando alguien lee el precheck en un log.
ALFABETO = "abcdefghijkmnpqrstuvwxyzABCDEFGHIJKLMNPQRSTUVWXYZ"


def legible() -> str:
    """El resolvedor tal cual, con comentarios. Lo que va a los prompts."""
    return CANONICO.read_text(encoding="utf-8").rstrip("\n")


def _nombres_propios(fuente: str) -> set[str]:
    """Los nombres que este modulo DEFINE, que son los unicos que se pueden renombrar.

    Se sacan del AST, no de una tabla: agregar una variable al canonico no obliga a
    acordarse de nada. Quedan fuera los nombres importados (`json`, `os`, `sys`), que
    son de otro modulo, y cualquier builtin que se sombrease sin querer.
    """
    arbol = ast.parse(fuente)
    definidos: set[str] = set()
    importados: set[str] = set()
    for nodo in ast.walk(arbol):
        if isinstance(nodo, ast.Name) and isinstance(nodo.ctx, (ast.Store, ast.Del)):
            definidos.add(nodo.id)
        elif isinstance(nodo, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            definidos.add(nodo.name)
        elif isinstance(nodo, ast.arg):
            definidos.add(nodo.arg)
        elif isinstance(nodo, (ast.Import, ast.ImportFrom)):
            for alias in nodo.names:
                importados.add((alias.asname or alias.name).split(".")[0])
        elif isinstance(nodo, ast.ExceptHandler) and nodo.name:
            definidos.add(nodo.name)
    return {n for n in definidos - importados if not hasattr(builtins, n)}


def _renombres(fuente: str) -> dict[str, str]:
    """Nombre original → nombre corto, en orden de primera aparicion en el texto.

    El orden lo fija el texto y no el recorrido del AST para que la salida sea la
    misma en cualquier maquina y version de Python: si esto variara, `check-resolver`
    veria divergir copias que nadie toco.
    """
    propios = _nombres_propios(fuente)
    orden: list[str] = []
    for token in tokenize.generate_tokens(io.StringIO(fuente).readline):
        if token.type == tokenize.NAME and token.string in propios and token.string not in orden:
            orden.append(token.string)
    cortos = {}
    for indice, nombre in enumerate(orden):
        # Mas nombres que letras: se pasa a dos caracteres antes que a numeros, que en
        # Python no pueden abrir un identificador.
        corto = (ALFABETO[indice] if indice < len(ALFABETO)
                 else ALFABETO[indice // len(ALFABETO) - 1] + ALFABETO[indice % len(ALFABETO)])
        cortos[nombre] = corto
    return cortos


def _necesita_espacio(previo: tuple[int, str], actual: tuple[int, str]) -> bool:
    """Un espacio solo donde pegarlos cambiaria el programa.

    Dos tokens de palabra seguidos (`not v`, `if p else None`, `import json`) se
    fundirian en un identificador. Un numero pegado a una palabra clave (`3if`) es un
    error de sintaxis desde Python 3.12. Todo lo demas —parentesis, comas, operadores—
    no necesita nada.
    """
    palabras = (tokenize.NAME, tokenize.NUMBER, tokenize.STRING)
    return previo[0] in palabras and actual[0] in palabras


def _atomos(fuente: str) -> list[tuple[int, str]]:
    """Los tokens que importan, ya renombrados, como pares (tipo, texto).

    Se trabaja sobre tokens y no sobre texto porque el renombrado tiene que tocar SOLO
    identificadores: la funcion `version` se acorta, la clave `'version'` del manifiesto
    no. Un reemplazo por texto no distingue las dos cosas, y el sintoma seria un
    resolvedor que lee una clave que no existe y elige vacio.
    """
    cortos = _renombres(fuente)
    atomos: list[tuple[int, str]] = []
    previo_punto = False
    for token in tokenize.generate_tokens(io.StringIO(fuente).readline):
        if token.type in (tokenize.COMMENT, tokenize.NL, tokenize.ENCODING,
                          tokenize.ENDMARKER):
            continue
        texto = token.string
        # Un atributo no es un nombre de este modulo: `partes.append` no se renombra.
        if token.type == tokenize.NAME and not previo_punto:
            texto = cortos.get(texto, texto)
        previo_punto = token.type == tokenize.OP and token.string == "."
        atomos.append((token.type, texto))
    return atomos


def _cadenas(atomos: list[tuple[int, str]]) -> dict[str, list[int]]:
    """Cada cadena con punto (`os.path`, `os.path.join`) → donde empieza cada uso.

    Solo cuentan los accesos que arrancan en un nombre suelto: `w.get(...)` sobre una
    variable local no se puede sacar a un alias porque la variable cambia en cada vuelta.
    """
    usos: dict[str, list[int]] = {}
    for i, (tipo, texto) in enumerate(atomos):
        if tipo != tokenize.NAME or (i and atomos[i - 1] == (tokenize.OP, ".")):
            continue
        j, cadena = i, texto
        while (j + 2 < len(atomos) and atomos[j + 1] == (tokenize.OP, ".")
               and atomos[j + 2][0] == tokenize.NAME):
            j += 2
            cadena += "." + atomos[j][1]
            # Una llamada tambien vale como uso: lo que se guarda es la funcion, no el
            # resultado, asi que aliasar `os.path.join` es seguro.
            usos.setdefault(cadena, []).append(i)
    return usos


def _aliasa(atomos: list[tuple[int, str]],
            siguiente: Callable[[], str]) -> list[tuple[int, str]]:
    """Saca a un alias las cadenas con punto que se repiten: `os.path.join` → `z=...`.

    Es lo que separa un precheck de 1100 caracteres de uno que cabe: `os.path.` aparece
    trece veces y son ocho caracteres cada una. Se elige por ahorro neto —contando lo
    que cuesta la linea del alias— y se repite, para que despues de aliasar `os.path`
    tambien se pueda aliasar `os.path.join` sobre el alias ya creado.
    """
    prologo: list[tuple[int, str]] = []
    while True:
        mejor, mejor_ahorro, mejor_pos = None, 0, 0
        for cadena, posiciones in _cadenas(atomos).items():
            # El alias cuesta su definicion (`z=os.path.join` + el `;` que la separa).
            ahorro = len(posiciones) * (len(cadena) - 1) - (len(cadena) + 3)
            if ahorro > mejor_ahorro or (ahorro == mejor_ahorro and ahorro > 0
                                         and posiciones[0] < mejor_pos):
                mejor, mejor_ahorro, mejor_pos = cadena, ahorro, posiciones[0]
        if mejor is None:
            return _tras_los_imports(atomos, prologo)
        alias = siguiente()
        piezas = mejor.split(".")
        prologo += [(tokenize.NAME, alias), (tokenize.OP, "=")]
        prologo.append((tokenize.NAME, piezas[0]))
        for pieza in piezas[1:]:
            prologo += [(tokenize.OP, "."), (tokenize.NAME, pieza)]
        prologo.append((tokenize.NEWLINE, ""))
        largo = len(piezas) * 2 - 1
        salida, i = [], 0
        while i < len(atomos):
            if [a[1] for a in atomos[i:i + largo]] == mejor.split(".")[:1] + sum(
                    [[".", p] for p in piezas[1:]], []):
                salida.append((tokenize.NAME, alias))
                i += largo
                continue
            salida.append(atomos[i])
            i += 1
        atomos = salida


def _tras_los_imports(atomos: list[tuple[int, str]],
                      prologo: list[tuple[int, str]]) -> list[tuple[int, str]]:
    """Los alias van DESPUES del ultimo import, no antes.

    Parece obvio y no lo es: puestos arriba del todo, `y=os.path` corre antes de
    `import os` y el resolvedor muere con un NameError en la primera corrida
    programada, que es donde nadie esta mirando.
    """
    corte = 0
    inicio = 0
    for i, (tipo, texto) in enumerate(atomos):
        if tipo == tokenize.NEWLINE:
            if atomos[inicio][1] in ("import", "from"):
                corte = i + 1
            inicio = i + 1
    return atomos[:corte] + prologo + atomos[corte:]


def _lineas(atomos: list[tuple[int, str]]) -> list[list]:
    """Las lineas logicas minificadas: [profundidad, texto, compuesta]."""
    lineas: list[list] = []
    profundidad = 0
    partes: list[str] = []
    previo: tuple[int, str] | None = None
    for tipo, texto in atomos:
        if tipo == tokenize.INDENT:
            profundidad += 1
            continue
        if tipo == tokenize.DEDENT:
            profundidad -= 1
            continue
        if tipo == tokenize.NEWLINE:
            if partes:
                cuerpo = "".join(partes)
                lineas.append([profundidad, cuerpo, cuerpo.endswith(":")])
            partes, previo = [], None
            continue
        if previo is not None and _necesita_espacio(previo, (tipo, texto)):
            partes.append(" ")
        partes.append(texto)
        previo = (tipo, texto)
    return lineas


def _sube_cuerpos(lineas: list[list]) -> list[list]:
    """`if c: D.append(c)` en una sola linea, cuando el cuerpo es UNA sentencia simple.

    Detras de un `:` no puede ir otra cabecera de bloque —`if a: if b: c` no es Python—,
    asi que un `try:` cuyo cuerpo es un `with` se queda como esta, y la linea resultante
    queda marcada como compuesta para que nadie la pegue despues de un `;`.
    """
    salida = [list(l) for l in lineas]
    for i in range(len(salida) - 2, -1, -1):
        profundidad, texto, compuesta = salida[i]
        if not texto.endswith(":") or not compuesta:
            continue
        hijo_prof, hijo_texto, hijo_compuesta = salida[i + 1]
        if hijo_prof != profundidad + 1 or hijo_compuesta:
            continue
        # El cuerpo tiene que ser exactamente esa linea: la siguiente ya sale del bloque.
        if i + 2 < len(salida) and salida[i + 2][0] > profundidad:
            continue
        salida[i] = [profundidad, texto + hijo_texto, True]
        del salida[i + 1]
    return salida


def _junta_simples(lineas: list[list]) -> list[list]:
    """`j=z(d,'bin')` + `k=c(d)` → `j=z(d,'bin');k=c(d)`: ahorra el salto y su sangria.

    Nunca con una linea compuesta de por medio —detras de un `;` no puede ir un bloque—
    ni detras de un `return`/`break`/`continue`, que dejaria codigo muerto.
    """
    salida: list[list] = []
    for linea in lineas:
        profundidad, texto, compuesta = linea
        if salida and not compuesta:
            previa = salida[-1]
            primera = texto_inicial(previa[1])
            if previa[0] == profundidad and not previa[2] and primera not in TERMINALES:
                previa[1] = f"{previa[1]};{texto}"
                continue
        salida.append(list(linea))
    return salida


def texto_inicial(linea: str) -> str:
    """La primera palabra de una sentencia, para reconocer las que cierran el bloque."""
    palabra = ""
    for caracter in linea:
        if not (caracter.isalpha() or caracter == "_"):
            break
        palabra += caracter
    return palabra


def compacto(fuente: str | None = None) -> str:
    """El resolvedor minificado: lo que cabe en el `precheck` del manifiesto."""
    fuente = legible() if fuente is None else fuente
    usados = set(_renombres(fuente).values())

    def siguiente() -> str:
        for letra in ALFABETO:
            if letra not in usados:
                usados.add(letra)
                return letra
        raise RuntimeError("se acabaron los nombres cortos para los alias")

    lineas = _junta_simples(_sube_cuerpos(_lineas(_aliasa(_atomos(fuente), siguiente))))
    return "\n".join(" " * profundidad + texto for profundidad, texto, _ in lineas)


def precheck(cola: str, fuente: str | None = None) -> str:
    """La linea de shell completa que declara una automation.

    `python3 -c "..."` entrecomillado: por eso el canonico no puede usar comillas
    dobles, pesos, comillas invertidas ni contrabarras — cualquiera de los cuatro
    partiria la cadena justo aca, y el sintoma seria un WA vacio en una corrida
    automatica que nadie mira.
    """
    return f'WA=$(python3 -c "{compacto(fuente)}") && [ -x "$WA/wa-scope" ] || exit 1; {cola}'


if __name__ == "__main__":
    import sys

    forma = sys.argv[1] if len(sys.argv) > 1 else "compacto"
    print(legible() if forma == "legible" else compacto(), end="")
