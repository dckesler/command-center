---
name: cc-snapshot
description: >-
  Save the live Command Center to a named snapshot: every tmux session, window
  and pane (layouts, working directories, what runs in each pane) and the
  conversation id of every agent, so cc-restore can rebuild it later with the
  agents resumed. Use when Daniel says "snapshot command center", "save my
  command center state", "save my session", before a reboot or a tmux
  restart, or when "cc-snapshot" is mentioned.
---

# Save the Command Center with cc-snapshot

```
cc-snapshot save [name] [--note "…"]   # default name: timestamp; also written as "latest"
cc-snapshot list                        # saved snapshots, newest first
cc-snapshot show [name]                 # what a snapshot holds (default: latest)
```

Snapshots live in `~/.config/command-center/snapshots/<name>.json`. One captures, for every
tmux session (with its `@idx`/`@label` numbering) and window (`@cc_role`, `@agent_pane`):
the layout string, and per pane the cwd, the foreground program, its kind and — for agent
panes — the Cursor conversation id to resume. Kinds: `tui` (the dashboard, `bun start`),
`central` (the manager), `dash` (`cc-dash <project>`), `agent`, `editor`, `shell`.

How agent conversations are identified, in order: the pane recorded by the hooks on the
agent's state events (`agents.jsonl` `pane`, exact); for a directory with a single agent
pane, the newest conversation the feed saw there, else the newest transcript directory
for that workspace; for several agents in one directory that predate pane recording,
each process is paired with the transcript created nearest its start time (best effort —
`show` marks unresolved agents `agent?`). Agents resolve exactly after their next turn.

Durable state — todos, inbox, mailboxes, the central's LOG.md, worktrees — is already on
disk and is not part of a snapshot. The Command Center dev session (an agent working on
this repo) is saved as `[protected]` and restored as shells only.

Typical: `cc-snapshot save before-reboot --note "mid LW-18147"` → later `cc-restore
before-reboot`. Taking a snapshot changes nothing; take one whenever.
