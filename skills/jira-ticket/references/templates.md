# Ticket Description Templates

## Standard Ticket (Feature / Refactor / Chore / Maintenance)

```
## Branch Id:

## Merge Request

## Summary

{Clear, concise statement of the intended outcome in paragraph form}

## Technical Details

**Repo:** {repository_name}

**Data models or schema changes:** {Description or None}

**Feature flags:** {Flag names or None}

**Performance/security considerations:**

- {Bullet point if applicable}
- {Or write "None"}

**Assumptions or constraints:**

- {Bullet point if applicable}
- {Or write "None"}

## Acceptance Criteria:

{Clear description of what must be true for this ticket to be considered done. Paragraph form or bulleted list.}

- {Criterion 1}
- {Criterion 2}

## Test Plan

**Prerequisites:** {What is needed before testing can begin — hardware (e.g. specific device, sensor, peripheral), other software, environment state, test data, or accounts. "None" if not applicable.}

**How to verify:** {The testing flow that proves each acceptance criterion is met — navigate to X, perform Y, confirm Z. One flow per AC if they differ.}

**Automated tests:** {Unit or integration tests to be written — or "None"}
```

## Bug Ticket

Same as standard but includes a QA Testing Steps section before Acceptance Criteria:

```
## Branch Id:

## Merge Request

## Summary

{Clear description of the bug and its impact}

## Technical Details

**Repo:** {repository_name}

**Data models or schema changes:** {Description or None}

**Feature flags:** {Flag names or None}

**Performance/security considerations:**

- {Any relevant considerations}
- {Or write "None"}

**Assumptions or constraints:**

- {Any assumptions}
- {Or write "None"}

## QA Testing Steps

**Environment:** {Dev/Staging/Production}

**Steps:**

- {Step 1 to reproduce}
- {Step 2 to reproduce}

**Observed Result:** {What actually happens}

**Expected Result:** {What should happen}

## Acceptance Criteria:

{What must be true for the bug to be considered fixed}

- {Criterion 1}
- {Criterion 2}

## Test Plan

**Prerequisites:** {What is needed before testing can begin — hardware, software, environment state, test data, or accounts. "None" if not applicable.}

**How to verify:** {The testing flow that confirms the fix — perform repro steps, confirm the error is gone, check adjacent flows for regressions.}

**Automated tests:** {Unit or integration tests to be written to prevent regression — or "None"}
```

## Formatting Rules

- Use `##` (H2) for all main section headers
- Business Context sub-items: bold question with answer on same line
- Technical Details sub-items: bold label with colon, answer on same line
- Acceptance Criteria: paragraph or bulleted list (no checkboxes)
- Leave "Merge Request" empty during creation
- Keep "Branch Id:" empty in the preview template, then auto-update it to the Jira issue key immediately after creation
- For maintenance tickets, Business Context can note: "This is a maintenance/technical debt item"

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

## Business Context

**Why are we doing this?** Content group admins need the ability to set up automated email digests for follow-up action reports, which currently requires manual intervention.

**Who is affected?** Content group admins managing audit and follow-up action workflows.

**What happens if we don't fix/build this?** Admins cannot configure automated report delivery, increasing manual overhead for report distribution.

**Link to design docs:** N/A

## Technical Details

**Repo:** api

**Data models or schema changes:** Uses existing ReportEmailDigest, ReportEmailDigestSchedule, and ListTemplateHasReportEmailDigest tables (migration already complete).

**Feature flags:** None

**Performance/security considerations:**

- Uses DataLoader for batched connector queries
- Sequential DB inserts (for-await) due to lack of connection pool

**Assumptions or constraints:**

- Content group mode only (not location mode)
- Requires existing audit template linked to a follow-up action template

## Acceptance Criteria:

- Content group admins can create report email digest configurations via the createFollowUpActionReportEmailDigest mutation
- Each configuration links a FUALT to a role, report type (FUA_SITE, FUA_AUDITOR, FUA_SUMMARY), and frequency schedule
- Duplicate configurations for the same list template and report type are rejected
- Non-admin users receive a permission error
- The reportEmailDigests field on ListTemplate returns all configured digests with nested frequencies
```
