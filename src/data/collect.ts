import type { LoadState, Row } from "../types.ts"
import { readAgentStatuses } from "./agents.ts"
import { getMrForBranch } from "./gitlab.ts"
import { getTicketsByKeys } from "./jira.ts"
import { parseRepoMap } from "./repos.ts"
import { findWindowFor, listTmuxWindows } from "./tmux.ts"
import { getGitStatus, listWorktrees, ticketKeyFromBranch } from "./worktrees.ts"

export type Update = (rows: Row[], load: LoadState) => void

/**
 * Build dashboard rows. Local git data lands first; Jira, GitLab, and tmux
 * columns fill in as their (slower) fetches complete, each triggering onUpdate.
 */
export async function collect(onUpdate: Update): Promise<void> {
  const repos = parseRepoMap()
  const worktrees = (await Promise.all(repos.map(listWorktrees))).flat()
  const agentStatuses = readAgentStatuses()

  const rows: Row[] = worktrees
    .map((wt) => ({
      repo: wt.repo.alias,
      repoPath: wt.repo.path,
      branch: wt.branch,
      worktreePath: wt.path,
      ticketKey: ticketKeyFromBranch(wt.branch),
      git: null,
      ticket: null,
      mr: null,
      tmuxWindow: null,
      agent: agentStatuses.get(wt.path) ?? null,
      isQa: wt.path.split("/").pop()?.includes("_qa_") ?? false,
    }))
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.branch.localeCompare(b.branch))

  const load: LoadState = { git: false, jira: false, gitlab: false, tmux: false }
  const emit = () => onUpdate(rows.map((r) => ({ ...r })), { ...load })
  emit()

  const gitDone = Promise.all(
    rows.map(async (row) => {
      row.git = await getGitStatus(row.worktreePath)
    }),
  ).then(() => {
    load.git = true
    emit()
  })

  const keys = rows.map((r) => r.ticketKey).filter((k): k is string => k !== null)
  const jiraDone = getTicketsByKeys(keys).then((tickets) => {
    for (const row of rows) {
      if (row.ticketKey) row.ticket = tickets.get(row.ticketKey) ?? null
    }
    load.jira = true
    emit()
  })

  const gitlabDone = Promise.all(
    rows.map(async (row) => {
      row.mr = await getMrForBranch(row.repoPath, row.branch)
    }),
  ).then(() => {
    load.gitlab = true
    emit()
  })

  const tmuxDone = listTmuxWindows().then((windows) => {
    for (const row of rows) {
      row.tmuxWindow = findWindowFor(windows, row.ticketKey, row.branch)
    }
    load.tmux = true
    emit()
  })

  await Promise.all([gitDone, jiraDone, gitlabDone, tmuxDone])
}
