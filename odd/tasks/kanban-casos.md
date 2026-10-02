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
    "actions": ["enviar", "editar", "ejecutar", "reclasificar", "cerrar", "reabrir"],
    "dispatch": {"project": "Alfa Demo", "state": "activo", "outcome": null,
                 "at": "iso", "updated_at": "iso"}
  }]
}
```

`dispatch` (T8) es el ultimo despacho del caso al agente del proyecto, o `null`. Solo
viaja cuando dice algo de la etapa: en `trabajo` (lanzando, activo, o la respuesta del
cliente por entregar), en `listo` con lo que reporto (`outcome` resuelto o necesita), en
`respondido` esperando al cliente y en `bloqueado` por el agente.

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
- [x] T3 — Jev: secreto propio + espejo 0600, `net:fetch` a `api.typesafe.ai`,
      cliente stdlib que falla cerrado, preguntas y umbrales del POC, caché en
      `juicio`, llamado desde `ingest`; revisión de borradores en `wa-send`;
      ajuste apagado por defecto con el aviso en config. (Cierra T3/T4 de
      `juicio-cacheado.md`.)
      Cerrada en W1 (a9abae5, 152eb67) y W3 (29d78a1, c7c5f90, f97d0dc); parser verificado contra respuestas reales del POC.
- [x] T4 — Sync del tablero: storage `board` con tope, escrito por `wa-scope`
      en cada sync y en cada mutación de caso.
      Cerrada en W1 (d4fe893).
- [x] T5 — Tablero en `activity.html`: columnas, tarjeta con propuesta, veredicto
      de Jev y acciones; móvil en lista por etapa.
      Solo lectura cerrada en W2 (5e66fbd, 6f7e229); las acciones entran con T6.
- [x] T6 — Canal panel → worker → `wa-scope caso` para las acciones del dueño
      (`--actor dueno` lo fuerza el worker), códigos de error estables.
      Cerrada en W1 (7f5e775); `npm run check` verde tras integrar la ronda 2.
- [x] T7 — `wa-scope tick` + automatización solo-comando; automatización de
      agente con precheck `pending --needs-agent` y prompt corto por caso;
      reemplazan `triage` y `take` (conservar ids de lo que el dueño ya
      prendió; lo decide el test de manifiesto); `engines` exige un Orca con
      automatizaciones solo-comando.
      Cerrada en W3 (8e36089, 5250852; integrada 7b8b06b): `tick` cada minuto sin
      modelo y `workspace: plugin-owned`; `triage` conserva su id con precheck
      `--needs-agent`; `take` se borra; `engines >=1.4.160`. Check verde.
- [ ] T8 — Despacho al proyecto desde el orquestador: entrega del pedido con su
      instrucción de respuesta, reporte con `caso resultado`, verificación con
      evidencia (sin evidencia → Bloqueado). Depende de T0 y T12.
      Diseño acordado con el dueño (2026-10-01): el agente del caso actúa como
      orquestador.
      1. Toma el caso entero (la ráfaga de mensajes, no el último; ver el arreglo de
         ráfagas) y el proyecto del caso.
      2. Mira el proyecto en solo lectura (repo, PROJECTS.md, Plane) y decide:
         - responder él mismo si es una respuesta;
         - crear la tarea en Plane (`orca plane create`, con el brief completo: mensajes,
           enlaces, cliente, qué hacer, qué responder) y despacharla al agente del
           proyecto por orquestación de Orca (`orchestration task-create` +
           `worker-start` en el workspace del proyecto, con el orquestador como
           coordinador);
         - o dejarla en Plane para un humano.
      3. El trabajador reporta con `wa-scope caso resultado` (resumen, respuesta,
         evidencia): el resultado no depende del buzón de orquestación. Nunca llama a
         `wa-send`; solo `tick` envía, con el piso de salida.
      4. Sin evidencia → Bloqueado. Sin resultado en N horas → Bloqueado ("sin respuesta
         del proyecto"). Un fallo de cuenta o de lanzamiento se ve en Bloqueado, nunca
         en silencio.
      5. El permiso va por chat (su modo) y por proyecto (aceptado en ajustes, con su
         proyecto de Plane): Automático sin excepción despacha solo; lo demás lo
         aprueba el dueño.
      6. Las corridas de trabajadores entran en la limpieza de workspaces de `tick`.
      Sondas: la orquestación está activa (`task-list` pide un Run); una
      automatización solo-comando sí llama a `orca orchestration` (run-list OK);
      `caso resultado` existe; T0 queda probado por las corridas de triage.
      Va después de desplegar la tanda de arreglos en curso (tablero-w6).
      Hecho en tablero-w9 (falta la prueba E2E en vivo, por eso sigue abierta):
      - `tick` despacha solo, sin agente que lo dispare: un caso que entró a `trabajo` por
        una firma (desde `decision` o `listo`) con su `trabajar` aprobado en la versión
        vigente. Lo que puso ahí el backfill no se despacha nunca. Uno por tick, dentro de
        `PRESUPUESTO_TICK_S` (si el lanzamiento entero no cabe, espera al minuto siguiente).
      - `caso_despacho` (tabla nueva, `create if not exists`: una `scope.db` vieja la gana
        sola) con una fila por entrada firmada a `trabajo`, escrita `lanzando` dentro del
        candado del tick ANTES de llamar a Orca. Una fila `lanzando` de más de 10 min (el
        tick murió a mitad) no se relanza: va a Bloqueado.
      - El proyecto del caso (o del chat) se resuelve con `orca worktree list`: por su ruta,
        y si no, por nombre visible exacto. Uno → `id:<repoId>::<path>`; cero o varios →
        Bloqueado ("no encuentro el proyecto X" / "X es ambiguo"). Sin proyecto, también.
      - `run-create` → `task-create --spec <brief>` → `worker-start --from <coordinador>
        --worktree <selector> --agent claude`. El brief va en inglés: el caso, cada mensaje
        tal cual en orden (transcripciones, adjuntos, lo ya contestado), lo aprobado, lo
        que reportaron agentes anteriores, las reglas (nunca wa-send, nada destructivo,
        no afirmar quién es nadie) y los tres comandos exactos con la ruta absoluta.
      - Vivo = su terminal en `orca terminal list --worktree <selector>`. Sin terminal ni
        resultado → Bloqueado ("terminó sin reportar"); sin resultado en 4 h → Bloqueado y
        `worker-stop` (tolera `stop_unknown`); cualquier error de Orca → Bloqueado con su
        texto. Nada se relanza solo; una firma nueva es un despacho nuevo.
      - Ampliación del dueño: `caso resultado --estado resuelto|necesita|bloqueado`
        (`resuelto` por defecto). `necesita` manda la pregunta y el caso espera al cliente
        (en `respondido`, con el despacho `esperando`); lo que conteste vuelve a `trabajo`
        (solo el motor: `caso mover` lo rechaza) y llega a la terminal viva del agente con
        `orca terminal send --enter`, o a un despacho nuevo con el hilo entero y los
        reportes anteriores. Nunca dos agentes vivos por caso. Una credencial en la
        respuesta no va al agente. La espera vence a las 72 h.
      - `caso resultado` manda la respuesta en el acto, con el candado del tick y su misma
        vuelta (`tick_caso`): regla del dueño, piso fijo, Jev y modo del chat. Lo retenido
        queda para el dueño como en el tick, y el tick no lo manda dos veces.
      - El tick lanza `triage` en el acto cuando un caso espera al agente: no si está
        apagada, no con una corrida en curso de menos de 30 min, no dos veces en 5 min.
      - Tablero: "Despachado a <proyecto> · hace X / Esperando al agente del proyecto",
        lo que reportó el agente, "Esperando al cliente" y "Bloqueado por el agente de X".
      - La línea del tick cuenta `despachados`, `bloqueados_por_despacho`,
        `respuestas_al_proyecto`, `agente_lanzado` y `agente_error`.
      Pendiente: E2E en vivo con un proyecto real; T22.9 (despachar sin el clic lo no
      destructivo) no entra acá: hoy un `trabajar` sigue esperando la firma.
      Arreglo tras la primera corrida en vivo (tablero-w10): `run-create` falló con
      `no_active_sender_terminal` (Orca busca quién manda la orquestación en la terminal
      activa del espacio, y el tick no tiene). El lanzamiento ahora es por terminal:
      brief en `despachos/caso-<id>-<fila>.md` junto a `scope.db` (0600, se borra al
      cerrar el despacho) → `terminal create --worktree <selector> --agent claude` →
      `terminal wait --for composer-ready` → una línea con `terminal send --enter`.
      Cuenta tomada o sin sesión → un reintento con la Claude autenticada de menos uso bajo
      95 % (no la activa), su id en `caso_despacho.cuenta_claude`; sin ninguna → Bloqueado
      "ninguna cuenta de Claude disponible". Soltar al agente es `terminal close`. Lo que
      bloqueó `no_active_sender_terminal` se despacha de nuevo UNA vez
      (`caso_despacho.reintento_de`); una firma de más de 24 h que el despacho ve por
      primera vez va a Bloqueado "aprobación vieja: vuelve a aprobar". `run_id`, `task_id` y
      `dispatch_id` quedan sin uso en la tabla.
- [ ] T12 — Orquestador: workspace propio del plugin con harness de atención y
      la lista de proyectos elegidos en los ajustes, refrescada cuando cambia.
      Hecho en W3 (652b6b9): catálogo desde Orca y PROJECTS.md en el harness.
      Falta registrar el workspace propio del plugin (`workspace: plugin-owned`), que
      va con T7.
- [x] T13 — Ajustes por chat: proyecto en lugar de Plane, modos nuevos, reglas
      por texto a proyecto; migración sin pérdida.
      Cerrada en W3 (bac9ec1, 8efe23c); la UI la rehace T17.
- [ ] T14 — Aprobación por WhatsApp (chat propio): sonda en vivo primero, luego
      mensaje de excepción, lectura de la respuesta citada, envío o cierre.
      Rediseño pedido por el dueño (2026-10-01): una automatización de verdad, no un
      tablero donde todo espera.
      1. Pregunta solo lo crítico:
         - lo que sale con un precio o un monto;
         - una credencial real (por su forma, no por la palabra "acceso");
         - una fecha prometida;
         - una alerta de Jev.
         Lo demás lo hace y lo informa.
      2. Cuando algo necesita al dueño, Alfred le escribe al número del dueño un
         informe corto: el caso, qué pide el cliente, qué va a hacer y la respuesta o
         la tarea. El dueño contesta por WhatsApp: "sí" aprueba, "no" cierra, y otro
         texto es la corrección.
         - La respuesta queda atada a `propuesta_version` y vence a las N horas.
         - Solo vale el número del dueño, configurado en ajustes; nunca se adivina.
      3. Lo que el dueño escribe a Alfred desde su número cuenta como instrucción del
         dueño para el caso abierto de ese chat ("procede", "dale la info").
      4. Lo no crítico que hizo solo le llega al dueño como resumen: corto, agrupado y
         sin texto sensible.
      5. El tablero queda como vista y control manual. Nada depende de que el dueño
         lo abra.
- [x] T15 — Primera corrida de `ingest` con línea base (`case_window_hours`).
      Cerrada en W1 (c0613ff).
- [ ] T0 — Sonda en vivo del despliegue de agente desde una automatización
      (necesita una cuenta Claude global en Orca).
- [ ] T9 — Pestaña de estadísticas desde `caso_evento`.
- [x] T10 — Insignia del nav = tarjetas en "Tu decisión" (hoy se queda pegada).
      Cerrada en W1 (d4fe893): la escribe wa-scope junto con `board`.
- [ ] T11 — Capturas: tablero y estadísticas, 1440/768/390/320, ES y EN, claro y
      oscuro (`activity.html` tiene los dos).
- [x] T16 — Defectos vistos en vivo (2026-10-01, línea de prueba): "Traer
      conversaciones" relanza la sesión pero no refresca la lista (queda para el
      sync de 5 min); un chat directo guardado con sufijo de dispositivo
      (`<lid>:90@lid`) duplica a la persona; `transport-silent` salta cuando el
      sync cae durante el reinicio del sidecar.
      Cerrada en W2 (4f96d5f, eccfe91) y W1 (50cda3e).
- [x] T17 — Ajustes rehechos para el modelo nuevo: pestañas (Estado,
      Conversaciones, Proyectos, Su aprobacion, Agente, Avanzado), un guardar por
      tarjeta, cero `<select>` nativos (en el panel de Orca su lista no se dibuja;
      Jev ya lo documento y uso grupos de botones), conversaciones y proyectos con
      autocompletar propio, Jev con interruptor, reglas viejas de Plane marcadas.
      Prueba que impide volver a meter un `<select>`.
      Cerrada (a2e27c0, integrada e070d43).
- [x] T19 — Piso fijo de excepciones sin Jev: reglas en código (dinero,
      credencial, compromiso de fecha) sobre el mensaje que entra y sobre la
      respuesta propuesta o enviada; se suman a las de Jev (Jev solo agrega). Así
      "Su aprobacion" dice la verdad con Jev apagado. Prefiere preguntar de más.
      Cerrada en W2 (545e25b, 5bb186b) y el texto de ajustes (5e856eb).
- [ ] T18 — Huecos de CLI vistos en T6: editar la propuesta en `listo`,
      reclasificar desde `clasificado`, `wa-send` aprobado por el dueño sin dejar
      fila de borrador.
- [x] T20 — Huecos de T7: un caso que Jev juzgó en zona gris o con credencial
      queda en `clasificado` sin propuesta, no despierta al agente y no cuenta en
      la insignia (debe llegar a "Tu decisión"); los avisos de cierre de Plane del
      triage viejo ya no corren (decidir si se retiran con Plane).
      Hecho: un clasificado sin propuesta despierta al agente en chats `responder` o
      `borrador` (sin `skip`); con credencial pasa a `decision` una vez. Los avisos de
      Plane siguen pendientes.
- [x] T21 — Sin pestaña Bandeja: el tablero es el panel. Historial del agente en
      el detalle de la tarjeta, "Atender ahora" e "Ignorar" como acciones de la
      tarjeta, proyecto asignable a mano desde el detalle. Va con el rediseño del
      tablero (W4).
      Hecha en W4 (8b6c626, c9154ce, 7e4d31d).
- [ ] T22 — Reglas de aprobación afinadas, pedidas por el dueño (2026-10-01) tras ver
      que casi todos los frenos del día fueron falsos positivos.
      1. Números del dueño:
         - en ajustes el dueño elige uno o varios números de confianza, con el
           autocompletar de chats y nunca adivinados;
         - sus mensajes cuentan como orden del dueño, y lo que se les responde o se
           envía por su pedido no pasa por las reglas de aprobación;
         - wa-send to one of the owner's own chats (e.g. a notice from another project's
           session) skips the Jev quality review; only the credential floor stays
           (owner, 2026-10-02: "review and hold what comes from users who are not me");
           a send to anyone else keeps the Jev review, because it protects the reader;
         - `wa-send --approve` is documented as "an explicit act of the owner" but any
           agent that can run the CLI can call it (seen 2026-10-02: a project session
           approved its own held notices). Once owner chats send without a hold, an
           agent must not be able to approve a hold: approval comes from the board, or
           from the owner's WhatsApp reply (T14), never from an agent's CLI call;
         - solo quedan los controles destructivos: nunca repetir una credencial real;
           nada irreversible en un proyecto (borrar, despliegue a producción, push
           forzado, pagos) sin una confirmación explícita en ese chat.
      2. Piso más preciso:
         - credencial = un valor con forma de secreto, o alguien que pide una clave o
           un código ("acceso" solo no cuenta);
         - compromiso = una fecha u hora concreta en lo que sale ("te confirmo" y
           "para el" no cuentan);
         - dinero = un monto o un precio en lo que sale.
      3. Por chat, cada regla con tres niveles: Preguntarme / Que el agente lo revise /
         Permitir. Por defecto: dinero, credencial y fecha en Preguntarme; los avisos
         de calidad de Jev en Que el agente lo revise (la ronda de revisión de
         tablero-w7).
      4. "Su aprobación" muestra estas reglas tal como son, sin la frase "no se pueden
         apagar".
      5. Jev y la configuración:
         - hoy Jev no recibe ni el tono ni las instrucciones del chat, y no sabe quién
           escribe: todo llega como `participant`;
         - la revisión de borradores fija "neutral Latin American Spanish" en el
           código, así que el borrador debe juzgarse con el tono del chat;
         - el remitente dueño viaja como `owner` para que su orden no cuente como
           `tries_to_instruct_the_assistant`; la autoridad sale del número que decide
           el plugin, nunca del texto ni de Jev;
         - para cualquier otro remitente, "soy el admin" sigue siendo un intento de
           instruir al asistente.
      6. Probar en vivo el tono y las instrucciones por chat antes de cerrar.
      7. Roles por número, que generalizan el punto 1:
         - Super admin (el dueño): todo, salvo los controles destructivos.
         - Operador (por ejemplo un PM): queda limitado a los proyectos que el dueño le
           asigna. Puede pedir ajustes y verificaciones, que se despachan al agente del
           proyecto (T8), y recibe el resultado en su chat. Lo destructivo o lo que esté
           fuera de sus proyectos va al dueño. Las respuestas a él no pasan por las
           reglas de cliente.
         - Cliente (por defecto): reglas de soporte y aprobaciones del chat.
         El rol sale del número, configurado en ajustes con el autocompletar de
         contactos, y nunca del texto del mensaje.
         Los roles se asignan al agregar o editar la conversación:
         - en un directo, el rol de esa persona;
         - en un grupo, la lista de sus participantes (con nombre, desde WhatsApp), donde
           a cada uno se le marca Operador o Super admin; el resto queda como Cliente;
         - un rol de grupo vale solo dentro de ese grupo y para los proyectos de ese
           chat;
         - el Super admin global (los números del dueño) vale en todos los chats.
      8. Varios proyectos por chat:
         - un grupo puede tener una lista de proyectos, no uno solo;
         - el proyecto de cada caso sale, en este orden, de: una regla de texto que
           coincide (ya existe); el agente, que elige entre los proyectos del chat por el
           contenido y deja escrito por qué; y, si queda ambiguo, una pregunta corta al que
           escribió ("¿es sobre A o sobre B?") o el dueño;
         - el caso muestra su proyecto y se cambia desde la tarjeta (ya existe);
         - el rol Operador de un grupo vale para los proyectos de ese grupo.
      9. Approval gates what is sent, not what is done (owner, 2026-10-02, after case
         #6 sat in "Su decision" with Ejecutar although the owner asked for it):
         - a `trabajar` proposal that is not destructive and stays inside the chat's
           projects is dispatched to the project agent (T8) at once, with no button;
         - destructive or compromising work (delete, production deploy, force push,
           payments, credentials, anything outside the chat's projects, anything that
           commits the team to a date or money) still waits for the owner;
         - the approval rules of point 3 apply to the reply that goes out with the
           result, so the owner approves before sending, never before doing;
         - technicians and engineers in a group get the Operador role of point 7, so
           they can request support work from the bot for that group's projects.
      Va después de tablero-w7.

- [ ] T23 — Supervisión del equipo por WhatsApp, pedida por el dueño (2026-10-01).
      El bot le avisa a cada miembro del equipo el estado de sus tareas y le pide lo que
      falta.
      1. Equipo: personas con rol Operador (T22) y su número de WhatsApp, enlazadas con
         su miembro de Plane, elegido en ajustes con el autocompletar de miembros de
         `orca plane members list`.
      2. Fuente de verdad: las tareas de Plane asignadas a cada uno, más los trabajos
         despachados por el plugin (T8). Una automatización solo-comando las lee, sin
         modelo, y detecta los cambios.
      3. Avisos, siempre con el enlace a la tarea como evidencia, para que Jev no los
         frene por estado sin verificar:
         - una tarea suya quedó lista ("revisa");
         - una tarea quedó bloqueada esperando algo de él ("requiere de ti: …");
         - una tarea sin movimiento en N días;
         - un resumen diario corto de lo pendiente.
      4. Respuestas por WhatsApp:
         - "listo", "bloqueado por …" o una pregunta de estado;
         - el bot comenta y mueve la tarea en Plane (`orca plane comment add`,
           `status set`);
         - lo ambiguo lo resuelve el agente.
      5. Respeta el horario de cada persona (`hours`), con un tope de mensajes al día por
         persona y modo "Solo avisos": el agente nunca charla por su cuenta.
      6. El dueño recibe un resumen del estado del equipo y lo que esté trabado.
      Depende de T22 (roles y números), T8 (despacho) y de `wa-read wait`.

- [ ] T24 — Skills section in settings, requested by the owner (2026-10-02), so any
      workspace agent can message the team over WhatsApp: tell a dev a task is ready,
      ask for something it needs, notify the owner, wait for an answer.
      1. A "Skills" section in config.html lists the plugin's installable skills, where
         each one is installed (global or which projects) and its version against the
         plugin's version, with Install, Update and Remove.
      2. Target: Global (every project) or one or more specific projects, picked from the
         Orca workspaces list (never typed paths). Agents: the ones Orca detects
         (claude-code, codex, the shared .agents/skills), like Orca's own Settings.
      3. Same mechanism as Orca: `npx skills add <source> --skill <name>` with `--global`
         or project-local, as `orca skills install` resolves it. The source is the
         installed plugin's own folder, so the skill matches the running plugin and needs
         no network or push. To verify first: that the skills CLI accepts a local path,
         and what a project-local install writes into the user's repo (tell the user it
         is a file in their repo; offer to keep it out of git).
      4. New skill `whatsapp-avisos` (English, generic, no real data):
         - resolves the plugin's bin through a stable path the plugin keeps up to date
           (the `.wa-bin` idea, at a fixed user-level location), never a hard-coded path;
         - send a notice or a request to a person or group by its configured name, only
           to chats the user enabled for it (mode Responder or a new "Solo avisos");
         - wait for an answer with `wa-read wait` (T18) and return it to the agent;
         - the rules: sends to the user's own chats skip the Jev quality review (T22
           point 1); sends to anyone else keep it; never a credential; no dates or
           money promised on the team's behalf; a held message is reported back with
           the approve command, never retried around the hold.
      5. Remove uninstalls exactly what Install wrote; the plugin never writes skills
         anywhere the user did not choose.
      Depende de T18 (`wa-read wait`, stable command) y T22 (dueño y Solo avisos).

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
