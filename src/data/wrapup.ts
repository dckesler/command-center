// One implementation of "I'm done with this worktree", shared by the TUI keys
// (w wrap-up, x cleanup, X mass cleanup) and the worktrees specialist's gated
// tools. The TUI confirms with a dialog; the specialist queues an approval.
// Either way the same plan is shown and the same steps run.
import { getMrExtras, mergeMr } from "./gitlab.ts"
import { applyTransition, getTransitions } from "./jira.ts"
import { killWindow } from "./tmux.ts"
import { deleteBranch, removeWorktree, type ActionResult } from "./worktrees.ts"
import type { Row } from "../types.ts"

export interface WrapUpPlan {
  /** what will happen, one line each, in order */
  steps: string[]
  /** things that make the wrap-up risky but not impossible */
  warnings: string[]
  /** set when the wrap-up must not run (open review threads); explains why */
  blocked: string | null
}

export function isDirty(row: Row): boolean {
  return (row.git?.dirtyCount ?? 0) > 0
}

/**
 * Work out what wrapping up this row means. Fetches the MR's thread state so
 * an open MR with unresolved review comments blocks the plan — merging over
 * them is the one wrap-up mistake that can't be undone.
 */
export async function planWrapUp(row: Row): Promise<WrapUpPlan> {
  const steps: string[] = []
  const warnings: string[] = []
  let blocked: string | null = null

  if (row.mr?.state === "opened") {
    const extras = await getMrExtras(row.repoPath, row.mr.projectId, row.mr.iid)
    const unresolved = extras
      ? extras.unresolvedThreads
      : row.mr.blockingDiscussionsResolved === false
        ? -1 // extras fetch failed but the last refresh knew of unresolved threads
        : 0
    if (unresolved > 0) {
      blocked = `!${row.mr.iid} has ${unresolved} unresolved comment thread${unresolved === 1 ? "" : "s"} — resolve them in GitLab first`
    } else if (unresolved < 0) {
      blocked = `!${row.mr.iid} has unresolved comment threads (count unavailable) — resolve them in GitLab first`
    }
    steps.push(`merge !${row.mr.iid}`)
    if (row.mr.detailedMergeStatus !== "mergeable") {
      warnings.push(`MR is not mergeable (${row.mr.detailedMergeStatus}) — merge may fail or be queued`)
    }
  } else if (row.mr?.state === "merged") {
    steps.push(`MR !${row.mr.iid} already merged — skipping merge`)
  } else {
    steps.push("no open MR — skipping merge")
  }
  if (row.ticketKey) steps.push(`transition ${row.ticketKey} to Done`)
  if (row.tmuxWindow) steps.push(`close tmux window ${row.tmuxWindow}`)
  steps.push(`remove worktree ${row.worktreePath} + delete branch ${row.branch}`)
  if (isDirty(row)) warnings.push(`${row.git!.dirtyCount} dirty files will be lost`)

  return { steps, warnings, blocked }
}

/**
 * Run the wrap-up: merge → ticket Done → close window → remove worktree +
 * branch. A failed merge aborts everything after it; later failures are
 * reported as ⚠ notes but don't stop the remaining steps. Callers are
 * expected to have shown `planWrapUp` and received a yes.
 */
export async function runWrapUp(row: Row, onStep?: (text: string) => void): Promise<ActionResult> {
  const notes: string[] = []
  const step = (text: string) => onStep?.(text)

  if (row.mr?.state === "opened") {
    step(`merging !${row.mr.iid}…`)
    const merged = await mergeMr(row.repoPath, row.mr.iid)
    if (!merged.ok) return { ok: false, message: `merge failed: ${merged.message} — wrap-up aborted` }
    notes.push(`!${row.mr.iid} merged`)
  }

  if (row.ticketKey) {
    step(`transitioning ${row.ticketKey} to Done…`)
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
    step(`closing tmux window ${row.tmuxWindow}…`)
    if (await killWindow(row.tmuxWindow)) notes.push(`window ${row.tmuxWindow} closed`)
    else notes.push(`⚠ could not close window ${row.tmuxWindow}`)
  }

  step(`removing ${row.worktreePath}…`)
  const removed = await removeWorktree(row.repoPath, row.worktreePath, isDirty(row))
  if (removed.ok) {
    await deleteBranch(row.repoPath, row.branch)
    notes.push("worktree + branch removed")
  } else {
    notes.push(`⚠ ${removed.message}`)
  }

  return { ok: !notes.some((n) => n.startsWith("⚠")), message: notes.join(" · ") }
}

export interface CleanupOptions {
  /** also `git branch -D` the branch (never for QA/review rows: it's someone else's branch) */
  deleteBranch: boolean
  /** also kill the row's tmux window */
  closeWindow: boolean
}

/** Worktree-only teardown: no MR, no Jira. */
export async function runCleanup(row: Row, opts: CleanupOptions, onStep?: (text: string) => void): Promise<ActionResult> {
  onStep?.(`removing ${row.worktreePath}…`)
  const result = await removeWorktree(row.repoPath, row.worktreePath, isDirty(row))
  if (!result.ok) return result
  const notes: string[] = ["worktree removed"]
  if (opts.deleteBranch) {
    const branchResult = await deleteBranch(row.repoPath, row.branch)
    notes.push(branchResult.ok ? `branch ${row.branch} deleted` : `⚠ ${branchResult.message}`)
  }
  if (opts.closeWindow && row.tmuxWindow) {
    notes.push(
      (await killWindow(row.tmuxWindow)) ? `window ${row.tmuxWindow} closed` : `⚠ could not close window ${row.tmuxWindow}`,
    )
  }
  return { ok: !notes.some((n) => n.startsWith("⚠")), message: notes.join(" · ") }
}
