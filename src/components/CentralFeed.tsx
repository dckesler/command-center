import type { CentralSnapshot } from "../data/central.ts"
import { formatClock } from "../data/inbox.ts"

const C = {
  dim: "#6b7280",
  header: "#93c5fd",
  value: "#e5e7eb",
  seen: "#71717a",
  from: "#93c5fd",
  yellow: "#facc15",
  red: "#f87171",
  green: "#4ade80",
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  for (const raw of text.split("\n")) {
    let line = ""
    for (const word of raw.split(" ")) {
      if (word.length > width) {
        if (line) lines.push(line)
        for (let i = 0; i + width < word.length; i += width) lines.push(word.slice(i, i + width))
        line = word.slice(Math.floor((word.length - 1) / width) * width)
        continue
      }
      if (!line) line = word
      else if (line.length + 1 + word.length <= width) line += ` ${word}`
      else {
        lines.push(line)
        line = word
      }
    }
    lines.push(line)
  }
  return lines
}

function age(iso: string | undefined, now: number): string {
  if (!iso) return ""
  const min = Math.floor((now - new Date(iso).getTime()) / 60_000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

/**
 * Tab 1 when the central manager runs as cursor-cli in a tmux pane: the
 * stream of reports addressed to central (every severity — only warn and
 * attention are also mailed into the agent's chat), plus where the agent is
 * and whether it is running. Reports the agent has already read with cc-inbox
 * are dimmed. Daniel talks to the agent in its pane, not here.
 */
export function CentralFeed({
  snapshot,
  scroll,
  width,
  height,
}: {
  snapshot: CentralSnapshot | null
  /** lines scrolled up from the bottom (0 = pinned to latest) */
  scroll: number
  width: number
  height: number
}) {
  const now = Date.now()
  const textWidth = Math.max(20, width - 2)

  let headline: { text: string; color: string }
  if (!snapshot) headline = { text: "central agent — looking…", color: C.dim }
  else if (!snapshot.pane) headline = { text: "central agent — not running (enter starts it in this tmux window)", color: C.red }
  else if (!snapshot.running) headline = { text: `central agent — quit (pane ${snapshot.pane.pane} is a shell; enter restarts it)`, color: C.red }
  else {
    const state = snapshot.status?.state ?? "unknown"
    const color = state === "working" ? C.yellow : state === "attention" ? C.red : state === "idle" ? C.green : C.dim
    const parts = [`central agent — ${state}${snapshot.status ? ` (${age(snapshot.status.ts, now)})` : ""}`, `pane ${snapshot.pane.pane}`]
    if (snapshot.pendingMail) parts.push(`✉ ${snapshot.pendingMail} queued`)
    headline = { text: parts.join("   "), color }
  }

  const all: { text: string; color: string }[] = []
  const reports = snapshot?.reports ?? []
  const seenIdx = snapshot?.seenId ? reports.findIndex((r) => r.id === snapshot.seenId) : -1
  reports.forEach((r, i) => {
    const seen = i <= seenIdx
    const mark = r.severity === "attention" ? "!! " : r.severity === "warn" ? " ! " : "   "
    const color = seen ? C.seen : r.severity === "attention" ? C.red : r.severity === "warn" ? C.yellow : C.value
    const head = `${formatClock(r.ts)} ${mark}${r.from}: `
    const indent = 9 // under "HH:MM !! "
    const lines = wrap(head + r.summary, textWidth - indent)
    lines.forEach((line, j) => all.push({ text: j === 0 ? line : `${" ".repeat(indent)}${line}`, color }))
  })

  const bodyHeight = Math.max(1, height - 2)
  const maxScroll = Math.max(0, all.length - bodyHeight)
  const offset = Math.min(scroll, maxScroll)
  const start = Math.max(0, all.length - bodyHeight - offset)
  const visible = all.slice(start, start + bodyHeight)

  return (
    <box flexDirection="column">
      <text fg={headline.color}>{headline.text}</text>
      <text fg={C.dim}>
        {`reports to central — ${reports.length}${snapshot?.unseen ? `, ${snapshot.unseen} unread by the agent` : ""} · !! attention, ! warn (mailed to it); the rest it reads with cc-inbox · enter/i → its pane${offset ? `   ↑${offset}` : ""}`}
      </text>
      <box flexDirection="column" height={bodyHeight}>
        {visible.length === 0 ? (
          <text fg={C.dim}>
            {snapshot?.running
              ? "no reports yet — specialists' report_to_central and cc-report central land here"
              : "the central manager is cursor-cli in the pane beside this one; specialists' reports land here and it steers them with cc-instruct"}
          </text>
        ) : (
          visible.map((line, i) => (
            <text key={i} fg={line.color}>
              {line.text || " "}
            </text>
          ))
        )}
      </box>
    </box>
  )
}
