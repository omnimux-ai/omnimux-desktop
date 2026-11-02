/** Build an unsigned unpacked application for the current host platform. */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { electronBuilderEnvironment } from './electron-builder-environment.ts'
import { withoutWindowsSigningSecrets } from './package-win.ts'
import { withoutMacReleaseSecrets } from './release-preflight.ts'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { writeAppBuildInfo } from './build-info.mjs'

const require = createRequire(import.meta.url)
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const builderCli = require.resolve('electron-builder/cli.js')
const electronDist = resolve(dirname(require.resolve('electron/package.json')), 'dist')

/** Electron Builder overrides that make the directory build unconditionally unsigned. */
export const UNSIGNED_DIRECTORY_BUILD_ARGS = Object.freeze([
  '--dir',
  '--publish',
  'never',
  '--config.forceCodeSigning=false',
  '--config.mac.identity=null',
  '--config.mac.notarize=false',
  '--config.win.signExecutable=false',
])

/**
 * Remove every release credential recognized by the native release entry points.
 * @param {NodeJS.ProcessEnv} environment
 * @returns {NodeJS.ProcessEnv}
 */
export function unsignedDirectoryBuildEnvironment(environment) {
  return electronBuilderEnvironment({
    ...withoutWindowsSigningSecrets(withoutMacReleaseSecrets(environment)),
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  })
}

/**
 * Build an unsigned, unpacked application for the current host platform.
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   electronBuilderCli?: string,
 *   electronDistPath?: string,
 *   nodeExecutable?: string,
 *   run?: typeof spawnSync,
 * }} [options]
 */
export function packageDirectory(options = {}) {
  const run = options.run ?? spawnSync
  const nodeExecutable = options.nodeExecutable ?? process.execPath
  const electronBuilderCli = options.electronBuilderCli ?? builderCli
  const configuredElectronDist = options.electronDistPath ?? electronDist
  const result = run(
    nodeExecutable,
    [
      electronBuilderCli,
      ...UNSIGNED_DIRECTORY_BUILD_ARGS,
      `--config.electronDist=${configuredElectronDist}`,
    ],
    {
      cwd: options.cwd ?? packageRoot,
      env: unsignedDirectoryBuildEnvironment(options.env ?? process.env),
      stdio: 'inherit',
    },
  )

  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`electron-builder --dir exited with ${String(result.status)}`)
  }
}

const invokedPath = process.argv[1]
/** Locate the packaged release-channel marker: `asar: false` keeps app content in
 * `Resources/app`, while an asar build would unpack it to `app.asar.unpacked`. */
function packagedMarkerPath(appPath) {
  const candidates = [
    join(appPath, 'Contents', 'Resources', 'app', 'preset', 'plugins', 'omnimux', 'src', 'release-channel.json'),
    join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'preset', 'plugins', 'omnimux', 'src', 'release-channel.json'),
  ]
  const found = candidates.find(candidate => existsSync(candidate))
  return found ?? candidates[0]
}

if (invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath)) {
  packageDirectory()
  // Record build provenance so any agent can identify the source tree of this app.
  if (process.platform === 'darwin') {
    const appDir = join(packageRoot, 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac')
    for (const name of readdirSync(appDir)) {
      if (!name.endsWith('.app')) continue
      const appPath = join(appDir, name)
      const markerPath = packagedMarkerPath(appPath)
      const { channel } = JSON.parse(readFileSync(markerPath, 'utf8'))
      writeAppBuildInfo(appPath, channel === 'development' ? 'package-dev' : 'package-dir')
    }
  }
}
