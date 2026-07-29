import { BrowserWindow, Notification } from 'electron'

/**
 * Telling you something needs you, when you are not looking at the app.
 *
 * Before this, the entire notification surface for a blocked teammate was a card rendered in
 * the Messages list of the **currently open project**. A question raised on project B while you
 * were reading project A was invisible; so was one raised while the window was minimised. The
 * teammate would then burn all twenty of its retry loops — a full model turn each, on its whole
 * context — waiting for you to see a doorbell you could not hear.
 *
 * Which is why this lands before the routing ladder rather than after it. A ladder built on an
 * unheard doorbell just adds a second person who is also waiting.
 */

/** Focus the window and tell the renderer which project to open. */
function reveal(projectId: string): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.webContents.send('vibepilot:reveal-project', projectId)
}

/**
 * Show an OS notification. Silently does nothing where the platform cannot.
 *
 * Never throws: a missing notification is a small loss, and a crash in the main process while
 * an agent is mid-turn is a large one.
 */
export function notifyUser(input: {
  projectId: string
  title: string
  body: string
}): void {
  try {
    if (!Notification.isSupported()) return

    const win = BrowserWindow.getAllWindows()[0]
    // Don't interrupt someone who is already looking at it.
    if (win?.isFocused() && !win.isMinimized()) return

    const n = new Notification({
      title: input.title,
      body: input.body.length > 220 ? `${input.body.slice(0, 217)}…` : input.body,
      silent: false,
    })
    n.on('click', () => reveal(input.projectId))
    n.show()
  } catch {
    // Notifications are best-effort by design. See above.
  }
}
