/**
 * cc-todo — the todo list from the command line, for the tmux central agent
 * (the embedded central had list_todos / focus_todos / add_todo_note /
 * set_focus as SDK tools; this is the same surface). Notes are authored as
 * "central". The TUI watches todos.json, so changes show up there at once.
 *
 *   bun run src/cli/todo.ts <command> …   (wrapped by skills/cc-todo/cc-todo)
 */
import {
  addTodo,
  addTodoNote,
  FOCUS_CADENCE_MS,
  FOCUS_MAX,
  fmtMinutes,
  fmtTodo,
  loadTodos,
  setFocus,
  sortTodos,
  stalledMinutes,
  toggleTodo,
  type Todo,
} from "../data/todos.ts"

const USAGE = `usage:
  cc-todo list [--all]                 todos: focus first, then pending (--all adds completed); ids, staleness, newest notes
  cc-todo focus                        the focus set with minutes since each one's last progress note
  cc-todo note <id|text> <text…>       append a progress note (resets the focus cadence clock)
  cc-todo note --checkin <id|text> <text…>   append a check-in note (asked, nothing new; defers the next check)
  cc-todo focus <id|text> on|off       put a todo into / take it out of the focus set
  cc-todo add [--focus] <text…>        add a todo
  cc-todo done <id|text>               toggle a todo done/undone
<id|text> is the id from list, a unique id prefix, or the exact todo text.`

function fail(msg: string): never {
  process.stderr.write(`cc-todo: ${msg}\n`)
  process.exit(1)
}

function find(todos: Todo[], ref: string): Todo {
  const lower = ref.toLowerCase()
  const exact = todos.find((t) => t.id === ref || t.text.toLowerCase() === lower)
  if (exact) return exact
  const prefix = todos.filter((t) => t.id.startsWith(ref))
  if (prefix.length === 1) return prefix[0]
  if (prefix.length > 1) fail(`"${ref}" matches ${prefix.length} todos — use a longer id`)
  fail(`no todo "${ref}"`)
}

const [command, ...rest] = process.argv.slice(2)
const flags = new Set(rest.filter((a) => a.startsWith("--")))
const args = rest.filter((a) => !a.startsWith("--"))
const todos = sortTodos(loadTodos())
const now = Date.now()

switch (command) {
  case "list": {
    const shown = flags.has("--all") ? todos : todos.filter((t) => !t.done)
    const hidden = todos.length - shown.length
    console.log(shown.length ? shown.map((t) => fmtTodo(t, 3, now)).join("\n") : "no todos")
    if (hidden && !flags.has("--all")) console.log(`(${hidden} completed hidden — --all shows them)`)
    break
  }
  case "focus": {
    if (args.length === 0) {
      const focus = todos.filter((t) => t.focus && !t.done)
      console.log(
        focus.length
          ? `focus cadence ${fmtMinutes(FOCUS_CADENCE_MS / 60_000)}, soft cap ${FOCUS_MAX}\n${focus.map((t) => `${fmtTodo(t, 5, now)}\n    stalled ${stalledMinutes(t, now)}m`).join("\n")}`
          : "no focus todos set",
      )
      break
    }
    const [ref, state] = args
    if (state !== "on" && state !== "off") fail("focus <id|text> on|off")
    const todo = find(todos, ref)
    if (todo.done) fail(`"${todo.text}" is completed — reopen it first (cc-todo done)`)
    const others = todos.filter((t) => t.focus && !t.done && t.id !== todo.id).length
    setFocus(todos, todo.id, state === "on")
    console.log(
      state === "on"
        ? `focus on: ${todo.text}${others + 1 > FOCUS_MAX ? ` — ${others + 1} focus todos now, above the soft cap of ${FOCUS_MAX}` : ""}`
        : `focus off: ${todo.text}`,
    )
    break
  }
  case "note": {
    const kind = flags.has("--checkin") ? "checkin" : "progress"
    const [ref, ...words] = args
    const text = words.join(" ").trim()
    if (!ref || !text) fail("note [--checkin] <id|text> <text…>")
    const todo = find(todos, ref)
    addTodoNote(todos, todo.id, text, "central", kind)
    console.log(`${kind} note on "${todo.text}": ${text}`)
    break
  }
  case "add": {
    const text = args.join(" ").trim()
    if (!text) fail("add [--focus] <text…>")
    let next = addTodo(todos, text)
    if (flags.has("--focus")) next = setFocus(next, next[0].id, true)
    console.log(`added ${next[0].id}: ${text}${flags.has("--focus") ? " (focus)" : ""}`)
    break
  }
  case "done": {
    const [ref] = args
    if (!ref) fail("done <id|text>")
    const todo = find(todos, ref)
    toggleTodo(todos, todo.id)
    console.log(`${todo.done ? "reopened" : "completed"}: ${todo.text}`)
    break
  }
  case undefined:
  case "-h":
  case "--help":
  case "help":
    console.log(USAGE)
    break
  default:
    fail(`unknown command "${command}"\n${USAGE}`)
}
