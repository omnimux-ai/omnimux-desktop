#!/usr/bin/env node
/**
 * Upload the market catalog assets to the distribution bucket.
 *
 * The cover art is 130 MB of images that used to be bundled inside the npm package,
 * which pushed it to 142 MB and made `npm publish` abort with EPIPE. They live on the
 * CDN instead, keyed by their catalog-relative path, and the plugin rewrites a missing
 * bundled path to this location.
 *
 * curl aborts larger files against the Cloudflare API with an HTTP/2 framing error and
 * an empty reply, so this uses Node's fetch like `r2-dist-sync.mjs` does.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/upload-market-assets.mjs --dir <catalog dir>
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { resolve } from 'node:path'

const BUCKET = 'omnimux-dist'
/** Key prefix the plugin resolves against; see MARKET_ASSET_CDN in the market plugin. */
const PREFIX = 'market'

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

function contentType(path) {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.webp': return 'image/webp'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.svg': return 'image/svg+xml'
    case '.json': return 'application/json; charset=utf-8'
    default: return 'application/octet-stream'
  }
}

/** Walk a directory and return every regular file with its path relative to `root`. */
function walk(root, dir = root) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(root, full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required')
  if (!account) throw new Error('CLOUDFLARE_ACCOUNT_ID is required')

  const dir = resolve(arg('--dir', 'catalog'))
  const only = arg('--only')
  const files = walk(dir).filter(file => only === undefined || relative(dir, file).startsWith(only))
  console.log(`uploading ${String(files.length)} file(s) from ${dir}`)

  let uploaded = 0
  let skipped = 0
  for (const file of files) {
    const key = `${PREFIX}/${relative(dir, file).split('\\').join('/')}`
    const body = readFileSync(file)
    let lastError = 'unknown'
    let ok = false
    // Uploads in a tight loop reuse a connection the API closes between requests, so a
    // single attempt fails intermittently with UND_ERR_SOCKET. Retry rather than abort.
    for (let attempt = 1; attempt <= 4 && !ok; attempt += 1) {
      try {
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${BUCKET}/objects/${key}`,
          {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType(file), Connection: 'close' },
            body,
          },
        )
        if (response.ok) { ok = true; break }
        lastError = `${String(response.status)} ${(await response.text()).slice(0, 160)}`
      } catch (error) {
        lastError = String(error?.cause?.code ?? error?.message ?? error)
      }
      await new Promise(done => setTimeout(done, 250 * attempt))
    }
    if (ok) uploaded += 1
    else { skipped += 1; console.error(`FAIL ${key}: ${lastError}`) }
  }
  console.log(`uploaded ${String(uploaded)}, failed ${String(skipped)}`)
  if (skipped > 0) process.exitCode = 1
}

await main()
