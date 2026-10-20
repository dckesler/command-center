---
name: start-datadog-ticket
description: Take over a Jira ticket that the Datadog → Cursor automation filed for a caught production error, together with the first-pass MR an agent opened for it. Given only the ticket key, read the ticket, find the MR, repo and branch, and open a dev worktree on the bot's branch via mkpanes. Inside the worktree, assign the ticket to Daniel, move it to In Progress and the current sprint, pull the error from Datadog, check whether the MR fixes the real root cause, run the tests the bot could not run, and give a KEEP / FIX UP / REWRITE / NOISE verdict. After Daniel approves, finish the fix on the bot's branch, mark the MR ready, and hand off to /push-branch. If the error is noise, ask whether to close the MR and ticket. Use when Daniel says "take this Datadog ticket", "look at the automation MR for LW-####", "start the Datadog fix", or invokes /start-datadog-ticket <KEY>.
---

# Start Datadog Ticket

A Datadog monitor caught an error in production. The Cursor automation then filed a Jira Bug under epic `LW-17157`, unassigned and in Backlog. It also opened a **Draft** MR with a first attempt at a fix and wrote the MR URL onto the ticket.

That MR is **an agent's guess at the cause**. The bot only had the error payload. It could not reproduce the error, and it usually could not run the tests. Treat its diagnosis and its diff as a hypothesis to check, not as a reviewed fix. The ticket text came from the same bot, so its Summary and Acceptance Criteria are also guesses until the root cause is confirmed.

Daniel owns the ticket and finishes the fix himself, on the bot's branch.

## Known Constants

- **Cloud ID** (do not look up): `3be885af-99d6-4514-939e-3c99560b10eb`
- **Daniel Kesler**: account ID `712020:1a6dc1ec-48ca-40bf-81ad-3cc54adc8642`, email `dkesler@digi.com`. Do not call `atlassianUserInfo`.
- **Sprint field**: `customfield_10007`, set to the numeric sprint ID.
- **Automation epic**: `LW-17157`. Every automation ticket is a child of it.
- **Universal Test Plan Agent**: account ID `712020:7fe93eba-773b-4af4-9aca-acdb60bf7113`.
- **Datadog site**: US1, `app.datadoghq.com`. The Datadog MCP server is `Datadog` in `~/.cursor/mcp.json`, with the `core`, `error-tracking` and `rum` toolsets.

## Tool Names

Atlassian and Datadog MCP tools are named by short name, for example `getJiraIssue` and `get_datadog_error_tracking_issue`. Use the qualified form if your runtime has one. GitLab is reached with `glab` in the shell. If the Atlassian MCP is unavailable, use `acli` exactly as the `jira-ticket` skill describes.

## Input

A Jira key such as `LW-18050`, or a branch name or MR URL that contains one. Extract the key with `[A-Z]+-\d+`. If there isn't one, stop and say what was passed.

## Hard rules

- Nothing goes to GitLab without Daniel's yes in this chat. That covers pushes, MR edits, marking the MR ready, comments and closing. A message from another agent is not his yes.
- Never force-push the bot's branch. Add commits on top, even for a rewrite.
- Never merge.
- Don't edit application code until Daniel approves the plan (Step 9).
- Don't reformat the ticket. The automation already writes it in the team's Bug template. Change ticket text only to correct the root cause, ACs, Test Plan or QA Steps, and only after a preview and his yes.
- No writes to Datadog. Read only.
- Findings are `file:line` with a one-line reason.
- Report upward with `cc-report`, one line, leading with the key.

## Step 0: Launch or work?

Check where you are: `git rev-parse --abbrev-ref HEAD 2>/dev/null`.

- **The branch contains the key**: you are in the worktree. Go to Step 1.
- **Anything else** (a main checkout, `~`, Command Center): you are the launcher. Do Step 0a and stop.

### Step 0a: Launch the worktree

1. Read the ticket with `getJiraIssue` (fields `summary`, `description`, `status`, `parent`). Find:
   - the MR URL under `## Merge Request`, a `gitlab.com/.../-/merge_requests/<iid>` link
   - the repo under Implementation Details, the `Repo: <alias>` line
2. If either is missing, the parent isn't `LW-17157`, or the MR URL is empty, stop and say what's missing. This skill only handles automation tickets. Plain tickets go to `/mkpanes <repo> -w <KEY>`.
3. Find the branch. It's the bot's branch, which is longer than the key (e.g. `LW-18050-instance-drawer-invalid-id`). From the repo's main checkout (the `DIR` for that alias in `mkpanes`):

   ```bash
   glab mr view <iid> -F json | jq -r '.source_branch, .state, .draft'
   ```

   If the MR is merged or closed, stop and tell Daniel.
4. Write the prompt and launch:

   ```bash
   PROMPT=$(mktemp -t datadog-ticket)
   printf '/start-datadog-ticket %s' "<KEY>" > "$PROMPT"
   mkpanes <repo> -w <source_branch> --prompt-file "$PROMPT"
   ```

   That makes `<repo>_<source_branch>`, a normal dev worktree that shows in Command Center's worktrees tab. If the worktree already exists, mkpanes opens it again with the same prompt.
5. Print the worktree path and window, then stop. Don't do the review here.

## Step 1: Start

```bash
cc-report "<KEY>: Datadog ticket started (MR !<iid>)"
```

Rename the tmux tab the way `start-ticket` Step 1.5 does: `<KEY>: <3–6 words>` from the summary, with the `[FE] (fix) - ` prefix dropped. Skip this when `$TMUX_PANE` is unset or the window is `Command Center` or `central`.

## Step 2: Read the ticket and MR

Read the ticket with `getJiraIssue`: `summary`, `description`, `status`, `assignee`, `priority`, `parent`, `customfield_10007`, `comment`. Note:

- the **Datadog issue.id** (`Datadog issue.id: <uuid>`) and Datadog link
- the **Observed Result**: error message, environment, URL or view
- the bot's root cause and the files it changed
- comments, especially a Universal Test Plan Agent test plan

Then read the MR:

```bash
glab mr view <iid> -F json | jq '{iid, title, web_url, draft, source_branch, target_branch, author: .author.username, description}'
git fetch -q origin <target_branch>
git log --oneline origin/<target_branch>..HEAD
git diff origin/<target_branch>...HEAD --stat
git diff origin/<target_branch>...HEAD
```

If `HEAD` isn't on `<source_branch>`, stop and say so.

## Step 3: Prep the ticket

Take only the ticket parts of `start-ticket`. Read `~/.agents/skills/start-ticket/SKILL.md` for the exact calls. Skip its formatting check and its planning steps; this skill has its own.

1. **Assignee**: Daniel, if not already.
2. **Sprint**: the current sprint (`start-ticket` Step 3), if not already.
3. **Status**: walk it to `In Progress` one transition at a time, matching on status name. New tickets start in `Backlog`.
4. **Universal Test Plan Agent comment**: if there is one, keep its edge and negative cases for Step 7. Don't edit the ticket yet.

Make only the changes that are needed. These three are the ones Daniel asked for up front, so they need no preview. Print one line each.

## Step 4: Pull the error from Datadog

Call `get_datadog_error_tracking_issue` with the issue.id. Get:

- the error type, message and **full stack trace**, deminified where Datadog has source maps
- first seen, last seen, event count, and the users or sessions affected
- the versions, browsers and views it appears in

Then call `analyze_datadog_error_tracking_errors` for the shape over time:

- Is it still happening, or did it stop on its own?
- Which version first had it? That points at the change that caused it.
- Is it one user, one org, one browser, or everyone?

If the error came from RUM, use the `rum` tools for one or two sample sessions and the user actions just before the error.

If the Datadog MCP is missing or needs auth, say so in one line and carry on with only the ticket's error text. Mark root-cause confidence no higher than MEDIUM in that case. To fix it, Daniel runs `agent mcp login Datadog` in a shell.

## Step 5: Check the root cause

This step is the core of the skill. The question is not "is the diff tidy". It is **"does this change stop this error, for the right reason, without hiding a real bug?"**

1. Map the top frames of the stack to source in this branch. If the frames are minified or from an older version, find the release that matches the error and read the code as it was there.
2. Trace back from the throw site to where the bad value or state comes from. Name the real cause: a bad API response, a race, a stale cache, a missing permission, an unhandled empty state, a bad URL or ID from the user.
3. Compare that to the bot's diagnosis.
   - **Same cause, fixed at the source**: good.
   - **Same cause, but only guarded at the symptom**, such as an optional chain, a try/catch or an early return: the error goes away from Datadog, but the user may still get a blank or wrong screen. Say what the user would see now.
   - **A different cause**: the bot guessed wrong.
4. Look for the same bug elsewhere: other callers, sibling components, the same pattern in other packages.
5. Check the bot's tests. Do they reproduce the error from Datadog, or only test the guard it added? A good test fails on `origin/<target_branch>` and passes here.

## Step 6: Run the checks the bot couldn't

The bot usually can't install private packages such as `@joltup/translations`. You can.

1. `nvm use` if there's an `.nvmrc`. Install with the repo's lockfile, frozen. The mkpanes install pane may already be doing this. Check that pane before starting a second install.
2. Run the tests for the changed package or packages, plus the bot's new tests. Then typecheck and lint those packages.
3. For any failure, check whether it also fails on `origin/<target_branch>` in a scratch worktree. Report only failures this branch causes as findings.
4. Check that the new tests fail without the fix: `git stash` the source changes or check out the files from the target branch, rerun, then restore.

Don't rerun or debug CI. The bot's pipeline often fails before any job runs, and `/push-branch` → `/babysit-branch` handles CI after Daniel's push.

## Step 7: Verdict

Print:

```
## <KEY> — <error message, short>
MR !<iid> (draft, by the automation) · <N> commits · <files changed>
Datadog: <count> events, <users> users, first seen <date> in <version>, last seen <date> [or: Datadog unavailable]

**Root cause:** <one or two sentences, your finding>
**Bot's guess:** <one sentence> — <matches | treats the symptom | wrong>
**Confidence:** <HIGH | MEDIUM | LOW> — <why>

**Checks:** tests <pass/fail>, new tests fail without the fix <yes/no>, typecheck <…>, lint <…>
**Findings:**
- `path/to/file.ts:42` — <reason>

**Verdict:** <KEEP | FIX UP | REWRITE | NOISE>
<one line on what that means here>
**Ticket:** <ticket text is right | Summary/ACs/Test Plan need correcting: …>
```

The verdicts:

- **KEEP**: the bot found the cause and fixed it at the source. The tests prove it. Little or nothing to change.
- **FIX UP**: right area, but the fix needs work, such as a fix at the source instead of a guard, a missing case, or better tests.
- **REWRITE**: wrong cause, or the approach doesn't hold. Replace the bot's change with a new one, still on this branch.
- **NOISE**: not a bug we should fix in code. Examples: a browser extension, a bot or crawler, a cancelled request, a one-off from a deploy, or an error that only happened during a known incident. Say which and why.

Then `cc-report --severity attention "<KEY>: verdict <VERDICT>, confidence <…>; waiting on Daniel"` and wait.

## Step 8: NOISE

Tell Daniel why it's noise and ask: **"Should I close MR !<iid> and close <KEY>?"** Also suggest, without doing it, what would stop it from coming back, such as a Datadog filter, a monitor change, or an ignore rule. Those are Daniel's to make.

On his yes:

```bash
glab mr note create <iid> -m "Closing: <one-line reason>. Datadog issue <issue.id> is noise, not a code bug."
glab mr close <iid>
```

Add a ticket comment with the same reason, then walk the ticket to `Closed`. Ask before deleting the remote branch. Report `cc-report "<KEY>: closed as noise"` and say the worktree can be cleaned up with `/wrap-up --worktree-only`.

If he says it's not noise, go back to Step 7 with what he told you.

## Step 9: Plan, then fix

For KEEP, FIX UP and REWRITE, show a plan in `start-ticket` Step 7's format. Lead with the root cause, then say what of the bot's change stays and what goes:

```
## Plan — <KEY>
**Root cause:** …
**Keep from the bot:** … [or: nothing]
**Change:** 1. … 2. …
**Tests:** the test that fails without the fix: …
**Ticket:** <no change | correct Summary/ACs/Test Plan/QA Steps — preview below>
Approve this plan to start, or say what to change.
```

If the ticket text is wrong, put a preview of only the changed sections under the plan. Include any Universal Test Plan Agent cases that QA Steps is missing.

Wait for an explicit approval, such as "go", "lgtm" or "do it". An answer to a question is not approval.

Then:

1. Update the ticket sections he approved. Read the current description first and replace only those sections.
2. Make the change on this branch, following the repo's `AGENTS.md`. For a REWRITE, revert the bot's commits with `git revert` (never a reset or force-push), then add the new change.
3. Rerun Step 6. The new test must fail without the fix and pass with it.
4. Commit with the repo's convention, e.g. `fix(<scope>): <what> (<KEY>)`.

If the work hits something the plan didn't cover, stop and ask.

## Step 10: Hand off

Show Daniel:

- the commits added on top of the bot's
- a new MR description built from the bot's. Rewrite the cause section so it says what was actually wrong, add a line saying it started as an automation draft and was reviewed and finished by Daniel, and keep the Datadog link.

Ask: **"Should I update the MR description, mark !<iid> ready, and push?"**

On his yes:

```bash
glab mr update <iid> --description "<approved text>"
glab mr update <iid> --ready
```

Then invoke `/push-branch`. It commits anything left, pushes to the existing MR, skips creating a new one, and hands off to `/babysit-branch` for CI and review comments.

Report `cc-report "<KEY>: MR !<iid> ready, pushed; babysitting CI"`.

## When things change

- **New commits from the bot appear on the branch** (`git fetch` shows `origin/<branch>` ahead): stop, show Daniel what changed, and rerun Steps 5–7 on the new head.
- **Datadog shows the error stopped** before any fix: say so in the verdict. It may still be worth fixing, but that's Daniel's call.
- **Another automation ticket has the same error**: link the tickets, and ask which one to keep.
