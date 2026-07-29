import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

/**
 * Windows has no SIGTERM semantics — `process.kill(pid, 'SIGTERM')` calls TerminateProcess
 * and does NOT kill the process tree. `claude.exe` spawns children (git, node, rg, MCP
 * servers), so killing only the parent leaves orphans holding file locks and burning quota.
 *
 * `taskkill /T` is the whole point of this module.
 */
export function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }
      resolve()
      return
    }
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {
      // taskkill returns nonzero when the process is already gone. Either way we're done.
      resolve()
    })
  })
}

export function isAlive(pid: number | null | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Graceful stop: close stdin (a clean end-of-input exits with code 0), then escalate.
 *
 * There is no interrupt path. `control_request/interrupt` on stdin was verified to do
 * nothing in Claude Code 2.1.220 — see docs/architecture/00-spikes.md. Killing the tree is
 * the only reliable stop, and it costs the in-flight turn.
 */
export async function stopTree(proc: ChildProcess, graceMs = 5000): Promise<'graceful' | 'killed'> {
  if (proc.exitCode !== null || proc.signalCode !== null) return 'graceful'

  try {
    proc.stdin?.end()
  } catch {
    /* stdin already closed */
  }

  const exited = await Promise.race([
    new Promise<boolean>((r) => proc.once('close', () => r(true))),
    new Promise<boolean>((r) => setTimeout(() => r(false), graceMs)),
  ])

  if (exited) return 'graceful'
  if (proc.pid) await killTree(proc.pid)
  return 'killed'
}
