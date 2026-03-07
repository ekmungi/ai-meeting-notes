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
/** Panel width in pixels. */
const PANEL_WIDTH = 220;
/** Panel height in pixels. */
const PANEL_HEIGHT = 64;

/**
 * Manages a floating always-on-top panel that shows recording controls
 * when Obsidian loses focus. Uses openPopoutLeaf + Electron BrowserWindow.
 */
export class FloatingIndicator {
  private app: App;
  private callbacks: IndicatorCallbacks;
  private position: IndicatorPosition = "top-right";
  private popoutLeaf: WorkspaceLeaf | null = null;
  private mainWindow: any = null;
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

  /** Register blur/focus listeners on the main Obsidian Electron window. */
  private _registerFocusListeners(): void {
    try {
      const remote = (window as any).require("@electron/remote");
      if (!remote) return;
      this.mainWindow = remote.getCurrentWindow();
      if (!this.mainWindow) return;

      this.boundOnBlur = () => {
        if (this.isActive) this.show();
      };
      this.boundOnFocus = () => {
        this.hide();
      };

      this.mainWindow.on("blur", this.boundOnBlur);
      this.mainWindow.on("focus", this.boundOnFocus);
    } catch (err) {
      console.warn("FloatingIndicator: Electron remote not available:", err);
    }
  }

  /** Remove blur/focus listeners from the main Electron window. */
  private _removeFocusListeners(): void {
    if (this.mainWindow) {
      if (this.boundOnBlur) this.mainWindow.removeListener("blur", this.boundOnBlur);
      if (this.boundOnFocus) this.mainWindow.removeListener("focus", this.boundOnFocus);
    }
    this.mainWindow = null;
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

    // Hide all Obsidian chrome in the popout
    const style = doc.createElement("style");
    style.textContent = `
      body {
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
        background: transparent !important;
      }
      .app-container, .workspace, .workspace-split, .workspace-leaf {
        background: transparent !important;
      }
      .titlebar, .workspace-tab-header-container, .status-bar,
      .workspace-ribbon, .sidebar-toggle-button,
      .workspace-tab-header, .view-header {
        display: none !important;
      }
      .workspace-leaf-content {
        padding: 0 !important;
        background: transparent !important;
      }
      .mn-float-panel {
        display: flex;
        align-items: center;
        width: ${PANEL_WIDTH}px;
        height: ${PANEL_HEIGHT}px;
        background: rgba(30, 30, 30, 0.95);
        border-radius: 10px;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
        border: 1px solid rgba(255, 255, 255, 0.08);
      }
      .mn-float-stop {
        flex: 0 0 80px;
        height: 100%;
        background: #dc2626;
        border: none;
        color: white;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        transition: background 0.15s;
      }
      .mn-float-stop:hover { background: #b91c1c; }
      .mn-float-stop svg { width: 16px; height: 16px; fill: white; }
      .mn-float-nav {
        flex: 1;
        height: 100%;
        background: transparent;
        border: none;
        color: #e5e5e5;
        font-size: 13px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        transition: background 0.15s;
        padding: 0 12px;
      }
      .mn-float-nav:hover { background: rgba(255, 255, 255, 0.08); }
      .mn-float-nav svg { width: 14px; height: 14px; fill: currentColor; }
    `;
    doc.head.appendChild(style);

    const contentEl = containerEl.querySelector(".workspace-leaf-content") ?? containerEl;
    contentEl.innerHTML = "";

    const panel = doc.createElement("div");
    panel.className = "mn-float-panel";

    const stopBtn = doc.createElement("button");
    stopBtn.className = "mn-float-stop";
    stopBtn.innerHTML =
      '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/></svg> Stop';
    stopBtn.addEventListener("click", () => {
      this.callbacks.onStop();
      this.deactivate();
    });

    const navBtn = doc.createElement("button");
    navBtn.className = "mn-float-nav";
    navBtn.innerHTML =
      'Transcript <svg viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" fill="none" stroke-width="2"/></svg>';
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
