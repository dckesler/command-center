---
name: start-ticket
description: Prepare a Jira ticket to begin work on it in the SmartSense Atlassian workspace — fetch the ticket, ensure it is formatted to our standard, assigned to Daniel, set to In Progress, and placed in the current sprint. Then investigate the work, ask until the approach is executable, present a plan for approval, and start implementing only after Daniel approves. Use when starting work on a branch/ticket, when invoked as `/start-ticket <ticket-or-branch>` (optionally with `--no-format` to skip the formatting check), or when the user says "start this ticket", "get this ticket ready", "prep my ticket", or mkpanes launches a worktree. Updates anything that isn't already correct.
---

# Start Ticket Skill

Prepare a Jira ticket so Daniel can start working on it, then plan and execute the work. Given a ticket key or a branch name that contains one, make sure the ticket is:

1. **Formatted to our standard** (per the `jira-ticket` skill)
2. **Test Cases enriched** with any Universal Test Plan Agent test-plan comment
3. **Assigned to Daniel**
4. **In Progress**
5. **In the current sprint**
6. **Planned** — investigate until the approach is executable, ask when unsure, present a plan, wait for approval, then implement

Update whatever isn't already correct on the ticket. Use the Atlassian MCP server only for Jira, targeting the SmartSense workspace. After the ticket is ready, use the current repo to plan and (only after approval) do the work.

## Known Constants

- **Cloud ID** (do not look up): `3be885af-99d6-4514-939e-3c99560b10eb`
- **Daniel Kesler** — account ID: `712020:1a6dc1ec-48ca-40bf-81ad-3cc54adc8642`, email: `dkesler@digi.com`. Do NOT call `atlassianUserInfo`.
- **Sprint field**: `customfield_10007` — set via `editJiraIssue` to a numeric sprint ID.
- **Universal Test Plan Agent** — account ID: `712020:7fe93eba-773b-4af4-9aca-acdb60bf7113`. A bot that posts an AI-generated test plan comment on tickets after a PR is linked. See Step 2.5.

## Tool Names

This skill refers to MCP tools by short name (e.g. `getJiraIssue`, `editJiraIssue`). Some agent runtimes expose the same tools under a longer qualified or deferred name (e.g. `mcp__claude_ai_Atlassian__getJiraIssue`, loaded via a tool-search/discovery step before first use). If your runtime works that way, resolve/load the qualified equivalent and use that — the short names below always refer to the same underlying Atlassian operation.

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

1. Rebuild the title and description into the correct template, **reusing the existing ticket content** — map whatever is already there into the right sections (e.g. an existing goal into Summary; existing repro / QA Steps / QA Testing Steps into Test Cases; old Technical Details into Implementation Details; any "why" from Business Context into Summary). Auto-detect platform/type from the content. Keep `## Branch Id:` set to the ticket key and leave `## Merge Request` empty.
2. For any **required** section that the existing ticket doesn't provide, **ask Daniel** for it. Use "None" / "N/A" for genuinely inapplicable fields rather than asking. Do not invent acceptance criteria, repro steps, or agent implementation instructions.
3. Show a short preview of the reformatted title + description and ask Daniel to confirm before editing.
4. On confirmation, apply with `editJiraIssue` (`summary` + `description`).

### Step 2.5: Check for a Universal Test Plan Agent comment

Look through the ticket's comments for one authored by the **Universal Test Plan Agent** (account ID above). There is at most one meaningful one — if several exist, use the most recent.

If none exists, skip this step entirely (don't mention it unless asked).

If one exists, parse it for:
- The **ACCEPTANCE-CRITERIA–DRIVEN TESTS** section (positive / negative / edge cases per AC)
- Ignore the RCA metadata header, COVERAGE SUMMARY table, AUTOMATION SUGGESTIONS, and run-summary footer — those aren't useful inside the ticket body.

Compare against the ticket's current **Test Cases** section (post Step 2, if that ran):

- **If Test Cases is missing or thin** (just restates the AC, no edge/negative cases): draft additional bullets from the agent's edge/negative cases to merge in. Reuse its wording; don't invent beyond what it suggests.
- **If Test Cases already covers this ground**: no change needed.

Never overwrite existing Test Cases — only append what's missing. Show Daniel a short preview of any proposed additions and get confirmation before applying (can be combined with the Step 2 preview/confirmation if both are happening in the same run). Apply via `editJiraIssue` on `description`.

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
• Format:    reformatted to Bug template (asked for Test Cases)   [or: skipped (--no-format)]
• Test Cases: found Universal Test Plan Agent comment — merged 2 edge cases into Test Cases
             [or: found, Test Cases already cover it — no change / or: none found]
• Assignee:  already Daniel ✓
• Sprint:    moved into current sprint (id 1234)
• Status:    To Do → In Progress
<ticket URL>
```

Then continue immediately to Step 6. Do not wait for Daniel to ask for a plan.

### Step 6: Investigate until the plan is executable

Goal: be **very sure** the work can be executed before proposing (and especially before starting) a solution. Play it safe. Prefer questions over guesses.

Do **not** edit application code in this step. Ticket edits from Steps 2–4 are already done.

1. **Read the ticket as the spec.** Use the post-update title + description (Summary, Acceptance Criteria, Test Plan, Test Cases, Implementation Details; repro / current vs expected if a bug). Comments only if they change the work (QA bounce, design decision).
2. **Orient in the repo.** Read the local `AGENTS.md` (and a workspace-level one if this is a monorepo). Identify which package/area the ticket belongs to.
3. **Find the real code.** Search for the feature, component, API, or bug site. Open the files that would change. Note neighboring tests and existing patterns to follow.
4. **Stop and ask whenever confidence is not high.** Ask Daniel before presenting a plan if any of these are true:
   - Cannot find the code, or several unrelated sites could be the target
   - Acceptance criteria are missing, contradictory, or could mean two product-different things
   - Multiple valid approaches with different UX, API, or scope implications
   - The change may be in a shared library (many consumers) and the ticket does not say how far to go
   - Repro / environment / flag / permission is needed to be sure
   - The ticket looks larger than one MR or the next slice is unclear

   Ask specific questions. Do not invent acceptance criteria, product behavior, or a "probably this file" guess. If blocked, say what was searched and what is still unknown, then wait.

5. **Only draft a plan once** you can name the files/areas to change, the concrete steps, and how you will know it worked. If you cannot, keep asking — do not paper over gaps with a vague plan.

### Step 7: Present the plan and wait for approval

Show a short plan and **stop**. Do not start implementing, scaffolding, or "just the first file."

```
## Plan — LW-XXXXX
**Goal:** one sentence, from the ticket
**Where:** packages + key files / symbols
**Approach:**
1. ...
2. ...
**Checks:** tests / QA path that prove the ACs
**Risks:** leftovers, shared-lib blast radius, open questions (should be none or already answered)
Approve this plan to start, or say what to change.
```

Wait for an explicit approve (e.g. "go", "lgtm", "do it", "approved"). A clarifying answer to an earlier question is **not** approval — incorporate it and re-show the plan if it changed.

If Daniel revises the plan, update it and ask again. Do not start on an unapproved revision.

### Step 8: Execute the approved plan

After approval, implement only what was approved. Follow repo conventions (`AGENTS.md`, existing patterns). Do not expand scope. If execution hits something the plan did not cover, **stop and ask** — do not improvise a new approach mid-flight.

## Critical Rules

- Atlassian MCP only for Jira; never silently switch workspaces. If SmartSense/MCP is unavailable, stop and tell the user (do not skip ahead to a plan that depends on ticket fields you could not read).
- Use the hardcoded cloud ID and Daniel's account ID — do not call `getAccessibleAtlassianResources` or `atlassianUserInfo`.
- The `jira-ticket` skill is the source of truth for title/description format — read it rather than hardcoding the template here.
- Never overwrite existing ticket content with placeholders; reuse what's there and ask for anything genuinely missing.
- Always preview and confirm before reformatting the title/description.
- Set the sprint via `customfield_10007` with the numeric sprint ID.
- Only change fields that aren't already correct.
- After ticket prep: investigate, then ask, then plan, then wait. Never start implementation until Daniel approves the plan.
- Do not guess product behavior or the change site. If unsure, ask.
- Do not treat ticket-prep confirmation or answers to clarifying questions as plan approval.
