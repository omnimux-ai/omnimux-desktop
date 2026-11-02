# DSH Desktop repository rules

This repository owns the desktop product around an unmodified DeepSeek Harness checkout. **It is the shipping OmniMux desktop line**: `/Applications/OmniMux.app` and released builds come from here, not from the sibling `omnimux-desktop` tree.

## Prerequisites and setup

- Use Node.js `^22.19.0` or `>=24.0.0` and the root Yarn `4.18.0` release through Corepack.
- Initialize the pinned upstream checkout with `git submodule update --init --recursive`.
- Install root dependencies with `corepack yarn install --immutable`.

## Build, run, and verify

- Start the desktop development workflow with `corepack yarn dev`.
- Build the desktop package with `corepack yarn build`.
- The bundled `dshmarket` version and its Desktop compatibility patch live in the root `resolutions` (`dshmarket@npm:1.70.1` → `.yarn/patches/dshmarket-desktop.patch`); commit the version, the patch, and the lockfile together. Installed apps do not hot-update executable plugins on launch.
- Before each release, run `corepack yarn aa:prepare-release` to build the latest official Agents Anywhere `main` for both Desktop workspaces (`dsh-plugin-desktop` and `dsh-desktop-next`, see `scripts/agents-anywhere-release-policy.mjs`). Commit the resulting artifact, provenance, manifests, and lockfile before packaging. Signed macOS releases and root Windows distribution commands verify freshness and installed versions; `DSH_AA_SOURCE_REF=pinned` is no longer supported.
- Run unit tests with `corepack yarn test`.
- Run type checking with `corepack yarn typecheck`.
- Run the complete headless gate with `corepack yarn check`.
- `dsh-desktop-next/` is the OmniMux product shell, branded in-tree from the upstream Next shell. It carries the shipped identity (`OmniMux` / `ai.omnimux.desktop` / `~/.omnimux`) through `src/product-identity.ts`, participates in root `build` / `typecheck` / `test` and in `corepack yarn check`, and has its own release entries (`dist:mac:next`, `dist:win:next`, `check:next`). `dsh-plugin-desktop` remains the shipped line until the shell swap is cut over; both are gated. Upstream's `dsh-plugin-desktop-beta` variant stays deliberately absent.
- Run upstream operations through the root scripts, such as `corepack yarn upstream:build`.


## OmniMux plugin ops (this repo is the day-to-day entry)

This fork is the **main ops entry** for OmniMux plugin develop / browser QA / sync-to-app / release. Plugin source lives in the sibling `dsh-plugin` repository at `product/omnimux-dsh`. Contracts: that tree's `docs/contracts/dev-pipeline.md` + `docs/contracts/ops-entry.md` (single ops entry; no per-plugin deploy lanes).

| Command | Purpose |
| --- | --- |
| `yarn omnimux:dev start <task> <plugin>` | L2: isolated Host + link one in-progress plugin + unified watch (official HMR) |
| `yarn omnimux:dev watch <task> <plugin>` | Switch which plugin the watch targets (Host stays up) |
| `yarn omnimux:sync [plugin…]` | Build then materialize into `~/.omnimux-dev/profiles/omnimux` (`--prod` targets `~/.omnimux`) (**does not restart App**) |
| `yarn omnimux:restart` | Manually restart `/Applications/OmniMux.app` after sync |
| `yarn omnimux:doctor` | Compliance check (prod must not link, etc.) |
| `yarn omnimux:stage` | Materialize into `preset/plugins/` before packaging |
| `yarn omnimux:path` | Print resolved product/plugin paths |

MUST NOT hand-`rsync`/`cp` into any profile. Daily iteration uses `omnimux:sync` + `omnimux:restart`; packaging uses `omnimux:stage` then `package:dir` / `dist:*`.
**Packaging Pre-requisite Rule**: Direct packaging or running `package-dir.mjs` without staging will cause startup crash (`missing dsh-better-sidebar` recovery window). When rebuilding `/Applications/OmniMux.app` or packaging distribution bundles, ALWAYS ensure `OMNIMUX_PLUGINS_DIR` is set and run `stage-preset-profile` (`node ./dsh-plugin-desktop/scripts/stage-preset-profile.ts` or `yarn omnimux:stage`) before packaging. Before `yarn package:dir` / `dist:*`, also run `corepack yarn install --immutable` at the repo root when `node_modules` may be stale: a hollow tree (declared `@deepseek-ai/*` missing from workspace `node_modules`) fails `tsc --emitDeclarationOnly` and makes electron-builder abort on missing production deps such as `@deepseek-ai/dsh-api-session-controller`.

- `deepseek-harness/` is a pinned upstream Git submodule. Never edit files inside it from a desktop feature branch.
- `dsh-plugin-desktop/` owns the Cordis Host and Client faces, Electron bootstrap, packaging, and release tests.
- `dsh-desktop-next/` owns the OmniMux Desktop shell, Profiles and recovery, and adapters for the existing AA bridge and Community Market. Keep its upstream reference and published runtime versions aligned; do not fork the official main frontend. Its product identity lives in `src/product-identity.ts` and must keep the shipped appId and `.omnimux` home so an upgrade stays one application.
- `dsh-community-fabric/` owns the community interoperability RFC. Until schemas and a reviewed reference adapter exist, it remains a private documentation scaffold and must not declare loadable DSH or package entry points.
- `dsh-community-market/` owns the community-market shell. Until its runtime is implemented, it remains a private documentation scaffold and must not declare loadable DSH or package entry points.
- The outer repository and all owned packages use the root Yarn release with `nodeLinker: node-modules`.
- The upstream submodule keeps its own pnpm workspace. Run upstream commands through the root `upstream:*` scripts, whose Yarn portable-shell commands enter the submodule before invoking Corepack.
- Compatibility mode must run the upstream default client without overrides. Advanced presentation belongs to desktop-owned client plugins and may replace documented slots or services through profile composition.
- Keep graphical application launch explicit. Builds, typechecks, unit tests, and Loader smokes must remain headless-safe.
- Commit before major changes of direction and keep the submodule pin update separate from desktop behavior changes.
- Keep the repository topology and package-manager split consistent with the [owning Agent Note](.agents/notes/implemented/process/2026-08-15-pinned-upstream-and-isolated-yarn-workspace.md).

## Repository ecosystem

This desktop product is one layer of a wider OmniMux project ecosystem: it forks an unmodified official DeepSeek Harness checkout, ships preset OmniMux plugins from the sibling `dsh-plugin` development workspace, and talks to the OmniMux Go gateway over `OMNIMUX_BASE_URL`. Sibling repositories are checked out next to this one (`dsh-plugin`, `OmniMux`, `deepseek-harness`, and the parallel slim shell `omnimux-desktop` — an alternative product direction, NOT the shipping line). Read the [ecosystem Agent Note](.agents/notes/implemented/architecture/2026-08-21-omnimux-ecosystem-map.md) before touching plugin sync, upstream pins, or gateway-facing behavior.

## Upstream sync contract

This fork syncs with upstream weekly. Before any merge from `origin/master`, read and follow [docs/contracts/upstream-sync.md](docs/contracts/upstream-sync.md) — it defines the four-tier merge decision ladder (auto-merge / template-resolve / user-confirm / reject), the standard SOP, and the mandatory decision log at [docs/contracts/upstream-sync-log.md](docs/contracts/upstream-sync-log.md). A merge without a log entry is not done.

## Release & R2 Distribution SOP

Distribution assets (macOS Universal DMG & Windows x64 NSIS) are hosted in Cloudflare R2 bucket `omnimux-dist` via `https://dl.omnimux.ai`. Detailed contract: [docs/contracts/release-sop.md](docs/contracts/release-sop.md).

- macOS artifact standard: **Universal DMG** (`OmniMux-<version>-universal.dmg` bundling both `arm64` and `x86_64`). Single universal installer serves all Mac devices.
- Windows artifact standard: **x64 NSIS Installer** (`OmniMux-<version>-x64-Setup.exe`). Supports silent install `/S` for auto-update and **website / CDN** distribution via `yarn dist:win` (unsigned).
- **Current Windows policy**: website-first, Microsoft Store paused (zero extra signing budget). Contract: [docs/contracts/windows-website-distribution.md](docs/contracts/windows-website-distribution.md). Paid Authenticode / Store resubmission remains optional and follows [docs/contracts/windows-trusted-signing-sop.md](docs/contracts/windows-trusted-signing-sop.md) only after an explicit paid-signing decision.
- **Public download page**: primary CTAs MUST point at `https://dl.omnimux.ai/` (not Store, not legacy `dshdesktop.cn`). Spec: [docs/contracts/download-page-spec.md](docs/contracts/download-page-spec.md).
- Sync artifacts to R2: `yarn dist:r2-sync` (or `node scripts/r2-dist-sync.mjs upload`).
- Verify CDN endpoints: `yarn dist:r2-verify` (or `node scripts/r2-dist-sync.mjs verify`).
- List R2 bucket assets: `yarn dist:r2-list` (or `node scripts/r2-dist-sync.mjs list`).

## Parallel development & PR contract

Multi-session feature work MUST follow [docs/contracts/parallel-dev-pr.md](docs/contracts/parallel-dev-pr.md): one task → one path lease → one worktree → one branch → one PR to `fork`/`omnimux`; main checkout is read-only for day-to-day coding. Local board/leases live under `.workbuddy/` (not committed). PR merge and dev delivery are automated once strict verifications pass (L0 unit tests, L2 dev environment, real browser / live runtime verification, and CI pass); manual review/pause is required only on test failure, unresolved blockers, production `--prod` release, or explicit user hold. After a PR is open/merged, follow-up updates `.workbuddy/pr-board.md`. Plugin-tree Git/PR lives in sibling `omnimux-dsh` contract `docs/contracts/plugin-git-pr.md` + skills `omnimux-plugin-pr` / `omnimux-pr-handoff` — do not reuse this fork's `fork`/`omnimux` topology there.
