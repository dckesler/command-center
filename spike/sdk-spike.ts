/**
 * SDK spike for the embedded chat pane (run: bun run spike/sdk-spike.ts).
 *
 * Verifies, in order:
 *   1. auth      — CURSOR_API_KEY works (model list)
 *   2. local run — a local agent executes on Bun and returns a result
 *   3. mcp       — a local agent can call the hosted Atlassian MCP server
 *                  (read-only Jira fetch), reusing the Cursor app's saved
 *                  OAuth login; also logs every tool call it makes so we can
 *                  see whether anything runs without an approval gate.
 */
import { Agent, Cursor, CursorAgentError } from "@cursor/sdk"

const apiKey = process.env.CURSOR_API_KEY
if (!apiKey) {
  console.error("FAIL auth — CURSOR_API_KEY is not set (mint one: cursor.com/dashboard → Integrations)")
  process.exit(1)
}

const MODEL = "composer-2.5"

// --- 1. auth ---------------------------------------------------------------
try {
  const models = await Cursor.models.list({ apiKey })
  const ids = models.map((m) => m.id)
  console.log(`PASS auth — ${ids.length} models visible${ids.includes(MODEL) ? ` (incl. ${MODEL})` : ""}`)
} catch (err) {
  console.error(`FAIL auth — ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}

// --- 2. local run ------------------------------------------------------------
try {
  const result = await Agent.prompt("Reply with exactly the single word: OK", {
    apiKey,
    model: { id: MODEL },
    local: { cwd: process.cwd() },
  })
  console.log(`${result.status === "finished" ? "PASS" : "FAIL"} local run — status=${result.status} result=${JSON.stringify(result.result).slice(0, 120)}`)
} catch (err) {
  if (err instanceof CursorAgentError) {
    console.error(`FAIL local run — startup error: ${err.message} (retryable=${err.isRetryable})`)
  } else {
    console.error(`FAIL local run — ${err instanceof Error ? err.message : err}`)
  }
  process.exit(1)
}

// --- 3. Atlassian MCP (read-only) -------------------------------------------
// No inline mcpServers: an inline definition gets its own credential identity
// ("inline:Atlassian") which is never OAuth'd. Instead, load the user-level
// ~/.cursor/mcp.json via settingSources so the agent reuses the saved OAuth
// login (per-project: cursor-agent mcp login Atlassian, run from the cwd).
await using agent = await Agent.create({
  apiKey,
  model: { id: MODEL },
  local: { cwd: process.cwd(), settingSources: ["user"] },
})

const run = await agent.send(
  "Using the Atlassian MCP tools, fetch Jira issue LW-17444 and reply with one line: " +
    "its key, status, and summary. Read-only: do not create, edit, or transition anything.",
)

const toolCalls: string[] = []
for await (const event of run.stream()) {
  if (event.type === "tool_call") {
    const name = (event as { name?: string; tool?: string }).name ?? (event as { tool?: string }).tool ?? "unknown"
    if (!toolCalls.includes(name)) toolCalls.push(name)
  }
}
const result = await run.wait()
console.log(`${result.status === "finished" ? "PASS" : "FAIL"} mcp — status=${result.status}`)
console.log(`  tool calls observed: ${toolCalls.length ? toolCalls.join(", ") : "(none captured)"}`)
console.log(`  final: ${JSON.stringify(result.result).slice(0, 300)}`)
