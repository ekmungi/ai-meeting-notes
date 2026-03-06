# Tests for SilenceMonitor -- RMS-based silence detection for WASAPI audio.

from __future__ import annotations

from unittest.mock import MagicMock

import numpy as np
import pytest

from meeting_notes.audio.silence import SilenceMonitor, _CALIBRATION_CHUNKS


def _make_silent_chunk(samples: int = 1600) -> bytes:
    """Return a chunk of pure silence (all zeros)."""
    return np.zeros(samples, dtype=np.int16).tobytes()


def _make_loud_chunk(samples: int = 1600, amplitude: int = 5000) -> bytes:
    """Return a chunk with constant non-zero amplitude."""
    return np.full(samples, amplitude, dtype=np.int16).tobytes()


def _calibrate(monitor: SilenceMonitor) -> None:
    """Feed enough silent chunks to complete calibration."""
    for _ in range(_CALIBRATION_CHUNKS):
        monitor.feed_chunk(_make_silent_chunk())


class TestSilenceMonitor:
    """Tests for SilenceMonitor behaviour."""

    def test_initial_state_not_silent(self) -> None:
        """Monitor should not report silence before calibration."""
        mon = SilenceMonitor(threshold_seconds=5.0)
        assert not mon.is_silent
        assert not mon.calibrated
        assert mon.silent_seconds == 0.0

    def test_calibration_phase(self) -> None:
        """Monitor becomes calibrated after receiving _CALIBRATION_CHUNKS chunks."""
        mon = SilenceMonitor(threshold_seconds=5.0)

        # Feed one fewer than needed -- still not calibrated.
        for _ in range(_CALIBRATION_CHUNKS - 1):
            mon.feed_chunk(_make_silent_chunk())
        assert not mon.calibrated

        # One more chunk completes calibration.
        mon.feed_chunk(_make_silent_chunk())
        assert mon.calibrated

    def test_silence_detected_after_threshold(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """is_silent becomes True after threshold_seconds of continuous silence."""
        mon = SilenceMonitor(threshold_seconds=5.0)
        _calibrate(mon)

        # Simulate time progression: start at t=0, jump to t=6.
        fake_time = 0.0

        def _fake_monotonic() -> float:
            return fake_time

        monkeypatch.setattr("meeting_notes.audio.silence.time.monotonic", _fake_monotonic)

        # First silent chunk after calibration sets the start marker.
        fake_time = 0.0
        mon.feed_chunk(_make_silent_chunk())
        assert not mon.is_silent

        # Jump past threshold.
        fake_time = 6.0
        mon.feed_chunk(_make_silent_chunk())
        assert mon.is_silent
        assert mon.silent_seconds >= 5.0

    def test_speech_resets_silence(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A loud chunk resets the silence counter."""
        mon = SilenceMonitor(threshold_seconds=5.0)
        _calibrate(mon)

        fake_time = 0.0

        def _fake_monotonic() -> float:
            return fake_time

        monkeypatch.setattr("meeting_notes.audio.silence.time.monotonic", _fake_monotonic)

        # Accumulate some silence.
        fake_time = 0.0
        mon.feed_chunk(_make_silent_chunk())
        fake_time = 6.0
        mon.feed_chunk(_make_silent_chunk())
        assert mon.is_silent

        # Speech resets.
        fake_time = 7.0
        mon.feed_chunk(_make_loud_chunk())
        assert not mon.is_silent
        assert mon.silent_seconds == 0.0

    def test_callback_fired_once_at_threshold(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """on_silence callback fires exactly once when silence crosses threshold."""
        callback = MagicMock()
        mon = SilenceMonitor(threshold_seconds=5.0, interval_seconds=15.0, on_silence=callback)
        _calibrate(mon)

        fake_time = 0.0

        def _fake_monotonic() -> float:
            return fake_time

        monkeypatch.setattr("meeting_notes.audio.silence.time.monotonic", _fake_monotonic)

        # First chunk sets start.
        mon.feed_chunk(_make_silent_chunk())
        callback.assert_not_called()

        # Cross threshold.
        fake_time = 6.0
        mon.feed_chunk(_make_silent_chunk())
        callback.assert_called_once()
        args = callback.call_args[0]
        assert args[0] >= 5.0

    def test_callback_fires_again_at_interval(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """on_silence fires again after interval_seconds of continued silence."""
        callback = MagicMock()
        mon = SilenceMonitor(threshold_seconds=5.0, interval_seconds=10.0, on_silence=callback)
        _calibrate(mon)

        fake_time = 0.0

        def _fake_monotonic() -> float:
            return fake_time

        monkeypatch.setattr("meeting_notes.audio.silence.time.monotonic", _fake_monotonic)

        # Set start.
        mon.feed_chunk(_make_silent_chunk())

        # First fire at threshold (5s).
        fake_time = 6.0
        mon.feed_chunk(_make_silent_chunk())
        assert callback.call_count == 1

        # Not yet at interval (5 + 10 = 15s).
        fake_time = 14.0
        mon.feed_chunk(_make_silent_chunk())
        assert callback.call_count == 1

        # At interval.
        fake_time = 16.0
        mon.feed_chunk(_make_silent_chunk())
        assert callback.call_count == 2

    def test_disabled_when_threshold_zero(self) -> None:
        """threshold_seconds=0 disables monitoring entirely."""
        callback = MagicMock()
        mon = SilenceMonitor(threshold_seconds=0, on_silence=callback)

        # Feed calibration + lots of silence.
        for _ in range(_CALIBRATION_CHUNKS + 100):
            mon.feed_chunk(_make_silent_chunk())

        assert not mon.is_silent
        callback.assert_not_called()

    def test_reset_clears_state(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """reset() returns monitor to pre-calibration state."""
        mon = SilenceMonitor(threshold_seconds=5.0)
        _calibrate(mon)

        fake_time = 0.0

        def _fake_monotonic() -> float:
            return fake_time

        monkeypatch.setattr("meeting_notes.audio.silence.time.monotonic", _fake_monotonic)

        # Accumulate silence.
        mon.feed_chunk(_make_silent_chunk())
        fake_time = 6.0
        mon.feed_chunk(_make_silent_chunk())
        assert mon.is_silent

        # Reset.
        mon.reset()
        assert not mon.calibrated
        assert not mon.is_silent
        assert mon.silent_seconds == 0.0
