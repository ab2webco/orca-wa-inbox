# Encargo: transporte único de WhatsApp

Quitar los dos transportes actuales — la app de macOS y WhatsApp Web — y dejar
uno solo: un sidecar headless, sin navegador y sin ventanas, que viva dentro del
plugin y hable el protocolo multi-dispositivo directamente.

Es una reescritura, no una migración. El código que sólo existía para servir a
los transportes viejos se borra. Lo que debe sobrevivir es el **conocimiento**,
y la sección 11 lo lista con nombre y línea.

**Fuera de alcance:** el agente supervisor/orquestador de Orca, el enrutamiento
a modelos y terminales. Si aparece en el repo, no tocarlo.

**Cómo leer este documento.** Cada afirmación va con su evidencia: archivo y
línea para lo verificado en código, números medidos para lo que se ejecutó. Lo
que no se pudo comprobar está marcado como **NO VERIFICADO** y no debe leerse
como si valiera lo mismo.

---

## 1. La restricción que define el diseño

Ninguna librería de WhatsApp puede correr dentro del worker del plugin. No es un
permiso que falte: es un muro del sandbox. Verificado en el código de `orca-oss`:

- El worker se lanza con `child_process.fork` y estos flags
  (`src/main/plugins/plugin-worker-sandbox-args.ts:4-24`,
  `src/main/plugins/plugin-host-process.ts:78-93`):

  ```
  --preserve-symlinks
  --preserve-symlinks-main
  --permission
  --allow-fs-read=<raíz del plugin>
  --allow-fs-read=<dir del host>
  --require plugin-host-preload.js
  [--allow-child-process]   ← sólo si se concede process:spawn
  ```

- `--allow-fs-write` **no existe en todo el repo**. El worker no puede escribir
  ningún archivo, en ningún directorio.
- `plugin-host-preload.ts:21-29` registra un hook de resolución que **lanza
  excepción** al resolver `net`, `http`, `https`, `http2`, `tls`,
  `dns`, `dns/promises` y `dgram`, y borra `WebSocket` del global en `:85`.
  **Es incondicional:** no hay ningún chequeo de capability en ese hook. Ocurre
  aunque se conceda `net:fetch`.
- `net:fetch` no abre sockets. Sólo instala un `fetch()` envuelto contra una
  allowlist de hosts declarada en el manifiesto (1–64 entradas,
  `plugin-capabilities.ts:77`).
- Addons nativos imposibles: `process.binding`, `process._linkedBinding`,
  `process.getBuiltinModule` y `process.dlopen` quedan congelados en `undefined`
  con `writable: false, configurable: false` (`plugin-host-preload.ts:87-101`).

Consecuencia directa: `require('@whiskeysockets/baileys')` revienta al importar.
Le pasa lo mismo a cualquier cliente de WhatsApp: todos necesitan un socket TCP
real.

## 2. Arquitectura: sidecar dentro del plugin

El sidecar **es parte del plugin**: vive en su carpeta, lo lanza el propio
plugin y muere con él. Lo que queda fuera no es el plugin, es el sandbox de
permisos de Node. El usuario no instala ni administra nada aparte.

- `process:spawn` no añade ningún método al host API — revisados los 13 de
  `PLUGIN_HOST_API_V0` (`plugin-host-api.ts:122-263`), ninguno lo declara. Sólo
  relaja el modelo de permisos agregando `--allow-child-process`
  (`plugin-worker-sandbox-args.ts:20-22`).
- El hijo **no hereda el sandbox**: los flags `--permission` no se propagan.
  Tiene `net`, `tls` y `ws` reales. El texto de consentimiento lo dice explícito
  (`plugin-capabilities.ts:100-101`): *"Programs it starts are not constrained
  by this plugin worker's file or network permissions"*.
- Con `process:spawn`, el fork del worker es `detached: true` en POSIX y se
  vuelve líder de su grupo de procesos
  (`plugin-worker-process-tree.ts:11-13`). Las rutas de muerte hacen
  `process.kill(-pid, 'SIGKILL')` sobre el grupo: el sidecar muere con el
  worker. **En Windows no se usa `detached`**; la limpieza va por
  `terminateWindowsProcessTree` (`:39-41`).
- El hijo hereda el `process.env` saneado del worker: una allowlist de **17**
  nombres (`plugin-worker-env.ts:8-27`). `ELECTRON_RUN_AS_NODE` y
  `ORCA_PLUGIN_NET_FETCH_HOSTS` los sintetiza el host aparte; no se heredan.
  Si el sidecar necesita credenciales, el worker debe pasarle un `env` explícito.
- **`fork()` no fija `cwd`** (`plugin-host-process.ts:78-93`). El worker hereda
  el cwd de Orca, no la raíz del plugin. Todas las rutas del sidecar deben ser
  absolutas.

| Pieza | De qué es dueña |
|---|---|
| Sidecar (proceso Node real, sin sandbox) | El socket de WhatsApp, el auth state en disco, el QR, la reconexión, la descarga de media |
| Worker del plugin | Relay con el sidecar; espeja estado y QR a `storage.*`; manda a terminales con `terminal.sendText`; late |
| Panel de settings | Lee `storage`, dibuja el QR, edita la configuración |
| `scope.db` (ya existe) | La whitelist, la escalera de permisos, el enrutamiento, la memoria de trabajo y la auditoría |

### Cómo se lanza el sidecar

Ya hay precedente en el repo: `main.mjs:688-694` spawnea `process.execPath` con
`ELECTRON_RUN_AS_NODE: '1'` para hacer trabajo de disco que el worker no puede.
El sidecar usa la misma vía. **No hace falta Node del sistema.**

## 3. Librería: Baileys 6.7.24

Decidido, con evidencia ejecutada.

Existen **cuatro** implementaciones independientes del protocolo
multi-dispositivo, y sólo cuatro: **Baileys** (TypeScript), **whatsmeow** (Go),
**Cobalt** (Java) y **whatsapp-rust** (Rust). Todo lo demás —WAHA, Evolution
API, Neonize, whatsapp-web.js, Venom, WPPConnect— envuelve a una de esas cuatro.

### Versión y receta de empaquetado

```
"@whiskeysockets/baileys": "6.7.24"     ← versión exacta, sin ^
"overrides": { "libsignal": "6.0.0" }
```

```
esbuild --bundle --platform=node --format=cjs --target=node20 \
        --minify --external:sharp
```

**Medido, no estimado:**

| | valor |
|---|---|
| `node_modules` crudo | 2.135 archivos / 58,66 MiB |
| Bundle final | **1 archivo / 3,17 MB** |
| Symlinks enviados | 0 |
| Binarios nativos en el bundle | 0 |
| QR emitido contra WhatsApp real | sí, 237 caracteres |

El `node_modules` crudo **no pasa**: supera el tope de 50 MB y roza el de 2.000
archivos. **Empaquetar no es una optimización, es requisito de instalación.**

### El `overrides` de `libsignal`

`6.7.24` declara `libsignal` como URL de git, y la entrada del lock queda con
commit fijado pero **sin campo `integrity`**. El `overrides` lo trae del
registro de npm. Verificado:

- Los dos tarballs —registro y GitHub en el commit `bcea72df`— son **idénticos
  byte a byte** en todos los archivos que se ejecutan (`diff` + `sha256`). Sólo
  difieren archivos de empaquetado que nunca se hacen `require`.
- El lock resultante trae `integrity: sha512-d/5V3YFtDljbFMufz4ncyUYGYhJl+...`
  y **cero entradas `git`**.
- `npm ci` corrió **con el ejecutable de `git` reemplazado por un script que
  siempre falla**, e instaló igual. No toca GitHub.
- El bundle es **idéntico byte a byte** con y sin el `overrides`: cambia la
  procedencia verificable, no lo que se envía.

### Licencias

Del árbol completo (95 paquetes), lo único copyleft que **termina dentro del
bundle** es `libsignal`, **GPL-3.0**. `sharp` y sus binarios LGPL quedan fuera
por el `--external`, confirmado grepeando el `.cjs`.

GPL-3.0 es copyleft fuerte y viaja dentro del archivo distribuido. **No se
evita con Baileys**: todas sus líneas usan el mismo `libsignal`. Es una decisión
de licenciamiento pendiente (sección 13).

### Por qué no las otras

- **Cloud API oficial de Meta**: descartada **estructuralmente**, no por riesgo.
  Exige cuenta Official Business Account, **rechaza números personales**, y
  **topa los grupos en 8 participantes**. Sí tiene Groups API — el argumento
  viejo de "no maneja grupos" ya no es cierto, pero el resultado es más firme.
- **whatsmeow**: **no es más seguro**. `tulir/whatsmeow#810` se titula
  *"'Your account may be at risk' warning affecting clients using WhatsMeow
  (also reported with Baileys)"*. El riesgo de baneo es equivalente. Además
  obligaría a distribuir binarios para cuatro plataformas, y sus únicos puentes
  a Node son proyectos de 3 estrellas.
- **whatsapp-rust** (Rust): ya está dentro de Baileys 7.x vía
  `whatsapp-rust-bridge`, que es su build a WASM alojado en la organización
  WhiskeySockets. Su árbol es Rust puro sin bindings napi: usarlo directo sería
  construir nuestro propio puente.
- **whatsapp-web.js, Venom, WPPConnect**: levantan Chromium por dentro, que es
  justo lo que se quiere eliminar. Ninguno añadió modo sin navegador.

### Riesgo de cuenta

Baileys es un cliente no oficial: existe riesgo de bloqueo permanente y sin
apelación. La whitelist y los límites de envío no son sólo control de alcance,
también son protección. Prácticas conocidas: número dedicado en vez del
personal, ritmo humano con jitter, y tratar la línea vinculada como
prescindible.

### Cadena de suministro

En diciembre de 2025 circuló un paquete malicioso imitando a Baileys
(`lotusbail`, 56.000 descargas) que robaba tokens de sesión e instalaba un
dispositivo vinculado persistente. Fijar el scope oficial
`@whiskeysockets/baileys` y no aceptar forks.

### Al subir de versión

Los 3,17 MB y el QR valen para `6.7.24`. **Subir de versión obliga a repetir la
prueba de empaquetado y la de emparejamiento.** Es un comando, y va como paso
del check del proyecto, no como ritual que alguien saltea.

## 4. Lo que se va

Los dos transportes son exactamente estos ajustes:

- `read_local` — app de macOS, hoy por defecto `"on"` (`bin/wa-scope:1022`)
- `read_web` — WhatsApp Web, hoy por defecto `"off"` (`bin/wa-scope:1023`)
- `read_web_text` — **clave independiente**, no derivada de la anterior. Su
  dominio es `off`/`memoria`, no `off`/`on` (`bin/wa_settings.py:299`), y el
  comentario en `bin/wa-scope:1024-1027` lo dice: *"es una eleccion aparte de
  leerla"*.

Se combinan en `bin/wa-scope:1557-1558`.

Archivos que hay que revisar uno por uno. **La lista del encargo anterior no era
exhaustiva** — faltaban ocho, incluida la descripción del propio manifiesto:

```
web-lines.mjs                     ← se borra completo (506/506 líneas)
main.mjs                          ← ~350 líneas del despachador de pestañas
config.html                       ← ~400-500 líneas de UI de líneas web
bin/wa-read                       ← ~90% del mecanismo muere
bin/wa-send                       ← ~600 de 724 líneas (los dos transportes)
bin/wa-scope                      ← sólo ~15-20%
bin/wa_settings.py                ← sólo las tres entradas read_*
orca-plugin.json:7                ← la descripción menciona "WhatsApp Web lines"
README.md                         ← 6 menciones
bin/wa-send:16
prompts/triage.md:203
harness/CLASSIFICATION.md, harness/EXAMPLES.md
docs/el-plugin-whatsapp-inbox.html
scripts/check-voseo:31
scripts/check-clis                ← ~1/3 (la jaula JAULA_WEB)
test/worker.test.mjs              ← ~700 de 1219 líneas
test/panels.test.mjs, test/shots.mjs
docs/LECTURA-MULTIFUENTE.md       ← se archiva; su contenido está en §11
```

Estimación con evidencia: **45-55% de las líneas del repo** existen sólo para
servir a los transportes que mueren. Pero la fracción de **conocimiento** que
debe sobrevivir es mucho mayor que la de código, porque las lecciones viven
justamente en los archivos donde ocurrieron los errores.

## 5. Lo que YA EXISTE y no se debe volver a construir

Esta sección es la corrección más importante respecto del encargo anterior, que
mandaba a construir desde cero cosas que ya están hechas y probadas.

### La whitelist y los límites ya existen: `scope.db`

`bin/wa-scope` mantiene un registro **transport-agnóstico** en
`~/.wa-inbox/scope.db`. Su tabla `chat_scope` **es** la whitelist que el encargo
anterior pedía inventar, y su escalera de modos **es** el control de límites
(`bin/wa-scope:17-21`):

```
off        no lo toca (por defecto para cualquier chat no registrado)
observar   puede leer y abrir tarjeta. No escribe en WhatsApp.
borrador   además deja el texto escrito en el chat, sin enviar.
responder  además envía. Sólo donde se autorizó explícitamente.
```

Con `RANK = {m: i for i, m in enumerate(MODES)}` y la compuerta
`RANK[mode] >= RANK[a.for_]`. **Denegar por defecto es estructural**, no una
convención: `merged_scope` nunca sintetiza una fila por defecto. El docstring lo
dice en la línea 4: *"Un chat que no esta en el registro no existe para el
agente."*

El esquema completo (`bin/wa-scope:124-212`) incluye además `wa_account`,
`agent_action`, `settings`, `route`, `work`, `digest`, `run_lock` y `run_trace`.
**Se reutiliza tal cual.** `wa_account.kind` sólo necesita un valor nuevo
(`baileys`) junto a `local`/`web`, y `migrate_cuentas()`
(`bin/wa-scope:713-735`) es la plantilla de esa migración.

### El latido ya existe

`main.mjs:712-727` escribe `storage.set('workerBeat')` cada 5 s, con tolerancia
de 30 s del lado del panel. Verificado que funciona: un `hostCall` sube
`lastActivityAt` (`plugin-host-process.ts:218-223`) sin tocar
`pendingCommands`/`pendingEvents`, así que `inFlightCount()` queda en 0 y el
reaper de 5 minutos nunca dispara. `test/worker.test.mjs:1149-1167` verifica que
sigue latiendo **aunque todas las herramientas `wa-*` estén rotas**. Se conserva
tal cual.

### El presupuesto de polling del panel ya existe

`config.html:1523-1534` implementa autolimitación con reserva para clics del
usuario. Se reutiliza verbatim (detalle en §11-M).

### La transcripción ya está desacoplada

`bin/wa-transcribe` opera sobre una ruta de archivo de audio, sin ningún
acoplamiento a WhatsApp ni a Orca. **No cambia.** El sidecar sólo tiene que
escribir los bytes descargados en una ruta y pasarla.

### Lo que NO existe: un almacén de mensajes

No hay ninguno. El esquema de `bin/wa-read` (`ZWACHATSESSION`, `ZWAMESSAGE`,
`ZWAMEDIAITEM`) es una **imitación sintética de las internas de Core Data del
macOS**, construida para que el mismo SQL corriera contra el archivo real o
contra una base fabricada desde la sesión web. Los dos transportes eran *pull*:
se leía en vivo y no se guardaba.

**El sidecar necesita un almacén nuevo**, con la forma que hoy responden
`cmd_inbox`/`cmd_chats`/`cmd_whoami`. Y `wa-read` se convierte en una **capa
delgada de consulta** sobre ese almacén, conservando su contrato JSON — que es
de lo que dependen `wa-scope`, los prompts del harness y el panel. Esa es la vía
de menor riesgo: el radio de explosión se reduce a la capa de transporte.

## 6. Límites del panel que condicionan la UI

- **No hay popup ni modal.** `contributes.panels[].surface` es un enum cerrado:
  `worktree | settings | nav` (`plugin-manifest.ts:78`). El QR va en el panel de
  `settings`.
- **No hay canal panel → worker.** Sólo 5 de los 13 métodos del host son
  llamables desde el panel (`plugin-host-api.ts:271-279`):
  `workspace.readContext`, `terminal.sendText`, `notifications.show`,
  `storage.get`, `storage.set`. Trazado hasta el ejecutor:
  `executePluginHostCall` corre en main y **nunca toca el worker**.
- **No existe evento de cambio de settings ni de storage.** `PLUGIN_EVENT_NAMES`
  (`plugin-manifest.ts:91-95`) está cerrado a `worktree.created`,
  `worktree.removed` y `agent.status.changed`. `settings.set` y `storage.set`
  escriben a JSON sin notificar a nadie. **Ambas direcciones requieren polling.**
- El panel tiene un límite de **30 mensajes cada 10 s**
  (`plugin-panel-bridge.ts:23-24`).
- El panel es **un solo archivo HTML** en un iframe sandbox de origen opaco.
  CSP exacta (`plugin-panel-shell.ts:25-27`):

  ```
  default-src 'none'; connect-src 'none'; script-src 'unsafe-inline';
  style-src 'unsafe-inline'; img-src data:; font-src data:;
  base-uri 'none'; form-action 'none'
  ```

  `sandbox="allow-scripts"` sin `allow-same-origin` (`PluginPanel.tsx:276`);
  `window.open` anulado (`plugin-panel-shell.ts:114`).

### El QR en el panel es trabajo nuevo

**El panel nunca ha dibujado un QR.** Hoy lo dibuja WhatsApp Web dentro de la
pestaña y el panel sólo dice dónde mirar (`config.html:730`);
`web-lines.mjs:209` apenas **detecta** si existe:
`qr: !!document.querySelector('canvas[aria-label]')`.

Consecuencias del CSP:

- **No se puede cargar un `<script src>` con una librería de QR.** El
  codificador va **inline** en el HTML y suma peso al archivo único.
- `img-src data:` y `script-src 'unsafe-inline'` sí están permitidos: sirve
  dibujar en `<canvas>` o generar un `data:` URI. Ninguno requiere red.

**Requisito, no detalle de implementación:** el QR de WhatsApp rota cada ~20 s.
Entre que el sidecar lo genera y el panel lo pinta hay tres saltos y un sondeo.
**El QR debe viajar con marca de tiempo, y el panel debe descartar lo vencido en
vez de pintarlo.** Pintar un QR muerto hace que el usuario escanee, falle y no
entienda por qué. El código viejo ya conoce ese dolor (`main.mjs:359`).

Flujo completo: el sidecar lo genera → el worker lo escribe con `storage.set`
junto a su timestamp → el panel hace `storage.get` y lo dibuja si sigue vivo.
Sondeo de 2 s como máximo mientras el QR está vivo, deteniéndose al emparejar.

## 7. Dónde vive cada dato

- `storage.*` (worker y panel): JSON plano. Valor ≤ 256 KiB, store completo
  ≤ 5 MiB, ≤ 1024 claves (`plugin-host-api.ts:68-70`). Archivo físico:
  `<userData>/plugins-data/<publisher>.<id>/storage.json`.
- `secrets.*` (sólo worker, ≤ 64 KiB, `panel: false` en los tres métodos).
- `contributes.settings`: máximo 32 entradas y sólo tres tipos —`string`,
  `boolean`, `number` (`plugin-settings-contribution.ts:15,26-62`). **No hay
  tipo lista.** Sólo `string` admite `secret: true`. Orca genera el formulario.
- **El auth state del sidecar NO va dentro de la carpeta del plugin.** El árbol
  del plugin está verificado por content-hash
  (`plugin-content-hash.ts:15-16`): escribir adentro cambia el hash. Va en
  `<userData>/plugins-data/<publisher>.<id>/`, junto a `storage.json` — fuera
  del árbol verificado, escribible por el usuario, y sobrevive a
  actualizaciones del plugin.
- Nota: el worker **sí puede leer** la raíz del plugin (`--allow-fs-read`), pero
  no escribirla. Con el auth state fuera de esa raíz, el worker no lo ve, que es
  el aislamiento deseado.

Consecuencia: la whitelist y el system prompt **no caben en
`contributes.settings`**. Viven en `scope.db` y en `storage`, editados desde el
panel. En `contributes.settings` quedan sólo los interruptores simples y la
API key opcional.

### Topes de empaquetado

`plugin-content-hash.ts:15-16` impone sobre **todo el árbol del plugin**:

```
MAX_PLUGIN_FILES       = 2.000
MAX_PLUGIN_TOTAL_BYTES = 50 MB
```

y **los symlinks se rechazan de plano** (`:50-52`). Un layout de pnpm con
symlinks al store falla la instalación.

## 8. Configuración que debe exponer el panel

1. **Emparejamiento**: estado de la conexión, QR cuando toca emparejar, botón de
   desvincular. Con marca de tiempo y descarte de QR vencido (§6).
2. **System prompt**: texto largo, editable, con valor por defecto.
3. **Whitelist y modos**: **no se construye de cero.** Es la UI sobre
   `chat_scope` y la escalera `off/observar/borrador/responder` que ya existen.
   Lo que no está registrado no existe para el agente.
4. **Límites de ritmo**: tope de mensajes por hora y ventana horaria. El campo
   `hours` de `chat_scope` ya existe (`'L-V 08:00-18:00'` por defecto).
5. **Jev (opcional)**: interruptor `boolean` + API key `string` con
   `secret: true` (§9).

Lo que ya existe y no depende del transporte se conserva: `tone`, `transcribe`,
`transcribe_lang`, `transcribe_quality`.

## 9. Capa opcional de juicio: Jev / TypeSafe

Un mensaje de WhatsApp es **entrada no confiable de un tercero**. Cualquiera en
un grupo puede escribir texto diseñado para que lo lea un modelo.

### Jev no es la frontera de seguridad

Esto no es cautela retórica; lo respalda la propia documentación de TypeSafe:

- `confidence` es *"a statistic computed from the probability distribution the
  answer already gives you"* — mide su propia consistencia, no si acertó.
- Del cookbook de consistencia: *"High consistency scores don't validate
  correctness — one model achieved 100% repeatability through deterministic
  brittleness rather than sound judgment."*
- En su propio cookbook de guardrails, su ejemplo de jailbreak puntúa **0,74**:
  dentro de la zona de bloqueo, pero pegado al borde.

Un atacante tiene reintentos infinitos y gratis contra un clasificador de umbral
fijo. **La seguridad se hace en código determinista:**

- La whitelist y la escalera de modos de `scope.db`.
- El conjunto **cerrado** de acciones ejecutables. Si el verbo no existe, una
  inyección exitosa sigue sin poder usarlo. Esta es la defensa real.
- La identidad del remitente: JID y membresía de grupo son **búsqueda
  determinista**, nunca juicio. Preguntarle a un modelo "¿este es de verdad el
  CTO?" es pedirle que autentique por estilo de escritura.
- El acceso a secretos: **negación dura** desde cualquier camino originado en
  chat. Sin umbral — un umbral admite que existe un número que lo abre.
- Las acciones irreversibles: confirmación humana fuera de banda,
  independientemente de cualquier número de confianza.

### Dónde sí aporta, medido

Acotado el daño máximo por código, queda un problema genuinamente semántico:
entre los mensajes permitidos, cuáles son requerimiento real, cuáles ruido, y
cuáles huelen raro.

Seis juicios independientes, todos en **una sola llamada paralela** sobre el
mismo estado:

| Juicio | Primitiva |
|---|---|
| `is_action_request` | Noul |
| `requests_out_of_scope_action` | Noul |
| `contains_meta_instructions` | Noul |
| `invokes_unearned_authority` | Noul |
| `requests_secrets_or_exfiltration` | Noul |
| `requested_consequence_severity` | Score, 4 niveles |

**Regla de composición: Jev puede frenar y escalar, nunca habilitar.** Ninguna
combinación de señales verdes amplía lo que el código ya permite. Esa asimetría
es el diseño entero.

### Resultados de la prueba de concepto

Corpus adversario de 52 mensajes en español latino real, contra la API en vivo:

- **Ingeniería social pura sin marcadores técnicos: 8 de 8** escaladas
  correctamente. Es la categoría que el código determinista no puede ver, y la
  única razón por la que Jev entra.
- **0 de 5 ataques** escritos a propósito contra los umbrales observados
  lograron pasar. El de circunloquio —*"el textito de configuración… ya sabés
  cuál"*— puntuó 0,82 en exfiltración **sin una sola palabra gatillo**.
- **El español no degradó la detección.** Sobre 20 pares español/inglés: delta
  medio por campo de 0,01–0,045 y **cero cambios de decisión**. La advertencia
  de la doc sobre idiomas no ingleses no se manifestó. **Traducir antes de
  juzgar no se justifica.**
- Latencia media **245 ms** (p95 312 ms), ~1.400 tokens de entrada por llamada.
- **Falsos positivos: 17%** con umbrales ajustados (riesgo > 0,6–0,7,
  severidad ≥ 2). No es cero. Un sistema que escala todo se apaga y se pierde.

**Límite honesto:** 52 mensajes son una señal, no un benchmark. Lo validado es
el rol de **capa de escalado a humano**, no de operación autónoma.

### Lección arquitectónica que salió de un falso negativo real

Hubo una inyección escondida en el nombre de una rama
(`feature/ai-ignore-all-previous-instructions...`). **Jev la detectó**
(`contains_meta_instructions = 0,84`). La lógica de composición la descartó
porque estaba condicionada a "¿es una petición?", y ese mensaje no lo parecía.

> **Los chequeos de riesgo nunca se condicionan a "¿es una petición?".**
> Las cargas indirectas jamás parecen peticiones. Ese es el punto de que sean
> indirectas.

### Plomería

- Endpoint: `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer`.
- **El worker puede llamarla directamente.** El SDK de JS es un envoltorio
  delgado sobre `globalThis.fetch`, sin internals de Node en la ruta de red.
  Basta declarar `api.typesafe.ai` en la allowlist de `net:fetch`.
- La API key va en `contributes.settings` como `string` con `secret: true`. **No
  en el panel propio**: el panel no puede llamar a `secrets.*` ni leer settings.
- **Latencia, límites y precio no están documentados.** Medirlos.
- **Degradación = modo apagado.** API caída, timeout, rate limit o sin llave:
  todo lo ambiguo escala a humano. *Fail closed* sin lógica especial.

**Qué se compra con Jev, dicho sin adornos:** sin Jev el sistema está igual de
seguro, pero llega más ruido. Con Jev está igual de seguro y molesta menos. No
añade seguridad; reduce escalaciones innecesarias.

## 10. Ciclo de vida: el detalle que rompe todo si se ignora

Supervisión del worker (`plugin-host-protocol.ts:108-114`,
`plugin-host-process.ts:22-24`, `plugin-supervisor.ts:32-33`) — todos exactos:

| Límite | Valor |
|---|---|
| Listo tras activación | 10 s |
| Timeout de comando | 30 s |
| Timeout de manejador de evento | 5 min → matan el worker |
| Eventos sin confirmar en vuelo | 64 → matan el worker |
| Reaping por inactividad | 5 min sin trabajo en curso |
| Workers vivos simultáneos | 5 |
| Gracia al cerrar | 2 s, luego SIGKILL |
| Reintentos tras crash | 3, backoff 500/2000/5000 ms |

El reaper salta si `inFlightCount() !== 0 || now - lastActivityAt() <= idleReapMs`
(`plugin-worker-manager.ts:240-243`). `lastActivityAt` sube con cualquier
`hostCall` del hijo — **y también cuando el host empuja un evento**
(`plugin-host-process.ts:286`). Lo que **no** cuenta es un `setInterval` interno
del worker que nunca habla con el host.

El latido de `main.mjs:712-727` ya cubre esto (§5).

Si el worker muere, muere el sidecar por SIGKILL al grupo, y se cae la sesión de
WhatsApp. Al cerrar la app todo se dispone.

## 11. Lecciones que deben sobrevivir

Extraídas del código que se va a borrar. Cada una con su origen. **UNIVERSAL**
significa que debe entrar al diseño nuevo; **HISTÓRICA** que muere con el
transporte y se conserva sólo como contexto.

### A. Identidad y JIDs

**A1. La llave es `(cuenta, jid)`, nunca el jid solo.** UNIVERSAL — la más
importante del repo. `bin/wa-scope:139-144`:

> *"Dos lineas tuyas pueden tener la MISMA conversacion: el directo con la misma
> persona visto desde dos numeros propios es el mismo `...@s.whatsapp.net`. Con
> el jid solo, esas dos filas se colapsan en una y el agente contesta desde la
> linea equivocada."*

Cualquier whitelist indexada sólo por JID fusiona silenciosamente dos
autorizaciones distintas.

**A2. Lista de exclusión cerrada, nunca whitelist por sufijo de JID.**
UNIVERSAL. `bin/wa-read:500-507`: sólo se excluyen `@newsletter` y `@broadcast`,
precisamente porque `@status` y `@lid.status` **sí** son conversaciones reales.
Una whitelist por sufijo las habría ocultado sin avisar.

**A3. Taxonomía confirmada contra la app real.** UNIVERSAL.
`@s.whatsapp.net` = directo/direccionable por teléfono, `@g.us` = grupo,
`@lid`/`@status` = otros. `bin/wa-send:283-288`: pasar un JID de grupo al
esquema `whatsapp://` abre un modal de error.

**A4. `kind` depende de grupo vs. directo.** UNIVERSAL en la forma de la regla:
`directo` si el chat no es `@g.us`; si lo es, `mencion` cuando el texto contiene
el LID propio, si no `respuesta` (`bin/wa-read:1595-1599`).

**A5. El ID de mensaje es la llave de idempotencia.** UNIVERSAL como concepto,
HISTÓRICA en formato. El `stanza_id` es llave primaria de `agent_action` y
`work` (`bin/wa-read:1617-1618`): *"una automatizacion sabe que ese mensaje ya
lo atendio."* Baileys usa `{remoteJid, fromMe, id, participant}`, no un string
serializado — **hay que re-verificar la forma, no el principio.**

### B. Rarezas de WhatsApp que producen fallos silenciosos

**B1. `quotedParticipant` llega en dos formas.** UNIVERSAL.
`docs/LECTURA-MULTIFUENTE.md:451`:

> *"llega en @lid y en @c.us: sobre 2343 citas, 45 traian el telefono. Mirar
> solo el LID pierde las respuestas viejas."*

Una implementación que mire una sola forma pierde ~2% de las respuestas, las
más antiguas, **sin error**.

**B2. La lista de menciones trae objetos, no strings.** UNIVERSAL.
`docs/LECTURA-MULTIFUENTE.md:450`: comparar con `===` contra el LID *"no
encuentra nunca nada, y eso se ve igual que 'nadie te nombro esta semana'."*
Verificar la forma que usa Baileys antes de enviar: el fallo produce un cero
silencioso, no una excepción.

**B3. Agrupar por `(tarjeta, chat_jid)`, nunca sólo por tarjeta.** UNIVERSAL.
`bin/wa-scope:1135-1148`:

> *"si dos conversaciones apuntan a la misma tarjeta, agrupar solo por issue
> avisaria a una y marcaria la otra como avisada — un mensaje perdido en
> silencio, que es el peor final posible."*

**B4. Borrados, editados y efímeros: hueco confirmado.** El grep completo sobre
`bin/wa-read` no encontró **nada** de revocación, edición ni mensajes que
desaparecen. `ZWAMESSAGE` se leyó como log append-only. **No es una lección a
portar: es un agujero que el diseño nuevo debe llenar desde cero.** Baileys sí
emite `messages.update` para revocaciones y ediciones.

**B5. Saber siempre de qué época es un timestamp.** HISTÓRICA en mecanismo
(`APPLE_EPOCH = 978307200`, Core Data), UNIVERSAL como disciplina:
`docs/LECTURA-MULTIFUENTE.md:383-385` — *"la fecha sale 31 anios adelantada y el
JSON se ve perfecto igual"*. Un error bien formado.

**B6. Ventana de 7 días, no de 1.** UNIVERSAL. `bin/wa-scope:996-998`: *"con un
dia, una mencion del viernes que nadie contesto ya no aparece el lunes y parece
que no hubo nada."* Una ventana de "reciente" debe sobrevivir un fin de semana.

### C. Media y notas de voz

**C1. Las notas de voz de WhatsApp son Opus; los motores quieren PCM 16 kHz
mono.** UNIVERSAL y portante. `bin/wa-transcribe:64-74`, con la receta exacta:

```
ffmpeg -nostdin -loglevel error -y -i <opus> -ar 16000 -ac 1 -c:a pcm_s16le <wav>
```

Baileys entrega los bytes Opus/OGG ya descifrados. Nota: `ffmpeg` **no** es
dependencia de Baileys para el camino central — sólo lo invoca perezosamente
para miniaturas de video. Lo necesitamos nosotros, en la tubería de
transcripción.

**C2. Los modelos sólo-inglés destrozan el español sin avisar: se rechazan de
entrada.** UNIVERSAL. `bin/wa-transcribe:18-21`:

```python
# Un modelo solo-ingles sobre audio en español devuelve basura sin avisar, que es peor
# que un error. Estos nombres se rechazan de entrada.
SOLO_INGLES = ("base.en", "small.en", "tiny.en", "medium.en", ...)
```

**C3. Nada se descarga solo.** UNIVERSAL, política de producto.
`bin/wa-transcribe:8-10`: *"Un plugin que baja pesos de internet en silencio es
lo contrario de lo que promete su hoja de permisos."*

**C4. Nunca sintetizar una ruta que no se puede respaldar.** UNIVERSAL.
`bin/wa-read:1138-1144`: `ZWAMEDIAITEM` se dejaba vacío a propósito para filas
web, porque *"Una ruta falsa la abriria wa-transcribe y fallaria con 'no such
file' lejos de aca."* Se expone el hueco como marcador tipado. Con Baileys el
problema desaparece — puede descargar cualquier media — pero el principio queda.

**C5. El adjunto viene cerca, no pegado a la mención.** UNIVERSAL, producto.
`bin/wa-read:1631-1633`: *"el pie casi nunca llega en el mismo mensaje que la
mencion: se manda la imagen y dos lineas despues el '@fulano mira esto' — sin
esta ventana el agente lee 'mira esto' sin idea de que."* Ventana de ±5 min por
defecto.

### D. Reglas de producto ganadas con datos

**D1. "Ya contestado" no se vuelve a mostrar.** UNIVERSAL en lógica.
`bin/wa-read:1565-1569`: una mención se suprime si hay un mensaje propio más
nuevo en ese chat. El comentario documenta que esto era una subconsulta
correlacionada por fila y **tardaba minutos**, dejando el panel inusable.
Implementarlo eficiente desde el día uno.

**D2. Ante la duda, no actuar.** UNIVERSAL, respaldado por datos.
`harness/AGENTS.md` regla 3: *"Esta tabla salio de clasificar 266 menciones
reales en 90 dias. La mitad no son trabajo."* Abrir tarjetas de más es peor que
de menos.

**D3. Una credencial nunca pasa por el agente.** UNIVERSAL, la regla de mayor
riesgo del sistema. `harness/AGENTS.md` regla 1: *"Si el mensaje trae una
contraseña, no la copie en la tarjeta, no la repita, no la guarde. Repórtela y
nada más."*

**D4. La ambigüedad se rechaza, nunca se resuelve en silencio.** UNIVERSAL — la
invariante de mayor valor para el camino de envío. Aparece tres veces sólo en
`bin/wa-send` (`LINEA_AMBIGUA`, la verificación de cierre que aborta sin
escribir nada) y en `jid_of` de `wa-scope`, que enumera candidatos y sale con 2.

**D5. Todo mensaje saliente va firmado, sin excepción.** UNIVERSAL.
`bin/wa-send:48-55,659-667`: el envío se **bloquea**, no se advierte, si no hay
`agent_name` configurado.

**D6. Estado explícito `ninguno` en vez de un destino en blanco.** UNIVERSAL.
`bin/wa-scope:65-69`: *"Dejar el destino en blanco se lee como configuracion a
medias, asi que 'no abre tarjeta' se dice en voz alta y es una eleccion como
cualquier otra."*

**D7. Guardia de línea base contra una avalancha de notificaciones.**
UNIVERSAL, patrón inolvidable. `bin/wa-scope:738-756`:

> *"Sin esto, estrenar la funcion mandaria una rafaga de mensajes a grupos de
> clientes por cada tarjeta cerrada en meses — y eso no se puede deshacer... El
> guardia vive aca y no en el prompt justamente porque un prompt se puede
> olvidar de un paso; una columna no."*

Toda función nueva de "notificar al cambiar" sobre un sistema con historia debe
marcar lo preexistente como ya notificado, con un flag durable.

**D8. Reintentar o no, codificado en qué falla marca la fila como hecha.**
UNIVERSAL. `bin/wa-scope:1212-1220`: un envío fallido se marca hecho — *"reintentar
cada cinco minutos un envio que no funciona es como se manda el mismo mensaje
veinte veces"* — mientras que un fallo al leer el tablero nunca llega a marcar
y reintenta solo.

### E. Contrato de proceso y errores

**E1. Los códigos de salida son respuestas de dominio, no niveles de fallo.**
UNIVERSAL. `bin/wa-read:126-131`: 1 = falta requisito, 2 = referencia ambigua,
4 = nada de dónde leer; `wa-scope`: 3 = denegado, 4 = lock tomado. Con **motivo
estable en la primera línea de stderr** y stdout vacío o parseable:

> *"Estos motivos son contrato: el panel los traduce por codigo. Cambiar el
> texto no rompe nada; renombrar el codigo desincroniza el panel en silencio."*

**Preservar este contrato exacto en la superficie que exponga el sidecar.**

**E2. Motivos distintos, no un fallo genérico.**
`docs/LECTURA-MULTIFUENTE.md:51-73`: *"Son diez motivos web y no uno porque la
accion del usuario es distinta en cada uno."* Aplica directo a los estados de
Baileys: QR pendiente, sesión cerrada, sin sesión y socket caído son acciones
distintas del usuario.

**E3. El doctor comprueba lo que está encendido, nunca asume un transporte
obligatorio.** UNIVERSAL, regresión confirmada. `bin/wa-read:1975-1998`: hacer
los chequeos locales incondicionales *"dejaba el plugin MUERTO en Linux y en
Windows con una sesion web leyendo perfecto."*

**E4. Las herramientas se resuelven por ruta absoluta relativa a `__file__`.**
UNIVERSAL, regresión confirmada dos veces. `bin/wa-scope:50-52`: *"ya habia
mandado a wa-scope a un wa-read de otra instalacion"*.

**E5. Fallo parcial avisa, nunca aborta.** UNIVERSAL. `bin/wa-read:2056-2065`:
*"perder la bandeja entera porque una segunda linea esta caida seria cambiar un
hueco por un apagon."* Y `:2029-2031`: "cuántas fuentes respondieron" nunca
puede colapsar con "cuántas filas volvieron", o una bandeja rota se lee como
una tranquila.

**E6. La detección de cambios debe conjuntar frescura, no disyuntarla.**
UNIVERSAL, regresión confirmada. `bin/wa-scope:451-478`: mirar sólo la huella de
la primera fuente **congeló la bandeja para siempre** en un equipo que leía sólo
por web. Un socket vivo no tiene proxy barato de mtime: se trata como
"siempre potencialmente cambiado", nunca se cachea como sin cambios.

### F. Privacidad y retención

**F1. Permisos de archivo sobre texto ajeno.** UNIVERSAL. `bin/wa-read:917-919`:
`os.chmod(ruta, 0o600)` — *"en un equipo compartido el umask por defecto lo deja
legible para todos."* El almacén nuevo del sidecar necesita lo mismo. **Y el
auth state también: es una credencial viva.**

**F2. Tope duro de retención, con desalojo visible.** UNIVERSAL.
`bin/wa-read:246-249`: *"un almacen sin tope y sin caducidad es un archivo de
conversaciones ajenas que nadie borra."* El mensaje de desalojo dice qué se fue
y cómo subir el límite.

**F3. Contenido y contabilidad se purgan distinto.** UNIVERSAL.
`bin/wa-read:1043-1044`: apagar la captura borra los cuerpos pero conserva el
`first_seen` por línea, *"porque no es contenido de nadie."*

**F4. Aislamiento entre cuentas en la llave de almacenamiento.** UNIVERSAL.
`bin/wa-read:960-985`: llave primaria `(account, chat_jid, stanza_id)` — *"servir
el cuerpo de la otra linea es contestar sobre la conversacion ajena."*

### G. Tono en español: decisión de producto, verificada por lint

**G1. `usted`, cero voseo.** UNIVERSAL. `scripts/voseo.py:3`: *"El usuario es
colombiano y el tono que el propio plugin configura dice 'sin voseo'."* El valor
por defecto de `tone` (`bin/wa-scope:1029-1030`): *"Espanol neutro
latinoamericano. Trata de usted. Formal pero no acartonado. Sin modismos
regionales, sin voseo, sin diminutivos. Frases cortas."*

**G2. El chequeo genera conjugaciones, no compara contra una lista.** UNIVERSAL.
`scripts/voseo.py:66-83`: 4 variantes por raíz sobre ~130 raíces, más
irregulares, con exclusiones explícitas para no marcar homógrafos del portugués.
**Debe seguir cuidando toda cadena en español que produzcan el sidecar o el
panel.**

### H. Panel: el presupuesto de 30/10 s

**H1. El error exacto que produjo la regla de la casa sobre evidencia visual.**
`config.html:1515-1516`:

> *"Medido: el host admite 30 mensajes por 10 s, el arranque gasta 21 y entrar
> al panel dispara focus -> otra vuelta de 19 = 40 en la misma ventana. El
> storage.set del clic caia en el puesto 31, volvia rate_limited, y el panel lo
> pintaba como 'El plugin no contesto'."*

Pasaba todas las pruebas funcionales. Sólo contar mensajes contra el
presupuesto real lo encontró.

**H2. Autolimitación con reserva para el usuario.** UNIVERSAL, reutilizable
verbatim. `config.html:1523-1534`:

```js
var CUPO = { max: 30, ventanaMs: 10000, reserva: 4 }
```

**Sólo el sondeo se autolimita.** Los clics del usuario salen siempre y
reintentan con backoff (300 ms → 2500 ms) si los rechazan.

**H3. Claves vivas vs. estáticas.** `config.html:2798-2807`: 6 claves vivas cada
12 s; sondear las ~19 reventaría el presupuesto. Las editables se empujan al
guardar o al enfocar.

**H4. `document.visibilityState` en todos los timers.** `setInterval` sigue
disparando en una pestaña oculta y quema presupuesto contra nadie.

**H5. Una lectura rechazada no es una clave vacía.** UNIVERSAL, y no tiene nada
que ver con WhatsApp. `config.html:1609-1624`, centinela `SIN_RESPUESTA`:
*"Aplastar las dos en null es lo que hacia parpadear el panel."* Se repinta con
el último valor bueno conocido.

**H6. Un panel es HTML+script inline: un error de sintaxis da un panel vacío y
roto en silencio.** `scripts/check-panels:4-6`: *"Perdi dos rondas de ida y
vuelta por eso."*

**H7. Las capturas existen porque las pruebas que pasan no prueban que se vea
bien.** `test/shots.mjs:3-5`: *"el que se entrego con 12 px de ancho los
pasaba."* Es el incidente que originó la regla de evidencia visual del proyecto.

### I. Multi-línea

**I1. Las fuentes suman, no se reemplazan.** UNIVERSAL en el modelo subyacente.
Aunque sobreviva un solo transporte, el producto soporta **varias líneas
independientes a la vez** (`wa_account`, `bin/wa-scope:101-106`) — un número
personal y uno de soporte. El diseño nuevo debe preservarlo.

**I2. Deduplicar por `stanza_id`, con respaldo en `jid`, nunca fusionar sin
llave.** UNIVERSAL. `bin/wa-read:2082-2096`: fusionar filas sin identidad
compartida borraría la identidad de la segunda línea.

**I3. Línea pendiente y línea promovida son estados distintos.** UNIVERSAL.
`docs/LECTURA-MULTIFUENTE.md:224-230`: se registra como pendiente, se promueve a
identidad real cuando la sesión confirma quién es, y **una línea a medio
enlazar nunca lee nada.** La forma se conserva; el mecanismo lo reemplaza el
emparejamiento de Baileys.

### J. Sandbox

**J1. El worker necesita una válvula de escape para escribir.** UNIVERSAL.
`main.mjs:689-710` (`sembrarFuera`): el proceso dentro del sandbox detecta que
lo está y reporta `reason: 'vallado'` **sin siquiera tocar disco**; la escritura
real ocurre en un hijo sin sandbox.

**J2. El latido debe estar desacoplado de la salud del transporte.** UNIVERSAL.
`main.mjs:712-727`, verificado en `test/worker.test.mjs:1149-1167`: sigue
latiendo aunque todas las herramientas estén rotas. 5 s de latido contra 30 s de
tolerancia, ajustado al hecho de que una llamada al CLI de Orca puede tardar
legítimamente 30 s.

## 12. Criterios de aceptación

Marcados por tipo de evidencia. Un criterio no verificado no se reporta como
cumplido.

**Verificables por código y pruebas:**

- No queda ninguna referencia a la app de macOS ni a WhatsApp Web en código,
  ajustes, documentación ni pruebas — incluida la descripción de
  `orca-plugin.json:7`.
- El plugin conecta con WhatsApp sin abrir ninguna ventana, sin navegador y sin
  la app de escritorio.
- El bundle del sidecar es **un archivo** y el árbol del plugin queda por debajo
  de 2.000 archivos y 50 MB, sin symlinks.
- `npm ci` instala sin acceso a GitHub y con `integrity` en todas las entradas.
- Un mensaje de un chat en modo `off` no produce ninguna acción, y queda
  registrado que se ignoró.
- Un límite alcanzado detiene la acción y lo dice, en vez de fallar callado.
- Los códigos de salida y los motivos estables de §11-E1 siguen intactos: el
  panel los traduce por código.
- El lint de voseo sigue pasando sobre toda cadena en español nueva.
- La suite pasa, y las pruebas de los transportes viejos se eliminan o se
  reescriben — **no se dejan desactivadas**.

**Verificables sólo mirando (regla de evidencia visual del proyecto):**

- El QR se dibuja dentro del panel de ajustes, se escanea desde la pantalla, y
  un QR vencido se descarta en vez de pintarse.
- Capturas a 1440, 768, 390 y 320 px, en los dos temas, de: sin emparejar, QR en
  pantalla, conectado, y sesión caída.

**Sólo verificables con una cuenta real emparejada — HOY NO VERIFICADO:**

- Orca reiniciado recupera la sesión **sin volver a pedir QR**.
- Tras suspender y despertar la máquina, el sidecar reconecta solo, y se conoce
  con qué código de desconexión y en cuánto tiempo.

## 13. Decisiones pendientes

1. **Licenciamiento GPL-3.0.** `libsignal` es GPL-3.0 y queda dentro del bundle
   distribuido. No se evita con Baileys. La única alternativa sería whatsmeow
   (MPL-2.0, copyleft por archivo), lo que reabre toda la elección de
   transporte. **Decisión de negocio, no técnica.**
2. **Qué acciones concretas entran en el conjunto cerrado de "puede hacer solo"**
   y cuáles exigen confirmación humana fuera de banda. De esto depende el techo
   de daño de una inyección exitosa, así que es la decisión de seguridad más
   importante del diseño.
3. **Respaldo del auth state.** Dónde y con qué política, sabiendo que es una
   credencial viva: quien la tenga puede leer y escribir como esa cuenta sin el
   teléfono.
4. **Política de ritmo contra el baneo.** Número dedicado o personal, tope por
   hora, jitter. La cuenta se pierde de forma permanente y sin apelación.
