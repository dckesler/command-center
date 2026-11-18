import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { statePath } from "../config.ts"

/**
 * hub-agents.json — the Cursor SDK agent id behind each hub specialist (review,
 * worktrees, projects, …). The hub writes an entry when it creates a
 * specialist and resumes that agent on the next TUI start instead of creating
 * a fresh one, so a specialist keeps its conversation across restarts.
 * cc-snapshot copies the file into a snapshot; cc-restore writes it back
 * before starting the TUI.
 */

export const HUB_AGENTS_FILE = statePath("hub-agents.json")

export interface SavedHubAgent {
  agentId: string
  /** SDK model the conversation runs on; a different configured model starts fresh */
  model: string
  /** when the agent was created */
  ts: string
}

export type SavedHubAgents = Record<string, SavedHubAgent>

export function readSavedHubAgents(): SavedHubAgents {
  if (!existsSync(HUB_AGENTS_FILE)) return {}
  try {
    const raw = JSON.parse(readFileSync(HUB_AGENTS_FILE, "utf8")) as unknown
    if (!raw || typeof raw !== "object") return {}
    const out: SavedHubAgents = {}
    for (const [id, v] of Object.entries(raw as Record<string, Partial<SavedHubAgent>>)) {
      if (v && typeof v.agentId === "string" && typeof v.model === "string") out[id] = { agentId: v.agentId, model: v.model, ts: v.ts ?? "" }
    }
    return out
  } catch {
    return {}
  }
}

/** Record (or with `null`, forget) the SDK agent behind a specialist. */
export function saveHubAgent(id: string, agent: SavedHubAgent | null): void {
  const all = readSavedHubAgents()
  if (agent) all[id] = agent
  else delete all[id]
  try {
    mkdirSync(dirname(HUB_AGENTS_FILE), { recursive: true })
    writeFileSync(`${HUB_AGENTS_FILE}.tmp`, `${JSON.stringify(all, null, 2)}\n`)
    renameSync(`${HUB_AGENTS_FILE}.tmp`, HUB_AGENTS_FILE)
  } catch {
    // advisory: losing the id only costs a fresh conversation next start
  }
}
