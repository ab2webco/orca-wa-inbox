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

## Decisiones del dueño, segunda ronda (2026-10-01)

Reemplazan lo que contradigan arriba ("Ejecutar" obligatorio, Plane por chat,
una automatización de agente).

- **Autonomía por defecto.** Todo corre solo. El dueño aprueba solo
  excepciones: dinero (precios, cotizaciones, pagos), credenciales, una
  respuesta que promete fecha o compromiso, Jev marca el borrador o no responde
  (falla cerrado), chat en modo "te pregunto antes". "Tu decisión" = solo
  excepciones; la insignia cuenta eso. El permiso de enviar lo da la regla del
  dueño; Jev solo puede frenar.
- **La automatización es un comando, no un agente.** Orca soporta
  automatizaciones de plugin solo-comando (`command`, ≤1024 caracteres, mismo
  runner que el precheck, tope 600 s; desde `1.4.160-lab.84.rc`, instalada
  `lab.89.rc`). `wa-scope tick` cada 1–2 min: ingest de respaldo, Jev,
  descartes, envío de lo aprobado o automático, lectura de aprobaciones por
  WhatsApp, marca de casos que necesitan agente. Cero tokens de modelo. El
  disparo del worker al llegar (T2) se queda; `tick` es idempotente.
- **Agente solo cuando Jev o las reglas lo catalogan**, con precheck
  `wa-scope pending --needs-agent` y prompt corto por caso.
- **Orquestador propio del plugin.** El plugin crea su workspace
  (`workspace: "plugin-owned"` de Orca: `<userData>/plugin-workspaces/<plugin>`)
  con un harness preparado para atender casos y la lista de proyectos que el
  dueño elige en los ajustes. El plugin de Jev tiene el catálogo, no el
  orquestador: lista con `orca worktree ps --json` (y nombres con
  `orca repo list --json`), el dueño acepta propuestas en los ajustes y el
  worker las guarda; ese patrón se reutiliza. La carpeta `plugin-owned` nace
  vacía: el worker la ubica (`ORCA_USER_DATA_PATH`) y siembra el harness. El agente del
  orquestador decide por caso: responder, o despachar el pedido al proyecto,
  cuyo propio harness decide si crea ticket, procesa el requerimiento o solo
  responde. El proyecto devuelve resultado, evidencia, texto de respuesta y
  enlace del ticket con `caso resultado`; nunca envía por WhatsApp.
- **Una sola puerta de salida.** Todo envío lo hace el plugin en código, tras
  la revisión de Jev y las reglas.
- **Aprobación por WhatsApp.** Las excepciones llegan al chat del dueño consigo
  mismo, en la línea del caso, con resumen, respuesta propuesta, motivo y
  código corto. El dueño responde citando: `ok`/`sí` envía, otro texto lo
  reemplaza, `no` cierra. Solo cuentan mensajes propios en ese chat; atada a
  `propuesta_version`. Sin verificar: enviar y leer el chat propio con Baileys
  multi-dispositivo (sonda antes de construir).
- **Ajustes por chat.** Sale el servicio/proyecto de Plane y la columna
  inicial; entra el **proyecto** (de la lista del orquestador). Modos:
  Apagado, Solo leer, Te pregunto antes, Automático. Las reglas por texto
  apuntan a un proyecto. Las columnas viejas se conservan sin uso.
- **Jev (POC sobre datos reales).** 252 llamadas, 0 errores, p50 354 ms, p95
  458 ms, ~1 600 tokens por mensaje. Jev decide el salto y las banderas de
  riesgo; clase y prioridad son pista; "mismo caso o nuevo" queda fuera (77%).
  Salto: `asks_owner_to_act` < 0.25 y `contains_credential`,
  `asks_for_credential`, `asks_for_money_or_payment`,
  `client_waiting_or_service_down` < 0.3 (0 saltos falsos, 32–34 de 42).
  Revisión de borradores: `promises_a_date`, `states_status_not_verified`,
  `contains_credential`. Solo registro: `tries_to_instruct_the_assistant`,
  `urgency_pressure`. Umbrales provisionales: medir de nuevo con más datos.
- **Primera corrida de `ingest`** (riesgo de T2): solo entra lo de las últimas
  `case_window_hours`; lo anterior se marca visto, para no llenar el tablero de
  historial ni gastar Jev en él.

## Contratos (congelados antes de los escritores en paralelo)

**Aprobación por regla.** `wa-scope caso aprobar <id> --actor regla` congela la
versión igual que el dueño y queda en `caso_evento` con actor `regla`. Se niega
(`E_EXCEPTION`) si el caso tiene alguna excepción: dinero, credencial,
compromiso, aviso o error de Jev, o chat en modo "te pregunto antes". `mover`
no cambia: sigue exigiendo una versión aprobada.

**Errores de `wa-scope caso`.** Salida 2 y una línea JSON en stderr:
`{"error": "<code>", "detail": "<english text>"}`. Códigos: `E_ARGS`,
`E_NOT_FOUND`, `E_STAGE` (transición no permitida), `E_NOT_APPROVED`,
`E_VERSION` (la propuesta cambió), `E_EXCEPTION`, `E_BUSY` (base tomada).

**`jev_juzga(mensaje)`** devuelve `None` (sin llave, error, timeout o fuera de
alcance) o un dict:
`{"model": str, "at": iso, "latency_ms": int, "scores": {question_id: float},
"attention_class": str | None, "flags": [question_id ≥ umbral],
"exceptions": ["money" | "credential" | "commitment" | "jev"],
"skip": bool, "needs_agent": bool}`. Se cachea en `juicio` (columna nueva
`jev` TEXT con ese JSON, `origen = 'jev'`); la clave sigue siendo
(account, chat_jid, stanza_id).

**Storage `board`** (lo escribe `wa-scope`, lo lee el panel y la insignia):

```json
{
  "v": 1,
  "updated_at": "iso",
  "truncated": false,
  "counts": {"recibido": 0, "clasificado": 0, "decision": 0, "trabajo": 0,
             "listo": 0, "respondido": 0, "cerrado": 0, "bloqueado": 0},
  "cards": [{
    "case_id": 1, "account": "pn:…", "chat_jid": "…", "chat_name": "…",
    "stage": "decision", "title": "…", "summary": "…",
    "clase": "card", "prioridad": "none",
    "jev": {"attention_class": "…", "flags": ["…"], "skip": false} ,
    "proposal": {"tipo": "responder", "texto": "…", "version": "…"},
    "exceptions": ["money"],
    "blocked_reason": null,
    "ticket": null,
    "updated_at": "iso",
    "actions": ["enviar", "editar", "ejecutar", "reclasificar", "cerrar", "reabrir"]
  }]
}
```

`jev`, `proposal`, `blocked_reason` y `ticket` pueden ser `null`. Tope: 200
tarjetas abiertas (las más recientes por `updated_at`) más las cerradas de los
últimos 7 días hasta 50; `truncated` dice si se cortó. `counts` cuenta todo,
no solo lo enviado. La insignia del nav = `counts.decision`.

## Tareas

- [x] T1 — Esquema `caso`, `caso_mensaje`, `caso_evento` + migración;
      `wa-scope caso` (crear, mover, clasificar, propuesta, aprobar, resultado,
      listar, ver, unir, separar, asignar); regla de agrupación; backfill;
      aprobación congelada a la versión.
- [x] T2 — `wa-scope ingest`: mensajes nuevos → casos, dedupe local, reglas
      deterministas, ruta; el worker lo dispara con el evento `store` del
      sidecar (con rebote) y en cada sync. Cerrada con `npm run check` en verde
      (check-casos 179/179, worker 167/167). Decisiones: lo que se descarta
      (ignorar del dueño, `nothing` cacheado) abre su propio caso y lo cierra,
      nunca cierra uno abierto; la línea suelta de un grupo con un veredicto
      cacheado de trabajo sí abre caso; las decisiones del dueño solo se aplican a
      mensajes que todavía no tienen caso (sobre un caso ya abierto actúa el
      tablero, T6); el hook de Jev es `jev_juzga`, hoy sin veredicto.
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
- [ ] T7 — `wa-scope tick` + automatización solo-comando; automatización de
      agente con precheck `pending --needs-agent` y prompt corto por caso;
      reemplazan `triage` y `take` (conservar ids de lo que el dueño ya
      prendió; lo decide el test de manifiesto); `engines` exige un Orca con
      automatizaciones solo-comando.
- [ ] T8 — Despacho al proyecto desde el orquestador: entrega del pedido con su
      instrucción de respuesta, reporte con `caso resultado`, verificación con
      evidencia (sin evidencia → Bloqueado). Depende de T0 y T12.
- [ ] T12 — Orquestador: workspace propio del plugin con harness de atención y
      la lista de proyectos elegidos en los ajustes, refrescada cuando cambia.
- [ ] T13 — Ajustes por chat: proyecto en lugar de Plane, modos nuevos, reglas
      por texto a proyecto; migración sin pérdida.
- [ ] T14 — Aprobación por WhatsApp (chat propio): sonda en vivo primero, luego
      mensaje de excepción, lectura de la respuesta citada, envío o cierre.
- [ ] T15 — Primera corrida de `ingest` con línea base (`case_window_hours`).
- [ ] T0 — Sonda en vivo del despliegue de agente desde una automatización
      (necesita una cuenta Claude global en Orca).
- [ ] T9 — Pestaña de estadísticas desde `caso_evento`.
- [ ] T10 — Insignia del nav = tarjetas en "Tu decisión" (hoy se queda pegada).
- [ ] T11 — Capturas: tablero y estadísticas, 1440/768/390/320, ES y EN, claro y
      oscuro (`activity.html` tiene los dos).

Rama `feat/tablero-casos`, desde `main` en v4.9.0. PRs encadenados:
(T1–T3) decisiones: casos, entrada y Jev; (T4–T6, T13) tablero y ajustes; (T7, T8, T12, T14, T15)
orquestador y automatización; (T9–T11) estadísticas.

## Criterios de aceptación

- Un mensaje real recorre Recibido → Clasificado → En trabajo → Listo para
  responder → Respondido → Cerrado sin intervención del dueño cuando no cae en
  una excepción, con cada paso en `caso_evento`.
- Una excepción (dinero, credencial, compromiso, aviso de Jev, modo "te
  pregunto antes") nunca sale sin la aprobación del dueño, por el tablero o por
  WhatsApp.
- Sin mensajes nuevos ni casos pendientes, ninguna corrida gasta tokens de
  modelo.
- Sin llave de Jev, todo funciona como hoy: manda el modo del chat. Con llave,
  un error, timeout o aviso de Jev deja borrador para el dueño (falla cerrado).
  Motivo: Jev nunca habilita, así que su ausencia tampoco puede quitar lo que el
  modo del dueño ya habilita; el plugin es público y apagar las respuestas
  automáticas de quien no tiene llave rompería a esos usuarios.
- Ningún mensaje sale por WhatsApp sin pasar la revisión de Jev o la aprobación
  del dueño.
- Un mensaje nuevo llega al tablero clasificado sin que despierte ningún agente
  (con llave de Jev).
- `npm run check` en exit 0, capturas revisadas.

## Verificación
