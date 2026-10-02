# Automatizaciones

Las definiciones viven acá versionadas porque Orca las guarda en el `orca-data.json` de
cada instalación, y ese archivo es por build: lo que crees en el dev no existe en el
instalado y viceversa.

| archivo | cada | corre |
|---|---|---|
| `whatsapp-tick.json` | 1 min | `wa-scope tick` (solo comando, sin agente) |
| `whatsapp-triage.json` | 5 min, a toda hora (y al instante con "Atender ahora") | agente, con precheck `wa-scope pending --needs-agent` |

`tick` también limpia: a lo sumo cada 5 minutos quita de la barra lateral (`orca worktree
rm`, solo el registro y sus terminales, nunca los archivos ni la raíz de la carpeta) los
espacios `::workspace:` que `triage` deja en cada corrida ya terminada, 5 por vuelta como
máximo y 2 minutos después de que acabó. Sin la CLI de Orca, o con un error, no hace nada
y lo cuenta en `limpieza_error`.

`tick` es un comando, no un agente (`orca automations create --command` en un Orca
1.4.160-lab.84 o más nuevo), pero despierta a dos:

- **El agente de casos.** Con un caso que lo espera (lo mismo que `pending --needs-agent`)
  lanza `triage` en el acto (`orca automations run`), sin esperar su cron: no si el dueño
  la apagó, no con una corrida en vuelo (en curso y de hace menos de 30 min: Orca deja
  corridas en `dispatched` días después) y no dos veces en 5 minutos. El precheck de
  `triage` **sale con 1 cuando ningún caso necesita lenguaje**, con lo que Orca marca la
  corrida `skipped_precheck` y no despierta al agente.
- **El agente del proyecto (T8).** Un `trabajar` aprobado (una firma de `decision` a
  `trabajo`; nunca lo que puso ahí el backfill) abre Claude en el espacio exacto del
  proyecto, uno por tick: el brief va a un archivo en la carpeta de datos del plugin
  (`despachos/`, junto a `scope.db`, nunca en el repo del proyecto), `orca terminal create
  --agent claude`, `terminal wait --for composer-ready` y una sola línea con
  `terminal send`: que lea ese archivo y lo siga. La orquestación de Orca no sirve desde el
  tick: busca quién la manda en la terminal activa del espacio, y la automatización no
  tiene ninguna (`no_active_sender_terminal`). Si la cuenta de Claude está tomada por otro
  espacio o sin sesión, prueba una vez con la autenticada de menos uso (bajo 95 %) y anota
  su id en `caso_despacho`. Una fila en `caso_despacho` (escrita antes de llamar a Orca)
  impide relanzar; que el agente siga se mira por su terminal en `orca terminal list`, y al
  soltarlo se cierra esa terminal. Sin proyecto, con un proyecto ambiguo, sin cuenta
  usable, sin reporte, sin respuesta en 4 h o con un error de Orca, el caso va a Bloqueado
  con el motivo. Una firma de más de 24 h que el despacho ve por primera vez tampoco se
  lanza ("aprobación vieja: vuelve a aprobar"); lo único que se reintenta solo, una vez,
  es lo que bloqueó `no_active_sender_terminal`. El agente reporta con `caso resultado` (`resuelto`, `necesita`
  o `bloqueado`), que manda la respuesta en el acto por el mismo piso; si pidió
  información, lo que conteste el cliente vuelve a su terminal o a un despacho nuevo.

La línea del tick cuenta `despachados`, `bloqueados_por_despacho`,
`respuestas_al_proyecto`, `agente_lanzado` y `agente_error`.

Las dos encuentran las herramientas leyendo `.wa-bin`, en la carpeta de trabajo del
plugin (`workspace: plugin-owned`): el worker escribe ahi la ruta de su propio `bin/` en
cada activacion (`harness.mjs`, `sembrarBin`). No hay resolvedor por instalacion ni por
`PATH`. Sin `.wa-bin` salen con 1, calladas, y la siguiente activacion lo siembra; el
resolvedor viejo no cabe junto a esta forma en los 1024 caracteres del manifiesto. Con un
build instalado y uno de desarrollo abiertos a la vez, comparten carpeta y gana el ultimo
que sembro.

## Crearlas

```bash
orca automations create \
  --name "<name>" --provider claude \
  --trigger "<trigger>" --timezone "<timezone>" \
  --precheck "<precheck>" \
  --workspace "id:<repoId>::<path>" --workspace-mode existing \
  --fresh-session --disabled \
  --prompt "$(cat <promptFile>)"
```

Detalles que cuestan una vuelta si no se saben:

- **`--fresh-session`, nunca `--reuse-session`.** Reusar sesión puede apropiarse del
  terminal de otro agente: el chequeo acepta un pane en estado `working` y también uno
  abierto por una persona, y el filtro es por tipo de agente, no por dueño.
- `--workspace` y `--repo` son excluyentes. Con `workspaceMode: existing` va `--workspace`.
- Crearlas **`--disabled`** y encenderlas después de una corrida manual mirada.
- El CLI de `orca` habla con el runtime que encuentre corriendo. Si tiene el instalado y
  un build dev abiertos a la vez, **gana el instalado**: no hay forma de apuntarlo al dev.
  Para probar en dev, cierre el instalado o cree las automations desde su UI.
