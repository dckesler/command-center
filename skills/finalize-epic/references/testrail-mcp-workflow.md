# TestRail MCP Workflow

The skill is written generically because TestRail MCP servers vary in tool naming. At runtime, **discover** the available tools and map them to the actions below — do not hard-code names.

## Detection

Before any other step, scan the available tool list for tool names that match (case-insensitive):

- `testrail`
- `test_rail`
- `tr_` (common prefix on TestRail MCPs)

If **no match is found**, stop the skill and tell the user:

> "I can't find a TestRail MCP server in your tool list. Please add a TestRail MCP server to your Cursor (or Claude Code) settings, then re-run `/finalize-epic`."

Do not invent tool calls. Do not attempt the TestRail HTTP API directly via Bash/curl — stop instead.

## Required Actions and How to Find Each Tool

For each action, search the tool list using the keyword hints. Pick the tool whose name + description best matches. If multiple plausible tools exist, prefer the one with simpler required parameters and confirm choice with the user before using it the first time.

| Action | Tool name keywords (any of) | Purpose |
|---|---|---|
| List projects | `get_projects`, `list_projects`, `projects` | Resolve a project name → project ID |
| List suites | `get_suites`, `list_suites`, `suites` | Resolve a suite name within a project → suite ID |
| List sections | `get_sections`, `list_sections`, `sections` | Resolve a section name within a suite → section ID |
| Create case | `add_case`, `create_case`, `add_test_case`, `create_test_case` | Create the test case under a section |
| Get case (verify) | `get_case`, `get_test_case` | Optional — verify creation and fetch URL |

If a needed action has no matching tool, stop and tell the user which capability is missing (e.g., "Your TestRail MCP doesn't expose a tool to list sections — I need that to resolve where the test goes. Please use a TestRail MCP that supports section listing.").

## Resolving the Destination

When the user names a project / suite / section:

1. **Project** — call the projects-list tool. If the user's text matches exactly one project name (case-insensitive), use it. If multiple, list them and ask. If none, ask the user to re-state.
2. **Suite** — call the suites-list tool with the resolved project ID. Same matching rules.
3. **Section** — call the sections-list tool with the resolved suite ID. Same matching rules. Sections can be nested; show the full path (e.g., `Web App > Lists > Templates`) when listing.

When the user pastes a **TestRail URL** instead of names:

- Section URL pattern is typically `…/index.php?/suites/view/<suite_id>&group_id=<section_id>` or `…/sections/view/<id>`.
- Extract the section ID directly. If the URL is unrecognized, fall back to asking for names.

Cache the resolved IDs for the run so subsequent ACs going to the same destination don't re-prompt.

## Two Phases: Draft, Then Batch Create

The skill never creates a TestRail case during the AC walk. Step 5 only **drafts** the case payload and saves it to the local draft file. Step 6c **batches** all queued drafts into create calls at end-of-run.

### Phase 1: Drafting (Step 5)

When an AC is marked `met`:

1. The user approves the test case content per [testrail-test-template.md](testrail-test-template.md).
2. The skill resolves the destination section if not already cached for the run.
3. The skill writes the full payload (section ID, title, type, priority, preconditions, steps) to the AC's section in the local draft file (see `epic-workflow.md` → "Local Draft File").
4. **No TestRail tool is called yet.** The case ID field in the draft stays as `queued`.

This means the destination section can be resolved once (or per-AC if the user wants different sections) without locking in the actual create.

### Phase 2: Batch Creation (Step 6c)

At end-of-run commit, iterate every AC in the local draft whose status is `met` and whose case ID field is `queued`:

For each draft, call the create-case tool with the **section ID** from the draft and the test case fields. Common parameter names across TestRail MCPs (map your chosen tool's parameters to these):

- `section_id` — from the draft
- `title` — from the draft
- `template_id` or `template` — usually `1` ("Test Case (Steps)") if the MCP requires it; if the tool doesn't expose this, omit
- `type_id` or `type` — from the draft (`1` "Functional" if not specified)
- `priority_id` or `priority` — from the draft (`2` "Medium" if not specified)
- `custom_preconds` — preconditions (markdown allowed)
- `custom_steps_separated` — array of `{content, expected}` from the draft's steps
- `custom_steps` — fallback single-string format if the MCP doesn't support separated steps

Prefer `custom_steps_separated` when available.

For each successful create:

1. Capture the returned case ID (commonly `id` or `case_id` in the response).
2. If the response includes a URL, capture it. Otherwise construct: `<TestRail base URL>/index.php?/cases/view/<case_id>` — only if you know the base URL from the user's earlier URL paste. If unknown, just report the ID.
3. **Immediately write the case ID (and URL if known) back into the local draft file** under that AC's section. This makes the run resumable: if a subsequent create fails, the already-created cases are recorded and won't be duplicated on resume.
4. Move to the next queued AC.

### Skipping pre-populated entries

If the local draft has an AC with case ID `<previously created — id unknown>` (carried forward from an Epic `[x]` mark without a TestRail reference), do **not** create anything for it during Step 6c. The user already has a case for it from a prior run — the skill just preserves the `[x]` on the Epic without a case-id reference at end-of-run.

## Error Handling

### Failure during drafting (Step 5)

The drafting phase doesn't call TestRail tools — only the destination-resolution calls (`get_projects`, `get_suites`, `get_sections`). If those fail, ask the user how to proceed (retry / use a different destination / abort).

### Failure during batch creation (Step 6c)

If a create call fails:

1. **Stop the batch immediately.** Do not continue creating subsequent cases.
2. The local draft already has the case IDs for everything that succeeded — those are committed to the draft, not duplicated on resume.
3. **Do not** start the Epic AC section rewrite (Step 6d) — partial Epic updates are confusing.
4. Report to the user:
   - Which ACs succeeded (with case IDs).
   - Which AC failed (with the error message from the MCP).
   - That the run is resumable by re-invoking `/finalize-epic` for the same Epic — the skill will detect the local draft, skip already-created cases, and pick up at the failed one.
5. Do not silently retry.

### Failure types worth distinguishing

If the MCP returns a permission error or auth error, surface it explicitly — these usually mean the TestRail MCP needs reconfiguration, not that the case payload is wrong. If the error is about a specific field (e.g., invalid `section_id`), the local draft for that AC needs to be edited before retry — tell the user to either edit `~/.finalize-epic/<EPIC-KEY>.md` directly or re-walk that AC.
