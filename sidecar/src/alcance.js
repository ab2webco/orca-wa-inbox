// El alcance: que conversaciones puede tocar el agente, preguntado a quien lo sabe.
//
// Esto NO reimplementa la autorizacion. `bin/wa-scope` mantiene el registro
// —`chat_scope`, con la escalera `off/observar/borrador/responder`— y su `merged_scope`
// cruza dos origenes: la tabla del CLI y lo que el usuario acaba de tocar en el panel,
// que vive en el `storage.json` del plugin. Copiar ese cruce aca seria tener dos
// verdades sobre quien esta autorizado, y el dia que discrepen el sidecar guardaria
// —o dejaria de guardar— lo contrario de lo que dice la pantalla.
//
// Denegar por defecto es ESTRUCTURAL y no una convencion: `merged_scope` nunca
// sintetiza una fila por defecto, y lo que no esta en el mapa esta en `off`
// (docs/ENCARGO-TRANSPORTE-UNICO.md §5). Si la consulta falla, el mapa no cambia; si
// nunca se pudo cargar, no se guarda nada. Un fallo de lectura no puede abrir permisos.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// Cada cuanto se vuelve a preguntar. El usuario autoriza un chat desde el panel y
// espera que el proximo mensaje ya entre; 30 s es lo que tarda en dejar de parecer
// roto, y son dos subprocesos cortos por minuto, no por mensaje.
export const ALCANCE_TTL_MS = 30000

const SEPARADOR = '\u0000'

export function llave (cuenta, jid) {
  return `${cuenta}${SEPARADOR}${jid}`
}

/** De las filas de `wa-scope list --json` al mapa `(cuenta, jid) -> modo`.
 *
 *  La llave lleva la cuenta adelante y NUNCA es el jid solo: dos lineas propias pueden
 *  tener la misma conversacion —el directo con la misma persona visto desde dos numeros
 *  propios es el mismo `...@s.whatsapp.net`— y con el jid solo esas dos autorizaciones
 *  distintas se funden en una (§11-A1). */
export function mapaDeAlcance (filas) {
  const mapa = new Map()
  for (const fila of Array.isArray(filas) ? filas : []) {
    const jid = fila?.chat_jid
    if (!jid) continue
    mapa.set(llave(fila.account || 'local', jid), fila.mode || 'off')
  }
  return mapa
}

/** El modo de una conversacion. Lo que no esta, esta en `off`. */
export function modoEn (mapa, cuenta, jid) {
  return mapa?.get(llave(cuenta, jid)) || 'off'
}

/** De las filas de `wa-scope config --json` a los topes de retencion. Son AJUSTES y no
 *  constantes: son retencion de texto ajeno, no rendimiento, y bajarlos tiene que poder
 *  hacerse desde el panel sin tocar codigo (§11-F2). */
export function topesDe (filas, previos = { max: 20000, dias: 90 }) {
  const valores = {}
  for (const fila of Array.isArray(filas) ? filas : []) {
    if (fila?.key) valores[fila.key] = fila.value
  }
  const entero = (clave, porDefecto) => {
    const n = parseInt(String(valores[clave] ?? '').trim(), 10)
    return Number.isFinite(n) && n > 0 ? n : porDefecto
  }
  return { max: entero('capture_max', previos.max), dias: entero('capture_days', previos.dias) }
}

/**
 * El alcance vivo, con su cache. `toolsDir` lo pasa el worker: las herramientas viajan
 * juntas y buscarlas en el PATH ya habia mandado a una a la instalacion equivocada
 * (§11-E4).
 */
export function crearAlcance ({ toolsDir, ejecutar = correr, ttlMs = ALCANCE_TTL_MS,
  ahora = () => Date.now() }) {
  let mapa = new Map()
  let topes = { max: 20000, dias: 90 }
  let cargadoEn = 0
  let cargoAlgunaVez = false

  function refrescar (forzar = false) {
    if (!toolsDir) return false
    if (!forzar && ahora() - cargadoEn < ttlMs) return cargoAlgunaVez
    cargadoEn = ahora()
    try {
      const nuevo = mapaDeAlcance(JSON.parse(ejecutar(join(toolsDir, 'wa-scope'),
        ['list', '--json']) || '[]'))
      // Solo se reemplaza con una respuesta que se pudo parsear. Un `wa-scope` que
      // fallo no puede vaciar el mapa: eso apagaria la captura de todo en silencio, y
      // un silencio se ve igual que una semana tranquila (§11-E5).
      mapa = nuevo
      cargoAlgunaVez = true
    } catch {
      return cargoAlgunaVez
    }
    try {
      topes = topesDe(JSON.parse(ejecutar(join(toolsDir, 'wa-scope'),
        ['config', '--json']) || '[]'), topes)
    } catch {
      // Sin ajustes se usan los topes anteriores, que arrancan en los de fabrica.
    }
    return true
  }

  return {
    refrescar,
    /** Deniega por defecto, y tambien mientras no se haya podido cargar nunca. */
    modo: (cuenta, jid) => (cargoAlgunaVez ? modoEn(mapa, cuenta, jid) : 'off'),
    topes: () => ({ ...topes }),
    listo: () => cargoAlgunaVez,
    // Para poder decir "llegaron 40 y se guardaron 0 porque no hay ninguna autorizada"
    // en vez de dejar una bandeja vacia sin explicacion.
    autorizadas: () => [...mapa.values()].filter((m) => m && m !== 'off').length
  }
}

function correr (cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 8 << 20 })
}
