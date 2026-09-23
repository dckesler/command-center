import { Agent, CursorAgentError } from "@cursor/sdk"
import { run } from "./exec.ts"
import { parseRepoMap } from "./repos.ts"
import { config } from "../config.ts"

const MODEL = config().model

export interface CloudAgent {
  id: string
  name: string
  summary: string
  /** Latest known execution status (run status, else agent status). */
  status: string
  archived: boolean
  repos: string[]
  url: string
  lastModified: number
  runId?: string
  branch?: string
  prUrl?: string
}

export interface CloudRepo {
  alias: string
  url: string
  startingRef: string
}

export interface CloudResult {
  ok: boolean
  message: string
}

function apiKey(): string | null {
  const key = process.env.CURSOR_API_KEY?.trim()
  return key || null
}

/** git@host:path.git → https://host/path.git; already-https URLs pass through. */
export function httpsRemote(url: string): string {
  const trimmed = url.trim()
  const ssh = trimmed.match(/^git@([^:]+):(.+)$/)
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`
  return trimmed
}

function agentUrl(id: string): string {
  return `https://cursor.com/agents/${id}`
}

function repoLabel(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\.git$/, "")
}

export async function listCloudRepos(): Promise<CloudRepo[]> {
  const repos = parseRepoMap()
  const out = await Promise.all(
    repos.map(async (repo) => {
      const remote = await run("git", ["-C", repo.path, "remote", "get-url", "origin"])
      if (!remote.ok || !remote.stdout.trim()) return null
      const head = await run("git", ["-C", repo.path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
      const startingRef = head.ok ? head.stdout.trim().replace(/^origin\//, "") : "master"
      return { alias: repo.alias, url: httpsRemote(remote.stdout.trim()), startingRef }
    }),
  )
  return out.filter((r): r is CloudRepo => r !== null)
}

export async function resolveCloudRepo(alias: string): Promise<CloudRepo | null> {
  const repos = await listCloudRepos()
  return repos.find((r) => r.alias === alias) ?? null
}

function sortCloudAgents(agents: CloudAgent[]): CloudAgent[] {
  const rank = (a: CloudAgent) => {
    if (a.status === "running" || a.status === "CREATING" || a.status === "RUNNING") return 0
    if (a.status === "error" || a.status === "ERROR") return 1
    return 2
  }
  return [...agents].sort((a, b) => rank(a) - rank(b) || b.lastModified - a.lastModified)
}

async function enrich(info: {
  agentId: string
  name: string
  summary: string
  status?: string
  lastModified: number
  archived?: boolean
  repos?: string[]
}): Promise<CloudAgent> {
  const key = apiKey()
  let runId: string | undefined
  let status = info.status ?? "idle"
  let branch: string | undefined
  let prUrl: string | undefined
  if (key) {
    try {
      const runs = await Agent.listRuns(info.agentId, { runtime: "cloud", apiKey: key, limit: 1 })
      const latest = runs.items[0]
      if (latest) {
        runId = latest.id
        status = latest.status
        const git = latest.git?.branches[0]
        branch = git?.branch
        prUrl = git?.prUrl
      }
    } catch {
      // list row is enough when run lookup fails
    }
  }
  return {
    id: info.agentId,
    name: info.name,
    summary: info.summary,
    status,
    archived: info.archived === true,
    repos: info.repos ?? [],
    url: agentUrl(info.agentId),
    lastModified: info.lastModified > 0 && info.lastModified < 1e12 ? info.lastModified * 1000 : info.lastModified,
    runId,
    branch,
    prUrl,
  }
}

export async function listCloudAgents(): Promise<{ ok: boolean; agents: CloudAgent[]; message?: string }> {
  const key = apiKey()
  if (!key) return { ok: false, agents: [], message: "CURSOR_API_KEY is not set" }
  try {
    const listed = await Agent.list({ runtime: "cloud", apiKey: key, limit: 50, includeArchived: false })
    const agents = await Promise.all(listed.items.filter((a) => a.runtime !== "local").map((a) => enrich(a)))
    return { ok: true, agents: sortCloudAgents(agents) }
  } catch (err) {
    const message = err instanceof CursorAgentError ? err.message : err instanceof Error ? err.message : "cloud list failed"
    return { ok: false, agents: [], message }
  }
}

export async function startCloudAgent(alias: string, prompt: string, branch?: string): Promise<CloudResult> {
  const key = apiKey()
  if (!key) return { ok: false, message: "CURSOR_API_KEY is not set" }
  const repo = await resolveCloudRepo(alias)
  if (!repo) return { ok: false, message: `unknown repo "${alias}" — use a mkpanes alias` }
  try {
    const agent = await Agent.create({
      apiKey: key,
      name: `${alias}: ${prompt.slice(0, 60)}`,
      model: { id: MODEL },
      cloud: {
        repos: [{ url: repo.url, startingRef: branch?.trim() || repo.startingRef }],
        autoCreatePR: false,
        skipReviewerRequest: true,
      },
    })
    try {
      const run = await agent.send(prompt)
      return { ok: true, message: `started ${agent.agentId} (${run.id}) on ${repoLabel(repo.url)}` }
    } finally {
      await agent[Symbol.asyncDispose]()
    }
  } catch (err) {
    if (err instanceof CursorAgentError) return { ok: false, message: `start failed: ${err.message}` }
    return { ok: false, message: err instanceof Error ? err.message : "start failed" }
  }
}

export async function followUpCloudAgent(agentId: string, prompt: string): Promise<CloudResult> {
  const key = apiKey()
  if (!key) return { ok: false, message: "CURSOR_API_KEY is not set" }
  try {
    const agent = await Agent.resume(agentId, { apiKey: key })
    try {
      const run = await agent.send(prompt)
      return { ok: true, message: `follow-up sent to ${agentId} (${run.id})` }
    } finally {
      await agent[Symbol.asyncDispose]()
    }
  } catch (err) {
    if (err instanceof CursorAgentError) return { ok: false, message: `follow-up failed: ${err.message}` }
    return { ok: false, message: err instanceof Error ? err.message : "follow-up failed" }
  }
}

export async function cancelCloudRun(agentId: string): Promise<CloudResult> {
  const key = apiKey()
  if (!key) return { ok: false, message: "CURSOR_API_KEY is not set" }
  try {
    const runs = await Agent.listRuns(agentId, { runtime: "cloud", apiKey: key, limit: 1 })
    const run = runs.items[0]
    if (!run) return { ok: false, message: `${agentId} has no runs` }
    if (run.status !== "running") return { ok: false, message: `${agentId} is not running (status ${run.status})` }
    if (run.supports("cancel")) await run.cancel()
    else await Agent.cancelRun(run.id, { runtime: "cloud", agentId, apiKey: key })
    return { ok: true, message: `cancelled ${run.id}` }
  } catch (err) {
    if (err instanceof CursorAgentError) return { ok: false, message: `cancel failed: ${err.message}` }
    return { ok: false, message: err instanceof Error ? err.message : "cancel failed" }
  }
}

export function fmtCloudAgent(agent: CloudAgent): string {
  const repo = agent.repos[0] ? repoLabel(agent.repos[0]) : "no repo"
  const extra = [agent.branch, agent.prUrl].filter(Boolean).join(" ")
  return `${agent.id} [${agent.status}] ${agent.name} | ${repo}${extra ? ` | ${extra}` : ""}${agent.summary ? ` — ${agent.summary}` : ""}`
}
