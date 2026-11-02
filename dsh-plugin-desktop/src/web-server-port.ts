/**
 * The bound loopback port of the Desktop WebServer.
 *
 * The upstream service publishes its port only once the listener is bound, so
 * the type is optional. Every Desktop call site here runs on the startup path
 * after that bind, where a missing port means the launch order changed; failing
 * loudly keeps a half-built URL or TLS edge from being created silently.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** The bound Desktop WebServer port, or a loud failure when it is not bound yet. */
export function requireWebServerPort(ctx: Context): number {
  const port = ctx.webServer.port
  if (port === undefined) {
    throw new Error('dsh-plugin-desktop: the desktop WebServer has not bound its port yet')
  }
  return port
}
