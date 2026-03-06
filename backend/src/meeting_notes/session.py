"""Meeting session orchestrator — ties audio capture, engine, and output together."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from queue import Empty
from typing import Callable

from meeting_notes.audio.capture import AudioCapture
from meeting_notes.audio.devices import AudioDevice
from meeting_notes.config import Config
from meeting_notes.engines.base import TranscriptionEngine, TranscriptSegment
from meeting_notes.engines.selector import select_engine
from meeting_notes.output.markdown import MarkdownWriter

logger = logging.getLogger(__name__)


class MeetingSession:
    """Orchestrates a meeting recording session.

    Wires together audio capture, transcription engine, and markdown output.
    The session forwards all audio to the engine — each engine handles its
    own filtering (cloud relies on server-side VAD, local uses a bounded
    async queue with drop-oldest policy).
    """

    def __init__(
        self,
        config: Config,
        mic_device: AudioDevice | None = None,
        system_device: AudioDevice | None = None,
        write_markdown: bool = True,
        status_callback: Callable[[str], None] | None = None,
    ):
        self._config = config
        self._mic_device = mic_device
        self._system_device = system_device
        self._write_markdown = write_markdown
        self._status_callback = status_callback
        self._capture: AudioCapture | None = None
        self._engine: TranscriptionEngine | None = None
        self._writer: MarkdownWriter | None = None
        self._running = False
        self._paused = False
        self._task: asyncio.Task | None = None
        self._extra_callbacks: list[Callable[[TranscriptSegment], None]] = []
        self._audio_callbacks: list = []

    def add_transcript_callback(
        self, callback: Callable[[TranscriptSegment], None],
    ) -> None:
        """Register an additional callback for transcript segments.

        Called for every segment (including partials). Callbacks registered
        here fire after the built-in _on_transcript handler.
        """
        self._extra_callbacks.append(callback)

    def add_audio_callback(self, cb: Callable) -> None:
        """Register a callback invoked for each audio chunk in the audio loop.

        Args:
            cb: Callable receiving the audio chunk object.
        """
        self._audio_callbacks.append(cb)

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def is_paused(self) -> bool:
        return self._paused

    async def start(self) -> Path | None:
        """Start the meeting session. Returns path to output markdown, or None if write_markdown=False."""
        # Select engine
        self._engine = select_engine(self._config, on_status=self._status_callback)
        logger.info("Using engine: %s", self._engine.name)

        # Set up markdown writer (skipped in server mode — plugin handles output)
        output_path: Path | None = None
        if self._write_markdown:
            self._writer = MarkdownWriter(
                output_dir=self._config.output_dir,
                engine_name=self._engine.name,
                timestamp_mode=self._config.timestamp_mode,
                meeting_type=self._config.meeting_type,
            )
            output_path = self._writer.start()

        # Register transcript callback
        self._engine.on_transcript(self._on_transcript)

        # Start engine
        await self._engine.start()

        # Start audio capture
        self._capture = AudioCapture(
            mic_device=self._mic_device,
            system_device=self._system_device,
            target_sample_rate=self._config.sample_rate,
        )
        self._capture.start()

        # Start the audio forwarding loop
        self._running = True
        self._task = asyncio.create_task(self._audio_loop())

        if output_path:
            logger.info("Meeting session started — writing to %s", output_path)
            print(f"\nRecording started. Transcript: {output_path}")
            print("Press Ctrl+C to stop.\n")
        else:
            logger.info("Meeting session started (no markdown output)")

        return output_path

    async def stop(self) -> None:
        """Stop the meeting session gracefully."""
        self._running = False

        # Stop audio capture
        if self._capture:
            self._capture.stop()

        # Wait for audio loop to finish
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=5.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass

        # Stop engine (will flush fragment buffer internally)
        if self._engine:
            await self._engine.stop()

        # Close markdown file
        if self._writer:
            self._writer.stop()

        print("\nRecording stopped.")
        if self._writer and self._writer.file_path:
            print(f"Transcript saved to: {self._writer.file_path}")

    async def pause(self) -> None:
        """Pause audio capture. Session stays active; no audio is forwarded to the engine."""
        if not self._running or self._paused:
            return
        self._paused = True
        # Flush any in-flight partial before stopping audio so the last
        # spoken words are committed rather than waiting for AssemblyAI's
        # silence timeout (up to ~2s) to fire end_of_turn.
        if self._engine:
            await self._engine.flush()
        if self._capture:
            self._capture.stop()
            self._capture = None
        logger.info("Meeting session paused")

    async def resume(self) -> None:
        """Resume audio capture after a pause."""
        if not self._running or not self._paused:
            return
        self._capture = AudioCapture(
            mic_device=self._mic_device,
            system_device=self._system_device,
            target_sample_rate=self._config.sample_rate,
        )
        self._capture.start()
        self._paused = False
        logger.info("Meeting session resumed")

    async def _audio_loop(self) -> None:
        """Read audio chunks from capture and forward all to the engine.

        No VAD filtering here — each engine handles its own audio needs:
        - Cloud engine: sends everything, AssemblyAI has server-side VAD
        - Local engine: buffers audio in fixed-length windows, dispatches
          via a bounded async queue with drop-oldest policy
        """
        assert self._capture is not None
        assert self._engine is not None

        chunks_forwarded = 0

        while self._running:
            try:
                if self._paused or self._capture is None:
                    await asyncio.sleep(0.01)
                    continue

                try:
                    chunk = self._capture.mixed_queue.get_nowait()
                except Empty:
                    await asyncio.sleep(0.01)  # 10ms poll instead of 500ms blocking
                    continue

                chunks_forwarded += 1

                # Notify audio callbacks (e.g., silence monitor)
                for cb in self._audio_callbacks:
                    try:
                        cb(chunk)
                    except Exception:
                        pass

                await self._engine.send_audio(chunk.data)

                if chunks_forwarded % 500 == 0:
                    logger.debug(
                        "Audio loop: %d chunks forwarded to engine",
                        chunks_forwarded,
                    )

            except Empty:
                await asyncio.sleep(0.01)
            except Exception:
                logger.exception("Unexpected error in audio loop")
                await asyncio.sleep(0.05)

    def _on_transcript(self, segment: TranscriptSegment) -> None:
        """Handle incoming transcript segments from the engine."""
        # Notify extra callbacks (e.g., server WebSocket broadcast) for all segments
        for cb in self._extra_callbacks:
            try:
                cb(segment)
            except Exception:
                logger.exception("Error in extra transcript callback")

        if not segment.text.strip():
            return

        # Only write final (non-partial) segments to file
        if segment.is_partial:
            return

        if self._writer:
            self._writer.write_segment(segment)
