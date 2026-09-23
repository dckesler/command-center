import { appendFileSync, mkdirSync } from "node:fs"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { config, statePath } from "./config.ts"
import { disposeAll } from "./agents/hub.ts"
import { App } from "./App.tsx"

// The embedded Cursor SDK agent logs to the console in-process; anything
// written to the tty draws over the TUI frame, so route console output to a
// file instead.
const logFile = statePath("tui.log")
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

let quitting = false

async function quit(): Promise<void> {
  if (quitting) return
  quitting = true
  try {
    await Promise.race([disposeAll(), new Promise((resolve) => setTimeout(resolve, 750))])
  } finally {
    process.exit(0)
  }
}

let root: ReturnType<typeof createRoot> | undefined
const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  // OpenTUI re-hooks console and pops an overlay over the frame on any
  // console.error (SDK hook warnings, a tool spawn failing). Everything is
  // already routed to tui.log above; keep the overlay off.
  consoleMode: "disabled",
  openConsoleOnError: false,
  // OpenTUI restores the tty in destroy() but does not exit the process.
  // Without process.exit the event loop stays up (fs.watch, SDK agents) and
  // the terminal looks frozen after the UI disappears.
  onDestroy: () => {
    try {
      root?.unmount()
    } catch {
      // unmount must not block quit
    }
    void quit()
  },
})
root = createRoot(renderer)
root.render(<App />)
