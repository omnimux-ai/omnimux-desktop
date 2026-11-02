/**
 * First-run policy.
 *
 * Every channel starts with deterministic shipped defaults: the platform
 * default window mode (enhanced mode on macOS and Windows) with loopback browser
 * access already on. First-run Setup is suppressed by default across all channels
 * unless explicitly requested via OMNIMUX_FORCE_SETUP_WIZARD.
 */

import { defaultDesktopShellMode } from './desktop-mode-default.ts'
import {
  defaultDesktopSetupWizardSettings,
  type DesktopSetupWizardSettings,
} from './setup-wizard-settings.ts'

/** First-run Setup is suppressed across all standard channels unless explicitly forced. */
export function desktopFirstRunSetupSuppressed(_channel?: string): boolean {
  if (process.env.OMNIMUX_FORCE_SETUP_WIZARD === '1') return false
  return true
}

/**
 * Whether this launch settles first-run Setup with shipped defaults instead of
 * opening the wizard.
 *
 * Combines upstream's "Setup is required for this Profile" verdict with the
 * OmniMux first-run policy, so the decision is testable on its own rather than
 * buried in the Electron bootstrap.
 * @param required - upstream's `desktopSetupWizardRequired(...)` verdict.
 * @returns true when Setup must be recorded as settled without asking.
 */
export function settlesFirstRunSetup(required: boolean): boolean {
  return required && desktopFirstRunSetupSuppressed(process.env.OMNIMUX_CHANNEL)
}

/** Shipped first-run settings: the platform default mode with browser access on. */
export function defaultDesktopFirstRunSettings(): DesktopSetupWizardSettings {
  return Object.freeze({
    ...defaultDesktopSetupWizardSettings(),
    mode: defaultDesktopShellMode(),
    openBrowser: true,
  })
}
