/** Desktop-only omissions from the production dependency tree Electron Builder copies into the payload. */

/** Platform and every CPU architecture whose native dependencies one Next package carries. */
export interface NextPackagingTarget {
  readonly platform: NodeJS.Platform
  readonly archs: readonly string[]
}

/** Platform constraints published by an installed dependency. */
export interface RuntimePackageConstraints {
  readonly os?: readonly string[]
  readonly cpu?: readonly string[]
}

function permits(values: readonly string[] | undefined, value: string): boolean {
  if (values === undefined || values.length === 0) return true
  if (values.includes(`!${value}`)) return false
  return values.includes(value) || values.includes('any') || values.every(item => item.startsWith('!'))
}

/**
 * Match published package constraints against the release, including every universal CPU.
 * Packages without constraints remain eligible regardless of their name.
 * @param manifest - Installed package metadata.
 * @param target - Release platform and CPUs, rather than the build host.
 * @returns Omission reason when no release architecture can use the package.
 */
export function nextRuntimePackageExclusion(manifest: RuntimePackageConstraints, target: NextPackagingTarget): string | undefined {
  if (!permits(manifest.os, target.platform)) return 'package OS does not match target'
  if (!target.archs.some(arch => permits(manifest.cpu, arch))) return 'package CPU does not match target'
  return undefined
}

/**
 * Identify build and diagnostic files omitted from the packaged Next runtime.
 * Unrecognized assets and target runtime binaries are retained. Paths name the copied
 * node_modules tree, including nested package containers.
 * @param path - Path relative to the production node_modules directory.
 * @param target - Platform and CPU architectures of the packaged Electron Node runtime.
 * @returns Omission reason, or undefined when the entry must be kept.
 */
export function nextRuntimeFileExclusion(path: string, target: NextPackagingTarget): string | undefined {
  const parts = path.split(/[\\/]/u)
  if (parts.some(part => ['.bin', '.pnpm', '.modules.yaml', '.pnpm-workspace-state-v1.json', '.yarn-state.yml'].includes(part))) {
    return 'package-manager metadata'
  }
  const file = parts.at(-1) ?? ''
  if (/\.(?:[cm]?[jt]s|css)\.map$/u.test(file)) return 'source map'
  if (/\.d\.[cm]?ts$/u.test(file)) return 'TypeScript declaration'
  if (/\.tsbuildinfo$/u.test(file)) return 'TypeScript build cache'
  const packageParts = parts.slice(parts.lastIndexOf('node_modules') + 1)
  const nameParts = packageParts[0]?.startsWith('@') ? 2 : 1
  const name = packageParts.slice(0, nameParts).join('/')
  const entry = packageParts.slice(nameParts).join('/')
  const targets = target.archs.map(arch => `${target.platform}-${arch}`)
  // pnpm vendors these optional prebuilds inside dist/node_modules, outside the manifest closure.
  const reflink = /^@reflink\/reflink-(darwin|linux|win32)-(x64|arm64|ia32)(?:-(?:gnu|musl|msvc))?$/u.exec(name)
  if (reflink !== null && !targets.includes(`${reflink[1]}-${reflink[2]}`)) return 'Reflink other platform or architecture'
  const officeEngines = target.platform === 'linux' ? ['wasm'] : targets
  if (name.startsWith('@deepseek-ai/libreoffice-kit-')) {
    if (!officeEngines.some(suffix => name === `@deepseek-ai/libreoffice-kit-${suffix}`)) return 'LibreOffice other platform'
  }
  if (name === 'fs-ext' && /^build\/(?:Release|Debug)\/(?:obj(?:\/|$)|fs_ext\.(?:exp|lib|pdb|iobj|ipdb)$)/u.test(entry)) {
    return 'fs-ext compiler output'
  }
  if (name === 'fs-ext' && /^build\/(?:binding\.sln|config\.gypi|fs_ext\.vcxproj(?:\.filters)?)$/u.test(entry)) {
    return 'fs-ext build configuration'
  }
  if (name === '@mixmark-io/domino' && (entry === 'test' || entry.startsWith('test/'))) return 'Domino test fixtures'
  if (name === '@mixmark-io/domino' && (entry === '.yarn' || entry.startsWith('.yarn/'))) return 'Domino development tooling'
  if (name === 'node-pty' && target.platform !== 'win32' && /^third_party\/conpty(?:\/|$)/u.test(entry)) {
    return 'node-pty Windows ConPTY sources'
  }
  if (name === 'node-pty' && entry.startsWith('third_party/conpty/')) {
    const arch = entry.split('/').find(part => /^win10-(?:x64|arm64|ia32)$/u.test(part))?.slice('win10-'.length)
    if (arch !== undefined && !target.archs.includes(arch)) return 'node-pty ConPTY other architecture'
  }
  if (name === 'node-pty' && entry.startsWith('prebuilds/')) {
    const platform = packageParts[nameParts + 1]
    if (platform !== undefined && !targets.includes(platform)) return 'node-pty other platform'
    if (file.endsWith('.pdb')) return 'node-pty debug symbols'
  }
  if (name === '@koromix/koffi-win32-x64' && entry === 'win32_x64/koffi.lib') return 'Koffi import library'
  return undefined
}

/**
 * Packages the shipped app does not load, excluded so their weight never reaches
 * the installer.
 *
 * Each entry is a whole feature this release line does not ship:
 *  - `dsh-office-to-pdf` / `dsh-skill-office` pull `libreoffice-kit`, 305 MB of
 *    dual-architecture LibreOffice binaries for Office document preview.
 *  - the voice-input bundle pulls `sherpa-onnx`, 69 MB of speech models.
 *  - `@dataiku/uv` is the Python runtime the Agents Anywhere bridge uses; that
 *    bridge is an optional profile bundle this line does not enable.
 *
 * Excluding a package here is only half the change: the matching `cordis.patch.yml`
 * row must be disabled too, or the Host fails to resolve a bundle that the profile
 * still lists. `dsh-desktop-next/tests/payload-exclusions.spec.ts` pins that pairing.
 */
const UNUSED_FEATURE_PACKAGES: readonly (readonly [RegExp, string])[] = [
  [/^@deepseek-ai\/dsh-office-to-pdf$/u, 'Office preview is not shipped'],
  [/^@deepseek-ai\/dsh-skill-office$/u, 'Office skill is not shipped'],
  [/^@deepseek-ai\/libreoffice-kit(?:-|$)/u, 'LibreOffice runtime for the unshipped Office preview'],
  [/^@deepseek-ai\/dsh-experimental-voice-input-bundle$/u, 'Voice input is not shipped'],
  [/^@deepseek-ai\/dsh-experimental-speech-to-text(?:-|$)/u, 'Speech-to-text runtime for the unshipped voice input'],
  [/^sherpa-onnx(?:-|$)/u, 'Speech model runtime for the unshipped voice input'],
  [/^@dataiku\/uv(?:-|$)/u, 'Python runtime for the unshipped Agents Anywhere bridge'],
]

/**
 * Report a package this release line deliberately does not ship.
 * @param name - Installed package name.
 * @returns Omission reason, or undefined when the package may ship.
 */
export function nextRuntimeUnusedFeatureExclusion(name: string): string | undefined {
  for (const [pattern, reason] of UNUSED_FEATURE_PACKAGES) {
    if (pattern.test(name)) return reason
  }
  return undefined
}

/**
 * Every package name pattern the exclusion table covers, for tests and docs.
 * @returns The patterns as source strings.
 */
export function nextRuntimeUnusedFeaturePatterns(): readonly string[] {
  return UNUSED_FEATURE_PACKAGES.map(([pattern]) => pattern.source)
}
