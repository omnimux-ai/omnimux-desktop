import { ipcMain, systemPreferences, type BrowserWindow, type IpcMainEvent, type WebContents } from 'electron'
import { TITLEBAR_DOUBLE_CLICK_IPC_CHANNEL } from './window-actions-bridge-contract.ts'
import type { DesktopPlatform } from './runtime.ts'

export interface TitleBarDoubleClickHandlerOptions {
  readonly window: BrowserWindow
  readonly platform: DesktopPlatform
  /**
   * WebContents that hosts the client renderer. The isolated compatibility shell
   * puts the renderer in its own `WebContentsView`, so `window.webContents` is
   * not the surface that sends the double-click IPC.
   */
  readonly rendererWebContents?: WebContents
  readonly systemPreferencesApi?: Pick<typeof systemPreferences, 'getUserDefault'>
  readonly ipcMainApi?: Pick<typeof ipcMain, 'on' | 'off'>
}

/**
 * Execute title bar double-click action on the target window.
 *
 * On macOS (darwin), respects the user's system preference in
 * System Settings -> Desktop & Dock -> "Double-click a window's title bar to":
 * - "Maximize" (Zoom): toggle maximize / unmaximize
 * - "Minimize": minimize window to dock
 * - "None": do nothing
 *
 * On other platforms (Windows/Linux): toggles maximize / unmaximize.
 */
export function executeTitleBarDoubleClickAction(
  window: BrowserWindow,
  platform: DesktopPlatform,
  systemPrefs?: Pick<typeof systemPreferences, 'getUserDefault'>,
): void {
  if (window.isDestroyed() || window.isFullScreen()) return

  if (platform === 'darwin') {
    let action = 'Maximize'
    try {
      const prefs = systemPrefs ?? (typeof systemPreferences !== 'undefined' ? systemPreferences : undefined)
      if (prefs && typeof prefs.getUserDefault === 'function') {
        action = prefs.getUserDefault('AppleActionOnDoubleClick', 'string')
      }
    } catch {
      action = 'Maximize'
    }

    if (action === 'Minimize') {
      window.minimize()
    } else if (action === 'None') {
      // User disabled titlebar double-click in macOS preferences.
    } else {
      // Default behavior: Zoom / Maximize
      if (window.isMaximized()) {
        window.unmaximize()
      } else {
        window.maximize()
      }
    }
  } else {
    if (window.isMaximized()) {
      window.unmaximize()
    } else {
      window.maximize()
    }
  }
}

/**
 * Attach an IPC listener for title bar double-click events, scoping actions strictly
 * to the sender's BrowserWindow.
 */
export function attachTitleBarDoubleClickListener(
  options: TitleBarDoubleClickHandlerOptions,
): () => void {
  let ipc: Pick<typeof ipcMain, 'on' | 'off'> | undefined = options.ipcMainApi
  if (!ipc) {
    try {
      if (typeof ipcMain !== 'undefined' && ipcMain && typeof ipcMain.on === 'function') {
        ipc = ipcMain
      }
    } catch {
      ipc = undefined
    }
  }
  if (!ipc) {
    return () => {}
  }

  const handler = (event: IpcMainEvent): void => {
    if (options.window.isDestroyed()) return
    if (event.sender.id !== (options.rendererWebContents ?? options.window.webContents).id) return

    executeTitleBarDoubleClickAction(
      options.window,
      options.platform,
      options.systemPreferencesApi,
    )
  }

  ipc.on(TITLEBAR_DOUBLE_CLICK_IPC_CHANNEL, handler)
  return () => {
    ipc.off(TITLEBAR_DOUBLE_CLICK_IPC_CHANNEL, handler)
  }
}
