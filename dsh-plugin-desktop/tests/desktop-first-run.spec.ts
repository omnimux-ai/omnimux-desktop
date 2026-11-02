import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  defaultDesktopFirstRunSettings,
  desktopFirstRunSetupSuppressed,
  settlesFirstRunSetup,
} from '../src/desktop-first-run.ts'

const DEFAULT_MODE = process.platform === 'linux' ? 'compatibility' : 'advanced'

describe('first-run policy', () => {
  it('suppresses first-run setup across all standard channels to settle deterministic defaults', () => {
    expect(desktopFirstRunSetupSuppressed('dev')).toBe(true)
    expect(desktopFirstRunSetupSuppressed('DEV')).toBe(true)
    expect(desktopFirstRunSetupSuppressed('prod')).toBe(true)
    expect(desktopFirstRunSetupSuppressed('production')).toBe(true)
    expect(desktopFirstRunSetupSuppressed('')).toBe(true)
    expect(desktopFirstRunSetupSuppressed(undefined)).toBe(true)
  })

  it('allows explicitly forcing first-run setup via environment flag', () => {
    const original = process.env.OMNIMUX_FORCE_SETUP_WIZARD
    try {
      process.env.OMNIMUX_FORCE_SETUP_WIZARD = '1'
      expect(desktopFirstRunSetupSuppressed('dev')).toBe(false)
      expect(desktopFirstRunSetupSuppressed('prod')).toBe(false)
    } finally {
      if (original === undefined) delete process.env.OMNIMUX_FORCE_SETUP_WIZARD
      else process.env.OMNIMUX_FORCE_SETUP_WIZARD = original
    }
  })

  it('ships the platform default mode with loopback browser access on', () => {
    const settings = defaultDesktopFirstRunSettings()
    expect(settings.mode).toBe(DEFAULT_MODE)
    expect(settings.openBrowser).toBe(true)
    expect(settings.networkExposure).toBe('loopback')
    expect(settings.notifications.enabled).toBe(true)
  })
})

describe('release first-run wiring (merged setup state machine)', () => {
  it('settles Setup only when upstream says Setup is required', () => {
    const original = process.env.OMNIMUX_FORCE_SETUP_WIZARD
    try {
      delete process.env.OMNIMUX_FORCE_SETUP_WIZARD
      // A release/Dev launch that upstream would send to the wizard is settled
      // with shipped defaults instead; a launch that needs nothing stays a no-op.
      expect(settlesFirstRunSetup(true)).toBe(true)
      expect(settlesFirstRunSetup(false)).toBe(false)
    } finally {
      if (original === undefined) delete process.env.OMNIMUX_FORCE_SETUP_WIZARD
      else process.env.OMNIMUX_FORCE_SETUP_WIZARD = original
    }
  })

  it('leaves the upstream wizard reachable through the explicit force flag', () => {
    const original = process.env.OMNIMUX_FORCE_SETUP_WIZARD
    try {
      process.env.OMNIMUX_FORCE_SETUP_WIZARD = '1'
      expect(settlesFirstRunSetup(true)).toBe(false)
    } finally {
      if (original === undefined) delete process.env.OMNIMUX_FORCE_SETUP_WIZARD
      else process.env.OMNIMUX_FORCE_SETUP_WIZARD = original
    }
  })

  it('is wired into main.ts ahead of the wizard and records Setup as settled', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    const settle = main.indexOf('settlesFirstRunSetup(setupPending)')
    const begin = main.indexOf('beginDesktopSetupWizard(marketUserDataDir')
    expect(settle).toBeGreaterThan(-1)
    expect(begin).toBeGreaterThan(settle)
    expect(main).toContain("'skipped',")
    expect(main).toContain('setupPending = false')
  })
})
