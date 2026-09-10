import { homedir } from "node:os"
import { Agent, CursorAgentError } from "@cursor/sdk"

/**
 * Embedded chat backed by a local Cursor SDK agent.
 *
 * The agent runs with cwd = $HOME and settingSources ["user"] so it loads
 * ~/.cursor/mcp.json (reusing the saved Atlassian OAuth login, which is stored
 * per project directory — the home project is the one that's authenticated)
 * and the user-level skills (jira-ticket etc).
 *
 * State lives at module level so the conversation survives tab switches; the
 * Chat component subscribes for re-renders.
 */

const MODEL = "composer-2.5"

export type ChatRole = "user" | "assistant" | "tool" | "error" | "info"

export interface ChatItem {
  role: ChatRole
  text: string
}

export interface ChatState {
  items: ChatItem[]
  busy: boolean
}

export const chatState: ChatState = { items: [], busy: false }

type Listener = () => void
const listeners = new Set<Listener>()

export function subscribeChat(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit() {
  for (const listener of listeners) listener()
}

type SdkAgent = Awaited<ReturnType<typeof Agent.create>>
let agent: SdkAgent | null = null

async function getAgent(): Promise<SdkAgent> {
  if (agent) return agent
  const apiKey = process.env.CURSOR_API_KEY
  if (!apiKey) {
    throw new Error("CURSOR_API_KEY is not set — export it before launching the control center")
  }
  agent = await Agent.create({
    apiKey,
    model: { id: MODEL },
    local: { cwd: homedir(), settingSources: ["user"] },
  })
  return agent
}

/** Send a message and stream the reply into chatState. No-op while busy. */
export async function sendChat(text: string): Promise<void> {
  if (chatState.busy || !text.trim()) return
  chatState.busy = true
  chatState.items.push({ role: "user", text: text.trim() })
  emit()

  // Whether the last item is an assistant bubble we're still appending to.
  // A tool call closes the bubble so the next text starts a fresh one.
  let assistantOpen = false
  const seenCalls = new Set<string>()

  try {
    const a = await getAgent()
    const run = await a.send(text)
    for await (const event of run.stream()) {
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type !== "text" || !block.text) continue
          if (assistantOpen) {
            chatState.items[chatState.items.length - 1].text += block.text
          } else {
            chatState.items.push({ role: "assistant", text: block.text })
            assistantOpen = true
          }
        }
        emit()
      } else if (event.type === "tool_call") {
        if (!seenCalls.has(event.call_id)) {
          seenCalls.add(event.call_id)
          chatState.items.push({ role: "tool", text: `⚙ ${event.name}` })
          assistantOpen = false
          emit()
        } else if (event.status === "error") {
          const item = chatState.items.find((i) => i.role === "tool" && i.text === `⚙ ${event.name}`)
          if (item) item.text = `⚙ ${event.name} — failed`
          emit()
        }
      }
    }
    const result = await run.wait()
    if (result.status !== "finished") {
      chatState.items.push({ role: "error", text: `run ended: ${result.status}` })
    }
  } catch (err) {
    // A startup failure means the agent handle is unusable — drop it so the
    // next send retries from scratch.
    if (err instanceof CursorAgentError) agent = null
    chatState.items.push({ role: "error", text: err instanceof Error ? err.message : String(err) })
  } finally {
    chatState.busy = false
    emit()
  }
}

/** Drop the conversation and dispose the agent; the next send starts fresh. */
export function newChat(): void {
  const old = agent
  agent = null
  chatState.items = []
  chatState.busy = false
  emit()
  old?.[Symbol.asyncDispose]().catch(() => {})
}

/** Best-effort cleanup on quit (bounded by the caller's timeout). */
export async function disposeChat(): Promise<void> {
  const old = agent
  agent = null
  if (old) await old[Symbol.asyncDispose]().catch(() => {})
}
