import { app, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateState } from '@shared/types'

/**
 * Keeping the installed app current, without ever interrupting work.
 *
 * The hard constraint here is not the download — it is that vibePilot holds things that must not
 * be killed mid-flight: live `claude.exe` subprocesses in the middle of a model turn, a SQLite
 * connection with a write queue behind it, and git worktrees that a merge may be halfway through.
 * electron-updater's default behaviour (`autoInstallOnAppQuit`) would restart the app out from
 * under all of that.
 *
 * So the download is automatic and silent — that part is free — and the *install* is deferred
 * until the app is closing anyway, driven explicitly from `shutdown()` in index.ts once the
 * engine has been drained. Nothing here ever quits the app on its own.
 */

// electron-updater ships as CommonJS; the named exports are not reachable through ESM interop.
const { autoUpdater } = electronUpdater

let state: UpdateState = { phase: 'idle' }

/** How often to look, once the first check has happened. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

/**
 * A moment's grace at launch.
 *
 * Startup already opens the database, marks stalled agents and builds the window. Racing a
 * network call against that buys nothing — an update that arrives twenty seconds later is just
 * as useful.
 */
const FIRST_CHECK_DELAY_MS = 20_000

function broadcast(next: UpdateState): void {
  state = next
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('vibepilot:update', next)
  }
}

/** Whether an installer is sitting on disk, ready to run when the app closes. */
export function updateIsReady(): boolean {
  return state.phase === 'ready'
}

export function currentUpdateState(): UpdateState {
  return state
}

/**
 * Run the downloaded installer and restart.
 *
 * Called from `shutdown()` **after** the engine has been drained and the database closed — never
 * before. `isSilent: false` so Windows shows the installer's own progress rather than appearing
 * to hang; `isForceRunAfter: true` so the app comes back up by itself, which is the whole point.
 */
export function installUpdateNow(): void {
  try {
    autoUpdater.quitAndInstall(false, true)
  } catch {
    // If this fails the app simply exits as normal and the update lands next launch.
  }
}

/**
 * Arm the updater.
 *
 * A no-op in development and for the portable build. `app.isPackaged` is false under
 * electron-vite, where there is no installer to replace and electron-updater would only throw
 * about a missing `app-update.yml`.
 */
export function initUpdater(): void {
  if (!app.isPackaged) return

  // We install from `shutdown()`, once the engine is drained. See the note at the top.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = null

  autoUpdater.on('checking-for-update', () => broadcast({ phase: 'checking' }))
  autoUpdater.on('update-not-available', () => broadcast({ phase: 'none' }))
  autoUpdater.on('download-progress', (p: { percent: number }) =>
    broadcast({
      phase: 'downloading',
      percent: Math.round(p.percent),
      version: state.phase === 'downloading' ? state.version : '',
    }),
  )
  autoUpdater.on('update-available', (info: { version: string }) =>
    broadcast({ phase: 'downloading', percent: 0, version: info.version }),
  )
  autoUpdater.on('update-downloaded', (info: { version: string }) =>
    broadcast({ phase: 'ready', version: info.version }),
  )

  /*
   * An update that cannot be found is not an error worth showing anyone. No network, a private
   * repo, a release that has not been published yet — all of these are ordinary, and none of
   * them mean anything is wrong with the app the user is currently running.
   */
  autoUpdater.on('error', (e: Error) => {
    broadcast({ phase: 'error', reason: e?.message ?? 'update check failed' })
    console.warn(`[update] ${e?.message ?? e}`)
  })

  const check = (): void => {
    void autoUpdater.checkForUpdates().catch(() => {
      /* already reported through the error handler above */
    })
  }

  setTimeout(check, FIRST_CHECK_DELAY_MS).unref?.()
  setInterval(check, CHECK_EVERY_MS).unref?.()
}
