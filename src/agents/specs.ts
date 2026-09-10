import type { AgentDefinition, SDKCustomTool } from "@cursor/sdk"
import type { Row, TicketInfo } from "../types.ts"
import type { Todo } from "../data/todos.ts"
import { readAgentStatuses } from "../data/agents.ts"
import { run } from "../data/exec.ts"
import { applyTransition, getEpicChildren, getTransitions, prepTicket } from "../data/jira.ts"
import { launchWork, runMkpanes, targetSession } from "../data/tmux.ts"
import { addTodo, editTodo, loadTodos, removeTodo, sortTodos, toggleTodo } from "../data/todos.ts"

/** Live TUI state pushed into the hub by the App on every change. */
export interface Snapshot {
  rows: Row[]
  backlog: TicketInfo[]
  epics: TicketInfo[]
  todos: Todo[]
}

/** What specs get from the hub when building their tools. */
export interface HubContext {
  snapshot(): Snapshot
  /** Tell the TUI that an agent changed data it renders. */
  appChanged(kind: "todos" | "refresh"): void
  /** Central-only helpers (wired by the hub). */
  agentList(): { id: string; title: string; busy: boolean; queued: number }[]
  agentStatus(id: string): string
  instruct(id: string, instruction: string): string
}

export interface TabAgentSpec {
  id: string
  title: string
  /** Seeded as a preamble on the agent's first message. */
  rolePrompt: string
  makeTools(ctx: HubContext): Record<string, SDKCustomTool>
  /** Native SDK subagents this tab agent can spawn via the task tool. */
  agents?: Record<string, AgentDefinition>
}

const REPLY_STYLE =
  "Your replies render in a small terminal pane: be brief and plain-text (no markdown tables, no headers). " +
  "Use the report_to_central tool for anything the manager should know; don't repeat reports in chat replies."

const EVENT_STYLE =
  "You will also receive automated '[event digest]' messages listing changes in your area. For each digest: " +
  "call report_to_central when something deserves the manager's or Daniel's awareness (severity attention if it needs Daniel now); " +
  "otherwise reply with a single short acknowledgment line and nothing else. Never call tools just to re-verify a digest."

// ---------------------------------------------------------------------------
// formatting helpers (compact, token-frugal)

function fmtRow(r: Row): string {
  const parts = [
    `${r.repo}/${r.branch}`,
    r.ticket ? `ticket ${r.ticketKey}: ${r.ticket.status}` : (r.ticketKey ?? "no ticket"),
    r.mr ? `MR !${r.mr.iid} ${r.mr.state}${r.mr.pipelineStatus ? ` ci:${r.mr.pipelineStatus}` : ""}` : "no MR",
    r.git ? `${r.git.dirtyCount} dirty` : "git?",
    r.tmuxWindow ? `window ${r.tmuxWindow}` : "no window",
    r.agent ? `agent ${r.agent.state} (${r.agent.source})` : "no agent",
  ]
  return parts.join(" | ")
}

function fmtTicket(t: TicketInfo): string {
  return `${t.key} [${t.status}] ${t.summary}${t.assignee ? ` (${t.assignee})` : ""}`
}

async function transitionByName(key: string, toStatus: string): Promise<string> {
  const transitions = await getTransitions(key)
  if (!transitions) return "could not fetch transitions (JIRA_EMAIL / JIRA_API_TOKEN?)"
  const match = transitions.find((t) => t.toStatus.toLowerCase() === toStatus.toLowerCase())
  if (!match) return `no transition to "${toStatus}" — available: ${transitions.map((t) => t.toStatus).join(", ")}`
  return (await applyTransition(key, match.id)) ? `${key} transitioned to ${match.toStatus}` : "transition failed"
}

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""))

// ---------------------------------------------------------------------------
// ticket-agent management (shared by worktrees + qa: they field-manage the
// external cursor/claude agents working in tmux windows)

/** Read-only deep inspection of one worktree, spawned via the task tool. */
const WORKTREE_INSPECTOR: AgentDefinition = {
  description:
    "Inspect one git worktree in depth: status, diff, recent commits, branch state vs origin. " +
    "Give it the worktree path and what to find out.",
  prompt:
    "You are a read-only worktree inspector. You get a worktree path and a question. " +
    "Use the shell (git -C <path> status/diff/log, reading files) to answer it. " +
    "Never modify anything: no commits, pushes, checkouts, edits, or state-changing commands. " +
    "Reply with a concise plain-text summary.",
  model: "inherit",
}

function ticketAgentTools(ctx: HubContext, qa: boolean): Record<string, SDKCustomTool> {
  const rowsFor = () => ctx.snapshot().rows.filter((r) => r.isQa === qa)
  const findWindow = (window: string): Row | undefined => rowsFor().find((r) => r.tmuxWindow === window)
  return {
    get_agent_feed: {
      description: "Latest hook status per worktree directory for the external ticket agents (cursor/claude).",
      inputSchema: { type: "object", properties: {} },
      execute: () => {
        const statuses = [...readAgentStatuses().entries()].filter(([dir]) => dir.includes("_qa_") === qa)
        return statuses.length
          ? statuses.map(([dir, s]) => `${dir}: ${s.state} (${s.source}, ${s.ts})`).join("\n")
          : "no active ticket agents"
      },
    },
    read_ticket_pane: {
      description:
        "Capture the visible tmux pane of a ticket window (window ids come from list output, e.g. \"0:5\"). " +
        "Shows what the ticket agent is doing or asking.",
      inputSchema: { type: "object", properties: { window: { type: "string" } }, required: ["window"] },
      execute: async (args) => {
        const window = str(args.window)
        if (!findWindow(window)) return `no ${qa ? "QA" : "dev"} worktree row has tmux window "${window}"`
        const res = await run("tmux", ["capture-pane", "-t", window, "-p"])
        if (!res.ok) return `capture failed: ${res.stderr.trim()}`
        const lines = res.stdout.replace(/\s+$/, "").split("\n")
        return lines.slice(-60).join("\n") || "(pane is empty)"
      },
    },
    message_ticket_agent: {
      description:
        "Type a message into a ticket window's active pane (where the cursor/claude agent runs) and press enter. " +
        "Use to nudge or answer a waiting ticket agent.",
      inputSchema: {
        type: "object",
        properties: { window: { type: "string" }, text: { type: "string" } },
        required: ["window", "text"],
      },
      execute: async (args) => {
        const window = str(args.window)
        const text = str(args.text)
        if (!findWindow(window)) return `no ${qa ? "QA" : "dev"} worktree row has tmux window "${window}"`
        const typed = await run("tmux", ["send-keys", "-t", window, "-l", text])
        if (!typed.ok) return `send failed: ${typed.stderr.trim()}`
        await run("tmux", ["send-keys", "-t", window, "Enter"])
        return `sent to ${window}: ${text}`
      },
    },
  }
}

const TICKET_AGENT_STYLE =
  "Tools for the external ticket agents: get_agent_feed (hook statuses), read_ticket_pane(window), " +
  "message_ticket_agent(window, text) to nudge or answer one. For deep read-only inspection of a single " +
  "worktree, spawn the worktree-inspector subagent with the worktree path and your question."

// ---------------------------------------------------------------------------
// central

const central: TabAgentSpec = {
  id: "central",
  title: "central",
  rolePrompt:
    "You are the central manager agent of Daniel's development control center TUI. " +
    "Specialist agents run one per tab (worktrees, qa, backlog, projects, todos); external ticket agents work in tmux windows. " +
    "Your tools: list_agents, get_status(agent), instruct(agent, instruction). " +
    "You receive batched '[reports]' messages from specialists — treat them as information; only instruct an agent or reply at length when action or a decision is actually needed, otherwise acknowledge in one short line. " +
    "Never instruct agents in a loop: after instructing, wait for the resulting report. " +
    "You also have your own shell, skills (jira-ticket, start-ticket, …) and Atlassian MCP access for direct requests from Daniel. " +
    REPLY_STYLE,
  makeTools(ctx) {
    return {
      list_agents: {
        description: "List the specialist agents (id, title, busy, queued messages).",
        inputSchema: { type: "object", properties: {} },
        execute: () =>
          ctx
            .agentList()
            .map((a) => `${a.id} (${a.title}) — ${a.busy ? "busy" : "idle"}${a.queued ? `, ${a.queued} queued` : ""}`)
            .join("\n") || "no agents registered",
      },
      get_status: {
        description: "Get a specialist agent's current status: busy state, queue, last report.",
        inputSchema: {
          type: "object",
          properties: { agent: { type: "string", description: "agent id, e.g. worktrees" } },
          required: ["agent"],
        },
        execute: (args) => ctx.agentStatus(str(args.agent)),
      },
      instruct: {
        description:
          "Send an instruction to a specialist agent (fire-and-forget). Its final reply comes back to you as a report.",
        inputSchema: {
          type: "object",
          properties: {
            agent: { type: "string", description: "agent id, e.g. worktrees" },
            instruction: { type: "string" },
          },
          required: ["agent", "instruction"],
        },
        execute: (args) => ctx.instruct(str(args.agent), str(args.instruction)),
      },
    }
  },
}

// ---------------------------------------------------------------------------
// specialists

const worktrees: TabAgentSpec = {
  id: "worktrees",
  title: "worktrees",
  rolePrompt:
    "You are the worktrees specialist of a development control center, and the field manager of the external ticket agents (cursor-cli/claude) working in tmux windows — one per worktree. " +
    "Scope: local git worktrees, their branches, MRs, CI, and the ticket agents working in them. " +
    "You get event digests about agent activity and MR/CI changes; report anything needing Daniel's attention to central (severity: info < warn < attention). " +
    "Destructive operations (removing worktrees, merging) are done by Daniel via TUI keys — recommend, don't attempt. " +
    TICKET_AGENT_STYLE +
    " " +
    REPLY_STYLE +
    " " +
    EVENT_STYLE,
  agents: { "worktree-inspector": WORKTREE_INSPECTOR },
  makeTools(ctx) {
    return {
      ...ticketAgentTools(ctx, false),
      list_worktrees: {
        description: "List current dev worktrees with git/ticket/MR/agent state.",
        inputSchema: { type: "object", properties: {} },
        execute: () => {
          const rows = ctx.snapshot().rows.filter((r) => !r.isQa)
          return rows.length ? rows.map(fmtRow).join("\n") : "no worktrees"
        },
      },
      launch_or_resume: {
        description: "Open (or resume) a work window for a branch/ticket via mkpanes in the user's tmux session.",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "repo alias, e.g. lists" },
            branch: { type: "string", description: "branch or ticket key, e.g. LW-17124" },
          },
          required: ["repo", "branch"],
        },
        execute: async (args) => {
          const session = await targetSession()
          const result = await launchWork(str(args.repo), str(args.branch), session)
          ctx.appChanged("refresh")
          return result.message
        },
      },
    }
  },
}

const qa: TabAgentSpec = {
  id: "qa",
  title: "qa",
  rolePrompt:
    "You are the QA specialist of a development control center. Scope: QA worktrees (directories named <repo>_qa_<branch>) where Daniel tests other people's tickets, and the QA ticket agents in their tmux windows. " +
    "Report QA sessions needing attention to central. Cleanup is done by Daniel via TUI keys — recommend, don't attempt. " +
    TICKET_AGENT_STYLE +
    " " +
    REPLY_STYLE +
    " " +
    EVENT_STYLE,
  agents: { "worktree-inspector": WORKTREE_INSPECTOR },
  makeTools(ctx) {
    return {
      ...ticketAgentTools(ctx, true),
      list_qa_worktrees: {
        description: "List current QA worktrees with git/ticket/MR/agent state.",
        inputSchema: { type: "object", properties: {} },
        execute: () => {
          const rows = ctx.snapshot().rows.filter((r) => r.isQa)
          return rows.length ? rows.map(fmtRow).join("\n") : "no QA worktrees"
        },
      },
      start_qa: {
        description: "Open a QA window for a ticket (mkpanes --qa: separate _qa_ worktree + /qa-ticket).",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "repo alias, e.g. lists" },
            ticket: { type: "string", description: "ticket key, e.g. LW-17124" },
          },
          required: ["repo", "ticket"],
        },
        execute: async (args) => {
          const session = await targetSession()
          const result = await runMkpanes([str(args.repo), "-w", str(args.ticket), "--qa"], session)
          ctx.appChanged("refresh")
          return result.message
        },
      },
    }
  },
}

const backlog: TabAgentSpec = {
  id: "backlog",
  title: "backlog",
  rolePrompt:
    "You are the backlog specialist of a development control center. Scope: Daniel's assigned-but-not-in-progress Jira tickets. " +
    "You can transition tickets, prep them (In Progress + current sprint), and start work on them via tmux. " +
    REPLY_STYLE +
    " " +
    EVENT_STYLE,
  makeTools(ctx) {
    return {
      list_backlog: {
        description: "List backlog tickets (assigned, not in progress).",
        inputSchema: { type: "object", properties: {} },
        execute: () => {
          const tickets = ctx.snapshot().backlog
          return tickets.length ? tickets.map(fmtTicket).join("\n") : "backlog empty"
        },
      },
      transition_ticket: {
        description: "Transition a Jira ticket to a target status by name.",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" }, to_status: { type: "string", description: 'e.g. "In Progress"' } },
          required: ["key", "to_status"],
        },
        execute: async (args) => {
          const result = await transitionByName(str(args.key), str(args.to_status))
          ctx.appChanged("refresh")
          return result
        },
      },
      prep_ticket: {
        description: "Move a ticket to In Progress and into the current sprint (skips whatever is already correct).",
        inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
        execute: async (args) => {
          const result = await prepTicket(str(args.key))
          ctx.appChanged("refresh")
          return result.message
        },
      },
      start_ticket: {
        description: "Start work on a ticket: open a tmux window with a worktree via mkpanes.",
        inputSchema: {
          type: "object",
          properties: { repo: { type: "string" }, ticket: { type: "string" } },
          required: ["repo", "ticket"],
        },
        execute: async (args) => {
          const session = await targetSession()
          const result = await launchWork(str(args.repo), str(args.ticket), session)
          ctx.appChanged("refresh")
          return result.message
        },
      },
    }
  },
}

const projects: TabAgentSpec = {
  id: "projects",
  title: "projects",
  rolePrompt:
    "You are the projects specialist of a development control center. Scope: Daniel's Jira epics and their child tickets. " +
    "You can list epics, drill into children, transition and prep tickets. " +
    REPLY_STYLE +
    " " +
    EVENT_STYLE,
  makeTools(ctx) {
    return {
      list_epics: {
        description: "List Daniel's open epics.",
        inputSchema: { type: "object", properties: {} },
        execute: () => {
          const epics = ctx.snapshot().epics
          return epics.length ? epics.map(fmtTicket).join("\n") : "no epics"
        },
      },
      list_epic_children: {
        description: "List the tickets inside an epic with statuses.",
        inputSchema: { type: "object", properties: { epic: { type: "string" } }, required: ["epic"] },
        execute: async (args) => {
          const children = await getEpicChildren(str(args.epic))
          if (!children) return "could not fetch epic children"
          return children.length ? children.map(fmtTicket).join("\n") : "epic has no child tickets"
        },
      },
      transition_ticket: {
        description: "Transition a Jira ticket to a target status by name.",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" }, to_status: { type: "string" } },
          required: ["key", "to_status"],
        },
        execute: async (args) => {
          const result = await transitionByName(str(args.key), str(args.to_status))
          ctx.appChanged("refresh")
          return result
        },
      },
      prep_ticket: {
        description: "Move a ticket to In Progress and into the current sprint.",
        inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
        execute: async (args) => {
          const result = await prepTicket(str(args.key))
          ctx.appChanged("refresh")
          return result.message
        },
      },
    }
  },
}

const todosSpec: TabAgentSpec = {
  id: "todos",
  title: "todos",
  rolePrompt:
    "You are the todos specialist of a development control center. Scope: Daniel's lightweight local todo list (no tickets, no branches). " +
    "Keep it tidy: add, edit, complete, and remove items on request. " +
    REPLY_STYLE,
  makeTools(ctx) {
    const mutate = (fn: (todos: Todo[]) => Todo[]): string => {
      sortTodos(fn(loadTodos()))
      ctx.appChanged("todos")
      return "done"
    }
    return {
      list_todos: {
        description: "List todos (including completed).",
        inputSchema: { type: "object", properties: {} },
        execute: () => {
          const todos = ctx.snapshot().todos
          return todos.length
            ? todos.map((t) => `${t.done ? "[x]" : "[ ]"} id=${t.id} ${t.text}`).join("\n")
            : "no todos"
        },
      },
      add_todo: {
        description: "Add a todo.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        execute: (args) => mutate((todos) => addTodo(todos, str(args.text))),
      },
      edit_todo: {
        description: "Rewrite a todo's text (id from list_todos).",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" }, text: { type: "string" } },
          required: ["id", "text"],
        },
        execute: (args) => mutate((todos) => editTodo(todos, str(args.id), str(args.text))),
      },
      toggle_todo: {
        description: "Toggle a todo done/undone (id from list_todos).",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        execute: (args) => mutate((todos) => toggleTodo(todos, str(args.id))),
      },
      remove_todo: {
        description: "Delete a todo (id from list_todos).",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        execute: (args) => mutate((todos) => removeTodo(todos, str(args.id))),
      },
    }
  },
}

/** Tab agents in tab order. Adding a new pane = adding a spec here. */
export const TAB_AGENT_SPECS: TabAgentSpec[] = [central, worktrees, qa, backlog, projects, todosSpec]
