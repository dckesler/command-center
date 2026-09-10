import type { GitStatus, RepoInfo } from "../types.ts"
import { run } from "./exec.ts"

export interface Worktree {
  repo: RepoInfo
  branch: string
  path: string
}

/** List linked worktrees for a repo (excludes the main checkout and detached heads). */
export async function listWorktrees(repo: RepoInfo): Promise<Worktree[]> {
  const res = await run("git", ["-C", repo.path, "worktree", "list", "--porcelain"])
  if (!res.ok) return []
  const worktrees: Worktree[] = []
  let currentPath: string | null = null
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length)
    } else if (line.startsWith("branch refs/heads/") && currentPath && currentPath !== repo.path) {
      worktrees.push({ repo, branch: line.slice("branch refs/heads/".length), path: currentPath })
    }
  }
  return worktrees
}

export async function getGitStatus(worktreePath: string): Promise<GitStatus> {
  const [statusRes, ageRes, upstreamRes] = await Promise.all([
    run("git", ["-C", worktreePath, "status", "--porcelain"]),
    run("git", ["-C", worktreePath, "log", "-1", "--format=%cr"]),
    run("git", ["-C", worktreePath, "rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
  ])

  const dirtyCount = statusRes.ok
    ? statusRes.stdout.split("\n").filter((l) => l.trim()).length
    : 0
  const lastCommitRelative = ageRes.ok ? ageRes.stdout.trim() : ""

  let ahead: number | null = null
  let behind: number | null = null
  let hasUpstream = false

  if (upstreamRes.ok) {
    const [a, b] = upstreamRes.stdout.trim().split(/\s+/).map(Number)
    ahead = a
    behind = b
    hasUpstream = true
  } else {
    // No upstream: compare against the origin default branch instead.
    const headRef = await run("git", ["-C", worktreePath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
    if (headRef.ok) {
      const defaultRef = headRef.stdout.trim()
      const vsDefault = await run("git", [
        "-C", worktreePath, "rev-list", "--left-right", "--count", `HEAD...${defaultRef}`,
      ])
      if (vsDefault.ok) {
        const [a, b] = vsDefault.stdout.trim().split(/\s+/).map(Number)
        ahead = a
        behind = b
      }
    }
  }

  return { dirtyCount, ahead, behind, hasUpstream, lastCommitRelative }
}

export interface ActionResult {
  ok: boolean
  message: string
}

async function isRegisteredWorktree(repoPath: string, worktreePath: string): Promise<boolean> {
  const res = await run("git", ["-C", repoPath, "worktree", "list", "--porcelain"])
  return res.ok && res.stdout.split("\n").some((line) => line === `worktree ${worktreePath}`)
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  force: boolean,
): Promise<ActionResult> {
  const args = ["-C", repoPath, "worktree", "remove"]
  if (force) args.push("--force")
  args.push(worktreePath)
  const res = await run("git", args, { timeoutMs: 60_000 })
  if (res.ok) return { ok: true, message: `removed ${worktreePath}` }

  // Without --force, git refuses to delete a worktree holding extra files.
  // Ignored files (e.g. node_modules from the pane's package install) are the
  // common cause and aren't user work — retry forced, but only when the
  // worktree reports no tracked changes and no untracked files.
  if (!force) {
    const status = await run("git", ["-C", worktreePath, "status", "--porcelain"])
    if (status.ok && !status.stdout.trim()) {
      const retry = await run(
        "git",
        ["-C", repoPath, "worktree", "remove", "--force", worktreePath],
        { timeoutMs: 60_000 },
      )
      if (retry.ok) return { ok: true, message: `removed ${worktreePath}` }
    }
  }

  // A failed remove can still deregister the worktree, leaving an orphaned
  // directory (git deletes the tracked files, fails to rmdir over ignored
  // ones, and prunes the metadata anyway). Once git no longer tracks the
  // path, deleting the leftover directory is the only way to finish the job.
  const looksSafe = worktreePath !== repoPath && worktreePath.split("/").filter(Boolean).length >= 3
  if (looksSafe && !(await isRegisteredWorktree(repoPath, worktreePath))) {
    const rm = await run("rm", ["-rf", worktreePath], { timeoutMs: 60_000 })
    await run("git", ["-C", repoPath, "worktree", "prune"])
    if (rm.ok) return { ok: true, message: `removed ${worktreePath} (cleaned leftover files)` }
  }

  return { ok: false, message: res.stderr.trim() || "worktree remove failed" }
}

export async function deleteBranch(repoPath: string, branch: string): Promise<ActionResult> {
  const res = await run("git", ["-C", repoPath, "branch", "-D", branch])
  return {
    ok: res.ok,
    message: res.ok ? `deleted branch ${branch}` : res.stderr.trim() || "branch delete failed",
  }
}

const TICKET_RE = /([A-Z][A-Z0-9]+-\d+)/

export function ticketKeyFromBranch(branch: string): string | null {
  const match = branch.match(TICKET_RE)
  return match ? match[1] : null
}
