---
name: lists-fe-qa-steps
description: Generate formatted QA testing steps for frontend changes in the lists monorepo. Use when asked to write QA steps, testing steps, or QA instructions for a Jira ticket. Analyzes the current branch diff or a Jira ticket to identify which workspace(s) in the lists monorepo are affected, then produces ready-to-paste steps in the team's standard format. Handles shared library changes, multi-workspace impact, and optionally updates the Jira ticket via MCP.
---

# Lists FE QA Steps Skill

Generate structured QA testing steps for frontend changes in the `lists` monorepo. Steps follow the team's standard format and are ready to paste into a Jira ticket description.

## Monorepo Context

The `lists` repo is a federated-module monorepo. Each workspace builds an independent bundle deployed to a CDN. Local development uses the **Requestly** browser extension to redirect CDN URLs to localhost.

Workspace details (ports, Requestly rules, routes) are in [references/workspaces.md](references/workspaces.md).

## Prerequisites (assumed of the tester)

The QA steps this skill produces assume the tester has the following set up. The skill does not verify them — surface this list to the user if they look new to the workflow:

- **`lists` repo cloned** locally with `npm install` run from the root.
- **Requestly browser extension** installed and signed in, with the team's shared rule workspace synced.
- **Atlassian access** to the SmartSense Jira workspace (cloud ID `3be885af-99d6-4514-939e-3c99560b10eb`). The Atlassian MCP must be configured for any ticket-update step.
- **A test environment login** for the SmartSense web app (typically staging — confirm with the user if unsure which environment to QA against).

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

For each affected workspace:

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

### Step 5: Analyze the Change and Infer Navigation

Read the changed file paths and any context (ticket summary, component names, route files) to determine:

- **Which page or feature** was changed (e.g., "settings modal", "template builder", "grid view")
- **The navigation path** to reach it from the app's home

Use these signals:
- File name (e.g., `SettingsModal.tsx` → navigate to settings)
- Directory path (e.g., `src/pages/TemplateBuilder/` → navigate to template builder)
- Route file changes (read the file to extract the URL path; route definitions usually live in `<workspace>/src/routes.js` or `<workspace>/src/router.js`)
- Ticket summary / description (often names the page directly)
- The **Navigation Reference** table in [references/workspaces.md](references/workspaces.md) — has canonical UI paths for the most common feature areas (audit lists, templates, grids, etc.). Consult this before guessing.

If the change's location in the UI is ambiguous, note this in the steps and ask the user to confirm the navigation path before finalizing.

### Step 6: Generate and Present QA Steps

Format the steps exactly as follows, then present them to the user:

```
QA Steps:

* Repo: lists/<workspace>
  * Command: `npm start`
  * Requestly rule: <Rule Name>

* <Navigation step 1>
* <Navigation step 2>
* ...
* <Verification step>
```

**Rules for the steps block:**
- List navigation steps in the order a tester would follow them top-to-bottom in the UI
- End with one or more **verification steps** that confirm the changed behavior (e.g., "Verify the tooltip appears", "Confirm the field is disabled")
- Keep each step as a single, plain-English action — no code or technical jargon
- If multiple workspaces are affected, produce a separate `* Repo: ...` block for each
- For `lists-web`, the Command must read `cd <lists-repo> && npm start` (not `cd <lists-repo>/lists-web && npm start`) since it runs the relay compiler from the repo root

After presenting, ask:
> "Should I add these QA steps to the Jira ticket?"

If the user confirms and provides (or you already have) a ticket key, update the ticket via the Atlassian MCP:

1. Call `getJiraIssue` (cloud ID `3be885af-99d6-4514-939e-3c99560b10eb`) with `responseContentFormat: "markdown"` to fetch the **current description**.
2. Concatenate: `<existing description>\n\n<QA steps block>`. If the existing description is empty, use only the QA steps block.
3. Call `editJiraIssue` with the full concatenated string as the new description (`contentFormat: "markdown"`).

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
- ALWAYS include the Requestly rule — it is required for local testing
- ALWAYS end the steps with at least one explicit verification step
- When a workspace needs multiple Requestly rules, include ALL of them
- Do NOT add technical implementation details to the step bullets — steps must be readable by non-engineers
- If the navigation path cannot be confidently inferred, flag it and ask the user rather than guessing
- NEVER update a Jira ticket without showing the steps preview and receiving explicit confirmation
- NEVER overwrite the existing ticket description — always fetch the current description first and append the QA steps after it

## Reference Files

- **Workspace ports, Requestly rules, and routes**: [references/workspaces.md](references/workspaces.md)
- **MCP workflow for Jira updates**: [../jira-ticket/references/mcp-workflow.md](../jira-ticket/references/mcp-workflow.md)
