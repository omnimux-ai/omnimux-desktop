#!/usr/bin/env node
/**
 * Generate the OmniMux plugin market index.
 *
 * The official DSH market index is a community-maintained JSON file served over
 * jsDelivr. This script builds our own, so plugin discovery does not depend on a
 * third-party repository staying online or accepting our entries.
 *
 * Output shape mirrors the official `format: 1` schema so the same client code
 * reads both.
 *
 * Usage:
 *   node scripts/build-plugin-index.mjs                 # write dist/dsh-index.json
 *   node scripts/build-plugin-index.mjs --check         # verify only, exit 1 on drift
 *   node scripts/build-plugin-index.mjs --out <path>    # custom output path
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marketablePlugins, withheldPlugins } from './plugin-tiers.mjs'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Publication timestamp recorded on every version entry.
 *
 * Format 1 requires an integer Unix-seconds value. It is derived from the plugin
 * manifest's mtime rather than "now" so that regenerating an unchanged index is a
 * no-op and `--check` stays meaningful.
 */
function publishTimestamp(pluginsRoot, dir) {
  try {
    return Math.floor(statSync(join(pluginsRoot, dir, 'package.json')).mtimeMs / 1000)
  } catch {
    return Math.floor(Date.now() / 1000)
  }
}

/**
 * Normalize a manifest repository URL to the plain http(s) form format 1 accepts.
 *
 * npm manifests commonly carry a `git+https://…` prefix and a trailing `.git`;
 * the index validator rejects both.
 */
function repositoryHref(value) {
  const raw = typeof value === "string" ? value : value?.url
  if (typeof raw !== "string" || raw.length === 0) return undefined
  const href = raw.replace(/^git\+/u, "").replace(/\.git$/u, "")
  return /^https?:\/\//u.test(href) ? href : undefined
}

/**
 * Plugins we know how to describe. Whether one actually ships is decided by
 * `config/plugin-tiers.json`: only the `preview` tier is published. Keeping the
 * copy here (titles, categories) separate from the shipping decision is what
 * lets a plugin move to `beta` without deleting its metadata.
 */
const DESCRIBED_PLUGINS = [
  {
    dir: 'omnimux',
    category: 'core',
    title: { en: 'OmniMux', zh: 'OmniMux' },
    description: {
      en: 'The OmniMux hub: apps, taskboard, expert gallery and the shell entries every other OmniMux plugin attaches to.',
      zh: 'OmniMux 中枢：应用、任务看板、专家馆，以及其他 OmniMux 插件依附的壳入口。',
    },
  },
  {
    dir: 'omnimux-market',
    category: 'market',
    title: { en: 'OmniMux Market', zh: 'OmniMux Market' },
    description: {
      en: 'Browse and install OmniMux plugins from the market index.',
      zh: '从市场索引浏览并安装 OmniMux 插件。',
    },
  },
  {
    dir: 'omnimux-accounts',
    category: 'core',
    title: { en: 'OmniMux Accounts', zh: 'OmniMux Accounts' },
    description: {
      en: 'Account and session management for OmniMux.',
      zh: 'OmniMux 账号与会话管理。',
    },
  },
  {
    dir: 'omnimux-analytics',
    category: 'feature',
    title: { en: 'OmniMux Analytics', zh: 'OmniMux Analytics' },
    description: {
      en: 'Usage analytics for OmniMux workspaces.',
      zh: 'OmniMux 工作区使用分析。',
    },
  },
  {
    dir: 'omnimux-assets',
    category: 'feature',
    title: { en: 'OmniMux Assets', zh: 'OmniMux Assets' },
    description: {
      en: 'Asset library and cloud catalog for OmniMux.',
      zh: 'OmniMux 资产库与云端目录。',
    },
  },
  {
    dir: 'omnimux-clip',
    category: 'feature',
    title: { en: 'OmniMux Clip', zh: 'OmniMux Clip' },
    description: {
      en: 'Clip and short-video production tools.',
      zh: '片段与短视频制作工具。',
    },
  },
  {
    dir: 'omnimux-forms',
    category: 'feature',
    title: { en: 'OmniMux Forms', zh: 'OmniMux Forms' },
    description: {
      en: 'Form building and collection.',
      zh: '表单构建与收集。',
    },
  },
  {
    dir: 'omnimux-inspiration',
    category: 'feature',
    title: { en: 'OmniMux Inspiration', zh: 'OmniMux Inspiration' },
    description: {
      en: 'Inspiration gallery and reference collection.',
      zh: '灵感馆与参考素材收集。',
    },
  },
  {
    dir: 'omnimux-products',
    category: 'feature',
    title: { en: 'OmniMux Products', zh: 'OmniMux Products' },
    description: {
      en: 'Product catalog and listing tools.',
      zh: '商品目录与上架工具。',
    },
  },
  {
    dir: 'omnimux-publish',
    category: 'feature',
    title: { en: 'OmniMux Publish', zh: 'OmniMux Publish' },
    description: {
      en: 'Multi-channel publishing for OmniMux content.',
      zh: 'OmniMux 内容多渠道发布。',
    },
  },
  {
    dir: 'omnimux-video',
    category: 'feature',
    title: { en: 'OmniMux Video', zh: 'OmniMux Video' },
    description: {
      en: 'Video generation and editing.',
      zh: '视频生成与编辑。',
    },
  },
  {
    dir: 'omnimux-workflow',
    category: 'feature',
    title: { en: 'OmniMux Workflow', zh: 'OmniMux Workflow' },
    description: {
      en: 'Workflow orchestration for OmniMux.',
      zh: 'OmniMux 工作流编排。',
    },
  },
]

function readManifest(pluginsRoot, dir) {
  const path = join(pluginsRoot, dir, 'package.json')
  if (!existsSync(path)) throw new Error(`missing plugin manifest: ${path}`)
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error(`${path} must declare string name and version`)
  }
  if (manifest.private === true) throw new Error(`${path} is private and cannot be published`)
  return manifest
}

/**
 * Confirm the exact version an entry names is actually installable.
 *
 * The index is only useful if `name@version` resolves: the market client builds that
 * spec verbatim, so publishing an entry for an unpublished version sends every user
 * who clicks install into a 404.
 */
async function assertPublished(name, version) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name).replace(/^%40/u, '@')}`
  let payload
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (response.status === 404) throw new Error(`${name} is not published on npm`)
    if (!response.ok) throw new Error(`npm registry answered ${String(response.status)} for ${name}`)
    payload = await response.json()
  } catch (error) {
    throw new Error(`cannot verify ${name}@${version}: ${error.message}`)
  }
  const versions = Object.keys(payload?.versions ?? {})
  if (!versions.includes(version)) {
    throw new Error(`${name}@${version} is not published on npm (available: ${versions.join(', ') || 'none'})`)
  }
}

function entryFor(pluginsRoot, spec) {
  const manifest = readManifest(pluginsRoot, spec.dir)
  const repositoryUrl = repositoryHref(manifest.repository)
  const entry = {
    name: manifest.name,
    title: spec.title,
    description: spec.description,
    author: 'OmniMux',
    metadata: {
      category: spec.category,
      keywords: ['dsh', 'deepseek-harness', 'bundle', 'cordis', 'omnimux'],
    },
    versions: [
      {
        version: manifest.version,
        // Format 1 requires a publication timestamp; a git source additionally needs
        // a 40-hex commit, which we do not track here, so npm is the only honest shape.
        publishTimestamp: publishTimestamp(pluginsRoot, spec.dir),
        source: { type: 'npm' },
      },
    ],
  }
  if (typeof manifest.homepage === 'string') entry.homepage = manifest.homepage
  if (repositoryUrl) entry.repository = { url: repositoryUrl }
  return entry
}

/**
 * The entries this index publishes: described plugins whose tier is `preview`.
 *
 * A preview plugin with no description is NOT an error: `dsh-better-sidebar` is a
 * third-party community plugin we preinstall but do not market, and the market
 * only lists what we author. A preview plugin that is also withheld IS an error,
 * because the tier file would then contradict itself.
 */
function publishedSpecs() {
  const preview = new Set(marketablePlugins())
  const withheld = new Set(withheldPlugins())
  const contradictory = [...preview].filter(name => withheld.has(name))
  if (contradictory.length > 0) {
    throw new Error(`plugin-tiers.json puts these plugins in preview and a withheld tier: ${contradictory.join(', ')}`)
  }
  return DESCRIBED_PLUGINS.filter(spec => preview.has(spec.dir))
}

function buildIndex(pluginsRoot) {
  return {
    format: 1,
    title: { en: 'OmniMux Plugin Market', zh: 'OmniMux 插件市场' },
    description: {
      en: 'Plugins reviewed and published by the OmniMux team.',
      zh: '由 OmniMux 团队审核并发布的插件。',
    },
    // Every category a plugin names must be declared here first: the format-1
    // validator rejects a `metadata.category` that references an unknown id.
    metadata: {
      categories: {
        core: { title: { en: 'Core', zh: '核心' } },
        market: { title: { en: 'Market', zh: '市场' } },
        feature: { title: { en: 'Features', zh: '功能' } },
      },
    },
    plugins: publishedSpecs().map(spec => entryFor(pluginsRoot, spec)),
  }
}

async function main() {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const outIndex = args.indexOf('--out')
  const outPath = outIndex === -1 ? join(ROOT_DIR, 'dist', 'dsh-index.json') : resolve(args[outIndex + 1])

  // Plugin sources live either in the sibling product tree (day-to-day work) or in
  // the staged preset copy (packaging and CI). Walk up from the repo root so a
  // worktree under .worktrees/ resolves the same siblings as the main checkout.
  const ancestors = []
  for (let dir = ROOT_DIR; dir !== dirname(dir); dir = dirname(dir)) ancestors.push(dir)
  const candidates = [
    process.env.OMNIMUX_PLUGINS_DIR,
    join(ROOT_DIR, 'dsh-desktop-next', 'node_modules'),
    ...ancestors.map(dir => join(dir, 'dsh-plugin', 'product', 'omnimux-dsh', 'plugins')),
    join(ROOT_DIR, 'dsh-plugin-desktop', 'preset', 'plugins'),
  ].filter(Boolean)
  const pluginsRoot = candidates.find(dir => existsSync(dir) && marketablePlugins().every(name => existsSync(join(dir, name, 'package.json'))))
    ?? candidates.find(dir => existsSync(dir))
  if (!pluginsRoot) throw new Error(`cannot locate the plugin sources; tried:\n  ${candidates.join('\n  ')}`)

  const index = buildIndex(pluginsRoot)
  // An entry naming an unpublished version sends every user who clicks install into a
  // 404, so confirm each one resolves before it ships. `--offline` skips the check for
  // air-gapped runs; it must never be used for a real publish.
  if (!args.includes('--offline')) {
    for (const plugin of index.plugins) {
      await assertPublished(plugin.name, plugin.versions[0].version)
    }
  } else {
    console.warn('skipping the npm publish check (--offline)')
  }
  // Validate with the reader's own parser before anything is written. A generator
  // that only round-trips its own output cannot notice a format violation, and the
  // market client would be the first to find out.
  const { parseMarketIndex } = await import(
    join(ROOT_DIR, 'dsh-desktop-next', 'node_modules', '@deepseek-ai', 'dsh-plugin-market-index', 'lib', 'index.js')
  )
  try {
    parseMarketIndex(index, 'https://dl.omnimux.ai/plugins/dsh-index.json')
  } catch (error) {
    throw new Error(`generated index violates format 1: ${error.message}${error.path ? ` (at ${error.path})` : ''}`)
  }
  const serialized = `${JSON.stringify(index, null, 2)}\n`

  if (check) {
    if (!existsSync(outPath)) throw new Error(`index not found at ${outPath}; run without --check first`)
    const current = readFileSync(outPath, 'utf8')
    if (current !== serialized) throw new Error(`${outPath} is stale; regenerate it`)
    console.log(`plugin index is current: ${String(index.plugins.length)} plugins`)
    return
  }

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, serialized)
  console.log(`wrote ${outPath} (${String(index.plugins.length)} plugins from ${pluginsRoot})`)
  for (const plugin of index.plugins) console.log(`  - ${plugin.name}@${plugin.versions[0].version}`)
}

await main()
