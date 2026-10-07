# Agent tabs close for good

## Objective

The plugin's case agents and project dispatches leave their Orca tabs open. On the owner's
machine, the plugin workspace had 12 open tabs and none of them matched a recorded terminal
handle. The tick believes it closed them.

Observed (read-only, live):

1. `cierra_terminal` runs `orca terminal close --terminal <handle>` without `--tab`. That
   closes the pane session, not the tab. Orca keeps the tab and restarts a shell in it
   (title `..orca-wa-inbox`) or resumes Claude (title `✳ WhatsApp case 54`), under a new
   handle. Example: run 284 (case 78) was recorded `terminado` at 13:32 with handle A; a tab
   titled `WhatsApp case #78` is still open with handle B (`sleeping`, `ptyId` null).
2. `cierra_huerfanas` recognizes a plugin tab only by an exact title regex
   (`WhatsApp case #N`, `WhatsApp: case agent`, `Despacho ...`). Claude and the shell
   rename the tab, so it never matches. It also skips every `agente` tab while ANY run is
   in flight, which is almost always.

## Scope

- T1. Close the whole tab: `cierra_terminal` passes `--tab`. If the installed Orca rejects
  `--tab` (an older CLI), fall back to today's call. The `/exit`, `exit` and
  `terminal stop` fallbacks stay.
- T2. Track the tab, not only the handle: when a case-agent run or a project dispatch opens
  its terminal, store its `tabId` (from `orca terminal show --terminal <h> --json`, or
  from `terminal list` filtered by the handle) in a new nullable column on
  `agente_corrida` and on `caso_despacho` (migration that keeps existing rows).
- T3. The orphan sweep (`cierra_huerfanas`) finds tabs by `tabId`: a live tab whose `tabId`
  belongs to a run or dispatch that is no longer in flight is closed with its CURRENT
  handle and `--tab`, whatever its title. A tab of an in-flight run or dispatch is never
  touched. The title rule stays for tabs opened before T2 (no stored `tabId`), widened to
  `WhatsApp case #?N` with an optional leading status glyph, and it no longer skips every
  `agente` tab while some other run is in flight: it skips only tabs whose handle or
  `tabId` is in flight.
- T4. A run closed through the path "terminal no longer alive" (`agente_cierra(con, None,
  ...)`) still closes its tab by `tabId` if the tab is alive under another handle.

Out of scope: the owner's own terminals in any workspace are never touched; project
workspaces keep today's rule (only tabs the plugin opened, identified by stored `tabId`
or the title rule).

## Checklist

- [ ] T1 close with `--tab`, fallback without (RED → GREEN)
- [ ] T2 store `tabId` for runs and dispatches (RED → GREEN)
- [ ] T3 sweep by `tabId`, wider title rule, precise in-flight skip (RED → GREEN)
- [ ] T4 closed-elsewhere run still closes its tab (RED → GREEN)
- [ ] Release

## Acceptance criteria

- With the fake Orca CLI: closing a run calls `terminal close --terminal <h> --tab`.
- A tab that came back with a new handle and a new title is closed by the next sweep
  because its `tabId` belongs to a finished run; a tab of an in-flight run is not.
- A terminal that is not the plugin's (no stored `tabId`, title not matching) is never
  closed.

## Checks

- `scripts/check-casos`, `scripts/check-clis`, `scripts/check-harness`.
