---
name: cc-snapshot
description: >-
  Save the live Command Center to a named snapshot: every tmux session, window
  and pane (layouts, working directories, what runs in each pane), every open
  project and its task tabs, the conversation id of every agent (running or
  finished) and the hub specialists' agent ids, so cc-restore can rebuild it
  later with everything resumed. Use when Daniel says "snapshot command
  center", "save my command center state", "save my session", before a reboot
  or a tmux restart, or when "cc-snapshot" is mentioned.
---

# Save the Command Center with cc-snapshot

```
cc-snapshot save [name] [--note "…"]   # default name: timestamp; also written as "latest"
cc-snapshot list                        # saved snapshots, newest first
cc-snapshot show [name]                 # what a snapshot holds (default: latest)
```

Snapshots live in `~/.config/command-center/snapshots/<name>.json`. One captures:

- every tmux session (with its `@idx`/`@label` numbering) and, when it is a `~/projects`
  project started by `start-project`, which project;
- every window: layout, `@cc_role`, `@agent_pane`, the exact command the launcher typed
  into the agent pane (`@agent_cmd` — set by `mkpanes`, `start-project`, `project-task`),
  and for project task tabs the ticket, prompt file and whether it is a worktree;
- every pane: cwd, foreground program, kind — `tui` (the dashboard, `bun start`),
  `central` (the manager), `dash` (`cc-dash <project>`), `agent`, `editor`, `shell` — and
  for agent panes the Cursor conversation id to resume. The window's agent pane is an
  agent pane even when the agent has exited (a finished worker): it is saved `(idle)`
  with its conversation so `cc-restore --revive` can bring it back;
- the hub specialists' SDK agent ids (`hub-agents.json`), so the TUI resumes their
  conversations after a restart.

How agent conversations are identified, in order: the pane recorded by the hooks on the
agent's state events (`agents.jsonl` `pane`, exact); for a directory with a single agent
pane, the newest conversation the feed saw there, else the newest transcript directory
for that workspace; for several agents in one directory that predate pane recording,
each process is paired with the transcript created nearest its start time (best effort).
`show` marks each agent `✓` (resumable), `↻` (no conversation, but relaunchable with its
original prompt), `?` (neither). Agents resolve exactly after their next turn.

Durable state — todos, inbox, mailboxes, the central's LOG.md, worktrees, PROJECT.md — is
already on disk and is not part of a snapshot. Projects without a tmux session are not
"open" and are not saved. The Command Center dev session (an agent working on this repo)
is saved as `[protected]` and restored as shells only.

Typical: `cc-snapshot save before-reboot --note "mid LW-18147"` → later `cc-restore
before-reboot`. Taking a snapshot changes nothing; take one whenever.
