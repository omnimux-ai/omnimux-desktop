/** Stable, transaction-safe package sources for the OmniMux profile. */

import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { valid } from 'semver'
import { parseDocument } from 'yaml'

export const MANAGED_SOURCE_DIRECTORY = '.materialize-snapshots/plugins'

const REVIEWED_NODE_PTY_VERSION = '1.1.0'
const PNPM_BUILD_REVIEW_PENDING = 'set this to true or false'
const NODE_PTY_DARWIN_HELPERS = [
  'prebuilds/darwin-arm64/spawn-helper',
  'prebuilds/darwin-x64/spawn-helper',
] as const

export const OFFICIAL_PROFILE_REBUILD_REMEDY =
  'Run: yarn omnimux:profile rebuild --target dev|prod --app <frozen-candidate.app>'

const GRAPH_ENTRIES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'node_modules',
  '.materialize-snapshots',
] as const

interface PackageManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly dependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
  readonly main?: unknown
  readonly exports?: unknown
  readonly bin?: unknown
  readonly dsh?: unknown
  readonly [key: string]: unknown
}

/** Preset-era Profile-local dependency spec, e.g. `file:./node_modules/<name>`. */
const LEGACY_PROFILE_LOCAL_SPEC = /^file:(?:\.\/)?node_modules\//u

export interface ManagedProfileRebuildOptions {
  readonly profileDir: string
  readonly presetDir: string
  readonly ownedPackages: readonly string[]
  readonly materialize: (candidateProfileDir: string) => Promise<void>
  /** Return pnpm's exact publish file list without running package scripts. */
  readonly packedFiles: (sourceDir: string) => Promise<readonly string[]>
  /** Test seam for a commit-time filesystem failure. */
  readonly rename?: (source: string, destination: string) => void
}

export interface ManagedProfileRebuildResult {
  readonly profileDir: string
  readonly packageCount: number
  readonly preservedManagedSources: readonly string[]
  /** Legacy Profile-local dependencies the staged preset no longer owns. */
  readonly droppedLegacySources: readonly string[]
  readonly sourceHash: string
  readonly manifestHash: string
}

export function packagePathSegments(name: string): string[] {
  if (name === '' || name.includes('\\') || isAbsolute(name)) fail(`invalid package name ${JSON.stringify(name)}`)
  const segments = name.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    fail(`invalid package name ${JSON.stringify(name)}`)
  }
  return segments
}

export function managedSourceRoot(profileDir: string): string {
  return join(profileDir, ...MANAGED_SOURCE_DIRECTORY.split('/'))
}

export function managedSourcePath(profileDir: string, name: string): string {
  return join(managedSourceRoot(profileDir), ...packagePathSegments(name))
}

export function managedDependencySpec(name: string): string {
  packagePathSegments(name)
  return `file:${MANAGED_SOURCE_DIRECTORY}/${name}`
}

function fail(message: string): never {
  throw new Error(`OmniMux managed Profile: ${message}. ${OFFICIAL_PROFILE_REBUILD_REMEDY}`)
}

function readManifest(path: string): PackageManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (cause) {
    fail(`unreadable package manifest at ${path} (${String(cause)})`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail(`invalid package manifest at ${path}`)
  return parsed as PackageManifest
}

function manifestAt(root: string, name: string): string {
  return join(root, ...packagePathSegments(name), 'package.json')
}

interface LocalDependencySpec {
  readonly dependency: string
  readonly spec: string
  readonly optional: boolean
}

interface RuntimeResolution {
  readonly entry?: string
  readonly error?: string
}

function localDependencySpecs(manifest: PackageManifest): LocalDependencySpec[] {
  // pnpm gives optionalDependencies precedence over dependencies for the same
  // name. Validate only the effective edge, not an inactive shadowed spec.
  const optionalDependencies = manifest.optionalDependencies ?? {}
  const required = Object.entries(manifest.dependencies ?? {})
    .filter(([dependency]) => !Object.hasOwn(optionalDependencies, dependency))
    .map(([dependency, spec]) => ({ dependency, spec, optional: false }))
  const optional = Object.entries(optionalDependencies)
    .map(([dependency, spec]) => ({ dependency, spec, optional: true }))
  return [...required, ...optional]
}

function assertContained(root: string, target: string, label: string): void {
  const path = relative(root, target)
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) fail(`${label} escapes ${root}`)
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    fail(`cannot inspect ${path} (${String(cause)})`)
  }
}

function assertPhysicalDirectory(path: string, label: string): void {
  const stat = lstatIfPresent(path)
  if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`${label} is missing or is not a physical directory at ${path}`)
  }
}

export function assertPhysicalProfileBoundary(profileDir: string): void {
  const boundary = dirname(dirname(profileDir))
  assertPhysicalDirectory(boundary, 'Profile home boundary')
  assertPhysicalDirectory(dirname(profileDir), 'Profile collection boundary')
  assertPhysicalDirectory(profileDir, 'Profile directory')
}

function assertOptionalPhysicalDirectory(path: string, label: string): boolean {
  const stat = lstatIfPresent(path)
  if (stat === undefined) return false
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} is not a physical directory at ${path}`)
  return true
}

function assertOptionalPhysicalFile(path: string, label: string): boolean {
  const stat = lstatIfPresent(path)
  if (stat === undefined) return false
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} is not a physical file at ${path}`)
  return true
}

function assertPhysicalTree(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) fail(`managed source contains symbolic link ${path}`)
    if (entry.isDirectory()) assertPhysicalTree(path)
  }
}

function assertManagedPackage(root: string, name: string, allowMissingTargets = false): void {
  assertPhysicalDirectory(root, 'managed source root')
  const segments = packagePathSegments(name)
  if (segments.length === 2) assertPhysicalDirectory(join(root, segments[0]!), `managed scope ${segments[0]}`)
  const packageDir = join(root, ...segments)
  const packageStat = lstatIfPresent(packageDir)
  if (packageStat === undefined || packageStat.isSymbolicLink() || !packageStat.isDirectory()) {
    fail(`managed source ${JSON.stringify(name)} is missing or is not a physical directory at ${packageDir}`)
  }
  assertPhysicalTree(packageDir)
  const manifest = readManifest(join(packageDir, 'package.json'))
  if (manifest.name !== name) fail(`managed source ${JSON.stringify(name)} declares name ${JSON.stringify(manifest.name)}`)
  for (const { dependency, spec, optional } of localDependencySpecs(manifest)) {
    if (spec.startsWith('link:')) fail(`${name} dependency ${dependency} uses forbidden ${spec}`)
    // A managed source is relocated into the user Profile, so a spec only a
    // workspace can resolve would never install there. Fail at seed time, next
    // to the packaged source, instead of leaving pnpm to abort in a Profile.
    if (spec.startsWith('workspace:')) {
      fail(`${name} dependency ${dependency} uses forbidden ${spec}; declare a published version or a file: path`)
    }
    if (!spec.startsWith('file:')) continue
    const target = resolve(packageDir, spec.slice('file:'.length))
    assertContained(root, target, `${name} dependency ${dependency}`)
    const dependencySegments = packagePathSegments(dependency)
    if (target !== join(root, ...dependencySegments)) {
      fail(`${name} dependency ${dependency} does not point at its canonical managed source (${spec})`)
    }
    if (dependencySegments.length === 2) {
      const scope = join(root, dependencySegments[0]!)
      if (lstatIfPresent(scope) !== undefined) assertPhysicalDirectory(scope, `managed scope ${dependencySegments[0]}`)
    }
    const targetStat = lstatIfPresent(target)
    if (targetStat === undefined) {
      if (allowMissingTargets || optional) continue
      fail(`${name} dependency ${dependency} has incomplete local source ${spec}`)
    }
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      fail(`${name} dependency ${dependency} local source is not a physical directory ${spec}`)
    }
    if (!existsSync(join(target, 'package.json'))) fail(`${name} dependency ${dependency} has incomplete local source ${spec}`)
    const targetManifest = readManifest(join(target, 'package.json'))
    if (targetManifest.name !== dependency) {
      fail(`${name} dependency ${dependency} local source declares name ${JSON.stringify(targetManifest.name)}`)
    }
  }
}

function assertExistingManagedBoundary(profileDir: string): void {
  const snapshots = join(profileDir, '.materialize-snapshots')
  if (lstatIfPresent(snapshots) === undefined) return
  assertPhysicalDirectory(snapshots, 'materialize snapshot root')
  const plugins = managedSourceRoot(profileDir)
  if (lstatIfPresent(plugins) !== undefined) assertPhysicalDirectory(plugins, 'managed source root')
}

export function assertFreshManagedProfileDestination(profileDir: string, candidateDir: string): void {
  const home = dirname(dirname(profileDir))
  if (!assertOptionalPhysicalDirectory(home, 'Profile home boundary')) return
  if (!assertOptionalPhysicalDirectory(dirname(profileDir), 'Profile collection boundary')) return
  if (assertOptionalPhysicalDirectory(candidateDir, 'fresh Profile candidate')) assertPhysicalTree(candidateDir)
  if (!assertOptionalPhysicalDirectory(profileDir, 'Profile directory')) return
  for (const name of [
    'package.json',
    'cordis.patch.yml',
    'pnpm-workspace.yaml',
    '.omnimux-seed-version',
    '.omnimux-materialization-pending',
  ] as const) {
    assertOptionalPhysicalFile(join(profileDir, name), `Profile ${name}`)
  }
  const snapshots = join(profileDir, '.materialize-snapshots')
  if (!assertOptionalPhysicalDirectory(snapshots, 'materialize snapshot root')) return
  const root = managedSourceRoot(profileDir)
  if (!assertOptionalPhysicalDirectory(root, 'managed source root')) return
  assertPhysicalTree(root)
}

export function assertManagedSourceGraph(root: string, packageNames: readonly string[]): void {
  const unique = new Set<string>()
  for (const name of packageNames) {
    if (unique.has(name)) fail(`duplicate managed package ${JSON.stringify(name)}`)
    unique.add(name)
    assertManagedPackage(root, name)
  }
}

export function assertExistingManagedProfile(profileDir: string, ownedPackages: readonly string[]): void {
  assertPhysicalProfileBoundary(profileDir)
  assertExistingManagedBoundary(profileDir)
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) fail(`existing Profile is missing ${manifestPath}`)
  const manifest = readManifest(manifestPath)
  const dependencies = manifest.dependencies ?? {}
  for (const name of ownedPackages) {
    const expected = managedDependencySpec(name)
    if (dependencies[name] !== expected) {
      fail(`dependency ${JSON.stringify(name)} must be ${JSON.stringify(expected)}, found ${JSON.stringify(dependencies[name])}`)
    }
  }
  assertManagedSourceGraph(managedSourceRoot(profileDir), ownedPackages)
}

export function createFreshManagedSources(
  presetDir: string,
  profileDir: string,
  ownedPackages: readonly string[],
): void {
  assertPhysicalProfileBoundary(profileDir)
  const presetRoot = join(presetDir, 'plugins')
  assertManagedSourceGraph(presetRoot, ownedPackages)
  const destinationRoot = managedSourceRoot(profileDir)
  mkdirSync(destinationRoot, { recursive: true })
  for (const name of ownedPackages) {
    const destination = join(destinationRoot, ...packagePathSegments(name))
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(join(presetRoot, ...packagePathSegments(name)), destination, { recursive: true, dereference: true })
    prepareManagedPackage(destination, name)
  }
  setManagedDependencies(join(profileDir, 'package.json'), ownedPackages)
  ensureManagedBuildPolicy(profileDir, ownedPackages)
}

function setManagedDependencies(manifestPath: string, packageNames: readonly string[]): void {
  const manifest = readManifest(manifestPath)
  const dependencies = { ...manifest.dependencies }
  for (const name of packageNames) dependencies[name] = managedDependencySpec(name)
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, dependencies }, undefined, 2)}\n`)
}

/**
 * Remove dependency lines a rebuild deliberately dropped.
 *
 * A preset-era Profile declared every package it carried, including the ones the
 * staged preset no longer owns — the Alpha packages a production preset
 * excludes, for instance. The candidate manifest is copied from that Profile, so
 * those lines have to go before pnpm installs the candidate.
 */
function dropLegacyDependencies(manifestPath: string, packageNames: readonly string[]): void {
  if (packageNames.length === 0) return
  const manifest = readManifest(manifestPath)
  const dependencies = { ...manifest.dependencies }
  for (const name of packageNames) delete dependencies[name]
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, dependencies }, undefined, 2)}\n`)
}

function prepareManagedPackage(packageDir: string, name: string): void {
  normalizeAndValidateManagedBin(packageDir, name)
  if (name === 'node-pty') ensureReviewedNodePtyHelpers(packageDir)
}

function normalizeAndValidateManagedBin(packageDir: string, name: string): void {
  const manifestPath = join(packageDir, 'package.json')
  const manifest = readManifest(manifestPath)
  let bin = manifest.bin
  if (typeof bin === 'string') {
    if (bin === '') fail(`managed source ${JSON.stringify(name)} declares an empty bin target`)
    const command = packagePathSegments(name).at(-1)!
    bin = { [command]: bin }
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, bin }, undefined, 2)}\n`)
  }
  if (bin === undefined) return
  if (typeof bin !== 'object' || bin === null || Array.isArray(bin)) {
    fail(`managed source ${JSON.stringify(name)} declares an invalid bin mapping`)
  }
  for (const [command, target] of Object.entries(bin)) {
    if (typeof target !== 'string' || target === '' || target.includes('\0')) {
      fail(`managed source ${JSON.stringify(name)} declares an invalid bin target for ${JSON.stringify(command)}`)
    }
    const entry = resolve(packageDir, target)
    assertContained(packageDir, entry, `${name} bin ${command}`)
    const stat = lstatIfPresent(entry)
    if (stat === undefined || stat.isSymbolicLink() || !stat.isFile()) {
      fail(`managed source ${JSON.stringify(name)} bin ${JSON.stringify(command)} is missing or is not a physical file`)
    }
  }
}

function ensureReviewedNodePtyHelpers(packageDir: string): void {
  if (process.platform !== 'darwin') return
  const manifest = readManifest(join(packageDir, 'package.json'))
  if (manifest.version !== REVIEWED_NODE_PTY_VERSION) return
  for (const relativePath of NODE_PTY_DARWIN_HELPERS) {
    const helper = resolve(packageDir, relativePath)
    assertContained(packageDir, helper, `node-pty helper ${relativePath}`)
    const stat = lstatIfPresent(helper)
    if (stat === undefined || stat.isSymbolicLink() || !stat.isFile()) {
      fail(`managed node-pty helper is missing or is not a physical file: ${relativePath}`)
    }
    const mode = Number(stat.mode)
    if ((mode & 0o100) === 0) {
      chmodSync(helper, (mode & 0o777) | 0o111)
    }
  }
}

function ensureManagedBuildPolicy(profileDir: string, packageNames: readonly string[]): void {
  if (!packageNames.includes('node-pty')) return
  const sourceManifest = readManifest(manifestAt(managedSourceRoot(profileDir), 'node-pty'))
  if (sourceManifest.version !== REVIEWED_NODE_PTY_VERSION) {
    fail(
      `node-pty managed source version ${JSON.stringify(sourceManifest.version)} has no reviewed build approval `
      + `(expected ${REVIEWED_NODE_PTY_VERSION})`,
    )
  }
  const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
  const document = parseDocument(readFileSync(workspacePath, 'utf8'), { prettyErrors: true })
  if (document.errors.length > 0) {
    fail(`Profile pnpm workspace policy is invalid (${document.errors.map(error => error.message).join('; ')})`)
  }
  const workspace: unknown = document.toJS()
  if (typeof workspace !== 'object' || workspace === null || Array.isArray(workspace)) {
    fail('Profile pnpm workspace policy must be a mapping')
  }
  const currentPolicy = (workspace as Record<string, unknown>).allowBuilds
  if (
    currentPolicy !== undefined
    && (typeof currentPolicy !== 'object' || currentPolicy === null || Array.isArray(currentPolicy))
  ) {
    fail('Profile allowBuilds policy must be a mapping')
  }
  const allowBuilds = (currentPolicy ?? {}) as Record<string, unknown>
  const managedFileRule = `node-pty@file:${MANAGED_SOURCE_DIRECTORY}/node-pty`
  const reviewedRules = [`node-pty@${REVIEWED_NODE_PTY_VERSION}`, managedFileRule] as const
  const deniedRules = Object.entries(allowBuilds)
    .filter(([rule, value]) => deniesReviewedNodePtyBuild(rule, value, managedFileRule))
    .map(([rule]) => rule)
  if (deniedRules.length > 0) {
    fail(`Profile build policy explicitly denies required node-pty lifecycle scripts (${deniedRules.join(', ')})`)
  }
  let changed = false
  for (const rule of reviewedRules) {
    const value = allowBuilds[rule]
    if (value === undefined || value === PNPM_BUILD_REVIEW_PENDING) {
      document.setIn(['allowBuilds', rule], true)
      changed = true
    } else if (value !== true) {
      fail(`Profile build policy for ${rule} must be true or false`)
    }
  }
  if (changed) writeFileSync(workspacePath, document.toString())
}

function deniesReviewedNodePtyBuild(rule: string, value: unknown, managedFileRule: string): boolean {
  if (value !== false) return false
  if (rule === 'node-pty' || rule === managedFileRule) return true
  if (!rule.startsWith('node-pty@')) return false
  const exactVersions = rule.slice('node-pty@'.length).split('||').map(version => valid(version))
  return exactVersions.every(version => version !== null)
    && exactVersions.includes(REVIEWED_NODE_PTY_VERSION)
}

function managedNameFromSpec(spec: string): string | undefined {
  const prefix = `file:${MANAGED_SOURCE_DIRECTORY}/`
  return spec.startsWith(prefix) ? spec.slice(prefix.length) : undefined
}

function chooseRebuildSources(
  profileDir: string,
  presetDir: string,
  ownedPackages: readonly string[],
): { readonly names: string[]; readonly sources: Map<string, string>; readonly preserved: string[]; readonly dropped: string[] } {
  const manifest = readManifest(join(profileDir, 'package.json'))
  const dependencies = manifest.dependencies ?? {}
  const presetRoot = join(presetDir, 'plugins')
  assertManagedSourceGraph(presetRoot, ownedPackages)
  const existingRoot = managedSourceRoot(profileDir)
  assertExistingManagedBoundary(profileDir)
  const names = [...ownedPackages]
  const dropped: string[] = []
  for (const [name, spec] of Object.entries(dependencies)) {
    if (ownedPackages.includes(name)) continue
    if (spec.startsWith('link:')) {
      fail(`non-candidate dependency ${JSON.stringify(name)} has unsupported source ${JSON.stringify(spec)}`)
    }
    if (LEGACY_PROFILE_LOCAL_SPEC.test(spec)) {
      // A Profile seeded before the managed model kept every package as its own
      // `file:./node_modules/<name>` copy. The staged preset owns the
      // composition now, so a dependency it does not own — an Alpha package the
      // production preset excludes, for instance — is dropped rather than
      // blocking the rebuild.
      dropped.push(name)
      continue
    }
    const managedName = managedNameFromSpec(spec)
    if (managedName === undefined) {
      if (spec.startsWith('file:')) fail(`non-candidate dependency ${JSON.stringify(name)} has non-managed file source ${JSON.stringify(spec)}`)
      continue
    }
    if (managedName !== name) fail(`dependency ${JSON.stringify(name)} points at managed source ${JSON.stringify(managedName)}`)
    names.push(name)
  }
  const sources = new Map<string, string>()
  const preserved: string[] = []
  for (const name of names) {
    const segments = packagePathSegments(name)
    if (segments.length === 2) {
      const scope = join(existingRoot, segments[0]!)
      if (lstatIfPresent(scope) !== undefined) assertPhysicalDirectory(scope, `managed scope ${segments[0]}`)
    }
    const existing = join(existingRoot, ...segments)
    const existingStat = lstatIfPresent(existing)
    if (existingStat !== undefined) {
      assertManagedPackage(existingRoot, name, true)
      sources.set(name, existing)
      preserved.push(name)
      continue
    }
    if (!ownedPackages.includes(name)) fail(`non-candidate managed source ${JSON.stringify(name)} is missing`)
    sources.set(name, join(presetRoot, ...packagePathSegments(name)))
  }
  return { names, sources, preserved, dropped }
}

function copyRebuildCandidate(
  profileDir: string,
  candidateDir: string,
  packageNames: readonly string[],
  sources: ReadonlyMap<string, string>,
  droppedLegacyNames: readonly string[],
): void {
  mkdirSync(candidateDir, { recursive: true })
  for (const name of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'] as const) {
    const source = join(profileDir, name)
    const sourceStat = lstatIfPresent(source)
    if (name !== 'pnpm-lock.yaml' && sourceStat === undefined) fail(`Profile is missing ${name}`)
    if (sourceStat !== undefined) {
      if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) fail(`Profile ${name} is not a physical file`)
      cpSync(source, join(candidateDir, name))
    }
  }
  const graphEntries = new Set<string>(GRAPH_ENTRIES)
  for (const entry of readdirSync(profileDir, { withFileTypes: true })) {
    if (graphEntries.has(entry.name) || entry.name === '.dsh-module-fallback') continue
    const source = join(profileDir, entry.name)
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      fail(`Profile installation sidecar is not a physical file or directory at ${source}`)
    }
    if (entry.isDirectory()) assertPhysicalTree(source)
    cpSync(source, join(candidateDir, entry.name), { recursive: entry.isDirectory(), dereference: false })
  }
  const currentSnapshots = join(profileDir, '.materialize-snapshots')
  const currentSnapshotsStat = lstatIfPresent(currentSnapshots)
  const candidateSnapshots = join(candidateDir, '.materialize-snapshots')
  mkdirSync(candidateSnapshots)
  if (currentSnapshotsStat !== undefined) {
    assertPhysicalDirectory(currentSnapshots, 'materialize snapshot root')
    assertPhysicalTree(currentSnapshots)
    for (const entry of readdirSync(currentSnapshots, { withFileTypes: true })) {
      if (entry.name === 'plugins') continue
      cpSync(join(currentSnapshots, entry.name), join(candidateSnapshots, entry.name), {
        recursive: entry.isDirectory(),
        dereference: false,
      })
    }
  }
  const root = managedSourceRoot(candidateDir)
  mkdirSync(root, { recursive: true })
  for (const name of packageNames) {
    const source = sources.get(name)
    if (source === undefined) fail(`no authoritative source selected for ${name}`)
    const destination = join(root, ...packagePathSegments(name))
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(source, destination, { recursive: true, dereference: true })
    prepareManagedPackage(destination, name)
  }
  setManagedDependencies(join(candidateDir, 'package.json'), packageNames)
  dropLegacyDependencies(join(candidateDir, 'package.json'), droppedLegacyNames)
  ensureManagedBuildPolicy(candidateDir, packageNames)
  assertManagedSourceGraph(root, packageNames)
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function hashDirectory(root: string): string {
  const hash = createHash('sha256')
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name)
      const name = relative(root, path).split(sep).join('/')
      if (entry.isSymbolicLink()) fail(`managed source contains symbolic link ${path}`)
      hash.update(`${entry.isDirectory() ? 'd' : 'f'}:${name}\0`)
      if (entry.isDirectory()) visit(path)
      else hash.update(readFileSync(path))
    }
  }
  visit(root)
  return hash.digest('hex')
}

function assertInstalledGraph(
  profileDir: string,
  packageNames: readonly string[],
  packedFiles: ReadonlyMap<string, readonly string[]>,
): void {
  const sourceRoot = managedSourceRoot(profileDir)
  assertManagedSourceGraph(sourceRoot, packageNames)
  const installedRoot = realpathSync(join(profileDir, 'node_modules'))
  const requireInstalled = createRequire(join(profileDir, 'package.json')).resolve
  const runtimePackages = packageNames.filter(name => declaresRuntimeEntry(readManifest(manifestAt(sourceRoot, name))))
  const runtimeEntries = resolveImportEntries(profileDir, runtimePackages)
  for (const name of packageNames) {
    const installedManifest = join(profileDir, 'node_modules', ...packagePathSegments(name), 'package.json')
    if (!existsSync(installedManifest)) fail(`pnpm did not install ${JSON.stringify(name)}`)
    const installed = readManifest(installedManifest)
    const source = readManifest(manifestAt(sourceRoot, name))
    assertContained(installedRoot, realpathSync(installedManifest), `installed manifest for ${name}`)
    if (installed.name !== name || installed.version !== source.version) {
      fail(`installed ${JSON.stringify(name)} does not match its managed source`)
    }
    const expectedFiles = packedFiles.get(name)
    if (expectedFiles === undefined) fail(`packed file list is missing for ${JSON.stringify(name)}`)
    assertInstalledContent(join(sourceRoot, ...packagePathSegments(name)), dirname(installedManifest), expectedFiles)
    if (name === 'node-pty') assertInstalledNodePtyHelpers(dirname(installedManifest))
    if (!hasRootExports(source) && typeof source.main === 'string' && source.main !== '') {
      const mainRequest = resolve(dirname(installedManifest), source.main)
      let mainEntry: string
      try {
        mainEntry = createRequire(join(profileDir, 'package.json')).resolve(mainRequest)
      } catch (entryCause) {
        fail(`installed ${JSON.stringify(name)} declared main is not resolvable (${String(entryCause)})`)
      }
      assertContained(installedRoot, realpathSync(mainEntry), `installed declared main for ${name}`)
    }
    const importResolution = runtimeEntries.get(name)
    if (importResolution?.entry !== undefined) {
      let physicalEntry: string
      try {
        physicalEntry = realpathSync(fileURLToPath(importResolution.entry))
      } catch (entryCause) {
        fail(`installed ${JSON.stringify(name)} runtime entry is missing (${String(entryCause)})`)
      }
      assertContained(installedRoot, physicalEntry, `installed runtime entry for ${name}`)
    } else if (importResolution !== undefined) {
      let requireEntry: string
      try {
        requireEntry = requireInstalled(name)
      } catch (entryCause) {
        fail(
          `installed ${JSON.stringify(name)} runtime entry is neither import- nor require-resolvable `
          + `(${importResolution.error ?? 'unknown import error'}; ${String(entryCause)})`,
        )
      }
      assertContained(installedRoot, realpathSync(requireEntry), `installed runtime entry for ${name}`)
    }
  }
}

function assertInstalledNodePtyHelpers(packageDir: string): void {
  if (process.platform !== 'darwin') return
  for (const relativePath of NODE_PTY_DARWIN_HELPERS) {
    const helper = resolve(packageDir, relativePath)
    assertContained(packageDir, helper, `installed node-pty helper ${relativePath}`)
    const stat = lstatIfPresent(helper)
    if (stat === undefined || stat.isSymbolicLink() || !stat.isFile() || (Number(stat.mode) & 0o100) === 0) {
      fail(`installed node-pty helper is missing, unsafe, or not executable: ${relativePath}`)
    }
  }
}

function declaresRuntimeEntry(manifest: PackageManifest): boolean {
  const rootExport = rootExportTarget(manifest.exports)
  if (rootExport.present) return hasRuntimeExportTarget(rootExport.value)
  return typeof manifest.main === 'string' && manifest.main !== ''
}

function hasRootExports(manifest: PackageManifest): boolean {
  return rootExportTarget(manifest.exports).present
}

function rootExportTarget(exports: unknown): { readonly present: boolean; readonly value?: unknown } {
  if (typeof exports === 'string' || Array.isArray(exports)) return { present: true, value: exports }
  if (typeof exports !== 'object' || exports === null) return { present: false }
  const entries = Object.entries(exports)
  if (Object.hasOwn(exports, '.')) return { present: true, value: (exports as Record<string, unknown>)['.'] }
  return entries.length > 0 && entries.every(([key]) => !key.startsWith('.'))
    ? { present: true, value: exports }
    : { present: false }
}

function hasRuntimeExportTarget(target: unknown): boolean {
  if (typeof target === 'string') return true
  if (Array.isArray(target)) return target.some(hasRuntimeExportTarget)
  if (typeof target !== 'object' || target === null) return false
  return Object.entries(target).some(([condition, value]) => condition !== 'types' && hasRuntimeExportTarget(value))
}

function resolveImportEntries(profileDir: string, names: readonly string[]): ReadonlyMap<string, RuntimeResolution> {
  if (names.length === 0) return new Map()
  const script = [
    'const names = JSON.parse(process.argv[1])',
    'const entries = Object.fromEntries(names.map(name => {',
    'try { return [name, { entry: import.meta.resolve(name) }] }',
    'catch (cause) { return [name, { error: String(cause?.code ?? cause) }] }',
    '}))',
    'process.stdout.write(JSON.stringify(entries))',
  ].join('\n')
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script, JSON.stringify(names)], {
    cwd: profileDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (result.status !== 0) {
    fail(`installed runtime entries are not import-resolvable (${result.stderr || result.stdout || String(result.error)})`)
  }
  let entries: unknown
  try {
    entries = JSON.parse(result.stdout)
  } catch (cause) {
    fail(`runtime entry resolver returned invalid output (${String(cause)})`)
  }
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    fail('runtime entry resolver returned an invalid result')
  }
  const resolved = new Map<string, RuntimeResolution>()
  for (const name of names) {
    const resolution = (entries as Record<string, unknown>)[name]
    if (typeof resolution !== 'object' || resolution === null || Array.isArray(resolution)) {
      fail(`installed ${JSON.stringify(name)} runtime resolution is invalid`)
    }
    const { entry, error } = resolution as Record<string, unknown>
    if (entry !== undefined && (typeof entry !== 'string' || !entry.startsWith('file:'))) {
      fail(`installed ${JSON.stringify(name)} runtime entry is not a file URL`)
    }
    if (error !== undefined && typeof error !== 'string') fail(`installed ${JSON.stringify(name)} runtime error is invalid`)
    if (entry === undefined && typeof error !== 'string') fail(`installed ${JSON.stringify(name)} runtime resolution is empty`)
    resolved.set(name, { ...(entry === undefined ? {} : { entry }), ...(error === undefined ? {} : { error }) })
  }
  return resolved
}

function assertInstalledContent(
  sourceRoot: string,
  installedRoot: string,
  packedFiles: readonly string[],
): void {
  if (!packedFiles.includes('package.json')) fail(`pnpm pack list omitted package.json for ${sourceRoot}`)
  for (const file of packedFiles) {
    if (file === '' || isAbsolute(file) || file.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
      fail(`pnpm returned unsafe packed file ${JSON.stringify(file)} for ${sourceRoot}`)
    }
    const source = join(sourceRoot, ...file.split('/'))
    const installed = join(installedRoot, ...file.split('/'))
    if (!existsSync(source) || !statSync(source).isFile()) fail(`packed source file is missing ${source}`)
    // pnpm may normalize publish-only manifest fields. Identity was checked
    // above; byte-for-byte verification applies to the actual package payload.
    if (file === 'package.json') continue
    if (!existsSync(installed) || !statSync(installed).isFile() || !readFileSync(installed).equals(readFileSync(source))) {
      fail(`installed content differs from packed managed source file ${file}`)
    }
  }
}

function commitCandidateGraph(
  profileDir: string,
  candidateDir: string,
  rename: (source: string, destination: string) => void,
  verify: () => void,
): void {
  const parent = dirname(profileDir)
  const backupDir = join(parent, `.omnimux-profile-backup-${basename(profileDir)}-${randomUUID()}`)
  mkdirSync(backupDir)
  const backedUp: string[] = []
  const installed: string[] = []
  try {
    for (const name of GRAPH_ENTRIES) {
      const active = join(profileDir, name)
      if (!existsSync(active)) continue
      rename(active, join(backupDir, name))
      backedUp.push(name)
    }
    for (const name of GRAPH_ENTRIES) {
      const candidate = join(candidateDir, name)
      if (!existsSync(candidate)) fail(`rebuilt candidate is missing ${name}`)
      rename(candidate, join(profileDir, name))
      installed.push(name)
    }
    verify()
  } catch (cause) {
    let rollbackFailure: unknown
    try {
      for (const name of installed.reverse()) rmSync(join(profileDir, name), { recursive: true, force: true })
      for (const name of backedUp.reverse()) rename(join(backupDir, name), join(profileDir, name))
    } catch (rollbackCause) {
      rollbackFailure = rollbackCause
    }
    if (rollbackFailure !== undefined) {
      throw new Error(`Profile graph commit failed (${String(cause)}); rollback failed (${String(rollbackFailure)}); backup retained at ${backupDir}`)
    }
    rmSync(backupDir, { recursive: true, force: true })
    throw cause
  }
  rmSync(backupDir, { recursive: true, force: true })
}

export async function rebuildManagedProfile(options: ManagedProfileRebuildOptions): Promise<ManagedProfileRebuildResult> {
  const profileDir = resolve(options.profileDir)
  const presetDir = resolve(options.presetDir)
  assertPhysicalProfileBoundary(profileDir)
  if (!existsSync(join(profileDir, 'package.json'))) fail(`Profile does not exist at ${profileDir}`)
  const plan = chooseRebuildSources(profileDir, presetDir, options.ownedPackages)
  const candidateDir = join(dirname(profileDir), `.omnimux-profile-candidate-${basename(profileDir)}-${randomUUID()}`)
  try {
    copyRebuildCandidate(profileDir, candidateDir, plan.names, plan.sources, plan.dropped)
    const packedFiles = new Map<string, readonly string[]>()
    for (const name of plan.names) {
      packedFiles.set(name, await options.packedFiles(managedSourcePath(candidateDir, name)))
    }
    await options.materialize(candidateDir)
    assertInstalledGraph(candidateDir, plan.names, packedFiles)
    const sourceHash = hashDirectory(managedSourceRoot(candidateDir))
    const manifestHash = hashFile(join(candidateDir, 'package.json'))
    commitCandidateGraph(profileDir, candidateDir, options.rename ?? renameSync, () => {
      assertExistingManagedProfile(profileDir, plan.names)
      assertInstalledGraph(profileDir, plan.names, packedFiles)
      if (hashDirectory(managedSourceRoot(profileDir)) !== sourceHash) fail('published managed source hash changed')
      if (hashFile(join(profileDir, 'package.json')) !== manifestHash) fail('published Profile manifest hash changed')
    })
    return {
      profileDir,
      packageCount: plan.names.length,
      preservedManagedSources: plan.preserved,
      droppedLegacySources: plan.dropped,
      sourceHash,
      manifestHash,
    }
  } finally {
    rmSync(candidateDir, { recursive: true, force: true })
  }
}
