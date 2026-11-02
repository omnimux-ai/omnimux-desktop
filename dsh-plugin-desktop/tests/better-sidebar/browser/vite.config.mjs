import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const harnessRoot = dirname(fileURLToPath(import.meta.url))
const packageDirInput = process.env.SIDEBAR_PACKAGE_DIR

if (!packageDirInput) {
  throw new Error('SIDEBAR_PACKAGE_DIR must point to the Better Sidebar package under test')
}

const packageDir = resolve(packageDirInput)
const bundlePath = resolve(packageDir, 'lib/client.js')

if (!existsSync(bundlePath)) {
  throw new Error(`Better Sidebar client bundle does not exist: ${bundlePath}`)
}

const packageRequire = createRequire(resolve(packageDir, 'package.json'))
const bundle = readFileSync(bundlePath)
const packageJson = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8'))
const bundleMetadata = {
  bundlePath,
  packageDir,
  version: packageJson.version,
  sha256: createHash('sha256').update(bundle).digest('hex'),
}

export default defineConfig({
  root: harnessRoot,
  resolve: {
    alias: [
      { find: /^react$/, replacement: packageRequire.resolve('react') },
      { find: /^react\/jsx-runtime$/, replacement: packageRequire.resolve('react/jsx-runtime') },
      { find: /^react-dom\/client$/, replacement: packageRequire.resolve('react-dom/client') },
      { find: /^@deepseek-ai\/dsh-client-ui-primitives$/, replacement: packageRequire.resolve('@deepseek-ai/dsh-client-ui-primitives') },
    ],
  },
  define: {
    __SIDEBAR_BUNDLE_METADATA__: JSON.stringify(bundleMetadata),
  },
  server: {
    host: '127.0.0.1',
    strictPort: true,
  },
  plugins: [{
    name: 'serve-exact-better-sidebar-client-bundle',
    configureServer(server) {
      server.middlewares.use('/sidebar-client.js', (_request, response) => {
        response.statusCode = 200
        response.setHeader('content-type', 'text/javascript; charset=utf-8')
        response.setHeader('cache-control', 'no-store')
        response.end(bundle)
      })
    },
  }],
})
