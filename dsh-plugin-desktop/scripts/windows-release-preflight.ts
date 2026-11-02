/** Fail-loud checks required before an Azure Trusted Signing Windows release. */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TRUSTED_SIGNING_VARIABLES = [
  'AZURE_CLIENT_CERTIFICATE_PASSWORD',
  'AZURE_CLIENT_CERTIFICATE_PATH',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_TENANT_ID',
  'OMNIMUX_WIN_PUBLISHER_NAME',
  'OMNIMUX_WIN_TRUSTED_SIGNING_ACCOUNT',
  'OMNIMUX_WIN_TRUSTED_SIGNING_ENDPOINT',
  'OMNIMUX_WIN_TRUSTED_SIGNING_PROFILE',
] as const

/** Injectable process inputs for the Windows Trusted Signing preflight. */
export interface WindowsReleasePreflightOptions {
  /** Environment inherited by electron-builder / Trusted Signing. */
  readonly env: NodeJS.ProcessEnv
  /** Platform that will run electron-builder. */
  readonly platform: NodeJS.Platform
  /** Node architecture that will run electron-builder. */
  readonly arch: string
}

/** Safe release facts confirmed by the preflight. */
export interface WindowsReleasePreflightResult {
  /** Trusted Signing account name. */
  readonly account: string
  /** Certificate profile name. */
  readonly certificateProfile: string
  /** Regional Trusted Signing endpoint. */
  readonly endpoint: string
  /** Authenticode publisher name expected by electron-builder. */
  readonly publisherName: string
  /** Entra authentication mechanism used by EnvironmentCredential. */
  readonly authentication: 'client-certificate' | 'client-secret'
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  return value === '' ? undefined : value
}

function requireEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = environmentValue(env, name)
  if (value === undefined) {
    throw new Error(`Incomplete Windows Trusted Signing credentials: missing ${name}`)
  }
  return value
}

/**
 * Remove Trusted Signing and Azure credential variables from unsigned / check subprocesses.
 * @param environment - Environment that may contain release secrets.
 * @returns A copy suitable for gates and unsigned packaging.
 */
export function withoutWindowsTrustedSigningSecrets(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized = { ...environment }
  const signingKeys = new Set<string>(TRUSTED_SIGNING_VARIABLES.map(key => key.toUpperCase()))
  for (const key of Object.keys(sanitized)) {
    if (signingKeys.has(key.toUpperCase())) delete sanitized[key]
  }
  return sanitized
}

/**
 * Validate that the process can perform an Azure Trusted Signing Windows release.
 * @param options - Host and credential inputs.
 * @returns Non-secret facts about the selected signing configuration.
 */
export function assertWindowsReleaseReady(
  options: WindowsReleasePreflightOptions,
): WindowsReleasePreflightResult {
  if (options.platform !== 'win32') {
    throw new Error('Windows Trusted Signing release must run on a native Windows host')
  }
  if (options.arch !== 'x64') {
    throw new Error(`Windows Trusted Signing release requires x64 Node; received ${options.arch}`)
  }

  const endpoint = requireEnvironmentValue(options.env, 'OMNIMUX_WIN_TRUSTED_SIGNING_ENDPOINT')
  if (!/^https:\/\/[A-Za-z0-9.-]+\.codesigning\.azure\.net\/?$/u.test(endpoint)) {
    throw new Error(
      'OMNIMUX_WIN_TRUSTED_SIGNING_ENDPOINT must be an https://*.codesigning.azure.net URI',
    )
  }

  const account = requireEnvironmentValue(options.env, 'OMNIMUX_WIN_TRUSTED_SIGNING_ACCOUNT')
  const certificateProfile = requireEnvironmentValue(
    options.env,
    'OMNIMUX_WIN_TRUSTED_SIGNING_PROFILE',
  )
  const publisherName = requireEnvironmentValue(options.env, 'OMNIMUX_WIN_PUBLISHER_NAME')
  requireEnvironmentValue(options.env, 'AZURE_TENANT_ID')
  requireEnvironmentValue(options.env, 'AZURE_CLIENT_ID')

  const clientSecret = environmentValue(options.env, 'AZURE_CLIENT_SECRET')
  const clientCertificatePath = environmentValue(options.env, 'AZURE_CLIENT_CERTIFICATE_PATH')
  if (clientSecret !== undefined && clientCertificatePath !== undefined) {
    throw new Error('Set AZURE_CLIENT_SECRET or AZURE_CLIENT_CERTIFICATE_PATH, not both')
  }
  if (clientSecret === undefined && clientCertificatePath === undefined) {
    throw new Error(
      'Incomplete Windows Trusted Signing credentials: missing AZURE_CLIENT_SECRET or AZURE_CLIENT_CERTIFICATE_PATH',
    )
  }

  return {
    account,
    certificateProfile,
    endpoint: endpoint.replace(/\/$/u, ''),
    publisherName,
    authentication: clientCertificatePath === undefined ? 'client-secret' : 'client-certificate',
  }
}

function main(): void {
  try {
    const result = assertWindowsReleaseReady({
      env: process.env,
      platform: process.platform,
      arch: process.arch,
    })
    console.log(
      `Windows Trusted Signing preflight passed: account=${result.account}; profile=${result.certificateProfile}; auth=${result.authentication}`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) main()
