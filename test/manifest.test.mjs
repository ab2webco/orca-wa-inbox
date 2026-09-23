#!/usr/bin/env node
// El manifiesto contra los limites REALES de Orca, no contra los que suponemos.
//
// Existe porque esta prueba ya salio verde sobre un manifiesto que Orca rechazaba
// entero: los dos `precheck` median 1778 y 1791 caracteres contra un techo de 1024, el
// plugin aparecia en la app como `invalid-development-plugin-3` y nada aca lo delataba
// —solo se miraban las capabilities y la prosa de la descripcion—. Una prueba que dice
// verde mientras el producto no carga es peor que no tener prueba: da permiso para
// publicar.
//
// Los numeros de abajo son copias de los del esquema de Orca, con archivo y linea, para
// que la proxima persona pueda verificarlos contra una version mas nueva en un minuto.
// Si Orca cambia un techo, aca falla y se actualiza; no se adivina.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'))

// ──────────────────────────────────────────────────────────────────────────
// Los limites, tal como los declara Orca. Ruta relativa a la raiz de orca-oss.
// ──────────────────────────────────────────────────────────────────────────
// src/shared/plugins/plugin-manifest-fields.ts:4,7
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ID_MAX = 64
// src/shared/plugins/plugin-manifest-fields.ts:5
const IDS_PROHIBIDOS = new Set(['__proto__', 'prototype', 'constructor'])
// src/shared/plugins/plugin-manifest-fields.ts:24-28
const RUTA_RELATIVA_MAX = 1024
// src/shared/plugins/plugin-manifest-fields.ts:46,48-58
const ICONO_NOMBRE_MAX = 64
// src/shared/plugins/plugin-manifest-fields.ts:60-64
const COMMAND_ID_MAX = 256
const COMMAND_ID_RE = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/
// src/shared/plugins/plugin-manifest.ts:55-56
const PANEL_LIMIT = 64
const COMMAND_LIMIT = 256
// src/shared/plugins/plugin-manifest.ts:60-63
const ENGINE_RANGE_MAX = 64
const ENGINE_RANGE_RE = /^>=\d+\.\d+\.\d+$/
// src/shared/plugins/plugin-manifest.ts:67,83,111,115 — todos los titulos y nombres
const TITULO_MAX = 256
// src/shared/plugins/plugin-manifest.ts:78 — enum CERRADO: un valor nuevo invalida todo
const SUPERFICIES = new Set(['worktree', 'settings', 'nav'])
// src/shared/plugins/plugin-manifest.ts:84 — enum cerrado del contexto de un comando
const CONTEXTOS = new Set(['global', 'worktree'])
// src/shared/plugins/plugin-manifest.ts:91-96 — enum cerrado, y el tope de eventos ES
// la cantidad de nombres que existen.
const EVENTOS = ['worktree.created', 'worktree.removed', 'agent.status.changed']
const EVENTO_LIMIT = EVENTOS.length
// src/shared/plugins/plugin-manifest.ts:113
const DESCRIPCION_MAX = 4096
// src/shared/plugins/plugin-manifest.ts:112 — semver estricto
const SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
// src/shared/plugins/plugin-manifest.ts:166
const CAPABILITY_LIMIT = 32
// src/shared/plugins/plugin-capabilities.ts:14-25 — enum cerrado: una capability con un
// typo (o de un Orca mas nuevo) invalida el manifiesto, no concede nada en silencio.
const CAPABILITIES = new Set([
  'workspace:read', 'terminal:send', 'notifications:show', 'storage', 'secrets',
  'events:subscribe', 'settings:own', 'net:fetch', 'process:spawn', 'skills:contribute'
])
// src/shared/plugins/plugin-settings-contribution.ts:15
const SETTINGS_LIMIT = 32
// src/shared/plugins/plugin-automation-contribution.ts:32
const AUTOMATION_LIMIT = 16
// src/shared/plugins/plugin-automation-contribution.ts:57 — EL QUE NOS TUMBO EL PLUGIN.
const PRECHECK_MAX = 1024
// src/shared/plugins/plugin-automation-contribution.ts:43
const COMMAND_MAX = 1024
// src/shared/plugins/plugin-automation-contribution.ts:48-53, via
// src/shared/automation-schedules.ts:12 (AUTOMATION_CRON_EXPRESSION_MAX_BYTES)
const TRIGGER_MAX = 2 * 1024
// src/shared/plugins/plugin-automation-contribution.ts:54
const TIMEZONE_MAX = 64
// src/shared/plugins/plugin-automation-contribution.ts:38,60 — literal, no string
const WORKSPACE_PROPIO = 'plugin-owned'
// src/shared/plugins/plugin-automation-contribution.ts:63-77 — los dos objetos son
// `.strict()`: una clave no declarada invalida el manifiesto entero.
const CLAVES_AUTOMATION_COMUNES = ['id', 'title', 'trigger', 'timezone', 'precheck', 'workspace']
const CLAVES_AUTOMATION_AGENTE = new Set([...CLAVES_AUTOMATION_COMUNES, 'prompt', 'provider'])
const CLAVES_AUTOMATION_COMANDO = new Set([...CLAVES_AUTOMATION_COMUNES, 'command'])
// src/shared/plugins/plugin-manifest.ts:152 — `contributes` es `.strict()`.
const CONTRIBUCIONES = new Set([
  'panels', 'commands', 'events', 'languagePacks', 'keybindings', 'vmRecipes', 'agents',
  'automations', 'skills', 'settings'
])
// src/shared/tui-agent-config.ts:12,326-327 — `provider` tiene que ser un agente que
// Orca sepa lanzar. La lista viva es TUI_AGENT_CONFIG; aca solo estan los que este
// plugin declara hoy, para que agregar uno obligue a mirar esa tabla.
const PROVEEDORES = new Set(['claude', 'codex', 'gemini', 'opencode'])

// src/shared/plugins/plugin-path-safety.ts:1-42 — toda ruta declarada se queda dentro
// de la carpeta del plugin y sobrevive a Windows.
const CHAR_PROHIBIDO_WINDOWS_RE = /[<>:"|?*]/
const DISPOSITIVO_WINDOWS_RE =
  /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i

const fallos = []
let hechas = 0

function exige (condicion, mensaje) {
  hechas += 1
  if (!condicion) fallos.push(mensaje)
}

function exigeTexto (valor, donde, { min = 1, max }) {
  exige(typeof valor === 'string' && valor.length >= min && valor.length <= max,
    `${donde}: ${typeof valor === 'string' ? `${valor.length} caracteres` : typeof valor}`
    + `, el esquema de Orca acepta ${min}..${max}`)
}

function exigeId (valor, donde) {
  exige(typeof valor === 'string' && valor.length <= ID_MAX && ID_RE.test(valor)
    && !IDS_PROHIBIDOS.has(valor),
  `${donde}: "${valor}" no es un id kebab-case de hasta ${ID_MAX} caracteres`)
}

function exigeRuta (valor, donde, max = RUTA_RELATIVA_MAX) {
  const segmentos = typeof valor === 'string' ? valor.split(/[\\/]/) : []
  const seguro = typeof valor === 'string'
    && valor.length >= 1 && valor.length <= max
    && !valor.startsWith('/') && !valor.startsWith('\\')
    && segmentos.every((s) => s.length > 0 && s !== '.' && s !== '..'
      && !s.endsWith('.') && !s.endsWith(' ')
      && !CHAR_PROHIBIDO_WINDOWS_RE.test(s)
      && ![...s].some((c) => c.charCodeAt(0) <= 31)
      && !DISPOSITIVO_WINDOWS_RE.test(s))
  exige(seguro, `${donde}: "${valor}" no es una ruta relativa portable dentro del plugin`)
}

function exigeClaves (objeto, permitidas, donde) {
  const sobra = Object.keys(objeto).filter((k) => !permitidas.has(k))
  exige(sobra.length === 0,
    `${donde}: claves que el esquema .strict() de Orca no declara: ${sobra.join(', ')}`)
}

// ── Raiz ──
exige(manifest.manifestVersion === 1, 'manifestVersion: Orca solo acepta el literal 1')
exige(manifest.pluginApi === 1, 'pluginApi: Orca solo acepta el literal 1')
exigeId(manifest.id, 'id')
exigeId(manifest.publisher, 'publisher')
exigeTexto(manifest.name, 'name', { max: TITULO_MAX })
exige(SEMVER_RE.test(manifest.version), `version: "${manifest.version}" no es semver`)
exigeTexto(manifest.description, 'description', { min: 0, max: DESCRIPCION_MAX })
exigeTexto(manifest.engines?.orca, 'engines.orca', { max: ENGINE_RANGE_MAX })
exige(ENGINE_RANGE_RE.test(manifest.engines?.orca ?? ''),
  `engines.orca: "${manifest.engines?.orca}" no tiene la forma ">=x.y.z"`)
if (manifest.main !== undefined) exigeRuta(manifest.main, 'main')
if (manifest.icon !== undefined) exigeRuta(manifest.icon, 'icon')

// ── contributes ──
const contributes = manifest.contributes ?? {}
exigeClaves(contributes, CONTRIBUCIONES, 'contributes')

const panels = contributes.panels ?? []
exige(panels.length <= PANEL_LIMIT, `contributes.panels: ${panels.length} supera ${PANEL_LIMIT}`)
for (const panel of panels) {
  const donde = `panel ${panel.id}`
  exigeId(panel.id, `${donde}.id`)
  exigeTexto(panel.title, `${donde}.title`, { max: TITULO_MAX })
  exigeRuta(panel.entry, `${donde}.entry`)
  if (panel.icon !== undefined) {
    // Un icono es un nombre del set curado de lucide (<=64) O una ruta .svg del plugin.
    if (panel.icon.toLowerCase().endsWith('.svg')) exigeRuta(panel.icon, `${donde}.icon`)
    else exigeTexto(panel.icon, `${donde}.icon`, { max: ICONO_NOMBRE_MAX })
  }
  if (panel.surface !== undefined) {
    exige(SUPERFICIES.has(panel.surface),
      `${donde}.surface: "${panel.surface}" no esta en el enum cerrado `
      + `${[...SUPERFICIES].join(' | ')}`)
  }
}

const commands = contributes.commands ?? []
exige(commands.length <= COMMAND_LIMIT,
  `contributes.commands: ${commands.length} supera ${COMMAND_LIMIT}`)
for (const comando of commands) {
  const donde = `command ${comando.id}`
  exigeTexto(comando.id, `${donde}.id`, { max: COMMAND_ID_MAX })
  exige(COMMAND_ID_RE.test(comando.id ?? ''), `${donde}.id: no es un id de comando portable`)
  exigeTexto(comando.title, `${donde}.title`, { max: TITULO_MAX })
  if (comando.context !== undefined) {
    exige(CONTEXTOS.has(comando.context),
      `${donde}.context: "${comando.context}" no esta en ${[...CONTEXTOS].join(' | ')}`)
  }
}

const events = contributes.events ?? []
exige(events.length <= EVENTO_LIMIT,
  `contributes.events: ${events.length} supera ${EVENTO_LIMIT}`)
for (const evento of events) {
  exige(EVENTOS.includes(evento.on),
    `events.on: "${evento.on}" no esta en el set cerrado ${EVENTOS.join(' | ')}`)
}

const settings = contributes.settings ?? []
exige(settings.length <= SETTINGS_LIMIT,
  `contributes.settings: ${settings.length} supera ${SETTINGS_LIMIT}`)

const automations = contributes.automations ?? []
exige(automations.length <= AUTOMATION_LIMIT,
  `contributes.automations: ${automations.length} supera ${AUTOMATION_LIMIT}`)
for (const auto of automations) {
  const donde = `automation ${auto.id}`
  exigeId(auto.id, `${donde}.id`)
  exigeTexto(auto.title, `${donde}.title`, { max: TITULO_MAX })
  exigeTexto(auto.trigger, `${donde}.trigger`, { max: TRIGGER_MAX })
  exigeTexto(auto.timezone, `${donde}.timezone`, { max: TIMEZONE_MAX })
  // La zona la valida Intl, que es la misma autoridad que usa Orca.
  hechas += 1
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: auto.timezone })
  } catch {
    fallos.push(`${donde}.timezone: "${auto.timezone}" no es una zona IANA`)
  }
  // El precheck: el techo que tumbo el plugin entero.
  if (auto.precheck !== undefined) {
    exigeTexto(auto.precheck, `${donde}.precheck`, { max: PRECHECK_MAX })
  }
  if (auto.workspace !== undefined) {
    exige(auto.workspace === WORKSPACE_PROPIO,
      `${donde}.workspace: solo existe el literal "${WORKSPACE_PROPIO}"`)
  }
  // Union de dos objetos strict: o agente (prompt + provider) o comando. Nunca las dos
  // ni ninguna, y sin claves de sobra.
  const esAgente = 'prompt' in auto || 'provider' in auto
  const esComando = 'command' in auto
  exige(esAgente !== esComando,
    `${donde}: tiene que ser o (prompt + provider) o (command), nunca las dos ni ninguna`)
  if (esAgente) {
    exigeRuta(auto.prompt, `${donde}.prompt`)
    exige(PROVEEDORES.has(auto.provider),
      `${donde}.provider: "${auto.provider}" no es un agente que Orca sepa lanzar`)
    exigeClaves(auto, CLAVES_AUTOMATION_AGENTE, donde)
  }
  if (esComando) {
    exigeTexto(auto.command, `${donde}.command`, { max: COMMAND_MAX })
    exigeClaves(auto, CLAVES_AUTOMATION_COMANDO, donde)
  }
}

// ── Ids duplicados (plugin-manifest-contribution-validation.ts:49-57) ──
for (const [nombre, lista] of [['panels', panels], ['commands', commands],
  ['automations', automations]]) {
  const ids = lista.map((entrada) => entrada.id)
  exige(new Set(ids).size === ids.length, `contributes.${nombre}: hay ids duplicados`)
}

// ── capabilities y las reglas cruzadas ──
const capabilities = manifest.capabilities ?? []
exige(capabilities.length <= CAPABILITY_LIMIT,
  `capabilities: ${capabilities.length} supera ${CAPABILITY_LIMIT}`)
const clases = new Set()
for (const capability of capabilities) {
  exige(CAPABILITIES.has(capability.kind),
    `capabilities: "${capability.kind}" no esta en el set cerrado de Orca`)
  clases.add(capability.kind)
  // Solo `net:fetch` lleva campos extra (hosts); las demas son {kind} y nada mas.
  if (capability.kind !== 'net:fetch') {
    exigeClaves(capability, new Set(['kind']), `capability ${capability.kind}`)
  }
}
// plugin-manifest-contribution-validation.ts:119-155 — lo que obliga a declarar `main`
// y la capability del evento. Sin esto el manifiesto tampoco carga.
exige(!(commands.some((c) => c.action === undefined) && !manifest.main),
  'main: es obligatorio cuando contributes.commands trae un comando del worker')
exige(!(events.length > 0 && !manifest.main),
  'main: es obligatorio cuando contributes.events no esta vacio')
exige(!(clases.has('process:spawn') && !manifest.main),
  'main: es obligatorio cuando se declara la capability process:spawn')
exige(!(events.length > 0 && !clases.has('events:subscribe')),
  'capabilities: events:subscribe es obligatoria cuando contributes.events no esta vacio')

// ── La capability del worker y la prosa que el usuario lee, que ya se cuidaban.
const processSpawn = capabilities.filter(({ kind }) => kind === 'process:spawn')
hechas += 1
assert.deepEqual(processSpawn, [{ kind: 'process:spawn' }],
  'the worker requires the process:spawn capability to execute wa-scope')

// La descripcion es lo UNICO que el usuario lee antes de instalar: no puede prometer
// una funcion que el plugin ya no tiene. Prometia "conecta lineas de WhatsApp Web
// lanzando la CLI de Orca" mucho despues de que eso dejara de existir, y nada lo
// delataba — no hay chequeo que lea prosa.
for (const muerto of ['WhatsApp Web', 'browser tab', 'Orca CLI']) {
  hechas += 1
  assert.ok(!manifest.description.includes(muerto),
    `the description still promises "${muerto}", which the plugin no longer does`)
}
// Y tiene que decir lo que SI hace hoy, o el usuario instala a ciegas.
hechas += 1
assert.match(manifest.description, /QR/,
  'the description does not say the line is paired with a QR code, which is what it does today')

if (fallos.length) {
  console.error('Orca rechazaria este manifiesto:')
  for (const f of fallos) console.error(`  ${f}`)
  console.error('\nUn manifiesto que no valida no carga a medias: el plugin entero aparece '
    + 'como invalid-development-plugin y ninguna otra prueba lo nota.')
  process.exit(1)
}
console.log(`${hechas}/${hechas} el manifiesto cabe en los limites reales de Orca`)
