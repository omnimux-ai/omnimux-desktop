import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nextRuntimeUnusedFeatureExclusion } from '../scripts/runtime-file-policy.ts'
import { NEXT_MAC_NATIVE_ENTRIES } from '../scripts/mac-runtime.ts'

const desktopRoot = join(import.meta.dirname, '..')
const cordisPatch = readFileSync(join(desktopRoot, 'cordis.patch.yml'), 'utf8')

/** Row ids the Next patch disables, read without a YAML dependency. */
function disabledRowIds(text: string): string[] {
  const ids: string[] = []
  let currentId: string | undefined
  for (const line of text.split('\n')) {
    const idMatch = /^-\s+id:\s*(\S+)\s*$/u.exec(line)
    if (idMatch !== null) { currentId = idMatch[1]; continue }
    if (currentId !== undefined && /^\s+disabled:\s*true\s*$/u.test(line)) {
      ids.push(currentId)
      currentId = undefined
    }
  }
  return ids
}

describe('payload exclusions', () => {
  it('excludes the heavy native runtimes this line does not ship', () => {
    // Each of these is a whole feature, not a size tweak: the matching cordis row
    // is disabled below, and shipping the package without its row (or vice versa)
    // is the failure this pair exists to prevent.
    for (const name of [
      '@deepseek-ai/libreoffice-kit',
      '@deepseek-ai/libreoffice-kit-darwin-arm64',
      '@deepseek-ai/dsh-office-to-pdf',
      '@deepseek-ai/dsh-skill-office',
      '@deepseek-ai/dsh-experimental-voice-input-bundle',
      '@deepseek-ai/dsh-experimental-speech-to-text',
      '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice',
      'sherpa-onnx-node',
      'sherpa-onnx-darwin-arm64',
      '@dataiku/uv',
      '@dataiku/uv-darwin-arm64',
    ]) {
      expect(nextRuntimeUnusedFeatureExclusion(name), name).toBeDefined()
    }
  })

  it('keeps packages the app still needs', () => {
    for (const name of [
      'ws',
      'react',
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@deepseek-ai/schemastery',
      'node-pty',
      '@img/sharp-darwin-arm64',
    ]) {
      expect(nextRuntimeUnusedFeatureExclusion(name), name).toBeUndefined()
    }
  })

  it('disables a cordis row for every excluded feature that registers one', () => {
    const disabled = disabledRowIds(cordisPatch)

    // Without these the profile still lists a bundle whose package the payload
    // dropped, and the Host refuses to start.
    expect(disabled).toContain('office-to-pdf')
    expect(disabled).toContain('skill-office')
    expect(disabled).toContain('voice-input')
    expect(disabled).toContain('agents-anywhere-bridge')
  })

  it('keeps the exclusions that predate this change', () => {
    const disabled = disabledRowIds(cordisPatch)

    expect(disabled).toContain('desktop-product-telemetry')
    expect(disabled).toContain('product-analytics')
    expect(disabled).toContain('client-hmr')
  })

  it('does not ask the macOS artifact verifier for native files of an excluded package', () => {
    // The verifier runs lipo on every listed entry; one the payload left out fails the DMG check.
    const paths = NEXT_MAC_NATIVE_ENTRIES.map(entry => entry.path)
    expect(paths.some(path => path.includes('@dataiku/uv'))).toBe(false)
    expect(paths).toContain('node_modules/@deepseek-ai/node-addon-system-darwin-arm64/bin/system.node')
  })
})
