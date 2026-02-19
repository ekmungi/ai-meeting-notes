"""Voice Activity Detection using Silero VAD.

Provides speech/silence detection for audio chunks, used to gate audio
before sending to the transcription engine. This prevents the engine
from receiving silence (which causes false endpointing) and ensures
complete speech segments are sent together.
"""

from __future__ import annotations

import logging
import os
from collections import deque
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

# Silero VAD operates on fixed window sizes at 16kHz:
# 512 samples (32ms), 1024 (64ms), or 1536 (96ms)
SILERO_WINDOW_SAMPLES = 512  # 32ms at 16kHz — lowest latency

# Default location where torch.hub caches the Silero model
_SILERO_ONNX_DEFAULT = Path(
    os.path.expanduser("~/.cache/torch/hub")
) / "snakers4_silero-vad_master/src/silero_vad/data/silero_vad.onnx"


class _SileroOnnxModel:
    """Minimal ONNX wrapper for Silero VAD — no torch/torchaudio needed.

    The Silero ONNX model expects:
      - input:  float32 [1, N]  (audio samples in [-1, 1])
      - state:  float32 [2, 1, 128] (recurrent state, zeros initially)
      - sr:     int64 scalar (sample rate: 8000 or 16000)
    Returns:
      - output: float32 [1, 1] (speech probability)
      - stateN: float32 [2, 1, 128] (updated state)
    """

    def __init__(self, model_path: str | Path):
        import onnxruntime

        self._session = onnxruntime.InferenceSession(
            str(model_path),
            providers=["CPUExecutionProvider"],
        )
        self._state = np.zeros((2, 1, 128), dtype=np.float32)

    def __call__(
        self, audio: np.ndarray, sample_rate: int
    ) -> float:
        """Run inference on a single audio window.

        Args:
            audio: float32 array of shape (N,), values in [-1, 1].
            sample_rate: 16000 or 8000.

        Returns:
            Speech probability as a float in [0, 1].
        """
        # Shape: [1, N]
        inp = audio.reshape(1, -1).astype(np.float32)
        sr = np.array(sample_rate, dtype=np.int64)

        out, self._state = self._session.run(
            None,
            {"input": inp, "state": self._state, "sr": sr},
        )
        return float(out[0, 0])

    def reset_states(self) -> None:
        """Reset recurrent state to zeros."""
        self._state = np.zeros((2, 1, 128), dtype=np.float32)


def _download_silero_onnx() -> Path:
    """Download Silero VAD ONNX model via torch.hub if not cached."""
    if _SILERO_ONNX_DEFAULT.exists():
        return _SILERO_ONNX_DEFAULT

    # torch.hub.load will download and cache the repo
    logger.info("Downloading Silero VAD model...")
    import torch
    torch.hub.load(
        repo_or_dir="snakers4/silero-vad",
        model="silero_vad",
        onnx=True,
        force_reload=False,
        trust_repo=True,
    )

    if _SILERO_ONNX_DEFAULT.exists():
        return _SILERO_ONNX_DEFAULT

    raise FileNotFoundError(
        f"Silero ONNX model not found at {_SILERO_ONNX_DEFAULT}"
    )


class VoiceActivityDetector:
    """Detects speech in audio using Silero VAD (ONNX mode).

    Uses onnxruntime directly — no torch or torchaudio needed at runtime
    (only for initial download if the model isn't cached yet).
    Falls back to a simple energy-based detector if unavailable.
    """

    def __init__(
        self,
        threshold: float = 0.35,
        sample_rate: int = 16000,
    ):
        self._threshold = threshold
        self._sample_rate = sample_rate
        self._model: _SileroOnnxModel | None = None
        self._use_silero = False
        self._init_model()

    def _init_model(self) -> None:
        """Load Silero VAD ONNX model, fall back to energy-based."""
        try:
            if _SILERO_ONNX_DEFAULT.exists():
                model_path = _SILERO_ONNX_DEFAULT
            else:
                model_path = _download_silero_onnx()

            self._model = _SileroOnnxModel(model_path)
            self._use_silero = True
            logger.info(
                "Silero VAD loaded (ONNX, threshold=%.2f)",
                self._threshold,
            )
        except Exception as exc:
            logger.warning(
                "Silero VAD not available (%s), "
                "using energy-based fallback. "
                "Install: pip install torch onnxruntime && "
                "python -c \"import torch; torch.hub.load("
                "'snakers4/silero-vad', 'silero_vad', "
                "onnx=True, trust_repo=True)\"",
                exc,
            )
            self._use_silero = False

    def is_speech(self, audio_bytes: bytes) -> bool:
        """Check if an audio chunk contains speech.

        Args:
            audio_bytes: Raw PCM 16-bit mono audio at self._sample_rate.

        Returns:
            True if speech is detected.
        """
        if self._use_silero:
            return self._silero_detect(audio_bytes)
        return self._energy_detect(audio_bytes)

    def _silero_detect(self, audio_bytes: bytes) -> bool:
        """Run Silero VAD (ONNX) on the audio chunk."""
        assert self._model is not None
        audio = np.frombuffer(audio_bytes, dtype=np.int16)
        audio_float = audio.astype(np.float32) / 32768.0

        for start in range(
            0, len(audio_float), SILERO_WINDOW_SAMPLES
        ):
            window = audio_float[start:start + SILERO_WINDOW_SAMPLES]
            if len(window) < SILERO_WINDOW_SAMPLES:
                padded = np.zeros(
                    SILERO_WINDOW_SAMPLES, dtype=np.float32
                )
                padded[:len(window)] = window
                window = padded

            prob = self._model(window, self._sample_rate)
            if prob >= self._threshold:
                return True

        return False

    def _energy_detect(self, audio_bytes: bytes) -> bool:
        """Simple RMS energy-based speech detection fallback."""
        audio = np.frombuffer(audio_bytes, dtype=np.int16)
        if len(audio) == 0:
            return False
        rms = float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))
        return rms > 300.0

    def reset(self) -> None:
        """Reset internal state (Silero has recurrent state)."""
        if self._use_silero and self._model is not None:
            self._model.reset_states()


class SpeechBuffer:
    """Buffers audio and uses VAD to emit complete speech segments.

    Accumulates audio while speech is detected. After speech ends,
    waits for a configurable post-speech silence duration before
    flushing the buffer. This prevents mid-sentence pauses from
    splitting the audio.

    The buffer also keeps a small pre-speech buffer so the start
    of speech is not clipped.
    """

    def __init__(
        self,
        vad: VoiceActivityDetector,
        post_speech_silence_ms: int = 1500,
        pre_speech_buffer_ms: int = 300,
        sample_rate: int = 16000,
        chunk_duration_ms: int = 100,
    ):
        self._vad = vad
        self._sample_rate = sample_rate
        self._bytes_per_chunk = int(
            sample_rate * chunk_duration_ms / 1000 * 2
        )

        self._silence_chunks_needed = max(
            1, post_speech_silence_ms // chunk_duration_ms
        )
        pre_chunks = max(1, pre_speech_buffer_ms // chunk_duration_ms)
        self._pre_buffer: deque[bytes] = deque(maxlen=pre_chunks)

        self._speech_buffer: list[bytes] = []
        self._silence_counter = 0
        self._in_speech = False

    @property
    def in_speech(self) -> bool:
        return self._in_speech

    def feed(self, audio_bytes: bytes) -> bytes | None:
        """Feed an audio chunk and return a complete speech segment or None.

        Returns:
            Concatenated audio bytes of a complete speech segment when
            speech ends, or None if still accumulating.
        """
        has_speech = self._vad.is_speech(audio_bytes)

        if has_speech:
            self._silence_counter = 0

            if not self._in_speech:
                self._in_speech = True
                self._speech_buffer = list(self._pre_buffer)
                self._pre_buffer.clear()
                logger.debug("Speech started")

            self._speech_buffer.append(audio_bytes)
            return None

        if self._in_speech:
            self._speech_buffer.append(audio_bytes)
            self._silence_counter += 1

            if self._silence_counter >= self._silence_chunks_needed:
                result = b"".join(self._speech_buffer)
                self._speech_buffer.clear()
                self._in_speech = False
                self._silence_counter = 0
                self._vad.reset()
                logger.debug(
                    "Speech ended (%.1fs of audio)",
                    len(result) / (self._sample_rate * 2),
                )
                return result
        else:
            self._pre_buffer.append(audio_bytes)

        return None

    def flush(self) -> bytes | None:
        """Force-flush any buffered speech (e.g., at session end).

        Returns:
            Remaining buffered audio, or None if buffer is empty.
        """
        if self._speech_buffer:
            result = b"".join(self._speech_buffer)
            self._speech_buffer.clear()
            self._in_speech = False
            self._silence_counter = 0
            return result
        return None
