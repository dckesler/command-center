---
name: wrap-up
description: Wrap up a worktree branch — close the GitLab MR, transition the Jira ticket to Done, remove the git worktree, delete the branch, and close the tmux window. Use when the user is done with a feature branch and wants to fully close it out. Also supports a worktree-only mode (e.g. "just the worktree", "--worktree-only") that skips MR/Jira/branch and only removes the worktree directory and closes the tmux window.
---

# Wrap-Up Skill

Fully close out a feature branch: close the GitLab MR, transition the Jira ticket to Done, tear down the worktree, and close the tmux window.

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

## Step 5: Confirm With the User

Present a summary of what will happen:
- MR to be closed (number + title, or "none found")
- Jira ticket to be transitioned to Done (key, or "none found")
- Worktree path to be removed
- Branch to be deleted
- Tmux window ID to be closed (the one identified in Step 3, or "none found")

Ask: "Confirm wrap-up?" and wait for explicit yes before proceeding.

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
- If state is `opened` after all attempts → **stop**. Tell the user: "The MR is still open after 2 minutes — it may be waiting for a pipeline, a merge train, or approval. Branch and worktree have NOT been removed. Check the MR in GitLab and re-run wrap-up once it is merged."
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
