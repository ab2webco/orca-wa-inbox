"""De donde salen las herramientas del plugin: el archivo `.wa-bin` y, de respaldo, el
puntero estable `bin-path`.

Antes el resolvedor (que decide DE CUAL instalacion salen wa-scope, wa-read y wa-send)
vivia inlineado en cinco lugares: el precheck de triage y el command de tick del
manifiesto, las dos copias de `automations/` y el bloque del prompt. Eran ~110 lineas de
Python con comentarios pegadas en la terminal en cada corrida, y una copia minificada de
casi 1000 caracteres contra un techo de 1024.

Ahora el worker, que ya conoce su propia carpeta, escribe la ruta de su `bin/` en
`<carpeta de trabajo del plugin>/.wa-bin` (harness.mjs, `sembrarBin`) en cada activacion
y en cada siembra. Las automatizaciones del plugin corren en esa carpeta
(`workspace: plugin-owned`), asi que basta leer el archivo.

El respaldo es `bin-path`, que la misma siembra deja en la carpeta de estado de las
herramientas (harness.mjs, `sembrarBinEstable`, `dirEstado`): `$HOME/.wa-inbox` y, en
Windows, `%APPDATA%\\wa-inbox` (se mira solo si `APPDATA` existe). Hace falta porque la
carpeta que Orca crea puede estar vacia: medido en una Linux con `orca` ya sembrada y la
app corriendo desde `orca-ide`, el tick salia con 1 cada minuto en una carpeta sin
`.wa-bin`. `bin-path` nombra siempre el plugin instalado que arranco ultimo.

Sin ninguno la corrida sale con 1 y dice por que en UNA linea de stderr, con la carpeta
en la que miro: callada, ese tick muerto no dejaba ninguna pista. Nunca `PATH`.

Todo cabe holgado en los 1024 caracteres del esquema de Orca (orca-oss/src/shared/plugins/
plugin-automation-contribution.ts:43 y :57); scripts/check-resolver lo mide.

Este modulo emite las dos formas publicadas, para que "derivar" sea una funcion:

  - `comando(cola)`: la linea de shell del manifiesto y de `automations/`;
  - `bloque_prompt()`: el bloque `sh` del prompt.

`python3 scripts/resolver_formas.py comando-tick|comando-triage|prompt` las imprime.
"""
import pathlib
import sys

RAIZ = pathlib.Path(__file__).resolve().parent.parent

HAY = '[ -x "$WA/wa-scope" ]'
FUENTES = (
    'WA="$(cat .wa-bin 2>/dev/null)"',
    f'{HAY} || WA="$(cat "$HOME/.wa-inbox/bin-path" 2>/dev/null)"',
    f'{HAY} || [ -z "$APPDATA" ] || WA="$(cat "$APPDATA/wa-inbox/bin-path" 2>/dev/null)"',
)
MOTIVO = ("wa-scope not found: neither .wa-bin in $PWD nor bin-path in ~/.wa-inbox "
          "or %APPDATA%/wa-inbox names an executable wa-scope; enable the plugin in Orca "
          "so it writes them")
COLAS = {
    "triage": '"$WA/wa-scope" pending --needs-agent --precheck',
    "tick": '"$WA/wa-scope" tick --json',
}


def comando(cola: str) -> str:
    """La linea de shell de una automatizacion: resuelve `WA`, sale con 1 diciendo por que
    en stderr si no hay `wa-scope` ejecutable, y corre `cola`."""
    return f'{"; ".join(FUENTES)}; {HAY} || {{ echo "{MOTIVO}" >&2; exit 1; }}; {cola}'


def bloque_prompt() -> str:
    """El bloque `sh` del prompt, sin las vallas."""
    return "\n".join((*FUENTES, f'{HAY} || echo "wa-scope not found"'))


if __name__ == "__main__":
    formas = {"comando-tick": comando(COLAS["tick"]),
              "comando-triage": comando(COLAS["triage"]), "prompt": bloque_prompt()}
    if len(sys.argv) != 2 or sys.argv[1] not in formas:
        sys.exit(f"uso: resolver_formas.py {'|'.join(formas)}")
    sys.stdout.write(formas[sys.argv[1]])
