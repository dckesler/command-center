---
name: wrap-up
description: Wrap up a worktree branch — check the MR pipeline's QA Audit stage (four manual attestation jobs: Test plan, test_plan_reviewed label, Test Lead, QA approval comment), verify each item on the Jira ticket and play the unplayed jobs only on Daniel's yes, then merge the GitLab MR, transition the Jira ticket to Done, remove the git worktree, delete the branch, and close the tmux window. Use when the user is done with a feature branch and wants to fully close it out. Also supports a worktree-only mode (e.g. "just the worktree", "--worktree-only") that skips MR/Jira/branch and only removes the worktree directory and closes the tmux window.
---

# Wrap-Up Skill

Fully close out a feature branch: clear the MR's QA Audit gate (Step 4b/5b), merge the GitLab MR, transition the Jira ticket to Done, tear down the worktree, and close the tmux window.

---

## Worktree-Only Mode

If the user says something like "just the worktree", "worktree only", or passes `--worktree-only`, run this condensed flow instead of the full Steps 1–9 below:

1. **Confirm this is a worktree** — run `git worktree list --porcelain && pwd`. If the current directory is the main repo, stop and say so.
2. **Record** the worktree path and main repo path, then **identify the tmux window by its worktree path** — the same way as Step 3 (see its warning). Do **not** use `tmux display-message`:
   ```bash
   tmux list-panes -a -F '#{window_id} #{pane_current_path}' | awk -v p="<worktree-path>" '$2==p {print $1}' | sort -u
   ```
   Record exactly one match. If **zero**, there is no window to close — skip the tmux step. If **more than one**, list them and ask the user which to close.
3. **Confirm with the user** — show the worktree path and tmux window that will be removed, then wait for explicit yes.
4. **Remove the worktree**:
   ```bash
   git -C <main-repo-path> worktree remove --force <worktree-path>
   ```
   If the directory still exists after that, remove it:
   ```bash
   rm -rf <worktree-path>
   ```
5. **Close the tmux window** — only if step 2 found exactly one window. `cd ~` first so the shell cwd is valid after the worktree directory is gone, then target the window explicitly by the captured ID, never the active window:
   ```bash
   cd ~ && tmux kill-window -t '<window-id>'
   ```

Do not close any MR, transition any Jira ticket, or delete any branch in this mode.

---

## Unattended Mode (a project's central agent)

A project's central agent (started by `start-project`) may wrap up **its own task tabs** without Daniel's confirmation, but only when all of these hold:

- The project's `PROJECT.md` has `**Plan:** approved`.
- The MR is **already merged** (`glab mr view <iid> -F json | jq -r .state` is `merged`). Unattended mode never merges: if the MR is open, stop and report `"<name>: <tab> MR !<iid> not merged yet — leaving the tab"` instead.
- The Jira ticket is in a Done-category status, or there is no ticket.
- Step 3 finds exactly one tmux window for the worktree path.

The central agent runs from the project's `central` window, not from the worktree, so take the worktree path from `project-task --list` (or the worker's report) and run every `git` command with `-C <worktree-path>` / `-C <main-repo-path>` instead of relying on `pwd`. Skip Step 4b, Step 5's confirmation, Step 5b and Step 6 (the merge). Unattended mode never plays QA Audit jobs: an unmerged MR whose pipeline is held at `manual` by the QA Audit stage is reported as not merged, like any other open MR, and Daniel runs the audit from the worktree himself. Do Steps 7–9 (ticket already Done is a no-op), then tick the step in PROJECT.md and log it.

If any condition fails, fall back to the normal flow below — which means asking Daniel.

---

## Step 1: Confirm This Is a Worktree

Run:

```bash
git worktree list --porcelain && pwd
```

- Find the entry matching the current directory (`pwd`).
- If the current directory is the main worktree (first entry), stop and tell the user: "This looks like the main repo, not a worktree. Nothing to wrap up."
- Otherwise, record the **worktree path** and **branch name**.

---

## Step 2: Detect the Main Repo Path

From `git worktree list --porcelain`, the first entry is always the main repo. Parse its path.

---

## Step 3: Identify the Tmux Window by Worktree Path

Do **not** use `tmux display-message -p '#{window_id}'`. This skill's Bash commands do **not** run inside your interactive tmux window, so `display-message` returns whichever window is currently *active* — which is usually the wrong one and has caused the wrong window to be killed.

Instead, find the window whose pane is sitting in the worktree directory. Capture this **now**, before Step 8 removes the worktree (afterward the path no longer matches):

```bash
tmux list-panes -a -F '#{window_id} #{pane_current_path}' | awk -v p="<worktree-path>" '$2==p {print $1}' | sort -u
```

- **Exactly one** window ID → record it for Step 9.
- **Zero** matches (not running under tmux, or no window is in the worktree) → there is no window to close; note this and **skip Step 9 entirely**. Never fall back to the active window.
- **More than one** match → list them for the user and ask which to close; never guess.

---

## Step 4: Identify the MR and Jira Ticket

### MR
Check the conversation context for a GitLab MR URL or number. If found, use it.
If not found in context, look it up by branch:

```bash
glab mr list --source-branch <branch-name> --output json
```

Parse the MR IID from the result. If no open MR is found, note this and skip the MR step.

### Jira Ticket
Extract the ticket key from the branch name using the pattern `[A-Z]+-[0-9]+` (e.g., `LW-17033`). If the branch name doesn't match, check the conversation context for a ticket key. If none found, skip the Jira step.

---

## Step 4b: Inspect the QA Audit Stage

Some repos (lists, and any pipeline that includes `gitlab/jira-ticket-audit.yml`) end their MR pipeline with a **QA Audit** stage: four blocking manual jobs, one per thing the Jira ticket must have before the MR may merge. Each job only echoes "Confirmed." — **playing it is the attestation**, so whoever plays it is vouching that the ticket really has that item. Until all four have run green the pipeline sits at `manual` and GitLab refuses the merge.

| job | the ticket must have | how to check (from the worktree) |
|---|---|---|
| `Jira Ticket Audit: Test plan` | a non-empty **Test Plan** section in the description | `acli jira workitem view <KEY> --fields description --json \| jq '[.fields.description.content[]? \| select(.type=="heading") \| .content[0].text] \| map(test("Test Plan";"i")) \| any'` → `true`, and the text under that heading is not empty |
| `Jira Ticket Audit: Test plan approval label` | the label `test_plan_reviewed` | `acli jira workitem view <KEY> --fields labels --json` → `.fields.labels` includes `test_plan_reviewed` |
| `Jira Ticket Audit: Test lead assigned` | **Test Lead** (`customfield_11800`) set | `acli jira workitem view <KEY> --fields customfield_11800 --json` → `.fields.customfield_11800.displayName` non-null |
| `Jira Ticket Audit: QA approval comment` | a comment saying QA passed | `acli jira workitem view <KEY> --fields comment,status --json \| jq -c '.fields.comment.comments[]? \| {author: .author.displayName, created: .created[0:10], text: ([.. \| .text? // empty] \| join(" "))}'` → a comment matching `passed QA` / `QA passed` / `QA approved` (any author; `/pass-qa` writes "Passed QA."). "Test plan approved." is the *label's* evidence, not this one. A status of *Ready For Deployment* or later corroborates it |

Skip this whole step when Step 4 found no open MR.

1. Find the head pipeline and its QA Audit jobs (run from the worktree so `glab` resolves the project):

   ```bash
   glab mr view <mr-iid> --output json | jq '{project_id, pipeline: .head_pipeline.id, status: .head_pipeline.status}'
   glab api "projects/<project_id>/pipelines/<pipeline_id>/jobs?per_page=100" \
     | jq -c '.[] | select(.stage == "QA Audit") | {id, name, status}'
   ```

   No jobs in a `QA Audit` stage → this repo has no audit gate; record "no QA Audit stage" and go to Step 5.

2. Classify each job: `success` = already run; `manual` = not run yet; `failed` / `canceled` = run and failed (retryable); `pending` / `running` = someone just played it — wait for it in Step 5b.

3. For every job that is **not** `success`, check the ticket for the item in the table above and record **evidence** (the exact label, the Test Lead's name, the comment's author and date, a one-line quote of the Test Plan heading) or **missing**.

4. Record the result for Step 5 as one line per job:

   ```
   QA Audit (pipeline 3075010211, 2/4 run):
     ✓ Test plan — already run
     ✓ Test plan approval label — already run
     ▶ Test lead assigned — not run; ticket has Test Lead: Daniel Kesler ✓
     ▶ QA approval comment — not run; "Passed QA." by Jenni Whitman, Nov 14 ✓
   ```

   An item with no evidence reads `✗ … — not run; ticket has NO test lead`. If the audit was already run in full (4/4 `success`), the line is just `QA Audit: 4/4 run ✓`.

Never play a job in this step. Never add the missing item yourself (no label, no Test Lead, no comment) — those are QA's and Daniel's calls; say what is missing and let him decide.

---

## Step 5: Confirm With the User

Present a summary of what will happen:
- MR to be closed (number + title, or "none found")
- **QA Audit** — the block from Step 4b. When jobs remain to be played, add exactly one question under it: "Run the N remaining QA Audit jobs? (I am vouching for the items marked ✓.)" — and if any item is **missing**, say instead that the merge will stay blocked until it exists, and offer to play only the jobs whose item is present.
- Jira ticket to be transitioned to Done (key, or "none found")
- Worktree path to be removed
- Branch to be deleted
- Tmux window ID to be closed (the one identified in Step 3, or "none found")

Ask: "Confirm wrap-up?" and wait for explicit yes before proceeding. One answer covers both questions when he gives one ("yes, run them" / "go ahead" = both; "wrap up but don't run the audits" = merge will be attempted and will stop at Step 6's poll). If Daniel's request already said the audits are good to run ("run the audits", "audits are fine", "QA items are all there"), do not ask the audit question again — still show the block, since he is vouching on your evidence.

---

## Step 5b: Play the Remaining QA Audit Jobs (only on Daniel's yes)

Only when Step 4b found jobs to run **and** Daniel said yes. From the worktree:

```bash
glab api -X POST "projects/<project_id>/jobs/<job_id>/play"     # status manual → pending
glab api -X POST "projects/<project_id>/jobs/<job_id>/retry"    # status failed/canceled → new job
```

Play only the jobs he agreed to (all of them, or only those with evidence). Then poll until none is `pending` or `running`:

```bash
glab api "projects/<project_id>/pipelines/<pipeline_id>/jobs?per_page=100" \
  | jq -c '.[] | select(.stage == "QA Audit") | {name, status}'
```

Every 10 seconds, up to 18 attempts (3 minutes). All four `success` → tell him `QA Audit: 4/4 run ✓` in one line and continue to Step 6. Anything else (`failed`, still `manual`, timeout) → **stop before merging**; show the job states and the GitLab pipeline URL (`glab api "projects/<project_id>/pipelines/<pipeline_id>" | jq -r .web_url`), and tell him the branch and worktree have NOT been touched.

---

## Step 6: Merge the GitLab MR

If an MR was found:

```bash
glab mr merge <mr-iid> --yes
```

Run this from the worktree directory so glab picks up the correct remote.

### Verify the merge completed

After running the merge command, poll the MR state until it reaches `merged` or a terminal failure state. Do **not** proceed to Step 7, 8, or 9 until the MR is confirmed merged.

Poll loop (run from the worktree directory):

```bash
glab mr view <mr-iid> --output json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('state','unknown'))"
```

- Repeat every **10 seconds**, up to **12 attempts** (2 minutes total).
- If state is `merged` → proceed to Step 7.
- If state is `closed` → **stop**. Tell the user: "The MR was closed rather than merged — it may have been declined or closed manually. Branch and worktree have NOT been removed. Please check the MR and re-run wrap-up when ready."
- If state is `opened` after all attempts → **stop**. Tell the user: "The MR is still open after 2 minutes — it may be waiting for a pipeline, a merge train, or approval. Branch and worktree have NOT been removed. Check the MR in GitLab and re-run wrap-up once it is merged." If Step 4b left QA Audit jobs unplayed (he declined, or an item was missing), say that first: that is why the pipeline is `manual` and the merge is held.
- If `glab mr view` itself errors → **stop**. Show the error and tell the user the branch and worktree have NOT been removed.

**Never skip this check.** The branch deletion in Step 8 uses `-d` (safe delete), but losing the branch reference while the MR is unmerged is still disruptive. Halting here keeps everything recoverable.

---

## Step 7: Transition the Jira Ticket to Done

If a ticket key was found, use the Atlassian MCP tools:

1. Call `getTransitionsForJiraIssue` with:
   - `cloudId`: `3be885af-99d6-4514-939e-3c99560b10eb`
   - `issueIdOrKey`: the ticket key

2. Find the transition whose name is `Done` (or closest match: `Close`, `Closed`, `Resolve`).

3. Call `transitionJiraIssue` with:
   - `cloudId`: `3be885af-99d6-4514-939e-3c99560b10eb`
   - `issueIdOrKey`: the ticket key
   - `transitionId`: the ID from step 2

---

## Step 8: Remove the Worktree and Delete the Branch

Remove the worktree:

```bash
git -C <main-repo-path> worktree remove --force <worktree-path>
```

Delete the local branch:

```bash
git -C <main-repo-path> branch -d <branch-name>
```

If `-d` fails (unmerged), tell the user and ask whether to force-delete with `-D`.

---

## Step 9: Close the Tmux Window

Only if Step 3 found **exactly one** matching window. `cd ~` first so the shell cwd is valid after the worktree directory is gone, then target the window explicitly by the ID captured in Step 3 — never the active window:

```bash
cd ~ && tmux kill-window -t '<window-id>'
```

If Step 3 found zero matches, skip this step.
