# Control Center

Keyboard-first TUI dashboard for all in-progress work: git worktrees, agents in tmux,
GitLab MRs, and Jira tickets. See `PLAN.md` for the roadmap and verified feasibility notes.

## Requirements

- Bun (`brew install oven-sh/bun/bun`) — OpenTUI's native renderer requires it
- `glab` authenticated to gitlab.com
- `acli` authenticated to the SmartSense Jira
- `JIRA_EMAIL`, `JIRA_API_TOKEN` (and optionally `JIRA_BASE_URL`) env vars — used for
  listing/executing ticket transitions via the Jira REST API, which acli cannot list
- `tmux` running
- `~/.local/bin/mkpanes` — parsed at startup as the source of truth for the repo map

## Run

```bash
npm install
npm start
```

Best run as a dedicated tmux window.

## Views

- **[1] Worktrees** — one row per git worktree, joining local git state, Jira, GitLab MR,
  and tmux. `tab` (or `1`/`2`) switches views.
- **[2] Backlog** — tickets assigned to you that aren't In Progress or Done, sorted by
  last update. The WT column marks tickets that already have a local worktree. `s` starts
  a ticket: pick a repo and it launches `mkpanes <repo> -w <KEY> -s <session>`. `n` opens
  a "new ticket" tmux window running `cursor-cli` with a prompt to create a ticket via the
  jira-ticket skill (it asks for the parent epic, platform, type, and details); refresh
  afterward and the new ticket appears in the backlog, ready to start with `s`.
- **[3] Todos** — simple local list for things without a ticket or branch, stored in
  `~/.config/control-center/todos.json`. `a` adds, `space`/`enter` toggles done,
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
| `q` | quit |

## Reading the dashboard

- **GIT** — `✚n` dirty files, `↑n ↓n` ahead/behind upstream; a `*` means the branch has
  no upstream so the comparison is against the origin default branch.
- **MR** — most recent MR for the branch (`⚠` = has conflicts).
- **CI** — head pipeline status of an open MR.
- **READY** — merge readiness of an open MR (`✓ ready`), or the blocker: `approval`,
  `threads` (unresolved discussions), `conflicts`, `rebase`, `ci`, `changes`, `draft`.
- **TMUX** — `session:index` of the tmux window whose name matches the ticket/branch.
