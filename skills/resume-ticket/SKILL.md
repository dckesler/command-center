---
name: resume-ticket
description: Resume work on a Jira ticket whose worktree already exists — gather ticket context, local branch state, and any existing MR (pipeline, approvals, unresolved comments), then present a resume brief with suggested next steps. Use when picking work back up in an existing worktree, when invoked as `/resume-ticket <ticket-or-branch>`, or when mkpanes relaunches a window for a worktree that already existed. Unlike /start-ticket, this never reformats or edits the ticket.
---

# Resume Ticket Skill

Get Daniel back up to speed on a ticket he already started. The worktree exists, so the ticket was already prepped by `/start-ticket` — **do not reformat, reassign, or re-sprint it**. The job here is reconnaissance: what state is the ticket, the branch, and the MR in, and what should happen next?

## Known Constants

- **Cloud ID** (do not look up): `3be885af-99d6-4514-939e-3c99560b10eb`
- **Daniel Kesler** — account ID: `712020:1a6dc1ec-48ca-40bf-81ad-3cc54adc8642`, email: `dkesler@digi.com`. Do NOT call `atlassianUserInfo`.

## Tool Names

This skill refers to Atlassian MCP tools by short name (e.g. `getJiraIssue`). If your runtime exposes them under longer qualified names, resolve those — the short names always refer to the same underlying operation.

## Input

The argument is a ticket key or a branch name. Extract the Jira issue key by matching `[A-Z]+-\d+` (e.g. `feature/LW-17095-fix-thing` → `LW-17095`).

If no key can be extracted, treat the argument as a plain branch name: skip the Jira steps and still do the local + MR checks.

## Workflow

### Step 1: Fetch the ticket (read-only)

Call `getJiraIssue` with the cloud ID and the key, requesting:
`["summary", "description", "status", "assignee", "issuetype", "comment"]`.

From the result, note:

- Summary and the **Acceptance Criteria** / **QA Testing Steps** sections of the description.
- Current status. If it is not `In Progress`, that is a signal worth surfacing (e.g. bounced back from QA, or moved to Done while local work remains) — report it, and only transition it back to In Progress if Daniel asks.
- Recent comments — especially anything since work started: QA feedback, reviewer notes, Universal Test Plan Agent updates.

Do **not** edit the ticket in any way during this skill.

### Step 2: Local branch state

From the worktree directory (the current directory when launched via mkpanes):

- `git status --short` — uncommitted changes?
- `git log --oneline <default-branch>..HEAD` — commits made so far (fetch origin first if needed to compare against latest).
- `git rev-list --count @{upstream}..HEAD` (if an upstream exists) — unpushed commits. No upstream means the branch was never pushed.

### Step 3: Check for an existing MR

Run `glab mr view <branch>` (or `glab mr list --source-branch=<branch>`) from the worktree.

- **No MR** — note that the branch hasn't been pushed / no MR opened yet. `/push-branch` is the next step once the work is ready.
- **MR exists** — gather:
  - State (open / merged / closed) and URL.
  - Pipeline status of the latest commit.
  - Approval state.
  - Unresolved discussions — list each unresolved thread briefly (author + gist). CodeAnt bot suggestions count here too.
  - Whether the MR branch is behind the local branch (unpushed local commits) or ahead of it (someone else pushed).

If the MR is already **merged**, say so prominently — the remaining work is probably just wrap-up (`/wrap-up`), not more code.

### Step 4: Present the resume brief

Print a compact brief, then stop and let Daniel direct the work:

```
LW-17095 — [BE] (fix) - allow NA setting can't be removed
• Ticket:  In Progress, assigned to Daniel
           2 new comments since last commit (QA found an edge case — summarized below)
• Local:   4 commits ahead of main, 1 uncommitted file, 2 unpushed commits
• MR:      !4821 open — pipeline passed, no approvals yet, 3 unresolved threads
• Next:    address the 3 review threads, push, then /babysit-branch
<ticket URL>
<MR URL>
```

Tailor the **Next** line to the actual state, e.g.:

- No MR, work looks done locally → suggest `/push-branch`.
- MR open with unresolved comments / failing CI → suggest addressing them, then `/babysit-branch`.
- MR merged, ticket not Done → suggest `/wrap-up`.
- New QA/review comments on the ticket → summarize what they're asking for.

Then ask Daniel what he'd like to tackle first (or just proceed if he already said, e.g. "resume and fix the review comments").

## Critical Rules

- **Never edit the ticket** — no reformatting, no assignee/sprint/status changes. Status transitions only on explicit request.
- Atlassian MCP only for Jira reads; use the hardcoded cloud ID. If MCP is unavailable, do the git/MR checks anyway and say the Jira half was skipped.
- Read-only recon: this skill gathers state and proposes next steps — it does not push, merge, or resolve anything itself.
- If both the local branch and MR are missing meaningful work (no commits, no MR), say so — Daniel may actually want `/start-ticket` instead.
