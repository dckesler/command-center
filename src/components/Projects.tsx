import { projectNeeds, type Project } from "../data/projects.ts"
import { isMailStuck, mailWaitMinutes, type PendingMail } from "../data/mail.ts"

const C = {
  dim: "#6b7280",
  header: "#93c5fd",
  key: "#a78bfa",
  value: "#e5e7eb",
  green: "#4ade80",
  yellow: "#facc15",
  red: "#f87171",
  gray: "#9ca3af",
  selectedBg: "#1f2937",
}

/** Pad/truncate to `w`, always leaving a gutter so columns never touch. */
const GAP = 2
function fit(s: string, w: number): string {
  const usable = Math.max(1, w - GAP)
  if (s.length > usable) return (s.slice(0, usable - 1) + "…").padEnd(w)
  return s.padEnd(w)
}

const COLS = {
  name: 26,
  status: 9,
  plan: 10,
  needs: 7,
  epic: 11,
  next: 6,
  updated: 13,
  tmux: 8,
  agent: 11,
}
const FIXED_WIDTH = Object.values(COLS).reduce((a, b) => a + b, 0)
/** "✉2 " / "✉2 68m " — undelivered cc-mail waiting for the agent (age once stuck); fills the tail of the AGENT column. */
const mailTag = (m: PendingMail) => (isMailStuck(m) ? `✉${m.count} ${mailWaitMinutes(m)}m ` : `✉${m.count} `)

function relativeDays(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  if (days < 30) return `${days} days ago`
  const months = Math.floor(days / 30)
  return months === 1 ? "a month ago" : `${months} months ago`
}

const STATUS_COLORS: Record<string, string> = {
  active: "#4ade80",
  paused: "#facc15",
  done: "#6b7280",
  unknown: "#9ca3af",
}

/** `**Plan:**` state → short label + colour. Gates (waiting on the user) are red. */
const PLAN_VIEW: Record<string, { label: string; color: string }> = {
  none: { label: "-", color: "#6b7280" },
  draft: { label: "draft", color: "#9ca3af" },
  proposed: { label: "approve?", color: "#f87171" },
  approved: { label: "approved", color: "#4ade80" },
  revision: { label: "revision?", color: "#f87171" },
}

const AGENT_COLORS: Record<string, string> = {
  working: "#facc15",
  attention: "#f87171",
  idle: "#4ade80",
  start: "#9ca3af",
}

/** Lines under the table for the selected project (goal + current state). */
const PREVIEW_LINES = 3

export function Projects({
  projects,
  hiddenCount = 0,
  selected,
  loading,
  width,
  height,
}: {
  projects: Project[]
  /** done / all-steps-checked projects left out of `projects` (v shows them) */
  hiddenCount?: number
  selected: number
  loading: boolean
  width: number
  height: number
}) {
  const summaryWidth = Math.max(10, width - FIXED_WIDTH - 2)

  if (loading && projects.length === 0) {
    return (
      <box>
        <text fg={C.dim}>loading projects…</text>
      </box>
    )
  }

  const current = projects[selected]
  const preview: string[] = []
  if (current?.brief) {
    const previewWidth = Math.max(20, width - 4)
    const needs = projectNeeds(current)
    const text = [
      needs.length && `needs you: ${needs.join("; ")}`,
      current.brief.goal && `goal: ${current.brief.goal}`,
      current.brief.currentState && `now: ${current.brief.currentState}`,
    ]
      .filter((x): x is string => typeof x === "string" && !!x)
      .join("  ·  ")
    for (let i = 0; i < text.length && preview.length < PREVIEW_LINES; i += previewWidth) {
      preview.push(text.slice(i, i + previewWidth))
    }
  }

  // Header row + optional hidden-count line + optional preview block (blank line + lines).
  const maxVisible = Math.max(1, height - 1 - (hiddenCount > 0 ? 1 : 0) - (preview.length ? preview.length + 1 : 0))
  let start = 0
  if (projects.length > maxVisible) {
    start = Math.min(Math.max(0, selected - Math.floor(maxVisible / 2)), projects.length - maxVisible)
  }
  const visible = projects.slice(start, start + maxVisible)

  return (
    <box flexDirection="column">
      <text wrapMode="none">
        <span fg={C.header}>
          {fit("PROJECT", COLS.name)}
          {fit("STATUS", COLS.status)}
          {fit("PLAN", COLS.plan)}
          {fit("NEEDS", COLS.needs)}
          {fit("EPIC", COLS.epic)}
          {fit("NEXT", COLS.next)}
          {fit("UPDATED", COLS.updated)}
          {fit("TMUX", COLS.tmux)}
          {fit("AGENT", COLS.agent)}
          {fit("GOAL", summaryWidth)}
        </span>
      </text>
      {visible.map((project, i) => {
        const idx = start + i
        const isSelected = idx === selected
        const brief = project.brief
        const status = brief?.status ?? "unknown"
        const plan = PLAN_VIEW[brief?.plan ?? "none"] ?? PLAN_VIEW.none
        const needs = projectNeeds(project).length
        return (
          <box key={project.name} backgroundColor={isSelected ? C.selectedBg : undefined}>
            <text wrapMode="none">
              <span fg={isSelected ? "#ffffff" : C.key}>{isSelected ? "▸" : " "}{fit(project.name, COLS.name - 1)}</span>
              <span fg={brief ? STATUS_COLORS[status] : C.red}>{fit(brief ? status : "no brief", COLS.status)}</span>
              <span fg={plan.color}>{fit(brief ? plan.label : "-", COLS.plan)}</span>
              <span fg={needs ? C.red : C.dim}>{fit(needs ? String(needs) : "-", COLS.needs)}</span>
              <span fg={brief?.epic ? C.key : C.dim}>{fit(brief?.epic ?? "-", COLS.epic)}</span>
              <span fg={C.value}>{fit(brief ? String(brief.nextSteps.length) : "-", COLS.next)}</span>
              <span fg={C.dim}>{fit(relativeDays(project.modified), COLS.updated)}</span>
              <span fg={project.tmuxWindow ? C.green : C.dim}>{fit(project.tmuxWindow ?? "-", COLS.tmux)}</span>
              <span fg={project.agent ? AGENT_COLORS[project.agent.state] ?? C.gray : C.dim}>
                {fit(project.agent?.state ?? "-", project.mail ? COLS.agent - mailTag(project.mail).length : COLS.agent)}
              </span>
              {project.mail && <span fg={isMailStuck(project.mail) ? C.red : C.yellow}>{mailTag(project.mail)}</span>}
              <span fg={C.gray}>{fit(brief?.goal || (brief ? "" : "press s to create PROJECT.md and start"), summaryWidth)}</span>
            </text>
          </box>
        )
      })}
      {projects.length === 0 && !loading && (
        <text fg={C.dim}>{hiddenCount > 0 ? "no active projects — press n to create one" : "no projects — press n to create one"}</text>
      )}
      {hiddenCount > 0 && (
        <text fg={C.dim}>{`${hiddenCount} done hidden — v to show`}</text>
      )}
      {preview.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          {preview.map((line, i) => (
            <text key={i} fg={C.gray}>{line}</text>
          ))}
        </box>
      )}
    </box>
  )
}
