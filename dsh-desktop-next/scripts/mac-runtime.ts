import { chmodSync, existsSync } from 'node:fs'
import { MACOS_UNIVERSAL_NATIVE_ENTRIES, prepareMacUniversalRuntime } from '../../dsh-plugin-desktop/scripts/mac-universal.ts'
import { nextRuntimeUnusedFeatureExclusion } from './runtime-file-policy.ts'

/** Package name of a `node_modules/...` native entry. */
function entryPackage(path: string): string {
  const parts = path.split('/').slice(1)
  return parts.slice(0, parts[0]?.startsWith('@') ? 2 : 1).join('/')
}

// Next uses the official Host, which has no dependency on the old desktop lock binding, and does not
// ship the unused features runtime-file-policy.ts leaves out of the payload (such as the uv runtime).
export const NEXT_MAC_NATIVE_ENTRIES = [
  ...MACOS_UNIVERSAL_NATIVE_ENTRIES.filter(entry => !entry.path.startsWith('node_modules/fs-ext/')
    && nextRuntimeUnusedFeatureExclusion(entryPackage(entry.path)) === undefined),
  { arch: 'arm64' as const, path: 'node_modules/@trycua/cua-driver-darwin-arm64/cua_driver_node_runtime.node' },
  { arch: 'x86_64' as const, path: 'node_modules/@trycua/cua-driver-darwin-x64/cua_driver_node_runtime.node' },
  { arch: 'arm64' as const, path: 'node_modules/@ubjs/node-darwin-arm64/uniffi-runtime-napi.darwin-arm64.node' },
  { arch: 'x86_64' as const, path: 'node_modules/@ubjs/node-darwin-x64/uniffi-runtime-napi.darwin-x64.node' },
]
export function prepareNextMacRuntime(desktopRoot: string): void {
  prepareMacUniversalRuntime({ desktopRoot, nativeEntries: NEXT_MAC_NATIVE_ENTRIES, exists: existsSync, chmod: chmodSync })
}
