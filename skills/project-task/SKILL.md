---
name: project-task
description: >-
  For a project's central agent: open a task tab (tmux window) inside the
  project's own tmux session running a worker cursor-cli agent that reports
  back to the central agent via cc-report project:<name>. Code work goes in a
  git worktree (--repo, --ticket/--branch) created like Control Center's
  worktrees; other work runs in the project dir. Also message a task tab or
  list them. Use when delegating a self-contained piece of project work, when
  the user says "open a tab for X", "spin off a task", "start ticket LW-#### for
  this project", "delegate X", or invokes /project-task.
---

# Delegate project work to a task tab

You are (or are acting for) the **central agent** of a `~/projects/<name>` project, in its tmux session. Self-contained work goes in its own tab so you stay free to manage. Resolve the binary: `project-task` on `PATH`, then `~/.local/bin/project-task`, then `~/.agents/skills/project-task/project-task`. The project is inferred from your cwd / tmux session; pass `--project <name>` only from elsewhere.

## Decide the kind of tab first

| The work is… | Use |
|---|---|
| code changes in a repo, with a Jira ticket | `project-task --repo <repo> --ticket <KEY> "<task>"` |
| code changes in a repo, no ticket | `project-task --repo <repo> --branch <name> "<title>" "<task>"` (or omit `--branch`: defaults to `<project>-<title-slug>`) |
| research, docs, drafts, reviews, anything not touching a repo | `project-task "<title>" "<task>" [--dir sub]` |

**Rule: code changes always happen in a worktree.** Never point a worker at a repo's main checkout, never clone into the project directory. If Daniel names a ticket or a repo, it is a worktree tab. If a plain tab discovers it needs repo changes, it reports back and you reopen it with `--repo`.

`<repo>` is a mkpanes alias (`lists`, `api`, `smartsense-one-skeleton`, … — the `case "$ARG"` block in `~/.local/bin/mkpanes` is the list) or a path to a git repo. Only aliased repos appear on Control Center's worktrees tab; if a repo you need is missing, tell Daniel to add the alias to mkpanes.

## What a worktree tab does

Delegates to `mkpanes <repo> -w <branch> -s <project-session> --prompt-file …`, so it behaves exactly like Control Center's worktrees:

- worktree `<repo>_<branch>` next to the repo; branch fetched from origin, reused if it exists, otherwise created from the default branch (`--from <base>` to override)
- vim / agent / shell panes; `nvm use && <install>` in a bottom pane when there is a `package.json`
- the worker prompt: with `--ticket`, start with `/start-ticket <KEY>` (plan → Daniel approves in that chat → implement → `push-branch` → `babysit-branch`); without, commit on the branch and ask before pushing
- tab name keeps the ticket key / branch so both the project session and the worktrees tab can find it

## Arguments

- **title**: short, unique, tab-friendly (≤ 40 chars, no `:` or `.`). With `--ticket` it defaults to the key.
- **task**: one paragraph. What to produce, where, how the worker knows it is done, constraints. With `--ticket` and no task text, the worker just works the ticket.
- One task per tab. Do not open a tab for something you can do in a minute.

The worker's prompt is saved to `.cc/tasks/<slug>.txt`. It tells the worker to read `PROJECT.md`, never edit it, and report to you with `cc-report project:<name> "<title>: …"` on start, progress, blocked, and done.

## Reports from workers

They arrive in your chat as `[report HH:MM] (severity) <title>: <text>` and are appended to `.cc/inbox.jsonl`. For each:

1. Fold the result into `PROJECT.md` (Current state, tick/add Next steps, Log line).
2. If the worker asked something you can answer, reply with `project-task --message "<title>" "<answer>"`. Ticket workers wait for Daniel's plan approval in their own chat — tell Daniel which tab needs him rather than approving on his behalf.
3. If Daniel is needed, pass it upward: `cc-report projects "<name>: <title> needs …" --severity attention`.
4. When a task finishes, send `cc-report projects "<name>: <title> done — <one line>"`.

## Other commands

```bash
project-task --list                          # task tabs in this project, with their directories
project-task --message "<title>" "<text>"    # type into a task tab's agent
```

## Rules

- Never open a tab named `central`.
- Do not start a second tab for the same work; use `--message` to steer the existing one.
- Closing finished tabs and removing worktrees is Daniel's call (`wrap-up` skill), not yours.
