import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import * as desktopWorkspaceDependencies from '../src/host/workspace-dependencies.ts'
import { PRIMARY_RUNTIME_INSTALL_NAME, resolveWorkspaceDependenciesConfig } from '../src/host/workspace-dependencies.ts'

it('mounts only the workspace dependency tool, and removes it on disposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'next-workspace-dependencies-'))
  const ctx = new Context()
  try {
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    expect('default' in desktopWorkspaceDependencies).toBe(false)
    expect(ctx.loader.unwrapExports(desktopWorkspaceDependencies)).toBe(desktopWorkspaceDependencies)
    const modules = new Map<string, unknown>([
      ['agents', AgentRegistry], ['systemPrompt', SystemPrompt], ['tools', ToolRuntime], ['dependencies', desktopWorkspaceDependencies],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected plugin ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    const config = join(root, 'cordis.yml')
    await writeFile(config, [
      '- name: agents', '- name: systemPrompt', '- name: tools', '- name: dependencies',
      '  config:', `    source: ${JSON.stringify(join(root, 'runtime', 'arm64', 'primary-runtime'))}`,
      `    root: ${JSON.stringify(join(root, 'installed'))}`, '',
    ].join('\n'))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['load_workspace_dependencies'])
    const entry = [...ctx.loader.entries()].find(entry => entry.options.name === 'dependencies')
    expect(entry).toBeDefined()
    await entry?.fiber?.dispose()
    expect(ctx.tools.schemas()).toEqual([])
  } finally {
    try { await ctx.fiber.dispose() }
    finally { await rm(root, { recursive: true, force: true }) }
  }
})

it('never loads the Office skill, whose package this line leaves out of the payload', async () => {
  // A static import of an excluded package would fail the packaged Host before it reports ready.
  for (const file of ['../src/host/index.ts', '../src/host/workspace-dependencies.ts']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8')
    expect(source, file).not.toMatch(/from '@deepseek-ai\/dsh-skill-office'/u)
    expect(source, file).not.toMatch(/libreoffice-kit\/package\.json/u)
  }
})

it('mounts workspace dependencies only for a prepared development payload and always for a packaged Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'next-workspace-dependencies-config-'))
  try {
    const home = join(root, 'home')
    const source = join(root, '.desktop-build', 'runtime', 'arm64', 'primary-runtime')
    expect(resolveWorkspaceDependenciesConfig(root, undefined, home)).toBeUndefined()
    expect(resolveWorkspaceDependenciesConfig(root, source, home)).toBeUndefined()
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'runtime.json'), '{}')
    expect(resolveWorkspaceDependenciesConfig(root, source, home)).toEqual({ source, root: join(home, 'dsh-runtimes', PRIMARY_RUNTIME_INSTALL_NAME) })
    const archive = join(root, 'Resources', 'app.asar')
    const packaged = join(root, 'Resources', 'runtime', 'x64', 'primary-runtime')
    expect(() => resolveWorkspaceDependenciesConfig(archive, undefined, home)).toThrow('requires the bundled primary runtime path')
    expect(resolveWorkspaceDependenciesConfig(archive, packaged, home)).toEqual({ source: packaged, root: join(home, 'dsh-runtimes', PRIMARY_RUNTIME_INSTALL_NAME) })
    expect(PRIMARY_RUNTIME_INSTALL_NAME).not.toBe('dsh-primary-runtime')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
