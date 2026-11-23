---
name: cc-hub
description: >-
  Start, repair or inspect Command Center's two hubs — the REVIEWS and QA
  project-style tmux sessions (tabs 1 and 2) whose central agents track code
  reviews and QA sessions, start new ones on Daniel's word, receive the
  workers' reports and report upward to the review / qa specialists. Use when
  a hub tab is missing or its central agent quit, when Daniel says "start the
  review hub", "where did the QA tab go", "move my reviews into the hub", or
  when "cc-hub" is mentioned. The TUI runs `cc-hub ensure` itself on start.
---

# The review and QA hubs (cc-hub)

A hub is a project without a plan: a directory under `dirs.projects` (`reviews`, `qa` — config `hubs.review` / `hubs.qa`, `""` turns one off), a `PROJECT.md` marked `**Kind:** hub`, a tmux session of the same name with a `central` window (cc-dash left, the hub's central agent right — the same layout as `start-project`), and the review / QA windows as its task tabs. The status line pins them: `0 COMMAND CENTER`, `1 REVIEWS`, `2 QA`, projects from 3.

Reporting chain: worker (review-ticket / qa-ticket agent in a window of the hub session) → `cc-report` with no target resolves to `project:<hub>` → the hub central → `cc-report review|qa` → the specialist tab in Command Center → central. Workers keep the same skills and rules; only who reads their reports changes.

```bash
cc-hub ensure [review|qa|all] [--attach]   # create what is missing; idempotent
cc-hub adopt  [review|qa|all] [--dry-run]  # move *_review_* / *_qa_* windows from other sessions into the hubs
cc-hub status                              # sessions, central panes, window counts
cc-hub prompt <review|qa>                  # rewrite <hub>/.cc/central-prompt.txt and print its path
cc-hub session <review|qa>                 # print the hub's session name; exit 1 when not running
```

Resolve the binary: `cc-hub` on `PATH`, then `~/.local/bin/cc-hub`, then `~/.agents/skills/cc-hub/cc-hub`. Needs `tmux`, `jq`.

## ensure

For each hub that is on: create the directory, `.cc/`, and `PROJECT.md` if missing; write the central prompt; create the session with the `central` window (pane 1 `cc-dash`, pane 2 the agent command from `commands.agent` with `commands.projectModel`, `@agent_pane`, `@cc_role central`, `@agent_cmd`, session option `@cc_hub <kind>`) if the session is missing; otherwise restart only what quit (the agent pane, the dash). Then renumbers the tabs (`cc-session index`). `--attach` switches the client to the hub afterwards. Safe to run any time — the TUI calls it on every start so the two tabs always exist.

## adopt

Finds windows in *other* sessions whose panes sit in a `*_review_*` directory (review hub) or `*_qa_*` directory (QA hub) and moves them with `tmux move-window` into the hub, keeping their panes and agents. The agent inside keeps running; its next `cc-report` already routes to the hub central because routing follows the session. `--dry-run` lists the moves. Run it once after switching to hubs, or whenever a review/QA window was opened with an explicit `-s` elsewhere.

## The hub centrals

Each hub central's prompt (`cc-hub prompt <kind>` prints the path) tells it to:

- Start work on Daniel's word only — `mkpanes <repo> -w <branch> -t <ref> --review` (reviews; `-w <source branch>` and `/review-ticket <MR URL>` via `--prompt-file` for an MR with no ticket) or `mkpanes <repo> -w <KEY> --qa` (QA). No `-s`: mkpanes puts the window in the hub session on its own.
- Keep the picture: which windows are open, each one's state from the `[cc mail]` reports and `.cc/inbox.jsonl`; `cc-dash` on the left shows it live, so it does not narrate reports.
- Report upward with `cc-report review` / `cc-report qa`: a verdict ready, an issue found, an agent stuck or waiting on Daniel (severity attention), a review or QA finished. One line each.
- Steer a worker with `cc-mail send --window <session>:<window> "<text>"`; never type into its pane.
- Never post comments, approve, merge, transition Jira, or answer a worker's permission prompt — those are Daniel's, in the worker's own chat. Worktree-only wrap-up (`wrap-up --worktree-only` in the window) only when Daniel says a review/QA is done.

Command Center's review / qa specialists know the hub: they hand it work with `message_hub_central`, and treat its reports as the rolled-up state of the tab. Central reaches a hub with `cc-instruct project:reviews` / `project:qa`.

## Rules

- `start-project reviews` / `start-project qa` refuse — a hub is not a project; use `cc-hub ensure`.
- The Projects tab, the idle watchdog and the needs queue skip the hub directories.
- Turning a hub off (`"hubs": { "qa": "" }`) makes QA windows open in the Command Center session again and routes their reports straight to the qa specialist; nothing else changes.
