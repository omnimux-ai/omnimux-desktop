#!/usr/bin/env node
/**
 * verify-version.mjs — 版本一致性门禁。
 *
 * 校验：
 *   1. 根 package.json#version === dsh-plugin-desktop/package.json#version（任何提交都必须成立）
 *   2. 可选 --tag <vX.Y.Z>：发布 tag 去掉前缀 v 后必须等于 version（供 release 自动化使用）
 *
 * 用法：
 *   node scripts/verify-version.mjs
 *   node scripts/verify-version.mjs --tag v2.0.3
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readVersion(rel) {
  return JSON.parse(readFileSync(resolve(root, rel), 'utf8')).version
}

const rootVersion = readVersion('package.json')
const desktopVersion = readVersion('dsh-plugin-desktop/package.json')

const errors = []

if (rootVersion !== desktopVersion) {
  errors.push(
    `版本不一致: 根 package.json=${rootVersion} ≠ dsh-plugin-desktop/package.json=${desktopVersion}`,
  )
}

const tagIdx = process.argv.indexOf('--tag')
if (tagIdx !== -1) {
  const tag = process.argv[tagIdx + 1]
  if (!tag) {
    errors.push('--tag 需要提供一个 tag 值')
  } else {
    const clean = tag.replace(/^v/, '')
    if (clean !== rootVersion) {
      errors.push(`发布 tag 与版本不一致: tag=${tag} ≠ version=${rootVersion}`)
    }
  }
}

if (errors.length > 0) {
  for (const e of errors) process.stderr.write(`✗ ${e}\n`)
  process.exit(1)
}

process.stdout.write(`✓ 版本一致: ${rootVersion}\n`)
