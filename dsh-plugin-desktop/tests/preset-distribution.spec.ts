import type { Stats } from 'node:fs'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface BuilderFileMatcher {
  readonly from: string
  readonly to: string
  readonly patterns: readonly string[]
  createFilter(): (file: string, stat: Stats) => boolean
}

interface BuilderConfig {
  readonly files: unknown
}

type GetMainFileMatchers = (
  appDir: string,
  destination: string,
  macroExpander: (pattern: string) => string,
  platformSpecificBuildOptions: Record<string, never>,
  platformPackager: unknown,
  outDir: string,
  isElectronCompile: boolean,
) => BuilderFileMatcher[]

const packageRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const require = createRequire(import.meta.url)
const appBuilderManifest = require.resolve('app-builder-lib/package.json')
const { getMainFileMatchers } = require(join(dirname(appBuilderManifest), 'out/fileMatcher.js')) as {
  readonly getMainFileMatchers: GetMainFileMatchers
}
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  readonly build?: BuilderConfig
}
const outputDir = join(packageRoot, 'dist-preset-distribution-test')
const appDestination = join(outputDir, 'resources', 'app')
const regularFile = { isDirectory: () => false } as Stats

function computeMatchers(files: unknown): BuilderFileMatcher[] {
  return getMainFileMatchers(
    packageRoot,
    appDestination,
    pattern => pattern,
    {},
    {
      info: {
        buildResourcesDir: 'build',
        config: { files },
        debugLogger: { isEnabled: false },
        isPrepackedAppAsar: false,
        projectDir: packageRoot,
      },
    },
    outputDir,
    false,
  )
}

describe('preset distribution matcher', () => {
  it('uses the pinned electron-builder matcher implementation', () => {
    const builderVersion = JSON.parse(readFileSync(appBuilderManifest, 'utf8')) as { readonly version?: unknown }

    expect(builderVersion.version).toBe('26.15.7')
  })

  it('includes the complete preset surface without relaxing app-root filters', () => {
    const matchers = computeMatchers(manifest.build?.files)
    const rootMatcher = matchers.find(matcher => matcher.from === packageRoot)
    const presetMatcher = matchers.find(matcher => matcher.from === join(packageRoot, 'preset'))

    expect(rootMatcher).toBeDefined()
    expect(presetMatcher).toBeDefined()
    expect(presetMatcher?.to).toBe(join(appDestination, 'preset'))
    expect(presetMatcher?.patterns).toEqual(['**/*'])

    const presetFilter = presetMatcher!.createFilter()
    for (const relativePath of [
      'plugins/omnimux-clip/src/client/openreel/core/types/asset-imports.d.ts',
      'plugins/omnimux-clip/src/client/openreel/core/video/webgpu-types.d.ts',
      'plugins/omnimux-clip/src/client/openreel/web/types/asset-imports.d.ts',
      'plugins/omnimux-clip/src/client/openreel/web/types/global.d.ts',
      'plugins/omnimux-clip/node_modules/lucide-react/dist/lucide-react.d.ts',
      'plugins/omnimux-clip/src/client/openreel/agent/index.ts',
      'plugins/omnimux-clip/src/client/openreel/ui/styles/globals.css',
      'plugins/node-pty/prebuilds/darwin-arm64/pty.node',
      'plugins/omnimux-clip/node_modules/uuid/dist-node/bin/uuid',
    ]) {
      expect(presetFilter(join(presetMatcher!.from, relativePath), regularFile), relativePath).toBe(true)
    }

    const rootFilter = rootMatcher!.createFilter()
    expect(rootFilter(join(packageRoot, 'lib/main.js'), regularFile)).toBe(true)
    expect(rootFilter(join(packageRoot, 'lib/main.d.ts'), regularFile)).toBe(false)
    expect(rootFilter(join(packageRoot, '.git/config'), regularFile)).toBe(false)
  })

  it('demonstrates that the former root preset glob loses declarations', () => {
    const legacyMatchers = computeMatchers(['lib/**', 'package.json', 'preset/**'])
    const legacyRootMatcher = legacyMatchers.find(matcher => matcher.from === packageRoot)

    expect(legacyRootMatcher).toBeDefined()
    expect(legacyRootMatcher!.createFilter()(
      join(packageRoot, 'preset/plugins/example/lib/index.d.ts'),
      regularFile,
    )).toBe(false)
  })
})
