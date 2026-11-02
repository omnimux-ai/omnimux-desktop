/** Verify that Windows release PE files carry a valid Authenticode signature. */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPortableExecutable } from './verify-win-installer.ts'

/** Paths returned after Windows signature verification succeeds. */
export interface WindowsSignatureArtifacts {
  /** Unpacked application executable path. */
  readonly applicationPath: string
  /** NSIS installer path. */
  readonly installerPath: string
}

/** Injectable Windows signature verification boundary. */
export interface WindowsSignatureVerificationOptions {
  /** Desktop package root containing package.json. */
  readonly desktopRoot: string
  /** Directory that contains the signed installer / unpacked app. */
  readonly outputDir: string
  /** Product version embedded in the expected artifact name. */
  readonly version: string
  /** Platform executing the verifier. */
  readonly platform: NodeJS.Platform
  /** Execute PowerShell Get-AuthenticodeSignature for one PE path. */
  readonly readSignatureStatus: (path: string) => string
}

function readVersion(desktopRoot: string): string {
  const manifest = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as {
    version?: unknown
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`desktop package at ${desktopRoot} has no valid version`)
  }
  return manifest.version
}

function parseOutputDirArg(argv: readonly string[]): string | undefined {
  for (const arg of argv) {
    if (arg.startsWith('--output-dir=')) return arg.slice('--output-dir='.length)
  }
  return undefined
}

function defaultReadSignatureStatus(path: string): string {
  const escaped = path.replaceAll("'", "''")
  const script = [
    `$sig = Get-AuthenticodeSignature -FilePath '${escaped}'`,
    `Write-Output ("STATUS=" + $sig.Status)`,
    `Write-Output ("HASHER=" + $(if ($null -eq $sig.SignerCertificate) { 'missing' } else { 'present' }))`,
    `Write-Output ("SUBJECT=" + $(if ($null -eq $sig.SignerCertificate) { '' } else { $sig.SignerCertificate.Subject }))`,
  ].join('; ')
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8' },
  )
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `Get-AuthenticodeSignature failed for ${path}: ${result.stderr || String(result.status)}`,
    )
  }
  return result.stdout
}

function assertSignedStatus(path: string, label: string, payload: string): void {
  const status = /^STATUS=(.+)$/mu.exec(payload)?.[1]?.trim()
  const hasher = /^HASHER=(.+)$/mu.exec(payload)?.[1]?.trim()
  if (status !== 'Valid') {
    throw new Error(`${label} is not Authenticode-valid (Status=${status ?? 'unknown'}): ${path}`)
  }
  if (hasher !== 'present') {
    throw new Error(`${label} is missing an Authenticode signer certificate: ${path}`)
  }
}

function defaultOptions(argv: readonly string[] = process.argv.slice(2)): WindowsSignatureVerificationOptions {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const outputDirArg = parseOutputDirArg(argv)
  return {
    desktopRoot,
    outputDir: outputDirArg === undefined
      ? join(desktopRoot, 'dist', 'win-release')
      : resolve(outputDirArg),
    version: readVersion(desktopRoot),
    platform: process.platform,
    readSignatureStatus: defaultReadSignatureStatus,
  }
}

/**
 * Verify the signed NSIS installer and unpacked application executable.
 * @param options - Artifact root and signature probe.
 * @returns The verified artifact paths.
 */
export function verifyWindowsSignature(
  options: WindowsSignatureVerificationOptions = defaultOptions(),
): WindowsSignatureArtifacts {
  if (options.platform !== 'win32') {
    throw new Error('Windows signature verification must run on a native Windows host')
  }

  const installerPath = join(options.outputDir, `OmniMux-${options.version}-x64-Setup.exe`)
  const applicationPath = join(options.outputDir, 'win-unpacked', 'OmniMux.exe')
  if (!existsSync(installerPath)) {
    throw new Error(`signed Windows NSIS installer is missing: ${installerPath}`)
  }
  if (!existsSync(applicationPath)) {
    throw new Error(`signed unpacked Windows application is missing: ${applicationPath}`)
  }

  assertPortableExecutable(installerPath, 'signed Windows NSIS installer')
  assertPortableExecutable(applicationPath, 'signed unpacked Windows application')
  assertSignedStatus(
    installerPath,
    'signed Windows NSIS installer',
    options.readSignatureStatus(installerPath),
  )
  assertSignedStatus(
    applicationPath,
    'signed unpacked Windows application',
    options.readSignatureStatus(applicationPath),
  )
  return { installerPath, applicationPath }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    const verified = verifyWindowsSignature()
    console.log(`Windows signature verification passed: ${verified.installerPath}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
