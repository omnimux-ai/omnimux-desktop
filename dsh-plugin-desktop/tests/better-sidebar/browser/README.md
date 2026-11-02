# Compiled Better Sidebar browser harness

This harness loads one exact built `dsh-better-sidebar/lib/client.js` artifact,
materializes its real module-loader factory with the package's installed React,
ReactDOM, JSX runtime, and UI primitives exports, and calls the bundle's exported
`apply(ctx)`. The context contains one inert local session and no model, account,
credential, profile, or Host API.

Use the verifier report's `workRoot/first/source` directory, which retains the frozen build dependencies. The bundle bytes must match the packed file hashes in the report. Run from the outer repository worktree:

```sh
SIDEBAR_PACKAGE_DIR=/absolute/path/to/verified-build/first/source \
  corepack yarn workspace dsh-plugin-desktop exec vite \
  --config tests/better-sidebar/browser/vite.config.mjs \
  --host 127.0.0.1 --port 4179 --strictPort
```

Open `http://127.0.0.1:4179/` in the Codex built-in browser. The page shows the
absolute bundle path and SHA-256. Select **Run probe** once. A passing result
proves, against that compiled artifact, that:

- toggling the bottom panel and committing a width drag never remove either
  live layout variable;
- pointer-up writes the committed width and height before removing the body
  drag marker;
- disposing the plugin removes both layout variables.

The probe intentionally disposes the plugin. Select **Remount** to reload the
same artifact before a second run. `window.__SIDEBAR_HARNESS__.result` contains
the ordered mutation evidence for inspection from browser developer tools.

For a one-shot scripted component-harness capture, keep the Vite server running
and launch Electron with an explicit result directory:

```sh
HARNESS_URL=http://127.0.0.1:4179/ \
OUTPUT_DIR=/absolute/path/to/sidebar-harness-evidence \
  corepack yarn workspace dsh-plugin-desktop exec electron \
  tests/better-sidebar/browser/electron-runner.mjs
```

The runner uses a fresh temporary Electron profile, loads the harness in a
hidden `BrowserWindow`, exits nonzero on failure, selects **Run probe**, and writes
`sidebar-harness-result.json` plus `sidebar-harness.png`. This exercises the
compiled component harness; it is not a full Desktop application test.

## Source regression fixture

The adjacent `sidebar-layout-lifecycle.spec.tsx.fixture` is intentionally not a
test in this outer repository. Copy it into the checked-out Better Sidebar
package under the runnable `.spec.tsx` name, then run the focused Vitest file:

```sh
cp dsh-plugin-desktop/tests/better-sidebar/sidebar-layout-lifecycle.spec.tsx.fixture \
  "$SIDEBAR_PACKAGE_DIR/tests/sidebar-layout-lifecycle.spec.tsx"
cd "$SIDEBAR_PACKAGE_DIR"
corepack pnpm@11.8.0 exec vitest run tests/sidebar-layout-lifecycle.spec.tsx
```

The copied location makes its `../src/client/*` imports resolve against the
real package source. Keep this copy step explicit: the fixture verifies the
selected source tree and is not part of the outer desktop test suite.
