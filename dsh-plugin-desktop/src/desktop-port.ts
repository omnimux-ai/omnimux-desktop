/** Shared Desktop Web port policy. */

/**
 * OmniMux production loopback Host port.
 * Upstream DSH Desktop uses 43120 and retries +1 through +32 on EADDRINUSE.
 * Keep this outside that window so a default dual install (OmniMux + DSH Desktop)
 * does not collide.
 */
export const DESKTOP_PROD_WEB_PORT = 44_120

/**
 * OmniMux Dev loopback Host port (Issue #350 & omnimux-dsh dev-pipeline contract).
 * Keeps Dev App (L3-Dev) and Prod App (L3-Prod) completely isolated on distinct ports.
 */
export const DESKTOP_DEV_WEB_PORT = 45_120

/** Default production port fallback. */
export const DESKTOP_DEFAULT_WEB_PORT = DESKTOP_PROD_WEB_PORT

/** Maximum number of sequential ports tried after a bind collision or a Windows-reserved port. */
export const DESKTOP_WEB_PORT_RETRY_LIMIT = 32

/** Select the default loopback Web port based on runtime Dev/Prod channel identity. */
export function defaultDesktopWebPort(env: NodeJS.ProcessEnv = process.env): number {
  const channel = (env.OMNIMUX_CHANNEL ?? '').trim().toLowerCase()
  if (
    channel === 'dev'
    || env.OMNIMUX_DEV === '1'
    || env.NODE_ENV === 'development'
    || env.DSH_DESKTOP_DEV === '1'
  ) {
    return DESKTOP_DEV_WEB_PORT
  }
  return DESKTOP_PROD_WEB_PORT
}
