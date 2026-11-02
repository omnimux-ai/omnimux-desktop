import { describe, expect, it, vi } from 'vitest'
import {
  installDesktopTitleBarDoubleClick,
  shouldTriggerTitleBarDoubleClick,
} from '../src/client/titlebar-double-click.ts'
import {
  attachTitleBarDoubleClickListener,
  executeTitleBarDoubleClickAction,
} from '../src/titlebar-double-click.ts'
import {
  DESKTOP_WINDOW_ACTION_BRIDGE,
  TITLEBAR_DOUBLE_CLICK_IPC_CHANNEL,
} from '../src/window-actions-bridge-contract.ts'
import type { BrowserWindow, IpcMainEvent, systemPreferences } from 'electron'

describe('titlebar double-click client detector', () => {
  function createFakeElement(classes: string[] = [], tag = 'div', parent: unknown = null): EventTarget {
    return {
      tagName: tag.toUpperCase(),
      className: classes.join(' '),
      closest: vi.fn((selector: string) => {
        const selectors = selector.split(',').map(s => s.trim())
        for (const s of selectors) {
          if (s.startsWith('[class*="')) {
            const pattern = s.slice(9, -2)
            if (classes.some(c => c.includes(pattern))) return {}
          }
          if (s.toLowerCase() === tag.toLowerCase()) return {}
          if (s === `.${classes[0]}`) return {}
        }
        return parent
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as EventTarget
  }

  it('triggers for clicks in empty titlebar region under 38px', () => {
    const el = createFakeElement([], 'div')
    expect(shouldTriggerTitleBarDoubleClick(el, 20)).toBe(true)
  })

  it('rejects clicks beyond the titlebar height threshold', () => {
    const el = createFakeElement([], 'div')
    expect(shouldTriggerTitleBarDoubleClick(el, 39)).toBe(false)
    expect(shouldTriggerTitleBarDoubleClick(el, -1)).toBe(false)
  })

  it('rejects clicks when target is an interactive control', () => {
    const button = createFakeElement([], 'button')
    const tab = createFakeElement(['tabBar_tabActive'], 'div')
    const toggle = createFakeElement(['toggleButton'], 'button')
    const input = createFakeElement([], 'input')

    expect(shouldTriggerTitleBarDoubleClick(button, 10)).toBe(false)
    expect(shouldTriggerTitleBarDoubleClick(tab, 10)).toBe(false)
    expect(shouldTriggerTitleBarDoubleClick(toggle, 10)).toBe(false)
    expect(shouldTriggerTitleBarDoubleClick(input, 10)).toBe(false)
  })

  it('rejects clicks when an aria-modal dialog is active', () => {
    const fakeDoc = {
      querySelector: vi.fn((sel: string) => (sel === '[aria-modal="true"]' ? {} : null)),
    }
    const emptyTitlebar = createFakeElement([], 'div')
    expect(shouldTriggerTitleBarDoubleClick(emptyTitlebar, 20, fakeDoc)).toBe(false)
  })

  it('delegates double-click to contextBridge and cleans up listener', () => {
    const handleTitleBarDoubleClick = vi.fn()
    let clickHandler: ((e: MouseEvent) => void) | undefined

    const fakeWindow = {
      document: { querySelector: vi.fn(() => null) },
      addEventListener: vi.fn((event: string, handler: (e: MouseEvent) => void) => {
        if (event === 'dblclick') clickHandler = handler
      }),
      removeEventListener: vi.fn((event: string) => {
        if (event === 'dblclick') clickHandler = undefined
      }),
      [DESKTOP_WINDOW_ACTION_BRIDGE]: {
        handleTitleBarDoubleClick,
      },
    } as unknown as Window & Record<string, unknown>

    const remove = installDesktopTitleBarDoubleClick('darwin', fakeWindow)
    expect(fakeWindow.addEventListener).toHaveBeenCalledWith(
      'dblclick',
      expect.any(Function),
      { capture: true },
    )

    // Simulate primary double-click on titlebar
    const emptyEl = createFakeElement([], 'div')
    const event = {
      button: 0,
      clientY: 15,
      target: emptyEl,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent

    clickHandler?.(event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(handleTitleBarDoubleClick).toHaveBeenCalledTimes(1)

    // Simulate non-primary (e.g. right click)
    const rightClickEvent = {
      button: 2,
      clientY: 15,
      target: emptyEl,
      preventDefault: vi.fn(),
    } as unknown as MouseEvent
    clickHandler?.(rightClickEvent)
    expect(handleTitleBarDoubleClick).toHaveBeenCalledTimes(1) // not called again

    // Teardown
    remove()
    expect(fakeWindow.removeEventListener).toHaveBeenCalledWith(
      'dblclick',
      expect.any(Function),
      { capture: true },
    )
    expect(clickHandler).toBeUndefined()
  })
})

describe('titlebar double-click main process executor', () => {
  function createFakeWindow(initial = { isMaximized: false, isFullScreen: false }) {
    let maximized = initial.isMaximized
    const fullScreen = initial.isFullScreen
    let destroyed = false

    return {
      isDestroyed: vi.fn(() => destroyed),
      isFullScreen: vi.fn(() => fullScreen),
      isMaximized: vi.fn(() => maximized),
      maximize: vi.fn(() => { maximized = true }),
      unmaximize: vi.fn(() => { maximized = false }),
      minimize: vi.fn(),
      webContents: { id: 42 },
      _destroy: () => { destroyed = true },
    } as unknown as BrowserWindow & {
      maximize: ReturnType<typeof vi.fn>
      unmaximize: ReturnType<typeof vi.fn>
      minimize: ReturnType<typeof vi.fn>
      _destroy: () => void
    }
  }

  function mockSystemPrefs(action: string): Pick<typeof systemPreferences, 'getUserDefault'> {
    return {
      getUserDefault: vi.fn(() => action) as unknown as typeof systemPreferences.getUserDefault,
    }
  }

  it('toggles maximize/unmaximize on darwin when system preference is Maximize', () => {
    const win = createFakeWindow({ isMaximized: false, isFullScreen: false })
    const systemPrefs = mockSystemPrefs('Maximize')

    executeTitleBarDoubleClickAction(win, 'darwin', systemPrefs)
    expect(win.maximize).toHaveBeenCalledTimes(1)
    expect(win.unmaximize).not.toHaveBeenCalled()

    executeTitleBarDoubleClickAction(win, 'darwin', systemPrefs)
    expect(win.unmaximize).toHaveBeenCalledTimes(1)
  })

  it('minimizes window on darwin when system preference is Minimize', () => {
    const win = createFakeWindow({ isMaximized: false, isFullScreen: false })
    const systemPrefs = mockSystemPrefs('Minimize')

    executeTitleBarDoubleClickAction(win, 'darwin', systemPrefs)
    expect(win.minimize).toHaveBeenCalledTimes(1)
    expect(win.maximize).not.toHaveBeenCalled()
  })

  it('does nothing on darwin when system preference is None', () => {
    const win = createFakeWindow({ isMaximized: false, isFullScreen: false })
    const systemPrefs = mockSystemPrefs('None')

    executeTitleBarDoubleClickAction(win, 'darwin', systemPrefs)
    expect(win.minimize).not.toHaveBeenCalled()
    expect(win.maximize).not.toHaveBeenCalled()
    expect(win.unmaximize).not.toHaveBeenCalled()
  })

  it('toggles maximize/unmaximize on non-darwin platforms', () => {
    const win = createFakeWindow({ isMaximized: false, isFullScreen: false })
    executeTitleBarDoubleClickAction(win, 'win32')
    expect(win.maximize).toHaveBeenCalledTimes(1)

    executeTitleBarDoubleClickAction(win, 'win32')
    expect(win.unmaximize).toHaveBeenCalledTimes(1)
  })

  it('ignores double-click when window is destroyed or in fullscreen', () => {
    const win = createFakeWindow({ isMaximized: false, isFullScreen: true })
    const systemPrefs = mockSystemPrefs('Maximize')

    executeTitleBarDoubleClickAction(win, 'darwin', systemPrefs)
    expect(win.maximize).not.toHaveBeenCalled()

    win._destroy()
    executeTitleBarDoubleClickAction(win, 'darwin', systemPrefs)
    expect(win.maximize).not.toHaveBeenCalled()
  })

  it('attaches and detaches IPC listener correctly', () => {
    const win = createFakeWindow()
    let registeredHandler: ((event: IpcMainEvent) => void) | undefined
    const mockIpcMain = {
      on: vi.fn((channel: string, handler: (event: IpcMainEvent) => void) => {
        if (channel === TITLEBAR_DOUBLE_CLICK_IPC_CHANNEL) registeredHandler = handler
        return mockIpcMain as any
      }),
      off: vi.fn((channel: string) => {
        if (channel === TITLEBAR_DOUBLE_CLICK_IPC_CHANNEL) registeredHandler = undefined
        return mockIpcMain as any
      }),
    }

    const detach = attachTitleBarDoubleClickListener({
      window: win,
      platform: 'darwin',
      systemPreferencesApi: mockSystemPrefs('Maximize'),
      ipcMainApi: mockIpcMain as any,
    })

    expect(mockIpcMain.on).toHaveBeenCalledWith(TITLEBAR_DOUBLE_CLICK_IPC_CHANNEL, expect.any(Function))
    expect(typeof registeredHandler).toBe('function')

    // Fire from matching webContents
    registeredHandler?.({ sender: { id: 42 } } as IpcMainEvent)
    expect(win.maximize).toHaveBeenCalledTimes(1)

    // Fire from different webContents (should be ignored)
    registeredHandler?.({ sender: { id: 999 } } as IpcMainEvent)
    expect(win.maximize).toHaveBeenCalledTimes(1)

    detach()
    expect(mockIpcMain.off).toHaveBeenCalledWith(TITLEBAR_DOUBLE_CLICK_IPC_CHANNEL, expect.any(Function))
    expect(registeredHandler).toBeUndefined()
  })
})
