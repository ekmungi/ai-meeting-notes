"""Tests for configuration module."""

from __future__ import annotations

from pathlib import Path

from meeting_notes.config import Config


def test_config_defaults():
    """Config should have sensible defaults."""
    config = Config()
    assert config.engine == "auto"
    assert config.sample_rate == 16000
    assert config.assemblyai_api_key == ""
    assert config.mic_device_index is None


def test_config_validate_missing_api_key():
    """Should report error when API key is missing and required."""
    config = Config(output_dir=Path("."))
    errors = config.validate(require_api_key=True)
    assert any("ASSEMBLYAI_API_KEY" in e for e in errors)


def test_config_validate_with_api_key():
    """Should pass validation when API key is provided."""
    config = Config(assemblyai_api_key="test_key", output_dir=Path("."))
    errors = config.validate(require_api_key=True)
    assert len(errors) == 0


def test_config_validate_bad_engine():
    """Should report error for invalid engine choice."""
    config = Config(assemblyai_api_key="key", engine="invalid", output_dir=Path("."))
    errors = config.validate()
    assert any("ENGINE" in e for e in errors)


def test_config_validate_missing_output_dir():
    """Should report error for nonexistent output directory."""
    config = Config(assemblyai_api_key="key", output_dir=Path("/nonexistent/path"))
    errors = config.validate()
    assert any("OUTPUT_DIR" in e for e in errors)


def test_config_validate_local_no_api_key():
    """Should pass when engine is local and no API key."""
    config = Config(engine="local", output_dir=Path("."))
    errors = config.validate(require_api_key=False)
    assert len(errors) == 0


def test_config_load_from_env(tmp_path: Path):
    """Should load config from environment variables."""
    env_file = tmp_path / ".env"
    env_file.write_text("ASSEMBLYAI_API_KEY=test_key_123\nENGINE=cloud\n")

    config = Config.load(env_path=env_file)
    assert config.assemblyai_api_key == "test_key_123"
    assert config.engine == "cloud"
