# Nothing in the reply chain stalls silently (linea-viva, second release)

## Objective

The first release (v4.29.0) makes sure each line's tick runs and that the owner hears
about a line that stops. The A0 audit in `odd/tasks/linea-viva.md` found more places
where a message, an agent or a notice can stop without anyone noticing. This release
closes them. The rule is the same:

- what can be recovered is recovered without a human;
- what cannot is reported to the owner once.

## Scope

1. **A send stuck in `enviando`.**
   - The problem: the sidecar died mid-send. The row is never retried, and it counts as
     "already written", so the fallback acknowledgement is suppressed too.
   - The fix: the sidecar reconciles every `enviando` row older than 2 minutes. If its
     own outgoing message is in the store (same chat, after `claimed_at`), the row
     becomes `enviado`. Otherwise it goes back to `pendiente`, at most once; a second
     time it becomes `rechazado` with a reason.
   - Python's `linea_escribio` and `caso_ya_escribio` stop counting an `enviando` row
     older than 2 minutes.
2. **An agent that keeps failing, or ends without a proposal.**
   - The problem: it is relaunched every 5 minutes forever, on the same Claude account.
   - The fix: after 3 consecutive runs of a case that end `fallido`, or `terminado`
     without a new proposal version, the case pauses and the owner is told once.
   - A Claude account with 3 consecutive launch failures is skipped for an hour, while
     another account exists.
3. **One agent slot per line.**
   - The problem: a stuck agent on one line holds up the other.
   - The fix: `agente_corrida` gains `cuenta` (with a migration). The in-flight check
     and the agent lock are keyed by line, through `rastro`.
4. **Notices that expire or fail.**
   - Unanswered approval notice: one reminder is sent before it expires.
   - Case past its SLA with no reply: one reminder to the owner.
   - Failed `aprobacion`/`bloqueo` notices: shown on the board (`notices_failed`) and in
     the panel (ES/EN/PT).
5. **A dead worker.**
   - The problem: the worker's backup tick and notices die with it.
   - The fix: the Python tick reads `workerBeat.at` from the plugin store. A beat older
     than 3 minutes is reported once to the owner and shown in the tick output. A missing
     key is not an alert.
6. **Quoted replies.**
   - The problem: replying to the notice message itself is not recognized.
   - The fix: the sidecar stores the quoted message id (`cita_id`). The owner's `si`/`no`
     quoting a notice applies to that notice, even when several are live.

## Checklist

- [ ] W1 Stale `enviando` reconciled by the sidecar; Python stops counting it as
      written (test/almacen, test/envio, scripts/check-casos).
- [ ] W2 Case pause and account skip after repeated agent failures, with one owner
      notice (scripts/check-casos).
- [ ] W3 Per-line agent slot and lock (scripts/check-casos).
- [ ] W4 Approval reminder, SLA reminder, failed notices on the board and panel
      (scripts/check-casos, test/panels, reduced shots).
- [ ] W5 Dead-worker detection from the Python tick (scripts/check-casos).
- [ ] W6 Quoted replies to a notice (test/sidecar-mensajes, test/almacen,
      scripts/check-casos).
- [ ] W7 Checks green without the full screenshot matrix; version bump; PR ready.

## Acceptance

- A reply whose send was cut by a sidecar crash goes out, or is marked as failed with a
  reason, within about 3 minutes of the sidecar coming back. It is never stuck in
  `enviando`.
- No case is relaunched more than 3 times in a row without progress; the owner hears
  about it.
- A stuck agent on one line does not delay the other line's agent.
- The owner gets one reminder before an approval expires. A failed notice is visible on
  the board.
- With the worker dead, the owner hears about it from the next tick.
- Quoting a notice with `si` approves that notice.

Each fix is tested for every install:

- one line and several lines;
- Jev off or without a key;
- no approval number;
- `local` accounts.

## Checks

- `PYTHONDONTWRITEBYTECODE=1` for every Python step.
- Every `npm run check` step except `npm run shots`.
- Reduced shots for the panels W4 touches.
