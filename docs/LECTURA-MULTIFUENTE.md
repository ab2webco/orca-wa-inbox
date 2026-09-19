# Leer de varias lineas: la base local y las sesiones de WhatsApp Web

Este documento es el diseno de la via web. **Lee `chats`, `whoami` e `inbox`**; `chat`
y `media` siguen afuera, y no por falta de tiempo: los dos prometen el CUERPO de cada
mensaje y la RUTA en disco de cada adjunto, y una sesion de navegador no tiene ninguno
de los dos. Lo demas — el registro de cuentas, los dos interruptores, el doctor — ya
estaba. Las secciones marcadas **medido** describen lo que se comprobo contra una sesion
viva; el resto sigue siendo diseno.

## Por que existe

La app de escritorio lee **una** linea: la del telefono con el que se instalo. Eso
deja fuera dos casos que no son raros:

1. **Linux.** No hay WhatsApp Desktop oficial. Los wrappers no oficiales envuelven
   `web.whatsapp.com` y no dejan base local.
2. **Un segundo numero.** El numero de soporte de la empresa, una cuenta comercial
   aparte. La app de escritorio ya gasto la unica linea que ese equipo podia tener, y
   ese segundo numero es a menudo el que de verdad se quiere atender — con el alcance
   acotado a unas pocas conversaciones, que es exactamente lo que el registro ya hace.

De ahi la regla que ordena todo lo demas: **la web es una opcion 2, nunca un
reemplazo.** Donde hay base local, la base local manda. La web se **suma**.

## Las fuentes

`bin/wa-read` separa *de donde* se lee de *que* se lee:

| | `LocalSource` | `WebSource` |
|---|---|---|
| origen | `ChatStorage.sqlite` de la app | sesion de navegador en `web.whatsapp.com` |
| plataformas | macOS (verificado), Windows (sin verificar) | todas |
| lineas | una, la del telefono instalado | una por sesion |
| historial | completo | solo lo que la sesion ya cargo |
| velocidad | instantaneo (copia + WAL) | lento (recorre la pagina) |
| coste | ninguno | un puesto de dispositivo enlazado |
| caida | no se cae | se cae (logout, telefono offline) |
| estado | **implementado** | **`chats`, `whoami` e `inbox`; `chat` y `media` no** |
| adjuntos | ruta en disco | **no hay ruta**: viven en el blob store del navegador |
| texto | siempre | opcional y apagado por defecto; solo lo que la sesion tiene en memoria |

`sources()` devuelve las fuentes activas en orden, la local primero.
`read_from_sources()` corre el comando contra cada una y junta las filas. Una fuente
que no puede responder **no devuelve vacio**: levanta `SourceError` con un motivo
estable. Si ninguna contesto, el CLI sale con `EXIT_SOURCE` (4) y el motivo en la
primera linea de stderr, con stdout vacio para que quien parsea JSON lea `[]` y no
reviente. Si alguna contesto, las que fallaron salen como `warning:` y la corrida
sigue: perder la bandeja entera porque una segunda linea esta caida seria cambiar un
hueco por un apagon.

Motivos estables (son contrato; el panel los traduce por codigo):

| motivo | cuando | salida |
|---|---|---|
| `no-source` | `read_local off` y `read_web off` | 4 |
| `local-unavailable` | no hay base que leer | 1 (como siempre) |
| `web-not-implemented` | se pidio `chat` o `media` por la via web | 4 |
| `web-no-orca` | la CLI de Orca no esta, o el runtime no contesta | 4 |
| `web-no-session` | no hay pestana en `web.whatsapp.com` para ese perfil | 4 |
| `web-logged-out` | la pestana esta, pero la sesion no esta enlazada (QR) | 4 |
| `web-line-pending` | la unica linea registrada quedo a medias (`enabled=0`) | 4 |
| `web-no-line` | `read_web on` y ninguna linea registrada | 4 |
| `web-profile-ambiguous` | dos perfiles del navegador contestan a la misma etiqueta | 4 |
| `web-eval-timeout` | la pagina no contesto dentro de `web_timeout_s` | 4 |
| `web-read-failed` | la sonda reviento adentro de la pagina | 4 |
| `web-text-unavailable` | se pidio el texto y la sesion ya no lo expone | 4 |

Son diez motivos web y no uno porque la accion del usuario es distinta en cada uno:
abrir Orca, abrir la pestana, escanear el QR, terminar de enlazar la linea, enlazar la
primera, desambiguar dos perfiles, esperar, recargar, o apagar el texto. `web-session-dropped`, que este
documento nombraba antes, **no existe**: la caida de una sesion se ve de dos maneras
distintas — la pestana cerrada y la pestana sin enlazar — y mandarlas al mismo motivo
le diria a quien tiene el QR en pantalla que abra una pestana que ya esta abierta.

El doctor tiene ademas `web-off`, que no es un fallo: es la via apagada diciendo lo que
cuesta y como se enciende.

### La pestana se elige por identidad de perfil, nunca por ser la primera

`web_page()` solo devuelve una pestana cuyo perfil es el de una linea REGISTRADA Y
HABILITADA, comparando primero contra `profileId` y despues contra `profileLabel`, y
negandose (`web-profile-ambiguous`) si dos perfiles distintos contestan a la misma
etiqueta. Con `read_web on` y ninguna linea habilitada no se lee nada: sale
`web-line-pending` si la que hay quedo a medio enlazar, y `web-no-line` si no hay
ninguna.

Antes, sin linea habilitada, se construia una fuente web SIN perfil y se tomaba la
primera pestana abierta en `web.whatsapp.com`. El razonamiento — "pidio la via web, que
lea 'no esta construida' y no 'no configuraste nada'" — dejo de valer cuando la via se
construyo, y lo que quedo fue peor que un mensaje confuso: en la maquina del dueno, con
`read_web on` y la linea nueva a medio enlazar, el plugin estaba leyendo su WhatsApp
PERSONAL por una sesion que nunca registro como linea. El `enabled=0` que wa-scope
escribe para que una linea a medias no se lea no lo protegia: redirigia al lector a algo
peor. Lo recorre `revisa_linea_sin_enlazar()` en `scripts/check-clis`.

## Los interruptores

Dos, no una lista de tres, porque las fuentes se suman:

- `read_local` — `on` (por defecto) / `off`. Apagarla en un equipo que tiene base es
  una eleccion real: leer solo la linea de la empresa.
- `read_web` — `on` / `off` (por defecto). Arranca apagada porque cuesta un puesto de
  dispositivo enlazado, y eso no se gasta sin que el usuario lo pida.
- `read_web_text` — `off` (por defecto) / `memoria`. **El texto de los mensajes es una
  eleccion aparte de leer la linea**, y esta es la seccion "Como sale el texto" de mas
  abajo. En `off` la bandeja sale igual: quien te nombro, en que conversacion, cuando y
  con que `stanza_id`; el cuerpo sale como `[web:no-text]`.

Se validan como el resto de los enums (`CONFIG_OPCIONES` en `bin/wa_settings.py`), se
guardan en `settings` y viajan al panel por `PANEL_SETTINGS`.

### De donde sale el valor efectivo

Tres fuentes, en este orden, y las dos herramientas usan la MISMA regla porque leen el
mismo modulo (`bin/wa_settings.py`):

1. `WA_READ_SETTING_<CLAVE>` en el entorno — solo para `wa-read`, solo esa corrida.
2. Lo que el panel guardo en el storage del plugin (claves planas: `readLocal`,
   `readWeb`, `readWebText`). **Manda sobre la base**: es lo que el usuario acaba de
   tocar, y `wa-scope config` lo espeja de vuelta en cada escritura.
3. La tabla `settings` de `~/.wa-inbox/scope.db`.

Tenerlo en un solo lado era el defecto: `wa-scope` mezclaba las dos y `wa-read` leia
solo la base, asi que cambiar de donde lee en el panel dejaba a `wa-scope config`
diciendo `read_web on` y a la lectura de verdad apagada, sin que nada lo dijera.

### Cuando una via es requisito

`local_manda = read_local encendida y no (read_web encendida y la sesion contesta)`, y
lo simetrico para la web. Una via apagada no es requisito nunca: con `read_local off` el
doctor dejo de pedir la app de escritorio, que es justo lo que el usuario apago. Con las
dos apagadas sale la fila `no-source`, que bloquea — no hay de donde leer.

## Las dos vias a la vez, y el mismo mensaje dos veces

Las fuentes se suman de verdad: la app de escritorio leyendo el numero personal y una
sesion web leyendo el del bot, en el mismo equipo, una sola bandeja.

Dos lineas que comparten un grupo — o la MISMA linea vista por las dos vias, que es lo
que pasa mientras el bot todavia no tiene numero propio — ven cada mensaje una vez cada
una. `read_from_sources()` funde por `stanza_id`, que es la clave de idempotencia que la
automation escribe en el issue: sin fundir, un mensaje son dos tarjetas.

Quien gana: la PRIMERA fuente, que es la local — trae la ruta del adjunto en disco y el
historial completo, y la web ninguna de las dos. De la segunda se toma solo lo que a la
primera le falta (un cuerpo capturado donde la local no tiene texto, el
`contexto_cerca`), porque quedarse con un lado entero tiraria eso sin decirlo. Las
conversaciones se funden igual por `jid`; lo que no trae ninguna de las dos claves no se
funde — `whoami` devuelve una fila POR LINEA y fundirlas seria borrar la segunda.

Con dos fuentes la bandeja ademas se reordena por fecha y se le vuelve a aplicar el
tope: cada fuente respeto el suyo, y sumarlas devolvia el doble de lo pedido.

## La identidad de una cuenta

Tabla `wa_account` en `~/.wa-inbox/scope.db`:

```sql
id      text primary key   -- 'local', o 'web:<lid>' cuando enlaza
kind    text               -- local | web
label   text               -- para mostrar; NO es la identidad
profile text               -- perfil de navegador de una sesion web
enabled integer
linked_at, updated_at text
```

**El `id` sale de la sesion, no de lo que el usuario escriba.** Al enlazar, la sesion
reporta su LID y ese LID forma el `id` (`web:<lid>`). Una etiqueta escrita a mano se
puede repetir — dos lineas llamadas "Soporte" — y despues de volver a enlazar nadie
podria decir cual es cual; una respuesta mandada desde la linea equivocada no se
deshace. El `label` existe solo para mostrar.

Mientras la sesion no haya enlazado no hay `id`, y sin `id` no puede tener
conversaciones. El hueco intermedio es el **slot**: un directorio de perfil
(`web-1`, `web-2`) que existe antes que la identidad. Una fila de `wa_account` se
escribe recien cuando el LID llega.

## Donde vive la sesion — **medido**

Un perfil de navegador por linea. Sin perfiles separados, la segunda sesion desloguea
a la primera; eso no cambio.

Lo que si cambio es **de quien es el perfil**. Este documento decia que vivia en
`<userData>/plugins-data/ab2web.orca-wa-inbox/web-sessions/<slot>/`, un directorio del
plugin. No es asi: los perfiles son objetos de Orca y el plugin no elige donde se
guardan. `orca tab profile list --json` devuelve

```json
{ "id": "8dfa4223-...", "scope": "isolated", "label": "wa-poc",
  "partition": "persist:orca-browser-session-8dfa4223-..." }
```

y `orca tab list --json` trae `profileId` y `profileLabel` en cada pestana. El plugin
no tiene nada que crear bajo su propio userData: crea un perfil de Orca y se queda con
su `id`.

### Como la cuenta encuentra su pestana

`wa_account.profile` guarda el **`id` del perfil de Orca** — el uuid, que es lo unico
estable de los dos. `web_page()` lista las pestanas, se queda con las que estan en
`web.whatsapp.com`, y de esas con la que coincida en `profileId` **o** en
`profileLabel` — el uuid **primero**, y la etiqueta solo si ninguna pestana coincide
por uuid: la etiqueta se acepta porque es lo que el usuario vio al crear el perfil y lo
que va a escribir si alguna vez edita el registro a mano, pero dos perfiles pueden
llamarse igual y el uuid no. Si dos perfiles distintos contestan a la misma etiqueta,
se niega con `web-profile-ambiguous` en vez de elegir uno. Sin perfil registrado no
sirve ninguna pestana: ver arriba.

## El enlace por QR

El panel no puede ejecutar nada y **no puede embeber WhatsApp Web**. Las dos puntas
lo impiden y las dos estan comprobadas: el shell del panel manda
`default-src 'none'; connect-src 'none'`, y `web.whatsapp.com` responde
`content-security-policy: frame-ancestors https://*.whatsapp.com https://whatsapp.com`.
No hay que intentarlo. La pestana del navegador de Orca **no** es un panel de plugin:
es una vista de navegador de verdad, y por eso si sirve.

El flujo:

1. El panel escribe un pedido en `webRequest` (el mismo camino que `syncRequest`).
2. El worker (`web-lines.mjs`) crea el perfil aislado y abre la pestana en un solo paso:
   `<orca> tab profile create --label <nombre> --scope isolated` →
   `tab create --url https://web.whatsapp.com --profile <id> --worktree <destino>`.
3. Se anota la fila de `wa_account` **ya**, con `wa-scope accounts --connect <perfil>`, y
   con un id provisional `web:pending:<perfil>` y `enabled=0`. Todavia no hay identidad
   — la pone la sesion — y `web_accounts()` solo devuelve las habilitadas, asi que una
   linea a medio enlazar no se puede leer por accidente. Recien ahi se enciende
   `read_web`. El orden ya no es lo que protege — `sources()` se niega con
   `web-line-pending` mientras no haya una linea habilitada — pero se mantiene: es lo
   que hace que el panel no ofrezca una via que va a fallar en cada lectura.
4. El usuario ve el QR **en esa pestana** y lo escanea con el telefono de ESE numero.
5. El worker sondea la sesion cada 3 s con `orca eval` — `localStorage.WALid`, y el
   `canvas[aria-label]` del QR como respaldo — hasta que aparece el LID. No se usa
   `snapshot`: el arbol de accesibilidad describe lo que se ve, y lo que hace falta es
   la identidad, que esta en claro en `localStorage`.
6. Con el LID, `wa-scope accounts --identify` asciende la fila a `web:<lid>`,
   `enabled=1`. Si ya existia una fila con ese LID — el mismo numero enlazado otra vez
   en otro perfil — se la reapunta en vez de duplicarla: las conversaciones autorizadas
   cuelgan del LID.
7. **La pestana se queda abierta.** Cerrarla mata la sesion: WhatsApp Web solo esta
   enlazado mientras la pagina vive. `tab close` corre solo al desvincular.

### Donde vive la pestana

`--worktree floating` la deja en el espacio flotante, fuera de los proyectos, que es el
unico sitio que sobrevive a cerrar el proyecto en el que estaba. Ese selector es nuevo
(orca-oss PR #410) y lo resuelve el RUNTIME, no el binario: por eso se detecta con una
lectura (`tab list --worktree floating`, que contesta `selector_not_found` cuando no
esta) y no leyendo el `--help`, que con un CLI nuevo contra un runtime viejo miente.

Sin ese selector la pestana cae en un proyecto de verdad — el que el usuario esta
mirando, por `workspace.readContext`, o el de actividad mas reciente — y el panel lo
dice con el nombre del proyecto y avisa que se cierra junto con el. Dejarla caer en "el
que estuviera activo" sin nombrarlo es exactamente como se pierde una pestana.

### El nombre del CLI de Orca por plataforma

| plataforma | comando |
|---|---|
| macOS, Windows | `orca` |
| Linux | `orca-ide` |
| cualquiera | `ORCA_CLI_COMMAND` si esta puesta, y gana |

**En Linux `orca` es el lector de pantalla de GNOME.** Ejecutarlo le pone a hablar la
maquina a una persona ciega. `bin/wa-read:orca_cli()` ya resuelve esto y el doctor lo
usa; cualquier codigo nuevo que invoque la CLI tiene que pasar por ahi y no por
`shutil.which("orca")`.

### El plugin no abre ningun socket

El manifiesto no declara `net:fetch` y eso se mantiene. Conducir el navegador de Orca
**no** es el plugin conectandose: es Orca abriendo la conexion, en su propio proceso,
con su propio permiso, exactamente como cuando el usuario navega. El plugin solo
manda comandos de CLI. Esa distincion es la razon entera por la que esto es
aceptable, y por eso esta escrita aca y en el codigo.

## Cuando la sesion se cae

Se cae: logout desde el telefono, telefono offline demasiado tiempo, WhatsApp echando
al dispositivo enlazado mas viejo. Cuando pasa:

- La fuente levanta `SourceError` con `web-no-session` si la pestana ya no esta, o
  `web-logged-out` si esta pero muestra el QR.
- Si hay base local, la corrida sigue con un `warning:` — no se apaga la bandeja.
- El doctor lo muestra como fila `web` **no bloqueante**, con la accion: volver a
  enlazar.
- La cuenta **no se borra**: sus conversaciones autorizadas siguen ahi y vuelven a
  funcionar al re-enlazar con el mismo numero, porque el `id` sale del LID y no de la
  sesion.
- WhatsApp da un numero limitado de dispositivos enlazados por numero (hoy cuatro
  aparte del telefono). Cada linea gasta uno. El doctor lo dice antes de encender la
  via, no despues.

## La conversacion lleva su linea

`chat_scope` esta ahora con llave `(account, chat_jid)`.

Esto no es cosmetico. Dos cuentas propias pueden tener la **misma** conversacion: el
directo con la misma persona visto desde dos numeros tuyos es el mismo
`...@s.whatsapp.net`. Con el jid como llave unica esas dos filas se colapsan en una y
el agente contesta desde la linea equivocada — la misma clase de error que la tarjeta
que se fue al tablero ajeno.

La migracion ya corrio (`migrate_cuentas()`): SQLite no sabe cambiar una primary key,
asi que la tabla se reconstruye una vez, copiando por nombre de columna, y todo lo que
existia queda en la cuenta `local`.

**Conectar una linea no autoriza nada.** Sigue rigiendo la regla de siempre: negar por
defecto. Una conversacion de una cuenta nueva no existe para el agente hasta que
alguien la registre con `wa-scope set`, con su permiso. `wa-scope accounts` muestra el
conteo de conversaciones autorizadas por linea justo para que un cero se vea.

## Enviar tiene que elegir la linea

`bin/wa-send` conduce la app de escritorio, que **es** la cuenta `local`. Una
conversacion de una cuenta web no se puede contestar por ahi: escribiria desde el
numero equivocado a un cliente.

La costura: antes de tocar nada, resolver la cuenta de la conversacion y despachar por
ella — app de escritorio para `local`, pestana del navegador para `web:<lid>`. Si la
cuenta no coincide con la via, **fallar cerrado** con un motivo estable
(`wrong-account`), nunca caer a la via por defecto. Es el mismo criterio de
`--open url`, que ya muere antes de tocar WhatsApp cuando el JID no es un directo.

## Como lee la sesion — **medido**

`read_from_sources()` le pide a cada fuente una **conexion SQLite** y despues corre el
comando contra ella. `WebSource.open()` devuelve exactamente eso: una base temporal con
la forma de la de macOS, poblada desde la sesion. Los `cmd_*` no se tocaron y no saben
de donde salieron sus filas, que es lo que hace que la via de macOS no pueda regresar
por un cambio de aca.

De la base de macOS se recrean **solo las columnas que las dos consultas leen**:

| tabla | columnas | para que |
|---|---|---|
| `ZWACHATSESSION` | `Z_PK`, `ZCONTACTJID`, `ZPARTNERNAME`, `ZUNREADCOUNT`, `ZLASTMESSAGEDATE` | `cmd_chats` |
| `ZWAGROUPMEMBER` | `ZCHATSESSION`, `ZMEMBERJID` | `own_lid()` y el conteo de grupos |
| `ZWAPROFILEPUSHNAME` | `ZJID`, `ZPUSHNAME` | el nombre propio de `cmd_whoami` |

Dos detalles que no se ven en la tabla:

- **La fecha.** `ts()` suma el epoch de Core Data (2001-01-01), asi que lo que se guarda
  es `t - APPLE_EPOCH` con `t` en epoch unix. Sin esa resta la fecha sale 31 anios
  adelantada y el JSON se ve perfecto igual.
- **La fila centinela.** Se inserta un `ZWAGROUPMEMBER` con `ZCHATSESSION` en `NULL`
  para el LID propio. Sin ella, una linea sin ningun grupo deja la tabla vacia,
  `own_lid()` devuelve `None` y el `whoami` sale sin LID — justo donde el LID **es** la
  identidad de la cuenta. Con `ZCHATSESSION` en `NULL` la fila existe pero no cuenta
  como grupo, porque `count(distinct ...)` ignora los nulos.

### De donde sale cada dato

IndexedDB `model-storage` (version 2040 en la sesion medida) y `localStorage`, leidos
con un `eval` dentro de la pagina:

| dato | donde |
|---|---|
| lista de conversaciones | store `chat`: `id`, `t` (epoch unix), `unreadCount`, `name` |
| nombre visible | `chat.name`, y si esta vacio `contact.name`, `contact.pushname`, `contact.displayNameLID`, en ese orden; al final el numero del jid |
| LID propio | `localStorage['WALid']` — `"<lid>:<dispositivo>@lid"`, se corta en el `:` |
| nombre propio | `contact[<lid>@lid].pushname`, que es el equivalente de `ZWAPROFILEPUSHNAME` |
| grupos | las conversaciones cuyo jid termina en `@g.us` |

Medido sobre 1020 conversaciones y 9690 contactos: `chat.name` resuelve 203,
`contact.name` otras 369, `contact.pushname` 67 mas y `displayNameLID` una. Las 374 que
quedan se muestran con el numero del jid y **no** se descartan: `cmd_chats` filtra por
`ZPARTNERNAME is not null`, asi que un `None` ahi las borraria en silencio.

El **LID propio NO esta en `user-prefs`**. Ese store tiene 42 claves y ninguna es la
identidad; la que sirve es `localStorage['WALid']`, y el numero de telefono esta en
`localStorage['last-wid-md']`. Contra la sesion viva, el LID que sale de ahi es el
**mismo** que `own_lid()` deduce en la base de macOS contando participaciones en grupos
— dos caminos independientes al mismo numero.

Lo que se deja afuera son los jid terminados en `@newsletter` y `@broadcast`: un canal
no es una conversacion que se atienda. Se excluye esa lista **cerrada** y no se filtra
por una lista blanca de dominios, porque la base de macOS ya trae jid terminados en
`@status` y `@lid.status` que si son conversaciones.

## La bandeja — **medido**

`inbox` es el comando por el que existe la via web. La API de WhatsApp Business **no
tiene grupos**: ni los lee, ni los escribe, ni existe una version de pago que los
agregue. Una mencion en un grupo solo se puede leer por aca.

`cmd_inbox` no se toco. Lo que se amplio es el esquema que `WebSource.open()` sintetiza:
ademas de las tres tablas de `chats` y `whoami`, ahora arma `ZWAMESSAGE`, `ZWAMEDIAITEM`
y la columna `ZCONTACTNAME` de `ZWAGROUPMEMBER`. El SQL del comando es el producto y
sigue corriendo entero.

### Las dos etapas, y por que en ese orden

1. **El conjunto de candidatos sale solo de metadatos.** No se abre ninguna
   conversacion, no se navega y no se toca la pestana. Es la etapa que siempre corre.
2. **El texto va aparte y apagado.** Ver "Como sale el texto".

El orden no es una preferencia: abrir una conversacion en WhatsApp Web la marca leida
**tambien en el telefono del usuario**. Una bandeja que para contarte que te nombraron
te vacia las notificaciones del telefono no es una bandeja, es un daño.

### De donde sale cada campo — **medido** sobre 39.274 mensajes de la sesion viva

| dato | donde | trampa |
|---|---|---|
| es mio | **primer segmento del `id`**: `true_…` / `false_…` | no hay campo suelto; `from` NO sirve — en un mensaje propio trae tu numero y no el chat |
| `stanza_id` | **tercer segmento del `id`** | tampoco hay campo suelto |
| chat | **segundo segmento del `id`** | el `id` tiene 3 segmentos en un directo y **4** en un grupo (el cuarto es el participante) |
| fecha | `t`, epoch unix en segundos | |
| te nombraron | `mentionedJidList` | son **objetos wid** `{server,user,_serialized}`, **no cadenas**: comparar con `===` contra el LID no encuentra nunca nada, y eso se ve igual que "nadie te nombro esta semana" |
| te contestaron | `quotedParticipant` (+ `quotedStanzaID` para el padre) | llega en `@lid` **y** en `@c.us`: sobre 2343 citas, 45 traian el telefono. Mirar solo el LID pierde las respuestas viejas |
| remitente en un grupo | `author` (wid), o el cuarto segmento del `id` | esta en 21.455 de 21.920 mensajes de grupo |
| tipo | `type` (`chat`, `image`, `ptt`, …) | |
| cuerpo | **no esta**: `msgRowOpaqueData = {_data, iv, _keyId, _scheme}`, AES-CBC con una CryptoKey HKDF no extraible | |

Dos cosas que este diseno decia antes y **no eran ciertas**, las dos por la misma
medicion mal tomada:

- *"600 mensajes en el store"*. Son **39.274**, desde 2022-11 hasta hoy. El error viene
  de recorrer el store con un cursor inverso sobre la clave primaria: la clave es el
  `id`, ordena alfabeticamente, y `'true_' > 'false_'` — asi que los "600 mas recientes"
  eran 600 mensajes **propios**. Para recorrer por recencia hay que usar el indice
  `rowId`.
- *"`mentionedJidList` tiene 1 fila no vacia de 63"*. Con la muestra bien tomada son
  **1870** mensajes con menciones, **295** de los cuales te nombran a vos.

### Las tres clases de fila que se sintetizan

`web_mensajes()` escribe en `ZWAMESSAGE` tres cosas distintas, y las tres hacen falta
para que el SQL de `cmd_inbox` signifique lo mismo que contra la base de macOS:

1. **Los candidatos** (`ZISFROMME = 0`).
2. **Mi ultimo mensaje en cada chat** (`ZISFROMME = 1`), una fila por chat, con su fecha.
   Es lo que lee `ULTIMA_MIA`. Sin ella el join queda vacio, el `coalesce` da 0 y la
   regla "si ya contestaste, la mencion esta atendida" **no se aplicaria nunca** por
   esta via: toda mencion vieja volveria en cada corrida, y el ticket se abriria de nuevo.
3. **El padre de una respuesta** (`ZISFROMME = 1`, `ZMESSAGEDATE = 0`), para que
   `p.ZISFROMME = 1` sea cierto y el `kind` salga `respuesta`. La fecha va en 0 a
   proposito: no se conoce, y con 0 no se mete en el `max()` de `ULTIMA_MIA`.

El `ZGROUPMEMBER` de cada autor va con `ZCHATSESSION` en **NULL**. `own_lid()` elige el
jid que aparece en mas chats distintos, y un participante con chats de verdad puede
empatarle o ganarle al propio — ahi la cuenta entera pasa a tener la identidad de otro.
Con NULL la fila existe para el join del nombre y no cuenta como grupo. Los autores de
un directo ni se crean: `SENDER` no se usa ahi, el remitente sale de `ZPARTNERNAME`.

### El `@<lid>` dentro del texto

`cmd_inbox` decide `mencion` mirando `ZTEXT like '%@<lid>%'`. En la base de macOS ese
token esta de verdad en el cuerpo, y **medido**, el cuerpo en memoria de una mencion en
la web tambien lo trae. Cuando el texto no se leyo — o cuando la mencion vino por
`groupMentions` y no por el token — `web_texto()` lo pone adelante a partir de los
metadatos. Es una reconstruccion, no una transcripcion, y por eso esta escrita aca.

## Los adjuntos: `null`, y por que no una ruta

`cmd_inbox` arma `media`, `adjuntos_cerca` y `audios` con
`os.path.join(MEDIA_BASE, ZMEDIALOCALPATH)` — **rutas del sistema de archivos**, que es
lo que `./bin/wa-transcribe` abre. Por la via web no hay ninguna: el adjunto vive en el
blob store del perfil del navegador, cifrado y sin nombre de archivo.

La decision: **`ZWAMEDIAITEM` se crea y se queda vacia**. El `left join` deja `media` en
`null` y las dos listas en `[]`. No se inventa ninguna ruta. Una ruta falsa la abriria
`wa-transcribe` y fallaria con "no such file" lejos de aca, y quien la leyera creeria
que el archivo se perdio.

Que el mensaje **traia** un adjunto no se pierde: va en el marcador de `ZTEXT` como
`media=<tipo>`, con el tipo que usa WhatsApp (`image`, `video`, `ptt`, `document`). Una
nota de voz sale como `[web:no-text reason=off media=ptt]` y no como un mensaje vacio.

## Como sale el texto

Cinco situaciones y **tres** motivos de "sin texto", todos legibles **desde la fila
misma**, porque cada motivo pide una accion distinta del usuario y en un JSON se ven todos
iguales:

| ajuste | situacion | que sale en `text` |
|---|---|---|
| `off` (por defecto) | no se pidio el texto | `[web:no-text reason=off]` |
| `memoria` | el mensaje esta en memoria y tiene cuerpo | el cuerpo, tal cual |
| `memoria` | no esta en memoria pero el oyente lo anoto al llegar | el cuerpo, tal cual |
| `memoria` | la sesion no tiene ese mensaje cargado y nadie lo anoto | `[web:no-text reason=not-loaded]` |
| `memoria` | lo tiene y no hay texto que leer | `[web:no-text reason=no-body media=ptt]` |

**El marcador sigue teniendo tres estados y no cuatro.** Un cuerpo que salio del almacen
de la captura es un CUERPO, no una manera de quedarse sin texto: darle un `reason=` seria
inventar una accion del usuario donde no hay ninguna, y `TEXTO_MOTIVOS` es exactamente la
lista de las que si la piden. La diferencia entre "lo tenia la sesion" y "lo anoto el
oyente" si importa — es la diferencia entre un techo que no sube y una funcion que esta
andando — y por eso va en el **resumen de una linea** de la corrida, que separa los dos
numeros. Si el segundo se queda en cero corrida tras corrida, el oyente no esta
funcionando aunque la bandeja siga contestando; en la fila no se veria.

**Nunca una cadena vacia.** `cmd_inbox` hace `(text or "")`, asi que un `null` ahi sale
como `""` y se lee como "el mensaje estaba en blanco" — que es otra cosa que "no se leyo
el texto", y manda al agente a contestar sobre nada.

`memoria` **no abre ninguna conversacion y no marca nada como leido**. Lee
`window.require('WAWebCollections').Msg`, la coleccion que la propia pagina mantiene en
memoria, donde el cuerpo ya esta en claro — y, desde "La captura viva", deja ademas un
oyente en esa misma coleccion que anota el mensaje cuando llega. Escuchar tampoco abre
nada.

### El techo de `memoria`, medido — y es bajo

La coleccion en memoria **no** es "lo que la sesion sincronizo". Es, casi entera, el
**preview de la lista lateral: el ultimo mensaje de cada conversacion**. Medido contra
una sesion recien enlazada, sin ninguna conversacion abierta:

| | |
|---|---|
| mensajes en IndexedDB | 39.244 |
| modelos en memoria | 1.311 |
| de grupo | **327 modelos en 201 conversaciones distintas** — 1,63 por chat, y **175 chats con exactamente uno** |
| candidatos de grupo (30 dias) | 270 |
| **candidatos que estaban en memoria** | **2** |

Los dos que estaban son los que **eran el ultimo mensaje de su grupo**. Una mencion de
hace tres dias no lo es, asi que sale `not-loaded` — y es lo que va a pasar casi siempre
en una sesion que nadie navego. En una sesion usada durante horas la cobertura sube
bastante (medido aparte: 60 de 188 con cuerpo), porque ahi si hay historia cargada.

**El techo no es bajo: es estructuralmente casi cero, y no se arregla sondeando mas
seguido.** 1,63 modelos por chat y 175 chats con exactamente uno dicen lo mismo de dos
maneras: lo que hay es el preview de la lista lateral. Una mencion deja de ser legible en
el instante en que cualquier otro escribe en ese grupo, y entre dos corridas el segundo
mensaje **destruye el texto del primero para siempre** — no queda en ningun lado desde
donde recuperarlo, porque en IndexedDB viaja cifrado. Bajar el intervalo de sondeo achica
la ventana pero no la cierra, y achicarla cuesta una corrida de navegador cada vez. La
unica salida es dejar de preguntar que hay en memoria y **anotar el mensaje cuando
llega**.

Por eso la corrida lo dice **de una linea en stderr** ademas de fila por fila: `X of Y
candidates came back with a body; Z are not in the session's memory`. Sin ese aviso, una
bandeja entera en `not-loaded` se lee como la funcion rota — y ya se leyo asi una vez,
buscando el fallo en el accessor cuando el accessor estaba bien.

**Lo que NO es la causa**, para que nadie lo vuelva a buscar ahi: no hay desalineacion de
claves entre los dos lados. Medido, **1.308 de 1.309** ids en memoria existen literales
en IndexedDB, y `Msg.get(<cadena>)` resuelve. La trampa que si esta cerca: en un registro
de IndexedDB `id` **es una cadena**, y en un modelo en memoria es un **objeto**
`{fromMe, remote, id, participant}` cuyo `_serialized` viene **vacio** en este build. La
clave de busqueda tiene que salir siempre del registro de IndexedDB — leer `_serialized`
del modelo da `''` y no encuentra nada, en silencio, con la misma cara que `not-loaded`.

**El modo que abriria los chats no existe, y es a proposito.** Se puede construir —
`WAWebChatLoadMessages.loadRecentMsgs` esta ahi — y es lo unico que subiria ese techo,
pero abrir una conversacion la marca leida tambien en el telefono, y no hay forma de
probarlo sin hacerselo a una cuenta de verdad. Si alguna vez se agrega, va con su propio
valor de ajuste y con esa frase al lado.

Si `memoria` esta encendido y la pagina ya no expone esa coleccion, la fuente falla con
`web-text-unavailable` en vez de devolver todo con el marcador: quien lo encendio lo
encendio para leer, y una bandeja entera sin texto se leeria como que nadie dijo nada.
Eso es distinto de `not-loaded`, que **no** es una falla: las filas estan todas.

## La captura viva — el oyente que anota el mensaje cuando llega

`WAWebCollections.Msg` **no** es solo un cache: es una coleccion con eventos de verdad.
Medido contra la sesion viva: `typeof Msg.on === 'function'`, y `on`, `off`, `once`,
`trigger` y `listenTo` estan todos. Un oyente de `add` ve el mensaje **con el cuerpo en
claro** en el momento en que la pagina lo crea, que es el unico momento en que ese texto
existe sin abrir la conversacion. Eso es todo lo que hace falta para subir el techo: no
preguntar, escuchar.

`wa-read inbox` instala ese oyente y, en cada corrida, se lleva lo que junto. El
`read_web_text=memoria` de siempre queda como estaba — se sigue leyendo la coleccion — y
la captura es lo que rellena justo el caso que la coleccion pierde.

### 1. Donde viven los cuerpos

Dos piezas, y ninguna de las dos alcanza sola:

| pieza | que es | por que |
|---|---|---|
| anillo en la pagina | `window.__waInboxCaptura.buf`, un `Map` de hasta **500** entradas | el oyente corre en la pagina y la CLI no esta viva cuando el mensaje llega; algo tiene que sostenerlo hasta la corrida siguiente |
| almacen en disco | `~/.wa-inbox/capture.db`, tabla `capturado`, **0600** | la CLI vive unos segundos cada `sync_minutes`; un global muere con la recarga y con el cierre de la pestana |

En cada corrida el anillo se **drena** al almacen y se vacia. El drenaje es leer-y-vaciar
en un solo paso: la pagina tiene un unico hilo de JS, asi que dos corridas que se pisen no
pueden llevarse la misma fila dos veces.

**Lo que esto cuesta, dicho de frente:** lo que llego *despues* del ultimo drenaje muere
si el usuario recarga la pestana. Es como mucho una ventana de `sync_minutes` (5 por
defecto). Se podia evitar escribiendo tambien en un IndexedDB propio dentro de
`web.whatsapp.com`, y **se decidio no hacerlo**: seria una segunda copia durable del texto
de mensajes de otra gente, viviendo en el perfil del navegador, que ninguna corrida de
`wa-read` puede garantizar que va a volver a podar — si el usuario apaga el ajuste o
desinstala el plugin, el almacen de disco se borra y esa copia se queda. Una copia
durable, en un archivo que el usuario puede ver y borrar, vale mas que cerrar una ventana
de cinco minutos. Y la recarga abre un hueco simetrico igual: sin oyente instalado no se
captura nada hasta la corrida siguiente, asi que cerrar solo la mitad del hueco no cerraba
el hueco.

**Que es lo que hay adentro, y quien lo puede leer.** El cuerpo de un mensaje de WhatsApp
es dato sensible de terceros. `capture.db` queda con permisos `0600` (no el umask: en un
equipo compartido el umask por defecto lo deja legible para todos) en el mismo directorio
que el registro de alcance, que es el archivo que el usuario ya sabe que manda. Lo lee el
usuario y nadie mas; no sale del equipo, no va al panel y no se sincroniza.

**Los topes, que son la otra mitad del trato.** Un almacen sin tope y sin caducidad es un
archivo de conversaciones ajenas que nadie borra, y eso no se ve en ninguna salida — solo
en el tamano del archivo, seis meses despues:

| tope | valor | ajuste | por que ese |
|---|---|---|---|
| filas | **20.000** | `capture_max` | es un buffer entre "llego" y "contestado", no un archivo: una vez que el agente respondio, el texto vive en el ticket. 20.000 cubre semanas de lo accionable de una linea sin volverse un historial |
| caducidad | **90 dias** desde que se capturo | `capture_days` | se cuenta desde la CAPTURA y no desde la fecha del mensaje: asi el tope es cuanto tiempo lo tenemos NOSOTROS, que es lo que se promete, y no algo que dependa de un `t` que viene de la red |
| por cuerpo | **4.000** caracteres | — | un mensaje de WhatsApp llega hasta 65.536; acotar las filas y no el cuerpo no acota nada. Lo que pasa se corta |

Los dos primeros son ajustes de `wa-scope`, como `web_timeout_s`, y por la misma razon:
son retencion de texto ajeno, no rendimiento, y bajarlos tiene que poder hacerse sin
tocar el codigo (`wa-scope config capture_days 7`). **Desaloja el que se cumpla primero,
y siempre por lo mas viejo.**

Y cuando desaloja, **se dice**, con el ajuste que lo gobierna al lado:

```
Evicted this run: 0 past `capture_days`=90 and 37 past `capture_max`=20000 —
raise them with `wa-scope config capture_max <n>` if a case went missing.
```

Enterarse de que el almacen estaba desbordando despues de perder un caso es enterarse
tarde. La linea solo aparece cuando de verdad echo algo.

La poda corre en **cada** corrida que toca el almacen, no solo cuando se escribe. Con
`read_web_text` en `off` la corrida **vacia los cuerpos** — no borra el archivo: adentro
queda una fila por linea con la fecha en que se enlazo, que no es contenido de nadie y
que hace falta para la ventana (mas abajo). `wa-read doctor` muestra la ruta y cuantos
cuerpos tiene, para que se pueda encontrar y borrar sin leer el codigo.

Pasada la caducidad o el tope, la fila vuelve a salir `not-loaded` — el estado que ya
existia. Perder el cache nunca es un error.

### 2. Como se instala el oyente sin apilarlo

La corrida dura segundos y pasa cada `sync_minutes`; el oyente tiene que estar en el
medio. Cada corrida evalua la misma expresion, que es **idempotente**:

1. Si `window.__waInboxCaptura` existe, es de **esta version** y esta colgado de **esta
   misma coleccion**, no instala nada y solo drena.
2. Si la version no coincide — el codigo del oyente cambio — llama al `off()` que el
   propio oyente dejo guardado y vuelve a instalar.
3. Si la coleccion es **otro objeto**, tambien reinstala: re-enlazar rearma los modulos de
   la pagina, y un oyente colgado de la coleccion vieja sigue vivo sin ver nada.

Sin esa guarda, una hora de corridas deja doce oyentes contando el mismo mensaje doce
veces. No es teorico: medido en la pagina viva, `Msg` ya tiene **66 oyentes de `add`**
propios de WhatsApp. Apilar ahi no es gratis.

La **version sale de un hash del propio codigo JS** (`web_captura_js()`), no de un numero
a mano. Cambiar el oyente y olvidarse de subir el numero dejaria corriendo el viejo hasta
que alguien recargue la pestana, y eso se ve exactamente igual que "la captura no anda".

Tras una recarga o un cierre de pestana el global no esta: la corrida siguiente instala de
cero. Lo drenado ya esta en disco; lo que quedaba en el anillo se perdio y esas filas
salen `not-loaded`.

### 3. Que se captura

Solo lo que `inbox` necesita para servir un cuerpo despues, y nada mas:

| campo | por que esta |
|---|---|
| `chat_jid` | mitad de la llave. Sin el, dos stanzas iguales en chats distintos servirian el cuerpo equivocado |
| `stanza_id` | la otra mitad: es la llave de idempotencia que la bandeja **ya publica** |
| `body` | es lo unico que la sonda no puede conseguir de otro lado — en IndexedDB viaja cifrado |
| `account` | dos lineas propias pueden tener el MISMO grupo; servir el cuerpo de la otra linea es contestar sobre la conversacion ajena |
| `captured_at` | la caducidad, y el orden del desalojo |

Los vecinos de la ventana se guardan con los mismos cinco campos: su metadata — quien y
cuando — la vuelve a sacar la sonda de IndexedDB en cada corrida.

**No** se guardan el autor, el tipo, la fecha del mensaje, la lista de menciones ni el id
completo (que lleva el jid del participante adentro). Todo eso la sonda lo saca en claro
de IndexedDB, con historial completo, en cada corrida: copiarlo aca seria espejar la
conversacion sin ganar nada y hacer del almacen una transcripcion que se sostiene sola.

Y no se guarda **todo** lo que pasa por la coleccion. Esto es lo mas importante de esta
seccion, porque es lo que separa un buffer de un archivo de las conversaciones de otra
gente.

**Medido**, corriendo las dos reglas sobre los 7 dias que la sesion viva tiene en
IndexedDB — 2.765 mensajes ajenos, 1.877 de ellos en 71 grupos:

| | un oyente sin filtrar | esta regla |
|---|---|---|
| todo lo que llega | **2.765** | **1.069** (937 accionables + 132 de la ventana de al lado) — 38,7% |
| **solo los grupos** | **1.877** | **181** (49 + 132) — **9,6%** |

O sea: **1.696 de los 1.877 mensajes de grupo — el 90,4% — no tocan el disco nunca.**
Esa es la charla de 71 grupos ajenos que no queda en claro en el equipo del usuario para
poder servir lo poco que la bandeja si tiene que atender. En los directos la proporcion
es al reves y tiene que serlo: ahi **todo** mensaje ajeno es un candidato de la bandeja.

El oyente guarda **solo lo que la bandeja puede atender**, y lo decide con la **misma**
`candidato()` que arma la bandeja — la de `WEB_REGLA_JS`, no una copia — con la ventana en
cero:

- te nombran (`mentionedJidList`, objetos wid),
- contestan algo tuyo (`quotedParticipant`, en `@lid` **y** en `@c.us`),
- o es un directo, donde todo mensaje ajeno es para vos.

Que sea la misma funcion y no una copia es lo que impide que las dos deriven; una copia
se romperia el dia que la regla cambie y nada se pondria rojo.

### Mas la ventana de al lado

`cmd_inbox` ya define una ventana de +/- N minutos alrededor de cada mensaje
(`nearby_media`, `--window`, 5 por defecto) porque, como dice el comentario que ya estaba
ahi, **la captura casi nunca viene en el mismo mensaje que el "@fulano mira esto"**. El
oyente respeta esa misma ventana:

- lo que llega **justo antes** de una mencion espera en una cola **corta y en memoria**
  (`WEB_CAPTURA_PENDIENTES_MAX`, 200) que **nunca toca el disco**; si en los minutos
  siguientes llega la mencion que lo vuelve util, se promueve; si no, se descarta.
- lo que llega **justo despues**, hasta N minutos, entra directo.

Por la via web no hay adjunto que abrir — `adjuntos_cerca` sale siempre vacia — asi que
lo que se puede dar en su lugar es el **texto** de al lado. Sale en la fila de la bandeja
como `contexto_cerca` (`{date, sender, text}`), y **solo cuando hay algo**: la tabla que
lo alimenta no existe en la base de la app de escritorio, asi que por la via local la
clave ni aparece y esa salida no se mueve un byte.

### Lo que esto NO captura, que es el costo honesto

Un mensaje que **se vuelve relevante despues** no va a tener cuerpo. El caso concreto:
alguien escribe algo en un grupo, nadie te nombra, pasan diez minutos, y recien ahi otra
persona te nombra respondiendo a aquel mensaje. El primero ya salio de la cola de
pendientes — la ventana es de minutos — y nunca se guardo, asi que el `quotedStanzaID`
apunta a un texto que no tenemos. La fila sale igual, con quien, cuando y en que grupo, y
el cuerpo del padre como `not-loaded`.

Es a proposito: el precio de no tener ese caso es no tener en claro, en disco, la
conversacion completa de todos los grupos por si acaso. Si alguna vez hace falta, lo que
sube es `--window`, no la regla.

Se escucha `add` **y** `change:body`: hay mensajes cuyo modelo se crea antes de que el
cuerpo este resuelto, y escuchar solo `add` los pierde con la misma cara que
`not-loaded`.

### 4. La ventana empieza en el enlace, no N dias atras

`inbox_days` (7 por defecto) es la ventana de la via local, donde el historial esta
completo y mirar una semana atras tiene sentido. Por la via web, el dia que se enlaza una
linea esa misma ventana devuelve **~198 menciones anteriores al enlace** que por
definicion **no pueden tener cuerpo**: el oyente no existia cuando llegaron, y la
coleccion en memoria no las tiene. No es historial, es ruido — y ademas tapa, arriba de
la lista, lo unico que si se puede atender.

Asi que por la via web la ventana arranca **en el instante en que la linea se enlazo**.

**Que senal se uso, y por que esa.** La primera corrida que consigue leer esa sesion. No
hay una mejor disponible: `wa_account.linked_at` existe en el registro de alcance, pero
hoy **nadie lo escribe**: `wa-scope accounts --connect` anota la linea y `--identify` le
pone su lid, pero ninguno de los dos sella una fecha de enlace, y ademas `wa-read` nunca
escribe en ese registro. Asi que la marca
se anota en el almacen propio, en la tabla `linea`, una sola vez por cuenta, y **no se
mueve**: si se reescribiera en cada corrida, la ventana empezaria de nuevo cada cinco
minutos y una mencion de hace un rato no volveria a salir jamas. Es tambien lo unico del
almacen que sobrevive a apagar `read_web_text`.

**`--days` explicito le gana siempre.** Mirar para atras a mano tiene que seguir siendo
posible; lo que cambia es el valor por defecto, no la capacidad. Y cuando el corte tapa
algo, la corrida lo dice, con la fecha y con la salida:

```
left out 198 candidate(s) older than the moment this line was linked (2026-09-18 15:12);
they predate the capture listener, so they can never carry a body.
Pass --days to look further back anyway
```

Sin ese aviso, una bandeja vacia el primer dia se lee como la funcion rota — y ya se leyo
asi una vez.

### 5. Los finales

Ninguno es nuevo. Cada uno cae en un motivo que ya existia, y ninguno aborta la corrida:

| que pasa | como termina |
|---|---|
| la sesion se desloguea | el oyente relee la identidad en **cada** mensaje; sin `WALid` no captura nada. La bandeja sigue fallando con `web-logged-out` como siempre |
| la pestana se cierra | `web_page()` levanta `web-no-session` antes de llegar aca |
| la pagina se recarga | el global no esta, la corrida instala de cero, lo drenado sigue en disco, lo del anillo sale `not-loaded` |
| Orca se reinicia | `web-no-orca`, igual que antes |
| la pagina ya no expone la coleccion | el oyente no se instala, sale un `warning:` que lo dice y la bandeja sigue con el techo de antes. Si ademas `read_web_text=memoria` no puede leer nada, la sonda falla con `web-text-unavailable`, que ya existia |
| dos corridas se pisan | la instalacion es idempotente y el drenaje es atomico. La que pierde la carrera ve el anillo vacio y sirve `not-loaded` |
| el almacen no se puede abrir o esta corrupto | `captura_abrir()` devuelve `None` y todo degrada a `not-loaded`. Nunca levanta |
| un modelo revienta adentro del oyente | se cuenta y se sigue. Un oyente que tira rompe la coleccion de **la pagina del usuario**, que es lo peor que esto podria hacer |
| el almacen desaloja por tope o caducidad | la fila vuelve a `not-loaded` y la corrida dice cuantas echo y con que ajuste subirlo |
| no se pudo anotar cuando se enlazo la linea | `captura_linea()` devuelve 0 y la ventana vuelve a ser `inbox_days`, que es lo de antes |

### Lo que esto no hace

No abre ninguna conversacion, no navega, no recarga y no dispara ningun evento en la
pagina: escuchar es leer. `scripts/check-clis` lo comprueba sobre el rastro de todo lo que
se le pidio a la CLI de Orca, y `.trigger(` esta en la lista de lo que nunca puede
aparecer ahi, al lado de `.click(` y `sendSeen`.

Tampoco sube el techo **hacia atras**: un mensaje que llego antes de que el oyente
existiera no se puede recuperar. La captura arregla de aca en adelante, que es lo unico
que se podia arreglar.

## El tope de la sonda

La ventana es configurable hasta "todo el historial", y ahi la sesion medida tiene ~9900
candidatos: bajarlos todos son megabytes por un `eval`. La sonda baja los
`WEB_INBOX_SONDA_MAX` (6000) mas nuevos y, cuando recorta, lo dice por `stderr` con
cuantos quedaron afuera. Recortar en silencio es lo que hace que una mencion vieja no
aparezca nunca y nadie sepa por que.

### `orca eval` no resuelve promesas

Una expresion que devuelve una `Promise` vuelve en `null`. El patron que funciona son
dos llamadas: una que arranca el trabajo asincrono y deja el resultado en un global
(`window.__waRead = ...; return 'started'`), y otra que lee
`JSON.stringify(window.__waRead)` en un bucle hasta `web_timeout_s` (45 s por defecto,
en `wa-scope config`). `web_payload()` es ese bucle y es el unico lugar donde vive.

## Lo que la implementacion tiene que tocar

Lista cerrada, para que el seguimiento sea mecanico:

1. ~~`bin/wa-read:WebSource.open()` — abrir/reusar la sesion y devolver algo con la
   misma forma que la conexion SQLite.~~ **Hecho para `chats`, `whoami` e `inbox`.**
   `chat` y `media` siguen saliendo con `web-not-implemented` y no estan pendientes:
   piden el cuerpo de cada mensaje y la ruta de cada adjunto, y el navegador no tiene
   ninguno de los dos.
2. `bin/wa-read` — que las filas lleven `account` cuando haya mas de una fuente
   activa, y que `--account` deje elegir una.
3. `bin/wa-scope` — `accounts` ya existe (`--connect`, `--label`, `--identify`,
   `--lid`, `--forget`) y es lo que usa el panel para conectar una linea. Lo que falta
   es que alguna de esas ramas selle `linked_at`: hoy la fecha de enlace la infiere
   `wa-read` de su propio almacen, en la tabla `linea`.
4. `bin/wa-scope` — `cmd_mode`, `cmd_rm` y `jid_of` filtran por `chat_jid` solo;
   cuando haya mas de una cuenta hay que pasarles la cuenta.
5. `bin/wa-scope:merged_scope()` — la clave del store del panel pasa a llevar la
   cuenta adelante para lo que no sea `local`; las de `local` se quedan como estan
   para no perder lo ya guardado.
6. `bin/wa-send` — despacho por cuenta y fallo cerrado, arriba.
7. `config.html` / `activity.html` — la etiqueta de la linea al lado del nombre de la
   conversacion en el selector, en la tabla del registro y en la lista de actividad.
   Sin eso, con dos lineas conectadas una fila que dice solo "Laura Mendez" es ambigua.
