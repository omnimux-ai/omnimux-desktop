#!/usr/bin/env node
/** Explicit, headless full-profile rebuild from one frozen OmniMux app. */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installDesktopPnpmRuntime } from '../src/desktop-runtime-environment.ts'
import { assertPhysicalProfileBoundary, rebuildManagedProfile } from '../src/managed-profile.ts'
import { materializeProfile } from '../src/profile-materializer.ts'
import { readOwnedPackages } from '../src/preset-profile.ts'

/** Homes whose managed Profiles this rebuild can establish. */
const PROFILE_TARGETS = Object.freeze({
  dev: join(homedir(), '.omnimux-dev'),
  prod: join(homedir(), '.omnimux'),
})
type ProfileTarget = keyof typeof PROFILE_TARGETS

interface Arguments {
  readonly target: ProfileTarget
  readonly app: string
}

function usage(): never {
  throw new Error('usage: yarn omnimux:profile rebuild --target dev|prod --app <frozen-candidate.app>')
}

function parseArguments(argv: readonly string[]): Arguments {
  if (argv[0] !== 'rebuild') usage()
  let target: string | undefined
  let app: string | undefined
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if ((flag !== '--target' && flag !== '--app') || value === undefined || value.startsWith('--')) usage()
    if (flag === '--target') target = value
    else app = value
    index += 1
  }
  if ((target !== 'dev' && target !== 'prod') || app === undefined) usage()
  if (!isAbsolute(app)) throw new Error('--app must be an absolute path to a frozen candidate .app')
  const frozen = realpathSync(app)
  if (!frozen.endsWith('.app')) throw new Error(`--app is not a macOS application bundle: ${frozen}`)
  return { target, app: frozen }
}

function candidateLayout(app: string): {
  readonly executable: string
  readonly presetDir: string
  readonly pnpmBinPath: string
} {
  const executableDir = join(app, 'Contents', 'MacOS')
  const executables = readdirSync(executableDir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(executableDir, entry.name))
  if (executables.length !== 1) {
    throw new Error(`candidate App must contain exactly one main executable in ${executableDir}`)
  }
  const unpacked = join(app, 'Contents', 'Resources', 'app.asar.unpacked')
  const presetDir = join(unpacked, 'preset')
  const pnpmBinPath = join(unpacked, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
  for (const path of [join(presetDir, 'owned-packages.json'), join(presetDir, 'plugins'), pnpmBinPath]) {
    if (!existsSync(path)) throw new Error(`candidate App is incomplete: ${path}`)
  }
  return { executable: executables[0]!, presetDir, pnpmBinPath }
}

function listPackedFiles(pnpmCommand: string, sourceDir: string): string[] {
  // Packages that ship through a staged "publish directory" (yarn monorepo
  // convention, e.g. @smithy/*) point pnpm's packer at <dir>/.release/package,
  // which a materialized snapshot never contains. The candidate directory is a
  // disposable copy, so the publishConfig can be dropped from the copy before
  // asking pnpm to enumerate its files.
  const manifestPath = join(sourceDir, 'package.json')
  let manifest: Record<string, unknown> | undefined
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  } catch {
    manifest = undefined
  }
  if (manifest !== undefined && manifest['publishConfig'] !== undefined) {
    delete manifest['publishConfig']
    writeFileSync(manifestPath, JSON.stringify(manifest))
  }
  const result = spawnSync(
    pnpmCommand,
    // A managed plugin may pin its own pnpm release (devEngines/packageManager).
    // The pack runs under the app's bundled pnpm, and its only purpose here is to
    // enumerate the files a package would ship, so a version mismatch must not
    // abort the rebuild (it did for omnimux-studio, pinned to pnpm 11.7.0).
    ['--config.ignore-scripts=true', '--pm-on-fail=ignore', 'pack', '--dry-run', '--json'],
    { cwd: sourceDir, env: { ...process.env, CI: 'true' }, encoding: 'utf8', timeout: 30_000 },
  )
  if (result.status !== 0) {
    throw new Error(`pnpm pack list failed for ${sourceDir}: ${result.stderr || result.stdout || String(result.error)}`)
  }
  const parsed = JSON.parse(result.stdout) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`pnpm returned an invalid pack list for ${sourceDir}`)
  }
  const files = (parsed as { files?: unknown }).files
  if (!Array.isArray(files) || files.some(file => {
    return typeof file !== 'object' || file === null || Array.isArray(file)
      || typeof (file as { path?: unknown }).path !== 'string'
  })) {
    throw new Error(`pnpm returned an invalid packed files array for ${sourceDir}`)
  }
  return files.map(file => (file as { path: string }).path)
}

export async function runManagedProfileRebuild(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArguments(argv)
  const electronVersion = process.versions.electron
  if (electronVersion === undefined) {
    throw new Error('profile rebuild must run through the frozen candidate App in ELECTRON_RUN_AS_NODE mode')
  }
  const layout = candidateLayout(args.app)
  if (realpathSync(process.execPath) !== realpathSync(layout.executable)) {
    throw new Error(`profile rebuild is running through ${process.execPath}, not frozen candidate ${layout.executable}`)
  }
  const homeDir = PROFILE_TARGETS[args.target]
  const profileDir = join(homeDir, 'profiles', 'omnimux')
  assertPhysicalProfileBoundary(profileDir)
  const runtimeDir = mkdtempSync(join(tmpdir(), 'omnimux-profile-rebuild-runtime-'))
  const runtime = installDesktopPnpmRuntime({
    platform: process.platform,
    appExecutable: layout.executable,
    pnpmBinPath: layout.pnpmBinPath,
    electronVersion,
    stateDir: runtimeDir,
    environment: process.env,
  })
  try {
    const ownedPackages = readOwnedPackages(layout.presetDir)
    const result = await rebuildManagedProfile({
      profileDir,
      presetDir: layout.presetDir,
      ownedPackages,
      packedFiles: async sourceDir => listPackedFiles(runtime.pnpmShimPath, sourceDir),
      materialize: async candidateProfileDir => {
        await materializeProfile({
          appExecutable: layout.executable,
          clearEnvironmentPath: runtime.clearEnvironmentPath,
          pnpmBinPath: layout.pnpmBinPath,
          nodeBinDir: runtime.nodeBinDir,
          nodeShimPath: runtime.nodeShimPath,
          homeDir,
          profileDir: candidateProfileDir,
          electronVersion,
          updateLockfile: true,
        })
      },
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    runtime.dispose()
    rmSync(runtimeDir, { recursive: true, force: true })
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(entry)
}

if (isDirectExecution()) {
  void runManagedProfileRebuild().catch(cause => {
    process.stderr.write(`omnimux profile rebuild failed: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`)
    process.exitCode = 1
  })
}
