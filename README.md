# WhatsApp Inbox

Mapea conversaciones de WhatsApp a proyectos de Plane y define, por conversación,
hasta dónde puede actuar tu agente.

## Requisitos

**El plugin lee cuando hay una línea enlazada, y no antes.** Se enlaza desde el panel
de ajustes escaneando un código QR; a partir de ahí un proceso hijo mantiene la línea
abierta y guarda lo que llega. Sin línea enlazada, `wa-read` se niega con el motivo
estable `no-transport` y `wa-scope tick` lo dice en su resumen (`sin_transporte`) sin
aprobar ni encolar nada, que es lo honesto — una bandeja siempre vacía se lee como una
semana tranquila.

Enlazada la línea, los mismos comandos contestan con código 0, y una lista vacía
significa que de verdad no hubo nada. Las dos respuestas son distintas a propósito:
confundirlas es leer «no puedo leer nada» como «no hay nada que atender».

| | |
|---|---|
| Sistema | **macOS, Linux o Windows.** El sidecar habla el protocolo multi-dispositivo, que no depende del sistema. |
| App | **Ninguna.** No hace falta WhatsApp Desktop ni un navegador: la línea se enlaza escaneando un QR desde el panel de ajustes, con el teléfono. |
| CLIs | `wa-read`, `wa-send`, `wa-scope`, `wa-transcribe`: viajan dentro del plugin, en su `bin/`. El prompt resuelve esa carpeta en `$WA`; no dependen del `PATH`. |
| Permisos | El plugin declara `process:spawn` porque el sidecar es un proceso hijo. Sin ese permiso concedido, el panel lo dice con su propio código y manda a *Revisar y activar*. |

Antes de nada, ejecute:

```
wa-read doctor
```

Le dice qué falta y por qué. Hoy siempre va a nombrar el transporte que falta; el resto
de los renglones son opcionales y no bloquean.

## Cada cuánto revisa, y qué pasa mientras no hay transporte

El worker relee WhatsApp cada 5 minutos por defecto. Lo puede cambiar en el panel
(*Cada cuánto revisa WhatsApp*) o por terminal:

```
wa-scope config sync_minutes 10
```

Ese número ya no es el peor caso para que un mensaje nuevo se vea: el worker corre
`wa-scope ingest` apenas el sidecar guarda un mensaje, y `wa-scope tick` lo repite cada
minuto por si ese aviso se perdió. El precheck del agente —`wa-scope pending
--needs-agent --precheck`— **no relee WhatsApp**: mira solo la base de casos, y sale con 1,
callado, cuando ningún caso necesita lenguaje o cuando el tick ya abre al agente de casos
por terminal (Orca crea un espacio por cada corrida de un plugin, aunque falle).


## De dónde lee

Los dos transportes viejos se quitaron enteros. En su lugar hay un **sidecar** que
habla el protocolo multi-dispositivo de WhatsApp: corre como proceso hijo del worker
—no dentro de él, porque el sandbox del worker borra `WebSocket` y revienta al resolver
`net`/`tls`— y su estado se espeja al panel por el almacén del plugin.

Se enlaza **desde el panel de ajustes**, en *Vinculación de WhatsApp*: el panel dibuja
el código QR y usted lo escanea con el teléfono. El QR rota cada ~20 s y el panel no
dibuja uno vencido: escanear algo muerto y no entender por qué falla es peor que
esperar. La sesión queda guardada fuera del árbol del plugin, en
`<userData>/plugins-data/<publisher>.<id>/wa-auth/`, porque ese árbol está verificado
por content-hash y un archivo nuevo ahí lo deja en «No válido».

Lo que ese proceso recibe va a un **almacén de mensajes** propio, en
`~/.wa-inbox/capture.db`, al lado del registro de alcance y fuera del árbol del plugin
por la misma razón que la sesión. `wa-read` es la capa de consulta sobre ese almacén y
nunca escribe en él.

Tres cosas que no son detalles de implementación:

- **Una conversación en `off` no deja ningún cuerpo en disco.** El corte ocurre antes
  de escribir, no al consultar. Lo que sí queda es que la conversación existe —su
  identificador, su nombre visible y su hora— porque sin eso no se la podría ofrecer
  nunca para autorizarla, y eso no es el texto de nadie.
- **El almacén tiene tope y caducidad** (`capture_max`, `capture_days`, editables), con
  permisos `0600`. Un almacén sin tope es un archivo de conversaciones ajenas que nadie
  borra. Cuando el tope muerde, se dice: el panel lo muestra y `wa-read state` trae
  cuánto se desalojó y cuándo.
- **La llave es `(línea, conversación, mensaje)`.** La misma conversación vista desde
  dos líneas suyas es el mismo identificador de WhatsApp, y servir el cuerpo de una al
  preguntar por la otra sería contestar sobre una conversación ajena.

Sin línea enlazada, `wa-read inbox|chats|chat|media|whoami|state` salen con código 4 y
el motivo `no-transport` en la primera línea de stderr, y `wa-send` con
`send-no-transport`, también con código 4. Negarse es el punto: una lista vacía se lee
como «no hay nada que atender», que es lo contrario de «no puedo leer nada».

## Escribir

La línea envía por el mismo sidecar que escucha: él tiene el socket. `wa-send` es
Python y no puede llamarlo, así que deja la petición en la bandeja de salida del almacén
—la tabla `envio` de `capture.db`, que los dos extremos ya abren— y espera ahí el
veredicto. El porqué de ese camino, y no el canal del panel, está en
`sidecar/src/envio.js`.

Tres cosas que ese camino garantiza:

- **Se entrega una sola vez.** Cada petición lleva su `--id`, y el mismo `--id` entrega
  una vez: si el veredicto tarda y se vuelve a preguntar, no sale dos veces. Un mensaje
  repetido en el grupo de un cliente no se retira.
- **Siempre hay respuesta.** Es un comando corto: termina con un veredicto o con un
  plazo vencido, nunca colgado.
- **Los motivos son distintos.** `send-no-transport` (la línea no está corriendo) y
  `send-rejected` (la línea está y WhatsApp lo rechazó) son códigos separados, porque lo
  que el dueño tiene que hacer con cada uno es distinto.

Y lo que `wa-send` comprueba ANTES de mirar si hay por dónde, en este orden: la **firma**
del agente (sin nombre configurado no escribe nada), la **línea** —la misma conversación
puede existir en dos líneas suyas, y elegir «la primera» le escribe a la equivocada, que
no se deshace—, y el **permiso** del registro. Quien llama se entera de lo primero que
está mal con lo que pidió, no de un fallo genérico al final.

**`borrador` ya no deja el texto escrito en el chat**, y no puede: el protocolo de
WhatsApp no tiene borradores del lado del servidor. Esa escalera solo existía mientras
el agente conducía una pantalla. Hoy el texto se guarda y espera: `wa-send --drafts`
lista lo que hay, y lo único que lo pone en la línea es la aprobación del dueño.

**Solo el dueño aprueba.** Un mensaje retenido sale cuando el dueño lo aprueba en el
tablero o contesta el aviso del plugin por WhatsApp, y por ningún otro camino. Antes,
cualquier sesión que pudiera correr la CLI podía aprobarlo con `wa-send --approve` (el
2026-10-02 la sesión de un proyecto aprobó sus propios avisos). Ahora el plugin guarda una
llave al azar, legible solo por su usuario, y se la pasa únicamente a esas dos llamadas;
sin ella `--approve` se niega con `send-approve-not-owner` y no sale nada. Lo mismo vale para
firmar un caso como el dueño: `wa-scope caso aprobar --actor dueno` sin esa llave se niega con
`E_NOT_OWNER`. Los mensajes retenidos que no son de ningún caso (el aviso de la sesión de un
proyecto que frenó el piso, por ejemplo) aparecen en el tablero, en «Mensajes retenidos», con
su texto y su motivo, para aprobarlos o cancelarlos desde ahí. Cada aprobación
queda en la actividad con quién la dio (el tablero o la respuesta por WhatsApp). Es una
barrera contra un agente equivocado o mal dirigido, no contra código del mismo usuario que
lea esa llave a propósito.

Lo que se le manda al chat del propio dueño, o al directo de un Operador o un Super admin,
no se retiene y no necesita aprobación: una sesión de un proyecto puede preguntarle algo al
dueño y esperar su respuesta con `wa-read wait --chat <jid> --after <stanza_id>`.

## Otros sistemas operativos

El sidecar no depende del sistema: habla el protocolo multi-dispositivo por WebSocket,
igual en macOS, Linux y Windows, y el almacén de mensajes va al mismo lugar que el
registro de alcance en los tres.

**Escribir** sigue a la línea de la conversación, no al revés, y el mismo grupo en dos
líneas no se adivina: se elige con `--line`. Leer también acepta `--line`, y cada fila
de la bandeja viaja con su línea.

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

## El arnés del agente: `AGENTS.md` y compañía

Todo lo que el agente sabía vivía en el prompt, que se lee una vez por corrida: un
modelo más chico improvisa. Ahora el plugin siembra cuatro archivos en su propia
carpeta de trabajo (`<userData>/plugin-workspaces/ab2web.orca-wa-inbox`) cada vez que
arranca, y ahí son contexto permanente — Orca además le mete el `AGENTS.md` de la
carpeta al agente sin que nadie se lo pida.

| archivo | qué lleva |
|---|---|
| `AGENTS.md` | las cinco reglas duras: la credencial no pasa por el agente, sin `responder` no se envía, en la duda no se abre tarjeta, una conversación `ninguno` nunca abre una, y el idioma sale de `wa-scope voice` |
| `COMMANDS.md` | cada comando con sus banderas reales, generado del `--help` de las propias herramientas: no puede envejecer en silencio |
| `CLASSIFICATION.md` | qué es soporte y qué no, de las 266 menciones reales que armaron la tabla |
| `EXAMPLES.md` | un mensaje atendido bien y uno atendido mal, paso a paso |

**Son tuyos para editar.** La regla está escrita en la cabecera de cada archivo, así
que no hace falta leer el código para saberla:

- Una sección `##` que **no tocaste** se reemplaza con la versión nueva del plugin.
- Una sección `##` que **editaste** es tuya desde ese momento: el plugin conserva tu
  texto y no vuelve a reescribir esa sección. Las demás siguen actualizándose.
- Una sección `##` que **agregaste** se conserva, al final del archivo.
- Si borra el archivo, el plugin lo vuelve a escribir entero.

El plugin distingue las dos cosas con un sha256 de lo último que él escribió, que
guarda en `.harness.json` al lado. Es la misma regla que usa Orca para los campos de
una automatización de un plugin.

Si esta versión de Orca todavía no le da carpeta al plugin, no se siembra nada, el
motivo queda en el estado que lee el panel y **todo lo demás funciona igual**.

### Automations

The plugin declares two automations. Both run in the folder Orca creates for the
plugin (`workspace: "plugin-owned"`, `<userData>/plugin-workspaces/ab2web.orca-wa-inbox`),
never in one of your repos. They need Orca 1.4.160-lab.84 or later, the first build with
command-only automations (`engines.orca` says `>=1.4.160`: Orca compares only
`x.y.z`, so a 1.4.160 build older than lab.84 does not load this manifest at all).

| id | What it runs | When | Model tokens |
|---|---|---|---|
| `tick` | `wa-scope tick`: picks up any message the live trigger missed, approves by the owner's rule every clean reply on a `responder` chat, sends it through `wa-send --send` (Jev and the fixed exception floor still review it), and refreshes the board and badge | every minute | none: it is a command, no agent and no terminal |
| `triage` | the case agent, with `prompts/triage.md`: it drafts a reply, classifies, or proposes work for the cases that need language | every 5 minutes, any hour, plus right away when the owner presses "Atender ahora" on the board | only when its precheck `wa-scope pending --needs-agent --precheck` finds a case that needs language and the tick is not launching the case agent itself (it has not run for 3 minutes, or its last launch failed in a way the automation does not share); otherwise the run is `skipped_precheck` and Orca creates no workspace for it |

What never leaves on its own: anything with an exception (money, a credential, a
commitment, a Jev flag or a Jev error) and anything on a chat in `borrador`. Those stay
in *Your decision* on the board. A reply that Jev or the floor holds back is left as a
draft with the case's own request id, so approving it from the board sends that same
draft once.

**New automations arrive paused.** Orca never turns on scheduled work for you, neither
on install nor on update. Turn each one on from the Automations list, or with
`orca automations edit <id> --enabled`.

**How updates behave.** Every plugin update changes its content hash, so Orca asks you
to approve the plugin again; that approval reconciles the automations:

- a row whose `id` is still declared is updated **in place**: name, prompt, precheck,
  command, provider, schedule and time zone follow the new manifest, unless you edited
  that field yourself, in which case your value stays (`orca automations show <id>`
  lists it under the fields you edited). Whether it is enabled is never touched, so
  `triage` keeps the on/off you gave it;
- a new `id` (here, `tick`) is created paused;
- an `id` the plugin no longer declares is deleted with its run history. `take`
  (*Take what was marked*) is gone: the board replaced it.

Disabling the plugin deletes its automations, and enabling it again recreates them
paused: after a disable/enable you turn them on again.

## Lo que el plugin NO hace

- No sale a internet: no declara `net:fetch`. Todo es local.
- No envía nada por su cuenta. Sin supervisión deja **borradores**.
- No toca chats que no estén en el registro. Lo que no autorizaste, no existe para él.
- No trae nombre de agente puesto. Lo elige usted, y firma cada mensaje con él.

## Los CLIs tienen que estar en el PATH

Esto es solo para los comandos que el panel te ofrece copiar: **las automations ya no
dependen del PATH** — resuelven el `bin/` del plugin instalado al arrancar, porque el
agente corre en un worktree del workspace y ahi no existe ningun `./bin/`.

El panel emite comandos sin ruta (`wa-scope list`), asi que `wa-read`, `wa-send` y
`wa-scope` tienen que resolverse desde tu shell:

```
mkdir -p ~/.local/bin
WA="$(cat ~/.wa-inbox/bin-path)"
for t in wa-read wa-send wa-scope; do ln -sf "$WA/$t" ~/.local/bin/$t; done
```

`bin-path` lo reescribe el plugin cada vez que arranca, con la ruta del `bin/` del plugin
instalado (en Windows, `%APPDATA%\wa-inbox\bin-path`). Un agente de cualquier proyecto lo
lee igual para correr las herramientas sin depender del PATH.

## Elija la terminal destino

`workspace.readContext` devuelve los terminales del worktree **solo por id** — no dice
si cada uno es una shell o una sesion de agente. El panel no puede adivinarlo, asi que
lo elige usted en "Terminal destino" y queda recordado.

Si apunta a una sesion de agente, el agente va a leer los comandos como si le hablaras
en vez de ejecutarlos.

## Desarrollo

El arnés de verificación vive en este mismo repo, junto al plugin. Antes se quedaba
afuera y quien clonaba no podía correr nada.

```
npm run setup    # instala en ../.orca-wa-inbox-deps, NO acá
npm run check
```

`setup` crea el directorio hermano, escribe su `package.json` desde
`scripts/deps.package.json` —la única lista de dependencias del arnés— e instala ahí,
incluido el navegador que usan las capturas. Basta con eso: no hace falta un
`playwright install` aparte.

Necesita **Node** y **Python ≥ 3.10** (varios `scripts/check-*` usan sintaxis de 3.10;
el `python3` de macOS es 3.9 y no sirve).

`npm install` **acá adentro** rompe el plugin: dejaría un `node_modules` dentro de la
carpeta que el marketplace clona y que Orca carga. Por eso las dependencias del arnés
viven fuera del árbol y `npm run setup` es lo que las pone donde van.

`check` corre, en orden:

| | qué comprueba |
|---|---|
| `scripts/check-panels` | que el `<script>` inline de `config.html` y `activity.html` parsee. Si no parsea, el panel se renderiza vacío y sin error visible. |
| `scripts/check-prompts` | que `prompts/*.md` y `harness/*.md` no tengan voseo. El agente le escribe a clientes en Colombia. |
| `scripts/check-harness` | que ninguna regla dura se haya perdido al mudar doctrina del prompt al arnés: cada una tiene que seguir alcanzable por los dos caminos, el `AGENTS.md` y los dos prompts. |
| `scripts/check-clis` | que los cuatro CLIs de `bin/` arranquen de verdad —8 invocaciones— más 134 comprobaciones de ajustes, migración, precheck y el contrato de negarse sin transporte: los seis comandos de lectura con su código estable y stdout vacío, y el envío con la firma y la ambigüedad comprobadas antes. Compilar no alcanza. |
| `scripts/check-closing` | 36 pruebas del aviso de cierre contra una base temporal: el guardia del backlog, un aviso por tarjeta, `completed` vs `cancelled`, y el permiso. Corre el CLI de verdad, con `HOME` movido para no tocar la base real. |
| `node test/manifest.test.mjs` | 2 pruebas de contrato sobre `orca-plugin.json`: la capacidad que el worker necesita, y que la descripción no prometa lo que el plugin ya no hace. |
| `test/panels.test.mjs` | 221 pruebas sobre los paneles con jsdom y el puente del host simulado, incluidos los tres finales de la búsqueda de conversaciones, el botón de reintento, los cinco estados del QR y que ningún código del CLI llegue a pantalla sin traducir. |
| `test/worker.test.mjs` | 77 pruebas sobre `main.mjs` con el host simulado: que un sync que falla deje escrito el motivo, que el pedido del panel se atienda una sola vez, el lanzamiento y la caída del sidecar con sus códigos estables, y la siembra del arnés entera. Corre con `HOME` movido: no toca la carpeta real. |
| `npm run shots` | 192 capturas: los dos paneles a 1440, 768, 390 y 320 px en tema claro y oscuro, más los tres finales de la búsqueda, los cinco estados de la vinculación por QR, el equipo sin transporte y los dos estados de un guardado —en vuelo y fallido—. Falla si algo desborda a lo ancho. |

`scripts/` es herramienta de desarrollo; `bin/` son los cuatro CLIs que el plugin
publica. No se mezclan.

Las capturas salen a `docs/capturas/` y **no se versionan**: hoy son 65 MB de salida de
build para un plugin que versionado pesa menos de 1 MB, y el marketplace clona el repo
entero en cada instalación. Se regeneran con `npm run shots`.
