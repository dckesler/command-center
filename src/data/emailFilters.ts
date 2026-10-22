/**
 * Inbox noise filters. Each rule is a set of case-insensitive, multiline
 * (^ = line start) regexes; a mail is hidden by the first enabled rule whose
 * given fields all match, unless
 * the rule's `unless` pattern matches its subject or body. Hidden mail stays
 * in the data (the tab can show it with `h`, the specialist with
 * include_hidden) — nothing is moved or deleted in Outlook.
 *
 * Defaults ship here; `email.filters` in config.json is merged by `name`, so a
 * user entry can flip `enabled`, replace a pattern, or add a new rule.
 */

export interface EmailFilter {
  name: string
  enabled: boolean
  /** why this rule exists — shown in the tab when hidden mail is listed */
  why?: string
  from?: string
  subject?: string
  body?: string
  /** keep the mail when this matches subject or body */
  unless?: string
}

export const DEFAULT_EMAIL_FILTERS: EmailFilter[] = [
  {
    name: "jira-field-updates",
    enabled: true,
    why: "Jira field-only changes (sprint, assignee, rank, dates) — mentions, assignments and comments still show",
    from: "^jira@",
    body: "made (an|\\d+) updates?",
    unless: "mentioned you|assigned this work item to you|new comments?|updated a comment",
  },
  {
    name: "jira-digests",
    enabled: true,
    why: "Jira weekly update / stale work item digests",
    from: "^jira@",
    subject: "weekly update|work items from spaces",
  },
  // --- suggestions: flip `enabled` in config.json ---------------------------
  {
    name: "jira-comments",
    enabled: false,
    why: "Jira comment notifications too — only mentions and assignments remain",
    from: "^jira@",
    body: "new comments?|updated a comment",
    unless: "mentioned you|assigned this work item to you",
  },
  {
    name: "jira-snyk-tickets",
    enabled: false,
    why: "Jira traffic on Snyk vulnerability tickets",
    from: "^jira@",
    subject: "snyk",
  },
  {
    name: "gitlab-mr-threads",
    enabled: false,
    why: "GitLab MR discussion threads (the review tab tracks open MRs) — the MR being approved, merged or conflicted, failed pipelines, mentions and review requests still show",
    from: "^gitlab@",
    subject: "^Re: ",
    // anchored to GitLab's own event line so a comment that merely says "approved" does not keep the mail
    unless: "^Merge request (!\\d+ )?(was (approved|merged)|can no longer be merged)|^Pipeline .*failed|mentioned you in|requested (a )?review|assigned you|was assigned to you",
  },
  {
    name: "gitlab-mr-approved",
    enabled: false,
    why: "'Merge request was approved' notices (the review tab shows approvals)",
    from: "^gitlab@",
    body: "^Merge request was approved",
  },
  {
    name: "gitlab-mr-merged",
    enabled: false,
    why: "'Merge request !N was merged' notices",
    from: "^gitlab@",
    body: "^Merge request !\\d+ was merged",
  },
  {
    name: "gitlab-pipeline-ok",
    enabled: false,
    why: "GitLab passing / fixed pipeline notices",
    from: "^gitlab@",
    subject: "(fixed|successful|passed) pipeline",
  },
  {
    name: "meeting-responses",
    enabled: false,
    why: "Accepted / Tentative / Declined / Canceled meeting responses (the calendar tab shows the real state)",
    subject: "^(Accepted|Tentative|Declined|Canceled|Cancelled): ",
  },
  {
    name: "confluence-digests",
    enabled: false,
    why: "Confluence daily digests and 'your team is working on these pages' nudges",
    from: "^confluence@",
    subject: "digest|working on these pages|join the conversation",
  },
  {
    name: "atlassian-marketing",
    enabled: false,
    why: "Atlassian product marketing (prompts made for you, tips)",
    from: "@po\\.atlassian\\.net$",
  },
  { name: "awardco", enabled: false, why: "Awardco recognition nudges", from: "@digi\\.awardco\\.com$" },
  { name: "snyk-alerts", enabled: false, why: "Snyk vulnerability alert mail", from: "@snyk\\.io$" },
  { name: "datadog-digest", enabled: false, why: "Datadog daily digest", from: "@dtdg\\.co$", subject: "digest" },
  { name: "barracuda-quarantine", enabled: false, why: "Barracuda quarantine summaries", from: "^quarantine@" },
  { name: "fathom-recaps", enabled: false, why: "Fathom meeting recaps", from: "@fathom\\.video$" },
  { name: "kronos", enabled: false, why: "Kronos timekeeping notices", from: "@mykronos\\.com$" },
  { name: "linkedin", enabled: false, why: "LinkedIn notifications", from: "@linkedin\\.com$" },
]

/** Defaults ← user entries, matched by name; unknown names are appended. */
export function mergeEmailFilters(user: unknown): EmailFilter[] {
  const out = DEFAULT_EMAIL_FILTERS.map((f) => ({ ...f }))
  if (!Array.isArray(user)) return out
  for (const raw of user) {
    if (!raw || typeof raw !== "object") continue
    const u = raw as Partial<EmailFilter>
    if (typeof u.name !== "string" || !u.name) continue
    const idx = out.findIndex((f) => f.name === u.name)
    const base: EmailFilter = idx >= 0 ? out[idx] : { name: u.name, enabled: true }
    const merged: EmailFilter = {
      ...base,
      ...(typeof u.enabled === "boolean" ? { enabled: u.enabled } : {}),
      ...(typeof u.why === "string" ? { why: u.why } : {}),
      ...(typeof u.from === "string" ? { from: u.from } : {}),
      ...(typeof u.subject === "string" ? { subject: u.subject } : {}),
      ...(typeof u.body === "string" ? { body: u.body } : {}),
      ...(typeof u.unless === "string" ? { unless: u.unless } : {}),
    }
    if (idx >= 0) out[idx] = merged
    else out.push(merged)
  }
  return out
}

function re(pattern: string | undefined): RegExp | null {
  if (!pattern) return null
  try {
    return new RegExp(pattern, "im")
  } catch {
    return null
  }
}

export interface FilterInput {
  fromAddress: string
  subject: string
  body: string
}

/** Name of the first enabled rule that hides this mail, or null to keep it. */
export function hiddenBy(mail: FilterInput, filters: EmailFilter[]): string | null {
  for (const f of filters) {
    if (!f.enabled) continue
    const from = re(f.from)
    const subject = re(f.subject)
    const body = re(f.body)
    if (!from && !subject && !body) continue
    if (from && !from.test(mail.fromAddress)) continue
    if (subject && !subject.test(mail.subject)) continue
    if (body && !body.test(mail.body)) continue
    const unless = re(f.unless)
    if (unless && (unless.test(mail.subject) || unless.test(mail.body))) continue
    return f.name
  }
  return null
}
