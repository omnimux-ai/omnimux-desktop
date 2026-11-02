import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { marketablePlugins, preinstalledPlugins, readPluginTiers, tierOf, withheldPlugins } from './plugin-tiers.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Write one tier file and return its path. */
function tierFile(tiers) {
  const root = mkdtempSync(join(tmpdir(), 'plugin-tiers-'))
  roots.push(root)
  const path = join(root, 'plugin-tiers.json')
  writeFileSync(path, `${JSON.stringify({ tiers }, null, 2)}\n`)
  return path
}

describe('plugin release tiers', () => {
  it('keeps the sidebar as infrastructure rather than a marketable product plugin', () => {
    const tiers = readPluginTiers()

    // Every OmniMux plugin registers its shell entries through this service, so
    // it is a hard preinstall and must never be offered as a market install.
    assert.ok(tiers.infrastructure.includes('dsh-better-sidebar'))
    assert.ok(!tiers.preview.includes('dsh-better-sidebar'))
    assert.ok(!marketablePlugins().includes('dsh-better-sidebar'))
    assert.ok(preinstalledPlugins().includes('dsh-better-sidebar'))
  })

  it('reads the shipped config with the expected tiers', () => {
    const tiers = readPluginTiers()

    assert.ok(tiers.preview.includes('omnimux'))
    assert.ok(tiers.preview.includes('omnimux-forms'))
    assert.ok(tiers.beta.includes('omnimux-accounts'))
    assert.ok(tiers.retired.includes('omnimux-automation'))
  })

  it('preinstalls infrastructure before preview so the sidebar loads first', () => {
    const path = tierFile({ infrastructure: ['the-base'], preview: ['a-product'], beta: [], retired: [] })

    assert.deepEqual(preinstalledPlugins(path), ['the-base', 'a-product'])
    // The market never lists the base service.
    assert.deepEqual(marketablePlugins(path), ['a-product'])
  })

  it('keeps the shipped tiers disjoint', () => {
    const tiers = readPluginTiers()
    const all = [...tiers.infrastructure, ...tiers.preview, ...tiers.beta, ...tiers.retired]
    assert.equal(new Set(all).size, all.length, 'a plugin appears in more than one tier')
  })

  it('resolves the tier of a plugin and reports an undeclared one as undefined', () => {
    const path = tierFile({ infrastructure: ['base'], preview: ['a-plugin'], beta: ['b-plugin'], retired: ['c-plugin'] })

    assert.equal(tierOf('base', path), 'infrastructure')
    assert.equal(tierOf('a-plugin', path), 'preview')
    assert.equal(tierOf('b-plugin', path), 'beta')
    assert.equal(tierOf('c-plugin', path), 'retired')
    // Undeclared is not a fifth tier: it is the drift this file exists to catch.
    assert.equal(tierOf('never-declared', path), undefined)
  })

  it('rejects a plugin listed in two tiers', () => {
    const path = tierFile({ infrastructure: [], preview: ['dup'], beta: ['dup'], retired: [] })

    assert.throws(() => readPluginTiers(path), /appears in both tiers/u)
  })

  it('rejects a tier file that omits infrastructure', () => {
    // Dropping the tier would silently demote the sidebar to "not preinstalled",
    // which breaks every plugin that registers through it.
    assert.throws(() => readPluginTiers(tierFile({ preview: ['ok'], beta: [], retired: [] })), /tiers\.infrastructure must be an array/u)
  })

  it('rejects a malformed tier file', () => {
    assert.throws(() => readPluginTiers(tierFile({ infrastructure: [], preview: ['ok'] })), /tiers\.beta must be an array/u)
    assert.throws(() => readPluginTiers(tierFile({ infrastructure: [], preview: ['Bad Name'], beta: [], retired: [] })), /invalid plugin name/u)
  })

  it('separates the withheld list from everything that ships', () => {
    const path = tierFile({ infrastructure: ['base'], preview: ['ships'], beta: ['testing'], retired: ['gone'] })

    assert.deepEqual(withheldPlugins(path), ['testing', 'gone'])
  })
})
