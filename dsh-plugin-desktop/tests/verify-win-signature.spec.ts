import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyWindowsSignature } from '../scripts/verify-win-signature.ts'

function writeMinimalPe(path: string): void {
  const buffer = Buffer.alloc(128, 0)
  buffer.write('MZ', 0, 'ascii')
  buffer.writeUInt32LE(64, 0x3c)
  buffer.write('PE\0\0', 64, 'ascii')
  writeFileSync(path, buffer)
}

describe('Windows signature verification', () => {
  it('accepts PE files that report Authenticode Valid', () => {
    const root = mkdtempSync(join(tmpdir(), 'omnimux-win-sign-'))
    const unpacked = join(root, 'win-unpacked')
    mkdirSync(unpacked)
    const installerPath = join(root, 'OmniMux-2.0.3-x64-Setup.exe')
    const applicationPath = join(unpacked, 'OmniMux.exe')
    writeMinimalPe(installerPath)
    writeMinimalPe(applicationPath)

    const verified = verifyWindowsSignature({
      desktopRoot: root,
      outputDir: root,
      version: '2.0.3',
      platform: 'win32',
      readSignatureStatus: () => 'STATUS=Valid\nHASHER=present\nSUBJECT=CN=Twinspace\n',
    })

    expect(verified).toEqual({ installerPath, applicationPath })
  })

  it('rejects unsigned or invalid Authenticode status', () => {
    const root = mkdtempSync(join(tmpdir(), 'omnimux-win-sign-bad-'))
    const unpacked = join(root, 'win-unpacked')
    mkdirSync(unpacked)
    writeMinimalPe(join(root, 'OmniMux-2.0.3-x64-Setup.exe'))
    writeMinimalPe(join(unpacked, 'OmniMux.exe'))

    expect(() => verifyWindowsSignature({
      desktopRoot: root,
      outputDir: root,
      version: '2.0.3',
      platform: 'win32',
      readSignatureStatus: () => 'STATUS=NotSigned\nHASHER=missing\nSUBJECT=\n',
    })).toThrow('Authenticode-valid')
  })
})
