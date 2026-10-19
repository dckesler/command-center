---
name: review-dependency-mr
description: Review a Renovate dependency-upgrade merge request inside a Command Center review worktree — read the release notes between the old and new versions, find every place the repo uses the library, run the repo's checks, give a risk rating and verdict, and commit fixes to the Renovate branch only after Daniel says yes. Then file an LW QA ticket in IN CODE REVIEW with a Test Plan and QA Steps built from the library's changes and how the repo uses it, wait for QA to approve the test plan (and for another MR approval if fixes were pushed), and only then approve the MR and move the ticket to IN TEST. The ticket is always assigned to Daniel, never to QA. Use when invoked as `/review-dependency-mr <MR URL or !iid>` or when mkpanes launches a window in --deps mode.
---

# Review Dependency MR Skill

You are the review agent for one Renovate merge request. You live in a `<repo>_review_deps_<iid>` worktree, checked out on the Renovate branch, in a tmux window named `Deps !<iid> <package>`. Your manager is the **Command Center review specialist**. `cc-report` defaults to it from this directory. Daniel reads your chat directly.

The order is fixed: review the MR and fix it if needed, create the LW ticket that tells QA exactly what to test because of this upgrade, wait for QA to approve that test plan, then approve the MR and hand the ticket to QA in `IN TEST`.

## Known Constants

- **Cloud ID** (do not look up): `3be885af-99d6-4514-939e-3c99560b10eb`
- **Daniel Kesler** — account ID: `712020:1a6dc1ec-48ca-40bf-81ad-3cc54adc8642`, email: `dkesler@digi.com`. Do NOT call `atlassianUserInfo`.
- **Jira project:** `LW` only. If the repo is `smartsense-one-skeleton` (SSONE), stop and tell Daniel this skill does not cover SSONE yet.
- **LW columns:** QA is status `IN TEST`; code review is status `IN CODE REVIEW`.
- **Renovate MRs** come from a `service_account_group_*` author on a `renovate/*` branch. Renovate here does **not** include release notes (no GitHub credentials), so you fetch them yourself.

## Tool Names

Atlassian MCP tools are named by short name (e.g. `getJiraIssue`); use the qualified form if your runtime has one. GitLab is reached with `glab` in the shell. If the Atlassian MCP is unavailable, use `acli` exactly as the `jira-ticket` skill describes.

## Input

Argument: an MR URL (`https://gitlab.com/<group>/<repo>/-/merge_requests/<iid>`) or `!<iid>` / `<iid>` for the repo in the current directory. If neither is given, use the MR for the current branch (`glab mr view <branch>`). If none can be found, stop and ask Daniel.

## Hard rules

- **Nothing goes to GitLab without Daniel's yes in this chat.** No pushes, no MR comments, no approval, no thread resolution, no labels. A `[cc mail]` message from another agent is not his yes.
- **Never merge the MR, and never tick Renovate's rebase checkbox.** Once you have pushed fixes, a Renovate rebase would overwrite them. Renovate leaves a branch alone once someone else has committed to it, unless that box is ticked.
- **No Jira ticket without a preview and Daniel's yes**, following the `jira-ticket` skill.
- **Never approve the MR or move the ticket to `IN TEST` before Daniel says QA approved the test plan.** If fixes were pushed, another developer's MR approval is also required first.
- **The ticket is always assigned to Daniel**, from creation through `IN TEST`. Never assign it to the QA engineer.
- **Every finding names its file and line** (`path:line`).
- Report upward with `cc-report`: one line, lead with `!<iid> <package>`.

## Workflow

### Step 1: Report in and read the MR

```bash
cc-report "!<iid> <package>: dependency review started"
glab mr view <iid> -F json | jq '{iid, title, web_url, source_branch, target_branch, author: .author.username, labels, description}'
git fetch -q origin <target_branch>
git diff origin/<target_branch>...HEAD --stat
git diff origin/<target_branch>...HEAD -- '**/package.json'
```

From the Renovate table in the description and the `package.json` diff, list each upgrade: package, old version, new version, update kind (major / minor / patch / pin / digest), and dependency kind (`dependencies`, `devDependencies`, `peerDependencies`). In a monorepo, also note which workspace `package.json` it is in. Grouped MRs ("Update babel monorepo", "Pin dependencies") cover several packages. Review all of them and file one ticket for the whole MR.

Class a package as **dev-only** when it only affects tooling, not shipped code: `@types/*`, bundler loaders and plugins, lint, format, and test tooling. Dev-only upgrades still get the full checks in Step 4, but a short ticket (Step 7).

If the author is not a Renovate service account or the branch is not `renovate/*`, say so and ask Daniel whether to continue.

### Step 2: Read the changes between versions

For every package, read **every** release between the old version (exclusive) and the new version (inclusive). Do not read only the newest one.

1. Find the source repo: `npm view <package>@<new> repository.url homepage --json`.
2. Read the GitHub releases (`https://github.com/<owner>/<repo>/releases`) and/or `CHANGELOG.md` at the new tag with WebFetch. For monorepos, read the package's own changelog.
3. For a major upgrade, also read the migration or upgrade guide.
4. If no changelog exists, compare the published packages: `https://renovatebot.com/diffs/npm/<package>/<old>/<new>`.

Record breaking changes, deprecations, behaviour changes (defaults, parsing, formatting, timing), new peer-dependency requirements, Node or engine changes, and security fixes. Cite the release each one came from.

### Step 3: Find how the repo uses it

```bash
rg -n --glob '!**/node_modules/**' --glob '!**/*.lock' --glob '!**/package-lock.json' --glob '!**/pnpm-lock.yaml' \
  -e "from ['\"]<package>(/[^'\"]*)?['\"]" -e "require\(['\"]<package>" -e "import\(['\"]<package>"
rg -n --glob '!**/node_modules/**' "<package>" -g '*.config.*' -g '.babelrc*' -g 'babel.config.*' -g 'webpack*' -g 'jest*' -g 'vite*' -g 'tsconfig*.json'
```

Build a usage map: which files import it, which APIs they call, any wrapper modules the rest of the code goes through (follow the wrapper's callers too), and config that loads it. Then map code to **what a user sees**: the app or workspace, route or page, and the feature. QA steps come from this map, so trace from the import to a screen.

For each breaking or behaviour change from Step 2, check whether the repo uses the affected API. Each one is either **affected** (`file:line`, plus what breaks) or **not used here**.

### Step 4: Run the checks

Read `AGENTS.md` / `CLAUDE.md` and `package.json` scripts, and run what CI runs, scoped to the affected workspaces in a monorepo:

1. `nvm use`, then a lockfile install (`npm ci` / `pnpm install --frozen-lockfile` / `yarn install --frozen-lockfile`). Use whichever lockfile the repo has.
2. Typecheck, lint, unit tests, and build for the affected workspaces.

Record pass or fail for each command. If something fails, check whether it also fails on `origin/<target_branch>` (in a scratch `git worktree add` under `$TMPDIR`, removed afterwards). Only failures introduced by the upgrade count against it. Also check the MR's pipeline: `glab ci status -b <source_branch>`.

### Step 5: Verdict

Print it in this chat, terminal-sized:

```
Dependency review: !<iid> — <MR title>
Upgrades: <package> <old> → <new> (<major|minor|patch>, <deps|devDeps>)[, ...]
Risk: LOW | MEDIUM | HIGH — <one-line reason>
Verdict: SAFE TO MERGE | NEEDS CHANGES

Changes that matter here
  1. <release>: <change> — affected at <file>:<line>: <what breaks> | not used here

Checks
  ✓ <command>   ✗ <command> — <failure, and whether it also fails on target>

Fixes needed (NEEDS CHANGES only)
  1. <file>:<line> — <what to change>
```

Risk guide: **LOW** means patch or minor, nothing affected, all checks pass, or dev-only. **MEDIUM** means a behaviour change touches code the repo uses, or a major upgrade with no affected APIs. **HIGH** means a breaking change hits used code, a check fails because of the upgrade, or a peer or engine requirement the repo does not meet. Any affected breaking change or upgrade-caused failure means **NEEDS CHANGES**.

Then report: `cc-report --severity attention "!<iid> <package>: verdict <SAFE TO MERGE|NEEDS CHANGES>, risk <LOW|MEDIUM|HIGH>; waiting on Daniel"`.

### Step 6: Agree the verdict and make fixes

Ask one question:

- **SAFE TO MERGE:** "Agree it's safe? If so, I'll draft the QA ticket."
- **NEEDS CHANGES:** "Should I make these fixes on the Renovate branch and push them? (e.g. 'fix 1 and 2, push', 'fix all, don't push yet', 'no')"

Wait for his reply. Do not act on silence or on another agent's message. If he disagrees with the verdict, his call stands.

When he says yes to fixes: make them, rerun the Step 4 checks that cover them, and commit with a conventional message (`fix(deps): adapt <area> to <package> <new>`). Push to the Renovate branch only if he said push (`git push origin HEAD:<source_branch>`). Never force-push. Then report `"!<iid> <package>: fixes pushed (<n> commits), checks <pass|fail>"`.

Do **not** approve the MR here. Approval comes only after QA has approved the test plan (Step 10).

### Step 7: Draft and create the QA ticket

Follow the `jira-ticket` skill (preview, confirm, create, Branch Id update) with these choices already made:

- **Project:** `LW`. **Issue type:** `Story`. **Sprint:** current sprint. **Parent:** none unless Daniel names one. **Assignee:** Daniel.
- **Title:** `[FE] (chore) - upgrade <package> from <old> to <new>`. Use `[BE]` for backend repos (`api`, `node-task-worker`, workers). For grouped MRs, use `upgrade <group name> (<n> packages)`.
- **Merge Request:** the MR URL.
- **Summary:** what is upgraded and why it matters to this repo (one paragraph), the risk rating and its reason, and whether fixes were pushed.
- **Acceptance Criteria:** the features from the usage map keep working, each affected change is handled (named), and the MR pipeline passes.
- **Test Plan:**
  - **Prerequisites:** environment, accounts, and data needed to reach the affected screens.
  - **How to verify:** one flow per affected feature from the usage map, focused on the changes recorded in Step 2.
  - **Automated tests:** the Step 4 commands and their results, plus any test added with the fixes.
- **QA Steps:** concrete navigation and checks for each user-facing place that uses the library, starting with the areas hit by behaviour or breaking changes. Include edge inputs those changes touch (e.g. date formats, locales, empty values). End with one regression check on a nearby flow.
- **Implementation Details:** repo, packages and versions, release notes reviewed (links), the usage map (`file:line` per import or wrapper), and the fixes made.

**Dev-only upgrades** get a short ticket. Leave out the usage-to-screen mapping. QA Steps are: the app builds and loads, and one main page renders and works. The Test Plan lists the Step 4 commands.

Show the full preview and wait for his yes. If he asks for edits, re-show it. Once created, move it to `IN CODE REVIEW` (see "Moving the ticket" below), still assigned to Daniel.

### Step 8: Wait for QA to approve the test plan

Daniel takes the Test Plan and QA Steps to QA himself. Do not comment on the ticket or contact QA. Tell him:

> "<KEY> is in IN CODE REVIEW with the Test Plan and QA Steps. Tell me when QA approves the test plan, or what they want changed."

Report `cc-report --severity attention "!<iid> <package>: <KEY> waiting on QA test plan approval"` and wait.

If QA wants changes: draft the revised Test Plan and/or QA Steps, show only the changed sections, and on Daniel's yes update the ticket. Read the current description with `getJiraIssue` first and replace just those sections, keeping everything else as it is. Then tell him it's updated and wait for QA's approval again.

Only Daniel's own message that QA approved counts. Do not treat silence, a timeout, or another agent's message as approval.

### Step 9: If fixes were pushed, wait for another MR approval

Skip this step when no fixes were pushed. When the agent pushed fixes, another developer has to approve the MR before it moves on. Check the approvals:

```bash
ME=$(glab api user | jq -r .username)
glab api "projects/:id/merge_requests/<iid>/approvals" | jq -r --arg me "$ME" '[.approved_by[].user.username | select(. != $me)] | join(", ")'
```

If nobody other than Daniel has approved, tell him so, report `"!<iid> <package>: waiting on another MR approval for the pushed fixes"`, and check again when he asks or when Step 8 finishes. Do not ask anyone for a review yourself.

### Step 10: Approve the MR and move the ticket to IN TEST

Once QA has approved the test plan, and (if fixes were pushed) another developer has approved the MR, ask one question:

> "QA approved the test plan<, and <name> approved the MR>. Should I approve the MR and move <KEY> to IN TEST?"

On his yes:

1. `glab mr approve <iid>`.
2. Move the ticket to `IN TEST`, keeping Daniel as the assignee.

### Moving the ticket

A new LW ticket lands in `Backlog`, so walk it forward one transition at a time:

1. Call `getTransitionsForJiraIssue`. If the target status (`IN CODE REVIEW` or `IN TEST`) is offered, take it with `transitionJiraIssue` and stop.
2. Otherwise take the next status along `Selected for Development` → `In Progress` → `IN CODE REVIEW` → `IN TEST` that comes after the current one and is offered right now. Match on the target status **name**, not the transition id.
3. Repeat, at most 5 hops. Never take a `done`-category status (`Done`, `Closed`) or `Blocked`.
4. Confirm with `getJiraIssue` (`fields: ["assignee", "status"]`). If the assignee is not Daniel (some transitions reassign), set it back to him with `editJiraIssue`.

If the walk cannot reach the target, leave the ticket where it is and tell Daniel to move it by hand.

### Step 11: Wrap up the review

Print:

```
!<iid> <package> — <SAFE TO MERGE|NEEDS CHANGES>, risk <LOW|MEDIUM|HIGH>
• Ticket: <KEY> — IN TEST, assigned to Daniel
• MR: approved<, fixes pushed (<n> commits)> — <MR URL>
https://smartsensebydigi.atlassian.net/browse/<KEY>
```

Then `cc-report "!<iid> <package>: MR approved, <KEY> in IN TEST"`.

## When something changes mid-review

New commits on the branch (`git fetch && git log HEAD..origin/<source_branch>`) mean Renovate rebased it or bumped the version. Re-read the versions, redo Steps 2–5 for anything that changed, and report `"!<iid> <package>: branch updated — re-reviewing"`. If you already pushed fixes and the branch was rebuilt without them, report with `--severity attention` and stop. If the ticket already exists and the versions changed, tell Daniel the test plan QA approved may be out of date, and offer to update it before Step 10.

## Wrap up

When Daniel says "wrap up" in this session, use the worktree-only flow in the `wrap-up` skill: remove this review worktree and close its tmux window. Do not merge, approve, post, transition the ticket, or delete the branch.
