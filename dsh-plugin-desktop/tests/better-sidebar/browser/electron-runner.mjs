import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { app, BrowserWindow } from 'electron'

function readOption(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const harnessUrl = process.env.HARNESS_URL ?? readOption('--url')
const outputDirInput = process.env.OUTPUT_DIR ?? readOption('--output-dir')

if (!harnessUrl) throw new Error('HARNESS_URL or --url is required')
if (!outputDirInput) throw new Error('OUTPUT_DIR or --output-dir is required')
new URL(harnessUrl)

const outputDir = resolve(outputDirInput)
const userDataDir = mkdtempSync(join(tmpdir(), 'better-sidebar-harness-'))
let window

app.setPath('userData', userDataDir)

async function run() {
  try {
    await app.whenReady()
    window = new BrowserWindow({
      width: 1280,
      height: 820,
      show: false,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    await window.loadURL(harnessUrl)
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const startedAt = performance.now()
      const poll = () => {
        if (window.__SIDEBAR_HARNESS__ && document.querySelector('[data-dsh-better-sidebar] [data-dsh-panel-host]')) {
          resolve(true)
        } else if (performance.now() - startedAt > 10000) {
          reject(new Error('Timed out waiting for the compiled sidebar harness to boot'))
        } else {
          requestAnimationFrame(poll)
        }
      }
      poll()
    })`)
    await window.webContents.executeJavaScript("document.getElementById('run-probe').click(); true")
    const result = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const startedAt = performance.now()
      const poll = () => {
        const result = window.__SIDEBAR_HARNESS__.result
        if (result !== null) {
          resolve(result)
        } else if (performance.now() - startedAt > 10000) {
          reject(new Error('Timed out waiting for the compiled sidebar probe result'))
        } else {
          requestAnimationFrame(poll)
        }
      }
      poll()
    })`)

    mkdirSync(outputDir, { recursive: true })
    const screenshot = await window.webContents.capturePage()
    writeFileSync(join(outputDir, 'sidebar-harness.png'), screenshot.toPNG())
    writeFileSync(join(outputDir, 'sidebar-harness-result.json'), `${JSON.stringify({
      harnessUrl,
      capturedAt: new Date().toISOString(),
      runtime: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
      },
      result,
    }, null, 2)}\n`)

    if (!result.pass) throw new Error(result.error ?? 'Compiled sidebar probe failed')
  } finally {
    if (window && !window.isDestroyed()) window.destroy()
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

run().then(
  () => app.exit(0),
  error => {
    console.error(error)
    app.exit(1)
  },
)
