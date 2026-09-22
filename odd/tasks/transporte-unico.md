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
- Commit: pendiente de review — sin commitear (instrucción explícita del pedido)

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
- Commit: pendiente de review — sin commitear (instrucción explícita del pedido)

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
- Commit: pendiente de review — sin commitear (instrucción explícita del pedido)

**Diseño:** el directorio de auth (`<userData>/plugins-data/<publisher>.<id>/wa-auth/`)
se resuelve en un subproceso (`sidecar/resolve-auth-dir.mjs`, mismo patrón que
`sembrarFuera`) porque el worker no puede leer el userData de Orca. `lanzarSidecar()`
(exportada de `main.mjs`) hace `spawn()` del sidecar, parsea su protocolo JSON-lines
y lo espeja a `storage.sidecar`, con códigos estables propios (`sidecar-sin-authdir`,
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
- Commit: —

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

**Estado:** T1, T2, T3 y T4 cerradas con pruebas en verde y evidencia visual mirada.
Sin commitear (working tree para review, según instrucción explícita — T3/T4 tampoco
se commitearon, instrucción explícita de este pedido).

**Evidencia de esta rebanada:**

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

**Siguiente paso:** T5 — emparejar de verdad, desde el panel, con un teléfono real.
