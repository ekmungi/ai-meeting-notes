"""Tests for Voice Activity Detection and SpeechBuffer.

Tests use the energy-based fallback (no torch dependency needed).
"""

from __future__ import annotations

from unittest.mock import MagicMock

import numpy as np

from meeting_notes.audio.vad import SpeechBuffer, VoiceActivityDetector


def make_audio_bytes(
    amplitude: int = 0, duration_ms: int = 100, sample_rate: int = 16000
) -> bytes:
    """Generate PCM 16-bit mono audio bytes.

    Args:
        amplitude: Peak amplitude (0 = silence, 5000+ = speech-level).
        duration_ms: Duration in milliseconds.
        sample_rate: Sample rate in Hz.
    """
    num_samples = int(sample_rate * duration_ms / 1000)
    if amplitude == 0:
        audio = np.zeros(num_samples, dtype=np.int16)
    else:
        # Generate a simple sine wave at 440Hz
        t = np.arange(num_samples) / sample_rate
        audio = (amplitude * np.sin(2 * np.pi * 440 * t)).astype(np.int16)
    return audio.tobytes()


class TestVoiceActivityDetector:
    """Tests for the energy-based VAD fallback."""

    def test_silence_detected_as_no_speech(self):
        vad = VoiceActivityDetector(sample_rate=16000)
        # Force energy fallback
        vad._use_silero = False
        silence = make_audio_bytes(amplitude=0)
        assert vad.is_speech(silence) is False

    def test_loud_audio_detected_as_speech(self):
        vad = VoiceActivityDetector(sample_rate=16000)
        vad._use_silero = False
        speech = make_audio_bytes(amplitude=5000)
        assert vad.is_speech(speech) is True

    def test_quiet_audio_below_threshold(self):
        vad = VoiceActivityDetector(sample_rate=16000)
        vad._use_silero = False
        quiet = make_audio_bytes(amplitude=100)
        assert vad.is_speech(quiet) is False

    def test_empty_audio(self):
        vad = VoiceActivityDetector(sample_rate=16000)
        vad._use_silero = False
        assert vad.is_speech(b"") is False

    def test_reset_is_noop_for_energy(self):
        vad = VoiceActivityDetector(sample_rate=16000)
        vad._use_silero = False
        vad.reset()  # Should not raise


class TestSpeechBuffer:
    """Tests for the VAD-gated speech buffering."""

    def _make_buffer(
        self,
        post_silence_ms: int = 300,
        pre_buffer_ms: int = 100,
    ) -> tuple[SpeechBuffer, MagicMock]:
        """Create a SpeechBuffer with a mock VAD."""
        mock_vad = MagicMock(spec=VoiceActivityDetector)
        buf = SpeechBuffer(
            vad=mock_vad,
            post_speech_silence_ms=post_silence_ms,
            pre_speech_buffer_ms=pre_buffer_ms,
            sample_rate=16000,
            chunk_duration_ms=100,
        )
        return buf, mock_vad

    def test_silence_only_returns_nothing(self):
        buf, mock_vad = self._make_buffer()
        mock_vad.is_speech.return_value = False

        chunk = make_audio_bytes(amplitude=0)
        for _ in range(10):
            result = buf.feed(chunk)
            assert result is None
        assert not buf.in_speech

    def test_speech_starts_buffering(self):
        buf, mock_vad = self._make_buffer()
        mock_vad.is_speech.return_value = True

        chunk = make_audio_bytes(amplitude=5000)
        result = buf.feed(chunk)
        assert result is None  # Still accumulating
        assert buf.in_speech is True

    def test_speech_then_silence_emits_segment(self):
        buf, mock_vad = self._make_buffer(post_silence_ms=300)
        speech = make_audio_bytes(amplitude=5000)
        silence = make_audio_bytes(amplitude=0)

        # 5 chunks of speech
        mock_vad.is_speech.return_value = True
        for _ in range(5):
            buf.feed(speech)

        # 3 chunks of silence (300ms post-speech = 3 * 100ms)
        mock_vad.is_speech.return_value = False
        result = None
        for _ in range(3):
            result = buf.feed(silence)

        # Should have emitted: 5 speech + 3 silence = 8 chunks
        assert result is not None
        expected_chunks = 5 + 3
        expected_bytes = expected_chunks * len(speech)
        assert len(result) == expected_bytes
        assert not buf.in_speech

    def test_pause_within_tolerance_continues(self):
        """A short pause shorter than post_silence_ms should NOT split."""
        buf, mock_vad = self._make_buffer(post_silence_ms=500)
        speech = make_audio_bytes(amplitude=5000)
        silence = make_audio_bytes(amplitude=0)

        # Speech
        mock_vad.is_speech.return_value = True
        for _ in range(5):
            buf.feed(speech)

        # Short pause (2 chunks = 200ms < 500ms threshold)
        mock_vad.is_speech.return_value = False
        r1 = buf.feed(silence)
        r2 = buf.feed(silence)
        assert r1 is None
        assert r2 is None
        assert buf.in_speech is True  # Still in speech!

        # Speech resumes
        mock_vad.is_speech.return_value = True
        for _ in range(3):
            r = buf.feed(speech)
            assert r is None
        assert buf.in_speech is True

    def test_pre_buffer_includes_context(self):
        """Pre-speech buffer should capture audio before speech starts."""
        buf, mock_vad = self._make_buffer(
            post_silence_ms=100, pre_buffer_ms=200
        )
        silence = make_audio_bytes(amplitude=0)
        speech = make_audio_bytes(amplitude=5000)

        # Feed silence to fill pre-buffer (2 chunks = 200ms)
        mock_vad.is_speech.return_value = False
        buf.feed(silence)
        buf.feed(silence)

        # Speech starts
        mock_vad.is_speech.return_value = True
        buf.feed(speech)
        buf.feed(speech)

        # End with silence (1 chunk = 100ms = threshold)
        mock_vad.is_speech.return_value = False
        result = buf.feed(silence)

        # Should include: 2 pre-buffer + 2 speech + 1 silence = 5 chunks
        assert result is not None
        expected_bytes = 5 * len(speech)
        assert len(result) == expected_bytes

    def test_flush_returns_remaining(self):
        buf, mock_vad = self._make_buffer()
        speech = make_audio_bytes(amplitude=5000)

        mock_vad.is_speech.return_value = True
        buf.feed(speech)
        buf.feed(speech)

        result = buf.flush()
        assert result is not None
        assert len(result) == 2 * len(speech)
        assert not buf.in_speech

    def test_flush_empty_returns_none(self):
        buf, mock_vad = self._make_buffer()
        assert buf.flush() is None

    def test_multiple_speech_segments(self):
        """Should emit separate segments for distinct speech bursts."""
        buf, mock_vad = self._make_buffer(post_silence_ms=200)
        speech = make_audio_bytes(amplitude=5000)
        silence = make_audio_bytes(amplitude=0)

        segments = []

        # First burst: 3 speech + 2 silence
        mock_vad.is_speech.return_value = True
        for _ in range(3):
            buf.feed(speech)
        mock_vad.is_speech.return_value = False
        for _ in range(2):
            r = buf.feed(silence)
            if r is not None:
                segments.append(r)

        assert len(segments) == 1

        # Gap of pure silence
        for _ in range(5):
            buf.feed(silence)

        # Second burst: 2 speech + 2 silence
        mock_vad.is_speech.return_value = True
        for _ in range(2):
            buf.feed(speech)
        mock_vad.is_speech.return_value = False
        for _ in range(2):
            r = buf.feed(silence)
            if r is not None:
                segments.append(r)

        assert len(segments) == 2

    def test_1500ms_post_speech_for_meeting_use(self):
        """With 1500ms post-speech, a 1-second pause does NOT split."""
        buf, mock_vad = self._make_buffer(post_silence_ms=1500)
        speech = make_audio_bytes(amplitude=5000)
        silence = make_audio_bytes(amplitude=0)

        # Speak
        mock_vad.is_speech.return_value = True
        for _ in range(5):
            buf.feed(speech)

        # 1-second pause (10 chunks * 100ms) — should NOT split
        mock_vad.is_speech.return_value = False
        for i in range(10):
            r = buf.feed(silence)
            assert r is None, f"Split at chunk {i} (1000ms < 1500ms)"

        assert buf.in_speech is True

        # Continue speaking
        mock_vad.is_speech.return_value = True
        for _ in range(3):
            buf.feed(speech)

        # Now 1.5s silence to actually end
        mock_vad.is_speech.return_value = False
        result = None
        for _ in range(15):
            r = buf.feed(silence)
            if r is not None:
                result = r
                break

        assert result is not None
        assert not buf.in_speech
