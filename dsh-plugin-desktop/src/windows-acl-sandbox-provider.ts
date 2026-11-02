/** Electron adapter for the upstream Windows ACL sandbox provider. */

import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { adaptWindowsAclArgv, desktopWindowsAclAdaptation } from './windows-pwsh-sandbox.ts'

/**
 * Sandbox provider that inserts the desktop Node-mode trampoline for Electron.
 *
 * The PowerShell executor cannot do this: the trampoline belongs after confinement,
 * while that executor's only declared argv seam runs before it, and the base class
 * keeps its confinement step private. Wrapping this provider's public `confine`
 * also leaves the upstream health probe on the untouched runner invocation.
 */
export class DesktopWindowsAclSandboxProvider extends LocalSandboxProvider {
  override async confine(
    argv: readonly string[],
    policy: SandboxPolicy,
    signal?: AbortSignal,
  ): Promise<ConfinedArgv> {
    const confined = await super.confine(argv, policy, signal)
    const adapted = adaptWindowsAclArgv(confined.argv, desktopWindowsAclAdaptation())
    return adapted === confined.argv ? confined : { ...confined, argv: [...adapted] }
  }
}

export default DesktopWindowsAclSandboxProvider
