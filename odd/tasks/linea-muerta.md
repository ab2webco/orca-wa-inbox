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

