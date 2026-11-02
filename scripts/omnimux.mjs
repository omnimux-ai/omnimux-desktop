#!/usr/bin/env node
/**
 * OmniMux 插件运维主入口（本仓库作日常开发/测试/同步/发布入口）。
 *
 * 真源脚本在 sibling 产品树 dsh-plugin/product/omnimux-dsh/scripts/；
 * 本文件只做路径解析与命令转发，让 Agent / 人类只在 fork 仓库操作。
 *
 * 用法（yarn 包装见 package.json omnimux:*）：
 *   node scripts/omnimux.mjs sync [插件...]
 *   node scripts/omnimux.mjs sync --skip-build omnimux-assets
 *   node scripts/omnimux.mjs dev start <name> <plugin>
 *   node scripts/omnimux.mjs dev stop|ls|rm|watch|unwatch ...
 *   node scripts/omnimux.mjs doctor
 *   node scripts/omnimux.mjs restart
 *   node scripts/omnimux.mjs profile rebuild --target dev --app /absolute/frozen/OmniMux.app
 *   node scripts/omnimux.mjs stage
 *   node scripts/omnimux.mjs path
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const forkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultProduct = join(homedir(), 'Desktop/Project/dsh-plugin/product/omnimux-dsh')
const productRoot = process.env.OMNIMUX_PRODUCT_DIR
  ? resolve(process.env.OMNIMUX_PRODUCT_DIR)
  : defaultProduct
const pluginsRoot = process.env.OMNIMUX_PLUGINS_DIR
  ? resolve(process.env.OMNIMUX_PLUGINS_DIR)
  : join(productRoot, 'plugins')

function die(msg) {
  process.stderr.write(`✗ ${msg}\n`)
  process.exit(1)
}

function requireProduct() {
  if (!existsSync(join(productRoot, 'scripts/sync-to-app.sh'))) {
    die(`产品树缺失或不完整: ${productRoot}\n  设置 OMNIMUX_PRODUCT_DIR 指向 dsh-plugin/product/omnimux-dsh`)
  }
}

function runBash(scriptRel, args) {
  requireProduct()
  const script = join(productRoot, scriptRel)
  const env = {
    ...process.env,
    OMNIMUX_PLUGINS_DIR: pluginsRoot,
  }
  const result = spawnSync('bash', [script, ...args], {
    cwd: productRoot,
    env,
    stdio: 'inherit',
  })
  process.exit(result.status === null ? 1 : result.status)
}

function runYarnWorkspace(scriptName, args = []) {
  const result = spawnSync('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'run', scriptName, ...args], {
    cwd: forkRoot,
    env: {
      ...process.env,
      OMNIMUX_PLUGINS_DIR: pluginsRoot,
    },
    stdio: 'inherit',
  })
  process.exit(result.status === null ? 1 : result.status)
}

function runProfile(args) {
  const appIndex = args.indexOf('--app')
  const appArgument = appIndex === -1 ? undefined : args[appIndex + 1]
  if (!appArgument) die('profile rebuild 必须显式传入 --app <frozen-candidate.app>')
  const app = realpathSync(resolve(appArgument))
  if (!app.endsWith('.app')) die(`--app 不是 macOS 应用包: ${app}`)
  const executableDir = join(app, 'Contents', 'MacOS')
  const executables = readdirSync(executableDir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(executableDir, entry.name))
  if (executables.length !== 1) die(`候选 App 的主可执行文件不唯一: ${executableDir}`)
  const script = join(forkRoot, 'dsh-plugin-desktop/scripts/rebuild-managed-profile.ts')
  const result = spawnSync(executables[0], [script, ...args], {
    cwd: forkRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
  })
  process.exit(result.status === null ? 1 : result.status)
}

function restartApp(target = 'prod') {
  if (target === 'prod' && (process.env.DSH_AGENT_SESSION || process.env.AGENT_ROLE || process.env.CI)) {
    die('Agent / 非交互式进程禁止强杀生产桌面应用 (/Applications/OmniMux.app)！生产应用重启由用户自主掌控。如需测试请使用: yarn omnimux:restart dev')
  }

  if (target === 'dev') {
    spawnSync('pkill', ['-f', 'OmniMux Dev.app'], { stdio: 'ignore' })
    spawnSync('sleep', ['1'], { stdio: 'ignore' })
    const open = spawnSync('open', ['-a', 'OmniMux Dev'], { stdio: 'inherit' })
    if (open.status !== 0) die('open -a "OmniMux Dev" 失败（确认已打包或安装开发版）')
    process.stdout.write('✓ 已请求重启 OmniMux Dev 开发版\n')
    return
  }

  spawnSync('pkill', ['-f', '/Applications/OmniMux.app'], { stdio: 'ignore' })
  // give Electron a beat to release locks
  spawnSync('sleep', ['1'], { stdio: 'ignore' })
  const open = spawnSync('open', ['-a', 'OmniMux'], { stdio: 'inherit' })
  if (open.status !== 0) die('open -a OmniMux 失败（确认已安装 /Applications/OmniMux.app）')
  process.stdout.write('✓ 已请求重启 OmniMux 正式版（手动确认窗口是否起来）\n')
}

function printHelp() {
  process.stdout.write(`OmniMux 插件运维入口（fork → 产品树）

产品树: ${productRoot}
插件源: ${pluginsRoot}

命令:
  sync [插件...] [--prod] [--skip-build]
                                  build + 物化进 profile（默认进 ~/.omnimux-dev 开发版，--prod 进生产）
  restart [prod|dev]              手动重启 /Applications/OmniMux.app 或 OmniMux Dev
  dev <start|stop|ls|rm|watch|unwatch> ...
                                  L2 预发布环境（含统一 watch）
  doctor                          三层环境合规自检
  profile rebuild --target dev --app <frozen-candidate.app>
                                  从冻结候选 App 全量重建 Dev Profile 依赖图
  stage                           物化进 preset/plugins（发布前）
  verify --preset <dir>           校验发行清单与打包内容是否一致（发布前）
  verify --profile <dir> --expect <distribution.json>
                                  校验已安装的开发环境与发行清单是否一致
  path                            打印产品树 / 插件路径

示例:
  yarn omnimux:sync omnimux-workflow          # 默认同步至 Dev 开发版
  yarn omnimux:sync --prod omnimux-workflow   # 人类明确指令下同步至生产正式版
  yarn omnimux:dev start assets-v2 omnimux-assets
  yarn omnimux:restart dev
  yarn omnimux:profile rebuild --target dev --app /absolute/path/OmniMux.app
  yarn omnimux:stage
  yarn omnimux:verify --preset dsh-plugin-desktop/preset
  yarn omnimux:verify --profile ~/.omnimux-dev/profiles/omnimux --expect /Applications/OmniMux Dev.app/Contents/Resources/app.asar.unpacked/preset/distribution.json
`)
}

const [cmd, ...rest] = process.argv.slice(2)
if (!cmd || cmd === '-h' || cmd === '--help') {
  printHelp()
  process.exit(0)
}

switch (cmd) {
  case 'sync':
    runBash('scripts/sync-to-app.sh', rest)
    break
  case 'dev':
    runBash('scripts/dev-env.sh', rest)
    break
  case 'doctor':
    runBash('scripts/dev-doctor.sh', rest)
    break
  case 'profile':
    runProfile(rest)
    break
  case 'restart':
    restartApp(rest[0] || 'prod')
    break
  case 'stage':
    if (!process.env.OMNIMUX_PLUGINS_DIR) {
      process.env.OMNIMUX_PLUGINS_DIR = pluginsRoot
    }
    runYarnWorkspace('stage:preset', rest)
    break
  case 'verify':
    runYarnWorkspace('verify:distribution', rest)
    break
  case 'path':
    requireProduct()
    process.stdout.write(`product: ${productRoot}\nplugins: ${pluginsRoot}\nfork:    ${forkRoot}\n`)
    break
  default:
    die(`未知命令: ${cmd}\n\n跑 yarn omnimux:help 看用法`)
}
