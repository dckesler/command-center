# Ticket Description Templates

Human-facing sections come first (Branch Id through QA Steps). Implementation Details is last and is written for agents.

**Test Plan** is required at ticket creation. It must show the work is testable: prerequisites, test type (manual / automated / both), the flow that proves each AC, and which automated tests will be written or updated. Keep it to a few lines.

**QA Steps** are the steps a QA engineer runs on staging once the MR is ready to verify. This is the same section as "QA Testing Steps" / "Test Cases" — always use the heading `## QA Steps`. Do not add a second QA section. The first item is always `**Preconditions:**`. Both sections must pass [qa-steps-checklist.md](qa-steps-checklist.md).

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

**Test type:** {manual / automated / both}

**How to verify:** {The testing flow that proves each acceptance criterion can be tested — navigate to X, perform Y, confirm Z. One flow per AC if they differ. Written at ticket creation, before coding. A few lines, not the ticket's history.}

**Automated tests:** {The test files or suites to be written or updated, named — or "None". Never "existing tests should pass" without naming them or "the CI pipeline".}

## QA Steps

{Steps a QA engineer runs on staging, through the UI, once the MR is ready. Concrete navigation and checks, including at least one regression check when a nearby flow could break. Not a restatement of the ACs. Each step names the surface (web / mobile) and the object. No localhost, console, API or database steps — if a check needs backend access, write "Dev-assisted: <who> verifies <what> with QA".}

- **Preconditions:** {Dev flags, feature flags, hardware, account/role, test data that must exist — or "None". Always the first item; never put a flag in a later step.}
- {TestRail: C<id>, C<id> — only the cases that must run for this ticket, or omit the line. Do not repeat their steps below.}
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

Same section order as standard. Put environment, observed result, and expected result in Summary. There is no separate QA Testing Steps section — use QA Steps.

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

**Test type:** {manual / automated / both}

**How to verify:** {The testing flow that confirms the fix can be verified — perform the repro path, confirm the error is gone, check adjacent flows for regressions. Written at ticket creation. A few lines.}

**Automated tests:** {The regression test files or suites to be written or updated, named — or "None"}

## QA Steps

- **Preconditions:** {Dev flags, feature flags, hardware, account/role, test data needed to reproduce — or "None". Always first.}
- {Perform the original repro path on staging, naming the app, page and object}
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
- Human sections stay above Implementation Details: Branch Id, Merge Request, Summary, Acceptance Criteria, Test Plan, QA Steps
- Implementation Details is agent-facing. Sub-items: bold label with colon, answer on the same line
- When writing ADF (acli), emit Implementation Details as a collapsed `expand` node titled `Implementation Details`. When writing markdown (MCP), use `## Implementation Details` — MCP markdown does not reliably produce expand nodes
- Acceptance Criteria: paragraph or bulleted list (no checkboxes)
- Leave "Merge Request" empty during creation
- Keep "Branch Id:" empty in the preview template, then auto-update it to the Jira issue key immediately after creation
- Do not create a Business Context or Technical Details section. Fold any existing "why" into Summary; map old Technical Details into Implementation Details
- Always use `## QA Steps` (never "Test Cases", "QA Testing Steps", or "Repro Steps")
- `## QA Steps` always starts with a `**Preconditions:**` item. Any feature flag named under Implementation Details is repeated there — QA does not read Implementation Details
- Test Plan and QA Steps must pass [qa-steps-checklist.md](qa-steps-checklist.md) before the preview is shown

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

**Prerequisites:** A staging content group with an audit template linked to a follow-up action template, plus an admin and a non-admin account.

**Test type:** both

**How to verify:** Create a digest and confirm it appears on the template; retry a duplicate and confirm rejection; try as a non-admin and confirm it is refused.

**Automated tests:** `test/mutations/createFollowUpActionReportEmailDigest.test.ts` (happy path, duplicate, permission) and `test/types/ListTemplate.reportEmailDigests.test.ts`.

## QA Steps

- **Preconditions:** Staging; content group admin account and a non-admin account in the same content group; an audit template that is linked to a follow-up action template. No feature flag.
- On the web app, log in as the content group admin and go to Audits & Inspections → Templates → open the linked audit template → Settings
- In the Report Email Digests section, add a digest for the "FUA Site" report type with a weekly frequency and save
- Confirm the digest appears in the list with report type "FUA Site" and frequency "Weekly"
- Add a second digest for "FUA Site" and confirm the save is rejected with a duplicate error
- Log out, log in as the non-admin, open the same template's Settings and confirm the Report Email Digests section is not editable
- Regression: change and save an unrelated setting on the same template and confirm it persists after reload

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
