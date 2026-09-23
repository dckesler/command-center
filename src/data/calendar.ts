import { run } from "./exec.ts"

/**
 * Outlook calendar via the CLI for Microsoft 365 (`m365`), read-only. Requires
 * a completed `m365 login` (device code) with the Calendars.Read delegated
 * permission. Uses the calendarView range query so recurring meetings are
 * expanded into their occurrences.
 */

export interface CalendarEvent {
  id: string
  subject: string
  /** ISO instants (UTC) */
  start: string
  end: string
  isAllDay: boolean
  isCancelled: boolean
  location: string
  organizer: string
  /** how many people are invited (excluding the organizer) */
  attendees: number
  /** none | organizer | accepted | tentativelyAccepted | declined | notResponded */
  response: string
  /** free | tentative | busy | oof | workingElsewhere */
  showAs: string
  isOnline: boolean
  joinUrl: string
  webLink: string
  bodyPreview: string
}

interface GraphDateTime {
  dateTime?: string
  timeZone?: string
}

interface GraphEvent {
  id?: string
  subject?: string
  start?: GraphDateTime
  end?: GraphDateTime
  isAllDay?: boolean
  isCancelled?: boolean
  location?: { displayName?: string }
  organizer?: { emailAddress?: { name?: string; address?: string } }
  attendees?: { type?: string; status?: { response?: string }; emailAddress?: { name?: string; address?: string } }[]
  responseStatus?: { response?: string }
  showAs?: string
  isOnlineMeeting?: boolean
  onlineMeeting?: { joinUrl?: string }
  onlineMeetingUrl?: string
  webLink?: string
  bodyPreview?: string
  body?: { content?: string; contentType?: string }
}

/** Graph returns "2026-09-23T15:00:00.0000000" plus a timeZone; make it an instant. */
function toIso(value: GraphDateTime | undefined): string {
  const raw = value?.dateTime
  if (!raw) return ""
  const trimmed = raw.replace(/(\.\d{3})\d+/, "$1")
  const zone = (value?.timeZone ?? "UTC").toLowerCase()
  const date = zone === "utc" && !/[zZ]|[+-]\d\d:\d\d$/.test(trimmed) ? new Date(`${trimmed}Z`) : new Date(trimmed)
  return Number.isNaN(date.getTime()) ? "" : date.toISOString()
}

function normalize(e: GraphEvent): CalendarEvent {
  return {
    id: e.id ?? "",
    subject: e.subject || "(no title)",
    start: toIso(e.start),
    end: toIso(e.end),
    isAllDay: e.isAllDay ?? false,
    isCancelled: e.isCancelled ?? false,
    location: (e.location?.displayName ?? "").trim(),
    organizer: e.organizer?.emailAddress?.name || e.organizer?.emailAddress?.address || "",
    attendees: (e.attendees ?? []).filter((a) => a.type !== "resource").length,
    response: e.responseStatus?.response ?? "none",
    showAs: e.showAs ?? "busy",
    isOnline: e.isOnlineMeeting ?? Boolean(e.onlineMeeting?.joinUrl || e.onlineMeetingUrl),
    joinUrl: e.onlineMeeting?.joinUrl ?? e.onlineMeetingUrl ?? "",
    webLink: e.webLink ?? "",
    bodyPreview: (e.bodyPreview ?? "").replace(/\s+/g, " ").trim(),
  }
}

/** Local-midnight bounds of the day containing `date`. */
export function dayBounds(date = new Date()): { start: Date; end: Date } {
  const start = new Date(date)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { start, end }
}

/** null = calendar unavailable (not logged in, CLI missing, or command failed). */
export async function getEvents(start: Date, end: Date): Promise<CalendarEvent[] | null> {
  const res = await run(
    "m365",
    [
      "outlook",
      "event",
      "list",
      "--startDateTime",
      start.toISOString(),
      "--endDateTime",
      end.toISOString(),
      "--output",
      "json",
    ],
    { timeoutMs: 60_000 },
  )
  if (!res.ok) return null
  try {
    const events = JSON.parse(res.stdout) as GraphEvent[]
    return events
      .map(normalize)
      .filter((e) => e.start)
      .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end))
  } catch {
    return null
  }
}

/** Today's events (local day). */
export function getTodayEvents(): Promise<CalendarEvent[] | null> {
  const { start, end } = dayBounds()
  return getEvents(start, end)
}

/** Full detail of one event for the calendar agent (attendees + plain-text body). */
export async function getEventDetail(id: string): Promise<string | null> {
  const res = await run("m365", ["outlook", "event", "get", "--id", id, "--output", "json"], { timeoutMs: 60_000 })
  if (!res.ok) return null
  try {
    const raw = JSON.parse(res.stdout) as GraphEvent
    const e = normalize(raw)
    const content = raw.body?.content ?? ""
    const body =
      raw.body?.contentType?.toLowerCase() === "html"
        ? content
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/[ \t]+/g, " ")
            .replace(/\s*\n\s*/g, "\n")
            .trim()
        : content.trim()
    const attendees = (raw.attendees ?? [])
      .filter((a) => a.type !== "resource")
      .map((a) => `${a.emailAddress?.name || a.emailAddress?.address || "?"} (${a.status?.response ?? "none"})`)
    return [
      `subject: ${e.subject}`,
      `when: ${fmtRange(e)}${e.isCancelled ? " (CANCELLED)" : ""}`,
      e.location ? `where: ${e.location}` : "",
      e.isOnline ? `online: ${e.joinUrl || "yes"}` : "",
      `organizer: ${e.organizer}`,
      `your response: ${e.response}`,
      attendees.length ? `attendees (${attendees.length}): ${attendees.join(", ")}` : "",
      "",
      body.slice(0, 4000),
    ]
      .filter((line) => line !== "")
      .join("\n")
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// formatting

export function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
}

export function fmtRange(e: CalendarEvent): string {
  if (e.isAllDay) return "all day"
  return `${fmtClock(e.start)}–${fmtClock(e.end)}`
}

/** Minutes until the event starts (negative once it has started). */
export function minutesUntil(e: CalendarEvent, now = Date.now()): number {
  return Math.round((new Date(e.start).getTime() - now) / 60_000)
}

export function isNow(e: CalendarEvent, now = Date.now()): boolean {
  return new Date(e.start).getTime() <= now && now < new Date(e.end).getTime()
}

/** One compact line per event for agents. */
export function fmtEvent(e: CalendarEvent, now = Date.now()): string {
  const flags = [
    e.isCancelled ? "cancelled" : "",
    e.response === "declined" ? "declined" : e.response === "tentativelyAccepted" ? "tentative" : "",
    e.showAs === "free" ? "free" : "",
    e.isOnline ? "online" : "",
  ].filter(Boolean)
  const when = e.isAllDay
    ? ""
    : isNow(e, now)
      ? " | NOW"
      : minutesUntil(e, now) > 0
        ? ` | in ${fmtMinutes(minutesUntil(e, now))}`
        : " | done"
  return `${fmtRange(e)} | ${e.subject}${e.location ? ` @ ${e.location}` : ""}${e.organizer ? ` | ${e.organizer}` : ""}${
    flags.length ? ` [${flags.join(", ")}]` : ""
  }${when} | id=${e.id}`
}

export function fmtMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h}h${m}m` : `${h}h`
}
