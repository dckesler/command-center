---
name: finalize-epic
description: Walk a finished Jira Epic to completion by reviewing each Acceptance Criterion, creating a TestRail test case for every AC that is met, and filing a follow-up Jira ticket for every AC that is not. Use when the user asks to finalize an epic, close out an epic, write TestRail tests for an epic's ACs, or audit an epic's acceptance criteria. Creates a "Finalize Epic" tracking ticket as a child of the Epic and updates it as each AC is processed. When every AC comes back met, also files a QA approval ticket asking QA to review the ACs and give the Epic final sign-off, assigns it to a QA engineer, and moves it into the QA column.
---

# Finalize Epic Skill

Review a finished Jira Epic and close it out by mapping every Acceptance Criterion to either a new TestRail test case (if the code meets it) or a follow-up Jira ticket (if it does not). Progress is tracked in a "Finalize Epic" child ticket created at the start of the run.

## Required MCP Servers

This skill requires **two** MCP servers to be connected. If either is missing, stop at the relevant detection step and tell the user — do not attempt CLI fallbacks.

- **Atlassian MCP** — for the SmartSense Jira workspace (`https://smartsensebydigi.atlassian.net`, cloud ID `3be885af-99d6-4514-939e-3c99560b10eb`).
- **TestRail MCP** — for creating test cases. The skill is written generically: it discovers the available TestRail tools at runtime rather than hard-coding tool names. See [references/testrail-mcp-workflow.md](references/testrail-mcp-workflow.md).

## Workflow

### Step 1: Detect Required MCPs

Before asking the user anything, verify both MCPs are connected.

1. **Atlassian** — call `getAccessibleAtlassianResources`. Dedupe by `cloudId` + `url`. Confirm `https://smartsensebydigi.atlassian.net` (`3be885af-99d6-4514-939e-3c99560b10eb`) is present. If not, stop and tell the user to fix the Atlassian MCP connection.
2. **TestRail** — check the available tools list for any tool whose name suggests TestRail (matches `testrail`, `test_rail`, or `tr_` case-insensitively). If none is present, stop with this exact message:

   > "I can't find a TestRail MCP server in your tool list. Please add a TestRail MCP server to your Cursor (or Claude Code) settings, then re-run `/finalize-epic`."

   Do not proceed to Step 2 without TestRail tools available.

### Step 2: Identify the Epic

Ask: "Which Epic are we finalizing? (paste a Jira URL or issue key)"

When the user replies:

1. Extract the issue key (e.g., `LW-16787`).
2. Call `getJiraIssue` with `responseContentFormat: "markdown"` against the SmartSense cloud ID.
3. Verify `issuetype.name == "Epic"`. If not, stop and report what type the issue actually is.
4. Capture: issue key, summary, description, project key, parent (rare for epics, but capture if present).

### Step 3: Find or Create the "Finalize Epic" Tracking Ticket

First, check whether a tracking ticket already exists for this Epic before creating a new one.

#### 3a. Look for an existing tracking ticket

Run this JQL via `searchJiraIssuesUsingJql` against the SmartSense cloud ID:

```
parent = <EPIC-KEY> AND summary ~ "Finalize Epic"
```

Treat a result as a match only if **both** are true:

- The summary starts with `Finalize Epic:` (or is exactly `Finalize Epic`).
- The issue is not in a `Done` / `Closed` / `Cancelled` status.

If exactly one open match is found, **reuse it**:

1. Tell the user: "Found existing tracking ticket <FINALIZE-KEY>. Reusing it."
2. Save its key as `<FINALIZE-KEY>`.
3. Skip to Step 4 — do not create a new ticket and do not edit the existing description yet (Step 5 will update bullets in place).

If multiple open matches are found, list them (key + summary + status) and ask the user which to reuse, or whether to create a fresh one.

If a previous tracking ticket exists but is in `Done` / `Closed` / `Cancelled`, treat it as absent and proceed to 3b.

#### 3b. Create a new tracking ticket

Create a Task issue type as a child of the Epic. Title: `Finalize Epic: <Epic Summary>`.

Description (markdown) — keep this exact structure so it can be updated mid-run:

```markdown
## Goal
Track close-out of <EPIC-KEY> by mapping each Acceptance Criterion to a TestRail test case or follow-up ticket.

## Parent Epic
<EPIC-KEY> — <Epic Summary>

## Acceptance Criteria Status
<one bullet per AC, populated in Step 5 — start as " - [ ] AC #N — pending review">

## Branch Id: <will be replaced with this ticket's own key after creation>
```

Follow the preview-and-confirm rule from the `jira-ticket` skill: show the full ticket payload (Workspace, Project, Issue Type=Task, Title, Description, Assignee=current user, Parent=Epic key) and wait for explicit "yes" before calling `createJiraIssue`. After creation, update the `Branch Id` line per the [jira-ticket MCP workflow](../jira-ticket/references/mcp-workflow.md).

Save this ticket key — every subsequent step appends to its description.

### Step 4: Extract Acceptance Criteria

There are three sources, tried in order. AC parsing rules and supported formats for all three are in [references/epic-workflow.md](references/epic-workflow.md).

#### 4a. Inline ACs on the Epic

Parse the Epic's description for an Acceptance Criteria section (`## Acceptance Criteria`, `### AC:`, etc.). If found, use them as-is. If any AC line carries a `[x]` marker (i.e., it was completed in a prior run), keep that mark — it tells Step 4.5 to pre-populate the local draft as `met` and skip it during the walk.

#### 4b. Confluence Requirements fallback

If no inline ACs are present, check the Epic description for a Confluence smartlink under a `## Requirements` (or similarly-named) section. Smartlinks in markdown look like:

```
<custom data-type="smartlink" data-id="...">https://<site>/wiki/spaces/<space>/pages/<pageId>/<title></custom>
```

If such a link is found:

1. Extract the page ID from the URL (or the tiny-link ID from `/wiki/x/<id>` URLs).
2. Fetch the page via `getConfluencePage` with `contentFormat: "markdown"` against the SmartSense cloud ID.
3. Locate the Requirements section in the page body using the heading rules in [references/epic-workflow.md](references/epic-workflow.md).
4. Synthesize a numbered draft AC list from the requirements prose. Each requirement bullet, sub-bullet, or "behavior" statement becomes one testable AC. Skip personas, scope summaries, and background prose.
5. Flag any inline clarifications in the source (e.g. "*Clarification needed: ...*", "*TBD*") as a separate "Open questions" list — do not turn them into ACs.
6. Show the user the full draft list **plus** the open-questions list and ask:

   > "I built these ACs from the Requirements page on Confluence. Approve this list to walk through it, or paste a refined list."

   Wait for explicit approval. If the user pastes a refined list, use that instead.

#### 4c. No ACs and no requirements link

If neither 4a nor 4b yields anything, stop and tell the user:

> "This Epic has no Acceptance Criteria and no Confluence Requirements link I could parse. Please add an `## Acceptance Criteria` section to the Epic (or a `## Requirements` smartlink to a Confluence page), then re-run `/finalize-epic`. I've already created the tracking ticket <FINALIZE-KEY> — feel free to delete it or keep it for the re-run."

Do not invent ACs. Do not silently backfill them.

#### 4d. Write ACs back to the Epic (mandatory)

Before continuing, ensure the Epic itself carries the AC list. This is the **canonical source** that future runs (and Step 4.5 carry-forward) read from.

- **If the Epic already has an Acceptance Criteria section** (4a path): leave it alone — it's already the source of truth. Do not rewrite it now.
- **If the Epic does not have one** (4b path or 4a found a non-canonical heading): append an Acceptance Criteria section as described in [references/epic-workflow.md](references/epic-workflow.md) → "ADF Write Format for the Epic". Tell the user: "Wrote N ACs to <EPIC-KEY>."

**All writes to the Epic description use ADF, not markdown.** Markdown writes break smartlinks, mentions, and other rich-text nodes already in the description. See `epic-workflow.md` for the read-modify-write procedure and node shapes.

#### Present the list

Once a list is in hand, present it once before walking. **Annotate any AC that is already in a terminal state** (read from the Epic's `[x]`, `fix tracked in <KEY>`, or `[-]` markers) so the user can see at a glance which will be walked vs. skipped.

```
Found N Acceptance Criteria on <EPIC-KEY> [from Confluence: <page title>]:
  1. [x] <AC text> — already met (TestRail <id>)
  2. [ ] <AC text> — already not met (fix tracked in <key>, still open — skipping)
  3. [ ] <AC text> — RE-WALKING: fix <key> has shipped, needs verification + a TestRail case
  4. [-] <AC text> — already skipped
  5. <AC text>
  ...

Walking <K> pending ACs (<N - K> already resolved — skipping).
```

Call out re-walked ACs distinctly, as above — the user needs to see that a previously-failing AC is coming back around because its fix landed, not silently reappearing in the walk.

Include the bracketed source note only when ACs came from Confluence (4b). The "Walking K pending" line is mandatory — it tells the user exactly what comes next.

### Step 4.5: Initialize or Resume the Local Draft

The skill keeps a working draft at `~/.finalize-epic/<EPIC-KEY>.md` for the run. The format is specified in [references/epic-workflow.md](references/epic-workflow.md) — "Local Draft File".

Resolve the draft state in this order:

1. **Existing draft file?**
   - If `~/.finalize-epic/<EPIC-KEY>.md` exists, read it. Tell the user:

     > "Found existing draft for <EPIC-KEY> at `~/.finalize-epic/<EPIC-KEY>.md` — last updated <timestamp>, <X>/<N> ACs already processed. Resume or start over?"

   - On **resume**: validate that the draft's AC count and texts match the current Epic AC list. If they match, jump to Step 5 starting at the first AC whose status is `pending`. If they drifted (AC text changed on the Epic, or count differs), stop and tell the user the diff so they can either fix the Epic or delete the draft and restart.
   - On **start over**: delete the existing draft after explicit confirmation, then continue to step 2.
2. **No draft file — create one.** Initialize from the AC list, with one section per AC. For each AC, set initial status by:
   - If the Epic AC line carries `[x]` → status `met`. If the line includes a `TestRail <case-id>` reference, capture that ID; the AC will be skipped during the walk and the existing case ID is preserved in the final Epic update. If no case ID is present, mark the case ID field as `<previously created — id unknown>`.
   - If the Epic AC line carries a `fix tracked in <KEY>` reference → **check the follow-up ticket's status** with `getJiraIssue` on `<KEY>`:
     - Follow-up is in a `done` status category → status **`pending`**, and record the key as `**Reopened from**: <KEY>` in the AC's draft section. The fix has shipped, so the AC is testable now and **must be re-walked**. It has no TestRail coverage yet — that's the whole point of the second run.
     - Follow-up is still open → status `not-met` with the key captured; skipped during the walk (nothing has changed yet).
   - If the Epic AC line carries a `[-]` marker → status `skipped`, capturing the reason.
   - Otherwise → status `pending`.
3. Save the file. Mention to the user: "Local draft initialized at `~/.finalize-epic/<EPIC-KEY>.md`."

**A shipped fix is not a verified AC.** Never carry a `not-met` AC forward as resolved just because its follow-up ticket closed — that would hand QA an AC with no test case and no verification behind it. The done follow-up is the signal to *re-test*, not to wave it through.

The draft is the **source of truth during the run.** Mid-run state changes (Step 5) write here, not to the Epic or TestRail.

### Step 5: Walk Each AC (draft, do not commit)

Process ACs strictly in order, but **only walk ACs whose draft status is `pending`**. ACs that come into Step 5 with status `met`, `not-met`, or `skipped` were resolved in a prior run or pre-marked on the Epic — do not re-prompt the user about them.

For each `pending` AC:

1. Display the AC number and full text.
2. Ask: **"Has this AC been met by the code? (yes / no / skip)"**
3. Branch on the answer.

For each non-`pending` AC encountered while walking, print one short skip line and move on — do not ask the user anything:

- `met` → `Skipping AC #N — already met (TestRail <id>).`
- `not-met` → `Skipping AC #N — already not met (fix tracked in <key>, still open).`
- `skipped` → `Skipping AC #N — previously skipped.`

When walking a **re-opened** AC (one that carries `Reopened from: <KEY>`), say so before asking, so the user knows what they're being asked to judge: `AC #N was not met last run. Fix <KEY> has since shipped. Re-verifying.`

If `pending` is `0` (every AC was already resolved coming in), tell the user: "Nothing to walk — all ACs already resolved. Jumping to commit." and proceed straight to Step 6.

#### 5a. AC met — draft a TestRail case

1. Resolve the TestRail destination once per run (cache for subsequent ACs):
   - On the first met AC, ask: "Where should the TestRail tests go? (project name, suite name, and section — or paste a TestRail URL pointing to the section)."
   - Resolve via the TestRail MCP per [references/testrail-mcp-workflow.md](references/testrail-mcp-workflow.md). On subsequent met ACs, ask only: "Same destination as AC #<prev>? (yes/no)" — if no, re-resolve.
2. Draft a test case from the AC using the format in [references/testrail-test-template.md](references/testrail-test-template.md).
3. Show the full draft and ask: **"Approve this test draft? (yes / no / edit)"** On **edit**, ask the user what to change and re-show.
4. On approval: write the draft into the local draft file under this AC's section, mark the AC `met`. **Do not call the TestRail create tool yet.**
5. Update the Finalize Epic tracking ticket bullet to `- [x] AC #N — TestRail draft queued` (per [references/epic-workflow.md](references/epic-workflow.md) update procedure). The bullet will be rewritten at end-of-run with the real case ID.

#### 5b. AC not met — draft a follow-up Jira ticket

Defer to the conventions in the `jira-ticket` skill, but **draft only — do not create**:

1. Ask the user:
   - "What should we call this ticket?"
   - "Ticket type? (Bug / Maintenance — default Bug)"
   - "Any additional info I should include?" (For Bug, prompt for environment, steps to reproduce, observed vs. expected.)
2. Auto-detect platform (`[BE]` / `[FE]` / `[MOB]`) from the AC text and Epic context per the `jira-ticket` rules.
3. Build the ticket payload using the template at [../jira-ticket/references/templates.md](../jira-ticket/references/templates.md). Set `parent` to the **Epic key**.
4. Show the full preview and ask: **"Approve this ticket draft? (yes / no / edit)"**
5. On approval: write the ticket payload into the local draft file under this AC's section, mark the AC `not-met`. **Do not call `createJiraIssue` yet.**
6. Update the tracking ticket bullet to `- [ ] AC #N — fix-it ticket queued`.

#### 5c. AC skipped

1. Ask once: "Why are we skipping? (one-line note — or hit enter to skip without a note)"
2. Mark the AC `skipped` in the local draft (with optional reason).
3. Update the tracking ticket bullet to `- [-] AC #N — skipped[: <reason>]`.

After each AC, briefly confirm the local draft update (e.g., "Saved AC #N to local draft.") and move to the next.

### Step 6: End-of-Run Commit

When all ACs are walked (or every remaining AC is non-`pending`), commit the queued work in this order. Detailed reconciliation rules — including how to preserve user edits to AC text on the Epic — are in [references/epic-workflow.md](references/epic-workflow.md) → "End-of-Run Reconciliation".

#### 6a. Show the commit plan

Print a summary of what's about to happen:

```
About to commit:
  - Create N TestRail cases in <section path>
  - Create M follow-up Jira tickets (parented to <EPIC-KEY>)
  - Rewrite the `## Acceptance Criteria` section on <EPIC-KEY> with final statuses
  - Mark the tracking ticket <FINALIZE-KEY> as complete
  - [only if the 6f gate passes] Create a QA approval ticket (parented to <EPIC-KEY>), assign it, and move it to the QA column (`IN TEST`)

Proceed? (yes / no)
```

Include the QA approval ticket line only when the 6f gate passes: every AC is `met` or `skipped`, with zero `pending` and zero `not-met` — see 6f.

Wait for explicit "yes". On "no", leave everything as-is — the local draft persists and the run can be resumed later.

#### 6b. Create queued follow-up Jira tickets

For each AC marked `not-met` whose draft has no `created_ticket_key` yet:

1. Create via the [jira-ticket MCP workflow](../jira-ticket/references/mcp-workflow.md) — including the `Branch Id` update.
   **Important:** The `parent` field is **mandatory** for follow-up tickets — always pass it as `{"key": "<EPIC-KEY>"}` (an object, not a plain string). This is what links the ticket under the Epic in Jira. After creation, verify the returned issue has a `parent` set; if it doesn't, immediately call `editJiraIssue` with `fields: {"parent": {"key": "<EPIC-KEY>"}}` to fix it before moving on.
2. Write the returned issue key back into the local draft under that AC.
3. If a create fails: stop the batch, leave the local draft intact, report which ACs succeeded/failed. The run can be resumed by re-invoking `/finalize-epic` for the same Epic.

#### 6c. Create queued TestRail cases

For each AC marked `met` whose draft has no `testrail_case_id` yet (and is not pre-populated as `<previously created — id unknown>`):

1. Create via the TestRail MCP per [references/testrail-mcp-workflow.md](references/testrail-mcp-workflow.md) → "Batch Creation".
2. Write the returned case ID (and URL if returned) back into the local draft under that AC.
3. On failure: same recovery rule as 6b — stop the batch, preserve the draft, report state.

#### 6d. Rewrite the Epic's Acceptance Criteria section

Once 6b and 6c finish without errors, update the Epic's AC section in ADF.

**Important MCP behavior:** `getJiraIssue` always returns markdown regardless of the `responseContentFormat` parameter — the true ADF document is never returned by this tool. Do not attempt a read-ADF-modify-write. Instead:

1. `getJiraIssue` for the Epic with `responseContentFormat: "markdown"` (fetch fresh, immediately before write) to get the current description content.
2. Reconstruct the full description as an ADF document, preserving all existing sections from the markdown (headings, bullet lists, bold text, inline code, etc.) and appending or replacing the `## Acceptance Criteria` section.
3. For the Acceptance Criteria section, use a **`bulletList`** — do NOT use `taskList` nodes (they are rejected by the Jira API via this MCP). Represent status with text prefixes:
   - `met` → `[x] AC #N — <text> — TestRail C<case-id>`
   - `not-met` → `[ ] AC #N — <text> — fix tracked in <ISSUE-KEY>`
   - `skipped` → `[-] AC #N — <text> — skipped[: <reason>]`
4. If a previous run already wrote a trailing reference (e.g., `— TestRail C1234`), strip it before appending the new one so references don't accumulate.
5. Call `editJiraIssue` with the full ADF document and `contentFormat: "adf"`. The `fields.description` value must be an ADF object (not a markdown string) — pass it as a JSON object, not a string.

#### 6e. Finalize the tracking ticket

Append a "## Run Complete" section to the Finalize Epic tracking ticket description with the same summary as 6g (including the QA approval ticket link, if one was created in 6f).

**Then check whether to close the tracking ticket.** Two conditions must BOTH be true:

1. Every AC is in a terminal state (`met`, `not-met`, or `skipped`) — zero ACs are `pending`.
2. Every `not-met` AC's follow-up ticket (the `created_ticket_key` in the local draft) is in a `Done` / `Closed` / `Cancelled` status in Jira.

To check condition 2: for each AC whose status is `not-met`, call `getJiraIssue` for its `created_ticket_key` and check `fields.status.statusCategory.key`. A value of `done` means the ticket is resolved.

- **If both conditions are met**: transition the tracking ticket to a `done` status:
  1. Call `getTransitionsForJiraIssue` for the tracking ticket.
  2. Filter to transitions whose target status is in the `done` status category. Prefer one named `Done` (case-insensitive); if multiple, prefer the first one returned.
  3. If no `done`-category transition is available from the current status, do not force one — append a note to the description: "Could not auto-close: no Done transition available from current status. Close manually."
  4. Otherwise call `transitionJiraIssue` with the chosen transition ID. Tell the user: "Closed tracking ticket <FINALIZE-KEY>."
- **If any ACs remain `pending`**: do NOT transition. Append a note to the description: "Tracking ticket left open: <K> ACs still pending — re-run `/finalize-epic` to walk them." Tell the user the same thing in chat.
- **If all ACs are resolved but some follow-up tickets are still open**: do NOT transition. Append a note to the description listing the open follow-up tickets (e.g., "Tracking ticket left open: follow-up tickets still open: <KEY1>, <KEY2> — re-run `/finalize-epic` after they are resolved."). Tell the user the same thing in chat.

#### 6f. Create the QA approval ticket (only if the Epic is ready for sign-off)

This step runs **only** when every AC in the local draft is either `met` or `skipped` — zero `pending`, zero `not-met`.

If anything else remains, do not create this ticket. Tell the user which and go straight to 6g:

- pending ACs remain → "Skipping QA approval ticket — <K> ACs still pending."
- `not-met` ACs remain → "Skipping QA approval ticket — <K> ACs not met, fixes still open: <KEYS>."

**A `not-met` AC only clears by being re-walked and coming back `met`** (Step 4.5 reopens it as `pending` once its follow-up ships, and 5a gives it a TestRail case). A closed follow-up ticket is *not* sufficient on its own — an AC with no test case behind it has not been verified, and must never be counted toward sign-off.

**`skipped` ACs do not block the ticket, but they must be disclosed.** Never let a skipped AC pass silently into QA sign-off — QA needs to know what went unverified.

When the gate passes:

1. **Resolve the assignee (required).** Ask: "Who should the QA approval ticket go to? (QA engineer name or email)"
   - Pass the answer to `lookupJiraAccountId` and use the returned `accountId`.
   - If the lookup returns no match, or more than one, show what came back and re-ask. Do not guess.
   - Do **not** create the ticket unassigned. If the user can't name an assignee, stop 6f and tell them: "Skipping the QA approval ticket — it needs an assignee. Re-run `/finalize-epic` once you know who owns QA sign-off." Then go to 6g.
2. Build the ticket payload per the `jira-ticket` skill's conventions:
   - Issue Type: Task
   - Title: `QA Review: <Epic Summary>`
   - Description (markdown): a short note asking QA to review each AC and its TestRail case, then give final sign-off. List **every** AC from the local draft in epic order under one numbered list — do not split into Verified / Fixed / Skipped sections. Use this shape:

     ```markdown
     ## Goal
     All acceptance criteria on [<EPIC-KEY>](<EPIC-URL>) are resolved. Please review each AC and its TestRail case, then give final QA approval.

     ## Acceptance Criteria
     1. <AC text> — [C<id>](<testrail-case-url>)
     2. <AC text> — [C<id>](<testrail-case-url>) (re-verified after <ISSUE-KEY>)
     3. <AC text> — no TestRail (skipped: <reason>)

     ## Branch Id:
     ```

     Line rules (one line per AC, same order as the Epic / local draft):
     - **`met`** — full AC text, then ` — ` and a markdown link to the TestRail case. Prefer the URL from the local draft (`testrail_case_url` / create response). If only an ID is known, build `<TestRail base URL>/index.php?/cases/view/<case_id>` when the base URL is known from earlier in the run; otherwise render plain `C<case-id>` with no link. If the AC was re-opened after a shipped fix (`Reopened from: <KEY>` in the draft), append ` (re-verified after <KEY>)` after the TestRail link.
     - **`skipped`** — full AC text, then ` — no TestRail (skipped` and, if a reason was recorded, `: <reason>`), then `)`. Skipped ACs stay in the numbered list so QA sees the full set; they must never be omitted.
     - **`met` with `<previously created — id unknown>`** — full AC text, then ` — TestRail case previously created (id unknown)`.
     - Never invent a TestRail URL. Never list only case IDs without the AC text.
   - Parent: the **Epic key**
   - Assignee: the `accountId` resolved in step 1
3. Show the full ticket preview — including **Assignee** and the line "Will be moved to the QA column (`IN TEST`) after creation" — and ask: **"Approve this QA ticket? (yes / no / edit)"** On **edit**, ask what to change and re-show.
4. On approval, create it via the [jira-ticket MCP workflow](../jira-ticket/references/mcp-workflow.md), passing `assignee_account_id`, and including the `Branch Id` update.
5. **Verify the assignee stuck.** Call `getJiraIssue` for the new key with `fields: ["assignee", "status"]`. If `assignee` is null, immediately call `editJiraIssue` with `fields: {"assignee": {"id": "<accountId>"}}`.
6. **Move it to the QA column** — see 6f-i below.
7. Save the returned issue key — it's included in the end-of-run summary (6g) and appended to the Finalize Epic tracking ticket's "## Run Complete" section (6e).
8. If the create fails: report it, but do not roll back anything else already committed in 6b/6c/6d/6e — this ticket can be created later by re-running `/finalize-epic` (it will detect all ACs are already resolved and offer this step again).

##### 6f-i. Transition the QA ticket into the QA column

The QA column in the SmartSense LW workflow is the status **`IN TEST`** (status id `10004`, reached by the transition named `In Test`). A newly created ticket lands in `Backlog`, and `In Test` is **not** directly available from there — it is only offered from `IN CODE REVIEW`. So the ticket has to be walked forward one transition at a time.

Walk it like this, re-reading transitions before every hop:

1. Call `getTransitionsForJiraIssue` for the QA ticket.
2. If a transition whose target status name matches the QA column (`IN TEST`, or case-insensitively any of `in test`, `in qa`, `ready for qa`, `qa`, `testing`) is available, take it with `transitionJiraIssue` and stop — you're done.
3. Otherwise take the next transition along this forward path, matching by **target status name** (case-insensitive), not by transition id — ids are workflow-specific and change between projects:

   `Selected for Development` → `In Progress` → `IN CODE REVIEW` → `IN TEST`

   Pick the first status in that list that is *after* the ticket's current status and is available as a transition target right now. In the LW workflow this resolves to `In Progress` → `IN CODE REVIEW` → `In Test` — three hops from `Backlog`.
4. Repeat from step 1. Cap the walk at **5 hops**.
5. NEVER take a transition whose target status is in the `done` status category (`Done`, `Closed`), and never take `Blocked` — those are dead ends that would strand the ticket.
6. After the walk, call `getJiraIssue` with `fields: ["status"]` and confirm the status is the QA column. Tell the user: "QA ticket <QA-KEY> assigned to <Display Name> and moved to `IN TEST`."
7. **If the walk can't reach the QA column** (no forward transition available, or the 5-hop cap is hit): do not force anything and do not delete the ticket. Report it plainly — "Created QA ticket <QA-KEY> assigned to <Display Name>, but couldn't move it past `<current status>` — the `In Test` transition wasn't available. Move it to the QA column manually." — and continue to 6g. The rest of the run stands.

#### 6g. Post the summary in chat

```
Finalized <EPIC-KEY>:
  ✓ Met (N): <AC#> → TestRail <case-id>, ...
  ✗ Follow-ups (M): <AC#> → <ISSUE-KEY>, ...
  - Skipped (K): <AC#>, ...

Epic updated:        <EPIC-URL>
Tracking ticket:     <FINALIZE-URL>
QA approval ticket:  <QA-TICKET-URL>  [only if created in 6f]
                     assigned to <Display Name> — <final status>

Local draft:         ~/.finalize-epic/<EPIC-KEY>.md
```

#### 6h. Local draft cleanup

Ask: **"Keep or delete the local draft? (keep / delete — default keep)"** Default to keep so the user can audit what was committed.

Do not transition the Epic itself. The user closes the Epic manually after they've reviewed everything. The skill only auto-closes the **tracking ticket**, and only if every AC is resolved.

## Critical Rules

- NEVER create a TestRail case or a follow-up Jira ticket during Step 5. All creates are batched in Step 6.
- NEVER move past Step 5 for an AC without an approved draft (TestRail draft, ticket payload, or skip reason) saved to the local draft file.
- NEVER skip Step 6a's commit-plan confirmation — the user must explicitly approve the batch before any creates happen.
- NEVER silently switch Atlassian workspaces — SmartSense only.
- NEVER fall back to a CLI when an MCP server is unavailable. Stop and ask the user to fix the connection.
- NEVER invent Acceptance Criteria. If the Epic has none and no Confluence Requirements link is parseable, stop and ask the user to add them in Jira.
- When ACs come from a Confluence Requirements page, ALWAYS show the synthesized draft and get explicit approval before walking it.
- ALWAYS process ACs in the order they appear in the Epic description.
- ALWAYS skip ACs whose initial status (read from the Epic at Step 4.5) is already `met`, `not-met`, or `skipped` — do not re-prompt the user about resolved ACs.
- ALWAYS link follow-up fix-it tickets as children of the **Epic**, not the Finalize Epic tracking ticket.
- ALWAYS update the Finalize Epic tracking ticket bullet after each AC during Step 5 — Jira watchers see live progress, even though the Epic itself is only updated at end-of-run.
- ALWAYS preserve the existing Finalize Epic description when editing — fetch current, swap one bullet, save full string.
- ALWAYS preserve the user's AC text on the Epic at end-of-run — only the taskItem `state` and the trailing reference text are rewritten in Step 6d.
- ALWAYS read and write the Epic description as **ADF** (Atlassian Document Format) — never markdown. Markdown writes destroy smartlinks (Confluence/SharePoint previews), mentions, and other rich-text nodes already in the description. The tracking ticket and fix-it tickets keep markdown — only the **Epic** is ADF.
- ALWAYS leave the local draft intact when a batch create fails — the run is resumable.
- ONLY close (transition to `done`) the tracking ticket when (1) every AC is in a terminal state (`met`, `not-met`, or `skipped`) AND (2) every `not-met` AC's follow-up Jira ticket is in a `done` status category. If any AC is still `pending`, or any follow-up ticket is still open, leave the tracking ticket open so the next `/finalize-epic` run can check again.
- NEVER transition the Epic itself.
- ONLY create the QA approval ticket (Step 6f) when every AC is `met` or `skipped` — zero `pending`, zero `not-met`.
- NEVER treat a closed follow-up ticket as verification of its AC. A shipped fix means the AC is now *testable*, not *tested*: Step 4.5 reopens it as `pending` so it gets re-walked and earns a TestRail case. An AC with no test case behind it must never count toward QA sign-off.
- ALWAYS re-walk a `not-met` AC once its follow-up ticket reaches a `done` category — that re-verification is the primary purpose of a second `/finalize-epic` run on the same Epic.
- ALWAYS list every AC (met and skipped) in epic order in the QA approval ticket's numbered `## Acceptance Criteria` list, with a TestRail case link for each `met` AC and an explicit `no TestRail (skipped[: reason])` note for each skipped AC. Skips do not block the ticket, but QA must never be asked to sign off without seeing what went unverified.
- NEVER create the QA approval ticket without an explicit assignee from the user and explicit approval of the ticket preview — same preview-and-confirm rule as every other Jira create in this skill.
- ALWAYS resolve the QA assignee through `lookupJiraAccountId` and pass `assignee_account_id` at create time, then verify it stuck with `getJiraIssue`. NEVER leave the QA approval ticket unassigned — an unassigned ticket sitting in the QA column is invisible work.
- ALWAYS move the QA approval ticket into the QA column (`IN TEST`) after creating it, walking the workflow one transition at a time and matching on target **status name**, not transition id. NEVER take a `done`-category or `Blocked` transition while walking. If the QA column can't be reached, leave the ticket where it landed and tell the user to move it manually — do not force a transition and do not delete the ticket.
- ALWAYS link the QA approval ticket as a child of the **Epic**, not the Finalize Epic tracking ticket.

## Reference Files

- **TestRail MCP tool detection and usage**: [references/testrail-mcp-workflow.md](references/testrail-mcp-workflow.md)
- **Test case format drafted from an AC**: [references/testrail-test-template.md](references/testrail-test-template.md)
- **AC parsing rules and tracking-ticket structure**: [references/epic-workflow.md](references/epic-workflow.md)
- **Jira MCP workflow (used for tracking ticket and fix-it tickets)**: [../jira-ticket/references/mcp-workflow.md](../jira-ticket/references/mcp-workflow.md)
- **Jira ticket templates**: [../jira-ticket/references/templates.md](../jira-ticket/references/templates.md)
