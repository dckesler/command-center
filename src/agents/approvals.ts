// Human-in-the-loop gate for specialist tools that change state outside this
// laptop (Jira transitions, cloud agents). A gated tool does not act: it
// queues an approval here and returns immediately. The TUI shows the queue
// (`!`), and only Daniel's keypress runs the action. The outcome goes back to
// the requesting specialist as an event, so it can report to central.
import { pushEvent } from "./events.ts"

export interface PendingApproval {
  id: string
  /** specialist id that asked, e.g. "tickets" */
  agent: string
  /** one line: what will happen */
  title: string
  /** extra context lines shown in the confirm dialog */
  detail: string[]
  createdAt: number
  run: () => Promise<string>
}

const pending: PendingApproval[] = []
const listeners = new Set<() => void>()
let seq = 0

function notify(): void {
  for (const fn of listeners) fn()
}

export function listApprovals(): PendingApproval[] {
  return pending.slice()
}

export function onApprovalsChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * Queue an action for Daniel. Returns the string the tool should hand back to
 * the model: it says the action is waiting, not done, and not to retry.
 */
export function requestApproval(req: Omit<PendingApproval, "id" | "createdAt">): string {
  seq += 1
  const id = `a${seq}`
  pending.push({ ...req, id, createdAt: Date.now() })
  notify()
  return (
    `queued for Daniel's approval (#${id}): ${req.title}. Nothing has changed yet — it runs only when he approves it in the TUI ` +
    "(and he may decline). Do not call this tool again for the same action; you will receive an event with the outcome."
  )
}

/** Daniel decided. Runs the action on approve; tells the requesting specialist either way. */
export async function decideApproval(id: string, approve: boolean): Promise<string> {
  const idx = pending.findIndex((p) => p.id === id)
  if (idx < 0) return `approval #${id} no longer pending`
  const [item] = pending.splice(idx, 1)
  notify()
  if (!approve) {
    pushEvent(item.agent, `Daniel declined: ${item.title} — do not retry; ask him in chat if it still matters`, "info")
    return `declined: ${item.title}`
  }
  let result: string
  try {
    result = await item.run()
  } catch (e) {
    result = `failed: ${e instanceof Error ? e.message : String(e)}`
  }
  pushEvent(item.agent, `Daniel approved: ${item.title} → ${result}`, "info")
  return result
}
