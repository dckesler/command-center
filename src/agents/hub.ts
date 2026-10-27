import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { Agent, CursorAgentError, type SDKCustomTool } from "@cursor/sdk"
import { TAB_AGENT_SPECS, type HubContext, type Snapshot, type TabAgentSpec } from "./specs.ts"
import { ackInbox, appendInbox, formatCatchUp, formatClock, unreadInbox } from "../data/inbox.ts"
import { parseSlash } from "../data/skills.ts"
import { config, statePath } from "../config.ts"
import { centralDir, centralMode } from "../data/central.ts"
import { sendMail } from "../data/mail.ts"
import { emitAgents, getStore, resetStore, subscribeAgents, type ChatItem } from "./stores.ts"

/**
 * AgentHub: owns one SDK agent per tab spec, serializes sends per agent,
 * routes specialist reports into the central agent's inbox, and exposes the
 * HubContext that specs build their tools against.
 *
 * All agents run locally with cwd = $HOME and settingSources ["user"] so they
 * share the saved Atlassian MCP login and the user-level skills.
 *
 * Central comes in two flavours (config central.mode). "embedded": the
 * `central` spec is an SDK agent like the others and tab 1 is its chat.
 * "tmux": the manager is cursor-cli in a pane of the Command Center window
 * (cc-central); reports addressed to central leave this process through
 * cc-mail to central.dir, and instructions come back through the agent feed
 * (cc-instruct → `event: "instruct"` → instructSpecialist).
 */

const MODEL = config().model
const USER = config().user.name
const CENTRAL_TMUX = centralMode() === "tmux"

/** Max autonomous central deliveries per minute (loop/cost guard). */
const CENTRAL_DELIVERIES_PER_MINUTE = 6

type SdkAgent = Awaited<ReturnType<typeof Agent.create>>

interface QueuedMessage {
  /** what shows in the pane */
  text: string
  /** what the agent receives when it differs from `text` (e.g. a `/skill` expansion) */
  payload?: string
  /** how the message renders in the pane: user input vs system traffic */
  display: "user" | "info"
  accent?: ChatItem["accent"]
  onDone?: (finalText: string) => void
}

interface Entry {
  spec: TabAgentSpec
  agent: SdkAgent | null
  seeded: boolean
  queue: QueuedMessage[]
  running: boolean
  lastReport: string | null
  /** did this agent call report_to_central during the current run? */
  reportedInRun: boolean
  /** Unread inbox injected into the first run after (re)create. */
  pendingCatchUp: string | null
}

interface Report {
  from: string
  severity: string
  summary: string
  ts: number
}

const entries = new Map<string, Entry>()
for (const spec of TAB_AGENT_SPECS) {
  entries.set(spec.id, {
    spec,
    agent: null,
    seeded: false,
    queue: [],
    running: false,
    lastReport: null,
    reportedInRun: false,
    pendingCatchUp: null,
  })
}

let snapshot: Snapshot = { rows: [], tickets: [], epics: [], projects: [], todos: [], emails: null, events: null, cloud: [], grok: [], grokBots: [] }
let onAppChanged: (kind: "todos" | "refresh") => void = () => {}

const inbox: Report[] = []
const centralDeliveries: number[] = []
let deliveryTimer: ReturnType<typeof setTimeout> | null = null

// ---------------------------------------------------------------------------
// context handed to specs

const ctx: HubContext = {
  snapshot: () => snapshot,
  appChanged: (kind) => onAppChanged(kind),
  agentList: () =>
    [...entries.values()]
      .filter((e) => e.spec.id !== "central")
      .map((e) => ({ id: e.spec.id, title: e.spec.title, busy: e.running, queued: e.queue.length })),
  agentStatus: (id) => {
    const entry = entries.get(id)
    if (!entry) return `unknown agent "${id}"`
    return [
      `${id}: ${entry.running ? "busy" : "idle"}, ${entry.queue.length} queued`,
      `last report: ${entry.lastReport ?? "(none)"}`,
    ].join("\n")
  },
  instruct: (id, instruction) => instructSpecialist(id, instruction),
}

/**
 * Central (either flavour) tells a specialist what to do. Fire-and-forget:
 * the specialist's final reply comes back to central as a report unless it
 * already reported during that run.
 */
export function instructSpecialist(id: string, instruction: string, from = "central"): string {
  const entry = entries.get(id)
  if (!entry || id === "central") {
    return `unknown agent "${id}" — valid: ${[...entries.keys()].filter((k) => k !== "central").join(", ")}`
  }
  enqueue(id, {
    text: `[instruction from ${from}]\n${instruction}`,
    display: "info",
    onDone: (finalText) => {
      // If the specialist already reported via its tool, don't double up.
      if (!entry.reportedInRun) reportToCentral(id, "info", `reply to instruction: ${finalText || "(no reply)"}`)
    },
  })
  return `instruction queued for ${id} — its reply will arrive as a report`
}

// ---------------------------------------------------------------------------
// hub status file: lets CLIs outside this process (cc-instruct list) see the
// specialists' busy/queue state. Rewritten at most once a second.

const HUB_STATUS = statePath("hub.json")
let hubStatusTimer: ReturnType<typeof setTimeout> | null = null

function writeHubStatus(): void {
  const agents = [...entries.values()]
    .filter((e) => e.spec.id !== "central" || !CENTRAL_TMUX)
    .map((e) => ({
      id: e.spec.id,
      title: e.spec.title,
      live: e.agent !== null,
      busy: e.running,
      queued: e.queue.length,
      lastReport: e.lastReport,
    }))
  const body = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, central: centralMode(), agents })
  try {
    mkdirSync(config().dirs.config, { recursive: true })
    writeFileSync(`${HUB_STATUS}.tmp`, `${body}\n`)
    renameSync(`${HUB_STATUS}.tmp`, HUB_STATUS)
  } catch {
    // status is advisory
  }
}

subscribeAgents(() => {
  if (hubStatusTimer) return
  hubStatusTimer = setTimeout(() => {
    hubStatusTimer = null
    writeHubStatus()
  }, 1_000)
})
writeHubStatus()

// In tmux mode the durable inbox for central is only a log (cc-mail's mailbox
// is the delivery store), so anything left unread from an embedded run is
// already history.
if (CENTRAL_TMUX) {
  const stale = unreadInbox("central")
  if (stale.length) ackInbox("central", stale[stale.length - 1].id)
}

// ---------------------------------------------------------------------------
// public API

export function updateSnapshot(next: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...next }
}

export function currentSnapshot(): Snapshot {
  return snapshot
}

export function setAppChangedHandler(handler: (kind: "todos" | "refresh") => void): void {
  onAppChanged = handler
}

export function agentIds(): string[] {
  return [...entries.keys()]
}

export function agentBusy(id: string): boolean {
  const entry = entries.get(id)
  return entry ? entry.running || entry.queue.length > 0 : false
}

/**
 * True when this tab already has a live SDK handle (catch-up uses the inbox
 * instead). The tmux central is always "live": its mailbox holds whatever it
 * has not read yet, so the hub never wakes or catches it up.
 */
export function isAgentLive(id: string): boolean {
  if (id === "central" && CENTRAL_TMUX) return true
  return entries.get(id)?.agent != null
}

/**
 * User typed a message into an agent's chat pane. `/skill-name args` is
 * expanded into an explicit instruction to read and follow that SKILL.md;
 * `/skills` lists what is installed; an unknown `/name` is answered locally
 * and never sent.
 */
export function sendUser(id: string, text: string): void {
  if (id === "central" && CENTRAL_TMUX) return // tab 1 is read-only; Daniel types in the agent's pane
  if (text.includes("/")) {
    const slash = parseSlash(text)
    if (slash.kind === "mentions") {
      enqueue(id, { text, payload: slash.payload, display: "user", accent: "skill" })
      return
    }
    if (slash.kind === "list") {
      addItem(id, { role: "user", text, accent: "skill" })
      const lines = slash.skills.map((s) => `/${s.name}${s.description ? ` — ${s.description.slice(0, 90)}${s.description.length > 90 ? "…" : ""}` : ""}`)
      addItem(id, { role: "info", text: lines.length ? `${lines.length} skills:\n${lines.join("\n")}` : "no skills found" })
      emitAgents()
      return
    }
    if (slash.kind === "unknown") {
      addItem(id, { role: "user", text })
      const hint = slash.suggestions.length ? ` Did you mean: ${slash.suggestions.map((s) => `/${s.name}`).join(", ")}?` : ""
      addItem(id, { role: "error", text: `no skill named "${slash.name}".${hint} Type /skills to list them.` })
      emitAgents()
      return
    }
    if (slash.kind === "skill") {
      enqueue(id, { text, payload: slash.payload, display: "user", accent: "skill" })
      return
    }
  }
  enqueue(id, { text, display: "user" })
}

/** Hub-originated traffic (event digests, report batches, instructions). */
export function sendSystem(id: string, text: string, onDone?: (finalText: string) => void): void {
  if (id === "central" && CENTRAL_TMUX) {
    void sendMail({ dir: centralDir() }, text, { from: "command center" }).then(() => onDone?.(""))
    return
  }
  enqueue(id, { text, display: "info", onDone })
}

const REPORT_MAX = 160

/** Specialists report up; central's inbox delivers when it goes idle. */
export function reportToCentral(from: string, severity: string, summary: string): void {
  const clipped = summary.replace(/\s+/g, " ").trim().slice(0, REPORT_MAX)
  if (!clipped) return // a specialist called the tool with nothing to say
  const entry = entries.get(from)
  if (entry) entry.lastReport = clipped
  const ts = Date.now()
  inbox.push({ from, severity, summary: clipped, ts })
  appendInbox({
    to: "central",
    from,
    severity: severity === "warn" || severity === "attention" ? severity : "info",
    summary: clipped,
    ts,
  })
  getStore("central").unread = true
  emitAgents()
  deliverInbox()
}

/** Drop an agent's conversation; next message starts a fresh SDK agent. */
export function newConversation(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  const old = entry.agent
  entry.agent = null
  entry.seeded = false
  entry.queue = []
  entry.lastReport = null
  entry.pendingCatchUp = null
  resetStore(id)
  old?.[Symbol.asyncDispose]().catch(() => {})
}

export function markRead(id: string): void {
  const store = getStore(id)
  if (store.unread) {
    store.unread = false
    emitAgents()
  }
}

/** Best-effort cleanup on quit (caller bounds the wait). */
export async function disposeAll(): Promise<void> {
  const agents = [...entries.values()].map((e) => e.agent).filter((a): a is SdkAgent => a !== null)
  for (const entry of entries.values()) entry.agent = null
  await Promise.all(agents.map((a) => a[Symbol.asyncDispose]().catch(() => {})))
}

// ---------------------------------------------------------------------------
// internals

function addItem(id: string, item: Omit<ChatItem, "ts">): void {
  getStore(id).items.push({ ...item, ts: Date.now() })
}

function enqueue(id: string, message: QueuedMessage): void {
  const entry = entries.get(id)
  if (!entry) return
  entry.queue.push(message)
  void processQueue(entry)
}

async function processQueue(entry: Entry): Promise<void> {
  if (entry.running) return
  entry.running = true
  const store = getStore(entry.spec.id)
  store.busy = true
  emitAgents()
  try {
    while (entry.queue.length > 0) {
      const message = entry.queue.shift()!
      addItem(entry.spec.id, { role: message.display, text: message.text, accent: message.accent })
      store.unread = true
      emitAgents()
      entry.reportedInRun = false
      const finalText = await runOnce(entry, message.payload ?? message.text)
      message.onDone?.(finalText)
    }
  } finally {
    store.busy = false
    entry.running = false
    emitAgents()
  }
  // Central going idle is the moment to flush any reports that queued up
  // while it was running.
  if (entry.spec.id === "central") deliverInbox()
}

async function getAgent(entry: Entry): Promise<SdkAgent> {
  if (entry.agent) return entry.agent
  const apiKey = process.env.CURSOR_API_KEY
  if (!apiKey) {
    throw new Error("CURSOR_API_KEY is not set — export it before launching the command center")
  }
  const tools: Record<string, SDKCustomTool> = { ...entry.spec.makeTools(ctx) }
  if (entry.spec.id !== "central") {
    tools.report_to_central = {
      description:
        "One-line status for the central manager. Include the ticket key and what changed. " +
        "Max ~160 characters. Do not quote the ticket agent's last message. " +
        `severity: info (FYI), warn (degrading), attention (needs ${USER} now).`,
      inputSchema: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: 'e.g. "LW-17790 idle, tests pass, no MR yet"',
          },
          severity: { type: "string", enum: ["info", "warn", "attention"] },
        },
        required: ["summary"],
      },
      execute: (args) => {
        const severity = typeof args.severity === "string" ? args.severity : "info"
        entry.reportedInRun = true
        reportToCentral(entry.spec.id, severity, String(args.summary ?? ""))
        return "reported to central"
      },
    }
  }
  entry.agent = await Agent.create({
    apiKey,
    name: `command-center ${entry.spec.id}`,
    model: { id: MODEL },
    agents: entry.spec.agents,
    local: { cwd: homedir(), settingSources: ["user"], customTools: tools },
  })
  const missed = unreadInbox(entry.spec.id)
  if (missed.length > 0) {
    entry.pendingCatchUp = formatCatchUp(missed)
    ackInbox(entry.spec.id, missed[missed.length - 1].id)
  }
  return entry.agent
}

/** Custom tools surface through an MCP bridge with name "mcp"; dig out the real tool name. */
function toolLabel(name: string, args: unknown): string {
  if (name !== "mcp" || typeof args !== "object" || args === null) return name
  const record = args as Record<string, unknown>
  const tool = record.tool ?? record.toolName ?? record.name
  return typeof tool === "string" ? tool : name
}

/** Send one message, stream into the store, return the run's assistant text. */
async function runOnce(entry: Entry, text: string): Promise<string> {
  const store = getStore(entry.spec.id)
  let assistantOpen = false
  let finalText = ""
  const seenCalls = new Map<string, number>()
  try {
    const agent = await getAgent(entry)
    let payload = entry.seeded ? text : `${entry.spec.rolePrompt}\n\n---\n\n${text}`
    entry.seeded = true
    if (entry.pendingCatchUp) {
      payload = `${entry.pendingCatchUp}\n\n---\n\n${payload}`
      entry.pendingCatchUp = null
    }
    const run = await agent.send(payload)
    for await (const event of run.stream()) {
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type !== "text" || !block.text) continue
          finalText += block.text
          if (assistantOpen) {
            store.items[store.items.length - 1].text += block.text
          } else {
            addItem(entry.spec.id, { role: "assistant", text: block.text })
            assistantOpen = true
          }
        }
        store.unread = true
        emitAgents()
      } else if (event.type === "tool_call") {
        const label = `⚙ ${toolLabel(event.name, event.args)}`
        const index = seenCalls.get(event.call_id)
        if (index === undefined) {
          seenCalls.set(event.call_id, store.items.length)
          addItem(entry.spec.id, { role: "tool", text: label })
          assistantOpen = false
          emitAgents()
        } else if (store.items[index].text !== label && label !== "⚙ mcp") {
          store.items[index].text = label
          emitAgents()
        }
      }
    }
    const result = await run.wait()
    if (result.status !== "finished") {
      addItem(entry.spec.id, { role: "error", text: `run ended: ${result.status}` })
      emitAgents()
    }
  } catch (err) {
    // Startup failures leave an unusable handle; drop it so the next send retries.
    if (err instanceof CursorAgentError) {
      entry.agent = null
      entry.seeded = false
    }
    addItem(entry.spec.id, { role: "error", text: err instanceof Error ? err.message : String(err) })
    emitAgents()
  }
  return finalText.trim()
}

function deliveryRateOk(): boolean {
  const cutoff = Date.now() - 60_000
  while (centralDeliveries.length > 0 && centralDeliveries[0] < cutoff) centralDeliveries.shift()
  return centralDeliveries.length < CENTRAL_DELIVERIES_PER_MINUTE
}

function deliverInbox(): void {
  if (inbox.length === 0) return
  const central = entries.get("central")!
  // Embedded: flushed when the SDK agent goes idle. tmux: cc-mail decides
  // (hook mid-turn, follow-up at turn end, or a nudge when idle).
  if (!CENTRAL_TMUX && (central.running || central.queue.length > 0)) return
  if (CENTRAL_TMUX) {
    // Only warn/attention interrupt the central's chat. Info reports stay on the
    // dashboard's central tab (inbox.jsonl) and the agent reads them with cc-inbox.
    const urgent = inbox.filter((r) => r.severity === "warn" || r.severity === "attention")
    inbox.length = 0
    inbox.push(...urgent)
    if (inbox.length === 0) return
  }
  const hasAttention = inbox.some((r) => r.severity === "attention")
  if (!hasAttention && !deliveryRateOk()) {
    if (!deliveryTimer) {
      deliveryTimer = setTimeout(() => {
        deliveryTimer = null
        deliverInbox()
      }, 15_000)
    }
    return
  }
  if (!hasAttention) centralDeliveries.push(Date.now())
  const batch = inbox.splice(0)
  const lastDisk = unreadInbox("central")
  if (lastDisk.length) ackInbox("central", lastDisk[lastDisk.length - 1].id)
  if (CENTRAL_TMUX) {
    void mailBatchToCentral(batch)
    return
  }
  const text = `[reports]\n${batch.map((r) => `- [${formatClock(r.ts)}] ${r.from} (${r.severity}): ${r.summary}`).join("\n")}`
  sendSystem("central", text)
}

let mailChain: Promise<unknown> = Promise.resolve()

/**
 * One cc-mail message per warn/attention report so each keeps its sender and
 * severity; only the last one may wake an idle agent, which then receives every
 * pending message in a single nudge. Sends are chained so batches never interleave.
 */
function mailBatchToCentral(batch: Report[]): Promise<void> {
  const job = mailChain.then(async () => {
    const dir = centralDir()
    for (let i = 0; i < batch.length; i++) {
      const r = batch[i]
      const severity = r.severity === "attention" ? "attention" : "warn"
      const res = await sendMail({ dir }, r.summary, { from: r.from, severity, noWake: i < batch.length - 1 })
      if (!res.ok) console.warn(`central mail failed: ${res.message}`)
    }
  })
  mailChain = job.catch(() => {})
  return job
}
