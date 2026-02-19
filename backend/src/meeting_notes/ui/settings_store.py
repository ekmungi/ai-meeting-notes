"""Persistent user settings stored as JSON in %APPDATA%/ai-meeting-notes/."""

from __future__ import annotations

import json
import logging
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

_APP_DIR_NAME = "ai-meeting-notes"


def _default_settings_dir() -> Path:
    """Return the platform-appropriate settings directory."""
    base = os.environ.get("APPDATA")
    if base:
        return Path(base) / _APP_DIR_NAME
    # Fallback for non-Windows
    return Path.home() / ".config" / _APP_DIR_NAME


@dataclass(frozen=True)
class UserSettings:
    """Immutable user settings persisted across sessions."""

    # Engine
    engine: str = "cloud"  # "cloud" | "local" | "auto"
    assemblyai_api_key: str = ""

    # Audio
    mic_device_index: int | None = None
    system_audio_device_index: int | None = None

    # Output
    output_dir: str = ""  # Empty means cwd
    timestamp_mode: str = "elapsed"  # "none" | "local_time" | "elapsed"

    # Local engine
    local_model_size: str = "small.en"
    local_compute_type: str = "int8"

    # Recording
    endpointing: str = "conservative"

    def replace(self, **kwargs) -> UserSettings:
        """Return a new UserSettings with the given fields replaced."""
        current = asdict(self)
        current.update(kwargs)
        return UserSettings(**current)


_SERIALIZABLE_FIELDS = {f.name for f in UserSettings.__dataclass_fields__.values()}


def _settings_path(settings_dir: Path | None = None) -> Path:
    d = settings_dir or _default_settings_dir()
    return d / "settings.json"


def load_settings(settings_dir: Path | None = None) -> UserSettings:
    """Load settings from JSON file. Returns defaults if file is missing or corrupt."""
    path = _settings_path(settings_dir)
    if not path.exists():
        logger.debug("No settings file found at %s, using defaults", path)
        return UserSettings()

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        # Filter to known fields only
        known = {k: v for k, v in raw.items() if k in _SERIALIZABLE_FIELDS}
        return UserSettings(**known)
    except (json.JSONDecodeError, TypeError, KeyError) as exc:
        logger.warning("Corrupt settings file %s: %s — using defaults", path, exc)
        return UserSettings()


def save_settings(settings: UserSettings, settings_dir: Path | None = None) -> None:
    """Persist settings to JSON file."""
    path = _settings_path(settings_dir)
    path.parent.mkdir(parents=True, exist_ok=True)

    data = asdict(settings)
    # Never persist the API key to disk in plaintext — keep it in the JSON
    # but this is the user's local machine so it's acceptable.
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    logger.debug("Settings saved to %s", path)
