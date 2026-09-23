import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { config } from "../config.ts"
import { readAgentStatuses, type AgentStatus } from "./agents.ts"
import { listTmuxWindows, projectSessionName } from "./tmux.ts"

/**
 * Projects are plain directories under ~/projects. Each one is tracked by a
 * PROJECT.md brief (goal, current state, next steps, log) that the project's
 * tmux agent keeps current. The control center itself is excluded.
 */

export const PROJECTS_DIR = config().dirs.projects
export const BRIEF_FILE = "PROJECT.md"

/** Directory names that never show up as projects (config.projects.exclude). */
const EXCLUDED = new Set(config().projects.exclude)

export type ProjectStatus = "active" | "paused" | "done" | "unknown"

export interface ProjectBrief {
  title: string
  status: ProjectStatus
  /** "Updated:" line from the brief, if present (YYYY-MM-DD). */
  updated: string | null
  /** First paragraph under "## Goal". */
  goal: string
  /** First paragraph under "## Current state". */
  currentState: string
  /** Unchecked items under "## Next steps". */
  nextSteps: string[]
  doneSteps: number
}

export interface Project {
  /** Directory name — also the tmux session/window name. */
  name: string
  path: string
  brief: ProjectBrief | null
  /** mtime of PROJECT.md, else of the directory (ISO). */
  modified: string
  /** tmux `session:index` of the project's window (own session named after the project). */
  tmuxWindow: string | null
  /** Latest hook state of an agent running in this directory. */
  agent: AgentStatus | null
}

// ---------------------------------------------------------------------------
// brief parsing

function firstParagraph(section: string): string {
  const lines = section.split("\n").map((l) => l.trim())
  const out: string[] = []
  for (const line of lines) {
    if (!line) {
      if (out.length) break
      continue
    }
    out.push(line)
  }
  return out.join(" ")
}

function sectionAfter(body: string, heading: RegExp): string {
  const lines = body.split("\n")
  const start = lines.findIndex((l) => heading.test(l.trim()))
  if (start === -1) return ""
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^##\s/.test(l))
  return (end === -1 ? rest : rest.slice(0, end)).join("\n")
}

export function parseBrief(markdown: string, fallbackTitle: string): ProjectBrief {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallbackTitle
  const statusRaw = markdown.match(/^\**Status:?\**:?\s*(.+)$/im)?.[1]?.trim().toLowerCase() ?? ""
  const status: ProjectStatus = statusRaw.startsWith("active")
    ? "active"
    : statusRaw.startsWith("paused") || statusRaw.startsWith("on hold")
      ? "paused"
      : statusRaw.startsWith("done") || statusRaw.startsWith("complete") || statusRaw.startsWith("shipped")
        ? "done"
        : "unknown"
  const updated = markdown.match(/^\**Updated:?\**:?\s*(\d{4}-\d{2}-\d{2})/im)?.[1] ?? null
  const steps = sectionAfter(markdown, /^##\s+next steps/i)
  const nextSteps: string[] = []
  let doneSteps = 0
  for (const line of steps.split("\n")) {
    const m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.+)$/)
    if (!m) continue
    if (m[1] === " ") nextSteps.push(m[2].trim())
    else doneSteps++
  }
  return {
    title,
    status,
    updated,
    goal: firstParagraph(sectionAfter(markdown, /^##\s+goal/i)),
    currentState: firstParagraph(sectionAfter(markdown, /^##\s+current state/i)),
    nextSteps,
    doneSteps,
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export function briefTemplate(name: string, goal = ""): string {
  return [
    `# ${name}`,
    "",
    "**Status:** active",
    `**Updated:** ${today()}`,
    "",
    "## Goal",
    "",
    goal || "_What this project is for, in one paragraph._",
    "",
    "## Current state",
    "",
    "_Where things are right now. Keep this current — it is what the control center shows._",
    "",
    "## Next steps",
    "",
    "- [ ] Define the first concrete step",
    "",
    "## Log",
    "",
    `- ${today()}: project created`,
    "",
  ].join("\n")
}

// ---------------------------------------------------------------------------
// listing

export function briefPath(projectPath: string): string {
  return join(projectPath, BRIEF_FILE)
}

export function readBrief(projectPath: string): ProjectBrief | null {
  const path = briefPath(projectPath)
  if (!existsSync(path)) return null
  try {
    return parseBrief(readFileSync(path, "utf8"), basename(projectPath))
  } catch {
    return null
  }
}

export function readBriefRaw(projectPath: string): string | null {
  const path = briefPath(projectPath)
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

function isLinkedWorktree(dir: string): boolean {
  try {
    return statSync(join(dir, ".git")).isFile()
  } catch {
    return false
  }
}

export function isProjectDir(dir: string): boolean {
  if (!dir.startsWith(`${PROJECTS_DIR}/`)) return false
  const rel = dir.slice(PROJECTS_DIR.length + 1)
  const name = rel.split("/")[0]
  if (!name || name.startsWith(".") || EXCLUDED.has(name)) return false
  return !isLinkedWorktree(join(PROJECTS_DIR, name))
}

/** Project root that contains `dir`, or null. */
export function projectRootOf(dir: string): string | null {
  if (!isProjectDir(dir)) return null
  return join(PROJECTS_DIR, dir.slice(PROJECTS_DIR.length + 1).split("/")[0])
}

function listProjectDirs(): string[] {
  if (!existsSync(PROJECTS_DIR)) return []
  return readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !EXCLUDED.has(e.name))
    // Linked git worktrees (`.git` is a file) of repos that live in ~/projects
    // belong to the worktrees tab, not here.
    .filter((e) => !isLinkedWorktree(join(PROJECTS_DIR, e.name)))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
}

const STATUS_RANK: Record<ProjectStatus, number> = { active: 0, unknown: 1, paused: 2, done: 3 }

/** Active first, then most recently modified. */
export function sortProjects(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => {
    const sa = STATUS_RANK[a.brief?.status ?? "unknown"]
    const sb = STATUS_RANK[b.brief?.status ?? "unknown"]
    if (sa !== sb) return sa - sb
    return b.modified.localeCompare(a.modified)
  })
}

export async function listProjects(): Promise<Project[]> {
  const names = listProjectDirs()
  const [windows, agents] = await Promise.all([listTmuxWindows(), Promise.resolve(readAgentStatuses())])
  const projects = names.map((name): Project => {
    const path = join(PROJECTS_DIR, name)
    const brief = readBrief(path)
    let modified: string
    try {
      const target = existsSync(briefPath(path)) ? briefPath(path) : path
      modified = statSync(target).mtime.toISOString()
    } catch {
      modified = new Date(0).toISOString()
    }
    // Projects run in their own session named after the directory; fall back
    // to a same-named window anywhere (older launches).
    const session = projectSessionName(name)
    const window =
      windows.find((w) => w.target.startsWith(`${session}:`)) ?? windows.find((w) => w.name === name)
    return {
      name,
      path,
      brief,
      modified,
      tmuxWindow: window?.target ?? null,
      agent: agents.get(path) ?? null,
    }
  })
  return sortProjects(projects)
}

// ---------------------------------------------------------------------------
// creation

/** Directory-safe project name: lowercase, hyphens, no leading dots. */
export function slugifyProjectName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64)
}

export function createProject(rawName: string, goal = ""): { ok: boolean; message: string; project?: { name: string; path: string } } {
  const name = slugifyProjectName(rawName)
  if (!name) return { ok: false, message: "project name is empty after cleanup" }
  if (EXCLUDED.has(name)) return { ok: false, message: `"${name}" is reserved` }
  const path = join(PROJECTS_DIR, name)
  if (existsSync(path)) return { ok: false, message: `${path} already exists — resume it instead` }
  try {
    mkdirSync(path, { recursive: true })
    writeFileSync(briefPath(path), briefTemplate(name, goal))
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, message: `created ${path}`, project: { name, path } }
}

/**
 * Worker reports delivered to a project's central agent by
 * `cc-report project:<name>` (appended to <project>/.cc/inbox.jsonl).
 */
export function readProjectReports(projectPath: string, count = 20): string[] {
  const path = join(projectPath, ".cc", "inbox.jsonl")
  if (!existsSync(path)) return []
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return []
  }
  const out: string[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as { ts?: string; from?: string; severity?: string; text?: string }
      const clock = r.ts ? new Date(r.ts).toTimeString().slice(0, 5) : "--:--"
      out.push(`[${clock}] ${r.from ?? "?"} (${r.severity ?? "info"}): ${r.text ?? ""}`)
    } catch {
      // skip malformed
    }
  }
  return out.slice(-count)
}

/** One-line summary used by the specialist and digests. */
export function fmtProject(p: Project): string {
  const b = p.brief
  const parts = [
    p.name,
    b ? `status ${b.status}` : "no PROJECT.md",
    b && b.nextSteps.length ? `${b.nextSteps.length} next step${b.nextSteps.length === 1 ? "" : "s"}` : null,
    p.tmuxWindow ? `window ${p.tmuxWindow}` : "no window",
    p.agent ? `agent ${p.agent.state} (${p.agent.source})` : "no agent",
  ].filter((x): x is string => !!x)
  return parts.join(" | ")
}
