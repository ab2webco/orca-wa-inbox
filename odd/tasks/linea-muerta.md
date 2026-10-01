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
- [ ] T2 — Sidecar: 403/411/440 con tope de intentos y motivo propio.
- [ ] T3 — Sidecar: latido periódico por stdout (≥60 s, respeta el tope de 64
      llamadas sin confirmar del host).
- [ ] T4 — Worker: el `exit` no sobrescribe `sesion-cerrada`; reinicio
      supervisado con backoff y tope para las demás salidas. Prueba en
      `worker.test.mjs`.
- [ ] T5 — Panel de config: "conectado" exige latido fresco; con 401 ofrece
      Desvincular y no Reintentar. Prueba en `panels.test.mjs`.
- [ ] T6 — Panel de actividad: mismo criterio de vida para "Línea conectada".
- [ ] T7 — `wa-read doctor`: el transporte exige `sidecar_beat` fresco
      (misma regla que `sidecar_vivo` en `bin/wa-send`); `checkSystem`
      periódico.
- [ ] T8 — Capturas de los estados nuevos (sin señal, sesión cerrada → QR) a
      1440/768/390/320, ES y EN, revisadas a ojo.

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

