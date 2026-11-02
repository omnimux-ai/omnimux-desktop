import { describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import type { SpawnSyncOptions } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Run = (command: string, args: readonly string[], options: SpawnSyncOptions) => { status: number | null; error?: Error }
const packageRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const scriptUrl = new URL('../scripts/package-dev.mjs', import.meta.url).href
const { packageDev } = await import(scriptUrl) as {
  packageDev(options: { platform: NodeJS.Platform; arch?: string; run: Run }): string
}
const stampScript = fileURLToPath(new URL('../scripts/stamp-dev-app.mjs', import.meta.url))

describe('development app packaging', () => {
  it.each(['arm64', 'x64'])('stages development once before packaging and stamps the %s output', arch => {
    const run = vi.fn<Run>().mockReturnValue({ status: 0 })
    const appPath = packageDev({ platform: 'darwin', arch, run })

    expect(appPath).toBe(join(packageRoot, 'dist', arch === 'arm64' ? 'mac-arm64' : 'mac', 'OmniMux.app'))
    expect(run.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ['corepack', ['yarn', 'run', 'build']],
      // Mirrors `package:dir`: the native prebuild (Electron ABI) and the primary
      // runtime payload must exist before electron-builder packs the bundle.
      [process.execPath, [join(packageRoot, 'scripts', 'prepare-fs-ext.ts')]],
      [process.execPath, [join(packageRoot, 'scripts', 'prepare-runtime.ts')]],
      [process.execPath, [join(packageRoot, 'scripts', 'stage-preset-profile.ts'), '--channel', 'development']],
      [process.execPath, [join(packageRoot, 'scripts', 'package-dir.mjs')]],
      [process.execPath, [stampScript, appPath]],
      // Stamping rewrites Info.plist after electron-builder signed the bundle,
      // so the ad-hoc signature is re-applied to the stamped output.
      ['codesign', ['--force', '--deep', '--sign', '-', appPath]],
    ])
    for (const call of run.mock.calls) {
      expect(call[2]).toMatchObject({ cwd: packageRoot, stdio: 'inherit' })
    }
    const root = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    const desktop = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
    expect(root.scripts['package:dev']).toBe('yarn workspace dsh-community-market build && yarn workspace dsh-plugin-desktop package:dev')
    expect(desktop.scripts['package:dev']).toBe('node scripts/package-dev.mjs')
    expect(desktop.scripts['package:dir']).toBe('yarn run build && yarn run prepare:electron-native && yarn run prepare:runtime && yarn run stage:preset && node scripts/package-dir.mjs')
  })

  it.each([1, 2, 3, 4, 5, 6, 7])('stops at the first failing packaging step %i', failedStep => {
    const run = vi.fn<Run>().mockImplementation(() => ({
      status: run.mock.calls.length === failedStep ? 1 : 0,
    }))
    expect(() => packageDev({ platform: 'darwin', arch: 'arm64', run })).toThrow('exited with 1')
    expect(run).toHaveBeenCalledTimes(failedStep)
  })

  it('rejects an unsupported host before building or staging', () => {
    const run = vi.fn<Run>()
    expect(() => packageDev({ platform: 'linux', arch: 'x64', run })).toThrow('native macOS')
    expect(run).not.toHaveBeenCalled()
  })
})

function createApp(root: string, channel: string): { appPath: string; plistPath: string } {
  const appPath = join(root, 'OmniMux.app')
  const plistPath = join(appPath, 'Contents', 'Info.plist')
  mkdirSync(dirname(plistPath), { recursive: true })
  writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleDisplayName</key><string>OmniMux</string>
<key>LSEnvironment</key><dict><key>OMNIMUX_CHANNEL</key><string>prod</string></dict></dict></plist>
`)
  if (channel !== 'missing') {
    const markerPath = join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'preset', 'plugins', 'omnimux', 'src', 'release-channel.json')
    mkdirSync(dirname(markerPath), { recursive: true })
    writeFileSync(markerPath, channel === 'malformed' ? '{' : JSON.stringify({ channel }))
  }
  return { appPath, plistPath }
}

describe('Dev identity requires a development preset', () => {
  it.each(['production', 'missing', 'malformed', 'unknown'])('rejects %s preset before mutating Info.plist', channel => {
    const root = mkdtempSync(join(tmpdir(), 'omnimux-dev-stamp-'))
    try {
      const { appPath, plistPath } = createApp(root, channel)
      const before = readFileSync(plistPath)
      const result = spawnSync(process.execPath, [stampScript, appPath], { encoding: 'utf8' })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('rebuild with corepack yarn package:dev')
      expect(readFileSync(plistPath)).toEqual(before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'darwin')('stamps a development preset using the native plist editor', () => {
    const root = mkdtempSync(join(tmpdir(), 'omnimux-dev-stamp-'))
    try {
      const { appPath, plistPath } = createApp(root, 'development')
      execFileSync(process.execPath, [stampScript, appPath])
      expect(execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :LSEnvironment:OMNIMUX_CHANNEL', plistPath], { encoding: 'utf8' }).trim()).toBe('dev')
      expect(execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleDisplayName', plistPath], { encoding: 'utf8' }).trim()).toBe('OmniMux Dev')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
