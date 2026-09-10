import type { LoadState, Row } from "../types.ts"

const C = {
  dim: "#6b7280",
  header: "#93c5fd",
  repo: "#a78bfa",
  branch: "#e5e7eb",
  green: "#4ade80",
  yellow: "#facc15",
  red: "#f87171",
  cyan: "#67e8f9",
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
  repo: 21,
  branch: 18,
  git: 13,
  age: 15,
  status: 15,
  mr: 17,
  ci: 11,
  ready: 12,
  tmux: 7,
  agent: 11,
}
const FIXED_WIDTH = Object.values(COLS).reduce((a, b) => a + b, 0)

function gitCell(row: Row): { text: string; color: string } {
  if (!row.git) return { text: fit("…", COLS.git), color: C.dim }
  const parts: string[] = []
  if (row.git.dirtyCount > 0) parts.push(`✚${row.git.dirtyCount}`)
  if (row.git.ahead !== null) {
    const marker = row.git.hasUpstream ? "" : "*"
    parts.push(`↑${row.git.ahead}${marker}`)
    if (row.git.behind && row.git.behind > 0) parts.push(`↓${row.git.behind}`)
  }
  if (parts.length === 0) parts.push("clean")
  const dirty = row.git.dirtyCount > 0
  const behind = (row.git.behind ?? 0) > 0
  return {
    text: fit(parts.join(" "), COLS.git),
    color: dirty ? C.yellow : behind ? C.red : C.gray,
  }
}

function statusCell(row: Row, loaded: boolean): { text: string; color: string } {
  if (!row.ticketKey) return { text: fit("no ticket", COLS.status), color: C.dim }
  if (!row.ticket) return { text: fit(loaded ? "not found" : "…", COLS.status), color: C.dim }
  const color =
    row.ticket.statusCategory === "Done" ? C.green
    : row.ticket.statusCategory === "In Progress" ? C.yellow
    : C.gray
  return { text: fit(row.ticket.status, COLS.status), color }
}

function mrCell(row: Row, loaded: boolean): { text: string; color: string } {
  if (!row.mr) return { text: fit(loaded ? "-" : "…", COLS.mr), color: C.dim }
  const label = row.mr.draft && row.mr.state === "opened" ? "draft" : row.mr.state
  const conflict = row.mr.hasConflicts ? " ⚠" : ""
  const color =
    row.mr.state === "merged" ? C.green
    : row.mr.state === "closed" ? C.red
    : row.mr.draft ? C.gray
    : C.cyan
  return { text: fit(`!${row.mr.iid} ${label}${conflict}`, COLS.mr), color }
}

/** Human labels for GitLab detailed_merge_status blockers. */
const READY_LABELS: Record<string, { label: string; color: string }> = {
  mergeable: { label: "✓ ready", color: C.green },
  conflicts: { label: "conflicts", color: C.red },
  broken_status: { label: "conflicts", color: C.red },
  discussions_not_resolved: { label: "threads", color: C.yellow },
  not_approved: { label: "approval", color: C.yellow },
  requested_changes: { label: "changes", color: C.red },
  ci_still_running: { label: "ci running", color: C.yellow },
  ci_must_pass: { label: "ci", color: C.red },
  draft_status: { label: "draft", color: C.gray },
  need_rebase: { label: "rebase", color: C.yellow },
  unchecked: { label: "checking", color: C.gray },
  checking: { label: "checking", color: C.gray },
}

function readyCell(row: Row): { text: string; color: string } {
  if (!row.mr || row.mr.state !== "opened") return { text: fit("-", COLS.ready), color: C.dim }
  const status = row.mr.detailedMergeStatus
  if (!status) return { text: fit("?", COLS.ready), color: C.dim }
  const mapped = READY_LABELS[status] ?? { label: status, color: C.gray }
  return { text: fit(mapped.label, COLS.ready), color: mapped.color }
}

/** Per-worktree agent state from Cursor/Claude hook events. */
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

function ciCell(row: Row): { text: string; color: string } {
  const status = row.mr?.pipelineStatus
  if (!status) return { text: fit("-", COLS.ci), color: C.dim }
  const map: Record<string, { icon: string; color: string }> = {
    success: { icon: "✓", color: C.green },
    failed: { icon: "✗", color: C.red },
    running: { icon: "●", color: C.yellow },
    pending: { icon: "○", color: C.yellow },
    canceled: { icon: "⊘", color: C.gray },
  }
  const m = map[status] ?? { icon: "?", color: C.gray }
  return { text: fit(`${m.icon} ${status}`, COLS.ci), color: m.color }
}

export function Dashboard({
  rows,
  selected,
  load,
  width,
  height,
}: {
  rows: Row[]
  selected: number
  load: LoadState
  width: number
  height: number
}) {
  const summaryWidth = Math.max(10, width - FIXED_WIDTH - 2)

  // Keep the selected row visible when there are more rows than screen lines.
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
          {fit("REPO", COLS.repo)}
          {fit("BRANCH", COLS.branch)}
          {fit("GIT", COLS.git)}
          {fit("LAST COMMIT", COLS.age)}
          {fit("TICKET", COLS.status)}
          {fit("MR", COLS.mr)}
          {fit("CI", COLS.ci)}
          {fit("READY", COLS.ready)}
          {fit("TMUX", COLS.tmux)}
          {fit("AGENT", COLS.agent)}
          {fit("SUMMARY", summaryWidth)}
        </span>
      </text>
      {visible.map((row, i) => {
        const idx = start + i
        const isSelected = idx === selected
        const git = gitCell(row)
        const status = statusCell(row, load.jira)
        const mr = mrCell(row, load.gitlab)
        const ci = ciCell(row)
        const ready = readyCell(row)
        const agent = agentCell(row)
        return (
          <box key={`${row.repo}/${row.branch}`} backgroundColor={isSelected ? C.selectedBg : undefined}>
            <text>
              <span fg={isSelected ? "#ffffff" : C.repo}>{isSelected ? "▸" : " "}{fit(row.repo, COLS.repo - 1)}</span>
              <span fg={C.branch}>{fit(row.branch, COLS.branch)}</span>
              <span fg={git.color}>{git.text}</span>
              <span fg={C.dim}>{fit(row.git?.lastCommitRelative ?? "…", COLS.age)}</span>
              <span fg={status.color}>{status.text}</span>
              <span fg={mr.color}>{mr.text}</span>
              <span fg={ci.color}>{ci.text}</span>
              <span fg={ready.color}>{ready.text}</span>
              <span fg={row.tmuxWindow ? C.green : C.dim}>{fit(row.tmuxWindow ?? "-", COLS.tmux)}</span>
              <span fg={agent.color}>{agent.text}</span>
              <span fg={C.gray}>{fit(row.ticket?.summary ?? "", summaryWidth)}</span>
            </text>
          </box>
        )
      })}
    </box>
  )
}
