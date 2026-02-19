"""Bridge between UI UserSettings and backend Config."""

from __future__ import annotations

from pathlib import Path

from meeting_notes.config import Config
from meeting_notes.ui.settings_store import UserSettings


def settings_to_config(settings: UserSettings) -> Config:
    """Convert UserSettings to a backend Config instance."""
    output_dir = Path(settings.output_dir) if settings.output_dir else Path.cwd()
    return Config(
        assemblyai_api_key=settings.assemblyai_api_key,
        output_dir=output_dir,
        engine=settings.engine,
        mic_device_index=settings.mic_device_index,
        system_audio_device_index=settings.system_audio_device_index,
        endpointing=settings.endpointing,
        local_model_size=settings.local_model_size,
        local_compute_type=settings.local_compute_type,
        timestamp_mode=settings.timestamp_mode,
    )


def validate_for_recording(settings: UserSettings) -> list[str]:
    """Validate settings are sufficient for recording. Returns error messages."""
    errors: list[str] = []

    if settings.engine in ("cloud", "auto") and not settings.assemblyai_api_key:
        errors.append("AssemblyAI API key is required for cloud transcription.")

    if settings.output_dir:
        output_path = Path(settings.output_dir)
        if not output_path.exists():
            errors.append(f"Output directory does not exist: {settings.output_dir}")

    if settings.engine not in ("cloud", "local", "auto"):
        errors.append(f"Invalid engine: {settings.engine}")

    if settings.timestamp_mode not in ("none", "local_time", "elapsed"):
        errors.append(f"Invalid timestamp mode: {settings.timestamp_mode}")

    return errors
