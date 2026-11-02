import {
  ADVANCED_MACOS_DRAG_LAYER_Z_INDEX,
  ADVANCED_MACOS_DRAG_REGION_HEIGHT,
  ADVANCED_WINDOWS_TITLEBAR_HEIGHT,
  MACOS_TRAFFIC_LIGHT_SAFE_WIDTH,
  WINDOWS_CAPTION_CONTROLS_WIDTH,
} from '../window-chrome.ts'
import { SIDEBAR_COLLAPSED } from './layout-state.ts'

/** Desktop-owned shell stylesheet kept as a plain string so the client bundle stays self-contained. */
const DESKTOP_OWNED_STYLES = `
html, body, #root { width: 100%; height: 100%; }
body:is([data-dsh-desktop-mode="extended"], [data-dsh-desktop-mode="advanced"]) { margin: 0; background: transparent !important; }
.dshDesktopFrame { position: relative; display: grid; grid-template-rows: 100%; width: 100%; height: 100%; overflow: hidden; background: transparent; transition: grid-template-columns var(--ds-transition-duration-slow) var(--ds-ease-in-out); }
.dshDesktopSidebarSurface { --dsw-specific-sidebar-fill: transparent; position: relative; grid-column: 1; grid-row: 1; min-width: 0; overflow: hidden; background: transparent; border-right: 1px solid var(--dsw-alias-border-l1); }
body:is([data-dsh-desktop-mode="extended"], [data-dsh-desktop-mode="advanced"])[data-dsh-desktop-material="off"] .dshDesktopSidebarSurface { --dsw-specific-sidebar-fill: var(--dsw-alias-bg-layer-1); background: var(--dsw-alias-bg-layer-1); }
.dshDesktopUpstreamSidebar { box-sizing: border-box; width: 100%; height: 100%; }
body:is([data-dsh-desktop-mode="extended"], [data-dsh-desktop-mode="advanced"]) [data-slot="sidebar.footer.action"] { display: flex !important; flex-direction: column; gap: 6px; min-width: 0; width: 100%; max-height: min(40vh, 240px); overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
body:is([data-dsh-desktop-mode="extended"], [data-dsh-desktop-mode="advanced"]) [data-slot="sidebar.footer.action"] > * { flex: none; min-width: 0; }
.dshDesktopFrame[data-desktop-mode="advanced"][data-desktop-platform="darwin"][data-sidebar-collapsed] .dshDesktopUpstreamSidebar { width: ${SIDEBAR_COLLAPSED}px; margin: 0 auto; }
.dshDesktopFrame[data-desktop-mode="advanced"][data-desktop-platform="darwin"] .dshDesktopSidebarSurface::before { content: ""; position: absolute; z-index: ${ADVANCED_MACOS_DRAG_LAYER_Z_INDEX}; top: 0; right: 0; left: ${MACOS_TRAFFIC_LIGHT_SAFE_WIDTH}px; height: ${ADVANCED_MACOS_DRAG_REGION_HEIGHT}px; user-select: none; -webkit-app-region: drag; }
.dshDesktopFrame[data-desktop-mode="advanced"][data-desktop-platform="darwin"] .dshDesktopSidebarSurface [class*="logoRow"],
.dshDesktopFrame[data-desktop-mode="advanced"][data-desktop-platform="darwin"] .dshDesktopSidebarSurface [class*="logoRow"] * { position: relative; z-index: ${ADVANCED_MACOS_DRAG_LAYER_Z_INDEX + 1}; -webkit-app-region: no-drag !important; pointer-events: auto !important; }
body[data-dsh-desktop-platform="darwin"] :is([class*="sidebarCol"], .dshDesktopSidebarSurface) [class*="_root"]:not([class*="collapsed"]) { padding-top: 4px !important; }
body[data-dsh-desktop-platform="darwin"] :is([class*="sidebarCol"], .dshDesktopSidebarSurface) [class*="_root"]:not([class*="collapsed"]) [class*="logoRow"] { height: ${ADVANCED_MACOS_DRAG_REGION_HEIGHT}px !important; padding-left: 72px !important; margin-bottom: 6px !important; }
body[data-dsh-desktop-platform="darwin"] :is([class*="sidebarCol"], .dshDesktopSidebarSurface) [class*="_root"][class*="collapsed"] { padding-top: 42px !important; }
body[data-dsh-desktop-platform="darwin"] [class*="_panel"] { padding-top: 0 !important; }
body[data-dsh-desktop-platform="darwin"]:not([data-dsh-sidebar-collapsed]) [class*="toggleCluster"],
body[data-dsh-desktop-platform="darwin"] .dshDesktopFrame:not([data-sidebar-collapsed]) [class*="toggleCluster"] { top: 3px !important; }
body[data-dsh-desktop-platform="darwin"][data-dsh-sidebar-collapsed] [class*="toggleCluster"],
body[data-dsh-desktop-platform="darwin"] .dshDesktopFrame[data-sidebar-collapsed] [class*="toggleCluster"] { top: 14px !important; }
body[data-dsh-desktop-platform="darwin"] header,
body[data-dsh-desktop-platform="darwin"] [data-slot="conversation.session.header"],
body[data-dsh-desktop-platform="darwin"] [data-slot="conversation"] > header,
body[data-dsh-desktop-platform="darwin"] [data-slot="shell.overlay"] header,
body[data-dsh-desktop-platform="darwin"] [class*="PageHeader"],
body[data-dsh-desktop-platform="darwin"] [class*="pageHeader"],
body[data-dsh-desktop-platform="darwin"] [class*="-stage"] > header,
body[data-dsh-desktop-platform="darwin"] [class*="-stage"] > [class*="Header"],
body[data-dsh-desktop-platform="darwin"] .sh-plaza-page > header,
body[data-dsh-desktop-platform="darwin"] .dshUk-PageHeader-pageHeader { -webkit-app-region: drag; }
.dshDesktopConversationSurface { grid-column: 2; grid-row: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--dsw-alias-bg-base); }
.dshDesktopRightbarSurface { position: relative; grid-column: 3; grid-row: 1; min-width: 0; min-height: 0; overflow: visible; }
.dshDesktopFrame[data-rightbar-fullscreen], .dshDesktopFrame[data-rightbar-fullscreen] .dshDesktopResizeHandle { transition: none; }
.dshDesktopFrame[data-desktop-mode="advanced"][data-desktop-platform="win32"] { grid-template-rows: ${ADVANCED_WINDOWS_TITLEBAR_HEIGHT}px minmax(0, 1fr); }
.dshDesktopFrame[data-desktop-mode="advanced"][data-desktop-platform="win32"] .dshDesktopSidebarSurface { grid-row: 1 / -1; }
.dshDesktopFrame[data-desktop-mode="advanced"][data-desktop-platform="win32"] .dshDesktopConversationSurface,
.dshDesktopFrame[data-desktop-mode="advanced"][data-desktop-platform="win32"] .dshDesktopRightbarSurface { grid-row: 2; }
.dshDesktopWindowsCaptionRow { position: relative; grid-column: 2 / -1; grid-row: 1; min-width: 0; background: var(--dsw-alias-bg-base); }
.dshDesktopWindowsCaptionRow::before { content: ""; position: absolute; inset: 0 ${WINDOWS_CAPTION_CONTROLS_WIDTH}px 0 0; user-select: none; -webkit-app-region: drag; }
.dshDesktopFrame[data-dragging] { transition: none; }
.dshDesktopOverlay { position: absolute; z-index: 1000; inset: 0; pointer-events: none; }
.dshDesktopOverlay > * { pointer-events: auto; }
.dshDesktopResizeHandle { position: absolute; z-index: 50; top: 0; bottom: 0; width: 8px; margin-left: -4px; cursor: col-resize; touch-action: none; -webkit-app-region: no-drag; transition: left var(--ds-transition-duration-slow) var(--ds-ease-in-out); }
.dshDesktopFrame[data-dragging] .dshDesktopResizeHandle { transition: none; }
.dshDesktopNoDrag, button, input, textarea, select, label, summary, a, [contenteditable="true"], [role="button"], [role="checkbox"], [role="dialog"], [role="menuitem"], [role="option"], [role="switch"], [role="tab"], [class*="toggleCluster"], [class*="toggleCluster"] *, [class*="toggleButton"], [class*="toggleButton"] *, [class*="bottomClose"], [class*="bottomClose"] * { -webkit-app-region: no-drag !important; }
[role="dialog"], [aria-modal="true"] { -webkit-app-region: no-drag !important; }
html:has([aria-modal="true"]) .dshDesktopWindowsCaptionRow::before { -webkit-app-region: no-drag !important; }
@media (prefers-reduced-motion: reduce) {
  .dshDesktopFrame,
  .dshDesktopResizeHandle { transition: none !important; }
}
`

/** Install shared panel styles; mode selectors keep enhanced and extended chrome independent. */
export function installDesktopOwnedStyles(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-plugin-desktop'
  style.dataset.pluginCss = 'dsh-plugin-desktop/desktop-owned-layout'
  style.textContent = DESKTOP_OWNED_STYLES
  document.head.appendChild(style)
  return () => { style.remove() }
}
