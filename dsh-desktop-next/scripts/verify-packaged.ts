/** Cross-check the assembled `app.asar` payload against the prepared tree before signing, without a GUI. */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { archivedPayload, auditNextPayload, nextPackagingTarget, PAYLOAD_DIR, verifyArchiveAgainstPrepared, verifyNextPayload, verifyUpdaterManifestShim } from './packaged-payload.ts'
import { expectedNextVersion, verifyNextRuntimeTree } from './prepare-runtime.ts'
import { DESKTOP_RUNTIME_FILE } from '../src/runtime-tree.ts'
import { packagingStepSync } from './packaging-step.ts'
import { verifyWindowsCodeUnpacked } from './windows-asar-unpack.ts'

/** Resources directories already cross-checked by afterPack in the current packaging process. */
export const verifiedPackagedResources = new Set<string>()

interface PackContext {
  appOutDir: string
  electronPlatformName: string
  packager: { projectDir: string; appInfo: { version: string } }
}

/**
 * Electron Builder's afterPack hook. The archive and its unpacked files are one copy of the
 * installation; the prepared tree with its sealed descriptor is another. The archive must be
 * complete and resolvable, carry nothing the Desktop file policy omits, keep native and
 * shell-executed files unpacked, embed the prepared descriptor byte for byte, and match its
 * inventory exactly; the interpreter payloads copied as extra resources must declare this
 * platform, every CPU and the product version; macOS must carry the manifest copy that the
 * updaters of earlier releases read beside the archive, and nothing else there. Universal macOS
 * builds run this once per CPU and once more on the merged application; all three archives come
 * from the same prepared tree, and the merge may only have re-serialized nested `Info.plist` files.
 * @param context - Electron Builder's afterPack context.
 */
export default async function afterPack(context: PackContext): Promise<void> {
  const resources = context.electronPlatformName === 'darwin' ? join(context.appOutDir, 'OmniMux.app/Contents/Resources') : join(context.appOutDir, 'resources')
  if (!existsSync(join(resources, 'app.asar'))) throw new Error('Next must package its application into app.asar like upstream Desktop')
  if (context.electronPlatformName === 'darwin' && /-(?:x64|arm64)-temp$/u.test(context.appOutDir)) {
    // electron-builder's universal packager immediately merges the two temporary per-CPU bundles
    // into mac-universal, deletes both staging directories, and invokes afterPack on the merged app.
    return
  }
  const platform = context.electronPlatformName as NodeJS.Platform
  const source = packagingStepSync('archive:open', () => archivedPayload(resources))
  try {
    packagingStepSync('archive:verify-updater-shim', () => verifyUpdaterManifestShim(resources, source, platform, context.packager.appInfo.version))
    packagingStepSync('archive:verify-dependencies', () => verifyNextPayload(source))
    const target = nextPackagingTarget(platform)
    const problems = packagingStepSync('archive:audit', () => auditNextPayload(source, target))
    if (problems.length > 0) throw new Error(`Next payload audit failed:\n${problems.join('\n')}`)
    const prepared = join(context.packager.projectDir, ...PAYLOAD_DIR.split('/'), DESKTOP_RUNTIME_FILE)
    const { descriptor, rewrittenPlists } = packagingStepSync('archive:verify-bytes', () => verifyArchiveAgainstPrepared(source, prepared, context.packager.appInfo.version, target))
    if (platform === 'win32') packagingStepSync('archive:verify-pe-unpack', () => verifyWindowsCodeUnpacked(source, join(context.packager.projectDir, ...PAYLOAD_DIR.split('/'))))
    const unpacked = source.list().filter(entry => entry.unpacked).length
    const { release } = descriptor
    console.log(`Verified the archive against the prepared Next payload: ${String(descriptor.files.length)} files (${String(unpacked)} unpacked) for ${descriptor.platform} ${descriptor.archs.join('/')}; `
      + `OmniMux ${release.version}, dsh ${release.dshVersion}, Electron ${release.electronVersion}, pnpm ${release.pnpmVersion}`
      + (rewrittenPlists.length === 0 ? '' : `; the universal merge rewrote ${rewrittenPlists.join(', ')}`))
  } finally { source.close() }
  const runtimes = packagingStepSync('runtime:verify-packaged', () => verifyNextRuntimeTree(join(resources, 'runtime'), platform, expectedNextVersion(context.packager.projectDir)))
  for (const runtime of runtimes) console.log(`Verified the ${runtime.arch} primary runtime: Python ${runtime.manifest.python}, Node ${runtime.manifest.node}, pnpm ${runtime.manifest.pnpm}`)
  // Thin any universal (fat) Mach-O binaries to the target architecture.
  // Upstream deps (@trycua, lxml, etc.) ship universal binaries that trigger
  // Gatekeeper's Rosetta warning on Apple Silicon when only arm64 is needed.
  if (platform === 'darwin') {
    const targetArch = context.appOutDir.endsWith('-arm64') ? 'arm64' : 'x86_64'
    const thinned = packagingStepSync('thin:universal-binaries', () => thinUniversalBinaries(resources, targetArch))
    if (thinned.length > 0) console.log(`Thinned ${thinned.length} universal binary(ies) to ${targetArch}: ${thinned.join(', ')}`)
  }
  verifiedPackagedResources.add(resolve(resources))
  await Promise.resolve()
}

/**
 * Scan `app.asar.unpacked` and `runtime/` for universal Mach-O binaries and
 * `lipo -thin` them to the target architecture.  A universal binary contains
 * both x86_64 and arm64 slices; on a single-arch package it triggers a
 * Gatekeeper "install Rosetta" prompt.  Returns the relative paths thinned.
 * @param resources - `Contents/Resources` inside the staged .app bundle.
 * @param targetArch - `arm64` or `x86_64` matching `context.appOutDir`.
 */
function thinUniversalBinaries(resources: string, targetArch: 'arm64' | 'x86_64'): string[] {
  const thinned: string[] = []
  const dirs = [join(resources, 'app.asar.unpacked'), join(resources, 'runtime')]
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const entry of walkExecutables(dir)) {
      const file = join(dir, entry)
      if (!isUniversalMachO(file)) continue
      execFileSync('lipo', [file, '-thin', targetArch, '-output', file])
      thinned.push(entry)
    }
  }
  return thinned
}

/** Recursively collect executable files under a directory, relative to it. */
function walkExecutables(dir: string): string[] {
  const entries: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) entries.push(...walkExecutables(full).map(e => `${name}/${e}`))
    else if ((stat.mode & 0o111) !== 0) entries.push(name)
  }
  return entries
}

/** Check whether a file is a universal Mach-O binary (contains both x86_64 and arm64). */
function isUniversalMachO(file: string): boolean {
  try {
    const fileType = execFileSync('file', ['-b', file], { encoding: 'utf8' })
    if (!fileType.includes('Mach-O')) return false
    const out = execFileSync('lipo', ['-info', file], { encoding: 'utf8' })
    return out.includes('x86_64') && out.includes('arm64')
  } catch { return false }
}
