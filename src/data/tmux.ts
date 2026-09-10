import { homedir } from "node:os"
import { join } from "node:path"
import { run } from "./exec.ts"

const MKPANES = join(homedir(), ".local", "bin", "mkpanes")

export interface TmuxWindow {
  target: string // session:index
  name: string
}

export async function listTmuxWindows(): Promise<TmuxWindow[]> {
  const res = await run("tmux", [
    "list-windows", "-a", "-F", "#{session_name}:#{window_index}\t#{window_name}",
  ])
  if (!res.ok) return []
  return res.stdout
    .split("\n")
    .filter((l) => l.includes("\t"))
    .map((l) => {
      const [target, ...rest] = l.split("\t")
      return { target, name: rest.join("\t") }
    })
}

/**
 * Session that new work windows should land in: the session this TUI runs in,
 * or the most recently active attached session when running outside tmux.
 */
export async function targetSession(): Promise<string | null> {
  if (process.env.TMUX) {
    const res = await run("tmux", ["display-message", "-p", "#{session_name}"])
    if (res.ok) return res.stdout.trim()
  }
  const res = await run("tmux", [
    "list-sessions", "-F", "#{session_attached}\t#{session_activity}\t#{session_name}",
  ])
  if (!res.ok) return null
  const sessions = res.stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const [attached, activity, ...name] = l.split("\t")
      return { attached: attached !== "0", activity: Number(activity), name: name.join("\t") }
    })
    .sort((a, b) => Number(b.attached) - Number(a.attached) || b.activity - a.activity)
  return sessions[0]?.name ?? null
}

export async function jumpToWindow(target: string): Promise<boolean> {
  const res = await run("tmux", ["select-window", "-t", target])
  return res.ok
}

export async function killWindow(target: string): Promise<boolean> {
  const res = await run("tmux", ["kill-window", "-t", target])
  return res.ok
}

/** Run mkpanes with the given args, appending `-s <session>` unless already present. */
export async function runMkpanes(
  args: string[],
  session: string | null,
): Promise<{ ok: boolean; message: string }> {
  const finalArgs = [...args]
  if (session && !args.includes("-s")) finalArgs.push("-s", session)
  const res = await run(MKPANES, finalArgs, { timeoutMs: 120_000 })
  return {
    ok: res.ok,
    message: res.ok
      ? `mkpanes ${args.join(" ")} — window created`
      : res.stderr.trim() || "mkpanes failed",
  }
}

/** Launch a work window for a branch via mkpanes (which handles the worktree + panes). */
export async function launchWork(
  repoAlias: string,
  branch: string,
  session: string | null,
  extraArgs: string[] = [],
): Promise<{ ok: boolean; message: string }> {
  const result = await runMkpanes([repoAlias, "-w", branch, ...extraArgs], session)
  return { ...result, message: result.ok ? `launched ${branch} in tmux` : result.message }
}

export function createTicketPrompt(parentEpic?: { key: string; summary: string }): string {
  const parentPart = parentEpic
    ? `The parent epic is already decided: ${parentEpic.key} (${parentEpic.summary}). ` +
      "Set it as the ticket's parent and do not ask me about the parent. Then gather"
    : "First ask me which parent epic this belongs under, then gather"
  return (
    "Create a new Jira ticket using the jira-ticket skill. " +
    parentPart +
    " the platform, type, and remaining details from me before creating anything. " +
    "When the ticket is created, tell me the ticket key so I can start it from my control center."
  )
}

/**
 * Open a tmux window running cursor-cli with a ticket-creation prompt.
 * The AI gathers epic/platform/type conversationally via the jira-ticket skill;
 * when `parentEpic` is given (projects view) the parent question is skipped.
 * tmux makes the new window active, so the user lands in the conversation.
 */
export async function openTicketCreator(
  session: string | null,
  parentEpic?: { key: string; summary: string },
): Promise<{ ok: boolean; message: string }> {
  const args = ["new-window", "-P", "-F", "#{session_name}:#{window_index}"]
  if (session) args.push("-t", `${session}:`)
  args.push("-n", "new ticket", "-c", homedir())
  const created = await run("tmux", args)
  if (!created.ok) {
    return { ok: false, message: created.stderr.trim() || "tmux new-window failed" }
  }
  const target = created.stdout.trim()
  // send-keys types into an interactive zsh, so the cursor-cli alias resolves.
  await run("tmux", ["send-keys", "-t", target, `cursor-cli ${JSON.stringify(createTicketPrompt(parentEpic))}`, "Enter"])
  return { ok: true, message: `ticket creator opened in ${target} — refresh (r) when done` }
}

/**
 * Open a tmux window running cursor-cli with the finalize-epic skill, epic
 * pre-supplied (the skill's only required input — everything else it gathers
 * interactively: MCP checks, TestRail destination, per-AC answers).
 */
export async function openFinalizeEpic(
  session: string | null,
  epic: { key: string; summary: string },
): Promise<{ ok: boolean; message: string }> {
  const args = ["new-window", "-P", "-F", "#{session_name}:#{window_index}"]
  if (session) args.push("-t", `${session}:`)
  args.push("-n", `FINALIZE ${epic.key}`, "-c", homedir())
  const created = await run("tmux", args)
  if (!created.ok) {
    return { ok: false, message: created.stderr.trim() || "tmux new-window failed" }
  }
  const target = created.stdout.trim()
  const prompt =
    "Run the finalize-epic skill. " +
    `The epic we are finalizing is ${epic.key} (${epic.summary}) — use that as the answer to ` +
    '"Which Epic are we finalizing?" and do not ask me for it. ' +
    "Start with the skill's MCP detection step and then walk me through the acceptance criteria interactively."
  // send-keys types into an interactive zsh, so the cursor-cli alias resolves.
  await run("tmux", ["send-keys", "-t", target, `cursor-cli ${JSON.stringify(prompt)}`, "Enter"])
  return { ok: true, message: `finalize-epic for ${epic.key} started in ${target}` }
}

/** Match a dashboard row to a tmux window by ticket key or branch name. */
export function findWindowFor(
  windows: TmuxWindow[],
  ticketKey: string | null,
  branch: string,
): string | null {
  const window = windows.find(
    (w) => (ticketKey && w.name.includes(ticketKey)) || w.name.includes(branch),
  )
  return window ? window.target : null
}
