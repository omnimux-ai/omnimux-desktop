/** Inspect the actual signatures, not merely the builder's entitlement input. */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export const NEXT_MAC_REQUIRED_ENTITLEMENTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation',
  'com.apple.security.device.audio-input',
] as const

type ReadEntitlements = (path: string, arch: string) => Record<string, unknown>

const readEntitlements: ReadEntitlements = (path, arch) => {
  const xml = execFileSync('codesign', ['-d', '--arch', arch, '--entitlements', ':-', path], { encoding: 'utf8' })
  return JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml, encoding: 'utf8' }))
}

/**
 * Every packaged CPU slice and every Electron Helper must retain microphone access.
 * A single-architecture release carries one slice, so the caller states which ones exist.
 */
export function verifyNextMacEntitlements(
  appPath: string,
  read: ReadEntitlements = readEntitlements,
  arches: readonly string[] = ['arm64', 'x86_64'],
): void {
  const targets = [appPath, ...['', ' (Renderer)', ' (GPU)', ' (Plugin)']
    .map(suffix => join(appPath, 'Contents', 'Frameworks', `OmniMux Helper${suffix}.app`))]
  for (const target of targets) {
    for (const arch of arches) {
      const entitlements = read(target, arch)
      for (const key of NEXT_MAC_REQUIRED_ENTITLEMENTS) {
        if (entitlements[key] !== true) throw new Error(`Missing macOS entitlement ${key} in ${target} (${arch})`)
      }
    }
  }
}
