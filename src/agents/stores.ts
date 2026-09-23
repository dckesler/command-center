/**
 * Per-agent chat UI state. Module-level so conversations survive tab
 * switches; a single listener set covers all stores (any change re-renders
 * subscribed components, which is cheap in a TUI).
 */

export type ChatRole = "user" | "assistant" | "tool" | "error" | "info"

export interface ChatItem {
  role: ChatRole
  text: string
  ts?: number
  /** render hint: a recognised `/skill` invocation */
  accent?: "skill"
}

export interface ChatStore {
  items: ChatItem[]
  busy: boolean
  /** undelivered activity while the user is on another tab */
  unread: boolean
  /** Unsent input text. Kept per agent so tab switches don't share a prompt. */
  draft: string
}

const stores = new Map<string, ChatStore>()
const listeners = new Set<() => void>()

export function getStore(id: string): ChatStore {
  let store = stores.get(id)
  if (!store) {
    store = { items: [], busy: false, unread: false, draft: "" }
    stores.set(id, store)
  }
  return store
}

export function subscribeAgents(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitAgents(): void {
  for (const listener of listeners) listener()
}

export function resetStore(id: string): void {
  const store = getStore(id)
  store.items = []
  store.busy = false
  store.unread = false
  store.draft = ""
  emitAgents()
}
