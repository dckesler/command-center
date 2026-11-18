/**
 * The user's open merge requests across GitLab, joined with what the command
 * center knows locally (worktree, tmux window, agent, Jira status) and with the
 * review state GitLab keeps per MR (approvals, unresolved threads, pipeline).
 * Backs the `cc-mrs` CLI and the worktrees specialist's list_my_mrs tool.
 */
import type { MrExtras, RepoInfo } from "../types.ts"
import { readAgentStatuses, type AgentState } from "./agents.ts"
import { run } from "./exec.ts"
import { getMrExtras, gitlabUsername, remoteProjectPath } from "./gitlab.ts"
import { getTicketsByKeys } from "./jira.ts"
import { parseRepoMap } from "./repos.ts"
import { findWindowFor, listTmuxWindows } from "./tmux.ts"
import { listWorktrees, ticketKeyFromBranch } from "./worktrees.ts"

export interface ThreadSummary {
  id: string
  author: string
  authorName: string
  isBot: boolean
  createdAt: string
  /** newest note in the thread */
  updatedAt: string
  notes: number
  /** first line of the opening note, trimmed */
  snippet: string
  /** file:line when the thread is anchored to a diff */
  position: string | null
}

export interface MyMr {
  iid: number
  projectId: number
  /** "group/project" */
  projectPath: string
  /** repo alias from the repo map, or null when there is no local checkout */
  repo: string | null
  repoPath: string | null
  branch: string
  targetBranch: string
  title: string
  url: string
  draft: boolean
  hasConflicts: boolean
  detailedMergeStatus: string | null
  pipelineStatus: string | null
  updatedAt: string
  approval: MrExtras | null
  unresolved: ThreadSummary[]
  ticketKey: string | null
  ticketStatus: string | null
  worktreePath: string | null
  tmuxWindow: string | null
  agentState: AgentState | null
}

interface GlabListMr {
  iid: number
  project_id: number
  title: string
  web_url: string
  source_branch: string
  target_branch: string
  draft: boolean
  has_conflicts: boolean
  detailed_merge_status?: string
  updated_at: string
  references?: { full?: string }
  head_pipeline?: { status: string } | null
}

interface GlabNote {
  id: number
  body: string
  system?: boolean
  resolvable?: boolean
  resolved?: boolean
  created_at: string
  updated_at: string
  author: { username: string; name: string }
  position?: { new_path?: string; old_path?: string; new_line?: number | null; old_line?: number | null } | null
}

interface GlabDiscussion {
  id: string
  notes: GlabNote[]
}

/** CodeAnt, GitLab group/project bots, service accounts, CI accounts. */
export function isBotAuthor(username: string, name = ""): boolean {
  return /bot|codeant|service_account|factory|renovate|dependabot/i.test(`${username} ${name}`)
}

/** Unresolved review threads of one MR, oldest first. */
export async function unresolvedThreads(repoPath: string | null, projectId: number, iid: number): Promise<ThreadSummary[] | null> {
  const res = await run("glab", ["api", `projects/${projectId}/merge_requests/${iid}/discussions?per_page=100`], cwdOpt(repoPath))
  if (!res.ok) return null
  let discussions: GlabDiscussion[]
  try {
    discussions = JSON.parse(res.stdout) as GlabDiscussion[]
  } catch {
    return null
  }
  const out: ThreadSummary[] = []
  for (const d of discussions) {
    const resolvable = d.notes.filter((n) => n.resolvable)
    if (resolvable.length === 0 || resolvable.every((n) => n.resolved)) continue
    const first = d.notes.find((n) => !n.system) ?? d.notes[0]
    if (!first) continue
    const newest = d.notes.reduce((a, b) => (a.created_at > b.created_at ? a : b))
    const pos = first.position
    const path = pos?.new_path ?? pos?.old_path
    const line = pos?.new_line ?? pos?.old_line
    out.push({
      id: d.id,
      author: first.author.username,
      authorName: first.author.name,
      isBot: isBotAuthor(first.author.username, first.author.name),
      createdAt: first.created_at,
      updatedAt: newest.created_at,
      notes: d.notes.filter((n) => !n.system).length,
      snippet: snippetOf(first.body),
      position: path ? `${path}${line ? `:${line}` : ""}` : null,
    })
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

function snippetOf(body: string): string {
  const line =
    body
      .split("\n")
      .map((l) => l.replace(/^[#>*\-\s]+/, "").replace(/\*\*/g, "").trim())
      .find((l) => l.length > 0) ?? ""
  return line.length > 110 ? `${line.slice(0, 107)}…` : line
}

function cwdOpt(repoPath: string | null): { cwd?: string } {
  return repoPath ? { cwd: repoPath } : {}
}

/** Resolve "group/project" → local repo for every repo the command center knows. */
async function repoByProjectPath(repos: RepoInfo[]): Promise<Map<string, RepoInfo>> {
  const map = new Map<string, RepoInfo>()
  await Promise.all(
    repos.map(async (repo) => {
      const path = await remoteProjectPath(repo.path)
      if (path) map.set(path.toLowerCase(), repo)
    }),
  )
  return map
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

export interface ListMyMrsOptions {
  /** hide MRs with no GitLab activity for this many days (0 = show everything) */
  sinceDays?: number
  /** skip the per-MR detail calls (approvals, threads, pipeline) — list only */
  shallow?: boolean
}

export interface MyMrsResult {
  username: string | null
  mrs: MyMr[]
  /** MRs hidden by sinceDays */
  hidden: number
  error: string | null
}

/**
 * Every open MR authored by the glab login, newest activity first. Each MR
 * gets three extra GitLab calls (detail, approvals, discussions) unless
 * `shallow`; they run four at a time.
 */
export async function listMyOpenMrs(opts: ListMyMrsOptions = {}): Promise<MyMrsResult> {
  const repos = parseRepoMap()
  const anchor = repos[0]?.path ?? null
  const username = await gitlabUsername(anchor ?? undefined)
  const list = await run("glab", ["api", "merge_requests?scope=created_by_me&state=opened&per_page=100"], cwdOpt(anchor))
  if (!list.ok) return { username, mrs: [], hidden: 0, error: list.stderr.trim() || "glab api merge_requests failed" }
  let raw: GlabListMr[]
  try {
    raw = JSON.parse(list.stdout) as GlabListMr[]
  } catch {
    return { username, mrs: [], hidden: 0, error: "could not parse glab output" }
  }
  if (!Array.isArray(raw)) return { username, mrs: [], hidden: 0, error: "unexpected glab output" }

  raw.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  const sinceDays = opts.sinceDays ?? 0
  const cutoff = sinceDays > 0 ? Date.now() - sinceDays * 86_400_000 : 0
  const kept = cutoff ? raw.filter((m) => new Date(m.updated_at).getTime() >= cutoff) : raw
  const hidden = raw.length - kept.length

  const [byProject, worktrees, windows] = await Promise.all([
    repoByProjectPath(repos),
    Promise.all(repos.map(listWorktrees)).then((w) => w.flat()),
    listTmuxWindows(),
  ])
  const agents = readAgentStatuses()

  const mrs: MyMr[] = kept.map((m) => {
    const projectPath = m.references?.full?.replace(/!\d+$/, "") ?? m.web_url.replace(/^https?:\/\/[^/]+\//, "").replace(/\/-\/merge_requests\/\d+.*$/, "")
    const repo = byProject.get(projectPath.toLowerCase()) ?? null
    const wt = repo ? worktrees.find((w) => w.repo.path === repo.path && w.branch === m.source_branch) ?? null : null
    const ticketKey = ticketKeyFromBranch(m.source_branch)
    return {
      iid: m.iid,
      projectId: m.project_id,
      projectPath,
      repo: repo?.alias ?? null,
      repoPath: repo?.path ?? null,
      branch: m.source_branch,
      targetBranch: m.target_branch,
      title: m.title,
      url: m.web_url,
      draft: m.draft,
      hasConflicts: m.has_conflicts,
      detailedMergeStatus: m.detailed_merge_status ?? null,
      pipelineStatus: m.head_pipeline?.status ?? null,
      updatedAt: m.updated_at,
      approval: null,
      unresolved: [],
      ticketKey,
      ticketStatus: null,
      worktreePath: wt?.path ?? null,
      tmuxWindow: wt ? findWindowFor(windows, ticketKey, m.source_branch) : null,
      agentState: wt ? agents.get(wt.path)?.state ?? null : null,
    }
  })

  const keys = mrs.map((m) => m.ticketKey).filter((k): k is string => k !== null)
  const ticketsDone = getTicketsByKeys(keys).then((tickets) => {
    for (const mr of mrs) if (mr.ticketKey) mr.ticketStatus = tickets.get(mr.ticketKey)?.status ?? null
  })

  const detailsDone = opts.shallow
    ? Promise.resolve()
    : pool(mrs, 4, async (mr) => {
        const [detail, approval, threads] = await Promise.all([
          run("glab", ["api", `projects/${mr.projectId}/merge_requests/${mr.iid}`], cwdOpt(mr.repoPath ?? anchor)),
          getMrExtras(mr.repoPath ?? anchor ?? process.cwd(), mr.projectId, mr.iid),
          unresolvedThreads(mr.repoPath ?? anchor, mr.projectId, mr.iid),
        ])
        if (detail.ok) {
          try {
            const d = JSON.parse(detail.stdout) as GlabListMr
            mr.pipelineStatus = d.head_pipeline?.status ?? mr.pipelineStatus
            mr.detailedMergeStatus = d.detailed_merge_status ?? mr.detailedMergeStatus
            mr.hasConflicts = d.has_conflicts
          } catch {
            // keep list values
          }
        }
        mr.approval = approval
        mr.unresolved = threads ?? []
      }).then(() => undefined)

  await Promise.all([ticketsDone, detailsDone])
  return { username, mrs, hidden, error: null }
}

// ---------------------------------------------------------------------------
// classification + formatting (shared by the CLI and the specialist tool)

/** Something on this MR needs work before it can merge: open threads, red CI, conflicts. */
export function mrNeedsPass(mr: MyMr): boolean {
  return mr.unresolved.length > 0 || mr.hasConflicts || mr.pipelineStatus === "failed"
}

/** Pushed, green, nothing open — just waiting for a reviewer's approval. */
export function mrWaitingOnApproval(mr: MyMr): boolean {
  return !mr.draft && !mrNeedsPass(mr) && mr.approval !== null && !mr.approval.approved
}

export function ageOf(iso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000))
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

export function fmtMyMr(mr: MyMr, opts: { shallow?: boolean } = {}): string {
  const where = mr.repo ? `${mr.repo}/${mr.branch}` : `${mr.projectPath}/${mr.branch}`
  const parts = [`!${mr.iid} ${where}`]
  if (mr.draft) parts.push("draft")
  if (mr.pipelineStatus) parts.push(`ci:${mr.pipelineStatus}`)
  if (mr.hasConflicts) parts.push("conflicts")
  if (!opts.shallow) {
    if (mr.approval) {
      const a = mr.approval
      const got = a.approvalsRequired - a.approvalsLeft
      const who = a.approvedBy.length ? ` (${a.approvedBy.join(", ")})` : ""
      parts.push(a.approved ? `approved ${got}/${a.approvalsRequired}${who}` : `${got}/${a.approvalsRequired} approvals${who}`)
    } else {
      parts.push("approvals ?")
    }
    const humans = mr.unresolved.filter((t) => !t.isBot)
    const bots = mr.unresolved.length - humans.length
    if (mr.unresolved.length === 0) parts.push("no open threads")
    else {
      const newest = mr.unresolved.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b))
      const mix = [humans.length ? `${humans.length} human` : "", bots ? `${bots} bot` : ""].filter(Boolean).join(" + ")
      parts.push(`${mr.unresolved.length} unresolved (${mix}; newest ${ageOf(newest.updatedAt)} ago by ${authorLabel(newest)})`)
    }
  }
  if (mr.ticketKey) parts.push(`${mr.ticketKey} ${mr.ticketStatus ?? "?"}`)
  if (mr.worktreePath) {
    const local = ["worktree"]
    if (mr.tmuxWindow) local.push(`window ${mr.tmuxWindow}`)
    local.push(mr.agentState ? `agent ${mr.agentState}` : "no agent")
    parts.push(local.join(", "))
  } else if (mr.repo) parts.push("no worktree")
  else parts.push("no local checkout")
  parts.push(`updated ${ageOf(mr.updatedAt)} ago`)
  return parts.join(" | ")
}

/** Humans by username; bots by their display name (GitLab bot usernames are hashes). */
export function authorLabel(t: Pick<ThreadSummary, "author" | "authorName" | "isBot">): string {
  if (!t.isBot) return t.author
  const name = t.authorName.replace(/\*/g, "").trim()
  return name ? `${name} (bot)` : "gitlab bot"
}

export function fmtThread(t: ThreadSummary): string {
  const who = authorLabel(t)
  const where = t.position ? ` ${t.position}` : ""
  const replies = t.notes > 1 ? `, ${t.notes} notes` : ""
  return `- ${who}${where} (${ageOf(t.createdAt)} ago${replies}): ${t.snippet}`
}

// ---------------------------------------------------------------------------
// the pass: hand each MR that needs work to a babysit-branch agent

export interface PassResult {
  mr: MyMr
  action: "mailed" | "launched" | "skipped"
  message: string
}

function passReason(mr: MyMr, user: string): string {
  const bits: string[] = []
  if (mr.unresolved.length) {
    const humans = mr.unresolved.filter((t) => !t.isBot)
    const bots = mr.unresolved.length - humans.length
    const authors = [...new Set(mr.unresolved.map(authorLabel))].join(", ")
    bits.push(
      `${mr.unresolved.length} unresolved review thread${mr.unresolved.length === 1 ? "" : "s"} ` +
        `(${[humans.length ? `${humans.length} human` : "", bots ? `${bots} bot` : ""].filter(Boolean).join(", ")}; from ${authors})`,
    )
  }
  if (mr.pipelineStatus === "failed") bits.push("a failed pipeline")
  if (mr.hasConflicts) bits.push(`merge conflicts with ${mr.targetBranch}`)
  const ticket = mr.ticketKey ? ` The Jira ticket ${mr.ticketKey} is ${mr.ticketStatus ?? "in an unknown status"} and stays there — do not transition it.` : ""
  return `${bits.join(", ")}.${ticket} ${user} asked for a review pass; he is not watching this window.`
}

/**
 * Point a babysit-branch agent at an MR that needs work. Existing agent in the
 * MR's worktree → cc-mail into its chat. Worktree or checkout but no agent →
 * mkpanes opens (or reuses) the worktree with a babysit-branch prompt. No local
 * checkout of the repo → skipped.
 */
export async function dispatchPass(
  mr: MyMr,
  deps: {
    user: string
    session: string | null
    sendMail: (dir: string, text: string) => Promise<{ ok: boolean; message: string }>
    mkpanes: (args: string[], session: string | null) => Promise<{ ok: boolean; message: string }>
    writePromptFile: (name: string, text: string) => string
  },
): Promise<PassResult> {
  const label = `!${mr.iid} ${mr.repo ?? mr.projectPath}/${mr.branch}`
  if (!mrNeedsPass(mr)) return { mr, action: "skipped", message: `${label}: nothing to address` }
  if (!mr.repo) return { mr, action: "skipped", message: `${label}: no local checkout of ${mr.projectPath} — open it by hand` }

  if (mr.worktreePath && mr.agentState && mr.agentState !== "ended") {
    const text =
      `MR !${mr.iid} (${mr.url}) has ${passReason(mr, deps.user)} ` +
      `Re-enter /babysit-branch now: Step 1 if CI is not green on the current HEAD, otherwise Step 3 — collect every unresolved thread, ` +
      `fix what is worth fixing, close the rest with a reason, push with /push-branch, and loop until CI is green with no open threads. ` +
      `Report to central with cc-report when the MR is ready again.`
    const res = await deps.sendMail(mr.worktreePath, text)
    return {
      mr,
      action: res.ok ? "mailed" : "skipped",
      message: res.ok ? `${label}: mailed the agent in ${mr.tmuxWindow ?? mr.worktreePath} (${res.message})` : `${label}: cc-mail failed — ${res.message}`,
    }
  }

  const prompt =
    `/babysit-branch\n\n` +
    `You are picking up MR !${mr.iid} (${mr.url}) on branch ${mr.branch} of ${mr.repo}, pushed earlier by ${deps.user}. It has ${passReason(mr, deps.user)}\n\n` +
    `Run babysit-branch from Step 0 (derive the MR), then Step 1 (CI on the current HEAD), then Step 3 and Step 4: triage every unresolved thread — ` +
    `fix what is worth fixing in this worktree, close the rest with a reason — push with /push-branch, and loop until CI is green with no open threads. ` +
    `Then tell ${deps.user} the MR is ready for his review again (Step 5) and report to central with cc-report. ` +
    `Never move the ticket: it is already where ${deps.user} wants it.\n`
  const file = deps.writePromptFile(`mr-pass-${mr.repo}-${mr.branch.replace(/[^\w.-]+/g, "_")}.txt`, prompt)
  const res = await deps.mkpanes([mr.repo, "-w", mr.branch, "--prompt-file", file], deps.session)
  const reused = mr.worktreePath ? " (existing worktree)" : ""
  return {
    mr,
    action: res.ok ? "launched" : "skipped",
    message: res.ok ? `${label}: opened a babysit-branch window${reused}` : `${label}: mkpanes failed — ${res.message}`,
  }
}

/** Match "!123", "123", a branch, a ticket key, or "repo/branch" against the list. */
export function findMyMr(mrs: MyMr[], ref: string): MyMr | undefined {
  const t = ref.trim()
  const bang = t.match(/^!?(\d+)$/)
  if (bang) return mrs.find((m) => m.iid === Number(bang[1]))
  const lower = t.toLowerCase()
  return mrs.find(
    (m) =>
      m.branch.toLowerCase() === lower ||
      m.ticketKey?.toLowerCase() === lower ||
      `${m.repo}/${m.branch}`.toLowerCase() === lower ||
      m.url === t,
  )
}
