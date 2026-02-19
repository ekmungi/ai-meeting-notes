"""Tests for MeetingSession._audio_loop audio forwarding.

Verifies that the audio loop forwards ALL audio chunks to the engine
without filtering. Each engine handles its own VAD/buffering internally.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import numpy as np
import pytest

from meeting_notes.session import MeetingSession


def _make_audio_bytes(amplitude: int = 0, duration_ms: int = 100) -> bytes:
    """Generate PCM 16-bit mono audio bytes at 16kHz."""
    num_samples = int(16000 * duration_ms / 1000)
    if amplitude == 0:
        audio = np.zeros(num_samples, dtype=np.int16)
    else:
        t = np.arange(num_samples) / 16000
        audio = (amplitude * np.sin(2 * np.pi * 440 * t)).astype(np.int16)
    return audio.tobytes()


class _FakeChunk:
    """Mimics AudioChunk with a .data attribute."""

    def __init__(self, data: bytes, source: str = "mixed"):
        self.data = data
        self.source = source
        self.timestamp_ms = 0.0


class TestAudioLoopForwarding:
    """Verify that _audio_loop forwards all chunks to the engine."""

    @pytest.mark.asyncio
    async def test_all_chunks_forwarded_to_engine(self):
        """Every audio chunk should be sent to the engine (no filtering)."""
        config = MagicMock()
        config.sample_rate = 16000
        session = MeetingSession(config)

        mock_engine = AsyncMock()
        mock_capture = MagicMock()

        session._engine = mock_engine
        session._capture = mock_capture
        session._running = True

        speech_data = _make_audio_bytes(amplitude=5000)
        silence_data = _make_audio_bytes(amplitude=0)

        # Mix of speech and silence — ALL should be forwarded
        chunks = [
            _FakeChunk(speech_data),
            _FakeChunk(silence_data),
            _FakeChunk(speech_data),
            _FakeChunk(silence_data),
            _FakeChunk(speech_data),
        ]
        call_count = 0

        def side_effect():
            nonlocal call_count
            if call_count >= len(chunks):
                session._running = False
                from queue import Empty
                raise Empty()
            chunk = chunks[call_count]
            call_count += 1
            return chunk

        mock_capture.mixed_queue.get_nowait = side_effect

        await session._audio_loop()

        # ALL 5 chunks should have been forwarded
        assert mock_engine.send_audio.await_count == 5

    @pytest.mark.asyncio
    async def test_session_has_no_vad(self):
        """Session should NOT have a VAD — engines handle their own."""
        config = MagicMock()
        session = MeetingSession(config)
        assert not hasattr(session, "_vad")

    @pytest.mark.asyncio
    async def test_audio_loop_handles_empty_queue(self):
        """Audio loop should handle queue.Empty gracefully."""
        from queue import Empty

        config = MagicMock()
        session = MeetingSession(config)

        mock_engine = AsyncMock()
        mock_capture = MagicMock()

        session._engine = mock_engine
        session._capture = mock_capture
        session._running = True

        call_count = 0

        def side_effect():
            nonlocal call_count
            call_count += 1
            if call_count > 2:
                session._running = False
            raise Empty()

        mock_capture.mixed_queue.get_nowait = side_effect

        await session._audio_loop()

        # No chunks sent (all were Empty)
        assert mock_engine.send_audio.await_count == 0
