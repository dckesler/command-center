---
name: cc-restore
description: >-
  Rebuild the Command Center from a cc-snapshot: recreate the tmux sessions
  and windows that are missing, with their layouts and working directories,
  and resume each agent's conversation in its pane. Use when Daniel says
  "restore command center", "resume my command center", "bring my session
  back", after a reboot or tmux restart, or when "cc-restore" is mentioned.
---

# Rebuild the Command Center with cc-restore

```
cc-restore [name]                 # default: latest
cc-restore --dry-run              # print every step, change nothing
cc-restore --no-agents            # windows and layouts only; agent panes stay shells
cc-restore --session <name>…      # only these tmux sessions
```

Run `cc-snapshot show [name]` first to see what will come back. Then, per session in the
snapshot: create it if missing (same `@idx`/`@label`), create each window that is **not
already open** (matched by name; open windows are never touched, so re-running is safe),
split to the saved pane count, apply the saved layout, set `@cc_role`/`@agent_pane`, then
type into each pane: `cd <cwd> && clear && <program>` —

- `tui` → `bun start` (typed last, 2 s after the others, so its `cc-central ensure` finds
  the central already resuming);
- `central` / `agent` → `<commands.agent> [--model <saved>] --resume=<conversation id>`;
- `dash` → `cc-dash <project>`; `editor` → the editor; `shell` → nothing.

Skipped with a note: windows whose first pane directory no longer exists (a worktree that
was wrapped up), agent panes with no known conversation id (left as shells — start the
agent by hand or with `mkpanes`/`start-project`), and agents in a `[protected]` window
(the Command Center dev session).

Resumed agents pick up their own conversation; nothing is typed to them. They are not
told anything happened — if the gap matters, tell them yourself. Windows restored into
an existing session get their saved index when it is free, otherwise the next one.
