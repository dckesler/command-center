# Command Center

Keyboard-first TUI dashboard for all in-progress work: git worktrees, agents in tmux,
GitLab MRs, Jira tickets and epics, local projects, todos, Outlook mail, and Cursor
Cloud agents — with one Cursor SDK "specialist" agent per tab and a central manager
they report to (a Cursor CLI session beside the dashboard, see *[1] Central*). See `PLAN.md` for the roadmap and verified feasibility notes.

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
| `dirs.config` | `CC_CONFIG_DIR` | `~/.config/command-center` | state: `agents.jsonl`, `inbox.jsonl`, `mail/`, `todos.json`, `focus-day.json`, `hub.json`, `central/`, `tui.log` |
| `dirs.projects` | `CC_PROJECTS_DIR` | `~/projects` | Projects tab root |
| `dirs.skills` | | cursor/claude/agents skill dirs | roots scanned for `/skill` completion |
| `commands.agent` | `CC_AGENT_CMD` | `cursor-cli` | command typed into tmux panes to start an agent (alias OK) |
| `commands.projectModel` | `CC_PROJECT_MODEL` | `claude-opus-5-5-high` | Cursor CLI model for each project's central agent (`cursor-cli --list-models`); `""` = CLI default; only applied when `commands.agent` is the Cursor CLI |
| `central.mode` | `CC_CENTRAL_MODE` | `tmux` | `tmux` = the central manager is a Cursor CLI session in the pane right of the dashboard (`cc-central`), tab 1 read-only; `embedded` = Cursor SDK agent inside the TUI with a typed chat on tab 1 |
| `central.dir` | `CC_CENTRAL_DIR` | `~/.config/command-center/central` | the tmux central's working dir and `cc-mail` mailbox (`prompt.txt`, `LOG.md`, `seen.json`) |
| `central.model` | `CC_CENTRAL_MODEL` | `""` | Cursor CLI model for the tmux central; `""` = `commands.projectModel` |
| `commands.mkpanes` | `MKPANES_BIN` | `~/.local/bin/mkpanes` | worktree launcher; parsed for repo aliases when `repos` is empty |
| `commands.editor` | | `""` | editor to open in a spare pane of project/task windows (e.g. `vim`; project windows use a bottom pane since the top-left runs `cc-dash`); empty or `none` = no editor |
| `commands.terminal` | | `switch` | `switch` = one terminal window, projects are tmux sessions the client switches between (see *Tabs* below); `alacritty` \| `terminal` = a new OS window per project; `none` = leave the session detached |
| `commands.tmuxSession` | | `null` | pin the session that receives ticket windows |
| `jira.baseUrl` | `JIRA_BASE_URL` | `""` | Jira site; empty disables links and transitions |
| `jira.cloudId`, `jira.sprintField` | | `""`, `customfield_10007` | Atlassian MCP cloud id; sprint custom field |
| `model` | `CC_MODEL` | `composer-2.5` | Cursor SDK model for specialists and Cloud agents |
| `projects.exclude` | | `command-center, node_modules` | dirs under `dirs.projects` that are not projects |
| `projects.maxParallelTasks` | | `2` | task tabs a project's central agent keeps busy at once under an approved plan |
| `projects.idleMinutes` | | `20` | an active project with an approved plan, open steps, no task tabs and an idle central agent for this long gets an "idle project" nudge via the projects specialist (`0` = off) |
| `mrs.sinceDays` | | `60` | `cc-mrs` / `list_my_mrs` hide your open MRs with no GitLab activity for this long (`0` = show all) |
| `review.hideFiles` | | lockfiles, snapshots, `dist/`, … | gitignore patterns `cc-review` seeds into a repo's `.tuicrignore` — files hidden from tuicr diffs (MR and local reviews) |
| `hubs.review` | | `reviews` | directory under `dirs.projects` + tmux session of the review hub (tab 1; its central agent manages review windows); `""` = no hub |
| `hubs.qa` | | `qa` | same for the QA hub (tab 2); `""` = no hub |
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

The shell skills (`cc-report`, `cc-mail`, `cc-central`, `cc-instruct`, `cc-inbox`, `cc-mrs`, `cc-review`, `cc-hub`, `cc-todo`, `cc-snapshot`, `cc-restore`,
`start-project`, `project-task`) and
`hooks/agent-event.sh` read the same file with `jq`, so one config drives both the TUI
and the agents it launches. `bun run doctor` reports what is missing.

## Views

Tabs are `1`–`9`, `0`, `-`, `=` (or `tab` to cycle): central, projects, review, worktrees,
qa, tickets, epics, todos, email, cloud, calendar, grok.

- **[1] Central** — the manager every specialist reports to. By default
  (`central.mode: "tmux"`) it is **not** an SDK agent inside the TUI but a Cursor CLI
  session in a tmux pane *right of the dashboard* in the Command Center window (top row: dashboard | central; the bottom row is yours for terminals), running in
  its own directory (`central.dir`, default `~/.config/command-center/central`:
  `prompt.txt`, `LOG.md`) on `central.model` (falls back to `commands.projectModel`).
  On start the TUI runs `cc-central ensure`, which reuses the pane marked
  `@cc_role=command-center`, else a shell pane right of the TUI on its row, else splits
  the TUI in half, and launches the agent with the manager prompt. The tab is the
  **report stream**: every report addressed to central (`report_to_central`,
  `cc-report central …`, central-bound TUI events — all appended to `inbox.jsonl`), with
  `!!` attention / `!` warn marks, the agent's state, pane id and queued mail on top;
  reports the agent has already read are dimmed. `enter`/`i` switch the tmux client to
  its pane, `j`/`k` scroll, `g` latest. The agent's chat stays yours: only **warn and
  attention** reports are pushed into it as `cc-mail` (stuck agents, approvals waiting,
  focus checks); info reports it reads with `cc-inbox` (unread-then-mark, `--peek`,
  `--all -n N`, `--count`) on start, before answering you, and before acting. It steers
  everything else with `cc-instruct` — `cc-instruct list` (hub specialists + every agent pane in tmux),
  `cc-instruct <specialist> "<text>"` (the specialist's reply returns as a report),
  `cc-instruct project:<name> …` / `window:` / `pane:` / `dir:` (cc-mail to a project
  central, ticket or task agent) — and keeps the focus-todo loop with `cc-todo`
  (`list`, `focus`, `note`, `add`, `done`). Ask it what is out for review and it runs
  `cc-mrs`: every open MR you authored on GitLab (worktree or not) with approvals,
  unresolved threads (human vs bot, newest age), CI, conflicts and Jira status, ending in
  "N waiting on approval · N need work"; `cc-mrs threads !<iid>` shows the open threads
  and, when you ask for a pass, `cc-mrs pass` hands each MR that needs work to a
  babysit-branch agent (cc-mail to the one already in its worktree, else a new worktree
  window) that fixes or closes the threads, pushes, and reports back — never touching the
  Jira status. It never messages the pane that runs the
  Command Center dev session. Restart it with `ctrl+c` twice in its pane then
  `cc-central ensure` (or `cc-central start --force`); `cc-central status` shows what
  is running where. `central.mode: "embedded"` restores the in-TUI SDK central with a
  typed chat on this tab.

- **[3] Review** — code reviews of other people's merge requests, one row per
  `<repo>_review_<branch>` worktree (`mkpanes --review`; `/` in a branch becomes `__` in
  the directory). Columns: ticket, MR URL,
  MR title, agent, approval (`✓ approved 2/2`, `1/2 approved`, `unapproved`; `★` marks
  your own approval). `n` picks a repo and asks for a ticket key (the branch is assumed
  to be named after it), a branch, **or an MR link** (`https://…/-/merge_requests/123`
  or `!123`): an MR is looked up with `glab`, the worktree is made on its source branch,
  and the agent gets `/review-ticket <MR URL>` — no ticket needed; a URL naming another
  registered repo switches to that repo. Either way it opens a tmux window named
  `Code Review <TICKET or !IID>` in the REVIEWS hub session (tab 1 — see *The review and
  QA hubs* below; QA windows go to the QA hub, tab 2) and starts `/review-ticket` in the agent pane. That
  agent reads the ticket's acceptance criteria (or, without a ticket, the MR's own
  description) and the full diff, writes a verdict with
  file:line findings in its chat, reports to the review specialist with `cc-report`, and
  posts comments or approves on GitLab **only after you say yes in its chat**. `a`
  approves the selected MR as you (confirm dialog); `s` jumps to the window, `x` cleans
  up and closes it. The review specialist relays verdicts and stuck agents to central.

  You review the diff yourself in **tuicr** (`brew install tuicr`): the agent runs
  `cc-review open`, which starts `tuicr mr <iid>` in the window's top-right pane (review
  windows split the top row 50/50 for it) with the
  repo's `.tuicrignore` applied (seeded from `review.hideFiles`, never committed; "hide
  the docs while I review" → `cc-review hide 'docs/**'`). `c` comments a line, `v`+`c` a
  range, `:summary` lists drafts. The agent adds its own findings into the same session
  (`cc-review add`, tagged with its model name) so you can delete the ones you disagree
  with; "post my comments" → `cc-review drafts` (numbered, ⚠ near existing threads) and,
  on your yes, `cc-review post`: inline-anchored discussions with `` `path:line` `` and
  the comment type on the first line, verified after posting, URLs printed, drafts
  cleared. Comment types (`issue`, `question`, `nit`, `praise`) live in
  `~/.config/tuicr/config.toml`.

- **[4] Worktrees** — one row per git worktree, joining local git state, Jira, GitLab MR,
  and tmux. `w` wraps a branch up (merge the MR, ticket → Done, close the tmux window,
  remove the worktree + branch; refused while the MR has unresolved review threads or
  its pipeline is held at `manual` by unplayed QA Audit jobs — the `wrap-up` skill, run in
  the worktree, verifies the four ticket items and plays those on your yes), `x`
  removes just the worktree, `X` mass-cleans worktrees whose ticket is Done and MR merged.
  The same wrap-up is available by asking — "wrap up lists/LW-1234" in the worktrees
  chat (or central, which relays it) queues the identical plan for your approval; both
  paths share `src/data/wrapup.ts`. The worktrees specialist's `list_worktrees` adds
  approvals and unresolved-thread counts for every open MR, and `list_my_mrs` lists all
  your open MRs on GitLab (same data as `cc-mrs`).
  Any agent in any window (ticket worktree, project task tab, the dev window) can put
  its own changes in front of you before they become an MR: the `local-review` skill runs
  `cc-review local open`, which starts tuicr on the branch's commits + uncommitted changes
  in the window's spare pane (widened to half the window) and flags the tab; you comment
  (`c`, `v`+`c`, `:w`, `:q`), say "done", and the agent reads them (`cc-review local
  drafts`, numbered with the code they point at), fixes or answers each one in place
  (`resolve` / `add`), and reports the round. Nothing from a local review goes to GitLab.
  `start-ticket` offers it before `/push-branch` for changes worth a look, `babysit-branch`
  when you answer "let me look" to an MR-ready message, and project task workers when
  the central agent (or you) asks to see the work.
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
  tracked by a `PROJECT.md` brief — `# Title`, `**Status:** active|paused|done|archived`,
  `**Updated:** YYYY-MM-DD`, an optional `**Epic:** LW-1234` (the Jira epic the project
  delivers; `none` when there isn't one), `**Plan:** draft|proposed|approved YYYY-MM-DD|revision pending`,
  then `## Goal`, `## Current state`, `## Plan`, `## Next steps` (checkbox list),
  `## Needs <user>` (open questions, checkbox list), `## Decisions` (dated calls the agent
  made alone) and a dated `## Log`. The table shows status, plan state, how many things
  wait on you (NEEDS), epic, open next steps, the project's tmux window, and its agent
  state. Projects whose brief is `done`, or whose steps are all ticked with nothing
  running, are hidden; `v` shows them. `**Status:** archived` removes a project from
  Command Center altogether (no row even with `v`, no needs queue, no idle watchdog, not
  in the projects specialist's list) while leaving the directory in place — set it in
  `PROJECT.md` to shelve a project, change it back to resurface it. `n` runs a short
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
  `a` approves a proposed plan or pending revision (writes `**Plan:** approved <today>`
  and mails the central agent, which starts the steps); `w` lists everything waiting on
  you across all projects and jumps to the one you pick.

  **How a project runs itself.** The central agent interviews you once, writes
  `## Plan` (milestones → steps, each with deliverable, repo / ticket or
  `ticket to create: <title>`, done-when, confidence, open questions), sets
  `**Plan:** proposed` and reports `attention`. After your approval it keeps
  `projects.maxParallelTasks` task tabs busy, starts the next unblocked step whenever one
  finishes, creates the tickets the plan names without re-asking, answers workers'
  questions from the plan, and wraps up its own tabs once their MR is merged. It stops
  for exactly five gates: plan approval, an ambiguity the plan cannot settle (logged
  under `## Needs <user>`), a non-reversible low-confidence call (reversible ones are
  made and logged under `## Decisions` with a `warn` report), MR review, and a plan
  revision (`**Plan:** revision pending`, written as `### Revision <date>` under
  `## Plan`). If an approved project sits idle with open steps and no task tabs for
  `projects.idleMinutes`, the projects specialist nudges the central agent, then tells
  central if it stays stalled.

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

  **Project dashboard (`cc-dash`).** The top-left pane of every project's `central`
  window runs `cc-dash <project>`, a read-only TUI so that switching to a project's tab
  answers "what is this, what's going on, who needs me" without visiting the sub-agent
  tabs: PROJECT.md status / plan state / goal / current state (+ epic progress), a red
  **NEEDS YOU** block (a plan or revision awaiting approval, open `## Needs <user>`
  questions, tabs whose newest report is `attention`, agents in the `attention` hook
  state, stuck cc-mail — oldest wait first), one row per tab (window #, ticket + short Jira
  status, MR with CI icon / approvals / open threads, agent state, newest report and
  its age), open next steps and the latest reports. It watches `.cc/inbox.jsonl`,
  `PROJECT.md`, the agent feed and the mail dir, so a worker's `cc-report` shows up
  within a second; Jira/GitLab columns refresh every 60 s. Keys: `j/k` select,
  `enter` jump to that tab, `o` MR, `t` ticket, `p` PROJECT.md, `r` refresh, `q` quit.
  `start-project` launches it for new sessions and, on a resume, starts it in pane 1 of
  an existing session when that pane is an idle shell. `commands.editor`, if set, now
  opens in a bottom pane instead.

  Skills in `skills/` (synced to `~/.agents/skills`, binaries linked into
  `~/.local/bin`): `start-project`, `project-task`, `cc-report`, `cc-mail`, `cc-grok`,
  `cc-flag`, `cc-dash`.

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
  Bot's Secure Storage, local execution left at Ask/Never. A Bot that pauses at
  `needs-you` (its saved logins need you present in the app) and later rewrites its
  report is delivered again. The `grok-qa` skill uses a Bot as a QA tester: it sends a
  ticket's QA steps to run on staging (app.joltstage.com, signed in with the QA test
  account held in the Bot's Secure Storage as `JOLT_STAGE_QA_USERNAME` /
  `JOLT_STAGE_QA_PASSWORD`) and hands the findings back as candidate issues you
  confirm — from a `qa-ticket` session or any agent chat.
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
puts the tmux status line at the bottom of the screen: the current project's windows, a
blank gap, then a row of numbered project tabs along the bottom edge (one per tmux
session — `0 COMMAND CENTER`, `1 REVIEWS`, `2 QA` (the two hubs, see below), then each
project in the order it was opened). Set `status-position top` to flip the block.
`tmux/cc-session` does the numbering (stored as `@idx`/`@label` on each session; hooks
renumber on create/close/rename) and draws the row (`cc-session tabs`), so the pinned
hubs stay at 1 and 2 whatever order the sessions were created in.

### The review and QA hubs (tabs 1 and 2)

Code reviews and QA sessions each get a project-style tmux session of their own —
`~/projects/reviews` and `~/projects/qa` (`hubs.review` / `hubs.qa` in config; `""`
turns a hub off) — with a `central` window (cc-dash left, central agent right) exactly
like a project, and the review / QA windows as its task tabs. The hub's central agent
tracks that kind of work day to day: you can start a review or a QA from its chat
("review !563 in lists", "QA LW-18213"), the spawned workers report to it
(`cc-report` resolves to `project:reviews` / `project:qa` from inside the session), and
it reports to the review / QA specialist in Command Center with `cc-report review|qa`,
which reports to central — the workers otherwise follow the same `review-ticket` /
`qa-ticket` flow, and the Review and QA tabs still show every row. The TUI runs
`cc-hub ensure` on start so both hubs open with Command Center; review/QA windows
opened from the TUI, the specialists' `start_review` / `start_qa`, or `mkpanes
--review|--qa` land in the hub session when it is running (`-s` overrides).
`cc-hub status` shows them, `cc-hub adopt` moves existing `_review_` / `_qa_` windows
in from other sessions, `cc-hub prompt review|qa` rewrites a hub's central prompt
(`<hub>/.cc/central-prompt.txt`). `start-project` refuses the hub names.
Install it by sourcing it at the end of your tmux config (`~/.tmux.conf.user` if your
`.tmux.conf` sources that):

```
source-file ~/projects/command-center/tmux/command-center.tmux
```

Keys: `Ctrl-s 0..9` project by number (`Ctrl-s 0` is Command Center), `Ctrl-s n` / `Ctrl-s p`
(or `Ctrl-s Tab` / `Ctrl-s BTab`) next / previous project, `Ctrl-s Ctrl-s` sends a real Ctrl-s to the pane;
`prefix 1-9` windows as usual, `prefix Tab` / `BTab` also step projects, `prefix S`
project picker. `Alt-0..9` does the same as `Ctrl-s N` without a prefix if the terminal
sends Option as Meta (Alacritty `[window] option_as_alt = "Both"`, Ghostty
`macos-option-as-alt = true`). Jumping from a Command
Center row (`s`, task tabs, the `@` dialog) uses `switch-client`, so it crosses sessions.

Marks: `cc-flag <attention|warn> [--window <target> | --dir <path>]` (`skills/cc-flag`)
colours a window tab red or yellow and its project tab too; a mark on something
already on screen is skipped, and marks clear themselves when you select the window
or switch to the session. Who sets them: `cc-report --severity warn|attention` marks
the reporting agent's own tab; Command Center marks a worktree/project tab when it
raises a warn/attention event about that directory (stuck mail, Grok `needs-you`,
ticket-agent events), and marks its own tab when an approval is waiting or mail is
stuck. `cc-flag info` is a no-op so callers can pass severities straight through.

## Save and restore the whole thing

`cc-snapshot save [name] [--note "…"]` writes every tmux session, window and pane —
layout, cwd, what runs there — plus the conversation id of every agent to
`dirs.config/snapshots/<name>.json` (and `latest.json`); `cc-snapshot list` / `show`.
Per session it records which `~/projects` project it is; per window which project task
tab (ticket, prompt file, worktree or not); per window the exact command the launcher
typed into the agent pane (`@agent_cmd`, set by `mkpanes`, `start-project` and
`project-task`); and the hub specialists' SDK agent ids (`hub-agents.json`). The
window's agent pane counts as an agent pane even when the agent has already exited.

`cc-restore [name] [--dry-run] [--no-agents] [--revive] [--no-fresh] [--no-attach]
[--session <name>]… [--project <name>]…` rebuilds whatever is missing: sessions (same
numbering), windows (matched by name — open ones are left alone, so it is safe to
re-run) with their layouts and window options, then types the program back into each
pane: `bun start` for the dashboard, `cc-dash <project>` for project dashboards,
`<commands.agent> --resume=<id>` for every agent that was running (the central
included), the editor where one ran, and `nvm use && <install>` in a worktree window
whose checkout has no `node_modules`. An agent whose conversation cannot be resumed is
relaunched with its original prompt from `@agent_cmd` (a started ticket becomes
`/resume-ticket`); `--no-fresh` leaves it a shell. Agents that had already exited at
save time (finished workers) come back only with `--revive`. The hub specialists'
ids are written back before the TUI starts, so the TUI resumes their conversations
(`Agent.resume`; a specialist on a different `model` starts fresh, and "new
conversation" in a tab forgets its id). Finally the client is attached (outside tmux)
or switched (inside) to the saved current session. Agent conversations are tied to
panes by the hooks (`agents.jsonl` state events carry `pane`), with transcript-based
fallbacks for agents that predate that; `show` marks each agent `✓` (resumable),
`↻` (relaunchable only), `?` (neither), `(idle)` when it had exited. Windows whose
worktree is gone and the Command Center dev session's agent are skipped with a note.

## Layout

```
src/            TUI (OpenTUI/React), data layer, hub agents and their specs
src/dash/       cc-dash — the per-project dashboard TUI (own entrypoint, reuses the data layer)
src/cli/        bun entrypoints behind shell skills (todo.ts ← cc-todo, inbox.ts ← cc-inbox, mrs.ts ← cc-mrs, review.ts ← cc-review, snapshot.ts ← cc-snapshot/cc-restore)
src/config.ts   config loader (defaults ← config.json ← env)
skills/         first-party agent skills; `bun run skills sync` links them into ~/.agents/skills and ~/.claude/skills
tmux/           command-center.tmux — status rows (windows / gap / session tabs) and keys; cc-session numbers sessions (hubs pinned at 1, 2) and draws the tab row
hooks/          agent-event.sh (Cursor/Claude hook → agents.jsonl) and example hook wiring
scripts/        setup.ts (setup/doctor), skills.ts (skill manager)
config.example.json, .env.example
```

State written at runtime lives only in `dirs.config` (default `~/.config/command-center`):
`agents.jsonl` (hook feed), `inbox.jsonl` + `cursors.json` (durable specialist inbox),
`mail/` (inter-agent mailboxes), `todos.json`, `focus-day.json`, `hub.json` (specialist
status snapshot read by `cc-instruct`), `hub-agents.json` (specialist SDK agent ids the TUI
resumes on start), `central/` (the tmux central's prompt, log and `seen.json` read cursor), `snapshots/` (cc-snapshot files),
`tui.log`, `dash.log`. Nothing is written inside the repo.

Personal constants baked into some skill docs (`skills/*/SKILL.md` "Known constants":
Atlassian account ids, cloud id, GitLab group) are still the author's; adjust them when
adopting the skills.
