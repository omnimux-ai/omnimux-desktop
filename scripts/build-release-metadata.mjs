#!/usr/bin/env node
/**
 * Generate the static release metadata the desktop updaters poll.
 *
 * The application asks one fixed URL per channel for the latest version. Those
 * objects sit beside the installers in the distribution bucket, so publishing a
 * release means writing them in the same upload.
 *
 * Response shape (consumed by `dsh-plugin-desktop/src/update-checker.ts`):
 *   { "version": "2.0.18", "channel": "stable", "sha256": { "mac": "…", "windows": "…" } }
 *
 * Usage:
 *   node scripts/build-release-metadata.mjs --version 2.0.18 --dir ./release-assets
 *   node scripts/build-release-metadata.mjs --check --dir ./release-assets
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Channels the desktop clients can request. */
const CHANNELS = ['stable', 'beta', 'next']

/**
 * Map a release channel to the prerelease tag its versions must carry.
 *
 * `stable` accepts only a plain `x.y.z`; the others require exactly that tag, which
 * mirrors `parseCanonicalChannelVersion` in the update checker.
 */
const CHANNEL_TAG = { stable: undefined, beta: 'beta', next: 'next' }

function parseArgs(argv) {
  const value = flag => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }
  return { version: value('--version'), dir: value('--dir'), check: argv.includes('--check') }
}

function assertChannelVersion(version, channel) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(version)
  if (!match) throw new Error(`not a canonical SemVer: ${version}`)
  const tag = match[4]
  const expected = CHANNEL_TAG[channel]
  if (expected === undefined) {
    if (tag !== undefined) throw new Error(`${version} is a prerelease and cannot ship on the stable channel`)
    return
  }
  if (tag !== expected) throw new Error(`${version} must carry the "-${expected}" tag for the ${channel} channel`)
}

/** Walk a directory recursively so artifacts nested inside subdirectories are found. */
function walkFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full))
    else if (entry.isFile()) out.push({ name: entry.name, path: full })
  }
  return out
}

/** Pick the installer for one platform and hash it. */
function digestFor(dir, patterns) {
  const files = walkFiles(dir)
  for (const pattern of patterns) {
    const hit = files.find(file => pattern.test(file.name))
    if (hit) {
      return { name: hit.name, sha256: createHash('sha256').update(readFileSync(hit.path)).digest('hex'), bytes: statSync(hit.path).size }
    }
  }
  return undefined
}

function buildMetadata(dir, version, channel) {
  assertChannelVersion(version, channel)
  const macArm64 = digestFor(dir, [/-arm64\.dmg$/u])
  const macX64 = digestFor(dir, [/-x64\.dmg$/u])
  const windows = digestFor(dir, [/-Setup\.exe$/u, /\.exe$/u])
  const sha256 = {}
  if (macArm64) sha256.macArm64 = macArm64.sha256
  if (macX64) sha256.macX64 = macX64.sha256
  if (windows) sha256.windows = windows.sha256
  const metadata = { version, channel }
  if (Object.keys(sha256).length > 0) metadata.sha256 = sha256
  return { metadata, macArm64, macX64, windows }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.version) throw new Error('--version is required')
  const dir = args.dir === undefined ? join(ROOT_DIR, 'dist', 'release-download') : resolve(args.dir)
  if (!existsSync(dir)) throw new Error(`release asset directory not found: ${dir}`)

  // A version belongs to exactly one channel, decided by its prerelease tag.
  const tag = /-([0-9A-Za-z.-]+)$/u.exec(args.version)?.[1]
  const channel = CHANNELS.find(candidate => CHANNEL_TAG[candidate] === tag)
  if (channel === undefined) throw new Error(`${args.version} does not match any known release channel`)

  const built = buildMetadata(dir, args.version, channel)
  const outDir = join(dir, 'api', 'desktop')
  const path = join(outDir, `version-${channel}.json`)
  const serialized = `${JSON.stringify(built.metadata, null, 2)}\n`

  if (args.check) {
    if (!existsSync(path)) throw new Error(`missing release metadata: ${path}`)
    if (readFileSync(path, 'utf8') !== serialized) throw new Error(`${path} is stale; regenerate it`)
    console.log(`release metadata is current: ${channel} ${args.version}`)
    return
  }

  mkdirSync(outDir, { recursive: true })
  writeFileSync(path, serialized)
  const parts = [built.macArm64 && `mac-arm64 ${String(built.macArm64.bytes)}B`, built.macX64 && `mac-x64 ${String(built.macX64.bytes)}B`, built.windows && `windows ${String(built.windows.bytes)}B`]
    .filter(Boolean).join(', ')
  console.log(`wrote ${path}${parts ? ` (${parts})` : ''}`)
}

main()
