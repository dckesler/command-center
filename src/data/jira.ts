import type { TicketInfo, TransitionOption } from "../types.ts"
import { run } from "./exec.ts"

const JIRA_BASE = "https://smartsensebydigi.atlassian.net"

/**
 * Transitions use the Jira REST API directly (acli can execute a transition by
 * status name but cannot list the valid ones). Credentials come from the
 * JIRA_EMAIL / JIRA_API_TOKEN env vars already exported in the user's shell.
 */
function restAuth(): { base: string; headers: Record<string, string> } | null {
  const email = process.env.JIRA_EMAIL
  const token = process.env.JIRA_API_TOKEN
  if (!email || !token) return null
  const base = process.env.JIRA_BASE_URL ?? JIRA_BASE
  return {
    base,
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
  }
}

export async function getTransitions(key: string): Promise<TransitionOption[] | null> {
  const auth = restAuth()
  if (!auth) return null
  try {
    const res = await fetch(`${auth.base}/rest/api/3/issue/${key}/transitions`, { headers: auth.headers })
    if (!res.ok) return null
    const data = (await res.json()) as { transitions: { id: string; name: string; to: { name: string } }[] }
    return data.transitions.map((t) => ({ id: t.id, name: t.name, toStatus: t.to.name }))
  } catch {
    return null
  }
}

interface RestIssue {
  key: string
  fields: {
    summary: string
    status: { name: string; statusCategory: { name: string } }
    issuetype: { name: string }
    priority: { name: string } | null
    updated: string
    assignee?: { displayName: string } | null
  }
}

async function searchRest(jql: string, maxResults = 100): Promise<TicketInfo[] | null> {
  const auth = restAuth()
  if (!auth) return null
  const params = new URLSearchParams({
    jql,
    fields: "summary,status,issuetype,priority,updated,assignee",
    maxResults: String(maxResults),
  })
  try {
    const res = await fetch(`${auth.base}/rest/api/3/search/jql?${params}`, { headers: auth.headers })
    if (!res.ok) return null
    const data = (await res.json()) as { issues: RestIssue[] }
    return data.issues.map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status.name,
      statusCategory: issue.fields.status.statusCategory.name,
      type: issue.fields.issuetype.name,
      url: `${JIRA_BASE}/browse/${issue.key}`,
      priority: issue.fields.priority?.name,
      updated: issue.fields.updated,
      assignee: issue.fields.assignee?.displayName,
    }))
  } catch {
    return null
  }
}

/**
 * Assigned-but-not-active tickets. Uses REST (not acli) because acli's search
 * doesn't allow requesting the `updated` field.
 */
export function getBacklog(): Promise<TicketInfo[] | null> {
  return searchRest(
    'assignee = currentUser() AND statusCategory != Done AND status != "In Progress" ORDER BY updated DESC',
  )
}

/** Open epics assigned to the user, for the projects view. */
export function getEpics(): Promise<TicketInfo[] | null> {
  return searchRest(
    "assignee = currentUser() AND issuetype = Epic AND statusCategory != Done ORDER BY updated DESC",
    50,
  )
}

/**
 * All tickets inside an epic. On Jira Cloud, epic children are linked via the
 * `parent` field; fall back to the legacy "Epic Link" field if that finds nothing.
 */
export async function getEpicChildren(epicKey: string): Promise<TicketInfo[] | null> {
  const byParent = await searchRest(`parent = ${epicKey} ORDER BY key ASC`)
  if (byParent && byParent.length > 0) return byParent
  const byEpicLink = await searchRest(`"Epic Link" = ${epicKey} ORDER BY key ASC`)
  return byEpicLink ?? byParent
}

/** Jira sprint field (same constant the start-ticket skill uses). */
const SPRINT_FIELD = "customfield_10007"

interface SprintValue {
  id: number
  state?: string
  name?: string
}

/**
 * Numeric id of the project's open sprint, resolved the same way as the
 * start-ticket skill: any issue already in openSprints() carries the sprint
 * object in its sprint field.
 */
async function getCurrentSprintId(projectKey: string): Promise<number | null> {
  const auth = restAuth()
  if (!auth) return null
  const params = new URLSearchParams({
    jql: `project = ${projectKey} AND sprint in openSprints() ORDER BY updated DESC`,
    fields: SPRINT_FIELD,
    maxResults: "1",
  })
  try {
    const res = await fetch(`${auth.base}/rest/api/3/search/jql?${params}`, { headers: auth.headers })
    if (!res.ok) return null
    const data = (await res.json()) as { issues: { fields: Record<string, SprintValue[] | null> }[] }
    const sprints = data.issues[0]?.fields[SPRINT_FIELD] ?? []
    const active = sprints.find((s) => s.state === "active") ?? sprints[sprints.length - 1]
    return active?.id ?? null
  } catch {
    return null
  }
}

/**
 * Quick "start prep": ensure the ticket is In Progress and in the current
 * sprint. Skips anything already correct; reports what changed per part.
 */
export async function prepTicket(key: string): Promise<{ ok: boolean; message: string }> {
  const auth = restAuth()
  if (!auth) return { ok: false, message: "JIRA_EMAIL / JIRA_API_TOKEN not set" }
  const notes: string[] = []

  let status: string
  let ticketSprints: SprintValue[]
  try {
    const res = await fetch(`${auth.base}/rest/api/3/issue/${key}?fields=status,${SPRINT_FIELD}`, {
      headers: auth.headers,
    })
    if (!res.ok) return { ok: false, message: `could not fetch ${key} (${res.status})` }
    const issue = (await res.json()) as {
      fields: { status: { name: string } } & Record<string, SprintValue[] | null>
    }
    status = issue.fields.status.name
    ticketSprints = (issue.fields[SPRINT_FIELD] as SprintValue[] | null) ?? []
  } catch {
    return { ok: false, message: `could not fetch ${key}` }
  }

  const sprintId = await getCurrentSprintId(key.split("-")[0])
  if (!sprintId) {
    notes.push("⚠ no open sprint found")
  } else if (ticketSprints.some((s) => s.id === sprintId)) {
    notes.push("sprint ✓")
  } else {
    try {
      const res = await fetch(`${auth.base}/rest/api/3/issue/${key}`, {
        method: "PUT",
        headers: auth.headers,
        body: JSON.stringify({ fields: { [SPRINT_FIELD]: sprintId } }),
      })
      notes.push(res.ok ? "→ current sprint" : `⚠ sprint update failed (${res.status})`)
    } catch {
      notes.push("⚠ sprint update failed")
    }
  }

  if (status === "In Progress") {
    notes.push("status ✓")
  } else {
    const transitions = await getTransitions(key)
    const transition = transitions?.find((t) => t.toStatus.toLowerCase() === "in progress")
    if (!transition) {
      notes.push(`⚠ no In Progress transition from ${status}`)
    } else if (await applyTransition(key, transition.id)) {
      notes.push(`${status} → In Progress`)
    } else {
      notes.push("⚠ transition failed")
    }
  }

  return { ok: !notes.some((n) => n.startsWith("⚠")), message: `${key}: ${notes.join(" · ")}` }
}

export async function applyTransition(key: string, transitionId: string): Promise<boolean> {
  const auth = restAuth()
  if (!auth) return false
  try {
    const res = await fetch(`${auth.base}/rest/api/3/issue/${key}/transitions`, {
      method: "POST",
      headers: auth.headers,
      body: JSON.stringify({ transition: { id: transitionId } }),
    })
    return res.ok
  } catch {
    return false
  }
}

interface AcliIssue {
  key: string
  fields: {
    summary: string
    status: { name: string; statusCategory: { name: string } }
    issuetype: { name: string }
  }
}

function toTicketInfo(issue: AcliIssue): TicketInfo {
  return {
    key: issue.key,
    summary: issue.fields.summary,
    status: issue.fields.status.name,
    statusCategory: issue.fields.status.statusCategory.name,
    type: issue.fields.issuetype.name,
    url: `${JIRA_BASE}/browse/${issue.key}`,
  }
}

async function searchJql(jql: string, limit = 100): Promise<TicketInfo[] | null> {
  const res = await run("acli", ["jira", "workitem", "search", "--jql", jql, "--json", "--limit", String(limit)], {
    timeoutMs: 60_000,
  })
  if (!res.ok) return null
  try {
    const issues = JSON.parse(res.stdout) as AcliIssue[]
    return issues.map(toTicketInfo)
  } catch {
    return null
  }
}

/**
 * Look up tickets by key in one JQL query. `key in (...)` fails wholesale if
 * any key doesn't exist in Jira, so fall back to per-key queries on failure.
 */
export async function getTicketsByKeys(keys: string[]): Promise<Map<string, TicketInfo>> {
  const result = new Map<string, TicketInfo>()
  if (keys.length === 0) return result

  const unique = [...new Set(keys)]
  const batch = await searchJql(`key in (${unique.join(",")})`, unique.length)
  if (batch) {
    for (const t of batch) result.set(t.key, t)
    return result
  }

  const perKey = await Promise.all(unique.map((k) => searchJql(`key = ${k}`, 1)))
  for (const tickets of perKey) {
    if (tickets?.[0]) result.set(tickets[0].key, tickets[0])
  }
  return result
}
