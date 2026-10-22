---
name: share-links
description: Print the GitLab MR and Jira ticket links for the work in the current chat as a three-line block Daniel can copy and paste into a chat, with a one-line summary and the 🔗 MR / 🎟 Jira icons. Live status goes below the block, never inside it. Use when Daniel says "give me the links", "links for this", "share links", "MR and ticket links", or invokes /share-links.
---

# Share Links

Give Daniel the MR and ticket for the work in this chat, ready to paste into Teams or Slack.

## Output

A fenced `text` block with exactly three lines, and nothing else in it:

```text
<KEY>: <one-line summary>
🔗 MR: <MR URL>
🎟  Jira: https://smartsensebydigi.atlassian.net/browse/<KEY>
```

- The icons and spacing match `/babysit-branch`'s final output: `🔗 MR:` and `🎟  Jira:` with two spaces.
- Use the plain URL. Chat apps turn it into a link. Don't write markdown links inside the block.
- The summary says what the change does, for someone who hasn't seen the ticket. Use plain words, about 8–15 words, with no `[FE] (fix) -` prefix, status or MR number. Example: `LW-18050: Close the instance drawer instead of crashing when its instance no longer exists`.
- If there is no MR yet, leave out the `🔗 MR:` line. If there is no ticket, leave out the `🎟  Jira:` line and start the summary with `!<iid>:`. Never add placeholders.
- With several tickets or MRs in the chat, print one block per ticket, most recent first. Ask only if you can't tell which one Daniel means.

Under the block, outside it, print the status from **Status**.

## Find the ticket and MR

Use the chat first. It usually already has the ticket key, MR URL, ticket summary and what was changed. Only look up what's missing:

1. **Ticket key**: from the chat. If not there, use the current branch: `git rev-parse --abbrev-ref HEAD`, matched with `[A-Z]+-\d+`.
2. **MR URL**: from the chat. If not there, run `glab mr list --source-branch "$(git rev-parse --abbrev-ref HEAD)" -F json | jq -r '.[0].web_url // empty'`. If that's empty, check the ticket's `## Merge Request` section.
3. **Summary**: write it from what the chat says was actually done. That beats the ticket title, which may be a first guess. If the chat has little, read the ticket summary and description with `getJiraIssue` (Atlassian MCP; `acli` as the `jira-ticket` skill describes, if MCP is unavailable).

Cloud ID for Jira calls: `3be885af-99d6-4514-939e-3c99560b10eb`.

## Status

Look these up live, then print them as a short list after the block:

- **Jira**: status and assignee, from `getJiraIssue` fields `status` and `assignee`.
- **MR**: state, draft or ready, pipeline status, approvals, and anything blocking merge.

  ```bash
  glab mr view <iid> -F json | jq -r '"\(.state) draft=\(.draft) pipeline=\(.head_pipeline.status // "none") merge=\(.detailed_merge_status)"'
  glab api "projects/:id/merge_requests/<iid>/approvals" | jq -r '[.approved_by[].user.name] | join(", ")'
  ```

For example:

```
• Jira: IN CODE REVIEW, Daniel Kesler
• MR: ready, pipeline passed, approved by Jane Doe, mergeable
```

If a lookup fails, say so in that status line. The block above stays as it is.

Don't edit anything. This skill only reads.
