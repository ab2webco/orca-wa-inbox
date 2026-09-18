# WhatsApp Inbox

Mapea conversaciones de WhatsApp a proyectos de Plane y define, por conversación,
hasta dónde puede actuar tu agente.

## Requisitos

**Hoy esto solo funciona en macOS.** No es una decisión de diseño, es lo único que
está verificado — ver "Otros sistemas" abajo.

| | |
|---|---|
| Sistema | **macOS**. Verificado en macOS 26.6. |
| App | **WhatsApp Desktop** (Mac App Store), con sesión iniciada y abierta al menos una vez. |
| Base legible | La base local tiene que poder abrirse. Hoy WhatsApp Desktop en macOS la deja como SQLite **sin cifrar**, y `wa-read doctor` lo comprueba de verdad: lee la cabecera del archivo y cuenta los mensajes. Si algún día la cifran (como en Android, que usa SQLCipher), el archivo va a seguir ahí pero el doctor va a decir que no se puede leer. |
| CLIs | `wa-read`, `wa-send`, `wa-scope` en `~/tools` (o donde apunte `toolsDir`). |
| Permisos | Accesibilidad para Orca Lab, solo si querés que el agente escriba. Para leer no hace falta. |

Antes de nada, corré:

```
wa-read doctor
```

Te dice exactamente qué falta y por qué. No se conforma con que los archivos existan:
abre la base y cuenta los mensajes.

**FileVault no es un problema.** Cifra el disco, no el archivo para tu sesión: con la
Mac desbloqueada la base se lee normal. Lo que sí rompería todo es que WhatsApp
empezara a cifrar su propia base.

## WhatsApp Web no sirve

El plugin lee la base local `ChatStorage.sqlite` que deja WhatsApp Desktop.
**WhatsApp Web no deja base local**: los mensajes viven en el IndexedDB del navegador,
atados al origen `web.whatsapp.com` y a su propio cifrado. No hay archivo que leer.

Si solo usás WhatsApp Web, no hay camino de lectura. Instalá WhatsApp Desktop —
comparte la misma cuenta y no consume un dispositivo vinculado extra.

## Otros sistemas operativos

Sé honesto con esto en vez de prometer lo que no probé:

- **Windows** — WhatsApp Desktop existe, pero guarda sus datos en otro formato y otra
  ruta (`%LOCALAPPDATA%\Packages\...`). **No verificado.** Para soportarlo habría que
  confirmar si la base es legible y reescribir la capa de lectura de `wa-read`.
  El resto (`wa-scope`, el mapeo, el panel) es portable tal cual.
- **Linux** — no hay WhatsApp Desktop oficial. Solo web, y ya vimos que web no deja
  base local. Sin camino hoy.

La parte de **escribir** depende de la accesibilidad del sistema vía `orca computer`,
que sí es multiplataforma; pero sin lectura no hay nada que responder, así que el
cuello de botella es la base local.

## Lo que el plugin NO hace

- No sale a internet: no declara `net:fetch`. Todo es local.
- No envía nada por su cuenta. Sin supervisión deja **borradores**.
- No toca chats que no estén en el registro. Lo que no autorizaste, no existe para él.
- No trae nombre de agente puesto. Lo elegís vos, y firma cada mensaje con él.

## Los CLIs tienen que estar en el PATH

El panel emite comandos sin ruta (`wa-scope list`), asi que `wa-read`, `wa-send` y
`wa-scope` tienen que resolverse desde tu shell:

```
mkdir -p ~/.local/bin
for t in wa-read wa-send wa-scope; do ln -sf ~/tools/$t ~/.local/bin/$t; done
```

## Elegi la terminal destino

`workspace.readContext` devuelve los terminales del worktree **solo por id** — no dice
si cada uno es una shell o una sesion de agente. El panel no puede adivinarlo, asi que
lo elegis vos en "Terminal destino" y queda recordado.

Si apunta a una sesion de agente, el agente va a leer los comandos como si le hablaras
en vez de ejecutarlos.

## Desarrollo

El arnés de verificación vive en este mismo repo, junto al plugin. Antes se quedaba
afuera y quien clonaba no podía correr nada.

```
npm install
npx playwright install chromium   # solo la primera vez
npm run check
```

`check` corre, en orden:

| | qué comprueba |
|---|---|
| `scripts/check-panels` | que el `<script>` inline de `config.html` y `activity.html` parsee. Si no parsea, el panel se renderiza vacío y sin error visible. |
| `scripts/check-prompts` | que `prompts/*.md` no tengan voseo. El agente le escribe a clientes en Colombia. |
| `scripts/check-clis` | que los cuatro CLIs de `bin/` arranquen de verdad. Compilar no alcanza. |
| `test/panels.test.mjs` | 36 pruebas sobre los paneles con jsdom y el puente del host simulado. |
| `npm run shots` | fotografía los dos paneles a 1440, 768, 390 y 320 px en tema claro y oscuro, y falla si algo desborda a lo ancho. |

`scripts/` es herramienta de desarrollo; `bin/` son los cuatro CLIs que el plugin
publica. No se mezclan.

Las capturas salen a `docs/capturas/` y **no se versionan**: son 3.3 MB de salida de
build para un plugin de 188 KB, y el marketplace clona el repo entero en cada
instalación. Se regeneran con `npm run shots`.
