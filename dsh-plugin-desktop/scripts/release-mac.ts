/** Build a signed and notarized macOS DMG from validated release credentials. */

import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  adaptMacReleaseEnvironment,
  assertMacReleaseReady,
  withoutMacReleaseSecrets,
} from './release-preflight.ts'
import { prepareInstalledMacUniversalRuntime } from './mac-universal.ts'

/** Architectures the signed macOS release can package. */
export type MacReleaseArchitecture = 'universal' | 'arm64' | 'x64'

/**
 * Read the release architecture from `DSH_MAC_RELEASE_ARCH`, defaulting to the
 * universal application the signed release ships. Release builds separate the
 * concept from `DSH_MAC_SMOKE_ARCH` so CI smoke selection never changes what
 * a release package.
 * @param environment - Environment of the packaging process.
 * @returns The electron-builder architecture to package.
 */
export function macReleaseArchitecture(environment: NodeJS.ProcessEnv): MacReleaseArchitecture {
  const value = environment.DSH_MAC_RELEASE_ARCH
  if (value === undefined || value === '') return 'universal'
  if (value === 'universal' || value === 'arm64' || value === 'x64') return value
  throw new Error(
    `DSH_MAC_RELEASE_ARCH must be universal, arm64, or x64; received ${JSON.stringify(value)}`,
  )
}
import { prepareFsExtForElectron } from './prepare-fs-ext.ts'
import { electronBuilderEnvironment } from './electron-builder-environment.ts'
import { desktopRuntimeTargets, prepareDesktopInterpreters, primaryRuntimeDirectory, verifyPreparedDesktopRuntime } from './prepare-runtime.ts'
import { signMacRuntime, withMacSigningIdentity } from './sign-runtime.ts'

/** Injectable release boundary used by focused tests. */
export interface MacReleaseOptions {
  /** Environment containing the selected signing and notarization credentials. */
  readonly env: NodeJS.ProcessEnv
  /** Platform executing the release. */
  readonly platform: NodeJS.Platform
  /** Desktop package root containing package.json. */
  readonly desktopRoot: string
  /** Dedicated signed-release output directory, isolated from historical artifacts. */
  readonly outputDir: string
  /** Remove only the dedicated generated release output before packaging. */
  readonly resetOutput: () => void
  /** Read code-signing identities with a credential-free environment. */
  readonly listCodeSigningIdentities: (env: NodeJS.ProcessEnv) => string
  /** Execute one release command. */
  readonly run: (
    command: string,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) => void
  /** Report non-secret release progress. */
  readonly log: (message: string) => void
  /** Target macOS architecture: universal merges arm64+x64, single arch produces a leaner DMG. */
  readonly releaseArch: 'universal' | 'arm64' | 'x64'
  /** Validate and prepare the architecture-specific runtime trees matching releaseArch. */
  readonly prepareRuntime: () => void
}

function listCodeSigningIdentities(env: NodeJS.ProcessEnv): string {
  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
    env,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`security find-identity exited with ${String(result.status)}`)
  }
  return result.stdout
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

function defaultReleaseOptions(): MacReleaseOptions {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const outputDir = resolve(desktopRoot, 'dist', 'mac-release')
  const releaseArch = macReleaseArchitecture(process.env)
  return {
    env: process.env,
    platform: process.platform,
    desktopRoot,
    outputDir,
    releaseArch,
    resetOutput: () => rmSync(outputDir, { recursive: true, force: true }),
    listCodeSigningIdentities,
    run,
    log: message => console.log(message),
    prepareRuntime: () => {
      if (releaseArch === 'universal') {
        prepareFsExtForElectron({ platform: 'darwin', arch: 'arm64', desktopRoot })
        prepareFsExtForElectron({ platform: 'darwin', arch: 'x64', desktopRoot })
        prepareInstalledMacUniversalRuntime(desktopRoot)
      } else {
        const arch = releaseArch === 'arm64' ? 'arm64' : 'x64'
        prepareFsExtForElectron({ platform: 'darwin', arch, desktopRoot })
      }
      verifyPreparedDesktopRuntime(desktopRoot, 'darwin')
    },
  }
}

/**
 * Build the macOS artifact while exposing release secrets only to Electron Builder.
 * @param options - Injectable process and command boundaries.
 */
export function releaseMac(options: MacReleaseOptions = defaultReleaseOptions()): void {
  const releaseEnvironment = adaptMacReleaseEnvironment(options.env)
  const buildEnvironment = withoutMacReleaseSecrets(releaseEnvironment)
  const result = assertMacReleaseReady({
    env: releaseEnvironment,
    platform: options.platform,
    listCodeSigningIdentities: () => options.listCodeSigningIdentities(buildEnvironment),
  })
  options.log(
    `macOS release preflight passed: ${result.identity}; signing via ${result.signing}; notarization via ${result.notarization}`,
  )

  // The workspace check includes the package build and repository-layout gate. Signing
  // material is withheld from every build, test, Loader smoke, and layout subprocess.
  options.run(
    process.execPath,
    ['scripts/prepare-agents-anywhere-release.mjs', '--verify-release'],
    resolve(options.desktopRoot, '..'),
    buildEnvironment,
  )
  options.run(process.execPath, ['scripts/prepare-dsh-market.mjs', '--check'], resolve(options.desktopRoot, '..'), buildEnvironment)
  options.run('yarn', ['run', 'check'], resolve(options.desktopRoot, '..'), buildEnvironment)
  options.resetOutput()
  options.prepareRuntime()
  const archFlag = options.releaseArch === 'universal' ? '--universal'
    : options.releaseArch === 'arm64' ? '--arm64' : '--x64'
  options.log(`macOS release target: ${options.releaseArch}`)
  // electron-builder auto-enables publishing when it detects CI and then aborts the
  // whole packaging step with "GitHub Personal Access Token is not set". Releasing is
  // the workflow's job (artifact upload plus the publish job), so the build declares
  // that it never publishes on its own.
  options.run('yarn', [
    'exec', 'electron-builder', '--mac', 'dmg', archFlag,
    '--config.forceCodeSigning=true', '--config.mac.notarize=true',
    '--config.npmRebuild=false', '--publish', 'never',
    `--config.directories.output=${options.outputDir}`,
  ], options.desktopRoot, electronBuilderEnvironment(releaseEnvironment))
  options.run(
    process.execPath,
    ['scripts/verify-mac-release.ts', options.outputDir],
    options.desktopRoot,
    buildEnvironment,
  )
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    // The preflight the release flow repeats; the payload signatures must carry the identity it selects.
    const releaseEnvironment = adaptMacReleaseEnvironment(process.env)
    const ready = assertMacReleaseReady({
      env: releaseEnvironment,
      platform: process.platform,
      listCodeSigningIdentities: () => listCodeSigningIdentities(withoutMacReleaseSecrets(releaseEnvironment)),
    })
    const appId = (JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8')) as { build: { appId: string } }).build.appId
    // Like upstream Desktop, every Mach-O payload file is signed before electron-builder runs; osx-sign would leave the Python extension modules unsigned.
    await prepareDesktopInterpreters({
      desktopRoot,
      sign: runtimeRoot => withMacSigningIdentity(releaseEnvironment, ready.identity, async (signer) => {
        for (const { arch } of desktopRuntimeTargets('darwin')) {
          const signed = await signMacRuntime(primaryRuntimeDirectory(runtimeRoot, arch), appId, signer, arch)
          console.log(`Signed ${String(signed)} native files of the ${arch} primary runtime as ${ready.identity}`)
        }
      }),
    })
    releaseMac()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
