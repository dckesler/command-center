import { closeSync, existsSync, openSync, readSync, statSync, watch } from "node:fs"
import { basename, relative } from "node:path"
import { config, statePath } from "../config.ts"
import type { CloudAgent } from "../data/cloud.ts"
import type { Row, TicketInfo } from "../types.ts"
import { parseFeedLine, type FeedEvent } from "../data/agents.ts"
import {
  ackInbox,
  appendInbox,
  formatCatchUp,
  formatClock,
  getFeedCursor,
  setFeedOffset,
  ticketKeyFromDir,
  unreadInbox,
  type InboxSeverity,
} from "../data/inbox.ts"
import { run } from "../data/exec.ts"
import type { EmailMessage } from "../data/outlook.ts"
import { fmtEvent, fmtMinutes, fmtRange, isNow, minutesUntil, type CalendarEvent } from "../data/calendar.ts"
import { isProjectDir, projectRootOf, type Project } from "../data/projects.ts"
import { currentSnapshot, isAgentLive, sendSystem } from "./hub.ts"

/**
 * Autonomous event sources. Two feeds produce per-tab "[event digest]"
 * messages that run the owning specialist automatically:
 *
 *  1. the agent hook feed (~/.config/command-center/agents.jsonl) written by
 *     Cursor/Claude hooks in ticket worktrees → worktrees / qa tabs, and in
 *     ~/projects directories → projects tab
 *  2. explicit `cc-report` lines in that same feed (any cwd, addressed `to` a tab)
 *  3. diffs between completed refresh snapshots (MR state, CI, ticket
 *     status, project briefs) → worktrees / qa / tickets / epics / projects / cloud tabs
 *
 * Digests are debounced and rate-limited per tab; every specialist run costs
 * an LLM call, so noise is filtered at the source (interesting states only,
 * value-to-value changes only).
 */

const FEED_DIR = config().dirs.config
const FEED = statePath("agents.jsonl")

const DEBOUNCE_MS = 2_000
/** Min gap between digest runs for one tab; events accumulate meanwhile. */
const MIN_INTERVAL_MS = 30_000

// ---------------------------------------------------------------------------
// per-tab digest buffers

interface TabBuffer {
  lines: string[]
  timer: ReturnType<typeof setTimeout> | null
  lastSent: number
  lastInboxId: string | null
}

const buffers = new Map<string, TabBuffer>()

/** Tabs we have already queued a catch-up send for (agent still creating). */
const waking = new Set<string>()
const wakeTimers = new Map<string, ReturnType<typeof setTimeout>>()

const WAKE_TABS = [
  "worktrees",
  "qa",
  "tickets",
  "epics",
  "projects",
  "todos",
  "email",
  "cloud",
  "calendar",
  "central",
] as const

function reportTab(to: string | undefined, dir: string): string {
  if (to && (WAKE_TABS as readonly string[]).includes(to)) return to
  if (isProjectDir(dir)) return "projects"
  return dir.includes("_qa_") ? "qa" : "worktrees"
}

/** First snapshot with rows: drain downtime, then wake any tab that has unread. */
let wokeUnread = false

function scheduleWake(tab: string): void {
  if (isAgentLive(tab) || waking.has(tab) || wakeTimers.has(tab)) return
  wakeTimers.set(
    tab,
    setTimeout(() => {
      wakeTimers.delete(tab)
      if (isAgentLive(tab) || waking.has(tab)) return
      const missed = unreadInbox(tab)
      if (missed.length === 0) return
      waking.add(tab)
      ackInbox(tab, missed[missed.length - 1].id)
      sendSystem(tab, formatCatchUp(missed), () => {
        waking.delete(tab)
      })
    }, DEBOUNCE_MS),
  )
}

function wakeUnreadTabs(): void {
  for (const tab of WAKE_TABS) {
    if (unreadInbox(tab).length > 0) scheduleWake(tab)
  }
}

function pushEvent(
  tab: string,
  line: string,
  severity: InboxSeverity = "info",
  extra?: { dir?: string; persist?: boolean; inboxSummary?: string },
): void {
  const stamped = line.startsWith("[") ? line : `[${formatClock()}] ${line}`
  let inboxId: string | null = null
  if (extra?.persist !== false) {
    inboxId = appendInbox({
      to: tab,
      from: extra?.dir ? "ticket" : "event",
      severity,
      summary: extra?.inboxSummary ?? stamped,
      dir: extra?.dir,
      ticket: extra?.dir ? ticketKeyFromDir(extra.dir) : undefined,
    }).id
  }
  // Specialist is down (or Command Center just came back): leave it on disk
  // and wake the tab so catch-up actually runs. Without this, events sit in
  // the inbox forever — handles are lazy and nothing else creates them.
  if (!isAgentLive(tab)) {
    scheduleWake(tab)
    return
  }
  let buffer = buffers.get(tab)
  if (!buffer) {
    buffer = { lines: [], timer: null, lastSent: 0, lastInboxId: null }
    buffers.set(tab, buffer)
  }
  buffer.lines.push(stamped)
  if (inboxId) buffer.lastInboxId = inboxId
  if (buffer.timer) return
  const wait =
    severity === "attention"
      ? DEBOUNCE_MS
      : Math.max(DEBOUNCE_MS, buffer.lastSent + MIN_INTERVAL_MS - Date.now())
  buffer.timer = setTimeout(() => {
    buffer.timer = null
    const lines = buffer.lines.splice(0)
    if (lines.length === 0) return
    buffer.lastSent = Date.now()
    if (buffer.lastInboxId) {
      ackInbox(tab, buffer.lastInboxId)
      buffer.lastInboxId = null
    }
    sendSystem(tab, `[event digest]\n${lines.map((l) => `- ${l}`).join("\n")}`)
  }, wait)
}

// ---------------------------------------------------------------------------
// agent hook feed → worktrees / qa

/** States worth waking a specialist for; start/working are routine. */
const INTERESTING_STATES = new Set(["attention", "idle", "ended"])

/**
 * What a ticket agent did since its last interesting state change. Activity
 * events never wake a specialist on their own; they enrich the next
 * idle/attention digest so it says what happened, not just that it stopped.
 */
interface Activity {
  lastResponse: string | null
  edits: Set<string>
  commands: string[]
}

const activityByDir = new Map<string, Activity>()
const MAX_EDITS_SHOWN = 8
const MAX_COMMANDS_SHOWN = 5
const RESPONSE_MAX = 400

function activityFor(dir: string): Activity {
  let a = activityByDir.get(dir)
  if (!a) {
    a = { lastResponse: null, edits: new Set(), commands: [] }
    activityByDir.set(dir, a)
  }
  return a
}

function recordActivity(event: FeedEvent): void {
  const a = activityFor(event.dir)
  if (event.event === "response" && event.text) {
    a.lastResponse = event.text
  } else if (event.event === "edit" && event.file) {
    a.edits.add(relative(event.dir, event.file) || basename(event.file))
  } else if (event.event === "shell" && event.command) {
    a.commands.push(event.command)
    if (a.commands.length > MAX_COMMANDS_SHOWN) a.commands.shift()
  }
}

/** Digest line for a state event, folding in (and clearing) accumulated activity. */
function describeStateEvent(event: FeedEvent, opts: { brief?: boolean; consume?: boolean } = {}): string {
  const name = basename(event.dir)
  const source = event.source ? ` (${event.source})` : ""
  const kind = isProjectDir(event.dir) ? "project agent" : "ticket agent"
  const parts = [`${kind} in ${name} is now ${event.state}${source}`]
  if (event.summary) parts.push(`reason: ${event.summary}`)
  const a = activityByDir.get(event.dir)
  if (a) {
    if (a.edits.size) {
      const files = [...a.edits]
      const shown = files.slice(0, MAX_EDITS_SHOWN).join(", ")
      parts.push(`edited ${files.length} file${files.length === 1 ? "" : "s"}: ${shown}${files.length > MAX_EDITS_SHOWN ? ", …" : ""}`)
    }
    if (a.commands.length) parts.push(`ran: ${a.commands.join(" ; ")}`)
    if (a.lastResponse && !opts.brief) {
      const text = a.lastResponse.length > RESPONSE_MAX ? `…${a.lastResponse.slice(-RESPONSE_MAX)}` : a.lastResponse
      parts.push(`last said: "${text}"`)
    }
    if (opts.consume !== false) {
      if (event.state === "ended") activityByDir.delete(event.dir)
      else {
        a.edits.clear()
        a.commands = []
        // keep lastResponse: an attention right after idle still refers to it
      }
    }
  }
  return parts.join(" | ")
}

let feedOffset = 0
const lastStateByDir = new Map<string, string>()
let watching = false

export function startEventWatchers(): void {
  if (watching) return
  watching = true
  const saved = getFeedCursor()
  const size = existsSync(FEED) ? statSync(FEED).size : 0
  if (!saved.hasCursor) {
    // First run: don't replay the whole history into the inbox.
    feedOffset = size
    setFeedOffset(feedOffset)
  } else {
    feedOffset = saved.offset > size ? 0 : saved.offset
  }
  drainFeed()
  try {
    watch(FEED_DIR, (_event, filename) => {
      if (filename === "agents.jsonl") drainFeed()
    })
  } catch {
    // fs.watch unavailable — hook events just won't stream in
  }
}

function drainFeed(): void {
  // Don't consume the feed until worktree rows exist — otherwise downtime
  // replay would skip every ticket event and permanently advance the cursor.
  if (currentSnapshot().rows.length === 0) return
  if (!existsSync(FEED)) return
  const size = statSync(FEED).size
  if (size < feedOffset) {
    // Rotated (hook script keeps the last 2000 lines). Replay from 0 and
    // skip events we already persisted via lastFeedTs.
    feedOffset = 0
  }
  if (size === feedOffset) return
  const fd = openSync(FEED, "r")
  const chunk = Buffer.alloc(size - feedOffset)
  readSync(fd, chunk, 0, chunk.length, feedOffset)
  closeSync(fd)
  const text = chunk.toString("utf8")
  // only consume complete lines; a partial tail stays for the next drain
  const end = text.lastIndexOf("\n")
  if (end < 0) return
  feedOffset += Buffer.byteLength(text.slice(0, end + 1), "utf8")
  const saved = getFeedCursor()
  let lastTs = saved.lastTs
  for (const line of text.slice(0, end).split("\n")) {
    const event = parseFeedLine(line)
    if (!event) continue
    if (event.ts && lastTs && event.ts <= lastTs) continue
    if (event.ts) lastTs = event.ts
    // Explicit cc-report lines are addressed to a tab. Accept them from any
    // cwd so a brand-new agent can report before its worktree is on the board.
    if (event.event === "report") {
      const text = (event.text || event.summary || "").replace(/\s+/g, " ").trim()
      if (!text) continue
      const tab = reportTab(event.to, event.dir)
      const severity: InboxSeverity =
        event.severity === "warn" || event.severity === "attention" ? event.severity : "info"
      pushEvent(tab, text, severity, {
        dir: event.dir || undefined,
        inboxSummary: `[${formatClock()}] ${text}`,
      })
      continue
    }
    // Only ticket agents in known worktrees and project agents under
    // ~/projects count. Crucially this drops the hub's own agents (they run
    // in $HOME and fire the same hooks), which would otherwise create a
    // digest → run → hook → digest feedback loop.
    const isWorktree = currentSnapshot().rows.some((r) => r.worktreePath === event.dir)
    const projectRoot = isWorktree ? null : projectRootOf(event.dir)
    if (!isWorktree && !projectRoot) continue
    if (event.event) {
      recordActivity(event)
      continue
    }
    if (!event.state) continue
    // Repeated identical states are dropped, except attention: each one is a
    // distinct prompt (permission, question) the manager may need to relay.
    if (event.state !== "attention" && lastStateByDir.get(event.dir) === event.state) continue
    lastStateByDir.set(event.dir, event.state)
    if (!INTERESTING_STATES.has(event.state)) continue
    const tab = projectRoot ? "projects" : event.dir.includes("_qa_") ? "qa" : "worktrees"
    const severity: InboxSeverity = event.state === "attention" ? "attention" : "info"
    const brief = describeStateEvent(event, { brief: true, consume: false })
    const full = describeStateEvent(event, { brief: false })
    pushEvent(tab, full, severity, {
      dir: event.dir,
      inboxSummary: `[${formatClock()}] ${brief}`,
    })
  }
  setFeedOffset(feedOffset, lastTs)
}

// ---------------------------------------------------------------------------
// refresh snapshot diffs
//
// Only fully-loaded snapshots are ingested (the App gates on its load flags),
// so a value present on both sides that differs is a real change — not a
// progressive-load artifact.

let prevRows: Row[] | null = null

export function ingestRows(rows: Row[]): void {
  drainFeed()
  if (!wokeUnread && rows.length > 0) {
    wokeUnread = true
    wakeUnreadTabs()
  }
  const prev = prevRows
  prevRows = rows
  if (!prev || prev.length === 0) return
  const byKey = new Map(prev.map((r) => [`${r.repo}:${r.branch}:${r.isQa}`, r]))
  for (const row of rows) {
    const old = byKey.get(`${row.repo}:${row.branch}:${row.isQa}`)
    if (!old) continue
    const tab = row.isQa ? "qa" : "worktrees"
    const label = `${row.repo}/${row.branch}`
    if (old.mr && row.mr && old.mr.state !== row.mr.state) {
      pushEvent(tab, `${label}: MR !${row.mr.iid} went ${old.mr.state} → ${row.mr.state}`)
    }
    if (old.mr?.pipelineStatus && row.mr?.pipelineStatus && old.mr.pipelineStatus !== row.mr.pipelineStatus) {
      pushEvent(tab, `${label}: CI went ${old.mr.pipelineStatus} → ${row.mr.pipelineStatus} on !${row.mr.iid}`)
    }
    if (old.ticket && row.ticket && old.ticket.status !== row.ticket.status) {
      pushEvent(tab, `${label}: ticket ${row.ticketKey} went ${old.ticket.status} → ${row.ticket.status}`)
    }
    if (old.git?.head && row.git?.head && old.git.head !== row.git.head) {
      void describeHeadMove(row.worktreePath, old.git.head, row.git.head).then((line) => pushEvent(tab, `${label}: ${line}`))
    }
  }
}

const MAX_COMMITS_SHOWN = 5

/** "n new commits: subj; subj" when HEAD advanced, or a rebase/reset note when it didn't. */
async function describeHeadMove(worktreePath: string, oldHead: string, newHead: string): Promise<string> {
  const log = await run("git", ["-C", worktreePath, "log", "--format=%s", `${oldHead}..${newHead}`])
  const subjects = log.ok ? log.stdout.split("\n").filter((s) => s.trim()) : []
  if (subjects.length === 0) {
    return `HEAD moved ${oldHead.slice(0, 7)} → ${newHead.slice(0, 7)} without new commits (rebase/reset/amend?)`
  }
  const shown = subjects.slice(0, MAX_COMMITS_SHOWN).join("; ")
  return `${subjects.length} new commit${subjects.length === 1 ? "" : "s"}: ${shown}${subjects.length > MAX_COMMITS_SHOWN ? "; …" : ""}`
}

let prevEmailIds: Set<string> | null = null

/** New unread arrivals since the previous completed inbox fetch → email agent. */
export function ingestEmails(emails: EmailMessage[]): void {
  const prev = prevEmailIds
  prevEmailIds = new Set(emails.map((e) => e.id))
  if (!prev) return
  for (const mail of emails) {
    if (!mail.isRead && !prev.has(mail.id)) {
      pushEvent("email", `new unread mail from ${mail.from} <${mail.fromAddress}>: ${mail.subject}`)
    }
  }
}

// ---------------------------------------------------------------------------
// calendar: schedule digest on load, diffs on refresh, reminders before start

/** Lead time for the "starting soon" reminder. */
const MEETING_REMINDER_MIN = 10
const REMINDER_TICK_MS = 60_000

let calendarEvents: CalendarEvent[] | null = null
let calendarDay = ""
/** Events already announced as starting soon (id+start, so recurrences count once each). */
const remindedEvents = new Set<string>()
let reminderTimer: ReturnType<typeof setInterval> | null = null

const eventKey = (e: CalendarEvent) => `${e.id}@${e.start}`
/** Meetings that count as commitments: not cancelled, not declined, not all-day. */
const isCommitment = (e: CalendarEvent) => !e.isCancelled && !e.isAllDay && e.response !== "declined"

/** One-line summary of what's left today, for central. */
function scheduleSummary(events: CalendarEvent[], now = Date.now()): string {
  const remaining = events.filter((e) => isCommitment(e) && new Date(e.end).getTime() > now)
  if (remaining.length === 0) return "no more meetings today"
  const current = remaining.find((e) => isNow(e, now))
  const next = remaining.find((e) => minutesUntil(e, now) > 0)
  const last = remaining[remaining.length - 1]
  const parts = [`${remaining.length} meeting${remaining.length === 1 ? "" : "s"} left`]
  if (current) parts.push(`now: ${current.subject} until ${fmtRange(current).split("–")[1]}`)
  if (next) parts.push(`next: ${next.subject} at ${fmtRange(next).split("–")[0]} (in ${fmtMinutes(minutesUntil(next, now))})`)
  if (last) parts.push(`free after ${fmtRange(last).split("–")[1]}`)
  return parts.join("; ")
}

/** Today's schedule → calendar specialist: digest on first load / new day, diffs afterwards. */
export function ingestCalendar(events: CalendarEvent[]): void {
  const prev = calendarEvents
  const today = new Date().toDateString()
  calendarEvents = events
  startReminderTicker()
  if (!prev || calendarDay !== today) {
    calendarDay = today
    remindedEvents.clear()
    const now = Date.now()
    const listed = events.filter(isCommitment).map((e) => fmtEvent(e, now))
    pushEvent(
      "calendar",
      `today's schedule loaded — ${scheduleSummary(events, now)}${listed.length ? `\n${listed.join("\n")}` : ""}`,
      "info",
      { inboxSummary: `today's schedule loaded — ${scheduleSummary(events, now)}` },
    )
    return
  }
  const before = new Map(prev.map((e) => [eventKey(e), e]))
  const after = new Map(events.map((e) => [eventKey(e), e]))
  for (const [key, e] of after) {
    const old = before.get(key)
    if (!old) {
      if (isCommitment(e)) pushEvent("calendar", `new meeting today: ${fmtRange(e)} ${e.subject}${e.organizer ? ` (${e.organizer})` : ""}`)
    } else if (!old.isCancelled && e.isCancelled) {
      pushEvent("calendar", `cancelled: ${fmtRange(e)} ${e.subject}`)
    } else if (old.end !== e.end || old.location !== e.location || old.subject !== e.subject) {
      pushEvent("calendar", `changed: ${e.subject} now ${fmtRange(e)}${e.location ? ` @ ${e.location}` : ""}`)
    }
  }
  for (const [key, old] of before) {
    if (!after.has(key) && isCommitment(old)) pushEvent("calendar", `removed from today: ${fmtRange(old)} ${old.subject}`)
  }
}

function startReminderTicker(): void {
  if (reminderTimer) return
  reminderTimer = setInterval(checkReminders, REMINDER_TICK_MS)
  checkReminders()
}

/** Announce commitments starting within the lead time, once each. */
function checkReminders(): void {
  if (!calendarEvents) return
  const now = Date.now()
  for (const e of calendarEvents) {
    if (!isCommitment(e)) continue
    const key = eventKey(e)
    if (remindedEvents.has(key)) continue
    const minutes = minutesUntil(e, now)
    if (minutes > MEETING_REMINDER_MIN || minutes < -1) continue
    remindedEvents.add(key)
    const where = e.location || (e.isOnline ? "Teams" : "")
    pushEvent(
      "calendar",
      `${e.subject} starts ${minutes <= 0 ? "now" : `in ${minutes}m`}${where ? ` (${where})` : ""}${e.organizer ? ` — ${e.organizer}` : ""}`,
      "attention",
    )
  }
}

const prevTickets = new Map<string, TicketInfo[]>()

let prevCloud: CloudAgent[] | null = null

/** New cloud agents and run-status changes → cloud specialist. */
export function ingestCloud(agents: CloudAgent[]): void {
  const prev = prevCloud
  prevCloud = agents
  if (!prev) return
  const byId = new Map(prev.map((a) => [a.id, a]))
  for (const agent of agents) {
    const old = byId.get(agent.id)
    if (!old) {
      pushEvent("cloud", `new cloud agent ${agent.name} [${agent.status}] ${agent.id}`)
    } else if (old.status !== agent.status) {
      pushEvent("cloud", `${agent.name} ${agent.id} went ${old.status} → ${agent.status}`)
    }
  }
}

let prevProjects: Project[] | null = null

/** New directories and brief status changes under ~/projects → projects specialist. */
export function ingestProjects(projects: Project[]): void {
  const prev = prevProjects
  prevProjects = projects
  if (!prev) return
  const byName = new Map(prev.map((p) => [p.name, p]))
  for (const project of projects) {
    const old = byName.get(project.name)
    if (!old) {
      pushEvent("projects", `new project directory ${project.name}${project.brief ? ` (${project.brief.status})` : " (no PROJECT.md)"}`)
      continue
    }
    const oldStatus = old.brief?.status ?? "none"
    const newStatus = project.brief?.status ?? "none"
    if (oldStatus !== newStatus) {
      pushEvent("projects", `${project.name}: brief status went ${oldStatus} → ${newStatus}`)
    }
  }
  for (const old of prev) {
    if (!projects.some((p) => p.name === old.name)) pushEvent("projects", `project directory ${old.name} is gone`)
  }
}

export function ingestTickets(tab: "tickets" | "epics", tickets: TicketInfo[]): void {
  const prev = prevTickets.get(tab)
  prevTickets.set(tab, tickets)
  if (!prev || prev.length === 0) return
  const byKey = new Map(prev.map((t) => [t.key, t]))
  const noun = tab === "epics" ? "epic" : "ticket"
  for (const ticket of tickets) {
    const old = byKey.get(ticket.key)
    if (!old) {
      pushEvent(tab, `new ${noun}: ${ticket.key} [${ticket.status}] ${ticket.summary}`)
    } else if (old.status !== ticket.status) {
      pushEvent(tab, `${noun} ${ticket.key} went ${old.status} → ${ticket.status}`)
    }
  }
}
