import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { bus } from '../bus'
import { getProject } from '../db/repos/projects'
import { getTicket } from '../db/repos/tickets'

/**
 * See the change before you merge it.
 *
 * *"i want that to appear locally you know? then i verify it and then i can implement it where
 * i want."* None of that was possible: finished work lived on `vp/<n>-<slug>` in a worktree
 * outside the user's checkout, so their own dev server — running against their base branch —
 * could not see it. The change was invisible until it had already been merged, which is the
 * wrong way round.
 *
 * The dev server runs **in the worktree**, on its own port. The alternative was merging onto a
 * preview branch inside the user's own checkout, which would move their HEAD — the one thing
 * `squashMerge` was carefully built not to do. Isolation is the promise; previewing is not
 * worth trading it for.
 *
 * ## The dependency problem, stated rather than hidden
 *
 * A git worktree is a separate directory, so it has no `node_modules`. Three options, none
 * free: install per preview (slow, and disk per ticket), symlink the project's (a shared
 * mutable directory between agents that are supposed to be isolated), or require the preview
 * command to handle it. This takes the third: the command is the user's, and if it needs an
 * install it can say so. `hasDependencies` reports what is there so the failure is legible
 * rather than a stack trace about a missing module.
 */

/** Ports are allocated upward from here, so a preview never sits on the project's own server. */
const BASE_PORT = 3100
const MAX_PREVIEWS = 6
/** Output kept per preview, for the panel. Enough to see a compile error, not a whole build. */
const LOG_TAIL = 8_000

export interface Preview {
  ticketId: string
  projectId: string
  port: number
  url: string
  cmd: string
  cwd: string
  startedAt: number
  log: string
  child: ChildProcess
}

const previews = new Map<string, Preview>()

/** What a caller may see. The child process is deliberately not part of it. */
export interface PreviewInfo {
  ticketId: string
  port: number
  url: string
  startedAt: number
  log: string
}

function info(p: Preview): PreviewInfo {
  return { ticketId: p.ticketId, port: p.port, url: p.url, startedAt: p.startedAt, log: p.log }
}

export function listPreviews(projectId: string): PreviewInfo[] {
  return [...previews.values()].filter((p) => p.projectId === projectId).map(info)
}

export function previewFor(ticketId: string): PreviewInfo | null {
  const p = previews.get(ticketId)
  return p ? info(p) : null
}

function freePort(): number {
  const taken = new Set([...previews.values()].map((p) => p.port))
  for (let port = BASE_PORT; port < BASE_PORT + 100; port++) if (!taken.has(port)) return port
  return BASE_PORT
}

/**
 * Does this worktree look able to run anything?
 *
 * Not a guarantee — plenty of projects need no install at all — but a missing `node_modules`
 * beside a `package.json` is the single most likely reason a preview dies immediately, and
 * saying so beats a stack trace about a module that cannot be found.
 */
export function hasDependencies(cwd: string): boolean {
  if (!existsSync(join(cwd, 'package.json'))) return true
  return existsSync(join(cwd, 'node_modules'))
}

export interface StartResult {
  ok: boolean
  reason?: string
  preview?: PreviewInfo
}

export function startPreview(ticketId: string): StartResult {
  const existing = previews.get(ticketId)
  if (existing) return { ok: true, preview: info(existing) }

  const ticket = getTicket(ticketId)
  if (!ticket) return { ok: false, reason: 'That ticket no longer exists.' }

  const project = getProject(ticket.projectId)
  if (!project) return { ok: false, reason: 'That project no longer exists.' }
  if (!project.previewCmd) {
    return {
      ok: false,
      reason:
        'This project has no preview command. Set one in Settings — for a Next.js app it is ' +
        'usually `npm run dev -- -p {port}`.',
    }
  }
  if (!ticket.worktreePath) {
    return { ok: false, reason: 'Nothing has been built for this ticket yet.' }
  }
  if (previews.size >= MAX_PREVIEWS) {
    return { ok: false, reason: `${MAX_PREVIEWS} previews are already running. Stop one first.` }
  }

  const port = freePort()
  const cmd = project.previewCmd.replaceAll('{port}', String(port))
  const cwd = ticket.worktreePath

  const child = spawn(cmd, {
    cwd,
    shell: true,
    windowsHide: true,
    // Same environment shaping as `runCommand`: colour codes in a log panel are noise.
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', PORT: String(port) },
  })

  const preview: Preview = {
    ticketId,
    projectId: ticket.projectId,
    port,
    url: `http://localhost:${port}`,
    cmd,
    cwd,
    startedAt: Date.now(),
    log: hasDependencies(cwd)
      ? ''
      : 'This worktree has a package.json and no node_modules. If the server fails to start, ' +
        'that is why — the preview command has to install, or the project has to vendor them.\n',
    child,
  }
  previews.set(ticketId, preview)

  const append = (chunk: Buffer): void => {
    preview.log = (preview.log + chunk.toString()).slice(-LOG_TAIL)
    bus.emitDomain({ type: 'tickets:changed', projectId: preview.projectId })
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)

  child.on('exit', (code) => {
    // A preview that dies is not an error worth a dialog, but it must not keep claiming a URL.
    previews.delete(ticketId)
    if (code !== 0 && code !== null) {
      preview.log += `\nThe preview stopped (exit ${code}).\n`
    }
    bus.emitDomain({ type: 'tickets:changed', projectId: preview.projectId })
  })
  child.on('error', (e) => {
    preview.log += `\nCould not start: ${e.message}\n`
    previews.delete(ticketId)
    bus.emitDomain({ type: 'tickets:changed', projectId: preview.projectId })
  })

  bus.emitDomain({ type: 'tickets:changed', projectId: preview.projectId })
  return { ok: true, preview: info(preview) }
}

export function stopPreview(ticketId: string): boolean {
  const p = previews.get(ticketId)
  if (!p) return false
  previews.delete(ticketId)
  try {
    p.child.kill()
  } catch {
    /* already gone */
  }
  bus.emitDomain({ type: 'tickets:changed', projectId: p.projectId })
  return true
}

/**
 * Every preview, gone.
 *
 * A dev server that outlives the app holds a port and a node process for ever, and nobody
 * would think to look for it. The shutdown path that drains agents has to drain these too.
 */
export function stopAllPreviews(): void {
  for (const id of [...previews.keys()]) stopPreview(id)
}
