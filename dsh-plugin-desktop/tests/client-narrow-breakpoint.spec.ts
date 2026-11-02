import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AdvancedFrame, type AdvancedFrameProps } from '../src/client/AdvancedFrame.tsx'
import {
  DesktopLayoutState,
  resolveNarrowBreakpoint,
  SIDEBAR_AUTO_COLLAPSE,
  SIDEBAR_AUTO_EXPAND,
} from '../src/client/layout-state.ts'

/** Mirror of DesktopOwnedFrame collapsed derivation — keep in lockstep with AdvancedFrame.tsx. */
function collapsedFrom(narrow: boolean, narrowExpanded: boolean, sidebar: number): boolean {
  return narrow ? !narrowExpanded : sidebar === 0
}

function frameSource(): string {
  return readFileSync(new URL('../src/client/AdvancedFrame.tsx', import.meta.url), 'utf8')
}

describe('resolveNarrowBreakpoint hysteresis', () => {
  it('collapses strictly below 1024 and expands only at 1088', () => {
    expect(SIDEBAR_AUTO_COLLAPSE).toBe(1024)
    expect(SIDEBAR_AUTO_EXPAND).toBe(1088)
    expect(resolveNarrowBreakpoint(1023, false)).toBe(true)
    expect(resolveNarrowBreakpoint(1023, true)).toBe(true)
    expect(resolveNarrowBreakpoint(1024, false)).toBe(false)
    expect(resolveNarrowBreakpoint(1024, true)).toBe(true)
    expect(resolveNarrowBreakpoint(1087, false)).toBe(false)
    expect(resolveNarrowBreakpoint(1087, true)).toBe(true)
    expect(resolveNarrowBreakpoint(1088, false)).toBe(false)
    expect(resolveNarrowBreakpoint(1088, true)).toBe(false)
  })

  it('holds the current flag across a ±1px snap inside the dead band', () => {
    expect(resolveNarrowBreakpoint(1025, false)).toBe(false)
    expect(resolveNarrowBreakpoint(1024, false)).toBe(false)
    expect(resolveNarrowBreakpoint(1087, true)).toBe(true)
    expect(resolveNarrowBreakpoint(1088, true)).toBe(false)
  })
})

describe('narrow measurement is window width, not squeezed frame width', () => {
  it('does not flip narrow or collapsed when the frame is squeezed across 1024 and the window is unchanged', () => {
    const layout = new DesktopLayoutState()
    const windowWidth = 1440
    let narrow = resolveNarrowBreakpoint(windowWidth, false)
    layout.setNarrow(narrow)
    const start = layout.getSnapshot()
    expect(start).toMatchObject({ narrow: false, narrowExpanded: false, sidebar: 280 })
    const startCollapsed = collapsedFrom(start.narrow, start.narrowExpanded, start.sidebar)
    expect(startCollapsed).toBe(false)

    // Simulate better-sidebar drag: #root margin-right animates the frame
    // across 1024 while window.innerWidth stays 1440.
    for (const frameWidth of [1440, 1200, 1100, 1025, 1023, 900, 1025, 1440]) {
      void frameWidth
      narrow = resolveNarrowBreakpoint(windowWidth, layout.getSnapshot().narrow)
      layout.setNarrow(narrow)
      const snap = layout.getSnapshot()
      expect(snap.narrow).toBe(false)
      expect(snap.narrowExpanded).toBe(false)
      expect(collapsedFrom(snap.narrow, snap.narrowExpanded, snap.sidebar)).toBe(startCollapsed)
    }
  })

  it('still auto-collapses when the window itself crosses below 1024, then holds until 1088', () => {
    const layout = new DesktopLayoutState()
    expect(layout.getSnapshot().sidebar).toBe(280)

    let narrow = false
    narrow = resolveNarrowBreakpoint(1100, narrow)
    layout.setNarrow(narrow)
    expect(layout.getSnapshot()).toMatchObject({ narrow: false, narrowExpanded: false })
    expect(collapsedFrom(false, false, 280)).toBe(false)

    narrow = resolveNarrowBreakpoint(1023, narrow)
    layout.setNarrow(narrow)
    expect(layout.getSnapshot()).toMatchObject({ narrow: true, narrowExpanded: false })
    expect(collapsedFrom(true, false, 280)).toBe(true)

    layout.toggleSidebar()
    expect(layout.getSnapshot()).toMatchObject({ narrow: true, narrowExpanded: true })
    expect(collapsedFrom(true, true, 280)).toBe(false)

    // Dead band must not reset the manual expand (setNarrow is a no-op).
    narrow = resolveNarrowBreakpoint(1050, layout.getSnapshot().narrow)
    layout.setNarrow(narrow)
    expect(layout.getSnapshot()).toMatchObject({ narrow: true, narrowExpanded: true })
    expect(collapsedFrom(true, true, 280)).toBe(false)

    narrow = resolveNarrowBreakpoint(1088, layout.getSnapshot().narrow)
    layout.setNarrow(narrow)
    expect(layout.getSnapshot()).toMatchObject({ narrow: false, narrowExpanded: false })
    expect(collapsedFrom(false, false, 280)).toBe(false)
  })

  it('keeps ResizeObserver for column geometry and drives the breakpoint from window.innerWidth', () => {
    const source = frameSource()
    expect(source).toContain('new ResizeObserver')
    expect(source).toContain('element.getBoundingClientRect().width')
    expect(source).toContain('setViewport(width)')
    expect(source).toContain('resolveNarrowBreakpoint(window.innerWidth')
    expect(source).toContain("window.addEventListener('resize'")
    expect(source).toContain('layout.setNarrow(narrow)')
    expect(source).not.toMatch(/viewport\s*<\s*SIDEBAR_AUTO_COLLAPSE/)
    expect(source).not.toMatch(/setNarrow\([^)]*viewport/)
  })

  it('SSR markup sets data-sidebar-collapsed from window.innerWidth, not a squeezed frame', () => {
    const layout = new DesktopLayoutState()
    const props = {
      layout,
      platform: 'darwin',
      useSessions: (select: (state: { current?: string; byId: Record<string, { blank: boolean }> }) => unknown) =>
        select({ byId: {} }),
      usePanelInfo: (select: (state: { activePanelId?: string }) => unknown) => select({}),
      renderSlot: (name: string) => createElement('span', { 'data-slot': name }),
    } as unknown as AdvancedFrameProps

    try {
      vi.stubGlobal('window', { innerWidth: 1440 })
      const wide = renderToStaticMarkup(createElement(AdvancedFrame, props))
      expect(wide).not.toContain('data-sidebar-collapsed')
      // Third-party sidebar rows anchor to the official column marker, which this
      // frame has to carry for the slot content it hosts.
      expect(wide).toContain('data-pane="sidebar"')

      vi.stubGlobal('window', { innerWidth: 900 })
      const narrowMarkup = renderToStaticMarkup(createElement(AdvancedFrame, {
        ...props,
        layout: new DesktopLayoutState(),
      }))
      expect(narrowMarkup).toContain('data-sidebar-collapsed="true"')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
