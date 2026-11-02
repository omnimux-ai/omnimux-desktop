/** Build provenance: record the exact source tree behind a packaged app bundle. */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Quiet git invocation; returns trimmed stdout or null on failure. */
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0 || result.error) return null
  const out = result.stdout.trim()
  return out.length > 0 ? out : null
}

/** This fork repository root (the superproject above dsh-plugin-desktop/). */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Snapshot the current source identity of this build.
 * @param channel - Build channel label, e.g. `package-dir` or `dist:mac`.
 */
export function currentBuildInfo(channel) {
  const desktopPackage = JSON.parse(
    readFileSync(join(repoRoot, 'dsh-plugin-desktop', 'package.json'), 'utf8'),
  )
  const dshSpec = desktopPackage.dependencies?.['@deepseek-ai/dsh'] ?? null
  return {
    product: desktopPackage.build?.productName ?? 'OmniMux',
    version: desktopPackage.version,
    channel,
    builtAt: new Date().toISOString(),
    repo: {
      branch: git(repoRoot, 'branch', '--show-current'),
      commit: git(repoRoot, 'rev-parse', '--short', 'HEAD'),
      origin: git(repoRoot, 'remote', 'get-url', 'origin'),
      fork: git(repoRoot, 'remote', 'get-url', 'fork'),
    },
    upstream: {
      master: git(repoRoot, 'rev-parse', '--short', 'origin/master'),
    },
    dsh: {
      packageSpec: dshSpec,
      submodule: git(join(repoRoot, 'deepseek-harness'), 'rev-parse', '--short', 'HEAD'),
    },
  }
}

/**
 * Write `build-info.json` into an app bundle's Resources.
 * @param appPath - Path to the `.app` bundle.
 * @param channel - Build channel label.
 * @returns The recorded snapshot.
 */
export function writeAppBuildInfo(appPath, channel = 'local') {
  const info = currentBuildInfo(channel)
  const resources = join(appPath, 'Contents', 'Resources')
  writeFileSync(join(resources, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`)
  return info
}

// CLI mode: `node scripts/build-info.mjs <appPath> [channel]`
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appPath = process.argv[2]
  if (appPath === undefined) {
    console.error('usage: build-info.mjs <appPath> [channel]')
    process.exit(1)
  }
  console.log(JSON.stringify(writeAppBuildInfo(appPath, process.argv[3] ?? 'cli'), null, 2))
}
