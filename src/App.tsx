import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Backlog } from "./components/Backlog.tsx"
import { Chat } from "./components/Chat.tsx"
import { Dashboard } from "./components/Dashboard.tsx"
import { DetailPanel } from "./components/DetailPanel.tsx"
import { EpicDetail } from "./components/EpicDetail.tsx"
import { Epics } from "./components/Epics.tsx"
import { MkpanesPrompt } from "./components/MkpanesPrompt.tsx"
import { Modal, type ModalState } from "./components/Modal.tsx"
import { QaTicketPrompt } from "./components/QaTicketPrompt.tsx"
import { Todos } from "./components/Todos.tsx"
import { addTodo, editTodo, loadTodos, removeTodo, sortTodos, toggleTodo, type Todo } from "./data/todos.ts"
import {
  agentBusy,
  disposeAll,
  markRead,
  newConversation,
  sendUser,
  setAppChangedHandler,
  updateSnapshot,
} from "./agents/hub.ts"
import { getStore, subscribeAgents } from "./agents/stores.ts"
import { ingestRows, ingestTickets, startEventWatchers } from "./agents/events.ts"
import { collect } from "./data/collect.ts"
import { run } from "./data/exec.ts"
import { getMrExtras, mergeMr } from "./data/gitlab.ts"
import { applyTransition, getBacklog, getEpicChildren, getEpics, getTransitions, prepTicket } from "./data/jira.ts"
import { parseRepoMap } from "./data/repos.ts"
import {
  createTicketPrompt,
  jumpToWindow,
  killWindow,
  launchWork,
  openFinalizeEpic,
  runMkpanes,
  targetSession,
} from "./data/tmux.ts"
import { deleteBranch, removeWorktree } from "./data/worktrees.ts"
import type { LoadState, MrExtras, Row, TicketInfo } from "./types.ts"

const INITIAL_LOAD: LoadState = { git: false, jira: false, gitlab: false, tmux: false }

type View = "central" | "worktrees" | "qa" | "backlog" | "projects" | "todos"

const VIEW_ORDER: View[] = ["central", "worktrees", "qa", "backlog", "projects", "todos"]

const VIEW_BY_KEY: Record<string, View> = {
  "1": "central",
  "2": "worktrees",
  "3": "qa",
  "4": "backlog",
  "5": "projects",
  "6": "todos",
}

/** In Progress first, then To Do, then Done — most actionable at the top. */
const CATEGORY_RANK: Record<string, number> = { "In Progress": 0, "To Do": 1, New: 1, Done: 2 }
function sortEpicTickets(tickets: TicketInfo[]): TicketInfo[] {
  return [...tickets].sort(
    (a, b) =>
      (CATEGORY_RANK[a.statusCategory] ?? 1) - (CATEGORY_RANK[b.statusCategory] ?? 1) ||
      a.key.localeCompare(b.key, undefined, { numeric: true }),
  )
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** Animated frame while `active`, so the UI visibly isn't frozen during slow fetches. */
function useSpinner(active: boolean): string {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const interval = setInterval(() => setTick((t) => t + 1), 120)
    return () => clearInterval(interval)
  }, [active])
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length]
}

export function App() {
  const { width, height } = useTerminalDimensions()
  const [rows, setRows] = useState<Row[]>([])
  const [load, setLoad] = useState<LoadState>(INITIAL_LOAD)
  const [selected, setSelected] = useState(0)
  const [selectedQa, setSelectedQa] = useState(0)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [detailRow, setDetailRow] = useState<Row | null>(null)
  const [extras, setExtras] = useState<MrExtras | null>(null)
  const [extrasLoading, setExtrasLoading] = useState(false)
  const [modal, setModal] = useState<ModalState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [view, setView] = useState<View>("central")
  const [backlog, setBacklog] = useState<TicketInfo[]>([])
  const [backlogLoading, setBacklogLoading] = useState(true)
  const [selectedBacklog, setSelectedBacklog] = useState(0)
  const [epics, setEpics] = useState<TicketInfo[]>([])
  const [epicsLoading, setEpicsLoading] = useState(true)
  const [selectedEpic, setSelectedEpic] = useState(0)
  const [epicDetail, setEpicDetail] = useState<{ epic: TicketInfo; tickets: TicketInfo[] | null } | null>(null)
  const [selectedEpicTicket, setSelectedEpicTicket] = useState(0)
  const [todos, setTodos] = useState<Todo[]>(() => sortTodos(loadTodos()))
  const [selectedTodo, setSelectedTodo] = useState(0)
  const [showCompletedTodos, setShowCompletedTodos] = useState(false)
  const [addingTodo, setAddingTodo] = useState(false)
  const [editingTodo, setEditingTodo] = useState<Todo | null>(null)
  const [mkpanesPrompt, setMkpanesPrompt] = useState(false)
  /** set when the QA flow has a repo picked and is waiting for the ticket key */
  const [qaPrompt, setQaPrompt] = useState<{ repo: string } | null>(null)
  /** chat view: whether the message input owns the keyboard */
  const [chatFocused, setChatFocused] = useState(true)
  const [chatScroll, setChatScroll] = useState(0)
  /** per-tab agent chat drawer (tabs other than central) */
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerFocused, setDrawerFocused] = useState(false)
  /** re-render on any agent store change (busy dots, drawer content) */
  const [agentTick, setAgentTick] = useState(0)
  useEffect(() => subscribeAgents(() => setAgentTick((t) => t + 1)), [])
  const refreshing = useRef(false)

  const openDetail = useCallback((row: Row) => {
    setDetailRow(row)
    setExtras(null)
    if (row.mr && row.mr.state === "opened") {
      setExtrasLoading(true)
      getMrExtras(row.repoPath, row.mr.projectId, row.mr.iid).then((result) => {
        setExtras(result)
        setExtrasLoading(false)
      })
    }
  }, [])

  const refresh = useCallback(async () => {
    if (refreshing.current) return
    refreshing.current = true
    setLoad(INITIAL_LOAD)
    setBacklogLoading(true)
    getBacklog().then((tickets) => {
      if (tickets) setBacklog(tickets)
      setBacklogLoading(false)
    })
    setEpicsLoading(true)
    getEpics().then((result) => {
      if (result) setEpics(result)
      setEpicsLoading(false)
    })
    try {
      await collect((newRows, newLoad) => {
        setRows(newRows)
        setLoad(newLoad)
      })
      setLastRefresh(new Date())
    } finally {
      refreshing.current = false
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Keep the hub's snapshot in sync so agent tools read live TUI state.
  useEffect(() => {
    updateSnapshot({ rows, backlog, epics, todos })
  }, [rows, backlog, epics, todos])

  // Autonomous events: hook-feed watcher plus refresh diffs (only complete
  // loads are diffed, so progressive refresh states don't fake changes).
  useEffect(() => {
    startEventWatchers()
  }, [])
  useEffect(() => {
    if (load.git && load.jira && load.gitlab && load.tmux) ingestRows(rows)
  }, [rows, load])
  useEffect(() => {
    if (!backlogLoading) ingestTickets("backlog", backlog)
  }, [backlog, backlogLoading])
  useEffect(() => {
    if (!epicsLoading) ingestTickets("projects", epics)
  }, [epics, epicsLoading])

  // Agent-driven data changes flow back into the TUI.
  useEffect(() => {
    setAppChangedHandler((kind) => {
      if (kind === "todos") setTodos(sortTodos(loadTodos()))
      else refresh()
    })
  }, [refresh])

  // Viewing an agent's conversation clears its unread marker.
  useEffect(() => {
    if (view === "central") markRead("central")
    else if (drawerOpen) markRead(view)
  }, [view, drawerOpen, agentTick])

  const finishAction = useCallback(
    (result: { ok: boolean; message: string }) => {
      setBusy(null)
      setMessage({ text: result.message, ok: result.ok })
      if (result.ok) refresh()
    },
    [refresh],
  )

  const startOrJump = useCallback(
    async (row: Row) => {
      if (row.tmuxWindow) {
        const ok = await jumpToWindow(row.tmuxWindow)
        setMessage({ text: ok ? `switched to ${row.tmuxWindow}` : "tmux select-window failed", ok })
        return
      }
      // The worktree already exists: for QA rows mkpanes re-runs the QA-steps
      // prompt (--qa), otherwise it detects the worktree and runs /resume-ticket.
      const verb = row.isQa ? "Re-open QA for" : "Resume"
      setModal({
        title: `${verb} ${row.repo} / ${row.branch} via mkpanes?`,
        options: [{ label: row.isQa ? "Open QA window" : "Resume in tmux window" }, { label: "Cancel" }],
        selected: 0,
        onPick: (i) => {
          setModal(null)
          if (i !== 0) return
          setBusy(`${row.isQa ? "opening QA for" : "resuming"} ${row.branch}…`)
          targetSession()
            .then((session) => launchWork(row.repo, row.branch, session, row.isQa ? ["--qa"] : []))
            .then((result) =>
              finishAction({
                ...result,
                message: result.ok
                  ? row.isQa
                    ? `QA window for ${row.branch} opened`
                    : `resuming ${row.branch} — /resume-ticket running`
                  : result.message,
              }),
            )
        },
      })
    },
    [finishAction],
  )

  const changeStatus = useCallback(
    async (key: string | null, currentStatus: string | undefined) => {
      if (!key) {
        setMessage({ text: "row has no ticket", ok: false })
        return
      }
      setBusy(`fetching transitions for ${key}…`)
      const transitions = await getTransitions(key)
      setBusy(null)
      if (!transitions || transitions.length === 0) {
        setMessage({ text: "could not fetch transitions (check JIRA_EMAIL / JIRA_API_TOKEN)", ok: false })
        return
      }
      setModal({
        title: `Transition ${key} (now: ${currentStatus ?? "?"})`,
        options: [...transitions.map((t) => ({ label: t.toStatus })), { label: "Cancel" }],
        selected: 0,
        onPick: (i) => {
          setModal(null)
          if (i >= transitions.length) return
          const transition = transitions[i]
          setBusy(`transitioning ${key} to ${transition.toStatus}…`)
          applyTransition(key, transition.id).then((ok) =>
            finishAction({ ok, message: ok ? `${key} → ${transition.toStatus}` : "transition failed" }),
          )
        },
      })
    },
    [finishAction],
  )

  const startBacklogTicket = useCallback(
    (ticket: TicketInfo) => {
      const repos = parseRepoMap()
      setModal({
        title: `Start ${ticket.key} — pick a repo`,
        options: [...repos.map((r) => ({ label: r.alias })), { label: "Cancel" }],
        selected: 0,
        onPick: (i) => {
          setModal(null)
          if (i >= repos.length) return
          const repo = repos[i]
          setBusy(`launching ${ticket.key} in ${repo.alias}…`)
          targetSession()
            .then((session) => launchWork(repo.alias, ticket.key, session))
            .then(finishAction)
        },
      })
    },
    [finishAction],
  )

  const wrapUp = useCallback(
    async (row: Row) => {
      const dirty = (row.git?.dirtyCount ?? 0) > 0

      // Fresh unresolved-comments check for open MRs: merging over open
      // review threads is the one wrap-up mistake that can't be undone.
      if (row.mr?.state === "opened") {
        setBusy(`checking !${row.mr.iid} for open comments…`)
        const extras = await getMrExtras(row.repoPath, row.mr.projectId, row.mr.iid)
        setBusy(null)
        const unresolved = extras
          ? extras.unresolvedThreads
          : row.mr.blockingDiscussionsResolved === false
            ? -1 // extras fetch failed but the last refresh knew of unresolved threads
            : 0
        if (unresolved !== 0) {
          setModal({
            title: `Wrap up blocked — !${row.mr.iid} has open comments`,
            body: [
              unresolved > 0
                ? `✗ ${unresolved} unresolved comment thread${unresolved === 1 ? "" : "s"} on the MR`
                : "✗ MR has unresolved comment threads (count unavailable)",
              "Resolve them in GitLab first (o opens the MR), then wrap up again.",
            ],
            options: [{ label: "Close" }],
            selected: 0,
            onPick: () => setModal(null),
          })
          return
        }
      }

      const steps: string[] = []
      if (row.mr?.state === "opened") steps.push(`• merge !${row.mr.iid}`)
      else if (row.mr?.state === "merged") steps.push(`• MR !${row.mr.iid} already merged — skipping merge`)
      else steps.push("• no open MR — skipping merge")
      if (row.ticketKey) steps.push(`• transition ${row.ticketKey} to Done`)
      if (row.tmuxWindow) steps.push(`• close tmux window ${row.tmuxWindow}`)
      steps.push(`• remove worktree + delete branch ${row.branch}`)

      const warnings: string[] = []
      if (row.mr?.state === "opened" && row.mr.detailedMergeStatus !== "mergeable") {
        warnings.push(`⚠ MR is not mergeable (${row.mr.detailedMergeStatus}) — merge may fail or be queued`)
      }
      if (dirty) warnings.push(`⚠ ${row.git!.dirtyCount} dirty files will be lost`)

      setModal({
        title: `Wrap up ${row.repo}/${row.branch}`,
        body: [...steps, ...warnings],
        options: [{ label: "Wrap up", danger: true }, { label: "Cancel" }],
        selected: 1,
        onPick: async (i) => {
          setModal(null)
          if (i !== 0) return
          const notes: string[] = []

          if (row.mr?.state === "opened") {
            setBusy(`merging !${row.mr.iid}…`)
            const merged = await mergeMr(row.repoPath, row.mr.iid)
            if (!merged.ok) {
              finishAction({ ok: false, message: `merge failed: ${merged.message} — wrap-up aborted` })
              return
            }
            notes.push(`!${row.mr.iid} merged`)
          }

          if (row.ticketKey) {
            setBusy(`transitioning ${row.ticketKey} to Done…`)
            const transitions = await getTransitions(row.ticketKey)
            const done =
              transitions?.find((t) => t.toStatus.toLowerCase() === "done") ??
              transitions?.find((t) => t.toStatus.toLowerCase() === "closed")
            if (done && (await applyTransition(row.ticketKey, done.id))) {
              notes.push(`${row.ticketKey} → ${done.toStatus}`)
            } else {
              notes.push(
                `⚠ could not transition ${row.ticketKey}${
                  transitions ? ` (available: ${transitions.map((t) => t.toStatus).join(", ")})` : ""
                }`,
              )
            }
          }

          if (row.tmuxWindow) {
            setBusy(`closing tmux window ${row.tmuxWindow}…`)
            if (await killWindow(row.tmuxWindow)) notes.push(`window ${row.tmuxWindow} closed`)
            else notes.push(`⚠ could not close window ${row.tmuxWindow}`)
          }

          setBusy(`removing ${row.worktreePath}…`)
          const removed = await removeWorktree(row.repoPath, row.worktreePath, dirty)
          if (removed.ok) {
            await deleteBranch(row.repoPath, row.branch)
            notes.push("worktree + branch removed")
          } else {
            notes.push(`⚠ ${removed.message}`)
          }

          finishAction({ ok: !notes.some((n) => n.startsWith("⚠")), message: notes.join(" · ") })
        },
      })
    },
    [finishAction],
  )

  const massCleanup = useCallback(() => {
    const isDone = (row: Row) => row.ticket?.statusCategory === "Done" && row.mr?.state === "merged"
    const candidates = rows.filter((r) => isDone(r) && r.git !== null && r.git.dirtyCount === 0)
    const skippedDirty = rows.filter((r) => isDone(r) && (r.git?.dirtyCount ?? 0) > 0)
    if (candidates.length === 0) {
      setMessage({
        text: `no clean worktrees with a Done/Closed ticket and merged MR${skippedDirty.length ? ` (${skippedDirty.length} candidates skipped: dirty)` : ""}`,
        ok: false,
      })
      return
    }
    setModal({
      title: `Mass cleanup — ${candidates.length} worktrees (ticket Done + MR merged)`,
      body: [
        ...candidates.map((r) => `${r.repo}/${r.branch}  (${r.ticket!.status}, !${r.mr!.iid} merged)`),
        ...(skippedDirty.length > 0
          ? [`skipped (dirty files): ${skippedDirty.map((r) => r.branch).join(", ")}`]
          : []),
      ],
      options: [
        { label: `Remove ${candidates.length} worktrees + delete branches`, danger: true },
        { label: `Remove ${candidates.length} worktrees only`, danger: true },
        { label: "Cancel" },
      ],
      selected: 2,
      onPick: async (i) => {
        setModal(null)
        if (i === 2) return
        let removed = 0
        const failures: string[] = []
        for (let n = 0; n < candidates.length; n++) {
          const row = candidates[n]
          setBusy(`cleaning ${n + 1}/${candidates.length}: ${row.repo}/${row.branch}…`)
          const result = await removeWorktree(row.repoPath, row.worktreePath, false)
          if (result.ok) {
            removed++
            if (i === 0) await deleteBranch(row.repoPath, row.branch)
          } else {
            failures.push(row.branch)
          }
        }
        finishAction({
          ok: failures.length === 0,
          message:
            failures.length > 0
              ? `removed ${removed}, failed: ${failures.join(", ")}`
              : `removed ${removed} worktrees${i === 0 ? " + branches" : ""}`,
        })
      },
    })
  }, [rows, finishAction])

  const cleanupWorktree = useCallback(
    (row: Row, closeWindow = false) => {
      const dirty = (row.git?.dirtyCount ?? 0) > 0
      const windowSuffix = closeWindow && row.tmuxWindow ? " + close window" : ""
      setModal({
        title: `Clean up ${row.worktreePath}${dirty ? ` — ${row.git!.dirtyCount} DIRTY FILES will be lost!` : ""}`,
        options: [
          { label: `Remove worktree${windowSuffix}`, danger: dirty },
          { label: `Remove worktree + delete branch${windowSuffix}`, danger: true },
          { label: "Cancel" },
        ],
        selected: 2,
        onPick: async (i) => {
          setModal(null)
          if (i === 2) return
          setBusy(`removing ${row.worktreePath}…`)
          const result = await removeWorktree(row.repoPath, row.worktreePath, dirty)
          if (!result.ok) {
            finishAction(result)
            return
          }
          const notes: string[] = ["worktree removed"]
          if (i === 1) {
            const branchResult = await deleteBranch(row.repoPath, row.branch)
            notes.push(branchResult.ok ? `branch ${row.branch} deleted` : `⚠ ${branchResult.message}`)
          }
          if (closeWindow && row.tmuxWindow) {
            notes.push(
              (await killWindow(row.tmuxWindow))
                ? `window ${row.tmuxWindow} closed`
                : `⚠ could not close window ${row.tmuxWindow}`,
            )
          }
          finishAction({ ok: !notes.some((n) => n.startsWith("⚠")), message: notes.join(" · ") })
        },
      })
    },
    [finishAction],
  )

  /** Open the central chat seeded with a jira-ticket prompt (epic optional). */
  const openTicketChat = useCallback((epic?: TicketInfo) => {
    setEpicDetail(null)
    setView("central")
    setChatFocused(true)
    setChatScroll(0)
    sendUser("central", createTicketPrompt(epic ? { key: epic.key, summary: epic.summary } : undefined))
  }, [])

  /** Launch the finalize-epic skill in a tmux window titled FINALIZE <key>. */
  const finalizeEpic = useCallback((epic: TicketInfo) => {
    setBusy(`starting finalize-epic for ${epic.key}…`)
    targetSession()
      .then((session) => openFinalizeEpic(session, { key: epic.key, summary: epic.summary }))
      .then((result) => {
        setBusy(null)
        setMessage({ text: result.message, ok: result.ok })
      })
  }, [])

  /** Refetch the open epic's children in place (keeps selection clamped). */
  const refetchEpicChildren = useCallback(() => {
    if (!epicDetail) return
    const epicKey = epicDetail.epic.key
    getEpicChildren(epicKey).then((fresh) => {
      if (!fresh) return
      const sorted = sortEpicTickets(fresh)
      setEpicDetail((d) => (d && d.epic.key === epicKey ? { ...d, tickets: sorted } : d))
      setSelectedEpicTicket((s) => Math.min(s, Math.max(0, sorted.length - 1)))
    })
  }, [epicDetail])

  const openEpic = useCallback((epic: TicketInfo) => {
    setEpicDetail({ epic, tickets: null })
    setSelectedEpicTicket(0)
    getEpicChildren(epic.key).then((tickets) => {
      setEpicDetail((d) =>
        d && d.epic.key === epic.key ? { ...d, tickets: sortEpicTickets(tickets ?? []) } : d,
      )
    })
  }, [])

  const submitMkpanes = useCallback(
    (args: string[]) => {
      setMkpanesPrompt(false)
      setBusy(`mkpanes ${args.join(" ")}…`)
      targetSession()
        .then((session) => runMkpanes(args, session))
        .then(finishAction)
    },
    [finishAction],
  )

  const startQa = useCallback(() => {
    const repos = parseRepoMap()
    setModal({
      title: "New QA — pick a repo",
      options: [...repos.map((r) => ({ label: r.alias })), { label: "Cancel" }],
      selected: 0,
      onPick: (i) => {
        setModal(null)
        if (i >= repos.length) return
        setQaPrompt({ repo: repos[i].alias })
      },
    })
  }, [])

  const submitQaTicket = useCallback(
    (ticket: string) => {
      if (!qaPrompt) return
      const repo = qaPrompt.repo
      setQaPrompt(null)
      setBusy(`opening QA for ${ticket} in ${repo}…`)
      targetSession()
        .then((session) => runMkpanes([repo, "-w", ticket, "--qa"], session))
        .then((result) =>
          finishAction({
            ...result,
            message: result.ok ? `QA window for ${ticket} opened` : result.message,
          }),
        )
    },
    [qaPrompt, finishAction],
  )

  const workRows = rows.filter((r) => !r.isQa)
  const qaRows = rows.filter((r) => r.isQa)

  const overlayActive =
    modal !== null || detailRow !== null || epicDetail !== null || mkpanesPrompt || qaPrompt !== null
  const drawerVisible = drawerOpen && view !== "central" && !overlayActive

  useKeyboard((key) => {
    // While a text input is focused it owns all keys except escape.
    if (addingTodo || editingTodo || mkpanesPrompt || qaPrompt) {
      if (key.name === "escape") {
        setAddingTodo(false)
        setEditingTodo(null)
        setMkpanesPrompt(false)
        setQaPrompt(null)
      }
      return
    }
    if (view === "central" && chatFocused && !modal) {
      if (key.name === "escape") setChatFocused(false)
      return
    }
    // While the tab's agent drawer input is focused it owns all keys.
    if (drawerVisible && drawerFocused) {
      if (key.name === "escape") setDrawerFocused(false)
      return
    }
    if (key.name === "q" && !busy) {
      // Best-effort agent disposal, capped so quitting never hangs.
      Promise.race([disposeAll(), new Promise((resolve) => setTimeout(resolve, 1500))]).finally(() =>
        process.exit(0),
      )
      return
    }
    if (busy) return
    setMessage(null)
    if (modal) {
      if (key.name === "escape") setModal(null)
      if (key.name === "j" || key.name === "down") {
        setModal((m) => m && { ...m, selected: Math.min(m.selected + 1, m.options.length - 1) })
      }
      if (key.name === "k" || key.name === "up") {
        setModal((m) => m && { ...m, selected: Math.max(m.selected - 1, 0) })
      }
      if (key.name === "return") modal.onPick(modal.selected)
      return
    }
    if (detailRow) {
      if (key.name === "escape" || key.name === "return") setDetailRow(null)
      if (key.name === "o" && detailRow.mr) run("open", [detailRow.mr.url])
      if (key.name === "t" && detailRow.ticket) run("open", [detailRow.ticket.url])
      return
    }
    if (epicDetail) {
      const tickets = epicDetail.tickets ?? []
      const ticket = tickets[selectedEpicTicket]
      if (key.name === "escape") setEpicDetail(null)
      if (key.name === "j" || key.name === "down") {
        setSelectedEpicTicket((s) => Math.min(s + 1, Math.max(0, tickets.length - 1)))
      }
      if (key.name === "k" || key.name === "up") {
        setSelectedEpicTicket((s) => Math.max(s - 1, 0))
      }
      if (key.name === "r") {
        // Refetch this epic's tickets in place (keeps selection), plus the
        // global refresh so worktree/tmux dots stay accurate.
        refresh()
        refetchEpicChildren()
      }
      if (key.name === "p" && ticket) {
        setModal({
          title: `Move ${ticket.key} to In Progress + current sprint?`,
          options: [{ label: "Move" }, { label: "Cancel" }],
          selected: 0,
          onPick: (i) => {
            setModal(null)
            if (i !== 0) return
            setBusy(`prepping ${ticket.key}…`)
            prepTicket(ticket.key).then((result) => {
              setBusy(null)
              setMessage({ text: result.message, ok: result.ok })
              refetchEpicChildren()
            })
          },
        })
      }
      if (key.name === "s" && ticket) {
        // Same semantics as the worktrees tab: jump to the tmux window or
        // resume the existing worktree; otherwise pick a repo and start fresh.
        const row = rows.find((r) => r.ticketKey === ticket.key)
        if (row) startOrJump(row)
        else startBacklogTicket(ticket)
      }
      if (key.name === "n") openTicketChat(epicDetail.epic)
      if (key.name === "f") finalizeEpic(epicDetail.epic)
      if (key.name === "t" && ticket) run("open", [ticket.url])
      if (key.name === "c" && ticket) changeStatus(ticket.key, ticket.status)
      return
    }
    if (key.name === "tab" || VIEW_BY_KEY[key.name]) {
      const next =
        key.name === "tab" ? VIEW_ORDER[(VIEW_ORDER.indexOf(view) + 1) % VIEW_ORDER.length] : VIEW_BY_KEY[key.name]
      setView(next)
      if (next === "central") {
        setChatFocused(true)
        setChatScroll(0)
        markRead("central")
      }
      return
    }
    if (key.name === "r") refresh()

    // Per-tab agent drawer: ; toggles, i refocuses the input when open.
    const sequence = (key as unknown as { sequence?: string }).sequence
    if (view !== "central" && (key.name === ";" || sequence === ";")) {
      if (drawerOpen) {
        setDrawerOpen(false)
        setDrawerFocused(false)
      } else {
        setDrawerOpen(true)
        setDrawerFocused(true)
        markRead(view)
      }
      return
    }
    if (drawerVisible && key.name === "i") {
      setDrawerFocused(true)
      return
    }

    if (view === "central") {
      // Focused chat is handled earlier; here the input is unfocused.
      if (key.name === "i" || key.name === "return" || key.name === "a") setChatFocused(true)
      if (key.name === "j" || key.name === "down") setChatScroll((s) => Math.max(0, s - 1))
      if (key.name === "k" || key.name === "up") setChatScroll((s) => s + 1)
      if (key.name === "n") {
        setModal({
          title: "Start a new central conversation? The current one is discarded.",
          options: [{ label: "New conversation", danger: true }, { label: "Cancel" }],
          selected: 1,
          onPick: (i) => {
            setModal(null)
            if (i === 0) newConversation("central")
          },
        })
      }
      return
    }

    if (view === "todos") {
      const visibleTodos = showCompletedTodos ? todos : todos.filter((t) => !t.done)
      const todo = visibleTodos[selectedTodo]
      if (key.name === "j" || key.name === "down") {
        setSelectedTodo((s) => Math.min(s + 1, Math.max(0, visibleTodos.length - 1)))
      }
      if (key.name === "k" || key.name === "up") {
        setSelectedTodo((s) => Math.max(s - 1, 0))
      }
      if (key.name === "v") {
        setShowCompletedTodos((show) => !show)
        setSelectedTodo(0)
      }
      if (key.name === "a") setAddingTodo(true)
      if (key.name === "e" && todo) setEditingTodo(todo)
      if ((key.name === "space" || key.name === "return") && todo) {
        setTodos(sortTodos(toggleTodo(todos, todo.id)))
        // When completed todos are hidden, a just-completed one leaves the list.
        if (!showCompletedTodos && !todo.done) {
          setSelectedTodo((s) => Math.max(0, Math.min(s, visibleTodos.length - 2)))
        }
      }
      if (key.name === "x" && todo) {
        setModal({
          title: `Delete todo: ${todo.text.slice(0, 40)}`,
          options: [{ label: "Delete", danger: true }, { label: "Cancel" }],
          selected: 1,
          onPick: (i) => {
            setModal(null)
            if (i !== 0) return
            setTodos(sortTodos(removeTodo(todos, todo.id)))
            setSelectedTodo((s) => Math.max(0, Math.min(s, visibleTodos.length - 2)))
          },
        })
      }
      return
    }

    if (view === "qa") {
      const row = qaRows[selectedQa]
      if (key.name === "j" || key.name === "down") {
        setSelectedQa((s) => Math.min(s + 1, Math.max(0, qaRows.length - 1)))
      }
      if (key.name === "k" || key.name === "up") {
        setSelectedQa((s) => Math.max(s - 1, 0))
      }
      if (key.name === "return" && row) openDetail(row)
      if (key.name === "n") startQa()
      if (key.name === "s" && row) startOrJump(row)
      if (key.name === "c" && row) changeStatus(row.ticketKey, row.ticket?.status)
      // QA cleanup also closes the QA tmux window — the QA session is done with.
      if (key.name === "x" && row) cleanupWorktree(row, true)
      if (key.name === "o") {
        const url = row?.mr?.url
        if (url) run("open", [url])
      }
      if (key.name === "t") {
        const url = row?.ticket?.url
        if (url) run("open", [url])
      }
      return
    }

    if (view === "projects") {
      const epic = epics[selectedEpic]
      if (key.name === "j" || key.name === "down") {
        setSelectedEpic((s) => Math.min(s + 1, Math.max(0, epics.length - 1)))
      }
      if (key.name === "k" || key.name === "up") {
        setSelectedEpic((s) => Math.max(s - 1, 0))
      }
      if (key.name === "return" && epic) openEpic(epic)
      if (key.name === "n" && epic) openTicketChat(epic)
      if (key.name === "f" && epic) finalizeEpic(epic)
      if (key.name === "c" && epic) changeStatus(epic.key, epic.status)
      if (key.name === "t" && epic) run("open", [epic.url])
      return
    }

    if (view === "backlog") {
      const ticket = backlog[selectedBacklog]
      if (key.name === "j" || key.name === "down") {
        setSelectedBacklog((s) => Math.min(s + 1, Math.max(0, backlog.length - 1)))
      }
      if (key.name === "k" || key.name === "up") {
        setSelectedBacklog((s) => Math.max(s - 1, 0))
      }
      if (key.name === "n") openTicketChat()
      if (key.name === "s" && ticket) startBacklogTicket(ticket)
      if (key.name === "c" && ticket) changeStatus(ticket.key, ticket.status)
      if (key.name === "t" && ticket) run("open", [ticket.url])
      return
    }

    if (key.name === "j" || key.name === "down") {
      setSelected((s) => Math.min(s + 1, Math.max(0, workRows.length - 1)))
    }
    if (key.name === "k" || key.name === "up") {
      setSelected((s) => Math.max(s - 1, 0))
    }
    if (key.name === "return" && workRows[selected]) openDetail(workRows[selected])
    if (key.name === "n") setMkpanesPrompt(true)
    if (key.name === "s" && workRows[selected]) startOrJump(workRows[selected])
    if (key.name === "c" && workRows[selected]) changeStatus(workRows[selected].ticketKey, workRows[selected].ticket?.status)
    if (key.name === "x" && key.shift) massCleanup()
    else if (key.name === "x" && workRows[selected]) cleanupWorktree(workRows[selected])
    if (key.name === "w" && workRows[selected]) wrapUp(workRows[selected])
    if (key.name === "o") {
      const url = workRows[selected]?.mr?.url
      if (url) run("open", [url])
    }
    if (key.name === "t") {
      const url = workRows[selected]?.ticket?.url
      if (url) run("open", [url])
    }
  })

  const drawerHeight = Math.max(8, Math.floor((height - 4) * 0.4))
  const contentHeight = drawerVisible ? height - 4 - drawerHeight : height - 4

  /** Busy / unread indicator for a tab's agent. */
  const agentDot = (id: string) =>
    agentBusy(id) ? (
      <span fg="#facc15"> ⚙</span>
    ) : getStore(id).unread ? (
      <span fg="#4ade80"> ●</span>
    ) : null

  const loading = (["git", "jira", "gitlab", "tmux"] as const).filter((k) => !load[k])
  const working = loading.length > 0 || backlogLoading || epicsLoading || busy !== null
  const spinner = useSpinner(working)
  const statusLine =
    loading.length > 0
      ? `${spinner} loading: ${loading.join(", ")}…`
      : backlogLoading
        ? `${spinner} loading backlog…`
        : lastRefresh
          ? `refreshed ${lastRefresh.toLocaleTimeString()}`
          : ""

  return (
    <box flexDirection="column" height={height}>
      <box paddingLeft={1} paddingRight={1} flexDirection="row" justifyContent="space-between">
        <text>
          <span fg="#93c5fd">CONTROL CENTER</span>
          <span fg={view === "central" ? "#ffffff" : "#6b7280"}>  [1] central</span>
          {agentDot("central")}
          <span fg={view === "worktrees" ? "#ffffff" : "#6b7280"}>  [2] {workRows.length} worktrees</span>
          {agentDot("worktrees")}
          <span fg={view === "qa" ? "#ffffff" : "#6b7280"}>  [3] {qaRows.length} qa</span>
          {agentDot("qa")}
          <span fg={view === "backlog" ? "#ffffff" : "#6b7280"}>  [4] {backlog.length} backlog</span>
          {agentDot("backlog")}
          <span fg={view === "projects" ? "#ffffff" : "#6b7280"}>  [5] {epics.length} projects</span>
          {agentDot("projects")}
          <span fg={view === "todos" ? "#ffffff" : "#6b7280"}>  [6] {todos.filter((t) => !t.done).length} todos</span>
          {agentDot("todos")}
        </text>
        <text fg="#6b7280">{statusLine}</text>
      </box>
      <box paddingLeft={1} paddingRight={1} flexGrow={1} flexDirection="column">
        <box flexGrow={1} flexDirection="column">
        {mkpanesPrompt ? (
          <MkpanesPrompt onSubmit={submitMkpanes} />
        ) : qaPrompt ? (
          <QaTicketPrompt repo={qaPrompt.repo} onSubmit={submitQaTicket} />
        ) : modal ? (
          <Modal modal={modal} />
        ) : detailRow ? (
          <DetailPanel row={detailRow} extras={extras} extrasLoading={extrasLoading} />
        ) : epicDetail ? (
          <EpicDetail
            epic={epicDetail.epic}
            tickets={epicDetail.tickets}
            worktreeKeys={new Set(rows.map((r) => r.ticketKey).filter((k): k is string => k !== null))}
            windowKeys={new Set(
              rows.filter((r) => r.tmuxWindow).map((r) => r.ticketKey).filter((k): k is string => k !== null),
            )}
            selected={selectedEpicTicket}
            width={width - 2}
            height={height - 4}
          />
        ) : view === "todos" ? (
          <Todos
            todos={showCompletedTodos ? todos : todos.filter((t) => !t.done)}
            hiddenDoneCount={showCompletedTodos ? 0 : todos.filter((t) => t.done).length}
            selected={selectedTodo}
            adding={addingTodo}
            editing={editingTodo}
            onSubmit={(text) => {
              if (editingTodo) {
                setTodos(sortTodos(editTodo(todos, editingTodo.id, text)))
                setEditingTodo(null)
              } else {
                setTodos(sortTodos(addTodo(todos, text)))
                setAddingTodo(false)
                setSelectedTodo(0)
              }
            }}
            height={contentHeight}
          />
        ) : view === "backlog" ? (
          <Backlog
            tickets={backlog}
            selected={selectedBacklog}
            worktreeKeys={new Set(rows.map((r) => r.ticketKey).filter((k): k is string => k !== null))}
            loading={backlogLoading}
            width={width - 2}
            height={contentHeight}
          />
        ) : view === "projects" ? (
          <Epics
            epics={epics}
            selected={selectedEpic}
            loading={epicsLoading}
            width={width - 2}
            height={contentHeight}
          />
        ) : view === "central" ? (
          <Chat
            agentId="central"
            title="Central agent"
            emptyHint="central manager agent — it directs the tab specialists and receives their reports. Type a message and press enter."
            focused={chatFocused}
            scroll={chatScroll}
            width={width - 2}
            height={height - 4}
          />
        ) : view === "qa" ? (
          qaRows.length === 0 ? (
            <text fg="#6b7280">no QA worktrees — press n to start one (pick repo, enter ticket)</text>
          ) : (
            <Dashboard rows={qaRows} selected={selectedQa} load={load} width={width - 2} height={contentHeight} />
          )
        ) : (
          <Dashboard rows={workRows} selected={selected} load={load} width={width - 2} height={contentHeight} />
        )}
        </box>
        {drawerVisible && (
          <Chat
            agentId={view}
            title={`${view} agent`}
            emptyHint={`${view} specialist — ask about or act on this tab. Type a message and press enter.`}
            focused={drawerFocused}
            scroll={0}
            width={width - 2}
            height={drawerHeight}
          />
        )}
      </box>
      <box paddingLeft={1}>
        <text>
          {busy ? (
            <span fg="#facc15">{spinner} {busy}</span>
          ) : message ? (
            <span fg={message.ok ? "#4ade80" : "#f87171"}>{message.text}</span>
          ) : (
            <span fg="#6b7280">
              {drawerVisible && drawerFocused
                ? "enter send   esc table keys   ; close agent chat"
                : mkpanesPrompt || qaPrompt
                ? "enter run   esc cancel"
                : modal
                ? "j/k move   enter select   esc cancel"
                : detailRow
                  ? "esc/enter back   o open MR   t open ticket   q quit"
                  : epicDetail
                    ? "esc back   j/k move   n new ticket   s start/jump   p in-progress+sprint   f finalize   c status   t open ticket   r refresh   q quit"
                    : view === "todos"
                      ? addingTodo || editingTodo
                        ? "enter save   esc cancel"
                        : `tab views   j/k move   a add   e edit   space/enter toggle   v ${showCompletedTodos ? "hide" : "show"} completed   x delete   ; agent   q quit`
                      : view === "central"
                        ? chatFocused
                          ? "enter send   esc unfocus input"
                          : "tab views   i focus input   j/k scroll   n new conversation   q quit"
                      : view === "backlog"
                        ? "tab views   j/k move   n create ticket   s start ticket   c status   t open ticket   ; agent   r refresh   q quit"
                        : view === "projects"
                          ? "tab views   j/k move   enter open epic   n new ticket   f finalize   c status   t open epic   ; agent   r refresh   q quit"
                          : view === "qa"
                            ? "tab views   j/k move   enter details   n new QA   s open/jump   c status   x cleanup   ; agent   r refresh   o/t open   q quit"
                            : "tab views   j/k move   enter details   n new   s start/jump   c status   w wrap-up   x cleanup   X mass cleanup   ; agent   r refresh   o/t open   q quit"}
            </span>
          )}
        </text>
      </box>
    </box>
  )
}
