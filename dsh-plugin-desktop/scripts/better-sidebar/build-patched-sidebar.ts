import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BETTER_SIDEBAR_VERSION = '0.28.1'
export const BETTER_SIDEBAR_COMMIT = '59131330bb837cf48dc4117b17c091998b595df0'
export const BETTER_SIDEBAR_REPOSITORY = 'https://github.com/omdsh-dev/DSH-better-sidebar.git'
export const BETTER_SIDEBAR_PNPM_VERSION = '11.8.0'
export const BETTER_SIDEBAR_LOCK_SHA256 = 'd45f33d5e4adb0148210366de2ff800db1f14ef9196ef44643b53f11977cefb9'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// Upgrade and failure-handling contract: docs/contracts/better-sidebar-source.md.
const patchPath = resolve(desktopRoot, '..', 'patches', 'dsh-better-sidebar', BETTER_SIDEBAR_VERSION, 'omnimux.patch')

export interface BuiltBetterSidebar {
  readonly tarballPath: string
  readonly packedRoot: string
}

export function buildPatchedBetterSidebar(workRoot: string): BuiltBetterSidebar {
  const sourceRoot = join(workRoot, 'source')
  const packRoot = join(workRoot, 'packed')
  mkdirSync(sourceRoot, { recursive: true })
  mkdirSync(packRoot, { recursive: true })

  run('git', ['init', '--quiet'], sourceRoot)
  run('git', ['config', 'core.autocrlf', 'false'], sourceRoot)
  run('git', ['remote', 'add', 'origin', BETTER_SIDEBAR_REPOSITORY], sourceRoot)
  run('git', ['fetch', '--quiet', '--depth=1', 'origin', BETTER_SIDEBAR_COMMIT], sourceRoot)
  run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], sourceRoot)
  const actualCommit = run('git', ['rev-parse', 'HEAD'], sourceRoot).trim()
  if (actualCommit !== BETTER_SIDEBAR_COMMIT) {
    throw new Error(`dsh-better-sidebar source mismatch: expected ${BETTER_SIDEBAR_COMMIT}, got ${actualCommit}`)
  }
  if (sha256(join(sourceRoot, 'pnpm-lock.yaml')) !== BETTER_SIDEBAR_LOCK_SHA256) {
    throw new Error('dsh-better-sidebar lockfile differs from the pinned commit contract')
  }
  // The patch series may update the lockfile (a feature patch can add build
  // dependencies), so the manifest records the PINNED lock — the anchor
  // validated directly above — while `patchSha256` covers whatever the series
  // changed, lockfile included.
  const pinnedLockSha256 = BETTER_SIDEBAR_LOCK_SHA256
  const expectedPatchSha256 = sha256(patchPath)
  run('git', ['apply', '--check', patchPath], sourceRoot)
  run('git', ['apply', patchPath], sourceRoot)
  runCorepackPnpm(['install', '--frozen-lockfile', '--ignore-scripts'], sourceRoot)
  runCorepackPnpm(['run', 'build'], sourceRoot)
  writeBuildManifest(sourceRoot, expectedPatchSha256, pinnedLockSha256)
  runCorepackPnpm(['pack', '--config.ignore-scripts=true', '--pack-destination', '../packed'], sourceRoot)

  const tarballs = readdirSync(packRoot).filter(name => name.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new Error(`dsh-better-sidebar pack produced ${String(tarballs.length)} tarballs; expected exactly one`)
  }
  const tarballPath = realpathSync(join(packRoot, tarballs[0]!))
  const extractedRoot = join(workRoot, 'packed-files')
  mkdirSync(extractedRoot)
  run('tar', ['-xzf', tarballPath, '-C', extractedRoot], workRoot)
  const packedPackageRoot = join(extractedRoot, 'package')
  verifyPackedSources(sourceRoot, packedPackageRoot)
  return { tarballPath, packedRoot: packedPackageRoot }
}

export function verifyInstalledBetterSidebar(installedRoot: string, packedRoot: string): void {
  for (const relativePath of listFiles(packedRoot)) {
    const expected = join(packedRoot, relativePath)
    const actual = join(installedRoot, relativePath)
    if (!existsSync(actual) || !readFileSync(actual).equals(readFileSync(expected))) {
      throw new Error(`staged dsh-better-sidebar differs from the packed build: ${relativePath}`)
    }
  }
  verifyBuildManifest(installedRoot)
}

function verifyPackedSources(sourceRoot: string, packedRoot: string): void {
  const packagedBuildFiles = listFiles(packedRoot)
    .filter(path => path.startsWith('src/') || path.startsWith('lib/') || path === 'omnimux-build.json')
  if (!packagedBuildFiles.includes('lib/index.js')
    || !packagedBuildFiles.includes('lib/client.js')
    || !packagedBuildFiles.includes('lib/client-registry.js')) {
    throw new Error('dsh-better-sidebar pack is missing a required built runtime')
  }
  for (const relativePath of packagedBuildFiles) {
    const source = join(sourceRoot, relativePath)
    if (!existsSync(source) || !readFileSync(join(packedRoot, relativePath)).equals(readFileSync(source))) {
      throw new Error(`dsh-better-sidebar pack differs from the patched build: ${relativePath}`)
    }
  }
  verifyBuildManifest(packedRoot)
}

interface BuildManifest {
  readonly package: 'dsh-better-sidebar'
  readonly version: string
  readonly repository: string
  readonly commit: string
  readonly patchSha256: string
  readonly lockfileSha256: string
  readonly packageManager: string
  readonly node: string
  readonly files: Readonly<Record<string, string>>
}

function writeBuildManifest(sourceRoot: string, expectedPatchSha256: string, lockfileSha256: string): void {
  if (sha256(patchPath) !== expectedPatchSha256) {
    throw new Error('dsh-better-sidebar patch changed while the source was building')
  }
  const files = Object.fromEntries(buildArtifactFiles(sourceRoot)
    .map(path => [path, sha256(join(sourceRoot, path))]))
  const manifest: BuildManifest = {
    package: 'dsh-better-sidebar',
    version: BETTER_SIDEBAR_VERSION,
    repository: BETTER_SIDEBAR_REPOSITORY,
    commit: BETTER_SIDEBAR_COMMIT,
    patchSha256: expectedPatchSha256,
    lockfileSha256,
    packageManager: `pnpm@${BETTER_SIDEBAR_PNPM_VERSION}`,
    node: process.version,
    files,
  }
  writeFileSync(join(sourceRoot, 'omnimux-build.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
}

function buildArtifactFiles(sourceRoot: string): string[] {
  const src = listFiles(join(sourceRoot, 'src')).map(path => `src/${path}`)
  const lib = listFiles(join(sourceRoot, 'lib'))
    .filter(path => !path.endsWith('.map'))
    .map(path => `lib/${path}`)
  return [...src, ...lib].sort()
}

function verifyBuildManifest(root: string): void {
  const manifest = JSON.parse(readFileSync(join(root, 'omnimux-build.json'), 'utf8')) as BuildManifest
  if (manifest.package !== 'dsh-better-sidebar'
    || manifest.version !== BETTER_SIDEBAR_VERSION
    || manifest.repository !== BETTER_SIDEBAR_REPOSITORY
    || manifest.commit !== BETTER_SIDEBAR_COMMIT
    || manifest.patchSha256 !== sha256(patchPath)
    || manifest.lockfileSha256 !== BETTER_SIDEBAR_LOCK_SHA256
    || manifest.packageManager !== `pnpm@${BETTER_SIDEBAR_PNPM_VERSION}`) {
    throw new Error('dsh-better-sidebar build provenance does not match the pinned contract')
  }
  const recordedFiles = Object.keys(manifest.files).sort()
  const actualFiles = buildArtifactFiles(root)
  if (JSON.stringify(recordedFiles) !== JSON.stringify(actualFiles)) {
    throw new Error('dsh-better-sidebar build provenance file inventory mismatch')
  }
  for (const [path, expectedHash] of Object.entries(manifest.files)) {
    if (!existsSync(join(root, path)) || sha256(join(root, path)) !== expectedHash) {
      throw new Error(`dsh-better-sidebar build provenance hash mismatch: ${path}`)
    }
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function listFiles(root: string): string[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'))
    }
  }
  visit(root)
  return files.sort()
}

function runCorepackPnpm(args: readonly string[], cwd: string): string {
  const pnpmArgs = [`pnpm@${BETTER_SIDEBAR_PNPM_VERSION}`, ...args]
  if (process.platform !== 'win32') return run('corepack', pnpmArgs, cwd)
  return run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `corepack ${pnpmArgs.join(' ')}`], cwd)
}

function run(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true', npm_config_ignore_scripts: 'true' },
  })
  if (result.status === 0) return result.stdout ?? ''
  const status = result.status === null
    ? result.signal ?? result.error?.message ?? 'unknown'
    : String(result.status)
  throw new Error([
    `dsh-better-sidebar: ${command} ${args.join(' ')} failed (${status})`,
    result.error === undefined ? undefined : `error: ${result.error.message}`,
    `stdout:\n${result.stdout === '' ? '<empty>' : (result.stdout ?? '<empty>').trimEnd()}`,
    `stderr:\n${result.stderr === '' ? '<empty>' : (result.stderr ?? '<empty>').trimEnd()}`,
  ].filter((line): line is string => line !== undefined).join('\n'))
}
