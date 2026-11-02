import { describe, expect, it } from 'vitest'
import { isOmnimuxDevLaunch, applyOmnimuxDevEnvironment, resolveDevCdpPort, DESKTOP_DEV_CDP_PORT_DEFAULT } from '../src/desktop-identity.ts'
import {
  DESKTOP_DEV_WEB_PORT,
  DESKTOP_PROD_WEB_PORT,
  defaultDesktopWebPort,
} from '../src/desktop-port.ts'

describe('desktop-identity & port policy (Issue #350)', () => {
  it('detects dev launch when execPath contains OmniMux Dev regardless of ambient prod channel', () => {
    expect(
      isOmnimuxDevLaunch({
        env: { OMNIMUX_CHANNEL: 'prod' },
        execPath: '/Applications/OmniMux Dev.app/Contents/MacOS/OmniMux',
        appName: 'OmniMux',
      }),
    ).toBe(true)
  })

  it('detects dev launch when appName contains Dev', () => {
    expect(
      isOmnimuxDevLaunch({
        env: {},
        execPath: '/Applications/OmniMux.app/Contents/MacOS/OmniMux',
        appName: 'OmniMux Dev',
      }),
    ).toBe(true)
  })

  it('detects dev launch when userData contains OmniMux-Dev', () => {
    expect(
      isOmnimuxDevLaunch({
        env: { OMNIMUX_CHANNEL: 'prod' },
        execPath: '/Applications/OmniMux.app/Contents/MacOS/OmniMux',
        appName: 'OmniMux',
        userDataDir: '/home/tester/Library/Application Support/OmniMux-Dev',
      }),
    ).toBe(true)
  })

  it('detects dev launch from explicit dev env markers', () => {
    expect(isOmnimuxDevLaunch({ env: { OMNIMUX_CHANNEL: 'dev' } })).toBe(true)
    expect(isOmnimuxDevLaunch({ env: { OMNIMUX_DEV: '1' } })).toBe(true)
    expect(isOmnimuxDevLaunch({ env: { NODE_ENV: 'development' } })).toBe(true)
    expect(isOmnimuxDevLaunch({ env: { DSH_DESKTOP_DEV: '1' } })).toBe(true)
  })

  it('falls back to prod when no dev indicators are present', () => {
    expect(
      isOmnimuxDevLaunch({
        env: { OMNIMUX_CHANNEL: 'prod' },
        execPath: '/Applications/OmniMux.app/Contents/MacOS/OmniMux',
        appName: 'OmniMux',
        userDataDir: '/home/tester/Library/Application Support/OmniMux',
      }),
    ).toBe(false)
  })

  it('applyOmnimuxDevEnvironment sets CHANNEL=dev and OMNIMUX_DEV=1', () => {
    const env: NodeJS.ProcessEnv = { OMNIMUX_CHANNEL: 'prod' }
    applyOmnimuxDevEnvironment(env)
    expect(env.OMNIMUX_CHANNEL).toBe('dev')
    expect(env.OMNIMUX_DEV).toBe('1')
  })

  it('defaultDesktopWebPort selects 45120 for Dev and 44120 for Prod', () => {
    expect(defaultDesktopWebPort({ OMNIMUX_CHANNEL: 'dev' })).toBe(DESKTOP_DEV_WEB_PORT)
    expect(defaultDesktopWebPort({ OMNIMUX_DEV: '1' })).toBe(DESKTOP_DEV_WEB_PORT)
    expect(defaultDesktopWebPort({ NODE_ENV: 'development' })).toBe(DESKTOP_DEV_WEB_PORT)
    expect(defaultDesktopWebPort({ OMNIMUX_CHANNEL: 'prod' })).toBe(DESKTOP_PROD_WEB_PORT)
    expect(defaultDesktopWebPort({})).toBe(DESKTOP_PROD_WEB_PORT)
  })
  it('resolveDevCdpPort: Dev exposes a CDP port (default 9229)', () => {
    expect(resolveDevCdpPort({ env: { OMNIMUX_CHANNEL: 'dev' } })).toBe(DESKTOP_DEV_CDP_PORT_DEFAULT)
    expect(resolveDevCdpPort({ env: { OMNIMUX_DEV: '1' } })).toBe(DESKTOP_DEV_CDP_PORT_DEFAULT)
    expect(resolveDevCdpPort({ isDevLaunch: true, env: {} })).toBe(DESKTOP_DEV_CDP_PORT_DEFAULT)
  })

  it('resolveDevCdpPort: Dev port is overridable via OMNIMUX_DEV_CDP_PORT', () => {
    expect(resolveDevCdpPort({ env: { OMNIMUX_CHANNEL: 'dev', OMNIMUX_DEV_CDP_PORT: '9333' } })).toBe('9333')
  })

  it('resolveDevCdpPort: Prod never exposes CDP', () => {
    expect(resolveDevCdpPort({ env: { OMNIMUX_CHANNEL: 'prod' } })).toBeNull()
    expect(resolveDevCdpPort({ isDevLaunch: false, env: {} })).toBeNull()
  })

})
