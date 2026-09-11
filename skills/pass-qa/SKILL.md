---
name: pass-qa
description: Mark a Jira ticket as passing QA — transitions it to "Ready For Deployment" and adds a comment from Daniel saying he passed the QA. Use when the user says "pass QA", "QA passed", "mark as QA passed", or invokes /pass-qa. Accepts an optional ticket key argument; infers from the current git branch if omitted.
---

# Pass QA Skill

Move a Jira ticket to "Ready For Deployment" and add a QA-passed comment from Daniel.

## Known Constants

- **Cloud ID** (do not look up): `3be885af-99d6-4514-939e-3c99560b10eb`
- **Daniel Kesler** — account ID: `712020:1a6dc1ec-48ca-40bf-81ad-3cc54adc8642`, email: `dkesler@digi.com`. Do NOT call `atlassianUserInfo`.

## Tool Names

This skill refers to MCP tools by short name (e.g. `getJiraIssue`). Some runtimes expose them under a longer qualified name (e.g. `mcp__claude_ai_Atlassian__getJiraIssue`, loaded via ToolSearch). Resolve and load the qualified form if needed — the short names always refer to the same Atlassian operations.

## Input

Optional argument: a ticket key (e.g. `LW-17189`) or a branch name containing one (e.g. `LW-17189-fix-thing`).

- Extract the Jira key by matching `[A-Z]+-\d+`.
- If no argument is given, run `git branch --show-current` via Bash and extract the key from the branch name the same way.
- If no key can be found either way, stop and ask the user for the ticket key.

## Workflow

### Step 1: Fetch the ticket

Call `getJiraIssue` with the cloud ID and extracted key, requesting fields `["summary", "status"]`.

Confirm the ticket exists and show the summary to the user so they can verify it's the right one.

### Step 2: Transition to "Ready For Deployment"

Call `getTransitionsForJiraIssue` to get the available transitions for the ticket.

Find the transition whose target status name is `Ready For Deployment` (case-insensitive match). If no such transition exists, tell the user and stop — do not guess another transition.

Call `transitionJiraIssue` with that transition ID.

### Step 3: Add QA-passed comment

Call `addCommentToJiraIssue` with the comment body:

```
Passed QA.
```

This comment is made by Daniel's authenticated session — no need to set author explicitly.

### Step 4: Report

Print a one-line confirmation:

```
LW-##### — <summary>
• Status:  → Ready For Deployment ✓
• Comment: "Passed QA." added ✓
<ticket URL>
```
