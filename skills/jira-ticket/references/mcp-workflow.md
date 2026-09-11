# MCP Tool Workflow

Use the Atlassian MCP tools to create Jira tickets. Follow this sequence.

## Tool Sequence

### 1. Resolve the Workspace

```
Tool: getAccessibleAtlassianResources
Purpose: Retrieve Atlassian workspaces and scopes for the current user
```

Rules:

- Dedupe returned resources by `cloudId` + `url` because the same workspace can appear multiple times for different products/scopes.
- Select only `https://smartsensebydigi.atlassian.net`
- Expected SmartSense cloud ID: `3be885af-99d6-4514-939e-3c99560b10eb`
- If SmartSense is not present, stop and tell the user. Do not silently use any other workspace.

### 2. Resolve Assignee

Default assignee is Daniel Kesler — account ID `712020:1a6dc1ec-48ca-40bf-81ad-3cc54adc8642` (see Known Constants in SKILL.md). Do NOT call `atlassianUserInfo`.

Only call `lookupJiraAccountId` if the developer explicitly provides a different assignee name or email.

### 3. Resolve Sprint Target (if requested)

Only resolve sprint when the developer asks for sprint placement.

- If sprint target is `backlog` (or unspecified), skip sprint updates.
- If sprint target is a sprint ID, use it directly.
- If sprint target is a sprint name, search for the matching sprint.
- If sprint target is `current sprint`, resolve active sprint(s) for the Jira project:
  - Use `searchJiraIssuesUsingJql` with `project = <PROJECT_KEY> AND sprint in openSprints() ORDER BY updated DESC`
  - Collect unique open sprint IDs from returned issues
  - If exactly one open sprint is found, use it
  - If multiple open sprints are found, ask the developer which sprint to use (name + ID options)
  - If no active sprint is found, ask whether to continue in backlog or provide an explicit sprint ID

### 4. Resolve Required Create Fields (project-specific)

Before creating the issue, detect required fields for the selected project + issue type.

1. Resolve issue type metadata:
   - Default `issueTypeName` to `Story` unless the user explicitly specified a different issue type (e.g., Bug, Task, Epic).
   - Call `getJiraProjectIssueTypesMetadata` to find the issue type ID for the chosen `issueTypeName`.
2. Resolve field requirements:
   - Call `getJiraIssueTypeMetaWithFields` using project key + issue type ID.
3. For each required field:
   - If already provided, keep it.
   - If a `defaultValue` exists, auto-fill it.
   - If no `defaultValue` exists, ask one focused question for that field only.
4. Continue only after all required fields are populated.

### 5. Create the Ticket

```
Tool: createJiraIssue
Fields:
  - summary: "[PLATFORM] (type) - description"     (formatted title)
  - description: (full template with ## headers)     (markdown body)
  - assignee_account_id: "712020:1a6dc1ec-48ca-40bf-81ad-3cc54adc8642" (unless a different assignee was resolved in step 2)
  - parent: (parent ticket key, only if provided)
  - additional_fields: (required custom fields resolved in step 4)
```

### 6. Update Branch Id in Description (required)

Immediately after creation, update the Branch Id placeholder with the created issue key.

1. Call `getJiraIssue` for the created issue key and read `description`.
2. Replace the first `## Branch Id:` line with:
   - `## Branch Id: <ISSUE_KEY>`
3. Call `editJiraIssue` to save the updated description.

### 7. Set Sprint and Priority (if needed)

```
Tool: editJiraIssue
Purpose: Update sprint or priority fields that weren't set during creation
Fields: customfield_10007 (sprint ID), priority
```

### 8. Verify and Report

```
Tool: getJiraIssue
Purpose: Confirm creation and retrieve the ticket URL
```

Report the ticket ID (e.g., `PROJ-12345`) and URL back to the developer.

## Field Mapping

| Ticket Field | Jira API Field | Notes |
|-------------|---------------|-------|
| Title | `summary` | `[PLATFORM] (type) - description` |
| Description | `description` | Markdown with `##` headers |
| Branch Id | `description` | Must be updated to Jira issue key right after create |
| Assignee | `assignee_account_id` | Default: current user |
| Parent | `parent` | Only if provided |
| Project required fields | `additional_fields` | Resolve via issue type metadata before create |
| Sprint | `customfield_10007` via `editJiraIssue` | Set after creation when sprint target is not backlog |
| Priority | `priority` | Set after creation if specified |

## Error Handling and Fallback

### MCP Server Not Available

If MCP tools are not responding (error, timeout, or the Atlassian MCP server is not configured):

1. Inform the user: "The Atlassian MCP server is not available."
2. Probe `acli` as a fallback: run `acli jira auth status` in the shell.
3. If `acli` is authenticated, switch to the acli workflow ([references/acli-workflow.md](acli-workflow.md)) and proceed.
4. If neither tool works, tell the user and suggest: verify the Atlassian MCP connection in your AI tool's settings, or run `acli jira auth login` (install from [developer.atlassian.com/cloud/acli](https://developer.atlassian.com/cloud/acli/guides/install/) if not present).

### MCP Tool Errors During Creation

- If `getAccessibleAtlassianResources` returns no resources, ask the developer to verify their Atlassian connection
- If `getAccessibleAtlassianResources` returns resources but SmartSense is missing, stop and ask the developer to fix workspace access
- If `createJiraIssue` fails, show the error. If it's an auth/permission issue, try `acli` as a fallback ([references/acli-workflow.md](acli-workflow.md)).
- If `createJiraIssue` fails with a field error, ask the developer to verify project and issue type
- If required-field metadata calls fail, report the error and stop
- If Branch Id update fails, report the error and stop
- If multiple current sprints are found, ask the developer to pick one
- If current sprint lookup fails, ask whether to continue in backlog or provide a sprint ID directly
