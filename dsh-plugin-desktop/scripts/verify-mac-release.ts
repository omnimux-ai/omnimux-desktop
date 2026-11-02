/** Verify the signed application sealed inside one macOS release DMG. */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MACOS_UNIVERSAL_NATIVE_ENTRIES } from './mac-universal.ts'
import { verifyMacEntitlements } from './verify-mac-entitlements.ts'
import { verifyDesktopMacRuntime } from './verify-mac-runtime.ts'

/** Injectable filesystem and command boundaries for release verification. */
export interface MacReleaseVerificationOptions {
  /** CPU slices the packaged executable must carry; both for a universal release. */
  readonly archSlices?: readonly string[]
  /** Native inventory for shells which do not load legacy-only modules. */
  readonly nativeEntries?: readonly { readonly arch: string; readonly path: string }[]
  /** Physical runtime root inside the application; the unpacked `Resources/app` layout by default. */
  readonly unpackedRoot?: (appPath: string) => string
  /** Directory containing exactly one release DMG. */
  readonly distDir: string
  /** Installed application name inside the mounted image. */
  readonly productName: string
  /** Return regular DMG files in the distribution directory. */
  readonly listDmgs: (distDir: string) => readonly string[]
  /** Create a private empty mount point. */
  readonly makeMountPoint: () => string
  /** Execute one macOS verification command. */
  readonly run: (command: string, args: readonly string[]) => void
  /** Inspect signed main/Helper entitlements; custom verifiers may own this check. */
  readonly verifyEntitlements?: (appPath: string, productName: string) => void
  /** Check resources beside the archive, such as bundled interpreter payloads, inside the mounted application. */
  readonly verifyRuntime?: (appPath: string) => void
  /** Remove the detached empty mount point. */
  readonly removeMountPoint: (mountPoint: string) => void
}

function listDmgs(distDir: string): readonly string[] {
  return readdirSync(distDir)
    .filter(name => name.endsWith('.dmg'))
    .map(name => join(distDir, name))
    .filter(path => statSync(path).isFile())
}

// One verification subprocess gets up to ten minutes; the release build already proved the
// chain signs and notarizes, so a verify step must never be able to stall the job all the
// way to the CI timeout without naming the culprit (as happened on the 1.6GB image).
const VERIFY_COMMAND_TIMEOUT_MS = 10 * 60 * 1000

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit', timeout: VERIFY_COMMAND_TIMEOUT_MS })
  if (result.error !== undefined) throw result.error
  if (result.signal === 'SIGTERM') {
    throw new Error(`${command} ${args.join(' ')} timed out after ${VERIFY_COMMAND_TIMEOUT_MS / 60000}m`)
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

function defaultOptions(): MacReleaseVerificationOptions {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  return {
    distDir: process.argv[2] === undefined
      ? join(packageRoot, 'dist', 'mac-release')
      : resolve(process.argv[2]),
    productName: 'OmniMux',
    listDmgs,
    makeMountPoint: () => mkdtempSync(join(tmpdir(), 'omnimux-dmg-')),
    run,
    verifyEntitlements: verifyMacEntitlements,
    // The interpreter payloads beside the application: both CPUs present, the host CPU executed, release signatures checked.
    verifyRuntime: appPath => verifyDesktopMacRuntime(appPath, true),
    removeMountPoint: mountPoint => rmdirSync(mountPoint),
  }
}

/**
 * Mount and verify the application contained in the unique release DMG.
 * @param options - Filesystem and command boundaries.
 * @returns The verified DMG and application paths.
 */
export function verifyMacRelease(
  options: MacReleaseVerificationOptions = defaultOptions(),
): { readonly appPath: string; readonly dmgPath: string } {
  const dmgs = options.listDmgs(options.distDir)
  if (dmgs.length !== 1) {
    throw new Error(
      `macOS release verification requires exactly one DMG in ${options.distDir}; found ${String(dmgs.length)}`,
    )
  }

  const dmgPath = dmgs[0]!
  const mountPoint = options.makeMountPoint()
  const appPath = join(mountPoint, `${options.productName}.app`)
  let mounted = false
  let failure: unknown

  try {
    options.run('hdiutil', ['attach', dmgPath, '-mountpoint', mountPoint, '-nobrowse', '-readonly'])
    mounted = true
    const executablePath = join(appPath, 'Contents', 'MacOS', options.productName)
    for (const slice of options.archSlices ?? ['x86_64', 'arm64']) {
      console.log(`[verify-mac] lipo executable ${slice}`)
      options.run('lipo', [executablePath, '-verify_arch', slice])
    }
    const unpackedRoot = options.unpackedRoot === undefined ? join(appPath, 'Contents', 'Resources', 'app') : options.unpackedRoot(appPath)
    for (const entry of options.nativeEntries ?? MACOS_UNIVERSAL_NATIVE_ENTRIES) {
      console.log(`[verify-mac] lipo native ${entry.arch} ${entry.path}`)
      options.run('lipo', [join(unpackedRoot, entry.path), '-verify_arch', entry.arch])
      if (entry.path.endsWith('/bin/uv')) {
        options.run('/bin/test', ['-x', join(unpackedRoot, entry.path)])
        if (entry.arch === (process.arch === 'x64' ? 'x86_64' : process.arch)) {
          console.log(`[verify-mac] exec uv --version`)
          options.run(join(unpackedRoot, entry.path), ['--version'])
        }
      }
    }
    console.log(`[verify-mac] codesign --verify --deep app`)
    options.run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
    console.log(`[verify-mac] entitlements`)
    options.verifyEntitlements?.(appPath, options.productName)
    console.log(`[verify-mac] runtime payload`)
    options.verifyRuntime?.(appPath)
    console.log(`[verify-mac] spctl assess`)
    options.run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath])
    console.log(`[verify-mac] stapler validate`)
    options.run('xcrun', ['stapler', 'validate', appPath])
  } catch (cause) {
    failure = cause
  }

  const cleanupFailures: unknown[] = []
  if (mounted) {
    try {
      options.run('hdiutil', ['detach', mountPoint])
    } catch (cause) {
      cleanupFailures.push(cause)
    }
  }
  try {
    options.removeMountPoint(mountPoint)
  } catch (cause) {
    cleanupFailures.push(cause)
  }

  if (failure !== undefined || cleanupFailures.length > 0) {
    const failures = failure === undefined ? cleanupFailures : [failure, ...cleanupFailures]
    throw new AggregateError(failures, `failed to verify macOS release DMG ${basename(dmgPath)}`)
  }
  return { appPath, dmgPath }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    const verified = verifyMacRelease()
    console.log(`macOS release verification passed: ${verified.dmgPath}`)
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
