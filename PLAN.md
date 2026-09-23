# Command Center

A keyboard-first TUI (OpenTUI React) that acts as the command center for all in-progress
work: worktrees, agents in tmux, GitLab MRs, and Jira tickets.

## The linking key

**branch name = Jira ticket key = worktree suffix = tmux window name.**
Existing conventions (mkpanes, /start-ticket) already enforce this, so one dashboard row
can join all four systems on the ticket key / branch name.

## Verified feasibility (2026-08-20)

Every feature below was verified against the real environment before being committed to.

| Feature | Mechanism | Verified how |
|---|---|---|
| Repo map / worktree discovery | Parse repo aliases from `~/.local/bin/mkpanes`; `git worktree list --porcelain` per repo | Listed 12/4/4 worktrees in lists/web/api |
| Local branch status | `git status --porcelain`, `git rev-list --count` ahead/behind | trivial |
| MR status + CI | `glab` 1.97.0 authenticated (gitlab.com, DKesler2). `glab mr list -F json` per repo; `glab mr view <iid> -F json` includes `state`, `draft`, `has_conflicts`, `detailed_merge_status`, full `pipeline` object | Ran against smartsense4/lists |
| Jira tickets | `acli` authenticated (smartsensebydigi.atlassian.net). `acli jira workitem search --jql ... --json` | Ran JQL for assigned open tickets |
| Ticket transitions | `acli jira workitem transition --key K --status S --yes` | Confirmed in `--help` (phase 2) |
| Start work via mkpanes | tmux windows CAN be created from outside tmux with `tmux new-window -t <session>:`; mkpanes needs a small `-s <session>` flag (approved) since bare tmux calls are ambiguous with 2 attached sessions | Tested in scratch session (phase 2) |
| Worktree cleanup | `git worktree remove` + branch delete; full close-out mirrors the wrap-up skill | (phase 2) |
| Tmux awareness | `tmux list-windows -a -F ...`; window names already contain ticket keys | Listed live windows |
| Ticket-less ToDos | Local JSON file | trivial (phase 4) |

## Decisions

- **Stack:** OpenTUI React (`@opentui/react`), keyboard-first, **no mouse support** (tmux has `mouse off`).
- **Runtime:** Bun 1.4 (`brew install oven-sh/bun/bun`). Node 24 was tried first but
  OpenTUI's native FFI requires `node:ffi`, which Node 24 doesn't ship; Bun is OpenTUI's
  primary runtime. Bun lives in `~/.bun`/Homebrew and doesn't affect nvm-managed Node.
- **Location:** `~/projects/command-center`.
- **mkpanes:** gets an optional `-s <session>` flag in phase 2 (backward compatible).
- Runs inside tmux as a long-lived window.

## Architecture

Single process. React renders the TUI; a data layer shells out to `git`, `glab`, `acli`,
and `tmux` with `execFile`, all fetches parallelized and joined into dashboard rows.

```
src/
  index.tsx        entry: createCliRenderer + root
  App.tsx          keyboard handling, refresh, view state
  types.ts         Row / Ticket / Mr / TmuxWindow models
  data/
    exec.ts        execFile helper (timeout, error capture)
    repos.ts       parse mkpanes case-block into {alias -> path}
    worktrees.ts   worktree list + dirty/ahead/behind per worktree
    gitlab.ts      MR lookup per repo, pipeline via mr view
    jira.ts        ticket lookup by keys (JQL `key in (...)`), assigned-open search
    tmux.ts        list windows, match ticket key in window name
    collect.ts     orchestrate parallel fetch, build rows
  components/
    Dashboard.tsx  the main table
```

### Fetch strategy

1. Parse repo map (local, instant).
2. Per repo in parallel: `git worktree list --porcelain` (local, fast).
3. Per non-main worktree in parallel: git dirty/ahead/behind (local, fast).
4. Per repo with worktrees, in parallel: `glab mr list -F json` (~1.5s network);
   then `glab mr view <iid> -F json` per matched MR for pipeline status.
5. One `acli` search: `key in (<all ticket keys from branches>)` (~2s network).
6. One `tmux list-windows -a`.

Columns render incrementally: local git data appears immediately; MR/Jira columns fill in
as network calls land. `r` re-fetches.

## Phases

- **Phase 1 (this): read-only dashboard.** One row per worktree: repo, branch/ticket,
  ticket summary + Jira status, local git state, MR state + CI pipeline, tmux window
  indicator. Keys: j/k navigate, r refresh, o open MR in browser, t open ticket, q quit.
- **Phase 2: actions — DONE (2026-08-20).** mkpanes `-s <session>` flag added (all tmux
  calls now target the created window id, deterministic from outside tmux; backup of the
  pre-change script at /tmp/mkpanes.bak). `s` jumps to or launches a row's tmux window,
  `c` transitions tickets (transitions listed + executed via Jira REST with
  JIRA_EMAIL/JIRA_API_TOKEN env vars — acli can execute but not list transitions),
  `x` removes worktrees with optional branch deletion and dirty-file warning.
  Full wrap-up (close MR + ticket Done + cleanup in one action) deferred.
- **Phase 3: backlog view — DONE (2026-08-20).** Second view (`tab`/`1`/`2`) listing
  assigned-but-not-active tickets via Jira REST search (acli's search disallows the
  `updated` field, so REST is used with the same env-var credentials). Shows type,
  status, priority, relative update age, and a worktree-exists indicator. `s` opens a
  repo picker and starts the ticket via mkpanes; `c` transitions; `t` opens in browser.
- **Phase 4: ToDos — DONE (2026-08-20).** Third view (`3`) with a JSON store at
  `~/.config/command-center/todos.json`. Add via OpenTUI input (submit events carry no
  value, so the draft is tracked via onInput), toggle with space/enter, delete with
  confirm modal. Pending sort above completed.

- **Post-phase additions (2026-08-20).** `Shift+X` mass cleanup: removes every clean
  worktree with a Done/Closed ticket + merged MR (dirty ones listed but skipped),
  preview modal, per-item progress in the status bar. Animated spinner shown in the
  header while any source is loading and next to busy messages during actions.
- **2026-08-21.** `n` opens a free-form mkpanes prompt: raw arguments are tokenized and
  passed straight to the script (usage hint shown below the input), `-s <session>` is
  appended unless the user passes their own, and the dashboard refreshes on completion.
  mkpanes errors surface in the status bar.
- **2026-08-21: ticket creation.** `n` in the backlog view opens a "new ticket" tmux
  window running cursor-cli prompted to use the jira-ticket skill (asks for parent epic,
  platform, type, details). Note cursor-cli is a zsh alias for `agent`, so it must be
  launched via tmux send-keys into an interactive shell, not execFile. Creation is
  conversational in that window; the command center is not blocked. Start the new ticket
  afterward with `s` (which runs /start-ticket via mkpanes).

- **2026-08-21: wrap-up action.** `w` on a worktree row: merges the MR
  (`glab mr merge --yes --remove-source-branch`; glab enables auto-merge when a pipeline
  is running), transitions the ticket to Done (falls back to Closed; warns with available
  statuses if neither exists), closes the row's tmux window, removes worktree + branch.
  Step preview modal with not-mergeable/dirty warnings; aborts if the merge fails.

## Remaining ideas (unscheduled)

- Auto-refresh on an interval.
- Repo-suggestion heuristics in the backlog start picker (e.g. by project key).
