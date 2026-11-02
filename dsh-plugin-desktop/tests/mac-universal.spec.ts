import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  MACOS_UNIVERSAL_NATIVE_ENTRIES,
  prepareMacUniversalRuntime,
} from '../scripts/mac-universal.ts'

describe('universal macOS native runtime preparation', () => {
  // fs-ext is the only universal entry whose filename moves with the Electron ABI. Spelling
  // that number out made this spec the last thing standing between an ABI bump and a green
  // `check` job, and it lost: bumping Electron turned a previously green job red instead of
  // catching the drift. Derive the number so the assertion survives the next bump.
  it('tracks the fs-ext binding for both CPU architectures at the installed Electron ABI', () => {
    const abi = readFileSync(
      fileURLToPath(new URL('../node_modules/electron/abi_version', import.meta.url)),
      'utf8',
    ).trim()
    expect(abi).toMatch(/^\d+$/)

    expect(MACOS_UNIVERSAL_NATIVE_ENTRIES).toEqual(expect.arrayContaining([
      {
        arch: 'arm64',
        path: `node_modules/fs-ext/prebuilds/darwin-arm64/electron.abi${abi}.node`,
      },
      {
        arch: 'x86_64',
        path: `node_modules/fs-ext/prebuilds/darwin-x64/electron.abi${abi}.node`,
      },
    ]))
  })

  it('keeps one sharp version across the manifest, the lockfile and the native entries', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      devDependencies?: Record<string, string>
    }
    const declared = manifest.devDependencies?.sharp
    expect(declared).toBeDefined()
    // Two sharp resolutions in the tree let Yarn hoist a different one than the
    // pinned entry names. That 0.35.3/0.35.5 split is what broke the universal
    // DMG smoke: nothing else compares the pin with what the install resolves.
    const lockfile = readFileSync(new URL('../../yarn.lock', import.meta.url), 'utf8')
    expect(lockfile.match(/^"sharp@npm:[^"]+":$/gmu)).toEqual([`"sharp@npm:${declared}":`])
    for (const entry of MACOS_UNIVERSAL_NATIVE_ENTRIES) {
      const embedded = /@img\/sharp-darwin-(?:arm64|x64)\/lib\/sharp-darwin-(?:arm64|x64)-(\d+\.\d+\.\d+)\.node$/u.exec(entry.path)
      if (embedded !== null) expect(embedded[1]).toBe(declared)
    }
  })

  it('requires every CPU-specific file and repairs both uv binaries and node-pty helpers', () => {
    const chmod = vi.fn()
    const desktopRoot = resolve('/desktop')

    prepareMacUniversalRuntime({ desktopRoot, exists: () => true, chmod })

    expect(chmod.mock.calls).toEqual([
      [join(desktopRoot, 'node_modules/@dataiku/uv-darwin-arm64/bin/uv'), 0o755],
      [join(desktopRoot, 'node_modules/@dataiku/uv-darwin-x64/bin/uv'), 0o755],
      [join(desktopRoot, 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'), 0o755],
      [join(desktopRoot, 'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper'), 0o755],
    ])
  })

  it('fails before changing permissions when one architecture is incomplete', () => {
    const chmod = vi.fn()
    const desktopRoot = resolve('/desktop')
    const missing = MACOS_UNIVERSAL_NATIVE_ENTRIES.at(-1)!.path

    expect(() => prepareMacUniversalRuntime({
      desktopRoot,
      exists: path => path !== join(desktopRoot, missing),
      chmod,
    })).toThrow(join(desktopRoot, missing))
    expect(chmod).not.toHaveBeenCalled()
  })
})
