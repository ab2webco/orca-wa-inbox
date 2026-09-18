# Leer de varias lineas: la base local y las sesiones de WhatsApp Web

Este documento es el diseno de la via web. **No esta construida.** Lo que ya esta en
el arbol es la costura: las fuentes, el registro de cuentas, los dos interruptores y
un doctor que dice la verdad en cada plataforma. Esto describe lo que falta, con el
detalle suficiente para que la implementacion sea mecanica.

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
| estado | **implementado** | **disenado, sin construir** |

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
| `web-not-implemented` | se pidio la via web | 4 |

## Los interruptores

Dos, no una lista de tres, porque las fuentes se suman:

- `read_local` — `on` (por defecto) / `off`. Apagarla en un equipo que tiene base es
  una eleccion real: leer solo la linea de la empresa.
- `read_web` — `on` / `off` (por defecto). Arranca apagada porque cuesta un puesto de
  dispositivo enlazado, y eso no se gasta sin que el usuario lo pida.

Se validan como el resto de los enums (`CONFIG_OPCIONES` en `bin/wa-scope`), se
guardan en `settings` y viajan al panel por `PANEL_SETTINGS`.

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

## Donde vive la sesion

Un perfil de navegador por linea, bajo el userData de Orca, al lado de lo que ya
guarda el plugin:

```
<userData>/plugins-data/ab2web.orca-wa-inbox/web-sessions/<slot>/
```

`<userData>` es el mismo que ya resuelve `user_data_roots()` en `bin/wa-scope`
(`~/Library/Application Support/orca` en macOS, `%APPDATA%\orca` en Windows,
`$XDG_CONFIG_HOME/orca` en Linux). Se usa `orca tab profile create <slot>` y
`orca tab profile set <slot>` para que cada linea abra con el suyo: sin perfiles
separados, la segunda sesion desloguea a la primera.

## El enlace por QR

El panel no puede ejecutar nada y **no puede embeber WhatsApp Web**. Las dos puntas
lo impiden y las dos estan comprobadas: el shell del panel manda
`default-src 'none'; connect-src 'none'`, y `web.whatsapp.com` responde
`content-security-policy: frame-ancestors https://*.whatsapp.com https://whatsapp.com`.
No hay que intentarlo. La pestana del navegador de Orca **no** es un panel de plugin:
es una vista de navegador de verdad, y por eso si sirve.

El flujo:

1. El panel escribe un pedido en storage (el mismo camino que `syncRequest`).
2. El worker llama `wa-scope` / `wa-read`, que abre la pestana:
   `<orca> tab profile create <slot>` → `tab profile set <slot>` →
   `tab create --url https://web.whatsapp.com`.
3. El usuario ve el QR **en esa pestana** y lo escanea con el telefono de ESE numero.
4. Se espera con `snapshot` hasta que el arbol de accesibilidad deje de mostrar el QR
   y aparezca la lista de chats; de ahi sale el LID que fija el `id`.
5. Se escribe la fila de `wa_account` y se cierra la pestana con `tab close`.

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

- La fuente levanta `SourceError("web-session-dropped", ...)`.
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

## Lo que la implementacion tiene que tocar

Lista cerrada, para que el seguimiento sea mecanico:

1. `bin/wa-read:WebSource.open()` — abrir/reusar la sesion y devolver algo con la
   misma forma que la conexion SQLite, o adaptar `cmd_*` a un lector.
2. `bin/wa-read` — que las filas lleven `account` cuando haya mas de una fuente
   activa, y que `--account` deje elegir una.
3. `bin/wa-scope` — `accounts add|rm|enable`, que hoy no existen a proposito: el
   registro solo tiene la fila `local` porque es la unica linea que puede producir
   conversaciones. Llegan con el lector, no antes.
4. `bin/wa-scope` — `cmd_mode`, `cmd_rm` y `jid_of` filtran por `chat_jid` solo;
   cuando haya mas de una cuenta hay que pasarles la cuenta.
5. `bin/wa-scope:merged_scope()` — la clave del store del panel pasa a llevar la
   cuenta adelante para lo que no sea `local`; las de `local` se quedan como estan
   para no perder lo ya guardado.
6. `bin/wa-send` — despacho por cuenta y fallo cerrado, arriba.
7. `config.html` / `activity.html` — la etiqueta de la linea al lado del nombre de la
   conversacion en el selector, en la tabla del registro y en la lista de actividad.
   Sin eso, con dos lineas conectadas una fila que dice solo "Laura Mendez" es ambigua.
