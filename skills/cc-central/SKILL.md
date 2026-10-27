---
name: cc-central
description: >-
  Start, restart or inspect Command Center's central manager agent — cursor-cli
  running in a tmux pane under the Command Center TUI (config central.mode =
  tmux). Use when the central agent pane is missing or quit, when Daniel says
  "start the central agent", "restart central", "where is central", or when
  "cc-central" is mentioned. The TUI runs `cc-central ensure` itself on start.
---

# The tmux central agent (cc-central)

With `central.mode: "tmux"` the manager is not an SDK agent inside the TUI but `commands.agent` (cursor-cli, model `central.model` or `commands.projectModel`) in a pane of the Command Center window. Specialists reach it through cc-mail; it steers everything with `cc-instruct`; tab 1 of the TUI shows its conversation read-only.

```bash
cc-central ensure [--window <target>]   # start unless one runs (idempotent)
cc-central start  [--window <target>]   # start now; refuses while one runs
cc-central status                       # pane, hook state, pending mail, prompt/log paths
cc-central pane                         # pane id (exit 1 when none)
cc-central prompt                       # rewrite the prompt file and print its path
```

- **Window**: `--window`, else the window marked `@cc_role=command-center`, else the window of the pane you run it from, else one named `Command Center`.
- **Pane**: the registered `@agent_pane` if the agent quit and left a shell; else a shell pane on the TUI's row to its right; else the TUI is split in half (dashboard left, central right). Panes on the bottom row are the user's terminals and are never taken.
- **Directory**: `central.dir` (default `~/.config/command-center/central`) — the agent's cwd, mailbox address, `prompt.txt` and `LOG.md`. Nothing else should run there.

To restart with a fresh prompt: quit the agent in its pane (`ctrl+c` twice), then `cc-central ensure`. The log survives; the new session opens by reading it.
