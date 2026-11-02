/**
 * Opt-in integration verifier for the pinned better-sidebar source pipeline.
 * Run with: node --experimental-strip-types tests/better-sidebar/verify-pipeline.mjs
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const desktopRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const builderPath = join(desktopRoot, 'dsh-plugin-desktop/scripts/better-sidebar/build-patched-sidebar.ts')
const stagePath = join(desktopRoot, 'dsh-plugin-desktop/scripts/stage-preset-profile.ts')
const {
  buildPatchedBetterSidebar,
  verifyInstalledBetterSidebar,
  BETTER_SIDEBAR_COMMIT,
  BETTER_SIDEBAR_VERSION,
} = await import(pathToFileURL(builderPath).href)
const patchPath = join(desktopRoot, 'patches/dsh-better-sidebar', BETTER_SIDEBAR_VERSION, 'omnimux.patch')
const workRoot = mkdtempSync(join(tmpdir(), 'better-sidebar-pipeline-'))
const reportPath = process.env.SIDEBAR_PIPELINE_REPORT ?? join(workRoot, 'report.json')

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, CI: 'true' } })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}
function files(root) {
  const result = []
  const visit = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) result.push(relative(root, path))
    }
  }
  visit(root)
  return result.sort()
}
function hashes(root) {
  return Object.fromEntries(files(root).map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]))
}
function assertSameHashes(left, right, context) {
  const paths = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
  const mismatch = paths.find(path => left[path] !== right[path])
  if (mismatch !== undefined) {
    throw new Error(`${context}: ${mismatch} (${left[mismatch] ?? '<missing>'} != ${right[mismatch] ?? '<missing>'})`)
  }
}
function expectFailure(action, text) {
  try { action() } catch (error) {
    if (String(error).includes(text)) return
    throw new Error(`failure did not include ${text}: ${String(error)}`)
  }
  throw new Error(`expected failure containing ${text}`)
}

const { stagePresetProfile } = await import(pathToFileURL(stagePath).href)
const first = buildPatchedBetterSidebar(join(workRoot, 'first'))
const firstHashes = hashes(first.packedRoot)

// Mirrors config/plugin-tiers.json (preview + beta, the tiers stagePresetProfile
// stages): the stage asserts every one of these has a source directory, so the
// fixture must cover the full list.
const productNames = [
  'omnimux', 'omnimux-accounts', 'omnimux-assets', 'omnimux-products',
  'omnimux-workflow', 'omnimux-market', 'omnimux-inspiration', 'omnimux-clip',
  'omnimux-video', 'omnimux-analytics', 'omnimux-publish', 'omnimux-forms',
]
const pluginsRoot = join(workRoot, 'product-plugins')
for (const name of productNames) {
  const root = join(pluginsRoot, name)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name, version: '1.0.0', main: 'index.js' })}\n`)
  writeFileSync(join(root, 'index.js'), 'export {}\n')
  // stagePresetProfile writes release-channel.json into the staged hub's
  // src/, and copyPluginSources only creates what the source has.
  mkdirSync(join(root, 'src'), { recursive: true })
}
// stagePresetProfile validates the hub's lifecycle registry and release
// channel before copying anything, so the fixture has to carry both. They are
// the minimum the validator accepts, not a replica of the product values.
const hubSrc = join(pluginsRoot, 'omnimux', 'src')
mkdirSync(hubSrc, { recursive: true })
writeFileSync(join(hubSrc, 'plugin-lifecycle.json'), `${JSON.stringify({ omnimux: { stage: 'alpha', toolPrefixes: ['omnimux_'] } }, null, 2)}\n`)
writeFileSync(join(hubSrc, 'release-channel.json'), `${JSON.stringify({ channel: 'development' }, null, 2)}\n`)
const presetDir = join(workRoot, 'preset')
// `development` keeps the Alpha-stage hub in the copy set: the default
// `production` channel deliberately excludes it, which leaves the staged hub
// without the src/ tree writeReleaseChannel needs.
stagePresetProfile({ pluginsRoot, presetDir, releaseChannel: 'development' })
const installed = join(presetDir, 'plugins/dsh-better-sidebar')
verifyInstalledBetterSidebar(installed, first.packedRoot)
const stagedHashes = Object.fromEntries(Object.keys(firstHashes).map(path => [
  path,
  createHash('sha256').update(readFileSync(join(installed, path))).digest('hex'),
]))
assertSameHashes(firstHashes, stagedHashes, 'clean builder and staged builder differ')
const tampered = join(workRoot, 'tampered')
cpSync(installed, tampered, { recursive: true })
const tamperedClient = readFileSync(join(tampered, 'lib/client.js'))
tamperedClient[0] ^= 1
writeFileSync(join(tampered, 'lib/client.js'), tamperedClient)
expectFailure(() => verifyInstalledBetterSidebar(tampered, first.packedRoot), 'differs from the packed build')

const patchProbe = join(workRoot, 'patch-probe')
mkdirSync(patchProbe, { recursive: true })
run('git', ['init', '--quiet'], patchProbe)
run('git', ['config', 'core.autocrlf', 'false'], patchProbe)
run('git', ['remote', 'add', 'origin', 'https://github.com/omdsh-dev/DSH-better-sidebar.git'], patchProbe)
run('git', ['fetch', '--quiet', '--depth=1', 'origin', BETTER_SIDEBAR_COMMIT], patchProbe)
run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], patchProbe)
run('git', ['apply', '--check', patchPath], patchProbe)
const changedSource = join(workRoot, 'changed-source')
cpSync(patchProbe, changedSource, { recursive: true, dereference: true })
writeFileSync(
  join(changedSource, 'package.json'),
  readFileSync(join(changedSource, 'package.json'), 'utf8')
    .replace('"cordis.patch.yml"', '"cordis.patch.yml.mutated"'),
)
expectFailure(() => run('git', ['apply', '--check', patchPath], changedSource), 'patch failed')
run('git', ['apply', patchPath], patchProbe)
expectFailure(() => run('git', ['apply', '--check', patchPath], patchProbe), 'patch failed')

const report = {
  workRoot,
  firstTarball: first.tarballPath,
  fileCount: Object.keys(firstHashes).length,
  tarballSha256: createHash('sha256').update(readFileSync(first.tarballPath)).digest('hex'),
  stagedProvenance: JSON.parse(readFileSync(join(installed, 'omnimux-build.json'), 'utf8')),
  packedFiles: firstHashes,
  stagedFiles: stagedHashes,
  tamperRejected: true,
  changedSourcePatchRejected: true,
  alreadyAppliedPatchRejected: true,
}
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
