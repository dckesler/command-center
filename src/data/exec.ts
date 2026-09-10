import { execFile } from "node:child_process"

export interface ExecResult {
  stdout: string
  stderr: string
  ok: boolean
}

/** Run a command, never throw — callers inspect `ok`. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GLAB_PAGER: "cat", PAGER: "cat" },
      },
      (error, stdout, stderr) => {
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", ok: !error })
      },
    )
  })
}
