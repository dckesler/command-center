/**
 * Data for the per-project dashboard (cc-dash). Read-only: everything comes
 * from what the project's agents already leave on disk — PROJECT.md, the
 * report inbox (.cc/inbox.jsonl), the agent hook feed, cc-mail state and the
 * tmux session — plus a slow Jira/GitLab join for the ticket and MR columns.
 */
import { existsSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { readAgentStatuses } from "../data/agents.ts"
import { run } from "../data/exec.ts"
import { getMrExtras, getMrForBranch } from "../data/gitlab.ts"
import { getEpicChildren, getTicketsByKeys } from "../data/jira.ts"
import { isMailStuck, mailWaitMinutes, pendingMailFor, readPendingMail } from "../data/mail.ts"
import {
  listProjectTasks,
  readBrief,
  readProjectReportEntries,
  TICKET_KEY,
  type Project,
  type ProjectReport,
  type ProjectTask,
} from "../data/projects.ts"
import { projectSessionName } from "../data/tmux.ts"
import { ticketKeyFromBranch } from "../data/worktrees.ts"
import type { MrExtras, Row, TicketInfo } from "../types.ts"

export interface NeedsYou {
  /** null = the central agent itself (or a tab that is no longer open — see `label`) */
  task: ProjectTask | null
  /** display name when there is no task row (closed tab) */
  label?: string
  reason: "report" | "agent" | "mail"
  text: string
  /** ISO of when the wait started */
  since: string
}

export interface EpicProgress {
  key: string
  ticket: TicketInfo | null
  children: TicketInfo[] | null
}

export interface DashSnapshot {
  project: Project
  /** null = session not running */
  tasks: ProjectTask[] | null
  /** MR approvals / unresolved threads by MR iid (slow join) */
  extras: Map<number, MrExtras>
  needsYou: NeedsYou[]
  /** oldest first */
  reports: ProjectReport[]
  epic: EpicProgress | null
  /** when the slow Jira/GitLab join last completed (0 = never) */
  slowAt: number
}

function isLinkedWorktree(dir: string): boolean {
  try {
    return statSync(join(dir, ".git")).isFile()
  } catch {
    return false
  }
}

/** Resolve a project argument (name or path) to its directory. */
export function resolveProjectDir(arg: string | undefined, projectsDir: string): string | null {
  if (arg) {
    if (arg.includes("/")) return existsSync(arg) ? arg.replace(/\/$/, "") : null
    const dir = join(projectsDir, arg)
    return existsSync(dir) ? dir : null
  }
  const cwd = process.cwd()
  if (cwd.startsWith(`${projectsDir}/`)) return join(projectsDir, cwd.slice(projectsDir.length + 1).split("/")[0])
  return null
}

/**
 * Window paths of the project's session that are git worktrees, as dashboard
 * rows (branch + repo from git; ticket/MR filled by the slow join).
 */
async function worktreeRows(projectName: string, prev: Row[]): Promise<Row[]> {
  const session = projectSessionName(projectName)
  const res = await run("tmux", ["list-windows", "-t", `=${session}`, "-F", "#{pane_current_path}\t#{window_name}"])
  if (!res.ok) return []
  const seen = new Set<string>()
  const rows: Row[] = []
  for (const line of res.stdout.split("\n")) {
    const [path, name] = line.split("\t")
    if (!path || seen.has(path) || !isLinkedWorktree(path)) continue
    seen.add(path)
    const old = prev.find((r) => r.worktreePath === path)
    if (old) {
      rows.push(old)
      continue
    }
    const [branchRes, commonRes] = await Promise.all([
      run("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"]),
      run("git", ["-C", path, "rev-parse", "--git-common-dir"]),
    ])
    const branch = branchRes.ok ? branchRes.stdout.trim() : basename(path).split("_").slice(1).join("_")
    const common = commonRes.ok ? commonRes.stdout.trim() : ""
    const repoPath = common ? dirname(common.startsWith("/") ? common : join(path, common)) : dirname(path)
    rows.push({
      repo: basename(repoPath),
      repoPath,
      branch,
      worktreePath: path,
      ticketKey: ticketKeyFromBranch(branch) ?? name?.match(TICKET_KEY)?.[0] ?? null,
      git: null,
      ticket: null,
      mr: null,
      tmuxWindow: null,
      agent: null,
      isQa: false,
      isReview: false,
      approval: null,
    })
  }
  return rows
}

export class DashSource {
  private rows: Row[] = []
  private extras = new Map<number, MrExtras>()
  private epic: EpicProgress | null = null
  private slowAt = 0
  private slowRunning = false

  constructor(
    readonly dir: string,
    readonly name: string = basename(dir),
  ) {}

  /** Cheap, local: brief, inbox, agent feed, mail, tmux windows. */
  async fast(): Promise<DashSnapshot> {
    const brief = readBrief(this.dir)
    const agents = readAgentStatuses()
    const mail = readPendingMail()
    const project: Project = {
      name: this.name,
      path: this.dir,
      brief,
      modified: "",
      tmuxWindow: null,
      agent: agents.get(this.dir) ?? null,
      mail: pendingMailFor(mail, this.dir),
    }
    this.rows = await worktreeRows(this.name, this.rows)
    const tasks = await listProjectTasks(project, this.rows)
    const reports = readProjectReportEntries(this.dir)
    const epicKey = brief?.epic ?? null
    if (this.epic && this.epic.key !== epicKey) this.epic = null
    if (!this.epic && epicKey) this.epic = { key: epicKey, ticket: null, children: null }
    return {
      project,
      tasks,
      extras: this.extras,
      needsYou: computeNeedsYou(project, tasks, reports),
      reports,
      epic: this.epic,
      slowAt: this.slowAt,
    }
  }

  /** Jira + GitLab for the current rows and the epic. Safe to call often; runs one at a time. */
  async slow(): Promise<void> {
    if (this.slowRunning) return
    this.slowRunning = true
    try {
      const keys = this.rows.map((r) => r.ticketKey).filter((k): k is string => !!k)
      const [tickets] = await Promise.all([
        getTicketsByKeys(keys),
        Promise.all(
          this.rows.map(async (row) => {
            row.mr = await getMrForBranch(row.repoPath, row.branch)
            if (row.mr && row.mr.state === "opened") {
              const extras = await getMrExtras(row.repoPath, row.mr.projectId, row.mr.iid)
              if (extras) this.extras.set(row.mr.iid, extras)
            }
          }),
        ),
      ])
      for (const row of this.rows) if (row.ticketKey) row.ticket = tickets.get(row.ticketKey) ?? row.ticket
      if (this.epic) {
        const [ticket, children] = await Promise.all([
          getTicketsByKeys([this.epic.key]).then((m) => m.get(this.epic!.key) ?? null),
          getEpicChildren(this.epic.key),
        ])
        this.epic = { key: this.epic.key, ticket, children }
      }
      this.slowAt = Date.now()
    } finally {
      this.slowRunning = false
    }
  }
}

/**
 * What is waiting on Daniel, oldest wait first. A tab needs him when its
 * newest report is `attention` (and the agent has not gone back to work
 * since), when its agent is in the `attention` hook state (permission prompt,
 * question), or when cc-mail to it is stuck undelivered.
 */
export function computeNeedsYou(project: Project, tasks: ProjectTask[] | null, reports: ProjectReport[] = []): NeedsYou[] {
  const out: NeedsYou[] = []
  const now = Date.now()
  const consider = (task: ProjectTask | null, agent: Project["agent"], mail: Project["mail"], report: ProjectReport | null) => {
    if (report && report.severity === "attention") {
      const resumed = agent && agent.state === "working" && agent.ts > report.ts
      if (!resumed) out.push({ task, reason: "report", text: report.text, since: report.ts })
    }
    if (agent && agent.state === "attention") {
      out.push({ task, reason: "agent", text: agent.summary?.trim() || "agent is waiting for input", since: agent.ts })
    }
    if (mail && isMailStuck(mail, now)) {
      out.push({
        task,
        reason: "mail",
        text: `${mail.count} message${mail.count === 1 ? "" : "s"} undelivered for ${mailWaitMinutes(mail, now)}m (from ${mail.oldestFrom})`,
        since: new Date(mail.oldestAt || now).toISOString(),
      })
    }
  }
  const central = tasks?.find((t) => t.role === "central") ?? null
  consider(null, central?.agent ?? project.agent, central?.mail ?? project.mail, central?.lastReport ?? null)
  for (const t of tasks ?? []) if (t.role !== "central") consider(t, t.agent, t.mail, t.lastReport)
  // Attention reports from tabs that are not (or no longer) in the session —
  // the session is down, or the tab was closed with a question still open.
  // Kept for three days so a closed tab cannot nag forever.
  const matched = new Set((tasks ?? []).map((t) => t.lastReport?.from).filter(Boolean))
  const latestByFrom = new Map<string, ProjectReport>()
  for (const r of reports) latestByFrom.set(r.from, r)
  for (const [from, r] of latestByFrom) {
    if (matched.has(from) || r.severity !== "attention") continue
    if (now - new Date(r.ts).getTime() > 3 * 24 * 60 * 60 * 1000) continue
    out.push({ task: null, label: from, reason: "report", text: `${r.text} (tab not open)`, since: r.ts })
  }
  return out.sort((a, b) => a.since.localeCompare(b.since))
}
