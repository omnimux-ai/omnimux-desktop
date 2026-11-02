#!/usr/bin/env node
/** Verify a staged OmniMux preset — or an installed Profile — against its own distribution record. */

import { existsSync, readFileSync, lstatSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashDirectory } from '../src/managed-profile.ts'
import {
  DISTRIBUTION_FILENAME,
  SKILLS_DIRNAME,
  SKILL_ORIGIN_FILENAME,
  listPackageNames,
  listStagedSkills,
  packageDirSegments,
} from '../src/preset-profile.ts'

/** One recorded preinstalled entry. Unknown shapes are rejected, not ignored. */
interface DistributionItem {
  readonly kind: 'plugin' | 'skill'
  readonly id: string
  readonly tier: 'core' | 'product' | 'beta'
  readonly version: string | null
  readonly digest: string
  /** Skill only: the product surface the skill came from. */
  readonly origin?: string
}

/** A staged preset's account of what it ships. */
interface DistributionManifest {
  readonly schema: number
  readonly channel: string
  readonly items: readonly DistributionItem[]
}

/** Inputs for {@link verifyDistribution}. */
export interface VerifyDistributionOptions {
  /** A staged preset directory (`preset/`) that carries its own record. */
  readonly presetDir?: string
  /** An installed Profile directory, verified against `manifestPath`. */
  readonly profileDir?: string
  /** Explicit record path; required for a Profile, optional for a preset. */
  readonly manifestPath?: string
  /** Profile only: fail when an installed package is absent from the record. */
  readonly strict?: boolean
}

/** What one verification pass proved. */
export interface VerifyDistributionResult {
  readonly target: 'preset' | 'profile'
  readonly directory: string
  readonly channel: string
  readonly verified: number
  /** Installed but unrecorded packages (Profile mode reports these). */
  readonly extra: readonly string[]
}

const SNAPSHOT_DIRECTORY = '.materialize-snapshots/plugins'

function fail(message: string): never {
  throw new Error(`verify-distribution: ${message}`)
}

function readJson(path: string, label: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`${label} is unreadable (${path}): ${String(error)}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be an object: ${path}`)
  }
  return value as Record<string, unknown>
}

/**
 * Read and validate one distribution record.
 *
 * A record that cannot be trusted is worse than no record: every later check
 * would compare the artifact against a guess, so the shape is verified first.
 * @param path - Absolute path to `distribution.json`.
 */
export function readDistribution(path: string): DistributionManifest {
  const value = readJson(path, 'distribution record')
  if (value.schema !== 1) fail(`unsupported distribution schema ${JSON.stringify(value.schema)}: ${path}`)
  if (typeof value.channel !== 'string' || value.channel === '') {
    fail(`distribution channel must be a non-empty string: ${path}`)
  }
  if (!Array.isArray(value.items) || value.items.length === 0) {
    fail(`distribution items must be a non-empty array: ${path}`)
  }
  const seen = new Set<string>()
  const items = value.items.map((entry, index): DistributionItem => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail(`distribution item ${String(index)} must be an object: ${path}`)
    }
    const item = entry as Record<string, unknown>
    if (item.kind !== 'plugin' && item.kind !== 'skill') {
      fail(`distribution item ${String(index)} has unsupported kind ${JSON.stringify(item.kind)}`)
    }
    if (typeof item.id !== 'string' || item.id === '') fail(`distribution item ${String(index)} needs an id`)
    if (item.kind === 'skill') {
      if (typeof item.origin !== 'string' || item.origin === '') {
        fail(`distribution skill ${item.id} has invalid origin ${JSON.stringify(item.origin)}`)
      }
      if (item.version !== null) fail(`distribution skill ${item.id} must not carry a version`)
    }
    if (item.tier !== 'core' && item.tier !== 'product' && item.tier !== 'beta') {
      fail(`distribution item ${item.id} has invalid tier ${JSON.stringify(item.tier)}`)
    }
    if (item.version !== null && typeof item.version !== 'string') {
      fail(`distribution item ${item.id} has invalid version ${JSON.stringify(item.version)}`)
    }
    if (typeof item.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(item.digest)) {
      fail(`distribution item ${item.id} has invalid digest ${JSON.stringify(item.digest)}`)
    }
    if (seen.has(item.id)) fail(`distribution record lists ${JSON.stringify(item.id)} twice`)
    seen.add(item.id)
    return item as unknown as DistributionItem
  })
  return { schema: 1, channel: value.channel, items }
}

/** True when `target` stays inside `root`, comparing resolved path segments. */
function isInside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/**
 * Reject a manifest the relocated preset could not install from.
 *
 * The producer already normalizes manifests; this reads the artifact back so a
 * later packaging step (or a hand-edited tree) cannot reintroduce a spec that
 * only the build checkout can resolve.
 */
function assertManifestsRelocatable(pluginsDir: string, names: readonly string[]): void {
  for (const name of names) {
    const packageDir = join(pluginsDir, ...packageDirSegments(name))
    const manifestPath = join(packageDir, 'package.json')
    if (!existsSync(manifestPath)) fail(`recorded package ${name} has no manifest: ${manifestPath}`)
    const manifest = readJson(manifestPath, `manifest for ${name}`)
    const optionalDependencies = (manifest.optionalDependencies ?? {}) as Record<string, string>
    for (const field of ['dependencies', 'optionalDependencies'] as const) {
      const dependencyMap = manifest[field]
      if (dependencyMap === undefined) continue
      if (typeof dependencyMap !== 'object' || dependencyMap === null || Array.isArray(dependencyMap)) {
        fail(`${name} ${field} must be an object`)
      }
      for (const [dependency, spec] of Object.entries(dependencyMap as Record<string, string>)) {
        if (field === 'dependencies' && Object.hasOwn(optionalDependencies, dependency)) continue
        if (typeof spec !== 'string') fail(`${name} dependency ${dependency} has a non-string spec`)
        if (spec.startsWith('workspace:') || spec.startsWith('link:')) {
          fail(`${name} dependency ${dependency} uses ${spec}, which cannot resolve inside a relocated preset`)
        }
        if (!spec.startsWith('file:')) continue
        const target = resolve(packageDir, spec.slice('file:'.length))
        if (!isInside(pluginsDir, target)) {
          fail(`${name} dependency ${dependency} escapes the preset (${spec})`)
        }
        if (field === 'optionalDependencies' && !existsSync(target)) continue
        if (!existsSync(join(target, 'package.json'))) {
          fail(`${name} dependency ${dependency} has no source at ${spec}`)
        }
      }
    }
  }
}

/** Compare one installed package directory against its recorded digest. */
function assertRecordedBytes(packageDir: string, item: DistributionItem): void {
  const stat = lstatSync(packageDir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`${item.id} is not a physical directory: ${packageDir}`)
  }
  const manifest = readJson(join(packageDir, 'package.json'), `manifest for ${item.id}`)
  if (typeof manifest.name !== 'string' || manifest.name !== item.id) {
    fail(`${item.id} declares name ${JSON.stringify(manifest.name)}`)
  }
  if (item.version !== null && manifest.version !== item.version) {
    fail(`${item.id} is version ${JSON.stringify(manifest.version)}, the record says ${JSON.stringify(item.version)}`)
  }
  const digest = hashDirectory(packageDir)
  if (digest !== item.digest) {
    fail(`${item.id} digest is ${digest}, the record says ${item.digest}`)
  }
}

/**
 * Compare one seeded skill directory against its recorded digest.
 *
 * The origin marker is checked as well: it is what lets a later seed tell this
 * product's copy from a skill the user authored under the same name.
 */
function assertRecordedSkill(skillDir: string, item: DistributionItem): void {
  if (!existsSync(skillDir)) fail(`skill ${item.id} has no directory: ${skillDir}`)
  const stat = lstatSync(skillDir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`skill ${item.id} is not a physical directory: ${skillDir}`)
  }
  if (!existsSync(join(skillDir, 'SKILL.md'))) fail(`skill ${item.id} has no SKILL.md: ${skillDir}`)
  const marker = readJson(join(skillDir, SKILL_ORIGIN_FILENAME), `origin marker for ${item.id}`)
  if (marker.id !== item.id) fail(`skill ${item.id} marker names ${JSON.stringify(marker.id)}`)
  if (item.origin !== undefined && marker.origin !== item.origin) {
    fail(`skill ${item.id} origin is ${JSON.stringify(marker.origin)}, the record says ${JSON.stringify(item.origin)}`)
  }
  const digest = hashDirectory(skillDir)
  if (digest !== item.digest) {
    fail(`skill ${item.id} digest is ${digest}, the record says ${item.digest}`)
  }
}

/** Compare installed names against recorded names and report both directions. */
function partitionInstalled(
  installed: readonly string[],
  items: readonly DistributionItem[],
): { readonly missing: string[]; readonly extra: string[] } {
  const recorded = new Set(items.map(item => item.id))
  const present = new Set(installed)
  return {
    missing: items.map(item => item.id).filter(id => !present.has(id)),
    extra: installed.filter(id => !recorded.has(id)),
  }
}

/**
 * Verify a staged preset against the record it ships.
 * @param presetDir - The `preset/` directory produced by `stage-preset-profile`.
 * @param manifestPath - Record to compare against; defaults to the preset's own.
 */
export function verifyPreset(presetDir: string, manifestPath?: string): VerifyDistributionResult {
  const recordPath = manifestPath ?? join(presetDir, DISTRIBUTION_FILENAME)
  if (!existsSync(recordPath)) {
    fail(`no distribution record at ${recordPath}; stage the preset with stage-preset-profile first`)
  }
  const manifest = readDistribution(recordPath)
  const pluginsDir = join(presetDir, 'plugins')
  if (!existsSync(pluginsDir)) fail(`staged preset has no plugins directory: ${pluginsDir}`)
  const plugins = manifest.items.filter(item => item.kind === 'plugin')
  const skills = manifest.items.filter(item => item.kind === 'skill')
  const installed = listPackageNames(pluginsDir)
  const { missing, extra } = partitionInstalled(installed, plugins)
  if (missing.length > 0) fail(`preset is missing ${String(missing.length)} recorded package(s): ${missing.join(', ')}`)
  if (extra.length > 0) fail(`preset ships ${String(extra.length)} package(s) the record does not list: ${extra.join(', ')}`)

  const ownedPath = join(presetDir, 'owned-packages.json')
  if (!existsSync(ownedPath)) fail(`staged preset has no owned-packages.json: ${ownedPath}`)
  const owned = JSON.parse(readFileSync(ownedPath, 'utf8')) as unknown
  if (!Array.isArray(owned) || owned.some(name => typeof name !== 'string')) {
    fail(`owned-packages.json must be an array of names: ${ownedPath}`)
  }
  const ownedSet = new Set(owned as string[])
  if (ownedSet.size !== installed.length || installed.some(name => !ownedSet.has(name))) {
    fail(`owned-packages.json and preset/plugins disagree: ${ownedPath}`)
  }

  for (const item of plugins) assertRecordedBytes(join(pluginsDir, ...packageDirSegments(item.id)), item)
  assertManifestsRelocatable(pluginsDir, installed)

  const stagedSkills = listStagedSkills(presetDir)
  const recordedSkillIds = skills.map(item => item.id)
  const missingSkills = recordedSkillIds.filter(id => !stagedSkills.includes(id))
  const extraSkills = stagedSkills.filter(id => !recordedSkillIds.includes(id))
  if (missingSkills.length > 0) {
    fail(`preset is missing ${String(missingSkills.length)} recorded skill(s): ${missingSkills.join(', ')}`)
  }
  if (extraSkills.length > 0) {
    fail(`preset stages ${String(extraSkills.length)} skill(s) the record does not list: ${extraSkills.join(', ')}`)
  }
  for (const item of skills) assertRecordedSkill(join(presetDir, SKILLS_DIRNAME, item.id), item)

  return { target: 'preset', directory: presetDir, channel: manifest.channel, verified: manifest.items.length, extra: [] }
}

/**
 * Verify an installed Profile against a distributed record.
 *
 * A Profile may legitimately hold more than one record: development syncs add
 * product plugins a given app build never staged. Recorded packages must be
 * present at the recorded bytes; unrecorded ones are reported, and only
 * `strict` turns them into a failure.
 * @param profileDir - The Profile directory to inspect.
 * @param manifestPath - Record to compare against.
 * @param strict - Fail on packages the record does not list.
 */
export function verifyProfile(profileDir: string, manifestPath: string, strict = false): VerifyDistributionResult {
  const manifest = readDistribution(manifestPath)
  const plugins = manifest.items.filter(item => item.kind === 'plugin')
  const skills = manifest.items.filter(item => item.kind === 'skill')
  const snapshots = join(profileDir, SNAPSHOT_DIRECTORY)
  if (!existsSync(snapshots)) fail(`Profile has no managed source root: ${snapshots}`)
  const installed = listPackageNames(snapshots)
  const { missing, extra } = partitionInstalled(installed, plugins)
  if (missing.length > 0) fail(`Profile is missing ${String(missing.length)} recorded package(s): ${missing.join(', ')}`)
  if (strict && extra.length > 0) {
    fail(`Profile holds ${String(extra.length)} package(s) the record does not list: ${extra.join(', ')}`)
  }

  const profileManifest = readJson(join(profileDir, 'package.json'), 'Profile manifest')
  const dependencies = (profileManifest.dependencies ?? {}) as Record<string, string>
  for (const item of plugins) {
    const expected = `file:${SNAPSHOT_DIRECTORY}/${item.id}`
    if (dependencies[item.id] !== expected) {
      fail(`Profile dependency ${item.id} must be ${expected}, found ${JSON.stringify(dependencies[item.id])}`)
    }
  }

  for (const item of plugins) assertRecordedBytes(join(snapshots, ...packageDirSegments(item.id)), item)
  assertManifestsRelocatable(snapshots, installed)

  // Skills live in the Harness Home beside `profiles/`, not inside one Profile:
  // that is the root the skill provider discovers.
  const skillRoot = join(dirname(dirname(resolve(profileDir))), SKILLS_DIRNAME)
  const installedSkills = listStagedSkills(dirname(skillRoot))
  const recordedSkillIds = skills.map(item => item.id)
  const missingSkills = recordedSkillIds.filter(id => !installedSkills.includes(id))
  if (missingSkills.length > 0) {
    fail(`Harness Home is missing ${String(missingSkills.length)} recorded skill(s): ${missingSkills.join(', ')}`)
  }
  for (const item of skills) assertRecordedSkill(join(skillRoot, item.id), item)

  const unrecordedSkills = installedSkills.filter(id => !recordedSkillIds.includes(id))
  return {
    target: 'profile',
    directory: profileDir,
    channel: manifest.channel,
    verified: manifest.items.length,
    extra: [...extra, ...unrecordedSkills],
  }
}

/**
 * Verify whichever target the options name.
 * @param options - Preset or Profile plus an optional explicit record.
 */
export function verifyDistribution(options: VerifyDistributionOptions): VerifyDistributionResult {
  const targets = [options.presetDir, options.profileDir].filter(value => value !== undefined)
  if (targets.length !== 1) fail('pass exactly one of --preset or --profile')
  if (options.presetDir !== undefined) return verifyPreset(resolve(options.presetDir), options.manifestPath)
  if (options.manifestPath === undefined) fail('--profile requires --expect <distribution.json>')
  return verifyProfile(resolve(options.profileDir!), resolve(options.manifestPath), options.strict === true)
}

/** Parse the CLI arguments; unknown flags fail rather than being ignored. */
export function parseArguments(argv: readonly string[]): VerifyDistributionOptions {
  let presetDir: string | undefined
  let profileDir: string | undefined
  let manifestPath: string | undefined
  let strict = false
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--strict') {
      strict = true
      continue
    }
    if (flag !== '--preset' && flag !== '--profile' && flag !== '--expect') {
      fail(`unknown argument ${JSON.stringify(flag)}; usage: verify-distribution.ts (--preset|--profile) <dir> [--expect <distribution.json>] [--strict]`)
    }
    if (value === undefined || value.startsWith('--')) fail(`${flag} needs a value`)
    if (flag === '--preset') presetDir = value
    else if (flag === '--profile') profileDir = value
    else manifestPath = value
    index += 1
  }
  if ((presetDir === undefined) === (profileDir === undefined)) {
    fail('usage: verify-distribution.ts (--preset|--profile) <dir> [--expect <distribution.json>] [--strict]')
  }
  return { ...(presetDir === undefined ? {} : { presetDir }), ...(profileDir === undefined ? {} : { profileDir }), ...(manifestPath === undefined ? {} : { manifestPath }), strict }
}

function main(): void {
  const result = verifyDistribution(parseArguments(process.argv.slice(2)))
  const extras = result.extra.length === 0 ? '' : ` (${String(result.extra.length)} unrecorded: ${result.extra.join(', ')})`
  process.stdout.write(
    `verified ${String(result.verified)} ${result.target} package(s) against ${result.channel}${extras} in ${result.directory}\n`,
  )
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
