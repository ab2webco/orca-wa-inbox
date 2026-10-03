# Case file for the agent + automations that turn themselves on

## Objective

The case agent gets one short line and a per-case `.md` file; its rules live in the
harness (skill `whatsapp-soporte` + plugin `CLAUDE.md`), not in a long launch prompt.
After an update/re-approval the plugin's automations come back enabled without a click.

## Scope

- `wa-scope` tick writes `~/.wa-inbox/casos/caso-<id>.md` before launching the case agent:
  case id, chat, sender role, classification, Jev verdict, project, verbatim case
  messages only (no unrelated chat context; at most a short context summary),
  transcripts and media paths, prior proposals and hold reasons, allowed levels.
- The brief sent to the agent is one line pointing at that file and the skill.
- Rules move from `prompts/triage.md` into the `whatsapp-soporte` skill / `CLAUDE.md`;
  `prompts/triage.md` becomes a short pointer.
- The project-agent dispatch brief uses the same case file.
- The worker enables the plugin's own automations (tick + triage) when it finds them
  disabled after the plugin (re)starts.

## Checklist

- [x] T1 Case file writer (`casos/caso-<id>.md`), only case messages, tests in check-casos.
      Proof: check-casos "el caso en un archivo: solo lo del caso" (5 checks), 941/941 green.
- [x] T2 One-line brief for the case agent and the dispatch to project agents.
      Proof: check-casos agent+dispatch section 626/626 ("le da UNA linea: atiende el caso",
      "el brief del despacho lleva el caso y lo aprobado, y nada de otro caso"); panels
      `sin-prompt` text names the case file.
- [x] T3 Rules into the skill/CLAUDE.md, `prompts/triage.md` as a pointer; harness tests.
      Proof: check-harness 50 checks (rules in AGENTS.md + skill, pointer <= 30 lines, names
      the skill, no steps); check-prompts 15; resolver 29/29; manifest 110/110.
- [ ] T4 Worker enables the plugin automations found disabled; worker tests.
- [ ] T5 Live E2E after deploy: a real case answered from the case file; automations
      enabled after re-approval without a click.

## Acceptance

- A case brief never carries messages from other cases.
- After re-approval both automations are enabled by the plugin itself.
- All suites green: check-casos, worker, manifest, panels, voseo, datos-reales, harness.
