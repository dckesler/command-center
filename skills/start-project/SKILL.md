---
name: start-project
description: >-
  Start or resume a project in ~/projects: create the directory and PROJECT.md
  brief if needed, open a dedicated tmux session in a new Alacritty window, and
  launch cursor-cli as the project's central agent, which reports to Control
  Center's projects specialist. Use when the user says "start a project",
  "new project called X", "resume project X", "open project X", or invokes
  /start-project.
---

# Start a project

One command does everything:

```bash
start-project <name | path> [--new | --resume] [--no-attach] [--goal "<one paragraph>"] [--context "<background>"] [--epic KEY]
```

Resolve the binary: `start-project` on `PATH`, then `~/.local/bin/start-project`, then `~/.agents/skills/start-project/start-project`.

## What it does

1. `~/projects/<slug>` — created if missing (`--goal` seeds the brief's Goal, `--context` its Current state, `--epic` its Epic line).
2. `PROJECT.md` — written from the standard template if missing: `# name`, `**Status:**`, `**Updated:**`, `**Epic:** KEY|none`, `## Goal`, `## Current state`, `## Next steps` (checkboxes), `## Log`.
3. tmux session named after the project (window `central`, cwd inside the project, vim / agent / shell panes) — only if it doesn't exist.
4. `cursor-cli --model <commands.projectModel>` (default `claude-opus-5-5-high`, the latest Opus — it plans and delegates, so it gets the strongest model; `""` = CLI default) in the agent pane as the **project central agent**. Its prompt (saved to `.cc/central-prompt.txt`) makes it own `PROJECT.md`, delegate with `project-task`, absorb `[report]` lines from workers, and report upward with `cc-report projects "<name>: …"`.
5. A new Alacritty window attached to the session. If the session is already showing somewhere, it says so instead of opening a duplicate.

Prints one summary line; that line is the result to show the user.

## When invoked by an agent

- From Command Center (hub specialists): the TUI's `n`/`s` keys and the projects specialist's `open_project` / `create_project` tools already run this. Do not also run it manually.
- From any other agent: run it with the name the user gave. If they described the project, pass `--goal`. Do not create `PROJECT.md` yourself; let the script do it.
- Do not start a project for `command-center` — it is reserved.

## After

Report the printed line. If a new project was created, tell the user the central agent will ask them about the goal in the new window.
