/** OmniMux Dev / Prod launch identity helpers (no Electron import). */

/**
 * True when this process should bind the Dev harness home (`~/.omnimux-dev`).
 *
 * Bundle path / app name win over a stale `LSEnvironment.OMNIMUX_CHANNEL=prod`
 * that older Dev.app copies inherited from the Prod electron-builder config.
 */
export function isOmnimuxDevLaunch(input: {
  readonly env?: NodeJS.ProcessEnv
  readonly execPath?: string
  readonly appName?: string
  readonly userDataDir?: string
}): boolean {
  const env = input.env ?? process.env
  const execPath = input.execPath ?? process.execPath
  const appName = input.appName ?? ''
  const userData = input.userDataDir ?? ''
  const channel = (env.OMNIMUX_CHANNEL ?? '').trim().toLowerCase()

  if (channel === 'dev' || env.OMNIMUX_DEV === '1') return true
  if (
    execPath.includes('OmniMux Dev')
    || execPath.includes('OmniMux-Dev')
    || appName.includes('Dev')
    || userData.includes('OmniMux-Dev')
    || userData.includes('omnimux-dev')
  ) {
    return true
  }
  return env.NODE_ENV === 'development' || env.DSH_DESKTOP_DEV === '1'
}

/** Force Dev channel markers into process.env after Dev identity is detected. */
export function applyOmnimuxDevEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  env.OMNIMUX_CHANNEL = 'dev'
  env.OMNIMUX_DEV = '1'
}


/** Default Chromium DevTools protocol (CDP) port for Dev-only agent automation. */
export const DESKTOP_DEV_CDP_PORT_DEFAULT = '9229'

/**
 * Resolve the Dev-only remote-debugging port the desktop shell should expose.
 * - Dev launch: returns a port (default 9229, overridable via
 *   OMNIMUX_DEV_CDP_PORT) so agents can drive the real Electron renderer.
 * - Prod / release launch: returns null (CDP never exposed).
 */
export function resolveDevCdpPort(input: {
  readonly env?: NodeJS.ProcessEnv
  readonly isDevLaunch?: boolean
}): string | null {
  const env = input.env ?? process.env
  const isDev = input.isDevLaunch ?? isOmnimuxDevLaunch({ env })
  if (!isDev) return null
  const port = (env.OMNIMUX_DEV_CDP_PORT ?? '').trim()
  if (port !== '') return port
  return DESKTOP_DEV_CDP_PORT_DEFAULT
}
