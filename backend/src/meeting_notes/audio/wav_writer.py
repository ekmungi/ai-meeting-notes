"""Parallel WAV file writer -- records raw audio alongside transcription.

Writes 16kHz mono int16 PCM to a standard WAV file. Designed to be
registered as an audio callback via MeetingSession.add_audio_callback().
Best-effort: write failures are logged but never interrupt recording.
"""

from __future__ import annotations

import logging
import wave
from pathlib import Path

logger = logging.getLogger(__name__)

_SAMPLE_RATE = 16000
_CHANNELS = 1
_SAMPLE_WIDTH = 2  # 16-bit = 2 bytes


class WavWriter:
    """Writes raw PCM int16 audio chunks to a WAV file."""

    def __init__(self, path: Path) -> None:
        """Initialize writer with target file path.

        Args:
            path: Destination path for the WAV file.
        """
        self._path = path
        self._wav: wave.Wave_write | None = None

    def open(self) -> None:
        """Open the WAV file for writing."""
        self._wav = wave.open(str(self._path), "wb")
        self._wav.setnchannels(_CHANNELS)
        self._wav.setsampwidth(_SAMPLE_WIDTH)
        self._wav.setframerate(_SAMPLE_RATE)
        logger.info("WAV recording started: %s", self._path)

    def write_chunk(self, pcm_data: bytes) -> None:
        """Write a chunk of raw PCM audio. No-op if file is not open.

        Args:
            pcm_data: Raw int16 PCM bytes at 16kHz mono.
        """
        if self._wav is None:
            return
        try:
            self._wav.writeframes(pcm_data)
        except Exception:
            logger.warning("WAV write failed (continuing recording)", exc_info=True)

    def close(self) -> None:
        """Close the WAV file. Safe to call multiple times."""
        if self._wav is not None:
            try:
                self._wav.close()
            except Exception:
                logger.warning("WAV close failed", exc_info=True)
            self._wav = None
            logger.info("WAV recording saved: %s", self._path)

    def __enter__(self) -> WavWriter:
        """Open writer as context manager."""
        self.open()
        return self

    def __exit__(self, exc_type: type | None, exc_val: BaseException | None, exc_tb: object) -> None:
        """Close writer on context exit."""
        self.close()
