# Automatizaciones

Las definiciones viven acá versionadas porque Orca las guarda en el `orca-data.json` de
cada instalación, y ese archivo es por build: lo que crees en el dev no existe en el
instalado y viceversa.

| archivo | cada | precheck |
|---|---|---|
| `whatsapp-triage.json` | 5 min, L-V 8-18 | `wa-scope pending` |
| `whatsapp-tomar-lo-marcado.json` | 2 min | `wa-scope pending --only-taken` |

El precheck hace dos cosas: sincroniza el panel (barato, sin agente) y **sale con 1 cuando
no hay nada**, con lo que Orca marca la corrida `skipped_precheck` y no despierta al
agente. Por eso la de "tomar" puede correr cada 2 minutos sin costar nada.

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
