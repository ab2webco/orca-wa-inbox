/**
 * WhatsApp Inbox — worker del plugin.
 *
 * Corre en el worker out-of-process de Orca (Node plano, sin Electron). Es el unico
 * lado del plugin que puede tocar disco, asi que aca vive todo lo que necesita leer
 * la base de WhatsApp o persistir el registro.
 *
 * No reimplementa la lectura de WhatsApp: delega en los CLIs (`wa-read`, `wa-scope`,
 * `wa-send`), que ya resuelven el WAL, el epoch de Core Data y la resolucion de LIDs.
 * Duplicar esa logica aca seria tener dos verdades que se desincronizan.
 */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Las herramientas viajan dentro del plugin. Antes se buscaban en el PATH del usuario,
// lo que solo funcionaba en la maquina donde alguien las habia enlazado a mano.
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const TOOLS = join(PLUGIN_DIR, 'bin')
const SCOPE_KEY = 'scope'          // { [chatJid]: ScopeEntry }
const MODES = ['off', 'observar', 'borrador', 'responder']

/** El nombre del agente lo define quien usa el plugin. No viene con uno puesto. */
const DEFAULT_SETTINGS = { agentName: '', signMessages: true, toolsDir: TOOLS }

/** Corre `wa-read doctor` y avisa por notificacion si algo falta. */
async function checkSystem(orca) {
  const result = await run(join(TOOLS, 'wa-read'), ['doctor', '--json'],
    { timeoutMs: 30000 }).catch(() => null)
  let checks = []
  try {
    checks = JSON.parse(result?.stdout || '[]')
  } catch {
    checks = []
  }
  const failed = checks.filter((c) => !c.ok)
  if (!checks.length) {
    await orca.host.call('notifications.show', {
      title: 'No pude verificar el sistema',
      body: `No pude correr las herramientas del plugin. Revisa que ${TOOLS} sea ejecutable.`
    }).catch(() => {})
    return
  }
  if (!failed.length) return

  // El primer chequeo es si el sistema esta soportado; distinguirlo de "falta instalar
  // WhatsApp" importa, porque uno se arregla y el otro no.
  const unsupported = failed.some((c) => /sistema|system/i.test(c.check))
  await orca.host.call('notifications.show', {
    title: unsupported
      ? 'WhatsApp Inbox no puede leer en este sistema'
      : 'WhatsApp Inbox necesita algo mas',
    body: unsupported
      ? 'La lectura de WhatsApp solo esta verificada en macOS con WhatsApp Desktop. ' +
        'El resto del plugin funciona; las automatizaciones no van a correr.'
      : `${failed[0].check}: ${failed[0].detalle}. Corre ./bin/wa-read doctor para el detalle.`
  }).catch(() => {})
  orca.log(`chequeo: faltan ${failed.map((c) => c.check).join(', ')}`)
}

function run(cmd, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // wa-scope check sale con 3 cuando deniega: es una respuesta, no una falla.
        if (error && error.code !== 3) {
          reject(new Error(stderr?.trim() || error.message))
          return
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: error?.code ?? 0 })
      })
  })
}

async function runJson(cmd, args) {
  const { stdout, code } = await run(cmd, args)
  try {
    return { code, data: JSON.parse(stdout || 'null') }
  } catch {
    throw new Error(`${cmd} no devolvio JSON: ${stdout.slice(0, 200)}`)
  }
}

export default function activate(orca) {
  // Al activarse, lo primero es decir si este sistema puede leer WhatsApp. Si no puede,
  // el usuario se tiene que enterar ahora y no cuando una automatizacion lleve una
  // semana sin correr sin explicar por que.
  checkSystem(orca).catch((error) => orca.log(`chequeo inicial fallo: ${error.message}`))

  const tool = async (name) => {
    const s = await settings()
    return join(s.toolsDir || TOOLS, name)
  }

  async function settings() {
    const stored = await orca.host.call('settings.get', { key: 'config' }).catch(() => null)
    return { ...DEFAULT_SETTINGS, ...(stored?.value ?? {}) }
  }

  async function scope() {
    const stored = await orca.host.call('storage.get', { key: SCOPE_KEY }).catch(() => null)
    return stored?.value && typeof stored.value === 'object' ? stored.value : {}
  }

  async function saveScope(next) {
    await orca.host.call('storage.set', { key: SCOPE_KEY, value: next })
    return next
  }

  /** Conversaciones de WhatsApp, ya cruzadas con lo que el usuario mapeo. */
  orca.commands.register('wa-inbox.sync', async (args) => {
    const { data } = await runJson(await tool('wa-read'),
      ['chats', '-n', String(args?.limit ?? 200), '--json'])
    const mapped = await scope()
    return (data ?? []).map((chat) => ({
      ...chat,
      scope: mapped[chat.jid] ?? { mode: 'off', planeProject: null }
    }))
  })

  orca.commands.register('wa-inbox.scope.list', async () => {
    const mapped = await scope()
    return Object.entries(mapped).map(([jid, value]) => ({ chatJid: jid, ...value }))
  })

  /**
   * Un chat activo exige proyecto de Plane: sin el, el agente no sabria donde abrir
   * el issue, y adivinar el proyecto es peor que no actuar.
   */
  orca.commands.register('wa-inbox.scope.set', async (args) => {
    const { chatJid, chatName, planeProject, mode = 'off', initialState, hours } = args ?? {}
    if (!chatJid) throw new Error('falta chatJid')
    if (!MODES.includes(mode)) throw new Error(`modo invalido: ${mode}`)
    if (mode !== 'off' && !planeProject) {
      throw new Error('un chat activo necesita planeProject')
    }
    const next = await scope()
    if (mode === 'off' && !planeProject) {
      delete next[chatJid]
    } else {
      next[chatJid] = {
        chatName: chatName ?? next[chatJid]?.chatName ?? chatJid,
        planeProject: planeProject ?? next[chatJid]?.planeProject ?? null,
        mode,
        initialState: initialState ?? next[chatJid]?.initialState ?? null,
        hours: hours ?? next[chatJid]?.hours ?? 'L-V 08:00-18:00',
        updatedAt: new Date().toISOString()
      }
    }
    await saveScope(next)
    // El registro del CLI es la fuente que leen las automations; mantenerlos alineados.
    if (next[chatJid]) {
      await run(await tool('wa-scope'), ['set', chatJid,
        '--project', String(next[chatJid].planeProject ?? ''),
        '--mode', mode]).catch((error) => orca.log(`wa-scope set fallo: ${error.message}`))
    }
    return next[chatJid] ?? { chatJid, mode: 'off' }
  })

  /** Mensajes dirigidos al usuario, filtrados a los chats que el mismo autorizo. */
  orca.commands.register('wa-inbox.inbox', async (args) => {
    const { data } = await runJson(await tool('wa-read'),
      ['inbox', '--days', String(args?.days ?? 1), '--json'])
    const mapped = await scope()
    const rows = (data ?? []).filter((m) => (mapped[m.chat_jid]?.mode ?? 'off') !== 'off')
    if (rows.length && args?.notify !== false) {
      const s = await settings()
      await orca.host.call('notifications.show', {
        title: s.agentName ? `${s.agentName}: ${rows.length} pendientes`
                           : `${rows.length} mensajes te mencionan`,
        body: rows.slice(0, 3).map((r) => `${r.chat}: ${r.text}`.slice(0, 90)).join('\n')
      }).catch(() => {})
    }
    return rows
  })

  /** Preflight: que el usuario sepa que le falta antes de depender de esto. */
  orca.commands.register('wa-inbox.doctor', async () => {
    if (process.platform !== 'darwin') {
      return {
        ok: false,
        checks: [{ check: 'sistema operativo', ok: false, detalle: process.platform }],
        nota: 'Solo macOS. WhatsApp Web no deja base local y en Windows la base esta ' +
              'en otro formato, sin verificar.'
      }
    }
    const { data } = await runJson(await tool('wa-read'), ['doctor', '--json'])
      .catch(() => ({ data: null }))
    return { ok: !!data && data.every((c) => c.ok), checks: data ?? [] }
  })

  orca.commands.register('wa-inbox.settings', async (args) => {
    if (!args || args.read) return settings()
    const next = { ...(await settings()), ...args }
    await orca.host.call('settings.set', { key: 'config', value: next })
    return next
  })

  orca.events.on('agent.status.changed', (payload) => {
    orca.log(`agente ${payload.state} en ${payload.worktreeId ?? 'sin worktree'}`)
  })
}
