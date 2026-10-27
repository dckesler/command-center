import { plainTurn, type CentralSnapshot } from "../data/central.ts"

const C = {
  dim: "#6b7280",
  header: "#93c5fd",
  value: "#e5e7eb",
  mail: "#a1a1aa",
  user: "#93c5fd",
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
 * Tab 1 when the central manager runs as cursor-cli in a tmux pane: a
 * read-only view of its conversation (mail in, what it said), plus where it
 * is and whether it is running. Daniel talks to it in the pane itself.
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
  for (const turn of snapshot?.turns ?? []) {
    const t = plainTurn(turn)
    const prefix = t.role === "mail" ? "✉ " : t.role === "user" ? "❯ " : ""
    const color = t.role === "mail" ? C.mail : t.role === "user" ? C.user : C.value
    for (const line of wrap(prefix + t.text, textWidth)) all.push({ text: line, color })
    all.push({ text: "", color: C.dim })
  }

  const bodyHeight = Math.max(1, height - 2)
  const maxScroll = Math.max(0, all.length - bodyHeight)
  const offset = Math.min(scroll, maxScroll)
  const start = Math.max(0, all.length - bodyHeight - offset)
  const visible = all.slice(start, start + bodyHeight)

  return (
    <box flexDirection="column">
      <text fg={headline.color}>{headline.text}</text>
      <text fg={C.dim}>
        {snapshot?.transcript
          ? `read-only — this is the agent's own chat; enter or i puts you in its pane${offset ? `   ↑${offset}` : ""}`
          : "read-only — no transcript yet; it appears after the agent's first turn"}
      </text>
      <box flexDirection="column" height={bodyHeight}>
        {visible.length === 0 ? (
          <text fg={C.dim}>
            {snapshot?.running
              ? "waiting for the agent's first turn…"
              : "the central manager is cursor-cli in the pane below this one; specialists report to it through cc-mail and it steers them with cc-instruct"}
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
