/**
 * Una clave `reports` de ejemplo (odd/tasks/informes-tablero.md, "Storage key reports"),
 * con la forma exacta que escribe `wa-scope sync`. La usan la prueba de los paneles y las
 * capturas: los datos son de mentira a proposito (el repositorio es publico), y las fechas
 * se arman alrededor de "ahora" para que cada periodo tenga lo suyo el dia que se corra.
 */
const dos = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`

/** La medianoche local de hace `n` dias. */
function medianoche (ahora, n) {
  const d = new Date(ahora)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - n)
  return d
}

/** 24 horas con un perfil de oficina: casi nada de noche, picos a media manana y tarde. */
function horas (escala, semilla) {
  const forma = [0, 0, 0, 0, 0, 0, 1, 2, 5, 9, 12, 10, 6, 7, 10, 11, 8, 5, 3, 2, 1, 1, 0, 0]
  return forma.map((v, h) => Math.round(v * escala * (1 + ((semilla * 7 + h * 3) % 5) / 10)))
}

const T = (value, n, prev, prevN, delta, bars) =>
  ({ value, n, prev, prev_n: prevN, delta_pct: delta, bars })

/** Un periodo con datos. `dias` null = Todo. */
function periodo (ahora, dias, extra) {
  const hoy = medianoche(ahora, 0)
  const bucket = dias === 1 ? 'hour' : dias === null ? 'week' : 'day'
  const rows = dias !== null && dias <= 7 ? 'date' : 'weekday'
  let claves
  if (bucket === 'hour') {
    claves = Array.from({ length: ahora.getHours() + 1 }, (_, h) => `${ymd(hoy)} ${dos(h)}`)
  } else if (bucket === 'day') {
    claves = Array.from({ length: dias }, (_, i) => ymd(medianoche(ahora, dias - 1 - i)))
  } else {
    const lunes = medianoche(ahora, (hoy.getDay() + 6) % 7)
    claves = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(lunes)
      d.setDate(d.getDate() - 7 * (11 - i))
      return ymd(d)
    })
  }
  const barrasT = (base) => claves.map((k, i) =>
    ({ k, value: i % 4 === 3 ? null : base + ((i * 37) % 5) * Math.round(base / 6), n: i % 4 === 3 ? 0 : 1 + (i % 3) }))
  const filasTrafico = (escala) => rows === 'date'
    ? Array.from({ length: dias }, (_, i) => ({ k: ymd(medianoche(ahora, dias - 1 - i)), h: horas(escala, i) }))
    : Array.from({ length: 7 }, (_, i) => ({ k: i + 1, h: horas(i >= 5 ? escala / 4 : escala, i) }))
  const desde = dias === null ? null : medianoche(ahora, dias - 1)
  return Object.assign({
    from: desde ? desde.toISOString() : null,
    to: ahora.toISOString(),
    prev_from: desde ? medianoche(ahora, 2 * dias - 1).toISOString() : null,
    prev_to: desde ? new Date(ahora.getTime() - dias * 86400000).toISOString() : null,
    bucket,
    rows,
    first_response: T(754, 18, 900, 20, -16, barrasT(700)),
    resolution: T(13800, 15, 7200, 14, 92, barrasT(12000)),
    customer_wait: Object.assign(T(420, 40, 0, 0, null, barrasT(400)), { unanswered: 3 }),
    volume: {
      totals: { chats: 12, received: 12345, sent: 9876, created: 18, resolved: 15 },
      prev: { chats: 11, received: 11022, sent: 10181, created: 0, resolved: 15 },
      delta_pct: { chats: 9, received: 12, sent: -3, created: null, resolved: 0 },
      bars: claves.map((k, i) => ({ k, chats: 3 + (i % 4), received: 40 + ((i * 53) % 90),
        sent: 30 + ((i * 41) % 70), created: 1 + (i % 3), resolved: i % 4 }))
    },
    traffic: { received: filasTrafico(3), resolved: filasTrafico(0.4) },
    sla: {
      met: 14,
      missed: 3,
      pending: 1,
      rate: 82.4,
      prev_rate: 75,
      delta_pts: 7.4,
      misses: [
        // Texto de clientes: se pinta como texto, nunca como HTML.
        { case_id: 41, title: 'Factura <b>duplicada</b>', chat: 'Cliente Uno',
          first_response_s: 2400, project: 'Beta Demo' },
        { case_id: 37, title: 'Sin acceso al panel', chat: 'Soporte Norte',
          first_response_s: null, project: null }
      ],
      misses_more: 1
    },
    projects: [
      { id: 'alfa-demo', name: 'Alfa Demo', cases: 10, resuelto: 6, necesita: 2, bloqueado: 1,
        jev_held: 2, owner_decision: 3 },
      { id: 'beta-demo', name: 'Beta Demo', cases: 5, resuelto: 3, necesita: 1, bloqueado: 0,
        jev_held: 0, owner_decision: 1 },
      { id: null, name: null, cases: 3, resuelto: 0, necesita: 0, bloqueado: 0, jev_held: 0,
        owner_decision: 2 }
    ]
  }, extra || {})
}

/** "Todo" no tiene periodo anterior: ninguna comparacion. */
function sinComparar (p) {
  const t = (x) => Object.assign({}, x, { prev: null, prev_n: null, delta_pct: null })
  return Object.assign({}, p, {
    first_response: t(p.first_response),
    resolution: t(p.resolution),
    customer_wait: t(p.customer_wait),
    volume: Object.assign({}, p.volume, { prev: null, delta_pct: null }),
    sla: Object.assign({}, p.sla, { prev_rate: null, delta_pts: null })
  })
}

/** Las filas del CSV: creadas hoy, hace 3 dias y hace 20, con lo que hay que escapar. Las
 *  filas no traen titulo (`wa-scope` ya no lo manda); la 50 lo trae como una clave de antes,
 *  y el CSV no lo copia igual. */
function casos (ahora) {
  const a = (dias, h) => {
    const d = medianoche(ahora, dias)
    d.setHours(h, 15, 0, 0)
    return d.toISOString()
  }
  return [
    { case_id: 52, chat: 'Soporte, "Norte"', created: new Date(ahora.getTime() - 60000).toISOString(),
      first_response_s: 300, resolution_s: null, stage: 'decision', project: 'Alfa Demo', sla: 'met' },
    { case_id: 51, chat: '=Cliente Uno', created: a(3, 10),
      first_response_s: 2400, resolution_s: 7200, stage: 'respondido', project: null, sla: 'missed' },
    { case_id: 50, chat: 'Soporte Norte', title: 'Otra linea\ncon salto', created: a(3, 9),
      first_response_s: null, resolution_s: null, stage: 'recibido', project: 'Beta Demo', sla: 'pending' },
    { case_id: 49, chat: 'Cliente Uno', created: a(20, 11),
      first_response_s: 60, resolution_s: 600, stage: 'cerrado', project: 'Alfa Demo', sla: null }
  ]
}

export function informeDeEjemplo (ahora = new Date()) {
  return {
    v: 1,
    account: 'local',
    updated_at: new Date(ahora.getTime() - 60000).toISOString(),
    sla_minutes: 15,
    live: { open: 7, decision: 3, waiting_customer: 2, blocked: 1, conversations: 14 },
    // La maquinaria, al dia: el agente produjo hace un rato, asi que no hay aviso.
    engine: {
      verdicts: { card: 90, alert: 2, doubtful: 27, nothing: 95 },
      agent_output: { draft: 28, issue: 2, sent: 7 },
      agent_last_output_at: '2026-10-09 09:10:00',
      agent_silent_s: 3600,
      agent_stalled: false
    },
    periods: {
      today: periodo(ahora, 1),
      '7d': periodo(ahora, 7),
      '30d': periodo(ahora, 30),
      all: sinComparar(periodo(ahora, null))
    },
    cases: casos(ahora),
    cases_more: 0
  }
}

/** Una linea recien vinculada: todo en cero o sin valor, sin reventar. */
export function informeVacio (ahora = new Date()) {
  const vacioT = (bars) => ({ value: null, n: 0, prev: null, prev_n: 0, delta_pct: null, bars })
  const unPeriodo = (dias) => {
    const base = periodo(ahora, dias)
    const cero = { chats: 0, received: 0, sent: 0, created: 0, resolved: 0 }
    const sinValor = base.first_response.bars.map((b) => ({ k: b.k, value: null, n: 0 }))
    return Object.assign(base, {
      first_response: vacioT(sinValor),
      resolution: vacioT(sinValor),
      customer_wait: Object.assign(vacioT(sinValor), { unanswered: 0 }),
      volume: { totals: cero, prev: dias ? cero : null,
        delta_pct: dias ? { chats: null, received: null, sent: null, created: null, resolved: null } : null,
        bars: base.volume.bars.map((b) => Object.assign({ k: b.k }, cero)) },
      traffic: { received: base.traffic.received.map((f) => ({ k: f.k, h: Array(24).fill(0) })),
        resolved: base.traffic.resolved.map((f) => ({ k: f.k, h: Array(24).fill(0) })) },
      sla: { met: 0, missed: 0, pending: 0, rate: null, prev_rate: null, delta_pts: null,
        misses: [], misses_more: 0 },
      projects: []
    })
  }
  return {
    v: 1,
    account: 'local',
    updated_at: new Date(ahora.getTime() - 60000).toISOString(),
    sla_minutes: 15,
    live: { open: 0, decision: 0, waiting_customer: 0, blocked: 0, conversations: 0 },
    periods: { today: unPeriodo(1), '7d': unPeriodo(7), '30d': unPeriodo(30), all: unPeriodo(null) },
    cases: [],
    cases_more: 0
  }
}
