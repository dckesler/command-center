import type { AgentDefinition, SDKCustomTool } from "@cursor/sdk"
import type { Row, TicketInfo } from "../types.ts"
import { config } from "../config.ts"
import type { Todo } from "../data/todos.ts"
import { findTranscript, readAgentStatuses, readTranscriptTail } from "../data/agents.ts"
import { ackInbox, formatCatchUp, readInbox, unreadInbox } from "../data/inbox.ts"
import {
  cancelCloudRun,
  followUpCloudAgent,
  fmtCloudAgent,
  listCloudRepos,
  startCloudAgent,
  type CloudAgent,
} from "../data/cloud.ts"
import { run } from "../data/exec.ts"
import { sendMail } from "../data/mail.ts"
import { getMessageBody, type EmailMessage } from "../data/outlook.ts"
import { dayBounds, fmtEvent, getEventDetail, getEvents, type CalendarEvent } from "../data/calendar.ts"
import { applyTransition, getEpicChildren, getTicketsByKeys, getTransitions, prepTicket } from "../data/jira.ts"
import {
  createProject,
  fmtProject,
  fmtTask,
  listProjectTasks,
  readBriefRaw,
  readProjectReports,
  setProjectEpic,
  type Project,
} from "../data/projects.ts"
import { launchWork, openProjectWindow, runMkpanes, targetSession } from "../data/tmux.ts"
import {
  addTodo,
  addTodoNote,
  editTodo,
  FOCUS_CADENCE_MS,
  FOCUS_MAX,
  fmtMinutes as fmtTodoMinutes,
  fmtTodo,
  loadTodos,
  removeTodo,
  removeTodoNote,
  setFocus,
  sortTodos,
  toggleTodo,
  type NoteAuthor,
} from "../data/todos.ts"

/** Live TUI state pushed into the hub by the App on every change. */
export interface Snapshot {
  rows: Row[]
  tickets: TicketInfo[]
  epics: TicketInfo[]
  projects: Project[]
  todos: Todo[]
  /** null while Outlook is unavailable (m365 not logged in) */
  emails: EmailMessage[] | null
  /** today's calendar; null while the calendar is unavailable */
  events: CalendarEvent[] | null
  cloud: CloudAgent[]
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

/** How prompts address the human (config.user.name). */
const USER = config().user.name

const FOCUS_CADENCE_LABEL = fmtTodoMinutes(FOCUS_CADENCE_MS / 60_000)

const REPLY_STYLE =
  "Your replies render in a small terminal pane: be brief and plain-text (no markdown tables, no headers). " +
  "Use the report_to_central tool for anything the manager should know; don't repeat reports in chat replies."

const EVENT_STYLE =
  "You will also receive '[event digest]' and sometimes '[catch-up]' messages (updates that arrived while you were down). " +
  "For each: call report_to_central with ONE short line — ticket key + what changed, no quotes of the ticket agent's last message — " +
  `when central or ${USER} should know (severity attention if ${USER} is needed now). ` +
  "Otherwise reply with a single short acknowledgment. Never call tools just to re-verify a digest."

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

/** Per-turn cap for transcript output: user turns can carry huge attached-skill preambles. */
const TRANSCRIPT_TURN_MAX = 1200

/** Durable inbox access for one tab (updates that arrived while the specialist was down). */
function inboxTools(tab: string): Record<string, SDKCustomTool> {
  return {
    read_inbox: {
      description:
        "Read durable updates addressed to this tab. Default is unread (arrived while you were down). scope=all shows the last 20.",
      inputSchema: {
        type: "object",
        properties: { scope: { type: "string", description: '"unread" (default) or "all"' } },
      },
      execute: (args) => {
        const all = str(args.scope) === "all"
        const items = all ? readInbox().filter((r) => r.to === tab).slice(-20) : unreadInbox(tab)
        return items.length ? formatCatchUp(items) : "inbox empty"
      },
    },
    ack_inbox: {
      description: "Mark durable inbox items as read through the given id (from read_inbox).",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      execute: (args) => {
        ackInbox(tab, str(args.id))
        return `acked through ${str(args.id)}`
      },
    },
  }
}

function ticketAgentTools(ctx: HubContext, qa: boolean): Record<string, SDKCustomTool> {
  const rowsFor = () => ctx.snapshot().rows.filter((r) => r.isQa === qa)
  const findWindow = (window: string): Row | undefined => rowsFor().find((r) => r.tmuxWindow === window)
  return {
    ...inboxTools(qa ? "qa" : "worktrees"),
    get_agent_feed: {
      description: "Latest hook status per worktree directory for the external ticket agents (cursor/claude).",
      inputSchema: { type: "object", properties: {} },
      execute: () => {
        const statuses = [...readAgentStatuses().entries()].filter(([dir]) => dir.includes("_qa_") === qa)
        return statuses.length
          ? statuses
              .map(([dir, s]) => `${dir}: ${s.state} (${s.source}, ${s.ts})${s.summary ? ` — ${s.summary}` : ""}`)
              .join("\n")
          : "no active ticket agents"
      },
    },
    read_ticket_transcript: {
      description:
        "Read the last N user/assistant turns of a ticket agent's conversation transcript (Cursor or Claude) for the " +
        "worktree behind a tmux window. Richer than the pane: full text of what the agent said and was told, nothing scrolled off.",
      inputSchema: {
        type: "object",
        properties: {
          window: { type: "string", description: 'tmux window id from list output, e.g. "0:5"' },
          turns: { type: "number", description: "how many turns to return (default 6, max 20)" },
        },
        required: ["window"],
      },
      execute: (args) => {
        const window = str(args.window)
        const row = findWindow(window)
        if (!row) return `no ${qa ? "QA" : "dev"} worktree row has tmux window "${window}"`
        const status = readAgentStatuses().get(row.worktreePath)
        const path = findTranscript(row.worktreePath, status)
        if (!path) return `no transcript found for ${row.worktreePath}`
        const turns = Math.min(20, Math.max(1, Number(args.turns) || 6))
        const tail = readTranscriptTail(path, turns)
        if (tail.length === 0) return `transcript ${path} has no text turns yet`
        return tail
          .map((t) => `[${t.role}] ${t.text.length > TRANSCRIPT_TURN_MAX ? `${t.text.slice(0, TRANSCRIPT_TURN_MAX)}…` : t.text}`)
          .join("\n\n")
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
        "Send a message to a ticket window's agent through the cc-mail mailbox. A busy agent gets it after its next tool call, " +
        "a finishing agent gets it as its next turn, an idle agent is nudged only when nobody is typing in that tmux session and its " +
        "input box is empty; otherwise it waits (the result says which). Use to steer or inform a ticket agent. " +
        "It cannot answer a permission prompt or a menu — use type_into_ticket_pane for that.",
      inputSchema: {
        type: "object",
        properties: {
          window: { type: "string" },
          text: { type: "string" },
          severity: { type: "string", description: "info (default) | warn | attention" },
        },
        required: ["window", "text"],
      },
      execute: async (args) => {
        const window = str(args.window)
        if (!findWindow(window)) return `no ${qa ? "QA" : "dev"} worktree row has tmux window "${window}"`
        const severity = (["info", "warn", "attention"] as const).find((s) => s === str(args.severity)) ?? "info"
        const res = await sendMail({ window }, str(args.text), { from: `command center ${qa ? "qa" : "worktrees"}`, severity })
        return res.message
      },
    },
    type_into_ticket_pane: {
      description:
        "Type raw text into a ticket window's agent pane and press enter — this lands in whatever is focused there, so only use it " +
        "when read_ticket_pane shows the agent waiting on a prompt, question or menu that needs a literal answer (e.g. 'y', a number, " +
        "an option). For messages use message_ticket_agent.",
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
        // cursor-cli needs a beat between a burst of typed text and Enter, or it keeps a copy in the input box
        await new Promise((r) => setTimeout(r, 500))
        await run("tmux", ["send-keys", "-t", window, "Enter"])
        return `typed into ${window}: ${text}`
      },
    },
  }
}

const TICKET_AGENT_STYLE =
  "Tools for the external ticket agents: get_agent_feed (hook statuses), read_inbox for durable updates that arrived while you were down, " +
  "read_ticket_transcript(window, turns) for what an agent said and was told, read_ticket_pane(window) for its live screen, " +
  "message_ticket_agent(window, text) to steer or inform one (mailbox: never typed over the user's draft), type_into_ticket_pane(window, text) " +
  "only to answer a literal prompt it is waiting on. Event digests already include last reply, files edited, git commands, " +
  "and new commits — read those before reaching for tools. report_to_central must stay one short line. For deep read-only inspection " +
  "of a single worktree, spawn the worktree-inspector subagent with the worktree path and your question."

// ---------------------------------------------------------------------------
// central

const central: TabAgentSpec = {
  id: "central",
  title: "central",
  rolePrompt:
    `You are the central manager agent of ${USER}'s development command center TUI. ` +
    "Specialist agents run one per tab (worktrees, qa, tickets, epics, projects, todos, email, cloud, calendar); external ticket agents and project agents work in tmux windows. " +
    `The calendar specialist tells you about ${USER}'s upcoming meetings — use that context when timing suggestions (don't propose long tasks right before a meeting; ask calendar when you need his availability). ` +
    "Your tools: list_agents, get_status(agent), instruct(agent, instruction), plus focus_todos / list_todos / add_todo_note / set_focus for the focus loop. " +
    "You receive batched '[reports]' messages (each line is timestamped and one sentence) from specialists — treat them as information; only instruct an agent or reply at length when action or a decision is actually needed, otherwise acknowledge in one short line. " +
    "Never instruct agents in a loop: after instructing, wait for the resulting report. " +
    `Focus todos: ${USER} marks a few todos as today's focus; they must keep moving. The todos specialist reports 'focus: <text> — no progress ` +
    `for <time>' when one has gone ${FOCUS_CADENCE_LABEL} without a progress note. On such a report: first check what you already know — recent ` +
    "[reports] from worktrees/projects/tickets/qa and this conversation (an MR merged, a ticket moved, a worker finished on the thing the " +
    "todo is about). If you can attribute real progress, record it with add_todo_note(kind=progress) and say nothing. If you cannot, ask " +
    `${USER} in one line, e.g. 'Focus check: \"<text>\" — nothing logged since <time>. Any progress? (or say park to unfocus)', and stop. ` +
    `When ${USER} answers: real progress → add_todo_note(kind=progress) with his words; nothing yet / still on it → add_todo_note(kind=checkin) ` +
    "so the next check waits another window; park / drop → set_focus(off). Never ask about the same todo twice within a window — if a repeat " +
    "report arrives while your question is still unanswered, acknowledge in a few words and do not re-ask. Do not consult the calendar " +
    `specialist for this: focus checks are already suppressed during meetings. 'focus: nothing set for today' → ask ${USER} once which todos ` +
    `(up to ${FOCUS_MAX}) are today's focus and set them. A 'focus day ended' recap → relay it in two or three lines. ` +
    `You also have your own shell, skills (jira-ticket, start-ticket, …) and Atlassian MCP access for direct requests from ${USER}. ` +
    REPLY_STYLE,
  makeTools(ctx) {
    return {
      ...todoTools(ctx, "central"),
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
    "You are the worktrees specialist of a development command center, and the field manager of the external ticket agents (cursor-cli/claude) working in tmux windows — one per worktree. " +
    "Scope: local git worktrees, their branches, MRs, CI, and the ticket agents working in them. " +
    `You get event digests about agent activity and MR/CI changes; report anything needing ${USER}'s attention to central (severity: info < warn < attention). ` +
    `Destructive operations (removing worktrees, merging) are done by ${USER} via TUI keys — recommend, don't attempt. ` +
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
    `You are the QA specialist of a development command center. Scope: QA worktrees (directories named <repo>_qa_<branch>) where ${USER} tests other people's tickets, and the QA ticket agents in their tmux windows. ` +
    `Report QA sessions needing attention to central. Cleanup is done by ${USER} via TUI keys — recommend, don't attempt. ` +
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
        description: "Open a QA window for a ticket (mkpanes --qa: _qa_ worktree + /qa-ticket; sets Jira Test Lead to Daniel).",
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

const tickets: TabAgentSpec = {
  id: "tickets",
  title: "tickets",
  rolePrompt:
    `You are the tickets specialist of a development command center. Scope: ${USER}'s assigned Jira tickets that are not Done/Closed (epics live on the epics tab). ` +
    "The list is ordered closest-to-shipped first (Ready For Deployment / In Test / code review, then In Progress, then Blocked, then To Do, with Backlog last). " +
    "You can transition tickets, prep them (In Progress + current sprint), and start work on them via tmux. " +
    "You also create Jira tickets: when asked to create one (directly or via a seeded prompt), follow the jira-ticket skill " +
    `and ask ${USER} the questions it needs one at a time in this chat. ` +
    REPLY_STYLE +
    " " +
    EVENT_STYLE,
  makeTools(ctx) {
    return {
      list_tickets: {
        description: `List ${USER}'s open assigned tickets (no epics), closest to shipped first.`,
        inputSchema: { type: "object", properties: {} },
        execute: () => {
          const list = ctx.snapshot().tickets
          return list.length ? list.map(fmtTicket).join("\n") : "no open tickets"
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

const epicsSpec: TabAgentSpec = {
  id: "epics",
  title: "epics",
  rolePrompt:
    `You are the epics specialist of a development command center. Scope: ${USER}'s Jira epics and their child tickets. ` +
    "You can list epics, drill into children, transition and prep tickets. " +
    "You also create Jira tickets: when asked to create one (directly or via a seeded prompt), follow the jira-ticket skill, " +
    `ask ${USER} the questions it needs one at a time in this chat, and link the ticket to the epic when one is given. ` +
    REPLY_STYLE +
    " " +
    EVENT_STYLE,
  makeTools(ctx) {
    return {
      list_epics: {
        description: `List ${USER}'s open epics.`,
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

// ---------------------------------------------------------------------------
// projects (~/projects directories + their tmux project agents)

const PROJECT_INSPECTOR: AgentDefinition = {
  description:
    "Inspect one ~/projects directory in depth: PROJECT.md, file layout, recent changes. " +
    "Give it the project path and what to find out.",
  prompt:
    "You are a read-only project inspector. You get a project directory and a question. " +
    "Read PROJECT.md first, then whatever files answer the question (ls, cat, git log if it is a repo). " +
    "Never modify anything. Reply with a concise plain-text summary.",
  model: "inherit",
}

const projectsSpec: TabAgentSpec = {
  id: "projects",
  title: "projects",
  rolePrompt:
    "You are the projects specialist of a development command center, and the field manager of the project agents (cursor-cli) " +
    "working in tmux windows — one per directory under ~/projects (the command center itself is excluded). " +
    "Each project is tracked by a PROJECT.md brief: Goal, Current state, Next steps (checkboxes), dated Log, and an optional **Epic:** line linking the Jira epic it delivers. " +
    "project_detail(name) is the one-call overview (brief, epic progress, every sub-agent tab with worktree/ticket/MR/agent state and last report) — use it before answering questions about a project. " +
    "Reporting chain: task-tab workers → (cc-report project:<name>) → the project's central agent → (cc-report projects) → you → (report_to_central) → central. " +
    "Central-agent reports arrive as event digests and inbox items; read_project_reports shows the worker-level reports underneath when a digest is unclear. " +
    "You can list projects, read a brief, read a central agent's pane or transcript, message it, list its task tabs, and open/resume a project (start-project skill). " +
    `Creating directories is done by ${USER} via the TUI (n) or by you with create_project only when he asks. ` +
    `Always pass upward: every digest that changes a project's state, finishes a task, or needs ${USER} gets one report_to_central line (severity: info < warn < attention). ` +
    "For deep read-only inspection of one project, spawn the project-inspector subagent with the path and your question. " +
    REPLY_STYLE +
    " " +
    EVENT_STYLE,
  agents: { "project-inspector": PROJECT_INSPECTOR },
  makeTools(ctx) {
    const find = (name: string): Project | undefined => ctx.snapshot().projects.find((p) => p.name === name)
    return {
      ...inboxTools("projects"),
      list_projects: {
        description: "List ~/projects directories with brief status, next-step count, tmux window, and agent state.",
        inputSchema: { type: "object", properties: {} },
        execute: () => {
          const projects = ctx.snapshot().projects
          return projects.length ? projects.map(fmtProject).join("\n") : "no projects"
        },
      },
      read_project_brief: {
        description: "Read a project's PROJECT.md in full.",
        inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        execute: (args) => {
          const project = find(str(args.name))
          if (!project) return `no project named "${str(args.name)}"`
          return readBriefRaw(project.path) ?? `${project.name} has no PROJECT.md yet`
        },
      },
      read_project_transcript: {
        description: "Last N user/assistant turns of the project agent's transcript (Cursor or Claude).",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, turns: { type: "number", description: "default 6, max 20" } },
          required: ["name"],
        },
        execute: (args) => {
          const project = find(str(args.name))
          if (!project) return `no project named "${str(args.name)}"`
          const status = readAgentStatuses().get(project.path)
          const path = findTranscript(project.path, status)
          if (!path) return `no transcript found for ${project.path}`
          const turns = Math.min(20, Math.max(1, Number(args.turns) || 6))
          const tail = readTranscriptTail(path, turns)
          if (tail.length === 0) return `transcript ${path} has no text turns yet`
          return tail
            .map((t) => `[${t.role}] ${t.text.length > TRANSCRIPT_TURN_MAX ? `${t.text.slice(0, TRANSCRIPT_TURN_MAX)}…` : t.text}`)
            .join("\n\n")
        },
      },
      read_project_pane: {
        description: "Capture the visible tmux pane of a project's window.",
        inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        execute: async (args) => {
          const project = find(str(args.name))
          if (!project) return `no project named "${str(args.name)}"`
          if (!project.tmuxWindow) return `${project.name} has no tmux window`
          const res = await run("tmux", ["capture-pane", "-t", project.tmuxWindow, "-p"])
          if (!res.ok) return `capture failed: ${res.stderr.trim()}`
          const lines = res.stdout.replace(/\s+$/, "").split("\n")
          return lines.slice(-60).join("\n") || "(pane is empty)"
        },
      },
      message_project_agent: {
        description:
          "Send a message to a project's central agent through the cc-mail mailbox. A busy agent gets it after its next tool call, " +
          "a finishing agent gets it as its next turn, an idle agent is nudged only when nobody is typing in that tmux session and " +
          "its input box is empty; otherwise it waits and the result says why. Never types over the user's draft.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            text: { type: "string" },
            severity: { type: "string", description: "info (default) | warn | attention" },
          },
          required: ["name", "text"],
        },
        execute: async (args) => {
          const project = find(str(args.name))
          if (!project) return `no project named "${str(args.name)}"`
          const severity = (["info", "warn", "attention"] as const).find((s) => s === str(args.severity)) ?? "info"
          const target = project.tmuxWindow ? { window: project.tmuxWindow } : { dir: project.path }
          const res = await sendMail(target, str(args.text), { from: "command center projects", severity })
          return res.message
        },
      },
      open_project: {
        description:
          "Open or resume a project in its own tmux session + terminal window (starts the project agent on first open).",
        inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        execute: async (args) => {
          const project = find(str(args.name))
          if (!project) return `no project named "${str(args.name)}"`
          const result = await openProjectWindow(project)
          ctx.appChanged("refresh")
          return result.message
        },
      },
      read_project_reports: {
        description:
          "Last N worker reports sent to a project's central agent (cc-report project:<name> → .cc/inbox.jsonl). " +
          "Shows what the task tabs told the central agent, even if it has not passed them upward yet.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, count: { type: "number", description: "default 20, max 100" } },
          required: ["name"],
        },
        execute: (args) => {
          const project = find(str(args.name))
          if (!project) return `no project named "${str(args.name)}"`
          const reports = readProjectReports(project.path, Math.min(100, Math.max(1, Number(args.count) || 20)))
          return reports.length ? reports.join("\n") : `${project.name} has no worker reports yet`
        },
      },
      list_project_tasks: {
        description:
          "Sub-agents of a project: every tmux window in its session (central + task tabs) with worktree/repo@branch, " +
          "ticket + Jira status, MR state, agent hook state and the newest cc-report from that tab.",
        inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        execute: async (args) => {
          const project = find(str(args.name))
          if (!project) return `no project named "${str(args.name)}"`
          const tasks = await listProjectTasks(project, ctx.snapshot().rows)
          if (tasks === null) return `${project.name} has no running session`
          return tasks.length ? tasks.map(fmtTask).join("\n") : `${project.name}: session has no windows`
        },
      },
      project_detail: {
        description:
          "Everything known about one project in one call: brief header (status, epic, goal, current state, open next steps), " +
          "sub-agents (list_project_tasks), epic ticket progress from Jira when an epic is linked, and the last worker reports.",
        inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        execute: async (args) => {
          const project = find(str(args.name))
          if (!project) return `no project named "${str(args.name)}"`
          const b = project.brief
          const out: string[] = [fmtProject(project)]
          if (b) {
            if (b.goal) out.push(`goal: ${b.goal}`)
            if (b.currentState) out.push(`now: ${b.currentState}`)
            if (b.nextSteps.length) out.push(`next steps (${b.nextSteps.length} open, ${b.doneSteps} done):\n${b.nextSteps.map((s) => `  - ${s}`).join("\n")}`)
          }
          if (b?.epic) {
            const [found, children] = await Promise.all([getTicketsByKeys([b.epic]), getEpicChildren(b.epic)])
            const epic = found.get(b.epic)
            if (!epic) out.push(`epic ${b.epic}: not found in Jira`)
            else {
              const done = (children ?? []).filter((c) => c.statusCategory === "Done").length
              out.push(`epic ${epic.key} ${epic.summary} [${epic.status}] — ${done}/${children?.length ?? 0} tickets done`)
              if (children?.length) out.push(children.map((c) => `  ${c.key} [${c.status}] ${c.assignee ?? "-"}: ${c.summary}`).join("\n"))
            }
          }
          const tasks = await listProjectTasks(project, ctx.snapshot().rows)
          out.push(tasks === null ? "session: not running" : tasks.length ? `sub-agents:\n${tasks.map((t) => `  ${fmtTask(t)}`).join("\n")}` : "session running, no windows")
          const reports = readProjectReports(project.path, 8)
          if (reports.length) out.push(`recent reports:\n${reports.map((r) => `  ${r}`).join("\n")}`)
          return out.join("\n")
        },
      },
      set_project_epic: {
        description: `Link a Jira epic to a project (writes the **Epic:** line of PROJECT.md) or clear it with key "none". Only when ${USER} asked.`,
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, key: { type: "string", description: "epic key, e.g. LW-17444, or none" } },
          required: ["name", "key"],
        },
        execute: (args) => {
          const project = find(str(args.name))
          if (!project) return `no project named "${str(args.name)}"`
          const key = str(args.key)
          const result = setProjectEpic(project.path, /^(none|-|clear)$/i.test(key) ? null : key)
          if (result.ok) ctx.appChanged("refresh")
          return result.message
        },
      },
      create_project: {
        description:
          `Create a new project directory with a PROJECT.md brief and open its agent window. Only when ${USER} asked. ` +
          "Interview first if he did not give them: a one-paragraph goal (required), any context the agent should know, and an optional Jira epic key.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            goal: { type: "string", description: "one-paragraph goal — what the project is for and what done looks like" },
            context: { type: "string", description: "optional background: links, prior art, constraints, people, deadlines" },
            epic: { type: "string", description: "optional Jira epic key, e.g. LW-17444" },
          },
          required: ["name", "goal"],
        },
        execute: async (args) => {
          const created = createProject(str(args.name), { goal: str(args.goal), context: str(args.context), epic: str(args.epic) || null })
          if (!created.ok || !created.project) return created.message
          const result = await openProjectWindow(created.project, "new")
          ctx.appChanged("refresh")
          return `${created.message}; ${result.message}`
        },
      },
    }
  },
}

/** Todo tools shared by the todos specialist and (a subset) the central agent. */
function todoTools(ctx: HubContext, by: NoteAuthor): Record<string, SDKCustomTool> {
  const mutate = (fn: (todos: Todo[]) => Todo[]): string => {
    sortTodos(fn(loadTodos()))
    ctx.appChanged("todos")
    return "done"
  }
  const find = (id: string) => loadTodos().find((t) => t.id === id || t.text.toLowerCase() === id.toLowerCase())
  return {
    list_todos: {
      description: "List todos (focus first, then pending, then completed) with staleness for focus items and their newest notes.",
      inputSchema: { type: "object", properties: {} },
      execute: () => {
        const todos = ctx.snapshot().todos
        return todos.length ? todos.map((t) => fmtTodo(t)).join("\n") : "no todos"
      },
    },
    focus_todos: {
      description: `The focus set: todos expected to keep moving today, with minutes since their last progress note (cadence ${FOCUS_CADENCE_LABEL}).`,
      inputSchema: { type: "object", properties: {} },
      execute: () => {
        const focus = ctx.snapshot().todos.filter((t) => t.focus && !t.done)
        return focus.length ? focus.map((t) => fmtTodo(t, 5)).join("\n") : "no focus todos set"
      },
    },
    add_todo_note: {
      description:
        "Append a timestamped note to a todo (id or exact text from list_todos). kind=progress (default) records real movement and resets the " +
        "focus cadence clock; kind=checkin records that someone asked and there was nothing new — it defers the next focus check without " +
        "counting as progress. Notes are never rewritten; add another instead.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          kind: { type: "string", enum: ["progress", "checkin"] },
        },
        required: ["id", "text"],
      },
      execute: (args) => {
        const todo = find(str(args.id))
        if (!todo) return `no todo "${str(args.id)}"`
        const kind = str(args.kind) === "checkin" ? "checkin" : "progress"
        return mutate((todos) => addTodoNote(todos, todo.id, str(args.text), by, kind))
      },
    },
    set_focus: {
      description: `Put a todo into (on=true) or take it out of (on=false) the focus set. Soft cap ${FOCUS_MAX}; more dilutes the point — say so when asked to exceed it.`,
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, on: { type: "boolean" } },
        required: ["id", "on"],
      },
      execute: (args) => {
        const todo = find(str(args.id))
        if (!todo) return `no todo "${str(args.id)}"`
        if (todo.done) return `"${todo.text}" is completed — reopen it first`
        const count = loadTodos().filter((t) => t.focus && !t.done && t.id !== todo.id).length
        mutate((todos) => setFocus(todos, todo.id, args.on !== false))
        return args.on !== false && count + 1 > FOCUS_MAX ? `done — ${count + 1} focus todos now, above the soft cap of ${FOCUS_MAX}` : "done"
      },
    },
  }
}

const todosSpec: TabAgentSpec = {
  id: "todos",
  title: "todos",
  rolePrompt:
    `You are the todos specialist of a development command center. Scope: ${USER}'s lightweight local todo list (no tickets, no branches). ` +
    "Keep it tidy: add, edit, complete, focus/unfocus, and remove items on request. " +
    "Every todo carries an append-only, timestamped note log — read the notes before acting on a todo, and use add_todo_note to record " +
    "useful context (links, decisions, next steps) as you learn it; never try to rewrite an existing note. " +
    `Focus todos are the ones that must keep moving all day; the system checks them every ${FOCUS_CADENCE_LABEL} inside focus hours. ` +
    "Event digests you receive: 'focus check: \"<text>\" (id=…) — no progress for …' means a focus todo has gone a full cadence without a " +
    "progress note — immediately report_to_central one line: 'focus: <text> — no progress for <time>; last: <newest note or none>' " +
    "(severity as given: warn, or attention once it is two windows behind). Do not add a note yourself for a focus check and do not ask " +
    `${USER} — central handles that. 'focus day started' → one line to central listing the focus set by name; if the event says some are ` +
    "already past the cadence, name those as 'stalled: <text> (<time>)' in that same line (or, when empty, " +
    `'focus: nothing set for today — ask ${USER} to pick up to ${FOCUS_MAX}'). 'focus day ended' → report the recap in one line per todo, ` +
    "joined with ';'. " +
    REPLY_STYLE,
  makeTools(ctx) {
    const mutate = (fn: (todos: Todo[]) => Todo[]): string => {
      sortTodos(fn(loadTodos()))
      ctx.appChanged("todos")
      return "done"
    }
    return {
      ...todoTools(ctx, "todos"),
      add_todo: {
        description: "Add a todo, optionally with a first note and/or straight into the focus set.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" }, notes: { type: "string" }, focus: { type: "boolean" } },
          required: ["text"],
        },
        execute: (args) =>
          mutate((todos) => {
            let next = addTodo(todos, str(args.text))
            const id = next[0].id
            if (typeof args.notes === "string" && args.notes.trim()) next = addTodoNote(next, id, str(args.notes), "todos")
            if (args.focus === true) next = setFocus(next, id, true)
            return next
          }),
      },
      remove_todo_note: {
        description: "Delete one note from a todo by its ISO timestamp (from list_todos output is not exact — read the todo first).",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" }, ts: { type: "string" } },
          required: ["id", "ts"],
        },
        execute: (args) => mutate((todos) => removeTodoNote(todos, str(args.id), str(args.ts))),
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
        description: "Toggle a todo done/undone (id from list_todos). Completing a todo removes it from focus.",
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

const email: TabAgentSpec = {
  id: "email",
  title: "email",
  rolePrompt:
    `You are the email specialist of a development command center. Scope: ${USER}'s Outlook work inbox (recent messages). ` +
    "You can list the inbox and fetch full message bodies. This is read-only: you cannot send, reply, move or delete mail — " +
    `when ${USER} wants to reply, draft the text in chat for him to paste into Outlook (o opens the message there). ` +
    "Report genuinely important-looking unread mail to central (severity attention only for truly urgent items). " +
    REPLY_STYLE +
    " " +
    EVENT_STYLE,
  makeTools(ctx) {
    return {
      list_inbox: {
        description: "List recent inbox messages (id, from, subject, received, read state).",
        inputSchema: { type: "object", properties: {} },
        execute: () => {
          const emails = ctx.snapshot().emails
          if (emails === null) return "Outlook unavailable — m365 CLI is not logged in"
          return emails.length
            ? emails
                .map(
                  (e) =>
                    `${e.isRead ? "[read]  " : "[unread]"} id=${e.id} | ${e.from} <${e.fromAddress}> | ${e.subject} | ${e.receivedAt}`,
                )
                .join("\n")
            : "inbox empty (last 7 days)"
        },
      },
      read_message: {
        description: "Fetch the full plain-text body of one message (id from list_inbox).",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        execute: async (args) => (await getMessageBody(str(args.id))) ?? "could not fetch message",
      },
    }
  },
}

const calendar: TabAgentSpec = {
  id: "calendar",
  title: "calendar",
  rolePrompt:
    `You are the calendar specialist of a development command center. Scope: ${USER}'s Outlook work calendar, read-only. ` +
    "Your two jobs: (1) keep central aware of what is coming up — when a meeting is about to start, when the day's schedule " +
    `loads or changes — so central can time its suggestions around ${USER}'s availability; (2) answer ${USER}'s questions about ` +
    "his schedule (today by default; use list_events for other days). " +
    "Tools: today_schedule (cached, free), list_events(start, end) for any range, event_detail(id) for attendees/body. " +
    "Local time is what matters — always quote times as given by the tools, never convert. " +
    "Never mention declined or cancelled meetings as commitments. You cannot create, change or respond to events. " +
    "Reports to central: one line, e.g. \"standup in 10m (Teams)\" or \"schedule loaded: 4 meetings, next 10:00 design review, free after 15:00\"; " +
    "severity attention only when a meeting starts within 10 minutes. " +
    REPLY_STYLE +
    " " +
    EVENT_STYLE,
  makeTools(ctx) {
    const schedule = () => {
      const events = ctx.snapshot().events
      if (events === null) return "calendar unavailable — m365 CLI is not logged in (needs Calendars.Read)"
      const now = Date.now()
      const header = `today ${new Date().toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}, now ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`
      return events.length ? `${header}\n${events.map((e) => fmtEvent(e, now)).join("\n")}` : `${header}\nno meetings today`
    }
    return {
      today_schedule: {
        description: "Today's events from the TUI's cached calendar (time range, subject, location, organizer, flags, id).",
        inputSchema: { type: "object", properties: {} },
        execute: schedule,
      },
      list_events: {
        description:
          "Fetch events for a date range (local dates, YYYY-MM-DD; end is inclusive). Use for tomorrow / this week / a given day.",
        inputSchema: {
          type: "object",
          properties: {
            start: { type: "string", description: "first day, YYYY-MM-DD" },
            end: { type: "string", description: "last day, YYYY-MM-DD (defaults to start)" },
          },
          required: ["start"],
        },
        execute: async (args) => {
          const first = new Date(`${str(args.start)}T00:00:00`)
          const last = new Date(`${str(args.end) || str(args.start)}T00:00:00`)
          if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return "dates must be YYYY-MM-DD"
          const { start } = dayBounds(first)
          const { end } = dayBounds(last)
          const events = await getEvents(start, end)
          if (events === null) return "calendar unavailable — m365 CLI is not logged in"
          if (events.length === 0) return `no events ${str(args.start)}${str(args.end) ? ` → ${str(args.end)}` : ""}`
          const now = Date.now()
          return events
            .map((e) => `${new Date(e.start).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${fmtEvent(e, now)}`)
            .join("\n")
        },
      },
      event_detail: {
        description: "Full detail of one event (id from today_schedule/list_events): attendees with responses, online link, body.",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        execute: async (args) => (await getEventDetail(str(args.id))) ?? "could not fetch event",
      },
    }
  },
}

const cloud: TabAgentSpec = {
  id: "cloud",
  title: "cloud",
  rolePrompt:
    `You are the cloud specialist of a development command center. Scope: ${USER}'s Cursor Cloud agents (bc- ids) that run on Cursor VMs against his git remotes. ` +
    "You can list them, start a new one on a mkpanes repo alias (lists, core, …), send a follow-up, or cancel a running run. " +
    `Starting a cloud agent is a real remote job that costs API usage — only start one when ${USER} asked. Default is no PR. ` +
    "Report failed or finished runs that need attention to central. " +
    REPLY_STYLE +
    " " +
    EVENT_STYLE,
  makeTools(ctx) {
    return {
      list_cloud_agents: {
        description: `List ${USER}'s Cursor Cloud agents (status, repo, branch, summary).`,
        inputSchema: { type: "object", properties: {} },
        execute: () => {
          const agents = ctx.snapshot().cloud
          return agents.length ? agents.map(fmtCloudAgent).join("\n") : "no cloud agents"
        },
      },
      list_cloud_repos: {
        description: "List mkpanes repo aliases that can be used to start a cloud agent.",
        inputSchema: { type: "object", properties: {} },
        execute: async () => {
          const repos = await listCloudRepos()
          return repos.length
            ? repos.map((r) => `${r.alias} → ${r.url} (ref ${r.startingRef})`).join("\n")
            : "no mkpanes repos found"
        },
      },
      start_cloud_agent: {
        description: "Start a Cursor Cloud agent on a mkpanes repo alias with a prompt. Does not open a PR.",
        inputSchema: {
          type: "object",
          properties: {
            repo: { type: "string", description: "mkpanes alias, e.g. lists" },
            prompt: { type: "string" },
            branch: { type: "string", description: "optional starting ref; defaults to the repo's origin HEAD" },
          },
          required: ["repo", "prompt"],
        },
        execute: async (args) => {
          const result = await startCloudAgent(str(args.repo), str(args.prompt), str(args.branch) || undefined)
          if (result.ok) ctx.appChanged("refresh")
          return result.message
        },
      },
      follow_up_cloud: {
        description: "Send a follow-up prompt to an existing cloud agent (bc- id from list_cloud_agents).",
        inputSchema: {
          type: "object",
          properties: { agent_id: { type: "string" }, prompt: { type: "string" } },
          required: ["agent_id", "prompt"],
        },
        execute: async (args) => {
          const result = await followUpCloudAgent(str(args.agent_id), str(args.prompt))
          if (result.ok) ctx.appChanged("refresh")
          return result.message
        },
      },
      cancel_cloud_run: {
        description: "Cancel the latest running run of a cloud agent (bc- id).",
        inputSchema: {
          type: "object",
          properties: { agent_id: { type: "string" } },
          required: ["agent_id"],
        },
        execute: async (args) => {
          const result = await cancelCloudRun(str(args.agent_id))
          if (result.ok) ctx.appChanged("refresh")
          return result.message
        },
      },
    }
  },
}

/** Tab agents in tab order. Adding a new pane = adding a spec here. */
export const TAB_AGENT_SPECS: TabAgentSpec[] = [
  central,
  worktrees,
  qa,
  tickets,
  epicsSpec,
  projectsSpec,
  todosSpec,
  email,
  cloud,
  calendar,
]
