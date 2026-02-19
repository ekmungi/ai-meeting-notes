"""Tests for the local faster-whisper transcription engine."""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from meeting_notes.engines.base import TranscriptSegment
from meeting_notes.engines.local import LocalEngine


def _make_audio_bytes(duration_s: float = 1.0, sample_rate: int = 16000) -> bytes:
    """Generate audio bytes (sine wave)."""
    t = np.linspace(0, duration_s, int(sample_rate * duration_s), dtype=np.float32)
    audio = (np.sin(2 * np.pi * 440 * t) * 16000).astype(np.int16)
    return audio.tobytes()


class TestLocalEngineInit:
    def test_name_includes_model_size(self):
        engine = LocalEngine(model_size="small.en")
        assert "small.en" in engine.name
        assert "faster-whisper" in engine.name

    def test_name_with_custom_model(self):
        engine = LocalEngine(model_size="base.en")
        assert "base.en" in engine.name

    def test_default_parameters(self):
        engine = LocalEngine()
        assert engine._sample_rate == 16000
        assert engine._model_size == "small.en"
        assert engine._compute_type == "int8"
        assert engine._beam_size == 1
        assert engine._chunk_seconds == 10


class TestLocalEngineStart:
    @pytest.mark.asyncio
    async def test_start_loads_model(self):
        mock_model = MagicMock()
        with patch(
            "meeting_notes.engines.local.LocalEngine._load_model",
            return_value=mock_model,
        ):
            engine = LocalEngine()
            await engine.start()
            assert engine._model is mock_model
            assert engine._running is True
            assert engine._transcription_task is not None
            # Clean up
            engine._running = False
            await engine._transcription_task


class TestLocalEngineSendAudio:
    @pytest.mark.asyncio
    async def test_send_audio_buffers_until_chunk_size(self):
        """Audio should be buffered, not dispatched immediately."""
        mock_model = MagicMock()

        with patch(
            "meeting_notes.engines.local.LocalEngine._load_model",
            return_value=mock_model,
        ):
            engine = LocalEngine(chunk_seconds=10)
            await engine.start()

            # Send 1 second of audio — well under 10s threshold
            chunk = _make_audio_bytes(1.0)
            await engine.send_audio(chunk)
            assert engine._transcription_queue.empty()

            # Clean up
            engine._running = False
            await engine._transcription_task

    @pytest.mark.asyncio
    async def test_send_audio_noop_when_stopped(self):
        engine = LocalEngine()
        # Not started, should not raise
        await engine.send_audio(b"\x00" * 3200)

    @pytest.mark.asyncio
    async def test_send_audio_dispatches_when_chunk_fills(self):
        """After enough audio accumulates, should dispatch to transcription."""
        received: list[TranscriptSegment] = []
        mock_segment = MagicMock()
        mock_segment.text = "dispatched"
        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([mock_segment], MagicMock())

        with patch(
            "meeting_notes.engines.local.LocalEngine._load_model",
            return_value=mock_model,
        ):
            engine = LocalEngine(chunk_seconds=2)
            await engine.start()
            engine.on_transcript(lambda seg: received.append(seg))

            # Send 3 seconds of audio (exceeds 2s chunk)
            audio = _make_audio_bytes(3.0)
            await engine.send_audio(audio)

            # Give background loop time to consume
            await asyncio.sleep(0.3)
            finals = [s for s in received if not s.is_partial]
            assert len(finals) == 1

            # Clean up
            engine._running = False
            await engine._transcription_task

    @pytest.mark.asyncio
    async def test_transcribes_after_chunk_fills(self):
        """After enough audio, the background loop should transcribe and emit."""
        received: list[TranscriptSegment] = []

        mock_segment = MagicMock()
        mock_segment.text = "Hello world"
        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([mock_segment], MagicMock())

        with patch(
            "meeting_notes.engines.local.LocalEngine._load_model",
            return_value=mock_model,
        ):
            # Use short chunk to trigger quickly
            engine = LocalEngine(chunk_seconds=2)
            await engine.start()
            engine.on_transcript(lambda seg: received.append(seg))

            # Send 3 seconds of audio (exceeds 2s chunk)
            audio = _make_audio_bytes(3.0)
            await engine.send_audio(audio)

            # Give the background loop time to process
            await asyncio.sleep(0.2)

            finals = [s for s in received if not s.is_partial]
            assert len(finals) == 1
            assert finals[0].text == "Hello world"

            # Clean up
            engine._running = False
            await engine._transcription_task


class TestLocalEngineTranscription:
    @pytest.mark.asyncio
    async def test_skips_very_short_segments(self):
        """Segments shorter than 0.5s should be skipped."""
        received: list[TranscriptSegment] = []

        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([], MagicMock())

        with patch(
            "meeting_notes.engines.local.LocalEngine._load_model",
            return_value=mock_model,
        ):
            engine = LocalEngine()
            await engine.start()
            engine.on_transcript(lambda seg: received.append(seg))

            # Transcribe a very short segment directly
            short_audio = _make_audio_bytes(0.3)
            await engine._transcribe_segment(short_audio)

            assert len(received) == 0
            mock_model.transcribe.assert_not_called()

            # Clean up
            engine._running = False
            await engine._transcription_task

    @pytest.mark.asyncio
    async def test_skips_empty_transcription(self):
        """Empty whisper output should not emit a segment."""
        received: list[TranscriptSegment] = []

        mock_segment = MagicMock()
        mock_segment.text = "   "
        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([mock_segment], MagicMock())

        with patch(
            "meeting_notes.engines.local.LocalEngine._load_model",
            return_value=mock_model,
        ):
            engine = LocalEngine()
            await engine.start()
            engine.on_transcript(lambda seg: received.append(seg))

            # Transcribe a segment that returns whitespace
            audio = _make_audio_bytes(1.0)
            await engine._transcribe_segment(audio)

            # Partial ([Transcribing...]) is emitted, but no final segment
            finals = [s for s in received if not s.is_partial]
            assert len(finals) == 0

            # Clean up
            engine._running = False
            await engine._transcription_task


class TestLocalEngineStop:
    @pytest.mark.asyncio
    async def test_stop_discards_buffered_audio(self):
        """stop() discards the partial audio buffer to return immediately.

        The final partial window is intentionally dropped — waiting for
        inference on stop caused indefinite UI hangs (see D-stop-hang).
        """
        received: list[TranscriptSegment] = []

        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([], MagicMock())

        with patch(
            "meeting_notes.engines.local.LocalEngine._load_model",
            return_value=mock_model,
        ):
            engine = LocalEngine(chunk_seconds=30)
            await engine.start()
            engine.on_transcript(lambda seg: received.append(seg))

            # Send 5 seconds — under the 30s threshold so it stays buffered
            audio = _make_audio_bytes(5.0)
            await engine.send_audio(audio)
            # Give a moment — nothing should be emitted yet
            await asyncio.sleep(0.1)
            assert len(received) == 0

            # Stop should return immediately and discard the buffer
            await engine.stop()

            # Buffer should be cleared and no segments emitted
            assert len(engine._audio_buffer) == 0
            finals = [s for s in received if not s.is_partial]
            assert len(finals) == 0

    @pytest.mark.asyncio
    async def test_stop_returns_immediately(self):
        """stop() must complete quickly even if inference is in progress."""
        import time

        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([], MagicMock())

        with patch(
            "meeting_notes.engines.local.LocalEngine._load_model",
            return_value=mock_model,
        ):
            engine = LocalEngine(chunk_seconds=2)
            await engine.start()

            # Trigger an inference by sending enough audio
            audio = _make_audio_bytes(3.0)
            await engine.send_audio(audio)
            await asyncio.sleep(0.05)  # Let the loop pick up the chunk

            t0 = time.monotonic()
            await engine.stop()
            elapsed = time.monotonic() - t0

            # Stop must complete in well under 1 second
            assert elapsed < 1.0, f"stop() took {elapsed:.2f}s — should be instant"


class TestRunWhisper:
    def test_converts_audio_format(self):
        """_run_whisper should convert int16 bytes to float32 for Whisper."""
        mock_segment = MagicMock()
        mock_segment.text = "Test"
        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([mock_segment], MagicMock())

        engine = LocalEngine()
        engine._model = mock_model

        audio = _make_audio_bytes(1.0)
        result = engine._run_whisper(audio)

        assert result == "Test"

        # Verify the model was called with float32 array
        call_args = mock_model.transcribe.call_args
        audio_arg = call_args[0][0]
        assert audio_arg.dtype == np.float32
        assert audio_arg.max() <= 1.0
        assert audio_arg.min() >= -1.0

    def test_disables_vad_filter(self):
        """_run_whisper should disable faster-whisper VAD (handled at session level)."""
        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([], MagicMock())

        engine = LocalEngine()
        engine._model = mock_model

        engine._run_whisper(_make_audio_bytes(1.0))

        call_kwargs = mock_model.transcribe.call_args[1]
        assert call_kwargs["vad_filter"] is False

    def test_concatenates_multiple_segments(self):
        """Multiple Whisper segments should be joined with spaces."""
        seg1 = MagicMock()
        seg1.text = "Hello"
        seg2 = MagicMock()
        seg2.text = "world"
        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([seg1, seg2], MagicMock())

        engine = LocalEngine()
        engine._model = mock_model

        result = engine._run_whisper(_make_audio_bytes(2.0))
        assert result == "Hello world"

    def test_filters_blank_audio_artifacts(self):
        """[BLANK_AUDIO] and similar Whisper artifacts should be excluded."""
        blank = MagicMock()
        blank.text = "[BLANK_AUDIO]"
        real = MagicMock()
        real.text = "Hello there"
        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([blank, real], MagicMock())

        engine = LocalEngine()
        engine._model = mock_model

        result = engine._run_whisper(_make_audio_bytes(2.0))
        assert result == "Hello there"
        assert "[BLANK_AUDIO]" not in result


class TestTranscriptionLoop:
    @pytest.mark.asyncio
    async def test_audio_loop_not_blocked_during_transcription(self):
        """send_audio must return immediately even while transcription runs."""
        mock_segment = MagicMock()
        mock_segment.text = "Result"
        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([mock_segment], MagicMock())

        with patch(
            "meeting_notes.engines.local.LocalEngine._load_model",
            return_value=mock_model,
        ):
            engine = LocalEngine(chunk_seconds=2)
            await engine.start()

            # Send enough audio to enqueue a transcription
            audio = _make_audio_bytes(3.0)
            await engine.send_audio(audio)

            # send_audio should have returned immediately;
            # sending more audio should also return instantly
            more_audio = _make_audio_bytes(1.0)
            await engine.send_audio(more_audio)

            # Buffer should contain the leftover + new audio
            assert len(engine._audio_buffer) > 0

            # Clean up
            engine._running = False
            await engine._transcription_task

    @pytest.mark.asyncio
    async def test_multiple_windows_processed_sequentially(self):
        """Multiple full windows should all be transcribed in order."""
        received: list[TranscriptSegment] = []
        call_count = 0

        def fake_transcribe(audio, **kwargs):
            nonlocal call_count
            call_count += 1
            seg = MagicMock()
            seg.text = f"Segment {call_count}"
            return [seg], MagicMock()

        mock_model = MagicMock()
        mock_model.transcribe.side_effect = fake_transcribe

        with patch(
            "meeting_notes.engines.local.LocalEngine._load_model",
            return_value=mock_model,
        ):
            engine = LocalEngine(chunk_seconds=2)
            await engine.start()
            engine.on_transcript(lambda seg: received.append(seg))

            # Send two separate windows worth of audio
            audio_w1 = _make_audio_bytes(2.5)  # triggers 1st dispatch (2s), 0.5s left
            await engine.send_audio(audio_w1)

            audio_w2 = _make_audio_bytes(2.0)  # buffer now 2.5s, triggers 2nd dispatch
            await engine.send_audio(audio_w2)

            # Let the loop process both
            await asyncio.sleep(0.5)

            finals = [s for s in received if not s.is_partial]
            assert len(finals) == 2
            assert finals[0].text == "Segment 1"
            assert finals[1].text == "Segment 2"

            # Clean up
            engine._running = False
            await engine._transcription_task
