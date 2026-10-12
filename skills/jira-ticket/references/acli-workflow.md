# Atlassian CLI (acli) Workflow

Use the [Atlassian CLI](https://developer.atlassian.com/cloud/acli/guides/introduction/) to create and manage Jira tickets via shell commands. This is a fallback for when the Atlassian MCP server is unavailable — see [SKILL.md](../SKILL.md) Step 4. The `acli` tool requires ADF (Atlassian Document Format) JSON for rich description formatting.

## Prerequisites

- `acli` installed ([install guide](https://developer.atlassian.com/cloud/acli/guides/install/))
- Authenticated against the SmartSense site: `acli jira auth status` must show `Site: smartsensebydigi.atlassian.net`

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

### acli Authenticated to Another Site

If `acli jira auth status` shows a `Site:` other than `smartsensebydigi.atlassian.net`:

1. Stop. Never create or edit tickets on another site.
2. Tell the user which site acli is on and ask them to run `acli jira auth switch` (or `acli jira auth login`) for `smartsensebydigi.atlassian.net`.
3. Re-check with `acli jira auth status` before proceeding.

### acli Create Fails

If `acli jira workitem create` fails:

1. Show the full error output to the user.
2. Common causes: invalid project key, wrong issue type, a missing required field, malformed ADF JSON.
3. If the error names a required field, ask the user for that value, add it under `additionalAttributes`, and retry.
4. If it's an auth/permission error, suggest `acli jira auth login`.
5. Before retrying via MCP, follow the duplicate check in [SKILL.md](../SKILL.md) Step 5.

## Creation Workflow

Create a private temporary directory for this run, outside any repo, and use that exact path for every payload below. Shell variables may not persist between commands, so record the printed path and substitute it for `<ACLI_TMP>`:

```bash
mktemp -d "${TMPDIR:-/tmp}/acli-jira.XXXXXX"
```

### 1. Verify Auth and Site

```bash
acli jira auth status
```

Continue only if it reports `✓ Authenticated` and `Site: smartsensebydigi.atlassian.net`.

### 2. Resolve Sprint Target (if requested)

Skip this step when the sprint target is `backlog`. Use a sprint ID directly if one was given.

For `current sprint` or a sprint name, list the project's boards, then the sprints on each `scrum` board:

```bash
acli jira board search --project <PROJECT_KEY> --json
acli jira board list-sprints --id <BOARD_ID> --state active,future --json
```

Collect sprints from every scrum board and dedupe by `id`. For `current sprint`, use the sprints whose `state` is `active`; for a sprint name, match on `name`. If exactly one matches, use its `id`. If several match, ask the user which one (name + ID). If none do, ask whether to continue in backlog or provide a sprint ID.

### 3. Build ADF JSON Payload

Write the payload to `<ACLI_TMP>/workitem-create.json`. Descriptions MUST use ADF JSON (not markdown) for rich formatting in Jira.

- `type`: `Story` unless the user specified another issue type.
- `parentIssueId`: omit when there is no parent.
- `additionalAttributes`: holds the sprint (`customfield_10007`, numeric sprint ID) and any other required custom fields. Omit `customfield_10007` when the sprint target is `backlog`. Set the sprint here — `acli jira workitem edit` cannot set custom fields after creation.

```json
{
  "projectKey": "<PROJECT_KEY>",
  "type": "Story",
  "summary": "[BE] (feat) - add report email digest system",
  "assignee": "@me",
  "parentIssueId": "<PARENT_KEY>",
  "additionalAttributes": {
    "customfield_10007": 1234
  },
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
        "content": [{ "type": "text", "text": "QA Steps" }]
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

### 4. Create the Ticket

```bash
acli jira workitem create --from-json "<ACLI_TMP>/workitem-create.json" --json
```

Record the created issue key from the output. Once a key exists, never run the create again — finish the remaining steps on that ticket. If the command times out or prints no key without a validation error, do not retry: run the duplicate check in [SKILL.md](../SKILL.md) Step 5.

### 5. Update Branch Id in Description (required)

Write `<ACLI_TMP>/workitem-edit.json` with the created key and the same `description` document you just sent, changing only the first heading from `Branch Id:` to `Branch Id: <ISSUE_KEY>`. Rebuild from the local payload rather than reading the description back, so nothing is lost in the round-trip.

```json
{
  "issues": ["<ISSUE_KEY>"],
  "description": { "type": "doc", "version": 1, "content": [ "...same nodes, with the Branch Id heading updated..." ] }
}
```

```bash
acli jira workitem edit --from-json "<ACLI_TMP>/workitem-edit.json" -y --json
```

If this edit fails, report the error and the issue key, and stop. Do not create another ticket.

### 6. Verify

```bash
acli jira workitem view <ISSUE_KEY> --json --fields summary,description,assignee,parent,customfield_10007
```

Confirm the Branch Id heading, assignee, parent (if one was requested), and sprint (if one was requested). acli cannot set `parent` or custom fields after creation, so if either is missing, tell the user which field to fix in Jira.

Report the issue key and `https://smartsensebydigi.atlassian.net/browse/<ISSUE_KEY>`.

### 7. Clean Up

Remove the temporary payloads after success:

```bash
rm -rf "<ACLI_TMP>"
```

## Editing an Existing Ticket

### Generate Edit Payload

```bash
acli jira workitem edit --generate-json
```

Fill in `issues` with the ticket key(s), modify the remaining fields, save it in a `mktemp -d` directory as above, then apply:

```bash
acli jira workitem edit --from-json "<ACLI_TMP>/workitem-edit.json" -y --json
```

The edit payload supports summary, description, assignee, type, and labels only — not parent or custom fields such as sprint.

## Transitioning Ticket Status

```bash
acli jira workitem transition --key "<ISSUE_KEY>" --status "In Progress" -y
```

## Inspecting All Fields (for custom fields)

```bash
acli jira workitem view <ISSUE_KEY> --json --fields "*all"
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
| Workspace check | `getAccessibleAtlassianResources` | `Site:` line of `acli jira auth status` |
| Creation | `createJiraIssue` | `acli jira workitem create --from-json` |
| Sprint | `editJiraIssue` after creation | `additionalAttributes.customfield_10007` at creation only |
| Parent | `parent` on create | `parentIssueId` on create only |
| Verification | `getJiraIssue` | `acli jira workitem view KEY --json` |
| Transitions | `transitionJiraIssue` | `acli jira workitem transition --key KEY` |
| Field inspection | `getJiraIssueTypeMetaWithFields` | `--fields "*all"` to discover custom fields |

## acli Command Quick Reference

| Action | Command |
|--------|---------|
| Check auth | `acli jira auth status` |
| Create ticket | `acli jira workitem create --from-json file.json --json` |
| Create (simple) | `acli jira workitem create --summary "Title" --project <PROJECT_KEY> --type Story` |
| Edit ticket | `acli jira workitem edit --from-json file.json -y --json` |
| View ticket | `acli jira workitem view KEY --json` |
| Transition | `acli jira workitem transition --key KEY --status "Status" -y` |
| Assign | `acli jira workitem assign --key KEY --assignee "@me" -y` |
| Search | `acli jira workitem search --jql "project = <PROJECT_KEY> AND status = Open"` |
| All fields | `acli jira workitem view KEY --json --fields "*all"` |
| Generate JSON | `acli jira workitem create --generate-json` |

## Safety Rules

- ALWAYS show the `acli` command preview before running it
- Use `-y` / `--yes` flag for mutating commands that prompt (edit, assign, transition)
- Verify with `view --json` after every mutation
- Store temporary JSON payloads in a per-run `mktemp -d` directory (never inside a repo, never shared between runs) and remove it after success
- `--description` / `--description-file` accept plain text or ADF but never render markdown. Use `--from-json` so the ADF description, assignee, parent, and custom fields go in one payload
- NEVER run `create` twice for the same ticket. Once a key exists, finish the remaining steps on that key
