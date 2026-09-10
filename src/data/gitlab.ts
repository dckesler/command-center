import type { MrExtras, MrInfo } from "../types.ts"
import { run } from "./exec.ts"

interface GlabMr {
  iid: number
  project_id: number
  title: string
  state: "opened" | "merged" | "closed"
  draft: boolean
  has_conflicts: boolean
  detailed_merge_status?: string
  blocking_discussions_resolved?: boolean
  web_url: string
  source_branch: string
  head_pipeline?: { status: string } | null
  pipeline?: { status: string } | null
}

/**
 * Find the most recent MR for a branch (any state), then fetch pipeline status
 * if the list payload didn't include it. Runs `glab` inside the main repo
 * checkout so it resolves the GitLab project from the git remote.
 */
export async function getMrForBranch(repoPath: string, branch: string): Promise<MrInfo | null> {
  const list = await run(
    "glab",
    ["mr", "list", "--all", `--source-branch=${branch}`, "--output", "json", "--per-page", "5"],
    { cwd: repoPath },
  )
  if (!list.ok) return null

  let mrs: GlabMr[]
  try {
    mrs = JSON.parse(list.stdout)
  } catch {
    return null
  }
  if (!Array.isArray(mrs) || mrs.length === 0) return null

  // Prefer an open MR, then merged, then whatever is newest.
  const mr =
    mrs.find((m) => m.state === "opened") ??
    mrs.find((m) => m.state === "merged") ??
    mrs[0]

  let pipelineStatus = mr.head_pipeline?.status ?? mr.pipeline?.status ?? null
  let detailedMergeStatus = mr.detailed_merge_status ?? null
  let blockingDiscussionsResolved = mr.blocking_discussions_resolved ?? null

  // The list payload omits pipeline (and sometimes merge-status) info, so open
  // MRs get one detail call that provides pipeline + merge readiness together.
  if (mr.state === "opened") {
    const detail = await run(
      "glab",
      ["api", `projects/${mr.project_id}/merge_requests/${mr.iid}`],
      { cwd: repoPath },
    )
    if (detail.ok) {
      try {
        const parsed = JSON.parse(detail.stdout) as GlabMr
        pipelineStatus = parsed.head_pipeline?.status ?? parsed.pipeline?.status ?? pipelineStatus
        detailedMergeStatus = parsed.detailed_merge_status ?? detailedMergeStatus
        blockingDiscussionsResolved = parsed.blocking_discussions_resolved ?? blockingDiscussionsResolved
      } catch {
        // leave detail fields unknown
      }
    }
  }

  return {
    iid: mr.iid,
    projectId: mr.project_id,
    title: mr.title,
    state: mr.state,
    draft: mr.draft,
    hasConflicts: mr.has_conflicts,
    detailedMergeStatus,
    blockingDiscussionsResolved,
    pipelineStatus,
    url: mr.web_url,
  }
}

/**
 * Merge an MR. If a pipeline is running, glab enables auto-merge (merge when
 * pipeline succeeds) rather than failing. Removes the remote source branch.
 */
export async function mergeMr(repoPath: string, iid: number): Promise<{ ok: boolean; message: string }> {
  const res = await run("glab", ["mr", "merge", String(iid), "--yes", "--remove-source-branch"], {
    cwd: repoPath,
    timeoutMs: 120_000,
  })
  return {
    ok: res.ok,
    message: res.ok
      ? res.stdout.trim().split("\n").pop() ?? `!${iid} merged`
      : res.stderr.trim() || "merge failed",
  }
}

interface GlabApprovals {
  approved: boolean
  approvals_required: number
  approvals_left: number
  approved_by: { user: { username: string } }[]
}

interface GlabDiscussion {
  notes: { resolvable?: boolean; resolved?: boolean }[]
}

/** Approvals + unresolved-thread counts. Fetched only for the expanded row view. */
export async function getMrExtras(
  repoPath: string,
  projectId: number,
  iid: number,
): Promise<MrExtras | null> {
  const [approvalsRes, discussionsRes] = await Promise.all([
    run("glab", ["api", `projects/${projectId}/merge_requests/${iid}/approvals`], { cwd: repoPath }),
    run("glab", ["api", `projects/${projectId}/merge_requests/${iid}/discussions?per_page=100`], {
      cwd: repoPath,
    }),
  ])
  if (!approvalsRes.ok || !discussionsRes.ok) return null

  try {
    const approvals = JSON.parse(approvalsRes.stdout) as GlabApprovals
    const discussions = JSON.parse(discussionsRes.stdout) as GlabDiscussion[]

    let resolvableThreads = 0
    let unresolvedThreads = 0
    for (const discussion of discussions) {
      const resolvable = discussion.notes.filter((n) => n.resolvable)
      if (resolvable.length === 0) continue
      resolvableThreads++
      if (!resolvable.every((n) => n.resolved)) unresolvedThreads++
    }

    return {
      approved: approvals.approved,
      approvalsRequired: approvals.approvals_required,
      approvalsLeft: approvals.approvals_left,
      approvedBy: approvals.approved_by.map((a) => a.user.username),
      resolvableThreads,
      unresolvedThreads,
    }
  } catch {
    return null
  }
}
