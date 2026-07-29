import { app, BrowserWindow, session, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, closeDb } from './db'
import { flushWrites } from './db/writer'
import { markAllStalledOnBoot } from './db/repos/agents'
import { startHeartbeat, stopHeartbeat } from './engine/heartbeat'
import { stopAllPreviews } from './engine/preview'
import { coalescer } from './bus/coalescer'
import { mcpServer } from './mcp/server'
import { registerIpc } from './ipc'
import { initUpdater, installUpdateNow, updateIsReady } from './updater'

// Single instance: two copies would fight over the SQLite file and the worktree lock.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let quitting = false

/**
 * The app's own icon, rather than Electron's.
 *
 * `build/icon.png` in development, `resources/icon.png` once packaged. Guarded with `existsSync`
 * because a missing picture must never be the reason the app will not start — Electron falls
 * back to its own icon and everything else works.
 */
function appIcon(): string | undefined {
  for (const p of [
    join(process.resourcesPath ?? '', 'icon.png'),
    join(__dirname, '../../build/icon.png'),
  ]) {
    if (p && existsSync(p)) return p
  }
  return undefined
}

/*
 * Without this Windows groups the window under "Electron" — wrong name, wrong icon in the
 * taskbar, and pinning it pins Electron rather than vibePilot.
 */
app.setAppUserModelId('net.peggert.vibepilot')

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    /*
     * Lowered from 900 now that both side rails fold away and the board reflows into as many
     * columns as fit. The old floor was set when the layout could not survive being narrow;
     * it can, so the window is allowed to be a window.
     */
    minWidth: 720,
    minHeight: 560,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    icon: appIcon(),
    backgroundColor: '#f2f2f3',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs `require` for the typed façade; no node in renderer
      webSecurity: true,
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // The renderer never navigates. Anything trying to is either a bug or hostile.
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  coalescer.attach(mainWindow)

  if (process.env['ELECTRON_RENDERER_URL']) {
    // Renderer errors are invisible from the terminal otherwise — a blank window with no
    // clue why is the worst possible dev loop.
    mainWindow.webContents.on('console-message', (...a: unknown[]) => {
      const e = a[0] as { level?: string; message?: string; lineNumber?: number; sourceId?: string }
      const msg = typeof a[2] === 'string' ? a[2] : (e?.message ?? '')
      if (msg) console.log(`[renderer] ${msg}`)
    })
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) =>
      console.error(`[renderer] failed to load ${url}: ${desc} (${code})`),
    )
    mainWindow.webContents.on('render-process-gone', (_e, d) =>
      console.error('[renderer] process gone:', d.reason),
    )
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * CSP as a response header. Vite's dev server injects an inline React-refresh preamble, so
 * dev needs 'unsafe-inline' for scripts — the shipped app must not, hence the split.
 * `connect-src` allows the HMR websocket in dev only.
 */
function installCsp(): void {
  const dev = !!process.env['ELECTRON_RENDERER_URL']
  const policy = [
    "default-src 'self'",
    dev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    dev ? "connect-src 'self' ws://localhost:* http://localhost:*" : "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')

  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    })
  })
}

app.whenReady().then(() => {
  openDb()

  // You cannot reattach to a child's stdio after your own process dies, so nothing that
  // was running before this launch is recoverable as a live stream. Mark them stalled so
  // the UI offers a restart instead of showing agents that will never move again.
  const stalled = markAllStalledOnBoot()
  if (stalled > 0) console.log(`[boot] marked ${stalled} interrupted agent(s) as stalled`)

  installCsp()
  registerIpc(() => mainWindow)
  createWindow()
  initUpdater()

  /*
   * The Pilot only ever woke when something woke it — a draft, a route, a finished step.
   * Nothing called it because time had passed, so work that silently stopped produced no
   * event and nobody found out until a person looked at the board. This is the clock.
   */
  startHeartbeat()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (e) => {
  /*
   * Second pass. `quitAndInstall` asks the app to quit again once the installer is running, and
   * by then the engine is already drained — so let it through rather than draining twice.
   */
  if (quitting) return
  quitting = true
  // Nothing should be waking the Pilot while the engine is draining.
  stopHeartbeat()
  // A dev server that outlives the app holds a port and a node process for ever, and nobody
  // would think to go looking for it.
  stopAllPreviews()
  e.preventDefault()
  void shutdown().finally(finish)
})

/**
 * The last thing that happens.
 *
 * If an installer was downloaded while you were working, this is the only safe moment to run it:
 * every agent has been stopped, the write queue is flushed and the database is closed. The
 * timeout is a backstop — if the installer will not start for any reason, the app must still
 * exit rather than sit there looking hung, and the update simply lands on the next launch.
 */
function finish(): void {
  if (!updateIsReady()) {
    app.exit(0)
    return
  }
  setTimeout(() => app.exit(0), 10_000).unref?.()
  installUpdateNow()
}

async function shutdown(): Promise<void> {
  coalescer.detach()
  try {
    const { manager } = await import('./engine/manager')
    await manager.shutdownAll(8000)
  } catch {
    /* engine may not be initialised yet */
  }
  mcpServer.close()
  flushWrites()
  closeDb()
}
