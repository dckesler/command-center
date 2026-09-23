import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { RepoInfo } from "../types.ts"
import { config } from "../config.ts"

/**
 * Repo alias → path registry for the worktrees tab and launches.
 *
 * Source of truth, in order:
 *   1. `repos` in config.json when non-empty
 *   2. the mkpanes script's `case "$ARG"` block (config.commands.mkpanes), e.g.
 *        lists)              DIR="$HOME/code/lists" ;;
 *        smartsense-one-skeleton|ssone-s) DIR="$HOME/code/smartsense-one-skeleton" ;;
 * Only aliases whose path is a git checkout are returned.
 */
export function parseRepoMap(): RepoInfo[] {
  const fromConfig = Object.entries(config().repos)
  if (fromConfig.length > 0) {
    return fromConfig.filter(([, path]) => existsSync(join(path, ".git"))).map(([alias, path]) => ({ alias, path }))
  }
  const mkpanes = config().commands.mkpanes
  if (!existsSync(mkpanes)) return []
  const script = readFileSync(mkpanes, "utf8")
  const seen = new Set<string>()
  const repos: RepoInfo[] = []
  const re = /^\s*([\w|-]+)\)\s+DIR="\$HOME\/([^"]+)"/gm
  for (const match of script.matchAll(re)) {
    const alias = match[1].split("|")[0]
    const path = join(homedir(), match[2])
    if (seen.has(path)) continue
    seen.add(path)
    if (existsSync(join(path, ".git"))) {
      repos.push({ alias, path })
    }
  }
  return repos
}
