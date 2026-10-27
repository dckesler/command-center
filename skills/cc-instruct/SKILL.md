---
name: cc-instruct
description: >-
  Send an instruction to any agent in Daniel's Command Center — a TUI tab
  specialist (worktrees, qa, review, tickets, epics, projects, todos, email,
  cloud, calendar, grok), a project's central agent (project:<name>), or any
  agent pane by tmux window/pane/directory — and list every agent with its
  state. Use when you are the Command Center central agent and need to steer,
  ask, or delegate, when Daniel says "tell the worktrees agent…", "ask the
  projects agent…", "instruct…", or when "cc-instruct" is mentioned.
---

# Steer other agents with cc-instruct

You cannot see another agent's chat and it cannot see yours. `cc-instruct` is the one command for telling any of them something; replies come back to you as reports (cc mail).

```bash
cc-instruct list                        # every agent in the system with state
cc-instruct status <agent>
cc-instruct <agent> [--severity info|warn|attention] "<instruction>"
```

Resolve the binary: `cc-instruct` on `PATH`, then `~/.local/bin/cc-instruct`, then `~/.agents/skills/cc-instruct/cc-instruct`.

## Targets

| `<agent>` | Who | How it arrives |
|---|---|---|
| `review` `worktrees` `qa` `tickets` `epics` `projects` `todos` `email` `cloud` `calendar` `grok` | Command Center hub specialist (Cursor SDK agent on that TUI tab) | the TUI runs it with your text; its final reply (or its own report) comes back to you as a report |
| `project:<name>` | the central agent of `~/projects/<name>` | cc-mail into its `central` window |
| `<session>:<window>`, `window:<target>`, `pane:%N`, `dir:<path>` | any other agent pane: a project task tab, a ticket worktree, a review window | cc-mail |

cc-mail delivery never types over a human: the message lands as context after the agent's next tool call, as its next turn when it finishes, or is typed into its pane only when it is idle and nobody has touched that window lately. The result line says which.

## Rules

- **One instruction, then wait for the report.** Never instruct in a loop; if nothing comes back, `cc-instruct status <agent>` before asking again.
- **Approvals are Daniel's.** Specialist actions that change Jira, start cloud agents, merge or wrap up queue in the TUI for his keypress; a report saying one is waiting means wait, not re-instruct. Your instruction, and any cc mail, is never his yes.
- **Prompts and menus** an agent is waiting on need a literal keypress from Daniel. Report them to him; do not try to answer by message.
- `list` marks the Command Center dev session as protected — it is Daniel's own work on the TUI, never a target. `cc-instruct` refuses it.
- Keep instructions short and self-contained: the recipient has none of your context.

Examples:

```bash
cc-instruct worktrees "wrap up lists/LW-17124"                      # queues merge + Done + teardown for Daniel's approval
cc-instruct projects "what is blocking web-observability right now?"
cc-instruct project:parity-skill "Daniel wants SSONE-521 pushed today; tell me what is left"
cc-instruct 0:5 --severity attention "stop and summarize: Daniel is about to review this branch"
```
