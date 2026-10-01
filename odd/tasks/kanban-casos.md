# Tablero de casos, ejecución aprobada y Jev

## Objetivo

Que cada pedido que llega por WhatsApp sea un **caso** visible en un tablero,
con su etapa, la decisión que se tomó y quién la tomó; que el dueño apruebe con
un clic lo que requiere trabajo; que una automatización ejecute solo lo
aprobado y devuelva el resultado como una tarjeta lista para responder o
cerrar; y que todo quede medido.

## Decisiones del dueño (2026-10-01)

- **Caso local + Plane**: el caso vive en el plugin. Solo el que requiere
  trabajo real abre tarjeta en Plane, enlazada al caso.
- **Aprobación por tarjeta**: lanzar un agente de trabajo exige el clic
  "Ejecutar". Las respuestas simples siguen el modo del chat (`borrador`
  espera aprobación, `responder` sale sola).
- **Llave de Jev propia**: setting secreto del plugin, como el Advisor.

## Restricciones verificadas

- Un plugin no llama a otro; el worker no lanza agentes por la API del host
  (13 métodos). Sí puede: el agente de una automatización con
  `orca worktree create --agent --prompt` / `orca terminal create --agent`.
- Las automatizaciones del plugin son declarativas y arrancan apagadas.
- Jev puede frenar y escalar, nunca habilitar (§9). Falla CERRADO: sin llave,
  con timeout o error, el caso sigue el camino de hoy (agente clasifica) y lo
  ambiguo va al dueño.
- Credenciales nunca pasan por el agente ni por Jev (tabla de clasificación).
- Texto de clientes a `api.typesafe.ai` solo con la llave puesta; config lo
  dice en claro.

## Modelo

`scope.db` (no `capture.db`, mismo motivo que `juicio`):

- `caso` — `case_id`, account, chat_jid, `etapa`, `clase`, `prioridad`,
  título, resumen, `propuesta` (JSON: tipo `responder | trabajar | escalar |
  descartar`, texto de respuesta, instrucciones del trabajo, repo destino),
  `plane_issue`, timestamps.
- `caso_mensaje` — `stanza_id → case_id`: cinco mensajes del mismo pedido son
  UN caso.
- `caso_evento` — cada transición: de, a, `actor` (`agente | jev | dueno |
  automatizacion | trabajador`), detalle, `at`. Es la fuente de toda
  estadística.
- `work`, `juicio` y `agent_action` se conservan; `work` pasa a colgar del caso.
- **Regla de agrupación**: un mensaje nuevo se suma al caso abierto del mismo
  chat si ese caso se actualizó en las últimas N horas (N configurable,
  default 12) y no está Cerrado; si no, abre caso nuevo. El agente puede
  separar o unir explícitamente con `wa-scope caso unir/separar`. Probado.
- **Backfill**: cada fila `work` abierta sin `case_id` se migra a un caso en
  "En trabajo" con su `issue`; `wa-scope closing` sigue funcionando tras la
  migración (probado sobre una `scope.db` con `work` abiertos).
- **Aprobación congelada**: cada propuesta tiene `version` (hash del JSON). La
  decisión del dueño guarda la versión que vio; el ejecutor corre solo esa
  instantánea y rechaza la decisión si la propuesta cambió después (triage
  corre cada 5 min). Sin esto "nada corre sin tu clic" no se cumple.

## Etapas (columnas)

| Etapa | Qué significa | Quién la mueve |
|---|---|---|
| Recibido | Mensajes agrupados en un caso | triage |
| Clasificado | Clase de la tabla + juicio de Jev + prioridad | triage / Jev |
| Tu decisión | Propuesta lista: respuesta, plan de trabajo o escalamiento | espera al dueño |
| En trabajo | Agente desplegado con las instrucciones | ejecutor |
| Listo para responder | Resultado del trabajo + respuesta redactada | trabajador |
| Respondido | `envio` en estado `enviado` | ejecutor / sidecar |
| Cerrado | Terminado o descartado (con motivo) | dueño / ejecutor |

Carril lateral: **Bloqueado** (envío rechazado, agente falló, ruta sin
regla), con el motivo.

Acciones del dueño por tarjeta: Ejecutar · Aprobar respuesta · Editar
respuesta · Escalar a Plane · Cerrar · Reabrir.

## Automatizaciones

- **triage** (existe): agrupa en casos, clasifica (Jev primero, agente si Jev
  no decide), redacta la propuesta y deja la tarjeta en "Tu decisión" — o, en
  chats `responder` con propuesta `responder`, la pasa directo al ejecutor.
- **take** (se conserva el id; las automatizaciones del plugin arrancan
  apagadas y renombrarla dejaría huérfana la que el dueño ya prendió): se
  amplían su pre-check y su prompt para ser el ejecutor. Pre-check = hay
  tarjetas aprobadas; sigue bajo el tope de 1.024 caracteres (test de
  manifiesto).
  Ejecuta exactamente lo que dice la propuesta: envía respuestas aprobadas por
  `wa-send`; para `trabajar` despliega un agente (`orca worktree create
  --agent --prompt`) en el repo de la ruta, con las instrucciones de la
  tarjeta; abre la tarjeta de Plane si corresponde.
- **trabajador** (el agente desplegado): termina con `wa-scope caso resultado
  <id> --respuesta ... --resumen ...`, que crea la tarjeta "Listo para
  responder". Corre en otro repo, sin el resolvedor del plugin: su prompt
  lleva la ruta absoluta a `wa-scope`. Nunca envía por WhatsApp él mismo.

**Supuesto sin verificar (bloquea T5–T6)**: que el agente de una
automatización puede correr `orca worktree create --agent --prompt` y que el
agente desplegado puede reportar de vuelta. Se prueba en vivo antes de T5
(sonda descartable; el worktree se borra después). Si falla, cambia el diseño
del ejecutor.

**Hallazgo de la sonda (2026-10-01)**: una corrida de automatización de Orca
queda `completed` aunque el agente no haya hecho nada (sin sesión de Claude
falló con "Login expired" y la corrida se marcó completa). El ejecutor no se
fía del estado de la corrida: verifica con evidencia (`caso_evento` del
trabajador, `envio` en `enviado`) y si no la hay, la tarjeta va a Bloqueado
con el motivo.

## Jev

Una llamada paralela por caso nuevo: `Choice` sobre la tabla de
clasificación + los `Noul`/`Score` del §9 (pide credencial, dinero, decisión,
urgencia, ingeniería social). Puede: saltar lo que no pide nada, marcar
prioridad, mandar a "Tu decisión". No puede: aprobar ni lanzar trabajo.
Cacheado por `stanza_id` (tabla `juicio`).

## Estadísticas (pestaña del panel)

7 y 30 días: casos por etapa y por clase (qué es lo que más se atiende); por
chat/cliente; decisiones tomadas por actor; tiempo mediano a clasificar, a
responder y a cerrar; esfuerzo (corridas, agentes desplegados, minutos en
trabajo por caso y por clase); envíos enviados/rechazados; Jev (llamadas,
casos resueltos sin modelo grande, latencia, fallos).

## Tareas

- [ ] T0 — Sonda en vivo del despliegue de agente desde una automatización y
      del reporte de vuelta (descartable, worktree limpiado).
- [ ] T1 — Esquema `caso`, `caso_mensaje`, `caso_evento` + migración sobre
      `scope.db` existente; `wa-scope caso` (crear, mover, propuesta,
      resultado, listar, unir, separar) con validación de etapas y transiciones;
      regla de agrupación; backfill de `work` abiertos; versión de propuesta.
- [ ] T2 — Sync: el panel recibe casos por etapa (storage `board`), con tope.
- [ ] T3 — Tablero en `activity.html`: columnas, tarjeta con propuesta y
      acciones; móvil en lista por etapa.
- [ ] T4 — Canal panel → worker → `scope.db` para las acciones del dueño (patrón
      request/result existente) y registro en `caso_evento`.
- [ ] T5 — `triage.md` agrupa en casos y deja propuestas; prompt del trabajador.
- [ ] T6 — `take` ampliada como ejecutor + pre-check de tarjetas aprobadas;
      ejecuta solo la versión aprobada; despliegue del agente; repo destino por
      ruta en config (UI y lógica en el mismo PR).
- [ ] T7 — Setting secreto de Jev, `net:fetch` a `api.typesafe.ai`, espejo 0600
      de la llave; aviso en config de qué sale del equipo.
- [ ] T8 — Cliente TypeSafe en Python stdlib + preguntas del dominio; falla
      cerrado; caché en `juicio`. (Cierra T3/T4 de `juicio-cacheado.md`.)
- [ ] T9 — Pestaña de estadísticas desde `caso_evento`.
- [ ] T10 — Insignia del nav = tarjetas en "Tu decisión" (hoy se queda pegada).
- [ ] T11 — Capturas: tablero y estadísticas, 1440/768/390/320, ES y EN; tema
      claro y oscuro solo si `activity.html` tiene los dos (verificar y decirlo).

La rama del tablero (`feat/tablero-casos`) sale de `main` en v4.9.0, que ya
incluye `fix/linea-muerta`. T0 solo bloquea T5–T6: T1–T4 avanzan sin él.
Se entrega en PRs encadenados: (T1–T4) tablero, (T5–T6) ejecución,
(T7–T8) Jev, (T9–T11) estadísticas.

## Criterios de aceptación

- Un mensaje real recorre Recibido → Clasificado → Tu decisión → (Ejecutar) →
  En trabajo → Listo para responder → Respondido → Cerrado, con cada paso en
  `caso_evento`.
- Nada que requiera trabajo se ejecuta sin el clic del dueño.
- Sin llave de Jev, todo funciona como hoy.
- `npm run check` en exit 0, capturas revisadas.

## Verificación
