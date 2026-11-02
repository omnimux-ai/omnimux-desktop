// Temporary end-to-end check of seedOmnimuxProfile (uses compiled lib/).
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { seedOmnimuxProfile, resolveHarnessHome, REQUIRED_BUNDLES } from '../lib/preset-profile.js'

const home = resolveHarnessHome()
const profileDir = join(home, 'profiles', 'omnimux')

if (existsSync(profileDir)) {
  console.log(`[seed-test] removing existing profile: ${profileDir}`)
  rmSync(profileDir, { recursive: true, force: true })
}

const presetDir = fileURLToPath(new URL('../preset', import.meta.url))
console.log(`[seed-test] seed against preset: ${presetDir}`)
const result = seedOmnimuxProfile({ home, presetDir })
console.log('[seed-test] seed result:', result)

if (!existsSync(profileDir)) throw new Error('seed did not create profileDir')
if (!existsSync(join(profileDir, 'package.json'))) throw new Error('seed did not write package.json')
if (!existsSync(join(profileDir, 'cordis.patch.yml'))) throw new Error('seed did not write cordis.patch.yml')
if (!existsSync(join(profileDir, 'pnpm-workspace.yaml'))) throw new Error('seed did not write pnpm-workspace.yaml')
const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
const bundles = manifest.dsh?.profile?.bundles ?? []
const missing = REQUIRED_BUNDLES.filter((b) => !bundles.includes(b))
if (missing.length > 0) throw new Error(`seed missing bundles: ${missing.join(', ')}`)
console.log(`[seed-test] bundles ok: ${bundles.length} (${bundles.join(', ')})`)

const ownedDeps = Object.keys(manifest.dependencies ?? {})
console.log(`[seed-test] owned deps: ${ownedDeps.length}`)

const stamp = join(profileDir, '.omnimux-seed-version')
if (!existsSync(stamp)) throw new Error('seed stamp not written')
const stampValue = readFileSync(stamp, 'utf8').trim()
console.log(`[seed-test] seed-version stamp: ${stampValue}`)

const modulesDir = join(profileDir, 'node_modules')
const sampleNames = ['dsh-better-sidebar', 'omnimux', 'omnimux-assets']
for (const name of sampleNames) {
  const segs = name.split('/')
  const p = join(modulesDir, ...segs, 'package.json')
  if (!existsSync(p)) throw new Error(`seed did not copy plugin ${name}: ${p}`)
  console.log(`[seed-test] plugin materialised: ${name}`)
}

console.log(`[seed-test] PASS — profile size: ${statSync(profileDir).size} bytes, modules size: ${statSync(modulesDir).size} bytes`)
