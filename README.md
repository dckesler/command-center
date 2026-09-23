# Command Center

Keyboard-first TUI dashboard for all in-progress work: git worktrees, agents in tmux,
GitLab MRs, Jira tickets and epics, local projects, todos, Outlook mail, and Cursor
Cloud agents — with one Cursor SDK "specialist" agent per tab and a central manager
they report to. See `PLAN.md` for the roadmap and verified feasibility notes.

## Install on a new machine

```bash
git clone <this repo> ~/projects/command-center   # any path works
cd command-center
brew install oven-sh/bun/bun tmux jq              # required tools (macOS)
bun install
bun run setup                                     # config, hooks, skills, health check
```

`bun run setup` creates `~/.config/command-center/config.json` from
`config.example.json` and `.env` from `.env.example`, links `hooks/agent-event.sh` into
the config dir, symlinks `skills/*` into `~/.agents/skills` and the skill CLIs
(`cc-report`, `start-project`, `project-task`) into `~/.local/bin`, then runs the same
checks as `bun run doctor`. It never edits `~/.cursor/hooks.json` or
`~/.claude/settings.json`; merge `hooks/cursor-hooks.example.json` (and the Claude one
if you use Claude Code) yourself so agents in tmux report their status into the feed.

Then edit the two files it created:

- **`~/.config/command-center/config.json`** — everything machine/user-specific and
  non-secret. All keys optional; see the reference below and `config.example.json`.
- **`.env`** (git-ignored, loaded by Bun) — secrets: `CURSOR_API_KEY` (hub specialists
  and Cloud agents), `JIRA_EMAIL` + `JIRA_API_TOKEN` (ticket transitions via the Jira
  REST API). Already-exported shell variables win over `.env`.

Run it as a dedicated tmux window:

```bash
bun start
```

### Requirements

| Tool | Needed for | Install |
|---|---|---|
| Bun | runtime (OpenTUI's native renderer needs it) | `brew install oven-sh/bun/bun` |
| tmux | agent windows, project sessions | `brew install tmux` |
| jq | `cc-report`, the hook script | `brew install jq` |
| an agent CLI | typed into panes to start agents: `commands.agent` in config (default `cursor-cli`; `claude` works) | Cursor CLI / Claude Code |
| `glab` (optional) | MRs, CI, merge on the worktrees tab | `brew install glab`, `glab auth login` |
| `acli` (optional) | tickets and epics tabs | Atlassian CLI, `acli jira auth login` |
| `m365` (optional) | Email and Calendar tabs | `npm i -g @pnp/cli-microsoft365`, see below |
| Alacritty (optional) | new OS windows for projects (`commands.terminal`) | or set `"terminal": "terminal"` / `"none"` |
| `mkpanes` (optional) | worktree launcher + repo alias registry | your own script; or fill `repos` in config |

### Email / Calendar tabs and Microsoft 365

`src/data/outlook.ts` (mail) and `src/data/calendar.ts` (calendar, read-only) go through
the CLI for Microsoft 365 (`m365`), which holds a delegated OAuth token obtained with
`m365 login --authType deviceCode`. The token cache and the app registration it uses live
in `~/.config/configstore/` (`cli-m365-config.json` holds `clientId` / `tenantId`).
Required Graph permissions (delegated, admin-consented): `Mail.Read`, `Mail.Send`,
`Calendars.Read`. Nothing in this repo stores or reads the token directly.

## Configuration reference (`config.json`)

Resolution order: environment variable → `config.json` → default.

| Key | Env | Default | Purpose |
|---|---|---|---|
| `user.name` | | `"the user"` | how agent prompts address you |
| `user.email`, `user.jiraAccountId` | | `""` | your Atlassian identity (used by ticket skills) |
| `dirs.config` | `CC_CONFIG_DIR` | `~/.config/command-center` | state: `agents.jsonl`, `inbox.jsonl`, `todos.json`, `tui.log` |
| `dirs.projects` | `CC_PROJECTS_DIR` | `~/projects` | Projects tab root |
| `dirs.skills` | | cursor/claude/agents skill dirs | roots scanned for `/skill` completion |
| `commands.agent` | `CC_AGENT_CMD` | `cursor-cli` | command typed into tmux panes to start an agent (alias OK) |
| `commands.mkpanes` | `MKPANES_BIN` | `~/.local/bin/mkpanes` | worktree launcher; parsed for repo aliases when `repos` is empty |
| `commands.editor` | | `vim` | opened in the left pane of project/task windows |
| `commands.terminal` | | `alacritty` | `alacritty` \| `terminal` \| `none` for new project windows |
| `commands.tmuxSession` | | `null` | pin the session that receives ticket windows |
| `jira.baseUrl` | `JIRA_BASE_URL` | `""` | Jira site; empty disables links and transitions |
| `jira.cloudId`, `jira.sprintField` | | `""`, `customfield_10007` | Atlassian MCP cloud id; sprint custom field |
| `model` | `CC_MODEL` | `composer-2.5` | Cursor SDK model for specialists and Cloud agents |
| `projects.exclude` | | `command-center, node_modules` | dirs under `dirs.projects` that are not projects |
| `repos` | | `{}` | alias → path; overrides the mkpanes registry when non-empty |

The shell skills (`cc-report`, `start-project`, `project-task`) and
`hooks/agent-event.sh` read the same file with `jq`, so one config drives both the TUI
and the agents it launches. `bun run doctor` reports what is missing.

## Views

Tabs are `1`–`9`, `0` (or `tab` to cycle): central, projects, worktrees, qa, tickets,
epics, todos, email, cloud, calendar.

- **[3] Worktrees** — one row per git worktree, joining local git state, Jira, GitLab MR,
  and tmux.
- **[5] Tickets** — tickets assigned to you that aren't Done/Closed (epics stay on
  Epics). Sorted closest-to-shipped first (In Test / code review above In Progress,
  Blocked below it, Backlog last). The WT column marks tickets that already have a local
  worktree. `s` starts a ticket: pick a repo and it launches
  `mkpanes <repo> -w <KEY> -s <session>`. `n` creates a ticket in the tab's agent drawer.
- **[6] Epics** — your open Jira epics. `enter` opens an epic's child tickets (the open
  epic stays put while you switch tabs; `esc` closes it). `n` creates a ticket under the
  epic, `f` runs finalize-epic in a tmux window.
- **[2] Projects** — every directory in `dirs.projects` (default `~/projects`, minus
  `projects.exclude` and linked git worktrees). Each project is
  tracked by a `PROJECT.md` brief — `# Title`, `**Status:** active|paused|done`,
  `**Updated:** YYYY-MM-DD`, an optional `**Epic:** LW-1234` (the Jira epic the project
  delivers; `none` when there isn't one), then `## Goal`, `## Current state`,
  `## Next steps` (checkbox list) and a dated `## Log`. The table shows status, epic,
  open next steps, the project's tmux window, and its agent state. `n` creates
  `~/projects/<name>` with a template brief; `s` runs the `start-project` skill: the
  project gets its own tmux session (named after the project, window `central`,
  mkpanes-style panes) shown in a new terminal window (`commands.terminal`) — not a
  window of the work session — with `commands.agent` running as the project's
  **central agent**. An existing session is re-attached instead. `e` links/clears the
  epic (writes the `**Epic:**` line), `o` opens the folder, `t` opens `PROJECT.md`.

  `enter` expands a project: header (status, updated, session, central agent state,
  step counts), the epic with its Jira status and `done/total` child tickets, goal and
  current state, then one row per **sub-agent** — every window of the project's tmux
  session: `central` plus each `project-task` tab — with where it runs (`repo@branch`
  for worktree tabs, `project dir` otherwise), the ticket and its Jira status, MR state
  and CI, the agent's hook state, and the newest `cc-report` from that tab. Below: open
  next steps and the last worker reports. The view re-reads every 10 s while open.
  `j/k` + `enter`/`s` select a tab's window in the project session, `e` epic, `t` opens
  the epic (or the selected tab's ticket), `m` the tab's MR, `b` `PROJECT.md`, `o` the
  folder, `esc` back. The projects specialist has the same view as `project_detail(name)`
  and can link epics with `set_project_epic` when asked.

  Reporting chain (all via the `cc-report` skill; every layer reports upward):
  `project-task` worker tabs → `cc-report project:<name>` → the project's central agent
  (typed into its pane + `.cc/inbox.jsonl`) → `cc-report projects` → the projects
  specialist → `report_to_central` → central. The central agent owns `PROJECT.md` and
  delegates self-contained work with `project-task "<title>" "<task>"`, which opens a
  tab in the project session running a worker agent. Code changes always go through
  `project-task --repo <alias|path> --ticket <KEY>` (or `--branch <name>`, default
  `<project>-<title-slug>`): it calls `mkpanes <repo> -w <branch> -s <project-session>`,
  so the work lands in a `<repo>_<branch>` worktree that also appears on the worktrees
  tab, and the worker starts with `/start-ticket <KEY>` while reporting to the project's
  central agent.

  Skills in `skills/` (synced to `~/.agents/skills`, binaries linked into
  `~/.local/bin`): `start-project`, `project-task`, `cc-report`.
- **[9] Cloud** — Cursor Cloud agents started from here. `n` picks a mkpanes repo and a
  prompt (clones that repo's git remote on a Cursor VM, no PR). `s` sends a follow-up,
  `x` cancels the latest run, `o` opens the agent in the browser.
- **[0] Calendar** — today's Outlook calendar, read-only (`Calendars.Read`). Rows show
  time, subject, where (room or Teams), organizer and your response (`✓` accepted, `?`
  tentative, `!` not responded, `✗` declined/cancelled); the current meeting is green,
  anything starting within 15 minutes yellow. `enter` joins the online meeting (or opens
  it in Outlook), `o` opens it in Outlook. Re-fetched every 15 minutes on its own. The
  calendar specialist's job is context for central: it gets the day's schedule when it
  loads, diffs (new / moved / cancelled meetings) on each refresh, and a reminder 10
  minutes before each meeting you haven't declined, and relays those to central in one
  line. Ask it about your schedule (`;` drawer): `today_schedule`, `list_events(start,
  end)` for other days, `event_detail(id)` for attendees and the invite body. It has no
  write tools.
- **[7] Todos** — simple local list for things without a ticket or branch, stored in
  `dirs.config/todos.json`. `a` adds, `space`/`enter` toggles done,
  `x` deletes (with confirm). Pending items sort above completed ones.

## Keys

| Key | Action |
|---|---|
| `j` / `k` (or arrows) | move selection |
| `enter` | expand selected row (approvals, unresolved threads, full detail); esc/enter closes |
| `s` | jump to the row's tmux window, or launch one via `mkpanes <repo> -w <branch> -s <session>` |
| `n` | new worktree: type raw mkpanes arguments (e.g. `lists -w LW-17124 --qa`); `-s <session>` is appended automatically and the dashboard refreshes after |
| `c` | change ticket status (picker fetches valid transitions from Jira) |
| `w` | wrap up: merge the MR (`glab mr merge -y -d`; auto-merge if CI is running), transition the ticket to Done, close the row's tmux window, remove worktree + branch — with a step preview and warnings first |
| `x` | clean up worktree (optionally delete branch); warns when dirty files would be lost |
| `X` | mass cleanup: every clean worktree whose ticket is Done/Closed and MR is merged, with a preview list; dirty candidates are skipped |
| `r` | refresh all data |
| `o` | open selected row's MR in browser |
| `t` | open selected row's Jira ticket in browser |
| `ctrl+c` | quit |

In any agent chat, `/skill-name args` invokes an installed skill explicitly (the
specialist is told to read that `SKILL.md` and follow it with the given arguments);
`/skills` lists what is installed (`dirs.skills`, Cursor plugin skills, and this repo's
`skills/`). A message that
merely mentions `/skill-name` mid-sentence is sent as typed with a footnote pointing
the agent at each referenced `SKILL.md`. A message that *is* an unknown `/name` is
answered locally with suggestions and not sent. While typing, each `/name` token is
coloured in place — yellow while it prefixes some skills, green once it resolves, red
when nothing matches — and the box title shows `N matches` / `✓ /name` until you type
a space. Paths like `/tmp/x` are ignored.

## Reading the dashboard

- **GIT** — `✚n` dirty files, `↑n ↓n` ahead/behind upstream; a `*` means the branch has
  no upstream so the comparison is against the origin default branch.
- **MR** — most recent MR for the branch (`⚠` = has conflicts).
- **CI** — head pipeline status of an open MR.
- **READY** — merge readiness of an open MR (`✓ ready`), or the blocker: `approval`,
  `threads` (unresolved discussions), `conflicts`, `rebase`, `ci`, `changes`, `draft`.
- **TMUX** — `session:index` of the tmux window whose name matches the ticket/branch.

## Layout

```
src/            TUI (OpenTUI/React), data layer, hub agents and their specs
src/config.ts   config loader (defaults ← config.json ← env)
skills/         first-party agent skills; `bun run skills sync` links them into ~/.agents/skills
hooks/          agent-event.sh (Cursor/Claude hook → agents.jsonl) and example hook wiring
scripts/        setup.ts (setup/doctor), skills.ts (skill manager)
config.example.json, .env.example
```

State written at runtime lives only in `dirs.config` (default `~/.config/command-center`):
`agents.jsonl` (hook feed), `inbox.jsonl` + `cursors.json` (durable specialist inbox),
`todos.json`, `tui.log`. Nothing is written inside the repo.

Personal constants baked into some skill docs (`skills/*/SKILL.md` "Known constants":
Atlassian account ids, cloud id, GitLab group) are still the author's; adjust them when
adopting the skills.
