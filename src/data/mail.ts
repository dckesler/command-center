/**
 * Inter-agent mailboxes (see skills/cc-mail/cc-mail).
 *
 * Every message between agents is appended to
 * ~/.config/command-center/mail/<dir with "/" → "%">.jsonl and delivered by
 * the Cursor hooks (postToolUse → additional_context, stop → followup_message)
 * or, for an idle agent whose tmux session is quiet and whose input box is
 * empty, by typing one line into its pane. The TUI only reads pending counts
 * and sends through the CLI so there is exactly one delivery implementation.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { config, statePath } from "../config.ts"
import { run } from "./exec.ts"

const MAIL_DIR = statePath("mail")

/** The cc-mail CLI: repo copy first, then the synced user copy. */
export function ccMailBin(): string {
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "cc-mail", "cc-mail")
  if (existsSync(repo)) return repo
  const local = join(homedir(), ".local", "bin", "cc-mail")
  if (existsSync(local)) return local
  return join(homedir(), ".agents", "skills", "cc-mail", "cc-mail")
}

function canon(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

function decodeBox(name: string): string {
  return name.replace(/\.jsonl$/, "").replace(/%/g, "/")
}

function countLines(path: string): number {
  try {
    const text = readFileSync(path, "utf8")
    return text.length === 0 ? 0 : text.split("\n").filter((l) => l.length > 0).length
  } catch {
    return 0
  }
}

export interface PendingMail {
  count: number
  /** epoch ms of the oldest undelivered message (0 if unparsable) */
  oldestAt: number
  /** sender of the oldest undelivered message */
  oldestFrom: string
}

/** Undelivered mail keyed by canonical directory (only dirs with pending mail). */
export function readPendingMail(): Map<string, PendingMail> {
  const map = new Map<string, PendingMail>()
  if (!existsSync(MAIL_DIR)) return map
  for (const name of readdirSync(MAIL_DIR)) {
    if (!name.endsWith(".jsonl")) continue
    const box = join(MAIL_DIR, name)
    let lines: string[]
    try {
      lines = readFileSync(box, "utf8").split("\n").filter((l) => l.length > 0)
    } catch {
      continue
    }
    let read = 0
    try {
      read = Number(readFileSync(`${box}.read`, "utf8").replace(/\D/g, "")) || 0
    } catch {
      read = 0
    }
    if (lines.length <= read) continue
    let oldestAt = 0
    let oldestFrom = "?"
    try {
      const first = JSON.parse(lines[read]) as { ts?: string; from?: string }
      oldestAt = first.ts ? Date.parse(first.ts) || 0 : 0
      oldestFrom = first.from ?? "?"
    } catch {
      // unparsable line: age unknown
    }
    map.set(decodeBox(name), { count: lines.length - read, oldestAt, oldestFrom })
  }
  return map
}

/** Pending mail for one directory (null when none). Accepts raw or canonical paths. */
export function pendingMailFor(pending: Map<string, PendingMail>, dir: string): PendingMail | null {
  return pending.get(dir) ?? pending.get(canon(dir)) ?? null
}

/** Minutes the oldest pending message has waited (0 when unknown). */
export function mailWaitMinutes(mail: PendingMail | null, now: number = Date.now()): number {
  if (!mail || !mail.oldestAt) return 0
  return Math.max(0, Math.floor((now - mail.oldestAt) / 60_000))
}

/** Pending mail older than `mail.staleMinutes` — the retrier has not managed to hand it over. */
export function isMailStuck(mail: PendingMail | null, now: number = Date.now()): boolean {
  return mailWaitMinutes(mail, now) >= config().mail.staleMinutes
}

export type MailTarget = { dir: string } | { pane: string } | { window: string }

/**
 * Send a message to the agent in a directory / pane / tmux window through
 * cc-mail. Resolves to the CLI's one-line outcome ("delivered … nudged" or
 * "queued … <why>").
 */
export async function sendMail(
  target: MailTarget,
  text: string,
  opts: { from: string; severity?: "info" | "warn" | "attention" } = { from: "command center" },
): Promise<{ ok: boolean; message: string }> {
  const args = ["send"]
  if ("dir" in target) args.push("--dir", target.dir)
  else if ("pane" in target) args.push("--pane", target.pane)
  else args.push("--window", target.window)
  args.push("--from", opts.from, "--severity", opts.severity ?? "info", text)
  const res = await run(ccMailBin(), args, { timeoutMs: 15_000 })
  const out = (res.stdout.trim() || res.stderr.trim()).split("\n").pop() ?? ""
  if (!res.ok) return { ok: false, message: out || "cc-mail failed" }
  return { ok: true, message: out }
}
