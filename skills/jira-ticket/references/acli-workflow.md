# Atlassian CLI (acli) Workflow

Use the [Atlassian CLI](https://developer.atlassian.com/cloud/acli/guides/introduction/) to create and manage Jira tickets via shell commands. This is a fallback for when the Atlassian MCP server is unavailable — see [SKILL.md](../SKILL.md) Step 4. The `acli` tool requires ADF (Atlassian Document Format) JSON for rich description formatting.

## Prerequisites

- `acli` installed ([install guide](https://developer.atlassian.com/cloud/acli/guides/install/))
- Authenticated: `acli jira auth status`

If auth fails in sandbox mode, retry with full/local permissions.

## Error Handling and Fallback

### acli Not Installed

If `acli` is not found (command not found error):

1. Inform the user: "The Atlassian CLI (acli) is not installed."
2. Probe MCP as fallback: call `getAccessibleAtlassianResources`.
3. If MCP responds, switch to the MCP workflow ([references/mcp-workflow.md](mcp-workflow.md)).
4. If neither tool works, suggest installing acli: `brew install atlassian/tap/acli` (macOS) or see [install guide](https://developer.atlassian.com/cloud/acli/guides/install/).

### acli Not Authenticated

If `acli jira auth status` reports unauthenticated or expired token:

1. Inform the user: "acli is not authenticated. Run `acli jira auth login` to log in."
2. Wait for the user to authenticate.
3. Re-check with `acli jira auth status` before proceeding.

### acli Create Fails

If `acli jira workitem create` fails:

1. Show the full error output to the user.
2. Common causes: invalid project key, wrong issue type, malformed ADF JSON.
3. If it's an auth/permission error, suggest `acli jira auth login`.
4. If MCP is available, offer to retry via MCP as fallback.

## Creation Workflow

### 1. Verify Auth

```bash
acli jira auth status
```

### 2. Build ADF JSON Payload

Create a temporary JSON file in a scratch/working directory (e.g. `.acli-tmp/workitem-create.json`). Descriptions MUST use ADF JSON (not markdown) for rich formatting in Jira.

```json
{
  "projectKey": "LW",
  "type": "Task",
  "summary": "[BE] (feat) - add report email digest system",
  "assignee": "@me",
  "parentIssueId": "LW-12345",
  "description": {
    "type": "doc",
    "version": 1,
    "content": [
      {
        "type": "heading",
        "attrs": { "level": 2 },
        "content": [{ "type": "text", "text": "Branch Id:" }]
      },
      {
        "type": "heading",
        "attrs": { "level": 2 },
        "content": [{ "type": "text", "text": "Merge Request" }]
      },
      {
        "type": "heading",
        "attrs": { "level": 2 },
        "content": [{ "type": "text", "text": "Summary" }]
      },
      {
        "type": "paragraph",
        "content": [{ "type": "text", "text": "Description of the ticket goes here." }]
      },
      {
        "type": "heading",
        "attrs": { "level": 2 },
        "content": [{ "type": "text", "text": "Acceptance Criteria:" }]
      },
      {
        "type": "bulletList",
        "content": [
          {
            "type": "listItem",
            "content": [
              { "type": "paragraph", "content": [{ "type": "text", "text": "Criterion 1" }] }
            ]
          }
        ]
      },
      {
        "type": "heading",
        "attrs": { "level": 2 },
        "content": [{ "type": "text", "text": "Test Plan" }]
      },
      {
        "type": "paragraph",
        "content": [
          { "type": "text", "text": "Prerequisites: ", "marks": [{ "type": "strong" }] },
          { "type": "text", "text": "None" }
        ]
      },
      {
        "type": "paragraph",
        "content": [
          { "type": "text", "text": "How to verify: ", "marks": [{ "type": "strong" }] },
          { "type": "text", "text": "The flow that proves each AC can be tested." }
        ]
      },
      {
        "type": "paragraph",
        "content": [
          { "type": "text", "text": "Automated tests: ", "marks": [{ "type": "strong" }] },
          { "type": "text", "text": "None" }
        ]
      },
      {
        "type": "heading",
        "attrs": { "level": 2 },
        "content": [{ "type": "text", "text": "Test Cases" }]
      },
      {
        "type": "bulletList",
        "content": [
          {
            "type": "listItem",
            "content": [
              { "type": "paragraph", "content": [{ "type": "text", "text": "Navigate, act, and confirm the expected result." }] }
            ]
          }
        ]
      },
      {
        "type": "expand",
        "attrs": { "title": "Implementation Details" },
        "content": [
          {
            "type": "paragraph",
            "content": [
              { "type": "text", "text": "Repo: ", "marks": [{ "type": "strong" }] },
              { "type": "text", "text": "api" }
            ]
          },
          {
            "type": "paragraph",
            "content": [
              { "type": "text", "text": "Data models or schema changes: ", "marks": [{ "type": "strong" }] },
              { "type": "text", "text": "None" }
            ]
          },
          {
            "type": "paragraph",
            "content": [
              { "type": "text", "text": "Feature flags: ", "marks": [{ "type": "strong" }] },
              { "type": "text", "text": "None" }
            ]
          },
          {
            "type": "paragraph",
            "content": [
              { "type": "text", "text": "Performance/security considerations: ", "marks": [{ "type": "strong" }] },
              { "type": "text", "text": "None" }
            ]
          },
          {
            "type": "paragraph",
            "content": [
              { "type": "text", "text": "Assumptions or constraints: ", "marks": [{ "type": "strong" }] },
              { "type": "text", "text": "None" }
            ]
          },
          {
            "type": "paragraph",
            "content": [
              { "type": "text", "text": "Agent implementation instructions: ", "marks": [{ "type": "strong" }] },
              { "type": "text", "text": "None" }
            ]
          }
        ]
      }
    ]
  }
}
```

### 3. Create the Ticket

```bash
acli jira workitem create --from-json ".acli-tmp/workitem-create.json" --json
```

### 4. Verify

```bash
acli jira workitem view LW-XXXXX --json
```

### 5. Clean Up

Remove the temporary JSON file after successful creation:

```bash
rm .acli-tmp/workitem-create.json
```

## Editing an Existing Ticket

### Generate Edit Payload

```bash
acli jira workitem edit --generate-json
```

Modify the generated JSON, then apply:

```bash
acli jira workitem edit --from-json ".acli-tmp/workitem-edit.json" -y --json
```

## Transitioning Ticket Status

```bash
acli jira workitem transition LW-XXXXX --status "In Progress"
```

## Inspecting All Fields (for custom fields)

```bash
acli jira workitem view LW-XXXXX --json --fields "*all"
```

Use this to discover custom field IDs for sprint, story points, etc.

## ADF Node Reference

| Section | ADF Node Type |
|---------|--------------|
| `## Heading` | `{ "type": "heading", "attrs": { "level": 2 }, "content": [{ "type": "text", "text": "..." }] }` |
| Collapsed Implementation Details | `{ "type": "expand", "attrs": { "title": "Implementation Details" }, "content": [ ... ] }` |
| Paragraph | `{ "type": "paragraph", "content": [{ "type": "text", "text": "..." }] }` |
| **Bold text** | `{ "type": "text", "text": "...", "marks": [{ "type": "strong" }] }` |
| Bullet list | `{ "type": "bulletList", "content": [ { "type": "listItem", ... } ] }` |
| List item | `{ "type": "listItem", "content": [ { "type": "paragraph", ... } ] }` |
| Code block | `{ "type": "codeBlock", "attrs": { "language": "sql" }, "content": [{ "type": "text", "text": "..." }] }` |

## Key Differences from MCP

| Aspect | MCP | acli |
|--------|-----|------|
| Description format | Markdown (MCP converts) | ADF JSON (must build manually) |
| Auth | Automatic via MCP server | `acli jira auth status` |
| Creation | `CallMcpTool createJiraIssue` | `acli jira workitem create --from-json` |
| Verification | `CallMcpTool getJiraIssue` | `acli jira workitem view KEY --json` |
| Transitions | Not supported | `acli jira workitem transition` |
| Field inspection | Limited | `--fields "*all"` to discover custom fields |

## acli Command Quick Reference

| Action | Command |
|--------|---------|
| Check auth | `acli jira auth status` |
| Create ticket | `acli jira workitem create --from-json file.json --json` |
| Create (simple) | `acli jira workitem create --summary "Title" --project LW --type Task` |
| Edit ticket | `acli jira workitem edit --from-json file.json -y --json` |
| View ticket | `acli jira workitem view KEY --json` |
| Transition | `acli jira workitem transition KEY --status "Status"` |
| Assign | `acli jira workitem assign KEY --assignee "@me"` |
| Search | `acli jira workitem search --jql "project = LW AND status = Open"` |
| All fields | `acli jira workitem view KEY --json --fields "*all"` |
| Generate JSON | `acli jira workitem create --generate-json` |

## Safety Rules

- ALWAYS show the `acli` command preview before running it
- Use `-y` / `--yes` flag for mutating commands that prompt (edit, assign, transition)
- Verify with `view --json` after every mutation
- Store temporary JSON payloads in a scratch/working directory and remove them after success
- `--description-file` sends plain text only -- it does NOT render markdown as rich formatting. Always use `--from-json` with ADF for structured descriptions
