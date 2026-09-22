# WhatsApp Inbox

Mapea conversaciones de WhatsApp a proyectos de Plane y define, por conversación,
hasta dónde puede actuar tu agente.

## Requisitos

**Hoy el plugin no lee mensajes.** Las dos vías que tenía —la base local de WhatsApp
Desktop y una sesión de WhatsApp Web conducida por el navegador— se quitaron, y el
sidecar que las reemplaza ya enlaza la línea con un código QR pero todavía no trae los
mensajes. Eso no está escondido: `wa-read` se niega con el motivo estable
`no-transport` y `wa-scope pending` bloquea las automatizaciones, que es lo honesto —
una bandeja siempre vacía se lee como una semana tranquila.

Lo que sí funciona: el registro, el mapeo de conversaciones a proyectos, los permisos
por conversación, los dos paneles y el emparejamiento de la línea.

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

Ese número es también el peor caso para que un mensaje nuevo se vea. El precheck de las
automations —`wa-scope pending`— **no relee WhatsApp**: contesta con lo que dejó el
último sync, porque un precheck que corre cada dos minutos y empieza por la lectura
cara no es un precheck.

Si el sync deja de correr, el precheck **no** dice "no hay nada que hacer": sale con
código 2 y lo explica. Callarlo dejaría al agente sin correr durante días sin decir por
qué. Mientras no haya transporte, el precheck bloquea con el código `no-transport` por
esa misma razón.


## De dónde lee: todavía de ningún lado

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

**Leer los mensajes llega después.** Hasta entonces `wa-read inbox|chats|chat|media|
whoami|state` salen con código 4 y el motivo `no-transport` en la primera línea de
stderr, y `wa-send` con `send-no-transport`. Negarse es el punto: una lista vacía se
lee como «no hay nada que atender», que es lo contrario de «no puedo leer nada».

Lo que `wa-send` sí sigue haciendo antes de negarse, porque no depende del transporte:
exigir la firma del agente (sin nombre configurado no escribe nada) y **rechazar la
ambigüedad** — la misma conversación puede existir en dos líneas suyas, y elegir «la
primera» le escribe a la equivocada, que no se deshace.

## Otros sistemas operativos

El sidecar no depende del sistema: habla el protocolo multi-dispositivo por WebSocket,
igual en macOS, Linux y Windows. Lo que falta para que el plugin lea en cualquiera de
los tres es el almacén de mensajes, no soporte de plataforma.

**Escribir** sigue a la línea de la conversación, no al revés, y el mismo grupo en dos
líneas no se adivina: se elige con `--line`. Hoy, elegida la línea, `wa-send` se niega
con `send-no-transport` porque no hay por dónde mandar nada.

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

### Las dos automatizaciones corren en esa misma carpeta

Las dos automatizaciones que aporta el plugin —*triage* y *Take what was marked*—
declaran `workspace: "plugin-owned"`, así que Orca las apunta a
`<userData>/plugin-workspaces/ab2web.orca-wa-inbox`: **una carpeta que Orca crea para
el plugin, no un repo tuyo**. No es "un proyecto interno" en el sentido de uno de tus
checkouts: nace vacía, la registra Orca a nombre del plugin, y es la misma en la que
ya vivían `AGENTS.md` y compañía. El plugin nunca nombra una ruta ni elige un repo
tuyo — pide "mi carpeta" y Orca decide cuál es.

Antes no lo declaraban, y por eso aparecían como **"Todavía sin proyecto"**: Orca hace
nacer sin proyecto a toda automatización aportada por un plugin, justamente para no
adivinar en qué repo tuyo trabajar.

Lo que **no** cambia: siguen naciendo **pausadas**. Encender trabajo automático es
decisión suya y Orca nunca la toma por usted, ni al instalar ni al actualizar. Se
encienden una por una desde la lista de Automations, o con:

```
orca automations edit <id> --enabled
```

Al actualizar el plugin, Orca vuelve a conciliar las filas que ya existían **en su
lugar** —las empareja por el `id` del manifiesto, no crea duplicados— y les pone el
destino nuevo. Lo único que respeta intacto es lo que haya tocado usted: si usted le
puso un proyecto a mano, ese se queda.

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
WA=<la carpeta bin/ del plugin instalado>
for t in wa-read wa-send wa-scope; do ln -sf "$WA/$t" ~/.local/bin/$t; done
```

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
npm run setup                     # instala en ../.orca-wa-inbox-deps, NO acá
npx playwright install chromium   # solo la primera vez
npm run check
```

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
