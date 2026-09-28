---
name: cc-mail
description: >-
  Send a message to another Command Center agent (a project's central agent,
  a task tab, a ticket worktree) without typing over whatever the human has in
  that agent's input box. Use when a prompt says to message, steer, answer or
  inform another agent by directory, tmux pane or window, or when "cc-mail" is
  mentioned. Reports upward still go through cc-report; replies to a task tab
  still go through project-task --message — both use cc-mail underneath.
---

# Message another agent with cc-mail

Messages between agents are never typed straight into a pane. `cc-mail` appends the message to the recipient's mailbox and it is delivered by whichever of these happens first:

1. the recipient is working → injected as extra context after its next tool call (Cursor `postToolUse` hook)
2. the recipient finishes a turn → submitted as its next user message (Cursor `stop` hook)
3. the recipient is idle, nobody has typed in its tmux session for `mail.quietSeconds` (default 30) and its input box is empty → one line is typed into its pane

Otherwise it waits; the command's one-line result says which happened and why.

## Command

```bash
cc-mail send (--dir <dir> | --pane <pane-id> | --window <tmux target>) [--from <who>] [--severity info|warn|attention] <text>
cc-mail pending --dir <dir>     # how many messages are waiting for the agent in <dir>
cc-mail peek --dir <dir>        # show them without delivering
```

Resolve the binary: `cc-mail` on `PATH`, then `~/.local/bin/cc-mail`, then `~/.agents/skills/cc-mail/cc-mail`. `jq` and `tmux` must be available.

## Rules

- Prefer the higher-level skills: `cc-report` to report upward, `project-task --message` to answer a task tab. Use `cc-mail` directly only for a peer you can name by directory or pane.
- One message, one line, one topic. `--from` defaults to your tmux window name.
- A message cannot answer a permission prompt or menu — those need a literal keypress, which only the Command Center specialists may send.
- Mailboxes live in `~/.config/command-center/mail/`, never inside a repo or project directory.
