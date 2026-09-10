import type { AgentStatus } from "./data/agents.ts"

export interface RepoInfo {
  alias: string
  path: string
}

export interface GitStatus {
  dirtyCount: number
  ahead: number | null
  behind: number | null
  /** true when ahead/behind is vs the branch's own upstream, false when vs origin default */
  hasUpstream: boolean
  lastCommitRelative: string
}

export interface TicketInfo {
  key: string
  summary: string
  status: string
  statusCategory: string
  type: string
  url: string
  priority?: string
  /** ISO timestamp of last update (backlog view only) */
  updated?: string
  /** Assignee display name (epic children view) */
  assignee?: string
}

export interface MrInfo {
  iid: number
  projectId: number
  title: string
  state: "opened" | "merged" | "closed"
  draft: boolean
  hasConflicts: boolean
  /** GitLab detailed_merge_status, e.g. "mergeable", "not_approved", "discussions_not_resolved" */
  detailedMergeStatus: string | null
  blockingDiscussionsResolved: boolean | null
  pipelineStatus: string | null
  url: string
}

/** Lazily-fetched detail for the expanded row view. */
export interface MrExtras {
  approved: boolean
  approvalsRequired: number
  approvalsLeft: number
  approvedBy: string[]
  resolvableThreads: number
  unresolvedThreads: number
}

export interface Row {
  repo: string
  repoPath: string
  branch: string
  worktreePath: string
  ticketKey: string | null
  git: GitStatus | null
  ticket: TicketInfo | null
  mr: MrInfo | null
  /** e.g. "0:3" when a tmux window matches this row */
  tmuxWindow: string | null
  /** Latest hook event from a Cursor/Claude agent running in this worktree */
  agent: AgentStatus | null
  /** true for QA worktrees (mkpanes --qa names them <repo>_qa_<branch>) */
  isQa: boolean
}

export interface TransitionOption {
  id: string
  name: string
  toStatus: string
}

export interface LoadState {
  git: boolean
  jira: boolean
  gitlab: boolean
  tmux: boolean
}
