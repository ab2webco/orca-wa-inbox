# Claude Code recap in the "finished" summary

## Objective

The summary of finished agents shows `orca-wa-inbox x1` and nothing else, because agents
rarely leave a `wa-scope recap` line. Claude Code already writes its own recap (the
"※ recap:" the owner sees): what was done and the next step. Owner decision (2026-10-13):
the summary carries that recap next to the project, and a project that finishes again
without a new recap is not repeated.

## Facts (measured on the owner's machine, read-only)

- Claude Code stores each recap in the session transcript
  `<config>/projects/<cwd with every non-alphanumeric character as "-">/<session>.jsonl` as
  `{"type": "system", "subtype": "away_summary", "content", "cwd", "timestamp"}`.
- Last week: 591 recaps in 42 sessions, written about 3 minutes after the turn ends
  (p10 182 s, p50 184 s, p90 195 s), 200 to 335 characters, in the owner's language.
- Only Claude Code writes it (not Codex), and only while the user is away from that session.
- `~/.claude/projects` is where Orca keeps every account's transcripts (a link to Orca's
  own folder); `CLAUDE_CONFIG_DIR` can point elsewhere.

## Scope

- Each accumulated turn also keeps its worktree path (`p` in the row's JSON).
- Digest: a turn without a `wa-scope recap` line takes the latest Claude Code recap of its
  worktree written from the turn's `at` until the summary is built. Whitespace collapsed,
  paths replaced by "…", at most `LARGO_RECAP_CLAUDE` (600) characters or it is dropped
  (never truncated), and nothing secret-shaped. Only the tail of transcripts modified since
  the turn is read.
- Wait: in the first `ESPERA_RECAP_S` (240 s) of a new summary window, the summary waits
  while a turn younger than that has no recap yet. Bounded by the window start, so new
  turns cannot postpone it forever.
- No repeats: when a worktree's last summary line carried a recap and a new turn of it has
  no newer recap, that turn is left out (closed as `resumido`). A line shown without a
  recap clears the mark, so agents that never leave one (Codex) keep appearing as today.
  Marks per line in `settings`, swept after 7 days.
- Setting `orca_claude_recap` (`on` by default) / panel field `orcaNotices.claudeRecap`:
  switch in the Orca notices card under the summary, ES/EN/PT. Off: no transcript is read
  and there is no wait; `wa-scope recap` lines still show.
- Out of scope: the one-by-one "finished" notice (summary at 0 minutes), waiting/blocked
  notices.

## Checklist

- [x] C1 Setting `orca_claude_recap` + panel field (`check-clis`).
- [x] C2 Reader of Claude Code recaps + digest uses it after `wa-scope recap`
  (`check-casos`).
- [x] C3 Wait for the recap at the start of a window, bounded (`check-casos`).
- [x] C4 No repeat without a new recap (`check-casos`).
- [x] C5 Switch in the Orca notices card, ES/EN/PT (`test/panels.test.mjs`), screenshots.
- [x] C6 Full checks, task file, release.

## Acceptance criteria

- A Claude Code recap of the worktree written after the turn appears on its project line.
- A `wa-scope recap` line wins over the Claude Code recap.
- A recap from before the turn, over 600 characters, or secret-shaped does not show; paths
  never travel.
- With the switch off, lines are exactly as in v4.30.6.
- A project shown with a recap that finishes again without a new one is not listed again;
  one shown without a recap is listed again.

## Checks

- `python3 scripts/check-casos`, `scripts/check-clis`, `node test/panels.test.mjs`
- `scripts/check-voseo`, `scripts/check-datos-reales`, reduced screenshots of the card.

## Release

v4.30.7. Checks run on the final code: check-casos 2461/2461, panels 1714/1714, worker
719/719, almacen 357/357, envio 138/138, sidecar-mensajes 142/142, sidecar-pairing 129/129,
sidecar-build 11/11, manifest 112/112, resolver 55/55, userdata 25/25, check-closing 36/36,
check-lid 51/51, check-clis (561 settings checks), check-panels, check-voseo, check-prompts,
check-resolver, check-harness, check-datos-reales. Screens looked at: the Orca notices card,
ES light 390 and ES dark 1440. Live read-only check: the reader found the real recaps of two
sessions in 0.1 s with an isolated HOME. Not verified live: a digest sent by the installed
plugin.
