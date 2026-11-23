---
name: local-review
description: >-
  Put your own local code changes in front of Daniel in tuicr (his terminal
  diff viewer) and address the comments he leaves there, in code — no GitLab,
  no MR. Use when you reach a point where the work is ready for his eyes
  (implementation done, a risky refactor, before push-branch), when he says
  "let me look", "open it in tuicr", "local review", or when invoked as
  `/local-review`. Works in any Command Center window: ticket worktrees,
  project task tabs, the dev window.
---

# Local review in tuicr

You open the diff of what you did in the pane beside yours; Daniel reads it in tuicr and comments on lines; you read the comments as a list, fix each one (or answer it), and tell him what changed. It replaces pasting diffs into chat and replaces "post a draft MR so I can comment" for work that is not ready for an MR. Nothing in this skill touches GitLab or Jira.

`cc-review` must be on `PATH` (`~/.local/bin/cc-review`); if `cc-review local status` fails with "tuicr is not installed", say so and fall back to summarizing the diff in chat.

## Step 1: Open

Make sure what he should see is on disk — write files, run the formatter, no half-edited state. Do **not** commit for this step unless the enclosing skill already told you to commit as you go.

```bash
cc-review local open
```

Default scope: every commit on this branch since its branch point plus uncommitted changes. Narrow it when the default would bury what matters: `--working-tree` (only uncommitted), `--commits` (only commits), `--base <ref>` (another branch point, or `A..B`), `--path <dir-or-file>` (repeatable). It starts tuicr in the window's spare top pane, widens that pane to half the window, hides the files in `.tuicrignore` (lockfiles, snapshots, …), and flags the window red so he knows.

Then tell him, in two lines, what is in the diff and what you want looked at; report upward if you have a manager:

```bash
cc-report --severity attention "<ref>: ready for your review in tuicr — <what, in a few words>"
```

If `open` says "no idle top-row pane" or "no tmux window", print the `tuicr …` command it suggests and ask him to run it where he likes; everything else still works.

Then **wait**. Do not poll, do not read drafts early, do not keep working on the same files (he is reading them).

## Step 2: He is done

Trigger: "done", "done reviewing", "addressed?", "fix those", "take a look at my comments", or a `[cc mail]` saying so. Then:

```bash
cc-review local drafts
```

Each comment comes numbered with `path:line`, its `[TYPE]` (`issue`, `question`, `nit`, `praise`), author, text, and the surrounding code. "no comments" means he had nothing — say so in one line and continue the enclosing skill.

## Step 3: Address every comment

Work through the list in order; for each one:

- **Fix it** when it is a change you can make — edit the code, run the relevant tests or typecheck, then `cc-review local resolve <n>`. Batch resolves: `cc-review local resolve 1 2 5`.
- **Answer it** when it is a `[QUESTION]`, or when you disagree with an `[ISSUE]`/`[NIT]`: leave a reply beside it — `cc-review local add --file <path> --line <n> --type question --author "<your model name>" "<one or two sentences>"` — and leave his comment unresolved so he sees both.
- **Ask** only when the comment is genuinely ambiguous (two different changes would both satisfy it). One question, with the option you would pick.
- `[PRAISE]` → resolve, nothing to do.

Never resolve a comment you did not act on. Never edit his comments. Never run `cc-review post` — local comments are not for GitLab.

## Step 4: Report back

In chat, one block:

```
Review round <n>: <k> comments — <f> fixed, <a> answered in tuicr, <q> need you.
- #1 a.ts:42 renamed fooBar → loadUser (fixed)
- #3 b.ts:10 kept the retry; replied with why (open)
- #4 c.ts:7 question: cache per request or per session? I would do per request.
```

Then:
- If any comment stays open (answered or a question) → wait for him. His reply closes the loop: fix → `resolve`, or he says drop it → `resolve`.
- "another look" / "open it again" → back to Step 1 (`cc-review local open`); the previous round's session is retired, so re-state anything still open from it in chat.
- All resolved and he says so (or nothing is open) → `cc-report "<ref>: review comments addressed (<k>)"` if you have a manager, then continue the enclosing skill (commit, `/push-branch`, next step — whatever it says). Committing the fixes is the enclosing skill's call, not this one's.

## Rules

- `cc-review local` never posts, pushes, commits, or transitions anything.
- Do not open a local review for trivial changes or on every step — only when your judgment, the enclosing skill, or Daniel calls for his eyes.
- One tuicr per window: if `open` says tuicr is already running there, he is mid-review — wait.
- If `drafts` lists comments by an agent author (yours from an earlier round), treat them as context, not as new work.
