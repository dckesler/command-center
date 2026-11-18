---
name: lists-fe-qa-steps
description: Generate formatted QA testing steps for frontend changes in the lists monorepo. Use when asked to write QA steps, testing steps, or QA instructions for a Jira ticket. Analyzes the current branch diff or a Jira ticket to identify which workspace(s) in the lists monorepo are affected, then produces QA steps QA can run on staging through the UI (Preconditions first), plus a separate local-dev block (workspace, npm start, Requestly rule) for developers. Handles shared library changes, multi-workspace impact, and optionally updates the Jira ticket via MCP.
---

# Lists FE QA Steps Skill

Generate structured QA testing steps for frontend changes in the `lists` monorepo. The output has two parts:

1. **QA Steps** — what goes on the Jira ticket. Written for QA, who tests on **staging** through the UI, has no database access and does not run anything locally. Starts with Preconditions. Must pass the shared [QA steps checklist](../jira-ticket/references/qa-steps-checklist.md).
2. **Local dev check** — the workspace, start command and Requestly rule a developer needs to verify the same flow against localhost. Shown in chat for the developer; not written to the ticket's QA Steps (see Step 6).

## Monorepo Context

The `lists` repo is a federated-module monorepo. Each workspace builds an independent bundle deployed to a CDN. Local development uses the **Requestly** browser extension to redirect CDN URLs to localhost.

Workspace details (ports, Requestly rules, routes) are in [references/workspaces.md](references/workspaces.md).

## Prerequisites

**QA** (the audience of the QA Steps) needs only a staging login for the SmartSense web app (`app.joltstage.com`) with the role the feature requires. Unless the ticket says otherwise, QA tests on staging — never assume localhost, Requestly, devtools or database access.

**The developer** running the local dev check needs:

- **`lists` repo cloned** locally with `npm install` run from the root.
- **Requestly browser extension** installed and signed in, with the team's shared rule workspace synced.
- **Atlassian access** to the SmartSense Jira workspace (cloud ID `3be885af-99d6-4514-939e-3c99560b10eb`). The Atlassian MCP must be configured for any ticket-update step.

## Flags

- **`--no-update`** — changes the Step 6 update behavior: if the ticket already had QA steps in its description, show them and stop — do not offer to add or update anything. Only offer to add steps if none existed on the ticket (i.e., they were generated fresh from the diff). See Step 6 for details.

## Workflow

### Step 1: Gather Context

Use **all available signals** — they complement each other (Jira describes intent, the diff shows concrete files, the user fills in nuance):

1. **Jira ticket URL** — if provided, fetch via Atlassian MCP (`getJiraIssue`, cloud ID `3be885af-99d6-4514-939e-3c99560b10eb`). Read the Summary and Description.
2. **Current branch diff** — run `git diff main...HEAD --name-only` in the `lists` repo to get the changed files. (`main` is the trunk for this repo.)
3. **User description** — any plain-language context the user has given.

If none of the above is available, ask: "What changed? You can paste a Jira ticket URL, describe the change, or I can read your current branch diff."

### Step 2: Identify Affected Workspace(s)

Map every changed file path to its workspace directory. File paths are relative to the `lists` repo root.

**First, filter out paths that don't need QA.** If the *entire* diff falls into these buckets, report "no QA needed" and stop:

- Test-only files: `*.test.ts`, `*.test.tsx`, `*.test.js`, `*.spec.*`, `__tests__/`, `__mocks__/`, `__snapshots__/`
- Storybook config: `.storybook/` (Storybook *stories* under `src/` may still need QA — only the config dir is excluded)
- Docs and root configs: `*.md`, `package.json`, `tsconfig*.json`, lockfiles, `babel.config.*`, `biome.json`, `prettier.config.*`
- Non-QA workspaces (see [references/workspaces.md](references/workspaces.md) → "Non-QA Workspaces"): `lists-files/`, `integration-tests/`

If the diff has a *mix* of QA-relevant and excluded files, ignore the excluded ones and proceed with the rest.

Then map remaining paths:

- If the path starts with `<workspace-name>/src/...` → that workspace is directly affected.
- If the path is in a **shared library** (`lists-web-components/`, `lists-web-data-components/`, `lists-core/`, `lists-hooks/`, `template-and-instance-management/`, `shared-dev-utils/`) → see [Shared Library Changes](#shared-library-changes) below.

For each affected workspace, look up its entry in [references/workspaces.md](references/workspaces.md).

### Step 3: Resolve Requestly Rule(s)

Steps 3 and 4 feed the **local dev check** block only. For each affected workspace:

1. Check [references/workspaces.md](references/workspaces.md) for a known rule name.
2. If the rule is listed as **"check file"**, read the workspace's `requestly_rules.json` or `requestly_rules.txt` and extract all `"name"` values.
3. If no requestly file exists for that workspace, note it as: `Requestly rule: (set up redirect from CDN to http://localhost:<port>/bundle.js)`.

Some workspaces require **two rules** to be enabled simultaneously (e.g., `work-orders` needs both "Work Orders" and "Lists Repo"). Include all required rules.

### Step 4: Determine the Start Command

For most workspaces the command is:

```
cd <lists-repo>/<workspace>
npm start
```

Exception: If the workspace's `package.json` start script requires running from the repo **root** (e.g., `lists-web` which also runs the relay compiler), note the repo root instead:

```
cd <lists-repo>
npm start
```

Check [references/workspaces.md](references/workspaces.md) for the correct start location per workspace.

### Step 5: Analyze the Change, Infer Navigation and Preconditions

Read the changed file paths and any context (ticket summary, component names, route files) to determine:

- **Which page or feature** was changed (e.g., "settings modal", "template builder", "grid view")
- **The navigation path** to reach it from the app's home
- **Preconditions** QA must have before step one:
  - **Feature flags / dev flags** — grep the diff and the touched components for flag checks (e.g. `useFeatureFlag`, `isFeatureEnabled`, `flags.`, LaunchDarkly keys) and read the ticket's Implementation Details → Feature flags. Name every flag that gates the change and the value it needs.
  - **Role / permissions** — admin vs. member, content-group vs. location mode, if the UI differs.
  - **Data that must exist** — e.g. "a template with at least one camera item", "an audit list with a completed instance". Say how to create it in the UI if it may not exist on staging.
  - **Hardware** — only for mobile or device-paired flows.
- **Ambiguous actions** — any verb that can mean more than one thing in this app ("upload a photo", "open the item", "add a tag") must be pinned to one surface and object (which page, which item type, web vs. mobile). Resolve from the diff; if you cannot, ask the user — do not leave the step vague.

Use these signals:
- File name (e.g., `SettingsModal.tsx` → navigate to settings)
- Directory path (e.g., `src/pages/TemplateBuilder/` → navigate to template builder)
- Route file changes (read the file to extract the URL path; route definitions usually live in `<workspace>/src/routes.js` or `<workspace>/src/router.js`)
- Ticket summary / description (often names the page directly)
- The **Navigation Reference** table in [references/workspaces.md](references/workspaces.md) — has canonical UI paths for the most common feature areas (audit lists, templates, grids, etc.). Consult this before guessing.

If the change's location in the UI is ambiguous, note this in the steps and ask the user to confirm the navigation path before finalizing.

### Step 6: Generate and Present QA Steps

Format the output exactly as follows, then present it to the user:

```
QA Steps:

* Preconditions: <staging; role/account; data that must exist; feature flags and their values; hardware — or "None">
* <Navigation step 1 — name the app and page>
* <Navigation step 2>
* ...
* <Verification step>
* Regression: <nearby flow that could break — or "None">

Local dev check (for the developer, not QA):

* Repo: lists/<workspace>
  * Command: `npm start`
  * Requestly rule: <Rule Name>
* Run the same QA Steps against localhost
```

**Rules for the QA Steps block:**
- `Preconditions` is always the first bullet. Flags, role, data and hardware go there and nowhere else — QA runs the steps top to bottom and does not read ahead
- Every step is runnable on **staging through the UI**. No `npm`, Requestly, localhost, devtools/console, API or GraphQL calls, SQL, or "check the db". If a result is only visible in the database, write `Dev-assisted: <who> verifies <what> with QA` instead
- Every step names the surface and the object: which page, which item or template type, web vs. mobile. No step a tester could read two ways
- List navigation steps in the order a tester would follow them top-to-bottom in the UI, one action per step
- End with one or more **verification steps** that confirm the changed behavior (e.g., "Verify the tooltip appears", "Confirm the field is disabled"), then one `Regression:` bullet
- Keep each step as a single, plain-English action — no code, component names or technical jargon; refer to UI by its visible label
- Do not restate the acceptance criteria
- If the ticket links TestRail cases, do not repeat their steps — cover only what they don't
- Run the [QA steps checklist](../jira-ticket/references/qa-steps-checklist.md) before presenting

**Rules for the local dev block:**
- If multiple workspaces are affected, produce a separate `* Repo: ...` entry for each (and, if the flows differ, a separate QA Steps block per workspace)
- For `lists-web`, the Command must read `cd <lists-repo> && npm start` (not `cd <lists-repo>/lists-web && npm start`) since it runs the relay compiler from the repo root

After presenting, ask:
> "Should I add the QA steps to the Jira ticket?"

If the user confirms and provides (or you already have) a ticket key, update the ticket via the Atlassian MCP:

1. Call `getJiraIssue` (cloud ID `3be885af-99d6-4514-939e-3c99560b10eb`) with `responseContentFormat: "markdown"` to fetch the **current description**.
2. Build the ticket section: a `## QA Steps` heading followed by the **QA Steps bullets only**. The local dev block is for the developer and would be steps QA cannot run; leave it out unless the user explicitly asks for it, in which case add it under Implementation Details, never inside QA Steps.
3. If the description already has a `## QA Steps` section, replace its bullets; otherwise append the section after `## Test Plan` if present, else at the end.
4. Call `editJiraIssue` with the full updated description (`contentFormat: "markdown"`).

Never pass only the QA steps as the description — always preserve whatever content was already there.

## Shared Library Changes

When changes are in a shared library, the skill must determine **which app workspaces surface the changed component**:

1. **Grep or read** the changed component name across all workspace `src/` directories to find consumers.
2. Pick the **most representative workspace** (the one where the component is most prominently used or easiest to reach for a tester) for the primary QA steps block.
3. If the component appears in more than one workspace with distinct flows, generate separate blocks for each.

Shared libraries:
- `lists-web-components/` → UI primitives used across all apps (Storybook on port 6006)
- `lists-web-data-components/` → data-connected UI components used across all apps (Storybook on port 6006 — collides with `lists-web-components`, run one at a time)
- `lists-core/` → business logic (no direct UI — infer affected workspaces from calling code)
- `lists-hooks/` → React hooks (no direct UI — infer affected workspaces from calling code)
- `template-and-instance-management/` → shared template/instance logic consumed by `lists-web`, `work-orders`, `asset-management`, and `audit-lists`
- `shared-dev-utils/` → dev-only utilities (no UI — usually no QA needed; flag if a runtime path uses it)

## Critical Rules

- NEVER generate QA steps without first identifying the correct workspace
- ALWAYS start QA Steps with a `Preconditions` bullet (flags, role, data, hardware — or "None"); never put a flag in a later step
- ALWAYS write QA Steps that QA can run on staging through the UI — no localhost, Requestly, console, API or database steps; mark backend-only checks `Dev-assisted`
- ALWAYS include the Requestly rule in the local dev block — it is required for local testing
- ALWAYS end the steps with at least one explicit verification step and a `Regression:` bullet
- When a workspace needs multiple Requestly rules, include ALL of them
- Do NOT add technical implementation details to the step bullets — steps must be readable by non-engineers
- If the navigation path or an action's surface/object cannot be confidently inferred, flag it and ask the user rather than guessing or leaving the step vague
- NEVER update a Jira ticket without showing the steps preview and receiving explicit confirmation
- NEVER overwrite the existing ticket description — always fetch the current description first and append the QA steps after it

## Reference Files

- **Workspace ports, Requestly rules, and routes**: [references/workspaces.md](references/workspaces.md)
- **Test Plan / QA Steps checklist (QA's guidance)**: [../jira-ticket/references/qa-steps-checklist.md](../jira-ticket/references/qa-steps-checklist.md)
- **MCP workflow for Jira updates**: [../jira-ticket/references/mcp-workflow.md](../jira-ticket/references/mcp-workflow.md)
