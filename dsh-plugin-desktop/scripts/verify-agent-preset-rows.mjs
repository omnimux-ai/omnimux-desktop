#!/usr/bin/env node
/**
 * Verify the composed agent-preset declaration rows before a build trusts them.
 *
 * The rows are produced at profile-composition time (`src/agent-preset-rows.ts`),
 * so a mistake there surfaces as a boot failure in the shipped app instead of a
 * red test: duplicate Loader row ids from a preset the bundle already declares,
 * a plugin package the installation cannot resolve, or `tool-subagent` config the
 * current kernel throws on. This script composes the real shipped presets with
 * the real kernel facts and asserts those three invariants.
 *
 * Unit coverage for the pure composer lives in the repository's test tree; this
 * script exists because the composition also depends on the packaged preset
 * directory and on what the installed kernel actually resolves.
 */

import { existsSync } from 'node:fs'
import {
  AGENT_PRESET_DECLARATION_PACKAGE,
  composeShippedAgentPresetRows,
  shippedAgentPresetRoot,
  upstreamAgentPresetIds,
} from '../src/agent-preset-rows.ts'

const failures = []

/** Record one violated invariant. */
function fail(message) {
  failures.push(message)
}

const presetRoot = shippedAgentPresetRoot()
if (!existsSync(presetRoot)) {
  fail(`shipped preset root is missing: ${presetRoot} (run the preset stage first)`)
}

const upstream = upstreamAgentPresetIds()
const composition = composeShippedAgentPresetRows()

if (composition.rows.length === 0) fail('no agent preset rows were composed')

const rowIds = composition.rows.map(row => row.id)
if (new Set(rowIds).size !== rowIds.length) fail('duplicate Loader row id in the composed rows')

for (const row of composition.rows) {
  if (typeof row.id !== 'string' || !row.id.startsWith('omnimux-preset-')) {
    fail(`row id ${JSON.stringify(row.id)} does not carry the omnimux-preset- prefix`)
  }
  if (row.name !== AGENT_PRESET_DECLARATION_PACKAGE) {
    fail(`row ${JSON.stringify(row.id)} does not declare ${AGENT_PRESET_DECLARATION_PACKAGE}`)
  }
  const presetId = row.config?.id
  if (typeof presetId !== 'string' || presetId.length === 0) fail(`row ${JSON.stringify(row.id)} has no preset id`)
  if (upstream.has(presetId)) fail(`preset ${JSON.stringify(presetId)} is declared by the upstream bundle too`)
  const plugins = row.config?.plugins
  if (!Array.isArray(plugins) || plugins.length === 0) fail(`preset ${JSON.stringify(presetId)} composed no plugin rows`)
}

for (const name of composition.droppedPackages) {
  // Reported for the record: the preset ships without these rows on purpose.
  process.stdout.write(`  dropped unresolvable package: ${name}\n`)
}

/** Visit every plugin row of every composed preset, groups included. */
function visitRows(rows, visit) {
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    visit(row)
    if (Array.isArray(row.config)) visitRows(row.config, visit)
  }
}

for (const row of composition.rows) {
  visitRows(row.config?.plugins ?? [], plugin => {
    if (plugin.name !== '@deepseek-ai/dsh-tool-subagent') return
    const config = plugin.config
    if (config === null || typeof config !== 'object') return
    if (Object.hasOwn(config, 'persona')) fail(`tool-subagent row ${JSON.stringify(plugin.id)} kept the rejected persona config`)
    if (Object.hasOwn(config, 'toolFilter')) fail(`tool-subagent row ${JSON.stringify(plugin.id)} kept the rejected toolFilter config`)
  })
}

if (failures.length > 0) {
  for (const message of failures) process.stderr.write(`✗ ${message}\n`)
  process.exit(1)
}

process.stdout.write(
  `✓ agent presets: ${composition.rows.length} declared`
  + `, ${composition.skippedPresetIds.length} skipped (upstream-owned)`
  + `, ${composition.droppedPackages.length} package row(s) dropped\n`,
)
