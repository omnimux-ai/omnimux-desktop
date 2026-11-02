// Tests for the merge-conflict resolver used by sync-upstream.sh.
// Samples mirror the real conflicts observed on 2026-08-21.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConflicts, BRAND_KEYS } from './lib/resolve-merge-conflicts.mjs'

test('BRAND_KEYS lists the OmniMux identity fields', () => {
  assert.ok(BRAND_KEYS.includes('version'))
  assert.ok(BRAND_KEYS.includes('description'))
  assert.ok(BRAND_KEYS.includes('appId'))
  assert.ok(BRAND_KEYS.includes('productName'))
  assert.ok(BRAND_KEYS.includes('PRODUCT_NAME'))
})

test('B 级：package.json 版本取上游、品牌行保 HEAD（2026-08-21 真实样本）', () => {
  const input = `{
  "name": "dsh-plugin-desktop",
<<<<<<< HEAD
  "version": "2.0.1",
  "description": "OmniMux: an Electron shell composed as a DeepSeek Harness Cordis plugin",
=======
  "version": "2.0.2",
  "description": "DSH Desktop: an Electron shell composed as a DeepSeek Harness Cordis plugin",
>>>>>>> origin/master
  "license": "MIT",
`
  const result = resolveConflicts(input)
  assert.equal(result.resolved, true)
  assert.equal(result.notes.length, 2)
  assert.ok(result.output.includes('"version": "2.0.2"'))
  assert.ok(result.output.includes('"description": "OmniMux:'))
  assert.ok(!result.output.includes('<<<<<<<'))
  assert.ok(!result.output.includes('DSH Desktop'))
})

test('B 级：源码品牌常量行保 HEAD', () => {
  const input = `const app = {
<<<<<<< HEAD
const PRODUCT_NAME = 'OmniMux'
=======
const PRODUCT_NAME = 'DSH Desktop'
>>>>>>> origin/master
}
`
  const result = resolveConflicts(input)
  assert.equal(result.resolved, true)
  assert.ok(result.output.includes("PRODUCT_NAME = 'OmniMux'"))
  assert.ok(!result.output.includes('DSH Desktop'))
})

test('C 级：非品牌结构性差异停等（不能自动解）', () => {
  const input = `function boot() {
<<<<<<< HEAD
  await seedOmnimuxProfile({ home, presetDir })
  logger.info('seeded')
=======
  await migrateLegacyProfiles(home)
>>>>>>> origin/master
}
`
  const result = resolveConflicts(input)
  assert.equal(result.resolved, false)
  assert.ok(result.reason.includes('structural'))
})

test('C 级：段行数不一致停等', () => {
  const input = `x {
<<<<<<< HEAD
  a
  b
=======
  a
>>>>>>> origin/master
}
`
  const result = resolveConflicts(input)
  assert.equal(result.resolved, false)
})

test('无冲突标记直接通过', () => {
  const input = '{ "name": "ok" }\n'
  const result = resolveConflicts(input)
  assert.equal(result.resolved, true)
  assert.equal(result.output, input)
  assert.equal(result.notes.length, 0)
})
