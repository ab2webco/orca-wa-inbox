# Approval over WhatsApp (kanban T14)

## Objective

When a case needs the owner (a reply held by the fixed floor or Jev, a `trabajar` that
waits for a click), the plugin writes a short report to the **approval number the user
designates in Settings**, and the user answers over WhatsApp: `si <case>` approves, `no
<case>` closes, `<case> <text>` sends a correction back to the agent. The board stays as a
view; nothing depends on opening it.

This is a public plugin with many users: nothing is hard-coded. The approval number is a
per-install setting, picked from the user's trusted numbers ("Sus numeros de confianza",
`owners` in the plugin store, `wa_settings.duenos()`), never typed and never guessed. With
no approval number set, the feature is off and everything behaves as today.

## Scope

1. **Setting** `approvalNumber` (plugin store, next to `owners`): one of the trusted
   numbers, chosen in the owners card of `config.html` (button group or list built from the
   owners already added; no native `<select>`, it does not open in Orca's panel). Copy in ES
   (usted, no accents, like the rest of the panel) and EN. Off by default.
2. **Report** (tick, command-only, no model): once per `propuesta_version`, for a case that
   waits for the owner after the rules ran (a hold event for that version: `trabajo espera al
   dueno:` or the reply held for the owner), send to the DM with the approval number on the
   active line, through the same send path the tick uses (`envio` table, signed, `--id` keyed
   by case + version so it is sent once). The chat of a trusted number already skips the
   approval rules (T22.1). Content, short and in the chat tone of the panel language:
   case number, conversation name, what the client asks (one line, from the case summary or
   first message, trimmed), why it waits (the hold codes in words), and the proposed reply
   or task (trimmed), then how to answer: `si 18`, `no 18`, or `18 <correccion>`.
   Never include a credential: if the case has `credential` among its exceptions, say that a
   credential is involved and that it must be approved on the board.
3. **Answer** (ingest): a message from a trusted number in the approval DM that matches
   `^(si|sí|ok|dale|no)\s+#?(\d+)$` or `^#?(\d+)\s+(.+)$` (case-insensitive, trimmed) and
   names a case that has a pending approval report is NOT a new case:
   - yes: approve that `propuesta_version` as `dueno` (same path as the board's Approve);
   - no: close the case as `dueno` with reason "rechazado por WhatsApp";
   - text: leave it as the owner's correction for the agent (same path as the board's edit
     or reclassify with a note; the agent sees it in the case file) and relaunch the agent.
   A bare `si`/`no` with exactly one pending report applies to that one. Anything else from
   the owner keeps working as an owner order (opens or joins a case, as today).
   The report expires after `approval_hours` (default 24): an answer to an expired or
   superseded version does nothing except a one-line reply saying so.
   Each answer gets a one-line confirmation back ("Caso 18 aprobado, sale ahora").
4. **Blocked notice**: when a case moves to `bloqueado` (a dispatch reported blocked or
   failed), send one line to the approval number with the case and the reason.
5. **`estado` command**: the owner writes `estado` to the approval DM and gets the open
   cases by stage, one line each (number, conversation, stage, waiting since).
6. Board events for each of these ("aviso enviado por WhatsApp", "aprobado por WhatsApp")
   so the history says what happened.

## Design (decided while implementing)

- `wa-send` only writes to an authorized chat, and the store only keeps messages of
  authorized chats. So the approval DM has to be authorized in `responder`: the panel says
  so next to the picker and warns when it is not. Nothing bypasses `wa-send`.
- Storage: `approvalNumber` (a trusted id, `''` = off) and `approvalLang` (`es` | `en`, the
  panel language when it was saved; the backend has no other way to know it).
  `wa_settings.numero_aprobacion()` returns it only if it is still in `duenos()`.
- `approval_hours` is a CLI setting (`wa-scope config approval_hours N`, default 24).
- Table `aviso` (scope.db): one row per WhatsApp message to the approval number
  (`aprobacion` per case + version, `bloqueo` per blocked event, `respuesta` per answer).
  Its `req_id` is the `wa-send --id`, so nothing goes out twice; the tick sends what is
  `pendiente`.
- "Waits for the owner" = a hold event for the current version: `trabajo espera al dueno`,
  a new `respuesta espera al dueno` (the rule refused to sign a reply, E_EXCEPTION), a
  `wa-send` hold (`envio frenado`), or the revision rounds that end in "lo decide el dueno".
- Yes on a reply follows the board's Send: `aprobar --actor dueno`, then the `wa-send`
  draft with the case id and `--approve`. Yes on a job is `aprobar` (T8 dispatches it).
- A correction follows the board's Reclassify with a note (decision -> clasificado, the
  agent re-proposes) and the case file shows the owner's notes. A case in `listo` (the
  project agent's result) cannot be reclassified on the board either: the answer says to
  use si / no or the board.

## Not in scope (proposed next)

- Daily digest of what was handled without the owner (T14.4).
- Quoted-message answers (needs the quoted stanza id in the store).
- Line-down alerts (the line cannot report itself; needs another channel).

## Checklist

- [x] A1 Setting + panel picker (ES/EN, PT too), panel tests, screenshots.
      Proof: test/panels.test.mjs "T14: el numero de aprobacion..." (989/989); shots
      `config-numero-aprobacion` and `tablero-detalle` at 1440/768/390/320, light and dark.
- [x] A2 Report on hold, sent once per version, never a credential.
      Proof: scripts/check-casos "T14: la aprobacion por WhatsApp" (no number = nothing,
      untrusted number ignored, one report per version, credential without its value).
- [x] A3 Answer parsing in ingest (yes/no/correction/bare/expired/other).
      Proof: same section: parser table, si/no/N texto, bare si with one and two pending,
      expired, superseded, owner order still opens a case, client "si N" approves nothing.
- [x] A4 Blocked notice + `estado` command. Proof: same section.
- [x] A5 Skill says where the owner's correction arrives (case file section "The owner's
      corrections"); scripts/check-harness guards the phrase (51 checks).
- [ ] A6 Full `npm run check` green.

## Acceptance

- With no approval number set, nothing changes (tests prove it).
- With one set, a held case produces exactly one WhatsApp report per version to that number
  and to no other chat; `si N` sends the held reply / dispatches the work; `no N` closes;
  `N texto` reaches the agent; owner orders that are not answers still open cases.
- No real numbers or ids in the repo (scripts/check-datos-reales).
