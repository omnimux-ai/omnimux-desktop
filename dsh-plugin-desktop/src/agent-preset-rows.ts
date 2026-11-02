/**
 * Compose the Loader rows that carry the OmniMux agent presets into a profile.
 *
 * dsh 0.1.7-alpha.1 replaced filesystem preset discovery with declarations
 * carried by patch files (`@deepseek-ai/dsh-web-app/presets/*.patch.yml`), and
 * `@deepseek-ai/dsh-agent-presets` — the plugin that used to scan
 * `<home>/.agent-presets` and the profile's `roots` — no longer ships. The
 * product presets still reach the bundle (`preset/agent-presets`), so the
 * profile has to declare them itself or every session naming one fails with
 * `agent-preset/not-found`.
 *
 * Three rules keep the declarations bootable against a moving kernel:
 * - a preset the upstream bundle already declares is skipped: two rows for one
 *   preset id is a duplicate-`config.id` registration, and the row id itself
 *   (`preset-standard`, …) collides first;
 * - a plugin row whose package the installation cannot resolve is dropped, so a
 *   preset written against another harness version still loads;
 * - `tool-subagent` rows lose the config the current kernel rejects outright
 *   (`persona`, `toolFilter`), because one throw fails the whole preset.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAllDocuments } from 'yaml'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/** One Loader entry as the include patch list spells it. */
type PresetRow = NonNullable<PatchOptions['insert']>[number]

/** Loader row name that declares one agent preset. */
export const AGENT_PRESET_DECLARATION_PACKAGE = '@deepseek-ai/dsh-agent-preset'

/** OS-chooser backend of the directory-picker seam. */
export const NATIVE_PICKER_BACKEND = '@deepseek-ai/dsh-host-directory-picker-native'
/** Client surface that renders the native chooser result. */
export const NATIVE_PICKER_SURFACE = '@deepseek-ai/dsh-client-ui-directory-picker-native'

/** Package whose rc.3 kernel fixed the subagent config schema. */
const SUBAGENT_PACKAGE = '@deepseek-ai/dsh-tool-subagent'
/** Config fields `tool-subagent` throws on instead of ignoring. */
const REJECTED_SUBAGENT_FIELDS = ['persona', 'toolFilter'] as const
/** Row-id prefix that cannot collide with upstream's `preset-<id>` rows. */
const PRESET_ROW_ID_PREFIX = 'omnimux-preset-'
/** Declarations live beside the kernel bundle that consumes them. */
const PRESET_DECLARATION_PACKAGE = '@deepseek-ai/dsh-web-app'
const PRESET_DECLARATION_DIRNAME = 'presets'

/** YAML tag the loader evaluates at boot; the parser must keep it as data. */
const loaderJsExprTag = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (value: string) => ({ __jsExpr: value }),
}

/** Result of one composition attempt, split so callers can report what changed. */
export interface AgentPresetRowComposition {
  /** Insert rows to mount, already pruned for this installation. */
  readonly rows: readonly PresetRow[]
  /** Preset ids skipped because the upstream bundle declares them. */
  readonly skippedPresetIds: readonly string[]
  /** Plugin package names dropped because the installation cannot resolve them. */
  readonly droppedPackages: readonly string[]
  /** Preset ids whose `tool-subagent` config was reduced to the current schema. */
  readonly reducedPresetIds: readonly string[]
}

/** Inputs of the pure row composition; every filesystem fact is injected. */
export interface AgentPresetRowInputs {
  /** Preset ids with a directory under the shipped preset root. */
  readonly presetIds: readonly string[]
  /** Read one preset's `preset.yml` and `agent.cordis.yml`, as parsed data. */
  readonly readPreset: (id: string) => {
    readonly manifest: Record<string, unknown> | undefined
    readonly plugins: readonly unknown[] | undefined
  }
  /** Preset ids the upstream bundle already declares. */
  readonly upstreamPresetIds: ReadonlySet<string>
  /** Whether the installation can resolve one package specifier. */
  readonly resolvable: (name: string) => boolean
}

/** Read one YAML document, keeping `!!js` values as loader expressions. */
function readYamlDocument(path: string): unknown {
  const documents = parseAllDocuments(readFileSync(path, 'utf8'), { customTags: [loaderJsExprTag] })
  const [document] = documents
  if (document === undefined) return undefined
  if (document.errors.length > 0) {
    throw new Error(`cannot parse ${path}: ${document.errors[0]?.message ?? 'invalid YAML'}`)
  }
  return document.toJS()
}

/** Narrow one parsed value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !('__jsExpr' in value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read a row's `name` without trusting arbitrary YAML values. */
function rowName(row: Record<string, unknown>): string | undefined {
  const name = row.name
  return typeof name === 'string' && name.length > 0 ? name : undefined
}

/**
 * Strip the config fields the current `tool-subagent` rejects.
 *
 * The kernel throws on `persona`/`toolFilter` rather than ignoring them, and a
 * single throwing row fails the preset that carries it, so the declaration has
 * to drop them for the preset to mount at all.
 * @param row - One parsed plugin row.
 * @returns The row with rejected fields removed.
 */
export function reduceSubagentRow(row: Record<string, unknown>): Record<string, unknown> {
  const config = asRecord(row.config)
  if (config === undefined) return row
  const kept = { ...config }
  let changed = false
  for (const field of REJECTED_SUBAGENT_FIELDS) {
    if (!Object.hasOwn(kept, field)) continue
    delete kept[field]
    changed = true
  }
  return changed ? { ...row, config: kept } : row
}

/**
 * Drop plugin rows this installation cannot load, recursively through groups.
 * @param plugins - One preset's parsed plugin list.
 * @param resolvable - Package-specifier probe of the installation.
 * @returns The surviving rows and the package names that were dropped.
 */
export function prunePresetPlugins(
  plugins: readonly unknown[],
  resolvable: (name: string) => boolean,
): { readonly plugins: readonly unknown[]; readonly dropped: readonly string[] } {
  const dropped: string[] = []
  const visit = (rows: readonly unknown[]): Record<string, unknown>[] => {
    const kept: Record<string, unknown>[] = []
    for (const value of rows) {
      const row = asRecord(value)
      if (row === undefined) continue
      const name = rowName(row)
      if (name !== undefined && name.startsWith('@') && !resolvable(name)) {
        dropped.push(name)
        continue
      }
      let next = name === SUBAGENT_PACKAGE ? reduceSubagentRow(row) : row
      const config = next.config
      if (Array.isArray(config)) next = { ...next, config: visit(config) }
      kept.push(next)
    }
    return kept
  }
  return { plugins: visit(plugins), dropped }
}

/**
 * Compose the insert rows for every shipped preset this profile must declare.
 * @param inputs - Preset inventory, parsed preset reader, and installation facts.
 * @returns Rows plus what the composition skipped or reduced.
 */
export function composeAgentPresetRows(inputs: AgentPresetRowInputs): AgentPresetRowComposition {
  const rows: PresetRow[] = []
  const skippedPresetIds: string[] = []
  const droppedPackages: string[] = []
  const reducedPresetIds: string[] = []
  for (const id of [...inputs.presetIds].sort()) {
    if (inputs.upstreamPresetIds.has(id)) {
      skippedPresetIds.push(id)
      continue
    }
    const preset = inputs.readPreset(id)
    const source = preset.plugins
    if (source === undefined) continue
    const pruned = prunePresetPlugins(source, inputs.resolvable)
    if (pruned.dropped.length > 0) droppedPackages.push(...pruned.dropped)
    if (pruned.plugins.some((row, index) => row !== source[index])) reducedPresetIds.push(id)
    const manifest = preset.manifest ?? {}
    const config: Record<string, unknown> = { id, plugins: pruned.plugins }
    for (const field of ['name', 'description', 'order'] as const) {
      if (manifest[field] !== undefined) config[field] = manifest[field]
    }
    rows.push({ id: `${PRESET_ROW_ID_PREFIX}${id}`, name: AGENT_PRESET_DECLARATION_PACKAGE, config })
  }
  return {
    rows,
    skippedPresetIds: [...new Set(skippedPresetIds)].sort(),
    droppedPackages: [...new Set(droppedPackages)].sort(),
    reducedPresetIds: [...new Set(reducedPresetIds)].sort(),
  }
}

/** Resolve the shipped preset root from the shell's own module URL. */
export function shippedAgentPresetRoot(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL('../preset/agent-presets', moduleUrl))
}

/**
 * Preset ids the upstream bundle already declares.
 *
 * Declaring one again would duplicate both the Loader row id and the preset id,
 * and the loader refuses to boot on the first duplicate.
 * @param moduleUrl - Module URL used to resolve the kernel bundle.
 * @returns Preset ids carried by the bundle's own patch files.
 */
export function upstreamAgentPresetIds(moduleUrl: string = import.meta.url): ReadonlySet<string> {
  let directory: string
  try {
    const require = createRequire(moduleUrl)
    directory = join(dirname(require.resolve(`${PRESET_DECLARATION_PACKAGE}/package.json`)), PRESET_DECLARATION_DIRNAME)
  } catch {
    return new Set()
  }
  if (!existsSync(directory)) return new Set()
  const ids = new Set<string>()
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith('.patch.yml') && !entry.endsWith('.patch.yaml')) continue
    let document: unknown
    try {
      document = readYamlDocument(join(directory, entry))
    } catch {
      continue
    }
    if (!Array.isArray(document)) continue
    for (const patch of document) {
      const record = asRecord(patch)
      const insert = record?.insert
      if (!Array.isArray(insert)) continue
      for (const row of insert) {
        const parsed = asRecord(row)
        if (parsed === undefined || rowName(parsed) !== AGENT_PRESET_DECLARATION_PACKAGE) continue
        const id = asRecord(parsed.config)?.id
        if (typeof id === 'string' && id.length > 0) ids.add(id)
      }
    }
  }
  return ids
}

/**
 * Read the presets the bundle ships and compose their declaration rows.
 * @param options.moduleUrl - Shell module URL anchoring preset and kernel lookups.
 * @param options.presetRoot - Override for tests.
 * @param options.resolvable - Override for tests.
 * @returns Composition result; empty rows when no preset ships.
 */
export function composeShippedAgentPresetRows(options: {
  readonly moduleUrl?: string
  readonly presetRoot?: string
  readonly resolvable?: (name: string) => boolean
} = {}): AgentPresetRowComposition {
  const moduleUrl = options.moduleUrl ?? import.meta.url
  const presetRoot = options.presetRoot ?? shippedAgentPresetRoot(moduleUrl)
  const require = createRequire(moduleUrl)
  const resolvable = options.resolvable ?? ((name: string): boolean => {
    try {
      require.resolve(name)
      return true
    } catch {
      return false
    }
  })
  if (!existsSync(presetRoot)) {
    return { rows: [], skippedPresetIds: [], droppedPackages: [], reducedPresetIds: [] }
  }
  const presetIds = readdirSync(presetRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
  const readPreset = (id: string): { manifest: Record<string, unknown> | undefined; plugins: readonly unknown[] | undefined } => {
    const directory = join(presetRoot, id)
    const manifestPath = join(directory, 'preset.yml')
    const cordisPath = join(directory, 'agent.cordis.yml')
    const manifest = existsSync(manifestPath) ? asRecord(readYamlDocument(manifestPath)) : undefined
    const plugins = existsSync(cordisPath) ? readYamlDocument(cordisPath) : undefined
    return { manifest, plugins: Array.isArray(plugins) ? plugins : undefined }
  }
  return composeAgentPresetRows({
    presetIds,
    readPreset,
    upstreamPresetIds: upstreamAgentPresetIds(moduleUrl),
    resolvable,
  })
}

/**
 * Wrap the composed rows as the one patch that mounts them.
 * @param composition - Result of {@link composeShippedAgentPresetRows}.
 * @returns Patch list, empty when nothing ships.
 */
export function agentPresetPatchOptions(composition: AgentPresetRowComposition): PatchOptions[] {
  return composition.rows.length === 0 ? [] : [{ insert: [...composition.rows] }]
}
