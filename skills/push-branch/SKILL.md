---
name: push-branch
description: Push the current branch to origin and create a GitLab merge request using glab. Commits any outstanding changes first, syncs AGENTS.md, runs pre/post-push hooks, creates the MR, and links it to the Jira ticket. Then hands off to /babysit-branch to handle CI polling and review-comment triage. Use when the user asks to push a branch, create an MR, or open a merge request.
---

# Push Branch Skill

Commit any outstanding changes, push the current branch to origin, create a GitLab MR with an auto-derived title, link the MR to the Jira ticket, then hand off to `/babysit-branch` to poll CI and triage review comments.


## Wake-up entry (read this first)

This skill does **not** use `ScheduleWakeup` — it runs straight through to MR creation and then hands off. If you are re-entered mid-run, determine which step you're in from the conversation history and jump there:

- Working tree dirty, branch not yet pushed → **Step 0** (commit), then continue.
- Working tree clean, branch not yet pushed / MR not yet created → **Step 1**.
- MR already created, Jira not yet linked → **Step 5b**.
- MR created and Jira linked → invoke `/babysit-branch` (Step 6 handoff).

Always reuse the MR IID, MR URL, and repo slug captured earlier in the conversation rather than re-deriving them.

## Step 0: Commit Outstanding Changes

Before anything else, make sure the work is committed using our standard commit format.

1. Check for uncommitted changes and get the branch name:
   ```bash
   git branch --show-current; git status --short
   ```
2. If the working tree is **clean** (no output from `git status --short`), skip to Step 1 — everything is already committed.
3. If there are uncommitted changes:
   - Derive the ticket key from the branch name using the pattern `[A-Z]+-[0-9]+` (e.g., `LW-92`).
   - Review what changed to pick the right conventional commit type and a brief description:
     ```bash
     git diff HEAD --stat && git diff HEAD
     ```
   - Choose the **conventional commit type** that fits the change: `feat`, `fix`, `chore`, `refactor`, `test`, `docs`, `style`, `perf`, `build`, `ci`. Write a concise, imperative description.
   - Build the commit message in the format **for this repo** (see the table below):

     | Repo | Commit & MR title format | Example |
     |---|---|---|
     | `smartsense-one-skeleton` | `<type>: <description> (<TICKET>)` | `fix: rebuild charts when the theme changes (SSONE-328)` |
     | *(all others)* | `<TICKET> (<type>) - <description>` | `LW-92 (feat) - rename Store ID fields to Brand Store Id on web` |

     Detect the repo from the `origin` remote or the working directory. If the branch has no ticket key, omit the ticket portion and ask the user to confirm the message.
   - **Show the user the proposed commit message and wait for confirmation** (they may tweak the type or wording). Do not commit without confirmation.
4. On confirmation, stage everything, run the pre-commit hook (if present), then commit.

   Stage changes:
   ```bash
   git add -A
   ```

   Check for and run the pre-commit hook:
   ```bash
   if [ -f .git/hooks/pre-commit ]; then
     if [ ! -x .git/hooks/pre-commit ]; then
       echo "⚠️ .git/hooks/pre-commit exists but is not executable — skipping (run chmod +x .git/hooks/pre-commit to enable it)"
     else
       .git/hooks/pre-commit
     fi
   fi
   ```
   - If the hook **exits non-zero**: show its full output to the user, stop, and ask them to fix the issues before retrying. Do not commit.
   - If the hook passes, is absent, or is not executable: proceed to commit.

   ```bash
   git commit -m "<the message confirmed above>"
   ```
   Then continue to Step 1.

The MR title in Step 2 uses this same message verbatim, so the two always agree.

## Step 1: Gather Branch and Repo Info

Run as a single Bash call:

```bash
git branch --show-current; git remote get-url origin; git status
```

- If the working tree is **still** not clean after Step 0 (e.g. the user declined to commit), stop and tell the user there are uncommitted changes before proceeding.
- Parse the repo slug from the remote URL in `OWNER/REPO` or `GROUP/NAMESPACE/REPO` format for use with `-R`.

## Step 2: Derive the MR Title

The MR title is the same string as the commit message from Step 0, in the same
per-repo format. If you just wrote that commit, reuse it directly.

If you're re-entering mid-run and need to recover it, find the most recent commit
that mentions the ticket key:

```bash
branch=$(git branch --show-current) && git log --oneline -20 | grep -m1 "$branch" | sed 's/^[a-f0-9]* //'
```

- If a match is found, use that commit message as the MR title.
- If no match is found, ask the user: "What should the MR title be?"

Pass it explicitly with `-t` in Step 5 — do not rely on `glab` inferring a title
from the branch or commits.

## Step 3: Sync AGENTS.md

The working tree is clean by this point (Step 1 halts otherwise), so every prior change is already committed.

1. Look for an `AGENTS.md` at the repo root. **If none exists, skip this step entirely** and continue to Step 4. (Do not create one.)
2. Gather what may be worth documenting from two sources:
   - **The MR's changes** — fetch the latest default branch, then diff this branch against it:
     ```bash
     default=$(git symbolic-ref refs/remotes/origin/HEAD | sed 's|refs/remotes/origin/||') && git fetch origin "$default" && git diff "origin/$default"...HEAD --stat && git diff "origin/$default"...HEAD
     ```
   - **This conversation** — conventions, commands, gotchas, new scripts/directories, or architecture decisions that came up while doing the work.
3. Compare against the current `AGENTS.md` and identify **durable, project-level** facts that are missing — e.g. new build/test/lint commands, a new directory's purpose, naming or structural conventions, non-obvious gotchas. **Exclude** transient or task-specific notes; keep `AGENTS.md` lean.
4. If nothing meaningful is missing, skip the commit and continue to Step 4.
5. If there are additions, draft them, then **show the user the proposed `AGENTS.md` changes and wait for explicit approval.** Do not commit without approval.
6. On approval, apply the edit and commit it on its own:
   ```bash
   git add AGENTS.md && git commit -m "AGENTS.md updates"
   ```
   The push in Step 4 carries this commit, so it lands before the MR is created.

## Step 3b: Run Pre-Push Hook

Before pushing, check for and run the pre-push hook explicitly. This surfaces hook failures before the network call rather than mid-push.

1. Check whether the hook exists:
   ```bash
   ls -la .git/hooks/pre-push 2>/dev/null || echo "absent"
   ```
2. **Absent** — skip and proceed to Step 4.
3. **Present but not executable** — tell the user: "⚠️ `.git/hooks/pre-push` exists but is not executable — it will not fire on push. Run `chmod +x .git/hooks/pre-push` to enable it." Then proceed to Step 4.
4. **Present and executable** — construct the stdin payload that `git push` would send and run the hook:
   ```bash
   branch=$(git branch --show-current)
   local_sha=$(git rev-parse HEAD)
   remote_sha=$(git rev-parse "origin/$branch" 2>/dev/null || echo "0000000000000000000000000000000000000000")
   remote_url=$(git remote get-url origin)
   printf "refs/heads/%s %s refs/heads/%s %s\n" "$branch" "$local_sha" "$branch" "$remote_sha" \
     | .git/hooks/pre-push origin "$remote_url"
   ```
   - **Exits 0** → tell the user "✅ pre-push hook passed." Proceed to Step 4.
   - **Exits non-zero** → show the hook's full output, stop, and tell the user the pre-push hook failed. Ask: "Would you like to fix the issue and retry, or push anyway without the hook (requires your explicit approval)?"
     - To retry: wait for the user to resolve the issue, then re-run from Step 3b.
     - To skip: use `git push --no-verify -u origin <branch>` in Step 4 instead of the normal push (only on explicit user approval).

## Step 4: Push the Branch

```bash
git push -u origin <branch>
```

## Step 5: Create the Merge Request

First, detect the default branch:

```bash
git symbolic-ref refs/remotes/origin/HEAD | sed 's|refs/remotes/origin/||'
```

Then create the MR targeting that branch:

```bash
glab mr create \
  -t "<derived title>" \
  -d "" \
  --target-branch <default-branch> \
  --remove-source-branch \
  --yes \
  -R <repo-slug>
```

**Key flags:**
- `-t` — title derived in Step 2 (the MR title, not the AGENTS.md commit)
- `-d ""` — empty description required to avoid interactive prompt in non-interactive mode
- `--remove-source-branch` — delete branch after merge
- `--yes` — skip confirmation prompt

Output the MR URL to the user. **Capture the MR IID** — it's the trailing number in the URL (e.g., `3577` from `.../merge_requests/3577`). You'll need it for the babysit-branch handoff.

## Step 5b: Add the MR Link to the Jira Ticket

Now that the MR URL is captured, record it on the Jira ticket so the MR is linked from the issue.

1. Derive the ticket key from the branch name using the pattern `[A-Z]+-[0-9]+` (e.g., `LW-17033`). If the branch has no such key, skip this step (nothing to update) and continue to Step 6.
2. Fetch the issue description with the Atlassian MCP:
   - `getJiraIssue` with `cloudId: 3be885af-99d6-4514-939e-3c99560b10eb`, the derived `issueIdOrKey`, `fields: ["description"]`, and `responseContentFormat: "markdown"`.
3. In the description text, find the bare `Merge Request` line (our ticket template renders it as a `## Merge Request` heading) and replace that occurrence with `Merge Request: <MR URL>`, where `<MR URL>` is the URL captured in Step 5. Preserve the rest of the description verbatim.
   - If the text already contains `Merge Request: ` followed by a URL, it's already linked — skip the update.
   - If there is no `Merge Request` text anywhere in the description, skip the update and note it in one line ("No `Merge Request` placeholder on `<TICKET>` — skipped MR link."), then continue.
4. Write the updated description back with `editJiraIssue` using the same `cloudId` and `issueIdOrKey`, passing the full revised description.
5. Confirm in one line: "🔗 Linked MR on `<TICKET>`." Then continue to Step 6.

## Step 6: Hand Off to babysit-branch

Invoke the `babysit-branch` skill at **Step 1** (CI polling for the SHA just pushed). This includes the first push that opens the MR **and** every later push after review-comment fixes — never skip CI polling because comments were already triaged once. Pass along the MR IID, MR URL, and repo slug captured above so it doesn't need to re-derive them.
