/**
 * cc-inbox — the central manager's report stream from the command line.
 * Specialists' report_to_central, `cc-report central` and central-bound TUI
 * events are all appended to inbox.jsonl (to: "central"). Only warn/attention
 * reports are also mailed into the agent's chat; everything else waits here.
 * The default call prints what the agent has not read yet and marks it read
 * (central/seen.json), which the dashboard's central tab uses to dim them.
 *
 *   bun run src/cli/inbox.ts [options]   (wrapped by skills/cc-inbox/cc-inbox)
 */
import { centralReports, readSeen, unseenReports, writeSeen } from "../data/central.ts"
import { formatClock, type InboxRecord } from "../data/inbox.ts"

const USAGE = `usage:
  cc-inbox                 unread reports (oldest first), then mark them read
  cc-inbox --peek          unread reports without marking them read
  cc-inbox --all [-n N]    the newest N reports regardless of read state (default 40)
  cc-inbox --count         just the number of unread reports
  cc-inbox --mark          mark everything read without printing

Severity: !! attention, ! warn (those were also mailed into your chat), blank = info.`

function fmt(r: InboxRecord): string {
  const d = new Date(r.ts)
  const day = d.toDateString() === new Date().toDateString() ? "" : `${d.getMonth() + 1}/${d.getDate()} `
  const mark = r.severity === "attention" ? "!!" : r.severity === "warn" ? " !" : "  "
  return `${day}${formatClock(r.ts)} ${mark} ${r.from}: ${r.summary}`
}

function main(argv: string[]): number {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE)
    return 0
  }
  const all = argv.includes("--all")
  const peek = argv.includes("--peek")
  const count = argv.includes("--count")
  const markOnly = argv.includes("--mark")
  const nIdx = argv.indexOf("-n")
  const n = nIdx !== -1 ? Number(argv[nIdx + 1]) || 40 : 40

  const reports = centralReports(2000)
  const unread = unseenReports(reports, readSeen())
  const newest = reports[reports.length - 1]

  if (count) {
    console.log(String(unread.length))
    return 0
  }
  if (markOnly) {
    if (newest) writeSeen(newest.id)
    console.log(`marked ${unread.length} report${unread.length === 1 ? "" : "s"} read`)
    return 0
  }
  if (all) {
    const slice = reports.slice(-n)
    if (slice.length === 0) console.log("no reports yet")
    for (const r of slice) console.log(fmt(r))
    return 0
  }
  if (unread.length === 0) {
    console.log("no unread reports")
    return 0
  }
  console.log(`${unread.length} unread report${unread.length === 1 ? "" : "s"}${peek ? " (not marked read)" : ""}:`)
  for (const r of unread) console.log(fmt(r))
  if (!peek && newest) writeSeen(newest.id)
  return 0
}

process.exit(main(process.argv.slice(2)))
