# WAINBOX-69 — Plane refinement skill

## Where it lives and where it came from

- **Skill:** `~/.claude/skills/plane-refinement/SKILL.md`. It is a user-level skill, so it is not
  part of this repo.
- **Source:** the Jira refinement flow in the `koombea-workflows` marketplace:
  - `refine-ticket`: read the ticket, load the project context, analyze what is missing, draft,
    confirm, update;
  - `ticket-to-ready`: the ticket standard, the gates and the complexity rubric.
- **Caveat about the source:** neither plugin is installed or enabled in this setup. No
  refinement skill exists in `~/.claude/skills` or among Orca's bundled skills
  (`orca skills list`). These two are the closest match to "the Jira refinement skill the owner
  uses". If the owner meant a different one, the skill should be re-based on it.

## What it adds for Plane

- **Feature detection.** Before planning any field, it reads the project's feature flags
  (`is_issue_type_enabled`, `cycle_view`, `module_view`, `estimate`) and what already exists
  (states, labels, cycles, modules). When something is missing it degrades instead of failing:
  - no work item types: an epic becomes a `[Epic]` parent item;
  - no estimate system: the estimate goes in a body section;
  - no cycles: cycles are skipped.
- **CLI first.** Everything `orca plane` covers goes through it. The Plane MCP is used only for
  what the CLI lacks: feature flags, estimate points, scheduling relations, and creating a
  module.
- **Plane traps it guards against:**
  - `save-issue --label` replaces the whole label set;
  - there is no relation remove in the CLI;
  - `--workspace all` is rejected on writes;
  - MCP `resolve_work_item_type` **turns the types feature on** as a side effect;
  - feature-gated MCP calls return 404 on editions that lack the feature.
- **A human gate on every write.** Inside an Orca worker, the go comes through
  `orchestration ask` / `decision_gate`, never AskUserQuestion.
- **Ready means checked.** A 16-row definition-of-ready table; the item is ready only when every
  row is PASS or N/A.

## WAINBOX as observed on 2026-11-10

| Feature | State | How the skill handles it |
|---|---|---|
| Work item types | off (`is_issue_type_enabled: false`); MCP `list_work_item_types` returns 404 | The epic is a parent item titled `[Epic] …` |
| Estimates | none (`estimate: null`) | `## Estimate` section in the body |
| Cycles | off (`cycle_view: false`) | Skipped |
| Modules | on, none created | A module is proposed, then created only after a go |
| Labels | none | A minimal taxonomy is proposed, then created only after a go |
| States | Backlog, Todo, In Progress, Done, Cancelled | New items go to Backlog |

## Verification: lint mode run read-only on WAINBOX-54

Commands, all read-only:

- `orca plane issue WAINBOX-54 --comments --children --project WAINBOX --json`
- `orca plane relation list WAINBOX-54 --project WAINBOX --json`
- `orca plane attach list WAINBOX-54 --project WAINBOX --json`

All three returned `ok`. The item is in Backlog, priority `low`, with no labels, no parent, no
children, no relations, no links and no comments. Its body is a five-line list of owner
decisions.

| # | Check | Result | Evidence |
|---|---|---|---|
| R1 | Title formula | GAP | "Baileys features C2–C6 (…)": no area tag, no outcome |
| R2 | Kind fits | GAP | Five independent features in one item; should be an epic with children |
| R3 | Summary | GAP | No summary section |
| R4 | Scope in/out | GAP | Missing |
| R5 | FRs atomic | GAP | Bullets are feature names, not behaviours |
| R6 | Test plan | GAP | Missing |
| R7 | Boolean ACs | GAP | Missing |
| R8 | Dependencies and relations | GAP | Points to `odd/tasks/baileys-mensajes.md` but has no relations |
| R9 | Risks | GAP | C4–C6 are visible to customers (ticks, presence, edits); no risks written |
| R10 | Open questions with defaults | GAP | All five are open owner decisions with no default |
| R11 | Demo steps | GAP | Missing |
| R12 | Estimate | GAP | None; and it should be split |
| R13 | Priority and labels | PASS / GAP | Priority `low` is set; no labels (the project has none) |
| R14 | Parent / module | N/A | No epic exists yet; the project has no modules |
| R15 | DoD | GAP | Missing |
| R16 | State fits | PASS | Backlog, nothing started |

Verdict: **not ready**. The skill's recommendation for it: turn WAINBOX-54 into an epic and add
one child per decision (R9–R12 and R16 in `wainbox-69-baileys-audit.md`), each with its own
owner decision and default. That recommendation is part of the decision gate sent to the lead.
Nothing was written to Plane during this check.
