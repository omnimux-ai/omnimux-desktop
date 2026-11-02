/**
 * OmniMux product identity for the Next shell.
 *
 * The Next shell was adopted from upstream as a grey box under its own identity
 * (`DSH NEXT` / `ai.deepseek.dsh.desktop.next` / `~/.dsh`). OmniMux ships it as
 * the product shell, so every user-visible name, the bundle identifier and the
 * harness home must match the already-shipped OmniMux line instead.
 *
 * Two values are load-bearing and must never drift:
 * - `appId` keeps the shipped `ai.omnimux.desktop` so the OS treats an upgrade as
 *   the same application rather than a second install.
 * - `homeDirectoryName` keeps `.omnimux` so an existing installation's sessions,
 *   settings and plugins stay visible after the shell swap.
 */

export interface DesktopProductIdentity {
  readonly releaseChannel: 'stable' | 'development'
  readonly packageName: string
  /** electron-builder `productName`; also the macOS bundle and executable name. */
  readonly productName: string
  readonly appId: string
  /** Harness home under the user's home directory. */
  readonly homeDirectoryName: string
  /** Directory name under Electron's `appData` for the window/Chromium state. */
  readonly userDataDirectoryName: string
}

export const DESKTOP_RELEASE_IDENTITIES = Object.freeze({
  stable: Object.freeze({
    releaseChannel: 'stable' as const,
    packageName: 'dsh-desktop-next',
    productName: 'OmniMux',
    appId: 'ai.omnimux.desktop',
    homeDirectoryName: '.omnimux',
    userDataDirectoryName: 'OmniMux',
  }),
  development: Object.freeze({
    releaseChannel: 'development' as const,
    packageName: 'dsh-desktop-next',
    // Must match the Dev app's real userData directory so cross-edition evidence
    // keeps resolving through the same name.
    productName: 'OmniMux-Dev',
    appId: 'ai.omnimux.desktop',
    homeDirectoryName: '.omnimux-dev',
    userDataDirectoryName: 'OmniMux-Dev',
  }),
})

export type DesktopReleaseChannel = keyof typeof DESKTOP_RELEASE_IDENTITIES

/** Resolve the identity for a channel, defaulting to the shipped one. */
export function desktopIdentity(channel: DesktopReleaseChannel = 'stable'): DesktopProductIdentity {
  return DESKTOP_RELEASE_IDENTITIES[channel]
}

/** OmniMux stable identity, aligned with electron-builder's `build` block. */
export const DESKTOP_PRODUCT_IDENTITY = DESKTOP_RELEASE_IDENTITIES.stable
export const DESKTOP_PRODUCT_NAME = DESKTOP_PRODUCT_IDENTITY.productName
export const DESKTOP_APP_ID = DESKTOP_PRODUCT_IDENTITY.appId
export const DESKTOP_HOME_DIRECTORY_NAME = DESKTOP_PRODUCT_IDENTITY.homeDirectoryName
export const DESKTOP_USER_DATA_DIRECTORY_NAME = DESKTOP_PRODUCT_IDENTITY.userDataDirectoryName
