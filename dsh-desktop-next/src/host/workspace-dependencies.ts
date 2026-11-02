/** Bundled workspace dependencies (Python, Node.js, pnpm) for the Next profile; ported from upstream Desktop's Host composition. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import * as workspaceDependencies from '@deepseek-ai/dsh-tool-workspace-dependencies'
import { insideArchive } from '../asar-archive-policy.ts'

/** Loader identity for the application-owned workspace dependency composition. */
export const name = 'desktop-workspace-dependencies'

/** Application-selected bundled payload and installation directories. */
export interface Config {
  /** Bundled payload directory. */
  readonly source: string
  /** Directory under the Next home receiving the installed payload. */
  readonly root: string
}

/**
 * Installation name under `<home>/dsh-runtimes`. Next shares `~/.dsh` with the official Desktop, and the
 * tool replaces an installation whose manifest differs, so each edition keeps its own directory.
 */
export const PRIMARY_RUNTIME_INSTALL_NAME = 'dsh-next-primary-runtime'

/**
 * Resolve the workspace dependency composition for one Host start.
 * @param runtimeDir - Application directory; the archive itself when packaged.
 * @param source - Bundled payload directory the shell selected for this CPU.
 * @param home - Next home receiving the installation.
 * @returns The configuration, or undefined for a development tree whose payload was not prepared.
 * @throws For a packaged Host started without a payload path.
 */
export function resolveWorkspaceDependenciesConfig(runtimeDir: string, source: string | undefined, home: string): Config | undefined {
  const packaged = insideArchive(runtimeDir)
  if (source === undefined) {
    if (packaged) throw new Error('Next Host requires the bundled primary runtime path')
    return undefined
  }
  if (!packaged && !existsSync(join(source, 'runtime.json'))) return undefined
  return { source, root: join(home, 'dsh-runtimes', PRIMARY_RUNTIME_INSTALL_NAME) }
}

/**
 * Offer the bundled Python, Node.js and pnpm payload through `load_workspace_dependencies`.
 * Office skills are not mounted: this release line does not ship the Office feature, and
 * `scripts/runtime-file-policy.ts` keeps its packages out of the payload.
 * @param ctx - Profile scope; the tool declares its own service requirements.
 * @param config - Bundled payload source and installation root.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.plugin(workspaceDependencies, config)
}
