import type { Row, TicketInfo } from "../types.ts"

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
  priority: 10,
  updated: 13,
  wt: 6,
}
const FIXED_WIDTH = Object.values(COLS).reduce((a, b) => a + b, 0)

function relativeDays(iso: string | undefined): string {
  if (!iso) return ""
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  if (days < 30) return `${days} days ago`
  const months = Math.floor(days / 30)
  return months === 1 ? "a month ago" : `${months} months ago`
}

const PRIORITY_COLORS: Record<string, string> = {
  Highest: "#f87171",
  High: "#fb923c",
  Medium: "#9ca3af",
  Low: "#6b7280",
  Lowest: "#6b7280",
}

export function Backlog({
  tickets,
  selected,
  worktreeKeys,
  loading,
  width,
  height,
}: {
  tickets: TicketInfo[]
  selected: number
  /** ticket keys that already have a local worktree (from the dashboard rows) */
  worktreeKeys: Set<string>
  loading: boolean
  width: number
  height: number
}) {
  const summaryWidth = Math.max(10, width - FIXED_WIDTH - 2)

  const maxVisible = Math.max(1, height)
  let start = 0
  if (tickets.length > maxVisible) {
    start = Math.min(Math.max(0, selected - Math.floor(maxVisible / 2)), tickets.length - maxVisible)
  }
  const visible = tickets.slice(start, start + maxVisible)

  if (loading && tickets.length === 0) {
    return (
      <box>
        <text fg={C.dim}>loading backlog…</text>
      </box>
    )
  }

  return (
    <box flexDirection="column">
      <text>
        <span fg={C.header}>
          {fit("KEY", COLS.key)}
          {fit("TYPE", COLS.type)}
          {fit("STATUS", COLS.status)}
          {fit("PRIORITY", COLS.priority)}
          {fit("UPDATED", COLS.updated)}
          {fit("WT", COLS.wt)}
          {fit("SUMMARY", summaryWidth)}
        </span>
      </text>
      {visible.map((ticket, i) => {
        const idx = start + i
        const isSelected = idx === selected
        const hasWorktree = worktreeKeys.has(ticket.key)
        return (
          <box key={ticket.key} backgroundColor={isSelected ? C.selectedBg : undefined}>
            <text>
              <span fg={isSelected ? "#ffffff" : C.key}>{isSelected ? "▸" : " "}{fit(ticket.key, COLS.key - 1)}</span>
              <span fg={C.gray}>{fit(ticket.type, COLS.type)}</span>
              <span fg={ticket.status === "Blocked" ? C.red : C.value}>{fit(ticket.status, COLS.status)}</span>
              <span fg={PRIORITY_COLORS[ticket.priority ?? ""] ?? C.gray}>{fit(ticket.priority ?? "-", COLS.priority)}</span>
              <span fg={C.dim}>{fit(relativeDays(ticket.updated), COLS.updated)}</span>
              <span fg={hasWorktree ? C.green : C.dim}>{fit(hasWorktree ? "●" : "-", COLS.wt)}</span>
              <span fg={C.gray}>{fit(ticket.summary, summaryWidth)}</span>
            </text>
          </box>
        )
      })}
      {tickets.length === 0 && !loading && (
        <text fg={C.dim}>backlog is empty — nothing assigned that isn't already in progress</text>
      )}
    </box>
  )
}
