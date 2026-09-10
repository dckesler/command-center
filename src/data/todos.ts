import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface Todo {
  id: string
  text: string
  done: boolean
  createdAt: string
  completedAt?: string
}

const TODOS_PATH = join(homedir(), ".config", "control-center", "todos.json")

export function loadTodos(): Todo[] {
  if (!existsSync(TODOS_PATH)) return []
  try {
    return JSON.parse(readFileSync(TODOS_PATH, "utf8")) as Todo[]
  } catch {
    return []
  }
}

function saveTodos(todos: Todo[]): void {
  mkdirSync(dirname(TODOS_PATH), { recursive: true })
  writeFileSync(TODOS_PATH, JSON.stringify(todos, null, 2) + "\n")
}

export function addTodo(todos: Todo[], text: string): Todo[] {
  const next = [
    { id: crypto.randomUUID(), text: text.trim(), done: false, createdAt: new Date().toISOString() },
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

export function toggleTodo(todos: Todo[], id: string): Todo[] {
  const next = todos.map((t) =>
    t.id === id
      ? { ...t, done: !t.done, completedAt: !t.done ? new Date().toISOString() : undefined }
      : t,
  )
  saveTodos(next)
  return next
}

export function removeTodo(todos: Todo[], id: string): Todo[] {
  const next = todos.filter((t) => t.id !== id)
  saveTodos(next)
  return next
}

/** Pending first (newest first), then completed (most recently completed first). */
export function sortTodos(todos: Todo[]): Todo[] {
  const pending = todos.filter((t) => !t.done)
  const done = todos.filter((t) => t.done)
  done.sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
  return [...pending, ...done]
}
