"""Tests for UI settings store — JSON load/save/defaults."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from meeting_notes.ui.settings_store import UserSettings, load_settings, save_settings


@pytest.fixture
def settings_dir(tmp_path: Path) -> Path:
    return tmp_path / "settings"


def test_default_settings():
    s = UserSettings()
    assert s.engine == "cloud"
    assert s.assemblyai_api_key == ""
    assert s.timestamp_mode == "elapsed"
    assert s.endpointing == "conservative"
    assert s.local_model_size == "small.en"


def test_load_returns_defaults_when_no_file(settings_dir: Path):
    s = load_settings(settings_dir)
    assert s == UserSettings()


def test_save_and_load_roundtrip(settings_dir: Path):
    original = UserSettings(
        engine="local",
        assemblyai_api_key="test-key-123",
        output_dir="/tmp/notes",
        timestamp_mode="none",
    )
    save_settings(original, settings_dir)
    loaded = load_settings(settings_dir)
    assert loaded == original


def test_load_ignores_unknown_fields(settings_dir: Path):
    settings_dir.mkdir(parents=True, exist_ok=True)
    path = settings_dir / "settings.json"
    data = {"engine": "local", "unknown_field": "should_be_ignored"}
    path.write_text(json.dumps(data), encoding="utf-8")

    s = load_settings(settings_dir)
    assert s.engine == "local"


def test_load_handles_corrupt_json(settings_dir: Path):
    settings_dir.mkdir(parents=True, exist_ok=True)
    path = settings_dir / "settings.json"
    path.write_text("not valid json {{{", encoding="utf-8")

    s = load_settings(settings_dir)
    assert s == UserSettings()


def test_replace_returns_new_instance():
    original = UserSettings(engine="cloud")
    updated = original.replace(engine="local")
    assert updated.engine == "local"
    assert original.engine == "cloud"  # Immutable


def test_frozen_settings_cannot_be_mutated():
    s = UserSettings()
    with pytest.raises(AttributeError):
        s.engine = "local"  # type: ignore[misc]


def test_default_settings_new_fields():
    """New parity fields should have sensible defaults."""
    s = UserSettings()
    assert s.meeting_types == ["Meeting Notes", "1:1", "Standup", "Weekly Sync", "Design Review"]
    assert s.silence_threshold_seconds == 15
    assert s.silence_auto_stop is False
    assert s.record_wav is False
    assert s.speaker_labels is False
    assert s.open_editor_on_start is True


def test_save_and_load_roundtrip_new_fields(settings_dir: Path):
    """New fields should survive save/load cycle."""
    original = UserSettings(
        meeting_types=["Custom Type"],
        silence_threshold_seconds=30,
        silence_auto_stop=True,
        record_wav=True,
        speaker_labels=True,
        open_editor_on_start=False,
    )
    save_settings(original, settings_dir)
    loaded = load_settings(settings_dir)
    assert loaded.meeting_types == ["Custom Type"]
    assert loaded.silence_threshold_seconds == 30
    assert loaded.silence_auto_stop is True
    assert loaded.record_wav is True
    assert loaded.speaker_labels is True
    assert loaded.open_editor_on_start is False


def test_load_legacy_settings_missing_new_fields(settings_dir: Path):
    """Legacy settings.json without new fields should load with defaults."""
    settings_dir.mkdir(parents=True, exist_ok=True)
    path = settings_dir / "settings.json"
    data = {"engine": "local", "assemblyai_api_key": "key-123"}
    path.write_text(json.dumps(data), encoding="utf-8")

    s = load_settings(settings_dir)
    assert s.engine == "local"
    assert s.meeting_types == ["Meeting Notes", "1:1", "Standup", "Weekly Sync", "Design Review"]
    assert s.silence_threshold_seconds == 15
    assert s.record_wav is False
