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

### T10 — Desvincular la linea, y reintentar sin reiniciar Orca

El encargo §8.1 pide, con nombre: «estado de la conexion, QR cuando toca emparejar,
**boton de desvincular**». Los dos primeros estaban; el tercero no. Quien escaneaba
con el telefono equivocado quedaba atrapado: la unica salida era borrar un directorio
a mano. Y el auth state es una **credencial viva** (§11-F1) —quien la tenga lee y
escribe como esa cuenta sin el telefono—, asi que poder revocarla desde la pantalla no
es una comodidad, es el minimo.

- [x] **Canal panel → worker**, reconstruido con la forma que el repo ya tenia
      (`atenderPedido`/`veredicto` del transporte web que se quito en T6): el panel
      escribe `sidecarRequest` con `id` propio y `at`; el worker lo mira en el vigia de
      3 s que ya existia —sin timer nuevo— y contesta en `sidecarResult`, emparejado
      por `requestId`
- [x] **Ejecucion exactamente una vez**: memoria en RAM (`ultimoPedidoSidecar`) MAS el
      veredicto ya escrito, que es el que sobrevive a un reinicio del worker. El pedido
      se borra antes de actuar, y uno de otra sesion (TTL de 10 min) deja veredicto
      `vencido` en vez de callarse
- [x] **Desvincular**: apaga el sidecar por el camino de siempre (`detenidoPorWorker`,
      asi no se reporta como caida), limpia la clave `sidecar` ANTES de nada, borra el
      auth state en un hijo sin valla (`mandoSinValla`), y relanza
- [x] **Confirmacion en dos pasos** en el boton mismo —el panel no puede abrir un modal
      (`surface` es un enum cerrado y `window.open` esta anulado, §6)— con el aviso en
      `--destructive` diciendo que la sesion se termina y que hay que escanear de nuevo,
      y un «Cancelar» al lado
- [x] **Reintentar** para las fallas que un relanzamiento arregla
      (`sidecar-no-arranco`, `sidecar-authdir-fallo`, `sidecar-cayo`,
      `desvincular-fallo`). Un solo clic: no destruye nada
- [x] **Capturas con `npm run shots`** de los tres estados nuevos a 1440/768/390/320 en
      ambos temas — **miradas**
- [x] Ruta: **delegada** (6 archivos: `main.mjs`, `config.html`,
      `sidecar/resolve-auth-dir.mjs`, `test/worker.test.mjs`, `test/panels.test.mjs`,
      `test/shots.mjs` — disparo el trigger de escritura)
- Commit: — (instruccion explicita de no commitear)

**Decision 1 — el borrado vive en `resolve-auth-dir.mjs`, no en un guion hermano.** El
worker no puede borrar ahi: su valla declara `--allow-fs-read` sobre la raiz del plugin
y `--allow-fs-write` **no existe en todo orca-oss** (§1), asi que el borrado tiene que
ocurrir en un hijo sin valla. Se extendio el resolvedor con `--borrar` en vez de sumar
un hermano porque el hermano tendria que **duplicar la tabla de raices de userData** de
`harness.mjs`, y dos copias pueden discrepar. Discrepar sobre ESTA ruta significa borrar
la carpeta equivocada, o dejar viva la que el usuario creyo revocada — una credencial
viva que alguien cree muerta es peor que una que se sabe viva. Una sola implementacion,
una sola verdad sobre la ruta. Ademas `rmSync(..., { force: true })`: desvincular lo que
no estaba vinculado no es un error, es el resultado que el usuario pidio, ya cierto.

**Decision 2 — tras desvincular se RELANZA, no se queda apagado.** Desvincular existe
para volver a vincular: quien escaneo con el telefono equivocado quiere escanear con el
otro. Dejarlo apagado obliga a un segundo boton, y un estado que exige explicarle al
usuario que hacer a continuacion es un estado a medias. Relanzando, la pantalla vuelve
sola al unico estado que ya sabia dibujar: «Esperando el codigo QR», y despues el codigo.

**Decision 3 — si el borrado falla, NO se relanza.** Con las credenciales intactas el
sidecar volveria a conectar la MISMA sesion que el usuario acaba de pedir cortar, y el
panel diria «WhatsApp esta conectado» como si nada hubiera pasado. Por eso
`desvincular-fallo` es un codigo propio y no `sidecar-authdir-fallo`: lo que hay del
otro lado es distinto —la sesion **sigue viva**— y decirle al usuario cualquier otra
cosa lo deja creyendo que revoco algo que no revoco.

**Presupuesto del panel, la aritmetica.** `CUPO = {max: 30, ventanaMs: 10000,
reserva: 4}` deja 26 por 10 s para el sondeo. Lo que habia: ~4 de la base de 12 s
(5 claves) y ~5 del vigia dedicado del QR (1 clave cada 2 s). Lo que se suma: el sondeo
del veredicto, **1 clave cada 2 s = ~5 por 10 s**, y SOLO mientras hay un pedido en
vuelo (tope 30 s). Peor caso, que es reintentar desde una falla —ahi el vigia del QR
tambien corre—: 4 + 5 + 5 = **~14 de 26**. Desvincular es mas barato: se pide desde
`connected`, donde el vigia del QR esta apagado. El clic mismo va por `write()`, o sea
por el carril del usuario, con los 4 mensajes reservados y prioridad en la cola.

**Evidencia (TDD real, RED observado antes de implementar):**

- **Worker.** Con las pruebas nuevas y sin implementacion: **85/98**, con 13 fallas
  concretas — el veredicto nunca llegaba, el pedido quedaba sin borrar, las credenciales
  seguian en disco, el reintento no relanzaba (`antes=1 despues=1`), el pedido viejo no
  dejaba motivo, y el resolvedor contestaba `{"ok":true,"dir":...}` **sin `borrado`**
  ante `--borrar`. Con la implementacion: **98/98**.
- **Panel.** Sin implementacion corta en la primera asercion del bloque nuevo con
  `TypeError: Cannot read properties of null (reading 'click')` — el boton de
  desvincular no existia. Con la implementacion: **250/250** (29 pruebas nuevas).

**Tres defectos de las propias pruebas, encontrados mirando los FALLA.** El resolvedor
de mentira creaba el directorio en la llamada sin `--borrar`, con lo cual «se borro» era
inobservable despues del relanzamiento. El sidecar de mentira volvia a decir `open` al
instante, con lo cual «la conexion vieja no sigue en pie» no distinguia «se limpio y
reconecto» de «nunca se limpio». Y el tercero era **intermitente** —fallaba 2 de cada 3
corridas— porque leia la marca del hijo relanzado en el acto: el veredicto se escribe
cuando el worker ya hizo `spawn`, pero un Node recien nacido tarda un momento mas en
llegar a su primera linea, asi que medía la carrera y no el relanzamiento. Se espera al
hecho observable con `hasta()`, como el resto del archivo. Los tres eran dobles mal
hechos, no fallas del codigo.

### T11 — La palabra «sidecar» se le estaba mostrando al usuario

`sidecar` es como llamamos al proceso ayudante **entre nosotros**. Quien instala el
plugin no sabe que es, y estas eran justo las frases que lee cuando algo salio mal.

- [x] `pairingWaitingHow`, `pairingHowNoAuthDir`, `pairingHowNoStart` y
      `pairingHowCrashed` reescritas en **es/en/pt** para hablar de la conexion con
      WhatsApp y no de nuestra arquitectura de procesos
- [x] Los **codigos estables** (`sidecar-cayo`, `sidecar-no-arranco`,
      `sidecar-sin-permiso`, `sidecar-authdir-fallo`, `sidecar-sin-authdir`) quedaron
      intactos: son el contrato que el panel traduce, y renombrar uno desincroniza el
      panel en silencio (§11-E1). Solo cambio el texto
- [x] `sidecar` sigue —y debe seguir— en comentarios e identificadores, que es donde
      pertenece
- [x] Prueba que lo impide de nuevo: **ninguna cadena de `STRINGS.es/en/pt` nombra al
      sidecar**, barriendo las tres tablas enteras y no una lista a mano
- Commit: — (instruccion explicita de no commitear)

**Y de paso, «Reinicie Orca» se fue.** `pairingHowCrashed` y `pairingHowAuthDirFailed`
mandaban a reiniciar la aplicacion entera por un proceso hijo que el propio plugin sabe
relanzar. Ahora mandan al boton. `pairingHowLoggedOut` manda a desvincular, que es lo
que de verdad lo arregla: `sesion-cerrada` no reconecta nunca sola (`decidirTrasCierre`),
asi que las credenciales en disco estan muertas y hay que borrarlas. Los unicos que
siguen sin boton son `sidecar-sin-permiso` —lo arregla aprobar el plugin, no un
reintento— y `sidecar-sin-authdir`, que no lo arregla nadie desde el panel: un boton que
no puede funcionar promete una salida y devuelve al mismo lugar.

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

- [x] Esquema nuevo, con `(account, chat_jid, stanza_id)` como llave — el
      aislamiento entre líneas va en la llave, no en la intención (§11-F4).
      `sidecar/src/almacen.js`, tablas `linea` / `chat` / `mensaje` / `desalojo`
- [x] El sidecar escribe lo que recibe; `messages.update` cubre borrados y
      editados (§11-B4). `sidecar/src/mensajes.js` + `sidecar/src/ingesta.js`
- [x] `wa-read` pasa a ser capa de consulta sobre ese almacén, **conservando su
      contrato JSON** (`bin/wa_store.py` + `bin/wa-read`, 183 → 232 líneas)
- [x] Permisos `0600` —base, `-wal`, `-shm` y cada archivo de media— y tope de
      retención con desalojo visible en el panel, en `wa-read doctor` y en
      `wa-read state` (§11-F1, §11-F2)
- [x] `quotedParticipant` se mira en sus **tres** formas (`participant`,
      `participantPn`, `participantLid`) y comparando identidad CON su tipo, no
      sólo el número (§11-B1)
- [x] La lista de menciones se normaliza: cadenas y objetos, con el sufijo de
      dispositivo quitado (§11-B2)
- [x] Ruta: **delegada** para los dos mapeos (contrato JSON viejo, consumidores),
      escritura inline por etapas con verificación entre cada una
- Commit: — (instrucción explícita de no commitear)

**Dónde vive el almacén, y por qué.** `~/.wa-inbox/capture.db`, al lado de `scope.db`.
Tres razones, en orden de peso:

1. **No puede ir dentro del árbol del plugin**, que está verificado por content-hash
   (§7): un archivo que aparece después de instalar lo deja en «No válido».
2. **No va en `<userData>/plugins-data/<publisher>.<id>/`**, que es donde sí vive el
   auth state. Esa ruta sólo se resuelve preguntándole a Orca, en un subproceso, y
   puede no existir (`sin-userdata`). El auth state es una credencial *de Orca* y ahí
   pertenece; el almacén lo tienen que poder abrir `wa-read` y `wa-scope` corridos a
   mano, desde una terminal, con Orca cerrado.
3. **La autorización vive en `~/.wa-inbox/scope.db`** con la llave `(account, chat_jid)`.
   El almacén con `(account, chat_jid, stanza_id)` es esa misma llave más el mensaje.
   Que las dos bases estén en el mismo directorio y se respalden juntas no es comodidad:
   una sin la otra no significa nada.

Y el nombre no es nuevo: `bin/wa-scope:987` ya declaraba sus dos topes de retención
diciendo *«El almacén de cuerpos de mensajes (~/.wa-inbox/capture.db)»*, con
`capture_max`/`capture_days` ya validados por el panel. Esto ocupa el lugar que el
registro ya había reservado.

**Quién escribe, y quién no.** Sólo el sidecar, con `node:sqlite` —verificado en el
Node que trae Orca: `ELECTRON_RUN_AS_NODE=1 Orca -e ...` contesta **Electron 43.1.0,
Node 24.18.0**, y `require('node:sqlite')` resuelve—. El worker NO puede escribir ahí y
no lo intenta: su valla declara `--allow-fs-read` sobre la raíz del plugin y
`--allow-fs-write` no existe en todo orca-oss (§1). `wa-read` es Python, no hereda la
valla, y abre la base en `mode=ro` explícito.

**El corte de autorización ocurre ANTES de escribir**, no en la consulta. Un chat en
`off` no deja un cuerpo «que después no se muestra»: no deja cuerpo, y eso se ve
abriendo el archivo con un visor de sqlite. Lo que sí queda es que la conversación
existe —jid, nombre visible, hora— porque sin eso una conversación que nadie registró
no se puede ni ofrecer para autorizarla y la lista del panel nace vacía para siempre.
Es exactamente §11-F3: contenido y contabilidad se purgan distinto.

**El alcance no se reimplementa.** `sidecar/src/alcance.js` le pregunta a
`wa-scope list --json` —que es `merged_scope`, o sea la tabla del CLI cruzada con lo que
el usuario acaba de tocar en el panel— y cachea 30 s. Copiar ese cruce en JavaScript
habría sido tener dos verdades sobre quién está autorizado. Deniega por defecto y
también **mientras no haya podido cargar nunca**: un fallo de lectura no puede abrir
permisos, y una respuesta que no se pudo parsear no reemplaza el mapa anterior.

**La cuenta se llama `local`, y es a propósito.** `wa-scope set` escribe
`account='local'` cuando el usuario autoriza desde el panel (`bin/wa-scope:792`) y
`merged_scope` fuerza esa misma cuenta para las filas del panel (`:624`). Estrenar un
nombre nuevo habría dejado cada autorización existente apuntando a una línea que no
existe, y el síntoma sería una bandeja vacía sin un solo error. El env
`WA_SIDECAR_CUENTA` queda para el día que haya una segunda línea.

**Lo que se agregó al contrato JSON, todo aditivo:** `account` en las filas de `inbox` y
`chats`; `evicted`/`evictedAt`/`evictedFiles` en `state`; `--line` en los cinco comandos
de lectura; y el renglón `retention` en `doctor`. Nada se renombró ni se quitó.

**Evidencia (TDD real, RED observado ANTES de implementar, en tres vueltas):**

1. **Las rarezas de WhatsApp, como funciones puras.** `node test/sidecar-mensajes.test.mjs`
   sin `sidecar/src/mensajes.js` corta con
   `ERR_MODULE_NOT_FOUND: .../sidecar/src/mensajes.js`. Con la implementación:
   **72/72**. Cubre las dos formas de `mentionedJid` (cadenas y objetos wid), las tres
   de `participant` (`@lid`, `@c.us`, `@s.whatsapp.net`), el sufijo de dispositivo, la
   lista de exclusión cerrada con `@status`/`@lid.status` adentro, `messageTimestamp`
   como `Long`, y las dos formas de `messages.update`.
2. **Los seis casos de uso, contra el CLI de verdad.** `node test/almacen.test.mjs` sin
   `sidecar/src/almacen.js` corta con `ERR_MODULE_NOT_FOUND`; con el almacén pero con el
   `wa-read` viejo da **32/82**, con las 50 fallas todas del mismo lado —cada consulta
   contestaba `no-transport`— mientras las invariantes de almacenamiento (0600, el chat
   en `off` sin cuerpos, el aislamiento entre líneas, los conteos de desalojo) ya
   pasaban. Con la capa de consulta: **88/88**.
3. **El freno de los conteos.** `node test/sidecar-pairing.test.mjs` sin
   `tocaEmitirAlmacen` corta con
   `SyntaxError: The requested module '../sidecar/src/index.js' does not provide an
   export named 'ALMACEN_LATIDO_MS'`. Con la implementación: **31/31**.
4. **El worker.** Las dos pruebas nuevas, con `git stash push -- main.mjs`: **4 fallas**
   —`WA_SIDECAR_TOOLS_DIR` llegaba vacío y la clave `store` no existía en storage—.
   Con la implementación: **103/103**.

**Un cuarto defecto, visto releyendo el cableado y no por una prueba que fallara:** cada
mensaje `store` que sale por stdout termina en un `storage.set` del worker, y Orca mata
al worker a los 64 eventos sin confirmar en vuelo. Es el MISMO mecanismo que ya se llevo
puesto al worker una vez por lo hablador que es Baileys en stderr —y ahi el sintoma no
se parecia en nada a la causa: el panel se quedaba con un QR vencido para siempre porque
nadie llegaba a ver el final—. Una cuenta ocupada emite varios `messages.upsert` por
segundo durante la sincronizacion inicial. Los conteos salen ahora con freno de 30 s
(`tocaEmitirAlmacen`, pura y probada en `test/sidecar-pairing.test.mjs`, 26 → 31), y el
desalojo lo **fuerza**: es lo unico que no se puede perder.

**Tres defectos reales que encontraron las pruebas, no la lectura:**

- `lanzarSidecar` pasaba `TOOLS` (el `bin/` del plugin) en vez de `s.toolsDir`. Quien
  mueve el directorio de herramientas lo mueve entero, y con esto el sidecar le habría
  preguntado por el alcance a **otra instalación** (§11-E4). Lo delató la aserción de
  que el valor recibido fuera el mismo directorio que usa el resto del worker.
- El renglón de retención salía con `ok: True`, y `checkSystem` arma la lista de
  opcionales del panel con `requerido === false && !ok` (`main.mjs:88`): **un desalojo
  en verde no llega nunca a la pantalla**. «Visible» habría sido visible sólo corriendo
  el CLI a mano. Va con `ok: False` y `requerido: False`: se ve y no bloquea.
- `harness/EXAMPLES.md` documentaba el campo del autor como `"de"` cuando siempre fue
  `sender`, y pintaba `adjuntos_cerca` como una lista de rutas cuando es una lista de
  objetos. Un modelo siguiendo ese ejemplo habría leído `undefined` y reportado «sin
  adjunto» sobre un mensaje que traía uno. Corregido, con las dos formas dichas en voz
  alta.

**Dos chequeos nuevos que impiden que esto se rompa en silencio**
(`revisa_rutas_del_almacen` en `scripts/check-clis`, 134 → 140 comprobaciones):

- La ruta del almacén la resuelven DOS implementaciones —`rutaInbox()` en JavaScript y
  `inbox_dir()` en Python—. Discrepar no da un error: da un almacén que se llena y otro
  que se lee vacío, o sea una bandeja siempre tranquila sobre una cuenta que no para de
  escribir. Las dos se corren contra el MISMO entorno y se comparan. **Verificado no
  vacío**: cambiando `.wa-inbox` por `.wa-inbox-otro` en el lado JS, el chequeo falla
  nombrando las dos rutas.
- Los topes de retención arrancan en `DEFAULT_CONFIG` (wa-scope, que los guarda) y en
  `DEFAULTS` (wa_store, que los aplica sin registro). **Verificado no vacío**: bajando
  `capture_days` a 30 en un solo lado, el chequeo falla diciendo cuál es cuál.

**Evidencia visual (regla del proyecto), mirada:** captura nueva `config-leyendo` —línea
conectada, salud en verde y el aviso de desalojo— a **1440, 768, 390 y 320** en claro y
oscuro en español, y a 1440/320 en inglés. El renglón dice *«Retencion de mensajes — Se
borraron mensajes viejos para respetar el tope. Suba capture_max o capture_days si
necesita conservar mas»* en el panel en español y su equivalente en inglés, **sin una
palabra del CLI sin traducir**, sin desbordes a ningún ancho. Miradas también
`actividad` a 1440 claro y 390 oscuro con conversaciones presentes: mención, respuesta y
directo, cada uno con su remitente, su conversación, su hora y su insignia de adjunto.

**La cadena entera, recorrida a mano y con el HOME de mentira** (evidencia que no da
ninguna prueba unitaria, porque cruza cuatro procesos): con un mensaje fabricado en el
almacén y la conversación autorizada con `wa-scope set --mode observar`,
`wa-scope sync --json` contesta `{"synced": true}` y deja en el `storage.json` del
plugin —que es lo que lee el panel— `chats: [{jid, name: "Soporte Cliente Norte",
kind: "grupo", unread: 2, last}]` y `pending: [{stanzaId: "A1", chat, chatJid, sender:
"Laura", kind: "mencion", text, hasMedia, decision}]`, con `mapped: 1, authorized: 1`.
Y `wa-scope pending` sale **0** con `{"hay_trabajo": true, "detalle": "1 waiting, 0 in
progress"}`: las dos automatizaciones quedan desbloqueadas. Es el circuito completo
—almacén → `wa-read inbox` → `wa-scope sync` → panel → precheck— que estaba cortado.

**El chat en `off` no deja nada, verificado sobre el disco y no sobre una consulta:**
ingiriendo un mensaje con pie *«CONTRASENA-SUPER-SECRETA»*, una imagen y un remitente,
con el alcance en `off` para todo, `grep -r` sobre `~/.wa-inbox/` entero no encuentra ni
el cuerpo, ni los bytes del adjunto, ni el número del remitente. Quedan cero filas en
`mensaje`, ningún directorio de media, y **una** fila en `chat` con el jid y el nombre
visible — que es lo que hace falta para poder ofrecerla en el panel y autorizarla.

**Un modo de falla que se probó porque asustaba:** `wa-read` abre la base con
`mode=ro`, y una base en WAL cuyo escritor murió necesita recuperación, que escribe.
Medido en macOS: matando el escritor con `SIGKILL` con el WAL vivo, y otra vez
borrándole además el `-shm` (como tras reiniciar el equipo), `wa-read chats --json`
contesta correcto y sale 0 en los dos casos.

**Lo que NO está verificado, y hay que decirlo:** el cableado de los eventos de Baileys
—`messages.upsert`, `messages.update`, `chats.upsert`, `groupFetchAllParticipating`, y
la descarga de media con `downloadMediaMessage`— **no se ejercitó contra una cuenta
real**. Lo que se probó es el mapeo de un `WAMessage` a una fila y todo lo que sigue;
que el evento llegue con esa forma sale de la librería y de `process-message.js:195-251`,
no de una corrida. Esto necesita T5 (teléfono real), igual que la persistencia de sesión.

**Fuera de alcance, y queda pendiente:** registrar la línea en `wa_account` de
`scope.db` con `kind='baileys'` (§5 lo menciona; hoy `wa-scope accounts` no lista la
línea enlazada, y el almacén lleva su propia tabla `linea`). `wa-send` sigue negándose
con `send-no-transport`: enviar es otra rebanada.

### T12 — Defecto de actualización: el almacén de la vía vieja bloqueaba todo

Encontrado en la máquina del dueño, no en una prueba. En cualquier equipo que alguna
vez usó la vía de WhatsApp Web, `~/.wa-inbox/capture.db` **ya existe** con el esquema
de esa vía: `capturado` (su caché de cuerpos, tope 20000 / 90 días) y una `linea` de
dos columnas, sin `store_meta`. Medido ahí: `pragma user_version` = 0, `capturado` 0
filas, `linea` 2 filas (`web`, `web:262444127674377`, del 2026-09-19). El lector se
negaba con `store-schema` a **todo**: el plugin se instalaba, emparejaba y después no
contestaba nada.

Negarse estaba bien —contestar filas a medias es peor (§11-E5)—; lo que faltaba era
la salida. Y había un segundo defecto, más grave, que la prueba nueva destapó: al
abrir ese archivo, `abrirAlmacen` sellaba `schema_version = 1` mientras
`create table if not exists linea` dejaba intacta la tabla de dos columnas. El almacén
quedaba diciendo que estaba al día con la forma de ayer adentro, y `registrarLinea`
reventaba con `table linea has no column named lid`.

- [x] Detección de versión en el **escritor** (`sidecar/src/almacen.js`), no en
      `wa-read`, que abre en `mode=ro`
- [x] **Los cuerpos viejos se borran.** No es política nueva: §11-F3 ya dice que
      apagar la captura borra los cuerpos y conserva la contabilidad. Un cuerpo de
      `capturado` es texto de un cliente real en un esquema que este código no sabe
      leer; conservarlo sin poder servirlo es "un archivo de conversaciones ajenas que
      nadie borra" (§11-F2)
- [x] **Las líneas viejas también se van**, y eso sí es una decisión. `wa_store.abrir()`
      cuenta las filas de `linea` para decidir si hay línea enlazada: conservar dos
      cuentas `web*` —que nadie escribe ya y que ninguna autorización referencia
      (`chat_scope.account` es `local`)— dejaría el doctor en verde con "2 líneas
      enlazadas", el panel dejaría de pedir el QR y `wa-scope pending` soltaría al
      agente sobre una bandeja vacía para siempre. Una bandeja rota que se lee como una
      tranquila es lo único que §11-E5 prohíbe. Una fila de `linea` que **no** sea de la
      vía muerta sí se conserva con su `first_seen`
- [x] **Se dice en voz alta**, por el camino que ya usa la retención: tabla `migracion`
      en el almacén → `wa_store.ultima_migracion()` → renglón `store-migrated` del
      `doctor` con `ok: false, requerido: false` (el defecto conocido: `checkSystem`
      arma los opcionales con `requerido === false && !ok`, así que un renglón en verde
      no llega nunca a la pantalla) → `config.html` en es/en/pt. Y por `store` y stderr
      del sidecar, nunca por `error`: el panel lee `sidecar.error` como la causa de una
      sesión caída
- [x] **Atómica.** Migración + esquema + sello van en **una** transacción. Un corte a
      mitad deja el archivo como estaba y el lector negándose con `store-schema`
      (cerrado), nunca contestando datos incompletos. El sello va en `store_meta` **y**
      en `pragma user_version`, que es lo que contesta un `sqlite3` a mano — que es
      justo como se diagnosticó esto
- [x] Ruta: **inline** (escritor + lector + panel + pruebas; disparador de escritor por
      2+ archivos no triviales, atendido en un solo hilo por ser un cambio único)
- Commit: — (sin commitear, según instrucción explícita)

**Evidencia:**

- `node test/almacen.test.mjs`: **127/127** (eran 88; +39 de la migración)
- `node test/panels.test.mjs`: **267/267** (eran 260; +7)
- `node test/worker.test.mjs`: **104/104** (eran 103; +1)
- `node test/sidecar-mensajes.test.mjs` 72/72 · `sidecar-pairing` 31/31 ·
  `sidecar-build` 5/5 · `manifest` 2/2
- `scripts/check-clis` 8 CLI / 140 comprobaciones · `scripts/check-voseo` 34 archivos ·
  `scripts/check-panels` ok · `check-prompts` · `check-harness` · `check-closing` 36/36
- `npm run check` completo: **exit 0**
- `npm run shots`: 264 capturas; `config-almacen-migrado` **mirada** a 1440/768/390/320
  en claro y oscuro, es y en — sin desbordes, sin inglés colado en el panel en español
- **Sobre el archivo real del dueño:** migró a v1, `pragma user_version` 1, `capturado`
  ya no está, 2 líneas `web*` retiradas y anotadas en `migracion`. Los tres comandos
  pasaron de `store-schema` (callejón sin salida) a `no-transport` (escanee el QR), que
  es la negativa correcta hasta que el sidecar de T8 conecte y registre `local`. Sobre
  una **copia** de ese mismo archivo con la línea ya registrada: `chats` y `inbox`
  contestan `[]` con salida 0

---

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

**Estado:** T1, T2, T3, T4, T6, T7, T8, T10, T11 y T12 cerradas con pruebas en verde y
evidencia visual mirada. T5 sigue pendiente: requiere un teléfono real y el panel de
ajustes, y ahora además valida la ingesta real de T8. T9 sin empezar. Sin commitear
(working tree para review, según instrucción explícita).

**Lo que quedó de T6, en números:** `web-lines.mjs` y `docs/LECTURA-MULTIFUENTE.md`
borrados; `bin/wa-read` 2.212 → 197, `bin/wa-send` 724 → 122, `main.mjs` 1.249 → 807,
`config.html` 3.201 → 2.014, `scripts/check-clis` 3.510 → 876, `test/worker.test.mjs`
1.477 → 761, `test/panels.test.mjs` 2.177 → 1.451, `test/shots.mjs` 856 → 546.

**Advertencia honesta, actualizada por T8:** el plugin ya lee, pero **sólo con una línea
enlazada**. Sin ella, `health.ok` es `false` con `no-transport`, `wa-scope pending`
bloquea las dos automatizaciones con ese mismo código y la lista de conversaciones del
panel queda vacía. Con la línea enlazada, los seis comandos contestan con código 0 y una
lista vacía significa que de verdad no hubo nada. Las dos respuestas son distintas a
propósito (§11-E5) y las dos están cubiertas: la negativa en `scripts/check-clis`, la
afirmativa en `test/almacen.test.mjs`.

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

**Siguiente paso:** T5 — emparejar de verdad, desde el panel, con un teléfono real, que
ahora vale por dos: verifica la persistencia de la sesión **y** la ingesta real de T8,
que es lo único de esta rebanada que no se puede probar sin una cuenta. Después, T9.
