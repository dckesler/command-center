---
name: cc-mrs
description: >-
  List Daniel's open GitLab merge requests from the shell with what matters
  for review: approvals, unresolved review threads (human vs bot, newest age),
  pipeline, conflicts, Jira status and whether a worktree/agent is on each —
  then hand the ones with open threads, red CI or conflicts to babysit-branch
  agents in one command. Use when you are the Command Center central agent and
  Daniel asks which MRs are waiting on approval, which have comments, or to do
  a pass on his MRs, or when "cc-mrs" is mentioned.
---

# Daniel's open MRs (cc-mrs)

GitLab is the source of truth for "pushed and waiting": the TUI only knows MRs that still have a worktree, and babysit-branch stops polling once it has told Daniel the MR is ready. `cc-mrs` asks GitLab for every open MR he authored and joins it with the local state.

```bash
cc-mrs [list] [--since N | --all] [--waiting] [--needs] [--json]
cc-mrs threads <!iid | branch | TICKET-KEY> [...]
cc-mrs pass [--dry-run] [<!iid | branch | TICKET-KEY> ...]
```

Resolve the binary: `cc-mrs` on `PATH`, then `~/.local/bin/cc-mrs`, then `~/.agents/skills/cc-mrs/cc-mrs`. Needs `glab` logged in.

## list

One line per MR, newest GitLab activity first:

```
!3840 lists/LW-18323 | ci:manual | 0/1 approvals | 1 unresolved (1 bot; newest 39m ago by CODEANT-BOT (bot)) | LW-18323 In Progress | worktree, window 0:4, agent working | updated 39m ago
!4767 api/LW-17298 | ci:success | 0/1 approvals | no open threads | LW-17298 In Progress | no worktree | updated 6d ago
4 waiting on approval · 2 need work (!3840, !528) · 1 draft
6 older MRs hidden (--all to include)
```

- **waiting on approval** = not a draft, CI not failed, no conflicts, no open threads, not yet approved. Nothing to do but wait for a reviewer (or for Daniel to post it — see the Jira status: `In Progress` means he has not said he posted it yet).
- **needs work** = unresolved threads, a failed pipeline, or conflicts. `--needs` shows only those; `--waiting` only the first group.
- MRs with no activity for `mrs.sinceDays` (default 60) are hidden; `--all` shows them, `--since N` changes the window.
- `no local checkout` means the repo is not in the command center's repo map; a pass skips it.
- Three GitLab calls per MR; ten MRs take about five seconds. Run `list` once, then work from it.

## threads

The unresolved threads of one MR: author (bots by display name), `file:line`, age, note count, first line of the opening comment. Use it to tell Daniel *what* the comments are before a pass, or to judge whether they are worth a pass at all.

## pass

For every MR that needs work (or only the named ones):

| local state | what happens |
|---|---|
| worktree with a live agent (any state but ended) | cc-mail (`from: cc-mrs`, severity attention) telling it to re-enter `/babysit-branch` — Step 1 if CI is not green on HEAD, else Step 3 — fix or close every thread, push, loop |
| worktree or checkout, no agent | `mkpanes <repo> -w <branch> --prompt-file …` opens (or reuses) the worktree in the work session with a babysit-branch prompt |
| no local checkout | skipped, said so |

The agents triage on their own (fix what is worth fixing, close the rest with a reason), push with `/push-branch`, and report with `cc-report` when the MR is green with no open threads. A pass **never** transitions a Jira ticket, merges, or approves anything. `--dry-run` prints the plan without doing it.

## Rules for the central agent

- "What is waiting on approval / out for review / do any have comments?" → `cc-mrs`, answer in one line per MR that matters plus the summary line. No pass.
- "Do a pass / go through my MRs / address the comments" → `cc-mrs pass`, report one line per MR (mailed / launched / skipped and why). Daniel asked; do not ask again.
- Log the pass in LOG.md; relay each agent's "ready again" report when it arrives.
