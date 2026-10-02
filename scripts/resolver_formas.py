"""La unica fuente de donde salen las herramientas del plugin: el archivo `.wa-bin`.

Antes el resolvedor (que decide DE CUAL instalacion salen wa-scope, wa-read y wa-send)
vivia inlineado en cinco lugares: el precheck de triage y el command de tick del
manifiesto, las dos copias de `automations/` y el bloque del prompt. Eran ~110 lineas de
Python con comentarios pegadas en la terminal en cada corrida, y una copia minificada de
casi 1000 caracteres contra un techo de 1024.

Ahora el worker, que ya conoce su propia carpeta, escribe la ruta de su `bin/` en
`<carpeta de trabajo del plugin>/.wa-bin` (harness.mjs, `sembrarBin`) en cada activacion
y en cada siembra. Las automatizaciones del plugin corren en esa carpeta
(`workspace: plugin-owned`), asi que basta leer el archivo.

No hay respaldo: el resolvedor viejo, minificado, mide ~1000 caracteres y no cabe junto a
la forma corta dentro de los 1024 del esquema de Orca (orca-oss/src/shared/plugins/
plugin-automation-contribution.ts:43 y :57). Sin `.wa-bin` la corrida sale con 1, callada,
que es el desenlace barato: la siembra lo deja en la primera activacion.

Este modulo emite las dos formas publicadas, para que "derivar" sea una funcion:

  - `comando(cola)`: la linea de shell del manifiesto y de `automations/`;
  - `bloque_prompt()`: el bloque `sh` del prompt.

`python3 scripts/resolver_formas.py comando-tick|comando-triage|prompt` las imprime.
"""
import pathlib
import sys

RAIZ = pathlib.Path(__file__).resolve().parent.parent

LEER = 'WA="$(cat .wa-bin 2>/dev/null)"'
COLAS = {
    "triage": '"$WA/wa-scope" pending --needs-agent',
    "tick": '"$WA/wa-scope" tick --json',
}


def comando(cola: str) -> str:
    """La linea de shell de una automatizacion: resuelve `WA`, para en silencio si no hay
    `wa-scope` ejecutable, y corre `cola`."""
    return f'{LEER}; [ -x "$WA/wa-scope" ] || exit 1; {cola}'


def bloque_prompt() -> str:
    """El bloque `sh` del prompt, sin las vallas."""
    return f'{LEER}\n[ -x "$WA/wa-scope" ] || echo "wa-scope not found"'


if __name__ == "__main__":
    formas = {"comando-tick": comando(COLAS["tick"]),
              "comando-triage": comando(COLAS["triage"]), "prompt": bloque_prompt()}
    if len(sys.argv) != 2 or sys.argv[1] not in formas:
        sys.exit(f"uso: resolver_formas.py {'|'.join(formas)}")
    sys.stdout.write(formas[sys.argv[1]])
