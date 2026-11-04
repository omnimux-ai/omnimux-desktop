#!/usr/bin/env node
/**
 * cf-purge-cache.mjs — 清理 CDN 边缘缓存，让 `releases/latest/*` 别名立刻指向刚上传的产物。
 *
 * 为什么要单独清缓存：`scripts/r2-dist-sync.mjs` 只负责把对象写进 R2 源站。边缘节点
 * 在缓存未过期前仍会把旧对象发给用户和发布校验步骤 —— 发布校验读到的字节数不匹配，
 * 用户下载到的是上一个版本。R2 源站换内容不会自动清边缘缓存，必须显式 purge。
 *
 * 用法:
 *   node scripts/cf-purge-cache.mjs --version 2.0.22
 *   node scripts/cf-purge-cache.mjs --everything
 *
 * 环境变量:
 *   CLOUDFLARE_PURGE_TOKEN （必需，Zone 的 Cache Purge 权限；发布用的 R2 Token 无权清缓存）
 *   CLOUDFLARE_ZONE_ID     （可选；缺省时按 CDN 域名反查，反查需要 Zone Read 权限）
 *   OMNIMUX_DIST_BASE_URL  （可选；默认 https://dl.omnimux.ai）
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CDN_BASE_URL = (process.env.OMNIMUX_DIST_BASE_URL || 'https://dl.omnimux.ai').replace(/\/$/u, '')
/** Cloudflare 单次 purge 请求最多接受 30 个 URL。 */
const PURGE_BATCH_SIZE = 30

/** 读取 Cloudflare 鉴权 Token，保持与 r2-dist-sync.mjs 相同的解析顺序。 */
function resolveCloudflareToken() {
  // The R2 upload token cannot purge zone cache, so the dedicated purge token wins when present.
  if (process.env.CLOUDFLARE_PURGE_TOKEN) return process.env.CLOUDFLARE_PURGE_TOKEN
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN
  if (process.env.CF_TOKEN) return process.env.CF_TOKEN

  const candidatePaths = [
    join(process.env.HOME || '', '.wrangler/config/default.toml'),
    join(process.env.HOME || '', 'Library/Preferences/.wrangler/config/default.toml'),
  ]
  for (const configPath of candidatePaths) {
    if (!existsSync(configPath)) continue
    const match = readFileSync(configPath, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/u)
    if (match?.[1]) return match[1]
  }
  throw new Error('未找到 Cloudflare API Token。请设置 CLOUDFLARE_API_TOKEN 环境变量或通过 wrangler 登录。')
}

async function cloudflare(token, path, init) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  const body = await response.json()
  if (!body.success) {
    const detail = (body.errors || []).map(error => `${String(error.code)} ${String(error.message)}`).join('; ')
    throw new Error(`Cloudflare API ${path} 失败: ${detail || `HTTP ${String(response.status)}`}`)
  }
  return body
}

/** 从 CDN 域名反查 zone id：区域名去掉第一段子域（dl.omnimux.ai -> omnimux.ai）。 */
async function resolveZoneId(token) {
  if (process.env.CLOUDFLARE_ZONE_ID) return process.env.CLOUDFLARE_ZONE_ID
  const host = new URL(CDN_BASE_URL).hostname
  const candidates = host.split('.').slice(1).join('.')
  const body = await cloudflare(token, `/zones?name=${encodeURIComponent(candidates)}`)
  const zone = (body.result || [])[0]
  if (!zone?.id) throw new Error(`未能解析 ${candidates} 的 zone id，请设置 CLOUDFLARE_ZONE_ID`)
  return String(zone.id)
}

/** 发布产物在 CDN 上的全部键：latest 别名 + 版本目录 + 元数据。 */
function releaseUrls(version) {
  const paths = [
    'releases/latest/OmniMux-universal.dmg',
    'releases/latest/OmniMux-arm64.dmg',
    'releases/latest/OmniMux-mac.dmg',
    'releases/latest/OmniMux-x64.dmg',
    'releases/latest/DSH-Desktop.dmg',
    'releases/latest/OmniMux-Setup.exe',
    'releases/latest/OmniMux-x64-Setup.exe',
    'releases/latest/DSH-Desktop-Setup.exe',
    'api/desktop/version-stable.json',
    'api/desktop/version-next.json',
    'plugins/dsh-index.json',
  ]
  if (version) {
    paths.push(
      `releases/v${version}/OmniMux-${version}-universal.dmg`,
      `releases/v${version}/OmniMux-${version}-arm64.dmg`,
      `releases/v${version}/OmniMux-${version}-x64.dmg`,
      `releases/v${version}/OmniMux-${version}-x64-Setup.exe`,
      `releases/v${version}/DSH-Desktop-${version}-x64-Setup.exe`,
    )
  }
  return paths.map(path => `${CDN_BASE_URL}/${path}`)
}

async function purge(token, zoneId, urls) {
  for (let index = 0; index < urls.length; index += PURGE_BATCH_SIZE) {
    const batch = urls.slice(index, index + PURGE_BATCH_SIZE)
    await cloudflare(token, `/zones/${zoneId}/purge_cache`, {
      method: 'POST',
      body: JSON.stringify({ files: batch }),
    })
    console.log(`✓ 已清理 ${String(batch.length)} 个 URL（第 ${String(index / PURGE_BATCH_SIZE + 1)} 批）`)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const versionIndex = args.indexOf('--version')
  const version = versionIndex === -1 ? undefined : args[versionIndex + 1]
  if (versionIndex !== -1 && !version) throw new Error('--version 需要一个版本号，例如 --version 2.0.22')

  const token = resolveCloudflareToken()
  const zoneId = await resolveZoneId(token)

  if (args.includes('--everything')) {
    await cloudflare(token, `/zones/${zoneId}/purge_cache`, { method: 'POST', body: JSON.stringify({ purge_everything: true }) })
    console.log('✓ 已清理 zone 全量缓存')
    return
  }

  const urls = releaseUrls(version)
  await purge(token, zoneId, urls)
  console.log(`✓ CDN 缓存已清理（${CDN_BASE_URL}，${String(urls.length)} 个 URL）`)
}

main().catch((error) => {
  process.stderr.write(`✗ ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
