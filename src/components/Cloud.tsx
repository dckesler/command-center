import type { CloudAgent } from "../data/cloud.ts"

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

const GAP = 2
function fit(s: string, w: number): string {
  const usable = Math.max(1, w - GAP)
  if (s.length > usable) return (s.slice(0, usable - 1) + "…").padEnd(w)
  return s.padEnd(w)
}

const COLS = {
  name: 22,
  status: 12,
  repo: 28,
  branch: 18,
  updated: 13,
}
const FIXED_WIDTH = Object.values(COLS).reduce((a, b) => a + b, 0)

function relativeTime(ts: number): string {
  if (!ts) return ""
  const minutes = Math.floor((Date.now() - ts) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? "yesterday" : `${days}d ago`
}

function repoLabel(url: string): string {
  const path = url.replace(/^https?:\/\//, "").replace(/\.git$/, "")
  const parts = path.split("/")
  return parts.slice(-2).join("/")
}

function statusColor(status: string): string {
  const s = status.toLowerCase()
  if (s === "running" || s === "creating") return C.yellow
  if (s === "finished") return C.green
  if (s === "error" || s === "expired") return C.red
  return C.value
}

export function Cloud({
  agents,
  selected,
  loading,
  error,
  width,
  height,
}: {
  agents: CloudAgent[]
  selected: number
  loading: boolean
  error: string | null
  width: number
  height: number
}) {
  const summaryWidth = Math.max(10, width - FIXED_WIDTH - 2)
  const maxVisible = Math.max(1, height)
  let start = 0
  if (agents.length > maxVisible) {
    start = Math.min(Math.max(0, selected - Math.floor(maxVisible / 2)), agents.length - maxVisible)
  }
  const visible = agents.slice(start, start + maxVisible)

  if (loading && agents.length === 0) {
    return (
      <box>
        <text fg={C.dim}>loading cloud agents…</text>
      </box>
    )
  }

  if (error && agents.length === 0) {
    return (
      <box flexDirection="column">
        <text fg={C.red}>{error}</text>
        <text fg={C.dim}>export CURSOR_API_KEY and press r to retry</text>
      </box>
    )
  }

  if (agents.length === 0) {
    return (
      <box>
        <text fg={C.dim}>no cloud agents — press n to start one (pick repo, enter prompt)</text>
      </box>
    )
  }

  return (
    <box flexDirection="column">
      <text>
        <span fg={C.header}>
          {fit("NAME", COLS.name)}
          {fit("STATUS", COLS.status)}
          {fit("REPO", COLS.repo)}
          {fit("BRANCH", COLS.branch)}
          {fit("UPDATED", COLS.updated)}
          {fit("SUMMARY", summaryWidth)}
        </span>
      </text>
      {visible.map((agent, i) => {
        const idx = start + i
        const isSelected = idx === selected
        const repo = agent.repos[0] ? repoLabel(agent.repos[0]) : "-"
        return (
          <box key={agent.id} backgroundColor={isSelected ? C.selectedBg : undefined}>
            <text>
              <span fg={isSelected ? "#ffffff" : C.key}>{isSelected ? "▸" : " "}{fit(agent.name || agent.id, COLS.name - 1)}</span>
              <span fg={statusColor(agent.status)}>{fit(agent.status, COLS.status)}</span>
              <span fg={C.gray}>{fit(repo, COLS.repo)}</span>
              <span fg={C.value}>{fit(agent.branch ?? "-", COLS.branch)}</span>
              <span fg={C.dim}>{fit(relativeTime(agent.lastModified), COLS.updated)}</span>
              <span fg={C.gray}>{fit(agent.summary || agent.id, summaryWidth)}</span>
            </text>
          </box>
        )
      })}
    </box>
  )
}
