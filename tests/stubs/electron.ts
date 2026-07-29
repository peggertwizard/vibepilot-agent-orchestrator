import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Minimal stand-in for the bits of `electron` the main-process modules touch. */
const root = mkdtempSync(join(tmpdir(), 'vp-test-'))

export const app = {
  getPath: (name: string): string => join(root, name),
  getName: () => 'vibepilot-test',
  requestSingleInstanceLock: () => true,
  quit: () => undefined,
  on: () => undefined,
  whenReady: async () => undefined,
}

export const ipcMain = {
  handle: () => undefined,
  on: () => undefined,
}

export const shell = {
  openExternal: async () => undefined,
  showItemInFolder: () => undefined,
}

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
}

export const session = {
  defaultSession: { webRequest: { onHeadersReceived: () => undefined } },
}

export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return []
  }
}

/**
 * There is no notification centre under test, and `isSupported()` returning false is the
 * documented way to say so — `notifyUser` takes that branch and does nothing, which is what we
 * want: the tests assert on the question row, not on the doorbell.
 */
export const Notification = {
  isSupported: () => false,
}

export const testRoot = root
