# Escribir un plugin de Orca Lab

Lo que aprendimos construyendo `wa-inbox`, que sirve de referencia. Casi todo esto
cuesta una ronda de prueba y error si nadie te lo dice antes.

---

## 1. Anatomía mínima

```
mi-plugin/
  orca-plugin.json   manifest — lo único obligatorio
  main.mjs           worker (Node plano, sin Electron). Opcional.
  panel.html         UI. Opcional. HTML con todo inline.
```

Se instala desde Ajustes → Plugins → Instalar plugin → **Carpeta local**, apuntando a
la carpeta. Como **plugin de desarrollo** se carga desde el disco: edita el archivo y
recarga el panel, sin reinstalar.

## 2. El manifest

```jsonc
{
  "manifestVersion": 1,
  "id": "mi-plugin",              // kebab-case
  "publisher": "mi-org",          // kebab-case
  "version": "1.0.0",             // semver estricto
  "engines": { "orca": ">=1.4.0" }, // SOLO la forma ">=x.y.z"
  "pluginApi": 1,
  "main": "main.mjs",
  "contributes": {
    "panels": [{ "id": "mi-panel", "title": "…", "icon": "bell",
                 "entry": "panel.html", "surface": "worktree" }],
    "commands": [{ "id": "mi-plugin.hacer-algo", "title": "…" }],
    "events": [{ "on": "agent.status.changed" }]
  },
  "capabilities": [{ "kind": "storage" }]
}
```

**Trampas que cuestan tiempo:**

- `icon` sale de un **set curado**, no de todo lucide. Si pone uno que no está
  (`message-square`, por ejemplo) **no falla**: cae en silencio a un enchufe.
  La lista vive en `plugin-panel-activity-items.ts`.
- `engines.orca` solo acepta `">=x.y.z"`. Cualquier otro rango no valida.
- Los ids de comando aceptan puntos (`mi-plugin.hacer-algo`); los ids de plugin y de
  panel **no**: kebab-case y nada más.
- Valide el manifest contra el esquema real antes de instalar, en vez de adivinar:

  ```ts
  import { pluginManifestSchema } from './src/shared/plugins/plugin-manifest'
  pluginManifestSchema.safeParse(JSON.parse(readFileSync('orca-plugin.json','utf8')))
  ```

## 3. Capabilities: pida lo mínimo

Las que existen y el usuario consiente al instalar: `workspace:read`, `terminal:send`,
`notifications:show`, `storage`, `secrets`, `events:subscribe`, `settings:own`,
`net:fetch`, `process:spawn`.

Si no declarás `net:fetch`, Orca lo dice en la tarjeta del plugin. **Eso no es un
error**: es la app contándole al usuario que tu plugin no sale a internet.

`process:spawn` es la que más pesa en ese diálogo: dice que el plugin puede arrancar
programas como el usuario. Este plugin la declara porque conducir el navegador de Orca
es ejecutar su CLI, y **la descripción del plugin es el único texto de ese diálogo que
usted controla** — úsela para decir qué arranca, no para justificarse.

**No pida `terminal:send` para "hacer cosas".** El API no tiene noción de "la terminal
activa": da ids y nada más — ni el nombre, ni si es una shell o una sesión de agente
trabajando. Si elige la primera, le va a escribir comandos encima al agente de alguien.
Nosotros la pedimos, nos pasó exactamente eso, y terminamos sacándola.

## 4. El panel: lo que NO puede hacer

El panel es un iframe con `sandbox="allow-scripts"` y **sin** `allow-same-origin`
(invariante de seguridad, `PluginPanel.tsx:223`). Consecuencias:

- **Origen opaco ⇒ `localStorage`, `sessionStorage` e IndexedDB tiran `SecurityError`.**
  El panel no tiene ninguna persistencia propia. La única es `storage.*` del host.
- No puede cargar archivos relativos (`<script src="x.js">` no resuelve). **Todo inline.**
- No puede llamar a los comandos de tu worker. Panel y worker se hablan solo a través de
  `storage`: uno escribe, el otro lee.
- Solo puede llamar los métodos marcados `panel: true` en `plugin-host-api.ts`.

### El resultado viene envuelto dos veces

Esta se lleva media hora si no la sabe:

```js
// storage.get devuelve { value: <dato> }, y el bridge lo envuelve OTRA VEZ.
function stored(result) {
  if (!result || !result.ok || !result.value) return null
  return result.value.value === undefined ? null : result.value.value
}
```

Sin las dos capas te llega el objeto contenedor y la UI muestra `[object Object]`.

### Plantilla del puente

```js
var seq = 0, pending = {}
function call(action, params) {
  return new Promise(function (resolve) {
    var requestId = 'req-' + ++seq
    pending[requestId] = resolve
    // Origen opaco: '*' es el unico targetOrigin usable. El host valida la ventana.
    window.parent.postMessage(
      { type: 'orca-panel-action', requestId: requestId, action: action, params: params }, '*')
  })
}
window.addEventListener('message', function (e) {
  var d = e.data
  if (!d || d.type !== 'orca-panel-action-result') return
  var resolve = pending[d.requestId]
  if (!resolve) return
  delete pending[d.requestId]
  resolve(d)
})
```

### Presupuesto

30 mensajes cada 10 segundos por plugin, y 64 KB por mensaje. Un sondeo cada 8s cuesta
1. No hay evento de `storage`, así que si quiere que el panel se entere de cambios de
afuera, sondee — pero solo con `document.visibilityState === 'visible'`.

### Tema e idioma

El host inyecta sus tokens de diseño como variables CSS: use `var(--foreground)`,
`var(--background)`, `var(--border)`, `var(--primary)`, `var(--muted-foreground)` y el
panel combina con la app sin saber nada de ella.

El idioma **no** se inyecta. Sale de `navigator.language`, que en el renderer de Electron
refleja el idioma del app.

## 5. El worker (`main.mjs`)

Node plano, fuera de proceso, arrancado en forma perezosa en el primer trigger.

```js
export default function activate(orca) {
  orca.commands.register('mi-plugin.hacer-algo', async (args) => {
    const prev = await orca.host.call('storage.get', { key: 'contador' })
    return { ok: true }
  })
  orca.events.on('worktree.created', async (payload) => { /* … */ })
}
```

Solo hay **tres** eventos: `worktree.created`, `worktree.removed`,
`agent.status.changed`. No hay evento de storage, ni de terminal, ni de red.

A diferencia del panel, el worker **sí toca disco**. Ahí va lo que necesite leer archivos
o invocar binarios; el panel se limita a mostrar lo que el worker dejó en `storage`.

## 6. Lo que un plugin NO puede hacer

Antes de diseñar, descarte esto:

| | |
|---|---|
| Agregar un verbo `orca <cmd>` | El CLI es estático: specs y handlers se registran a mano en el repo. |
| Escribir en Plane, Linear o Jira | No está en el host API. |
| Engancharse a las automations | Solo los 3 eventos de arriba. |
| Recibir red entrante (webhooks) | `net:fetch` es saliente y con allowlist de hosts. |
| Crear una terminal | `terminal.sendText` escribe en una que ya existe. |

Si tu feature necesita algo de esa lista, el camino es un **módulo dentro del app**
(como Plane, Linear o Jira), no un plugin.

## 7. Errores que cometimos

- **Escribir en `terminals[0]`.** Era la sesión de un agente, que leyó los comandos como
  si le hablaran. El API no te deja distinguir shell de agente: o lo elige el usuario, o
  no toques terminales.
- **Un espejo en `localStorage`.** Nunca funcionó (origen opaco) y la UI fingía recordar.
  Peor que no recordar.
- **Documentación dentro del producto.** Tres párrafos de "Requisitos" explicando
  SQLCipher en medio del panel. La UI se calla cuando todo anda y muestra **una línea con
  una acción** cuando algo se rompe. El porqué va al README.
- **No validar el script del panel.** Si el JS no parsea, el panel se renderiza **vacío y
  sin ningún error visible**. Perdimos dos rondas por eso. Ahora corre `bin/check-panels`
  antes de cada commit.
- **Editar el repo del app mientras corría `pnpm dev` desde ahí.** Vite recargó archivos
  a medio escribir y el renderer se cayó. Si va a tocar orca-oss mientras lo usa,
  hágalo en otro worktree.

## 8. Cómo publicarlo

No van en `examples/plugins/` — eso es para muestras. La convención de los oficiales:

- Cada plugin en **su propio repo**, con un tag.
- Una entrada en `resources/plugins/launch/orca-marketplace.json` apuntando a ese repo y
  ese tag.
- Si además tiene que venir preinstalado: los archivos en
  `resources/plugins/launch/<publisher>.<id>/` y una entrada con su `contentHash` en
  `bundled-plugins.json`.

Preinstalar algo que solo funciona en un sistema operativo es darle un plugin roto al
resto. Si el tuyo es de plataforma limitada, que vaya al catálogo y no al bundle.
