/**
 * The tmux central agent (config central.mode = "tmux"): cursor-cli running
 * in a pane of the Command Center tmux window, started by the cc-central
 * skill. This module is what the TUI needs for tab 1 — the agent's state and
 * the stream of reports addressed to central (inbox.jsonl), which the agent
 * reads with cc-inbox; only warn/attention reports are mailed into its chat.
 * The agent talks back through cc-instruct, cc-todo and cc-mail, never
 * through the SDK hub.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "../config.ts"
import { readAgentStatuses, type AgentStatus } from "./agents.ts"
import { readInbox, type InboxRecord } from "./inbox.ts"
import { run } from "./exec.ts"
import { readPendingMail, pendingMailFor } from "./mail.ts"

/** Window option values cc-central sets on the Command Center window. */
export const CENTRAL_ROLE = "command-center"

export function centralMode(): "tmux" | "embedded" {
  return config().central.mode
}

export function centralDir(): string {
  return config().central.dir
}

/** The cc-central CLI: repo copy first, then the synced user copy. */
export function ccCentralBin(): string {
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "cc-central", "cc-central")
  if (existsSync(repo)) return repo
  const local = join(homedir(), ".local", "bin", "cc-central")
  if (existsSync(local)) return local
  return join(homedir(), ".agents", "skills", "cc-central", "cc-central")
}

export interface CentralPane {
  /** tmux pane id, e.g. %39 */
  pane: string
  /** session:index of its window */
  window: string
  /** pane_current_command — an agent CLI or a shell when the agent quit */
  command: string
}

/** The pane cc-central registered (window option @agent_pane where @cc_role = command-center), if it still exists. */
export async function centralPane(): Promise<CentralPane | null> {
  const res = await run("tmux", [
    "list-panes", "-a", "-F", "#{pane_id}\t#{session_name}:#{window_index}\t#{pane_current_command}\t#{@cc_role}\t#{@agent_pane}",
  ])
  if (!res.ok) return null
  for (const line of res.stdout.split("\n")) {
    const [pane, window, command, role, agentPane] = line.split("\t")
    if (role === CENTRAL_ROLE && agentPane && agentPane === pane) return { pane, window, command }
  }
  return null
}

const SHELLS = new Set(["zsh", "bash", "sh", "fish", "-zsh", "-bash", "login"])

export interface CentralSnapshot {
  /** hook state of the agent in central.dir (null when none is known) */
  status: AgentStatus | null
  pane: CentralPane | null
  /** the pane exists and runs something other than a shell */
  running: boolean
  /** undelivered cc-mail waiting for it */
  pendingMail: number
  /** reports addressed to central, oldest first (what tab 1 lists) */
  reports: InboxRecord[]
  /** id of the newest report the agent has read with cc-inbox */
  seenId: string | null
  /** reports newer than seenId */
  unseen: number
}

function seenPath(): string {
  return join(centralDir(), "seen.json")
}

/** Newest report id the agent has read (cc-inbox writes it). */
export function readSeen(): string | null {
  try {
    const raw = JSON.parse(readFileSync(seenPath(), "utf8")) as { id?: string }
    return typeof raw.id === "string" ? raw.id : null
  } catch {
    return null
  }
}

export function writeSeen(id: string): void {
  mkdirSync(centralDir(), { recursive: true })
  writeFileSync(seenPath(), `${JSON.stringify({ id, ts: Date.now() })}\n`)
}

/** Reports to central (all severities), oldest first; `limit` newest. */
export function centralReports(limit = 200): InboxRecord[] {
  const all = readInbox().filter((r) => r.to === "central")
  return all.slice(-limit)
}

/** Reports newer than the agent's seen cursor (all when none). */
export function unseenReports(reports: InboxRecord[] = centralReports(), seenId: string | null = readSeen()): InboxRecord[] {
  if (!seenId) return reports
  const idx = reports.findIndex((r) => r.id === seenId)
  return idx === -1 ? reports : reports.slice(idx + 1)
}

/** Everything tab 1 shows. */
export async function readCentral(limit = 200): Promise<CentralSnapshot> {
  const dir = centralDir()
  const status = readAgentStatuses().get(dir) ?? null
  const pane = await centralPane()
  const running = pane !== null && !SHELLS.has(pane.command)
  const pendingMail = pendingMailFor(readPendingMail(), dir)?.count ?? 0
  const reports = centralReports(limit)
  const seenId = readSeen()
  return { status, pane, running, pendingMail, reports, seenId, unseen: unseenReports(reports, seenId).length }
}

/** Start the agent if the window has none (idempotent): `cc-central ensure`. */
export async function ensureCentral(): Promise<{ ok: boolean; message: string }> {
  const res = await run(ccCentralBin(), ["ensure"], { timeoutMs: 20_000 })
  const out = (res.stdout.trim() || res.stderr.trim()).split("\n").pop() ?? ""
  return { ok: res.ok, message: out || (res.ok ? "cc-central ensure ran" : "cc-central failed") }
}

/** Put the central agent's pane on screen with the cursor in it. */
export async function focusCentral(): Promise<boolean> {
  const pane = await centralPane()
  if (!pane) return false
  await run("tmux", ["switch-client", "-t", pane.window])
  await run("tmux", ["select-window", "-t", pane.window])
  const res = await run("tmux", ["select-pane", "-t", pane.pane])
  return res.ok
}
