import type { LoadState, Row } from "../types.ts"

const C = {
  dim: "#6b7280",
  header: "#93c5fd",
  ticket: "#a78bfa",
  url: "#67e8f9",
  title: "#e5e7eb",
  green: "#4ade80",
  yellow: "#facc15",
  red: "#f87171",
  cyan: "#67e8f9",
  gray: "#9ca3af",
  selectedBg: "#1f2937",
}

const GAP = 2
function fit(s: string, w: number): string {
  const usable = Math.max(1, w - GAP)
  if (s.length > usable) return (s.slice(0, usable - 1) + "…").padEnd(w)
  return s.padEnd(w)
}

const COLS = {
  ticket: 12,
  url: 62,
  agent: 11,
  approval: 24,
}
const FIXED_WIDTH = COLS.ticket + COLS.url + COLS.agent + COLS.approval

const AGENT_LABELS: Record<string, { label: string; color: string }> = {
  working: { label: "● busy", color: C.yellow },
  idle: { label: "✓ idle", color: C.cyan },
  attention: { label: "! input", color: C.red },
  start: { label: "○ up", color: C.gray },
}

function agentCell(row: Row): { text: string; color: string } {
  if (!row.agent) return { text: fit("-", COLS.agent), color: C.dim }
  const mapped = AGENT_LABELS[row.agent.state] ?? { label: row.agent.state, color: C.gray }
  return { text: fit(mapped.label, COLS.agent), color: mapped.color }
}

/** "✓ approved 2/2 ★" — ★ marks your own approval. */
export function approvalCell(row: Row, me: string | null, loaded: boolean): { text: string; color: string } {
  if (!row.mr) return { text: fit(loaded ? "no MR" : "…", COLS.approval), color: C.dim }
  if (row.mr.state !== "opened") return { text: fit(row.mr.state, COLS.approval), color: row.mr.state === "merged" ? C.green : C.gray }
  const a = row.approval
  if (!a) return { text: fit(loaded ? "approval ?" : "…", COLS.approval), color: C.dim }
  const got = a.approvalsRequired - a.approvalsLeft
  const mine = me && a.approvedBy.includes(me) ? " ★" : ""
  if (a.approved) return { text: fit(`✓ approved ${got}/${a.approvalsRequired}${mine}`, COLS.approval), color: C.green }
  if (got > 0) return { text: fit(`${got}/${a.approvalsRequired} approved${mine}`, COLS.approval), color: C.yellow }
  return { text: fit(`unapproved 0/${a.approvalsRequired}`, COLS.approval), color: C.gray }
}

export function Reviews({
  rows,
  selected,
  load,
  me,
  width,
  height,
}: {
  rows: Row[]
  selected: number
  load: LoadState
  /** GitLab username of the glab login, for the ★ marker */
  me: string | null
  width: number
  height: number
}) {
  const titleWidth = Math.max(10, width - FIXED_WIDTH - 2)
  const maxVisible = Math.max(1, height)
  let start = 0
  if (rows.length > maxVisible) {
    start = Math.min(Math.max(0, selected - Math.floor(maxVisible / 2)), rows.length - maxVisible)
  }
  const visible = rows.slice(start, start + maxVisible)

  return (
    <box flexDirection="column">
      <text>
        <span fg={C.header}>
          {fit("TICKET", COLS.ticket)}
          {fit("MR", COLS.url)}
          {fit("TITLE", titleWidth)}
          {fit("AGENT", COLS.agent)}
          {fit("APPROVAL", COLS.approval)}
        </span>
      </text>
      {visible.map((row, i) => {
        const idx = start + i
        const isSelected = idx === selected
        const agent = agentCell(row)
        const approval = approvalCell(row, me, load.gitlab)
        const url = row.mr?.url ?? (load.gitlab ? "no MR for this branch" : "…")
        const title = row.mr?.title ?? row.ticket?.summary ?? ""
        return (
          <box key={row.worktreePath} backgroundColor={isSelected ? C.selectedBg : undefined}>
            <text>
              <span fg={isSelected ? "#ffffff" : C.ticket}>
                {isSelected ? "▸" : " "}
                {fit(row.ticketKey ?? row.branch, COLS.ticket - 1)}
              </span>
              <span fg={row.mr ? C.url : C.dim}>{fit(url, COLS.url)}</span>
              <span fg={C.title}>{fit(title, titleWidth)}</span>
              <span fg={agent.color}>{agent.text}</span>
              <span fg={approval.color}>{approval.text}</span>
            </text>
          </box>
        )
      })}
    </box>
  )
}
