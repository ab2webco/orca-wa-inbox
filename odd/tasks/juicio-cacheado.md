# Juicio cacheado, y Jev cuando esté disponible

## El problema, medido

La automatización de triage demora mucho decidiendo qué tipo de mensaje tratar.

Medido sobre el almacén real del dueño:

| | |
|---|---|
| Mensajes ajenos en la bandeja | 40 |
| De esos, charla de grupo que no lo nombra | 38 |
| Dirigidos a él | 2 |
| Corridas por día (`*/5 8-18 * * 1-5`) | 132 |
| **Clasificaciones por día** | **5.280** |

El agente razona sobre 40 mensajes para encontrar 2 que importan, 132 veces al
día. Y vuelve a razonar sobre los MISMOS 40 en la corrida siguiente: nada
recuerda el veredicto.

`STEP 5` ya evita reabrir tarjetas (`orca plane search <stanza_id>`), pero eso
solo cubre lo que ABRIÓ tarjeta. Las 38 líneas de grupo no abren ninguna, así
que se reclasifican para siempre dentro de la ventana de retención.

## Por qué el caché va primero

Sin caché, agregar Jev costaría **5.280 llamadas a la API por día** en vez de
40. El caché no es un extra del trabajo con Jev: es su prerrequisito.

Y por sí solo es la mayor parte de la mejora, sin mandar un solo byte a
ningún tercero.

## Objetivo

1. Un veredicto por mensaje se calcula **una vez** y se guarda, con la misma
   llave que el mensaje: `(account, chat_jid, stanza_id)`.
2. Cuando el plugin **Jev Advisor** está instalado y hay llave, ese veredicto
   lo emite Jev (~245 ms) en vez de costar una pasada de modelo grande.
3. Sin Advisor, sin llave, con la API caída o con timeout: **no hay campo de
   juicio** y el agente clasifica como hoy. Degradar es volver al estado
   actual, nunca bloquear ni inventar un veredicto.

## Restricciones que ya están verificadas

- **No se puede llamar de plugin a plugin.** La API del host de Orca son 13
  métodos (`plugin-host-api.ts`) y ninguno invoca comandos ajenos; además
  `storage.get` y `secrets.get` son `scope: 'plugin-private'`.
- **La llave se comparte por archivo, y es el mecanismo previsto.** El worker
  del Advisor espeja `TYPESAFE_API_KEY` en `~/.config/orca-supervisor/env`
  (0600) justamente para que procesos fuera del worker la lean: su propio
  `write-secret-mirror.mjs` nombra a los CLI y adaptadores como los
  consumidores, porque el store cifrado solo lo abre Electron.
- **Las preguntas del Advisor no sirven acá.** Son sobre comandos de shell,
  worktrees y niveles de capacidad de agente. Hay que escribir las nuestras.
- **Cuidado al vendorizar**: el Advisor *falla abierto* (sin llave, permite).
  Acá la entrada es texto no confiable de terceros y el §9 exige *fallar
  cerrado*. Copiar su default sería copiarlo en la dirección peligrosa.
- **Regla de composición del §9**: *Jev puede frenar y escalar, nunca
  habilitar.* Aplicada acá: Jev puede decir "esto no pide nada, sáltalo"
  —que es el ahorro— pero nunca "esto es soporte, actuá". Eso sigue siendo
  del agente y de la escalera de permisos.

## Alcance autorizado

- Tabla `juicio` en **`scope.db`**, no en `capture.db`. Llave
  `(account, chat_jid, stanza_id)`, la misma con la que se identifica un
  mensaje.

  Va ahí y no en `capture.db` por una razón medida: `bin/wa_store.py` abre
  TODO en `mode=ro` y lo dice de sí mismo —*"escribir no escribe, como todo
  este modulo"*—, y el esquema de `capture.db` lo crea y lo migra el sidecar
  (`sidecar/src/almacen.js`) detrás de la valla de permisos. Meter una tabla
  nuestra ahí obligaría a abrir en escritura el módulo que existe para no
  escribir, o a tocar el esquema del sidecar. `scope.db` ya es la base que
  `wa-scope` escribe, con `work`, `digest` y `run_trace` adentro.
- El veredicto viaja en la fila del inbox como una PISTA más, junto a `kind` y
  `escribio_despues`. Informa; no decide.
- Cliente de TypeSafe propio, en la librería estándar de Python. Sin
  dependencias nuevas: el árbol del plugin tiene tope de 2.000 archivos.
- La llave NUNCA en argv, ni en un log, ni en una URL. Solo cabecera.

## Fuera de alcance

- Que Jev redacte o dé forma a una respuesta. No lo hace y no lo va a hacer.
- Tocar la escalera de permisos de `scope.db`.
- Prender esto sin que el dueño ponga la llave.

## Tareas

- [x] T1 — Tabla `juicio` en `scope.db`, llave `(account, chat_jid, stanza_id)`,
      `create table if not exists`, probada sobre una `scope.db` preexistente.
- [x] T2 — `wa-scope juicio` escribe el veredicto; `--clase` y `--origen` se
      validan contra el conjunto cerrado y rechazan lo que no está en él.
- [ ] T3 — Detección del Advisor y de la llave, sin leer su valor al log.
- [ ] T4 — Cliente de TypeSafe + las preguntas de NUESTRO dominio.
- [x] T5 — El juicio viaja en la fila del inbox junto a `kind`; `triage.md` lo
      usa para saltar el reanálisis y graba el suyo cuando falta.
- [x] T6 — Degradación probada en tres formas: sin `scope.db`, con una vieja sin
      la tabla, y con el archivo corrupto. Las tres devuelven las 40 filas sin
      campo de juicio y sin romperse.

## Evidencia

Cada prueba nueva corrida contra el código SIN el cambio, y falla:

    almacen    -> wa-scope: error: argument cmd: invalid choice: 'juicio'
    check-clis -> sqlite3.OperationalError: no such table: juicio

Ida y vuelta contra el almacén real del dueño: veredicto grabado y leído en la
fila del inbox (`{'clase': 'nothing', 'origen': 'agente'}`). La fila de prueba
se borró después.

`npm run check` en exit 0. `check-clis` 160 comprobaciones (eran 149),
`almacen` 181/181 (eran 172), paneles 376/376, worker 119/119.

`wa_store.py` sigue sin abrir una sola conexión de escritura: las cuatro son
`mode=ro`, verificado.

## Verificación

`npm run check` en exit 0. Pruebas nuevas en `almacen` y en `check-clis`.
Cada prueba nueva se corre contra el código SIN el arreglo y tiene que fallar.

## Modo TDD

Activado (CLAUDE.md). RED observado antes de implementar, después GREEN.

## Decisión pendiente del dueño

Hoy de este plugin **no sale nada a internet**. El modo `api` de transcripción
está sin implementar a propósito y el panel promete *"el audio no sale de este
equipo"*. Jev manda texto de mensajes de clientes a un tercero. Por eso T4 y T6
quedan detrás de un interruptor apagado por defecto: T1–T3 y T5 mejoran la
velocidad sin mandar nada.
