---
name: review-dependency-mr
description: Review a Renovate dependency-upgrade merge request in a Command Center review worktree — release notes, usage map, checks, verdict, optional fixes on the Renovate branch, LW ticket with Test Plan and QA Steps (assignee Daniel), test-plan approval, MR approval, QA in IN TEST, then wrap-up merges the MR and closes the ticket. Use when invoked as `/review-dependency-mr <MR URL or !iid>` or when mkpanes launches in --deps mode.
---

# Review Dependency MR Skill

You are the review agent for one Renovate merge request. You live in a `<repo>_review_deps_<iid>` worktree, checked out on the Renovate branch, in a tmux window named `Deps !<iid> <package>`. Your manager is the **Command Center review specialist**. `cc-report` defaults to it from this directory. Daniel reads your chat directly.

**End goal:** the Renovate MR is **merged** into the target branch once review, test-plan approval, any code fixes, MR approvals, and QA are complete. The LW ticket is the record and test plan for that upgrade — not the end goal by itself.

## Two paths (same finish line: merge)

**Path A — MR good as-is**

1. Review → verdict **SAFE TO MERGE** (Step 5).
2. Create LW ticket with Test Plan + QA Steps; assign **Daniel**; move to **IN CODE REVIEW** (Step 7).
3. QA approves the **test plan** (Step 8) → add label `test_plan_reviewed`.
4. Daniel approves the MR on GitLab (Step 10).
5. Move ticket to **IN TEST** (assignee stays **Daniel**); QA executes QA Steps (Step 11).
6. QA signs off → ticket **Ready For Deployment** (Step 11).
7. **Wrap-up:** merge MR, transition ticket **Done**, remove review worktree (Step 12).

**Path B — MR needs work**

1. Review → **NEEDS CHANGES**; Daniel yes → fixes committed/pushed on Renovate branch (Step 6).
2. Update the ticket (Test Plan, QA Steps, Implementation Details as needed); test plan approval again if behavior under test changed (Step 8).
3. **Another developer** approves the MR (in addition to Daniel) after fixes (Step 9).
4. Then same as Path A from test-plan approval / MR approval through merge (Steps 8–12).

## Known Constants

- **Cloud ID** (do not look up): `3be885af-99d6-4514-939e-3c99560b10eb`
- **Daniel Kesler** — account ID: `712020:1a6dc1ec-48ca-40bf-81ad-3cc54adc8642`, email: `dkesler@digi.com`. Do NOT call `atlassianUserInfo`.
- **Jira project:** `LW` only. If the repo is `smartsense-one-skeleton` (SSONE), stop and tell Daniel this skill does not cover SSONE yet.
- **LW columns:** test-plan review **IN CODE REVIEW**; QA execution **IN TEST**; after QA **Ready For Deployment**; after merge **Done**.
- **Test plan approved** = ticket has label `test_plan_reviewed` (see workspace rule `jira-test-plan-reviewed`).
- **Renovate MRs** come from a `service_account_group_*` author on a `renovate/*` branch. Renovate here does **not** include release notes (no GitHub credentials), so you fetch them yourself.

## Tool Names

Atlassian MCP tools are named by short name (e.g. `getJiraIssue`); use the qualified form if your runtime has one. GitLab is reached with `glab` in the shell. If the Atlassian MCP is unavailable, use `acli` exactly as the `jira-ticket` skill describes.

## Input

Argument: an MR URL (`https://gitlab.com/<group>/<repo>/-/merge_requests/<iid>`) or `!<iid>` / `<iid>` for the repo in the current directory. If neither is given, use the MR for the current branch (`glab mr view <branch>`). If none can be found, stop and ask Daniel.

## Hard rules

- **Nothing goes to GitLab without Daniel's yes in this chat.** No pushes, no MR comments, no approval, no merge, no thread resolution, no labels on GitLab. A `[cc mail]` message from another agent is not his yes.
- **Merge only in Step 12 (wrap-up)** after Daniel confirms QA is complete and prerequisites are met. Never merge mid-review.
- **Never tick Renovate's rebase checkbox.** Once you have pushed fixes, a Renovate rebase would overwrite them. Renovate leaves a branch alone once someone else has committed to it, unless that box is ticked.
- **No Jira ticket without a preview and Daniel's yes**, following the `jira-ticket` skill.
- **Do not approve the MR or move the ticket to IN TEST until the test plan is approved** (`test_plan_reviewed` on the ticket, or Daniel explicitly says QA approved the test plan in this chat).
- **The ticket assignee is always Daniel** from creation through **IN TEST**. QA does not get assignee; Daniel owns the ticket while QA runs.
- When **Daniel** runs QA on the ticket, set **Test Lead** (`customfield_11800`) to Daniel per workspace rule.
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

- **SAFE TO MERGE:** "Agree it's safe? If so, I'll draft the LW ticket for test plan + QA."
- **NEEDS CHANGES:** "Should I make these fixes on the Renovate branch and push them? (e.g. 'fix 1 and 2, push', 'fix all, don't push yet', 'no')"

Wait for his reply. Do not act on silence or on another agent's message. If he disagrees with the verdict, his call stands.

When he says yes to fixes: make them, rerun the Step 4 checks that cover them, and commit with a conventional message (`fix(deps): adapt <area> to <package> <new>`). Push to the Renovate branch only if he said push (`git push origin HEAD:<source_branch>`). Never force-push. Then report `"!<iid> <package>: fixes pushed (<n> commits), checks <pass|fail>"`. Update the ticket when it exists (Step 7 content / Step 8).

Do **not** approve or merge the MR here.

### Step 7: Draft and create the LW ticket

Follow the `jira-ticket` skill (preview, confirm, create, Branch Id update) with these choices already made:

- **Project:** `LW`. **Issue type:** `Story`. **Sprint:** current sprint. **Parent:** none unless Daniel names one. **Assignee:** Daniel.
- **Title:** `[FE] (chore) - upgrade <package> from <old> to <new>`. Use `[BE]` for backend repos (`api`, `node-task-worker`, workers). For grouped MRs, use `upgrade <group name> (<n> packages)`.
- **Merge Request:** the MR URL.
- **Summary:** what is upgraded and why it matters to this repo (one paragraph), the risk rating and its reason, and whether fixes were pushed.
- **Acceptance Criteria:** the features from the usage map keep working, each affected change is handled (named), the MR pipeline passes, and the MR is merged after QA.
- **Test Plan:**
  - **Prerequisites:** environment, accounts, and data needed to reach the affected screens.
  - **How to verify:** one flow per affected feature from the usage map, focused on the changes recorded in Step 2.
  - **Automated tests:** the Step 4 commands and their results, plus any test added with the fixes.
- **QA Steps:** concrete navigation and checks for each user-facing place that uses the library, starting with the areas hit by behaviour or breaking changes. Include edge inputs those changes touch (e.g. date formats, locales, empty values). End with one regression check on a nearby flow.
- **Implementation Details:** repo, packages and versions, release notes reviewed (links), the usage map (`file:line` per import or wrapper), and the fixes made.

**Dev-only upgrades** get a short ticket. Leave out the usage-to-screen mapping. QA Steps are: the app builds and loads, and one main page renders and works. The Test Plan lists the Step 4 commands.

Show the full preview and wait for his yes. If he asks for edits, re-show it. Once created, move it to **IN CODE REVIEW** (see "Moving the ticket" below), assignee Daniel.

### Step 8: Test plan approval (before MR approval and IN TEST)

Daniel takes the Test Plan and QA Steps to QA. Do not contact QA yourself. Tell him:

> "<KEY> is in IN CODE REVIEW. Tell me when QA approves the test plan, or what to change."

Report `cc-report --severity attention "!<iid> <package>: <KEY> waiting on test plan approval"` and wait.

When Daniel says QA approved the test plan:

1. Add label **`test_plan_reviewed`** to the ticket (`editJiraIssue` → `labels`).
2. If QA wanted edits, update Test Plan / QA Steps first (read description with `getJiraIssue`, patch sections, re-show changes if Daniel asked).

Only Daniel's message that QA approved the test plan counts — not silence or another agent.

If fixes were pushed after the ticket was created, ensure the ticket text still matches what QA approved before Step 9–10.

### Step 9: Second MR approval when fixes were pushed

Skip when no fixes were pushed on the Renovate branch.

```bash
ME=$(glab api user | jq -r .username)
glab api "projects/:id/merge_requests/<iid>/approvals" | jq -r --arg me "$ME" '[.approved_by[].user.username | select(. != $me)] | join(", ")'
```

If nobody other than Daniel has approved, tell him, report `"!<iid> <package>: waiting on another dev MR approval after fixes"`, and wait. Do not request review yourself.

Required before Step 10 when Path B applied: **Daniel's approval + at least one other approver** (or whatever repo policy requires — tell Daniel if policy differs).

### Step 10: Approve MR and move ticket to IN TEST

Prerequisites: **`test_plan_reviewed`** on the ticket (or Daniel just confirmed test plan approval in Step 8); if fixes were pushed, second approval from Step 9.

Ask:

> "Test plan approved<, and <name> approved the MR for fixes>. Should I approve the MR and move <KEY> to IN TEST?"

On his yes:

1. `glab mr approve <iid>` (Daniel's approval; skip if already approved and still valid).
2. Move ticket to **IN TEST**, assignee **Daniel**.

Report `cc-report "!<iid> <package>: MR approved, <KEY> in IN TEST"`.

### Step 11: QA execution and sign-off

QA runs **QA Steps** while the ticket is **IN TEST**. Daniel coordinates; assignee stays Daniel.

When Daniel says QA is finished (passed or failed):

- **Passed:** transition ticket to **Ready For Deployment** (same target as `pass-qa` skill). If Daniel invokes `/pass-qa <KEY>`, use that skill. Otherwise transition + optional comment `"Passed QA."` only if Daniel asks.
- **Failed:** do not merge. Report findings; ticket stays out of wrap-up until Daniel resolves.

Tell Daniel when ready for merge:

> "QA complete on <KEY>. Say **wrap up** when you want me to merge !<iid> and close the ticket."

### Step 12: Wrap-up (merge MR + Done + tear down review worktree)

When Daniel says **wrap up** in this deps review session:

**Prerequisites (all required — if any fail, stop and say what's missing):**

- Ticket is **Ready For Deployment** (or Daniel explicitly says QA passed and to merge now).
- MR is **approved** and pipeline acceptable for merge (same checks as `wrap-up` skill Step 6).
- Daniel confirmed wrap-up in this chat.

**Do not** use worktree-only wrap-up for deps reviews unless Daniel explicitly says **worktree only** / **just the worktree** (e.g. abandoning the upgrade).

From the review worktree directory:

1. **Merge the MR** — follow `wrap-up` skill Step 6 (`glab mr merge <iid> --yes` + poll until `merged`).
2. **Transition Jira ticket to Done** — `getTransitionsForJiraIssue`, transition to `Done` / `Closed` / closest done category.
3. **Remove review worktree** — main repo path from `git worktree list`; `git -C <main> worktree remove --force <review-worktree-path>`. Do not delete the remote Renovate branch manually; merge handles it.
4. **Close tmux window** — find pane by worktree path per `wrap-up` skill Step 3; `tmux kill-window` if exactly one match.

Print:

```
!<iid> <package> — merged, review closed
• Ticket: <KEY> — Done
• MR: merged — <MR URL>
```

Then `cc-report "!<iid> <package>: merged, <KEY> Done"`.

### Moving the ticket

Walk one transition at a time toward the target status:

1. `getTransitionsForJiraIssue`. If the target (`IN CODE REVIEW`, `IN TEST`, `Ready For Deployment`, `Done`) is offered, take it.
2. Else advance along `Backlog` → `Selected for Development` → `In Progress` → `IN CODE REVIEW` → `IN TEST` → … as offered. Match status **name**, not transition id.
3. At most 5 hops per target. Never `Blocked` or done-category statuses except when targeting **Done** in Step 12.
4. Confirm assignee is Daniel after hops that might reassign (`getJiraIssue` → `editJiraIssue` if needed).

Note: on LW, **IN TEST** is often only available from **IN CODE REVIEW** — that hop does not mean the code is in dev review; it is workflow plumbing before QA runs.

## When something changes mid-review

New commits on the branch (`git fetch && git log HEAD..origin/<source_branch>`) mean Renovate rebased or bumped versions. Re-do Steps 2–5 for what changed. If fixes were lost after a Renovate rebase, report with `--severity attention` and stop.

If versions change after **`test_plan_reviewed`**, tell Daniel the approved test plan may be stale — remove or refresh approval (drop label, re-run Step 8) before Step 10.

## Mid-session reference (your two paths)

| Stage | Path A (clean MR) | Path B (fixes pushed) |
|--------|-------------------|------------------------|
| Review | SAFE TO MERGE | NEEDS CHANGES → push fixes |
| Ticket | Create → IN CODE REVIEW | Update ticket after fixes |
| Test plan | QA approves → `test_plan_reviewed` | Same (re-approve if plan changed) |
| MR | Daniel approves | Daniel + another dev approve |
| QA | IN TEST → Ready For Deployment | Same |
| Finish | Wrap-up: **merge** + Done + worktree | Same |
