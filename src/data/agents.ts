import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { statePath } from "../config.ts"

export type AgentState = "start" | "working" | "idle" | "attention" | "ended"

export interface AgentStatus {
  state: AgentState
  source: string // "cursor" | "claude"
  ts: string
  session: string
  /** Notification text / permission request that caused an "attention" state (Claude only). */
  summary?: string
  /** Transcript path reported by the hook payload (Claude only). */
  transcript?: string
}

/**
 * One line of ~/.config/control-center/agents.jsonl, written by
 * agent-event.sh from Cursor/Claude hooks or by the `cc-report` CLI.
 * State events carry `state`; activity events carry `event` instead
 * (response text, file edits, state-changing git/glab commands);
 * explicit reports use `event: "report"` plus `to` / `severity`.
 */
export interface FeedEvent {
  ts: string
  source: string
  dir: string
  session: string
  state?: AgentState
  event?: "response" | "edit" | "shell" | "report"
  summary?: string
  transcript?: string
  text?: string
  file?: string
  command?: string
  /** Explicit report target (cc-report). */
  to?: string
  severity?: "info" | "warn" | "attention"
}

const FEED = statePath("agents.jsonl")

/** Events older than this are ignored (e.g. sessions killed without a sessionEnd). */
const STALE_MS = 24 * 60 * 60 * 1000

export function parseFeedLine(line: string): FeedEvent | null {
  if (!line.trim()) return null
  try {
    const e = JSON.parse(line) as Partial<FeedEvent>
    if (!e.dir || (!e.state && !e.event)) return null
    return e as FeedEvent
  } catch {
    return null
  }
}

/**
 * Latest hook state event per directory wins. Directories whose last event is
 * "ended" (or too old to trust) report no agent.
 */
export function readAgentStatuses(): Map<string, AgentStatus> {
  if (!existsSync(FEED)) return new Map()
  const map = new Map<string, AgentStatus>()
  for (const line of readFileSync(FEED, "utf8").split("\n")) {
    const e = parseFeedLine(line)
    if (!e?.state) continue
    map.set(e.dir, {
      state: e.state,
      source: e.source,
      ts: e.ts,
      session: e.session,
      summary: e.summary,
      transcript: e.transcript,
    })
  }
  const cutoff = Date.now() - STALE_MS
  for (const [dir, status] of map) {
    if (status.state === "ended" || new Date(status.ts).getTime() < cutoff) {
      map.delete(dir)
    }
  }
  return map
}

// ---------------------------------------------------------------------------
// transcripts
//
// Both tools keep per-conversation JSONL transcripts keyed by a slug of the
// workspace path ("/" and "_" → "-"; Claude keeps the leading dash):
//   cursor: ~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl
//   claude: ~/.claude/projects/-<slug>/<id>.jsonl

function slug(dir: string): string {
  return dir.replace(/^\//, "").replace(/[/_]/g, "-")
}

function newestJsonl(dir: string, recurse: boolean): string | null {
  if (!existsSync(dir)) return null
  let best: { path: string; mtime: number } | null = null
  const visit = (d: string, depth: number) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (recurse && depth < 1) visit(p, depth + 1)
      } else if (name.endsWith(".jsonl") && (!best || st.mtimeMs > best.mtime)) {
        best = { path: p, mtime: st.mtimeMs }
      }
    }
  }
  visit(dir, 0)
  return best ? (best as { path: string }).path : null
}

/**
 * Locate the transcript of the agent working in `dir`. Prefers the exact
 * session from the hook feed; falls back to the newest transcript for that
 * workspace (covers sessions that already ended).
 */
export function findTranscript(dir: string, status: AgentStatus | undefined): string | null {
  if (status?.transcript && existsSync(status.transcript)) return status.transcript
  const home = homedir()
  const cursorDir = join(home, ".cursor", "projects", slug(dir), "agent-transcripts")
  const claudeDir = join(home, ".claude", "projects", `-${slug(dir)}`)
  if (status?.session) {
    const exact =
      status.source === "claude"
        ? join(claudeDir, `${status.session}.jsonl`)
        : join(cursorDir, status.session, `${status.session}.jsonl`)
    if (existsSync(exact)) return exact
  }
  const candidates = [
    status?.source === "claude" ? newestJsonl(claudeDir, false) : newestJsonl(cursorDir, true),
    status?.source === "claude" ? newestJsonl(cursorDir, true) : newestJsonl(claudeDir, false),
  ].filter((p): p is string => !!p)
  if (candidates.length === 0) return null
  return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

export interface TranscriptTurn {
  role: "user" | "assistant"
  text: string
}

/** Text content of one transcript line in either tool's format, or null for tool traffic/meta lines. */
function turnFromLine(line: string): TranscriptTurn | null {
  if (!line.trim()) return null
  let obj: {
    role?: string
    type?: string
    isSidechain?: boolean
    message?: { role?: string; content?: unknown }
  }
  try {
    obj = JSON.parse(line)
  } catch {
    return null
  }
  if (obj.isSidechain) return null
  const role = obj.role ?? obj.message?.role
  if (role !== "user" && role !== "assistant") return null
  if (obj.type && obj.type !== "user" && obj.type !== "assistant") return null
  const content = obj.message?.content
  let text = ""
  if (typeof content === "string") {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .filter((p): p is { type: string; text: string } => !!p && typeof p === "object" && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n")
  }
  text = text.trim()
  if (!text) return null
  return { role, text }
}

/** Last `turns` user/assistant text turns of a transcript, oldest first. */
export function readTranscriptTail(path: string, turns: number): TranscriptTurn[] {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return []
  }
  const lines = raw.split("\n")
  const out: TranscriptTurn[] = []
  for (let i = lines.length - 1; i >= 0 && out.length < turns; i--) {
    const turn = turnFromLine(lines[i])
    if (turn) out.push(turn)
  }
  return out.reverse()
}
