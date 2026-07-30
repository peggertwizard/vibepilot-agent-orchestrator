import { app } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Runtime state lives in userData, never inside the user's repo.
 *
 * Worktrees specifically live OUTSIDE the project directory: Windows MAX_PATH (260 chars)
 * blows up on `<project>/.vibepilot/worktrees/12/node_modules/...` in any real repo.
 * Only `pilot.md` and `rules/` live in the repo, where they are version-controlled and
 * reviewable.
 */
export function userDataDir(): string {
  return app.getPath('userData')
}

export function dbPath(): string {
  return join(userDataDir(), 'vibepilot.db')
}

/** `%LOCALAPPDATA%\vibepilot\wt` in practice. */
export function worktreeRoot(): string {
  return ensure(join(userDataDir(), 'wt'))
}

export function projectHash(projectPath: string): string {
  return createHash('sha256').update(projectPath.toLowerCase()).digest('hex').slice(0, 10)
}

export function worktreeDir(projectPath: string, ticketNumber: number): string {
  return join(worktreeRoot(), projectHash(projectPath), String(ticketNumber))
}

/** Per-run scratch: the composed system prompt goes here, not onto the command line. */
export function runDir(runId: string): string {
  return ensure(join(userDataDir(), 'runs', runId))
}

export function attachmentsDir(): string {
  return ensure(join(userDataDir(), 'attachments'))
}

/** In-repo, agent-visible, version-controlled. */
export function vibepilotConfigDir(projectPath: string): string {
  return join(projectPath, '.vibepilot')
}

function ensure(p: string): string {
  mkdirSync(p, { recursive: true })
  return p
}
