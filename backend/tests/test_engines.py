"""Tests for transcription engine interface and selection."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from meeting_notes.config import Config
from meeting_notes.engines.base import TranscriptSegment
from meeting_notes.engines.cloud import CloudEngine


def test_transcript_segment_defaults():
    """TranscriptSegment should have sensible defaults."""
    seg = TranscriptSegment(text="hello", timestamp_start=0.0, timestamp_end=1.0)
    assert seg.is_partial is False
    assert seg.speaker is None
    assert seg.confidence == 1.0


def test_engine_callback_registration():
    """Engines should support callback registration and emission."""
    received = []

    engine = CloudEngine(api_key="test", sample_rate=16000)
    engine.on_transcript(lambda seg: received.append(seg))

    # Simulate emission
    seg = TranscriptSegment(text="test", timestamp_start=0.0, timestamp_end=1.0)
    engine._emit(seg)

    assert len(received) == 1
    assert received[0].text == "test"


def test_cloud_engine_name():
    """Cloud engine should identify itself."""
    engine = CloudEngine(api_key="test")
    assert "AssemblyAI" in engine.name


def test_engine_selector_cloud_with_key():
    """Selector should choose cloud when internet is available and key exists."""
    from meeting_notes.engines.selector import select_engine

    config = Config(assemblyai_api_key="test_key", engine="cloud", output_dir=Path("."))
    engine = select_engine(config)
    assert isinstance(engine, CloudEngine)


def test_engine_selector_local_raises_without_faster_whisper():
    """Selector should raise RuntimeError when local requested but faster-whisper not installed."""
    import pytest

    from meeting_notes.engines.selector import select_engine

    config = Config(engine="local", output_dir=Path("."))

    with patch.dict("sys.modules", {"faster_whisper": None}):
        with pytest.raises((RuntimeError, ImportError)):
            select_engine(config)


def test_engine_selector_local_creates_local_engine():
    """Selector should create LocalEngine when local requested and faster-whisper available."""
    from meeting_notes.engines.local import LocalEngine
    from meeting_notes.engines.selector import select_engine

    config = Config(engine="local", output_dir=Path("."))
    engine = select_engine(config)
    assert isinstance(engine, LocalEngine)


def test_engine_selector_auto_no_internet_falls_back_to_local():
    """Selector should fall back to local engine when no internet in auto mode."""
    from meeting_notes.engines.local import LocalEngine
    from meeting_notes.engines.selector import select_engine

    config = Config(assemblyai_api_key="test_key", engine="auto", output_dir=Path("."))

    with patch("meeting_notes.engines.selector.check_connectivity", return_value=False):
        engine = select_engine(config)
        assert isinstance(engine, LocalEngine)


def test_engine_selector_auto_with_internet():
    """Selector should choose cloud when internet available in auto mode."""
    from meeting_notes.engines.selector import select_engine

    config = Config(assemblyai_api_key="test_key", engine="auto", output_dir=Path("."))

    with patch("meeting_notes.engines.selector.check_connectivity", return_value=True):
        engine = select_engine(config)
        assert isinstance(engine, CloudEngine)
