# Los espacios del plugin se apilan en la barra lateral

## El problema, medido (2026-10-02 ~15:00)

- Orca fuerza `new_per_run` en las automatizaciones de un plugin: cada corrida del cron
  `triage` crea un espacio `<repoId>::<carpeta del plugin>::workspace:<uuid>` ("WA Inbox
  (plugin)" o "WhatsApp: triage run N") con una terminal de shell adentro.
- Desde 8eee861 el tick abre al agente de casos por terminal en la raiz del espacio del
  plugin (`agente_corrida`). El cron quedo de respaldo, pero su precheck (`pending
  --needs-agent`) sigue pasando con cualquier caso esperando: cada 5 minutos una corrida
  `dispatch_failed` (la cuenta activa esta tomada) y un espacio mas.
- `tick_limpia` solo miraba la lista de corridas de la automatizacion `triage` ACTUAL,
  creia en `worktree rm` `{ok, removed: true}` y se rendia callada a los 3 intentos. En
  vivo `worktree rm` dijo `removed: true` y el espacio seguia en `worktree list`, varios
  con una terminal viva. Los de una automatizacion que Orca borro y recreo (ids nuevos al
  reactivar el plugin) no los veia nadie.

## Decision

1. `wa-scope pending --needs-agent --precheck` es el precheck del cron: sale 1 (Orca no
   crea el espacio) cuando el tick se encarga del agente de casos, o sea si el tick corrio
   hace menos de 3 minutos y su ultimo lanzamiento no fallo por algo que el cron si
   arregla (`sin-cli`, `sin-espacio`, `sin-prompt`: el cron no necesita ni la CLI, ni el
   espacio raiz, ni el prompt copiado). Una cuenta tomada no la arregla el cron: Orca lo
   lanza con la activa. El primer paso del agente sigue con `pending --needs-agent`.
   Cambia el precheck aprobado del manifiesto: el dueno vuelve a aprobar el plugin.
2. La limpieza mira `worktree list` y no las corridas: todo hijo `::workspace:` de la
   carpeta del plugin (la ruta del `runContext` de una automatizacion de este plugin),
   pasada la gracia, que no sea de una corrida en vuelo ni aloje la terminal del agente
   de casos o de un despacho en vuelo. Cierra sus terminales, `worktree rm`, y vuelve a
   listar para verificar. Lo que sigue en la lista cuenta un intento; a los 3 se dice en
   el resumen del tick y en la linea del tablero, y se sigue intentando al final de la
   cola. Con pendientes vuelve al minuto, no a los 5.

## Alcance

- [x] T1 `pending --needs-agent --precheck` y el manifiesto (orca-plugin.json,
  automations/, resolver_formas) con el precheck nuevo.
- [x] T2 La limpieza por `worktree list`, con terminales cerradas antes, verificacion y
  reintentos contados.
- [ ] T3 El tablero: `workspaces_stuck` y "N espacios del plugin no se pudieron quitar".

## Criterios

- Con el tick encargado, el precheck sale 1 y callado; sin tick reciente, o con una falla
  que el cron arregla, sale 0.
- Un hijo de la carpeta del plugin de una automatizacion borrada se encuentra y se quita.
- Las terminales del espacio se cierran antes del `worktree rm`.
- Un `rm` "ok" que sigue en la lista no cuenta como quitado y se reintenta.
- La raiz, otro plugin, una corrida en vuelo y el espacio del agente vivo no se tocan.
- Tras los intentos, la falla se ve en el resumen y en el tablero.

## Checks

`scripts/check-casos`, `node test/manifest.test.mjs`, `node test/resolver.test.mjs`,
`scripts/check-resolver`, `node test/panels.test.mjs`, `npm run check` sin shots, y shots
del tablero en 1440/768/390/320, claro y oscuro.
