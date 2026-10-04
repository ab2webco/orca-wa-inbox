# First message by the agent (Beta): acknowledgement, progress updates and a personal closing

## Objective

Today a new case in a `responder` chat gets the same fixed acknowledgement ("Recibimos su
mensaje...") from the tick, and then one reply. To the customer it reads like a canned bot.
The owner wants, as an opt-in Beta, the agent working the case to write the first message
itself, send short progress updates while it works, and close by saying what was done and
asking the customer to check. The fixed acknowledgement stays the default.

## Scope

1. A setting `first_reply_mode`, global with a per-chat override (`chat_scope`, null = use
   the global value), with three values:
   - `ack` (default, today's behavior, untouched): fixed acknowledgement from the tick.
   - `model` (Beta): no fixed acknowledgement; the agent writes the first message.
   - `model_with_ack_fallback` (Beta): the agent writes it; if no message went out for the
     case within `ack_fallback_minutes` (default 5, configurable), the tick sends the fixed
     acknowledgement.
2. In both model modes, every case that would have received an acknowledgement under `ack`
   is guaranteed to reach the agent (needs-agent), so the customer is never left without a
   first message by a case the triage skips.
3. A new command `caso avance <id> "<text>"` for the triage and project agents:
   - Only when the chat's mode is a model mode and the chat sends (`responder`).
   - Does not change the case's stage.
   - Goes through the same review as any reply (fixed floor + Jev). A held update is
     dropped with a case event; it never goes to the owner (updates are optional).
   - Its own send id per update (`caso-<id>-avance-<n>`), so several can be delivered.
   - Pacing: at most one every `update_every_minutes` (default 10) and `updates_max`
     (default 3) per case; the first message counts as update 1 and is exempt from the
     pacing wait. Rejections are explicit, machine-readable errors.
   - Signed like every other message (`agent_name`).
4. Closing: unchanged mechanics (`caso resultado --estado resuelto|necesita|bloqueado`);
   the instructions ask for a personal closing that says what was fixed and asks the
   customer to check it.
5. Instructions: `harness/skills/whatsapp-soporte/SKILL.md`, `harness/COMMANDS.md`,
   `prompts/triage.md` and the dispatch brief (`brief_de_despacho`) explain, only when the
   chat is in a model mode: write the first message about what the customer asked; when an
   update is worth sending (start, a real milestone, before a long step); never repeat
   phrasing; follow the chat's tone; never promise times, dates or prices; never state an
   unverified status.
6. Panel: in "Respuestas automaticas", the three modes as buttons (not a select) with a
   Beta badge on the two model modes, the fallback minutes, the update pacing, and the
   per-chat override. The `model` mode shows a warning that without fallback a customer gets
   nothing while Orca or the triage is down. ES/EN/PT. Screenshots at 1440/768/390/320,
   light and dark.

## Checklist

- [x] P1 Settings and storage: `first_reply_mode`, `ack_fallback_minutes`,
      `update_every_minutes`, `updates_max` (global, panel keys, validation, defaults) and
      the per-chat column; resolution chat > global > default. The four values travel in
      ONE panel key, `firstReply` ({mode, fallbackMinutes, everyMinutes, max}), and the chat's
      in its scope entry (`firstReply`); `voice` returns the resolved `first_reply`
      (scripts/check-clis, scripts/check-casos "ajustes"). RED: defaults None, invalid values
      accepted, `KeyError: first_reply`; GREEN: check-clis 273 settings checks, section 10/10.
- [x] P2 Tick: no acknowledgement at ingest in model modes; fallback acknowledgement after
      N minutes without an outgoing message in `model_with_ack_fallback`; never in `model`;
      model-mode cases marked for the agent. The fallback row is registered at ingest and
      waits `pendiente`; before sending, the tick takes the first-message slot (`enviando`)
      with the database locked, so an agent message and the fallback can never both be the
      first. The mode is re-read at send time (scripts/check-casos "el acuse y su respaldo").
      RED 7 failures (acuse sent in model and at once in fallback); GREEN 18/18, acuse
      section 24/24 unchanged.
- [ ] P3 `caso avance`: guards, review, unique ids, pacing, max, events, no stage change.
- [ ] P4 Instructions: skill, COMMANDS, triage prompt, dispatch brief.
- [ ] P5 Panel: mode buttons, Beta badges, warning, numbers, per-chat override, ES/EN/PT,
      screenshots looked at.
- [ ] P6 `npm run check` green.
- [ ] P7 Live: one chat in `model_with_ack_fallback` gets an agent-written first message,
      an update and a personal closing; the fallback fires when the agent is late.

## Acceptance

- With `ack` (default) nothing changes: every existing acknowledgement test still passes.
- In `model_with_ack_fallback`, a case gets the agent's first message, or the fixed
  acknowledgement after N minutes, never both.
- In `model`, a case never gets the fixed acknowledgement.
- Updates are delivered with distinct ids, respect pacing and the max, never move the
  stage, and a held update never reaches the customer or the owner.

## Checks

- `scripts/check-casos`, `test/panels.test.mjs`, `test/worker.test.mjs`, `npm run check`.
