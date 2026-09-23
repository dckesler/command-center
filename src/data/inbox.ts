import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { config } from "../config.ts"

export type InboxSeverity = "info" | "warn" | "attention"

export interface InboxRecord {
  id: string
  ts: number
  from: string
  to: string
  severity: InboxSeverity
  summary: string
  ticket?: string
  dir?: string
}

interface CursorFile {
  feedOffset?: number
  lastFeedTs?: string
  consumers?: Record<string, string>
}

function dataDir(): string {
  return config().dirs.config
}

function inboxPath(): string {
  return join(dataDir(), "inbox.jsonl")
}

function cursorPath(): string {
  return join(dataDir(), "cursors.json")
}

function ensureDir(): void {
  mkdirSync(dataDir(), { recursive: true })
}

function readCursors(): CursorFile {
  if (!existsSync(cursorPath())) return {}
  try {
    return JSON.parse(readFileSync(cursorPath(), "utf8")) as CursorFile
  } catch {
    return {}
  }
}

function writeCursors(next: CursorFile): void {
  ensureDir()
  const tmp = `${cursorPath()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next)}\n`)
  renameSync(tmp, cursorPath())
}

export function formatClock(ts: number = Date.now()): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  return `${hh}:${mm}`
}

export function getFeedCursor(): { offset: number; lastTs: string | null; hasCursor: boolean } {
  const cursors = readCursors()
  if (cursors.feedOffset === undefined && !cursors.lastFeedTs) {
    return { offset: 0, lastTs: null, hasCursor: false }
  }
  return { offset: cursors.feedOffset ?? 0, lastTs: cursors.lastFeedTs ?? null, hasCursor: true }
}

export function setFeedOffset(offset: number, lastTs?: string | null): void {
  const prev = readCursors()
  writeCursors({
    ...prev,
    feedOffset: offset,
    lastFeedTs: lastTs ?? prev.lastFeedTs,
  })
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function appendInbox(input: Omit<InboxRecord, "id" | "ts"> & { ts?: number }): InboxRecord {
  const record: InboxRecord = {
    id: newId(),
    ts: input.ts ?? Date.now(),
    from: input.from,
    to: input.to,
    severity: input.severity,
    summary: input.summary,
    ticket: input.ticket,
    dir: input.dir,
  }
  ensureDir()
  writeFileSync(inboxPath(), `${JSON.stringify(record)}\n`, { flag: "a" })
  rotateInbox()
  return record
}

function rotateInbox(): void {
  if (!existsSync(inboxPath())) return
  const raw = readFileSync(inboxPath(), "utf8")
  const lines = raw.split("\n").filter((l) => l.trim())
  if (lines.length <= 4000) return
  writeFileSync(inboxPath(), `${lines.slice(-2000).join("\n")}\n`)
}

export function readInbox(): InboxRecord[] {
  if (!existsSync(inboxPath())) return []
  const out: InboxRecord[] = []
  for (const line of readFileSync(inboxPath(), "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as InboxRecord)
    } catch {
      // skip malformed
    }
  }
  return out
}

export function unreadInbox(consumer: string): InboxRecord[] {
  const records = readInbox().filter((r) => r.to === consumer)
  const lastId = readCursors().consumers?.[consumer]
  if (!lastId) return records
  const idx = records.findIndex((r) => r.id === lastId)
  return idx === -1 ? records : records.slice(idx + 1)
}

export function ackInbox(consumer: string, id: string): void {
  const prev = readCursors()
  writeCursors({
    ...prev,
    consumers: { ...prev.consumers, [consumer]: id },
  })
}

export function formatCatchUp(records: InboxRecord[]): string {
  const lines = records.map(
    (r) => `- [${formatClock(r.ts)}] ${r.id} ${r.from} (${r.severity}): ${r.summary}`,
  )
  return `[catch-up] ${records.length} update${records.length === 1 ? "" : "s"} while you were down\n${lines.join("\n")}`
}

export function ticketKeyFromDir(dir: string): string | undefined {
  const match = dir.match(/([A-Z][A-Z0-9]+-\d+)/)
  return match?.[1]
}
