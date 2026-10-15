/**
 * Grok Bot runs — thin wrapper over the `cc-grok` CLI (skills/cc-grok).
 *
 * A "run" is one webhook POST to a Bot's routine. The Bot writes its report
 * to the GitLab outbox repo; `cc-grok pull` fetches new reports and delivers
 * each to whoever asked (an agent pane via cc-mail, or a TUI tab via
 * cc-report). This module only reads state and shells out — the CLI owns the
 * formats so agents and the TUI agree.
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { run } from "./exec.ts"

export type GrokState = "sent" | "refused" | "unknown" | "done" | "blocked" | "needs-you" | "failed"

export interface GrokReport {
  status: string
  summary: string
  finished: string
  bot: string
  body: string
}

export interface GrokRun {
  id: string
  bot: string
  task: string
  reportTo: string
  ticket: string
  from: string
  /** ISO time the webhook was fired */
  ts: string
  /** webhook outcome: sent | refused | unknown */
  status: string
  http: string
  detail: string
  /** report status when one exists, else the webhook outcome */
  state: GrokState
  report: GrokReport | null
  /** absolute path of the report file in the local outbox clone ("" if none) */
  reportPath: string
  /** report already delivered to whoever asked */
  delivered: boolean
}

export interface GrokBot {
  name: string
  /** has a webhook + key in grok.json, so cc-grok can start it */
  webhook: boolean
  /** seen in the desktop app's local roster */
  inRoster: boolean
  lastActivityAt: string | null
  awaiting: boolean
  unread: number
  last: string
}

export interface GrokResult {
  ok: boolean
  message: string
}

export function ccGrokBin(): string {
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "cc-grok", "cc-grok")
  if (existsSync(repo)) return repo
  const local = join(homedir(), ".local", "bin", "cc-grok")
  if (existsSync(local)) return local
  return join(homedir(), ".agents", "skills", "cc-grok", "cc-grok")
}

async function grok(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ ok: boolean; out: string; err: string }> {
  const r = await run(ccGrokBin(), args, opts)
  return { ok: r.ok, out: r.stdout, err: r.stderr }
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {}
}
function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function toRun(raw: unknown): GrokRun {
  const r = rec(raw)
  const rep = r.report ? rec(r.report) : null
  return {
    id: str(r.id),
    bot: str(r.bot),
    task: str(r.task),
    reportTo: str(r.report_to),
    ticket: str(r.ticket),
    from: str(r.from),
    ts: str(r.ts),
    status: str(r.status),
    http: str(r.http),
    detail: str(r.detail),
    state: (str(r.state) || "sent") as GrokState,
    report: rep
      ? { status: str(rep.status), summary: str(rep.summary), finished: str(rep.finished), bot: str(rep.bot), body: str(rep.body) }
      : null,
    reportPath: str(r.report_path),
    delivered: r.delivered === true,
  }
}

/** Newest first. Reports come from the last pulled outbox clone (no network). */
export async function listGrokRuns(): Promise<GrokRun[]> {
  const { ok, out } = await grok(["runs", "--json"])
  if (!ok || !out.trim()) return []
  try {
    const parsed = JSON.parse(out)
    return Array.isArray(parsed) ? parsed.map(toRun) : []
  } catch {
    return []
  }
}

/** Configured Bots merged with the desktop app roster. */
export async function listGrokBots(): Promise<GrokBot[]> {
  const { ok, out } = await grok(["bots", "--json"])
  if (!ok || !out.trim()) return []
  try {
    const parsed = JSON.parse(out)
    if (!Array.isArray(parsed)) return []
    return parsed.map((raw) => {
      const b = rec(raw)
      return {
        name: str(b.name),
        webhook: b.webhook === true,
        inRoster: b.inRoster === true,
        lastActivityAt: typeof b.lastActivityAt === "string" ? b.lastActivityAt : null,
        awaiting: b.awaiting === true,
        unread: typeof b.unread === "number" ? b.unread : 0,
        last: str(b.last),
      }
    })
  } catch {
    return []
  }
}

/**
 * Fetch the outbox and deliver any new reports. Network; called on refresh.
 * Returns the ids that were just delivered (for events).
 */
export async function pullGrokReports(): Promise<string[]> {
  const { ok, out } = await grok(["pull", "--json"], { timeoutMs: 90_000 })
  if (!ok || !out.trim()) return []
  try {
    const parsed = JSON.parse(out)
    return Array.isArray(parsed) ? parsed.map((r) => str(rec(r).id)).filter(Boolean) : []
  } catch {
    return []
  }
}

/**
 * Fire a Bot's webhook. `reportTo` is a tab name, `project:<name>`, or an
 * absolute agent directory; the TUI passes "grok" for runs it starts itself.
 */
export async function startGrokRun(
  bot: string,
  task: string,
  opts: { reportTo?: string; ticket?: string; from?: string } = {},
): Promise<GrokResult & { id?: string }> {
  const args = ["start", "--bot", bot]
  if (opts.reportTo) args.push("--report-to", opts.reportTo)
  if (opts.ticket) args.push("--ticket", opts.ticket)
  args.push("--from", opts.from ?? "command-center", task)
  const { ok, out, err } = await grok(args, { cwd: homedir(), timeoutMs: 45_000 })
  const text = (out + err).trim()
  const id = /run (\d{8}T\d{6}-[a-z0-9]{4})/.exec(text)?.[1]
  if (ok) return { ok: true, message: text || `sent to ${bot}`, id }
  // cc-grok exits 4 (refused / bad args) or 6 (unknown — curl failed); the text says which.
  return { ok: false, message: text || `cc-grok start failed for ${bot}`, id }
}

export function fmtGrokRun(r: GrokRun): string {
  const when = r.ts ? r.ts.slice(5, 16).replace("T", " ") : ""
  const head = `${r.id} ${r.bot} [${r.state}] → ${r.reportTo}${r.ticket ? ` (${r.ticket})` : ""} ${when} from ${r.from || "?"}: ${r.task.slice(0, 120)}`
  return r.report?.summary ? `${head}\n    ↳ ${r.report.summary.slice(0, 160)}` : head
}

export function fmtGrokBot(b: GrokBot): string {
  const flags = [b.webhook ? "webhook" : "no webhook", b.inRoster ? "" : "not in app roster", b.awaiting ? "awaiting Daniel" : "", b.unread ? `${b.unread} unread` : ""]
    .filter(Boolean)
    .join(", ")
  return `${b.name} (${flags})${b.last ? `: ${b.last.slice(0, 100)}` : ""}`
}
