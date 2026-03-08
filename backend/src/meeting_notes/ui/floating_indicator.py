"""Floating recording indicator -- always-on-top mini panel for desktop app.

Shows a small panel with Stop and Transcript buttons when the main window
loses focus during an active recording. The window is created once at
startup (hidden) and toggled via show/hide for thread safety.
"""

from __future__ import annotations

import ctypes
import logging
import os
import threading
import time
from typing import Any, Callable

logger = logging.getLogger(__name__)

# Panel dimensions (vertical layout: 3 stacked circle buttons)
# Width: 36px button + 4px padding each side = 44px
# Height: 3 * 36px buttons + 2 * 4px gaps + 2 * 4px padding = 124px
PANEL_WIDTH = 44
PANEL_HEIGHT = 124
EDGE_MARGIN = 0

# Focus polling interval (seconds)
_POLL_INTERVAL = 0.5


def calculate_position(
    position: str, screen_width: int, screen_height: int
) -> tuple[int, int]:
    """Calculate pixel coordinates for the indicator panel.

    Args:
        position: Edge position string (e.g. "top-right", "center-left").
        screen_width: Screen width in pixels.
        screen_height: Screen height in pixels.

    Returns:
        Tuple of (x, y) coordinates for the top-left corner.
    """
    center_y = (screen_height - PANEL_HEIGHT) // 2
    positions = {
        "top-left": (EDGE_MARGIN, EDGE_MARGIN),
        "top-right": (screen_width - PANEL_WIDTH - EDGE_MARGIN, EDGE_MARGIN),
        "center-left": (EDGE_MARGIN, center_y),
        "center-right": (screen_width - PANEL_WIDTH - EDGE_MARGIN, center_y),
        "bottom-left": (EDGE_MARGIN, screen_height - PANEL_HEIGHT - EDGE_MARGIN),
        "bottom-right": (screen_width - PANEL_WIDTH - EDGE_MARGIN, screen_height - PANEL_HEIGHT - EDGE_MARGIN),
    }
    return positions.get(position, positions["center-right"])


def build_indicator_html() -> str:
    """Return the HTML string for the floating indicator panel.

    Contains a red Stop button and a Transcript navigation button.
    Buttons call pywebview.api methods via the JS bridge.
    """
    return """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: transparent !important; overflow: hidden;
    -webkit-user-select: none; user-select: none;
    width: 100%; height: 100%; }
  .mn-col {
    display: flex; flex-direction: column; align-items: center;
    justify-content: center;
    gap: 4px; background: #1e1e1e; border-radius: 22px;
    padding: 4px; width: 100%; height: 100%;
    box-shadow: 0 4px 24px rgba(0,0,0,0.6);
  }
  .mn-btn {
    border: none; cursor: pointer; display: flex;
    align-items: center; justify-content: center;
    border-radius: 50%; width: 36px; height: 36px;
    transition: background 0.15s;
  }
  .mn-btn svg { width: 18px; height: 18px; }
  .mn-btn-stop { background: #dc2626; }
  .mn-btn-stop:hover { background: #b91c1c; }
  .mn-btn-stop svg { fill: white; }
  .mn-btn-back { background: rgba(255,255,255,0.08); }
  .mn-btn-back:hover { background: rgba(255,255,255,0.15); }
  .mn-btn-back svg { stroke: #c0c0c0; fill: none; }
  .mn-btn-back:hover svg { stroke: white; }
  .mn-btn-close { background: transparent; }
  .mn-btn-close:hover { background: rgba(255,255,255,0.08); }
  .mn-btn-close svg { stroke: #606060; }
  .mn-btn-close:hover svg { stroke: #a0a0a0; }
</style>
</head>
<body>
<div class="mn-col">
  <button class="mn-btn mn-btn-stop" onclick="pywebview.api.stop_recording()" title="Stop recording">
    <svg viewBox="0 0 18 18"><rect x="4" y="4" width="10" height="10" rx="2"/></svg>
  </button>
  <button class="mn-btn mn-btn-back" onclick="pywebview.api.go_to_main()" title="Back to app">
    <svg viewBox="0 0 18 18"><path d="M9 14V4M5 8l4-4 4 4" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </button>
  <button class="mn-btn mn-btn-close" onclick="pywebview.api.dismiss()" title="Dismiss">
    <svg viewBox="0 0 18 18"><path d="M5 5l8 8M13 5l-8 8" stroke-width="1.8" stroke-linecap="round"/></svg>
  </button>
</div>
</body>
</html>"""


def _get_screen_size() -> tuple[int, int]:
    """Get primary screen dimensions using ctypes (Windows).

    Returns:
        Tuple of (width, height) in pixels. Falls back to 1920x1080.
    """
    try:
        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        return user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    except Exception:
        return 1920, 1080


def _get_foreground_hwnd() -> int:
    """Get the HWND of the currently focused window (Windows).

    Returns:
        Window handle, or 0 on failure.
    """
    try:
        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        return user32.GetForegroundWindow()
    except Exception:
        return 0


class _FloatAPI:
    """JS API bridge for the floating indicator window."""

    def __init__(
        self,
        on_stop: Callable[[], None],
        on_navigate: Callable[[], None],
        on_dismiss: Callable[[], None],
    ) -> None:
        self._on_stop = on_stop
        self._on_navigate = on_navigate
        self._on_dismiss = on_dismiss

    def stop_recording(self) -> None:
        """Called from JS when stop button is clicked."""
        self._on_stop()

    def go_to_main(self) -> None:
        """Called from JS when back button is clicked."""
        self._on_navigate()

    def dismiss(self) -> None:
        """Called from JS when close button is clicked. Hides without stopping."""
        self._on_dismiss()


class FloatingIndicator:
    """Manages a floating always-on-top indicator window for the desktop app.

    The window is created once at startup (hidden=True) so it lives on the
    GUI thread.  show()/hide() toggle visibility from any thread.  Focus
    polling detects when the main window loses/gains focus.
    """

    def __init__(self, main_window: Any, on_stop: Callable[[], None]) -> None:
        self._main_window = main_window
        self._on_stop = on_stop
        self._float_window: Any = None
        self._poll_thread: threading.Thread | None = None
        self._polling = False
        self._position = "center-right"
        self.is_visible = False
        self._main_hwnd_cache: int = 0

    def create_hidden_window(self) -> None:
        """Create the floating window in a hidden state.

        Must be called BEFORE webview.start() so that pywebview creates
        the window on the GUI thread.  The window stays hidden until
        show() is called.
        """
        try:
            import webview  # type: ignore[import-untyped]

            api = _FloatAPI(
                on_stop=self._on_stop_and_hide,
                on_navigate=self._navigate_and_hide,
                on_dismiss=self._dismiss,
            )

            # Create off-screen (-9999) to prevent flash on startup.
            # show() moves it to the correct position before making visible.
            self._float_window = webview.create_window(
                title="Recording",
                html=build_indicator_html(),
                js_api=api,
                width=PANEL_WIDTH,
                height=PANEL_HEIGHT,
                min_size=(PANEL_WIDTH, PANEL_HEIGHT),
                x=-9999,
                y=-9999,
                on_top=True,
                frameless=True,
                resizable=False,
                hidden=True,
                transparent=True,
            )
            logger.info("Floating indicator window created (hidden)")
        except Exception:
            logger.warning(
                "Failed to create floating indicator window", exc_info=True
            )

    def start_monitoring(self, position: str = "center-right") -> None:
        """Start polling for main window focus loss.

        Args:
            position: Screen edge for the indicator panel.
        """
        if not self._float_window:
            logger.warning("No floating window — skipping monitoring")
            return
        self._position = position
        self._polling = True
        self._poll_thread = threading.Thread(
            target=self._focus_poll_loop,
            name="float-indicator-poll",
            daemon=True,
        )
        self._poll_thread.start()

    def stop_monitoring(self) -> None:
        """Stop polling and hide the indicator."""
        self._polling = False
        self.hide()
        if self._poll_thread:
            self._poll_thread.join(timeout=2)
            self._poll_thread = None

    def show(self) -> None:
        """Show the floating indicator window at the configured position."""
        if self.is_visible or not self._float_window:
            return
        self.is_visible = True
        try:
            # Move to configured position before showing
            screen_w, screen_h = _get_screen_size()
            x, y = calculate_position(self._position, screen_w, screen_h)
            self._float_window.move(x, y)
            self._float_window.show()
            logger.debug("Floating indicator shown at %s", self._position)
        except Exception:
            logger.warning("Failed to show floating indicator", exc_info=True)
            self.is_visible = False

    def hide(self) -> None:
        """Hide the floating indicator window."""
        if not self.is_visible or not self._float_window:
            return
        self.is_visible = False
        try:
            self._float_window.hide()
            logger.debug("Floating indicator hidden")
        except Exception:
            logger.warning("Failed to hide floating indicator", exc_info=True)

    def destroy(self) -> None:
        """Permanently destroy the floating window (app shutdown)."""
        self.stop_monitoring()
        if self._float_window:
            try:
                self._float_window.destroy()
            except Exception:
                pass
            self._float_window = None

    def _dismiss(self) -> None:
        """Hide the floating window. It will reappear next time focus is lost."""
        self.hide()

    def _navigate_and_hide(self) -> None:
        """Bring main window to front and hide indicator."""
        self.hide()
        if self._main_window:
            try:
                self._main_window.restore()
                # Brief on_top toggle to bring window to front
                self._main_window.on_top = True
                self._main_window.on_top = False
            except Exception:
                pass

    def _on_stop_and_hide(self) -> None:
        """Handle stop button: stop recording and hide indicator."""
        self.stop_monitoring()
        self._on_stop()

    def _focus_poll_loop(self) -> None:
        """Poll for main window focus state on a background thread.

        Compares GetForegroundWindow against the main window HWND.
        Shows the indicator when main window loses focus, hides when
        it regains.
        """
        # Wait briefly for windows to fully initialize
        time.sleep(1.0)

        main_hwnd = self._get_main_hwnd()
        if not main_hwnd:
            logger.warning("Could not get main window HWND for focus polling")
            return

        was_focused = True
        while self._polling:
            time.sleep(_POLL_INTERVAL)
            if not self._polling:
                break

            fg = _get_foreground_hwnd()
            is_main_focused = fg == main_hwnd
            float_hwnd = self._get_float_hwnd()
            is_float_focused = float_hwnd != 0 and fg == float_hwnd

            if is_main_focused and not was_focused:
                self.hide()
                was_focused = True
            elif not is_main_focused and not is_float_focused and was_focused:
                self.show()
                was_focused = False

    def _find_process_windows(self) -> list[int]:
        """Find all visible top-level window HWNDs for the current process.

        Uses win32 EnumWindows + GetWindowThreadProcessId to reliably
        locate windows regardless of pywebview backend internals.

        Returns:
            List of HWNDs belonging to this process.
        """
        try:
            user32 = ctypes.windll.user32  # type: ignore[attr-defined]
            pid = os.getpid()
            hwnds: list[int] = []

            # WNDENUMPROC callback type: (HWND, LPARAM) -> BOOL
            WNDENUMPROC = ctypes.WINFUNCTYPE(
                ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p
            )

            def _enum_callback(hwnd: int, _lparam: int) -> bool:
                window_pid = ctypes.c_ulong()
                user32.GetWindowThreadProcessId(
                    hwnd, ctypes.byref(window_pid)
                )
                if window_pid.value == pid and user32.IsWindowVisible(hwnd):
                    hwnds.append(hwnd)
                return True

            user32.EnumWindows(WNDENUMPROC(_enum_callback), 0)
            return hwnds
        except Exception:
            logger.debug("EnumWindows failed", exc_info=True)
            return []

    def _get_main_hwnd(self) -> int:
        """Get the HWND of the main pywebview window.

        Caches the result on first successful lookup.  Uses win32
        EnumWindows to find the first visible window in our process.

        Returns:
            Window handle, or 0 if unavailable.
        """
        if self._main_hwnd_cache:
            return self._main_hwnd_cache
        hwnds = self._find_process_windows()
        if hwnds:
            self._main_hwnd_cache = hwnds[0]
            return hwnds[0]
        return 0

    def _get_float_hwnd(self) -> int:
        """Get the HWND of the floating indicator window.

        Enumerates process windows and returns the first one that
        is not the cached main window HWND.

        Returns:
            Window handle, or 0 if unavailable.
        """
        if not self._main_hwnd_cache:
            return 0
        hwnds = self._find_process_windows()
        for hwnd in hwnds:
            if hwnd != self._main_hwnd_cache:
                return hwnd
        return 0
