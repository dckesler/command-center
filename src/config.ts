import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

/**
 * Machine/user-specific settings. Everything that used to be implicit (home
 * paths, which agent CLI to type into tmux panes, who the user is, which Jira
 * site) lives in one non-versioned JSON file, with sane defaults so a fresh
 * checkout still starts.
 *
 * Resolution order (first wins):
 *   1. environment variables (CC_CONFIG_DIR, CC_PROJECTS_DIR, CC_AGENT_CMD, CC_MODEL, …)
 *   2. $CC_CONFIG_DIR/config.json  (default ~/.config/command-center/config.json)
 *   3. defaults below
 *
 * `config.example.json` at the repo root documents every key. Secrets
 * (CURSOR_API_KEY, JIRA_EMAIL, JIRA_API_TOKEN) stay in the environment —
 * Bun loads a `.env` in the repo root automatically; see `.env.example`.
 */

export interface Config {
  user: {
    /** first name the agents address; used in prompts ("report to Daniel") */
    name: string
    /** work email (Jira account, git author); optional */
    email: string
    /** Atlassian account id; optional, used by skills that assign tickets */
    jiraAccountId: string
  }
  dirs: {
    /** state dir: agents.jsonl, inbox.jsonl, todos.json, tui.log, config.json */
    config: string
    /** where ~/projects-style project directories live */
    projects: string
    /** roots whose immediate children are skill folders (for /skill in chats) */
    skills: string[]
  }
  commands: {
    /** typed into tmux panes to start an agent; a shell alias is fine */
    agent: string
    /** path to the mkpanes script (worktree launcher, repo alias registry) */
    mkpanes: string
    editor: string
    /** terminal app used by start-project for new OS windows */
    terminal: "alacritty" | "terminal" | "none"
    /** tmux session that gets new ticket windows; null = the session we run in / first */
    tmuxSession: string | null
  }
  jira: {
    baseUrl: string
    /** Atlassian cloud id (MCP tools need it); optional */
    cloudId: string
    /** custom field id holding the sprint */
    sprintField: string
  }
  /** Cursor SDK model for the hub specialists and cloud agents */
  model: string
  projects: {
    /** directory names under dirs.projects that are not projects */
    exclude: string[]
  }
  /**
   * Repo alias → path. When empty, the alias list is parsed from the mkpanes
   * script's `case` block (the original source of truth).
   */
  repos: Record<string, string>
}

const HOME = homedir()
const DEFAULT_CONFIG_DIR = join(HOME, ".config", "command-center")

export const DEFAULTS: Config = {
  user: { name: "the user", email: "", jiraAccountId: "" },
  dirs: {
    config: DEFAULT_CONFIG_DIR,
    projects: join(HOME, "projects"),
    skills: [
      join(HOME, ".cursor", "skills"),
      join(HOME, ".cursor", "skills-cursor"),
      join(HOME, ".claude", "skills"),
      join(HOME, ".agents", "skills"),
    ],
  },
  commands: {
    agent: "cursor-cli",
    mkpanes: join(HOME, ".local", "bin", "mkpanes"),
    editor: "vim",
    terminal: "alacritty",
    tmuxSession: null,
  },
  // No Jira site by default: browse links and REST transitions are disabled until set.
  jira: { baseUrl: "", cloudId: "", sprintField: "customfield_10007" },
  model: "composer-2.5",
  projects: { exclude: ["command-center", "node_modules"] },
  repos: {},
}

/** `~/x` and `$HOME/x` → absolute. */
export function expandHome(p: string): string {
  if (!p) return p
  if (p === "~") return HOME
  if (p.startsWith("~/")) return join(HOME, p.slice(2))
  if (p.startsWith("$HOME/")) return join(HOME, p.slice(6))
  return isAbsolute(p) ? p : resolve(p)
}

export function configDir(): string {
  return expandHome(process.env.CC_CONFIG_DIR || DEFAULT_CONFIG_DIR)
}

export function configPath(): string {
  return join(configDir(), "config.json")
}

type Partialish = { [K in keyof Config]?: Partial<Config[K]> } & { model?: string }

function readFile(): Partialish {
  const path = configPath()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Partialish
  } catch (err) {
    console.warn(`command-center: could not parse ${path}: ${(err as Error).message}`)
    return {}
  }
}

let cached: Config | null = null

/** Merged config (defaults ← config.json ← env). Cached for the process. */
export function config(): Config {
  if (cached) return cached
  const file = readFile()
  const env = process.env
  const merged: Config = {
    user: { ...DEFAULTS.user, ...file.user },
    dirs: {
      config: configDir(),
      projects: expandHome(env.CC_PROJECTS_DIR || file.dirs?.projects || DEFAULTS.dirs.projects),
      skills: (file.dirs?.skills ?? DEFAULTS.dirs.skills).map(expandHome),
    },
    commands: {
      ...DEFAULTS.commands,
      ...file.commands,
      agent: env.CC_AGENT_CMD || file.commands?.agent || DEFAULTS.commands.agent,
      mkpanes: expandHome(env.MKPANES_BIN || file.commands?.mkpanes || DEFAULTS.commands.mkpanes),
    },
    jira: {
      ...DEFAULTS.jira,
      ...file.jira,
      baseUrl: (env.JIRA_BASE_URL || file.jira?.baseUrl || DEFAULTS.jira.baseUrl).replace(/\/+$/, ""),
    },
    model: env.CC_MODEL || file.model || DEFAULTS.model,
    projects: { exclude: file.projects?.exclude ?? DEFAULTS.projects.exclude },
    repos: Object.fromEntries(
      Object.entries(file.repos ?? {})
        .filter(([k, v]) => !k.startsWith("$") && typeof v === "string")
        .map(([k, v]) => [k, expandHome(v as string)]),
    ),
  }
  cached = merged
  return merged
}

/** Path inside the state dir. */
export function statePath(...parts: string[]): string {
  return join(config().dirs.config, ...parts)
}

/** Reset the cache (tests). */
export function resetConfigCache(): void {
  cached = null
}
