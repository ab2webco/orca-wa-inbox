# Restricted account: WAINBOX-75

## Objective

When WhatsApp restricts the line (the reachout timelock, error 463, or the new-chat cap),
the owner sees it in the panel and in `wa-scope doctor`, and queued sends to new chats close
as `rechazado` with the stable code `cuenta-restringida` instead of a generic library error.
Source: `docs/research/wainbox-69-baileys-audit.md` R1.

## Boundary

`main.mjs`, `sidecar/src/index.js`, `sidecar/src/envio.js`, `bin/wa-send`,
`scripts/check-clis` and their tests. The lead also cleared `activity.html` (banner) and
`bin/wa-scope` (doctor line). `test/panels.test.mjs` belongs to another member and is not
touched here: the banner is covered by a shot fixture (`actividad-restringida`).

## Mapping

| Requirement | Where |
|---|---|
| FR-1/FR-2 timelock set and lifted | `crearRestriccion().bloqueo` in `envio.js`; `connection.update` reads `reachoutTimeLock` in `index.js` |
| FR-3 query on open, once each | `consultarRestriccion` in `index.js` (TC-3); failure emits `restriccion-sin-leer` (TC-4) |
| FR-4 message cap | `sock.ev.on('message-capping.update')`, `crearRestriccion().cupo` (TC-6) |
| FR-5 panel banner | `main.mjs` `restriccionDeSidecar` writes `sidecar.restriccion`; `activity.html` `renderRestringida` (es/en/pt) |
| FR-6 doctor | `store_meta` `restriccion@<cuenta>` (`anotarRestriccion`), read by `wa-scope doctor` (`restriccion_de`) |
| FR-7 send gate | `atenderSalida({ restringida })` + `chatConSalida` in `envio.js` (TC-5); `wa-send` maps it to `send-account-restricted` |
| Expire at `timeEnforcementEnds` | `activa()` checks the end; the 60 s line heartbeat emits the lift (`revisar`) |
| No customer data | the message carries only flags, a Baileys code (validated), times and counts |

Q1 (block replies in existing chats too?): kept the default, no. Replies are still attempted.

## Checklist

- [x] RED tests first: `test/envio.test.mjs`, `test/sidecar-pairing.test.mjs`, `test/worker.test.mjs`
- [x] Sidecar: state, emit, store meta, queries on open, heartbeat lift, send gate
- [x] `wa-send`: `send-account-restricted` with the shared sentence
- [x] `wa-scope doctor`: `restriction` in JSON and "restricted until <time>" in text
- [x] `scripts/check-clis`: same code (sidecar vs wa-send), same sentence (wa-send vs doctor), doctor end to end
- [x] Panel banner + reduced shots (1440 en, 390 es, both themes)
- [x] `test/panels.test.mjs` banner case (RED on the old panel, GREEN now)
