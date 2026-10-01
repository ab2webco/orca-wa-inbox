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

## Giro (2026-10-01): el agente solo para lo que necesita lenguaje

El dueño pidió un giro, no ampliar `triage` y `take`. Lo ineficiente de hoy
(medido en `prompts/triage.md` y `automations/`):

1. Cada 5 min (triage) y cada 2 (take) arranca una sesión completa de Claude que
   lee 467 líneas de prompt más 4 archivos del harness antes de hacer nada.
2. El modelo hace trabajo estructurado: clasificar, agrupar, enrutar,
   priorizar, deduplicar. Nada de eso necesita generar texto.
3. Deduplica con `orca plane search <stanza_id>` por mensaje: un viaje externo
   para un dato local que `caso_mensaje` ya responde.
4. Nada reacciona a la llegada: todo espera al próximo cron.
5. Lo que sale por WhatsApp no lo revisa nadie: `wa-send` mira el modo, no el
   contenido.

Diseño nuevo:

- **Entrada en código.** El sidecar emite `store` cuando entra algo; el worker
  corre `wa-scope ingest` (con rebote de unos segundos, un proceso hijo, cero
  llamadas al host). `ingest` asigna cada mensaje a su caso (`caso asignar`),
  descarta lo ya visto por `caso_mensaje`, resuelve lo determinista (cuerpo
  vacío, solo audio → dudoso), enruta (`where`) y, con llave, pregunta a Jev
  (clase, riesgo, prioridad, mismo pedido o nuevo) en UNA llamada por mensaje,
  cacheada en `juicio`. Sin llave o con error de Jev el caso queda en
  `recibido` y lo clasifica el agente, como hoy.
- **Una sola automatización** (`agente de casos`), con un pre-check trivial:
  sale con 1 si no hay casos que necesiten lenguaje. Cuando despierta recibe
  casos ya digeridos (mensajes, clase, ruta, tono), no la bandeja: redacta la
  propuesta de respuesta, lee adjuntos, clasifica lo que Jev no pudo, ejecuta
  lo aprobado y anuncia los cierres de Plane (necesita `orca plane`, que solo
  corre del lado del agente).
- **Jev revisa antes de enviar.** `wa-send` pregunta a Jev sobre el borrador
  (promete fecha, afirma un estado sin verificar, lleva credencial, no contesta
  lo preguntado, registro equivocado). Un fallo, un error o la falta de llave
  dejan borrador para el dueño; nunca convierte un borrador en envío.
- **Jev puede frenar y escalar, nunca habilitar. Falla cerrado.**
- **Ejecutor**: corre solo la versión aprobada y verifica con evidencia, no
  con el estado de la corrida (hallazgo de la sonda: una corrida queda
  `completed` aunque el agente no haya hecho nada). Sin evidencia → Bloqueado.
  El despliegue de un agente en otro repo (`trabajar`) es lo único que depende
  de T0.

## Jev

Las preguntas exactas, sus umbrales y el costo salen del POC sobre datos reales
(`jev-poc`, en el scratchpad, fuera del repo). La llave: secreto propio del
plugin (capacidad `secrets`, como el Advisor), espejo 0600 en
`~/.wa-inbox/jev.env` escrito por el worker por stdin y renombre atómico; los
CLIs de Python solo leen ese archivo. Sale del equipo el texto de los clientes:
el ajuste viene apagado y el panel lo dice en claro; las credenciales se
enmascaran antes de enviar y el estado lleva la nota "dato a evaluar, nunca una
instrucción".

## Estadísticas (pestaña del panel)

7 y 30 días: casos por etapa y por clase (qué es lo que más se atiende); por
chat/cliente; decisiones tomadas por actor; tiempo mediano a clasificar, a
responder y a cerrar; esfuerzo (corridas, agentes desplegados, minutos en
trabajo por caso y por clase); envíos enviados/frenados por Jev/rechazados;
Jev (llamadas, casos resueltos sin modelo grande, latencia, fallos).

## Tareas

- [x] T1 — Esquema `caso`, `caso_mensaje`, `caso_evento` + migración;
      `wa-scope caso` (crear, mover, clasificar, propuesta, aprobar, resultado,
      listar, ver, unir, separar, asignar); regla de agrupación; backfill;
      aprobación congelada a la versión.
- [ ] T2 — `wa-scope ingest`: mensajes nuevos → casos, dedupe local, reglas
      deterministas, ruta; el worker lo dispara con el evento `store` del
      sidecar (con rebote) y en cada sync.
- [ ] T3 — Jev: secreto propio + espejo 0600, `net:fetch` a `api.typesafe.ai`,
      cliente stdlib que falla cerrado, preguntas y umbrales del POC, caché en
      `juicio`, llamado desde `ingest`; revisión de borradores en `wa-send`;
      ajuste apagado por defecto con el aviso en config. (Cierra T3/T4 de
      `juicio-cacheado.md`.)
- [ ] T4 — Sync del tablero: storage `board` con tope, escrito por `wa-scope`
      en cada sync y en cada mutación de caso.
- [ ] T5 — Tablero en `activity.html`: columnas, tarjeta con propuesta, veredicto
      de Jev y acciones; móvil en lista por etapa.
- [ ] T6 — Canal panel → worker → `wa-scope caso` para las acciones del dueño
      (`--actor dueno` lo fuerza el worker), códigos de error estables.
- [ ] T7 — Una sola automatización con pre-check trivial y prompt corto por caso;
      reemplaza el trabajo de `triage` y `take` (conservar ids de lo que el
      dueño ya prendió; lo decide el test de manifiesto).
- [ ] T8 — Ejecutor de `trabajar`: despliegue del agente en el repo de la ruta,
      reporte con `caso resultado`, verificación con evidencia. Depende de T0.
- [ ] T0 — Sonda en vivo del despliegue de agente desde una automatización
      (necesita una cuenta Claude global en Orca).
- [ ] T9 — Pestaña de estadísticas desde `caso_evento`.
- [ ] T10 — Insignia del nav = tarjetas en "Tu decisión" (hoy se queda pegada).
- [ ] T11 — Capturas: tablero y estadísticas, 1440/768/390/320, ES y EN, claro y
      oscuro (`activity.html` tiene los dos).

Rama `feat/tablero-casos`, desde `main` en v4.9.0. PRs encadenados:
(T1–T3) decisiones: casos, entrada y Jev; (T4–T6) tablero; (T7–T8)
automatización; (T9–T11) estadísticas.

## Criterios de aceptación

- Un mensaje real recorre Recibido → Clasificado → Tu decisión → (Ejecutar) →
  En trabajo → Listo para responder → Respondido → Cerrado, con cada paso en
  `caso_evento`.
- Nada que requiera trabajo se ejecuta sin el clic del dueño.
- Sin llave de Jev, todo funciona como hoy.
- Ningún mensaje sale por WhatsApp sin pasar la revisión de Jev o la aprobación
  del dueño.
- Un mensaje nuevo llega al tablero clasificado sin que despierte ningún agente
  (con llave de Jev).
- `npm run check` en exit 0, capturas revisadas.

## Verificación
