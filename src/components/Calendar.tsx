import { fmtMinutes, fmtRange, isNow, minutesUntil, type CalendarEvent } from "../data/calendar.ts"

const C = {
  dim: "#6b7280",
  header: "#93c5fd",
  value: "#e5e7eb",
  now: "#4ade80",
  soon: "#facc15",
  selectedBg: "#1f2937",
}

function pad(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width)
}

/** Detail lines under the list for the selected event. */
const PREVIEW_LINES = 4

function responseMark(e: CalendarEvent): string {
  if (e.isCancelled) return "✗"
  switch (e.response) {
    case "accepted":
    case "organizer":
      return "✓"
    case "tentativelyAccepted":
      return "?"
    case "declined":
      return "✗"
    case "notResponded":
      return "!"
    default:
      return " "
  }
}

export function Calendar({
  events,
  loading,
  selected,
  width,
  height,
}: {
  /** null = calendar unavailable (m365 not logged in) */
  events: CalendarEvent[] | null
  loading: boolean
  selected: number
  width: number
  height: number
}) {
  if (events === null) {
    return (
      <box flexDirection="column">
        <text fg={C.dim}>{loading ? "checking calendar…" : "Calendar unavailable — complete `m365 login` first"}</text>
        {!loading && (
          <text fg={C.dim}>needs the Calendars.Read permission; then run: m365 login --authType deviceCode</text>
        )}
      </box>
    )
  }
  const today = new Date().toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })
  if (events.length === 0) {
    return <text fg={C.dim}>{loading ? "loading calendar…" : `${today} — no meetings today`}</text>
  }

  const now = Date.now()
  const selectedEvent = events[selected]
  const timeWidth = 12
  const whereWidth = 22
  const whoWidth = 18
  const subjectWidth = Math.max(20, width - timeWidth - whereWidth - whoWidth - 10)

  const detail: string[] = []
  if (selectedEvent) {
    const parts = [
      selectedEvent.organizer ? `organizer: ${selectedEvent.organizer}` : "",
      selectedEvent.attendees ? `${selectedEvent.attendees} invited` : "",
      selectedEvent.response !== "none" ? `you: ${selectedEvent.response}` : "",
      selectedEvent.isOnline ? (selectedEvent.joinUrl ? "online (enter joins)" : "online") : "",
    ].filter(Boolean)
    if (parts.length) detail.push(parts.join("   "))
    const previewWidth = Math.max(20, width - 4)
    const text = selectedEvent.bodyPreview
    for (let i = 0; i < text.length && detail.length < PREVIEW_LINES; i += previewWidth) {
      detail.push(text.slice(i, i + previewWidth))
    }
  }

  const maxVisible = Math.max(1, height - 2 - (detail.length ? detail.length + 1 : 0))
  let start = 0
  if (events.length > maxVisible) {
    start = Math.min(Math.max(0, selected - Math.floor(maxVisible / 2)), events.length - maxVisible)
  }
  const visible = events.slice(start, start + maxVisible)

  const next = events.find((e) => !e.isCancelled && !e.isAllDay && minutesUntil(e, now) > 0 && e.response !== "declined")
  const current = events.find((e) => !e.isCancelled && !e.isAllDay && isNow(e, now))
  const summary = current
    ? `now: ${current.subject} (ends ${fmtRange(current).split("–")[1]})`
    : next
      ? `next: ${next.subject} in ${fmtMinutes(minutesUntil(next, now))}`
      : "no more meetings today"

  return (
    <box flexDirection="column">
      <text>
        <span fg={C.value}>{today}</span>
        <span fg={C.dim}>{"   "}{events.length} events   </span>
        <span fg={current ? C.now : C.dim}>{summary}</span>
      </text>
      <text fg={C.header}>
        {"    "}
        {pad("TIME", timeWidth)} {pad("SUBJECT", subjectWidth)} {pad("WHERE", whereWidth)} {pad("ORGANIZER", whoWidth)}
      </text>
      {visible.map((e, i) => {
        const idx = start + i
        const isSelected = idx === selected
        const live = !e.isAllDay && isNow(e, now)
        const past = !live && !e.isAllDay && new Date(e.end).getTime() < now
        const soon = !live && !past && minutesUntil(e, now) <= 15
        const muted = past || e.isCancelled || e.response === "declined"
        const fg = isSelected ? "#ffffff" : live ? C.now : soon ? C.soon : muted ? C.dim : C.value
        const where = e.location || (e.isOnline ? "Teams" : "")
        return (
          <box key={`${e.id}-${e.start}`} backgroundColor={isSelected ? C.selectedBg : undefined}>
            <text>
              <span fg={fg}>
                {isSelected ? "▸" : live ? "●" : " "}
                {responseMark(e)}
                {"  "}
                {pad(fmtRange(e), timeWidth)} {pad(e.subject, subjectWidth)}
              </span>
              <span fg={C.dim}>
                {" "}
                {pad(where, whereWidth)} {pad(e.organizer, whoWidth)}
              </span>
            </text>
          </box>
        )
      })}
      {detail.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          {detail.map((line, i) => (
            <text key={i} fg={C.dim}>
              {"  "}
              {line}
            </text>
          ))}
        </box>
      )}
    </box>
  )
}
