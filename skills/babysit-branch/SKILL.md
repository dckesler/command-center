---
name: babysit-branch
description: Get a GitLab MR merge-ready — resolve conflicts with the target branch, poll the CI/CD pipeline until it reaches a terminal state (updating from the target branch when a failure looks unrelated), then collect unresolved MR review comments (any author, including CodeAnt and humans), triage them autonomously — fix the ones worth fixing in the working tree, close the rest with a reason — summarize, and ask whether to run /push-branch. Loops back to CI polling after every push to the MR and ends only when the MR is mergeable. Can be invoked standalone on any branch that already has an open MR, or handed off from /push-branch. Use when the user asks to watch CI, babysit a branch, or wait for review comments, and ALWAYS after pushing new commits to a branch that has an open MR.
---

# Babysit Branch Skill

Poll the CI/CD pipeline on the current branch's open GitLab MR until it reaches a terminal state. If the pipeline passes, move the Jira ticket to Code Review. Then wait for review comments to settle, collect unresolved discussions from **any author** (humans and bots), and **triage them yourself**: fix every comment that is worth fixing, close the rest with a reason, summarize what you did, and ask the user whether to run `/push-branch`. The user is consulted at exactly two points — after a CI failure diagnosis, and after the fix summary — never for per-comment decisions.

**Standing rule — any push restarts polling.** Whenever new commits land on a branch with an open MR (via `/push-branch`, a manual `git push`, or a fix you committed yourself), re-enter this skill at **Step 1** for the new `HEAD` SHA. A push means a new pipeline and a fresh round of bot/human review; never treat the MR as babysat because an earlier SHA was.

## Wake-up entry (read this first)

This skill is re-entered on every `ScheduleWakeup` fire. **Determine which phase you're in from the conversation history and jump straight there — do not re-derive MR info if it is already known:**

- MR info not yet captured and not handed from `/push-branch` → **Step 0** (derive MR info).
- MR info known, CI pipeline not yet terminal → **Step 1** (CI polling).
- CI pipeline failed and failure diagnosis shown, waiting on user decision → act on **Step 1c**'s fix-or-continue prompt when they reply.
- CI pipeline reached a terminal state (non-failed), review comments not yet listed → **Step 2** (review-comment polling).
- CI pipeline failed, user chose "continue" → **Step 2** (review-comment polling).
- Review comments collected, triage not yet done → **Step 3** (collect) then **Step 4** (fix / close autonomously). No wakeups during triage; it runs straight through.
- Fix summary shown, waiting on the user's "ready for `/push-branch`?" answer → act on **Step 4b** when they reply. Do not schedule wakeups while waiting on the user.
- MR has conflicts with its target branch (Step 1a found `has_conflicts: true`) and they are not yet resolved → **Step 1a**. If you already asked the user how to resolve a genuine intent conflict, wait for their answer.
- New commits were pushed to the MR since the last CI poll (a `/push-branch` handoff after triage, a manual push, or `git rev-parse HEAD` no longer matches the SHA you last polled) → **Step 1** for the **new** `HEAD` SHA. Reset `REVIEW_POLLS` to 0 and record the push time as `SINCE` (see Step 2).

Always reuse the MR IID, MR URL, and repo slug captured earlier in the conversation rather than re-deriving them.

**Loop:** CI → review comments → autonomous triage → summary + "ready for `/push-branch`?" → push → back to CI. Do not print Step 5 links until that loop has nothing left to do: CI terminal on the current `HEAD`, no conflicts with the target branch, no unresolved comments, and no fixes sitting unpushed in the working tree.

## Step 0: Derive MR Info (standalone entry only)

Skip this step entirely if the MR IID, MR URL, and repo slug are already known from the conversation (e.g. handed off from `/push-branch`).

Run as a single Bash call:

```bash
git branch --show-current && git remote get-url origin && glab mr view --output json 2>/dev/null | jq -r '"\(.iid)\n\(.web_url)"'
```

- Parse the **branch name** from `git branch --show-current`.
- Parse the **repo slug** from the remote URL in `OWNER/REPO` or `GROUP/NAMESPACE/REPO` format for use with `-R`.
- Parse the **MR IID** (first line of `jq` output) and **MR URL** (second line).
- If `glab mr view` fails or returns no open MR, tell the user: "No open MR found for this branch. Push one first with `/push-branch`, or open an MR manually in GitLab." Then stop.

Once captured, proceed to Step 1.

## Step 1a: Check Mergeability (conflicts)

Run this once per SHA, before the first CI poll for that SHA — a conflicted MR can go green and still be unmergeable.

```bash
glab mr view <MR_IID> -R <repo-slug> --output json \
  | jq -r '"\(.target_branch)\t\(.has_conflicts)\t\(.detailed_merge_status)"'
```

- `has_conflicts` is `false` → continue to Step 1. (`detailed_merge_status` values like `ci_still_running`, `discussions_not_resolved` or `not_approved` are expected mid-loop; only `conflict` needs action here.)
- `has_conflicts` is `true` → resolve them now, before CI runs on a commit that cannot merge:
  1. `git fetch origin <target_branch>` and `git merge origin/<target_branch>` (match the repo's habit — use `git rebase origin/<target_branch>` only if the repo's MRs are normally rebased and the branch is not shared).
  2. For each conflicted file, read both sides and the surrounding code. Keep the intent of **both** the branch and the target: a target-side rename or signature change applies to the branch's new code too; a branch-side fix is not dropped because the target touched the same lines.
  3. If the two sides want incompatible things (both changed the same behaviour on purpose), `git merge --abort`, show the conflicting hunks with one line on what each side intends, and ask the user which wins. **Do not schedule a wakeup** — wait for the answer.
  4. After resolving, run the repo's checks on the touched files, then continue to `/push-branch` — this is a push, so it hands back here at Step 1 for the new `HEAD`.

## Step 1: Poll CI/CD Pipeline Status

GitLab creates two pipelines per MR: a **branch push pipeline** (source `push`) and a **merge request pipeline** (source `merge_request_event`). On many repos the push pipeline is `skipped` and the MR pipeline is the one that actually runs jobs — so prefer the MR pipeline when one exists. But **some repos (e.g. `smartsense4/core`) never create a `merge_request_event` pipeline at all** — only the push pipeline runs. On those repos, querying `refs/merge-requests/<MR_IID>/head` returns `null` forever, even after CI has already finished, which would otherwise cause an infinite polling loop.

To handle both cases, query the MR pipeline first, and fall back to the push pipeline for the branch — matched against the **current HEAD SHA** — if the MR pipeline query comes back empty:

```bash
CURRENT_SHA=$(git rev-parse HEAD)
PIPE=$(glab ci list --ref "refs/merge-requests/<MR_IID>/head" -R <repo-slug> -F json 2>/dev/null | jq -c '.[0] // empty')
if [ -z "$PIPE" ] || [ "$PIPE" = "null" ]; then
  PIPE=$(glab ci list --ref "<branch>" -R <repo-slug> -F json 2>/dev/null \
    | jq -c --arg sha "$CURRENT_SHA" '[.[] | select(.sha == $sha)][0] // empty')
fi
echo "$PIPE" | jq -r 'if . and . != "" then (.status, .web_url) else ("null","null") end'
```

This returns exactly two lines: the pipeline's state, then its URL. Matching the push pipeline against `CURRENT_SHA` matters — it ensures you're reading the pipeline for the commit actually on the branch right now, not a stale pipeline from an earlier commit that hasn't been superseded yet. If neither query finds a pipeline for the current SHA, the output will be `null\nnull` — treat that as non-terminal and keep polling. The terminal states are:
- `success` — pipeline passed
- `failed` — pipeline failed
- `canceled` — pipeline was canceled
- `skipped` — no automated jobs ran (only manual jobs configured); treat as terminal

**Non-terminal states** (keep polling): `running`, `pending`, `created`, `waiting_for_resource`, `preparing`

### Polling loop behaviour

Use `ScheduleWakeup` with `delaySeconds: 30` to schedule each poll. Pass the original `/babysit-branch` invocation as the `prompt` so the skill re-enters on each wakeup.

On each wakeup:
1. Run the JSON status check above.
2. If the state is **non-terminal**: tell the user the current status and schedule the next wakeup in 30 seconds with reason `"polling CI pipeline for <branch>"`.
3. If the state is **terminal**: print the CI status line (below). Then, **if (and only if) the pipeline passed (`success`)**, run **Step 1b** to move the Jira ticket to Code Review. Afterward (or immediately, for any non-`success` terminal state), **continue to Step 2** to begin review-comment handling. Do NOT print the MR/Jira links yet and do NOT end the loop — the links print only at the very end (Step 5).

### CI terminal status messages

- `success` → "✅ Pipeline passed for `<branch>`."
- `failed` → "❌ Pipeline failed for `<branch>`." Then run **Step 1c** to diagnose the failure.
- `canceled` → "⚠️ Pipeline was canceled for `<branch>`."
- `skipped` → "Pipeline skipped — only manual jobs are configured. No automated CI ran."

Do not include the pipeline URL in any terminal state message. On `success`, run Step 1b before continuing; on `failed`, skip Step 1b and run Step 1c instead; for `canceled` / `skipped`, skip both 1b and 1c. Regardless of which terminal state was reached, proceed to Step 2 (review comments are independent of the CI outcome).

## Step 1c: Diagnose Pipeline Failure

This runs **once**, immediately after a `failed` terminal state is detected. Skip entirely for any non-`failed` state.

1. **Get the pipeline ID** from the same query (with fallback) used in Step 1:
   ```bash
   CURRENT_SHA=$(git rev-parse HEAD)
   PIPE=$(glab ci list --ref "refs/merge-requests/<MR_IID>/head" -R <repo-slug> -F json 2>/dev/null | jq -c '.[0] // empty')
   if [ -z "$PIPE" ] || [ "$PIPE" = "null" ]; then
     PIPE=$(glab ci list --ref "<branch>" -R <repo-slug> -F json 2>/dev/null \
       | jq -c --arg sha "$CURRENT_SHA" '[.[] | select(.sha == $sha)][0] // empty')
   fi
   echo "$PIPE" | jq -r '.id'
   ```

2. **List failed jobs** for that pipeline:
   ```bash
   glab api "projects/:id/pipelines/<PIPELINE_ID>/jobs" \
     | jq -r '.[] | select(.status == "failed") | "\(.id)\t\(.stage)\t\(.name)"'
   ```
   Each line is `<JOB_ID>\t<stage>\t<job_name>`. If no jobs are returned, note "No failed jobs found in pipeline — it may have been a pipeline-level error." and continue to Step 2.

3. **For each failed job** (cap at 3 jobs to avoid excessive output), fetch the tail of its log:
   ```bash
   glab api "projects/:id/jobs/<JOB_ID>/trace" 2>/dev/null | tail -60
   ```
   If the trace is empty or the API call fails (e.g. the job has no log), note "No log available for `<job_name>`."

4. **Present a concise failure summary** to the user:
   - List each failed job by `<stage> / <job_name>`.
   - Under each job, show the last ~20 meaningful lines of its log (strip ANSI escape codes with `sed 's/\x1b\[[0-9;]*m//g'` if they appear). Truncate long lines at 200 chars. Focus on error lines — lines containing `error`, `Error`, `ERROR`, `FAILED`, `fatal`, `exit code`, or `npm ERR!` are most useful; include the surrounding 3 lines of context.
   - If there are more than 3 failed jobs, note "… and N more failed jobs. See the pipeline in GitLab for the full list." but do not fetch logs for the extras.

5. **Decide whether the failure is this MR's.** A failure is in scope when the failing job exercises files this MR changed, or the error names a symbol, test or path the MR touched. When it looks unrelated (a job this MR did not affect, a flaky integration test, an infrastructure error), check whether the branch is behind its target — another MR may already have fixed it:
   ```bash
   git fetch -q origin <target_branch> && git rev-list --count HEAD..origin/<target_branch>
   ```
   A non-zero count means the branch is behind. Say so in the summary and offer to merge the latest target branch and re-run (the **Update** option below) instead of guessing at a fix.

6. After presenting the summary, ask the user: "Would you like to fix the issue and push a new commit, update from `<target_branch>` and re-run, or should I continue to review comments?"
   - **Fix** — if the cause is clear from the log (lint, type error, a test you can see is wrong, a missing import), make the fix yourself in the working tree and show the diff; otherwise wait for the user to make the change. Then run `/push-branch` (Step 0 commits the fixes; it pushes to the same branch and MR — no second MR) which hands back to this skill at Step 1 for the new pipeline.
   - **Update** — `git merge origin/<target_branch>` (resolve conflicts per Step 1a), then `/push-branch`. The new pipeline tells you whether the failure was really unrelated.
   - **Continue** — proceed to Step 2 without re-pushing.

   **Scope rule for any CI fix you make yourself.** Fix the code this MR changed. Never edit `.gitlab-ci.yml`, CI scripts, lint/type/test configuration, thresholds, timeouts or retry counts to make a failure pass; never skip, delete or `.only` a test to get green; never change code outside the MR's scope. If a genuine fix would require any of those, do not do it — report what you found and why it needs a human decision, then ask.

## Step 1b: Move the Ticket to Code Review (on pipeline success only)

This runs **once**, the moment CI reaches `success`. Skip it entirely for any non-`success` terminal state — a failed/canceled pipeline should not advance the ticket. On later `ScheduleWakeup` re-entries the skill jumps to Step 2, so this is naturally not repeated.

1. Derive the ticket key from the branch name using the pattern `[A-Z]+-[0-9]+` (e.g., `LW-92`). If the branch has no such key, skip this step and continue to Step 2.
2. Fetch the available transitions with the Atlassian MCP `getTransitionsForJiraIssue` (`cloudId: 3be885af-99d6-4514-939e-3c99560b10eb`, the derived `issueIdOrKey`).
3. Find the transition whose target status name matches `code review` **case-insensitively** (our board's status is `IN CODE REVIEW`).
   - If no such transition is offered, the ticket is likely already in Code Review (or past it) — note it in one line ("`<TICKET>` already at/past Code Review — no transition.") and continue to Step 2. Do not force it backward.
4. Apply it with `transitionJiraIssue` using the same `cloudId` / `issueIdOrKey` and the matched transition id.
5. Confirm in one line: "🔀 Moved `<TICKET>` to Code Review." Then continue to Step 2.

Do not schedule a wakeup here — this is a synchronous one-shot update on the way to review-comment polling.

## Step 2: Poll until Review Comments Are Ready to Triage

After CI is terminal, wait until review activity has settled enough to list comments. Prefer waiting for CodeAnt's finished signal when that bot is reviewing, but **do not require CodeAnt** — human reviewers and other bots count too.

CodeAnt signals completion in one of two ways (author username/name contains `codeant`, case-insensitive):

1. **Review Status table** — a comment with heading `## 🤖 CodeAnt AI — Review Status` containing a table row with `✅ Reviewed your PR` and a non-empty Finished timestamp.
2. **Legacy phrase** — a comment body containing `CodeAnt AI finished reviewing your PR.`

Bots re-review on every push, so an old "finished" comment from a previous SHA must not count. `SINCE` is the epoch time of the commit at the current `HEAD` (the commit you are babysitting); only CodeAnt notes created after it count as activity for this round:

```bash
SINCE=$(git log -1 --format=%ct HEAD)
glab api "projects/:id/merge_requests/<MR_IID>/discussions?per_page=100" --paginate \
  | jq -r --argjson since "$SINCE" '
      def is_codeant:
        ((.author.username // "" | ascii_downcase | test("codeant"))
         or (.author.name // "" | ascii_downcase | test("codeant")));
      def is_codeant_done:
        (.body | test("CodeAnt AI finished reviewing your PR."; "i"))
        or (.body | test("✅ Reviewed your PR"; "i"));
      def is_status_noise:
        is_codeant and is_codeant_done;
      def is_recent:
        ((.updated_at // .created_at // "1970-01-01T00:00:00Z")
         | sub("\\.[0-9]+"; "") | fromdateiso8601) >= $since;
      . as $all
      | {
          codeant_done: ([ $all[].notes[] | select(is_codeant and is_codeant_done and is_recent) ] | length > 0),
          codeant_seen: ([ $all[].notes[] | select(is_codeant and is_recent) ] | length > 0),
          open_threads: ([ $all[]
            | . as $d
            | .notes[0]
            | select(.system | not)
            | select(is_status_noise | not)
            | select(.resolved | not)
          ] | length)
        }
      | "\(.codeant_done)\t\(.codeant_seen)\t\(.open_threads)"
    '
```

- `:id` is replaced by glab with the current repo's project ID (the skill runs inside the repo). If that fails, substitute the URL-encoded repo slug, e.g. `projects/group%2Fsub%2Frepo/...`.
- CodeAnt's Review Status table is often **edited in place** rather than re-posted; if `codeant_seen` stays `false` but a CodeAnt status comment exists whose `updated_at` is after `SINCE` and shows `✅ Reviewed your PR`, treat `codeant_done` as `true`.
- Track how many Step 2 polls have run since CI went terminal **for the current SHA** in the conversation (`REVIEW_POLLS`, start at 0, increment each wakeup, reset to 0 after every push).
- **Proceed to Step 3** when any of these is true:
  - `codeant_done` is `true` (CodeAnt finished), or
  - `codeant_seen` is `false` and `REVIEW_POLLS >= 2` (no CodeAnt activity after ~1 minute — don't hang waiting for a bot that isn't running), or
  - `REVIEW_POLLS >= 10` (~5 minutes) — list whatever comments exist and stop waiting.
- Otherwise: tell the user "Waiting on review comments…" (mention CodeAnt specifically only when `codeant_seen` is true and `codeant_done` is false) and schedule the next wakeup in 30 seconds with reason `"polling review comments for <branch>"`.

## Step 3: Collect Unresolved Review Comments

Fetch the discussions again and extract every unresolved non-system discussion root **from any author**, excluding CodeAnt completion-summary comments. Capture discussion ID, author, resolved state, and inline file/line when present:

```bash
glab api "projects/:id/merge_requests/<MR_IID>/discussions?per_page=100" --paginate \
  | jq -r '.[] | . as $d | (.notes[0])
      | select(.system | not)
      | select(
          ((.author.username // "" | ascii_downcase | test("codeant"))
            or (.author.name // "" | ascii_downcase | test("codeant")))
          and ((.body | test("CodeAnt AI finished reviewing your PR."; "i"))
            or (.body | test("✅ Reviewed your PR"; "i")))
          | not)
      | select(.resolved | not)
      | { discussion_id: $d.id,
          author: (.author.name // .author.username // "unknown"),
          file: (.position.new_path // .position.old_path // null),
          line: (.position.new_line // .position.old_line // null),
          body: .body }'
```

Keep the `discussion_id` for each item — you need it to reply and resolve in Step 4. Note the count of already-resolved threads in one line if non-zero.

If there are **no** unresolved comments, say so in one line and skip straight to Step 5.

Otherwise **do not list them for the user to pick from and do not ask anything** — go straight to Step 4.

## Step 4: Triage and Fix Autonomously

Decide for every open comment whether it is worth fixing, then act. Read the referenced code before deciding; do not judge from the comment text alone.

**Fix** a comment when it points at a real defect or a clear improvement that is in scope for this MR: correctness bugs, missing error handling or null checks the code path actually hits, security findings, a test the change should have had, misleading names or comments, dead code the MR introduced, style that violates the repo's own conventions. A human reviewer's request counts as worth fixing unless it is factually wrong — bias toward doing what a teammate asked.

**Close** a comment (resolve with a short reply) when it is: already addressed by the current code, factually mistaken about what the code does, out of scope for this MR (pre-existing code the MR did not touch, a refactor that belongs in its own ticket), a bot nit that contradicts the repo's conventions, a duplicate of another thread, or purely informational. Never close a human's comment as "out of scope" or "disagree" without saying why in the reply.

**Escalate** (neither fix nor close — leave open and list it in the summary) only when the right answer depends on product intent or information you do not have, e.g. "should this be configurable?" or a reviewer asking a question only the author can answer.

For each **fix**: make the change in the working tree; run the repo's relevant checks on what you touched (typecheck / lint / the affected tests — whatever `AGENTS.md` or `package.json` says); run `snyk_code_scan` on modified first-party code if applicable. Then reply on the thread and resolve it:

```bash
glab api -X POST "projects/:id/merge_requests/<MR_IID>/discussions/<DISCUSSION_ID>/notes" \
  -f body="Fixed: <one line — what changed>"
glab api -X PUT "projects/:id/merge_requests/<MR_IID>/discussions/<DISCUSSION_ID>?resolved=true"
```

For each **close**:

```bash
glab api -X POST "projects/:id/merge_requests/<MR_IID>/discussions/<DISCUSSION_ID>/notes" \
  -f body="Closing: <brief reason>"
glab api -X PUT "projects/:id/merge_requests/<MR_IID>/discussions/<DISCUSSION_ID>?resolved=true"
```

Resolve fixed threads now (before the push) so the user's summary and GitLab agree; the fix itself reaches the MR on the next push.

**Do not commit and do not push here.** Leave the fixes in the working tree — `/push-branch` Step 0 will show the commit message for confirmation and push.

### Step 4a: Summarize and Ask

Print one summary with three groups (omit empty groups):

```
Review triage for `<branch>` — N fixed, M closed, K left open

Fixed
1. <author> — <file:line> — <what the comment asked> → <what you changed>
…

Closed
2. <author> — <file:line> — <what the comment asked> → <why closed>
…

Left open (needs you)
3. <author> — <file:line> — <the question, verbatim or near>
```

Then, if anything was fixed, ask plainly:

> "Fixes are in the working tree (uncommitted). Ready to go back to `/push-branch`?"

If nothing was fixed (all closed), skip the question; continue to Step 5 if nothing is left open, or stop and ask the user about the left-open items if there are any.

**Do not schedule a wakeup here.** Wait for the user's reply.

### Step 4b: Act on the Reply

- **Yes / go / push** → run `/push-branch`. It commits (with confirmation of the message), pushes to the same branch and MR (never a second MR), and hands back to this skill at **Step 1** for the new `HEAD`. Reset `REVIEW_POLLS` to 0.
- **Changes requested** (the user disagrees with a fix or a close) → apply what they asked: revert or adjust the fix, or un-resolve and re-open a thread with `glab api -X PUT "...?resolved=false"` and a reply. Re-print the summary and ask again.
- **Answers to left-open items** → fold them in as fixes or closes per their answer, update the summary, and ask again if a push is now needed.
- **Not now** → stop. Say the fixes remain uncommitted in the working tree and that running `/push-branch` later will resume the loop.

## Step 5: Final Output — MR URL and Jira Ticket URL

Once CI is terminal for the current `HEAD` **and** no review comments remain unresolved **and** nothing from triage is sitting unpushed in the working tree, confirm the MR is actually mergeable:

```bash
glab mr view <MR_IID> -R <repo-slug> --output json \
  | jq -r '"\(.has_conflicts)\t\(.detailed_merge_status)\t\(.blocking_discussions_resolved)"'
```

- `has_conflicts: true` → back to **Step 1a**.
- `blocking_discussions_resolved: false` → a thread was opened or re-opened since triage; back to **Step 3**.
- `detailed_merge_status` of `not_approved` (or anything else that needs a person) is **not** yours to fix — name it in the final line so the user knows what is still outstanding.

Then print:

- **MR URL** — the GitLab merge request URL captured in Step 0 or handed from `/push-branch`
- **Jira ticket URL** — derive the ticket key from the branch name using the pattern `[A-Z]+-[0-9]+` (e.g., `LW-17033`) and format the URL as:
  `https://smartsensebydigi.atlassian.net/browse/<TICKET-KEY>`

Example output:
```
✅ Pipeline passed for `LW-17033`. Review comments triaged (2 fixed, 1 closed). Mergeable; waiting on approval.

🔗 MR: https://gitlab.com/smartsense4/lists/-/merge_requests/3577
🎟  Jira: https://smartsensebydigi.atlassian.net/browse/LW-17033
```

This ends the skill — do not schedule another wakeup.
