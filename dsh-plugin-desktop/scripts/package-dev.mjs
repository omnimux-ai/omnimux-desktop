#!/usr/bin/env node
/** Build a development preset and stamp the resulting unpacked macOS app. */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * @param {{
 *   platform?: NodeJS.Platform,
 *   arch?: string,
 *   run?: (command: string, args: readonly string[], options: import('node:child_process').SpawnSyncOptions) => { status: number | null, error?: Error },
 * }} options
 */
export function packageDev({ platform = process.platform, arch = process.arch, run = spawnSync } = {}) {
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) {
    throw new Error('package:dev requires a native macOS arm64 or x64 host')
  }
  const { build } = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const appPath = join(packageRoot, 'dist', arch === 'arm64' ? 'mac-arm64' : 'mac', `${build.productName}.app`)
  const steps = [
    ['corepack', ['yarn', 'run', 'build']],
    // `package:dir` runs these two before staging; without them electron-builder
    // fails on the native prebuild (Electron ABI mismatch) or on the missing
    // primary-runtime payload. Keep the same order so a Dev build and a plain
    // directory build cannot drift apart again.
    [process.execPath, [join(packageRoot, 'scripts', 'prepare-fs-ext.ts')]],
    [process.execPath, [join(packageRoot, 'scripts', 'prepare-runtime.ts')]],
    [process.execPath, [join(packageRoot, 'scripts', 'stage-preset-profile.ts'), '--channel', 'development']],
    [process.execPath, [join(packageRoot, 'scripts', 'package-dir.mjs')]],
    [process.execPath, [join(packageRoot, 'scripts', 'stamp-dev-app.mjs'), appPath]],
    // stamp-dev-app rewrites Info.plist after electron-builder signed the bundle,
    // which invalidates that signature and makes LaunchServices refuse to open the
    // app (error -54). Re-apply the ad-hoc signature over the stamped bundle.
    ['codesign', ['--force', '--deep', '--sign', '-', appPath]],
  ]
  for (const [command, args] of steps) {
    const result = run(command, args, { cwd: packageRoot, env: process.env, stdio: 'inherit' })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
  return appPath
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageDev()
}
