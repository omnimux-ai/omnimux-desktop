import { describe, expect, it } from 'vitest'
import {
  assertWindowsReleaseReady,
  withoutWindowsTrustedSigningSecrets,
} from '../scripts/windows-release-preflight.ts'

const validEnv = {
  PATH: 'C:\\Windows\\System32',
  SAFE_VALUE: 'kept',
  AZURE_TENANT_ID: 'tenant-id',
  AZURE_CLIENT_ID: 'client-id',
  AZURE_CLIENT_SECRET: 'client-secret',
  OMNIMUX_WIN_TRUSTED_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/',
  OMNIMUX_WIN_TRUSTED_SIGNING_ACCOUNT: 'omnimux-signing',
  OMNIMUX_WIN_TRUSTED_SIGNING_PROFILE: 'omnimux-win-release',
  OMNIMUX_WIN_PUBLISHER_NAME: 'Twinspace',
} as const

describe('Windows Trusted Signing preflight', () => {
  it('accepts a complete client-secret configuration and normalizes the endpoint', () => {
    expect(assertWindowsReleaseReady({
      env: { ...validEnv },
      platform: 'win32',
      arch: 'x64',
    })).toEqual({
      account: 'omnimux-signing',
      certificateProfile: 'omnimux-win-release',
      endpoint: 'https://eus.codesigning.azure.net',
      publisherName: 'Twinspace',
      authentication: 'client-secret',
    })
  })

  it('accepts client-certificate authentication', () => {
    expect(assertWindowsReleaseReady({
      env: {
        ...validEnv,
        AZURE_CLIENT_SECRET: undefined,
        AZURE_CLIENT_CERTIFICATE_PATH: 'C:\\certs\\sp.pfx',
      },
      platform: 'win32',
      arch: 'x64',
    }).authentication).toBe('client-certificate')
  })

  it('rejects incomplete or conflicting credentials before any signing work', () => {
    expect(() => assertWindowsReleaseReady({
      env: { ...validEnv, AZURE_CLIENT_SECRET: undefined },
      platform: 'win32',
      arch: 'x64',
    })).toThrow('AZURE_CLIENT_SECRET or AZURE_CLIENT_CERTIFICATE_PATH')

    expect(() => assertWindowsReleaseReady({
      env: {
        ...validEnv,
        AZURE_CLIENT_CERTIFICATE_PATH: 'C:\\certs\\sp.pfx',
      },
      platform: 'win32',
      arch: 'x64',
    })).toThrow('not both')

    expect(() => assertWindowsReleaseReady({
      env: {
        ...validEnv,
        OMNIMUX_WIN_TRUSTED_SIGNING_ENDPOINT: 'https://example.com',
      },
      platform: 'win32',
      arch: 'x64',
    })).toThrow('codesigning.azure.net')
  })

  it('rejects non-Windows hosts and strips secrets for unsigned gates', () => {
    expect(() => assertWindowsReleaseReady({
      env: { ...validEnv },
      platform: 'darwin',
      arch: 'x64',
    })).toThrow('native Windows host')

    expect(withoutWindowsTrustedSigningSecrets({
      ...validEnv,
      AZURE_CLIENT_CERTIFICATE_PATH: 'C:\\certs\\sp.pfx',
    })).toEqual({ PATH: 'C:\\Windows\\System32', SAFE_VALUE: 'kept' })
  })
})
