#!/usr/bin/env node
/**
 * Stamp an unpacked macOS app bundle with Dev channel identity in its Info.plist.
 *
 * Usage:
 *   node scripts/stamp-dev-app.mjs [path-to-app-bundle]
 * Default target:
 *   dsh-plugin-desktop/dist/mac-arm64/OmniMux.app or OmniMux Dev.app
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** Locate the packaged release-channel marker: `asar: false` keeps app content in
 * `Resources/app`, while an asar build would unpack it to `app.asar.unpacked`. */
function packagedMarkerPath(appPath) {
  const candidates = [
    join(appPath, 'Contents', 'Resources', 'app', 'preset', 'plugins', 'omnimux', 'src', 'release-channel.json'),
    join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'preset', 'plugins', 'omnimux', 'src', 'release-channel.json'),
  ]
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]
}

function findCandidateApp() {
  const armDir = join(packageRoot, 'dist', 'mac-arm64')
  if (existsSync(armDir)) {
    for (const name of readdirSync(armDir)) {
      if (name.endsWith('.app')) return join(armDir, name)
    }
  }
  const macDir = join(packageRoot, 'dist', 'mac')
  if (existsSync(macDir)) {
    for (const name of readdirSync(macDir)) {
      if (name.endsWith('.app')) return join(macDir, name)
    }
  }
  return null
}

/** @param {string | null} appPath */
export function stampDevApp(appPath = findCandidateApp()) {
  if (!appPath || !existsSync(appPath)) {
    throw new Error(`stamp-dev-app: target app bundle not found (${appPath ?? 'none'})`)
  }
  const plistPath = join(appPath, 'Contents', 'Info.plist')
  if (!existsSync(plistPath)) throw new Error(`stamp-dev-app: Info.plist not found at ${plistPath}`)

  const markerPath = packagedMarkerPath(appPath)
  let marker
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  } catch (cause) {
    throw new Error(`stamp-dev-app: packaged release channel is missing or unreadable; rebuild with corepack yarn package:dev (${markerPath})`, { cause })
  }
  if (marker?.channel !== 'development') {
    throw new Error(`stamp-dev-app: requires a development preset, received ${JSON.stringify(marker?.channel)}; rebuild with corepack yarn package:dev`)
  }

  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :LSEnvironment dict', plistPath], { stdio: 'ignore' })
  } catch {}

  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :LSEnvironment:OMNIMUX_CHANNEL dev', plistPath], { stdio: 'ignore' })
  } catch {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :LSEnvironment:OMNIMUX_CHANNEL string dev', plistPath], { stdio: 'ignore' })
  }

  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleDisplayName OmniMux Dev', plistPath], { stdio: 'ignore' })
  } catch {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :CFBundleDisplayName string OmniMux Dev', plistPath], { stdio: 'ignore' })
  }
  return plistPath
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plistPath = stampDevApp(process.argv[2])
  process.stdout.write(`✓ Successfully stamped Dev identity into ${plistPath}\n`)
}
