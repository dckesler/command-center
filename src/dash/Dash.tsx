import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { watch } from "node:fs"
import { join } from "node:path"
import { statePath } from "../config.ts"
import { run } from "../data/exec.ts"
import { isMailStuck, mailWaitMinutes, type PendingMail } from "../data/mail.ts"
import type { ProjectTask } from "../data/projects.ts"
import { jumpToWindow } from "../data/tmux.ts"
import type { MrExtras, TicketInfo } from "../types.ts"
import type { DashSnapshot, DashSource, NeedsYou } from "./snapshot.ts"

const C = {
  dim: "#6b7280",
  header: "#93c5fd",
  key: "#a78bfa",
  value: "#e5e7eb",
  green: "#4ade80",
  yellow: "#facc15",
  red: "#f87171",
  gray: "#9ca3af",
  selectedBg: "#1f2937",
}

const STATUS_COLORS: Record<string, string> = { active: C.green, paused: C.yellow, done: C.dim, unknown: C.gray }
const AGENT_COLORS: Record<string, string> = { working: C.yellow, attention: C.red, idle: C.green, start: C.gray, ended: C.dim }
const SEVERITY_COLORS: Record<string, string> = { info: C.gray, warn: C.yellow, attention: C.red }

const GAP = 2
function fit(s: string, w: number): string {
  const usable = Math.max(1, w - GAP)
  if (s.length > usable) return (s.slice(0, usable - 1) + "…").padEnd(w)
  return s.padEnd(w)
}

function wrap(text: string, width: number, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ""
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
      if (lines.length === max) break
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line && lines.length < max) lines.push(line)
  if (lines.length === max && words.join(" ").length > lines.join(" ").length) {
    lines[max - 1] = `${lines[max - 1].slice(0, Math.max(0, width - 1))}…`
  }
  return lines
}

function relative(iso: string, now = Date.now()): string {
  if (!iso) return ""
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** HH:MM today, otherwise MM-DD. */
function clock(iso: string, now = Date.now()): string {
  if (!iso) return "--:--"
  const d = new Date(iso)
  if (d.toDateString() === new Date(now).toDateString()) return d.toTimeString().slice(0, 5)
  return d.toISOString().slice(5, 10)
}

/** Markdown → plain text for one-line display: links to their text, no emphasis or code marks. */
function plain(md: string): string {
  return md
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

function ticketColor(t: TicketInfo): string {
  if (t.statusCategory === "Done") return C.green
  if (t.statusCategory === "In Progress") return C.yellow
  if (t.status === "Blocked") return C.red
  return C.value
}

/** Short Jira status: "In Code Review" → "Review", "In Progress" → "Prog". */
function shortStatus(s: string): string {
  const map: Record<string, string> = {
    "in progress": "Prog",
    "in code review": "Review",
    "code review": "Review",
    "in review": "Review",
    "awaiting review": "Review",
    "ready for deployment": "Deploy",
    "ready for qa": "QA",
    "in qa": "QA",
    "to do": "Todo",
    backlog: "Backlog",
    done: "Done",
    closed: "Done",
    blocked: "Blocked",
  }
  return map[s.toLowerCase()] ?? s.slice(0, 7)
}

const PIPE: Record<string, [string, string]> = {
  success: ["✓", C.green],
  failed: ["✗", C.red],
  running: ["⟳", C.yellow],
  pending: ["…", C.yellow],
  canceled: ["⊘", C.gray],
  skipped: ["–", C.gray],
}

function mrCell(t: ProjectTask, extras: Map<number, MrExtras>): { text: string; color: string } {
  const mr = t.mr
  if (!mr) return { text: "-", color: C.dim }
  if (mr.state === "merged") return { text: `!${mr.iid} merged`, color: C.green }
  if (mr.state === "closed") return { text: `!${mr.iid} closed`, color: C.dim }
  const pipe = mr.pipelineStatus ? PIPE[mr.pipelineStatus] ?? [mr.pipelineStatus.slice(0, 3), C.gray] : null
  const ex = extras.get(mr.iid)
  const parts = [`!${mr.iid}`]
  if (mr.draft) parts.push("draft")
  if (pipe) parts.push(`${pipe[0]}ci`)
  if (ex) {
    if (ex.approvalsRequired > 0) parts.push(`${ex.approvalsRequired - ex.approvalsLeft}/${ex.approvalsRequired}`)
    if (ex.unresolvedThreads > 0) parts.push(`${ex.unresolvedThreads}th`)
  }
  let color = C.value
  if (mr.hasConflicts || mr.pipelineStatus === "failed") color = C.red
  else if (mr.detailedMergeStatus === "mergeable") color = C.green
  else if (ex && ex.unresolvedThreads > 0) color = C.yellow
  return { text: parts.join(" "), color }
}

const mailTag = (m: PendingMail) => (isMailStuck(m) ? `✉${m.count} ${mailWaitMinutes(m)}m ` : `✉${m.count} `)

function windowIndex(target: string): string {
  return target.split(":").pop() ?? ""
}

// ---------------------------------------------------------------------------

export function Dash({ source }: { source: DashSource }) {
  const { width, height } = useTerminalDimensions()
  const [snap, setSnap] = useState<DashSnapshot | null>(null)
  const [selected, setSelected] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refreshFast = useCallback(async () => {
    try {
      setSnap(await source.fast())
    } catch (err) {
      console.error("fast refresh failed", err)
    }
  }, [source])

  const refreshSlow = useCallback(async () => {
    try {
      await source.slow()
      setSnap(await source.fast())
    } catch (err) {
      console.error("slow refresh failed", err)
    }
  }, [source])

  // Coalesce bursts of file events into one refresh.
  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void refreshFast(), 300)
  }, [refreshFast])

  useEffect(() => {
    void refreshFast().then(() => refreshSlow())
    const fast = setInterval(() => void refreshFast(), 5_000)
    const slow = setInterval(() => void refreshSlow(), 60_000)
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    const watchers: ReturnType<typeof watch>[] = []
    const tryWatch = (path: string) => {
      try {
        watchers.push(watch(path, schedule))
      } catch {
        // path may not exist yet (no .cc until the first report); the 5 s poll covers it
      }
    }
    tryWatch(join(source.dir, "PROJECT.md"))
    tryWatch(join(source.dir, ".cc"))
    tryWatch(statePath("agents.jsonl"))
    tryWatch(statePath("mail"))
    return () => {
      clearInterval(fast)
      clearInterval(slow)
      clearInterval(tick)
      for (const w of watchers) w.close()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [source, refreshFast, refreshSlow, schedule])

  // Selectable rows: needs-you entries first, then every task tab.
  const needs = snap?.needsYou ?? []
  const tasks = snap?.tasks ?? []
  const selectable: { task: ProjectTask | null }[] = [...needs.map((n) => ({ task: n.task })), ...tasks.map((t) => ({ task: t }))]
  const count = selectable.length
  const sel = Math.min(selected, Math.max(0, count - 1))
  const central = tasks.find((t) => t.role === "central") ?? null
  const targetOf = (task: ProjectTask | null) => (task ?? central)?.target ?? null

  useKeyboard((key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) process.exit(0)
    if (key.name === "j" || key.name === "down") setSelected(Math.min(count - 1, sel + 1))
    if (key.name === "k" || key.name === "up") setSelected(Math.max(0, sel - 1))
    if (key.name === "g") setSelected(0)
    if (key.name === "G") setSelected(Math.max(0, count - 1))
    if (key.name === "r") {
      setMessage("refreshing…")
      void refreshSlow().then(() => setMessage(null))
    }
    const task = selectable[sel]?.task ?? null
    if (key.name === "return") {
      const target = targetOf(task)
      if (target) void jumpToWindow(target)
    }
    if (key.name === "o") {
      const t = task ?? central
      if (t?.mr) void run("open", [t.mr.url])
      else setMessage("no MR on this row")
    }
    if (key.name === "t") {
      const t = task ?? central
      if (t?.ticket) void run("open", [t.ticket.url])
      else setMessage("no ticket on this row")
    }
    if (key.name === "p") void run("open", [join(source.dir, "PROJECT.md")])
  })

  useEffect(() => {
    if (!message || message === "refreshing…") return
    const id = setTimeout(() => setMessage(null), 2_500)
    return () => clearTimeout(id)
  }, [message])

  if (!snap) return <text fg={C.dim}> loading {source.name}…</text>

  const { project, extras, reports, epic } = snap
  const brief = project.brief
  const textWidth = Math.max(20, width - 2)

  // --- header ---------------------------------------------------------------
  const header: ReactNode[] = []
  const centralAgent = central?.agent ?? project.agent
  header.push(
    <text key="title">
      <span fg={C.key}>{project.name}</span>
      <span fg={brief ? STATUS_COLORS[brief.status] : C.red}>{`  ${brief ? brief.status : "no PROJECT.md"}`}</span>
      <span fg={C.dim}>{brief?.updated ? `  updated ${brief.updated}` : ""}</span>
      {epic && (
        <>
          <span fg={C.dim}>{"  epic "}</span>
          <span fg={C.key}>{epic.key}</span>
          <span fg={epic.ticket ? ticketColor(epic.ticket) : C.dim}>{epic.ticket ? ` ${shortStatus(epic.ticket.status)}` : ""}</span>
          <span fg={C.dim}>
            {epic.children ? ` ${epic.children.filter((c) => c.statusCategory === "Done").length}/${epic.children.length}` : ""}
          </span>
        </>
      )}
      <span fg={C.dim}>{"  central "}</span>
      <span fg={centralAgent ? AGENT_COLORS[centralAgent.state] ?? C.gray : C.dim}>{centralAgent?.state ?? "none"}</span>
      {central?.mail && <span fg={isMailStuck(central.mail) ? C.red : C.yellow}>{` ${mailTag(central.mail).trim()}`}</span>}
    </text>,
  )
  if (brief?.goal) for (const line of wrap(`Goal: ${plain(brief.goal)}`, textWidth, 2)) header.push(<text key={`g${header.length}`} fg={C.gray}>{line}</text>)
  if (brief?.currentState) for (const line of wrap(`Now:  ${plain(brief.currentState)}`, textWidth, 3)) header.push(<text key={`s${header.length}`} fg={C.value}>{line}</text>)

  // --- column widths --------------------------------------------------------
  const cols = { idx: 3, tab: Math.min(26, Math.max(14, Math.floor(width * 0.22))), ticket: 17, mr: 17, agent: 9 }
  const showTicket = width >= 90
  const showMr = width >= 70
  const fixed = cols.idx + cols.tab + (showTicket ? cols.ticket : 0) + (showMr ? cols.mr : 0) + cols.agent
  const reportWidth = Math.max(8, width - fixed - 3 - 1) // 3 = selector gutter

  // --- budget ---------------------------------------------------------------
  const needsLines = needs.length ? needs.length + 1 : 0
  const stepsAll = brief?.nextSteps ?? []
  const stepsBudget = stepsAll.length ? Math.min(stepsAll.length, 4) + 2 : 0
  const recentBudget = reports.length ? Math.min(reports.length, 6) + 2 : 0
  const footer = 1
  const tableRows = Math.max(1, height - header.length - needsLines - 2 - stepsBudget - recentBudget - footer)
  let start = 0
  const taskSel = sel - needs.length // index into tasks when a task row is selected
  if (tasks.length > tableRows && taskSel >= 0) {
    start = Math.min(Math.max(0, taskSel - Math.floor(tableRows / 2)), tasks.length - tableRows)
  }
  const visible = tasks.slice(start, start + tableRows)
  const recent = reports.slice(-Math.max(1, recentBudget - 2)).reverse()

  return (
    <box flexDirection="column" height={height}>
      {header}
      {needs.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <text fg={C.red}>{`NEEDS YOU (${needs.length})`}</text>
          {needs.map((n, i) => {
            const isSel = i === sel
            const task = n.task
            const label = task ? task.name : n.label ?? "central"
            const idx = task ? windowIndex(task.target) : n.label ? "" : central ? windowIndex(central.target) : ""
            const tail = ` ${clock(n.since, now)} · ${relative(n.since, now)}`
            return (
              <box key={`n${i}`} backgroundColor={isSel ? C.selectedBg : undefined}>
                <text>
                  <span fg={isSel ? "#ffffff" : C.red}>{isSel ? "▸! " : " ! "}</span>
                  <span fg={C.dim}>{fit(idx, cols.idx)}</span>
                  <span fg={C.value}>{fit(label, cols.tab)}</span>
                  <span fg={n.reason === "mail" ? C.yellow : C.red}>{fit(n.text, Math.max(8, width - 3 - cols.idx - cols.tab - tail.length))}</span>
                  <span fg={C.dim}>{tail}</span>
                </text>
              </box>
            )
          })}
        </box>
      )}
      <text> </text>
      <text>
        <span fg={C.header}>
          {"   "}
          {fit("#", cols.idx)}
          {fit("TAB", cols.tab)}
          {showTicket ? fit("TICKET", cols.ticket) : ""}
          {showMr ? fit("MR", cols.mr) : ""}
          {fit("AGENT", cols.agent)}
          {fit("LAST REPORT", reportWidth)}
        </span>
      </text>
      {snap.tasks === null && <text fg={C.dim}>  session not running</text>}
      {snap.tasks && snap.tasks.length === 0 && <text fg={C.dim}>  session has no windows</text>}
      {visible.map((t, i) => {
        const idx = start + i
        const isSel = idx + needs.length === sel
        const ticket = t.ticketKey ? `${t.ticketKey}${t.ticket ? ` ${shortStatus(t.ticket.status)}` : ""}` : "-"
        const mr = mrCell(t, extras)
        const report = t.lastReport ? `${t.lastReport.text}` : "-"
        const age = t.lastReport ? ` ${relative(t.lastReport.ts, now)}` : ""
        const dimRow = !t.agent || t.agent.state === "ended"
        return (
          <box key={t.target} backgroundColor={isSel ? C.selectedBg : undefined}>
            <text>
              <span fg={isSel ? "#ffffff" : C.dim}>{isSel ? " ▸ " : "   "}</span>
              <span fg={C.dim}>{fit(windowIndex(t.target), cols.idx)}</span>
              <span fg={isSel ? "#ffffff" : t.role === "central" ? C.key : dimRow ? C.gray : C.value}>
                {fit(t.role === "central" ? "central" : t.name, cols.tab)}
              </span>
              {showTicket && <span fg={t.ticket ? ticketColor(t.ticket) : t.ticketKey ? C.value : C.dim}>{fit(ticket, cols.ticket)}</span>}
              {showMr && <span fg={mr.color}>{fit(mr.text, cols.mr)}</span>}
              <span fg={t.agent ? AGENT_COLORS[t.agent.state] ?? C.gray : C.dim}>
                {fit(t.agent?.state ?? "-", t.mail ? cols.agent - mailTag(t.mail).length : cols.agent)}
              </span>
              {t.mail && <span fg={isMailStuck(t.mail) ? C.red : C.yellow}>{mailTag(t.mail)}</span>}
              <span fg={t.lastReport ? SEVERITY_COLORS[t.lastReport.severity] : C.dim}>{fit(report, reportWidth - age.length)}</span>
              <span fg={C.dim}>{age}</span>
            </text>
          </box>
        )
      })}
      {stepsAll.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <text fg={C.header}>{`NEXT STEPS${brief && brief.doneSteps ? `  (${brief.doneSteps} done)` : ""}`}</text>
          {stepsAll.slice(0, 4).map((step, i) => (
            <text key={i} fg={C.value}>
              {"  ☐ "}
              {fit(plain(step), textWidth - 4)}
            </text>
          ))}
          {stepsAll.length > 4 && <text fg={C.dim}>{`  … ${stepsAll.length - 4} more in PROJECT.md`}</text>}
        </box>
      )}
      {recent.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <text fg={C.header}>RECENT</text>
          {recent.map((r, i) => (
            <text key={i}>
              <span fg={C.dim}>{`  ${clock(r.ts, now)} `}</span>
              <span fg={SEVERITY_COLORS[r.severity]}>{r.severity === "attention" ? "! " : "  "}</span>
              <span fg={C.gray}>{fit(r.text, Math.max(10, textWidth - 10))}</span>
            </text>
          ))}
        </box>
      )}
      <box flexGrow={1} />
      <text>
        <span fg={message ? C.yellow : C.dim}>
          {message ?? "enter jump  o MR  t ticket  p PROJECT.md  r refresh  q quit"}
        </span>
        <span fg={C.dim}>{`   jira/gitlab ${snap.slowAt ? (relative(new Date(snap.slowAt).toISOString(), now) === "now" ? "just now" : relative(new Date(snap.slowAt).toISOString(), now) + " ago") : "loading…"}`}</span>
      </text>
    </box>
  )
}
