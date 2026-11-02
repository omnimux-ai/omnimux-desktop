/** Default presentation mode shared by the profile composer and the Setup Wizard. */

import type { DesktopShellMode } from './runtime.ts'

/**
 * Presentation mode used when a profile persists no explicit `dsh-desktop.mode`.
 *
 * Enhanced mode owns the layout, sidebar, and conversation rows, which is the
 * presentation this product ships by default. Linux cannot present it — the
 * desktop Client rejects enhanced mode there instead of silently falling back
 * to a different window — so Linux keeps the compatibility presentation.
 *
 * The Setup Wizard shows this same value on its mode step, so a first run that
 * accepts the offered default and a profile that stores no choice agree.
 * @param platform - Electron platform the desktop runs on.
 * @returns the mode used before any explicit choice is persisted.
 */
export function defaultDesktopShellMode(platform: NodeJS.Platform = process.platform): DesktopShellMode {
  return platform === 'linux' ? 'compatibility' : 'advanced'
}
