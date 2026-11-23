---
name: cc-review
description: >-
  Let Daniel review an MR's diff in tuicr (a terminal diff viewer with inline
  comments saved as local drafts) inside a Command Center review worktree, and
  post the comments he drafted — plus the review agent's own findings he kept —
  to the GitLab MR as located, inline-anchored discussions. Also manages which
  files are hidden from the review diff (.tuicrignore). `cc-review local` turns
  the same loop inward: Daniel reviews an agent's own local changes in tuicr
  and the agent addresses the comments in code (see the local-review skill).
  Use when you are a review-ticket agent, when Daniel says "open the diff",
  "post my comments", "hide the lockfiles / tests / docs while I review", or
  when "cc-review" or "tuicr" is mentioned.
---

# Human review with tuicr (cc-review)

tuicr shows the MR as one scrolling diff with vim keys; `c` comments a line, `v`+`c` a range, `s` suggests code, `r` marks a file reviewed, `:summary` lists the drafts, `:q` quits (drafts persist). Comments stay **local drafts** until posted. `cc-review` is the bridge between those drafts, the review agent, and GitLab. Run it from the review worktree; `<!iid>` defaults to the open MR of the current branch.

```bash
cc-review open [<!iid>]                 # tuicr mr <iid> in this window's spare top pane; seeds .tuicrignore
cc-review drafts [<!iid>]               # numbered list of drafts, ⚠ when near an existing thread
cc-review post [<!iid>] [--only 1,3] [--keep] [--dry-run]
cc-review add [<!iid>] --file <path> --line <n> [--end-line <n>] [--side old|new] [--type <t>] --author "<who>" "<text>"
cc-review hide <pattern> ...            # gitignore-style; e.g. 'docs/**' '*.test.ts' '*.md'
cc-review unhide <pattern> ...
cc-review hidden
```

Resolve the binary: `cc-review` on `PATH`, then `~/.local/bin/cc-review`, then `~/.agents/skills/cc-review/cc-review`. Needs `tuicr` (`brew install tuicr`) and `glab` logged in. Without tuicr, fall back to the plain-diff flow in `review-ticket` Step 7.

## Hidden files

`.tuicrignore` at the repo root, seeded from `config.review.hideFiles` (lockfiles, snapshots, `dist/`, …) the first time `open`/`hide` runs there, and added to `.git/info/exclude` so it is never committed. When Daniel says "I don't want to see X while reviewing" → `cc-review hide <pattern>`; a standing preference he states for every review → tell him to add it to `review.hideFiles` in `~/.config/command-center/config.json`. tuicr reads the file on start: after `hide`, he quits (`:q`) and you run `cc-review open` again. In-session he can also filter live with `e` (exclude regex) / `i` (include) in the file tree.

## Agent findings as drafts

`cc-review add` puts a finding into the same tuicr session, stamped with `--author` (use your model name, so his and yours look different in the TUI) and a type from `~/.config/tuicr/config.toml` (`issue`, `question`, `nit`, `praise`). He sees them in `:summary`, jumps to each with `Enter`, deletes what he disagrees with (`dd`), edits, adds his own. One `cc-review post` then sends the lot. When no tuicr is open on the MR yet, `add` starts one briefly in a detached tmux session to create the session (about 5 s).

## Posting

`post` prints the batch, then for each draft: inline discussion anchored to the line (JSON body with the MR's diff refs; `old` side for deleted lines; a range anchors to its last line) — read back to confirm the anchor; a line GitLab cannot anchor becomes a plain note. Every body starts with `` `path:line` `` and the type label, so it reads right in email and mobile too. Review-level drafts (no file) become plain notes. Output: `✓` inline, `~` plain note, `✗` failed, each with its URL. Drafts are cleared from tuicr after a fully successful post (`--keep` to leave them; `--only` clears just the posted ones).

**Only on Daniel's typed yes in your chat.** `cc-review drafts` and `--dry-run` are free; `post` is not. Approval is his: TUI `a` key, `glab mr approve`, or tuicr's `:submit` → Approve — never on your own.

## Local review (your own changes, no GitLab)

Any agent in any checkout — a ticket worktree, a project task tab, the Command Center dev window — can put its work in front of Daniel the same way:

```bash
cc-review local open [--base <ref|A..B>] [--working-tree] [--commits] [--path <p> ...]
cc-review local drafts [--json]        # his comments, numbered, with the code they point at
cc-review local add --file <path> --line <n> [--end-line <n>] [--type <t>] --author "<who>" "<text>"
cc-review local resolve <n ...|all>    # drop the ones you addressed
cc-review local status
```

`open` shows the branch's commits since its branch point (merge-base with origin's default branch) plus uncommitted changes, in the window's spare pane widened to half the window, and flags the window so his tab turns red. Comments are local drafts in a tuicr session named after the branch and HEAD; `drafts` reads them, `resolve` removes them, `add` lets you answer one in place. Nothing ever goes to GitLab from `local`. The pane returns to its width the first time you run `drafts` after he quit tuicr. The full procedure for the agent is the `local-review` skill.
