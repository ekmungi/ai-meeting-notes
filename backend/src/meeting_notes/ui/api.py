"""pywebview JS API bridge — exposes Python methods to the frontend."""

from __future__ import annotations

import logging
import os
import re
import subprocess
import sys
from dataclasses import asdict, replace
from pathlib import Path
from typing import Any

from meeting_notes.ui.floating_indicator import FloatingIndicator

logger = logging.getLogger(__name__)


class MeetingNotesAPI:
    """Exposed to JavaScript as pywebview.api.*"""

    def __init__(self) -> None:
        self._window = None
        self._runner: Any = None  # SessionRunner, set lazily
        self._floating_indicator: FloatingIndicator | None = None

    def set_window(self, window) -> None:
        """Set the main pywebview window and create the floating indicator."""
        self._window = window
        self._floating_indicator = FloatingIndicator(
            main_window=window,
            on_stop=lambda: self.stop_recording(),
        )

    # -- Window Controls --

    def minimize_window(self) -> None:
        if self._window is not None:
            self._window.minimize()

    def close_window(self) -> None:
        if self._window is not None:
            self._window.destroy()

    # -- Settings --

    def get_settings(self) -> dict:
        from meeting_notes.ui.settings_store import load_settings

        settings = load_settings()
        data = asdict(settings)
        # Mask API key for display (show last 4 chars)
        key = data.get("assemblyai_api_key", "")
        data["assemblyai_api_key"] = key  # Send full key so JS can populate input
        return data

    def save_settings(self, updates: dict) -> dict:
        from meeting_notes.ui.settings_store import load_settings, save_settings

        current = load_settings()
        # Merge updates into current settings
        merged = current.replace(**{k: v for k, v in updates.items() if v is not None})
        save_settings(merged)
        return {"ok": True}

    def browse_directory(self) -> str | None:
        if self._window is None:
            return None
        result = self._window.create_file_dialog(
            dialog_type=20,  # FOLDER_DIALOG
        )
        if result and len(result) > 0:
            return str(result[0])
        return None

    # -- Session History --

    def get_session_history(self) -> list[dict]:
        from meeting_notes.ui.settings_store import load_settings

        settings = load_settings()
        output_dir = Path(settings.output_dir) if settings.output_dir else Path.cwd()

        if not output_dir.exists():
            return []

        sessions = []
        # Glob for meeting note markdown files
        pattern = "*.md"
        files = sorted(output_dir.glob(pattern), reverse=True)

        for fp in files[:50]:  # Limit to 50 most recent
            info = _parse_session_file(fp)
            if info:
                sessions.append(info)

        return sessions

    # -- Recording --

    def start_recording(self, engine: str, meeting_type: str = "Meeting Notes") -> dict:
        from meeting_notes.ui.config_bridge import settings_to_config, validate_for_recording
        from meeting_notes.ui.session_runner import SessionRunner
        from meeting_notes.ui.settings_store import load_settings

        if self._runner and self._runner.is_running:
            return {"error": "A recording is already in progress."}

        settings = load_settings()
        # Override engine with UI selection
        settings = settings.replace(engine=engine)

        errors = validate_for_recording(settings)
        if errors:
            return {"error": errors[0]}

        config = settings_to_config(settings)
        # Override meeting type with UI selection (not persisted in settings)
        config = replace(config, meeting_type=meeting_type)

        self._runner = SessionRunner(
            config=config,
            window=self._window,
            open_editor=settings.open_editor_on_start,
        )

        try:
            engine_name = self._runner.start()

            # Start floating indicator monitoring
            if self._floating_indicator:
                self._floating_indicator.start_monitoring(settings.floating_indicator_position)

            return {"engine_name": engine_name}
        except ImportError as exc:
            logger.exception("Missing dependency for recording")
            msg = str(exc)
            if "faster_whisper" in msg or "faster-whisper" in msg:
                return {"error": "Local engine requires faster-whisper. "
                        "Install with: pip install faster-whisper"}
            return {"error": f"Missing dependency: {msg}"}
        except RuntimeError as exc:
            logger.exception("Failed to start recording")
            msg = str(exc)
            if "No audio" in msg or "no input" in msg.lower():
                return {"error": "No audio devices found. Check your microphone connection."}
            return {"error": msg}
        except Exception as exc:
            logger.exception("Failed to start recording")
            return {"error": str(exc)}

    def pause_recording(self) -> dict:
        """Pause or resume the active recording."""
        if not self._runner or not self._runner.is_running:
            return {"error": "No recording in progress."}
        try:
            if self._runner.is_paused:
                self._runner.resume()
                return {"paused": False}
            else:
                self._runner.pause()
                return {"paused": True}
        except Exception as exc:
            logger.exception("Failed to pause/resume recording")
            return {"error": str(exc)}

    def stop_recording(self) -> dict:
        if not self._runner or not self._runner.is_running:
            return {"error": "No recording in progress."}

        try:
            self._runner.stop()
            if self._floating_indicator:
                self._floating_indicator.stop_monitoring()
            return {"ok": True}
        except Exception as exc:
            logger.exception("Failed to stop recording")
            return {"error": str(exc)}

    def merge_notes(self) -> dict:
        """Merge notes file with transcript after user confirms save."""
        if not self._runner:
            return {"error": "No recording session"}
        try:
            result = self._runner.merge_notes()
            return {"ok": True, "path": result}
        except Exception as exc:
            logger.exception("Failed to merge notes")
            return {"error": str(exc)}

    def open_file(self, path: str) -> None:
        """Open a markdown file in the default system application.

        Validates that the path points to an existing file before opening,
        to prevent the JS bridge from being used to open arbitrary files.
        """
        from pathlib import Path as _Path
        resolved = _Path(path).resolve()
        if not resolved.is_file():
            logger.warning("open_file: path does not exist or is not a file: %s", path)
            return
        if sys.platform == "win32":
            os.startfile(str(resolved))  # noqa: S606
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(resolved)])  # noqa: S603, S607
        else:
            subprocess.Popen(["xdg-open", str(resolved)])  # noqa: S603, S607

    # -- Cleanup --

    def cleanup(self) -> None:
        """Graceful shutdown — stop recording if active."""
        if self._floating_indicator:
            self._floating_indicator.stop_monitoring()
        if self._runner and self._runner.is_running:
            logger.info("Window closing during recording — stopping session")
            try:
                self._runner.stop()
            except Exception:
                logger.exception("Error during cleanup")


def _parse_session_file(path: Path) -> dict | None:
    """Parse a meeting notes markdown file for session list display."""
    try:
        content = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None

    title = path.stem
    duration = ""

    # Parse YAML frontmatter for duration
    fm_match = re.match(r"^---\n(.+?)\n---", content, re.DOTALL)
    if fm_match:
        fm = fm_match.group(1)
        dur_match = re.search(r'duration:\s*"?(.+?)"?\s*$', fm, re.MULTILINE)
        if dur_match:
            duration = dur_match.group(1).strip()

    return {
        "title": title,
        "duration": duration or "in progress",
        "path": str(path),
    }
