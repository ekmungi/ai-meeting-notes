/**
 * Floating recording indicator -- appears as an always-on-top mini panel
 * when Obsidian loses focus during an active recording (D050).
 *
 * Uses Obsidian's openPopoutLeaf() to create a separate OS window,
 * then accesses the underlying Electron BrowserWindow for alwaysOnTop.
 */

import type { App, WorkspaceLeaf } from "obsidian";

/** Position options for the floating indicator. */
export type IndicatorPosition = "top-right" | "center-right" | "bottom-left";

/** Callbacks for floating indicator actions. */
interface IndicatorCallbacks {
  onStop: () => void;
  onNavigate: () => void;
}

/** Margin from screen edges in pixels. */
const EDGE_MARGIN = 20;
/** Electron popout minimum is ~200x200; we request small but fill whatever we get. */
const PANEL_WIDTH = 72;
/** Request compact height; actual may be larger due to Electron minimums. */
const PANEL_HEIGHT = 160;

/**
 * Manages a floating always-on-top panel that shows recording controls
 * when Obsidian loses focus. Uses openPopoutLeaf + Electron BrowserWindow.
 */
export class FloatingIndicator {
  private app: App;
  private callbacks: IndicatorCallbacks;
  private position: IndicatorPosition = "top-right";
  private popoutLeaf: WorkspaceLeaf | null = null;
  private boundOnBlur: (() => void) | null = null;
  private boundOnFocus: (() => void) | null = null;
  private isVisible = false;
  private isActive = false;

  constructor(app: App, callbacks: IndicatorCallbacks) {
    this.app = app;
    this.callbacks = callbacks;
  }

  /** Begin monitoring main window focus. Call when recording starts. */
  activate(position: IndicatorPosition): void {
    if (this.isActive) return;
    this.isActive = true;
    this.position = position;
    this._registerFocusListeners();
  }

  /** Stop monitoring and hide the panel. Call when recording stops. */
  deactivate(): void {
    this.isActive = false;
    this.hide();
    this._removeFocusListeners();
  }

  /** Show the floating indicator window. */
  show(): void {
    if (this.isVisible || !this.isActive) return;
    this.isVisible = true;
    this._createPopout();
  }

  /** Hide the floating indicator window. */
  hide(): void {
    if (!this.isVisible) return;
    this.isVisible = false;
    this._destroyPopout();
  }

  /** Clean up all resources. Call on plugin unload. */
  destroy(): void {
    this.deactivate();
  }

  // --- Private: Focus Listeners ---

  /** Register blur/focus listeners on the DOM window.
   *
   * Uses standard DOM events instead of Electron remote API, which
   * was removed in Electron 22+ and is unavailable in modern Obsidian.
   */
  private _registerFocusListeners(): void {
    this.boundOnBlur = () => {
      if (this.isActive) this.show();
    };
    this.boundOnFocus = () => {
      this.hide();
    };

    window.addEventListener("blur", this.boundOnBlur);
    window.addEventListener("focus", this.boundOnFocus);
  }

  /** Remove blur/focus listeners from the DOM window. */
  private _removeFocusListeners(): void {
    if (this.boundOnBlur) window.removeEventListener("blur", this.boundOnBlur);
    if (this.boundOnFocus) window.removeEventListener("focus", this.boundOnFocus);
    this.boundOnBlur = null;
    this.boundOnFocus = null;
  }

  // --- Private: Popout Window ---

  /** Create the popout leaf window via Obsidian API. */
  private _createPopout(): void {
    if (this.popoutLeaf) return;

    try {
      this.popoutLeaf = (this.app.workspace as any).openPopoutLeaf();
      if (!this.popoutLeaf) {
        console.warn("FloatingIndicator: openPopoutLeaf returned null");
        this.isVisible = false;
        return;
      }
      // Allow the popout window to initialize before configuring
      setTimeout(() => this._configurePopout(), 100);
    } catch (err) {
      console.warn("FloatingIndicator: Failed to create popout:", err);
      this.isVisible = false;
      this.popoutLeaf = null;
    }
  }

  /** Configure the popout window: size, position, always-on-top, and UI. */
  private _configurePopout(): void {
    if (!this.popoutLeaf) return;

    try {
      const containerEl = this.popoutLeaf.view?.containerEl;
      const popoutWindow = (containerEl as any)?.win;
      const electronWindow = popoutWindow?.electronWindow;

      if (!electronWindow) {
        console.warn("FloatingIndicator: Cannot access Electron window from popout leaf");
        this._destroyPopout();
        return;
      }

      electronWindow.setAlwaysOnTop(true, "floating");
      electronWindow.setSkipTaskbar(true);
      electronWindow.setMinimumSize(PANEL_WIDTH, PANEL_HEIGHT);
      electronWindow.setResizable(false);
      electronWindow.setMinimizable(false);
      electronWindow.setMaximizable(false);

      const bounds = this._calculateBounds(popoutWindow);
      electronWindow.setBounds(bounds);

      this._renderUI(containerEl, popoutWindow);
    } catch (err) {
      console.warn("FloatingIndicator: Failed to configure popout:", err);
      this._destroyPopout();
    }
  }

  /** Calculate pixel bounds for the panel based on the configured position. */
  private _calculateBounds(
    popoutWindow: any,
  ): { x: number; y: number; width: number; height: number } {
    let screenWidth = 1920;
    let screenHeight = 1080;
    let originX = 0;
    let originY = 0;

    try {
      const remote =
        popoutWindow?.require?.("@electron/remote") ??
        (window as any).require("@electron/remote");

      if (remote?.screen) {
        const display = remote.screen.getPrimaryDisplay();
        const workArea = display.workArea;
        screenWidth = workArea.width;
        screenHeight = workArea.height;
        originX = workArea.x;
        originY = workArea.y;
      }
    } catch {
      // Fall through to defaults
    }

    const positions: Record<IndicatorPosition, { x: number; y: number }> = {
      "top-right": {
        x: originX + screenWidth - PANEL_WIDTH - EDGE_MARGIN,
        y: originY + EDGE_MARGIN,
      },
      "center-right": {
        x: originX + screenWidth - PANEL_WIDTH - EDGE_MARGIN,
        y: originY + Math.floor((screenHeight - PANEL_HEIGHT) / 2),
      },
      "bottom-left": {
        x: originX + EDGE_MARGIN,
        y: originY + screenHeight - PANEL_HEIGHT - EDGE_MARGIN,
      },
    };

    const pos = positions[this.position] ?? positions["top-right"];
    return { x: pos.x, y: pos.y, width: PANEL_WIDTH, height: PANEL_HEIGHT };
  }

  /** Inject minimal HTML/CSS into the popout leaf, hiding Obsidian chrome. */
  private _renderUI(containerEl: HTMLElement, popoutWindow: any): void {
    const doc: Document = popoutWindow?.document ?? containerEl.ownerDocument;
    if (!doc) return;

    // Hide all Obsidian chrome and fill window with our panel
    const style = doc.createElement("style");
    style.textContent = `
      html, body {
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
        width: 100% !important;
        height: 100% !important;
        background: var(--background-secondary, #1e1e1e) !important;
      }
      .app-container, .workspace, .workspace-split,
      .workspace-leaf, .workspace-leaf-content {
        width: 100% !important;
        height: 100% !important;
        padding: 0 !important;
        margin: 0 !important;
        background: var(--background-secondary, #1e1e1e) !important;
      }
      .titlebar, .workspace-tab-header-container, .status-bar,
      .workspace-ribbon, .sidebar-toggle-button,
      .workspace-tab-header, .view-header {
        display: none !important;
      }
      .mn-float-panel {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
        width: 100%;
        height: 100%;
        background: var(--background-secondary, #1e1e1e);
        font-family: var(--font-interface, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
        border: 1px solid var(--background-modifier-border, rgba(255,255,255,0.08));
      }
      .mn-float-btn {
        width: 40px;
        height: 40px;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: var(--radius-m, 8px);
        transition: background 0.15s;
      }
      .mn-float-btn svg { width: 20px; height: 20px; }
      .mn-float-stop {
        background: #dc2626 !important;
      }
      .mn-float-stop:hover {
        background: #b91c1c !important;
      }
      .mn-float-stop svg { fill: white; }
      .mn-float-nav {
        background: var(--background-modifier-hover, rgba(255,255,255,0.08));
      }
      .mn-float-nav:hover {
        background: var(--background-modifier-active-hover, rgba(255,255,255,0.15));
      }
      .mn-float-nav svg {
        stroke: var(--text-muted, #c0c0c0);
        fill: none;
      }
      .mn-float-nav:hover svg {
        stroke: var(--text-normal, white);
      }
    `;
    doc.head.appendChild(style);

    const contentEl = containerEl.querySelector(".workspace-leaf-content") ?? containerEl;
    contentEl.innerHTML = "";

    const panel = doc.createElement("div");
    panel.className = "mn-float-panel";

    const stopBtn = doc.createElement("button");
    stopBtn.className = "mn-float-btn mn-float-stop";
    stopBtn.title = "Stop recording";
    stopBtn.innerHTML =
      '<svg viewBox="0 0 18 18"><rect x="4" y="4" width="10" height="10" rx="2"/></svg>';
    stopBtn.addEventListener("click", () => {
      this.callbacks.onStop();
      this.deactivate();
    });

    const navBtn = doc.createElement("button");
    navBtn.className = "mn-float-btn mn-float-nav";
    navBtn.title = "Back to Obsidian";
    navBtn.innerHTML =
      '<svg viewBox="0 0 18 18"><path d="M6 9L3 12l3 3M3 12h7a4 4 0 0 0 0-8H7" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    navBtn.addEventListener("click", () => {
      this.callbacks.onNavigate();
      this.hide();
    });

    panel.appendChild(stopBtn);
    panel.appendChild(navBtn);
    contentEl.appendChild(panel);
  }

  /** Close and detach the popout leaf. */
  private _destroyPopout(): void {
    if (this.popoutLeaf) {
      try {
        this.popoutLeaf.detach();
      } catch {
        // Leaf may already be detached
      }
      this.popoutLeaf = null;
    }
  }
}
