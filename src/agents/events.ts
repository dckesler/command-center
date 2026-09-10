import { closeSync, existsSync, openSync, readSync, statSync, watch } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type { Row, TicketInfo } from "../types.ts"
import { currentSnapshot, sendSystem } from "./hub.ts"

/**
 * Autonomous event sources. Two feeds produce per-tab "[event digest]"
 * messages that run the owning specialist automatically:
 *
 *  1. the agent hook feed (~/.config/control-center/agents.jsonl) written by
 *     Cursor/Claude hooks in ticket worktrees → worktrees / qa tabs
 *  2. diffs between completed refresh snapshots (MR state, CI, ticket
 *     status) → worktrees / qa / backlog / projects tabs
 *
 * Digests are debounced and rate-limited per tab; every specialist run costs
 * an LLM call, so noise is filtered at the source (interesting states only,
 * value-to-value changes only).
 */

const FEED_DIR = join(homedir(), ".config", "control-center")
const FEED = join(FEED_DIR, "agents.jsonl")

const DEBOUNCE_MS = 2_000
/** Min gap between digest runs for one tab; events accumulate meanwhile. */
const MIN_INTERVAL_MS = 30_000

// ---------------------------------------------------------------------------
// per-tab digest buffers

interface TabBuffer {
  lines: string[]
  timer: ReturnType<typeof setTimeout> | null
  lastSent: number
}

const buffers = new Map<string, TabBuffer>()

function pushEvent(tab: string, line: string): void {
  let buffer = buffers.get(tab)
  if (!buffer) {
    buffer = { lines: [], timer: null, lastSent: 0 }
    buffers.set(tab, buffer)
  }
  buffer.lines.push(line)
  if (buffer.timer) return
  const wait = Math.max(DEBOUNCE_MS, buffer.lastSent + MIN_INTERVAL_MS - Date.now())
  buffer.timer = setTimeout(() => {
    buffer.timer = null
    const lines = buffer.lines.splice(0)
    if (lines.length === 0) return
    buffer.lastSent = Date.now()
    sendSystem(tab, `[event digest]\n${lines.map((l) => `- ${l}`).join("\n")}`)
  }, wait)
}

// ---------------------------------------------------------------------------
// agent hook feed → worktrees / qa

/** States worth waking a specialist for; start/working are routine. */
const INTERESTING_STATES = new Set(["attention", "idle", "ended"])

let feedOffset = 0
const lastStateByDir = new Map<string, string>()
let watching = false

export function startEventWatchers(): void {
  if (watching) return
  watching = true
  feedOffset = existsSync(FEED) ? statSync(FEED).size : 0
  try {
    watch(FEED_DIR, (_event, filename) => {
      if (filename === "agents.jsonl") drainFeed()
    })
  } catch {
    // fs.watch unavailable — hook events just won't stream in
  }
}

function drainFeed(): void {
  if (!existsSync(FEED)) return
  const size = statSync(FEED).size
  if (size < feedOffset) {
    // file truncated/rotated — resync without replaying
    feedOffset = size
    return
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
  for (const line of text.slice(0, end).split("\n")) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as { dir?: string; state?: string; source?: string }
      if (!event.dir || !event.state) continue
      if (lastStateByDir.get(event.dir) === event.state) continue
      lastStateByDir.set(event.dir, event.state)
      if (!INTERESTING_STATES.has(event.state)) continue
      // Only ticket agents in known worktrees count. Crucially this drops the
      // hub's own agents (they run in $HOME and fire the same hooks), which
      // would otherwise create a digest → run → hook → digest feedback loop.
      if (!currentSnapshot().rows.some((r) => r.worktreePath === event.dir)) continue
      const tab = event.dir.includes("_qa_") ? "qa" : "worktrees"
      pushEvent(tab, `ticket agent in ${basename(event.dir)} is now ${event.state}${event.source ? ` (${event.source})` : ""}`)
    } catch {
      // skip malformed line
    }
  }
}

// ---------------------------------------------------------------------------
// refresh snapshot diffs
//
// Only fully-loaded snapshots are ingested (the App gates on its load flags),
// so a value present on both sides that differs is a real change — not a
// progressive-load artifact.

let prevRows: Row[] | null = null

export function ingestRows(rows: Row[]): void {
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
  }
}

const prevTickets = new Map<string, TicketInfo[]>()

export function ingestTickets(tab: "backlog" | "projects", tickets: TicketInfo[]): void {
  const prev = prevTickets.get(tab)
  prevTickets.set(tab, tickets)
  if (!prev || prev.length === 0) return
  const byKey = new Map(prev.map((t) => [t.key, t]))
  const noun = tab === "projects" ? "epic" : "ticket"
  for (const ticket of tickets) {
    const old = byKey.get(ticket.key)
    if (!old) {
      pushEvent(tab, `new ${noun}: ${ticket.key} [${ticket.status}] ${ticket.summary}`)
    } else if (old.status !== ticket.status) {
      pushEvent(tab, `${noun} ${ticket.key} went ${old.status} → ${ticket.status}`)
    }
  }
}
