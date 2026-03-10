/**
 * Floating recording indicator -- appears as an always-on-top mini window
 * when Obsidian loses focus during an active recording.
 *
 * Creates a raw Electron BrowserWindow via @electron/remote for exact
 * size control (no Obsidian workspace chrome or minimum size constraints).
 * Button clicks communicate back via document.title changes.
 */

import type { App } from "obsidian";

/** Position options for the floating indicator. */
export type IndicatorPosition = "top-right" | "center-right" | "bottom-left";

/** Callbacks for floating indicator actions. */
interface IndicatorCallbacks {
  onStop: () => void;
  onNavigate: () => void;
}

/** Margin from screen edges in pixels. */
const EDGE_MARGIN = 4;
/** Window width — just enough for a single column of buttons. */
const WIN_WIDTH = 58;
/** Window height — two 50px buttons + gap + padding. */
const WIN_HEIGHT = 116;

/** Inline HTML loaded into the raw BrowserWindow (no node/electron deps). */
function buildFloatHtml(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>float</title>
<style>
  html, body {
    margin: 0; padding: 0; overflow: hidden;
    width: 100%; height: 100%;
    background: #1e1e1e;
    -webkit-app-region: drag;
  }
  .panel {
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 6px; width: 100%; height: 100%;
    box-sizing: border-box; padding: 4px;
  }
  .btn {
    width: 50px; height: 50px;
    border: none; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    border-radius: 8px;
    -webkit-app-region: no-drag;
    transition: background 0.12s;
  }
  .btn svg { width: 28px; height: 28px; }
  .stop { background: #dc2626; }
  .stop:hover { background: #b91c1c; }
  .stop svg { fill: white; }
  .nav { background: rgba(255,255,255,0.08); }
  .nav:hover { background: rgba(255,255,255,0.15); }
  .nav svg { stroke: #c0c0c0; fill: none; }
  .nav:hover svg { stroke: white; }
</style>
</head><body>
<div class="panel">
  <button class="btn stop" id="stop" title="Stop recording">
    <svg viewBox="2 2 14 14"><rect x="4" y="4" width="10" height="10" rx="2"/></svg>
  </button>
  <button class="btn nav" id="nav" title="Back to Obsidian">
    <svg viewBox="1 2 15 14"><path d="M6 9L3 12l3 3M3 12h7a4 4 0 0 0 0-8H7" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </button>
</div>
</body></html>`;
}

/**
 * Manages a floating always-on-top mini window that shows recording
 * controls when Obsidian loses focus. Uses a raw Electron BrowserWindow
 * for pixel-perfect sizing (no Obsidian popout chrome).
 */
export class FloatingIndicator {
  private app: App;
  private callbacks: IndicatorCallbacks;
  private position: IndicatorPosition = "center-right";
  private floatWin: any = null;
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
    this._createWindow();
  }

  /** Hide the floating indicator window. */
  hide(): void {
    if (!this.isVisible) return;
    this.isVisible = false;
    this._destroyWindow();
  }

  /** Clean up all resources. Call on plugin unload. */
  destroy(): void {
    this.deactivate();
  }

  // --- Private: Focus Listeners ---

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

  private _removeFocusListeners(): void {
    if (this.boundOnBlur) window.removeEventListener("blur", this.boundOnBlur);
    if (this.boundOnFocus) window.removeEventListener("focus", this.boundOnFocus);
    this.boundOnBlur = null;
    this.boundOnFocus = null;
  }

  // --- Private: Raw Electron BrowserWindow ---

  /** Try to get @electron/remote module. */
  private _getRemote(): any {
    try {
      return (window as any).require("@electron/remote");
    } catch {
      return null;
    }
  }

  /** Create a raw Electron BrowserWindow (no Obsidian chrome). */
  private _createWindow(): void {
    if (this.floatWin) return;

    const remote = this._getRemote();
    if (!remote?.BrowserWindow) {
      console.warn("FloatingIndicator: @electron/remote not available");
      this.isVisible = false;
      return;
    }

    const pos = this._calculatePosition(remote);

    this.floatWin = new remote.BrowserWindow({
      x: pos.x,
      y: pos.y,
      width: WIN_WIDTH,
      height: WIN_HEIGHT,
      frame: false,
      transparent: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: true,
      show: false,
      backgroundColor: "#1e1e1e",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    // Load inline HTML
    this.floatWin.loadURL(
      "data:text/html;charset=utf-8," + encodeURIComponent(buildFloatHtml()),
    );

    // Once content is rendered, wire button clicks and show
    this.floatWin.webContents.once("did-finish-load", () => {
      if (!this.floatWin || !this.isVisible) return;

      // Inject click handlers that signal back via title change
      this.floatWin.webContents.executeJavaScript(`
        document.getElementById("stop").addEventListener("click", () => {
          document.title = "action:stop";
        });
        document.getElementById("nav").addEventListener("click", () => {
          document.title = "action:nav";
        });
      `);

      this.floatWin.showInactive();
    });

    // Listen for title changes as button-click signals
    this.floatWin.on("page-title-updated", (_e: any, title: string) => {
      if (title === "action:stop") {
        this.callbacks.onStop();
        this.deactivate();
      } else if (title === "action:nav") {
        this.callbacks.onNavigate();
        this.hide();
      }
    });

    // Edge-snap on drag release
    this.floatWin.on("moved", () => {
      this._edgeSnap(remote);
    });

    // Clean up reference if window is closed externally
    this.floatWin.on("closed", () => {
      this.floatWin = null;
      this.isVisible = false;
    });
  }

  /** Snap window to nearest horizontal screen edge after drag. */
  private _edgeSnap(remote: any): void {
    if (!this.floatWin || !remote?.screen) return;
    try {
      const [x, y] = this.floatWin.getPosition();
      const [w] = this.floatWin.getSize();
      const display = remote.screen.getDisplayNearestPoint({ x, y });
      const area = display.workArea;
      const midpoint = area.x + area.width / 2;
      const snappedX = (x + w / 2) < midpoint
        ? area.x + EDGE_MARGIN
        : area.x + area.width - w - EDGE_MARGIN;
      this.floatWin.setPosition(snappedX, y);
    } catch {
      // Screen API issue; skip snapping
    }
  }

  /** Calculate initial position based on configured placement. */
  private _calculatePosition(remote: any): { x: number; y: number } {
    let screenWidth = 1920;
    let screenHeight = 1080;
    let originX = 0;
    let originY = 0;

    try {
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
        x: originX + screenWidth - WIN_WIDTH - EDGE_MARGIN,
        y: originY + EDGE_MARGIN,
      },
      "center-right": {
        x: originX + screenWidth - WIN_WIDTH - EDGE_MARGIN,
        y: originY + Math.floor((screenHeight - WIN_HEIGHT) / 2),
      },
      "bottom-left": {
        x: originX + EDGE_MARGIN,
        y: originY + screenHeight - WIN_HEIGHT - EDGE_MARGIN,
      },
    };

    return positions[this.position] ?? positions["center-right"];
  }

  /** Close and destroy the float window. */
  private _destroyWindow(): void {
    if (this.floatWin) {
      try {
        this.floatWin.close();
      } catch {
        // Window may already be closed
      }
      this.floatWin = null;
    }
  }
}
