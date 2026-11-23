/**
 * tuicr integration. Review worktrees: the human reviews an MR's diff in
 * tuicr (a TUI with inline comments saved as local drafts), the review agent
 * reads those drafts and posts them to GitLab on his word. Local reviews: the
 * human reviews an agent's own uncommitted / branch changes the same way and
 * the agent addresses the drafts in code — nothing reaches GitLab. Also
 * manages the repo's .tuicrignore (files hidden from the review diff).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { config, statePath } from "../config.ts"
import { run } from "./exec.ts"
import { remoteProjectPath } from "./gitlab.ts"

export interface Draft {
  id: string
  path: string | null
  startLine: number | null
  endLine: number | null
  side: "old" | "new"
  type: string
  author: string
  content: string
}

export interface ExistingThread {
  id: string
  author: string
  path: string | null
  line: number | null
  resolved: boolean
  body: string
}

export interface DraftCheck {
  draft: Draft
  /** an existing thread on the same file within a few lines */
  near: ExistingThread | null
}

export async function tuicrInstalled(): Promise<boolean> {
  return (await run("tuicr", ["--version"])).ok
}

/** `gl:group/project/pr/<iid>` — tuicr's session slug for a GitLab MR. */
export async function sessionSlug(repoPath: string, iid: number): Promise<string | null> {
  const project = await remoteProjectPath(repoPath)
  return project ? `gl:${project}/pr/${iid}` : null
}

interface TuicrComment {
  id: string
  path?: string | null
  start_line?: number | null
  end_line?: number | null
  side?: "old" | "new"
  comment_type?: string
  author?: string
  lifecycle_state?: string
  content: string
}

/** Local drafts in the tuicr session for this MR (empty when there is no session). */
export async function readDrafts(repoPath: string, iid: number): Promise<{ slug: string; drafts: Draft[] } | { error: string }> {
  const slug = await sessionSlug(repoPath, iid)
  if (!slug) return { error: "cannot resolve the GitLab project from the origin remote" }
  return readDraftsOf(repoPath, slug)
}

/** Drafts of any tuicr session (MR or local) by slug. */
export async function readDraftsOf(repoPath: string, slug: string): Promise<{ slug: string; drafts: Draft[] } | { error: string }> {
  const res = await run("tuicr", ["review", "comments", "--session", slug, "--repo", repoPath], { cwd: repoPath })
  if (!res.ok) {
    const err = res.stderr.trim()
    if (/no .*session found|not found|does not exist/i.test(err)) return { slug, drafts: [] }
    return { error: err || "tuicr review comments failed" }
  }
  try {
    const raw = JSON.parse(res.stdout) as TuicrComment[]
    const drafts = raw
      .filter((c) => !c.lifecycle_state || c.lifecycle_state === "local_draft")
      .map((c) => ({
        id: c.id,
        path: c.path ?? null,
        startLine: c.start_line ?? null,
        endLine: c.end_line ?? c.start_line ?? null,
        side: c.side ?? "new",
        type: c.comment_type && c.comment_type !== "none" ? c.comment_type : "",
        author: c.author ?? "",
        content: c.content,
      }))
    return { slug, drafts }
  } catch {
    return { error: "could not parse tuicr output" }
  }
}

export interface TuicrSession {
  slug: string
  /** "local" (working tree / commit range) or a forge kind ("pr", …) */
  kind: string
  updatedAt: string
  commentCount: number
  /** tuicr's own "matches the checkout's current state" flag */
  active: boolean
}

/** Persisted tuicr sessions for a checkout (local ones and its origin repo's MR ones). */
export async function listSessions(repoPath: string): Promise<TuicrSession[]> {
  const res = await run("tuicr", ["review", "list", "--repo", repoPath])
  if (!res.ok) return []
  try {
    const raw = JSON.parse(res.stdout) as { slug: string; kind?: string; updated_at?: string; comment_count?: number; active?: boolean }[]
    return raw.map((s) => ({
      slug: s.slug,
      kind: s.kind ?? "",
      updatedAt: s.updated_at ?? "",
      commentCount: s.comment_count ?? 0,
      active: Boolean(s.active),
    }))
  } catch {
    return []
  }
}

async function hasSession(repoPath: string, slug: string): Promise<boolean> {
  return (await listSessions(repoPath)).some((s) => s.slug === slug)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * tuicr only creates a PR session from its TUI, and deletes an empty one on
 * exit. When no tuicr is open on this MR yet, run one briefly in a detached
 * tmux session while `work` adds the first draft, then quit it.
 */
async function withSession<T>(repoPath: string, iid: number, slug: string, work: () => Promise<T>): Promise<T | { ok: false; message: string }> {
  if (await hasSession(repoPath, slug)) return work()
  const name = `cc-tuicr-${iid}-${process.pid}`
  const started = await run("tmux", ["new-session", "-d", "-s", name, "-x", "200", "-y", "50", "-c", repoPath, `tuicr mr ${iid} --no-update-check`])
  if (!started.ok) return { ok: false, message: "no tuicr session for this MR and tmux could not start one — open tuicr on the MR first (cc-review open)" }
  try {
    for (let i = 0; i < 40; i++) {
      await sleep(500)
      if (await hasSession(repoPath, slug)) return await work()
    }
    return { ok: false, message: "tuicr did not create a session for the MR in 20s (is glab logged in?)" }
  } finally {
    await run("tmux", ["send-keys", "-t", name, "Escape", ":q", "Enter"])
    await sleep(800)
    await run("tmux", ["kill-session", "-t", name])
  }
}

/** Add a draft to the MR's tuicr session (how the agent puts its own findings in front of the human). */
export async function addDraft(
  repoPath: string,
  iid: number,
  draft: { path?: string; line?: number; endLine?: number; side?: "old" | "new"; type?: string; author: string; content: string },
): Promise<{ ok: boolean; message: string }> {
  const slug = await sessionSlug(repoPath, iid)
  if (!slug) return { ok: false, message: "cannot resolve the GitLab project from the origin remote" }
  return withSession(repoPath, iid, slug, () => addDraftNow(repoPath, slug, draft))
}

export async function addDraftNow(
  repoPath: string,
  slug: string,
  draft: { path?: string; line?: number; endLine?: number; side?: "old" | "new"; type?: string; author: string; content: string },
): Promise<{ ok: boolean; message: string }> {
  const payload: Record<string, unknown> = { content: draft.content, username: draft.author }
  if (draft.type) payload.type = draft.type
  if (draft.path) payload.file = draft.path
  if (draft.line) payload.line = draft.line
  if (draft.endLine && draft.endLine !== draft.line) {
    payload.start_line = draft.line
    payload.end_line = draft.endLine
    delete payload.line
  }
  if (draft.side) payload.side = draft.side
  const res = await run("tuicr", ["review", "add", "--session", slug, "--repo", repoPath, "--input", JSON.stringify(payload)], { cwd: repoPath })
  return { ok: res.ok, message: res.ok ? "added" : res.stderr.trim() || "tuicr review add failed" }
}

export async function clearDrafts(repoPath: string, iid: number): Promise<boolean> {
  const slug = await sessionSlug(repoPath, iid)
  if (!slug) return false
  return clearDraftsOf(repoPath, slug)
}

export async function clearDraftsOf(repoPath: string, slug: string): Promise<boolean> {
  return (await run("tuicr", ["review", "clearc", "--session", slug, "--repo", repoPath], { cwd: repoPath })).ok
}

export async function deleteDraft(repoPath: string, iid: number, id: string): Promise<boolean> {
  const slug = await sessionSlug(repoPath, iid)
  if (!slug) return false
  return deleteDraftOf(repoPath, slug, id)
}

export async function deleteDraftOf(repoPath: string, slug: string, id: string): Promise<boolean> {
  return (await run("tuicr", ["review", "delete", "--session", slug, "--repo", repoPath, "--comment-id", id], { cwd: repoPath })).ok
}

// ---------------------------------------------------------------------------
// Local reviews: the human reviews an agent's own changes (working tree and/or
// the branch's commits) in tuicr, and the agent addresses the drafts in code.
// Nothing here talks to GitLab.

export interface LocalScope {
  /** include uncommitted changes (`tuicr -w`) */
  workingTree: boolean
  /** commit range for `tuicr -r`, e.g. `abc123..HEAD`; null = none */
  range: string | null
  /** what the range is relative to, for messages */
  baseLabel: string | null
  commits: number
  dirtyFiles: number
}

/** The ref to diff a branch against: origin's default branch (`origin/main`, …), else a local `main`/`master`/`develop`; null when none. */
async function defaultBaseRef(repoPath: string): Promise<string | null> {
  const sym = await run("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: repoPath })
  if (sym.ok && sym.stdout.trim()) return sym.stdout.trim()
  for (const name of ["main", "master", "develop"]) {
    for (const ref of [`origin/${name}`, name]) {
      const res = await run("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: repoPath })
      if (res.ok) return ref
    }
  }
  return null
}

/**
 * What a local review should show: everything the branch did on top of the
 * default branch (merge-base..HEAD) plus uncommitted changes. `base` overrides
 * the branch point (a ref or `A..B`); `workingTreeOnly` skips commits.
 */
export async function localScope(repoPath: string, opts: { base?: string; workingTreeOnly?: boolean; commitsOnly?: boolean } = {}): Promise<LocalScope> {
  const status = await run("git", ["status", "--porcelain"], { cwd: repoPath })
  const dirtyFiles = status.ok ? status.stdout.split("\n").filter((l) => l.trim()).length : 0
  let range: string | null = null
  let baseLabel: string | null = null
  let commits = 0
  if (!opts.workingTreeOnly) {
    if (opts.base && opts.base.includes("..")) {
      range = opts.base
      baseLabel = opts.base
    } else {
      const ref = opts.base ?? (await defaultBaseRef(repoPath))
      if (ref) {
        const mb = await run("git", ["merge-base", ref, "HEAD"], { cwd: repoPath })
        if (mb.ok) {
          const base = mb.stdout.trim()
          const head = await run("git", ["rev-parse", "HEAD"], { cwd: repoPath })
          if (head.ok && head.stdout.trim() !== base) {
            range = `${base.slice(0, 12)}..HEAD`
            baseLabel = ref
          }
        }
      }
    }
    if (range) {
      const count = await run("git", ["rev-list", "--count", range], { cwd: repoPath })
      commits = count.ok ? Number(count.stdout.trim()) || 0 : 0
    }
  }
  const workingTree = !opts.commitsOnly && (dirtyFiles > 0 || !range)
  return { workingTree, range, baseLabel, commits, dirtyFiles }
}

/** The `tuicr …` argv for a scope (without the binary). */
export function localTuicrArgs(scope: LocalScope, paths: string[] = []): string[] {
  const args: string[] = []
  if (scope.workingTree) args.push("-w")
  if (scope.range) args.push("-r", scope.range)
  for (const p of paths) args.push("-p", p)
  args.push("--no-update-check")
  return args
}

interface LocalState {
  slug: string | null
  pane: string | null
  window: string | null
  /** width of the pane before we widened it for tuicr; null = untouched */
  restoreWidth: number | null
  openedAt: string
  scope: LocalScope
}

function localStateFile(repoPath: string): string {
  const key = repoPath.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+/, "")
  return statePath("local-review", `${key}.json`)
}

export function readLocalState(repoPath: string): LocalState | null {
  const file = localStateFile(repoPath)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, "utf8")) as LocalState
  } catch {
    return null
  }
}

export function writeLocalState(repoPath: string, state: LocalState | null): void {
  const file = localStateFile(repoPath)
  if (!state) {
    if (existsSync(file)) unlinkSync(file)
    return
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(state, null, 2))
}

/**
 * The tuicr local session the human is (or was) reviewing in this checkout:
 * the one recorded by `cc-review local open` while it still exists, else
 * tuicr's active local session, else the most recently updated local one.
 */
export async function localSession(repoPath: string): Promise<TuicrSession | null> {
  let sessions = (await listSessions(repoPath)).filter((s) => s.kind === "local")
  if (sessions.length === 0) return null
  const state = readLocalState(repoPath)
  const match = state?.slug ? sessions.find((s) => s.slug === state.slug) : null
  if (match) return match
  // Opened by cc-review: only a session from this round counts — an older
  // one holds comments from a previous round that were already dealt with.
  if (state) sessions = sessions.filter((s) => s.updatedAt >= state.openedAt)
  if (sessions.length === 0) return null
  return sessions.find((s) => s.active) ?? sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
}

/**
 * Wait for tuicr (just started in a pane) to persist its local session and
 * return it; null when none appears in time.
 */
export async function awaitLocalSession(repoPath: string, before: Set<string>, timeoutMs = 8000): Promise<TuicrSession | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(400)
    const fresh = (await listSessions(repoPath)).filter((s) => s.kind === "local" && !before.has(s.slug))
    if (fresh.length) return fresh.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  }
  return null
}

/** `n` lines of context around a draft from the working tree (new side only); "" when unavailable. */
export function snippetOf(repoPath: string, d: Draft, context = 2): string {
  if (!d.path || !d.startLine || d.side === "old") return ""
  const file = join(repoPath, d.path)
  if (!existsSync(file)) return ""
  const lines = readFileSync(file, "utf8").replace(/\n$/, "").split("\n")
  const from = Math.max(1, d.startLine - context)
  const to = Math.min(lines.length, (d.endLine ?? d.startLine) + context)
  const width = String(to).length
  const out: string[] = []
  for (let n = from; n <= to; n++) {
    const mark = n >= d.startLine && n <= (d.endLine ?? d.startLine) ? "▌" : " "
    out.push(`     ${String(n).padStart(width)} ${mark} ${lines[n - 1] ?? ""}`)
  }
  return out.join("\n")
}

/** One local draft for the agent: location, type, author, text, then the code it points at. */
export function fmtLocalDraft(repoPath: string, d: Draft, index: number): string {
  const type = d.type ? ` [${d.type.toUpperCase()}]` : ""
  const who = d.author ? ` — ${d.author}` : ""
  const text = d.content.split("\n").map((l) => `     ${l}`).join("\n")
  const snippet = snippetOf(repoPath, d)
  return `${index}. ${locationOf(d)}${type}${who}\n${text}${snippet ? `\n${snippet}` : ""}`
}

// ---------------------------------------------------------------------------
// GitLab side

interface GlabNote {
  id: number
  body: string
  system?: boolean
  resolvable?: boolean
  resolved?: boolean
  author: { username: string }
  position?: { new_path?: string; old_path?: string; new_line?: number | null; old_line?: number | null } | null
}

export async function existingThreads(repoPath: string, iid: number): Promise<ExistingThread[]> {
  const res = await run("glab", ["api", `projects/:id/merge_requests/${iid}/discussions?per_page=100`, "--paginate"], { cwd: repoPath })
  if (!res.ok) return []
  try {
    const discussions = JSON.parse(res.stdout) as { id: string; notes: GlabNote[] }[]
    const out: ExistingThread[] = []
    for (const d of discussions) {
      const first = d.notes.find((n) => !n.system)
      if (!first) continue
      const resolvable = d.notes.filter((n) => n.resolvable)
      out.push({
        id: d.id,
        author: first.author.username,
        path: first.position?.new_path ?? first.position?.old_path ?? null,
        line: first.position?.new_line ?? first.position?.old_line ?? null,
        // a non-resolvable thread (summary notes, bot reports) is never "open"
        resolved: resolvable.length === 0 || resolvable.every((n) => n.resolved),
        body: first.body,
      })
    }
    return out
  } catch {
    return []
  }
}

const NEAR_LINES = 3

export function checkDrafts(drafts: Draft[], threads: ExistingThread[]): DraftCheck[] {
  return drafts.map((draft) => {
    if (!draft.path || !draft.startLine) return { draft, near: null }
    const near =
      threads.find(
        (t) =>
          t.path === draft.path &&
          t.line !== null &&
          t.line >= draft.startLine! - NEAR_LINES &&
          t.line <= (draft.endLine ?? draft.startLine!) + NEAR_LINES,
      ) ?? null
    return { draft, near }
  })
}

export function locationOf(d: Draft): string {
  if (!d.path) return "(review)"
  if (!d.startLine) return d.path
  const range = d.endLine && d.endLine !== d.startLine ? `${d.startLine}-${d.endLine}` : `${d.startLine}`
  return `${d.path}:${range}${d.side === "old" ? " (old)" : ""}`
}

/** The MR comment body: `path:line` on the first line (type label when typed), then the text. */
export function bodyOf(d: Draft): string {
  const label = d.type ? `**[${d.type.toUpperCase()}]** ` : ""
  if (!d.path) return `${label}${d.content}`.trim()
  return `\`${locationOf(d)}\`\n${label}${d.content}`
}

export function fmtDraft(c: DraftCheck, index: number): string {
  const d = c.draft
  const type = d.type ? ` [${d.type.toUpperCase()}]` : ""
  const who = d.author ? ` — ${d.author}` : ""
  const head = `${index}. ${locationOf(d)}${type}${who}`
  const text = d.content.split("\n").map((l) => `     ${l}`).join("\n")
  const near = c.near
    ? `\n     ⚠ near an existing ${c.near.resolved ? "resolved" : "open"} thread by ${c.near.author} at ${c.near.path}:${c.near.line}: ${c.near.body.split("\n")[0].slice(0, 80)}`
    : ""
  return `${head}\n${text}${near}`
}

interface DiffRefs {
  base: string
  start: string
  head: string
}

async function diffRefs(repoPath: string, iid: number): Promise<DiffRefs | null> {
  const res = await run("glab", ["api", `projects/:id/merge_requests/${iid}/versions`], { cwd: repoPath })
  if (!res.ok) return null
  try {
    const v = (JSON.parse(res.stdout) as { base_commit_sha: string; start_commit_sha: string; head_commit_sha: string }[])[0]
    return v ? { base: v.base_commit_sha, start: v.start_commit_sha, head: v.head_commit_sha } : null
  } catch {
    return null
  }
}

export interface PostResult {
  draft: Draft
  ok: boolean
  anchored: boolean
  url: string | null
  message: string
}

/**
 * Post one draft as an MR discussion. Line/range drafts are anchored inline
 * (JSON body — form fields silently lose the position); the anchor is read
 * back, and a draft GitLab cannot anchor falls back to a plain note that still
 * names the file and line. Review-level drafts are plain notes.
 */
export async function postDraft(repoPath: string, iid: number, mrUrl: string, draft: Draft, refs: DiffRefs | null): Promise<PostResult> {
  const body = bodyOf(draft)
  const plain = async (why: string): Promise<PostResult> => {
    const res = await run("glab", ["api", "--method", "POST", `projects/:id/merge_requests/${iid}/notes`, "-f", `body=${body}`], { cwd: repoPath })
    if (!res.ok) return { draft, ok: false, anchored: false, url: null, message: res.stderr.trim() || "note failed" }
    const id = (JSON.parse(res.stdout) as { id: number }).id
    return { draft, ok: true, anchored: false, url: `${mrUrl}#note_${id}`, message: why }
  }

  if (!draft.path || !draft.startLine || !refs) return plain(draft.path ? "no diff refs — plain note" : "review-level note")

  const line = draft.endLine ?? draft.startLine
  const position: Record<string, unknown> = {
    position_type: "text",
    base_sha: refs.base,
    start_sha: refs.start,
    head_sha: refs.head,
    new_path: draft.path,
    old_path: draft.path,
  }
  if (draft.side === "old") position.old_line = line
  else position.new_line = line
  const res = await run(
    "glab",
    ["api", "--method", "POST", `projects/:id/merge_requests/${iid}/discussions`, "-H", "Content-Type: application/json", "--input", "-"],
    { cwd: repoPath, stdin: JSON.stringify({ body, position }) },
  )
  if (!res.ok) return plain(`inline anchor rejected (${(res.stderr.trim() || "400").split("\n")[0].slice(0, 80)}) — plain note`)
  try {
    const d = JSON.parse(res.stdout) as { id: string; notes: GlabNote[] }
    const note = d.notes[0]
    const anchored = Boolean(note?.position && (note.position.new_line || note.position.old_line))
    if (anchored) return { draft, ok: true, anchored: true, url: `${mrUrl}#note_${note.id}`, message: "inline" }
    // GitLab accepted the note but dropped the anchor: replace it with an explicit plain note
    await run("glab", ["api", "--method", "DELETE", `projects/:id/merge_requests/${iid}/discussions/${d.id}/notes/${note.id}`], { cwd: repoPath })
    return plain("anchor dropped by GitLab — plain note")
  } catch {
    return { draft, ok: false, anchored: false, url: null, message: "could not parse GitLab response" }
  }
}

export async function postDrafts(repoPath: string, iid: number, mrUrl: string, drafts: Draft[]): Promise<PostResult[]> {
  const refs = await diffRefs(repoPath, iid)
  const results: PostResult[] = []
  for (const draft of drafts) results.push(await postDraft(repoPath, iid, mrUrl, draft, refs))
  return results
}

// ---------------------------------------------------------------------------
// .tuicrignore

const IGNORE_HEADER = [
  "# Files hidden from tuicr review diffs (gitignore syntax; ! re-includes).",
  "# Managed by cc-review hide/unhide; kept out of git via .git/info/exclude.",
]

export async function repoTop(cwd: string): Promise<string | null> {
  const res = await run("git", ["rev-parse", "--show-toplevel"], { cwd })
  return res.ok ? res.stdout.trim() : null
}

export function ignorePath(top: string): string {
  return join(top, ".tuicrignore")
}

export function readIgnore(top: string): string[] {
  const file = ignorePath(top)
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
}

function writeIgnore(top: string, patterns: string[]): void {
  writeFileSync(ignorePath(top), [...IGNORE_HEADER, ...patterns, ""].join("\n"))
}

/** Make sure git never sees .tuicrignore (shared info/exclude of the repo, so every worktree is covered). */
async function excludeFromGit(top: string): Promise<void> {
  const res = await run("git", ["rev-parse", "--git-common-dir"], { cwd: top })
  if (!res.ok) return
  const common = res.stdout.trim()
  const exclude = join(common.startsWith("/") ? common : join(top, common), "info", "exclude")
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : ""
  if (current.split("\n").some((l) => l.trim() === ".tuicrignore")) return
  mkdirSync(dirname(exclude), { recursive: true })
  appendFileSync(exclude, `${current.endsWith("\n") || current === "" ? "" : "\n"}.tuicrignore\n`)
}

/** Create .tuicrignore from config.review.hideFiles when the repo has none yet. Returns the active patterns. */
export async function seedIgnore(top: string): Promise<string[]> {
  await excludeFromGit(top)
  if (!existsSync(ignorePath(top))) writeIgnore(top, config().review.hideFiles)
  return readIgnore(top)
}

export async function hidePatterns(top: string, patterns: string[]): Promise<string[]> {
  const current = await seedIgnore(top)
  const merged = [...current]
  for (const p of patterns) if (!merged.includes(p)) merged.push(p)
  writeIgnore(top, merged)
  return merged
}

export async function unhidePatterns(top: string, patterns: string[]): Promise<string[]> {
  const current = await seedIgnore(top)
  const kept = current.filter((p) => !patterns.includes(p))
  writeIgnore(top, kept)
  return kept
}
