/** Main-world key for the desktop window chrome action bridge. */
export const DESKTOP_WINDOW_ACTION_BRIDGE = '__DSH_DESKTOP_WINDOW_ACTION__'

/** Capability exposed by the context-isolated preload for native window chrome actions. */
export interface DesktopWindowActionBridge {
  /** Trigger the native title bar double-click action (e.g. macOS Zoom/Maximize/Minimize per user preference). */
  handleTitleBarDoubleClick(): void
}

/** Window shape consumed by desktop-only client code. */
export interface DesktopWindowActionBridgeWindow {
  __DSH_DESKTOP_WINDOW_ACTION__?: DesktopWindowActionBridge
}

/** IPC channel for titlebar double-click action. */
export const TITLEBAR_DOUBLE_CLICK_IPC_CHANNEL = 'dsh:window:titlebar-double-click'
