import type { GrokBot, GrokRun } from "../data/grok.ts"

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
  bot: 20,
  state: 11,
  reportTo: 22,
  started: 11,
}
const FIXED_WIDTH = Object.values(COLS).reduce((a, b) => a + b, 0)

function relativeTime(iso: string): string {
  const ts = Date.parse(iso)
  if (!ts) return ""
  const minutes = Math.floor((Date.now() - ts) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? "yesterday" : `${days}d ago`
}

export function grokStateColor(state: string): string {
  switch (state) {
    case "sent":
      return C.yellow
    case "done":
      return C.green
    case "needs-you":
    case "blocked":
    case "refused":
    case "failed":
      return C.red
    case "unknown":
      return C.gray
    default:
      return C.value
  }
}

/** Shorten an absolute report_to dir to something readable. */
function targetLabel(reportTo: string): string {
  if (!reportTo.startsWith("/")) return reportTo
  const parts = reportTo.split("/").filter(Boolean)
  return parts.slice(-1)[0] ?? reportTo
}

export function Grok({
  runs,
  bots,
  selected,
  loading,
  width,
  height,
}: {
  runs: GrokRun[]
  bots: GrokBot[]
  selected: number
  loading: boolean
  width: number
  height: number
}) {
  const taskWidth = Math.max(10, width - FIXED_WIDTH - 2)
  const ready = bots.filter((b) => b.webhook)
  const attention = bots.filter((b) => b.awaiting || b.unread > 0)
  const botLine =
    bots.length === 0
      ? "no Bots found — open the Grok Bot app, or add webhooks to ~/.config/command-center/grok.json"
      : `${ready.length}/${bots.length} Bots have a webhook` +
        (ready.length ? `: ${ready.map((b) => b.name).join(", ")}` : " (none can be started from here yet)") +
        (attention.length ? `  ·  waiting on you in the app: ${attention.map((b) => b.name).join(", ")}` : "")

  // two header lines + column header
  const maxVisible = Math.max(1, height - 3)
  let start = 0
  if (runs.length > maxVisible) {
    start = Math.min(Math.max(0, selected - Math.floor(maxVisible / 2)), runs.length - maxVisible)
  }
  const visible = runs.slice(start, start + maxVisible)

  if (loading && runs.length === 0 && bots.length === 0) {
    return (
      <box>
        <text fg={C.dim}>loading Grok Bot runs…</text>
      </box>
    )
  }

  return (
    <box flexDirection="column">
      <text fg={attention.length ? C.yellow : C.dim}>{botLine}</text>
      <text fg={C.dim}>
        {runs.length === 0
          ? "no runs yet — press n to send a task to a Bot (reports land here), or ask any agent to `cc-grok start`"
          : "enter: report  n: new run  x: close run  o: open Grok Bot app  r: pull reports"}
      </text>
      {runs.length > 0 ? (
        <text>
          <span fg={C.header}>
            {fit("BOT", COLS.bot)}
            {fit("STATE", COLS.state)}
            {fit("REPORTS TO", COLS.reportTo)}
            {fit("STARTED", COLS.started)}
            {fit("TASK", taskWidth)}
          </span>
        </text>
      ) : null}
      {visible.map((run, i) => {
        const idx = start + i
        const isSelected = idx === selected
        const stateText = run.state + (run.report && !run.delivered ? "*" : "")
        return (
          <box key={run.id} backgroundColor={isSelected ? C.selectedBg : undefined}>
            <text>
              <span fg={isSelected ? "#ffffff" : C.key}>
                {isSelected ? "▸" : " "}
                {fit(run.bot, COLS.bot - 1)}
              </span>
              <span fg={grokStateColor(run.state)}>{fit(stateText, COLS.state)}</span>
              <span fg={C.gray}>{fit(targetLabel(run.reportTo), COLS.reportTo)}</span>
              <span fg={C.dim}>{fit(relativeTime(run.ts), COLS.started)}</span>
              <span fg={C.value}>{fit(run.report?.summary ? `${run.task} ↳ ${run.report.summary}` : run.task, taskWidth)}</span>
            </text>
          </box>
        )
      })}
    </box>
  )
}
