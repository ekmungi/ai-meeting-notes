# Silence detection using RMS energy -- lightweight, no ML model.
# Designed for WASAPI mixed audio where Silero VAD fails.

from __future__ import annotations

import logging
import time
from typing import Callable

import numpy as np

logger = logging.getLogger(__name__)

_CALIBRATION_CHUNKS = 30  # 3 seconds at 100ms per chunk
_NOISE_MARGIN_FACTOR = 2.0
_MIN_RMS_THRESHOLD = 100.0


def _compute_rms(pcm_data: bytes) -> float:
    """Compute root-mean-square energy of raw PCM int16 audio bytes."""
    samples = np.frombuffer(pcm_data, dtype=np.int16).astype(np.float64)
    if len(samples) == 0:
        return 0.0
    return float(np.sqrt(np.mean(samples ** 2)))


class SilenceMonitor:
    """Detects sustained silence in raw PCM int16 audio chunks.

    Uses RMS energy (not Silero VAD) because WASAPI mixed audio
    fails VAD thresholds. Auto-calibrates ambient noise floor
    from the first 3 seconds of audio.
    """

    def __init__(
        self,
        threshold_seconds: float = 15.0,
        interval_seconds: float = 15.0,
        on_silence: Callable[[float], None] | None = None,
    ) -> None:
        """Create a new SilenceMonitor.

        Args:
            threshold_seconds: Seconds of silence before triggering. 0 disables.
            interval_seconds: Seconds between repeated silence callbacks.
            on_silence: Callback receiving elapsed silent seconds.
        """
        self._threshold_seconds = threshold_seconds
        self._interval_seconds = interval_seconds
        self._on_silence = on_silence

        # Internal state -- reset via reset().
        self._calibration_rms: list[float] = []
        self._rms_threshold: float = 0.0
        self._calibrated: bool = False
        self._silence_start: float | None = None
        self._last_callback_time: float | None = None
        self._is_silent: bool = False
        self._silent_seconds: float = 0.0

    # -- Public properties ---------------------------------------------------

    @property
    def calibrated(self) -> bool:
        """Whether the ambient noise calibration phase is complete."""
        return self._calibrated

    @property
    def is_silent(self) -> bool:
        """Whether sustained silence has been detected."""
        return self._is_silent

    @property
    def silent_seconds(self) -> float:
        """Elapsed seconds of continuous silence (0.0 if not silent)."""
        return self._silent_seconds

    # -- Public methods ------------------------------------------------------

    def feed_chunk(self, pcm_data: bytes) -> None:
        """Process a 100ms chunk of raw PCM int16 audio.

        Args:
            pcm_data: Raw PCM int16 bytes (e.g. 1600 samples at 16kHz).
        """
        # Disabled mode -- do nothing.
        if self._threshold_seconds <= 0:
            return

        rms = _compute_rms(pcm_data)

        # Calibration phase: collect ambient noise samples.
        if not self._calibrated:
            self._calibration_rms = [*self._calibration_rms, rms]
            if len(self._calibration_rms) >= _CALIBRATION_CHUNKS:
                ambient = max(self._calibration_rms) if self._calibration_rms else 0.0
                self._rms_threshold = max(ambient * _NOISE_MARGIN_FACTOR, _MIN_RMS_THRESHOLD)
                self._calibrated = True
                logger.info(
                    "Silence monitor calibrated: ambient_max=%.1f, threshold=%.1f",
                    ambient,
                    self._rms_threshold,
                )
            return

        # Post-calibration: classify chunk as speech or silence.
        now = time.monotonic()

        if rms >= self._rms_threshold:
            # Speech detected -- reset silence tracking.
            self._silence_start = None
            self._last_callback_time = None
            self._is_silent = False
            self._silent_seconds = 0.0
            return

        # Silence chunk.
        if self._silence_start is None:
            self._silence_start = now
            return

        elapsed = now - self._silence_start
        self._silent_seconds = elapsed

        if elapsed < self._threshold_seconds:
            return

        # Silence exceeds threshold.
        self._is_silent = True

        if self._on_silence is None:
            return

        # Fire callback: once at threshold, then every interval_seconds.
        if self._last_callback_time is None:
            self._last_callback_time = now
            self._on_silence(elapsed)
        elif now - self._last_callback_time >= self._interval_seconds:
            self._last_callback_time = now
            self._on_silence(elapsed)

    def reset(self) -> None:
        """Reset to initial state (pre-calibration)."""
        self._calibration_rms = []
        self._rms_threshold = 0.0
        self._calibrated = False
        self._silence_start = None
        self._last_callback_time = None
        self._is_silent = False
        self._silent_seconds = 0.0
