# TestRail Test Case Template

Use this format when drafting a test case from an Acceptance Criterion. Show the full draft to the user and get explicit approval before creating.

## Fields

| Field | Source | Default |
|---|---|---|
| Title | Derived from the AC — concise, action-oriented, sentence case | required |
| Type | `Functional` | unless the AC clearly implies UI / Performance / Smoke / Regression — then use that |
| Priority | `Medium` | bump to `High` if the AC mentions security, billing, or data integrity |
| Preconditions | Inferred from AC context (e.g., "User is logged in", "Audit list exists with at least one item") | empty if none apply |
| Steps | Numbered, plain-English actions a tester can follow without reading code | required |
| Expected Result (per step) | What should be observable after that step | required for the final step at minimum |

## Title Rules

- Start with a verb: `Verify`, `Ensure`, `Confirm`, `Check`.
- Strip ticket-speak: drop "As a user…", "should be able to…" — go direct.
- Keep under ~80 characters.

Examples:

- AC: *"As a user, I should be able to archive a template from the template list view"*
  → Title: `Verify a template can be archived from the template list view`
- AC: *"Submitting the form with an empty Name field shows a validation error"*
  → Title: `Verify validation error appears when submitting form with empty Name`

## Steps Rules

- One action per step. Do not stack ("click X and then Y" → split it).
- Reference UI by visible label, not by component name (`the "Archive" button`, not `<ArchiveButton>`).
- Final step's Expected Result must directly verify the AC.
- If the AC implies negative paths (validation, error states), include them as separate steps or a separate test case — flag this to the user before drafting.

## Draft Format Shown to the User

Present the draft like this before asking for approval:

```
TestRail Test Case Draft
─────────────────────────
Project:   <project name>
Suite:     <suite name>
Section:   <section path>

Title:     <title>
Type:      <type>
Priority:  <priority>

Preconditions:
  <preconds, or "None">

Steps:
  1. <action>
     Expected: <observable outcome>
  2. <action>
     Expected: <observable outcome>
  ...

Source AC: "<verbatim AC text>"
```

Then ask: **"Create this test case in TestRail?"** Wait for explicit "yes" before calling the create tool.

## When the AC is Vague

If the AC is too vague to draft a meaningful test (e.g., "The feature should work well"), do not invent test steps. Instead, ask the user one clarifying question — what observable behavior would prove the AC is met. Use their answer to draft. If they can't articulate one, recommend marking the AC as skipped and adding a follow-up to tighten the AC on the Epic.
