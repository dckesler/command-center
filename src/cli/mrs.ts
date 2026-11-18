/**
 * cc-mrs — the user's open merge requests, as the central agent sees them.
 * Lists every MR the glab login authored (any repo), with approvals, unresolved
 * review threads, pipeline, Jira status and whether a worktree/agent is on it;
 * shows the open threads of one MR; or hands the MRs that need work to
 * babysit-branch agents.
 *
 *   bun run src/cli/mrs.ts [options]   (wrapped by skills/cc-mrs/cc-mrs)
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { config, statePath } from "../config.ts"
import { sendMail } from "../data/mail.ts"
import {
  dispatchPass,
  findMyMr,
  fmtMyMr,
  fmtThread,
  listMyOpenMrs,
  mrNeedsPass,
  mrWaitingOnApproval,
  type MyMr,
  type PassResult,
} from "../data/mrs.ts"
import { runMkpanes, targetSession } from "../data/tmux.ts"

const USAGE = `usage:
  cc-mrs [list] [--since N] [--all] [--json]   open MRs you authored, newest activity first
      --since N   hide MRs with no GitLab activity for N days (default ${defaultSince()}); --all shows every one
      --waiting   only MRs waiting on approval (green, no open threads, not yet approved)
      --needs     only MRs that need work (unresolved threads, failed CI, conflicts)
  cc-mrs threads <!iid | branch | KEY>           the unresolved review threads of one MR
  cc-mrs pass [--dry-run] [<!iid | branch | KEY> ...]
      hand every MR that needs work (or just the named ones) to a babysit-branch agent:
      an agent already in the MR's worktree gets cc mail; otherwise mkpanes opens the worktree
      with a babysit-branch prompt. --dry-run prints the plan only.

Needs glab logged in. Each MR costs three GitLab calls; "list" is the one to run first.`

function defaultSince(): number {
  return config().mrs.sinceDays
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(name)
}

function numFlag(argv: string[], name: string, fallback: number): number {
  const i = argv.indexOf(name)
  if (i === -1) return fallback
  const n = Number(argv[i + 1])
  return Number.isFinite(n) ? n : fallback
}

function positionals(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--since") {
      i++
      continue
    }
    if (a.startsWith("--")) continue
    out.push(a)
  }
  return out
}

function summary(mrs: MyMr[]): string {
  const waiting = mrs.filter(mrWaitingOnApproval)
  const needs = mrs.filter(mrNeedsPass)
  const drafts = mrs.filter((m) => m.draft)
  const bits = [
    `${waiting.length} waiting on approval`,
    `${needs.length} need${needs.length === 1 ? "s" : ""} work (${needs.map((m) => `!${m.iid}`).join(", ") || "none"})`,
  ]
  if (drafts.length) bits.push(`${drafts.length} draft${drafts.length === 1 ? "" : "s"}`)
  return bits.join(" · ")
}

async function cmdList(argv: string[]): Promise<number> {
  const since = flag(argv, "--all") ? 0 : numFlag(argv, "--since", defaultSince())
  const result = await listMyOpenMrs({ sinceDays: since })
  if (result.error) {
    console.error(`cc-mrs: ${result.error}`)
    return 1
  }
  let mrs = result.mrs
  if (flag(argv, "--waiting")) mrs = mrs.filter(mrWaitingOnApproval)
  if (flag(argv, "--needs")) mrs = mrs.filter(mrNeedsPass)

  if (flag(argv, "--json")) {
    console.log(JSON.stringify({ username: result.username, hidden: result.hidden, mrs }, null, 2))
    return 0
  }
  const who = result.username ? ` by ${result.username}` : ""
  const window = since > 0 ? ` with activity in the last ${since} days` : ""
  console.log(`${mrs.length} open MR${mrs.length === 1 ? "" : "s"}${who}${window}:`)
  for (const mr of mrs) console.log(fmtMyMr(mr))
  if (mrs.length) console.log(summary(mrs))
  if (result.hidden) console.log(`${result.hidden} older MR${result.hidden === 1 ? "" : "s"} hidden (--all to include)`)
  return 0
}

async function cmdThreads(argv: string[]): Promise<number> {
  const refs = positionals(argv)
  if (refs.length === 0) {
    console.error("cc-mrs threads: which MR? (!iid, branch or ticket key)")
    return 2
  }
  const result = await listMyOpenMrs({ sinceDays: 0 })
  if (result.error) {
    console.error(`cc-mrs: ${result.error}`)
    return 1
  }
  let code = 0
  for (const ref of refs) {
    const mr = findMyMr(result.mrs, ref)
    if (!mr) {
      console.error(`cc-mrs: no open MR of yours matches ${ref}`)
      code = 1
      continue
    }
    console.log(fmtMyMr(mr))
    console.log(`  ${mr.url}`)
    if (mr.unresolved.length === 0) console.log("  no unresolved threads")
    for (const t of mr.unresolved) console.log(`  ${fmtThread(t)}`)
  }
  return code
}

async function cmdPass(argv: string[]): Promise<number> {
  const dryRun = flag(argv, "--dry-run")
  const refs = positionals(argv)
  const result = await listMyOpenMrs({ sinceDays: refs.length ? 0 : numFlag(argv, "--since", defaultSince()) })
  if (result.error) {
    console.error(`cc-mrs: ${result.error}`)
    return 1
  }
  let targets: MyMr[]
  if (refs.length) {
    targets = []
    for (const ref of refs) {
      const mr = findMyMr(result.mrs, ref)
      if (!mr) console.error(`cc-mrs: no open MR of yours matches ${ref}`)
      else targets.push(mr)
    }
  } else {
    targets = result.mrs.filter(mrNeedsPass)
  }
  if (targets.length === 0) {
    console.log("nothing to pass on: no open MR needs work")
    return 0
  }

  const user = config().user.name
  const session = await targetSession()
  const promptDir = statePath("mr-pass")
  const deps = {
    user,
    session,
    sendMail: (dir: string, text: string) => sendMail({ dir }, text, { from: "cc-mrs", severity: "attention" }),
    mkpanes: (args: string[], s: string | null) => runMkpanes(args, s),
    writePromptFile: (name: string, text: string) => {
      mkdirSync(promptDir, { recursive: true })
      const file = join(promptDir, name)
      writeFileSync(file, text)
      return file
    },
  }

  const results: PassResult[] = []
  for (const mr of targets) {
    if (dryRun) {
      const how = !mrNeedsPass(mr)
        ? "skip (nothing to address)"
        : !mr.repo
          ? `skip (no local checkout of ${mr.projectPath})`
          : mr.worktreePath && mr.agentState && mr.agentState !== "ended"
            ? `mail the agent in ${mr.tmuxWindow ?? mr.worktreePath}`
            : `mkpanes ${mr.repo} -w ${mr.branch} with a babysit-branch prompt${mr.worktreePath ? " (reuses the worktree)" : ""}`
      console.log(`${fmtMyMr(mr)}\n  → ${how}`)
      continue
    }
    const r = await dispatchPass(mr, deps)
    results.push(r)
    console.log(r.message)
  }
  if (dryRun) return 0
  const counts = { mailed: 0, launched: 0, skipped: 0 }
  for (const r of results) counts[r.action]++
  console.log(`pass: ${counts.mailed} mailed, ${counts.launched} launched, ${counts.skipped} skipped — agents report to central via cc-report as they finish`)
  return 0
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE)
    return 0
  }
  const [first, ...rest] = argv
  switch (first) {
    case undefined:
    case "list":
      return cmdList(first === undefined ? argv : rest)
    case "threads":
      return cmdThreads(rest)
    case "pass":
      return cmdPass(rest)
    default:
      if (first.startsWith("--")) return cmdList(argv)
      console.error(`cc-mrs: unknown command ${first}\n${USAGE}`)
      return 2
  }
}

process.exit(await main(process.argv.slice(2)))
