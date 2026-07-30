import { app, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateState } from '@shared/types'

/**
 * Telling you a new version exists, and then doing nothing until you say so.
 *
 * It checks once at launch. If something is there you get a button — in the title bar and in
 * Settings — and **nothing is downloaded until you press it**. A hundred megabytes should not
 * leave someone's connection because an app felt like it.
 *
 * Installing is separate again, and deferred to `shutdown()` in index.ts. vibePilot holds live
 * `claude.exe` subprocesses mid-turn, a SQLite handle with a write queue behind it, and git
 * worktrees a merge may be halfway through. electron-updater's `autoInstallOnAppQuit` would
 * restart the app out from under all of it, so the install runs after the engine is drained
 * and never before.
 */

// electron-updater ships as CommonJS; the named exports are not reachable through ESM interop.
const { autoUpdater } = electronUpdater

let state: UpdateState = { phase: 'idle' }

/**
 * A moment's grace at launch.
 *
 * Startup already opens the database, marks stalled agents and builds the window. Racing a
 * network call against that buys nothing.
 */
const FIRST_CHECK_DELAY_MS = 20_000

function broadcast(next: UpdateState): void {
  state = next
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('vibepilot:update', next)
  }
}

/** Whether an installer is on disk, ready to run when the app closes. */
export function updateIsReady(): boolean {
  return state.phase === 'ready'
}

export function currentUpdateState(): UpdateState {
  return state
}

/**
 * Look now. Returns what was found, so a Settings button can await it and say something.
 *
 * Safe to call while a download is in flight — checking again mid-download would only confuse
 * the state, so it is refused rather than queued.
 */
export async function checkForUpdate(): Promise<UpdateState> {
  if (!app.isPackaged) {
    broadcast({ phase: 'none', checkedAt: Date.now() })
    return state
  }
  if (state.phase === 'downloading' || state.phase === 'ready') return state

  broadcast({ phase: 'checking' })
  try {
    await autoUpdater.checkForUpdates()
  } catch {
    /* reported through the error handler */
  }
  return state
}

/**
 * Start the download. Only ever called because someone pressed a button.
 */
export async function downloadUpdate(): Promise<void> {
  if (state.phase !== 'available') return
  broadcast({ phase: 'downloading', percent: 0, version: state.version })
  try {
    await autoUpdater.downloadUpdate()
  } catch (e) {
    broadcast({ phase: 'error', reason: (e as Error)?.message ?? 'download failed' })
  }
}

/**
 * Run the downloaded installer and restart.
 *
 * Called from `shutdown()` **after** the engine is drained and the database closed — never
 * before. `isSilent: false` so Windows shows the installer's own progress rather than appearing
 * to hang; `isForceRunAfter: true` so the app comes back by itself.
 */
export function installUpdateNow(): void {
  try {
    autoUpdater.quitAndInstall(false, true)
  } catch {
    // If this fails the app exits normally and the update lands on the next launch.
  }
}

/**
 * Arm the updater.
 *
 * A no-op in development and for the portable build — `app.isPackaged` is false under
 * electron-vite, where there is no installer to replace and electron-updater would only throw
 * about a missing `app-update.yml`.
 */
export function initUpdater(): void {
  if (!app.isPackaged) return

  // Both off: the download is a button, and the install waits for a drained engine.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = null

  autoUpdater.on('update-available', (info: { version: string; releaseNotes?: unknown }) =>
    broadcast({
      phase: 'available',
      version: info.version,
      notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
    }),
  )
  autoUpdater.on('update-not-available', () =>
    broadcast({ phase: 'none', checkedAt: Date.now() }),
  )
  autoUpdater.on('download-progress', (p: { percent: number }) =>
    broadcast({
      phase: 'downloading',
      percent: Math.round(p.percent),
      version: state.phase === 'downloading' ? state.version : '',
    }),
  )
  autoUpdater.on('update-downloaded', (info: { version: string }) =>
    broadcast({ phase: 'ready', version: info.version }),
  )

  /*
   * An update that cannot be found is not an error worth showing anyone. No network, a release
   * not published yet — both ordinary, and neither means anything is wrong with the copy being
   * run right now.
   */
  autoUpdater.on('error', (e: Error) => {
    broadcast({ phase: 'error', reason: e?.message ?? 'update check failed' })
    console.warn(`[update] ${e?.message ?? e}`)
  })

  // Once, at launch. No polling: an app that phones home every six hours to tell you the same
  // thing is an app you learn to ignore.
  setTimeout(() => void checkForUpdate(), FIRST_CHECK_DELAY_MS).unref?.()
}
