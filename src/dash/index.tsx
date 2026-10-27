/**
 * cc-dash — per-project dashboard for the top-left pane of a project's
 * "central" tmux window. Read-only: shows PROJECT.md, the task tabs with their
 * ticket / MR / agent state, what is waiting on Daniel, and the latest worker
 * reports, refreshing as .cc/inbox.jsonl and the agent feed change.
 *
 *   bun run src/dash/index.tsx [<project-name> | <project-dir>]
 *
 * Without an argument the project is taken from the current directory.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { config, statePath } from "../config.ts"
import { Dash } from "./Dash.tsx"
import { DashSource, resolveProjectDir } from "./snapshot.ts"

const logFile = statePath("dash.log")
mkdirSync(config().dirs.config, { recursive: true })
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  console[level] = (...args: unknown[]) => {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} [${level}] ${args.map(String).join(" ")}\n`)
    } catch {
      // logging must never break the TUI
    }
  }
}

const dir = resolveProjectDir(process.argv[2], config().dirs.projects)
if (!dir) {
  process.stderr.write(
    `cc-dash: ${process.argv[2] ? `no project "${process.argv[2]}" under ${config().dirs.projects}` : "not inside a project directory — pass a project name"}\n`,
  )
  process.exit(2)
}

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  consoleMode: "disabled",
  openConsoleOnError: false,
  onDestroy: () => process.exit(0),
})
createRoot(renderer).render(<Dash source={new DashSource(dir)} />)
