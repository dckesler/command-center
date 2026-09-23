# Ticket Description Templates

Human-facing sections come first (Branch Id through Test Cases). Implementation Details is last and is written for agents.

**Test Plan** is required at ticket creation. It must show the work is testable: prerequisites, the flow that proves each AC, and what automated tests will be written.

**Test Cases** are the steps a QA engineer runs once the MR is ready to verify. This is the same section as "QA Testing Steps" / "QA Steps" — always use the heading `## Test Cases`. Do not add a second QA section.

## Standard Ticket (Feature / Refactor / Chore / Maintenance)

```
## Branch Id:

## Merge Request

## Summary

{Clear, concise statement of the intended outcome in paragraph form}

## Acceptance Criteria:

{Clear description of what must be true for this ticket to be considered done. Paragraph form or bulleted list.}

- {Criterion 1}
- {Criterion 2}

## Test Plan

**Prerequisites:** {What is needed before testing can begin — hardware (e.g. specific device, sensor, peripheral), other software, environment state, test data, or accounts. "None" if not applicable.}

**How to verify:** {The testing flow that proves each acceptance criterion can be tested — navigate to X, perform Y, confirm Z. One flow per AC if they differ. Written at ticket creation, before coding.}

**Automated tests:** {Unit or integration tests to be written — or "None"}

## Test Cases

{Steps a QA engineer runs once the MR is ready. Concrete navigation and checks, including at least one regression check when a nearby flow could break. Not a restatement of the ACs.}

- {Navigate to ...}
- {Perform the action that exercises the change}
- {Confirm the expected result}
- {Regression: related flow still works — or write "None"}

## Implementation Details

**Repo:** {repository_name}

**Data models or schema changes:** {Description or None}

**Feature flags:** {Flag names or None}

**Performance/security considerations:**

- {Bullet point if applicable}
- {Or write "None"}

**Assumptions or constraints:**

- {Bullet point if applicable}
- {Or write "None"}

**Agent implementation instructions:**

- {Concrete approach, files, constraints, or "do not" notes for an agent implementing this ticket}
- {Or write "None"}
```

## Bug Ticket

Same section order as standard. Put environment, observed result, and expected result in Summary. There is no separate QA Testing Steps section — use Test Cases.

```
## Branch Id:

## Merge Request

## Summary

{Clear description of the bug and its impact}

**Environment:** {Dev/Staging/Production}

**Observed Result:** {What actually happens}

**Expected Result:** {What should happen}

## Acceptance Criteria:

{What must be true for the bug to be considered fixed}

- {Criterion 1}
- {Criterion 2}

## Test Plan

**Prerequisites:** {What is needed before testing can begin — hardware, software, environment state, test data, or accounts. "None" if not applicable.}

**How to verify:** {The testing flow that confirms the fix can be verified — perform the repro path, confirm the error is gone, check adjacent flows for regressions. Written at ticket creation.}

**Automated tests:** {Unit or integration tests to be written to prevent regression — or "None"}

## Test Cases

- {Perform the original repro path}
- {Confirm the expected result — the bug no longer occurs}
- {Check adjacent flows for regressions}

## Implementation Details

**Repo:** {repository_name}

**Data models or schema changes:** {Description or None}

**Feature flags:** {Flag names or None}

**Performance/security considerations:**

- {Any relevant considerations}
- {Or write "None"}

**Assumptions or constraints:**

- {Any assumptions}
- {Or write "None"}

**Agent implementation instructions:**

- {Concrete approach, files, constraints, or "do not" notes for an agent implementing this ticket}
- {Or write "None"}
```

## Formatting Rules

- Use `##` (H2) for all main section headers
- Human sections stay above Implementation Details: Branch Id, Merge Request, Summary, Acceptance Criteria, Test Plan, Test Cases
- Implementation Details is agent-facing. Sub-items: bold label with colon, answer on the same line
- When writing ADF (acli), emit Implementation Details as a collapsed `expand` node titled `Implementation Details`. When writing markdown (MCP), use `## Implementation Details` — MCP markdown does not reliably produce expand nodes
- Acceptance Criteria: paragraph or bulleted list (no checkboxes)
- Leave "Merge Request" empty during creation
- Keep "Branch Id:" empty in the preview template, then auto-update it to the Jira issue key immediately after creation
- Do not create a Business Context or Technical Details section. Fold any existing "why" into Summary; map old Technical Details into Implementation Details
- Always use `## Test Cases` (never "QA Steps", "QA Testing Steps", or "Repro Steps")

## Platform Detection

| Keyword in context | Platform |
|--------------------|----------|
| migrations, graphql, nodejs, worker, php, database, API, server-side, backend | `[BE]` |
| style, design, Cypress, components, UI/UX, React, styling, frontend | `[FE]` |
| sensors, mobile, app, device | `[MB]` |

## Conventional Commit Types

| Ticket Type | Conventional Type | Example Title |
|-------------|------------------|---------------|
| New feature | `feat` | `[BE] (feat) - add report email digest system` |
| Bug fix | `fix` | `[FE] (fix) - resolve button styling in dashboard` |
| Refactor | `refactor` | `[BE] (refactor) - optimize sort order update query` |
| Maintenance / chore | `chore` | `[BE] (chore) - upgrade lodash dependency` |
| Performance | `perf` | `[BE] (perf) - batch sensor readings insert` |
| Documentation | `docs` | `[BE] (docs) - add API endpoint documentation` |
| Tests | `test` | `[BE] (test) - add Jest tests for report digest mutation` |

## Example: Complete Backend Feature Ticket

**Title:** `[BE] (feat) - add report email digest configuration for follow-up actions`

**Description:**

```
## Branch Id:

## Merge Request

## Summary

Implement a new GraphQL mutation and type resolvers to allow content group admins to configure email digest reports for Follow Up Action List Templates. This enables automated email notifications for FUA reports (site, auditor, and summary types) at configurable frequencies.

## Acceptance Criteria:

- Content group admins can create report email digest configurations via the createFollowUpActionReportEmailDigest mutation
- Each configuration links a FUALT to a role, report type (FUA_SITE, FUA_AUDITOR, FUA_SUMMARY), and frequency schedule
- Duplicate configurations for the same list template and report type are rejected
- Non-admin users receive a permission error
- The reportEmailDigests field on ListTemplate returns all configured digests with nested frequencies

## Test Plan

**Prerequisites:** A content group with an audit template linked to a follow-up action template, plus an admin and a non-admin account.

**How to verify:** Create a digest via the mutation and confirm it appears on the template; retry a duplicate and confirm rejection; call the same mutation as a non-admin and confirm a permission error.

**Automated tests:** Unit/integration tests for createFollowUpActionReportEmailDigest (happy path, duplicate, permission) and for reportEmailDigests on ListTemplate.

## Test Cases

- Log in as a content group admin and open an audit template linked to a follow-up action template
- Configure a report email digest for a FUA report type with a frequency, save, and confirm it appears with the correct frequency
- Attempt a duplicate digest for the same report type and confirm it is rejected
- Log in as a non-admin and confirm digest configuration is unavailable / returns a permission error
- Confirm unrelated audit template settings still load and save

## Implementation Details

**Repo:** api

**Data models or schema changes:** Uses existing ReportEmailDigest, ReportEmailDigestSchedule, and ListTemplateHasReportEmailDigest tables (migration already complete).

**Feature flags:** None

**Performance/security considerations:**

- Uses DataLoader for batched connector queries
- Sequential DB inserts (for-await) due to lack of connection pool

**Assumptions or constraints:**

- Content group mode only (not location mode)
- Requires existing audit template linked to a follow-up action template

**Agent implementation instructions:**

- Add createFollowUpActionReportEmailDigest and the ListTemplate.reportEmailDigests field using existing digest connectors
- Reject duplicate list-template + report-type pairs; enforce content-group admin permission
- Do not add a new migration
```
