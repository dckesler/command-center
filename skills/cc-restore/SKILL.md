---
name: cc-restore
description: >-
  Rebuild the Command Center from a cc-snapshot in one command: recreate the
  tmux sessions and windows that are missing (every open project and its task
  tabs included), resume each agent's conversation in its pane or relaunch it
  with its original prompt, hand the hub specialists' conversations back to
  the TUI, and attach. Use when Daniel says "restore command center", "resume
  my command center", "bring my session back", after a reboot or tmux
  restart, or when "cc-restore" is mentioned.
---

# Rebuild the Command Center with cc-restore

```
cc-restore [name]                 # default: latest — rebuild, resume, attach
cc-restore --dry-run              # print every step, change nothing
cc-restore --revive               # also bring back agents that had already exited at save time
cc-restore --no-fresh             # never relaunch an agent whose conversation is unknown (leave a shell)
cc-restore --no-agents            # windows and layouts only; agent panes stay shells
cc-restore --no-attach            # do not attach / switch the client afterwards
cc-restore --session <name>…      # only these tmux sessions
cc-restore --project <name>…      # only these projects' sessions
```

From a fresh terminal after a reboot, `cc-restore` alone is the whole start: it needs no
tmux running and ends attached to the session that was current. Run `cc-snapshot show
[name]` first if you want to see what will come back.

Per session in the snapshot: create it if missing (same `@idx`/`@label`), create each
window that is **not already open** (matched by name; open windows are never touched, so
re-running is safe), split to the saved pane count, apply the saved layout, set
`@cc_role`/`@cc_project`/`@agent_pane`/`@agent_cmd`, then type into each pane:
`cd <cwd> && clear && <program>` —

- `tui` → `bun start` (typed last, 2 s after the others, so its `cc-central ensure` finds
  the central already resuming); just before it, the snapshot's hub specialist ids are
  written to `hub-agents.json`, which the TUI reads to resume each specialist's
  conversation (`Agent.resume`) instead of starting a blank one;
- `central` / `agent` → `<commands.agent> [--model <saved>] --resume=<conversation id>`;
  with no known conversation, the launcher's recorded command instead (its original
  prompt; a `/start-ticket` becomes `/resume-ticket`) unless `--no-fresh`;
- `dash` → `cc-dash <project>`; `editor` → the editor; `shell` → nothing — except pane 3
  of a worktree window whose checkout has no `node_modules`, which gets
  `nvm use && <install>` like mkpanes does.

Agents that had already exited when the snapshot was taken (finished task workers, a quit
central) come back as shells unless `--revive`, which resumes their conversation or
relaunches them. Skipped with a note: windows whose first pane directory no longer exists
(a worktree that was wrapped up), agents with neither a conversation nor a launch command,
and agents in a `[protected]` window (the Command Center dev session).

Finally the client is attached to the saved current session (outside tmux) or switched
to it (inside tmux); `--no-attach` skips this, and when only some sessions were restored
and the current one is not among them nothing happens.

Resumed agents pick up their own conversation; nothing is typed to them. They are not
told anything happened — if the gap matters, tell them yourself. Hub specialists do get
one line saying the Command Center restarted. Windows restored into an existing session
get their saved index when it is free, otherwise the next one.
