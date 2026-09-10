/**
 * Headless smoke test for the agent hub (run: bun run spike/chat-smoke.ts).
 * Verifies queueing, streaming, and customTools wiring without the TUI.
 */
import { disposeAll, sendSystem } from "../src/agents/hub.ts"
import { getStore } from "../src/agents/stores.ts"

const send = (id: string, text: string) =>
  new Promise<string>((resolve) => sendSystem(id, text, resolve))

// 1. plain round trip
console.log("central says:", await send("central", "Reply with exactly the single word: OK"))

// 2. central custom tool (list_agents)
console.log(
  "central agents:",
  await send("central", "Call list_agents, then reply with only the comma-separated agent ids."),
)

// 3. specialist custom tool (list_todos on an empty snapshot)
console.log(
  "todos says:",
  await send("todos", "Call list_todos, then reply with one short line describing what it returned."),
)

console.log("central items:", getStore("central").items.length, "| todos items:", getStore("todos").items.length)
await disposeAll()
