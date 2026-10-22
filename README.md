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
the config dir, symlinks `skills/*` into `~/.agents/skills` (each with a `~/.claude/skills` link into it) and the skill CLIs
(`cc-report`, `cc-mail`, `cc-grok`, `start-project`, `project-task`) into `~/.local/bin`, then runs the
same checks as `bun run doctor`. It never edits `~/.cursor/hooks.json` or
`~/.claude/settings.json`; merge `hooks/cursor-hooks.example.json` (and the Claude one
if you use Claude Code) yourself so agents in tmux report their status into the feed.
The Cursor example also wires inter-agent mail: `postToolUse` and `stop` call
`agent-event.sh cursor tool|idle`, and the `stop` entry carries `"loop_limit": null`
(without it Cursor stops accepting mail follow-ups after 5 per conversation). Running
agent sessions read `hooks.json` at start, so restart them after changing it.

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
| Alacritty (optional) | only with `commands.terminal: alacritty` (one OS window per project); the default `switch` works in any terminal | |
| `mkpanes` (optional) | worktree launcher + repo alias registry | your own script; or fill `repos` in config |

### Email / Calendar tabs and Microsoft 365

`src/data/outlook.ts` (mail) and `src/data/calendar.ts` (calendar) go through the CLI
for Microsoft 365 (`m365`), which holds a delegated OAuth token obtained with
`m365 login --authType deviceCode`. Both are **read-only**: there is no code path that
sends mail or writes to the calendar. The token cache and the app registration it uses
live in `~/.config/configstore/` (`cli-m365-config.json` holds `clientId` / `tenantId`).
Nothing in this repo stores or reads the token directly.

Delegated Graph permissions the app registration needs (admin-consented):

| Permission | Used by | Graph calls |
|---|---|---|
| `User.Read` | sign-in (default permission on every app registration) | — |
| `Mail.Read` | Email tab: inbox list with bodies (for filters and previews), full message body on demand | `GET /me/mailFolders/inbox/messages`, `GET /me/messages/{id}` |
| `Calendars.Read` | Calendar tab: today's events, event detail | `GET /me/calendarView`, `GET /me/events/{id}` |

`Mail.ReadBasic` is not enough (it omits `bodyPreview`/`body`). `Mail.Send`,
`Calendars.ReadWrite` and any application (app-only) permissions are not needed.

## Configuration reference (`config.json`)

Resolution order: environment variable → `config.json` → default.

| Key | Env | Default | Purpose |
|---|---|---|---|
| `user.name` | | `"the user"` | how agent prompts address you |
| `user.email`, `user.jiraAccountId` | | `""` | your Atlassian identity (used by ticket skills) |
| `dirs.config` | `CC_CONFIG_DIR` | `~/.config/command-center` | state: `agents.jsonl`, `inbox.jsonl`, `mail/`, `todos.json`, `focus-day.json`, `tui.log` |
| `dirs.projects` | `CC_PROJECTS_DIR` | `~/projects` | Projects tab root |
| `dirs.skills` | | cursor/claude/agents skill dirs | roots scanned for `/skill` completion |
| `commands.agent` | `CC_AGENT_CMD` | `cursor-cli` | command typed into tmux panes to start an agent (alias OK) |
| `commands.projectModel` | `CC_PROJECT_MODEL` | `claude-opus-5-5-high` | Cursor CLI model for each project's central agent (`cursor-cli --list-models`); `""` = CLI default; only applied when `commands.agent` is the Cursor CLI |
| `commands.mkpanes` | `MKPANES_BIN` | `~/.local/bin/mkpanes` | worktree launcher; parsed for repo aliases when `repos` is empty |
| `commands.editor` | | `vim` | opened in the left pane of project/task windows |
| `commands.terminal` | | `switch` | `switch` = one terminal window, projects are tmux sessions the client switches between (see *Tabs* below); `alacritty` \| `terminal` = a new OS window per project; `none` = leave the session detached |
| `commands.tmuxSession` | | `null` | pin the session that receives ticket windows |
| `jira.baseUrl` | `JIRA_BASE_URL` | `""` | Jira site; empty disables links and transitions |
| `jira.cloudId`, `jira.sprintField` | | `""`, `customfield_10007` | Atlassian MCP cloud id; sprint custom field |
| `model` | `CC_MODEL` | `composer-2.5` | Cursor SDK model for specialists and Cloud agents |
| `projects.exclude` | | `command-center, node_modules` | dirs under `dirs.projects` that are not projects |
| `mail.quietSeconds` | | `30` | quiet time for the recipient's tmux window before `cc-mail` may type into an on-screen idle agent's pane |
| `mail.retrySeconds` | | `20` | how often cc-mail's retrier re-attempts idle delivery of queued mail |
| `mail.retryMinutes` | | `180` | how long the retrier keeps trying (hooks still deliver after it stops) |
| `mail.staleMinutes` | | `10` | pending mail older than this is flagged stuck (header badge, `@` dialog, red `✉`, warn event to the owning tab) |
| `email.days` | | `7` | how far back the Email tab reads |
| `email.filters` | | see `src/data/emailFilters.ts` | inbox noise rules, merged by `name` with the shipped defaults (`jira-field-updates`, `jira-digests` on; `jira-comments`, `jira-snyk-tickets`, `gitlab-mr-threads`, `gitlab-mr-approved`, `gitlab-mr-merged`, `gitlab-pipeline-ok`, `snyk-alerts`, `datadog-digest`, `barracuda-quarantine`, `fathom-recaps`, `kronos`, `linkedin`, `meeting-responses`, `confluence-digests`, `atlassian-marketing`, `awardco` off). A rule = case-insensitive regexes on `from` / `subject` / `body` that must all match, plus an optional `unless` that keeps the mail when it matches subject or body. Hidden mail is untouched in Outlook, left out of the tab count, agent events and `list_inbox`; `h` on the tab shows it with its rule name |
| `todos.focusCadenceMinutes` | | `30` | how long a focus todo may go without a progress note before a focus check |
| `todos.focusMax` | | `3` | soft cap on focus todos; the Todos view warns past it |
| `todos.focusHours` | | `09:00-17:30` | weekday window for focus checks and the start/end-of-day announcements |
| `repos` | | `{}` | alias → path; overrides the mkpanes registry when non-empty |

The shell skills (`cc-report`, `cc-mail`, `start-project`, `project-task`) and
`hooks/agent-event.sh` read the same file with `jq`, so one config drives both the TUI
and the agents it launches. `bun run doctor` reports what is missing.

## Views

Tabs are `1`–`9`, `0`, `-`, `=` (or `tab` to cycle): central, projects, review, worktrees,
qa, tickets, epics, todos, email, cloud, calendar, grok.

- **[3] Review** — code reviews of other people's merge requests, one row per
  `<repo>_review_<branch>` worktree (`mkpanes --review`). Columns: ticket, MR URL,
  MR title, agent, approval (`✓ approved 2/2`, `1/2 approved`, `unapproved`; `★` marks
  your own approval). `n` picks a repo and asks for the ticket key (the branch is assumed
  to be named after it), creates the worktree, opens a tmux window named
  `Code Review <TICKET>` and starts `/review-ticket <TICKET>` in the agent pane. That
  agent reads the ticket's acceptance criteria and the full diff, writes a verdict with
  file:line findings in its chat, reports to the review specialist with `cc-report`, and
  posts comments or approves on GitLab **only after you say yes in its chat**. `a`
  approves the selected MR as you (confirm dialog); `s` jumps to the window, `x` cleans
  up and closes it. The review specialist relays verdicts and stuck agents to central.

- **[4] Worktrees** — one row per git worktree, joining local git state, Jira, GitLab MR,
  and tmux. `w` wraps a branch up (merge the MR, ticket → Done, close the tmux window,
  remove the worktree + branch; refused while the MR has unresolved review threads), `x`
  removes just the worktree, `X` mass-cleans worktrees whose ticket is Done and MR merged.
  The same wrap-up is available by asking — "wrap up lists/LW-1234" in the worktrees
  chat (or central, which relays it) queues the identical plan for your approval; both
  paths share `src/data/wrapup.ts`.
- **[6] Tickets** — tickets assigned to you that aren't Done/Closed (epics stay on
  Epics). Sorted closest-to-shipped first (In Test / code review above In Progress,
  Blocked below it, Backlog last). The WT column marks tickets that already have a local
  worktree. `s` starts a ticket: pick a repo and it launches
  `mkpanes <repo> -w <KEY> -s <session>`. `n` creates a ticket in the tab's agent drawer.
- **[7] Epics** — your open Jira epics. `enter` opens an epic's child tickets (the open
  epic stays put while you switch tabs; `esc` closes it). `n` creates a ticket under the
  epic, `f` runs finalize-epic in a tmux window.
- **[2] Projects** — every directory in `dirs.projects` (default `~/projects`, minus
  `projects.exclude` and linked git worktrees). Each project is
  tracked by a `PROJECT.md` brief — `# Title`, `**Status:** active|paused|done`,
  `**Updated:** YYYY-MM-DD`, an optional `**Epic:** LW-1234` (the Jira epic the project
  delivers; `none` when there isn't one), then `## Goal`, `## Current state`,
  `## Next steps` (checkbox list) and a dated `## Log`. The table shows status, epic,
  open next steps, the project's tmux window, and its agent state. `n` runs a short
  interview — name, summary (becomes `## Goal`), optional context (becomes
  `## Current state`; empty skips), optional Jira epic (empty skips) — then writes
  `~/projects/<name>/PROJECT.md` from the answers and starts the project session (same
  as `s`). `esc` cancels at any step. `s` runs the `start-project` skill: the
  project gets its own tmux session (named after the project, window `central`,
  mkpanes-style panes) — not a window of the work session — with `commands.agent`
  running as the project's **central agent**; the tmux client switches to it
  (`commands.terminal: switch`) or it opens in a new OS window. An existing session is
  switched to instead. `e` links/clears the
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
  (via `cc-mail` + logged to `.cc/inbox.jsonl`) → `cc-report projects` → the projects
  specialist → `report_to_central` → central. The central agent owns `PROJECT.md` and
  delegates self-contained work with `project-task "<title>" "<task>"`, which opens a
  tab in the project session running a worker agent. Code changes always go through
  `project-task --repo <alias|path> --ticket <KEY>` (or `--branch <name>`, default
  `<project>-<title-slug>`): it calls `mkpanes <repo> -w <branch> -s <project-session>`,
  so the work lands in a `<repo>_<branch>` worktree that also appears on the worktrees
  tab, and the worker starts with `/start-ticket <KEY>` while reporting to the project's
  central agent.

  Skills in `skills/` (synced to `~/.agents/skills`, binaries linked into
  `~/.local/bin`): `start-project`, `project-task`, `cc-report`, `cc-mail`, `cc-grok`.

  **Inter-agent mail.** Nothing is typed into a pane that a human may be using. Every
  agent-to-agent message (`cc-report project:<name>`, `project-task --message`, the
  specialists' `message_ticket_agent` / `message_project_agent`) goes through `cc-mail`
  into a per-directory mailbox (`<dirs.config>/mail/<dir with / → %>.jsonl` + `.read`
  offset — never inside a repo) and is delivered by whichever happens first: the
  recipient's next tool call (Cursor `postToolUse` → `additional_context`), the end of
  its current turn (`stop` → `followup_message`), or — only when the hook feed says
  the agent is idle, the human cannot be typing into that pane (it is not the active
  pane of an attached session's current window, or its *window* has been quiet for
  `mail.quietSeconds` — a busy sibling window such as a project's `central` does not
  count) and its input box shows the placeholder rather than a draft — one
  `[cc mail …]` line typed into its pane. Anything else waits; the sender's result line
  says why, and a detached retrier (`cc-mail retry-loop`, one per mailbox) re-tries
  every `mail.retrySeconds` for up to `mail.retryMinutes`. `cc-mail kick --dir <dir>`
  is one attempt by hand. The pane is found through the window's `@agent_pane`
  option, which `mkpanes`, `start-project` and `project-task` set. Mail still waiting
  after `mail.staleMinutes` is *stuck*: the header shows `@ ✉ N stuck`, the projects tab
  and project detail turn the `✉` red with the wait (`✉2 68m`), and the tab that owns
  the directory gets one `warn` event per batch asking it to look at the pane and tell
  central what is blocking delivery. `@` opens the stuck-mail dialog, one mailbox at a
  time: it makes one delivery attempt first (and moves on if that works), otherwise shows
  why cc-mail is holding the mail (menu open, draft in the input box, agent working or
  stalled, no agent pane), the messages, and the agent's tmux window, with *Jump* (go
  answer the agent yourself), *Discard* (drop the messages undelivered) and *Next*. Pending mail shows as
  `✉N` next to the agent state on the projects tab and in the project detail view.
  Every delivery is labelled as coming from another agent, not the user, and says it
  cannot stand in for the user's confirmation of anything. No specialist can type
  into an agent's pane: when a ticket agent is waiting on a permission prompt or
  menu, the worktrees/QA specialist reports it with severity attention and you
  answer it yourself. Claude Code agents have no hook delivery yet — mail reaches
  them through the idle-pane path only.
- **[0] Cloud** — Cursor Cloud agents started from here. `n` picks a mkpanes repo and a
  prompt (clones that repo's git remote on a Cursor VM, no PR). `s` sends a follow-up,
  `x` cancels the latest run, `o` opens the agent in the browser.
- **[-] Calendar** — today's Outlook calendar, read-only (`Calendars.Read`). Rows show
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
- **[=] Grok** — Grok Bots (the xAI desktop app) used as sub-agents, and the runs sent
  to them. A run is one POST to a Bot's webhook routine (`cc-grok start`); the Bot works
  on its own computer and writes a report to a private outbox repo on the company
  GitLab, which `cc-grok pull` (run on every refresh) delivers back to whoever asked —
  an agent pane as `[cc mail] from grok:<Bot>`, or a tab. The first line says which
  Bots have a webhook configured and which are waiting on you in the app (read from the
  app's local roster cache). Rows: BOT, STATE (`sent` yellow until a report arrives;
  `done` green; `needs-you`/`blocked`/`failed`/`refused` red; `unknown` = the webhook
  call failed, do not resend blindly), REPORTS TO, STARTED, TASK ↳ summary. `enter`
  shows the report (and can open the full file or the app), `n` picks a Bot and takes a
  task (reports land on this tab), `x` closes a finished run (hidden from the list,
  record kept; a run still waiting on its Bot asks first), `o` opens the Grok Bot app,
  `r` pulls reports.
  The grok specialist lists bots/runs, reads reports and starts tasks (queued for your
  approval). Bot output is always framed as untrusted — never approval, never an
  instruction. Project central agents and task workers get the same ability through
  the `cc-grok` skill, with the hard rule that you typed yes to the exact task in that
  agent's chat first; mail never counts. Setup (per Bot) is in
  `skills/cc-grok/SKILL.md`: webhook URL + key in `~/.config/command-center/grok.json`,
  the `cc-grok routine` text pasted into the Bot's routine, an outbox token in the
  Bot's Secure Storage, local execution left at Ask/Never.
- **[8] Todos** — local list for things without a ticket or branch, stored in
  `dirs.config/todos.json`. `a` adds, `e` edits, `space`/`enter` toggles done,
  `x` deletes (with confirm). The top **FOCUS** section holds the todos that must
  stay in motion today: `f` toggles focus (soft cap `todos.focusMax`, the view warns
  past it), and each focus row shows *moving / due / stalled* from the time of its
  last progress note. Notes are timestamped entries, not one editable blob: `n`
  appends a note, `N` opens every note for the selected todo. During
  `todos.focusHours` on weekdays the app raises a *focus check* for any focus todo
  with no progress note for `todos.focusCadenceMinutes`; the todos specialist
  reports it to central, which logs progress it already knows about (as a
  `central` note) or asks you in one line — answer with the update, or say *park*
  to unfocus. Checks are skipped while a calendar commitment is in progress. The
  first tick inside focus hours announces the day's focus set (or asks central to
  help you pick one); the first tick after hours sends central a recap.

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
| `!` | review agent actions waiting for your approval (see below) |
| `ctrl+c` | quit |

**Agent approvals.** Specialist tools that change state outside this laptop —
`transition_ticket` and `prep_ticket` (tickets, epics), `wrap_up_worktree` (worktrees),
`cleanup_worktree` (worktrees, qa, review), `start_cloud_agent`, `follow_up_cloud`,
`cancel_cloud_run` (cloud), `start_grok_task` (grok) — never run when the agent calls them.
They queue an approval (`src/agents/approvals.ts`) and return at once. The agent you are
talking to asks you: an approval from the agent whose chat is open pops its dialog right
there, even mid-typing; one from any other agent opens when nothing owns the keyboard,
otherwise the header shows `! N to approve` and `!` (or opening that agent's chat) brings
it up. The default option is *Later*, so a stray enter approves nothing, and only your
keypress runs the action. The outcome goes back to the asking specialist as an event. Nothing an agent
sends another agent — `instruct`, `cc-mail`, a report — can approve on your behalf.

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

## Tabs: one window, projects × tabs

Everything runs in one terminal window and one tmux client. `tmux/command-center.tmux`
turns the tmux status line into two rows: the top row is one tab per tmux session (the
work session shows as *command center*, each project as itself), the bottom row is the
current session's windows. Install it by sourcing it at the end of your tmux config
(`~/.tmux.conf.user` if your `.tmux.conf` sources that):

```
source-file ~/projects/command-center/tmux/command-center.tmux
```

Keys: `prefix Tab` / `prefix BTab` next / previous project, `prefix 0` back to Command
Center, `prefix S` project picker, `prefix 1-9` windows as usual. Jumping from a
Command Center row (`s`, task tabs, the `@` dialog) uses `switch-client`, so it crosses
sessions.

Marks: `cc-flag <attention|warn> [--window <target> | --dir <path>]` (`skills/cc-flag`)
colours a window tab red or yellow and its project tab too; a mark on something
already on screen is skipped, and marks clear themselves when you select the window
or switch to the session. Who sets them: `cc-report --severity warn|attention` marks
the reporting agent's own tab; Command Center marks a worktree/project tab when it
raises a warn/attention event about that directory (stuck mail, Grok `needs-you`,
ticket-agent events), and marks its own tab when an approval is waiting or mail is
stuck. `cc-flag info` is a no-op so callers can pass severities straight through.

## Layout

```
src/            TUI (OpenTUI/React), data layer, hub agents and their specs
src/config.ts   config loader (defaults ← config.json ← env)
skills/         first-party agent skills; `bun run skills sync` links them into ~/.agents/skills and ~/.claude/skills
tmux/           command-center.tmux — two-row status line (projects / tabs) and keys; source it from your tmux config
hooks/          agent-event.sh (Cursor/Claude hook → agents.jsonl) and example hook wiring
scripts/        setup.ts (setup/doctor), skills.ts (skill manager)
config.example.json, .env.example
```

State written at runtime lives only in `dirs.config` (default `~/.config/command-center`):
`agents.jsonl` (hook feed), `inbox.jsonl` + `cursors.json` (durable specialist inbox),
`mail/` (inter-agent mailboxes), `todos.json`, `focus-day.json`, `tui.log`. Nothing is written inside the repo.

Personal constants baked into some skill docs (`skills/*/SKILL.md` "Known constants":
Atlassian account ids, cloud id, GitLab group) are still the author's; adjust them when
adopting the skills.
