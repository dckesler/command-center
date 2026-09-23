---
name: cc-report
description: >-
  Report status upward in Daniel's Command Center hierarchy by running the
  cc-report CLI: ticket agents and project central agents report to Control
  Center specialists (worktrees, qa, projects, ...); project task-tab workers
  report to their project's central agent (project:<name>). Use when the user
  says "report to the worktree agent", "report to the projects agent", "report
  to the central agent", "start reporting to command center", "cc-report", or
  when a prompt told this agent to keep something informed.
---

# Report upward with cc-report

Nothing above you can see this chat. Send one-line status reports with `cc-report`; they are durable and wake the recipient.

If you already have a `report_to_central` tool, you are a Command Center hub specialist — use that tool instead. Do not run this CLI.

## Command

```bash
cc-report [target] [--severity info|warn|attention] <summary>
```

Resolve the binary in this order: `cc-report` on `PATH`, then `~/.local/bin/cc-report`, then `~/.agents/skills/cc-report/cc-report`. `jq` must be available.

- **target** — who you report to:
  - `project:<name>` — the central agent of `~/projects/<name>`. Use this if you are a **task-tab worker** inside a project session — including worktree tabs whose cwd is a repo under `~/code`; the session decides, not the directory.
  - `projects` — Command Center's projects specialist. Use this if you are a **project central agent** (the `central` window of a project session).
  - `worktrees` / `qa` — Command Center's worktrees or QA specialist. Use this if you are a **ticket agent** in a worktree.
  - `tickets` | `epics` | `todos` | `email` | `cloud` | `central` — other Command Center tabs; only when Daniel asked.
  - Omitted: the default follows the rules above from your cwd and tmux window, so from the right place plain `cc-report "<summary>"` is correct.
- **severity**: `info` (FYI), `warn` (degrading), `attention` (Daniel needed now)
- **summary**: one line, max 160 characters. Lead with the ticket key, project name, or task title. No quotes of your last chat message. No markdown.

Examples:

```bash
cc-report worktrees "LW-17790 idle, tests pass, no MR yet"
cc-report worktrees --severity attention "LW-17790 blocked: needs API contract from platform"
cc-report projects "web-observability: Datadog RUM doc drafted, next is the FE logging plan"
cc-report project:web-observability "logging-plan: draft written to docs/logging.md, ready for review"
cc-report project:web-observability --severity attention "logging-plan: blocked, need Datadog org access"
```

## Standing instruction

When Daniel or your launch prompt says to report (to the worktree agent, the projects agent, the central agent, Command Center), treat it as a standing rule for the session:

1. Send one `cc-report` now (who you are + current state).
2. Report again after real progress, when done, when blocked, when an MR/CI/ticket status changes, or when Daniel is needed (`--severity attention`).
3. Do not report every thought, file edit, or command. Hooks already cover start/working/idle.

## Receiving reports (project central agents)

Worker reports arrive in your chat as `[report HH:MM] (severity) <tab>: <text>` lines and are also appended to `.cc/inbox.jsonl` in the project directory. Fold them into `PROJECT.md` (Current state, Next steps, Log) and pass anything Daniel needs upward with `cc-report projects`. On resume, `tail -n 20 .cc/inbox.jsonl` to catch reports that arrived while you were down.

## After the command

Confirm in chat with the same one line you sent. If the command is missing, say `cc-report` is not on PATH and stop — do not invent another channel.
