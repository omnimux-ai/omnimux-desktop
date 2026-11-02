import { beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { createRequire } from 'node:module'

const sidebarFixture = vi.hoisted(() => ({
  path: undefined as string | undefined,
  buildError: undefined as Error | undefined,
  verifyError: undefined as Error | undefined,
}))
vi.mock('../scripts/better-sidebar/build-patched-sidebar.ts', async () => {
  const fs = await import('node:fs')
  const pathApi = await import('node:path')
  return {
    BETTER_SIDEBAR_PNPM_VERSION: '11.8.0',
    buildPatchedBetterSidebar: (workRoot: string) => {
      if (sidebarFixture.buildError !== undefined) throw sidebarFixture.buildError
      const path = sidebarFixture.path ?? pathApi.join(workRoot, 'fixture-sidebar')
      if (sidebarFixture.path === undefined) {
        fs.mkdirSync(path, { recursive: true })
        fs.writeFileSync(pathApi.join(path, 'package.json'), '{"name":"dsh-better-sidebar","version":"1.0.0"}\n')
      }
      return { tarballPath: path, packedRoot: path }
    },
    verifyInstalledBetterSidebar: () => {
      if (sidebarFixture.verifyError !== undefined) throw sidebarFixture.verifyError
    },
  }
})
import {
  assertStagedSelfContained,
  normalizeStagedManifest,
  parseReleaseChannel,
  publishCandidate,
  stagePresetProfile,
} from '../scripts/stage-preset-profile.ts'
import { verifyPreset } from '../scripts/verify-distribution.ts'
import { listPackageNames } from '../src/preset-profile.ts'

const PRODUCT_PLUGINS = [
  'omnimux',
  'omnimux-accounts',
  'omnimux-assets',
  'omnimux-products',
  'omnimux-workflow',
  'omnimux-market',
  'omnimux-inspiration',
  'omnimux-clip',
  'omnimux-video',
  'omnimux-analytics',
  'omnimux-publish',
  'omnimux-forms',
] as const
const ALPHA_PLUGINS = [
  'omnimux-accounts',
  'omnimux-publish',
  'omnimux-analytics',
  'omnimux-forms',
] as const
const LIFECYCLE = {
  'omnimux-accounts': { stage: 'alpha', toolPrefixes: ['omnimux_accounts_'] },
  'omnimux-publish': { stage: 'alpha', toolPrefixes: ['omnimux_publish_'] },
  'omnimux-analytics': { stage: 'alpha', toolPrefixes: ['omnimux_analytics_'] },
  'omnimux-forms': { stage: 'alpha', toolPrefixes: ['omnimux_forms_'] },
} as const

describe('stagePresetProfile', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    sidebarFixture.path = undefined
    sidebarFixture.buildError = undefined
    sidebarFixture.verifyError = undefined
  })

  it('rejects the retired arbitrary sidebar package override', () => {
    vi.stubEnv('DSH_BETTER_SIDEBAR_SPEC', 'latest')
    expect(() => stagePresetProfile()).toThrowError('DSH_BETTER_SIDEBAR_SPEC is no longer supported')
  })

  it('preserves an existing preset when the pinned sidebar build fails', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux sidebar build failure '))
    try {
      const pluginsRoot = join(fixture, 'product plugins')
      const presetDir = join(fixture, 'existing preset')
      createProductPlugins(pluginsRoot)
      createExistingPreset(presetDir)
      sidebarFixture.buildError = new Error('pinned patch does not apply')

      expect(() => stagePresetProfile({ pluginsRoot, presetDir, releaseChannel: 'development' }))
        .toThrowError('pinned patch does not apply')
      expectExistingPreset(presetDir)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('preserves an existing preset when installed sidebar provenance fails', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux sidebar provenance failure '))
    try {
      const pluginsRoot = join(fixture, 'product plugins')
      const presetDir = join(fixture, 'existing preset')
      createProductPlugins(pluginsRoot)
      createExistingPreset(presetDir)
      sidebarFixture.verifyError = new Error('staged sidebar differs from packed build')

      expect(() => stagePresetProfile({ pluginsRoot, presetDir, releaseChannel: 'development' }))
        .toThrowError('staged sidebar differs from packed build')
      expectExistingPreset(presetDir)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  }, 30_000)
  it('materializes a local file dependency closure from paths containing spaces', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux stage fixture '))
    try {
      const sourceRoot = join(fixture, 'source tree with spaces')
      const pluginsRoot = join(sourceRoot, 'product plugins')
      const uiKit = join(sourceRoot, 'shared packages', 'ui kit')
      const requiredLeaf = join(sourceRoot, 'shared packages', 'required leaf')
      const tokens = join(sourceRoot, 'shared packages', 'tokens package')
      const sidebar = join(sourceRoot, 'sidebar package')
      const presetDir = join(fixture, 'target preset with spaces')
      createPresetSkeleton(presetDir)
      createPackage(requiredLeaf, '@fixture/required-leaf')
      createPackage(tokens, '@fixture/tokens')
      createPackage(uiKit, '@fixture/ui-kit', {
        dependencies: {
          '@fixture/required-leaf': 'file:../required leaf',
        },
        optionalDependencies: {
          '@fixture/tokens': 'file:../tokens package',
        },
      })
      createPackage(sidebar, 'dsh-better-sidebar')
      createProductPlugins(pluginsRoot, {
        omnimux: {
          dependencies: {
            '@fixture/ui-kit': 'file:../../missing ui kit',
          },
          optionalDependencies: {
            '@fixture/ui-kit': 'file:../../shared packages/ui kit',
          },
        },
        'omnimux-accounts': {
          dependencies: {
            '@fixture/ui-kit': 'file:../../shared packages/ui kit',
          },
        },
      })
      writeFileSync(join(pluginsRoot, 'omnimux', 'index.js'), "module.exports = require('@fixture/ui-kit')\n")
      writeFileSync(
        join(uiKit, 'index.js'),
        "module.exports = { required: require('@fixture/required-leaf'), optional: require('@fixture/tokens') }\n",
      )

      sidebarFixture.path = sidebar
      expect(stagePresetProfile({ pluginsRoot, presetDir, releaseChannel: 'development' })).toBe(16)
      const stagedPresets = join(presetDir, 'agent-presets')
      expect(readdirSync(stagedPresets).sort()).toEqual(['cordis', 'daily-work', 'standard', 'tiktok-agent'])
      expect(readFileSync(join(stagedPresets, 'cordis', 'preset.yml'), 'utf8')).toBe('name: cordis\n')

      rmSync(sourceRoot, { recursive: true, force: true })
      const movedPresetDir = join(fixture, 'moved preset with spaces')
      renameSync(presetDir, movedPresetDir)
      const output = join(movedPresetDir, 'plugins')
      expect(listPackageNames(output)).toEqual(expect.arrayContaining([
        ...PRODUCT_PLUGINS,
        '@fixture/ui-kit',
        '@fixture/required-leaf',
        '@fixture/tokens',
        'dsh-better-sidebar',
      ]))
      const omnimux = readJson(join(output, 'omnimux', 'package.json'))
      expect(omnimux.dependencies).toMatchObject({
        '@fixture/ui-kit': 'file:../../missing ui kit',
      })
      expect(omnimux.optionalDependencies).toMatchObject({
        '@fixture/ui-kit': 'file:../@fixture/ui-kit',
      })
      const stagedUiKit = readJson(join(output, '@fixture', 'ui-kit', 'package.json'))
      expect(stagedUiKit.dependencies).toMatchObject({
        '@fixture/required-leaf': 'file:../required-leaf',
      })
      expect(stagedUiKit.optionalDependencies).toMatchObject({
        '@fixture/tokens': 'file:../tokens',
      })
      expect(findSymlinks(output)).toEqual([])
      for (const name of listPackageNames(output)) {
        const manifest = readFileSync(join(output, ...name.split('/'), 'package.json'), 'utf8')
        expect(manifest).not.toContain(sourceRoot)
      }

      const runtimeRoot = join(fixture, 'runtime install with spaces')
      mkdirSync(runtimeRoot)
      const owned = readJson(join(movedPresetDir, 'owned-packages.json')) as unknown as string[]
      const dependencies = Object.fromEntries(owned.map(name => [
        name,
        relativeFileSpec(runtimeRoot, join(output, ...name.split('/'))),
      ]))
      writeFileSync(join(runtimeRoot, 'package.json'), `${JSON.stringify({ private: true, dependencies }, undefined, 2)}\n`)
      writeFileSync(join(runtimeRoot, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
      const installed = spawnSync(
        'pnpm',
        ['install', '--prod', '--ignore-scripts', '--config.confirmModulesPurge=false'],
        { cwd: runtimeRoot, encoding: 'utf8', env: { ...process.env, CI: 'true' } },
      )
      if (installed.status !== 0) {
        throw new Error(`runtime install failed (${String(installed.status)}):\n${installed.stdout ?? ''}\n${installed.stderr ?? ''}`)
      }
      expect(createRequire(join(runtimeRoot, 'probe.cjs'))('omnimux')).toEqual({
        required: { loaded: '@fixture/required-leaf' },
        optional: { loaded: '@fixture/tokens' },
      })
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  }, 30_000)

  it('surfaces pnpm output and preserves an existing preset when install fails', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux stage failure '))
    try {
      const pluginsRoot = join(fixture, 'product plugins')
      const presetDir = join(fixture, 'existing preset')
      createProductPlugins(pluginsRoot)
      createExistingPreset(presetDir)

      let failure: unknown
      try {
        sidebarFixture.path = join(fixture, 'missing sidebar package')
        stagePresetProfile({ pluginsRoot, presetDir, releaseChannel: 'development' })
      } catch (error) {
        failure = error
      }

      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toContain('stage-preset-profile: pnpm install failed')
      expect((failure as Error).message).toContain('stdout:')
      expect((failure as Error).message).toContain('ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND')
      expectExistingPreset(presetDir)
      expect(readdirSync(presetDir).some(name => name.startsWith('.preset-stage-'))).toBe(false)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  }, 30_000)

  it('rejects a missing local file dependency before publishing', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux stage missing local '))
    try {
      const pluginsRoot = join(fixture, 'product plugins')
      const presetDir = join(fixture, 'existing preset')
      createProductPlugins(pluginsRoot, {
        omnimux: { dependencies: { 'missing-local': 'file:../missing local' } },
      })
      createExistingPreset(presetDir)

      expect(() => stagePresetProfile({ pluginsRoot, presetDir, releaseChannel: 'development' }))
        .toThrowError(/local dependency "missing-local" is missing package\.json/)
      expectExistingPreset(presetDir)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('rejects one local package name resolving to different sources', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux stage conflict '))
    try {
      const sourceRoot = join(fixture, 'source tree')
      const pluginsRoot = join(sourceRoot, 'product plugins')
      createPackage(join(sourceRoot, 'shared one'), 'shared-local')
      createPackage(join(sourceRoot, 'shared two'), 'shared-local')
      createProductPlugins(pluginsRoot, {
        omnimux: { dependencies: { 'shared-local': 'file:../../shared one' } },
        'omnimux-accounts': { dependencies: { 'shared-local': 'file:../../shared two' } },
      })

      expect(() => stagePresetProfile({
        pluginsRoot,
        presetDir: join(fixture, 'target preset'),
        releaseChannel: 'development',
      })).toThrowError(/local package "shared-local" resolves to conflicting sources/)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('keeps an incompatible optional-only local package out of the staged output', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux stage optional platform '))
    try {
      const sourceRoot = join(fixture, 'source tree')
      const pluginsRoot = join(sourceRoot, 'product plugins')
      const excluded = join(sourceRoot, 'shared packages', 'excluded package')
      const sidebar = join(sourceRoot, 'sidebar package')
      const presetDir = join(fixture, 'target preset')
      createPresetSkeleton(presetDir)
      createPackage(excluded, '@fixture/excluded', {
        os: ['definitely-not-a-node-platform'],
      })
      createPackage(sidebar, 'dsh-better-sidebar')
      createProductPlugins(pluginsRoot, {
        'omnimux-assets': {
          optionalDependencies: {
            '@fixture/excluded': 'file:../../shared packages/excluded package',
          },
        },
      })

      sidebarFixture.path = sidebar
      expect(stagePresetProfile({ pluginsRoot, presetDir, releaseChannel: 'development' })).toBe(13)
      expect(listPackageNames(join(presetDir, 'plugins'))).not.toContain('@fixture/excluded')
      expect(readJson(join(presetDir, 'owned-packages.json'))).not.toContain('@fixture/excluded')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  }, 30_000)

  it('rejects a local package that would override the explicit sidebar dependency', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux stage sidebar collision '))
    try {
      const sourceRoot = join(fixture, 'source tree')
      const pluginsRoot = join(sourceRoot, 'product plugins')
      const localSidebar = join(sourceRoot, 'local sidebar')
      const presetDir = join(fixture, 'existing preset')
      createPackage(localSidebar, 'dsh-better-sidebar')
      createProductPlugins(pluginsRoot, {
        omnimux: {
          dependencies: {
            'dsh-better-sidebar': 'file:../../local sidebar',
          },
        },
      })
      createExistingPreset(presetDir)

      expect(() => stagePresetProfile({ pluginsRoot, presetDir, releaseChannel: 'development' }))
        .toThrowError(/local package "dsh-better-sidebar".+conflicts with explicit staging dependency/)
      expectExistingPreset(presetDir)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('restores plugins, skeleton, owned packages, and seed version when publishing fails', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux publish rollback '))
    try {
      const presetDir = join(fixture, 'preset')
      const candidateDir = join(fixture, 'candidate')
      createExistingPreset(presetDir)
      createPackage(join(candidateDir, 'plugins', 'new-valid'), 'new-valid')
      createPresetSkeleton(candidateDir)
      writeFileSync(join(candidateDir, 'owned-packages.json'), '["new-valid"]\n')
      writeFileSync(join(candidateDir, 'seed-version'), '8\n')
      let renameCount = 0

      expect(() => publishCandidate(candidateDir, presetDir, (from, to) => {
        renameCount += 1
        if (renameCount === 5) throw new Error('injected publish failure')
        renameSync(from, to)
      })).toThrowError('injected publish failure')

      expectExistingPreset(presetDir)
      expect(existsSync(join(presetDir, 'plugins', 'new-valid'))).toBe(false)
      expect(readdirSync(presetDir).some(name => name.startsWith('.preset-backup-'))).toBe(false)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('defaults to a production preset that excludes every lifecycle Alpha plugin', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux production stage '))
    try {
      const pluginsRoot = join(fixture, 'product plugins')
      const presetDir = join(fixture, 'preset')
      createProductPlugins(pluginsRoot)
      createPresetSkeleton(presetDir)

      expect(stagePresetProfile({ pluginsRoot, presetDir })).toBe(9)

      const output = join(presetDir, 'plugins')
      const owned = readJson(join(presetDir, 'owned-packages.json')) as unknown as string[]
      const skeleton = readJson(join(presetDir, 'skeleton', 'package.json'))
      for (const name of ALPHA_PLUGINS) {
        expect(existsSync(join(output, name))).toBe(false)
        expect(owned).not.toContain(name)
        expect(skeleton.dsh.profile.bundles).not.toContain(name)
      }
      expect(readJson(join(output, 'omnimux', 'src', 'release-channel.json'))).toEqual({
        channel: 'production',
      })
      expect(skeleton.dsh.profile.bundles).toEqual([
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        'dsh-better-sidebar',
        'omnimux',
        'omnimux-assets',
        'omnimux-workflow',
      ])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  }, 30_000)

  it('keeps every lifecycle Alpha plugin only for an explicit development stage', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux development stage '))
    try {
      const pluginsRoot = join(fixture, 'product plugins')
      const presetDir = join(fixture, 'preset')
      createProductPlugins(pluginsRoot)
      createPresetSkeleton(presetDir)

      expect(stagePresetProfile({ pluginsRoot, presetDir, releaseChannel: 'development' })).toBe(13)

      const output = join(presetDir, 'plugins')
      const owned = readJson(join(presetDir, 'owned-packages.json')) as unknown as string[]
      const skeleton = readJson(join(presetDir, 'skeleton', 'package.json'))
      for (const name of ALPHA_PLUGINS) {
        expect(existsSync(join(output, name, 'package.json'))).toBe(true)
        expect(owned).toContain(name)
        expect(skeleton.dsh.profile.bundles).toContain(name)
      }
      expect(readJson(join(output, 'omnimux', 'src', 'release-channel.json'))).toEqual({
        channel: 'development',
      })
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  }, 30_000)

  it('refuses a development stage whose skeleton would name an unstaged Alpha bundle', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux unstaged alpha bundle '))
    try {
      const pluginsRoot = join(fixture, 'product plugins')
      const presetDir = join(fixture, 'preset')
      createProductPlugins(pluginsRoot)
      createPresetSkeleton(presetDir)
      // A lifecycle entry outside PRODUCT_PLUGINS is how a packaged preset once
      // declared a bundle the stage never wrote: the app opened its recovery
      // window instead of the desktop. The stage has to refuse it here.
      createPackage(join(pluginsRoot, 'omnimux-extra'), 'omnimux-extra')
      writeFileSync(
        join(pluginsRoot, 'omnimux', 'src', 'plugin-lifecycle.json'),
        `${JSON.stringify({
          ...LIFECYCLE,
          'omnimux-extra': { stage: 'alpha', toolPrefixes: ['omnimux_extra_'] },
        }, undefined, 2)}\n`,
      )

      expect(() => stagePresetProfile({ pluginsRoot, presetDir, releaseChannel: 'development' }))
        .toThrowError('desktop preset declares bundles it does not stage: omnimux-extra')
      expect(existsSync(join(presetDir, 'plugins'))).toBe(false)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  }, 30_000)

  it('stages a package for every bundle the development skeleton declares', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux declared bundles '))
    try {
      const pluginsRoot = join(fixture, 'product plugins')
      const presetDir = join(fixture, 'preset')
      createProductPlugins(pluginsRoot)
      createPresetSkeleton(presetDir)

      stagePresetProfile({ pluginsRoot, presetDir, releaseChannel: 'development' })

      const skeleton = readJson(join(presetDir, 'skeleton', 'package.json'))
      const declared = (skeleton.dsh.profile.bundles as string[])
        .filter((name: string) => !name.startsWith('@deepseek-ai/'))
      expect(declared).toContain('omnimux-forms')
      for (const name of declared) {
        expect(existsSync(join(presetDir, 'plugins', name, 'package.json'))).toBe(true)
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  }, 30_000)

  it.each([
    ['missing lifecycle registry', (pluginsRoot: string) => rmSync(
      join(pluginsRoot, 'omnimux', 'src', 'plugin-lifecycle.json'),
    )],
    ['invalid lifecycle registry', (pluginsRoot: string) => writeFileSync(
      join(pluginsRoot, 'omnimux', 'src', 'plugin-lifecycle.json'),
      '{"omnimux-accounts":{"stage":"stable","toolPrefixes":[]}}\n',
    )],
    ['empty lifecycle registry', (pluginsRoot: string) => writeFileSync(
      join(pluginsRoot, 'omnimux', 'src', 'plugin-lifecycle.json'),
      '{}\n',
    )],
    ['missing release marker', (pluginsRoot: string) => rmSync(
      join(pluginsRoot, 'omnimux', 'src', 'release-channel.json'),
    )],
    ['invalid release marker', (pluginsRoot: string) => writeFileSync(
      join(pluginsRoot, 'omnimux', 'src', 'release-channel.json'),
      '{"channel":"preview"}\n',
    )],
  ])('preserves an existing preset for a %s', (_label, mutate) => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux invalid release policy '))
    try {
      const pluginsRoot = join(fixture, 'product plugins')
      const presetDir = join(fixture, 'existing preset')
      createProductPlugins(pluginsRoot)
      createExistingPreset(presetDir)
      mutate(pluginsRoot)

      expect(() => stagePresetProfile({ pluginsRoot, presetDir })).toThrow()
      expectExistingPreset(presetDir)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('fails production staging when a retained package depends on an Alpha plugin', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux alpha dependency '))
    try {
      const pluginsRoot = join(fixture, 'product plugins')
      const presetDir = join(fixture, 'existing preset')
      createProductPlugins(pluginsRoot, {
        'omnimux-assets': { dependencies: { 'omnimux-publish': 'file:../omnimux-publish' } },
      })
      createExistingPreset(presetDir)

      expect(() => stagePresetProfile({ pluginsRoot, presetDir }))
        .toThrowError('production plugin "omnimux-assets" depends on Alpha plugin "omnimux-publish"')
      expectExistingPreset(presetDir)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('stages the skills a product plugin declares and records them', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux stage skills '))
    try {
      const pluginsRoot = join(fixture, 'product plugins')
      const presetDir = join(fixture, 'preset')
      createProductPlugins(pluginsRoot)
      createPresetSkeleton(presetDir)
      const host = join(pluginsRoot, 'omnimux-video')
      mkdirSync(join(host, 'skills', 'clip-craft'), { recursive: true })
      writeFileSync(
        join(host, 'skills', 'clip-craft', 'SKILL.md'),
        '---\nname: clip-craft\ndescription: fixture skill\n---\n',
      )
      writeFileSync(
        join(host, 'dsh.manifest.json'),
        `${JSON.stringify({ id: 'omnimux-video', skills: ['skills/clip-craft/SKILL.md'] }, undefined, 2)}\n`,
      )

      stagePresetProfile({ pluginsRoot, presetDir, releaseChannel: 'development' })

      expect(readdirSync(join(presetDir, 'skills'))).toEqual(['clip-craft'])
      expect(existsSync(join(presetDir, 'skills', 'clip-craft', 'omnimux-skill.json'))).toBe(true)
      const record = readJson(join(presetDir, 'distribution.json'))
      const skills = (record.items as { kind: string }[]).filter(item => item.kind === 'skill')
      expect(skills).toEqual([{
        kind: 'skill',
        id: 'clip-craft',
        tier: 'product',
        version: null,
        origin: 'plugin:omnimux-video',
        digest: expect.any(String) as unknown as string,
      }])
      // The producer's own output must satisfy the verifier it ships with.
      expect(() => verifyPreset(presetDir)).not.toThrow()
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  }, 30_000)

  it('refuses a plugin that declares a skill it does not carry', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux stage missing skill '))
    try {
      const pluginsRoot = join(fixture, 'product plugins')
      const presetDir = join(fixture, 'preset')
      createProductPlugins(pluginsRoot)
      createPresetSkeleton(presetDir)
      writeFileSync(
        join(pluginsRoot, 'omnimux-video', 'dsh.manifest.json'),
        `${JSON.stringify({ id: 'omnimux-video', skills: ['skills/ghost/SKILL.md'] })}\n`,
      )

      expect(() => stagePresetProfile({ pluginsRoot, presetDir, releaseChannel: 'development' }))
        .toThrowError('plugin "omnimux-video" declares a missing skill: skills/ghost/SKILL.md')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('refuses two plugins that declare the same skill id', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux stage duplicate skill '))
    try {
      const pluginsRoot = join(fixture, 'product plugins')
      const presetDir = join(fixture, 'preset')
      createProductPlugins(pluginsRoot)
      createPresetSkeleton(presetDir)
      for (const name of ['omnimux-video', 'omnimux-clip']) {
        mkdirSync(join(pluginsRoot, name, 'skills', 'shared'), { recursive: true })
        writeFileSync(join(pluginsRoot, name, 'skills', 'shared', 'SKILL.md'), '---\nname: shared\n---\n')
        writeFileSync(
          join(pluginsRoot, name, 'dsh.manifest.json'),
          `${JSON.stringify({ id: name, skills: ['skills/shared/SKILL.md'] })}\n`,
        )
      }

      expect(() => stagePresetProfile({ pluginsRoot, presetDir, releaseChannel: 'development' }))
        .toThrowError('two product plugins declare the same skill "shared"')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('requires an explicit valid development channel argument', () => {
    expect(parseReleaseChannel([])).toBe('production')
    expect(parseReleaseChannel(['--channel', 'development'])).toBe('development')
    expect(() => parseReleaseChannel(['development'])).toThrow('usage:')
    expect(() => parseReleaseChannel(['--channel', 'preview'])).toThrow('usage:')
  })

  it('drops build-only dev dependencies before a package enters the preset', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux staged manifest '))
    try {
      const stagedRoot = join(fixture, 'packages')
      const packageDir = join(stagedRoot, 'omnimux-forms')
      createPackage(join(stagedRoot, 'omnimux-hub'), 'omnimux-hub')
      createPackage(packageDir, 'omnimux-forms', {
        dependencies: { 'omnimux-hub': 'file:../omnimux-hub' },
        devDependencies: {
          'dsh-ui-kit': 'file:../../../../personal/dsh-ui-kit',
          '@omnimux/form-contract': 'file:../../packages/form-contract',
        },
      })

      normalizeStagedManifest('omnimux-forms', packageDir, stagedRoot)

      const manifest = readJson(join(packageDir, 'package.json'))
      expect(manifest.devDependencies).toBeUndefined()
      expect(manifest.dependencies).toEqual({ 'omnimux-hub': 'file:../omnimux-hub' })
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('rejects a workspace-only dependency spec at stage time', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux staged workspace '))
    try {
      const stagedRoot = join(fixture, 'packages')
      const packageDir = join(stagedRoot, 'omnimux-forms')
      createPackage(packageDir, 'omnimux-forms', {
        dependencies: { '@omnimux/form-contract': 'workspace:*' },
      })

      expect(() => normalizeStagedManifest('omnimux-forms', packageDir, stagedRoot))
        .toThrowError('a workspace-only spec cannot resolve after the preset is relocated')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('rejects a symbolic-link dependency spec at stage time', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux staged link '))
    try {
      const stagedRoot = join(fixture, 'packages')
      const packageDir = join(stagedRoot, 'omnimux-forms')
      createPackage(packageDir, 'omnimux-forms', {
        dependencies: { 'omnimux-hub': 'link:../omnimux-hub' },
      })

      expect(() => normalizeStagedManifest('omnimux-forms', packageDir, stagedRoot))
        .toThrowError('symbolic links are forbidden in the preset')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('rejects a local dependency that escapes the staged root', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux staged escape '))
    try {
      const stagedRoot = join(fixture, 'packages')
      const packageDir = join(stagedRoot, 'omnimux-forms')
      createPackage(packageDir, 'omnimux-forms', {
        dependencies: { outside: 'file:../../../outside' },
      })

      expect(() => normalizeStagedManifest('omnimux-forms', packageDir, stagedRoot))
        .toThrowError('escapes the staged root')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('accepts a staged preset whose local edges stay inside it', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux staged self contained '))
    try {
      const pluginsDir = join(fixture, 'plugins')
      createPackage(join(pluginsDir, 'omnimux-hub'), 'omnimux-hub')
      createPackage(join(pluginsDir, 'omnimux-forms'), 'omnimux-forms', {
        dependencies: { 'omnimux-hub': 'file:../omnimux-hub' },
      })

      expect(() => assertStagedSelfContained(pluginsDir)).not.toThrow()
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('rejects a staged preset that still carries a workspace spec', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux preset workspace '))
    try {
      const pluginsDir = join(fixture, 'plugins')
      createPackage(join(pluginsDir, 'omnimux-forms'), 'omnimux-forms', {
        dependencies: { '@omnimux/form-contract': 'workspace:*' },
      })

      expect(() => assertStagedSelfContained(pluginsDir))
        .toThrowError('declares "@omnimux/form-contract" as "workspace:*"')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('rejects a staged preset whose local edge has no staged source', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux preset dangling '))
    try {
      const pluginsDir = join(fixture, 'plugins')
      createPackage(join(pluginsDir, 'omnimux-forms'), 'omnimux-forms', {
        dependencies: { 'omnimux-hub': 'file:../omnimux-hub' },
      })

      expect(() => assertStagedSelfContained(pluginsDir))
        .toThrowError('has no staged source at "file:../omnimux-hub"')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('tolerates a shadowed dependency spec and an absent optional edge', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'omnimux optional edge '))
    try {
      const stagedRoot = join(fixture, 'packages')
      const packageDir = join(stagedRoot, 'omnimux-assets')
      createPackage(packageDir, 'omnimux-assets', {
        dependencies: { 'omnimux-hub': 'file:../../missing omnimux-hub' },
        optionalDependencies: { 'omnimux-hub': 'file:../omnimux-hub' },
      })

      // pnpm gives optionalDependencies precedence, so the shadowed edge is not
      // an effective spec; the optional one has no staged source because the
      // platform excluded its package. Neither may fail the gate.
      expect(() => normalizeStagedManifest('omnimux-assets', packageDir, stagedRoot)).not.toThrow()
      expect(() => assertStagedSelfContained(stagedRoot)).not.toThrow()
      expect(readJson(join(packageDir, 'package.json')).dependencies)
        .toEqual({ 'omnimux-hub': 'file:../../missing omnimux-hub' })
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})

interface PackageManifestExtras {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly os?: readonly string[]
}

function createProductPlugins(
  pluginsRoot: string,
  extras: Partial<Record<(typeof PRODUCT_PLUGINS)[number], PackageManifestExtras>> = {},
): void {
  for (const name of PRODUCT_PLUGINS) createPackage(join(pluginsRoot, name), name, extras[name])
  const hubSource = join(pluginsRoot, 'omnimux', 'src')
  mkdirSync(hubSource)
  writeFileSync(join(hubSource, 'plugin-lifecycle.json'), `${JSON.stringify(LIFECYCLE, undefined, 2)}\n`)
  writeFileSync(join(hubSource, 'release-channel.json'), '{\n  "channel": "development"\n}\n')
  createProductPresets(pluginsRoot)
}

/** Product presets live beside the plugin tree in the product workspace. */
function createProductPresets(pluginsRoot: string): void {
  const presetsRoot = join(dirname(pluginsRoot), 'presets')
  for (const id of ['cordis', 'daily-work', 'standard', 'tiktok-agent']) {
    mkdirSync(join(presetsRoot, id), { recursive: true })
    writeFileSync(join(presetsRoot, id, 'preset.yml'), `name: ${id}\n`)
  }
  mkdirSync(join(presetsRoot, 'fragments'), { recursive: true })
  writeFileSync(join(presetsRoot, 'fragments', 'shared.yml'), 'name: shared\n')
}

function createPackage(root: string, name: string, extras: PackageManifestExtras = {}): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    name,
    version: '1.0.0',
    main: 'index.js',
    ...extras,
  }, undefined, 2)}\n`)
  writeFileSync(join(root, 'index.js'), `module.exports = { loaded: ${JSON.stringify(name)} }\n`)
}

function createExistingPreset(presetDir: string): void {
  createPackage(join(presetDir, 'plugins', 'existing-valid'), 'existing-valid')
  createPresetSkeleton(presetDir)
  writeFileSync(join(presetDir, 'owned-packages.json'), '["existing-valid"]\n')
  writeFileSync(join(presetDir, 'seed-version'), '7\n')
}

function createPresetSkeleton(presetDir: string): void {
  const skeleton = join(presetDir, 'skeleton')
  mkdirSync(skeleton, { recursive: true })
  writeFileSync(join(skeleton, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-omnimux',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'dsh-better-sidebar',
      'omnimux',
      'omnimux-accounts',
      'omnimux-assets',
      'omnimux-workflow',
    ] } },
  }, undefined, 2)}\n`)
  writeFileSync(join(skeleton, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(skeleton, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
}

function expectExistingPreset(presetDir: string): void {
  expect(existsSync(join(presetDir, 'plugins', 'existing-valid', 'package.json'))).toBe(true)
  expect(readFileSync(join(presetDir, 'owned-packages.json'), 'utf8')).toBe('["existing-valid"]\n')
  expect(readFileSync(join(presetDir, 'seed-version'), 'utf8')).toBe('7\n')
}

function relativeFileSpec(from: string, path: string): string {
  const value = relative(from, path).split(sep).join('/')
  return `file:${value.startsWith('.') ? value : `./${value}`}`
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
}

function findSymlinks(root: string): string[] {
  const found: string[] = []
  const queue = [root]
  while (queue.length > 0) {
    const dir = queue.pop()!
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) found.push(path)
      else if (entry.isDirectory()) queue.push(path)
    }
  }
  return found
}
