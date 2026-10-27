---
name: cc-todo
description: >-
  Read and update Daniel's Command Center todo list from the shell: list todos,
  see the focus set, append progress or check-in notes, toggle focus, add or
  complete items. Use when you are the Command Center central agent handling a
  focus report ("focus: <text> — no progress for …"), when Daniel asks about his
  todos in a tmux agent chat, or when "cc-todo" is mentioned. The TUI's todos
  tab reflects changes immediately.
---

# Todos with cc-todo

The list lives in `~/.config/command-center/todos.json`; the TUI watches that file, so anything you change here shows on the todos tab at once. Notes you add are authored `central`.

```bash
cc-todo list [--all]                    # focus first, then pending; --all adds completed
cc-todo focus                           # focus set with minutes since each one's last progress
cc-todo note <id|text> <text…>          # progress note — real movement; resets the cadence clock
cc-todo note --checkin <id|text> <text…> # asked, nothing new — defers the next focus check
cc-todo focus <id|text> on|off          # into / out of the focus set (soft cap in todos.focusMax)
cc-todo add [--focus] <text…>
cc-todo done <id|text>
```

`<id|text>` is the id from `list`, a unique prefix of it, or the exact todo text.

## The focus loop (central agent)

Focus todos must keep moving during the day. The todos specialist mails you `focus: <text> — no progress for <time>` when one has gone a cadence without a progress note.

1. Check what you already know (recent reports, this conversation: an MR merged, a ticket moved, a worker finished the thing the todo is about). Real progress you can attribute → `cc-todo note <id> "<what happened>"` and say nothing.
2. Otherwise ask Daniel in one line — `Focus check: "<text>" — nothing logged since <time>. Any progress? (or say park)` — and stop.
3. His answer: progress → `cc-todo note <id> "<his words>"`; nothing yet / still on it → `cc-todo note --checkin <id> "…"`; park / drop → `cc-todo focus <id> off`.
4. Never ask about the same todo twice within a cadence window. `focus: nothing set for today` → ask once which todos (up to the cap) are today's focus and set them. A `focus day ended` recap → relay it in two or three lines.
