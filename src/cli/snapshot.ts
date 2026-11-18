/**
 * cc-snapshot / cc-restore — save the live Command Center (every tmux session,
 * window, pane, and the agent conversation running in each pane) to a file,
 * and rebuild it later: same sessions and windows, same layouts, each agent
 * resumed in its pane with `--resume=<conversation id>`, the client attached.
 *
 * What is captured per pane: cwd, the program in the foreground (from the
 * pane's tty), and — for agent panes — the conversation id the hooks recorded
 * for that pane (agents.jsonl state events carry `pane`). The window's agent
 * pane (`@agent_pane`) counts as an agent pane even when the agent has
 * already exited (a finished task worker), so its conversation can be
 * revived; the launcher's exact command (`@agent_cmd`, set by mkpanes,
 * start-project and project-task) is kept so an agent with no recoverable
 * conversation can be relaunched with its original prompt.
 *
 * Per session: which ~/projects project it is (start-project sessions). Per
 * window: which project task tab it is (project-task windows). Plus the hub
 * specialists' SDK agent ids (hub-agents.json) so the TUI resumes them too.
 *
 * Durable state (todos, inbox, mailboxes, LOG.md) is already on disk and is
 * not part of a snapshot.
 *
 *   bun run src/cli/snapshot.ts save [name] [--note "…"]
 *   bun run src/cli/snapshot.ts list | show [name]
 *   bun run src/cli/snapshot.ts restore [name] [--dry-run] [--no-agents] [--revive] [--no-fresh] [--no-attach]
 *                                       [--session <name>]… [--project <name>]…
 */
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config, statePath } from "../config.ts"
import { findTranscript, parseFeedLine, slug } from "../data/agents.ts"
import { homedir } from "node:os"
import { centralDir } from "../data/central.ts"
import { run } from "../data/exec.ts"
import { HUB_AGENTS_FILE, readSavedHubAgents, type SavedHubAgents } from "../data/hubAgents.ts"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const SNAP_DIR = statePath("snapshots")
const VERSION = 2

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
  /** false for the window's agent pane when no agent process was running there (the worker had finished or quit) */
  live: boolean
  /** cursor-cli conversation to resume, when the hooks tied one to this pane */
  agent: { session: string; model: string | null; source: string } | null
}

interface TaskSnap {
  /** window name (the task title, possibly with " (branch)") */
  title: string
  project: string
  ticket: string | null
  /** the worker prompt project-task wrote, when it still exists */
  promptFile: string | null
  /** true when the tab works in a git worktree rather than the project directory */
  worktree: boolean
}

interface WindowSnap {
  index: number
  name: string
  layout: string
  active: boolean
  role: string | null
  agentPane: string | null
  /** the exact command the launcher typed into the agent pane (@agent_cmd), for a fresh relaunch */
  agentCmd: string | null
  /** project-task tab details (role "task") */
  task: TaskSnap | null
  /** the Command Center dev session — restored as shells only, never an agent */
  protected: boolean
  panes: PaneSnap[]
}

interface SessionSnap {
  name: string
  idx: string | null
  label: string | null
  activeWindow: number
  /** the ~/projects project this session belongs to (start-project sessions) */
  project: { name: string; dir: string } | null
  windows: WindowSnap[]
}

interface Snapshot {
  version: number
  name: string
  ts: string
  note: string | null
  host: string
  current: { session: string; window: number } | null
  /** hub specialists' SDK agent ids at save time (the TUI resumes them on start) */
  hub: SavedHubAgents | null
  sessions: SessionSnap[]
}

interface RestoreOptions {
  dryRun: boolean
  /** resume/relaunch agents at all (--no-agents: shells) */
  agents: boolean
  /** also bring back agents that had already exited at save time (--revive) */
  revive: boolean
  /** relaunch an agent from its recorded command when its conversation cannot be resumed (--no-fresh to disable) */
  fresh: boolean
  /** attach / switch the client to the saved current session afterwards (--no-attach to skip) */
  attach: boolean
  only: Set<string>
}

const USAGE = `usage:
  cc-snapshot save [name] [--note "…"]   save every tmux session/window/pane + agent conversation ids (default name: timestamp; also "latest")
  cc-snapshot list                        saved snapshots
  cc-snapshot show [name]                 what a snapshot would restore (default: latest)
  cc-restore [name] [--dry-run] [--no-agents] [--revive] [--no-fresh] [--no-attach] [--session <name>]… [--project <name>]…
                                          rebuild missing sessions/windows from a snapshot (default: latest); existing windows are left alone;
                                          agents resume their conversations in place, then the client attaches to the saved current session.
                                          --revive: also resume agents that had exited at save time; --no-fresh: never relaunch an agent from
                                          its recorded command when its conversation is unknown; --no-agents: shells only`

const SHELLS = new Set(["zsh", "bash", "sh", "fish", "-zsh", "-bash", "login"])

async function tmux(args: string[]): Promise<string> {
  const res = await run("tmux", args)
  if (!res.ok) throw new Error(`tmux ${args.join(" ")}: ${res.stderr.trim() || "failed"}`)
  return res.stdout
}

function sh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** start-project / project-task name sessions after the project, with ':' and '.' flattened. */
function sessionNameFor(project: string): string {
  return project.replace(/[:.]/g, "-")
}

function taskSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
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

function isAgentKind(k: PaneKind): boolean {
  return k === "agent" || k === "central"
}

/** The ~/projects project a session belongs to, judged by its name and a `central` window inside the project dir. */
function projectFor(sname: string, windows: WindowSnap[]): SessionSnap["project"] {
  const projects = config().dirs.projects
  const central = windows.find((w) => w.role === "central")
  if (!central?.panes[0]) return null
  const dir = central.panes[0].cwd
  if (!dir.startsWith(`${projects}/`)) return null
  const name = dir.slice(projects.length + 1).split("/")[0]
  if (!name || sessionNameFor(name) !== sname) return null
  return { name, dir: join(projects, name) }
}

function taskFor(wname: string, role: string | null, ccProject: string | null, firstCwd: string | undefined): TaskSnap | null {
  if (role !== "task" || !ccProject) return null
  const projectDir = join(config().dirs.projects, ccProject)
  // project-task appends " (branch)" to the title when the branch is not already in it; the prompt file is named after the title alone.
  const bare = wname.replace(/ \([^)]*\)$/, "")
  const candidates = [taskSlug(bare), taskSlug(wname)].map((s) => join(projectDir, ".cc", "tasks", `${s}.txt`))
  const promptFile = candidates.find((f) => existsSync(f)) ?? null
  const ticket = /\b([A-Z][A-Z0-9]+-\d+)\b/.exec(wname)?.[1] ?? null
  const worktree = !!firstCwd && !firstCwd.startsWith(`${projectDir}/`) && firstCwd !== projectDir
  return { title: wname, project: ccProject, ticket, promptFile, worktree }
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
      await tmux([
        "list-windows",
        "-t",
        sname,
        "-F",
        "#{window_index}\t#{window_name}\t#{window_layout}\t#{window_active}\t#{@cc_role}\t#{@agent_pane}\t#{@cc_project}\t#{@agent_cmd}",
      ])
    )
      .trim()
      .split("\n")
    let activeWindow = 0
    for (const wl of winLines.filter(Boolean)) {
      const [windex, wname, layout, wactive, role, agentPane, ccProject, agentCmd] = wl.split("\t")
      const panes: PaneSnap[] = []
      const paneLines = (
        await tmux(["list-panes", "-t", `${sname}:${windex}`, "-F", "#{pane_id}\t#{pane_index}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_active}\t#{pane_tty}"])
      )
        .trim()
        .split("\n")
      for (const pl of paneLines.filter(Boolean)) {
        const [pid, pindex, cwd, command, pactive, paneTty] = pl.split("\t")
        const isAgentPane = agentPane === pid
        const fg = SHELLS.has(command) ? null : await foreground(paneTty)
        const args = fg?.args ?? null
        let kind = classify(cwd, command, args, isAgentPane, role || null)
        let live = true
        // The launcher's agent pane with a bare shell in it: the agent has exited
        // (a finished worker, a quit central). Still an agent pane — its
        // conversation can be revived and its command relaunched.
        if (isAgentPane && kind === "shell") {
          kind = role === "command-center" ? "central" : "agent"
          live = false
        }
        let agent: PaneSnap["agent"] = null
        if (isAgentKind(kind)) {
          const hit = convs.byPane.get(pid)
          if (hit) agent = { session: hit.session, model: modelFromArgs(args), source: hit.source }
        }
        panes.push({ id: pid, index: Number(pindex), cwd, command, args, started: fg?.started ?? null, active: pactive === "1", kind, live, agent })
      }
      const isProtected = panes.some((p) => p.kind === "agent" && p.cwd === REPO)
      if (wactive === "1") activeWindow = Number(windex)
      windows.push({
        index: Number(windex),
        name: wname,
        layout,
        active: wactive === "1",
        role: role || null,
        agentPane: agentPane || null,
        agentCmd: agentCmd || null,
        task: taskFor(wname, role || null, ccProject || null, panes[0]?.cwd),
        protected: isProtected,
        panes,
      })
    }
    if (attached === "1" || (attached && attached !== "0")) current = { session: sname, window: activeWindow }
    sessions.push({ name: sname, idx: idx || null, label: label || null, activeWindow, project: projectFor(sname, windows), windows })
  }
  sessions.sort((a, b) => Number(a.idx ?? 999) - Number(b.idx ?? 999) || a.name.localeCompare(b.name))
  // Agents that started before the hooks recorded panes: when a directory has
  // exactly one agent pane in all of tmux, the newest conversation seen in that
  // directory is its conversation.
  const agentPanes = sessions.flatMap((s) => s.windows.flatMap((w) => w.panes.filter((p) => isAgentKind(p.kind))))
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
  const hub = readSavedHubAgents()
  const snap: Snapshot = {
    version: VERSION,
    name,
    ts: new Date().toISOString(),
    note,
    host: (await run("hostname", ["-s"])).stdout.trim(),
    current,
    hub: Object.keys(hub).length ? hub : null,
    sessions,
  }
  mkdirSync(SNAP_DIR, { recursive: true })
  const body = `${JSON.stringify(snap, null, 2)}\n`
  writeFileSync(join(SNAP_DIR, `${name}.json`), body)
  writeFileSync(join(SNAP_DIR, "latest.json"), body)
  return snap
}

/** Read a snapshot; v1 files get the v2 fields filled with their defaults. */
function load(name: string): Snapshot {
  const file = name.endsWith(".json") ? name : join(SNAP_DIR, `${name}.json`)
  if (!existsSync(file)) throw new Error(`no snapshot ${name} (${file}); cc-snapshot list`)
  const raw = JSON.parse(readFileSync(file, "utf8")) as Snapshot
  raw.hub ??= null
  for (const s of raw.sessions) {
    s.project ??= null
    for (const w of s.windows) {
      w.agentCmd ??= null
      w.task ??= null
      for (const p of w.panes) p.live ??= true
    }
  }
  return raw
}

function paneGlyph(p: PaneSnap, w: WindowSnap, s: SessionSnap): string {
  if (!isAgentKind(p.kind)) return p.kind
  const idle = p.live ? "" : "(idle)"
  if (p.agent) return `${p.kind}✓${idle}`
  if (relaunchCommand(w, s, "")) return `${p.kind}↻${idle}` // no conversation, but relaunchable with its prompt
  return `${p.kind}?${idle}`
}

function summarize(snap: Snapshot): string[] {
  const out: string[] = []
  const nWin = snap.sessions.reduce((n, s) => n + s.windows.length, 0)
  const allAgents = snap.sessions.flatMap((s) => s.windows.flatMap((w) => w.panes.filter((p) => isAgentKind(p.kind))))
  const nLive = allAgents.filter((p) => p.agent && p.live).length
  const nIdle = allAgents.filter((p) => p.agent && !p.live).length
  const nProjects = snap.sessions.filter((s) => s.project).length
  const hub = snap.hub ? Object.keys(snap.hub).length : 0
  out.push(
    `${snap.name} — ${snap.ts}${snap.note ? ` — ${snap.note}` : ""}: ${snap.sessions.length} sessions (${nProjects} projects), ${nWin} windows, ` +
      `${nLive} resumable agents${nIdle ? ` + ${nIdle} idle (--revive)` : ""}${hub ? `, ${hub} hub specialists` : ""}`,
  )
  for (const s of snap.sessions) {
    out.push(`  ${s.idx ?? "-"} ${s.name}${s.project ? ` — project ${s.project.dir.replace(homedir(), "~")}` : ""}`)
    for (const w of s.windows) {
      const kinds = w.panes.map((p) => paneGlyph(p, w, s)).join(" ")
      const task = w.task ? ` — task${w.task.ticket ? ` ${w.task.ticket}` : ""}${w.task.worktree ? " (worktree)" : ""}` : ""
      out.push(`      :${w.index} ${w.name}${w.protected ? " [protected]" : ""} — ${w.panes.length} panes: ${kinds}${task}`)
    }
  }
  if (snap.hub) out.push(`  hub specialists: ${Object.keys(snap.hub).join(" ")}`)
  return out
}

/**
 * The command that starts this window's agent afresh: the launcher's recorded
 * command (a started ticket is resumed, not started again), or — for windows
 * from before launchers recorded it — rebuilt from the prompt file on disk.
 */
function relaunchCommand(w: WindowSnap, s: SessionSnap, agentCmd: string): string | null {
  if (w.agentCmd) return w.agentCmd.replace(/\/start-ticket (\S+)( --no-format)?/, "/resume-ticket $1")
  if (w.task?.promptFile) return `${agentCmd} "$(cat ${sh(w.task.promptFile)})"`
  if (w.role === "central" && s.project) {
    const prompt = join(s.project.dir, ".cc", "central-prompt.txt")
    if (!existsSync(prompt)) return null
    const model = config().commands.projectModel
    return `${agentCmd}${model ? ` --model ${sh(model)}` : ""} "$(cat ${sh(prompt)})"`
  }
  return null
}

/** Program to type into a restored pane, or null for a plain shell (with a reason for the log). */
function startCommand(p: PaneSnap, w: WindowSnap, s: SessionSnap, agentCmd: string, opts: RestoreOptions): { cmd: string | null; note?: string } {
  switch (p.kind) {
    case "tui":
      return { cmd: "bun start" }
    case "dash": {
      const m = p.args?.match(/src\/dash\/index\.tsx\s+(\S+)|cc-dash\s+(\S+)/)
      const proj = m?.[1] ?? m?.[2] ?? basename(p.cwd)
      return { cmd: `cc-dash ${sh(proj)}` }
    }
    case "editor":
      return { cmd: basename(p.args?.split(" ")[0] ?? "vim") }
    case "agent":
    case "central": {
      if (!opts.agents) return { cmd: null }
      if (!p.live && !opts.revive) return { cmd: null, note: "agent had exited at save time — shell (--revive brings it back)" }
      if (p.agent) {
        const model = p.agent.model ? ` --model ${sh(p.agent.model)}` : ""
        return { cmd: `${agentCmd}${model} --resume=${sh(p.agent.session)}` }
      }
      const relaunch = relaunchCommand(w, s, agentCmd)
      if (opts.fresh && relaunch) return { cmd: relaunch, note: "no known conversation — relaunched with its original prompt" }
      return { cmd: null, note: relaunch ? `no known conversation — shell (relaunch: ${relaunch})` : "no known conversation or launch command — shell" }
    }
    default:
      return { cmd: null }
  }
}

/** `nvm use && <install>` for a fresh worktree checkout without node_modules (what mkpanes does on creation). */
function installCommand(dir: string): string | null {
  if (!existsSync(join(dir, "package.json")) || existsSync(join(dir, "node_modules"))) return null
  if (/_review_deps_/.test(basename(dir))) return null // the dependency reviewer installs with a frozen lockfile itself
  const install = existsSync(join(dir, "pnpm-lock.yaml")) ? "pnpm install" : existsSync(join(dir, "yarn.lock")) ? "yarn" : "npm install"
  return `nvm use && ${install}`
}

async function restore(snap: Snapshot, opts: RestoreOptions): Promise<string[]> {
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
        log.push(`skip ${s.name}:${w.index} ${w.name} — ${first.cwd} no longer exists${w.task?.worktree ? " (worktree wrapped up)" : ""}`)
        continue
      }
      let target: string
      if (!sessionExists) {
        log.push(`${opts.dryRun ? "would " : ""}create session ${s.name}${s.project ? ` (project ${s.project.name})` : ""} with window ${w.name}`)
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
      if (w.task) await act(`  @cc_project ${w.task.project}`, ["set-option", "-w", "-t", target, "@cc_project", w.task.project])
      if (w.agentCmd) await act(`  @agent_cmd (kept for relaunch)`, ["set-option", "-w", "-t", target, "@agent_cmd", w.agentCmd])
      // Pane ids are new; map the snapshot's agent pane by position.
      const newPanes = opts.dryRun ? w.panes.map((p) => p.id) : (await tmux(["list-panes", "-t", target, "-F", "#{pane_id}"])).trim().split("\n")
      const deferred: { paneId: string; kind: PaneKind; cmd: string }[] = []
      const rank = (k: PaneKind) => (k === "central" ? 0 : k === "agent" ? 1 : k === "tui" ? 3 : 2)
      let installPane: string | null = null
      for (let i = 0; i < w.panes.length; i++) {
        const p = w.panes[i]
        const paneId = newPanes[i]
        if (!paneId) continue
        if (w.agentPane === p.id) await act(`  @agent_pane ${paneId}`, ["set-option", "-w", "-t", target, "@agent_pane", paneId])
        if (!cwds[i]) {
          log.push(`  pane ${i + 1}: ${p.cwd} missing — left at ${cwds[0]}`)
          continue
        }
        if (w.protected && isAgentKind(p.kind)) {
          log.push(`  pane ${i + 1}: dev-session agent not resumed (protected)`)
          continue
        }
        const { cmd, note } = startCommand(p, w, s, agentCmd, opts)
        if (note) log.push(`  pane ${i + 1}: ${note}`)
        if (cmd) deferred.push({ paneId, kind: p.kind, cmd: `cd ${sh(cwds[i]!)} && clear && ${cmd}` })
        // mkpanes runs the dependency install in pane 3 of a worktree window; a
        // checkout restored without node_modules gets the same.
        else if (i === 2 && p.kind === "shell" && !installPane) installPane = paneId
      }
      if (installPane) {
        const install = installCommand(cwds[0])
        if (install) deferred.push({ paneId: installPane, kind: "shell", cmd: `cd ${sh(cwds[0])} && ${install}` })
      }
      // Agents first, the TUI last: its start runs `cc-central ensure`, which must
      // find the central already resuming in its pane rather than a bare shell.
      deferred.sort((a, b) => rank(a.kind) - rank(b.kind))
      for (const d of deferred) {
        if (d.kind === "tui") {
          // The TUI resumes the hub specialists from hub-agents.json; put the
          // snapshot's ids there first so an older snapshot brings back its own.
          if (snap.hub) {
            log.push(`${opts.dryRun ? "would " : ""}  write ${Object.keys(snap.hub).length} hub specialist ids to ${HUB_AGENTS_FILE}`)
            if (!opts.dryRun) writeFileSync(HUB_AGENTS_FILE, `${JSON.stringify(snap.hub, null, 2)}\n`)
          }
          if (!opts.dryRun) await new Promise((r) => setTimeout(r, 2000))
        }
        await keys(d.paneId, d.cmd)
      }
      if (w.active) await act(`  select window ${w.name}`, ["select-window", "-t", target])
    }
  }
  return log
}

/** Bring the saved current session on screen: switch the client when inside tmux, attach when on a terminal. */
async function attach(snap: Snapshot, opts: RestoreOptions): Promise<string | null> {
  const target = snap.current?.session ?? snap.sessions[0]?.name
  if (!target) return null
  if (opts.only.size && !opts.only.has(target)) return null
  if (opts.dryRun) return `would attach to session ${target}`
  const have = (await run("tmux", ["list-sessions", "-F", "#{session_name}"])).stdout.split("\n").includes(target)
  if (!have) return `session ${target} did not come back — nothing to attach to`
  if (process.env.TMUX) {
    const res = await run("tmux", ["switch-client", "-t", target])
    return res.ok ? `switched to session ${target}` : `could not switch client: ${res.stderr.trim()}`
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) return `attach with: tmux attach -t ${sh(target)}`
  await new Promise<void>((done) => spawn("tmux", ["attach-session", "-t", target], { stdio: "inherit" }).on("exit", () => done()))
  return null
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
    const opts: RestoreOptions = { dryRun: false, agents: true, revive: false, fresh: true, attach: true, only: new Set<string>() }
    let name = "latest"
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]
      if (a === "--dry-run") opts.dryRun = true
      else if (a === "--no-agents") opts.agents = false
      else if (a === "--revive") opts.revive = true
      else if (a === "--no-fresh") opts.fresh = false
      else if (a === "--no-attach") opts.attach = false
      else if (a === "--session") opts.only.add(argv[++i] ?? "")
      else if (a === "--project") opts.only.add(sessionNameFor(argv[++i] ?? ""))
      else if (a.startsWith("-")) throw new Error(`unknown option ${a}\n${USAGE}`)
      else name = a
    }
    const snap = load(name)
    console.log(summarize(snap)[0])
    for (const l of await restore(snap, opts)) console.log(l)
    if (opts.attach) {
      const msg = await attach(snap, opts)
      if (msg) console.log(msg)
    }
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
