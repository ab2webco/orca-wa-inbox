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

- [ ] `activate()` lanza el sidecar con `process.execPath` +
      `ELECTRON_RUN_AS_NODE=1`, como ya hace `sembrarFuera` (`main.mjs:688-694`)
- [ ] Espejar estado y QR a `storage.set` con su `ts`
- [ ] El latido existente (`main.mjs:712-727`) no se toca
- [ ] Prueba: si el sidecar muere, el motivo llega al storage que lee el panel —
      el mismo camino de falla que `test/worker.test.mjs` ya cubre para el sync
- [ ] Ruta: **inline** si toca sólo `main.mjs`
- Commit: —

### T4 — Panel: dibujar el QR

- [ ] Incrustar el codificador (`qrcode-generator`, MIT, ~20 KB minificado)
      inline en `config.html` — la CSP prohíbe `<script src>`
- [ ] Dibujar en `<canvas>`, no `data:` URI: auditable módulo a módulo
- [ ] Escalar con el ancho: 260 px hasta 480, 300 hasta 1024, 360 por encima
- [ ] Estado vencido explícito: **no dibujar** un QR muerto
- [ ] Sondeo de 2 s mientras el QR vive, detenido al emparejar, respetando `CUPO`
- [ ] Prueba: `test/panels.test.mjs` cubre el descarte por vencimiento
- [ ] **Capturas con `npm run shots`** a 1440/768/390/320 en ambos temas, y
      mirarlas
- [ ] Ruta: **delegada**
- Commit: —

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

**Estado:** T1 y T2 cerradas con pruebas en verde. Sin commitear (working tree
para review, según instrucción explícita).

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

**Pendiente de verificar** (sin cambios, sigue igual que antes de esta
rebanada): persistencia de sesión tras reinicio y reconexión tras suspender —
requiere T3 (lanzar el sidecar desde el worker), T4 (dibujar el QR) y T5
(emparejar con un teléfono real).

**Siguiente paso:** T3 — worker: lanzar y supervisar el sidecar.
