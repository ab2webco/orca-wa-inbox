# Transporte único de WhatsApp — sidecar Baileys

**Encargo:** `docs/ENCARGO-TRANSPORTE-UNICO.md`
**Rama:** pendiente (hoy `main`; se crea antes del primer commit)
**Estrategia de entrega:** `ask-on-risk`
**TDD:** activo (`Strict TDD Mode: enabled` en CLAUDE.md)
**Runner:** `npm run check` para la cadena completa; por prueba, `node test/<archivo>.test.mjs`
**Capturas:** `npm run shots` (`test/shots.mjs`), contra el `config.html` real

---

## Objetivo

Reemplazar los dos transportes actuales —app de macOS y WhatsApp Web— por un
sidecar headless que habla el protocolo multi-dispositivo vía Baileys.

Esta rebanada cubre **sidecar y emparejamiento**: que el plugin conecte con
WhatsApp y que el QR aparezca en el panel de ajustes. La eliminación de los
transportes viejos y el almacén de mensajes son rebanadas posteriores.

## Problema

Ninguna librería de WhatsApp puede correr dentro del worker: el sandbox borra
`WebSocket` y lanza excepción al resolver `net`/`tls`, incondicionalmente
(`plugin-host-preload.ts:21-29,85`). El transporte tiene que vivir en un proceso
hijo sin sandbox, lanzado con `process:spawn`.

## Restricciones

- **Árbol del plugin ≤ 50 MB y ≤ 2.000 archivos, sin symlinks**
  (`plugin-content-hash.ts:15-16,50-52`). No hay mecanismo de exclusión: el
  validador sólo salta `.git` en la raíz. Ya nos costó una tarde.
- **Las dependencias de build van en `../.orca-wa-inbox-deps`**, el patrón que el
  repo ya usa para el arnés. Al árbol del plugin sólo entra el bundle.
- **El auth state NO va dentro de la carpeta del plugin** — el árbol está
  verificado por content-hash. Va en `<userData>/plugins-data/<publisher>.<id>/`.
- **El panel sólo tiene `storage.get`/`storage.set`.** No hay canal panel→worker
  ni evento de cambio de storage: ambas direcciones son polling.
- **Presupuesto del panel: 30 mensajes por 10 s**, con 4 reservados para clics
  (`config.html:1523-1534`). El sondeo del QR entra en ese presupuesto.
- **`fork()` no fija `cwd`**: todas las rutas del sidecar deben ser absolutas.

## Alcance autorizado

`main.mjs`, `config.html`, `orca-plugin.json`, `sidecar/` (nuevo),
`../.orca-wa-inbox-deps/package.json`, `test/`.

**Fuera de alcance en esta rebanada:** borrar `web-lines.mjs`, tocar
`bin/wa-read`, `bin/wa-send` o el modelo de datos. El transporte viejo sigue
funcionando mientras el nuevo no esté probado.

---

## Tareas

### T1 — Build del sidecar

- [x] Añadir `@whiskeysockets/baileys` fijado a `6.7.24` y el `overrides` de
      `libsignal` a `../.orca-wa-inbox-deps/package.json`
- [x] Script de build: `esbuild --bundle --platform=node --format=cjs
      --target=node20 --minify --external:sharp` → `sidecar/sidecar.cjs`
      (via `sidecar/build.mjs`, API de JS de esbuild con `nodePaths` porque la CLI
      no tiene forma de apuntar a un `node_modules` hermano; wireado como
      `npm run build:sidecar`)
- [x] Prueba: el bundle existe, es **un solo archivo**, y el árbol del plugin
      sigue bajo 50 MB y 2.000 archivos sin symlinks
      (`test/sidecar-build.test.mjs`, 5/5 en verde)
- [x] Ruta: **delegada** (toca 2+ archivos no triviales)
- Commit: `fe99c53`

### T2 — Sidecar: emparejamiento, auth state y reconexión

- [x] Entrada del sidecar con `useMultiFileAuthState` apuntando a un directorio
      absoluto que pasa el worker por `WA_SIDECAR_AUTH_DIR` o `argv[2]` — el
      sidecar NO adivina la ruta; se crea con `0700` y se reafirma con `chmodSync`
- [x] Protocolo JSON por stdio con el worker: `qr`, `connection`, `error`
- [x] Reconexión con backoff acotado (1 s → 30 s, exponencial); **no** reconectar
      en `loggedOut` (401); reconexión inmediata en `restartRequired` (515);
      `connectionLost`/`timedOut` (ambos 408 en esta versión de Baileys) se tratan
      honestamente como un solo motivo, `socket-caido`
- [x] Cada mensaje de QR lleva `ts` y `rotation` — el panel descarta lo vencido
      (§6 del encargo; helper `qrVencido` compartido)
- [x] Prueba: dado un cierre con cada `statusCode`, decide reconectar o pedir QR
      (`test/sidecar-pairing.test.mjs`, 25/25 en verde; lógica extraída a
      `decidirTrasCierre`, pura, sin socket)
- [x] Ruta: **delegada**
- Commit: `fe99c53`

### T3 — Worker: lanzar y supervisar el sidecar

- [x] `activate()` lanza el sidecar con `process.execPath` +
      `ELECTRON_RUN_AS_NODE=1`, como ya hace `sembrarFuera` (`main.mjs:688-694`)
- [x] Espejar estado y QR a `storage.set` con su `ts`
- [x] El latido existente (`main.mjs:712-727`) no se toca
- [x] Prueba: si el sidecar muere, el motivo llega al storage que lee el panel —
      el mismo camino de falla que `test/worker.test.mjs` ya cubre para el sync
- [x] Ruta: **inline**, toco `main.mjs`, `harness.mjs` (refactor minimo: exporta
      `dataDir`, reusando la misma tabla de raices de userData que `workspaceDir`)
      y `sidecar/resolve-auth-dir.mjs` (nuevo, subprocess que resuelve el auth dir
      fuera de la valla de permisos)
- Commit: `a8aeac9`

**Diseño:** el directorio de auth (`<userData>/plugins-data/<publisher>.<id>/wa-auth/`)
se resuelve en un subproceso (`sidecar/resolve-auth-dir.mjs`, mismo patrón que
`sembrarFuera`) porque el worker no puede leer el userData de Orca. `lanzarSidecar()`
(exportada de `main.mjs`) hace `spawn()` del sidecar, parsea su protocolo JSON-lines
y lo espeja a `storage.sidecar`, con códigos estables propios (`sidecar-sin-authdir`,
`sidecar-sin-permiso`, `sidecar-authdir-fallo` —los tres del resolvedor, ver T7—,
`sidecar-no-arranco`, `sidecar-cayo`) distintos del `MOTIVO` del sidecar. `sidecarPath`
es un override interno en settings (como `toolsDir`) para que las pruebas apunten a
un guión de mentira en vez del bundle real.

**Evidencia (TDD real, RED confirmado por `git stash` antes de implementar):**
sin la implementación, `lanzarSidecar` no existe y `node test/worker.test.mjs` corta
con `TypeError: lanzarSidecar is not a function` tras fallar las aserciones de QR/
conexión. Con la implementación: `node test/worker.test.mjs` → **134/134 en verde**
(12 pruebas nuevas: QR con `ts`/`rotation` a storage, conexión abierta descarta el QR,
caída del proceso con código estable `sidecar-cayo`, arranque fallido con
`sidecar-no-arranco`, apagado a propósito no se reporta como caída, `WA_SIDECAR_AUTH_DIR`
resuelto fuera de la valla y bajo `plugins-data/ab2web.orca-wa-inbox/wa-auth`, y sin
userData el resolvedor dice `sin-userdata` en vez de adivinar).

### T4 — Panel: dibujar el QR

- [x] Incrustar el codificador (`qrcode-generator` 2.0.4, Kazuhiko Arase, MIT,
      minificado con esbuild a ~21 KB) inline en `config.html` — la CSP prohíbe
      `<script src>`; se conserva la nota de licencia sin minificar
- [x] Dibujar en `<canvas>`, no `data:` URI: módulo a módulo con `ctx.fillRect`,
      con zona de quietud de 4 módulos y fondo `#fff` fijo (no un token) para que
      el QR siga siendo legible en tema oscuro
- [x] Escalar con el ancho: 260 px hasta 480, 300 hasta 1024, 360 por encima
- [x] Estado vencido explícito: **no dibujar** un QR muerto — mensaje
      "El código venció" y detalle "esperando uno nuevo"
- [x] Sondeo de 2 s mientras el QR vive (`vigilarSidecar`, timer dedicado como
      `vigilarLineas`), detenido al emparejar, respetando `CUPO` y
      `document.visibilityState`
- [x] `sidecar` entra a `CLAVES`/`CLAVES_VIVAS`: presupuesto medido, ~11 de 26
      mensajes por 10 s del sondeo (6-7 de la base de 12 s + ~5 del dedicado de 2 s)
- [x] Prueba: `test/panels.test.mjs` cubre los cinco estados, el descarte por
      vencimiento, el escalado por ancho, `SIN_RESPUESTA` (no apaga el QR ya
      pintado) y que el sondeo dedicado se detenga al emparejar
- [x] **Capturas con `npm run shots`** a 1440/768/390/320 en ambos temas — **miradas**
- [x] Ruta: **delegada**, toco `config.html` y `test/panels.test.mjs`
- Commit: `a8aeac9`

**Evidencia (TDD real):** con `git stash` sobre `config.html`, `node test/panels.test.mjs`
corta con `TypeError: Cannot read properties of null (reading 'textContent')` en la
primera aserción del bloque nuevo — la sección de vinculación no existe todavía. Con
la implementación: **346/346 en verde** (20 pruebas nuevas).

**Evidencia visual (regla del proyecto):** `npm run shots` generó 328 capturas. Se
encontró y corrigió un defecto real mirándolas: la primera corrida de "QR en pantalla"
en tema claro a 1440px mostraba **"El código venció"** en vez del QR, porque
`test/shots.mjs` calculaba el `ts` del QR de prueba UNA vez al arrancar el guión —
minutos antes de que le tocara el turno a esa captura, superando los 20 s de vigencia.
Corregido refrescando `ts: Date.now()` por captura (mismo patrón que ya usaba
`workerBeat` en ese archivo para el mismo problema). Se miraron, tras la corrección:
`config-sidecar-{esperando,qr,conectado,caido}` en es-419 y en-US, en **1440, 768, 390
y 320 px**, en **claro y oscuro**. Los cuatro estados se ven correctos: QR legible con
fondo blanco y zona de quietud incluso en tema oscuro, mensaje de "conectado" en texto
normal, mensaje de "sesión caída" en `--destructive` con el detalle traducido por
código (`sidecar-cayo` → "El sidecar se detuvo. Reinicie Orca..."), sin desbordes en
ningún ancho.

### T5 — Emparejar de verdad, desde el panel

Decisión del usuario (2026-09-21): **no se verifica por terminal.** El arnés del
scratchpad queda descartado como camino de validación. La persistencia de sesión
se comprueba sobre el producto real, después de T4, no antes.

El costo asumido: si la sesión no sobreviviera a un reinicio, se descubre con T3
y T4 ya construidos encima. Se acepta a cambio de no validar sobre algo que no
es el plugin.

- [ ] Escanear el QR **del panel de ajustes**
- [ ] Verificar: reiniciar Orca recupera la sesión **sin pedir QR**
- [ ] Verificar: suspender y despertar la máquina reconecta solo
- [ ] Ruta: **manual**, requiere teléfono
- Commit: —

### T6 — Quitar los transportes viejos

Decisión del usuario (2026-09-22), pedida tres veces: el panel debe quedar **sólo
con la vinculación por QR**. Nada de app de escritorio, nada de WhatsApp Web,
nada de líneas conectadas.

El costo que se advirtió —que el plugin deja de leer hasta que exista el almacén
de mensajes— **ya estaba pagado**: el usuario tenía las dos rutas en `no` y el
panel mostraba "No hay de donde leer". No se pierde nada que estuviera vivo.

- [x] `config.html`: quitadas la sección "DE DONDE LEE" (`readLocal`, `readWeb`,
      `readWebText`), la sección "LINEAS CONECTADAS" entera con su máquina de
      estados, y el requisito opcional "WhatsApp Web como segunda linea" (se va
      solo: el doctor ya no emite el código `web`). 3.201 → 2.014 líneas
- [x] `main.mjs`: quitado el despachador de pestañas (`atenderWeb`, `filaVigente`,
      `veredicto`, `destinoPedido`, `refrescarLineas`, las casas, `cuentasWeb`,
      `orcaCli`) y el sondeo `webLines`/`webRequest`/`webStatus`/`webHomes`.
      Intactos el latido, `run()`/`runJson()`, `sembrarFuera`, el sidecar de T3 y
      `resolverCasaOrca` (sigue resolviendo `ORCA_USER_DATA_PATH` para los CLIs).
      1.249 → 807 líneas
- [x] `web-lines.mjs` borrado entero (506 líneas)
- [x] `bin/wa-scope`, `bin/wa_settings.py`: las tres claves `read_*` y
      `web_timeout_s` fuera de **las cinco** sitios a la vez —`PANEL_SETTINGS`,
      `CONFIG_OPCIONES`, `CONFIG_NUMERICOS`, `DEFAULT_CONFIG` y la combinación de
      `cmd_accounts`— que es la cicatriz que documenta `wa_settings.py:5`
- [x] `bin/wa-read`: borradas `LocalSource` (Core Data) y `WebSource` (eval del
      navegador) y, con ellas, la capa SQL que sólo esas dos poblaban. Los seis
      comandos de lectura se **niegan** con código 4 y el motivo estable
      `no-transport`; `doctor` sigue contestando porque es el único que puede
      explicar por qué. 2.212 → 197 líneas
- [x] `bin/wa-send`: borradas la vía de accesibilidad y la vía DOM/Lexical.
      Sobreviven la firma obligatoria, el rechazo de la ambigüedad
      (`send-ambiguous-line`), `send-wrong-line` y el despacho por línea; después
      de todo eso se niega con `send-no-transport`. 724 → 122 líneas
- [x] `orca-plugin.json:7`: descripción reescrita (enlaza la línea con un QR);
      `capabilities` sin tocar
- [x] Tests y chequeos: `scripts/check-clis` 3.510 → 876 líneas,
      `test/worker.test.mjs` 1.477 → 761, `test/panels.test.mjs` 2.177 → 1.451,
      `test/shots.mjs` 856 → 546. **Nada desactivado ni comentado**
- [x] `docs/LECTURA-MULTIFUENTE.md` borrado; las citas que quedaban en código vivo
      (`sidecar/src/index.js`, `main.mjs`, `bin/wa-scope`, dos pruebas) apuntan
      ahora a `docs/ENCARGO-TRANSPORTE-UNICO.md §11`
- [x] Ruta: **delegada** para la exploración (4 mapeos en paralelo), escritura
      inline con verificación por etapa
- Commit: — (instrucción explícita de no commitear)

**El contrato nuevo, que es lo único que se agregó:** `no-transport` (wa-read,
salida 4) y `send-no-transport` (wa-send). Un motivo propio y no un fallo genérico
porque la acción del usuario es distinta: no es reintentar ni revisar la
conversación, es esperar al almacén de mensajes (§11 E2). Negarse es el punto —
una lista vacía se lee como "no hay nada que atender", que es lo contrario de "no
puedo leer nada" (`bin/wa-read`, E5).

**Defecto arreglado, y dos más que apareció barriendo.** El pedido era el texto en
inglés *"both routes are off: turn the desktop app or WhatsApp Web back on"* en un
panel en español. Se fue con su sección, pero el barrido de códigos encontró que la
causa seguía viva:

1. El panel pintaba `salud.detail` **crudo** siempre. Sirve cuando el detalle es un
   dato —una ruta, un tamaño, un error de proceso— y miente cuando es una frase.
   Ahora el código manda si el panel lo conoce (`HEALTH_HOW_KEY`) y el crudo queda
   de respaldo. `hNoTransportHow` en `es`/`en`/`pt`.
2. **`sin-herramientas` no estaba en `HEALTH_KEY`.** Lo escribe el worker, no el
   CLI, y por eso nadie lo había mirado: cuando las herramientas no contestaban, el
   panel en español mostraba *"the plugin tools did not answer"*. Agregado
   `hNoTools` en los tres idiomas.
3. Códigos muertos que el CLI ya no emite y que el panel seguía sabiendo traducir
   (`system`, `whatsapp`, `database`, `readable`, `sqlite3`, `send`, `fulldisk`,
   los doce `web-*` y `local-covered-by-web`): fuera de las tablas, con sus 117
   cadenas huérfanas en los tres idiomas.

**Decisión de producto tomada en el camino:** `no-transport` **bloquea**
(`health.ok:false`, y `wa-scope pending` sale con 2) pero **no saca notificación**.
Bloquear es honesto —una bandeja siempre vacía se lee como una semana tranquila—
pero una notificación es para lo que tiene acción, y esto no la tiene: lo arregla
la rebanada que falta. Una notificación en cada arranque de cada máquina por algo
que nadie puede arreglar es como se enseña a ignorarlas. El motivo sí va al log
siempre. Cubierto por dos pruebas, una de cada lado.

**Evidencia (TDD real, RED observado antes de implementar):**

- **CLIs.** Se escribió primero `revisa_sin_transporte` en `scripts/check-clis`
  (36 comprobaciones). Contra el código viejo: **19 fallas** —
  `wa-read inbox` salía 1 con `local-unavailable` en vez de 4 con `no-transport`,
  `state` salía 0 y escribía en stdout, el doctor no traía el renglón y seguía
  nombrando `whatsapp web`/`read_web`/`read_local`/`desktop app`, y `wa-send`
  reventaba con un traceback. Con la implementación: **36/36**.
- **Manifiesto.** La prueba nueva falló con
  `the description still promises "WhatsApp Web", which the plugin no longer does`
  antes de reescribir la descripción. Después: **2/2**.
- **Worker.** La prueba de la notificación se corrió con el filtro
  (`accionables`) revertido a mano: **76/77**, con
  `FALLA y no saca una notificacion por algo que el usuario no puede arreglar —
  [{"title":"WhatsApp Inbox needs something else",...}]`. Restaurado: **77/77**.

**Verificación (orden canónico, todo en verde):**
`check-panels` · `check-voseo` (27 archivos) · `check-prompts` (17) ·
`check-harness` (25) · `check-closing` (36/36) · `check-clis` (8 CLI, 134
comprobaciones) · `manifest` 2/2 · `worker` 77/77 · `panels` 221/221 ·
`sidecar-build` 5/5 · `sidecar-pairing` 25/25 · `npm run shots` **192 capturas,
sin desbordes, sin errores de JS y con los select legibles**.

**Evidencia visual (regla del proyecto), miradas:** `config` en es/en, claro y
oscuro, a **1440, 768, 390 y 320** — el panel queda con requisitos, vinculación por
QR, agente, tono, transcripción, conversaciones y reglas, **sin encabezados vacíos
ni huecos** donde estaban las dos secciones. `config-sin-transporte` (nuevo, a los
cuatro anchos y en los dos idiomas) muestra la alerta entera en el idioma del
panel: en es-419 *"Todavia no hay de donde leer mensajes — Las dos vias viejas…
Enlace su linea con el codigo QR de aca arriba"*, en en-US el equivalente, **sin
una palabra del CLI sin traducir**. `config-sidecar-qr` sigue legible con fondo
blanco y zona de quietud en tema oscuro.

**Fuera de alcance, y queda pendiente:** `docs/el-plugin-whatsapp-inbox.html`
(documento de presentación) sigue describiendo las dos vías viejas. No es código,
no lo lee el plugin y ningún chequeo lo valida más allá del voseo.

### T7 — Defecto: el resolvedor del auth dir tenía un solo código para tres fallas

Visto en el producto: la tarjeta del plugin decía **"Requiere revisión"** con el
interruptor apagado, y el panel decía que no se encontró dónde Orca guarda los datos
del plugin en este equipo — pero `node sidecar/resolve-auth-dir.mjs <plugin>` corrido a
mano contestaba `{"ok":true,"dir":".../wa-auth"}`. El mensaje era falso y mandaba a
mirar una carpeta que estaba perfecta.

Causa: `main.mjs` escribía `SIDECAR_MOTIVO.SIN_AUTHDIR` para **cualquier** `{ok:false}`
del resolvedor, sin mirar si el resolvedor había contestado o si ni siquiera había
podido correr. Y peor: sin `process:spawn` concedido, el worker arranca sin
`--allow-child-process` y `execFile` **lanza en el acto** en vez de fallar por callback
—medido: `Error: Access to this API has been restricted. Use --allow-child-process`—,
así que la promesa se rechazaba, el motivo moría en un `orca.log` y al panel no llegaba
**nada**. Aparte, `motivoDe()` espera la forma que arma `run()` (`spawnCode`,
`timedOut`) y recibía el error crudo de `execFile`: devolvía `'fallo'` siempre.

- [x] `SIDECAR_MOTIVO`: `SIN_AUTHDIR` queda para "el resolvedor contestó que esta
      máquina no tiene userData" (su `reason: 'sin-userdata'`), y se suman
      `SIN_PERMISO` (`sidecar-sin-permiso`) y `AUTHDIR_FALLO`
      (`sidecar-authdir-fallo`), decididos por `motivoAuthDir()`
- [x] `resolverAuthDir()`: `try/catch` alrededor de `execFile` —la valla lanza, no
      rechaza— y `motivoDeCrudo()` traduce el error crudo a la forma que `motivoDe()`
      entiende; `motivoDe()` suma `ERR_ACCESS_DENIED` a `sin-permiso`, que es como
      deniega la valla de Node
- [x] `config.html`: `pairingHowNoPermission` y `pairingHowAuthDirFailed` en `es`/`en`/
      `pt`, y las dos entradas nuevas en `SIDECAR_HOW_KEY`. El español del caso sin
      permiso manda a **"Revisar y activar"** el plugin, que es la acción que lo arregla
- [x] `test/shots.mjs`: caso `config-sidecar-sin-permiso`, a los cuatro anchos y en los
      dos temas — el texto es lo único que cambia y un texto que manda a la acción
      equivocada no lo delata ninguna prueba de código, solo mirarlo
- [x] Ruta: **delegada** (5 archivos: `main.mjs`, `config.html`, `test/worker.test.mjs`,
      `test/panels.test.mjs`, `test/shots.mjs` — disparó el trigger de escritura)
- Commit: — (instrucción explícita de no commitear)

**Por qué tres códigos y no cuatro:** un timeout (`demoro`) y un reventón (`fallo`) le
piden lo mismo a quien lee el panel, así que van juntos en `AUTHDIR_FALLO`. Un permiso
denegado pide algo completamente distinto —aprobar el plugin— y por eso sí se separa
(`docs/LECTURA-MULTIFUENTE.md`: *"la accion del usuario es distinta en cada uno"*).

**Evidencia (TDD, RED observado antes de implementar):**
`node test/worker.test.mjs` con las pruebas nuevas y sin la implementación dio
**135/139**, con los tres códigos observados en
`["sidecar-sin-authdir", null, "sidecar-sin-authdir"]`: el caso tras la valla no llegaba
al storage (`null`) y el resolvedor reventado llegaba como `sidecar-sin-authdir` —
exactamente el defecto. `node test/panels.test.mjs` dio
`DETALLE-CRUDO-DEL-WORKER` para los dos códigos nuevos (el panel no los conocía).

Las pruebas del worker corren `activate()` en un **hijo** porque cada caso necesita un
arranque distinto: un `HOME` sin userData, `--permission` sin `--allow-child-process`
(la valla de verdad, igual que la usa Orca), y un `NODE_OPTIONS` inválido que hace que
el `node` hijo no levante. En macOS el directorio temporal es un enlace simbólico
(`/var/folders` → `/private/var/folders`) y la valla compara rutas resueltas: hay que
darle el `realpath` **y entrar por él**, o el hijo no puede leer ni su propio guión.

### T8 — El almacén de mensajes: que el plugin sirva para algo

Hoy el plugin **conecta y se detiene**. Emparejar no es utilidad: la bandeja está
vacía, la lista de conversaciones está vacía, el triage no tiene qué triar, y
cualquier modelo que use el CLI recibe `no-transport`. **Una sola pieza tumba
todas las partes**, y es esta.

**Casos de uso reales que tiene que soportar** (de los destinos que el propietario
ya atiende: soporte por WhatsApp, helpdesk, sitios de cliente):

1. Un cliente escribe en su grupo *"el reporte de ayer salió en blanco"*. Debe
   aparecer en la bandeja, con su conversación, su remitente y su hora.
2. Ese mismo cliente manda después una captura. El adjunto tiene que quedar
   asociado al problema, no como un mensaje suelto sin contexto (§11-C5: el pie
   casi nunca llega en el mismo mensaje).
3. Alguien manda una nota de voz. Se transcribe con lo que ya existe
   (`bin/wa-transcribe`, que sólo necesita una ruta de archivo).
4. El agente abre **una** tarjeta, no cinco, aunque el problema venga contado en
   cinco mensajes (§11-B3).
5. Una mención que el propietario **ya contestó** no vuelve a aparecer (§11-D1).
6. Un grupo en `off` no produce absolutamente nada, ni un registro de contenido.

- [ ] Esquema nuevo, con `(cuenta, chat_jid, stanza_id)` como llave — el
      aislamiento entre líneas va en la llave, no en la intención (§11-F4)
- [ ] El sidecar escribe lo que recibe; `messages.update` cubre borrados y
      editados, que **hoy no se manejan en ningún lado** (§11-B4)
- [ ] `wa-read` pasa a ser capa de consulta sobre ese almacén, **conservando su
      contrato JSON**: es de lo que dependen `wa-scope`, los prompts y el panel
- [ ] Permisos `0600` y tope de retención con desalojo visible (§11-F1, §11-F2)
- [ ] `quotedParticipant` se mira en sus **dos** formas, o se pierde el 2% de las
      respuestas sin un solo error (§11-B1)
- [ ] La lista de menciones trae objetos, no strings: comparar con `===` da cero
      silencioso (§11-B2)
- [ ] Ruta: **delegada**
- Commit: —

### T9 — Que cualquier modelo de Orca pueda usar el CLI

El contrato ya está bien —motivo estable en la primera línea de stderr, salida 4,
stdout vacío o parseable— y el arnés lo documenta. Falta que sea **descubrible**
para un agente que no sea el de los prompts incluidos.

- [ ] `--help` de cada herramienta se basta solo: qué hace, qué devuelve, qué
      significan sus códigos de salida
- [ ] El arnés se siembra para cualquier agente de Orca, no sólo para los dos
      prompts propios
- [ ] Ruta: **delegada**
- Commit: —

---

## Criterios de aceptación

- El plugin conecta con WhatsApp sin navegador ni app de escritorio
- El QR se dibuja en el panel de ajustes y se escanea desde la pantalla
- Un QR vencido no se dibuja
- El árbol del plugin sigue validando en Orca
- `npm run check` pasa

## Checks aplicables

`npm run check` · `npm run shots` · `scripts/check-panels` (un error de sintaxis
deja el panel vacío y mudo) · `scripts/check-voseo` sobre toda cadena nueva

---

## Progreso

**Estado:** T1, T2, T3, T4, T6 y T7 cerradas con pruebas en verde y evidencia visual
mirada. T5 sigue pendiente: requiere un teléfono real y el panel de ajustes. Sin
commitear (working tree para review, según instrucción explícita).

**Lo que quedó de T6, en números:** `web-lines.mjs` y `docs/LECTURA-MULTIFUENTE.md`
borrados; `bin/wa-read` 2.212 → 197, `bin/wa-send` 724 → 122, `main.mjs` 1.249 → 807,
`config.html` 3.201 → 2.014, `scripts/check-clis` 3.510 → 876, `test/worker.test.mjs`
1.477 → 761, `test/panels.test.mjs` 2.177 → 1.451, `test/shots.mjs` 856 → 546.

**Advertencia honesta:** hasta que exista el almacén de mensajes, el plugin **no lee**.
`health.ok` es `false` con `no-transport`, `wa-scope pending` bloquea las dos
automatizaciones con ese mismo código, y la lista de conversaciones del panel queda
vacía porque `wa-scope` no tiene a quién preguntarle. Eso es lo acordado y está dicho
en voz alta en los tres idiomas; no es una regresión silenciosa.

**Evidencia de T1/T2:**

- `../.orca-wa-inbox-deps/package-lock.json`: `libsignal@6.0.0` con `integrity`
  (`sha512-d/5V3YFtDljbFMufz4ncyUYGYhJl+...`), `@whiskeysockets/baileys@6.7.24`
  fijado sin `^`, **cero** entradas `"resolved": "git...`
- `sidecar/sidecar.cjs`: **1 archivo, 3,4 MB** (el build local dio 3,4 MB contra
  los 3,17 MB medidos antes en el encargo — la diferencia es normal entre
  versiones de esbuild/plataforma, sigue siendo un solo archivo bien por debajo
  del tope)
- Árbol del plugin tras el build: **66 archivos, 5,63 MB, 0 symlinks** — muy por
  debajo de 2.000 archivos / 50 MB
- `test/sidecar-build.test.mjs`: 5/5 en verde
- `test/sidecar-pairing.test.mjs`: 25/25 en verde — `decidirTrasCierre` cubierto
  para 401 (no reconecta), 515 (reconecta ya), 408 (reconecta con backoff,
  motivando la ambigüedad `connectionLost`/`timedOut` como un solo código
  honesto), código desconocido, backoff creciente y acotado (tope 30 s), mensaje
  de QR con `ts`/`rotation`, y `qrVencido` distinguiendo QR fresco de vencido
- `scripts/check-voseo`: 28 archivos revisados (se sumaron los 4 archivos nuevos
  a `OTROS`), en verde

**Evidencia de T3/T4:**

- `harness.mjs`: refactor mínimo — `raizDelPlugin()` privada compartida por
  `workspaceDir()` (sin cambio de comportamiento) y el nuevo `dataDir()`
- `sidecar/resolve-auth-dir.mjs` (nuevo): resuelve
  `<userData>/plugins-data/ab2web.orca-wa-inbox/wa-auth/` en subproceso
- `main.mjs`: `resolverAuthDir()`, `lanzarSidecar()` (exportada), wireado en
  `activate()` con `sidecarPath` como override interno de settings (como
  `toolsDir`) para pruebas; `apagarSidecar()` en el cleanup de `activate()`
- `config.html`: sección "Vinculación de WhatsApp" (primera sección del panel),
  `qrcode-generator` 2.0.4 inline (~21 KB minificado, licencia MIT conservada),
  `dibujarQr`/`qrVencido`/`tamanoQrPx`/`renderPairing`/`vigilarSidecar`; cadenas
  nuevas en `es`/`en`/`pt`
- `node test/worker.test.mjs`: **134/134 en verde** (12 pruebas nuevas de T3)
- `node test/panels.test.mjs`: **346/346 en verde** (20 pruebas nuevas de T4)
- `node test/sidecar-build.test.mjs`: **5/5 en verde** — árbol tras el build:
  **71 archivos, 5,78 MB, 0 symlinks** (subió de 66/5,63 MB por
  `resolve-auth-dir.mjs`, sigue muy por debajo del tope)
- `scripts/check-panels`, `scripts/check-voseo` (29 archivos, se sumó
  `sidecar/resolve-auth-dir.mjs` a `OTROS`): en verde
- `npm run shots`: 328 capturas, **miradas** a 1440/768/390/320 px en claro y
  oscuro para los cuatro estados de vinculación — ver detalle en T4 arriba,
  incluido el defecto real encontrado y corregido (QR "vencido" por un `ts`
  estático en el guión de capturas, no en el panel)
- `npm run check` completo (orden canónico): todas las etapas en verde

**Pendiente de verificar** (requiere T5, teléfono real, decisión explícita del
usuario de no validar por terminal — ver T5 arriba): persistencia de sesión tras
reinicio de Orca, y reconexión tras suspender/despertar la máquina.

**Siguiente paso:** T5 — emparejar de verdad, desde el panel, con un teléfono
real. Después, el almacén de mensajes: es lo único que separa al plugin de volver a
leer.
