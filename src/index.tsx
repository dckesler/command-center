import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App } from "./App.tsx"

// The embedded Cursor SDK agent logs to the console in-process; anything
// written to the tty draws over the TUI frame, so route console output to a
// file instead.
const logFile = join(homedir(), ".config", "control-center", "tui.log")
mkdirSync(join(homedir(), ".config", "control-center"), { recursive: true })
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  console[level] = (...args: unknown[]) => {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} [${level}] ${args.map(String).join(" ")}\n`)
    } catch {
      // logging must never break the TUI
    }
  }
}

const renderer = await createCliRenderer({ exitOnCtrlC: true })
createRoot(renderer).render(<App />)
