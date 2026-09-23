#!/usr/bin/env bun
/**
 * First-run setup and health check for a fresh checkout.
 *
 *   bun run setup    create config.json from the example, link the agent hook
 *                    script, sync skills, link the skill CLIs into ~/.local/bin,
 *                    then run the checks below
 *   bun run doctor   checks only
 *
 * Nothing here needs sudo or touches files outside $CC_CONFIG_DIR, ~/.agents/skills
 * and ~/.local/bin. Hook wiring into ~/.cursor/hooks.json / ~/.claude/settings.json
 * is printed, not written — those files are yours.
 */
import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { config, configPath } from "../src/config.ts"

const REPO = resolve(import.meta.dir, "..")
const HOME = homedir()
const LOCAL_BIN = join(HOME, ".local", "bin")
const SKILL_BINS = ["cc-report", "start-project", "project-task"]
const checksOnly = process.argv.includes("doctor") || process.argv.includes("--check")

const ok = (msg: string) => console.log(`  ✓ ${msg}`)
const warn = (msg: string) => console.log(`  ! ${msg}`)
const bad = (msg: string) => console.log(`  ✗ ${msg}`)
const tilde = (p: string) => p.replace(HOME, "~")

function which(cmd: string): string | null {
  const res = spawnSync("/bin/sh", ["-lc", `command -v ${cmd}`], { encoding: "utf8" })
  const out = res.stdout.trim()
  return res.status === 0 && out ? out : null
}

/** Does the user's interactive shell know `cmd` (binary, function or alias)? */
function shellKnows(cmd: string): boolean {
  const shell = process.env.SHELL || "/bin/zsh"
  const res = spawnSync(shell, ["-ic", `command -v ${cmd} >/dev/null 2>&1 || alias ${cmd} >/dev/null 2>&1`], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 5000,
  })
  return res.status === 0
}

function linkInto(dir: string, name: string, target: string): void {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  try {
    if (lstatSync(path).isSymbolicLink()) {
      if (readlinkSync(path) === target) return
      rmSync(path)
    } else {
      warn(`${tilde(path)} exists and is not a symlink — left alone`)
      return
    }
  } catch {
    // does not exist
  }
  symlinkSync(target, path)
  ok(`linked ${tilde(path)} → ${tilde(target)}`)
}

// ---------------------------------------------------------------------------
// setup steps

if (!checksOnly) {
  console.log("setup")
  const cfg = config()
  mkdirSync(cfg.dirs.config, { recursive: true })

  if (!existsSync(configPath())) {
    copyFileSync(join(REPO, "config.example.json"), configPath())
    ok(`created ${tilde(configPath())} from config.example.json — edit it (user, jira, commands)`)
  } else {
    ok(`config ${tilde(configPath())} exists`)
  }

  const envFile = join(REPO, ".env")
  if (!existsSync(envFile)) {
    copyFileSync(join(REPO, ".env.example"), envFile)
    ok("created .env from .env.example — fill in CURSOR_API_KEY, JIRA_EMAIL, JIRA_API_TOKEN")
  }

  linkInto(cfg.dirs.config, "agent-event.sh", join(REPO, "hooks", "agent-event.sh"))

  const sync = spawnSync("bun", [join(REPO, "scripts", "skills.ts"), "sync"], { stdio: "inherit" })
  if (sync.status !== 0) bad("skills sync failed")

  for (const name of SKILL_BINS) linkInto(LOCAL_BIN, name, join(REPO, "skills", name, name))
  console.log()
}

// ---------------------------------------------------------------------------
// checks

console.log("doctor")
const cfg = config()

ok(`config dir ${tilde(cfg.dirs.config)}${existsSync(configPath()) ? "" : " (no config.json yet — defaults in use)"}`)
if (cfg.user.name === "the user") warn("user.name not set — agents will say \"the user\"")
if (!cfg.jira.baseUrl) warn("jira.baseUrl not set — ticket links and status transitions are off")
existsSync(cfg.dirs.projects) ? ok(`projects dir ${tilde(cfg.dirs.projects)}`) : warn(`projects dir ${tilde(cfg.dirs.projects)} does not exist (Projects tab will be empty)`)

const required: [string, string][] = [
  ["bun", "runtime (brew install oven-sh/bun/bun)"],
  ["tmux", "windows for agents (brew install tmux)"],
  ["git", ""],
  ["jq", "used by cc-report and the hook script (brew install jq)"],
]
for (const [cmd, why] of required) (which(cmd) ? ok : bad)(`${cmd}${why ? ` — ${why}` : ""}`)

const optional: [string, string][] = [
  ["glab", "GitLab MRs/CI on the worktrees tab"],
  ["acli", "Jira tickets/epics tabs (Atlassian CLI)"],
  ["m365", "Email tab (CLI for Microsoft 365)"],
  ["alacritty", "new OS windows for projects (commands.terminal)"],
]
for (const [cmd, why] of optional) (which(cmd) ? ok : warn)(`${cmd} — ${why}${which(cmd) ? "" : " (optional, not found)"}`)

shellKnows(cfg.commands.agent)
  ? ok(`agent command "${cfg.commands.agent}" resolves in ${process.env.SHELL || "your shell"}`)
  : bad(`agent command "${cfg.commands.agent}" is not a command or alias in ${process.env.SHELL || "your shell"} — set commands.agent in config.json`)

existsSync(cfg.commands.mkpanes)
  ? ok(`mkpanes at ${tilde(cfg.commands.mkpanes)}`)
  : warn(`mkpanes not found at ${tilde(cfg.commands.mkpanes)} — worktree launches disabled; set commands.mkpanes or repos in config.json`)

const hook = join(cfg.dirs.config, "agent-event.sh")
existsSync(hook) ? ok(`hook script ${tilde(hook)}`) : warn(`hook script missing — run: bun run setup`)
const cursorHooks = join(HOME, ".cursor", "hooks.json")
const cursorText = existsSync(cursorHooks) ? readFileSync(cursorHooks, "utf8") : ""
cursorText.includes("agent-event.sh")
  ? ok("~/.cursor/hooks.json calls agent-event.sh")
  : warn("~/.cursor/hooks.json does not call agent-event.sh — merge hooks/cursor-hooks.example.json (agent status will not show)")

for (const v of ["CURSOR_API_KEY"]) (process.env[v] ? ok : bad)(`${v}${process.env[v] ? "" : " missing — hub specialists will not start (.env)"}`)
for (const v of ["JIRA_EMAIL", "JIRA_API_TOKEN"]) (process.env[v] ? ok : warn)(`${v}${process.env[v] ? "" : " missing — Jira status changes disabled (.env)"}`)

const m365 = which("m365") ? spawnSync("m365", ["status", "--output", "text"], { encoding: "utf8", timeout: 15000 }) : null
if (m365) {
  m365.stdout.includes("Logged out") || !m365.stdout.trim()
    ? warn("m365 is logged out — Email tab needs: m365 login --authType deviceCode (requires admin-consented Mail.Read + Calendars.Read)")
    : ok("m365 logged in")
}
