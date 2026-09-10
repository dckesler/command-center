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

/** Pad/truncate to `w`, always leaving a gutter so columns never touch. */
const GAP = 2
function fit(s: string, w: number): string {
  const usable = Math.max(1, w - GAP)
  if (s.length > usable) return (s.slice(0, usable - 1) + "…").padEnd(w)
  return s.padEnd(w)
}

const COLS = {
  key: 12,
  type: 10,
  status: 18,
  assignee: 18,
  wt: 6,
}
const FIXED_WIDTH = Object.values(COLS).reduce((a, b) => a + b, 0)

function statusColor(t: TicketInfo): string {
  if (t.statusCategory === "Done") return C.green
  if (t.statusCategory === "In Progress") return C.yellow
  if (t.status === "Blocked") return C.red
  return C.value
}

export function EpicDetail({
  epic,
  tickets,
  worktreeKeys,
  windowKeys,
  selected,
  width,
  height,
}: {
  epic: TicketInfo
  /** null while the children are still loading */
  tickets: TicketInfo[] | null
  /** ticket keys that already have a local worktree (from the dashboard rows) */
  worktreeKeys: Set<string>
  /** ticket keys whose worktree also has a live tmux window */
  windowKeys: Set<string>
  selected: number
  width: number
  height: number
}) {
  const summaryWidth = Math.max(10, width - FIXED_WIDTH - 2)
  const done = tickets?.filter((t) => t.statusCategory === "Done").length ?? 0

  // Header takes 3 lines (title, progress, column header).
  const maxVisible = Math.max(1, height - 3)
  const list = tickets ?? []
  let start = 0
  if (list.length > maxVisible) {
    start = Math.min(Math.max(0, selected - Math.floor(maxVisible / 2)), list.length - maxVisible)
  }
  const visible = list.slice(start, start + maxVisible)

  return (
    <box flexDirection="column">
      <text>
        <span fg={C.key}>{epic.key}</span>
        <span fg={C.value}>  {epic.summary}</span>
      </text>
      <text>
        <span fg={statusColor(epic)}>{epic.status}</span>
        <span fg={C.dim}>
          {tickets ? `   ${done}/${tickets.length} done` : "   loading tickets…"}
        </span>
      </text>
      <text>
        <span fg={C.header}>
          {fit("KEY", COLS.key)}
          {fit("TYPE", COLS.type)}
          {fit("STATUS", COLS.status)}
          {fit("ASSIGNEE", COLS.assignee)}
          {fit("WT", COLS.wt)}
          {fit("SUMMARY", summaryWidth)}
        </span>
      </text>
      {visible.map((ticket, i) => {
        const idx = start + i
        const isSelected = idx === selected
        const hasWorktree = worktreeKeys.has(ticket.key)
        const hasWindow = windowKeys.has(ticket.key)
        return (
          <box key={ticket.key} backgroundColor={isSelected ? C.selectedBg : undefined}>
            <text>
              <span fg={isSelected ? "#ffffff" : C.key}>{isSelected ? "▸" : " "}{fit(ticket.key, COLS.key - 1)}</span>
              <span fg={C.gray}>{fit(ticket.type, COLS.type)}</span>
              <span fg={statusColor(ticket)}>{fit(ticket.status, COLS.status)}</span>
              <span fg={C.gray}>{fit(ticket.assignee ?? "-", COLS.assignee)}</span>
              {/* green = worktree + tmux window (s jumps), yellow = worktree only (s resumes) */}
              <span fg={hasWindow ? C.green : hasWorktree ? C.yellow : C.dim}>{fit(hasWorktree ? "●" : "-", COLS.wt)}</span>
              <span fg={C.gray}>{fit(ticket.summary, summaryWidth)}</span>
            </text>
          </box>
        )
      })}
      {tickets && tickets.length === 0 && (
        <text fg={C.dim}>this epic has no child tickets</text>
      )}
    </box>
  )
}
