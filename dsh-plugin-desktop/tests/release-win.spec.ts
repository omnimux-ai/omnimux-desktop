import { describe, expect, it, vi } from 'vitest'
import { releaseWindows, type WindowsReleaseOptions } from '../scripts/release-win.ts'

interface CommandCall {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

function baseOptions(calls: CommandCall[], logs: string[] = []): WindowsReleaseOptions {
  return {
    env: {
      PATH: 'C:\\Windows\\System32',
      SAFE_VALUE: 'kept',
      AZURE_TENANT_ID: 'tenant-id',
      AZURE_CLIENT_ID: 'client-id',
      AZURE_CLIENT_SECRET: 'client-secret-must-not-leak-to-gates',
      OMNIMUX_WIN_TRUSTED_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net',
      OMNIMUX_WIN_TRUSTED_SIGNING_ACCOUNT: 'omnimux-signing',
      OMNIMUX_WIN_TRUSTED_SIGNING_PROFILE: 'omnimux-win-release',
      OMNIMUX_WIN_PUBLISHER_NAME: 'Twinspace',
    },
    platform: 'win32',
    arch: 'x64',
    nodeVersion: '22.23.2',
    workspaceRoot: 'C:\\repo',
    desktopRoot: 'C:\\repo\\dsh-plugin-desktop',
    outputDir: 'C:\\repo\\dsh-plugin-desktop\\dist\\win-release',
    builderCli: 'C:\\repo\\node_modules\\electron-builder\\cli.js',
    signatureVerifier: 'C:\\repo\\dsh-plugin-desktop\\scripts\\verify-win-signature.ts',
    nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    commandShell: 'C:\\Windows\\System32\\cmd.exe',
    resetOutput: () => undefined,
    run: (command, args, cwd, env) => {
      calls.push({ command, args: [...args], cwd, env: { ...env } })
    },
    log: message => logs.push(message),
  }
}

describe('Windows Trusted Signing release command boundary', () => {
  it('runs checks without secrets, then signs only through electron-builder', () => {
    const calls: CommandCall[] = []
    const logs: string[] = []
    const resetOutput = vi.fn()
    const options = baseOptions(calls, logs)

    releaseWindows({
      ...options,
      resetOutput,
    })

    expect(resetOutput).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(3)
    expect(calls[0]).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        'corepack yarn workspace dsh-plugin-desktop check:win-package',
      ],
      cwd: 'C:\\repo',
      env: { PATH: 'C:\\Windows\\System32', SAFE_VALUE: 'kept' },
    })
    expect(calls[1]).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: [
        'C:\\repo\\node_modules\\electron-builder\\cli.js',
        '--win',
        'nsis',
        '--x64',
        '--publish',
        'never',
        '--config.forceCodeSigning=true',
        '--config.npmRebuild=false',
        '--config.directories.output=C:\\repo\\dsh-plugin-desktop\\dist\\win-release',
        '--config.win.azureSignOptions.publisherName=Twinspace',
        '--config.win.azureSignOptions.endpoint=https://eus.codesigning.azure.net',
        '--config.win.azureSignOptions.codeSigningAccountName=omnimux-signing',
        '--config.win.azureSignOptions.certificateProfileName=omnimux-win-release',
        '--config.win.azureSignOptions.fileDigest=SHA256',
        '--config.win.azureSignOptions.timestampRfc3161=http://timestamp.acs.microsoft.com',
        '--config.win.azureSignOptions.timestampDigest=SHA256',
      ],
      cwd: 'C:\\repo\\dsh-plugin-desktop',
      env: options.env,
    })
    expect(calls[2]).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: [
        'C:\\repo\\dsh-plugin-desktop\\scripts\\verify-win-signature.ts',
        '--output-dir=C:\\repo\\dsh-plugin-desktop\\dist\\win-release',
      ],
      cwd: 'C:\\repo\\dsh-plugin-desktop',
      env: { PATH: 'C:\\Windows\\System32', SAFE_VALUE: 'kept' },
    })
    expect(logs[0]).toContain('Windows Trusted Signing preflight passed')
  })

  it('fails before packaging when Trusted Signing credentials are incomplete', () => {
    const calls: CommandCall[] = []
    expect(() => releaseWindows({
      ...baseOptions(calls),
      env: {
        PATH: 'C:\\Windows\\System32',
        OMNIMUX_WIN_TRUSTED_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net',
      },
    })).toThrow('missing OMNIMUX_WIN_TRUSTED_SIGNING_ACCOUNT')
    expect(calls).toEqual([])
  })

  it('reuses a completed CI package gate when explicitly requested', () => {
    const calls: CommandCall[] = []
    const logs: string[] = []
    releaseWindows({
      ...baseOptions(calls, logs),
      env: {
        ...baseOptions(calls).env,
        DSH_PACKAGE_CHECK_ALREADY_RAN: '1',
      },
    })
    expect(calls).toHaveLength(2)
    expect(logs).toContain('Skipping the Windows package preflight; the package gate already passed.')
  })
})
