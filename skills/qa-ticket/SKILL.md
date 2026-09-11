---
name: qa-ticket
description: Run a QA session for a Jira ticket — pull the QA steps from the ticket, wait while the tester works through them, collect any issues found, then post either a QA-passed comment or an issues-found comment on the ticket when done. Use when invoked as `/qa-ticket <ticket-or-branch>` or when mkpanes launches in --qa mode.
---

# QA Ticket Skill

Run an interactive QA session for a Jira ticket. Pull the steps, wait for the tester to work through them, then post the outcome as a comment on the ticket.

## Known Constants

- **Cloud ID** (do not look up): `3be885af-99d6-4514-939e-3c99560b10eb`
- **Daniel Kesler** — account ID: `712020:1a6dc1ec-48ca-40bf-81ad-3cc54adc8642`, email: `dkesler@digi.com`. Do NOT call `atlassianUserInfo`.

## Tool Names

This skill refers to MCP tools by short name (e.g. `getJiraIssue`, `addCommentToJiraIssue`). Some runtimes expose them under a longer qualified name (e.g. `mcp__claude_ai_Atlassian__getJiraIssue`, loaded via ToolSearch). Resolve and load the qualified form if needed.

## Input

Argument: a ticket key (e.g. `LW-17189`) or a branch name containing one.

- Extract the Jira key by matching `[A-Z]+-\d+`.
- If no key can be found, stop and ask the user for the ticket key.

## Workflow

### Step 1: Fetch the ticket

Call `getJiraIssue` with the cloud ID and extracted key, requesting fields `["summary", "description", "status"]` with `responseContentFormat: "markdown"`.

Show the ticket summary so the tester can confirm it's the right one.

### Step 2: Surface the QA steps

Look for a `## QA Testing Steps` section in the ticket's description.

**If QA steps exist in the ticket:** extract and display them exactly as written. Do not reformat or summarize — the tester needs the literal steps.

**If no QA steps exist:** invoke the `lists-fe-qa-steps` skill to generate them from the branch diff and ticket context. Present the generated steps. Do NOT offer to add them to the ticket (this is a read-only QA session).

After showing the steps, say:

> "Ready when you are. Tell me any issues as you find them, and let me know when you're done."

### Step 3: QA session — collect issues

Wait. The tester will work through the steps and report back. During this phase:

- Accept issue reports in any form ("it's not working when I do X", "found a bug: Y", etc.)
- Keep a running internal list of issues as the tester describes them
- Acknowledge each issue briefly ("Got it — logged.") and wait for more
- Do not ask clarifying questions unless an issue description is genuinely unclear
- Stay ready until the tester signals they are done

Signals that the session is done (any of these):
- "done", "that's it", "all good", "passing", "pass", "approve", "no issues", "looks good", "ship it"
- "found issues, done" / "that's all the issues"

### Step 4: Post the outcome comment

**If no issues were reported** (tester approved):

Post this comment on the ticket via `addCommentToJiraIssue`:

```
Passed QA.
```

**If issues were found:**

Format the issues as a numbered list and post this comment:

```
QA — Issues Found

1. <Issue 1 as described by the tester, cleaned up to one clear sentence>
2. <Issue 2>
...
```

Clean up the tester's wording only to fix obvious typos or sentence fragments — preserve their meaning exactly, don't editorialize or add context they didn't give.

### Step 5: Report

Print a short summary:

```
LW-##### — <summary>
• Comment: <"Passed QA." posted | X issues posted> ✓
<ticket URL>
```

## Fallback: Atlassian MCP unavailable

If MCP tools are not responding, probe `acli` (`acli jira auth status`). If authenticated, use `acli jira workitem comment add --key <KEY> --comment "<body>" -y` to post the comment. If neither works, show the tester the comment text and ask them to post it manually.

## Critical Rules

- NEVER transition the ticket status — that is the tester's or /pass-qa's responsibility
- NEVER update the ticket description
- NEVER offer to modify the QA steps on the ticket
- NEVER post the comment until the tester signals they are done
- ALWAYS show the comment text to the tester before posting, and wait for confirmation
- Keep the QA session low-noise — brief acknowledgements only, let the tester focus on testing
