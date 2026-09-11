# Epic Workflow Reference

How to parse Acceptance Criteria from a Jira Epic, how the local draft file is structured, how to keep the "Finalize Epic" tracking ticket in sync mid-run, and how end-of-run commits reconcile the local draft back into the Epic and TestRail.

## Acceptance Criteria Parsing

Fetch the Epic with `getJiraIssue` using `responseContentFormat: "markdown"`. Then locate the AC section in the description.

### Heading variants to recognize (case-insensitive)

The skill must tolerate any of these heading forms:

- `## Acceptance Criteria`
- `### Acceptance Criteria`
- `**Acceptance Criteria**`
- `Acceptance Criteria:` (plain line followed by a list)
- `AC:` (plain line followed by a list)
- `## ACs` / `## AC`

The AC section ends at the next heading of equal-or-shallower level, or at the end of the description.

### Item formats to recognize

Inside the AC section, accept any of these as individual ACs:

- Bulleted list (`- `, `* `, `+ `)
- Numbered list (`1.`, `2.`, …)
- Checkbox list (`- [ ]`, `- [x]`, `1. [x] ...`) — **the checked state IS meaningful**: a `[x]` AC is treated as already met by a prior run and pre-populated as `met` in the local draft (Step 4.5), so the user is not re-prompted for it. If the line includes a trailing `— TestRail <id>` reference, capture that ID. If it includes `— fix tracked in <KEY>`, treat the AC as `not-met` with that ticket key.
- Plain paragraphs separated by blank lines (only if no list markers are present)

Strip leading/trailing whitespace and any "Given/When/Then" formatting markers but keep the prose intact.

### Empty-section handling

If the AC section exists but contains no items (just whitespace, or only a "TBD" / "TODO" placeholder), treat it as missing and stop with the same message as if the section were absent.

### Multiple AC sections

If more than one heading matches (rare but possible), concatenate items in document order and inform the user: "Found ACs in multiple sections — combining them in order."

## Confluence Requirements Fallback

When the Epic has no inline ACs, the skill falls back to a linked Confluence Requirements page. This is interpretive — the Confluence page is rarely written as a flat AC list, so the skill synthesizes ACs and asks the user to approve the draft.

### 1. Detect the smartlink

Look in the Epic description (markdown form) for a section heading whose text contains "Requirements" (case-insensitive) — e.g., `## Requirements:`, `### Requirements`, `**Requirements**`. Underneath or on the same line, find a Confluence smartlink. Smartlinks render in markdown as:

```
<custom data-type="smartlink" data-id="...">https://<site>/wiki/...</custom>
```

The URL inside the tag is what you parse. Accept these URL shapes:

- `https://<site>/wiki/spaces/<spaceKey>/pages/<pageId>/<slug>` — the **pageId** is the long numeric segment.
- `https://<site>/wiki/spaces/<spaceKey>/pages/<pageId>/<slug>#<anchor>` — same; the `#anchor` is informational only (used to confirm we're aiming at a Requirements section), not passed to the API.
- `https://<site>/wiki/x/<tinyId>` — pass the tinyId as `pageId` to `getConfluencePage`; the MCP accepts tiny-link IDs.

Reject smartlinks whose URL is not a `/wiki/` Confluence path. If multiple Confluence smartlinks appear in the description, pick the one closest to the "Requirements" heading. If none is near a Requirements heading, ask the user which link to use rather than guessing.

### 2. Fetch the page

Call `getConfluencePage` with the SmartSense cloud ID and `contentFormat: "markdown"`. If the page can't be fetched, stop and report the error — do not attempt CLI fallbacks.

### 3. Locate the Requirements section in the page

In the fetched page body, find a heading containing "Requirements" (the heading itself may be `## **Requirements**:` with bold + colon — match the inner text case-insensitively after stripping markdown). The section ends at the next heading of equal-or-shallower level, or at the end of the body.

If multiple Requirements-shaped headings exist, prefer the top-level one (e.g., `##` over `###`). Tell the user which heading was used.

### 4. Synthesize ACs from the section

Walk the section content in document order. Each of the following becomes a candidate AC:

- A bullet describing observable behavior (e.g., "All boxes are unchecked by default")
- A bullet describing UI structure visible to a tester (e.g., "Below the X section, display a new Y section")
- A bullet describing a constraint or rule (e.g., "The role list never includes location-level roles")
- A nested bullet that adds testable specificity to its parent — promote it to its own AC if it's independently verifiable; otherwise fold it into the parent's wording

**Exclude** these — they are not testable as individual ACs:

- Persona descriptions, user needs, and motivations (typically under a "User Personas", "Goals", or "Problem" heading inside the section)
- Scope summaries and "high-level overview" prose
- Pure background or design rationale
- Links to designs or external docs (capture the link in chat once, do not turn it into an AC)

**Flag separately** as Open Questions:

- Inline notes like "*Clarification needed: …*", "*TBD*", "*to be decided*", "*see recommendations below*"
- Bullets that explicitly reference unresolved decisions
- Any heading whose body is empty or a placeholder

Do not turn open questions into ACs — list them under the draft so the user can resolve them with the team before walking the list.

### 5. Draft format shown to the user

Present the synthesized list like this:

```
ACs synthesized from Confluence: <Page Title>
Source heading: <e.g., "Requirements" under "FUAR: User Setup UI - FE">

Draft Acceptance Criteria:
  1. <AC text>
  2. <AC text>
  ...

Open questions flagged in the source:
  - <verbatim or paraphrased clarification>
  - ...
```

Then ask: **"Approve this list to walk through it, or paste a refined list."** Wait for explicit approval. If the user pastes a refined list, replace the synthesized one wholesale.

### 6. Mandatory write-back to the Epic

After the user approves the synthesized list, the skill **always** writes it back to the Epic so the Epic becomes the canonical AC source. See SKILL.md Step 4d. **All Epic writes use ADF** — see "ADF Write Format for the Epic" below for the procedure and node shapes. This is *only* done on the 4b path. The 4a path leaves the existing AC section as-is.

## Local Draft File

The local draft at `~/.finalize-epic/<EPIC-KEY>.md` is the **source of truth during the run**. The Epic and TestRail are only written at end-of-run (Step 6). The tracking ticket is a Jira-visible mirror but is not authoritative.

### Path

`~/.finalize-epic/<EPIC-KEY>.md` — one file per Epic. The skill creates the `~/.finalize-epic/` directory on first use.

### File format

The format is human-readable markdown so the user can audit it. The skill reads and writes it deterministically using the section headers below.

```markdown
# Finalize Epic Draft: <EPIC-KEY>

**Epic**: <EPIC-KEY> — <Epic Summary>
**Tracking ticket**: <FINALIZE-KEY>
**AC source**: inline | confluence:<page-id>
**Created**: <ISO-8601>
**Last updated**: <ISO-8601>

**TestRail destination** (default — set on first met AC):
- Project: <name> (id <id>)
- Suite: <name> (id <id>)
- Section: <full path> (id <id>)

---

## AC #1 — <status>

**Text**: <verbatim AC text>

**TestRail draft** (when status is `met`):
- Section: <path> (id <id>)
- Title: <title>
- Type: <type>
- Priority: <priority>
- Preconditions: <preconds or "None">
- Steps:
  1. <action>
     - Expected: <outcome>
  2. <action>
     - Expected: <outcome>

**TestRail case ID**: <id-or-"queued">

**Follow-up ticket draft** (when status is `not-met`):
<full ticket payload — Title, Type, Description body, Parent>

**Created ticket key**: <key-or-"queued">

**Skip reason** (when status is `skipped`): <reason or empty>

---

## AC #2 — <status>
...
```

Status values: `pending`, `met`, `not-met`, `skipped`. Only one of the three optional blocks (`TestRail draft`, `Follow-up ticket draft`, `Skip reason`) is filled per AC, matching its status.

### Initialization (Step 4.5)

When no draft file exists:

1. Create `~/.finalize-epic/` if missing.
2. Write the header block with metadata.
3. Append one `## AC #N — <status>` section per AC. For each AC, set the initial status by reading the Epic's AC line:
   - Line is `1. [x] <text> — TestRail <id>` → status `met`, capture `<id>`, no draft block needed.
   - Line is `1. [x] <text>` (no trailing reference) → status `met`, case ID = `<previously created — id unknown>`.
   - Line is `1. [ ] <text> — fix tracked in <KEY>` → status `not-met`, capture `<KEY>`.
   - Line is `1. [-] <text> — skipped[: <reason>]` → status `skipped`, capture reason.
   - Otherwise → status `pending`.
4. Save.

### Resume detection (Step 4.5)

When the draft file already exists:

1. Read the file. Parse out the AC list, statuses, and TestRail destination.
2. Compute counts: `<resolved>/<total>` where resolved = met + not-met + skipped.
3. Ask the user: "Found existing draft for <EPIC-KEY> (last updated <timestamp>, <resolved>/<total> ACs already processed). Resume or start over?"
4. **On resume**: validate the draft's AC count and texts match the current Epic AC list. If both match, jump directly to Step 5 starting at the first `pending` AC. If they drifted:
   - If the user has edited AC text on the Epic since the draft was written, prefer the Epic's text — update the draft's `**Text**` field for that AC and continue.
   - If the AC count differs (Epic has more or fewer ACs), stop and tell the user: "The Epic now has <N> ACs but the draft has <M>. Resolve manually before continuing — either align the Epic to the draft, or delete the draft and restart."
5. **On start over**: prompt "Delete `~/.finalize-epic/<EPIC-KEY>.md` and start fresh? (yes / no)". Only delete on explicit "yes". Then re-initialize per the rules above (which still honors `[x]` marks already on the Epic).

### Mid-run updates (Step 5)

After the user approves a TestRail draft, follow-up ticket draft, or skip reason:

1. Read the entire draft file.
2. Find the matching `## AC #N — <prev-status>` section.
3. Replace that section's content (keep the header, update status in the header line, fill in the relevant block).
4. Update the file's `**Last updated**` timestamp.
5. Save the entire file.

Never patch a single field — always rewrite the AC section in full to avoid leaving stale draft data.

## End-of-Run Reconciliation

Step 6 commits the local draft to Jira and TestRail. The order matters: Jira fix-it tickets first, TestRail second, then the Epic update last (so the Epic update can include real IDs from both).

### Order of operations

1. **Jira fix-it tickets** (Step 6b) — for each AC with status `not-met` and `created_ticket_key` empty, create the ticket via `jira-ticket` MCP workflow. Write the returned key into the draft.
2. **TestRail cases** (Step 6c) — for each AC with status `met` and `testrail_case_id` empty/`queued` (not `<previously created — id unknown>`), create the case. Write the returned ID into the draft.
3. **Epic AC section rewrite** (Step 6d) — see below.

### Rewriting the Epic AC section (Step 6d)

The skill **preserves the user's AC text** on the Epic. Only the `taskItem` `state` and the trailing reference text are updated. The full read-modify-write procedure and the ADF node shapes are in "ADF Write Format for the Epic" below.

### Failure recovery

If a create call fails mid-batch (Step 6b or 6c):

1. Stop the batch immediately.
2. Leave the local draft intact — successful creates have already been written back to the draft, so resuming will not duplicate them.
3. **Do not** start Step 6d if 6b or 6c failed — partial Epic updates are confusing.
4. Report which ACs succeeded, which failed (with the error), and that the run is resumable by re-invoking `/finalize-epic` for the same Epic.

## ADF Write Format for the Epic

All writes to the Epic description must use ADF (Atlassian Document Format), never markdown. Markdown writes destroy smartlinks, mentions, and other rich-text nodes already in the description: when the markdown→ADF parser sees a placeholder string like `<custom data-type="smartlink" data-id="id-0">URL</custom>`, it does not recognize it and either treats it as plain text or drops it entirely.

This rule applies to the **Epic only**. The tracking ticket and fix-it tickets are authored entirely by the skill (no preexisting rich nodes to lose) and continue to use markdown.

### Read once for parsing, fetch fresh for writes

The skill reads the Epic in markdown (`responseContentFormat: "markdown"`) for AC parsing and display — that is fine because we only consume the text. When the skill is about to **write** to the Epic, fetch a fresh copy in ADF (`responseContentFormat: "adf"`) immediately before the write. This minimizes the window for the user to edit the description between read and write, and gives us the lossless tree to mutate.

### The AC section as ADF

When the skill creates the Acceptance Criteria section (Step 4d), append two top-level nodes to the Epic document's `content` array, in this order:

1. A `heading` node with level 2 and text "Acceptance Criteria":

   ```json
   {
     "type": "heading",
     "attrs": { "level": 2 },
     "content": [{ "type": "text", "text": "Acceptance Criteria" }]
   }
   ```

2. A `taskList` node containing one `taskItem` per AC. Each `taskItem` starts with `state: "TODO"` and a single `paragraph` child whose text is the AC text:

   ```json
   {
     "type": "taskList",
     "attrs": { "localId": "ac-list" },
     "content": [
       {
         "type": "taskItem",
         "attrs": { "localId": "ac-1", "state": "TODO" },
         "content": [
           { "type": "paragraph", "content": [{ "type": "text", "text": "<AC #1 text>" }] }
         ]
       },
       {
         "type": "taskItem",
         "attrs": { "localId": "ac-2", "state": "TODO" },
         "content": [
           { "type": "paragraph", "content": [{ "type": "text", "text": "<AC #2 text>" }] }
         ]
       }
     ]
   }
   ```

Use stable `localId` values (`ac-1`, `ac-2`, …) so the tree is deterministic and the skill can locate task items reliably on subsequent runs.

Do **not** use a numbered `orderedList` with embedded `[ ]` text — that's the markdown shape, and it doesn't render as a checkbox in Jira. `taskList` is the correct ADF node for our `[ ] / [x]` semantics.

### End-of-run AC updates as ADF

For Step 6d, locate the Acceptance Criteria heading + `taskList` in the fetched ADF tree. For each `taskItem` in that list (matched by position to local-draft AC #N):

1. Read the existing paragraph text from the `taskItem`'s first paragraph child. **Preserve it as-is** — this is the user-edited AC text.
2. Strip any prior trailing reference the skill added in a previous run. Look for these suffixes (in order, take the first match) and remove from the text:
   - ` — TestRail <id>` (or ` — TestRail <id> (<url>)`)
   - ` — fix tracked in <KEY>`
   - ` — skipped: <reason>` (or just ` — skipped`)
3. Update the `taskItem`'s `state` attribute:
   - `met` → `"DONE"`
   - `not-met` → `"TODO"`
   - `skipped` → `"TODO"`
4. Append the new trailing reference to the paragraph text:
   - `met` → ` — TestRail <case-id>` (if a URL is known, render the case ID as a `text` node with a `link` mark: `[{type:"text", text:"<case-id>", marks:[{type:"link", attrs:{href:"<url>"}}]}]`)
   - `not-met` → ` — fix tracked in <ISSUE-KEY>` (issue key may be a plain text node; if you want it linkified, add a `link` mark with `href` set to the Jira issue URL)
   - `skipped` → ` — skipped[: <reason>]`
5. Leave the rest of the document untouched.
6. Call `editJiraIssue` with the full ADF document — pass it as the `description` field. Use `contentFormat: "adf"` (or omit, since ADF is the API default).

### Locating the AC section in ADF

When parsing the fetched ADF document to find the AC section:

1. Walk the top-level `content` array of the document.
2. Find a `heading` node whose `attrs.level` is 2 and whose flattened text matches "Acceptance Criteria" (case-insensitive, trimmed). If multiple match, prefer the one created by the skill (heading immediately followed by a `taskList` with matching `localId` `ac-list`). If still ambiguous, use the first.
3. The next node in the `content` array (or the next `taskList` skipping over any `paragraph` separator) is the AC list.

If the heading exists but the next node is not a `taskList` (e.g., the user converted the section to a `bulletList` or numbered list manually), do NOT auto-convert it — stop and tell the user: "The AC section on the Epic is no longer a task list. Convert it back, or delete the section so the skill can recreate it."

### What is preserved

Because the skill only mutates the AC `taskList`'s items (and never re-serializes the whole document through markdown), every other node in the Epic description is preserved exactly as Jira returned it: smartlinks, mentions (`@user`), inline cards, panels, status pills, code blocks, layout columns, tables, embedded media, etc.

## Finalize Epic Tracking Ticket

### Title

`Finalize Epic: <Epic Summary>`

### Description structure

The description is built once at creation time and edited in place as ACs are processed. Keep this exact structure so single-line edits are reliable:

```markdown
## Goal
Track close-out of <EPIC-KEY> by mapping each Acceptance Criterion to a TestRail test case or follow-up ticket.

## Parent Epic
<EPIC-KEY> — <Epic Summary>

## Acceptance Criteria Status
- [ ] AC #1 — pending review
- [ ] AC #2 — pending review
- [ ] AC #3 — pending review
...

## Branch Id: <FINALIZE-KEY>
```

At end-of-run, append a `## Run Complete` section with the final summary (per SKILL.md Step 6e), then conditionally close the ticket — see "End-of-Run Closeout" below.

### End-of-Run Closeout

The tracking ticket is auto-transitioned to a `done` status **only** when every AC in the local draft is in a terminal state (`met`, `not-met`, or `skipped`). If any AC is still `pending`, leave the ticket open.

Procedure when all ACs are terminal:

1. Call `getTransitionsForJiraIssue` for the tracking ticket.
2. From the returned transitions, filter to ones whose target status's `statusCategory.key` equals `done`.
3. If exactly one matches, use it. If multiple match, prefer the transition named `Done` (case-insensitive); if still ambiguous, take the first.
4. If no `done`-category transition is reachable from the current status, do not transition. Append a note to the description: `Could not auto-close: no Done transition available from current status. Close manually.`
5. Otherwise call `transitionJiraIssue` with the chosen transition ID.

If any AC is still `pending`, append this note instead: `Tracking ticket left open: <K> ACs still pending — re-run /finalize-epic to walk them.`

### Why gate closeout on full resolution

A tracking ticket whose ACs are partially resolved means the user paused mid-run (or left some ACs as a deliberate to-do). Auto-closing would lose that signal. The gate ensures the ticket itself is the indicator of "is the close-out done."

### Bullet states

The tracking ticket has two distinct phases — mid-run (queued) and post-commit (resolved). Mid-run bullets reflect the local draft's state; post-commit bullets reflect what was actually created.

| Phase | State | Bullet format |
|---|---|---|
| Pending | not yet walked | `- [ ] AC #N — pending review` |
| Mid-run | met (draft queued) | `- [x] AC #N — TestRail draft queued` |
| Mid-run | not met (draft queued) | `- [ ] AC #N — fix-it ticket queued` |
| Mid-run | skipped | `- [-] AC #N — skipped[: <reason>]` |
| Post-commit | met (created) | `- [x] AC #N — TestRail case <CASE-ID>` (append URL if returned) |
| Post-commit | not met (created) | `- [ ] AC #N — fix tracked in <ISSUE-KEY>` |
| Post-commit | skipped | unchanged from mid-run |

### Update procedure (every AC)

To update one bullet without disturbing the rest of the description:

1. Call `getJiraIssue` for the Finalize Epic ticket with `responseContentFormat: "markdown"`.
2. Read `description`.
3. In memory, find the line beginning with `- [ ] AC #<N> ` or `- [x] AC #<N> ` or `- [-] AC #<N> ` and replace the **entire line** with the new bullet.
4. Call `editJiraIssue` with the full updated description string and `contentFormat: "markdown"`.

Never write only the bullets — always pass the complete description string back.

### Why update mid-run and at end-of-run

Mid-run updates give Jira watchers visible progress without opening the Epic or the local draft file. End-of-run updates replace the "queued" placeholders with real IDs once Step 6 finishes.

## AC Numbering

Number ACs by their order in the Epic description (1-indexed). Do not re-number across runs.

## Reusing an Existing Tracking Ticket

When Step 3 reuses an open tracking ticket, treat the tracking ticket bullets as a **display mirror**, not the source of truth — the local draft (or the Epic's `[x]` marks if no draft exists) is what determines which ACs get walked.

Edge cases when reusing:

- **AC count changed since the tracking ticket was created** — the count check happens at Step 4.5 against the local draft, not against the tracking ticket. If counts differ between the local draft and the Epic, see Step 4.5 resume rules. The tracking ticket bullets are simply rewritten to match the new AC count.
- **AC text changed** — bullets reference `AC #N`, not the AC text, so text changes on the Epic don't affect the tracking ticket. The Epic is the canonical text source.
- **Stale bullets from a prior run** — if the tracking ticket has bullets like "TestRail draft queued" or "fix-it ticket queued" but the local draft says those ACs were already committed, rewrite the bullets to the post-commit form during Step 5 / Step 6 as appropriate. If a bullet says committed but the local draft has no record, trust the bullet — a previous run committed it before the local draft existed.
