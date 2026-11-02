import type { ILayout, MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Advanced-shell panel state shared by the root slot and layout-service adapter. */
export interface DesktopLayoutSnapshot {
  /** Preferred sidebar width; zero means the compact rail. */
  sidebar: number
  /** Saved right Sidebar width; null uses the initial frame ratio. */
  rightbar: number | null
  rightbarShown: boolean
  rightbarTrack: boolean
  rightbarFullscreen: boolean
  /** Whether the current viewport is below the automatic-collapse breakpoint. */
  narrow: boolean
  /** Manual narrow-screen override that temporarily expands the rail. */
  narrowExpanded: boolean
}

/** Column geometry after preserving the center surface. */
export interface DesktopColumns {
  /** Rendered sidebar width. */
  sidebar: number
  /** Rendered center width. */
  center: number
  /** Rendered rightbar width. */
  rightbar: number
}

/** Default compact rail used by the upstream sidebar. */
export const SIDEBAR_COLLAPSED = 56
/** Wider compact rail reserved only for the enhanced macOS presentation. */
export const MACOS_SIDEBAR_COLLAPSED = 90
export const SIDEBAR_DEFAULT = 280
export const SIDEBAR_MIN = 264
export const SIDEBAR_MAX = 420
export const SIDEBAR_AUTO_COLLAPSE = 1024
/**
 * Expand only after the window clears the collapse point by 64px (1088).
 * Window-manager snap/dock commonly jiggles ±1px around a round size; 64px
 * absorbs that jitter without making the expand feel delayed — the user has
 * already resized past 1024 by a noticeable amount. Collapse still fires
 * strictly below 1024 so a genuinely small window auto-hides the rail.
 */
export const SIDEBAR_AUTO_EXPAND = SIDEBAR_AUTO_COLLAPSE + 64
export const RIGHTBAR_DEFAULT_RATIO = 0.45
export const RIGHTBAR_MIN = 300
export const RIGHTBAR_MAX_RATIO = 0.7
export const CENTER_MIN = 400

/** Keep the wider macOS rail private to enhanced mode; extended uses upstream geometry. */
export function collapsedSidebarWidth(
  mode: 'extended' | 'advanced',
  platform: 'darwin' | 'win32' | 'linux',
): number {
  return mode === 'advanced' && platform === 'darwin'
    ? MACOS_SIDEBAR_COLLAPSED
    : SIDEBAR_COLLAPSED
}

/**
 * Resolve the automatic-collapse flag from **window** width, not frame width.
 * Dragging the better-sidebar splitter writes `--dsh-sidebar-width` and
 * transitions `#root { margin-right }`, which squeezes the frame across 1024
 * while `window.innerWidth` stays put. Using frame width here flashes the
 * official left rail. The hysteresis band (`[SIDEBAR_AUTO_COLLAPSE,
 * SIDEBAR_AUTO_EXPAND)`) keeps the current flag so snap/dock ±1px does not
 * flip `narrow` (which would also reset `narrowExpanded`).
 * @param windowWidth - `window.innerWidth`.
 * @param currentlyNarrow - last published `narrow` flag.
 * @returns whether the window should be treated as narrow.
 */
export function resolveNarrowBreakpoint(windowWidth: number, currentlyNarrow: boolean): boolean {
  if (windowWidth < SIDEBAR_AUTO_COLLAPSE) return true
  if (windowWidth >= SIDEBAR_AUTO_EXPAND) return false
  return currentlyNarrow
}

/**
 * Resolve three desktop columns without allowing rightbar to squeeze the conversation below its floor.
 * @param viewport - available frame width.
 * @param sidebar - sidebar preference, where zero selects the compact rail.
 * @param rightbar - rightbar preference, where zero closes the panel.
 * @returns rendered column widths.
 */
export function computeDesktopColumns(
  viewport: number,
  sidebar: number,
  rightbar: number,
  collapsedWidth: number = SIDEBAR_COLLAPSED,
): DesktopColumns {
  const sidebarWidth = sidebar === 0 ? collapsedWidth : clamp(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const available = viewport - sidebarWidth - CENTER_MIN
  const resolvedRightbar = rightbar === 0 || available < RIGHTBAR_MIN
    ? 0
    : Math.min(available, clamp(rightbar, RIGHTBAR_MIN, viewport * RIGHTBAR_MAX_RATIO))
  return { sidebar: sidebarWidth, center: Math.max(0, viewport - sidebarWidth - resolvedRightbar), rightbar: resolvedRightbar }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Small observable panel controller used by the advanced root registration. */
export class DesktopLayoutState implements ILayout {
  private panel: PanelInfo = Object.freeze({ activePanelId: null })
  private readonly panelListeners = new Set<() => void>()
  private navigation = new AbortController()

  constructor(private readonly hasMainPanel: (id: MainPanelId) => boolean = () => false) {}

  /** Selected global panel; the layout contract exposes it as an observable. */
  readonly panelInfo: HostObservable<PanelInfo> = {
    getSnapshot: () => this.panel,
    subscribe: (listener: () => void) => {
      this.panelListeners.add(listener)
      return () => { this.panelListeners.delete(listener) }
    },
  }

  /** Root selection remains independent of the active Session and column geometry. */
  getPanelInfo(): PanelInfo { return this.panel }

  /** Select a registered global panel, or return to the Conversation. */
  selectPanel(panelId: MainPanelId | null): void {
    if (panelId !== null && !this.hasMainPanel(panelId)) {
      throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
    }
    this.navigation.abort()
    if (this.panel.activePanelId === panelId) return
    this.panel = Object.freeze({ activePanelId: panelId })
    // The panel observable and the layout snapshot are separate channels, and
    // both audiences must learn about a selection change.
    for (const listener of this.panelListeners) listener()
    for (const listener of this.listeners) listener()
  }

  /** Return to the Conversation when the selected plugin panel is unloaded. */
  retainMainPanels(): void {
    const id = this.panel.activePanelId
    if (id !== null && !this.hasMainPanel(id)) this.selectPanel(null)
  }

  /** Supersede pending asynchronous navigation. */
  beginNavigation(): AbortSignal {
    this.navigation.abort()
    this.navigation = new AbortController()
    return this.navigation.signal
  }

  /** Invalidate pending work when the owning layout unloads. */
  dispose(): void { this.navigation.abort() }

  private snapshot: DesktopLayoutSnapshot = Object.freeze({
    sidebar: SIDEBAR_DEFAULT,
    rightbar: null,
    rightbarShown: false,
    rightbarTrack: false,
    rightbarFullscreen: false,
    narrow: false,
    narrowExpanded: false,
  })
  private readonly listeners = new Set<() => void>()

  /** @returns the immutable current panel snapshot. */
  getSnapshot(): DesktopLayoutSnapshot {
    return this.snapshot
  }

  /** @param listener - callback notified after a snapshot replacement. @returns its disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Toggle the wide sidebar and the platform-selected compact rail. */
  toggleSidebar(): void {
    if (this.snapshot.narrow) {
      this.publish({ ...this.snapshot, narrowExpanded: !this.snapshot.narrowExpanded })
      return
    }
    this.publish({ ...this.snapshot, sidebar: this.snapshot.sidebar === 0 ? SIDEBAR_DEFAULT : 0 })
  }

  /** @param narrow - whether the window is below the automatic-collapse breakpoint. */
  setNarrow(narrow: boolean): void {
    if (this.snapshot.narrow === narrow) return
    this.publish({ ...this.snapshot, narrow, narrowExpanded: false })
  }

  /** Report the upstream panel presentation, preserving its saved width. */
  openRightbar(track: boolean, fullscreen: boolean): void {
    if (this.snapshot.rightbarShown && this.snapshot.rightbarTrack === track
      && this.snapshot.rightbarFullscreen === fullscreen) return
    this.publish({ ...this.snapshot, rightbarShown: true, rightbarTrack: track,
      rightbarFullscreen: fullscreen,
      narrowExpanded: this.snapshot.narrow ? false : this.snapshot.narrowExpanded })
  }

  /** Clear presentation when the upstream panel closes or unmounts. */
  closeRightbar(): void {
    if (!this.snapshot.rightbarShown) return
    this.publish({ ...this.snapshot, rightbarShown: false, rightbarTrack: false, rightbarFullscreen: false })
  }

  /** @param width - requested sidebar width from a resize gesture. */
  setSidebar(width: number): void {
    this.publish({ ...this.snapshot, sidebar: clamp(width, SIDEBAR_MIN, SIDEBAR_MAX) })
  }

  /** @param width - requested rightbar width from a resize gesture. */
  setRightbar(width: number, viewport: number): void {
    this.publish({ ...this.snapshot, rightbar: clamp(width, RIGHTBAR_MIN, Math.max(RIGHTBAR_MIN, viewport * RIGHTBAR_MAX_RATIO)) })
  }

  private publish(next: DesktopLayoutSnapshot): void {
    this.snapshot = Object.freeze(next)
    for (const listener of this.listeners) listener()
  }
}
