import { useEffect, useRef } from "react"
import { FOCUS_CADENCE_MS, FOCUS_MAX, fmtMinutes, fmtNote, staleness, stalledMinutes, type Staleness, type Todo } from "../data/todos.ts"

const C = {
  dim: "#6b7280",
  header: "#93c5fd",
  value: "#e5e7eb",
  green: "#4ade80",
  yellow: "#facc15",
  red: "#f87171",
  selectedBg: "#1f2937",
}

const STALE_COLORS: Record<Staleness, string> = { fresh: C.green, due: C.yellow, stalled: C.red }

function relativeDays(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  return `${days} days ago`
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  for (const raw of text.split("\n")) {
    let line = ""
    for (const word of raw.split(" ")) {
      if (!line) line = word
      else if (line.length + 1 + word.length <= width) line += ` ${word}`
      else {
        lines.push(line)
        line = word
      }
    }
    lines.push(line)
  }
  return lines
}

/** Max rendered lines for the selected todo's notes panel. */
const NOTES_LINES = 6

export type TodoInputMode = { kind: "add" } | { kind: "edit"; todo: Todo } | { kind: "note"; todo: Todo }

export function Todos({
  todos,
  hiddenDoneCount,
  selected,
  input,
  onSubmit,
  width,
  height,
}: {
  /** display order: focus, pending, (completed) */
  todos: Todo[]
  /** completed todos currently hidden from the list (0 when showing all) */
  hiddenDoneCount: number
  selected: number
  /** open text input, if any */
  input: TodoInputMode | null
  onSubmit: (text: string) => void
  width: number
  height: number
}) {
  const inputOpen = input !== null

  // The input's submit event doesn't carry the value, so track it via onInput.
  // Seed the draft when the input opens so submitting without typing keeps the text.
  const draft = useRef("")
  useEffect(() => {
    if (input) draft.current = input.kind === "edit" ? input.todo.text : ""
  }, [input])

  const now = Date.now()
  const selectedTodo = inputOpen ? null : todos[selected]
  const noteLines = selectedTodo
    ? [...selectedTodo.notes]
        .reverse()
        .flatMap((n) => wrap(fmtNote(n), Math.max(20, width - 4)))
        .slice(0, NOTES_LINES)
    : []
  const hiddenNotes = selectedTodo ? Math.max(0, selectedTodo.notes.length - noteLines.length) : 0

  const focusCount = todos.filter((t) => t.focus && !t.done).length
  const firstNonFocus = todos.findIndex((t) => !(t.focus && !t.done))
  // Section headers take a line each: FOCUS (always), TODOS (when both sections exist).
  const headerLines = 1 + (focusCount > 0 && firstNonFocus >= 0 ? 1 : 0) + (focusCount > FOCUS_MAX ? 1 : 0)
  const maxVisible = Math.max(1, height - (inputOpen ? 3 : 0) - headerLines - (noteLines.length ? noteLines.length + 1 : 0))
  let start = 0
  if (todos.length > maxVisible) {
    start = Math.min(Math.max(0, selected - Math.floor(maxVisible / 2)), todos.length - maxVisible)
  }
  const visible = todos.slice(start, start + maxVisible)

  const inputTitle =
    input?.kind === "note" ? `Add note — ${input.todo.text}` : input?.kind === "edit" ? "Edit todo" : "New todo"
  const inputPlaceholder =
    input?.kind === "note"
      ? "What moved? (enter to add a timestamped note, esc to cancel)"
      : "What needs doing? (enter to save, esc to cancel)"

  return (
    <box flexDirection="column">
      {input && (
        <box title={inputTitle} border borderColor={C.header} height={3} marginBottom={1}>
          <input
            key={input.kind === "add" ? "new" : `${input.kind}-${input.todo.id}`}
            value={input.kind === "edit" ? input.todo.text : ""}
            placeholder={inputPlaceholder}
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
      {start === 0 && (
        <text>
          <span fg={C.header}>FOCUS</span>
          <span fg={C.dim}>
            {focusCount
              ? `  ${focusCount} in motion — checked every ${fmtMinutes(FOCUS_CADENCE_MS / 60_000)}`
              : "  none — press f on a todo to keep it moving today"}
          </span>
        </text>
      )}
      {focusCount > FOCUS_MAX && start === 0 && (
        <text fg={C.yellow}>  {focusCount} focus todos — more than {FOCUS_MAX} dilutes the point</text>
      )}
      {visible.map((todo, i) => {
        const idx = start + i
        const isSelected = idx === selected && !inputOpen
        const isFocus = todo.focus && !todo.done
        const stale = isFocus ? staleness(todo, now) : null
        const last = todo.notes[todo.notes.length - 1]
        return (
          <box key={todo.id} flexDirection="column">
            {idx === firstNonFocus && focusCount > 0 && (
              <text>
                <span fg={C.header}>{"\nTODOS"}</span>
              </text>
            )}
            <box backgroundColor={isSelected ? C.selectedBg : undefined}>
              <text>
                <span fg={isSelected ? "#ffffff" : todo.done ? C.dim : C.value}>
                  {isSelected ? "▸" : " "}
                  {todo.done ? "[✓] " : isFocus ? "[◆] " : "[ ] "}
                  {todo.text}
                </span>
                {todo.notes.length > 0 && <span fg={C.header}> ≡{todo.notes.length}</span>}
                {isFocus && stale ? (
                  <span fg={STALE_COLORS[stale]}>
                    {"  "}
                    {stale === "fresh" ? "moving" : stale === "due" ? "due" : "stalled"} · last progress {fmtMinutes(stalledMinutes(todo, now))} ago
                  </span>
                ) : (
                  <span fg={C.dim}>
                    {"  "}
                    {todo.done && todo.completedAt ? `done ${relativeDays(todo.completedAt)}` : relativeDays(todo.createdAt)}
                  </span>
                )}
                {isFocus && last && <span fg={C.dim}>{`  ${last.text.length > 50 ? `${last.text.slice(0, 49)}…` : last.text}`}</span>}
              </text>
            </box>
          </box>
        )
      })}
      {todos.length === 0 && !inputOpen && (
        <text fg={C.dim}>
          {hiddenDoneCount > 0 ? "no active todos — press a to add one" : "no todos — press a to add one"}
        </text>
      )}
      {hiddenDoneCount > 0 && <text fg={C.dim}>{hiddenDoneCount} completed hidden — press v to show</text>}
      {noteLines.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <text fg={C.header}>
            notes{hiddenNotes > 0 ? <span fg={C.dim}>{`  (+${hiddenNotes} older — N for all)`}</span> : null}
          </text>
          {noteLines.map((line, i) => (
            <text key={i} fg={C.dim}>
              {"  "}
              {line || " "}
            </text>
          ))}
        </box>
      )}
    </box>
  )
}
