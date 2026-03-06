"""Tests for WavWriter -- parallel WAV recording alongside transcription."""

import wave
from pathlib import Path

import numpy as np
import pytest

from meeting_notes.audio.wav_writer import WavWriter


class TestWavWriter:
    def test_creates_wav_file(self, tmp_path):
        """WavWriter creates a valid WAV file at the given path."""
        wav_path = tmp_path / "test.wav"
        writer = WavWriter(wav_path)
        writer.open()
        writer.close()
        assert wav_path.exists()

    def test_writes_audio_data(self, tmp_path):
        """Written chunks appear in the WAV file with correct format."""
        wav_path = tmp_path / "test.wav"
        writer = WavWriter(wav_path)
        writer.open()
        silence = np.zeros(16000, dtype=np.int16).tobytes()
        writer.write_chunk(silence)
        writer.close()

        with wave.open(str(wav_path), "rb") as wf:
            assert wf.getnchannels() == 1
            assert wf.getsampwidth() == 2
            assert wf.getframerate() == 16000
            assert wf.getnframes() == 16000

    def test_multiple_chunks(self, tmp_path):
        """Multiple write_chunk calls accumulate correctly."""
        wav_path = tmp_path / "test.wav"
        writer = WavWriter(wav_path)
        writer.open()
        chunk = np.full(1600, 1000, dtype=np.int16).tobytes()
        for _ in range(10):
            writer.write_chunk(chunk)
        writer.close()

        with wave.open(str(wav_path), "rb") as wf:
            assert wf.getnframes() == 16000

    def test_close_without_open_is_safe(self, tmp_path):
        """Calling close() without open() does not raise."""
        wav_path = tmp_path / "test.wav"
        writer = WavWriter(wav_path)
        writer.close()

    def test_write_after_close_is_ignored(self, tmp_path):
        """Writing after close does not raise (best-effort)."""
        wav_path = tmp_path / "test.wav"
        writer = WavWriter(wav_path)
        writer.open()
        writer.close()
        chunk = np.zeros(1600, dtype=np.int16).tobytes()
        writer.write_chunk(chunk)

    def test_context_manager(self, tmp_path):
        """WavWriter works as a context manager."""
        wav_path = tmp_path / "test.wav"
        with WavWriter(wav_path) as writer:
            chunk = np.zeros(1600, dtype=np.int16).tobytes()
            writer.write_chunk(chunk)
        assert wav_path.exists()
