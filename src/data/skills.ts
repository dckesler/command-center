import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "../config.ts"

/**
 * Index of the agent skills installed on this machine, so the chat panes can
 * recognise `/skill-name args` and hand the specialist an explicit "read this
 * SKILL.md and follow it" instruction instead of hoping the model notices.
 */

export interface Skill {
  name: string
  description: string
  /** absolute path to SKILL.md */
  path: string
}

const HOME = homedir()

/** Directories whose immediate children are skill folders (config.dirs.skills + plugins + this repo). */
function skillRoots(): string[] {
  const roots = [...config().dirs.skills, join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills")]
  // Cursor plugins: ~/.cursor/plugins/cache/<publisher>/<plugin>/<sha>/skills/<skill>
  const cache = join(HOME, ".cursor", "plugins", "cache")
  for (const publisher of listDirs(cache)) {
    for (const plugin of listDirs(join(cache, publisher))) {
      for (const sha of listDirs(join(cache, publisher, plugin))) {
        roots.push(join(cache, publisher, plugin, sha, "skills"))
      }
    }
  }
  return roots
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."))
      .filter((e) => {
        try {
          return statSync(join(dir, e.name)).isDirectory()
        } catch {
          return false
        }
      })
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** name + description from SKILL.md frontmatter; description may be a `>-` block. */
export function parseFrontmatter(markdown: string): { name?: string; description?: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const out: { name?: string; description?: string } = {}
  const lines = match[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(name|description):\s*(.*)$/)
    if (!m) continue
    const key = m[1] as "name" | "description"
    let value = m[2].trim()
    if (value === "" || /^[>|]-?$/.test(value)) {
      const parts: string[] = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim())
      value = parts.join(" ")
    }
    out[key] = value.replace(/^["']|["']$/g, "").replace(/\\(["'])/g, "$1")
  }
  return out
}

let cache: Skill[] | null = null
let cachedAt = 0
const TTL_MS = 60_000

/** All installed skills, deduped by real path, sorted by name. Cached for a minute. */
export function listSkills(force = false): Skill[] {
  if (!force && cache && Date.now() - cachedAt < TTL_MS) return cache
  const seen = new Set<string>()
  const byName = new Map<string, Skill>()
  for (const root of skillRoots()) {
    for (const dir of listDirs(root)) {
      const file = join(root, dir, "SKILL.md")
      if (!existsSync(file)) continue
      let real: string
      try {
        real = realpathSync(file)
      } catch {
        continue
      }
      if (seen.has(real)) continue
      seen.add(real)
      let fm: { name?: string; description?: string } = {}
      try {
        fm = parseFrontmatter(readFileSync(real, "utf8"))
      } catch {
        // unreadable skill: skip
      }
      const name = (fm.name || dir).trim()
      if (byName.has(name)) continue // first root wins
      byName.set(name, { name, description: (fm.description || "").replace(/\s+/g, " ").trim(), path: real })
    }
  }
  cache = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  cachedAt = Date.now()
  return cache
}

export function findSkill(name: string): Skill | null {
  const key = name.toLowerCase()
  return listSkills().find((s) => s.name.toLowerCase() === key) ?? null
}

const SLASH = /^\/([A-Za-z0-9][\w.-]*)(?:\s+([\s\S]*))?$/

/** A `/name` token in the draft: at the start or after whitespace, not a path. */
export interface SlashToken {
  start: number
  /** exclusive */
  end: number
  name: string
  /** the token is still being typed (nothing after it yet) */
  active: boolean
  /** exact skill / builtin, a prefix of some skills, or nothing */
  match: "skill" | "builtin" | "partial" | "none"
  /** number of skills the (partial) name prefixes */
  matches: number
}

const TOKEN = /(^|\s)\/([\w.-]*)(?=\s|$)/g
const BUILTINS = ["skills", "help"]

/**
 * Every `/name` token in the text, classified against the skill index. Used
 * for live colouring while typing and for finding referenced skills on send.
 * `/Users/…` style paths do not match (a second `/` follows the name).
 */
export function scanSlashTokens(text: string): SlashToken[] {
  const skills = listSkills()
  const out: SlashToken[] = []
  for (const m of text.matchAll(TOKEN)) {
    const start = (m.index ?? 0) + m[1].length
    const name = m[2]
    const end = start + 1 + name.length
    const active = end === text.length
    const lower = name.toLowerCase()
    let match: SlashToken["match"] = "none"
    let matches = 0
    if (BUILTINS.includes(lower)) {
      match = "builtin"
      matches = 1
    } else if (skills.some((s) => s.name.toLowerCase() === lower)) {
      match = "skill"
      matches = 1
    } else {
      matches = skills.filter((s) => s.name.toLowerCase().startsWith(lower)).length + BUILTINS.filter((b) => b.startsWith(lower)).length
      if (matches > 0) match = "partial"
    }
    out.push({ start, end, name, active, match, matches })
  }
  return out
}

/** Skills referenced anywhere in the text (exact `/name` tokens), deduped. */
export function referencedSkills(text: string): Skill[] {
  const seen = new Set<string>()
  const out: Skill[] = []
  for (const t of scanSlashTokens(text)) {
    if (t.match !== "skill") continue
    const skill = findSkill(t.name)
    if (skill && !seen.has(skill.name)) {
      seen.add(skill.name)
      out.push(skill)
    }
  }
  return out
}

export type SlashResult =
  | { kind: "none" }
  | { kind: "list"; skills: Skill[] }
  | { kind: "unknown"; name: string; suggestions: Skill[] }
  /** the whole message is `/skill args` */
  | { kind: "skill"; skill: Skill; args: string; payload: string }
  /** free text that mentions one or more `/skill` tokens */
  | { kind: "mentions"; skills: Skill[]; payload: string }

/**
 * Interpret chat input. A message that *is* `/<name> args` becomes an
 * explicit skill instruction (`/skills` lists what is installed; an unknown
 * leading `/name` is rejected). A message that merely *mentions* `/name`
 * tokens is sent as typed with a footnote telling the agent where each
 * referenced SKILL.md lives.
 */
export function parseSlash(text: string): SlashResult {
  const m = text.trim().match(SLASH)
  if (m) {
    const name = m[1]
    const args = (m[2] ?? "").trim()
    if (name === "skills" || name === "help") return { kind: "list", skills: listSkills() }
    const skill = findSkill(name)
    if (skill) {
      const payload =
        `Use the "${skill.name}" skill: read ${skill.path} in full and follow its instructions now.` +
        (args ? `\nArguments: ${args}` : "\nNo arguments were given; if the skill needs some, ask.")
      return { kind: "skill", skill, args, payload }
    }
    // `/typo` alone (or with args): not a path, not a skill → reject locally.
    if (!/\s/.test(text.trim()) || args.length > 0) {
      const prefix = name.toLowerCase()
      const suggestions = listSkills()
        .filter((s) => s.name.toLowerCase().startsWith(prefix) || s.name.toLowerCase().includes(prefix))
        .slice(0, 5)
      return { kind: "unknown", name, suggestions }
    }
  }
  const mentioned = referencedSkills(text)
  if (mentioned.length === 0) return { kind: "none" }
  const notes = mentioned.map((s) => `- /${s.name} → read ${s.path} and follow it`).join("\n")
  return { kind: "mentions", skills: mentioned, payload: `${text}\n\n(Skills referenced above:\n${notes})` }
}
