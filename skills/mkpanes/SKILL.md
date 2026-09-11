---
name: mkpanes
description: Launch a tmux dev workspace via the `mkpanes` command — resolve which repo, whether to create a git worktree, and which branch/ticket, then run it. Primary use is starting work on a Jira ticket in a worktree (`mkpanes <repo> -w <TICKET>`), which opens a tmux window (vim + cursor-cli + shell panes) and auto-runs /start-ticket in the AI pane (or /resume-ticket if the worktree already exists). Use when the user says "mkpanes", "spin up panes", "open a workspace/worktree", "start working on <ticket> in <repo>", "set me up for LW-####", or invokes /mkpanes. Secondary mode opens a plain repo workspace with no worktree.
---

# mkpanes Skill

Resolve the inputs `mkpanes` needs, validate them, then run the command. The script is the source of truth for repo aliases and behavior:

- **Command:** `/Users/devadmin/.local/bin/mkpanes`
- **Signature:** `mkpanes <repo-or-path> [-w <branch>] [--no-ticket] [--no-format] [--qa] [--claude] [--from <base-branch>]`

## What the command does

- **positional 1** — a known repo alias OR any directory path. Defaults to `$PWD` if omitted.
- **`-w <branch>`** — worktree mode. Creates/opens a git worktree named `<repo>_<branch>` next to the repo, fetching or branching from the default branch as needed. In the AI pane it runs `/start-ticket <branch>` (because the branch name is the Jira ticket key) — or `/resume-ticket <branch>` if the worktree already existed, since the ticket was prepped previously.
- **`--no-ticket`** — worktree mode only: run the plain AI CLI instead of `/start-ticket`.
- **`--no-format`** — passed through to `/start-ticket` (skip the formatting check).
- **`--from <base-branch>`** — worktree mode only: when creating a new branch (i.e. it doesn't exist on origin or locally), branch off `<base-branch>` instead of the repo's default branch. Has no effect if the branch already exists.
- **`--qa`** — worktree mode only: QA mode. Creates/opens the worktree (checks out the branch) but does **not** run `/start-ticket`. Instead runs `/qa-ticket <TICKET>` in the AI pane — pulls the QA steps, waits for the tester to work through them, and posts the outcome (pass or issues found) as a Jira comment when done. The ticket is never assigned to Daniel and its status/sprint are never touched. QA worktrees are named `<repo>_qa_<branch>` (instead of `<repo>_<branch>`) so the control center can list them in its dedicated QA tab. This holds even when the branch is already checked out in a dev worktree: QA gets its own `_qa_` directory (a second checkout of the same branch, via `git worktree add --force`), and each mode only ever reuses a directory of its own kind.
- **`--claude`** — use `claude` instead of `cursor-cli` (the default) in the top-right pane. All prompts (plain, `/start-ticket`, `/resume-ticket`, QA, code review) are passed the same way either way. (`--cursor` is still accepted as a no-op for backwards compatibility.)
- **`--code-review`** — code review mode. Starts the AI with a "code reviewer" role prompt and waits for the user to provide code, diffs, or descriptions to review. Works in both plain and worktree mode; takes precedence over `--qa` and `/start-ticket`.

It opens a new tmux window with: top-left `vim`, top-right `cursor-cli` (or `/start-ticket`), and a bottom row of shell panes; in worktree mode with a `package.json` it runs `nvm use && <install>` in a bottom pane, where the install command is detected from the lockfile (`pnpm-lock.yaml` → `pnpm install`, `yarn.lock` → `yarn`, otherwise `npm install`).

The default scenario is **starting a ticket worktree**: `mkpanes <repo> -w <TICKET>`.

## Step 1 — Parse the request

From what the user typed, extract:

1. **Repo** — e.g. "lists", "node-task-worker", or a path.
2. **Branch / ticket** — a Jira key like `LW-17124` (worktree mode) or an explicit branch name. If the user names a ticket or says "worktree", this is worktree mode. If they just say "open <repo>", it's plain mode (no `-w`).
3. **Flags** — `--no-ticket` (they don't want /start-ticket), `--no-format` (skip formatting), `--qa` (QA mode — surface QA steps, don't touch the ticket), `--claude` (use `claude` instead of the default `cursor-cli` in the top-right pane), `--code-review` (start AI in code reviewer role, wait for user input).

Only ask the user for pieces that are missing or ambiguous. Common gap: repo named but no ticket, or ticket named but no repo — ask for the missing one.

## Step 2 — Resolve & validate the repo

Read the `case "$ARG"` block in `/Users/devadmin/.local/bin/mkpanes` to get the current alias list (don't trust a stale copy — the list changes). At time of writing the aliases are:

`billing, core, feature-flags, integrations, jolt_dev-tools, labels, lists, mcp-javascript, scheduling-app, skills, time-temperature, timeclock` (under `~/code`) and `api, build-node, node-task-worker, jolt-highcharts, jolt-web, jube, knowledge-base, reporting-exporter, web, workflow-observer` (under `~/jolt/code`).

- If the user's repo matches an alias, use it as-is.
- If it's a path, confirm the directory exists.
- If it's neither, show the closest aliases and ask which they meant. Do not guess silently.

## Step 3 — Resolve & validate the ticket (worktree mode)

If worktree mode and the branch looks like a Jira key (`^[A-Z]{2,}-\d+$`):

- Validate it via the Atlassian MCP `getJiraIssue` (SmartSense cloud ID `3be885af-99d6-4514-939e-3c99560b10eb`, fields `["summary","status","assignee"]`).
- **Confirm it exists** — if not, stop and tell the user (likely a typo'd key); don't create a worktree for a non-existent ticket.
- Surface the summary so the user can confirm it's the right ticket.
- **Normal mode**: assignment/status/sprint are not blockers here — `/start-ticket` handles those. Just note if it's currently assigned to someone else.
- **`--qa` mode**: treat the ticket as read-only. Do not note assignment as a concern — Daniel is QAing, not taking ownership. Do not imply any ticket updates will happen.

If `--no-ticket` is set, or the branch isn't a Jira key (a plain feature branch), skip Jira validation.

## Step 4 — Confirm & run

Pre-flight:

- **Must be inside tmux.** Check `$TMUX` is set. If not, stop and tell the user to run from inside a tmux session (mkpanes uses `tmux new-window`).

Show the resolved command on one line and the effect, then run it. Examples:

> Running `mkpanes lists -w LW-17124` — creates worktree `lists_LW-17124`, opens a tmux window, and runs `/start-ticket LW-17124` in the AI pane. Proceed?

> Running `mkpanes lists -w LW-17124 --qa` — creates worktree `lists_qa_LW-17124`, opens a tmux window, and runs `/qa-ticket LW-17124` in the AI pane. The ticket will not be assigned or updated. Proceed?

Build the command with the exact positional order — **repo first, then `-w`, then branch**, flags anywhere:

```
mkpanes <repo> -w <branch> [--no-ticket] [--no-format]
```

or for plain mode:

```
mkpanes <repo>
```

Run it with the Bash tool. The command returns once the window is set up (it does not block on the spawned `cursor-cli`/`vim`). Report the new tmux window / worktree path back to the user.

## Notes

- The branch name in worktree mode becomes both the worktree suffix (`<repo>_<branch>`) and the `/start-ticket` argument, so for ticket work it should be the ticket key.
- If the worktree already exists (directory present or branch registered in `git worktree list`), `mkpanes` switches to it — safe to re-run.
- Don't run `/start-ticket` yourself; the command does it inside the new pane.
