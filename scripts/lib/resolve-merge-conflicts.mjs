/** Merge-conflict resolver implementing the upstream-sync contract tiers.
 *
 * Reads a file with git conflict markers and classifies each conflict block:
 * - B 级 (auto-resolve): HEAD/upstream differ only in lines whose key is a
 *   known brand/identity field. `version` lines take the upstream value;
 *   every other brand line keeps the HEAD (OmniMux) value.
 * - C 级 (stop for confirmation): any structural difference — unknown keys,
 *   mismatched line counts, or non-brand source changes.
 */

/** Keys whose conflicts follow the fixed B-tier template. */
export const BRAND_KEYS = [
  'version',
  'description',
  'appId',
  'productName',
  'artifactName',
  'shortcutName',
  'PRODUCT_NAME',
  'OMNIMUX_PROFILE_NAME',
  'DEFAULT_PROFILE_NAME',
  'appUserModelId',
]

const MARKER_START = /^<{7} ?/
const MARKER_MID = /^={7}$/
const MARKER_END = /^>{7} ?/

/** Classify one conflicting line pair against the brand template.
 * @returns {'upstream'|'head'|'structural'} */
function classifyLine(headLine, upstreamLine) {
  const keyMatch = /^\s*(?:export\s+)?(?:const|let|var|readonly)?\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*[:=]/.exec(headLine)
  if (keyMatch === null) return 'structural'
  const key = keyMatch[1]
  if (!BRAND_KEYS.includes(key)) return 'structural'
  if (key === 'version') return 'upstream'
  return 'head'
}

/** Resolve every conflict block in `input`.
 * @param {string} input - file content with git conflict markers.
 * @returns {{resolved: boolean, output: string, notes: string[], reason?: string}} */
export function resolveConflicts(input) {
  const lines = input.split('\n')
  const output = []
  const notes = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!MARKER_START.test(line)) {
      output.push(line)
      i += 1
      continue
    }
    const head = []
    const upstream = []
    i += 1
    let inHead = true
    let sawMid = false
    while (i < lines.length && !MARKER_END.test(lines[i])) {
      if (MARKER_MID.test(lines[i])) {
        inHead = false
        sawMid = true
        i += 1
        continue
      }
      ;(inHead ? head : upstream).push(lines[i])
      i += 1
    }
    if (!sawMid || i >= lines.length) {
      return {
        resolved: false,
        output: input,
        notes,
        reason: 'structural: malformed conflict block (missing markers)',
      }
    }
    i += 1 // skip the end marker
    if (head.length !== upstream.length) {
      return {
        resolved: false,
        output: input,
        notes,
        reason: 'structural: conflicting sections have different line counts',
      }
    }
    const merged = []
    for (let j = 0; j < head.length; j += 1) {
      const headLine = head[j]
      const upstreamLine = upstream[j]
      if (headLine === upstreamLine) {
        merged.push(headLine)
        continue
      }
      const verdict = classifyLine(headLine, upstreamLine)
      if (verdict === 'structural') {
        return {
          resolved: false,
          output: input,
          notes,
          reason: `structural: unknown change "${headLine.trim()}" vs "${upstreamLine.trim()}"`,
        }
      }
      if (verdict === 'upstream') {
        merged.push(upstreamLine)
        notes.push(`B 级·取上游: ${upstreamLine.trim()}`)
      } else {
        merged.push(headLine)
        notes.push(`B 级·保 OmniMux: ${headLine.trim()}`)
      }
    }
    output.push(...merged)
  }
  return { resolved: true, output: output.join('\n'), notes }
}

// CLI entry: resolveConflicts <file> — rewrites the file in place when every
// block resolves; prints "RESOLVED" plus per-line notes, or the stop reason.
import { fileURLToPath } from 'node:url'
import { resolve as resolvePath } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolvePath(invokedPath) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2]
  if (target === undefined) {
    console.error('usage: resolve-merge-conflicts.mjs <file>')
    process.exit(1)
  }
  const input = readFileSync(target, 'utf8')
  const result = resolveConflicts(input)
  if (!result.resolved) {
    console.log(`STOP: ${result.reason ?? 'unknown'}`)
    process.exit(2)
  }
  if (result.notes.length > 0) {
    writeFileSync(target, result.output)
    console.log('RESOLVED')
    for (const note of result.notes) console.log(note)
  } else {
    console.log('RESOLVED (no conflicts found)')
  }
}
