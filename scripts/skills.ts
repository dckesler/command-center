#!/usr/bin/env bun
/**
 * Skill management for the command center.
 *
 * The repo is the source of truth for two kinds of skills:
 *   skills/          first-party skills (committed files, edited here)
 *   .agents/skills/  third-party skills installed via the `skills` CLI
 *                    (committed copies; skills-lock.json records their source)
 *
 * `sync` symlinks both sets into ~/.agents/skills so every agent (hub
 * specialists, cursor-cli, claude — whose ~/.claude/skills links point at
 * ~/.agents/skills) picks them up. Dangling repo links are pruned.
 *
 * Usage:
 *   bun scripts/skills.ts sync                     (default)
 *   bun scripts/skills.ts add <owner/repo> [--skill <name>]
 *   bun scripts/skills.ts remove <skill-name>
 *   bun scripts/skills.ts list
 */
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const REPO = resolve(import.meta.dir, "..")
const FIRST_PARTY = join(REPO, "skills")
const THIRD_PARTY = join(REPO, ".agents", "skills")
const USER_SKILLS = join(homedir(), ".agents", "skills")
const LOCK = join(REPO, "skills-lock.json")

function skillDirs(path: string): string[] {
  if (!existsSync(path)) return []
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** Ensure ~/.agents/skills/<name> is a symlink to `target`. */
function linkOne(name: string, target: string): void {
  const linkPath = join(USER_SKILLS, name)
  if (isSymlink(linkPath)) {
    if (readlinkSync(linkPath) === target) return
    rmSync(linkPath)
  } else if (existsSync(linkPath)) {
    console.log(`  conflict: ~/.agents/skills/${name} is a real directory (not touching it).`)
    console.log(`            Move it into the repo or delete it, then rerun sync.`)
    return
  }
  symlinkSync(target, linkPath)
  console.log(`  linked ${name} → ${target.replace(REPO, "<repo>")}`)
}

function sync(): void {
  mkdirSync(USER_SKILLS, { recursive: true })
  for (const name of skillDirs(FIRST_PARTY)) linkOne(name, join(FIRST_PARTY, name))
  for (const name of skillDirs(THIRD_PARTY)) linkOne(name, join(THIRD_PARTY, name))
  // prune symlinks that point into the repo but whose target is gone
  for (const name of readdirSync(USER_SKILLS)) {
    const linkPath = join(USER_SKILLS, name)
    if (!isSymlink(linkPath)) continue
    const target = readlinkSync(linkPath)
    if (target.startsWith(REPO) && !existsSync(target)) {
      rmSync(linkPath)
      console.log(`  pruned stale link ${name}`)
    }
  }
  console.log("sync done")
}

function runSkillsCli(args: string[]): boolean {
  const result = spawnSync("npx", ["skills", ...args], { cwd: REPO, stdio: "inherit" })
  return result.status === 0
}

function add(args: string[]): void {
  if (args.length === 0) {
    console.error("usage: bun scripts/skills.ts add <owner/repo or url> [--skill <name>]")
    process.exit(1)
  }
  // --agent universal → copies into <repo>/.agents/skills + records in skills-lock.json
  if (!runSkillsCli(["add", ...args, "--agent", "universal", "-y"])) process.exit(1)
  sync()
  console.log("Skill added — commit .agents/skills/ and skills-lock.json to track it.")
}

function remove(name?: string): void {
  if (!name) {
    console.error("usage: bun scripts/skills.ts remove <skill-name>")
    process.exit(1)
  }
  if (skillDirs(THIRD_PARTY).includes(name)) {
    // third-party: let the CLI remove files + update the lock, then prune the link
    if (!runSkillsCli(["remove", name, "-y"])) process.exit(1)
  } else if (skillDirs(FIRST_PARTY).includes(name)) {
    rmSync(join(FIRST_PARTY, name), { recursive: true })
    console.log(`removed first-party skill skills/${name} (deletion will show in git)`)
  } else {
    console.error(`unknown skill "${name}" — see: bun scripts/skills.ts list`)
    process.exit(1)
  }
  sync()
}

function list(): void {
  console.log("first-party (skills/):")
  for (const name of skillDirs(FIRST_PARTY)) console.log(`  ${name}`)
  console.log("third-party (.agents/skills/, tracked in skills-lock.json):")
  const names = skillDirs(THIRD_PARTY)
  if (names.length === 0) {
    console.log("  (none)")
    return
  }
  let sources: Record<string, { source?: string }> = {}
  try {
    sources = (JSON.parse(readFileSync(LOCK, "utf8")) as { skills: typeof sources }).skills
  } catch {
    // lock missing/unreadable — list without sources
  }
  for (const name of names) console.log(`  ${name}${sources[name]?.source ? `  (from ${sources[name].source})` : ""}`)
}

const [command, ...rest] = process.argv.slice(2)
if (command === "add") add(rest)
else if (command === "remove" || command === "rm") remove(rest[0])
else if (command === "list" || command === "ls") list()
else if (command === "sync" || command === undefined) sync()
else {
  console.error(`unknown command "${command}" — use sync | add | remove | list`)
  process.exit(1)
}
