# Línea muerta: sin QR y el panel dice "conectado"

## El problema, medido (2026-10-01)

WhatsApp cerró la sesión desde el teléfono (código 401). Desde entonces:

- No vuelve a aparecer el QR, en ningún reinicio.
- El panel ofrece solo "Reintentar", que repite la misma falla, y esconde
  "Desvincular", que es la única salida.
- Chats, contactos y salud siguen viéndose sanos, porque salen de datos
  guardados que nunca caducan.

Estado real de la máquina del dueño: último mensaje recibido el 2026-09-23
11:02; último latido del sidecar el 2026-09-30 17:44 (cinco "Reintentar" que
murieron a los ~3 s cada uno); `wa-auth/creds.json` con `me` puesto, así que
Baileys intenta login y nunca pide registro.

## Causas, en orden

1. `sidecar/src/index.js` — ante un 401 el sidecar se detiene sin borrar las
   credenciales muertas. Con `creds.me` puesto, Baileys hace login, no
   emparejamiento: **ningún reinicio puede producir un QR**.
2. `main.mjs` — el `exit` del proceso sobrescribe `sesion-cerrada` con
   `sidecar-cayo`. El panel deja de ofrecer "Desvincular" y ofrece
   "Reintentar", que no puede funcionar.
3. `config.html` y `activity.html` — "conectado" sale de la última foto
   guardada (`sidecar` en storage), sin mirar si el worker o el sidecar
   siguen vivos. `wa-read doctor` da por buena la línea si existe una fila en
   `linea`, y solo se corre al arrancar.
4. `decidirTrasCierre` — 500 (badSession), 403, 411 y 440 reconectan para
   siempre sin borrar credenciales.

## Alcance

- Un 401 (y un 500 badSession) borra las credenciales y vuelve a conectar:
  el QR nuevo aparece solo, sin que el dueño tenga que encontrar un botón.
  El almacén `capture.db` NO se toca.
- El worker no tapa el motivo real del cierre. Una caída que no es 401 se
  reinicia sola con backoff y tope.
- "Conectado" solo si hay latido reciente del sidecar. Sin latido: "línea sin
  señal" con la hora del último, en el panel de config y en el de actividad.
- El chequeo de salud del transporte exige latido fresco y se repite, no solo
  al arrancar.
- 403/411/440 dejan de reintentar para siempre: tope y motivo claro.

## Fuera de alcance

- El kanban de casos y Jev (otra tarea).
- Borrar el almacén de mensajes al desvincular.

## Tareas

- [x] T1 — Sidecar: 401/500 borran `wa-auth`, recrean el estado y reconectan →
      se emite un QR nuevo. Prueba en `sidecar-pairing.test.mjs`.
      Decisión: el sidecar NO borra la carpeta él mismo. Sale con el código
      `SALIDA.CREDENCIALES_MUERTAS` (3) y el worker reusa `desvincularSidecar`, que
      ya espera a que el proceso muera antes de borrar (la carrera del "desvinculo y
      ya no conecta"). Un solo camino de borrado, el del botón Desvincular.
- [x] T2 — Sidecar: 403/411/440 con tope de intentos y motivo propio.
      Motivos `sesion-reemplazada` (440), `acceso-denegado` (403) y
      `multidispositivo` (411); tope de 3 cierres seguidos en 10 min (un `open` no
      reinicia la cuenta), y salida `SALIDA.RENDIDO` (4) que el worker no relanza.
- [x] T3 — Sidecar: latido periódico por stdout (≥60 s, respeta el tope de 64
      llamadas sin confirmar del host). `{type:'latido', ts, conectado}` cada
      `LATIDO_LINEA_MS` (60 s) y uno al arrancar; el worker lo guarda en
      `sidecar.latido` con la hora del sidecar.
- [x] T4 — Worker: el `exit` no sobrescribe `sesion-cerrada`; reinicio
      supervisado con backoff y tope para las demás salidas. Prueba en
      `worker.test.mjs`. `clasificarSalida` decide (credenciales muertas / rendido /
      caída) después de drenar stdout; `decidirReinicio`: 2 s, 4 s, 8 s… hasta 60 s,
      tope 5; un clic del panel o una vida de más de 2 min reinician la cuenta.
- [x] T5 — Panel de config: "conectado" exige latido fresco; con 401 ofrece
      Desvincular y no Reintentar. Prueba en `panels.test.mjs`. Estado nuevo
      `silent` ("La linea no da senal desde las HH:MM", con Reintentar y
      Desvincular); `LATIDO_LINEA_VENCE_MS` = 150 s; `statusCode` 401/500 manda sobre
      el `sidecar-cayo` viejo; textos de 440/403/411 en es, en y pt.
- [x] T6 — Panel de actividad: mismo criterio de vida para "Línea conectada".
      Sin latido fresco: "La linea no da senal desde las HH:MM" (clase `stale`), con el
      mismo `LATIDO_LINEA_VENCE_MS` que config.html (la prueba compara los dos).
- [x] T7 — `wa-read doctor`: el transporte exige `sidecar_beat` fresco
      (misma regla que `sidecar_vivo` en `bin/wa-send`); `checkSystem`
      periódico. La regla vive ahora en `wa_store.sidecar_vivo` y la usan los dos;
      sin latido el renglón sale con el código nuevo `transport-silent` (bloquea, se
      traduce en el panel, no notifica). `checkSystem` cada `SALUD_MS` (5 min), sin
      encimarse, y sin repetir la misma notificación.
- [x] T8 — Capturas de los estados nuevos (sin señal, sesión cerrada → QR) a
      1440/768/390/320, ES y EN, revisadas a ojo. `test/shots.mjs` gana
      `enTodosLosAnchos` (los estados marcados van también en inglés a los cuatro
      anchos) y `LATIDO_FRESCO` (el latido se sella al fotografiar).

- [ ] T9 — Cada número, su línea (decisión del dueño, 2026-10-01). Visto en vivo:
      tras vincular OTRO número, la línea nueva heredó los 305 chats y las 3
      autorizaciones en `responder` del número viejo, porque todo cuelga de la cuenta
      fija `local` y la fila de `linea` se pisó. Es una fuga de permisos entre líneas.
      Los datos y las autorizaciones quedan atados a la identidad del teléfono; un
      número nuevo empieza limpio; nada se borra y lo viejo reaparece si ese número
      se vuelve a vincular.
  - [x] T9a — Sidecar: la cuenta sale de la identidad (`pn:<dígitos>` de
        `creds.me.id`); al abrir, si difiere de `store_meta.linea_activa`, cambia la
        línea activa. Nunca copia filas ni pisa la `linea` de otra identidad.
  - [x] T9b — `wa_store`/`wa-read` (solo lectura): `linea_activa()`; `inbox`,
        `chats`, `whoami`, `state` y `doctor` miran la línea activa por defecto.
  - [x] T9c — `wa-scope`: `chat_scope`, `juicio`, `agent_action`, `work`, `digest`
        y `run_trace` por cuenta, filtrados por la línea activa; `scope`, `chats`,
        `activity`, `navBadge` y `decisions` del storage se rearman por línea; lo que
        el panel autorizó se persiste en `chat_scope` para no perderse al cambiar.
  - [x] T9d — `wa-send` se niega a mandar por una autorización de otra identidad.
  - [x] T9e — Worker y paneles: la cuenta viaja a `sidecar.cuenta`; el panel etiqueta
        autorizaciones y decisiones con ella; datos de otra línea se muestran como
        vacíos honestos; el worker sincroniza al cambiar de línea.
  - [ ] T9f — Migración `local` → cuenta de la identidad en `capture.db` (sidecar) y
        `scope.db` (`wa-scope`), atómica y visible en `wa-read doctor`. Escrita y
        probada, SIN conectar al arranque hasta que el lead repare los datos vivos.
  - [ ] T9g — Capturas: selector de conversaciones y panel de actividad tras cambiar
        de número (listas limpias), ES/EN, 1440/768/390/320, revisadas a ojo.

## Criterios de aceptación

- Con credenciales muertas (401), el panel muestra un QR nuevo sin intervención.
- Con el sidecar muerto o sin latido, ningún panel dice "conectado".
- `npm run check` en exit 0.

## Verificación

### T1 — credenciales muertas

- RED `node test/sidecar-pairing.test.mjs`:
  `SyntaxError: The requested module '../sidecar/src/index.js' does not provide an export named 'SALIDA'`
- RED `node test/worker.test.mjs`:
  `FALLA el QR nuevo llega a storage sin ningun pedido del panel — {... "motivo":"sidecar-cayo","statusCode":401,"error":{"code":"sidecar-cayo","detail":"sidecar exited (code 3, signal null)"} ...}`
  (es la causa 2 tal cual: el `exit` pisa `sesion-cerrada`).
- GREEN: `sidecar-pairing` 58/58, `worker` 125/125, `sidecar-build` 5/5.

### T2 — 403/411/440 con tope

- RED `node test/sidecar-pairing.test.mjs`:
  `SyntaxError: The requested module '../sidecar/src/index.js' does not provide an export named 'CIERRES_REPETIDOS_TOPE'`
- RED `node test/worker.test.mjs`:
  `FALLA la salida se clasifica como rendida — {"tipo":"caida","motivo":"sidecar-cayo",...}`
- GREEN: `sidecar-pairing` 78/78, `worker` 128/128, `sidecar-build` 5/5.

### T3 — latido de la línea

- RED `node test/sidecar-pairing.test.mjs`:
  `SyntaxError: The requested module '../sidecar/src/index.js' does not provide an export named 'LATIDO_LINEA_MS'`
- RED `node test/worker.test.mjs`:
  `FALLA el latido queda en la clave que leen los paneles — {... "store":null,"startedAt":...}` (sin `latido`)
- GREEN: `sidecar-pairing` 84/84, `worker` 131/131 (dos corridas), `sidecar-build` 5/5.
- Nota: en una corrida falló "el QR llega a storage" de la prueba previa "el sidecar
  habla" (ventana de 200 ms entre QR y `open` en el guion falso); dos corridas
  siguientes en verde. Inestabilidad previa, no de este cambio.

### T4 — supervisor del worker

- RED `node test/worker.test.mjs`: la suite se cortó en
  `worker: una caida del sidecar se reinicia sola, con backoff y tope` y salió con
  **exit 0** (`typeof decidirReinicio = undefined`; la autopsia de `activate()` se
  tragaba el `TypeError`). Arreglado de paso: la suite arranca con
  `process.exitCode = 1` y un corte a mitad ahora sale con 1 (observado: `exit=1`).
- GREEN: `worker` 140/140, exit 0.

### T5 — panel de config

- RED `node test/panels.test.mjs` (22 fallas), entre ellas:
  `FALLA con el latido viejo NO dice conectado — WhatsApp esta conectado`,
  `FALLA 401: ofrece desvincular — hidden=true`,
  `FALLA 401: no ofrece reintentar — hidden=false`,
  `FALLA sesion-reemplazada: se explica en el idioma del panel, no con el detalle crudo — DETALLE-CRUDO-DEL-SIDECAR`.
- Fixtures "conectado" existentes del panel de config: ahora traen `latido` fresco
  (cambió la regla, no la intención de esas pruebas).
- GREEN: `panels` 401/401; `check-panels` ok; `check-voseo` ok.

### T6 — panel de actividad

- RED `node test/panels.test.mjs` (6 fallas), entre ellas:
  `FALLA con el latido viejo no dice conectada — Linea conectada · +573000000011`,
  `FALLA config y actividad usan el mismo plazo de latido — config=150000 actividad=null`.
- GREEN: `panels` 407/407; `check-panels` ok; `check-voseo` ok.

### T7 — doctor y salud periódica

- RED `node test/almacen.test.mjs`:
  `FALLA con el latido viejo, el transporte NO esta en verde — {"check":"a message transport","ok":true,"detalle":"2 linked lines (local, segunda)",...}`
- RED `node test/panels.test.mjs`:
  `FALLA la linea sin senal se dice en espanol — ⚠a message transport transport-silent: the linked line has given no sign of life since 2026-09-30 17:44`
- RED `node test/worker.test.mjs`: `FALLA se revisa cada pocos minutos, no cada segundo — undefined`
  y la suite se cortó con exit 1 (el blindaje de T4 funcionando).
- Fixture actualizado: la prueba F2 del doctor "con la linea enlazada, el renglon del
  transporte esta en verde" ahora hace `almacen.latir()` antes (línea viva).
- GREEN: `almacen` 186/186, `panels` 408/408, `worker` 147/147, `check-clis` ok,
  `envio` en verde, `check-voseo` ok.

### T8 — capturas

- `npm run shots`: 408 capturas, "sin desbordes, sin errores de JS y con los select
  legibles" (en ../.orca-wa-inbox-capturas/).
- Revisadas a ojo, ES y EN, oscuro y claro, a 1440/768/390/320 (16 por estado, 96 en
  total; la parte superior donde viven la alerta, la vinculación y el renglón de la
  línea): `config-sidecar-sin-senal`, `config-sidecar-401-tapado`,
  `config-sidecar-reemplazada`, `config-sidecar-sesion-cerrada`, `config-sidecar-qr`,
  `actividad-linea-muda`. Control: `config-sidecar-conectado-es-dark-320` y
  `actividad-linea-viva-es-light-1440` siguen diciendo conectado.
- Lo que delató mirar: la alerta de `transport-silent` decía "Reintente la conexion
  aca arriba" con el botón DEBAJO. Corregido en es/en/pt ("aca abajo"/"below"/"aqui
  embaixo") y vuelto a fotografiar.


### T9a — la cuenta sale de la identidad (sidecar)

- RED `node test/sidecar-mensajes.test.mjs`:
  `SyntaxError: The requested module '../sidecar/src/mensajes.js' does not provide an export named 'cuentaDeIdentidad'`
- RED `node test/almacen.test.mjs`: `TypeError: alm.lineaActiva is not a function`
- RED `node test/envio.test.mjs`:
  `FALLA sale solo lo de la linea del socket — [{"jid":"120363111222333444@g.us","texto":"de la vieja"},{"jid":"573009998877@s.whatsapp.net","texto":"de la nueva"}]`
  (lo encolado para el número viejo salía desde el socket del nuevo).
- GREEN: `sidecar-mensajes` 87/87, `almacen` 194/194, `envio` 49/49,
  `sidecar-pairing` 84/84, `sidecar-build` 5/5 (bundle reconstruido).
- Cuenta `pn:<dígitos>`: el teléfono está en `creds.me.id` desde el emparejamiento; el
  LID llega después por `creds.update`. Sin identidad (emparejando) no se escribe ni se
  manda nada. Se quitó `WA_SIDECAR_CUENTA`: forzar una cuenta fija es justo la fuga.

### T9b — los lectores miran la línea activa

- RED `node test/almacen.test.mjs` (3 fallas), entre ellas:
  `FALLA y \`whoami\` dice el numero nuevo, uno solo — [{... "account":"pn:573001112233" ...},{... "account":"pn:573000000012" ...}]`
- RED doctor: `FALLA y el doctor habla de la linea activa, no de las dos — {... "via":"pn:573001112233"}`
- GREEN: `almacen` 200/200, `check-clis` ok. Un almacén sin `linea_activa` (de antes)
  sigue leyendo todas; `--line` puede pedir otra línea nombrándola.

### T9c — `wa-scope` por línea

- RED `scripts/check-clis` (`revisa_linea_por_numero`, escenario real con dos números,
  HOME temporal), reproduce lo visto en vivo:
  `con el numero nuevo vinculado, \`wa-scope list\` hereda ['100@g.us', '300@g.us', '400@g.us']`,
  `con el numero nuevo, \`wa-scope run\` muestra la corrida del viejo: {'state': 'ok', ... 'mapped': 3, 'authorized': 3}`,
  `'lo ultimo que hizo' del numero nuevo trae lo del viejo`,
  `la insignia del numero nuevo cuenta avisos del viejo: {'count': 1}`,
  `la cobertura del numero nuevo cuenta las del viejo: 3 de 3`.
- Regresión encontrada en el camino (`envio.test`, 6 fallas `send-denied`):
  `persistir_panel` pisaba el `chat_name` de la base con el jid provisorio del panel.
  Arreglado con la misma regla que `anotarChat`.
- GREEN: `check-clis` 172 comprobaciones (antes 160); `npm run check` exit 0.
- Cómo: `cuenta_activa()` sale de `store_meta.linea_activa` (por `wa_store`, solo
  lectura; sin ella, `local`). `agent_action`, `work` y `digest` ganan una columna
  `account` (default `local`, aditiva: no re-clava nada). El rastro de corrida va por
  línea (`triage@pn:...`; `local` conserva `triage`). El storage del panel se rearma con
  la línea activa (`scope` con `account`, `activity.account`, `chatsAccount`) y las
  decisiones se filtran por línea; lo que el panel autorizó se guarda en `chat_scope`
  con su línea antes de reescribir el storage, para que nada se pierda al cambiar.

### T9d — `wa-send` no manda por otra identidad

- RED `node test/envio.test.mjs` (5 fallas):
  `FALLA la autorizacion del numero viejo no manda desde el nuevo`,
  `FALLA y lo dice con su propio codigo`, `FALLA la del panel de antes (sin cuenta) tampoco`,
  `FALLA ni nombrando la linea vieja a proposito` (el mensaje salía).
- GREEN: `envio` 54/54, `check-clis`, `check-harness` y `check-prompts` ok. Código nuevo
  `send-line-not-linked` (sale 3, como el permiso), documentado en harness/COMMANDS.md.

### T9e — worker y paneles por línea

- RED `node test/worker.test.mjs` (contra el `main.mjs` commiteado):
  `FALLA la cuenta de la linea vinculada queda en la clave que leen los paneles — {... "me":"+573000000012" ...}` (sin `cuenta`)
  y `FALLA y el cambio de linea dispara un sync, sin esperar al reloj`.
- RED `node test/panels.test.mjs` (9 fallas), reproduce la captura en vivo:
  `FALLA el selector no ofrece las conversaciones del numero anterior — ["","100@g.us"]`,
  `FALLA no muestra la cobertura del numero anterior — El agente actua sobre 3 de 306 conversaciones`,
  `FALLA ni su corrida — La revision arranco y no volvio · 2026-09-24 08:46`,
  `FALLA ni su cola — ... pendiente viejo✓ lo toma tu agente`,
  `FALLA la decision queda etiquetada con el numero vinculado`.
- GREEN: `worker` 149/149, `panels` 423/423, `check-panels` y `check-voseo` ok.
- Cómo: el sidecar emite `{type:'linea', cuenta, cambio}`; el worker lo deja en
  `sidecar.cuenta` y, si cambió, pide un sync (reintenta mientras otro sync corre). Los
  paneles comparan `sidecar.cuenta` con `chatsAccount`, `activity.account` y el
  `account` de cada autorización y decisión: lo de otro número no se pinta (vacíos
  honestos) y lo nuevo se etiqueta con el número vinculado. La insignia la reescribe el
  sync que dispara el cambio de línea (probado en `check-clis`).
