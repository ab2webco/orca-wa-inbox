# No message that needs an answer goes unanswered

## Objective

A read-only review of the live store (2026-10-09 to 10-15) found requests that never got a
reply, and case agents that loop because they start blind. Fix the causes in the plugin, so
a message that asks for something always reaches an agent, and the agent knows what the
line already did in that chat.

## Findings (live data, counts only; no real identifiers here)

- Jev's skip comes only from the risk scores. A client's request class no longer skips
  since ed581fd (`skip_que_vale`), but a short answer to the line's own question ("yes"
  from the owner right after the agent asked whether to go ahead) is still dropped as a
  pleasantry.
- A group voice note is transcribed only if the chat already has an open case, so a voice
  note that would open the case is never transcribed and Jev drops it as
  `empty_or_audio_only`. No transcription has been stored since 2026-10-09.
- Triage sees one message alone: a follow-up such as "hi, what happened?" after unanswered
  messages is judged a pleasantry.
- A message that arrives while the chat's case is blocked joins that case and nobody
  handles it.
- The case file carries only that case's messages, never what the line already sent in the
  chat, the earlier cases, the documents it produced or the owner's corrections. Agents ask
  the owner what they already know, and ask permission for what the owner already ordered
  (one case asked three times). Since 10-10: 15 relaunches, 11 retracted proposals and 9
  owner corrections.
- Jev's draft review sees only the reply text, so "we updated the document" is held as an
  unverified status even when the agent did the work and reported the evidence.

## Scope

- J2 Triage context: Jev sees the last messages of the chat, both directions, and whether
  the line's last message asked a question; an answer to the line's pending question is
  never skipped.
- J3 Group voice notes in an active chat are transcribed before triage, within the
  existing cap; attachment-only messages from a client or an operator are not skipped.
- K1 A new message never joins a blocked case: it opens a new case related to it.
- M1 Chat memory in the case file and the worker brief: recent messages of the chat (both
  directions), earlier cases with their final replies, and the owner's corrections given
  on earlier cases of this chat.
- O1 The owner's order is the approval: the brief tells the agent to do it and not to ask
  again whether to do it.
- R1 Jev's draft review sees the agent's reported evidence (`--resumen`) and a status
  backed by it is not held.

Out of scope: per-chat configuration in the live store (the owner's call), duplicate
contact names, the Jev service model itself.

## Checklist

- [x] J2 Triage sees recent chat messages and the line's pending question.
  (check-casos J2 RED 10 FALLA, GREEN 13/13)
- [x] J3 Group voice notes transcribed before triage; attachments not skipped.
  (check-casos J3 RED 4 FALLA, GREEN 4/4; attachment-only skips left as they are)
- [x] K1 A blocked case does not absorb new messages.
  (check-casos K1 RED 5 FALLA, GREEN 5/5)
- [x] M1 Chat memory in the case file and the worker brief.
  (check-casos T8 case-file section RED 4 FALLA, GREEN 241/241; size-cap check added after, 3/3)
- [x] O1 Owner order executes without a second ask.
  (check-harness RED 2 files, GREEN; check-casos owner-case section RED 3 FALLA, GREEN 29/29)
- [ ] R1 Draft review sees the agent's evidence.
- [ ] Z1 Release checks and version.

## Acceptance criteria

- "yes" right after the line asked a question is not skipped.
- A group voice note in an active chat with no open case is transcribed and judged on its
  text.
- A message after a blocked case opens a new case related to it.
- The case file of a new case in a chat shows what the line sent before, the earlier
  cases' replies and the owner's corrections, within the size cap.
- An owner case brief says the order is the approval.
- A reply that says the work was done, with evidence in `--resumen`, is not held as
  unverified.

## Checks

Strict TDD per task (RED observed, then GREEN). Release suite: check-casos, panels, worker,
almacen, envio, sidecar tests, manifest, resolver, userdata, and the scripts/check-* set.
