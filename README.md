# WhatsApp Inbox

Mapea conversaciones de WhatsApp a proyectos de Plane y define, por conversación,
hasta dónde puede actuar tu agente.

## Requisitos

**Hay dos vías de lectura y se suman.** La base local de WhatsApp Desktop sólo está
verificada en macOS; la sesión de WhatsApp Web funciona en los tres sistemas y es la
única vía en Linux. Con la sesión web contestando, `wa-read doctor` no marca como
requisito nada de la base local — ver "De dónde lee" y "Otros sistemas" abajo.

| | |
|---|---|
| Sistema | **macOS, Linux o Windows.** La base local está verificada sólo en macOS 26.6; la vía web no depende del sistema. |
| App | **WhatsApp Desktop** (Mac App Store), con sesión iniciada y abierta al menos una vez — sólo para la vía local. Para la vía web alcanza con el navegador de Orca y el teléfono para escanear el QR. |
| Base legible | La base local tiene que poder abrirse. Hoy WhatsApp Desktop en macOS la deja como SQLite **sin cifrar**, y `wa-read doctor` lo comprueba de verdad: lee la cabecera del archivo y cuenta los mensajes. Si algún día la cifran (como en Android, que usa SQLCipher), el archivo va a seguir ahí pero el doctor va a decir que no se puede leer. |
| CLIs | `wa-read`, `wa-send`, `wa-scope`, `wa-transcribe`: viajan dentro del plugin, en su `bin/`. El prompt resuelve esa carpeta en `$WA`; no dependen del `PATH`. |
| Permisos | Accesibilidad para Orca Lab, solo si querés que el agente escriba. Para leer no hace falta, pero sin **Acceso total al disco** macOS te va a preguntar en cada lectura — ver abajo. |

Antes de nada, corré:

```
wa-read doctor
```

Te dice exactamente qué falta y por qué. No se conforma con que los archivos existan:
abre la base y cuenta los mensajes.

**FileVault no es un problema.** Cifra el disco, no el archivo para tu sesión: con la
Mac desbloqueada la base se lee normal. Lo que sí rompería todo es que WhatsApp
empezara a cifrar su propia base.

## Cuándo lee, y por qué el Mac pregunta

La base de WhatsApp vive en un Group Container y pesa unos 260 MB. **Se abre en un solo
momento: el sync del worker**, cada 5 minutos por defecto. Lo podés cambiar en el panel
(*Cada cuánto revisa WhatsApp*) o por terminal:

```
wa-scope config sync_minutes 10
```

Ese número es también el peor caso para que un mensaje nuevo se vea. El precheck de las
automations —`wa-scope pending`— **no abre WhatsApp**: contesta con lo que dejó el
último sync, porque un precheck que corre cada dos minutos y empieza copiando 260 MB no
es un precheck. En la práctica un mensaje tarda, como mucho, `sync_minutes` más lo que
falte para el próximo disparo de la automation.

Si el sync deja de correr, el precheck **no** dice "no hay nada que hacer": sale con
código 2 y lo explica. Callarlo dejaría al agente sin correr durante días sin decir por
qué.

Y si WhatsApp no escribió nada desde el sync anterior, no se relee: la fecha y el tamaño
del archivo alcanzan para saberlo, y copiarlo de nuevo daría exactamente la misma lista.

**El cartel de "Orca solicita acceso a datos de otras apps"** sale de ahí: macOS lo
levanta en cada proceso que toca ese contenedor si Orca Lab no tiene Acceso total al
disco. Se concede una sola vez en *Ajustes del Sistema → Privacidad y seguridad → Acceso
total al disco → agregar Orca Lab*, y `wa-read doctor` lo lista como opcional con esa
misma instrucción.

## De dónde lee: dos vías, y se suman

El plugin lee la base local `ChatStorage.sqlite` que deja WhatsApp Desktop. Esa base
es **una sola línea**: la del teléfono con el que se instaló la app.

La segunda vía es una **sesión de WhatsApp Web** con su propio perfil de navegador,
conducida por el navegador de Orca. No es un reemplazo de la base local — donde hay
base local, la base local manda — es **otra línea**: el número de soporte de la
empresa, una cuenta comercial aparte. Es también la única vía posible en Linux.

Se conecta **desde el panel de ajustes**, en *Líneas conectadas*: el botón «Conectar
cuenta» crea el perfil de navegador aislado, abre la pestaña en `web.whatsapp.com`,
registra la línea y enciende la vía web. Lo único que queda para el humano es escanear
el QR, y el panel sigue el estado real de la sesión mientras tanto — esperando el
escaneo, enlazada, caída, sin pestaña — y ofrece la acción que resuelve cada uno.
Antes eran cuatro comandos de terminal, que es otra forma de decir que no existía.

La pestaña va al **espacio flotante** (`--worktree floating`), fuera de los proyectos,
para que sobreviva a cerrar el proyecto en el que estabas. Ese selector es nuevo
(orca-oss PR #410): si este Orca no lo tiene, la pestaña cae en un proyecto con nombre
y el panel dice en cuál y que se cierra junto con él.

El diseño completo —dónde vive cada sesión, cómo se enlaza con el QR, cómo se
identifica una cuenta, qué pasa cuando la sesión se cae— está en
[`docs/LECTURA-MULTIFUENTE.md`](docs/LECTURA-MULTIFUENTE.md).

Conducir el navegador es ejecutar la CLI de Orca, así que el plugin declara
`process:spawn`. Orca escribe esa línea del diálogo de consentimiento, no el plugin:
dice que el plugin puede arrancar programas como vos. Lo que el plugin hace con eso es
sólo esto — abrir y manejar la pestaña de WhatsApp Web — y lo dice su descripción, que
es el único texto de ese diálogo que el plugin sí controla.

Lo que la vía web cuesta, dicho antes de encenderla: sin historial viejo (solo lo que
la sesión ya cargó), más lenta, gasta un puesto de dispositivo enlazado, y la sesión
se puede caer. Y conectar una línea **no autoriza nada**: sigue rigiendo negar por
defecto, conversación por conversación.

## Otros sistemas operativos

Sé honesto con esto en vez de prometer lo que no probé:

- **Windows** — WhatsApp Desktop existe, pero guarda sus datos en otro formato y otra
  ruta (`%LOCALAPPDATA%\Packages\...`). **No verificado.** Para soportarlo habría que
  confirmar si la base es legible y sumar una entrada a `SOURCES`.
  El resto (`wa-scope`, el mapeo, el panel) es portable tal cual.
- **Linux** — no hay WhatsApp Desktop oficial ni la va a haber. La vía que aplica ahí
  es la sesión web, que ya contesta `chats`, `whoami` e `inbox` desde una sesión viva
  del navegador de Orca. `chat` y `media` no: piden el cuerpo de cada mensaje y la ruta
  de cada adjunto, y un navegador no tiene ninguno de los dos. Por esa vía la bandeja
  sale sin texto salvo que se pida (`read_web_text`) y siempre sin rutas de adjuntos;
  `wa-read doctor` lo dice así en cada plataforma. Con el texto pedido, cada corrida
  deja un oyente en la página que anota el cuerpo de **lo que la bandeja puede atender**
  — te nombran, contestan algo tuyo, o es un directo, más lo que caiga en la ventana de
  `--window` alrededor — y lo guarda en `~/.wa-inbox/capture.db` (0600, `capture_max`
  20.000 cuerpos, `capture_days` 90 días); apagar `read_web_text` vacía los cuerpos. La
  conversación de grupo que no te nombra **no se guarda nunca**. Sin el oyente el texto
  casi nunca llega: la sesión solo tiene en memoria el último mensaje de cada
  conversación. Por esta vía la ventana arranca cuando se enlazó la línea, no
  `inbox_days` atrás; `--days` la abre igual.
  Ver [`docs/LECTURA-MULTIFUENTE.md`](docs/LECTURA-MULTIFUENTE.md).

La parte de **escribir** depende de la accesibilidad del sistema vía `orca computer`,
que sí es multiplataforma; pero sin lectura no hay nada que responder.

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
- Si borrás el archivo, el plugin lo vuelve a escribir entero.

El plugin distingue las dos cosas con un sha256 de lo último que él escribió, que
guarda en `.harness.json` al lado. Es la misma regla que usa Orca para los campos de
una automatización de un plugin.

Si esta versión de Orca todavía no le da carpeta al plugin, no se siembra nada, el
motivo queda en el estado que lee el panel y **todo lo demás funciona igual**.

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
WA=<la carpeta bin/ del plugin instalado>
for t in wa-read wa-send wa-scope; do ln -sf "$WA/$t" ~/.local/bin/$t; done
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
| `scripts/check-clis` | que los cuatro CLIs de `bin/` arranquen de verdad —8 invocaciones— más 308 comprobaciones de ajustes, fuentes, migración y vía web. Compilar no alcanza. Incluye la jaula que impide que el chequeo le toque la sesión de WhatsApp Web al usuario, y su control: sin la jaula, el caso se pone rojo. |
| `scripts/check-closing` | 36 pruebas del aviso de cierre contra una base temporal: el guardia del backlog, un aviso por tarjeta, `completed` vs `cancelled`, y el permiso. Corre el CLI de verdad, con `HOME` movido para no tocar la base real. |
| `node test/manifest.test.mjs` | 1 prueba de contrato sobre `orca-plugin.json`: que lo que el manifiesto declara exista en el árbol. |
| `test/panels.test.mjs` | 232 pruebas sobre los paneles con jsdom y el puente del host simulado, incluidos los tres finales de la búsqueda de conversaciones, el botón de reintento, y el marcador `[web:no-text]` dicho en palabras en los tres idiomas. |
| `test/worker.test.mjs` | 58 pruebas sobre `main.mjs` con el host simulado: que un sync que falla deje escrito el motivo, que el pedido del panel se atienda una sola vez, y la siembra del arnés entera — que aparezcan los cuatro archivos, que la referencia salga del `--help` de verdad, y que una segunda activación respete lo que el usuario editó mientras actualiza lo que no tocó. Corre con `HOME` movido: no toca WhatsApp ni la carpeta real. |
| `npm run shots` | 144 capturas: los dos paneles a 1440, 768, 390 y 320 px en tema claro y oscuro, más los tres estados de la búsqueda, los cuatro de conectar una línea —antes de conectar, esperando el escaneo, enlazada, caída—, el equipo que lee sólo por la vía web y la bandeja sin texto, a 1440 y 320. Falla si algo desborda a lo ancho. |

`scripts/` es herramienta de desarrollo; `bin/` son los cuatro CLIs que el plugin
publica. No se mezclan.

Las capturas salen a `docs/capturas/` y **no se versionan**: hoy son 65 MB de salida de
build para un plugin que versionado pesa menos de 1 MB, y el marketplace clona el repo
entero en cada instalación. Se regeneran con `npm run shots`.
