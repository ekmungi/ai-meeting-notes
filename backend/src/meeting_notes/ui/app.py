"""pywebview application shell — creates the desktop window."""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path


def _redirect_frozen_stdio() -> None:
    """In a windowed PyInstaller build sys.stdout/stderr are None.

    Redirect them to a log file so startup errors are captured rather than
    silently crashing the process before the window appears.
    """
    if not (getattr(sys, "frozen", False) and sys.stdout is None):
        return

    log_dir = Path(os.environ.get("APPDATA", Path.home())) / "ai-meeting-notes"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "app.log"

    # Open in write mode so each launch starts fresh
    log_file = open(log_path, "w", encoding="utf-8", buffering=1)  # noqa: SIM115
    sys.stdout = log_file
    sys.stderr = log_file


_redirect_frozen_stdio()

logger = logging.getLogger(__name__)


def _resolve_web_dir() -> Path:
    """Return the web assets directory, handling PyInstaller frozen builds."""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        # PyInstaller extracts data to sys._MEIPASS at runtime
        return Path(sys._MEIPASS) / "meeting_notes" / "ui" / "web"
    return Path(__file__).resolve().parent / "web"


_WEB_DIR = _resolve_web_dir()
_ICON_PATH = _WEB_DIR / "icon.png"


def main() -> None:
    """Launch the pywebview desktop window."""
    import logging as _logging

    # Configure logging for the GUI process.  basicConfig() is a no-op if
    # a root handler is already set (e.g. launched via __main__ --gui), so
    # this is always safe to call.  In a frozen build stderr is already
    # redirected to app.log by _redirect_frozen_stdio above.
    _logging.basicConfig(
        level=_logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    try:
        import webview  # type: ignore[import-untyped]
    except ImportError:
        print(
            "Error: pywebview is not installed.\n"
            "Install it with: pip install pywebview",
            file=sys.stderr,
        )
        sys.exit(1)

    from meeting_notes.ui.api import MeetingNotesAPI

    api = MeetingNotesAPI()
    index_path = _WEB_DIR / "index.html"

    window = webview.create_window(
        title="AI Meeting Notes",
        url=str(index_path),
        js_api=api,
        width=560,
        height=610,
        min_size=(480, 320),
        text_select=False,
        frameless=True,
    )

    api.set_window(window)

    # Create the floating indicator window (hidden) before start() so
    # pywebview creates it on the GUI thread.  show()/hide() are thread-safe.
    if api._floating_indicator:
        api._floating_indicator.create_hidden_window()

    # Force-hide the floating window after the main window loads,
    # because hidden=True is not reliable on all pywebview backends.
    def _ensure_float_hidden():
        if api._floating_indicator and api._floating_indicator._float_window:
            try:
                api._floating_indicator._float_window.hide()
            except Exception:
                pass

    window.events.loaded += _ensure_float_hidden

    # Register cleanup on window close
    def on_closing():
        logger.debug("Window closing — cleaning up")
        api.cleanup()

    window.events.closing += on_closing

    icon = str(_ICON_PATH) if _ICON_PATH.exists() else None
    webview.start(debug=("--debug" in sys.argv), icon=icon)


if __name__ == "__main__":
    main()
