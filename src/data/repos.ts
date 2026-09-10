import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { RepoInfo } from "../types.ts"

const MKPANES_PATH = join(homedir(), ".local", "bin", "mkpanes")

/**
 * The mkpanes script is the source of truth for the repo map. Parse its
 * `case "$ARG"` block, e.g.:
 *   lists)              DIR="$HOME/code/lists" ;;
 *   smartsense-one-skeleton|ssone-s) DIR="$HOME/code/smartsense-one-skeleton" ;;
 */
export function parseRepoMap(): RepoInfo[] {
  const script = readFileSync(MKPANES_PATH, "utf8")
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
