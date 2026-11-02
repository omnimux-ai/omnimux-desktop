/** Title bar double-click detection and event delegation for custom desktop frames. */

import {
  DESKTOP_WINDOW_ACTION_BRIDGE,
  type DesktopWindowActionBridgeWindow,
} from '../window-actions-bridge-contract.ts'
import type { DesktopClientPlatform } from './environment.ts'

export const TITLEBAR_INTERACTIVE_SELECTORS = [
  'button',
  'input',
  'textarea',
  'select',
  'a',
  'summary',
  '[role="button"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="dialog"]',
  '[contenteditable="true"]',
  '[class*="tab_"]',
  '[class*="tab "]',
  '[class*="tabActive"]',
  '[class*="tabClose"]',
  '[class*="tabBarPlus"]',
  '[class*="toggleCluster"]',
  '[class*="toggleButton"]',
  '[class*="bottomClose"]',
  '[class*="controls"]',
  '.dshDesktopNoDrag',
].join(',')

/**
 * The standard title bar height on macOS and Windows in compatibility and extended modes.
 * Double-clicks outside this top band are ordinary content interactions.
 */
export const TITLEBAR_MAX_CLIENT_Y = 38

export interface ClosableElementLike {
  closest(selector: string): unknown
}

export interface DocumentLike {
  querySelector(selector: string): unknown
}

/**
 * Determine whether a double-click event originated from an empty titlebar region
 * and should trigger native window maximize/zoom/minimize.
 */
export function shouldTriggerTitleBarDoubleClick(
  target: EventTarget | null,
  clientY: number,
  doc?: DocumentLike,
): boolean {
  if (clientY < 0 || clientY > TITLEBAR_MAX_CLIENT_Y) return false
  if (target === null || typeof (target as unknown as ClosableElementLike).closest !== 'function') return false

  // If a modal dialog is currently open, do not trigger titlebar actions.
  const activeDoc = doc ?? (typeof document !== 'undefined' ? document : undefined)
  if (activeDoc?.querySelector('[aria-modal="true"]') != null) return false

  // If clicked inside any interactive control, do not trigger window maximize.
  if ((target as unknown as ClosableElementLike).closest(TITLEBAR_INTERACTIVE_SELECTORS) != null) return false

  return true
}

/**
 * Install a window-level double-click listener to delegate title bar double-click
 * actions to the Electron main process via contextBridge.
 */
export function installDesktopTitleBarDoubleClick(
  _platform: DesktopClientPlatform = 'darwin',
  win: Window & DesktopWindowActionBridgeWindow = window,
): () => void {
  const onDoubleClick = (event: MouseEvent): void => {
    if (event.button !== 0) return // Only primary (left) button
    if (!shouldTriggerTitleBarDoubleClick(event.target, event.clientY, win.document)) return

    event.preventDefault()
    const bridge = win[DESKTOP_WINDOW_ACTION_BRIDGE]
    bridge?.handleTitleBarDoubleClick()
  }

  win.addEventListener('dblclick', onDoubleClick, { capture: true })
  return () => {
    win.removeEventListener('dblclick', onDoubleClick, { capture: true })
  }
}
