#!/usr/bin/env node
/**
 * Read the plugin release tiers from their single source of truth.
 *
 * Before this module every consumer kept its own copy of "which plugins ship":
 * the Next preinstall list, the market index generator, and the plugin repo's
 * lifecycle registry all drifted independently. That drift is how a plugin ends
 * up preinstalled while the market hides it, or alpha while the app ships it.
 *
 * Every consumer imports from here. Adding a plugin to a tier is a one-file
 * change; forgetting a consumer is not possible because there is no second list
 * to forget.
 *
 * Tiers:
 *   infrastructure  always preinstalled, never marketable — the services every
 *                   other plugin registers against (the sidebar). Removing one
 *                   breaks the rest, so it is not an optional choice.
 *   preview         preinstalled and listed in the market
 *   beta            internal testing: neither preinstalled nor listed
 *   retired         no longer shipped; a stale reference must fail loudly
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TIERS_PATH = join(ROOT_DIR, 'config', 'plugin-tiers.json')

/** Tier names in shipping order. */
export const TIER_NAMES = ['infrastructure', 'preview', 'beta', 'retired']

/**
 * Read and validate the tier file.
 * @param {string} [path] - Override for tests.
 * @returns {{ infrastructure: string[], preview: string[], beta: string[], retired: string[] }}
 */
export function readPluginTiers(path = TIERS_PATH) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read the plugin tier config at ${path}: ${error.message}`)
  }
  const tiers = parsed?.tiers
  if (tiers === null || typeof tiers !== 'object') {
    throw new Error(`${path} must declare a "tiers" object`)
  }
  const result = {}
  for (const name of TIER_NAMES) {
    const value = tiers[name]
    if (!Array.isArray(value)) {
      throw new Error(`${path}: tiers.${name} must be an array`)
    }
    for (const entry of value) {
      if (typeof entry !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(entry)) {
        throw new Error(`${path}: tiers.${name} contains an invalid plugin name ${JSON.stringify(entry)}`)
      }
    }
    result[name] = [...value]
  }
  // A plugin in two tiers is a config bug, not a preference: the consumers would
  // disagree about it depending on iteration order.
  const seen = new Map()
  for (const name of TIER_NAMES) {
    for (const entry of result[name]) {
      const previous = seen.get(entry)
      if (previous !== undefined) {
        throw new Error(`${path}: ${entry} appears in both tiers.${previous} and tiers.${name}`)
      }
      seen.set(entry, name)
    }
  }
  return result
}

/**
 * Every plugin the shipped app preinstalls: infrastructure first, then preview.
 *
 * Order matters: `dsh-better-sidebar` has to load before the plugins that
 * register their shell entries through it, so infrastructure leads.
 * @param {string} [path] - Override for tests.
 * @returns {string[]}
 */
export function preinstalledPlugins(path = TIERS_PATH) {
  const tiers = readPluginTiers(path)
  return [...tiers.infrastructure, ...tiers.preview]
}

/**
 * Plugins the market lists: the preview tier only.
 *
 * Infrastructure is deliberately absent — the sidebar is preinstalled and has no
 * installable market entry, so listing it would offer users a second copy of
 * something they already have.
 * @param {string} [path] - Override for tests.
 * @returns {string[]}
 */
export function marketablePlugins(path = TIERS_PATH) {
  return readPluginTiers(path).preview
}

/**
 * Plugins that must NOT be preinstalled or marketed.
 * @param {string} [path] - Override for tests.
 * @returns {string[]}
 */
export function withheldPlugins(path = TIERS_PATH) {
  const tiers = readPluginTiers(path)
  return [...tiers.beta, ...tiers.retired]
}

/**
 * The tier a plugin belongs to, or undefined when it is not declared.
 *
 * Undeclared is a failure mode worth surfacing: a plugin that ships without a
 * tier is exactly the drift this file exists to prevent.
 * @param {string} name - Plugin package name.
 * @param {string} [path] - Override for tests.
 * @returns {'infrastructure' | 'preview' | 'beta' | 'retired' | undefined}
 */
export function tierOf(name, path = TIERS_PATH) {
  const tiers = readPluginTiers(path)
  for (const tier of TIER_NAMES) {
    if (tiers[tier].includes(name)) return tier
  }
  return undefined
}
