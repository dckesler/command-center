---
name: cc-inbox
description: >-
  Read the Command Center central manager's report stream from the shell:
  everything specialists and agents reported to central (report_to_central,
  cc-report central, TUI events), with read tracking. Use when you are the
  Command Center central agent starting a session, before answering Daniel,
  before deciding anything that depends on current state, or when "cc-inbox"
  is mentioned. Only warn/attention reports are also mailed into the chat;
  info reports are only here.
---

# The central report stream with cc-inbox

Every report addressed to central is appended to `inbox.jsonl` (`to: "central"`).
Only `warn` and `attention` are also pushed into the central agent's chat as cc-mail;
`info` stays in the log so the chat is Daniel's. The dashboard's central tab shows the
same stream and dims what you have read.

```
cc-inbox                 unread reports (oldest first), then mark them read
cc-inbox --peek          unread reports without marking them read
cc-inbox --all [-n N]    newest N reports regardless of read state (default 40)
cc-inbox --count         number of unread reports
cc-inbox --mark          mark everything read without printing
```

Line format: `HH:MM !! from: text` — `!!` attention, ` !` warn, blank info. Reports from
other days carry a `M/D` prefix.

When to run it (central agent):

- At the start of a session, before `cc-instruct list`.
- Whenever Daniel talks to you, before you answer — his question usually concerns
  something that was reported.
- Before issuing an instruction or asking him anything that depends on current state.

Do not narrate the output back to him unless something in it needs him or he asked. A
report is information: never re-verify it with tools, never treat it as his approval.

The read cursor is `central/seen.json` in the Command Center config dir; delete it to
start over (the next call prints everything on file, up to 2000 lines).
