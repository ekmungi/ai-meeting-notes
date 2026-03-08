"""Floating recording indicator -- always-on-top mini panel for desktop app (D051).

Shows a small panel with Stop and Transcript buttons when the main window
loses focus during an active recording. Uses pywebview's create_window
with on_top=True and frameless=True.
"""

from __future__ import annotations

import ctypes
import logging
import os
import threading
import time
from typing import Any, Callable

logger = logging.getLogger(__name__)

# Panel dimensions
PANEL_WIDTH = 220
PANEL_HEIGHT = 64
EDGE_MARGIN = 20

# Focus polling interval (seconds)
_POLL_INTERVAL = 0.5


def calculate_position(
    position: str, screen_width: int, screen_height: int
) -> tuple[int, int]:
    """Calculate pixel coordinates for the indicator panel.

    Args:
        position: One of "top-right", "center-right", "bottom-left".
        screen_width: Screen width in pixels.
        screen_height: Screen height in pixels.

    Returns:
        Tuple of (x, y) coordinates for the top-left corner.
    """
    positions = {
        "top-right": (
            screen_width - PANEL_WIDTH - EDGE_MARGIN,
            EDGE_MARGIN,
        ),
        "center-right": (
            screen_width - PANEL_WIDTH - EDGE_MARGIN,
            (screen_height - PANEL_HEIGHT) // 2,
        ),
        "bottom-left": (
            EDGE_MARGIN,
            screen_height - PANEL_HEIGHT - EDGE_MARGIN,
        ),
    }
    return positions.get(position, positions["top-right"])


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
  body {
    background: rgba(30, 30, 30, 0.95);
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .mn-float-panel {
    display: flex;
    align-items: center;
    width: 100%;
    height: 100%;
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
  }
  .mn-float-nav:hover { background: rgba(255, 255, 255, 0.08); }
  .mn-float-nav svg { width: 14px; height: 14px; }
</style>
</head>
<body>
<div class="mn-float-panel">
  <button class="mn-float-stop" onclick="pywebview.api.stop_recording()">
    <svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
    Stop
  </button>
  <button class="mn-float-nav" onclick="pywebview.api.go_to_main()">
    Transcript
    <svg viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" fill="none" stroke-width="2"/></svg>
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
        self, on_stop: Callable[[], None], on_navigate: Callable[[], None]
    ) -> None:
        self._on_stop = on_stop
        self._on_navigate = on_navigate

    def stop_recording(self) -> None:
        """Called from JS when stop button is clicked."""
        self._on_stop()

    def go_to_main(self) -> None:
        """Called from JS when transcript button is clicked."""
        self._on_navigate()


class FloatingIndicator:
    """Manages a floating always-on-top indicator window for the desktop app.

    Shows a small panel with Stop and Transcript buttons. Monitors main
    window focus via win32 polling and auto-shows/hides accordingly.
    """

    def __init__(self, main_window: Any, on_stop: Callable[[], None]) -> None:
        self._main_window = main_window
        self._on_stop = on_stop
        self._float_window: Any = None
        self._poll_thread: threading.Thread | None = None
        self._polling = False
        self._position = "top-right"
        self.is_visible = False
        self._main_hwnd_cache: int = 0

    def start_monitoring(self, position: str = "top-right") -> None:
        """Start polling for main window focus loss.

        Args:
            position: Screen edge for the indicator panel.
        """
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
        """Create and show the floating indicator window."""
        if self.is_visible:
            return
        self.is_visible = True
        self._create_window()

    def hide(self) -> None:
        """Destroy the floating indicator window."""
        if not self.is_visible:
            return
        self.is_visible = False
        self._destroy_window()

    def _create_window(self) -> None:
        """Create the pywebview floating window."""
        try:
            import webview  # type: ignore[import-untyped]

            screen_w, screen_h = _get_screen_size()
            x, y = calculate_position(self._position, screen_w, screen_h)

            def _navigate_and_hide() -> None:
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

            api = _FloatAPI(
                on_stop=self._on_stop_and_hide,
                on_navigate=_navigate_and_hide,
            )

            self._float_window = webview.create_window(
                title="Recording",
                html=build_indicator_html(),
                js_api=api,
                width=PANEL_WIDTH,
                height=PANEL_HEIGHT,
                x=x,
                y=y,
                on_top=True,
                frameless=True,
                resizable=False,
                minimizable=False,
            )
        except Exception:
            logger.warning("Failed to create floating indicator window", exc_info=True)
            self.is_visible = False

    def _destroy_window(self) -> None:
        """Destroy the pywebview floating window."""
        if self._float_window:
            try:
                self._float_window.destroy()
            except Exception:
                pass
            self._float_window = None

    def _on_stop_and_hide(self) -> None:
        """Handle stop button: stop recording and hide indicator."""
        self.stop_monitoring()
        self._on_stop()

    def _focus_poll_loop(self) -> None:
        """Poll for main window focus state on a background thread.

        Compares GetForegroundWindow against the main window HWND.
        Shows the indicator when main window loses focus, hides when it regains.
        """
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

        Caches the result on first successful lookup. Uses win32
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
