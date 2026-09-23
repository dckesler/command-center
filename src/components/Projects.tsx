import type { Project } from "../data/projects.ts"

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
  name: 30,
  status: 10,
  epic: 12,
  next: 7,
  updated: 13,
  tmux: 8,
  agent: 11,
}
const FIXED_WIDTH = Object.values(COLS).reduce((a, b) => a + b, 0)

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
  selected,
  loading,
  width,
  height,
}: {
  projects: Project[]
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
    const text = [current.brief.goal && `goal: ${current.brief.goal}`, current.brief.currentState && `now: ${current.brief.currentState}`]
      .filter((x): x is string => !!x)
      .join("  ·  ")
    for (let i = 0; i < text.length && preview.length < PREVIEW_LINES; i += previewWidth) {
      preview.push(text.slice(i, i + previewWidth))
    }
  }

  // Header row + optional preview block (blank line + lines).
  const maxVisible = Math.max(1, height - 1 - (preview.length ? preview.length + 1 : 0))
  let start = 0
  if (projects.length > maxVisible) {
    start = Math.min(Math.max(0, selected - Math.floor(maxVisible / 2)), projects.length - maxVisible)
  }
  const visible = projects.slice(start, start + maxVisible)

  return (
    <box flexDirection="column">
      <text>
        <span fg={C.header}>
          {fit("PROJECT", COLS.name)}
          {fit("STATUS", COLS.status)}
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
        return (
          <box key={project.name} backgroundColor={isSelected ? C.selectedBg : undefined}>
            <text>
              <span fg={isSelected ? "#ffffff" : C.key}>{isSelected ? "▸" : " "}{fit(project.name, COLS.name - 1)}</span>
              <span fg={brief ? STATUS_COLORS[status] : C.red}>{fit(brief ? status : "no brief", COLS.status)}</span>
              <span fg={brief?.epic ? C.key : C.dim}>{fit(brief?.epic ?? "-", COLS.epic)}</span>
              <span fg={C.value}>{fit(brief ? String(brief.nextSteps.length) : "-", COLS.next)}</span>
              <span fg={C.dim}>{fit(relativeDays(project.modified), COLS.updated)}</span>
              <span fg={project.tmuxWindow ? C.green : C.dim}>{fit(project.tmuxWindow ?? "-", COLS.tmux)}</span>
              <span fg={project.agent ? AGENT_COLORS[project.agent.state] ?? C.gray : C.dim}>
                {fit(project.agent?.state ?? "-", COLS.agent)}
              </span>
              <span fg={C.gray}>{fit(brief?.goal || (brief ? "" : "press s to create PROJECT.md and start"), summaryWidth)}</span>
            </text>
          </box>
        )
      })}
      {projects.length === 0 && !loading && (
        <text fg={C.dim}>no projects — press n to create one</text>
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
