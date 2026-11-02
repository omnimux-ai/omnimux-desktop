#!/usr/bin/env node
/**
 * Record which plugin versions a release actually ships.
 *
 * The plugins are ordinary npm packages that the desktop build resolves at build
 * time: the app carries whatever the lockfile pinned. Nothing in a release
 * recorded *which* plugin versions that was, so answering "what code is in this
 * installer" meant re-reading a lockfile from a guessed commit, and the plugin
 * source repository had to be searched for a matching version label.
 *
 * This writes that answer beside the installers, so a release carries its own
 * bill of materials:
 *
 *   { "app": { "commit": "…" }, "plugins": [ { "name", "version", "commit" } ] }
 *
 * `commit` for a plugin is npm's `gitHead` — the commit the published tarball
 * was built from, which is what links a shipped byte to a source revision. A
 * plugin whose `gitHead` cannot be read is recorded with `null` and the reason
 * instead of failing the release: an incomplete record is worse than a complete
 * one, but much better than no release.
 *
 * Usage:
 *   node scripts/build-plugin-provenance.mjs [--lockfile yarn.lock] [--out release-assets]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Packages whose provenance a release must record, matched by name prefix. */
export const MANAGED_PREFIXES = ['omnimux', 'dsh-', '@deepseek-ai/dsh-']

/**
 * Versions pinned in a yarn v4 lockfile.
 *
 * Entries look like `"omnimux@npm:^0.1.3":` followed by `  version: 0.1.3`. A
 * package can appear under several ranges (one entry each); the installed
 * version is the same, so the map keeps whichever it reads.
 *
 * `workspace` marks a package the repository builds itself, resolved through
 * `resolution: "...@workspace:..."`. Those have no registry entry to ask for a
 * commit, and the repository's own commit already names their source.
 *
 * @param {string} text - lockfile contents
 * @returns {Map<string, {version: string, workspace: boolean}>}
 */
export function pinnedVersions(text) {
  const versions = new Map()
  let current = null
  let workspace = false
  for (const line of text.split('\n')) {
    if (!line.startsWith('  ') && line.endsWith(':')) {
      // Descriptor line, e.g. `"omnimux@npm:^0.1.3":` or `"pkg@workspace:.":`.
      // Several ranges can share a line; the first name is the package.
      const match = /^"?(@?[^"@]+(?:\/[^"@]+)?)@(npm|workspace):/u.exec(line)
      current = match ? match[1] : null
      workspace = match ? match[2] === 'workspace' : false
      continue
    }
    if (!current) continue
    const version = /^\s+version:\s*(\S+)\s*$/u.exec(line)
    if (version) {
      // A repository package can be listed twice — once through the registry and
      // once as a workspace link — and the workspace copy carries a version like
      // `0.0.0-use.local`. One workspace descriptor is enough to know the release
      // built it here rather than downloaded it.
      const local = workspace || version[1].includes('use.local')
      const previous = versions.get(current)
      versions.set(current, { version: version[1], workspace: local || Boolean(previous?.workspace) })
      current = null
    }
  }
  return versions
}

/** True when a package belongs in the provenance record. */
export function isManaged(name) {
  // The scope prefix (`@deepseek-ai/dsh-`) already starts with `@`, so compare raw.
  return MANAGED_PREFIXES.some((prefix) =>
    prefix.startsWith('@') ? name.startsWith(prefix) : name.startsWith(prefix)
  )
}

/**
 * Builds the record.
 * @param {string} lockfileText - lockfile contents
 * @param {(name: string, version: string) => string | null} lookupCommit - npm gitHead
 * @param {{commit?: string, version?: string}} app - the application's own identity
 */
export function buildProvenance(lockfileText, lookupCommit, app = {}) {
  const plugins = []
  for (const [name, pinned] of [...pinnedVersions(lockfileText)].sort(([a], [b]) => a.localeCompare(b))) {
    if (!isManaged(name)) continue
    if (pinned.workspace) {
      // Built from this repository, so the application commit covers it.
      plugins.push({ name, version: pinned.version, commit: null, source: 'workspace' })
      continue
    }
    let commit = null
    let note
    try {
      commit = lookupCommit(name, pinned.version)
      if (!commit) note = 'registry reports no gitHead for this version'
    } catch (error) {
      note = `registry lookup failed: ${String(error.message ?? error).slice(0, 120)}`
    }
    plugins.push(note ? { name, version: pinned.version, commit, note } : { name, version: pinned.version, commit })
  }
  return { app, plugins, generatedAt: new Date().toISOString() }
}

/** Reads a package version's `gitHead` from the public npm registry. */
export function registryCommit(name, version) {
  const raw = execFileSync('npm', ['view', `${name}@${version}`, 'gitHead', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  if (!raw || raw === 'undefined') return null
  const value = JSON.parse(raw)
  return typeof value === 'string' ? value : null
}

function parseArgs(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }
  return {
    lockfile: resolve(ROOT_DIR, value('--lockfile') ?? 'yarn.lock'),
    outDir: resolve(ROOT_DIR, value('--out') ?? 'release-assets'),
  }
}

function main() {
  const { lockfile, outDir } = parseArgs(process.argv.slice(2))
  if (!existsSync(lockfile)) {
    console.error(`refusing to write a provenance record without ${lockfile}`)
    process.exit(1)
  }
  const record = buildProvenance(
    readFileSync(lockfile, 'utf8'),
    registryCommit,
    {
      commit: process.env.GITHUB_SHA ?? null,
      version: process.env.RELEASE_VERSION ?? null,
    }
  )
  const outPath = join(outDir, 'plugin-provenance.json')
  writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`)
  const missing = record.plugins.filter((plugin) => plugin.commit === null)
  console.log(`${record.plugins.length} plugins recorded in ${outPath}`)
  if (missing.length > 0) {
    console.log(`  ${missing.length} without a commit: ${missing.map((p) => p.name).join(', ')}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
