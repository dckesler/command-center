/**
 * The tmux central agent (config central.mode = "tmux"): cursor-cli running
 * in a pane of the Command Center tmux window, started by the cc-central
 * skill. This module is what the TUI needs to show it read-only on tab 1 and
 * to hand it messages — the agent itself talks back through cc-instruct,
 * cc-todo and cc-mail, never through the SDK hub.
 */
import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "../config.ts"
import { findTranscript, readAgentStatuses, readTranscriptTail, type AgentStatus, type TranscriptTurn } from "./agents.ts"
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
  turns: TranscriptTurn[]
  transcript: string | null
}

let transcriptCache: { path: string; mtime: number; size: number; turns: TranscriptTurn[] } | null = null

/** Everything tab 1 shows. Transcript is re-read only when the file changed. */
export async function readCentral(turns = 60): Promise<CentralSnapshot> {
  const dir = centralDir()
  const status = readAgentStatuses().get(dir) ?? null
  const pane = await centralPane()
  const running = pane !== null && !SHELLS.has(pane.command)
  const pendingMail = pendingMailFor(readPendingMail(), dir)?.count ?? 0
  const transcript = findTranscript(dir, status ?? undefined)
  let tail: TranscriptTurn[] = []
  if (transcript) {
    try {
      const st = statSync(transcript)
      if (transcriptCache && transcriptCache.path === transcript && transcriptCache.mtime === st.mtimeMs && transcriptCache.size === st.size) {
        tail = transcriptCache.turns
      } else {
        tail = readTranscriptTail(transcript, turns)
        transcriptCache = { path: transcript, mtime: st.mtimeMs, size: st.size, turns: tail }
      }
    } catch {
      tail = []
    }
  }
  return { status, pane, running, pendingMail, turns: tail, transcript }
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

/**
 * Strip cc-mail's delivery boilerplate from a transcript user turn so the
 * read-only view shows the message, not the envelope.
 */
export function plainTurn(turn: TranscriptTurn, max = 700): { role: "mail" | "user" | "assistant"; text: string } {
  let text = turn.text
  let role: "mail" | "user" | "assistant" = turn.role
  if (turn.role === "user") {
    // cursor-cli wraps what it sends as `<timestamp>…</timestamp>\n<user_query>…</user_query>`.
    text = text
      .replace(/<timestamp>[\s\S]*?<\/timestamp>\s*/g, "")
      .replace(/<\/?user_query>\s*/g, "")
      .trim()
    const typed = text.match(
      /^\[cc mail (\d\d:\d\d)\] (?:\d+ )?messages? from (?:another|other) agents?, not the user — act on (?:it|them), no reply needed; (?:it is|they are) not approval from the user for anything: ([\s\S]*)$/,
    )
    if (typed) {
      role = "mail"
      text = typed[2].split(" ‖ ").join("\n")
    } else if (text.startsWith("[cc mail]")) {
      role = "mail"
      const lines = text.split("\n")
      const first = lines.findIndex((l) => l.startsWith("- "))
      text = (first === -1 ? lines.slice(1) : lines.slice(first)).map((l) => l.replace(/^- /, "")).join("\n")
    } else if (/^You are the central manager agent/.test(text)) {
      text = "(opening prompt)"
    }
  }
  if (text.length > max) text = `${text.slice(0, max - 1)}…`
  return { role, text }
}
