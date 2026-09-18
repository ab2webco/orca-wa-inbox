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

## Cuando la tarjeta se cierra

El flujo también vuelve: cuando una tarjeta llega a un estado final, la conversación que
la originó se entera. **Y eso es lo único del tablero que sale de ahí** — los
comentarios internos del equipo no se espejan nunca en un grupo de un cliente.

- **Un aviso por tarjeta**, no por mensaje. Cinco mensajes sobre lo mismo comparten
  tarjeta y comparten aviso.
- **Cerrado no es una sola cosa.** Una tarjeta `completed` se avisa como resuelta; una
  `cancelled` se avisa como cancelada. Decirle "listo" a un cliente sobre algo que se
  canceló es afirmar algo falso, así que el texto lo arma `wa-scope` y no el agente.
- Se decide por el **grupo** del estado (`backlog / unstarted / started / completed /
  cancelled`), nunca por el nombre de la columna: cada proyecto la bautiza distinto.
- Con permiso `borrador` el aviso queda escrito sin enviar. Con `observar` u `off` no se
  escribe nada, y esa decisión queda anotada en el panel de actividad — es el único
  lugar donde se ve, porque en el chat, por definición, no queda nada.
- **Un comentario del tablero que empiece con `[cliente]`** es la excepción: ese texto
  sale tal cual, solo, en lugar del mensaje armado y sin el resto del hilo. Sin esa
  marca, ningún comentario se copia al chat.
- Lo que se cerró **antes** de que esto existiera no avisa nada. La primera vez que
  corre, `wa-scope` guarda una línea de corte (`closing_since`) y marca como avisado
  todo lo que ya estaba abierto: estrenar la función no puede mandar una ráfaga de
  mensajes a grupos de clientes.

## Lo que el plugin NO hace

- No sale a internet: no declara `net:fetch`. Todo es local.
- No envía nada por su cuenta. Sin supervisión deja **borradores**.
- No toca chats que no estén en el registro. Lo que no autorizaste, no existe para él.
- No trae nombre de agente puesto. Lo elegís vos, y firma cada mensaje con él.

## Los CLIs tienen que estar en el PATH

Esto es solo para los comandos que el panel te ofrece copiar: **las automations ya no
dependen del PATH** — resuelven el `bin/` del plugin instalado al arrancar, porque el
agente corre en un worktree del workspace y ahi no existe ningun `./bin/`.

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
| `scripts/check-closing` | 36 pruebas del aviso de cierre contra una base temporal: el guardia del backlog, un aviso por tarjeta, `completed` vs `cancelled`, y el permiso. Corre el CLI de verdad, con `HOME` movido para no tocar la base real. |
| `test/panels.test.mjs` | 90 pruebas sobre los paneles con jsdom y el puente del host simulado, incluidos los tres finales de la búsqueda de conversaciones y el botón de reintento. |
| `test/worker.test.mjs` | 19 pruebas sobre `main.mjs` con el host simulado: que un sync que falla deje escrito el motivo, y que el pedido del panel se atienda una sola vez y se pare al apagar el plugin. Las herramientas son guiones falsos en un directorio temporal: no toca WhatsApp. |
| `npm run shots` | fotografía los dos paneles a 1440, 768, 390 y 320 px en tema claro y oscuro, más los tres estados de la búsqueda a 1440 y 320, y falla si algo desborda a lo ancho. |

`scripts/` es herramienta de desarrollo; `bin/` son los cuatro CLIs que el plugin
publica. No se mezclan.

Las capturas salen a `docs/capturas/` y **no se versionan**: son 3.3 MB de salida de
build para un plugin de 188 KB, y el marketplace clona el repo entero en cada
instalación. Se regeneran con `npm run shots`.
