import { useEffect, useRef } from "react"
import type { Todo } from "../data/todos.ts"

const C = {
  dim: "#6b7280",
  header: "#93c5fd",
  value: "#e5e7eb",
  green: "#4ade80",
  selectedBg: "#1f2937",
}

function relativeDays(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  return `${days} days ago`
}

export function Todos({
  todos,
  hiddenDoneCount,
  selected,
  adding,
  editing,
  onSubmit,
  height,
}: {
  todos: Todo[]
  /** completed todos currently hidden from the list (0 when showing all) */
  hiddenDoneCount: number
  selected: number
  adding: boolean
  /** When set, the input edits this todo instead of creating a new one. */
  editing: Todo | null
  onSubmit: (text: string) => void
  height: number
}) {
  const inputOpen = adding || editing !== null

  // The input's submit event doesn't carry the value, so track it via onInput.
  // Seed the draft when the input opens so submitting without typing keeps the text.
  const draft = useRef("")
  useEffect(() => {
    if (inputOpen) draft.current = editing?.text ?? ""
  }, [inputOpen, editing])

  const maxVisible = Math.max(1, height - (inputOpen ? 3 : 0))
  let start = 0
  if (todos.length > maxVisible) {
    start = Math.min(Math.max(0, selected - Math.floor(maxVisible / 2)), todos.length - maxVisible)
  }
  const visible = todos.slice(start, start + maxVisible)

  return (
    <box flexDirection="column">
      {inputOpen && (
        <box title={editing ? "Edit todo" : "New todo"} border borderColor={C.header} height={3} marginBottom={1}>
          <input
            key={editing?.id ?? "new"}
            value={editing?.text ?? ""}
            placeholder="What needs doing? (enter to save, esc to cancel)"
            focused
            onInput={(value: string) => {
              draft.current = value
            }}
            onSubmit={() => {
              if (draft.current.trim()) onSubmit(draft.current)
              draft.current = ""
            }}
          />
        </box>
      )}
      {visible.map((todo, i) => {
        const idx = start + i
        const isSelected = idx === selected && !inputOpen
        return (
          <box key={todo.id} backgroundColor={isSelected ? C.selectedBg : undefined}>
            <text>
              <span fg={isSelected ? "#ffffff" : todo.done ? C.dim : C.value}>
                {isSelected ? "▸" : " "}
                {todo.done ? "[✓] " : "[ ] "}
                {todo.text}
              </span>
              <span fg={C.dim}>
                {"  "}
                {todo.done && todo.completedAt ? `done ${relativeDays(todo.completedAt)}` : relativeDays(todo.createdAt)}
              </span>
            </text>
          </box>
        )
      })}
      {todos.length === 0 && !inputOpen && (
        <text fg={C.dim}>
          {hiddenDoneCount > 0 ? "no active todos — press a to add one" : "no todos — press a to add one"}
        </text>
      )}
      {hiddenDoneCount > 0 && (
        <text fg={C.dim}>{hiddenDoneCount} completed hidden — press v to show</text>
      )}
    </box>
  )
}
