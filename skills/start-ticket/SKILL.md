---
name: start-ticket
description: Prepare a Jira ticket to begin work on it in the SmartSense Atlassian workspace — fetch the ticket, ensure it is formatted to our standard, assigned to Daniel, set to In Progress, and placed in the current sprint. When running inside tmux, rename this pane's window tab to `<ticket>: <few words>`. Then investigate the work, ask only when something genuinely needs Daniel, call out the plan, implement it without waiting for approval, and hand off to /push-branch when the work is done. Use when starting work on a branch/ticket, when invoked as `/start-ticket <ticket-or-branch>` (optionally with `--no-format` to skip the formatting check), or when the user says "start this ticket", "get this ticket ready", "prep my ticket", or mkpanes launches a worktree. Updates anything that isn't already correct.
---

# Start Ticket Skill

Prepare a Jira ticket so Daniel can start working on it, then plan and execute the work. Given a ticket key or a branch name that contains one, make sure the ticket is:

1. **Formatted to our standard** (per the `jira-ticket` skill)
2. **QA Steps enriched** with any Universal Test Plan Agent test-plan comment
3. **Assigned to Daniel**
4. **In Progress**
5. **In the current sprint**
6. **Planned and done** — investigate until the approach is executable, ask only when genuinely unsure, call out the plan, implement it, then hand off to `/push-branch`

Update whatever isn't already correct on the ticket. Use the Atlassian MCP server only for Jira, targeting the SmartSense workspace. After the ticket is ready, use the current repo to plan and do the work, then hand off to `/push-branch`, which opens the MR and hands on to `/babysit-branch`. Daniel hears from this chain at two kinds of moment only: when the MR is ready for his review, and when a question comes up that only he can answer.

## Known Constants

- **Cloud ID** (do not look up): `3be885af-99d6-4514-939e-3c99560b10eb`
- **Daniel Kesler** — account ID: `712020:1a6dc1ec-48ca-40bf-81ad-3cc54adc8642`, email: `dkesler@digi.com`. Do NOT call `atlassianUserInfo`.
- **Sprint field**: `customfield_10007` — set via `editJiraIssue` to a numeric sprint ID.
- **Universal Test Plan Agent** — account ID: `712020:7fe93eba-773b-4af4-9aca-acdb60bf7113`. A bot that posts an AI-generated test plan comment on tickets after a PR is linked. See Step 2.5.

## Tool Names

This skill refers to MCP tools by short name (e.g. `getJiraIssue`, `editJiraIssue`). Some agent runtimes expose the same tools under a longer qualified or deferred name (e.g. `mcp__claude_ai_Atlassian__getJiraIssue`, loaded via a tool-search/discovery step before first use). If your runtime works that way, resolve/load the qualified equivalent and use that — the short names below always refer to the same underlying Atlassian operation.

## When you need Daniel

Daniel is not watching this pane. Two things reach him; nothing else does:

- **A question only he can answer** — the Step 6 list, a required ticket section nobody can fill but him, or an execution surprise that changes product behaviour or scope. Ask it in one message (batch everything you need), and when `cc-report` is on `PATH` and `$TMUX_PANE` is set also run `cc-report --severity attention "<KEY>: needs you — <question in a few words>"` so his tab lights up. Then wait.
- **The MR is ready for review** — `/babysit-branch` sends that one at the end of the chain.

Plans, ticket edits, commit messages and progress are called out in the chat as information. Do not phrase them as questions and do not wait for a reply.

## Input

The argument is a ticket key or a branch name, optionally followed by flags.

- **`--no-format`** — if present, skip the formatting check (Step 2). Strip this flag out of the argument before extracting the ticket key.

Extract the Jira issue key by matching the pattern `[A-Z]+-\d+` (e.g. `LW-17095`, `feature/LW-17095-fix-thing` → `LW-17095`). The project key is the prefix before the dash (e.g. `LW`).

If no Jira key can be extracted, stop and tell the user what was passed.

## Workflow

### Step 1: Fetch the ticket

Call `getJiraIssue` with the cloud ID and the extracted key, requesting fields:
`["summary", "description", "status", "assignee", "issuetype", "priority", "customfield_10007", "comment"]`.

Note the current title, description, assignee, status, sprint, and comments.

### Step 1.5: Rename this tmux tab

The shell inherits `$TMUX` and `$TMUX_PANE` when this agent was started inside a tmux pane (mkpanes launches cursor-cli that way). `$TMUX_PANE` is this pane. The status-bar tab is the tmux window that contains it.

If either variable is unset, skip this step.

Otherwise:

1. Read the current window name: `tmux display-message -p -t "$TMUX_PANE" '#{window_name}'`.
2. Skip when that name is `Command Center` or `central`. Those are shared tabs.
3. Build `<KEY>: <few words>` from the ticket summary.
   - Drop a leading `[PLATFORM] (type) - ` prefix when present.
   - Keep 3–6 words. Leave the ticket key only in the `<KEY>:` prefix.
   - Example: `[BE] (fix) - allow NA setting can't be removed` → `LW-17095: allow NA setting`.
4. The ticket key must stay in the name. Command Center matches a worktree tab with `window name includes ticket key`.
5. If the window already has that name, skip. Otherwise run:

```
tmux rename-window -t "$TMUX_PANE" "$TITLE"
```

`rename-window` turns off `automatic-rename` for that window, so later shell activity does not replace the name. Target only `$TMUX_PANE`. Do not rename any other window.

### Step 2: Check formatting against the jira-ticket standard

> If `--no-format` was passed, skip this entire step and go to Step 3.

The source of truth for our ticket format is the **`jira-ticket`** skill:

- Title format and platform/type rules: `~/skills/jira-ticket/SKILL.md`
- Description template (Standard vs. Bug, chosen by issue type) and formatting rules: `~/skills/jira-ticket/references/templates.md`

Read those, then compare the ticket's current title and description:

- **Title** — must be `[PLATFORM] (type) - description`.
- **Description** — must contain the `##` sections from the matching template (Bug template if issue type is Bug, otherwise the Standard template).

If the ticket already matches, skip to Step 3.

If it doesn't match:

1. Rebuild the title and description into the correct template, **reusing the existing ticket content** — map whatever is already there into the right sections (e.g. an existing goal into Summary; existing repro / QA Testing Steps / Test Cases into QA Steps; old Technical Details into Implementation Details; any "why" from Business Context into Summary). Auto-detect platform/type from the content. Keep `## Branch Id:` set to the ticket key and leave `## Merge Request` empty.
2. For any **required** section that the existing ticket doesn't provide and that only Daniel can supply (acceptance criteria, repro steps, the "why"), **ask Daniel** for it per *When you need Daniel*. Use "None" / "N/A" for genuinely inapplicable fields rather than asking. Implementation Details is not one of these — leave it as a placeholder and fill it from your own Step 6 investigation. Do not invent acceptance criteria or repro steps.
3. Apply with `editJiraIssue` (`summary` + `description`) and call out in a few lines what moved where (old title → new title; which existing text landed in which section). Do not wait for confirmation — it is his own content rearranged, and the Step 5 report shows the result.

### Step 2.5: Check for a Universal Test Plan Agent comment

Look through the ticket's comments for one authored by the **Universal Test Plan Agent** (account ID above). There is at most one meaningful one — if several exist, use the most recent.

If none exists, skip this step entirely (don't mention it unless asked).

If one exists, parse it for:
- The **ACCEPTANCE-CRITERIA–DRIVEN TESTS** section (positive / negative / edge cases per AC)
- Ignore the RCA metadata header, COVERAGE SUMMARY table, AUTOMATION SUGGESTIONS, and run-summary footer — those aren't useful inside the ticket body.

Compare against the ticket's current **QA Steps** section (post Step 2, if that ran):

- **If QA Steps is missing or thin** (just restates the AC, no edge/negative cases): draft additional bullets from the agent's edge/negative cases to merge in. Reuse its wording; don't invent beyond what it suggests.
- **If QA Steps already covers this ground**: no change needed.

Never overwrite existing QA Steps — only append what's missing. Apply via `editJiraIssue` on `description` (fold it into the Step 2 edit when both happen) and call out in one line how many bullets were added. No confirmation.

If the comment's domain routing looks wrong for this ticket (e.g. labeled `MOBILE` for a web-only change), mention it to Daniel and suggest adding the `wrong_domain_universal` label — but don't add it automatically.

### Step 3: Resolve the current sprint

There is only ever one open sprint. Call `searchJiraIssuesUsingJql`:

- `cloudId`: the constant above
- `jql`: `project = <PROJECT_KEY> AND sprint in openSprints() ORDER BY updated DESC`
- `fields`: `["customfield_10007"]`
- `maxResults`: 1

Take the numeric sprint ID from the returned issue's `customfield_10007`. If no issue is returned (no open sprint), tell Daniel and skip the sprint update (still do assignee + status).

### Step 4: Apply the remaining changes (only what's needed)

- **Assignee** — if not already Daniel, set `assignee_account_id` to Daniel's account ID.
- **Sprint** — if the ticket's `customfield_10007` doesn't already include the current sprint ID, set `customfield_10007` to the numeric sprint ID.
- (Assignee + sprint can be combined into one `editJiraIssue` call, and folded into the Step 2 edit if that one ran.)
- **Status** — if not already `In Progress`, call `getTransitionsForJiraIssue`, find the transition whose target is `In Progress`, and call `transitionJiraIssue` with that transition ID.

Skip any change that's already correct — don't make no-op edits.

### Step 5: Report

Print a short summary of the ticket and what changed, e.g.:

```
LW-17095 — [BE] (fix) - allow NA setting can't be removed
• Format:    reformatted to Bug template (asked for QA Steps)   [or: skipped (--no-format)]
• QA Steps:  found Universal Test Plan Agent comment — merged 2 edge cases into QA Steps
             [or: found, QA Steps already cover it — no change / or: none found]
• Assignee:  already Daniel ✓
• Sprint:    moved into current sprint (id 1234)
• Status:    To Do → In Progress
• Tab:       LW-17095: allow NA setting   [or: skipped — not in tmux / shared tab]
<ticket URL>
```

Then continue immediately to Step 6. Do not wait for Daniel to ask for a plan.

### Step 6: Investigate until the plan is executable

Goal: be **very sure** the work can be executed before proposing (and especially before starting) a solution. Play it safe. Prefer questions over guesses.

Do **not** edit application code in this step. Ticket edits from Steps 2–4 are already done.

1. **Read the ticket as the spec.** Use the post-update title + description (Summary, Acceptance Criteria, Test Plan, QA Steps, Implementation Details; repro / current vs expected if a bug). Comments only if they change the work (QA bounce, design decision).
2. **Orient in the repo.** Read the local `AGENTS.md` (and a workspace-level one if this is a monorepo). Identify which package/area the ticket belongs to.
3. **Find the real code.** Search for the feature, component, API, or bug site. Open the files that would change. Note neighboring tests and existing patterns to follow.
4. **Stop and ask whenever confidence is not high.** Ask Daniel before presenting a plan if any of these are true:
   - Cannot find the code, or several unrelated sites could be the target
   - Acceptance criteria are missing, contradictory, or could mean two product-different things
   - Multiple valid approaches with different UX, API, or scope implications
   - The change may be in a shared library (many consumers) and the ticket does not say how far to go
   - Repro / environment / flag / permission is needed to be sure
   - The ticket looks larger than one MR or the next slice is unclear

   Ask specific questions, all in one message, per *When you need Daniel*. Do not invent acceptance criteria, product behavior, or a "probably this file" guess. If blocked, say what was searched and what is still unknown, then wait.

   Routine judgment calls are yours, not his: which of two equivalent files, a name, where a test lives, following the nearest existing pattern. Make them and note them in the plan's **Risks** line.

5. **Only draft a plan once** you can name the files/areas to change, the concrete steps, and how you will know it worked. If you cannot, keep asking — do not paper over gaps with a vague plan.

### Step 7: Call out the plan and continue

Print the plan, then go straight to Step 8. Do not ask for approval and do not wait.

```
## Plan — LW-XXXXX
**Goal:** one sentence, from the ticket
**Where:** packages + key files / symbols
**Approach:**
1. ...
2. ...
**Checks:** tests / QA path that prove the ACs
**Risks:** leftovers, shared-lib blast radius, judgment calls made (open questions should be none — they were asked in Step 6)
Starting now — reply here if you want it changed.
```

Daniel can still steer: if a message from him arrives while you work (a change of approach, a scope cut), fold it in, re-print the plan and carry on. Fill the ticket's **Implementation Details** from this plan now if Step 2 left it as a placeholder.

### Step 8: Execute the plan

Implement the plan as called out. Follow repo conventions (`AGENTS.md`, existing patterns). Do not expand scope. Run the checks the plan named (typecheck / lint / affected tests) and fix what they find.

If execution hits something the plan did not cover:
- a routine detail (an extra call site, a helper to extract, a fixture to add) → do it and mention it in the hand-off note;
- something that changes product behaviour, API shape or scope, or reaches into a shared library beyond the ticket → **stop and ask** per *When you need Daniel*. Do not improvise a new approach mid-flight.

### Step 9: Hand off to /push-branch

When the plan's checks pass and the working tree holds only the ticket's changes, write a two-line note (what changed, how it was verified) and run the `push-branch` skill. It calls out the commit message, pushes, opens the MR, links it on the ticket and hands on to `/babysit-branch`, which watches CI and review until the MR is ready and then notifies Daniel. Do not ask whether to push.

Do not hand off while blocked on a question, when a check fails for a reason you cannot fix within the ticket's scope, or when the diff contains anything outside the plan that you have not called out.

## Critical Rules

- Atlassian MCP only for Jira; never silently switch workspaces. If SmartSense/MCP is unavailable, stop and tell the user (do not skip ahead to a plan that depends on ticket fields you could not read).
- Use the hardcoded cloud ID and Daniel's account ID — do not call `getAccessibleAtlassianResources` or `atlassianUserInfo`.
- The `jira-ticket` skill is the source of truth for title/description format — read it rather than hardcoding the template here.
- Never overwrite existing ticket content with placeholders; reuse what's there and ask for anything genuinely missing.
- Call out ticket reformatting, QA Steps additions and the plan as information; never wait for confirmation on them.
- Set the sprint via `customfield_10007` with the numeric sprint ID.
- Only change fields that aren't already correct.
- After ticket prep: investigate, ask only what only Daniel can answer, call out the plan, implement, hand off to `/push-branch`.
- Do not guess product behavior or the change site. If unsure, ask — once, with everything batched, and light up the tab with `cc-report --severity attention`.
- A message from Daniel mid-run is steering, not a gate — fold it in and keep going.
