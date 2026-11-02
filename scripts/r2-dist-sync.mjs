#!/usr/bin/env node
/**
 * scripts/r2-dist-sync.mjs — OmniMux 官方发布产物 Cloudflare R2 同步与分发自动化工具。
 *
 * 功能：
 *   1. 自动提取 Cloudflare 凭证（环境变量 或 本地 Wrangler OAuth 配置）。
 *   2. 支持 Windows（.exe）与 macOS（.dmg）产物批量上传到亚太 R2 存储桶 `omnimux-dist`。
 *   3. 自动生成标准化的版本路径（releases/vX.Y.Z/...）与 latest 别名路径（releases/latest/...）。
 *   4. 智能比对：相同大小产物自动秒级跳过，支持 --force 强制覆盖。
 *   5. 上传后自动对 CDN 自定义域名（https://dl.omnimux.ai）执行 HTTP 巡检与 Content-Length 校验。
 *   6. 提供 list、upload、verify 等标准化子命令，供 Agent 与 CI/CD 快速调用。
 *
 * 用法：
 *   node scripts/r2-dist-sync.mjs list
 *   node scripts/r2-dist-sync.mjs upload --version 2.0.4 --dir ./dist/release-download
 *   node scripts/r2-dist-sync.mjs verify --version 2.0.4
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID
const BUCKET_NAME = process.env.CLOUDFLARE_R2_BUCKET || 'omnimux-dist'
const CDN_BASE_URL = process.env.OMNIMUX_DIST_BASE_URL || 'https://dl.omnimux.ai'

/**
 * Resolve the Cloudflare account ID from the environment.
 *
 * The ID is deliberately not baked in as a fallback: this repository is public,
 * and a committed account identifier leaks the deployment's Cloudflare account.
 */
function resolveAccountId() {
  if (!ACCOUNT_ID) throw new Error('CLOUDFLARE_ACCOUNT_ID is required for R2 distribution commands')
  return ACCOUNT_ID
}

/**
 * 读取 Cloudflare 鉴权 Token
 */
function resolveCloudflareToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN
  if (process.env.CF_TOKEN) return process.env.CF_TOKEN

  const candidatePaths = [
    join(process.env.HOME || '', '.wrangler/config/default.toml'),
    join(process.env.HOME || '', 'Library/Preferences/.wrangler/config/default.toml'),
  ]

  for (const configPath of candidatePaths) {
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, 'utf8')
      const match = content.match(/oauth_token\s*=\s*"([^"]+)"/)
      if (match && match[1]) {
        return match[1]
      }
    }
  }

  throw new Error('未找到 Cloudflare API Token。请设置 CLOUDFLARE_API_TOKEN 环境变量或通过 wrangler 登录。')
}

/**
 * 列出 R2 存储桶中的所有对象
 */
async function listBucketObjects(token) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${resolveAccountId()}/r2/buckets/${BUCKET_NAME}/objects`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    throw new Error(`获取 R2 对象列表失败: HTTP ${res.status} ${res.statusText}`)
  }
  const data = await res.json()
  return data.result || []
}

/**
 * 解析当前 Cloudflare API Token 对应的 S3 Access Key ID（即 Token ID）。
 */
let cachedS3Creds = null
async function resolveR2S3Credentials(token) {
  if (cachedS3Creds) return cachedS3Creds
  const secretAccessKey = createHash('sha256').update(token).digest('hex')
  if (process.env.R2_ACCESS_KEY_ID) {
    cachedS3Creds = { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey }
    return cachedS3Creds
  }
  const verifyUrls = [
    `https://api.cloudflare.com/client/v4/accounts/${resolveAccountId()}/tokens/verify`,
    'https://api.cloudflare.com/client/v4/user/tokens/verify',
  ]
  for (const url of verifyUrls) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data?.result?.id) {
        cachedS3Creds = { accessKeyId: data.result.id, secretAccessKey }
        return cachedS3Creds
      }
    } catch {
      // ignore and try next endpoint
    }
  }
  return null
}

function contentTypeForKey(key) {
  if (key.endsWith('.exe')) return 'application/x-msdownload'
  if (key.endsWith('.dmg')) return 'application/x-apple-diskimage'
  if (key.endsWith('.zip')) return 'application/zip'
  // The desktop updaters parse these, so they must not arrive as octet-stream.
  if (key.endsWith('.json')) return 'application/json; charset=utf-8'
  if (key.endsWith('.txt') || key.endsWith('.yml')) return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
}

/**
 * 上传单个文件到 R2 存储桶（大文件优先走 S3 分片上传以绕过 REST API 100MB 限制，带重试机制）
 */
async function uploadObjectToR2(token, key, filePath, maxRetries = 3) {
  const stat = statSync(filePath)
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(2)
  const contentType = contentTypeForKey(key)
  const s3Creds = stat.size > 50 * 1024 * 1024 ? await resolveR2S3Credentials(token) : null

  let lastError = null
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      process.stdout.write(`  ⏳ [${attempt}/${maxRetries}] 正在上传 ${key} (${sizeMB} MB)... `)

      if (s3Creds) {
        const endpoint = `https://${resolveAccountId()}.r2.cloudflarestorage.com`
        const proc = spawnSync(
          'aws',
          ['s3', 'cp', filePath, `s3://${BUCKET_NAME}/${key}`, '--endpoint-url', endpoint, '--content-type', contentType, '--only-show-errors'],
          {
            env: {
              ...process.env,
              AWS_ACCESS_KEY_ID: s3Creds.accessKeyId,
              AWS_SECRET_ACCESS_KEY: s3Creds.secretAccessKey,
              AWS_DEFAULT_REGION: 'auto',
            },
            encoding: 'utf8',
            timeout: 15 * 60_000,
          },
        )
        if (proc.status !== 0) {
          throw new Error(`aws s3 cp failed (exit ${proc.status}): ${(proc.stderr || proc.stdout || '').trim()}`)
        }
        process.stdout.write(`✅ 成功 (S3 Multipart)\n`)
        return { etag: 's3-multipart' }
      }

      const buffer = readFileSync(filePath)
      const encodedKey = encodeURIComponent(key).replace(/%2F/g, '/')
      const url = `https://api.cloudflare.com/client/v4/accounts/${resolveAccountId()}/r2/buckets/${BUCKET_NAME}/objects/${encodedKey}`

      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Length': String(stat.size),
          'Content-Type': contentType,
        },
        body: buffer,
      })

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`HTTP ${res.status}: ${text}`)
      }

      const json = await res.json()
      if (!json.success) {
        throw new Error(`Cloudflare API 报错: ${JSON.stringify(json.errors)}`)
      }

      process.stdout.write(`✅ 成功 (ETag: ${json.result?.etag || 'ok'})\n`)
      return json.result
    } catch (err) {
      lastError = err
      process.stdout.write(`❌ 失败: ${err.message}\n`)
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 2000 * attempt))
      }
    }
  }

  throw new Error(`上传 ${key} 超过最大重试次数: ${lastError?.message}`)
}

/**
 * 校验 CDN 端直链是否正常可下载
 */
async function verifyEndpoint(key, expectedSize) {
  const url = `${CDN_BASE_URL}/${key}`
  try {
    const res = await fetch(url, { method: 'HEAD' })
    if (!res.ok) {
      return { key, url, ok: false, error: `HTTP ${res.status} ${res.statusText}` }
    }
    const contentLength = res.headers.get('content-length')
    if (expectedSize !== undefined && contentLength && Number(contentLength) !== expectedSize) {
      return {
        key,
        url,
        ok: false,
        error: `大小不匹配: 期望 ${expectedSize}，实际 CDN 返回 ${contentLength}`,
      }
    }
    return {
      key,
      url,
      ok: true,
      size: Number(contentLength || 0),
      contentType: res.headers.get('content-type'),
    }
  } catch (err) {
    return { key, url, ok: false, error: err.message }
  }
}

/**
 * 打印使用帮助
 */
function printHelp() {
  console.log(`
OmniMux R2 产物同步与分发工具

命令：
  list                              列出 R2 桶中所有现有产物
  upload [选项]                     上传本地构建产物至 R2 亚太存储桶
  verify [选项]                     巡检 CDN (https://dl.omnimux.ai) 直链可用性

选项：
  --version <vX.Y.Z>                指定发布版本（默认读取 package.json#version）
  --dir <path>                      指定产物源目录（默认查找 dist/ 与 release-download/）
  --win-exe <path>                  直接指定 Windows .exe 安装包路径
  --mac-dmg <path>                  直接指定 macOS Universal .dmg 镜像包路径
  --force                           强制重新上传已存在的同大小文件
  --skip-verify                     上传后跳过 CDN 巡检
`)
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0] || 'help'

  if (command === 'help' || args.includes('-h') || args.includes('--help')) {
    printHelp()
    return
  }

  const token = resolveCloudflareToken()

  if (command === 'list') {
    console.log(`📦 查询 Cloudflare R2 存储桶 '${BUCKET_NAME}' 产物清单...`)
    const objects = await listBucketObjects(token)
    if (objects.length === 0) {
      console.log('（存储桶当前为空）')
      return
    }
    console.log(`共 ${objects.length} 个对象：`)
    for (const obj of objects) {
      const sizeMB = (Number(obj.size) / (1024 * 1024)).toFixed(2)
      console.log(`  • ${obj.key.padEnd(50)} ${sizeMB.padStart(8)} MB   (${obj.uploaded || 'ok'})`)
    }
    return
  }

  // 解析 version
  //
  // The archive directory must be named after the version the ARTIFACT carries,
  // not the shell's package.json: this repo's root manifest is the old shell
  // (2.0.18) while the shipping Next build is 2.0.20-next, so reading the
  // manifest filed every archive under a version no user would look for
  // (issue #126). `--version` still wins when a caller states it explicitly.
  let version = null
  const versionIdx = args.indexOf('--version')
  if (versionIdx !== -1 && args[versionIdx + 1]) {
    version = args[versionIdx + 1].replace(/^v/, '')
  } else {
    try {
      const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8'))
      version = pkg.version
    } catch {
      version = '2.0.4'
    }
  }

  /** The `x.y.z[-tag]` embedded in one installer filename, or null. */
  function versionOfInstallerName(name) {
    const match = /^OmniMux-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-(?:x64-Setup\.exe|arm64\.dmg|x64\.dmg|universal\.dmg)$/u.exec(name)
    return match?.[1] ?? null
  }

  if (command === 'verify') {
    console.log(`🔍 正在巡检 https://dl.omnimux.ai 版本 v${version} 及 latest 直链...`)

    // `latest/` must be complete: every alias the landing page or an updater can
    // hit has to resolve, or a download button is dead.
    const latestKeys = [
      'releases/latest/OmniMux-Setup.exe',
      'releases/latest/OmniMux-x64-Setup.exe',
      'releases/latest/DSH-Desktop-Setup.exe',
      'releases/latest/OmniMux-arm64.dmg',
      'releases/latest/OmniMux-x64.dmg',
      'releases/latest/OmniMux-universal.dmg',
      'releases/latest/OmniMux-mac.dmg',
      'releases/latest/DSH-Desktop.dmg',
    ]

    // The archive only needs ONE reachable artifact per platform: it exists so a
    // user reporting a bad release can be handed the previous installer
    // (issue #126). Demanding all four historical aliases would fail a release
    // that only ever built one shell.
    const archiveCandidates = {
      windows: [
        `releases/v${version}/OmniMux-${version}-x64-Setup.exe`,
        `releases/v${version}/DSH-Desktop-${version}-x64-Setup.exe`,
      ],
      macos: [
        `releases/v${version}/OmniMux-${version}-arm64.dmg`,
        `releases/v${version}/OmniMux-${version}-x64.dmg`,
        `releases/v${version}/OmniMux-${version}-universal.dmg`,
        `releases/v${version}/DSH.Desktop-${version}-universal.dmg`,
      ],
    }

    let allOk = true
    for (const key of latestKeys) {
      const res = await verifyEndpoint(key)
      if (res.ok) {
        const sizeMB = (res.size / (1024 * 1024)).toFixed(2)
        console.log(`  ✅ [200 OK] ${res.url.padEnd(65)} (${sizeMB.padStart(6)} MB, ${res.contentType})`)
      } else {
        allOk = false
        console.log(`  ❌ [FAIL]   ${res.url.padEnd(65)} -> ${res.error}`)
      }
    }

    for (const [platform, keys] of Object.entries(archiveCandidates)) {
      let reachable = null
      for (const key of keys) {
        const res = await verifyEndpoint(key)
        if (res.ok) { reachable = res; break }
      }
      if (reachable !== null) {
        const sizeMB = (reachable.size / (1024 * 1024)).toFixed(2)
        console.log(`  ✅ [ARCHIVE ${platform}] ${reachable.url.padEnd(58)} (${sizeMB.padStart(6)} MB)`)
      } else {
        allOk = false
        console.log(`  ❌ [ARCHIVE ${platform}] no reachable artifact under releases/v${version}/`)
        console.log(`       Rollback to v${version} is impossible; tried: ${keys.join(', ')}`)
      }
    }

    if (!allOk) {
      process.exitCode = 1
    }
    return
  }

  if (command === 'upload') {
    const isForce = args.includes('--force')
    console.log(`🚀 开始执行 OmniMux v${version} 产物全链路同步到 R2 (dl.omnimux.ai)...`)

    // 获取当前桶内已有对象字典，实现智能跳过
    const existingObjects = await listBucketObjects(token)
    const existingMap = new Map()
    for (const obj of existingObjects) {
      existingMap.set(obj.key, Number(obj.size))
    }

    // 定位源文件
    let winExePath = null
    let macDmgPath = null

    const winIdx = args.indexOf('--win-exe')
    if (winIdx !== -1) winExePath = args[winIdx + 1]

    const macIdx = args.indexOf('--mac-dmg')
    if (macIdx !== -1) macDmgPath = args[macIdx + 1]

    const dirIdx = args.indexOf('--dir')
    const searchDir = dirIdx !== -1 ? resolve(ROOT_DIR, args[dirIdx + 1]) : null

    function walkInstallerFiles(dir) {
      if (!dir || !existsSync(dir)) return []
      const out = []
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) out.push(...walkInstallerFiles(full))
        else if (entry.isFile()) out.push(full)
      }
      return out
    }
    const discoveredFiles = walkInstallerFiles(searchDir)
    const discoveredWin = discoveredFiles.find(f => /OmniMux-.*-Setup\.exe$/u.test(basename(f)))
      ?? discoveredFiles.find(f => /-Setup\.exe$/u.test(basename(f)))
    const discoveredMacArm64 = discoveredFiles.find(f => /OmniMux-.*-arm64\.dmg$/u.test(basename(f)))
    const discoveredMacX64 = discoveredFiles.find(f => /OmniMux-.*-x64\.dmg$/u.test(basename(f)))
    const discoveredMacUniversal = discoveredFiles.find(f => /OmniMux-.*-universal\.dmg$/u.test(basename(f)))

    const candidateWinPaths = [
      winExePath,
      searchDir ? join(searchDir, `DSH-Desktop-${version}-x64-Setup.exe`) : null,
      searchDir ? join(searchDir, `OmniMux-${version}-x64-Setup.exe`) : null,
      discoveredWin,
      join(ROOT_DIR, 'dist/release-download', `DSH-Desktop-${version}-x64-Setup.exe`),
      join(ROOT_DIR, 'dist/release-download', `OmniMux-${version}-x64-Setup.exe`),
      join(ROOT_DIR, 'dsh-plugin-desktop/dist', `OmniMux-${version}-x64-Setup.exe`),
    ].filter(Boolean)

    const candidateMacArm64Paths = [
      searchDir ? join(searchDir, `OmniMux-${version}-arm64.dmg`) : null,
      discoveredMacArm64,
      join(ROOT_DIR, 'dist/release-download', `OmniMux-${version}-arm64.dmg`),
      join(ROOT_DIR, 'dsh-desktop-next/dist/mac-release', `OmniMux-${version}-arm64.dmg`),
    ].filter(Boolean)

    const candidateMacX64Paths = [
      searchDir ? join(searchDir, `OmniMux-${version}-x64.dmg`) : null,
      discoveredMacX64,
      join(ROOT_DIR, 'dist/release-download', `OmniMux-${version}-x64.dmg`),
      join(ROOT_DIR, 'dsh-desktop-next/dist/mac-release', `OmniMux-${version}-x64.dmg`),
    ].filter(Boolean)

    const candidateMacUniversalPaths = [
      macDmgPath,
      searchDir ? join(searchDir, `OmniMux-${version}-universal.dmg`) : null,
      discoveredMacUniversal,
      join(ROOT_DIR, 'dist/release-download', `OmniMux-${version}-universal.dmg`),
      join(ROOT_DIR, 'dsh-plugin-desktop/dist/mac-release', `OmniMux-${version}-universal.dmg`),
    ].filter(Boolean)

    for (const p of candidateWinPaths) {
      if (existsSync(p)) {
        winExePath = p
        break
      }
    }

    const macArtifacts = []
    for (const p of candidateMacArm64Paths) {
      if (existsSync(p)) { macArtifacts.push({ path: p, arch: 'arm64' }); break }
    }
    for (const p of candidateMacX64Paths) {
      if (existsSync(p)) { macArtifacts.push({ path: p, arch: 'x64' }); break }
    }
    for (const p of candidateMacUniversalPaths) {
      if (existsSync(p)) { macArtifacts.push({ path: p, arch: 'universal' }); break }
    }

    if (!winExePath && macArtifacts.length === 0) {
      throw new Error(`未找到任何待上传的 .exe 或 .dmg 产物文件，请检查 dist/ 或使用 --dir 参数指定。`)
    }

    // Re-derive the archive version from the artifact itself. The candidate
    // search above needs a version to build paths with, so it runs on the
    // manifest value; the key naming must not. When the two disagree (the shell
    // manifest says 2.0.18, the Next build is 2.0.20-next) an archive filed
    // under the manifest version is unreachable by anyone who knows what they
    // installed — issue #126.
    const artifactVersion = versionOfInstallerName(basename(macArtifacts[0]?.path ?? winExePath))
    if (artifactVersion !== null && artifactVersion !== version) {
      console.log(`📌 归档版本以产物为准：v${artifactVersion}（壳仓 manifest 为 v${version}）`)
      version = artifactVersion
    }

    console.log(`📌 匹配到本地待分发文件：`)
    if (winExePath) console.log(`  • Windows EXE: ${winExePath}`)
    for (const { path, arch } of macArtifacts) {
      console.log(`  • macOS ${arch} DMG: ${path}`)
    }

    const uploadPlan = []

    if (winExePath) {
      const winStat = statSync(winExePath)
      const actualWinName = basename(winExePath)
      const winKeys = new Set([
        `releases/v${version}/${actualWinName}`,
        `releases/v${version}/OmniMux-${version}-x64-Setup.exe`,
        `releases/v${version}/DSH-Desktop-${version}-x64-Setup.exe`,
        `releases/latest/OmniMux-Setup.exe`,
        `releases/latest/OmniMux-x64-Setup.exe`,
        `releases/latest/DSH-Desktop-Setup.exe`,
      ])
      for (const key of winKeys) uploadPlan.push({ key, file: winExePath, size: winStat.size })
    }

    for (const { path: macPath, arch } of macArtifacts) {
      const macStat = statSync(macPath)
      const actualMacName = basename(macPath)
      const macKeys = new Set([`releases/v${version}/${actualMacName}`])
      if (arch === 'arm64') {
        macKeys.add(`releases/v${version}/OmniMux-${version}-arm64.dmg`)
        macKeys.add(`releases/latest/OmniMux-arm64.dmg`)
        macKeys.add(`releases/latest/OmniMux-mac.dmg`)
        // Keep universal/legacy aliases pointing at arm64 when no separate universal DMG is built
        if (!macArtifacts.some(item => item.arch === 'universal')) {
          macKeys.add(`releases/latest/OmniMux-universal.dmg`)
          macKeys.add(`releases/latest/DSH-Desktop.dmg`)
        }
      } else if (arch === 'x64') {
        macKeys.add(`releases/v${version}/OmniMux-${version}-x64.dmg`)
        macKeys.add(`releases/latest/OmniMux-x64.dmg`)
      } else {
        macKeys.add(`releases/v${version}/OmniMux-${version}-universal.dmg`)
        macKeys.add(`releases/latest/OmniMux-universal.dmg`)
      }
      for (const key of macKeys) uploadPlan.push({ key, file: macPath, size: macStat.size })
    }

    // Release metadata the desktop updaters poll. It lives at a fixed path beside
    // nothing else, so it is uploaded as-is rather than under releases/.
    const metadataDir = join(searchDir ?? join(ROOT_DIR, 'dist/release-download'), 'api', 'desktop')
    if (existsSync(metadataDir)) {
      for (const name of readdirSync(metadataDir)) {
        if (!name.endsWith('.json')) continue
        const file = join(metadataDir, name)
        const stat = statSync(file)
        uploadPlan.push({ key: `api/desktop/${name}`, file, size: stat.size })
      }
      console.log(`  • 版本元数据: ${metadataDir}`)
    } else {
      console.log(`  ⚠️  未找到版本元数据目录 ${metadataDir}；应用将无法发现更新`)
    }

    // Plugin market index. Plugins ship independently of the desktop application, so
    // this object is the only thing that tells an installed build what is available.
    const indexFile = join(ROOT_DIR, 'dist', 'dsh-index.json')
    if (existsSync(indexFile)) {
      const stat = statSync(indexFile)
      uploadPlan.push({ key: 'plugins/dsh-index.json', file: indexFile, size: stat.size })
      console.log(`  • 插件索引: ${indexFile}`)
    } else {
      console.log(`  ⚠️  未找到插件索引 ${indexFile}；请先运行 scripts/build-plugin-index.mjs`)
    }

    console.log(`\n📤 开始同步 ${uploadPlan.length} 个分发节点...`)
    for (const item of uploadPlan) {
      const existingSize = existingMap.get(item.key)
      if (!isForce && existingSize === item.size) {
        console.log(`  ⚡ [已存在] ${item.key} 大小一致 (${(item.size / (1024 * 1024)).toFixed(2)} MB)，跳过上传`)
        continue
      }
      await uploadObjectToR2(token, item.key, item.file)
    }

    console.log(`\n🎉 全部产物同步完成！`)

    if (!args.includes('--skip-verify')) {
      console.log(`\n🔍 开始执行 CDN 节点直链巡检...`)
      for (const item of uploadPlan) {
        const check = await verifyEndpoint(item.key, item.size)
        if (check.ok) {
          const sizeMB = (check.size / (1024 * 1024)).toFixed(2)
          console.log(`  ✅ [200 OK] ${check.url.padEnd(65)} (${sizeMB.padStart(6)} MB)`)
        } else {
          console.log(`  ❌ [FAIL]   ${check.url.padEnd(65)} -> ${check.error}`)
        }
      }
    }

    console.log(`\n✨ 发布分发同步全链路完成！所有直链已在 dl.omnimux.ai 全球/国内边缘节点生效。`)
  }
}

main().catch(err => {
  console.error(`\n❌ 执行失败: ${err.message}`)
  process.exit(1)
})
