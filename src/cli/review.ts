/**
 * cc-review — the human-review half of a Command Center review worktree.
 * Opens tuicr on the MR in the window's spare pane, manages the files hidden
 * from the review diff (.tuicrignore), reads the comments the human drafted in
 * tuicr, and posts them to the GitLab MR as located, inline-anchored
 * discussions. Run from the review worktree. `cc-review local` is the same
 * loop turned inward: the human reviews an agent's own local changes and the
 * agent fixes what he marked — nothing is posted anywhere.
 *
 *   bun run src/cli/review.ts <command> …   (wrapped by skills/cc-review/cc-review)
 */
import { run } from "../data/exec.ts"
import { getMrByIid, getMrForBranch } from "../data/gitlab.ts"
import { flagTmux } from "../data/tmux.ts"
import {
  addDraft,
  addDraftNow,
  awaitLocalSession,
  checkDrafts,
  clearDrafts,
  clearDraftsOf,
  deleteDraft,
  deleteDraftOf,
  existingThreads,
  fmtDraft,
  fmtLocalDraft,
  hidePatterns,
  listSessions,
  localScope,
  localSession,
  localTuicrArgs,
  locationOf,
  postDrafts,
  readDrafts,
  readDraftsOf,
  readLocalState,
  repoTop,
  seedIgnore,
  tuicrInstalled,
  unhidePatterns,
  writeLocalState,
  type Draft,
} from "../data/tuicr.ts"

const USAGE = `usage (run inside the review worktree):
  cc-review open [<!iid>]              start \`tuicr mr <iid>\` in this window's spare pane (seeds .tuicrignore first)
  cc-review drafts [<!iid>]            the comments drafted in tuicr for this MR, flagged when near an existing thread
  cc-review post [<!iid>] [--only 1,3] [--keep] [--dry-run]
                                       post the drafts to the MR (inline where GitLab can anchor them), print URLs,
                                       then clear the drafts (--keep leaves them)
  cc-review add [<!iid>] --file <path> --line <n> [--end-line <n>] [--side old|new] [--type <t>] --author <who> <text>
                                       put a finding in front of the human as a tuicr draft
  cc-review hide <pattern> ...         add gitignore-style patterns to this repo's .tuicrignore (never committed)
  cc-review unhide <pattern> ...       remove patterns
  cc-review hidden                     list the active patterns
  cc-review local <open|drafts|add|resolve|status>
                                       the human reviews an agent's own local changes in tuicr; the agent addresses
                                       the comments in code, nothing is posted (cc-review local --help)

<!iid> defaults to the open MR of the current branch.`

interface Target {
  repoPath: string
  iid: number
  url: string
  title: string
}

function parseIid(arg: string | undefined): number | null {
  if (!arg) return null
  const m = arg.match(/^!?(\d+)$/) ?? arg.match(/merge_requests\/(\d+)/)
  return m ? Number(m[1]) : null
}

async function resolveTarget(arg: string | undefined): Promise<Target | { error: string }> {
  const top = await repoTop(process.cwd())
  if (!top) return { error: "not inside a git checkout" }
  const iid = parseIid(arg)
  if (iid) {
    const mr = await getMrByIid(top, iid)
    if (!mr) return { error: `no MR !${iid} in this project` }
    return { repoPath: top, iid: mr.iid, url: mr.webUrl, title: mr.title }
  }
  const branchRes = await run("git", ["branch", "--show-current"], { cwd: top })
  const branch = branchRes.stdout.trim()
  if (!branch) return { error: "detached HEAD — pass the MR as !<iid>" }
  const mr = await getMrForBranch(top, branch)
  if (!mr || mr.state !== "opened") return { error: `no open MR for branch ${branch} — pass !<iid>` }
  return { repoPath: top, iid: mr.iid, url: mr.url, title: mr.title }
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

const FLAGS_WITH_VALUE = new Set(["--only", "--file", "--line", "--end-line", "--side", "--type", "--author", "--base", "--path"])

function allPositionals(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (FLAGS_WITH_VALUE.has(argv[i])) {
      i++
      continue
    }
    if (!argv[i].startsWith("--")) out.push(argv[i])
  }
  return out
}

/** The MR reference, when given: `!123`, `123` or an MR URL. */
function positional(argv: string[]): string | undefined {
  return allPositionals(argv).find((p) => parseIid(p) !== null)
}

async function requireTuicr(): Promise<boolean> {
  if (await tuicrInstalled()) return true
  console.error("cc-review: tuicr is not installed (brew install tuicr)")
  return false
}

// ---------------------------------------------------------------------------

interface SparePane {
  windowId: string
  paneId: string
  width: number
  windowWidth: number
}

/**
 * The tmux window whose panes sit in `repoPath` and its idle top-row shell
 * pane (not the agent pane) where tuicr can run — the top-right pane mkpanes
 * leaves empty. Returns a message instead when there is none.
 */
async function findSparePane(repoPath: string, fallbackCmd: string): Promise<SparePane | { note: string } | { error: string }> {
  const panes = await run("tmux", [
    "list-panes", "-a", "-F",
    "#{pane_id}\t#{window_id}\t#{pane_current_path}\t#{pane_top}\t#{pane_left}\t#{pane_current_command}\t#{@agent_pane}\t#{pane_width}\t#{window_width}",
  ])
  if (!panes.ok) return { error: `tmux is not running — open it yourself: ${fallbackCmd}` }
  const rows = panes.stdout.trim().split("\n").map((l) => l.split("\t"))
  // prefer the window this process runs in (TMUX_PANE), else any window in the repo
  const own = process.env.TMUX_PANE ? rows.find((r) => r[0] === process.env.TMUX_PANE && r[2] === repoPath) : undefined
  const windowId = own?.[1] ?? rows.find((r) => r[2] === repoPath)?.[1]
  if (!windowId) return { note: `no tmux window is in ${repoPath}; run: ${fallbackCmd}` }
  const inWindow = rows.filter((r) => r[1] === windowId)
  const agentPane = inWindow[0]?.[6]
  const already = inWindow.find((r) => r[5] === "tuicr")
  if (already) return { note: `tuicr already running in pane ${already[0]} of window ${windowId}` }
  const spare = inWindow
    .filter((r) => r[3] === "0" && r[0] !== agentPane && /^(zsh|bash|fish|sh)$/.test(r[5]))
    .sort((a, b) => Number(b[4]) - Number(a[4]))[0]
  if (!spare) return { note: `no idle top-row pane in window ${windowId}; run in a pane: ${fallbackCmd}` }
  return { windowId, paneId: spare[0], width: Number(spare[7]) || 0, windowWidth: Number(spare[8]) || 0 }
}

async function cmdOpen(argv: string[]): Promise<number> {
  if (!(await requireTuicr())) return 1
  const t = await resolveTarget(positional(argv))
  if ("error" in t) return fail(t.error)
  const patterns = await seedIgnore(t.repoPath)
  const spare = await findSparePane(t.repoPath, `tuicr mr ${t.iid}`)
  if ("error" in spare) return fail(spare.error)
  if ("note" in spare) {
    console.log(spare.note)
    return 0
  }
  await run("tmux", ["send-keys", "-t", spare.paneId, `cd '${t.repoPath}' && clear && tuicr mr ${t.iid}`, "Enter"])
  console.log(`tuicr mr ${t.iid} (${t.title}) started in pane ${spare.paneId}; hiding ${patterns.length} pattern${patterns.length === 1 ? "" : "s"} (cc-review hidden)`)
  return 0
}

// ---------------------------------------------------------------------------
// local reviews (no GitLab)

const LOCAL_USAGE = `usage (run inside the checkout the agent is working in):
  cc-review local open [--base <ref|A..B>] [--working-tree] [--commits] [--path <p> ...]
                                       start tuicr on this branch's changes (commits since the branch point + uncommitted,
                                       by default) in this window's spare pane, widen it, and flag the window for the human
  cc-review local drafts [--json]      the comments the human left, numbered, with the code they point at
  cc-review local add --file <path> --line <n> [--end-line <n>] [--side old|new] [--type <t>] --author <who> <text>
                                       reply beside a comment (pushback, a question) as a tuicr draft
  cc-review local resolve <n ...|all>  remove addressed comments so the next \`drafts\` shows only what is left
  cc-review local status               is tuicr open, how many comments, what scope

Local comments never go to GitLab; the agent addresses them in code.`

async function localTarget(): Promise<string | { error: string }> {
  const top = await repoTop(process.cwd())
  return top ?? { error: "not inside a git checkout" }
}

function flagValues(argv: string[], name: string): string[] {
  const out: string[] = []
  argv.forEach((a, i) => {
    if (a === name && argv[i + 1]) out.push(argv[i + 1])
  })
  return out
}

/** Put the pane back to the width it had before `local open` widened it, once tuicr is gone from it. */
async function restorePane(repoPath: string): Promise<void> {
  const state = readLocalState(repoPath)
  if (!state?.pane || state.restoreWidth === null) return
  const cmd = await run("tmux", ["display-message", "-p", "-t", state.pane, "#{pane_current_command}"])
  if (!cmd.ok) {
    writeLocalState(repoPath, { ...state, pane: null, restoreWidth: null })
    return
  }
  if (cmd.stdout.trim() === "tuicr") return
  await run("tmux", ["resize-pane", "-t", state.pane, "-x", String(state.restoreWidth)])
  writeLocalState(repoPath, { ...state, restoreWidth: null })
}

async function cmdLocalOpen(argv: string[]): Promise<number> {
  if (!(await requireTuicr())) return 1
  const repoPath = await localTarget()
  if (typeof repoPath !== "string") return fail(repoPath.error)
  const scope = await localScope(repoPath, {
    base: flagValue(argv, "--base"),
    workingTreeOnly: argv.includes("--working-tree"),
    commitsOnly: argv.includes("--commits"),
  })
  if (!scope.workingTree && !scope.range) return fail("nothing to review: no uncommitted changes and no commits past the branch point")
  if (scope.workingTree && scope.dirtyFiles === 0 && !scope.range) return fail("nothing to review: the working tree is clean")
  const paths = flagValues(argv, "--path")
  const tuicrCmd = `tuicr ${localTuicrArgs(scope, paths).map((a) => (/[\s'"]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(" ")}`
  const patterns = await seedIgnore(repoPath)
  const spare = await findSparePane(repoPath, tuicrCmd)
  if ("error" in spare) return fail(spare.error)
  if ("note" in spare) {
    console.log(spare.note)
    return 0
  }
  const before = new Set((await listSessions(repoPath)).filter((s) => s.kind === "local").map((s) => s.slug))
  // tuicr wants room: at least half the window
  let restoreWidth: number | null = null
  if (spare.windowWidth && spare.width < Math.floor(spare.windowWidth / 2)) {
    restoreWidth = spare.width
    await run("tmux", ["resize-pane", "-t", spare.paneId, "-x", "50%"])
  }
  await run("tmux", ["send-keys", "-t", spare.paneId, `cd '${repoPath}' && clear && ${tuicrCmd}`, "Enter"])
  flagTmux("attention", { window: spare.windowId })
  const session = await awaitLocalSession(repoPath, before)
  writeLocalState(repoPath, {
    slug: session?.slug ?? null,
    pane: spare.paneId,
    window: spare.windowId,
    restoreWidth,
    openedAt: new Date().toISOString(),
    scope,
  })
  const what = [
    scope.range ? `${scope.commits} commit${scope.commits === 1 ? "" : "s"} since ${scope.baseLabel}` : null,
    scope.workingTree ? `${scope.dirtyFiles} uncommitted file${scope.dirtyFiles === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" + ")
  console.log(`${tuicrCmd} started in pane ${spare.paneId} (${what}); hiding ${patterns.length} pattern${patterns.length === 1 ? "" : "s"}`)
  console.log(session ? `session ${session.slug}` : "tuicr session not visible yet — cc-review local drafts finds it when he has commented")
  console.log("Wait for him to say he is done, then: cc-review local drafts")
  return 0
}

async function cmdLocalDrafts(argv: string[]): Promise<number> {
  if (!(await requireTuicr())) return 1
  const repoPath = await localTarget()
  if (typeof repoPath !== "string") return fail(repoPath.error)
  await restorePane(repoPath)
  const session = await localSession(repoPath)
  if (!session) {
    console.log("no local tuicr session for this checkout — he left no comments (tuicr drops an empty session on :q), or tuicr is not open yet (cc-review local open)")
    return 0
  }
  const read = await readDraftsOf(repoPath, session.slug)
  if ("error" in read) return fail(read.error)
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ slug: session.slug, drafts: read.drafts }, null, 2))
    return 0
  }
  if (read.drafts.length === 0) {
    console.log(`no comments in tuicr session ${session.slug}`)
    return 0
  }
  console.log(`${read.drafts.length} comment${read.drafts.length === 1 ? "" : "s"} (session ${session.slug}):`)
  read.drafts.forEach((d, i) => console.log(fmtLocalDraft(repoPath, d, i + 1)))
  console.log("Address each in code, then: cc-review local resolve <n ...|all>. Reply beside one with cc-review local add.")
  return 0
}

async function cmdLocalAdd(argv: string[]): Promise<number> {
  if (!(await requireTuicr())) return 1
  const repoPath = await localTarget()
  if (typeof repoPath !== "string") return fail(repoPath.error)
  const session = await localSession(repoPath)
  if (!session) return fail("no local tuicr session — open one first (cc-review local open) and have him comment, or add after his first comment")
  const file = flagValue(argv, "--file")
  const line = Number(flagValue(argv, "--line")) || undefined
  const endLine = Number(flagValue(argv, "--end-line")) || undefined
  const side = flagValue(argv, "--side") as "old" | "new" | undefined
  const type = flagValue(argv, "--type")
  const author = flagValue(argv, "--author")
  const text = allPositionals(argv).slice(-1)[0]
  if (!author || !text) return fail("--author and the comment text are required")
  const res = await addDraftNow(repoPath, session.slug, { path: file, line, endLine, side, type, author, content: text })
  if (!res.ok) return fail(res.message)
  console.log(`draft added: ${file ? `${file}${line ? `:${line}` : ""}` : "(review)"}`)
  return 0
}

async function cmdLocalResolve(argv: string[]): Promise<number> {
  if (!(await requireTuicr())) return 1
  const repoPath = await localTarget()
  if (typeof repoPath !== "string") return fail(repoPath.error)
  const session = await localSession(repoPath)
  if (!session) return fail("no local tuicr session for this checkout")
  const read = await readDraftsOf(repoPath, session.slug)
  if ("error" in read) return fail(read.error)
  const picks = allPositionals(argv)
  if (picks.length === 0) return fail("which comments? numbers from cc-review local drafts, or all")
  if (picks.includes("all")) {
    const ok = await clearDraftsOf(repoPath, session.slug)
    if (!ok) return fail("tuicr review clearc failed")
    console.log(`resolved all ${read.drafts.length} comment${read.drafts.length === 1 ? "" : "s"}`)
    return 0
  }
  const idx = picks.map((p) => Number(p)).filter((n) => Number.isInteger(n) && n >= 1 && n <= read.drafts.length)
  if (idx.length === 0) return fail(`no such comment numbers (1-${read.drafts.length})`)
  let done = 0
  for (const n of idx) {
    const d = read.drafts[n - 1]
    if (await deleteDraftOf(repoPath, session.slug, d.id)) {
      done++
      console.log(`✓ ${n}. ${locationOf(d)}`)
    } else console.log(`✗ ${n}. ${locationOf(d)} — delete failed`)
  }
  const left = read.drafts.length - done
  console.log(left ? `${left} comment${left === 1 ? "" : "s"} left (cc-review local drafts)` : "all comments resolved")
  return done === idx.length ? 0 : 1
}

async function cmdLocalStatus(): Promise<number> {
  const repoPath = await localTarget()
  if (typeof repoPath !== "string") return fail(repoPath.error)
  const state = readLocalState(repoPath)
  const session = await localSession(repoPath)
  let open = false
  if (state?.pane) {
    const cmd = await run("tmux", ["display-message", "-p", "-t", state.pane, "#{pane_current_command}"])
    open = cmd.ok && cmd.stdout.trim() === "tuicr"
  }
  const count = session ? ((await readDraftsOf(repoPath, session.slug)) as { drafts?: Draft[] }).drafts?.length ?? 0 : 0
  const scope = state?.scope
  const what = scope
    ? [scope.range ? `${scope.commits} commit${scope.commits === 1 ? "" : "s"} since ${scope.baseLabel}` : null, scope.workingTree ? "uncommitted changes" : null].filter(Boolean).join(" + ")
    : "not opened by cc-review"
  console.log(`tuicr: ${open ? `open in pane ${state?.pane}` : "not open"}${state ? ` (opened ${state.openedAt})` : ""}`)
  console.log(`scope: ${what}`)
  console.log(session ? `session: ${session.slug} — ${count} comment${count === 1 ? "" : "s"}` : "session: none (no comments yet)")
  return 0
}

async function cmdLocal(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  switch (sub) {
    case "open":
      return cmdLocalOpen(rest)
    case "drafts":
      return cmdLocalDrafts(rest)
    case "add":
      return cmdLocalAdd(rest)
    case "resolve":
      return cmdLocalResolve(rest)
    case "status":
      return cmdLocalStatus()
    default:
      console.log(LOCAL_USAGE)
      return sub && sub !== "-h" && sub !== "--help" ? 2 : 0
  }
}

async function loadChecked(t: Target) {
  const read = await readDrafts(t.repoPath, t.iid)
  if ("error" in read) return read
  const threads = await existingThreads(t.repoPath, t.iid)
  return { slug: read.slug, checks: checkDrafts(read.drafts, threads), threads }
}

async function cmdDrafts(argv: string[]): Promise<number> {
  if (!(await requireTuicr())) return 1
  const t = await resolveTarget(positional(argv))
  if ("error" in t) return fail(t.error)
  const loaded = await loadChecked(t)
  if ("error" in loaded) return fail(loaded.error)
  if (loaded.checks.length === 0) {
    console.log(`no drafts in tuicr for !${t.iid} (session ${loaded.slug})`)
    return 0
  }
  console.log(`${loaded.checks.length} draft${loaded.checks.length === 1 ? "" : "s"} for !${t.iid} ${t.title}:`)
  loaded.checks.forEach((c, i) => console.log(fmtDraft(c, i + 1)))
  const open = loaded.threads.filter((th) => !th.resolved).length
  console.log(`MR has ${loaded.threads.length} existing thread${loaded.threads.length === 1 ? "" : "s"} (${open} open). Post with: cc-review post !${t.iid} [--only 1,2]`)
  return 0
}

async function cmdPost(argv: string[]): Promise<number> {
  if (!(await requireTuicr())) return 1
  const t = await resolveTarget(positional(argv))
  if ("error" in t) return fail(t.error)
  const loaded = await loadChecked(t)
  if ("error" in loaded) return fail(loaded.error)
  let drafts: Draft[] = loaded.checks.map((c) => c.draft)
  const only = flagValue(argv, "--only")
  if (only) {
    const idx = only.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 1)
    drafts = idx.map((n) => drafts[n - 1]).filter((d): d is Draft => Boolean(d))
  }
  if (drafts.length === 0) {
    console.log("nothing to post")
    return 0
  }
  const dryRun = argv.includes("--dry-run")
  console.log(`${dryRun ? "would post" : "posting"} ${drafts.length} comment${drafts.length === 1 ? "" : "s"} to !${t.iid} ${t.url}`)
  if (dryRun) {
    for (const d of drafts) console.log(`- ${locationOf(d)}${d.type ? ` [${d.type.toUpperCase()}]` : ""}: ${d.content.split("\n")[0].slice(0, 100)}`)
    return 0
  }
  const results = await postDrafts(t.repoPath, t.iid, t.url, drafts)
  let failed = 0
  for (const r of results) {
    if (!r.ok) failed++
    const mark = r.ok ? (r.anchored ? "✓" : "~") : "✗"
    console.log(`${mark} ${locationOf(r.draft)} — ${r.message}${r.url ? ` ${r.url}` : ""}`)
  }
  if (failed === 0 && !argv.includes("--keep")) {
    if (only) {
      // only some posted: clear just those
      for (const r of results) await deleteDraft(t.repoPath, t.iid, r.draft.id)
    } else {
      await clearDrafts(t.repoPath, t.iid)
    }
    console.log("drafts cleared from tuicr")
  } else if (failed) {
    console.log(`${failed} failed — drafts kept in tuicr; fix and re-run`)
  }
  console.log("✓ inline  ~ plain note (file:line in the body)  ✗ failed")
  return failed ? 1 : 0
}

async function cmdAdd(argv: string[]): Promise<number> {
  if (!(await requireTuicr())) return 1
  const t = await resolveTarget(positional(argv))
  if ("error" in t) return fail(t.error)
  const file = flagValue(argv, "--file")
  const line = Number(flagValue(argv, "--line")) || undefined
  const endLine = Number(flagValue(argv, "--end-line")) || undefined
  const side = flagValue(argv, "--side") as "old" | "new" | undefined
  const type = flagValue(argv, "--type")
  const author = flagValue(argv, "--author")
  const positionals = allPositionals(argv)
  const text = positionals.filter((p) => !parseIid(p)).slice(-1)[0]
  if (!author || !text) return fail("--author and the comment text are required")
  const res = await addDraft(t.repoPath, t.iid, { path: file, line, endLine, side, type, author, content: text })
  if (!res.ok) return fail(res.message)
  console.log(`draft added for !${t.iid}: ${file ? `${file}${line ? `:${line}` : ""}` : "(review)"}`)
  return 0
}

async function cmdHide(argv: string[], remove: boolean): Promise<number> {
  const top = await repoTop(process.cwd())
  if (!top) return fail("not inside a git checkout")
  const patterns = argv.filter((a) => !a.startsWith("--"))
  if (patterns.length === 0) return fail("which patterns?")
  const active = remove ? await unhidePatterns(top, patterns) : await hidePatterns(top, patterns)
  console.log(`${remove ? "unhid" : "hiding"} ${patterns.join(", ")} — ${active.length} pattern${active.length === 1 ? "" : "s"} in ${top}/.tuicrignore${active.length ? `:\n  ${active.join("\n  ")}` : ""}`)
  console.log("tuicr applies the file on its next start (:q and cc-review open again).")
  return 0
}

async function cmdHidden(): Promise<number> {
  const top = await repoTop(process.cwd())
  if (!top) return fail("not inside a git checkout")
  const active = await seedIgnore(top)
  console.log(active.length ? `${top}/.tuicrignore:\n  ${active.join("\n  ")}` : `${top}/.tuicrignore is empty`)
  return 0
}

function fail(msg: string): number {
  console.error(`cc-review: ${msg}`)
  return 1
}

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE)
    return argv.length === 0 ? 2 : 0
  }
  const [cmd, ...rest] = argv
  switch (cmd) {
    case "open":
      return cmdOpen(rest)
    case "drafts":
      return cmdDrafts(rest)
    case "post":
      return cmdPost(rest)
    case "add":
      return cmdAdd(rest)
    case "hide":
      return cmdHide(rest, false)
    case "unhide":
      return cmdHide(rest, true)
    case "hidden":
      return cmdHidden()
    case "local":
      return cmdLocal(rest)
    default:
      console.error(`cc-review: unknown command ${cmd}\n${USAGE}`)
      return 2
  }
}

process.exit(await main(process.argv.slice(2)))
