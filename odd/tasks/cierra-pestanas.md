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
- T5. When a case reaches `cerrado` or `respondido` (any path: every stage change goes
  through `caso_mover`), the plugin closes the tabs of all that case's runs and dispatches
  that are not in flight: by stored `tabId` with `--tab` (current handle from `terminal
  list`), or by the stored handle when there is no `tabId`. A dispatch waiting for the
  customer (`esperando`) is in flight and is not closed. Best-effort from the tick: the
  transition only asks for the next sweep (never blocks on Orca); a failure retries on the
  next sweep.
- T6. Adoption of tabs opened before this fix: in the plugin's OWN workspace only (the
  root of the `plugin-workspaces/<plugin id>` folder, where only the case agent runs), the
  sweep closes every tab whose handle and `tabId` are not in flight, whatever its title,
  once it has been idle (`lastOutputAt`) for at least `PESTANA_QUIETA_S` (10 minutes), and
  never while a run is opening or an automation run of that workspace is in flight. The
  folder's `::workspace:` children keep their own cleanup. Project workspaces keep the
  strict rule (stored `tabId` or the title rule).

Out of scope: the owner's own terminals in any workspace are never touched; project
workspaces keep today's rule (only tabs the plugin opened, identified by stored `tabId`
or the title rule).

## Checklist

- [x] T1 close with `--tab`, fallback without (RED → GREEN)
- [x] T2 store `tabId` for runs and dispatches (RED → GREEN)
- [x] T3 sweep by `tabId`, wider title rule, precise in-flight skip (RED → GREEN)
- [x] T4 closed-elsewhere run still closes its tab (RED → GREEN)
- [x] T5 closed or answered case closes its finished runs' and dispatches' tabs (RED → GREEN)
- [x] T6 idle tabs in the plugin's own workspace are adopted and closed (RED → GREEN)
- [ ] Release

## Acceptance criteria

- With the fake Orca CLI: closing a run calls `terminal close --terminal <h> --tab`.
- A tab that came back with a new handle and a new title is closed by the next sweep
  because its `tabId` belongs to a finished run; a tab of an in-flight run is not.
- A terminal that is not the plugin's (no stored `tabId`, title not matching) is never
  closed in a project workspace.
- Moving a case to `cerrado` makes the next tick close its finished dispatch's tab by
  handle; a finished dispatch of an open case keeps its tab.
- In the plugin's own workspace, an idle tab (10+ minutes) that is not in flight is closed
  whatever its title; a recent one, an in-flight one, and any tab of a project workspace
  are not.

## Checks

- `scripts/check-casos`, `scripts/check-clis`, `scripts/check-harness`.
