/** Build a Windows x64 NSIS installer signed with Azure Trusted Signing. */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertWindowsReleaseReady,
  withoutWindowsTrustedSigningSecrets,
  type WindowsReleasePreflightResult,
} from './windows-release-preflight.ts'

/** Injectable release boundary used by focused tests. */
export interface WindowsReleaseOptions {
  /** Environment containing Trusted Signing and Azure credentials. */
  readonly env: NodeJS.ProcessEnv
  /** Platform executing the release. */
  readonly platform: NodeJS.Platform
  /** Node architecture executing the release. */
  readonly arch: string
  /** Node version executing the release. */
  readonly nodeVersion: string
  /** Repository root containing the Yarn workspace. */
  readonly workspaceRoot: string
  /** Desktop package root containing electron-builder configuration. */
  readonly desktopRoot: string
  /** Dedicated signed-release output directory. */
  readonly outputDir: string
  /** Absolute electron-builder CLI module. */
  readonly builderCli: string
  /** Absolute signature verification script. */
  readonly signatureVerifier: string
  /** Node executable used to run package-local scripts. */
  readonly nodeExecutable: string
  /** Absolute native Windows command interpreter. */
  readonly commandShell: string
  /** Remove only the dedicated generated release output before packaging. */
  readonly resetOutput: () => void
  /** Execute one release command. */
  readonly run: (
    command: string,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) => void
  /** Report non-secret release progress. */
  readonly log: (message: string) => void
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

function assertWindowsReleaseHost(options: WindowsReleaseOptions): void {
  if (options.platform !== 'win32') {
    throw new Error('Windows Trusted Signing release must run on a native Windows host')
  }
  if (options.arch !== 'x64') {
    throw new Error(`Windows Trusted Signing release requires x64 Node; received ${options.arch}`)
  }
  const versionMatch = /^(\d+)\.(\d+)\./u.exec(options.nodeVersion)
  const major = Number(versionMatch?.[1])
  const minor = Number(versionMatch?.[2])
  if (!((major === 22 && minor >= 19) || major === 24)) {
    throw new Error(
      `Windows Trusted Signing release requires Node 22.19+ or Node 24.x with bundled Corepack; received ${options.nodeVersion}`,
    )
  }
}

function defaultReleaseOptions(): WindowsReleaseOptions {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const workspaceRoot = resolve(desktopRoot, '..')
  const outputDir = resolve(desktopRoot, 'dist', 'win-release')
  const require = createRequire(import.meta.url)
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR
  return {
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    workspaceRoot,
    desktopRoot,
    outputDir,
    builderCli: require.resolve('electron-builder/cli.js'),
    signatureVerifier: fileURLToPath(new URL('./verify-win-signature.ts', import.meta.url)),
    nodeExecutable: process.execPath,
    commandShell: windowsRoot === undefined || windowsRoot.length === 0
      ? 'cmd.exe'
      : join(windowsRoot, 'System32', 'cmd.exe'),
    resetOutput: () => rmSync(outputDir, { recursive: true, force: true }),
    run,
    log: message => console.log(message),
  }
}

function builderArgs(
  options: WindowsReleaseOptions,
  preflight: WindowsReleasePreflightResult,
): string[] {
  return [
    options.builderCli,
    '--win',
    'nsis',
    '--x64',
    '--publish',
    'never',
    '--config.forceCodeSigning=true',
    '--config.npmRebuild=false',
    `--config.directories.output=${options.outputDir}`,
    `--config.win.azureSignOptions.publisherName=${preflight.publisherName}`,
    `--config.win.azureSignOptions.endpoint=${preflight.endpoint}`,
    `--config.win.azureSignOptions.codeSigningAccountName=${preflight.account}`,
    `--config.win.azureSignOptions.certificateProfileName=${preflight.certificateProfile}`,
    '--config.win.azureSignOptions.fileDigest=SHA256',
    '--config.win.azureSignOptions.timestampRfc3161=http://timestamp.acs.microsoft.com',
    '--config.win.azureSignOptions.timestampDigest=SHA256',
  ]
}

/**
 * Build the Windows installer while exposing Trusted Signing credentials only to Electron Builder.
 * @param options - Injectable process and command boundaries.
 */
export function releaseWindows(options: WindowsReleaseOptions = defaultReleaseOptions()): void {
  assertWindowsReleaseHost(options)
  const preflight = assertWindowsReleaseReady({
    env: options.env,
    platform: options.platform,
    arch: options.arch,
  })
  const buildEnvironment = withoutWindowsTrustedSigningSecrets(options.env)
  options.log(
    `Windows Trusted Signing preflight passed: account=${preflight.account}; profile=${preflight.certificateProfile}; auth=${preflight.authentication}`,
  )

  if (options.env.DSH_PACKAGE_CHECK_ALREADY_RAN !== '1') {
    options.run(
      options.commandShell,
      ['/d', '/s', '/c', 'corepack yarn workspace dsh-plugin-desktop check:win-package'],
      options.workspaceRoot,
      buildEnvironment,
    )
  } else {
    options.log('Skipping the Windows package preflight; the package gate already passed.')
  }

  options.resetOutput()
  options.run(
    options.nodeExecutable,
    builderArgs(options, preflight),
    options.desktopRoot,
    options.env,
  )
  options.run(
    options.nodeExecutable,
    [options.signatureVerifier, `--output-dir=${options.outputDir}`],
    options.desktopRoot,
    buildEnvironment,
  )
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    releaseWindows()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
