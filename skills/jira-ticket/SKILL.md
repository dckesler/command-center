---
name: jira-ticket
description: Create and manage standardized Jira tickets in the SmartSense Atlassian workspace using the Atlassian MCP server, or the Atlassian CLI (acli) as a fallback when MCP is unavailable. Use when the user asks to create a Jira ticket, file a bug, create a feature request, log a task, write a ticket, update a ticket, transition a ticket status, or mentions Jira issue creation. Handles Backend (BE), Frontend (FE), and Mobile (MB) platforms with conventional commit types in the title. Supports Feature, Bug, Maintenance, and Refactor ticket types with structured templates. Also use when the user mentions MCP, Atlassian MCP, acli, or Atlassian CLI.
---

# Jira Ticket Skill

Create and manage standardized Jira tickets in the SmartSense Atlassian workspace. Prefer the Atlassian MCP server; fall back to the Atlassian CLI (`acli`) only when MCP is unavailable.

## Workspace Scope

- Target Atlassian site: `https://smartsensebydigi.atlassian.net`
- Preferred cloud ID: `3be885af-99d6-4514-939e-3c99560b10eb`
- `getAccessibleAtlassianResources` may return duplicate entries for the same workspace because Jira and Confluence scopes are listed separately. Dedupe by `cloudId` + `url`.
- Never silently switch to another Atlassian workspace. If SmartSense is unavailable, stop and tell the user.
- Do not treat legacy examples such as `LW-*` as workspace defaults.

## Known Constants

- **Daniel Kesler** — account ID: `712020:1a6dc1ec-48ca-40bf-81ad-3cc54adc8642`, email: `dkesler@digi.com`. Do NOT call `atlassianUserInfo`.
- **Sprint field**: `customfield_10007` — set via `editJiraIssue` to a numeric sprint ID.

## Tool Names

This skill refers to MCP tools by short name (e.g. `getJiraIssue`, `createJiraIssue`). Some agent runtimes expose the same tools under a longer qualified or deferred name (e.g. `mcp__claude_ai_Atlassian__getJiraIssue`, loaded via a tool-search/discovery step before first use). If your runtime works that way, resolve/load the qualified equivalent and use that — the short names below always refer to the same underlying Atlassian operation.

## Title Format

```
[PLATFORM] (type) - short description
```

**Platform** is auto-determined from context:

| Platform | Keywords                                                             |
| -------- | -------------------------------------------------------------------- |
| `[BE]`   | migrations, graphql, nodejs, worker, php, database, API, server-side |
| `[FE]`   | style, design, Cypress, components, UI/UX, React, frontend           |
| `[MB]`   | sensors, mobile, app, device                                         |

## Workflow

### Step 1: Gather Information

Ask only for missing required fields. Do NOT ask for platform, assignee, parent ticket, or branch ID.

**Required:**

- Main goal or intended outcome
- Repository (default: detect from current workspace)
- Data model or schema changes
- Acceptance criteria
- Test plan — written at ticket creation, before coding: what prerequisites are needed to test (hardware, software, data), the flow that proves each AC *can* be tested, and what automated tests will be written. Goal is to confirm the work is provably testable before starting.
- Test cases — the steps a QA engineer runs once the MR is ready to verify (same thing as "QA Testing Steps"). Infer from the summary and ACs when possible. Do not restate the ACs.

**Optional (ask only if needed):**

- Sprint target (`current sprint`, specific sprint ID/name, or `backlog`)

**Bug-specific (additionally required):**

- Environment (dev / staging / production)
- Steps to reproduce
- Observed result vs. expected result

**Defaults (do not ask):**

- Jira issue type: `Story` unless the user explicitly specifies otherwise (e.g., Bug, Task, Epic)
- Platform: auto-detect from keywords
- Assignee: current user
- Parent: infer from context if an epic or parent ticket is referenced anywhere in the conversation (e.g. "part of LW-XXXX", "child of", "builds on", a ticket key mentioned alongside words like "epic", "parent", "umbrella"); if explicitly provided, use it; if neither, skip it. Always show the inferred parent in the preview so the user can correct it.
- Branch ID: auto-set to created Jira issue key after ticket creation
- Sprint target: `backlog` unless the user explicitly asks for `current sprint` or a specific sprint
- Implementation Details (repo, schema, flags, perf/security, assumptions, agent implementation instructions): fill from context or "None" / "N/A". Do not interview the human for this section.

### Step 2: Format the Ticket

Use the appropriate template from [references/templates.md](references/templates.md).

### Step 3: Show Preview and Confirm

ALWAYS present a preview showing: Workspace, Project, Issue Type, Title, Description (including Test Plan and Test Cases), Assignee, Sprint Target, Priority, Parent (if any). Ask: "Should I proceed with creating this ticket?" and WAIT for explicit approval.

### Step 4: Detect Available Tool

Before creating, resolve the MCP workspace:

1. Call `getAccessibleAtlassianResources` (Atlassian MCP tool).
2. Dedupe returned resources by `cloudId` + `url`.
3. Select only the SmartSense workspace: `https://smartsensebydigi.atlassian.net` (`3be885af-99d6-4514-939e-3c99560b10eb`).
4. If SmartSense is present, continue with MCP. Follow [references/mcp-workflow.md](references/mcp-workflow.md).
5. If MCP is unavailable, times out, returns no resources, or SmartSense is missing: probe `acli` (`acli jira auth status`). If authenticated, follow [references/acli-workflow.md](references/acli-workflow.md) instead. If `acli` is also unavailable, stop and tell the user to fix the Atlassian MCP connection (or install/authenticate `acli`).

### Step 5: Create the Ticket

Follow the reference for whichever tool was selected in Step 4:

- **MCP**: [references/mcp-workflow.md](references/mcp-workflow.md)
- **acli**: [references/acli-workflow.md](references/acli-workflow.md)

If the chosen tool fails mid-creation, attempt the other tool as fallback before reporting an error and stopping.

## Critical Rules

- NEVER create a ticket without showing a preview and receiving confirmation
- ALWAYS format the title as `[PLATFORM] (type) - description`
- ALWAYS default assignee to current user
- ALWAYS target the SmartSense Atlassian workspace only
- NEVER silently target another Atlassian workspace
- For bugs, put environment / observed / expected in Summary and use "Test Cases" for post-MR QA steps (never "Repro Steps" or "QA Testing Steps")
- ALWAYS update "Branch Id:" to the created Jira issue key immediately after creation
- Use "None" or "N/A" for inapplicable fields
- Keep conversation focused -- ask only essential questions

## Reference Files

- **Ticket description templates**: [references/templates.md](references/templates.md)
- **MCP tool workflow**: [references/mcp-workflow.md](references/mcp-workflow.md)
- **Atlassian CLI (acli) workflow**: [references/acli-workflow.md](references/acli-workflow.md)
