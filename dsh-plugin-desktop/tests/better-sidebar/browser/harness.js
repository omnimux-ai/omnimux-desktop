import * as React from 'react'
import * as ReactDomClient from 'react-dom/client'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as UiPrimitives from '@deepseek-ai/dsh-client-ui-primitives'

const metadata = __SIDEBAR_BUNDLE_METADATA__
const registrations = new Map()
const disposers = []
const mutationEvents = []
const htmlStyle = document.documentElement.style
const originalFetch = window.fetch.bind(window)
const originalWebSocket = window.WebSocket
const originalSetProperty = htmlStyle.setProperty.bind(htmlStyle)
const originalRemoveProperty = htmlStyle.removeProperty.bind(htmlStyle)
const originalBodyRemoveAttribute = document.body.removeAttribute.bind(document.body)

htmlStyle.setProperty = (name, value, priority) => {
  if (name === '--dsh-sidebar-width' || name === '--dsh-sidebar-height') {
    mutationEvents.push({ kind: 'set', name, value, at: performance.now() })
  }
  originalSetProperty(name, value, priority)
}
htmlStyle.removeProperty = (name) => {
  if (name === '--dsh-sidebar-width' || name === '--dsh-sidebar-height') {
    mutationEvents.push({ kind: 'remove', name, at: performance.now() })
  }
  return originalRemoveProperty(name)
}
document.body.removeAttribute = (name) => {
  if (name === 'data-dsh-sidebar-dragging') {
    mutationEvents.push({ kind: 'drag-marker-removed', name, at: performance.now() })
  }
  originalBodyRemoveAttribute(name)
}

window.__ModuleLoader__ = {
  mode: 'harness',
  load(registration) {
    registrations.set(registration.id, registration)
  },
}

class DummyWebSocket {
  static OPEN = 1
  readyState = DummyWebSocket.OPEN
  onmessage = null
  onclose = null
  onerror = null
  close() {}
  send() {}
}
window.WebSocket = DummyWebSocket

window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href)
  if (url.pathname === '/sidebar/api/settings.get') {
    return Response.json({
      ok: true,
      value: {
        value: {
          openByDefault: true,
          defaultWidthPercent: 35,
          bottomPanelAutoTerminal: false,
          tabsEnabled: { editor: false, terminal: false },
        },
        revision: 1,
        externalDisable: false,
      },
    })
  }
  if (url.pathname === '/sidebar/api/shell.get') {
    return Response.json({ ok: true, value: { shell: '/bin/sh', name: 'sh' } })
  }
  if (url.pathname.startsWith('/sidebar/')) {
    return Response.json({ ok: false, error: { code: 'harness', message: 'live sidebar I/O is disabled' } }, { status: 404 })
  }
  return originalFetch(input, init)
}

const localeSnapshot = Object.freeze({ active: 'en' })
const sessionSnapshot = Object.freeze({
  current: 'compiled-bundle-harness',
  byId: Object.freeze({
    'compiled-bundle-harness': Object.freeze({
      id: 'compiled-bundle-harness',
      cwd: '/tmp/sidebar-harness',
      displayTitle: 'Compiled bundle harness',
      running: false,
    }),
  }),
  subagentsByParent: Object.freeze({}),
  jobsBySession: Object.freeze({}),
})
const moduleExternals = {
  react: React,
  'react-dom/client': ReactDomClient,
  'react/jsx-runtime': ReactJsxRuntime,
  '@deepseek-ai/dsh-client-ui-primitives': UiPrimitives,
}
const ctx = {
  locale: {
    getSnapshot: () => localeSnapshot,
    subscribe: () => () => {},
    register: () => () => {},
  },
  sessions: {
    list: { getSnapshot: () => sessionSnapshot, subscribe: () => () => {} },
    scope: () => undefined,
  },
  connection: { api: { subagents: { history: async () => ({ result: { ok: true, value: { events: [], hasMore: false } } }) } } },
  workspaces: { openPath: async () => {} },
  modules: {
    import: async (specifier) => {
      if (!(specifier in moduleExternals)) throw new Error(`Harness has no module external: ${specifier}`)
      return moduleExternals[specifier]
    },
  },
  slots: {
    inject: () => () => {},
    register: () => () => {},
  },
  provide(name, value) { this[name] = value },
  get() { return undefined },
  effect(factory) {
    const disposer = factory()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
}

function renderResult(result) {
  const rows = [
    ['Status', result === null ? 'ready' : result.pass ? 'PASS' : 'FAIL', result === null ? '' : result.pass ? 'pass' : 'fail'],
    ['Bundle', metadata.bundlePath],
    ['Version', String(metadata.version)],
    ['SHA-256', metadata.sha256],
  ]
  if (result !== null && 'liveUpdatesKeptVariables' in result) {
    rows.push(
      ['Live update kept vars', String(result.liveUpdatesKeptVariables), result.liveUpdatesKeptVariables ? 'pass' : 'fail'],
      ['Pointerup order', String(result.pointerupGeometryBeforeMarker), result.pointerupGeometryBeforeMarker ? 'pass' : 'fail'],
      ['Unmount cleared vars', String(result.unmountClearedVariables), result.unmountClearedVariables ? 'pass' : 'fail'],
      ['Final geometry', `${result.finalWidth} × ${result.finalHeight}`],
      ['Observed removals', result.liveRemovalNames.join(', ') || 'none'],
    )
  } else if (result !== null && 'error' in result) {
    rows.push(['Error', result.error, 'fail'])
  }
  document.getElementById('harness-result').innerHTML = rows.map(([name, value, className = '']) =>
    `<dt>${escapeHtml(name)}</dt><dd class="${className}">${escapeHtml(value)}</dd>`,
  ).join('')
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character])
}

function waitFor(predicate, timeoutMs = 5000) {
  const start = performance.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = predicate()
      if (value) resolve(value)
      else if (performance.now() - start >= timeoutMs) reject(new Error('Timed out waiting for compiled sidebar mount'))
      else requestAnimationFrame(poll)
    }
    poll()
  })
}

function nextPaint() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

function dispatchPointer(target, type, clientX, clientY = 100) {
  target.dispatchEvent(new PointerEvent(type, {
    bubbles: true,
    pointerId: 17,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX,
    clientY,
  }))
}

function installDeterministicCapture(handle) {
  let captured = false
  handle.setPointerCapture = () => { captured = true }
  handle.hasPointerCapture = () => captured
  handle.releasePointerCapture = () => { captured = false }
}

let disposed = false
let lastResult = null

async function disposePlugin() {
  if (disposed) return
  disposed = true
  for (const dispose of disposers.reverse()) dispose()
  await nextPaint()
  window.fetch = originalFetch
  window.WebSocket = originalWebSocket
  htmlStyle.setProperty = originalSetProperty
  htmlStyle.removeProperty = originalRemoveProperty
  document.body.removeAttribute = originalBodyRemoveAttribute
}

async function runProbe() {
  if (disposed) throw new Error('The compiled plugin was already disposed; reload the page to run again')
  const service = ctx.betterSidebar
  await waitFor(() => service?.getSnapshot().state)
  await nextPaint()
  const bottomToggle = await waitFor(() => document.querySelector(
    '[data-dsh-better-sidebar] [data-dsh-panel-host] button[aria-label="Expand bottom panel"], '
    + '[data-dsh-better-sidebar] [data-dsh-panel-host] button[aria-label="Collapse bottom panel"]',
  ))
  mutationEvents.length = 0
  bottomToggle.click()
  await nextPaint()
  const heightUpdateEvents = mutationEvents.splice(0)

  const host = document.querySelector('[data-dsh-better-sidebar] [data-dsh-panel-host]')
  const panel = host.children[1]
  const widthHandle = panel.firstElementChild
  if (!(widthHandle instanceof HTMLElement)) throw new Error('Compiled Sidebar did not render the width drag handle')
  installDeterministicCapture(widthHandle)
  const startWidth = service.getSnapshot().state.width
  dispatchPointer(widthHandle, 'pointerdown', 700)
  await nextPaint()
  mutationEvents.length = 0
  dispatchPointer(widthHandle, 'pointerup', 620)
  await nextPaint()
  const pointerupEvents = mutationEvents.splice(0)

  const state = service.getSnapshot().state
  const expectedWidth = startWidth + 80
  const expectedHeight = state.bottomOpen ? state.bottomHeight : 0
  const widthSetIndex = pointerupEvents.findIndex(event =>
    event.kind === 'set' && event.name === '--dsh-sidebar-width' && event.value === `${expectedWidth}px`)
  const heightSetIndex = pointerupEvents.findIndex(event =>
    event.kind === 'set' && event.name === '--dsh-sidebar-height' && event.value === `${expectedHeight}px`)
  const markerRemovalIndex = pointerupEvents.findIndex(event => event.kind === 'drag-marker-removed')
  const liveRemovalNames = [...heightUpdateEvents, ...pointerupEvents]
    .filter(event => event.kind === 'remove')
    .map(event => event.name)
  const liveUpdatesKeptVariables = liveRemovalNames.length === 0
  const pointerupGeometryBeforeMarker = widthSetIndex >= 0 && heightSetIndex >= 0 && markerRemovalIndex >= 0
    && widthSetIndex < markerRemovalIndex && heightSetIndex < markerRemovalIndex
  const finalWidth = htmlStyle.getPropertyValue('--dsh-sidebar-width')
  const finalHeight = htmlStyle.getPropertyValue('--dsh-sidebar-height')

  mutationEvents.length = 0
  await disposePlugin()
  const unmountRemovalNames = mutationEvents.filter(event => event.kind === 'remove').map(event => event.name)
  const unmountClearedVariables = finalWidth === `${expectedWidth}px`
    && finalHeight === `${expectedHeight}px`
    && htmlStyle.getPropertyValue('--dsh-sidebar-width') === ''
    && htmlStyle.getPropertyValue('--dsh-sidebar-height') === ''
    && unmountRemovalNames.includes('--dsh-sidebar-width')
    && unmountRemovalNames.includes('--dsh-sidebar-height')

  lastResult = {
    pass: liveUpdatesKeptVariables && pointerupGeometryBeforeMarker && unmountClearedVariables,
    liveUpdatesKeptVariables,
    pointerupGeometryBeforeMarker,
    unmountClearedVariables,
    finalWidth,
    finalHeight,
    liveRemovalNames,
    heightUpdateEvents,
    pointerupEvents,
    unmountRemovalNames,
    bundle: metadata,
  }
  renderResult(lastResult)
  return lastResult
}

async function loadCompiledPlugin() {
  const script = document.createElement('script')
  script.src = `/sidebar-client.js?sha256=${encodeURIComponent(metadata.sha256)}`
  await new Promise((resolve, reject) => {
    script.addEventListener('load', resolve, { once: true })
    script.addEventListener('error', () => reject(new Error('Failed to load exact compiled client bundle')), { once: true })
    document.head.append(script)
  })
  const registration = registrations.get('dsh-better-sidebar')
  if (!registration) throw new Error('Compiled bundle did not register dsh-better-sidebar')
  const exports = registration.factory(specifier => {
    if (!(specifier in moduleExternals)) throw new Error(`Compiled bundle requested unexpected external: ${specifier}`)
    return moduleExternals[specifier]
  })
  if (typeof exports.apply !== 'function') throw new Error('Compiled bundle did not export apply(ctx)')
  exports.apply(ctx)
  await waitFor(() => document.querySelector('[data-dsh-better-sidebar] [data-dsh-panel-host]'))
  await nextPaint()
  renderResult(null)
}

document.getElementById('run-probe').addEventListener('click', () => {
  runProbe().catch(error => {
    lastResult = { pass: false, error: String(error), bundle: metadata }
    renderResult(lastResult)
  })
})
document.getElementById('dispose-plugin').addEventListener('click', () => { void disposePlugin() })
document.getElementById('remount-plugin').addEventListener('click', () => { location.reload() })

window.__SIDEBAR_HARNESS__ = {
  metadata,
  ctx,
  events: mutationEvents,
  get result() { return lastResult },
  runProbe,
  dispose: disposePlugin,
}

loadCompiledPlugin().catch(error => {
  lastResult = { pass: false, error: String(error), bundle: metadata }
  renderResult(lastResult)
})
