"""Abstract transcription engine interface."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Callable


@dataclass
class TranscriptSegment:
    """A piece of transcribed text with metadata."""

    text: str
    timestamp_start: float  # Seconds from meeting start
    timestamp_end: float
    is_partial: bool = False  # True for interim/partial results
    speaker: str | None = None  # None until diarization is available
    confidence: float = 1.0


class TranscriptionEngine(ABC):
    """Base class for transcription engines (cloud and local)."""

    def __init__(self) -> None:
        self._callbacks: list[Callable[[TranscriptSegment], None]] = []

    def on_transcript(self, callback: Callable[[TranscriptSegment], None]) -> None:
        """Register a callback to receive transcript segments."""
        self._callbacks.append(callback)

    def _emit(self, segment: TranscriptSegment) -> None:
        """Notify all registered callbacks of a new segment."""
        for cb in self._callbacks:
            cb(segment)

    @abstractmethod
    async def start(self) -> None:
        """Initialize the engine and prepare for audio input."""
        ...

    @abstractmethod
    async def send_audio(self, chunk: bytes) -> None:
        """Send a chunk of 16-bit PCM 16kHz mono audio to the engine."""
        ...

    @abstractmethod
    async def stop(self) -> None:
        """Stop the engine and finalize any pending transcription."""
        ...

    async def flush(self) -> None:
        """Flush any buffered or in-flight partial text immediately.

        Default is a no-op. Engines with internal buffering (e.g. CloudEngine)
        override this to commit uncommitted partials before a pause/stop.
        """

    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable engine name."""
        ...
