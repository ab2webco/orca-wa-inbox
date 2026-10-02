# Claude se cierra en la pregunta de confiar en la carpeta

## El problema, medido (2026-10-02 17:04)

- El tick abrió al agente de casos (`terminal create --agent claude
  --claude-account <id>`) en el espacio del plugin. `orca terminal read` de esa
  terminal muestra la pantalla de confianza de Claude Code ("Claude Code'll be
  able to read, edit, and execute files here." / "Security guide") y 9 s después
  el prompt del shell: Claude se cerró.
- `orca terminal state`: `agent: null`, `session.read: false`,
  `reason: agent-session-unknown`, `unsubmittedInput.pending.evidence:
  submit-without-turn`. Las dos corridas anteriores terminaron `vencido` a los
  30 min sin turno.
- Lo mismo en el primer despacho a un proyecto cuya carpeta esa cuenta nunca
  confió. La confianza es por cuenta de Claude y por carpeta: cada cuenta del
  bot la ve una vez en cada carpeta.

## Por qué pasa (verificado con Claude Code 2.1.288, en un HOME aislado)

- `composer-ready` se cumple con la pantalla de confianza: Orca toma la marca
  de Claude (el cursor tras el pegado entre corchetes) y ese diálogo la pone.
- En 2.1.288 la opción marcada por defecto es "No, exit" (arriba) y "Yes, I
  trust this folder" va abajo, sin números: el Enter de la línea del brief la
  elige y Claude sale. `y`, `1` y `2` no hacen nada; Flecha abajo y Enter
  aceptan (`hasTrustDialogAccepted: true`). Las versiones de antes ponían
  "1. Yes, proceed" primero y marcado.
- Con el shell a la vista `tui-idle` nunca se cumple, así que la cura de la
  línea perdida nunca reenvía ni falla: la corrida vence a los 30 min.

## Decisión

Antes de escribir la línea del brief, el lanzamiento compartido (agente de
casos y despacho al proyecto) lee la terminal. Con la pantalla de confianza la
acepta: mueve el cursor a la opción que dice Yes (Flecha abajo o arriba según
dónde esté), vuelve a leer para ver el cursor en ella y recién ahí manda Enter;
nunca adivina el orden. La carpeta es el espacio del propio plugin o la del
proyecto que el dueño asignó a ese chat. Con el shell a la vista no escribe
nada: la corrida falla con "Claude se cerro al abrir: <ultima linea>" y su
terminal se cierra. El reenvío de la línea perdida también mira la pantalla.

## Alcance

- [x] T1 `wa-scope`: leer la pantalla, aceptar la confianza, no escribir en un
  shell (lanzamiento y reenvío); el agente de casos falla con `se-cerro` y,
  tras tres seguidas, `se-cierra` y espera una hora; el despacho va a
  Bloqueado con el motivo y se reintenta una vez.
- [ ] T2 Tablero: las frases de `se-cerro` y `se-cierra` en los tres idiomas.

## Criterios de aceptación

- Confianza a la vista: Flecha hasta Yes, Enter, composer, la línea, turno.
- Claude se cerró: ninguna escritura en la terminal, la corrida falla con el
  motivo, la terminal se cierra y el tick siguiente abre otra (acotado).
- El reenvío no escribe con la confianza ni con el shell a la vista.
- Lo mismo en el despacho al proyecto.

## Checks

- `scripts/check-casos` con la `orca` de mentira (pantallas de confianza, de
  shell y de composer).
- `npm run check` entero; capturas solo de lo que cambió en el tablero.
