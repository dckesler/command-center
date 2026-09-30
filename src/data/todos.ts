import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { config, statePath } from "../config.ts"

/** Who wrote a note: the user in the TUI, the todos specialist, or the central agent. */
export type NoteAuthor = "user" | "todos" | "central"

/**
 * A timestamped note on a todo. `progress` notes are real movement and reset a
 * focus todo's cadence clock; `checkin` notes record that someone asked and
 * there was nothing new — they defer the next ping but the todo stays stalled.
 */
export interface TodoNote {
  ts: string
  text: string
  by: NoteAuthor
  kind: "progress" | "checkin"
}

export interface Todo {
  id: string
  text: string
  done: boolean
  createdAt: string
  completedAt?: string
  /** in today's focus set: expected to keep moving through the day */
  focus?: boolean
  focusedAt?: string
  /** append-only log, oldest first */
  notes: TodoNote[]
}

/** On-disk shape, including the pre-focus format (`notes` was a single string). */
type StoredTodo = Omit<Todo, "notes"> & { notes?: string | TodoNote[] }

const TODOS_PATH = statePath("todos.json")

function migrate(t: StoredTodo): Todo {
  const notes: TodoNote[] = Array.isArray(t.notes)
    ? t.notes
    : typeof t.notes === "string" && t.notes.trim()
      ? [{ ts: t.createdAt, text: t.notes.trim(), by: "user", kind: "progress" }]
      : []
  return { ...t, notes }
}

export function loadTodos(): Todo[] {
  if (!existsSync(TODOS_PATH)) return []
  try {
    return (JSON.parse(readFileSync(TODOS_PATH, "utf8")) as StoredTodo[]).map(migrate)
  } catch {
    return []
  }
}

function saveTodos(todos: Todo[]): void {
  mkdirSync(dirname(TODOS_PATH), { recursive: true })
  writeFileSync(TODOS_PATH, JSON.stringify(todos, null, 2) + "\n")
}

export function addTodo(todos: Todo[], text: string): Todo[] {
  const next: Todo[] = [
    { id: crypto.randomUUID(), text: text.trim(), done: false, createdAt: new Date().toISOString(), notes: [] },
    ...todos,
  ]
  saveTodos(next)
  return next
}

export function editTodo(todos: Todo[], id: string, text: string): Todo[] {
  const next = todos.map((t) => (t.id === id ? { ...t, text: text.trim() } : t))
  saveTodos(next)
  return next
}

/** Completing a todo also drops it from the focus set. */
export function toggleTodo(todos: Todo[], id: string): Todo[] {
  const next = todos.map((t) =>
    t.id === id
      ? t.done
        ? { ...t, done: false, completedAt: undefined }
        : { ...t, done: true, completedAt: new Date().toISOString(), focus: false }
      : t,
  )
  saveTodos(next)
  return next
}

export function setFocus(todos: Todo[], id: string, focus: boolean): Todo[] {
  const next = todos.map((t) =>
    t.id === id ? { ...t, focus, focusedAt: focus ? (t.focus ? t.focusedAt : new Date().toISOString()) : undefined } : t,
  )
  saveTodos(next)
  return next
}

export function addTodoNote(
  todos: Todo[],
  id: string,
  text: string,
  by: NoteAuthor = "user",
  kind: TodoNote["kind"] = "progress",
): Todo[] {
  const trimmed = text.replace(/\s+/g, " ").trim()
  if (!trimmed) return todos
  const note: TodoNote = { ts: new Date().toISOString(), text: trimmed, by, kind }
  const next = todos.map((t) => (t.id === id ? { ...t, notes: [...t.notes, note] } : t))
  saveTodos(next)
  return next
}

export function removeTodoNote(todos: Todo[], id: string, ts: string): Todo[] {
  const next = todos.map((t) => (t.id === id ? { ...t, notes: t.notes.filter((n) => n.ts !== ts) } : t))
  saveTodos(next)
  return next
}

export function removeTodo(todos: Todo[], id: string): Todo[] {
  const next = todos.filter((t) => t.id !== id)
  saveTodos(next)
  return next
}

/** Focus first (oldest progress first, so the most stalled is on top), then pending (newest first), then completed. */
export function sortTodos(todos: Todo[]): Todo[] {
  const focus = todos.filter((t) => !t.done && t.focus)
  focus.sort((a, b) => lastProgressAt(a) - lastProgressAt(b))
  const pending = todos.filter((t) => !t.done && !t.focus)
  const done = todos.filter((t) => t.done)
  done.sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
  return [...focus, ...pending, ...done]
}

// ---------------------------------------------------------------------------
// focus cadence

export const FOCUS_CADENCE_MS = config().todos.focusCadenceMinutes * 60_000
export const FOCUS_MAX = config().todos.focusMax

/** Epoch ms of the newest progress note, else when the todo became focus, else creation. */
export function lastProgressAt(t: Todo): number {
  const progress = t.notes.filter((n) => n.kind === "progress")
  const last = progress[progress.length - 1]
  return new Date(last?.ts ?? t.focusedAt ?? t.createdAt).getTime()
}

/** Epoch ms of the newest check-in note, or 0. */
export function lastCheckInAt(t: Todo): number {
  const checkins = t.notes.filter((n) => n.kind === "checkin")
  const last = checkins[checkins.length - 1]
  return last ? new Date(last.ts).getTime() : 0
}

/** Time since the last progress note, in whole minutes. */
export function stalledMinutes(t: Todo, now = Date.now()): number {
  return Math.max(0, Math.floor((now - lastProgressAt(t)) / 60_000))
}

export type Staleness = "fresh" | "due" | "stalled"

/** fresh: inside one cadence; due: past one; stalled: past two (or never moved since focus). */
export function staleness(t: Todo, now = Date.now()): Staleness {
  const age = now - lastProgressAt(t)
  if (age < FOCUS_CADENCE_MS) return "fresh"
  if (age < 2 * FOCUS_CADENCE_MS) return "due"
  return "stalled"
}

/** Whether the focus engine may ping right now: configured hours, weekdays. */
export function inFocusHours(now = new Date()): boolean {
  const day = now.getDay()
  if (day === 0 || day === 6) return false
  const [start, end] = config().todos.focusHours.split("-")
  const minutes = now.getHours() * 60 + now.getMinutes()
  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number)
    return h * 60 + m
  }
  return minutes >= toMin(start) && minutes < toMin(end)
}

export function fmtMinutes(min: number): string {
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`
}

function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
}

function fmtDay(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return ""
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} `
}

/** "09:42 central: merged the MR" (with a date prefix when not today). */
export function fmtNote(n: TodoNote): string {
  return `${fmtDay(n.ts)}${fmtClock(n.ts)} ${n.by}${n.kind === "checkin" ? " (check-in)" : ""}: ${n.text}`
}

/** One line per todo for the specialist: flags, staleness for focus items, and the newest notes. */
export function fmtTodo(t: Todo, notesShown = 3, now = Date.now()): string {
  const head = `${t.done ? "[x]" : t.focus ? "[F]" : "[ ]"} id=${t.id} ${t.text}`
  const focus = t.focus && !t.done ? ` — focus, ${staleness(t, now)}, last progress ${fmtMinutes(stalledMinutes(t, now))} ago` : ""
  const notes = t.notes.slice(-notesShown).map((n) => `\n    ${fmtNote(n)}`)
  const more = t.notes.length > notesShown ? `\n    (+${t.notes.length - notesShown} earlier notes)` : ""
  return `${head}${focus}${notes.join("")}${more}`
}

/** Progress notes written today, for the end-of-day recap. */
export function notesToday(t: Todo, now = new Date()): TodoNote[] {
  const day = now.toDateString()
  return t.notes.filter((n) => new Date(n.ts).toDateString() === day)
}
