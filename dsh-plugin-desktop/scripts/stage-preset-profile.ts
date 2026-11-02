/** Materialize offline OmniMux profile plugins into preset/plugins. */

import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashDirectory } from '../src/managed-profile.ts'
import { DISTRIBUTION_FILENAME, SKILLS_DIRNAME, SKILL_ORIGIN_FILENAME, listPackageNames, packageDirSegments } from '../src/preset-profile.ts'
import {
  BETTER_SIDEBAR_PNPM_VERSION,
  buildPatchedBetterSidebar,
  verifyInstalledBetterSidebar,
} from './better-sidebar/build-patched-sidebar.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultPresetDir = join(desktopRoot, 'preset')
const defaultPluginsDir = join(defaultPresetDir, 'plugins')
/** Repository-root tier config: the one place that says which plugins ship. */
const PLUGIN_TIERS_PATH = join(resolve(desktopRoot, '..'), 'config', 'plugin-tiers.json')
/**
 * Every plugin the preset owns, read from the tier config instead of a copy.
 *
 * `infrastructure` is staged separately from its patched source, and `retired`
 * plugins must not be staged at all: the product tree stops materializing them,
 * so a preset that still owned one would fail the seed with the same
 * "dependency ... must be file:.materialize-snapshots/..." recovery-window crash.
 * Beta stays staged because Desktop ships beta plugins for internal testing;
 * only the market withholds them.
 */
function readProductPlugins(): readonly string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(PLUGIN_TIERS_PATH, 'utf8'))
  } catch (error) {
    throw new Error(`plugin tier config is unreadable (${PLUGIN_TIERS_PATH}): ${String(error)}`)
  }
  const tiers = (parsed as { tiers?: Record<string, unknown> } | null)?.tiers
  if (tiers === null || typeof tiers !== 'object') {
    throw new Error(`plugin tier config must declare a "tiers" object: ${PLUGIN_TIERS_PATH}`)
  }
  const names: string[] = []
  for (const tier of ['preview', 'beta'] as const) {
    const value = tiers[tier]
    if (!Array.isArray(value) || value.some(name => typeof name !== 'string' || name === '')) {
      throw new Error(`plugin tier config: tiers.${tier} must be an array of plugin names: ${PLUGIN_TIERS_PATH}`)
    }
    names.push(...(value as string[]))
  }
  return names
}

const PRODUCT_PLUGINS = readProductPlugins()
const CORE_REQUIRED_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  'dsh-better-sidebar',
  'omnimux',
] as const
const RELEASE_CHANNELS = ['production', 'development'] as const
type ReleaseChannel = (typeof RELEASE_CHANNELS)[number]
/** Staged product presets, published beside the plugin seed. */
const AGENT_PRESETS_DIRNAME = 'agent-presets'
/** Preset manifest every staged preset directory must carry. */
const AGENT_PRESET_MANIFEST = 'preset.yml'
/** Shared preset inputs the repository keeps beside the preset ids. */
const AGENT_PRESET_EXCLUDED_DIRS: ReadonlySet<string> = new Set(['fragments'])
/** Directory-bundle entry file every staged skill must carry. */
const SKILL_MANIFEST = 'SKILL.md'
/** Version of the distribution record's own shape. */
const DISTRIBUTION_SCHEMA = 1

/**
 * Product-tree plugins staged into the preset. The profile stays on `link:`
 * during development; packaging reads the same source trees (the link
 * targets) and materializes offline copies here — one structure, no
 * switching. The source root is required via OMNIMUX_PLUGINS_DIR so the
 * desktop deploy root never embeds a host machine's absolute path.
 */
interface Manifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}
interface LifecycleEntry {
  readonly stage: 'alpha'
  readonly toolPrefixes: readonly string[]
}
export interface StagePresetProfileOptions {
  readonly pluginsRoot?: string
  readonly presetDir?: string
  readonly releaseChannel?: ReleaseChannel
}

/**
 * Stage plugin snapshots the desktop seed copies into the user profile.
 * @returns the number of package directories written under preset/plugins.
 */
export function stagePresetProfile(options: StagePresetProfileOptions = {}): number {
  if (process.env.DSH_BETTER_SIDEBAR_SPEC !== undefined) {
    throw new Error('DSH_BETTER_SIDEBAR_SPEC is no longer supported; the sidebar source and patch are repository-pinned')
  }
  const releaseChannel = options.releaseChannel ?? 'production'
  if (!RELEASE_CHANNELS.includes(releaseChannel)) {
    throw new Error(`release channel must be production or development: ${JSON.stringify(releaseChannel)}`)
  }
  const targetPresetDir = resolve(options.presetDir ?? defaultPresetDir)
  const pluginsRoot = options.pluginsRoot ?? process.env.OMNIMUX_PLUGINS_DIR
  if (pluginsRoot === undefined || pluginsRoot === '') {
    throw new Error('OMNIMUX_PLUGINS_DIR is required (absolute path to the omnimux-dsh product-tree plugins directory)')
  }
  const resolvedPluginsRoot = resolve(pluginsRoot)
  const lifecycle = readLifecycleRegistry(resolvedPluginsRoot)
  readSourceReleaseChannel(resolvedPluginsRoot)
  const alphaPlugins = new Set(Object.keys(lifecycle))
  const productPlugins: readonly string[] = PRODUCT_PLUGINS.filter(name => releaseChannel === 'development' || !alphaPlugins.has(name))
  for (const name of alphaPlugins) {
    if (!existsSync(join(resolvedPluginsRoot, ...packageDirSegments(name)))) {
      throw new Error(`unknown lifecycle plugin: ${name}`)
    }
  }
  for (const name of PRODUCT_PLUGINS) assertProductPluginSource(resolvedPluginsRoot, name)
  mkdirSync(targetPresetDir, { recursive: true })
  // Keep every local file: spec on one canonical path namespace. macOS may
  // expose the same temporary directory as both /var and /private/var;
  // mixing those spellings makes pnpm resolve a valid tarball as /private/private/var.
  const staging = realpathSync(mkdtempSync(join(tmpdir(), 'omnimux-preset-')))
  let candidateDir: string | undefined
  try {
    const sidebar = buildPatchedBetterSidebar(join(staging, 'better-sidebar'))
    const dependencies: Record<string, string> = {
      'dsh-better-sidebar': toFileSpec(staging, sidebar.tarballPath),
    }
    const optionalDependencies: Record<string, string> = {}
    const stagedPackagesRoot = join(staging, 'packages')
    const packages = new Map<string, { source: string; destination: string }>()
    for (const name of productPlugins) {
      const source = realpathSync(join(resolvedPluginsRoot, name))
      const destination = join(stagedPackagesRoot, ...packageDirSegments(name))
      registerPackage(packages, name, source, destination)
    }
    const copied = new Set<string>()
    for (const name of productPlugins) {
      const entry = packages.get(name)!
      copyPackageClosure(
        name,
        entry.source,
        entry.destination,
        stagedPackagesRoot,
        packages,
        copied,
        releaseChannel === 'production' ? alphaPlugins : new Set(),
      )
      dependencies[name] = toFileSpec(staging, entry.destination)
    }
    for (const [name, entry] of packages) normalizeStagedManifest(name, entry.destination, stagedPackagesRoot)
    writeReleaseChannel(join(stagedPackagesRoot, 'omnimux'), releaseChannel)
    for (const [name, entry] of packages) {
      if (productPlugins.includes(name)) continue
      if (Object.hasOwn(dependencies, name)) {
        throw new Error(
          `local package ${JSON.stringify(name)} from ${entry.source} conflicts with explicit staging dependency ${JSON.stringify(dependencies[name])}`,
        )
      }
      optionalDependencies[name] = toFileSpec(staging, entry.destination)
    }
    writeFileSync(join(staging, 'package.json'), `${JSON.stringify({
      private: true,
      dependencies,
      optionalDependencies,
    }, undefined, 2)}\n`)
    writeFileSync(join(staging, 'pnpm-workspace.yaml'), `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n`)
    installStaging(staging)
    assertNoAlphaPackages(join(staging, 'node_modules'), alphaPlugins, releaseChannel)

    candidateDir = mkdtempSync(join(targetPresetDir, '.preset-stage-'))
    const candidatePluginsDir = join(candidateDir, 'plugins')
    mkdirSync(candidatePluginsDir)
    copyHoistedModules(join(staging, 'node_modules'), candidatePluginsDir)
    const owned = listPackageNames(candidatePluginsDir)
    for (const required of [...productPlugins, 'dsh-better-sidebar']) {
      if (!owned.includes(required)) {
        throw new Error(`staged preset is missing required plugin ${required}: ${owned.join(', ')}`)
      }
    }
    assertNoAlphaPackages(candidatePluginsDir, alphaPlugins, releaseChannel)
    assertReleaseChannel(candidatePluginsDir, releaseChannel)
    assertStagedSelfContained(candidatePluginsDir)
    verifyInstalledBetterSidebar(join(candidatePluginsDir, 'dsh-better-sidebar'), sidebar.packedRoot)
    stageSkeleton(targetPresetDir, candidateDir, alphaPlugins, releaseChannel)
    assertSkeletonBundlesAreStaged(candidateDir)
    stageAgentPresets(resolvedPluginsRoot, candidateDir)
    const skills = stageSkills(resolvedPluginsRoot, candidateDir, productPlugins)
    writeFileSync(join(candidateDir, 'owned-packages.json'), `${JSON.stringify(owned, undefined, 2)}\n`)
    writeFileSync(
      join(candidateDir, DISTRIBUTION_FILENAME),
      `${JSON.stringify(distributionManifest(owned, skills, candidateDir, releaseChannel, alphaPlugins), undefined, 2)}\n`,
    )
    const seedVersionPath = join(targetPresetDir, 'seed-version')
    writeFileSync(
      join(candidateDir, 'seed-version'),
      existsSync(seedVersionPath) ? readFileSync(seedVersionPath) : '1\n',
    )
    publishCandidate(candidateDir, targetPresetDir)
    candidateDir = undefined
    return owned.length
  } finally {
    if (candidateDir !== undefined) rmSync(candidateDir, { recursive: true, force: true })
    rmSync(staging, { recursive: true, force: true })
  }
}

function registerPackage(
  packages: Map<string, { source: string; destination: string }>,
  name: string,
  source: string,
  destination: string,
): void {
  packageDirSegments(name)
  const existing = packages.get(name)
  if (existing !== undefined && existing.source !== source) {
    throw new Error(`local package ${JSON.stringify(name)} resolves to conflicting sources: ${existing.source} and ${source}`)
  }
  if (existing === undefined) packages.set(name, { source, destination })
}

function copyPackageClosure(
  name: string,
  source: string,
  destination: string,
  stagedPackagesRoot: string,
  packages: Map<string, { source: string; destination: string }>,
  copied: Set<string>,
  excludedPackages: ReadonlySet<string>,
): void {
  if (copied.has(name)) return
  copied.add(name)
  copyPluginSources(source, destination)
  const manifestPath = join(destination, 'package.json')
  const manifest = readManifest(manifestPath)
  const optionalDependencies = new Set(Object.keys(manifest.optionalDependencies ?? {}))
  let changed = false
  for (const field of ['dependencies', 'optionalDependencies'] as const) {
    const dependencyMap = manifest[field]
    if (dependencyMap === undefined) continue
    for (const [dependencyName, spec] of Object.entries(dependencyMap)) {
      if (field === 'dependencies' && optionalDependencies.has(dependencyName)) continue
      if (excludedPackages.has(dependencyName)) {
        throw new Error(`production plugin ${JSON.stringify(name)} depends on Alpha plugin ${JSON.stringify(dependencyName)}`)
      }
      if (!spec.startsWith('file:')) continue
      const sourcePath = spec.slice('file:'.length)
      if (sourcePath === '') {
        throw new Error(`local dependency ${JSON.stringify(dependencyName)} in ${join(source, 'package.json')} has an empty file: path`)
      }
      const unresolvedSource = resolve(source, sourcePath)
      if (!existsSync(join(unresolvedSource, 'package.json'))) {
        throw new Error(`local dependency ${JSON.stringify(dependencyName)} is missing package.json: ${unresolvedSource}`)
      }
      const dependencySource = realpathSync(unresolvedSource)
      const dependencyDestination = join(stagedPackagesRoot, ...packageDirSegments(dependencyName))
      registerPackage(packages, dependencyName, dependencySource, dependencyDestination)
      const entry = packages.get(dependencyName)!
      copyPackageClosure(
        dependencyName,
        entry.source,
        entry.destination,
        stagedPackagesRoot,
        packages,
        copied,
        excludedPackages,
      )
      dependencyMap[dependencyName] = toFileSpec(destination, entry.destination)
      changed = true
    }
  }
  if (changed) writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
}

function readManifest(path: string): Manifest {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Manifest
  } catch (error) {
    throw new Error(`cannot read package manifest ${path}: ${String(error)}`)
  }
}

function readLifecycleRegistry(pluginsRoot: string): Readonly<Record<string, LifecycleEntry>> {
  const path = join(pluginsRoot, 'omnimux', 'src', 'plugin-lifecycle.json')
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`plugin lifecycle registry is unreadable (${path}): ${String(error)}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`plugin lifecycle registry must be an object: ${path}`)
  }
  if (Object.keys(value).length === 0) {
    throw new Error(`plugin lifecycle registry must contain at least one entry: ${path}`)
  }
  for (const [pluginId, entry] of Object.entries(value)) {
    packageDirSegments(pluginId)
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`invalid lifecycle entry: ${pluginId}`)
    }
    const candidate = entry as Partial<LifecycleEntry>
    if (candidate.stage !== 'alpha' || !Array.isArray(candidate.toolPrefixes)) {
      throw new Error(`invalid lifecycle entry: ${pluginId}`)
    }
    if (candidate.toolPrefixes.some(prefix => typeof prefix !== 'string' || prefix.length === 0)) {
      throw new Error(`invalid lifecycle tool prefix: ${pluginId}`)
    }
  }
  return value as Record<string, LifecycleEntry>
}

function readSourceReleaseChannel(pluginsRoot: string): void {
  const path = join(pluginsRoot, 'omnimux', 'src', 'release-channel.json')
  const channel = readReleaseChannel(path)
  if (channel !== 'development') {
    throw new Error(`product source release channel must be development: ${path}`)
  }
}

function readReleaseChannel(path: string): ReleaseChannel {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`release channel marker is unreadable (${path}): ${String(error)}`)
  }
  const channel = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as { channel?: unknown }).channel
    : undefined
  if (channel !== 'production' && channel !== 'development') {
    throw new Error(`release channel marker is invalid (${path}): ${JSON.stringify(channel)}`)
  }
  return channel
}

function assertProductPluginSource(pluginsRoot: string, name: string): void {
  const path = join(pluginsRoot, ...packageDirSegments(name), 'package.json')
  if (!existsSync(path)) {
    throw new Error(`product plugin source is missing: ${dirname(path)} (set OMNIMUX_PLUGINS_DIR)`)
  }
  const manifest = readManifest(path)
  if (manifest.name !== name) {
    throw new Error(`product plugin source ${path} declares name ${JSON.stringify(manifest.name)}, expected ${JSON.stringify(name)}`)
  }
}

function writeReleaseChannel(hubRoot: string, releaseChannel: ReleaseChannel): void {
  writeFileSync(
    join(hubRoot, 'src', 'release-channel.json'),
    `${JSON.stringify({ channel: releaseChannel }, undefined, 2)}\n`,
  )
}

function assertReleaseChannel(pluginsDir: string, releaseChannel: ReleaseChannel): void {
  const path = join(pluginsDir, 'omnimux', 'src', 'release-channel.json')
  if (readReleaseChannel(path) !== releaseChannel) {
    throw new Error(`staged hub release channel does not match ${releaseChannel}: ${path}`)
  }
}

function assertNoAlphaPackages(
  pluginsDir: string,
  alphaPlugins: ReadonlySet<string>,
  releaseChannel: ReleaseChannel,
): void {
  if (releaseChannel !== 'production') return
  const found = listPackageNames(pluginsDir).filter(name => alphaPlugins.has(name))
  if (found.length > 0) {
    throw new Error(`production preset contains Alpha packages: ${found.join(', ')}`)
  }
}

function stageSkeleton(
  targetPresetDir: string,
  candidateDir: string,
  alphaPlugins: ReadonlySet<string>,
  releaseChannel: ReleaseChannel,
): void {
  const source = join(targetPresetDir, 'skeleton')
  const destination = join(candidateDir, 'skeleton')
  if (!existsSync(join(source, 'package.json'))) {
    throw new Error(`desktop preset skeleton package.json is missing: ${join(source, 'package.json')}`)
  }
  cpSync(source, destination, { recursive: true, dereference: true })
  const manifestPath = join(destination, 'package.json')
  const manifest = readManifest(manifestPath)
  const currentBundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(currentBundles) || currentBundles.some(name => typeof name !== 'string' || name === '')) {
    throw new Error(`desktop preset skeleton bundles are invalid: ${manifestPath}`)
  }
  const bundles = currentBundles.filter(name => !alphaPlugins.has(name))
  if (releaseChannel === 'development') {
    for (const name of alphaPlugins) if (!bundles.includes(name)) bundles.push(name)
  }
  const missingCore = CORE_REQUIRED_BUNDLES.filter(name => !bundles.includes(name))
  if (missingCore.length > 0) {
    throw new Error(`desktop preset skeleton is missing mandatory bundles: ${missingCore.join(', ')}`)
  }
  const stripAlpha = (dependencies: Record<string, string> | undefined): Record<string, string> | undefined => {
    if (dependencies === undefined || releaseChannel === 'development') return dependencies
    return Object.fromEntries(Object.entries(dependencies).filter(([name]) => !alphaPlugins.has(name)))
  }
  writeFileSync(manifestPath, `${JSON.stringify({
    ...manifest,
    dependencies: stripAlpha(manifest.dependencies),
    optionalDependencies: stripAlpha(manifest.optionalDependencies),
    devDependencies: stripAlpha(manifest.devDependencies),
    dsh: {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh?.profile,
        bundles,
      },
    },
  }, undefined, 2)}\n`)
}

/**
 * Refuse a preset whose skeleton names a bundle the staging never wrote.
 *
 * The skeleton's bundles are the Profile's load list, and the seed asserts each
 * one resolves under `preset/plugins` before it touches the user's Profile. A
 * preset that fails that assert cannot boot: the app opens its recovery window
 * instead of the desktop. Asserting the artifact here keeps that failure in the
 * build, where the message names the package instead of a startup crash.
 */
function assertSkeletonBundlesAreStaged(candidateDir: string): void {
  const manifest = readManifest(join(candidateDir, 'skeleton', 'package.json'))
  const pluginsDir = join(candidateDir, 'plugins')
  const missing = (manifest.dsh?.profile?.bundles ?? []).filter(name =>
    !name.startsWith('@deepseek-ai/')
    && !existsSync(join(pluginsDir, ...packageDirSegments(name), 'package.json')))
  if (missing.length > 0) {
    throw new Error(
      `desktop preset declares bundles it does not stage: ${missing.join(', ')}; `
      + 'list every declared bundle in PRODUCT_PLUGINS or drop it from preset/skeleton/package.json',
    )
  }
}

/** A skill staged from a product plugin, recorded so the seed can own its copy. */
interface StagedSkill {
  readonly id: string
  readonly origin: string
}

/** Read one JSON object, rejecting anything that is not a plain object. */
function readJsonObject(path: string, label: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is unreadable (${path}): ${String(error)}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object: ${path}`)
  }
  return value as Record<string, unknown>
}

/**
 * Collect the skills the staged product plugins declare.
 *
 * A plugin advertises skills in its `dsh.manifest.json`. Shipping the file
 * inside the plugin package is not enough: nothing registers a plugin package
 * as a skill root, so the skill is present on disk and invisible to the model.
 * Staging them under `preset/skills/` puts them where the seed can install them
 * into the Harness Home, which *is* a discovered root.
 *
 * Each staged skill keeps a marker naming the plugin it came from, so a later
 * seed can refresh its own copy without touching a skill the user owns.
 */
function stageSkills(pluginsRoot: string, candidateDir: string, productPlugins: readonly string[]): StagedSkill[] {
  const destinationRoot = join(candidateDir, SKILLS_DIRNAME)
  const staged: StagedSkill[] = []
  for (const name of productPlugins) {
    const manifestPath = join(pluginsRoot, name, 'dsh.manifest.json')
    if (!existsSync(manifestPath)) continue
    const manifest = readJsonObject(manifestPath, `plugin manifest for ${name}`)
    const declared = manifest.skills
    if (declared === undefined) continue
    if (!Array.isArray(declared) || declared.some(entry => typeof entry !== 'string')) {
      throw new Error(`plugin ${JSON.stringify(name)} declares an invalid skills list: ${manifestPath}`)
    }
    for (const relativeManifest of declared as string[]) {
      if (!relativeManifest.endsWith(`/${SKILL_MANIFEST}`)) {
        throw new Error(`plugin ${JSON.stringify(name)} skill ${JSON.stringify(relativeManifest)} is not a ${SKILL_MANIFEST} path`)
      }
      const pluginDir = join(pluginsRoot, name)
      const manifestFile = resolve(pluginDir, relativeManifest)
      if (!isInside(pluginDir, manifestFile)) {
        throw new Error(`plugin ${JSON.stringify(name)} skill ${JSON.stringify(relativeManifest)} escapes the plugin`)
      }
      if (!existsSync(manifestFile)) {
        throw new Error(`plugin ${JSON.stringify(name)} declares a missing skill: ${relativeManifest}`)
      }
      const skillDir = dirname(manifestFile)
      const id = basename(skillDir)
      if (staged.some(entry => entry.id === id)) {
        throw new Error(`two product plugins declare the same skill ${JSON.stringify(id)}`)
      }
      const destination = join(destinationRoot, id)
      mkdirSync(destination, { recursive: true })
      cpSync(skillDir, destination, { recursive: true, dereference: true })
      writeFileSync(join(destination, SKILL_ORIGIN_FILENAME), `${JSON.stringify({
        id,
        origin: `plugin:${name}`,
      }, undefined, 2)}\n`)
      staged.push({ id, origin: `plugin:${name}` })
    }
  }
  return staged.sort((left, right) => left.id.localeCompare(right.id))
}

/**
 * Stage the OmniMux agent presets beside the plugin seed.
 *
 * The presets used to be patched into the installed application after
 * packaging (an asar header edit plus an Info.plist integrity rewrite). That
 * only worked while the presets package was physically unpacked; selective
 * `asarUnpack` no longer unpacks it, so the injection point vanished and the
 * product presets silently stopped reaching the shell. Staging them into
 * `preset/agent-presets` ships them inside the signed bundle instead: the whole
 * `preset/**` tree is unpacked, and the profile composes this directory as an
 * additional system root.
 */
function stageAgentPresets(pluginsRoot: string, candidateDir: string): number {
  const source = join(dirname(pluginsRoot), 'presets')
  if (!existsSync(source)) {
    throw new Error(`product agent presets are missing: ${source} (set OMNIMUX_PLUGINS_DIR)`)
  }
  const ids = readdirSync(source, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !AGENT_PRESET_EXCLUDED_DIRS.has(entry.name))
    .map(entry => entry.name)
    .sort()
  if (ids.length === 0) throw new Error(`product agent presets are empty: ${source}`)
  for (const id of ids) {
    const manifest = join(source, id, AGENT_PRESET_MANIFEST)
    if (!existsSync(manifest)) throw new Error(`agent preset ${JSON.stringify(id)} has no ${AGENT_PRESET_MANIFEST}: ${manifest}`)
  }
  const destination = join(candidateDir, AGENT_PRESETS_DIRNAME)
  for (const id of ids) {
    cpSync(join(source, id), join(destination, id), { recursive: true, dereference: true })
  }
  return ids.length
}

function toFileSpec(fromPackageDir: string, targetPackageDir: string): string {
  const path = relative(fromPackageDir, targetPackageDir).split(sep).join('/')
  return `file:${path.startsWith('.') ? path : `./${path}`}`
}

/**
 * Make one staged package manifest safe to relocate.
 *
 * The preset ships as a physical copy outside the product tree, so a spec the
 * build-time checkout can resolve may not resolve on a user machine. Dev
 * dependencies are dropped outright: pnpm never installs a dependency's dev
 * dependencies, and they are the usual home of a source-relative `file:` edge
 * that the preset would carry forever. A workspace-only spec fails here, where
 * the offending product source is still known, rather than surfacing later as
 * `ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL` inside a user Profile.
 */
export function normalizeStagedManifest(name: string, packageDir: string, stagedPackagesRoot: string): void {
  const manifestPath = join(packageDir, 'package.json')
  const manifest = readManifest(manifestPath)
  let changed = false
  if (manifest.devDependencies !== undefined) {
    delete manifest.devDependencies
    changed = true
  }
  for (const field of ['dependencies', 'optionalDependencies'] as const) {
    const dependencyMap = manifest[field]
    if (dependencyMap === undefined) continue
    const optionalDependencies = manifest.optionalDependencies ?? {}
    for (const [dependency, spec] of Object.entries(dependencyMap)) {
      // pnpm gives optionalDependencies precedence over dependencies for the
      // same name, so the shadowed spec is not an effective edge.
      if (field === 'dependencies' && Object.hasOwn(optionalDependencies, dependency)) continue
      if (spec.startsWith('workspace:')) {
        throw new Error(
          `staged package ${JSON.stringify(name)} declares ${JSON.stringify(dependency)} as ${JSON.stringify(spec)}: `
          + 'a workspace-only spec cannot resolve after the preset is relocated, so publish a version or use a file: path',
        )
      }
      if (spec.startsWith('link:')) {
        throw new Error(
          `staged package ${JSON.stringify(name)} declares ${JSON.stringify(dependency)} as ${JSON.stringify(spec)}: `
          + 'symbolic links are forbidden in the preset',
        )
      }
      if (!spec.startsWith('file:')) continue
      if (!isInside(stagedPackagesRoot, resolve(packageDir, spec.slice('file:'.length)))) {
        throw new Error(
          `staged package ${JSON.stringify(name)} dependency ${JSON.stringify(dependency)} escapes the staged root (${JSON.stringify(spec)})`,
        )
      }
    }
  }
  if (changed) writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
}

/**
 * Verify the published preset cannot reference anything outside itself.
 *
 * `seedOmnimuxProfile` copies these directories into a user Profile verbatim,
 * so a manifest that still points at the product tree fails there with a pnpm
 * error naming neither the plugin nor the preset. Check the artifact.
 */
export function assertStagedSelfContained(pluginsDir: string): void {
  for (const name of listPackageNames(pluginsDir)) {
    const packageDir = join(pluginsDir, ...packageDirSegments(name))
    const manifest = readManifest(join(packageDir, 'package.json'))
    for (const field of ['dependencies', 'optionalDependencies'] as const) {
      const dependencyMap = manifest[field]
      if (dependencyMap === undefined) continue
      const optionalDependencies = manifest.optionalDependencies ?? {}
      for (const [dependency, spec] of Object.entries(dependencyMap)) {
        // pnpm gives optionalDependencies precedence over dependencies for the
        // same name, so the shadowed spec is not an effective edge.
        if (field === 'dependencies' && Object.hasOwn(optionalDependencies, dependency)) continue
        if (!spec.startsWith('file:')) {
          if (spec.startsWith('workspace:') || spec.startsWith('link:')) {
            throw new Error(
              `staged preset package ${JSON.stringify(name)} declares ${JSON.stringify(dependency)} as ${JSON.stringify(spec)}`,
            )
          }
          continue
        }
        const target = resolve(packageDir, spec.slice('file:'.length))
        if (!isInside(pluginsDir, target)) {
          throw new Error(
            `staged preset package ${JSON.stringify(name)} dependency ${JSON.stringify(dependency)} escapes the preset (${JSON.stringify(spec)})`,
          )
        }
        // An effective optional local edge may be absent when the platform
        // excludes its package; a target that is present must still be real.
        if (field === 'optionalDependencies' && !existsSync(target)) continue
        if (!existsSync(join(target, 'package.json'))) {
          throw new Error(
            `staged preset package ${JSON.stringify(name)} dependency ${JSON.stringify(dependency)} has no staged source at ${JSON.stringify(spec)}`,
          )
        }
      }
    }
  }
}

/** True when `target` stays inside `root`, comparing resolved path segments. */
function isInside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function copyPluginSources(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true })
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: (path) => {
      const relative = path.slice(source.length)
      if (relative.includes(`${join('node_modules')}`)) return false
      if (relative.endsWith('.test.js') || relative.endsWith('.spec.js')) return false
      return true
    },
  })
}

function installStaging(staging: string): void {
  const installArgs = ['install', '--prod', '--ignore-scripts', '--config.confirmModulesPurge=false']
  const command = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : 'corepack'
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', `corepack pnpm@${BETTER_SIDEBAR_PNPM_VERSION} ${installArgs.join(' ')}`]
    : [`pnpm@${BETTER_SIDEBAR_PNPM_VERSION}`, ...installArgs]
  const result = spawnSync(command, args, {
    cwd: staging,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
  })
  if (result.status === 0) return
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const status = result.status === null
    ? result.signal ?? result.error?.message ?? 'unknown'
    : String(result.status)
  throw new Error([
    `stage-preset-profile: pnpm install failed (${status})`,
    result.error === undefined ? undefined : `error: ${result.error.message}`,
    `stdout:\n${stdout === '' ? '<empty>' : stdout.trimEnd()}`,
    `stderr:\n${stderr === '' ? '<empty>' : stderr.trimEnd()}`,
  ].filter((line): line is string => line !== undefined).join('\n'))
}

function copyHoistedModules(source: string, destination: string): void {
  for (const name of listPackageNames(source)) {
    const from = join(source, ...name.split('/'))
    const to = join(destination, ...name.split('/'))
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to, { recursive: true, dereference: true })
    // pnpm materializes nested `node_modules/.bin` entries whose relative
    // targets pointed into the (now deleted) staging tree. electron-builder
    // stats every packaged file, so a dangling link fails the whole build,
    // while runtime code never invokes these CLI shims.
    removeDanglingBinLinks(to)
  }
}

function removeDanglingBinLinks(packageDir: string): void {
  const queue = [join(packageDir, 'node_modules')]
  while (queue.length > 0) {
    const dir = queue.pop()!
    const binDir = join(dir, '.bin')
    if (existsSync(binDir)) rmSync(binDir, { recursive: true, force: true })
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== '.bin' && !entry.name.startsWith('.')) {
        queue.push(join(dir, entry.name, 'node_modules'))
      }
    }
  }
}

/** One preinstalled entry in a staged preset's distribution record. */
interface DistributionItem {
  readonly kind: 'plugin' | 'skill'
  readonly id: string
  readonly tier: 'core' | 'product' | 'beta'
  readonly version: string | null
  readonly digest: string
  /** Skill only: the product surface the skill came from. */
  readonly origin?: string
}

/** The staged preset's own account of what it ships. */
interface DistributionManifest {
  readonly schema: number
  readonly channel: ReleaseChannel
  readonly generatedFrom: { readonly appVersion: string; readonly desktopCommit: string | null }
  readonly items: readonly DistributionItem[]
}

/**
 * Record what this preset ships, beside the packages themselves.
 *
 * `owned-packages.json` answers "which directories exist"; this answers "which
 * product, at which version, at which bytes" — the question a support report or
 * a release audit actually asks. `verify-distribution` reads it back and fails
 * when the artifact no longer matches, so the record cannot drift into a claim.
 *
 * `tier` restates the release-channel decision as data: `beta` entries are the
 * lifecycle-registry Alpha plugins, which a production channel never stages.
 *
 * Skills are recorded beside packages because the seed installs both: a skill a
 * plugin declares is invisible until it reaches the Harness Home's skill root.
 */
function distributionManifest(
  owned: readonly string[],
  skills: readonly StagedSkill[],
  candidateDir: string,
  releaseChannel: ReleaseChannel,
  alphaPlugins: ReadonlySet<string>,
): DistributionManifest {
  const pluginsDir = join(candidateDir, 'plugins')
  const core = new Set<string>(CORE_REQUIRED_BUNDLES)
  const pluginItems: DistributionItem[] = owned.map((id) => {
    const packageDir = join(pluginsDir, ...packageDirSegments(id))
    const manifest = readManifest(join(packageDir, 'package.json'))
    return {
      kind: 'plugin',
      id,
      tier: core.has(id) ? 'core' : alphaPlugins.has(id) ? 'beta' : 'product',
      version: typeof manifest.version === 'string' ? manifest.version : null,
      digest: hashDirectory(packageDir),
    }
  })
  const skillItems: DistributionItem[] = skills.map(skill => ({
    kind: 'skill',
    id: skill.id,
    tier: 'product',
    version: null,
    digest: hashDirectory(join(candidateDir, SKILLS_DIRNAME, skill.id)),
    origin: skill.origin,
  }))
  return {
    schema: DISTRIBUTION_SCHEMA,
    channel: releaseChannel,
    generatedFrom: { appVersion: desktopPackageVersion(), desktopCommit: desktopCommit() },
    items: [...pluginItems, ...skillItems],
  }
}

/** Version of the desktop package that produced this preset. */
function desktopPackageVersion(): string {
  const manifest = readManifest(join(desktopRoot, 'package.json'))
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

/** Short HEAD of the fork checkout, or null when the tree is not a Git work tree. */
function desktopCommit(): string | null {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: resolve(desktopRoot, '..'),
    encoding: 'utf8',
  })
  if (result.status !== 0) return null
  const head = (result.stdout ?? '').trim()
  return head.length > 0 ? head : null
}

export function publishCandidate(
  candidateDir: string,
  targetPresetDir: string,
  rename: typeof renameSync = renameSync,
): void {
  const entries = [
    'plugins',
    'skeleton',
    'agent-presets',
    SKILLS_DIRNAME,
    'owned-packages.json',
    DISTRIBUTION_FILENAME,
    'seed-version',
  ] as const
  const backupRoot = mkdtempSync(join(targetPresetDir, '.preset-backup-'))
  const backedUp: string[] = []
  const published: string[] = []
  try {
    for (const entry of entries) {
      const target = join(targetPresetDir, entry)
      if (!existsSync(target)) continue
      rename(target, join(backupRoot, entry))
      backedUp.push(entry)
    }
    for (const entry of entries) {
      const source = join(candidateDir, entry)
      if (!existsSync(source)) continue
      rename(source, join(targetPresetDir, entry))
      published.push(entry)
    }
  } catch (error) {
    const rollbackErrors: string[] = []
    for (const entry of [...published].reverse()) {
      try {
        rmSync(join(targetPresetDir, entry), { recursive: true, force: true })
      } catch (rollbackError) {
        rollbackErrors.push(`remove new ${entry}: ${String(rollbackError)}`)
      }
    }
    for (const entry of [...backedUp].reverse()) {
      try {
        const target = join(targetPresetDir, entry)
        if (existsSync(target)) rmSync(target, { recursive: true, force: true })
        rename(join(backupRoot, entry), target)
      } catch (rollbackError) {
        rollbackErrors.push(`restore ${entry}: ${String(rollbackError)}`)
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(
        `preset publish failed (${String(error)}); rollback also failed; previous preset backup retained at ${backupRoot}: ${rollbackErrors.join('; ')}`,
      )
    }
    rmSync(backupRoot, { recursive: true, force: true })
    throw error
  }
  try {
    rmSync(candidateDir, { recursive: true, force: true })
    rmSync(backupRoot, { recursive: true, force: true })
  } catch (error) {
    throw new Error(
      `preset published successfully, but staging cleanup failed; the new preset remains active and the previous backup is retained at ${backupRoot}: ${String(error)}`,
    )
  }
}
function main(): void {
  const count = stagePresetProfile({ releaseChannel: parseReleaseChannel(process.argv.slice(2)) })
  process.stdout.write(`staged ${String(count)} preset packages into ${defaultPluginsDir}\n`)
}

export function parseReleaseChannel(args: readonly string[]): ReleaseChannel {
  if (args.length === 0) return 'production'
  if (args.length === 2 && args[0] === '--channel' && RELEASE_CHANNELS.includes(args[1] as ReleaseChannel)) {
    return args[1] as ReleaseChannel
  }
  throw new Error('usage: stage-preset-profile.ts [--channel production|development]')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
