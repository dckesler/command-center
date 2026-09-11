---
name: babysit-branch
description: Poll a GitLab MR's CI/CD pipeline until it reaches a terminal state, then collect unresolved MR review comments (any author, including CodeAnt and humans), list them for triage, and print the final MR and Jira links. Can be invoked standalone on any branch that already has an open MR, or handed off from /push-branch. Use when the user asks to watch CI, babysit a branch, or wait for review comments.
---

# Babysit Branch Skill

Poll the CI/CD pipeline on the current branch's open GitLab MR until it reaches a terminal state. If the pipeline passes, move the Jira ticket to Code Review. Then wait for review comments to settle, list unresolved discussions from **any author** (humans and bots), and let the user triage fixes vs. closes before printing the final MR and Jira links.

## Wake-up entry (read this first)

This skill is re-entered on every `ScheduleWakeup` fire. **Determine which phase you're in from the conversation history and jump straight there — do not re-derive MR info if it is already known:**

- MR info not yet captured and not handed from `/push-branch` → **Step 0** (derive MR info).
- MR info known, CI pipeline not yet terminal → **Step 1** (CI polling).
- CI pipeline failed and failure diagnosis shown, waiting on user decision → act on **Step 1c**'s fix-or-continue prompt when they reply.
- CI pipeline reached a terminal state (non-failed), review comments not yet listed → **Step 2** (review-comment polling).
- CI pipeline failed, user chose "continue" → **Step 2** (review-comment polling).
- Review comments already listed → you are waiting on the user's triage decisions; act on **Step 3 / Step 4** when they reply. Do not schedule wakeups while waiting on the user.

Always reuse the MR IID, MR URL, and repo slug captured earlier in the conversation rather than re-deriving them.

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

5. After presenting the summary, ask the user: "Would you like to fix the issue and push a new commit, or should I continue to review comments?"
   - **Fix** — wait for the user to make code changes, then when they're ready, return to Step 0 of `/push-branch` (commit the fixes) and loop through the full push cycle again on the same branch, which will trigger a new pipeline.
   - **Continue** — proceed to Step 2 without re-pushing.

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

On each wakeup, fetch discussions and decide:

```bash
glab api "projects/:id/merge_requests/<MR_IID>/discussions?per_page=100" --paginate \
  | jq -r '
      def is_codeant:
        ((.author.username // "" | ascii_downcase | test("codeant"))
         or (.author.name // "" | ascii_downcase | test("codeant")));
      def is_codeant_done:
        (.body | test("CodeAnt AI finished reviewing your PR."; "i"))
        or (.body | test("✅ Reviewed your PR"; "i"));
      def is_status_noise:
        is_codeant and is_codeant_done;
      . as $all
      | {
          codeant_done: ([ $all[].notes[] | select(is_codeant and is_codeant_done) ] | length > 0),
          codeant_seen: ([ $all[].notes[] | select(is_codeant) ] | length > 0),
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
- Track how many Step 2 polls have run since CI went terminal in the conversation (`REVIEW_POLLS`, start at 0, increment each wakeup).
- **Proceed to Step 3** when any of these is true:
  - `codeant_done` is `true` (CodeAnt finished), or
  - `codeant_seen` is `false` and `REVIEW_POLLS >= 2` (no CodeAnt activity after ~1 minute — don't hang waiting for a bot that isn't running), or
  - `REVIEW_POLLS >= 10` (~5 minutes) — list whatever comments exist and stop waiting.
- Otherwise: tell the user "Waiting on review comments…" (mention CodeAnt specifically only when `codeant_seen` is true and `codeant_done` is false) and schedule the next wakeup in 30 seconds with reason `"polling review comments for <branch>"`.

## Step 3: List Unresolved Review Comments

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
      | { discussion_id: $d.id,
          resolved: .resolved,
          author: (.author.name // .author.username // "unknown"),
          file: (.position.new_path // .position.old_path // null),
          line: (.position.new_line // .position.old_line // null),
          body: .body }'
```

Present the open (unresolved) suggestions to the user as a numbered list. For each, show **author**, file:line (when inline), and a concise rendering of the comment body. Keep the `discussion_id` for each item — you need it to resolve threads in Step 4. Skip any already-resolved threads (note their count in one line).

If there are **no** unresolved comments, say so in one line and skip straight to Step 5.

Then ask the user, plainly:

> "Which would you like to fix, and which should I close out? (e.g. 'fix 1 and 3, close 2')"

**Do not schedule a wakeup here.** Stop and wait for the user's reply — this is a human decision point.

## Step 4: Act on the User's Decisions

For each suggestion the user picks:

- **Fix** — make the code change in the working tree per the suggestion. After applying fixes, follow normal practice: run the relevant `snyk_code_scan` on modified first-party code if applicable, then let the user review. Do not auto-commit or auto-push unless the user asks — confirm before committing the fixes onto the branch. (Optionally reply on the thread noting the fix, then resolve it.)
- **Close** — resolve the discussion thread, optionally posting a short reply with the reason first:

```bash
# Optional reply explaining the decision
glab api -X POST "projects/:id/merge_requests/<MR_IID>/discussions/<DISCUSSION_ID>/notes" \
  -f body="Closing: <brief reason>"

# Resolve the thread
glab api -X PUT "projects/:id/merge_requests/<MR_IID>/discussions/<DISCUSSION_ID>?resolved=true"
```

Process all of the user's choices, then briefly summarize what was fixed vs. resolved. If the user asks to revisit the list, return to Step 3.

## Step 5: Final Output — MR URL and Jira Ticket URL

Once CI is terminal and the review comments have been triaged (or there were none), print:

- **MR URL** — the GitLab merge request URL captured in Step 0 or handed from `/push-branch`
- **Jira ticket URL** — derive the ticket key from the branch name using the pattern `[A-Z]+-[0-9]+` (e.g., `LW-17033`) and format the URL as:
  `https://smartsensebydigi.atlassian.net/browse/<TICKET-KEY>`

Example output:
```
✅ Pipeline passed for `LW-17033`. Review comments triaged (2 fixed, 1 resolved).

🔗 MR: https://gitlab.com/smartsense4/lists/-/merge_requests/3577
🎟  Jira: https://smartsensebydigi.atlassian.net/browse/LW-17033
```

This ends the skill — do not schedule another wakeup.
