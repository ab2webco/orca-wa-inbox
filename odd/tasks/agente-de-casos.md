# El agente de casos no arranca, y el tablero lo esconde

## El problema, medido (2026-10-02 13:51)

- `orca automations runs --id <triage>`: todas las corridas recientes son
  `dispatch_failed` con "This Claude account is in use by an assigned worktree".
  Orca lanza las automatizaciones con la cuenta de Claude ACTIVA y ni
  `automations run` ni `automations edit` aceptan otra.
- El tablero dice "Para el agente en su próxima corrida" y "Última revisión ·
  2 casos para el agente" mientras cada lanzamiento falla: la falla es callada.
- "Atender ahora" corre `orca automations run` (agente.mjs): falla igual.

## Decisión

El tick lanza SIEMPRE al agente de casos por terminal, con el mismo código del
despacho al proyecto (T8): `terminal create --agent claude` en el espacio del
plugin (el de `runContext` de la automatización `triage`), con la cuenta elegida
o la de respaldo, el prompt de `prompts/triage.md` como brief y una línea, y la
verificación del turno. La automatización `triage` sigue con su cron como
respaldo: su precheck no cambia y su agente se frena en el `lock` si ya hay uno.

Por qué no "primero `automations run`, después la terminal": el fallo de
`automations run` llega tarde (la corrida se despacha y falla después), así que
saberlo cuesta un minuto más y una máquina de estados sobre las corridas de Orca;
y no deja elegir la cuenta. La terminal sirve a quien tiene una sola cuenta (el
primer intento es sin `--claude-account`, igual que la automatización) y a quien
tiene varias.

## Alcance

- [x] T1 `wa-scope`: tabla `agente_corrida`; el tick vigila y lanza a lo más UN
  agente de casos por vuelta (nunca dos a la vez, ni con el lock tomado), cada
  5 min como mucho; cierra su terminal cuando terminó o a los 30 min.
- [x] T2 `wa-scope agente lanzar`: lo mismo para "Atender ahora", con plazo; el
  worker lo usa en vez de `orca automations run`.
- [x] T3 Tablero: `agent_launch` y `waits_agent`; "No pude lanzar al agente:
  <motivo>" en las tarjetas que esperan al agente y en la línea de la revisión.
- [ ] T4 Cuenta de Claude del bot (config.html, pestaña Agente): "Automática" o
  una cuenta de `orca account list`; la usan el agente de casos y el despacho
  al proyecto, con respaldo automático y el tablero dice cuál se usó y por qué.

## Criterios de aceptación

- Con `dispatch_failed` en las corridas de `triage`, el tick abre al agente por
  terminal con otra cuenta autenticada.
- Nunca dos agentes de casos a la vez; lanzamientos acotados por vuelta.
- "Atender ahora" usa el mismo camino.
- Un lanzamiento fallido se ve en el tablero, con su motivo.

## Checks

`npm run check` (scripts/check-casos, test/worker.test.mjs, test/panels.test.mjs,
`npm run shots` en 1440, 768, 390 y 320, en los dos temas).
