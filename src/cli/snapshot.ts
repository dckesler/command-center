/**
 * cc-snapshot / cc-restore — save the live Command Center (every tmux session,
 * window, pane, and the agent conversation running in each pane) to a file,
 * and rebuild it later: same sessions and windows, same layouts, each agent
 * resumed in its pane with `--resume=<conversation id>`.
 *
 * What is captured per pane: cwd, the program in the foreground (from the
 * shell's child process), and — for agent panes — the conversation id the
 * hooks recorded for that pane (agents.jsonl state events carry `pane`).
 * Durable state (todos, inbox, mailboxes, LOG.md) is already on disk and is
 * not part of a snapshot.
 *
 *   bun run src/cli/snapshot.ts save [name] [--note "…"]
 *   bun run src/cli/snapshot.ts list | show [name]
 *   bun run src/cli/snapshot.ts restore [name] [--dry-run] [--no-agents] [--session <name>]…
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config, statePath } from "../config.ts"
import { findTranscript, parseFeedLine, slug } from "../data/agents.ts"
import { homedir } from "node:os"
import { centralDir } from "../data/central.ts"
import { run } from "../data/exec.ts"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const SNAP_DIR = statePath("snapshots")
const VERSION = 1

type PaneKind = "agent" | "tui" | "dash" | "central" | "editor" | "shell" | "other"

interface PaneSnap {
  id: string
  index: number
  cwd: string
  /** pane_current_command at save time */
  command: string
  /** argv of the foreground program (child of the pane shell), if any */
  args: string | null
  /** epoch ms the foreground program started (for matching transcripts) */
  started: number | null
  active: boolean
  kind: PaneKind
  /** cursor-cli conversation to resume, when the hooks tied one to this pane */
  agent: { session: string; model: string | null; source: string } | null
}

interface WindowSnap {
  index: number
  name: string
  layout: string
  active: boolean
  role: string | null
  agentPane: string | null
  /** the Command Center dev session — restored as shells only, never an agent */
  protected: boolean
  panes: PaneSnap[]
}

interface SessionSnap {
  name: string
  idx: string | null
  label: string | null
  activeWindow: number
  windows: WindowSnap[]
}

interface Snapshot {
  version: number
  name: string
  ts: string
  note: string | null
  host: string
  current: { session: string; window: number } | null
  sessions: SessionSnap[]
}

const USAGE = `usage:
  cc-snapshot save [name] [--note "…"]   save every tmux session/window/pane + agent conversation ids (default name: timestamp; also "latest")
  cc-snapshot list                        saved snapshots
  cc-snapshot show [name]                 what a snapshot would restore (default: latest)
  cc-restore [name] [--dry-run] [--no-agents] [--session <name>]…
                                          rebuild missing sessions/windows from a snapshot (default: latest); existing windows are left alone;
                                          agents resume their conversations in place (--no-agents: shells only)`

const SHELLS = new Set(["zsh", "bash", "sh", "fish", "-zsh", "-bash", "login"])

async function tmux(args: string[]): Promise<string> {
  const res = await run("tmux", args)
  if (!res.ok) throw new Error(`tmux ${args.join(" ")}: ${res.stderr.trim() || "failed"}`)
  return res.stdout
}

function sh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * argv of the program running in the pane: the outermost non-shell process on
 * the pane's tty (agent launchers re-exec and double-fork, so walking the
 * shell's children misses them; the controlling terminal does not).
 */
async function foreground(paneTty: string): Promise<{ args: string; started: number | null } | null> {
  const tty = paneTty.replace(/^\/dev\//, "")
  // lstart is fixed-width ("Wed Oct 28 13:59:05 2026"), so it can lead the line.
  const ps = await run("ps", ["-t", tty, "-o", "lstart=,pid=,ppid=,args="])
  if (!ps.ok) return null
  const procs = ps.stdout
    .split("\n")
    .map((l) => l.trim().match(/^(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ started: Date.parse(m[1]), pid: m[2], ppid: m[3], args: m[4] }))
    .filter((p) => !SHELLS.has(basename(p.args.split(" ")[0]).replace(/^-/, "")))
  const pids = new Set(procs.map((p) => p.pid))
  const roots = procs.filter((p) => !pids.has(p.ppid))
  const pick = roots[0] ?? procs[0]
  return pick ? { args: pick.args, started: Number.isFinite(pick.started) ? pick.started : null } : null
}

/** Cursor conversations recorded for a workspace: id → when the transcript dir was created. */
function transcriptsFor(dir: string): { id: string; born: number }[] {
  const root = join(homedir(), ".cursor", "projects", slug(dir), "agent-transcripts")
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((n) => /^[0-9a-f-]{36}$/.test(n))
    .map((id) => ({ id, born: statSync(join(root, id)).birthtimeMs }))
}

function modelFromArgs(args: string | null): string | null {
  const m = args?.match(/--model[= ]('?)([^\s']+)\1/)
  return m ? m[2] : null
}

function classify(cwd: string, command: string, args: string | null, isAgentPane: boolean, role: string | null): PaneKind {
  const a = args ?? ""
  // Judge by the program, not by words in its arguments (an agent prompt may mention cc-dash).
  const prog = basename(a.split(" ")[0] ?? "")
  const argv = a.split(" ")
  if (/^(cursor-agent|agent|claude|cursor-cli)$/.test(prog) || (isAgentPane && command === "node")) {
    return cwd === centralDir() || (role === "command-center" && isAgentPane) ? "central" : "agent"
  }
  if (argv.some((x) => /src\/dash\/index\.tsx$/.test(x) || basename(x) === "cc-dash")) return "dash"
  if (cwd === REPO && prog === "bun" && argv.some((x) => x === "start" || /src\/index\.tsx?$/.test(x))) return "tui"
  if (/^(n?vim|vi|hx|nano|emacs)$/.test(prog)) return "editor"
  if (SHELLS.has(command)) return "shell"
  return "other"
}

/** pane id → newest conversation id the hooks saw there (plus a per-dir fallback). */
function conversations(): { byPane: Map<string, { session: string; source: string }>; byDir: Map<string, { session: string; source: string }> } {
  const byPane = new Map<string, { session: string; source: string }>()
  const byDir = new Map<string, { session: string; source: string }>() // newest per dir
  const feed = statePath("agents.jsonl")
  if (!existsSync(feed)) return { byPane, byDir }
  for (const line of readFileSync(feed, "utf8").split("\n")) {
    const e = parseFeedLine(line)
    if (!e?.state || !e.session) continue
    if (e.pane) byPane.set(e.pane, { session: e.session, source: e.source })
    byDir.set(e.dir, { session: e.session, source: e.source })
  }
  return { byPane, byDir }
}

async function save(name: string, note: string | null): Promise<Snapshot> {
  const convs = conversations()
  const sessions: SessionSnap[] = []
  const sessLines = (await tmux(["list-sessions", "-F", "#{session_name}\t#{@idx}\t#{@label}\t#{session_attached}"])).trim().split("\n")
  let current: Snapshot["current"] = null
  for (const sl of sessLines.filter(Boolean)) {
    const [sname, idx, label, attached] = sl.split("\t")
    const windows: WindowSnap[] = []
    const winLines = (
      await tmux(["list-windows", "-t", sname, "-F", "#{window_index}\t#{window_name}\t#{window_layout}\t#{window_active}\t#{@cc_role}\t#{@agent_pane}"])
    )
      .trim()
      .split("\n")
    let activeWindow = 0
    for (const wl of winLines.filter(Boolean)) {
      const [windex, wname, layout, wactive, role, agentPane] = wl.split("\t")
      const panes: PaneSnap[] = []
      const paneLines = (
        await tmux(["list-panes", "-t", `${sname}:${windex}`, "-F", "#{pane_id}\t#{pane_index}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_active}\t#{pane_tty}"])
      )
        .trim()
        .split("\n")
      for (const pl of paneLines.filter(Boolean)) {
        const [pid, pindex, cwd, command, pactive, paneTty] = pl.split("\t")
        const fg = SHELLS.has(command) ? null : await foreground(paneTty)
        const args = fg?.args ?? null
        const kind = classify(cwd, command, args, agentPane === pid, role || null)
        let agent: PaneSnap["agent"] = null
        if (kind === "agent" || kind === "central") {
          const hit = convs.byPane.get(pid)
          if (hit) agent = { session: hit.session, model: modelFromArgs(args), source: hit.source }
        }
        panes.push({ id: pid, index: Number(pindex), cwd, command, args, started: fg?.started ?? null, active: pactive === "1", kind, agent })
      }
      const isProtected = panes.some((p) => p.kind === "agent" && p.cwd === REPO)
      if (wactive === "1") activeWindow = Number(windex)
      windows.push({ index: Number(windex), name: wname, layout, active: wactive === "1", role: role || null, agentPane: agentPane || null, protected: isProtected, panes })
    }
    if (attached === "1" || (attached && attached !== "0")) current = { session: sname, window: activeWindow }
    sessions.push({ name: sname, idx: idx || null, label: label || null, activeWindow, windows })
  }
  sessions.sort((a, b) => Number(a.idx ?? 999) - Number(b.idx ?? 999) || a.name.localeCompare(b.name))
  // Agents that started before the hooks recorded panes: when a directory has
  // exactly one agent pane in all of tmux, the newest conversation seen in that
  // directory is its conversation.
  const agentPanes = sessions.flatMap((s) => s.windows.flatMap((w) => w.panes.filter((p) => p.kind === "agent" || p.kind === "central")))
  const perDir = new Map<string, number>()
  for (const p of agentPanes) perDir.set(p.cwd, (perDir.get(p.cwd) ?? 0) + 1)
  for (const p of agentPanes) {
    if (p.agent || perDir.get(p.cwd) !== 1) continue
    const hit = convs.byDir.get(p.cwd)
    if (hit) p.agent = { session: hit.session, model: modelFromArgs(p.args), source: hit.source }
    else {
      // Quiet for longer than the feed remembers: the newest Cursor transcript
      // for that workspace is named after its conversation id.
      const t = findTranscript(p.cwd, undefined)
      const id = t && /agent-transcripts\/([0-9a-f-]{36})\//.exec(t)?.[1]
      if (id) p.agent = { session: id, model: modelFromArgs(p.args), source: "cursor" }
    }
  }
  // Several agents in one directory (a project's central + task windows) that
  // predate pane recording: pair each agent process with the transcript whose
  // directory was created closest to the process start (within 10 minutes).
  const unresolvedDirs = new Set(agentPanes.filter((p) => !p.agent && p.started).map((p) => p.cwd))
  for (const dir of unresolvedDirs) {
    const taken = new Set(agentPanes.filter((p) => p.cwd === dir && p.agent).map((p) => p.agent!.session))
    const free = transcriptsFor(dir).filter((t) => !taken.has(t.id))
    const pending = agentPanes.filter((p) => p.cwd === dir && !p.agent && p.started).sort((a, b) => a.started! - b.started!)
    for (const p of pending) {
      let best: { id: string; born: number } | null = null
      for (const t of free) {
        if (taken.has(t.id)) continue
        const d = Math.abs(t.born - p.started!)
        if (d <= 10 * 60_000 && (!best || d < Math.abs(best.born - p.started!))) best = t
      }
      if (!best) continue
      taken.add(best.id)
      p.agent = { session: best.id, model: modelFromArgs(p.args), source: "cursor" }
    }
  }
  const snap: Snapshot = {
    version: VERSION,
    name,
    ts: new Date().toISOString(),
    note,
    host: (await run("hostname", ["-s"])).stdout.trim(),
    current,
    sessions,
  }
  mkdirSync(SNAP_DIR, { recursive: true })
  const body = `${JSON.stringify(snap, null, 2)}\n`
  writeFileSync(join(SNAP_DIR, `${name}.json`), body)
  writeFileSync(join(SNAP_DIR, "latest.json"), body)
  return snap
}

function load(name: string): Snapshot {
  const file = name.endsWith(".json") ? name : join(SNAP_DIR, `${name}.json`)
  if (!existsSync(file)) throw new Error(`no snapshot ${name} (${file}); cc-snapshot list`)
  return JSON.parse(readFileSync(file, "utf8")) as Snapshot
}

function summarize(snap: Snapshot): string[] {
  const out: string[] = []
  const nWin = snap.sessions.reduce((n, s) => n + s.windows.length, 0)
  const nAgents = snap.sessions.reduce((n, s) => n + s.windows.reduce((m, w) => m + w.panes.filter((p) => p.agent).length, 0), 0)
  out.push(`${snap.name} — ${snap.ts}${snap.note ? ` — ${snap.note}` : ""}: ${snap.sessions.length} sessions, ${nWin} windows, ${nAgents} resumable agents`)
  for (const s of snap.sessions) {
    out.push(`  ${s.idx ?? "-"} ${s.name}`)
    for (const w of s.windows) {
      const kinds = w.panes.map((p) => (p.kind === "agent" || p.kind === "central" ? (p.agent ? `${p.kind}✓` : `${p.kind}?`) : p.kind)).join(" ")
      out.push(`      :${w.index} ${w.name}${w.protected ? " [protected]" : ""} — ${w.panes.length} panes: ${kinds}`)
    }
  }
  return out
}

/** Program to type into a restored pane, or null for a plain shell. */
function startCommand(p: PaneSnap, agentCmd: string, agents: boolean): string | null {
  switch (p.kind) {
    case "tui":
      return "bun start"
    case "dash": {
      const m = p.args?.match(/src\/dash\/index\.tsx\s+(\S+)|cc-dash\s+(\S+)/)
      const proj = m?.[1] ?? m?.[2] ?? basename(p.cwd)
      return `cc-dash ${sh(proj)}`
    }
    case "editor":
      return basename(p.args?.split(" ")[0] ?? "vim")
    case "agent":
    case "central": {
      if (!agents || !p.agent) return null
      const model = p.agent.model ? ` --model ${sh(p.agent.model)}` : ""
      return `${agentCmd}${model} --resume=${sh(p.agent.session)}`
    }
    default:
      return null
  }
}

async function restore(snap: Snapshot, opts: { dryRun: boolean; agents: boolean; only: Set<string> }): Promise<string[]> {
  const log: string[] = []
  const agentCmd = config().commands.agent
  const existing = new Set((await run("tmux", ["list-sessions", "-F", "#{session_name}"])).stdout.split("\n").filter(Boolean))
  const act = async (desc: string, args: string[]) => {
    log.push(`${opts.dryRun ? "would " : ""}${desc}`)
    if (!opts.dryRun) await tmux(args)
  }
  const keys = async (target: string, cmd: string) => {
    log.push(`${opts.dryRun ? "would " : ""}run in ${target}: ${cmd}`)
    if (!opts.dryRun) await tmux(["send-keys", "-t", target, "C-u", cmd, "Enter"])
  }

  for (const s of snap.sessions) {
    if (opts.only.size && !opts.only.has(s.name)) continue
    let sessionExists = existing.has(s.name)
    const haveWindows = new Set<string>()
    if (sessionExists) {
      for (const l of (await run("tmux", ["list-windows", "-t", s.name, "-F", "#{window_name}"])).stdout.split("\n")) if (l) haveWindows.add(l)
    }
    for (const w of s.windows) {
      if (haveWindows.has(w.name)) {
        log.push(`skip ${s.name}:${w.index} ${w.name} — already open`)
        continue
      }
      const first = w.panes[0]
      if (!first) continue
      const cwds = w.panes.map((p) => (existsSync(p.cwd) ? p.cwd : null))
      if (!cwds[0]) {
        log.push(`skip ${s.name}:${w.index} ${w.name} — ${first.cwd} no longer exists`)
        continue
      }
      let target: string
      if (!sessionExists) {
        log.push(`${opts.dryRun ? "would " : ""}create session ${s.name} with window ${w.name}`)
        const created = opts.dryRun
          ? `${s.name}:${w.index}`
          : (await tmux(["new-session", "-d", "-P", "-F", "#{session_name}:#{window_index}", "-s", s.name, "-n", w.name, "-c", cwds[0], "-x", "284", "-y", "69"])).trim()
        if (s.idx) await act(`  @idx ${s.idx}`, ["set-option", "-t", s.name, "@idx", s.idx])
        if (s.label) await act(`  @label ${s.label}`, ["set-option", "-t", s.name, "@label", s.label])
        sessionExists = true
        existing.add(s.name)
        target = created
        // The first window takes base-index; move it if the snapshot had it elsewhere.
        if (created !== `${s.name}:${w.index}`) {
          await act(`  move window to :${w.index}`, ["move-window", "-s", created, "-t", `${s.name}:${w.index}`])
          target = `${s.name}:${w.index}`
        }
      } else {
        const taken = (await run("tmux", ["list-windows", "-t", s.name, "-F", "#{window_index}"])).stdout.split("\n").includes(String(w.index))
        const where = taken ? `${s.name}:` : `${s.name}:${w.index}`
        const out = opts.dryRun ? "" : await tmux(["new-window", "-d", "-P", "-F", "#{session_name}:#{window_index}", "-t", where, "-n", w.name, "-c", cwds[0]])
        log.push(`${opts.dryRun ? "would " : ""}create window ${s.name}:${taken ? "(next)" : w.index} ${w.name}`)
        target = out.trim() || `${s.name}:${w.index}`
      }
      haveWindows.add(w.name)
      // Each split targets the previous pane so pane order equals creation order
      // (tmux inserts a new pane after its target), which is how select-layout
      // assigns cells and how the snapshot listed them.
      let prev = opts.dryRun ? target : (await tmux(["list-panes", "-t", target, "-F", "#{pane_id}"])).trim().split("\n")[0]!
      for (let i = 1; i < w.panes.length; i++) {
        log.push(`${opts.dryRun ? "would " : ""}  split pane ${i + 1}`)
        if (!opts.dryRun) prev = (await tmux(["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", prev, "-c", cwds[i] ?? cwds[0]!])).trim()
      }
      if (w.panes.length > 1) await act(`  layout ${w.layout.slice(0, 40)}…`, ["select-layout", "-t", target, w.layout])
      if (w.role) await act(`  @cc_role ${w.role}`, ["set-option", "-w", "-t", target, "@cc_role", w.role])
      // Pane ids are new; map the snapshot's agent pane by position.
      const newPanes = opts.dryRun ? w.panes.map((p) => p.id) : (await tmux(["list-panes", "-t", target, "-F", "#{pane_id}"])).trim().split("\n")
      const deferred: { paneId: string; kind: PaneKind; cmd: string }[] = []
      const rank = (k: PaneKind) => (k === "central" ? 0 : k === "agent" ? 1 : k === "tui" ? 3 : 2)
      for (let i = 0; i < w.panes.length; i++) {
        const p = w.panes[i]
        const paneId = newPanes[i]
        if (!paneId) continue
        if (w.agentPane === p.id) await act(`  @agent_pane ${paneId}`, ["set-option", "-w", "-t", target, "@agent_pane", paneId])
        if (!cwds[i]) {
          log.push(`  pane ${i + 1}: ${p.cwd} missing — left at ${cwds[0]}`)
          continue
        }
        if (w.protected && (p.kind === "agent" || p.kind === "central")) {
          log.push(`  pane ${i + 1}: dev-session agent not resumed (protected)`)
          continue
        }
        const cmd = startCommand(p, agentCmd, opts.agents)
        if (cmd) deferred.push({ paneId, kind: p.kind, cmd: `cd ${sh(cwds[i]!)} && clear && ${cmd}` })
        else if ((p.kind === "agent" || p.kind === "central") && !p.agent) log.push(`  pane ${i + 1}: agent had no known conversation id — shell`)
      }
      // Agents first, the TUI last: its start runs `cc-central ensure`, which must
      // find the central already resuming in its pane rather than a bare shell.
      deferred.sort((a, b) => rank(a.kind) - rank(b.kind))
      for (const d of deferred) {
        if (d.kind === "tui" && !opts.dryRun) await new Promise((r) => setTimeout(r, 2000))
        await keys(d.paneId, d.cmd)
      }
      if (w.active) await act(`  select window ${w.name}`, ["select-window", "-t", target])
    }
  }
  return log
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0]
  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(USAGE)
    return cmd ? 0 : 1
  }
  if (cmd === "save") {
    const noteIdx = argv.indexOf("--note")
    const note = noteIdx !== -1 ? argv[noteIdx + 1] ?? null : null
    const rest = argv.slice(1).filter((a, i, arr) => a !== "--note" && arr[i - 1] !== "--note")
    const name = (rest[0] ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)).replace(/[^\w.-]+/g, "-")
    const snap = await save(name, note)
    for (const l of summarize(snap)) console.log(l)
    console.log(`saved ${join(SNAP_DIR, `${name}.json`)} (also latest.json)`)
    return 0
  }
  if (cmd === "list") {
    if (!existsSync(SNAP_DIR)) {
      console.log("no snapshots yet — cc-snapshot save")
      return 0
    }
    const files = readdirSync(SNAP_DIR).filter((f) => f.endsWith(".json") && f !== "latest.json")
    files.sort((a, b) => statSync(join(SNAP_DIR, b)).mtimeMs - statSync(join(SNAP_DIR, a)).mtimeMs)
    for (const f of files) {
      const s = load(join(SNAP_DIR, f))
      console.log(summarize(s)[0])
    }
    return 0
  }
  if (cmd === "show") {
    for (const l of summarize(load(argv[1] ?? "latest"))) console.log(l)
    return 0
  }
  if (cmd === "restore") {
    const only = new Set<string>()
    let name = "latest"
    let dryRun = false
    let agents = true
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]
      if (a === "--dry-run") dryRun = true
      else if (a === "--no-agents") agents = false
      else if (a === "--session") only.add(argv[++i] ?? "")
      else name = a
    }
    const snap = load(name)
    console.log(summarize(snap)[0])
    for (const l of await restore(snap, { dryRun, agents, only })) console.log(l)
    return 0
  }
  console.error(USAGE)
  return 1
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`cc-snapshot: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  },
)
