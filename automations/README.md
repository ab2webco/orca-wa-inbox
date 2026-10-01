# Automatizaciones

Las definiciones viven acá versionadas porque Orca las guarda en el `orca-data.json` de
cada instalación, y ese archivo es por build: lo que crees en el dev no existe en el
instalado y viceversa.

| archivo | cada | corre |
|---|---|---|
| `whatsapp-tick.json` | 1 min | `wa-scope tick` (solo comando, sin agente) |
| `whatsapp-triage.json` | 5 min, L-V 8-18 | agente, con precheck `wa-scope pending --needs-agent` |

`tick` no despierta a ningún agente: es un comando (`orca automations create --command`
en un Orca 1.4.160-lab.84 o más nuevo). El precheck de `triage` **sale con 1 cuando
ningún caso necesita lenguaje**, con lo que Orca marca la corrida `skipped_precheck` y
no despierta al agente.

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
