import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type AgentState = "start" | "working" | "idle" | "attention" | "ended"

export interface AgentStatus {
  state: AgentState
  source: string // "cursor" | "claude"
  ts: string
  session: string
}

const FEED = join(homedir(), ".config", "control-center", "agents.jsonl")

/** Events older than this are ignored (e.g. sessions killed without a sessionEnd). */
const STALE_MS = 24 * 60 * 60 * 1000

/**
 * Latest hook event per directory wins. Directories whose last event is
 * "ended" (or too old to trust) report no agent.
 */
export function readAgentStatuses(): Map<string, AgentStatus> {
  if (!existsSync(FEED)) return new Map()
  const map = new Map<string, AgentStatus>()
  for (const line of readFileSync(FEED, "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as { dir?: string } & AgentStatus
      if (!e.dir || !e.state) continue
      map.set(e.dir, { state: e.state, source: e.source, ts: e.ts, session: e.session })
    } catch {
      // skip malformed line
    }
  }
  const cutoff = Date.now() - STALE_MS
  for (const [dir, status] of map) {
    if (status.state === "ended" || new Date(status.ts).getTime() < cutoff) {
      map.delete(dir)
    }
  }
  return map
}
