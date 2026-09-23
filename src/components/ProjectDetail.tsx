import type { ReactNode } from "react"
import type { Project, ProjectReport, ProjectTask } from "../data/projects.ts"
import type { TicketInfo } from "../types.ts"

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

const STATUS_COLORS: Record<string, string> = {
  active: C.green,
  paused: C.yellow,
  done: C.dim,
  unknown: C.gray,
}

const AGENT_COLORS: Record<string, string> = {
  working: C.yellow,
  attention: C.red,
  idle: C.green,
  start: C.gray,
}

const SEVERITY_COLORS: Record<string, string> = { info: C.gray, warn: C.yellow, attention: C.red }

/** Pad/truncate to `w`, always leaving a gutter so columns never touch. */
const GAP = 2
function fit(s: string, w: number): string {
  const usable = Math.max(1, w - GAP)
  if (s.length > usable) return (s.slice(0, usable - 1) + "…").padEnd(w)
  return s.padEnd(w)
}

function wrap(text: string, width: number, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ""
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
      if (lines.length === max) break
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line && lines.length < max) lines.push(line)
  if (lines.length === max && words.join(" ").length > lines.join(" ").length) {
    lines[max - 1] = `${lines[max - 1].slice(0, Math.max(0, width - 1))}…`
  }
  return lines
}

function ticketColor(t: TicketInfo): string {
  if (t.statusCategory === "Done") return C.green
  if (t.statusCategory === "In Progress") return C.yellow
  if (t.status === "Blocked") return C.red
  return C.value
}

function relative(iso: string): string {
  if (!iso) return ""
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

const COLS = { tab: 26, where: 24, ticket: 22, mr: 14, agent: 11 }
const FIXED_WIDTH = Object.values(COLS).reduce((a, b) => a + b, 0)

export interface EpicSummary {
  key: string
  /** null while loading; undefined when Jira could not find it */
  ticket: TicketInfo | null | undefined
  children: TicketInfo[] | null
}

export function ProjectDetail({
  project,
  tasks,
  epic,
  reports,
  selected,
  width,
  height,
}: {
  project: Project
  /** null = session not running; undefined = loading */
  tasks: ProjectTask[] | null | undefined
  /** null = no epic on this project */
  epic: EpicSummary | null
  reports: ProjectReport[]
  selected: number
  width: number
  height: number
}) {
  const brief = project.brief
  const status = brief?.status ?? "unknown"
  const textWidth = Math.max(20, width - 4)

  // --- header block ---------------------------------------------------------
  const header: ReactNode[] = []
  header.push(
    <text key="title">
      <span fg={C.key}>{project.name}</span>
      <span fg={C.value}>{brief && brief.title !== project.name ? `  ${brief.title}` : ""}</span>
      <span fg={C.dim}>{`  ${project.path}`}</span>
    </text>,
  )
  header.push(
    <text key="status">
      <span fg={brief ? STATUS_COLORS[status] : C.red}>{brief ? status : "no PROJECT.md"}</span>
      <span fg={C.dim}>{brief?.updated ? `   updated ${brief.updated}` : ""}</span>
      <span fg={C.dim}>{"   session "}</span>
      <span fg={project.tmuxWindow ? C.green : C.dim}>{project.tmuxWindow ?? "not running"}</span>
      <span fg={C.dim}>{"   central agent "}</span>
      <span fg={project.agent ? AGENT_COLORS[project.agent.state] ?? C.gray : C.dim}>{project.agent?.state ?? "none"}</span>
      <span fg={C.dim}>
        {brief ? `   ${brief.doneSteps} done / ${brief.nextSteps.length} open steps` : ""}
      </span>
    </text>,
  )
  if (epic) {
    const t = epic.ticket
    const done = epic.children?.filter((c) => c.statusCategory === "Done").length ?? 0
    header.push(
      <text key="epic">
        <span fg={C.dim}>epic </span>
        <span fg={C.key}>{epic.key}</span>
        {t === null ? (
          <span fg={C.dim}>  loading…</span>
        ) : t === undefined ? (
          <span fg={C.red}>  not found in Jira</span>
        ) : (
          <>
            <span fg={C.value}>{`  ${t.summary}`}</span>
            <span fg={ticketColor(t)}>{`  ${t.status}`}</span>
            <span fg={C.dim}>
              {epic.children ? `  ${done}/${epic.children.length} tickets done` : "  loading tickets…"}
            </span>
          </>
        )}
      </text>,
    )
  } else {
    header.push(
      <text key="epic" fg={C.dim}>
        epic none — press e to link one
      </text>,
    )
  }
  if (brief?.goal) for (const line of wrap(`goal: ${brief.goal}`, textWidth, 2)) header.push(<text key={`g${header.length}`} fg={C.gray}>{line}</text>)
  if (brief?.currentState)
    for (const line of wrap(`now: ${brief.currentState}`, textWidth, 3)) header.push(<text key={`s${header.length}`} fg={C.value}>{line}</text>)

  // --- task table -------------------------------------------------------------
  const list = tasks ?? []
  const reportWidth = Math.max(10, width - FIXED_WIDTH - 2)
  const nextStepsBudget = brief?.nextSteps.length ? Math.min(brief.nextSteps.length, 4) + 1 : 0
  const reportsBudget = reports.length ? Math.min(reports.length, 4) + 1 : 0
  const tableRows = Math.max(1, height - header.length - 2 - nextStepsBudget - reportsBudget - 1)
  let start = 0
  if (list.length > tableRows) {
    start = Math.min(Math.max(0, selected - Math.floor(tableRows / 2)), list.length - tableRows)
  }
  const visible = list.slice(start, start + tableRows)

  return (
    <box flexDirection="column">
      {header}
      <text> </text>
      <text>
        <span fg={C.header}>
          {fit("AGENT / TAB", COLS.tab)}
          {fit("WHERE", COLS.where)}
          {fit("TICKET", COLS.ticket)}
          {fit("MR", COLS.mr)}
          {fit("STATE", COLS.agent)}
          {fit("LAST REPORT", reportWidth)}
        </span>
      </text>
      {tasks === undefined && <text fg={C.dim}>  loading task tabs…</text>}
      {tasks === null && <text fg={C.dim}>  session not running — press s to start it</text>}
      {tasks && tasks.length === 0 && <text fg={C.dim}>  session has no windows</text>}
      {visible.map((t, i) => {
        const idx = start + i
        const isSelected = idx === selected
        const where = t.worktree
          ? `${t.repo ?? "worktree"}${t.branch ? `@${t.branch}` : ""}`
          : t.path === project.path
            ? "project dir"
            : t.path.replace(project.path, ".")
        const ticket = t.ticketKey ? `${t.ticketKey}${t.ticket ? ` ${t.ticket.status}` : ""}` : "-"
        const mr = t.mr ? `!${t.mr.iid} ${t.mr.state}${t.mr.pipelineStatus ? ` ${t.mr.pipelineStatus}` : ""}` : "-"
        const report = t.lastReport ? `${relative(t.lastReport.ts)} ${t.lastReport.text}` : "-"
        return (
          <box key={t.target} backgroundColor={isSelected ? C.selectedBg : undefined}>
            <text>
              <span fg={isSelected ? "#ffffff" : t.role === "central" ? C.key : C.value}>
                {isSelected ? "▸" : " "}
                {fit(t.role === "central" ? "central" : t.name, COLS.tab - 1)}
              </span>
              <span fg={t.worktree ? C.green : C.gray}>{fit(where, COLS.where)}</span>
              <span fg={t.ticket ? ticketColor(t.ticket) : t.ticketKey ? C.value : C.dim}>{fit(ticket, COLS.ticket)}</span>
              <span fg={t.mr ? (t.mr.state === "merged" ? C.green : t.mr.hasConflicts ? C.red : C.value) : C.dim}>{fit(mr, COLS.mr)}</span>
              <span fg={t.agent ? AGENT_COLORS[t.agent.state] ?? C.gray : C.dim}>{fit(t.agent?.state ?? "-", COLS.agent)}</span>
              <span fg={t.lastReport ? SEVERITY_COLORS[t.lastReport.severity] : C.dim}>{fit(report, reportWidth)}</span>
            </text>
          </box>
        )
      })}
      {brief && brief.nextSteps.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <text fg={C.header}>NEXT STEPS</text>
          {brief.nextSteps.slice(0, 4).map((step, i) => (
            <text key={i} fg={C.value}>
              {"  - "}
              {fit(step, textWidth - 4)}
            </text>
          ))}
        </box>
      )}
      {reports.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <text fg={C.header}>RECENT REPORTS</text>
          {reports.slice(-4).reverse().map((r, i) => (
            <text key={i}>
              <span fg={C.dim}>{`  ${relative(r.ts).padStart(3)} `}</span>
              <span fg={SEVERITY_COLORS[r.severity]}>{r.from}</span>
              <span fg={C.gray}>{`: ${fit(r.text, Math.max(10, textWidth - r.from.length - 8))}`}</span>
            </text>
          ))}
        </box>
      )}
    </box>
  )
}
