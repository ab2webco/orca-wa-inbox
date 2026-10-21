# borrador-de-sesion (WAINBOX-59)

## Objective

When `wa-send` holds a message written from an interactive session (not a plugin-launched
case or project agent, and not the plugin's own sends), the plugin sends the owner a
WhatsApp notice at once with the FULL text and a short code. `si <code>` sends it through
the existing approver path (`wa-send --approve <id> --by whatsapp-reply`); `no <code>`
withdraws it. Today such a draft creates no notice at all.

## Scope

- `wa-send`: every session draft it leaves (`--send` held by the floor or Jev, `--send` on
  `borrador`, or a plain draft) asks `wa-scope draft-notice --req=<id> --line=<line>`,
  passing only ids. Never when the hold is the agent's to rewrite. Its exit code never
  depends on the notice. The code is never printed to the caller.
- The plugin's own sends carry a marker env (`WA_INBOX_PLUGIN_SEND`): `tick_envia`,
  `entrega_del_dueno`, the board (`acciones.mjs`) and the owner notice (`main.mjs`). A case
  or project agent is recognised by its terminal (`ORCA_TERMINAL_HANDLE` / `ORCA_TAB_ID`
  in `agente_corrida` / `caso_despacho`). Both cases: still held, no session notice.
- `draft-notice` reads the draft from `envio` itself, and enqueues a new aviso type
  `borrador` (`aviso-d-<req_id>`, code in `version`), then sends what is pending.
  A secret-shaped value or a credential: the notice has no text and says "board only".
- `lee_respuesta` reads `si|yes|no <CODE>` (letter first, so never a case number).
  `atiende_respuesta` resolves the code before any case lookup; a quoted notice of another
  type with a bare `si` never falls through to a case notice.
- `si <code>` re-checks the stored body: a secret or a credential is refused (board only).
- Kept: owner-chat sends skip Jev; the secret floor always holds; no agent gets the key.
- Out of scope: answering a draft notice that left through another line (`aviso-relevo`
  stays case-only); bare `si` for draft notices.

## Tasks

- [ ] B1 Tests (RED): session held -> one notice with the full text and a code; `si
  <code>` from the owner sends it and logs the WhatsApp approval; `no <code>` withdraws it;
  a non-owner and a self-sent `si <code>` do nothing; a case-agent terminal and the plugin
  marker get no notice; secret -> no text and refused; parser keeps `si 18`.
- [ ] B2 `wa-send` asks for the notice; `wa-scope draft-notice`, the `borrador` aviso and
  its texts (es/en); the reply path; the plugin marker in the plugin's own sends (GREEN).
- [ ] B3 `npm run check` without shots green; PR opened.

## Acceptance

- An owner-authorized session send leaves with a single owner action (`si <code>`).
- A case agent's identical send is still held, with no session notice.
- A secret-shaped value is always held, and never travels in the notice.
- Fake data only (public repo).

## Checks

- `scripts/check-casos`, `scripts/check-harness`, `scripts/check-voseo`,
  `scripts/check-datos-reales`, and the rest of the `check` chain without `npm run shots`
  (no panel changes).
