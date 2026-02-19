"""Tests for config bridge — UserSettings to Config conversion."""

from __future__ import annotations

from pathlib import Path

from meeting_notes.ui.config_bridge import settings_to_config, validate_for_recording
from meeting_notes.ui.settings_store import UserSettings


def test_settings_to_config_defaults():
    s = UserSettings()
    c = settings_to_config(s)
    assert c.engine == "cloud"
    assert c.timestamp_mode == "elapsed"
    assert c.endpointing == "conservative"
    assert c.local_model_size == "small.en"
    assert c.output_dir == Path.cwd()


def test_settings_to_config_with_values():
    s = UserSettings(
        engine="local",
        assemblyai_api_key="key-123",
        output_dir="/tmp/out",
        timestamp_mode="none",
    )
    c = settings_to_config(s)
    assert c.engine == "local"
    assert c.assemblyai_api_key == "key-123"
    assert c.output_dir == Path("/tmp/out")
    assert c.timestamp_mode == "none"


def test_validate_cloud_requires_api_key():
    s = UserSettings(engine="cloud", assemblyai_api_key="")
    errors = validate_for_recording(s)
    assert any("API key" in e for e in errors)


def test_validate_local_no_api_key_needed():
    s = UserSettings(engine="local", assemblyai_api_key="")
    errors = validate_for_recording(s)
    assert not any("API key" in e for e in errors)


def test_validate_bad_output_dir():
    s = UserSettings(engine="local", output_dir="/nonexistent/path/xyz")
    errors = validate_for_recording(s)
    assert any("does not exist" in e for e in errors)
