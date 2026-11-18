# Test Plan and QA Steps Checklist

Source: QA's "Better Test Plans and Test Cases" notes (Jonathan Rees). Run this before writing or editing a ticket's `## Test Plan` or `## QA Steps`, and before drafting a TestRail case. Every skill that touches those sections points here; do not restate these rules elsewhere.

## Test Plan

- **Short.** 3–6 lines. The "why" and the ticket's history belong in Summary, not here.
- **Name the test type:** `manual`, `automated`, or `both`.
- **Name the tests.** When adding or updating automated tests, say which files or suites. "Existing tests should pass" is not a plan — name the tests, or say "the CI pipeline".
- **Prerequisites** list only what is needed to start testing: environment, accounts/roles, data, hardware.
- `test_plan_reviewed` means QA reviewed the **plan**, not the QA Steps. If QA should also check the steps, ask for that explicitly when handing the ticket over.

## QA Steps

- **Preconditions first.** The first item of `## QA Steps` is `**Preconditions:**` — dev flags, feature flags, hardware, account/role, test data that must exist — or `None`. Never put a flag or setup requirement in a later step. QA runs the steps top to bottom without reading ahead; the last step is the last thing read.
- **Runnable on stage, through the UI.** Unless the ticket says otherwise, QA tests on staging. Steps may not require: localhost, `npm start`, Requestly or other redirects, devtools or the browser console, direct API/GraphQL calls, SQL, or database access. QA has no database access.
- **No "check the db".** If a result can only be seen in the database or backend, write `Dev-assisted: <who> verifies <what> with QA` so QA knows to schedule it; otherwise find the UI-visible effect and check that instead.
- **No skipped steps.** Every step names the surface and the object: which app (web / mobile iOS / mobile Android), which page, which item or template type. "Upload a photo" is not a step; "In the mobile app, open a camera item on an audit list and upload a photo" is. For `[MB]` tickets, Preconditions name the platform, device and build.
- **One action per step**, plain English, visible labels only (`the "Archive" button`, not the component name). No implementation details.
- **End with verification** that confirms the changed behaviour, then one regression check on a nearby flow (or `Regression: None`).
- **Not a restatement of the ACs.**

## TestRail references

- List only the specific case IDs that need to run for this ticket. Never link a whole suite and then say some failures don't apply.
- Do not repeat a linked case's steps inside QA Steps. QA Steps cover only what the linked cases do not.
- When merging generated cases (Universal Test Plan Agent, grok-qa findings) into QA Steps, drop any bullet that restates an existing step or a linked TestRail case.

## TestRail priorities

- Default `Medium`.
- `High` and `Critical` **mobile** cases are added to the release Smoke Test, which runs for every release. Only use them when the case genuinely must run every release, and say so when proposing the priority.

## Quick checklist

- [ ] Preconditions first (dev flags, feature flags, hardware, role, data)
- [ ] Steps QA can run on stage, UI only
- [ ] No db checks unless marked dev-assisted
- [ ] No skipped steps — surface and object named every time
- [ ] Only the relevant TestRail cases, no duplicate steps
- [ ] Careful with High / Critical priorities
- [ ] Simple plan: test type and which tests
