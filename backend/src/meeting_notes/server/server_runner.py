"""Async adapter wrapping MeetingSession for server use.

Unlike SessionRunner (which bridges pywebview thread pool to asyncio), ServerRunner
runs entirely within the FastAPI async context. It registers a transcript callback
that broadcasts segments to WebSocket clients via ConnectionManager.
"""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

from meeting_notes.audio.devices import AudioDevice
from meeting_notes.audio.silence import SilenceMonitor
from meeting_notes.audio.wav_writer import WavWriter
from meeting_notes.config import Config
from meeting_notes.engines.base import TranscriptSegment
from meeting_notes.server.ws import ConnectionManager
from meeting_notes.session import MeetingSession

logger = logging.getLogger(__name__)

# Lock file to prevent double-recording (D022)
_LOCK_FILE = Path.home() / ".ai-meeting-notes.lock"


class ServerRunner:
    """Manages a MeetingSession within the FastAPI async context.

    The server is stateless (D024): all config comes from the POST /session/start
    request body. No shared settings.json.
    """

    def __init__(self, ws_manager: ConnectionManager) -> None:
        self._ws_manager = ws_manager
        self._session: MeetingSession | None = None
        self._start_time: float = 0.0
        self._output_path: str = ""
        self._status_task: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._session_lock = asyncio.Lock()
        self._paused_at: float = 0.0
        self._total_paused_seconds: float = 0.0
        self._silence_monitor: SilenceMonitor | None = None
        self._wav_writer: WavWriter | None = None
        self._wav_path: str | None = None

    @property
    def is_recording(self) -> bool:
        """True when a session is active (including while paused)."""
        return self._session is not None and self._session.is_running

    @property
    def is_paused(self) -> bool:
        return self._session is not None and self._session.is_paused

    @property
    def output_path(self) -> str:
        return self._output_path

    @property
    def wav_path(self) -> str | None:
        """Path to WAV recording, or None if not enabled."""
        return self._wav_path

    @property
    def elapsed_seconds(self) -> float:
        """Active recording time, excluding any paused intervals."""
        if not self.is_recording:
            return 0.0
        total = time.monotonic() - self._start_time
        paused = self._total_paused_seconds
        if self._paused_at > 0:
            paused += time.monotonic() - self._paused_at
        return max(0.0, total - paused)

    async def start(self, config: Config, mic: AudioDevice | None = None,
                    system: AudioDevice | None = None) -> str:
        """Start a recording session. Returns the engine name.

        Raises RuntimeError if already recording or if session cannot start.
        """
        async with self._session_lock:
            if self.is_recording:
                raise RuntimeError("A recording session is already active")

            # Atomic lock file creation (D022)
            try:
                with open(_LOCK_FILE, "x") as f:
                    f.write(str(time.time()))
            except FileExistsError:
                raise RuntimeError(
                    "Another recording is already in progress "
                    f"(lock file: {_LOCK_FILE})"
                )

            self._loop = asyncio.get_running_loop()
            self._paused_at = 0.0
            self._total_paused_seconds = 0.0
            self._session = MeetingSession(
                config=config, mic_device=mic, system_device=system,
                write_markdown=False,  # Plugin writes to vault; server needs no file output
            )

            # Register broadcast callback BEFORE session.start() so the engine
            # captures it. Engine callbacks fire from background threads, so we
            # marshal to the event loop via call_soon_threadsafe.
            def _broadcast_cb(segment: TranscriptSegment) -> None:
                if not segment.text.strip():
                    return
                # Final transcript proves speech is happening — reset silence
                # monitor even if RMS is below threshold (e.g. low-volume
                # system audio that AssemblyAI can still decode).
                if not segment.is_partial and self._silence_monitor:
                    self._silence_monitor.reset_silence()
                if self._loop and self._loop.is_running():
                    asyncio.run_coroutine_threadsafe(
                        self._ws_manager.broadcast_transcript(
                            text=segment.text,
                            is_partial=segment.is_partial,
                            timestamp_start=segment.timestamp_start,
                            timestamp_end=segment.timestamp_end,
                            speaker=segment.speaker,
                        ),
                        self._loop,
                    )

            self._session.add_transcript_callback(_broadcast_cb)

            # Wire up silence monitoring if enabled
            if config.silence_threshold_seconds > 0:
                def _silence_cb(silent_seconds: float) -> None:
                    if self._loop and self._loop.is_running():
                        asyncio.run_coroutine_threadsafe(
                            self._ws_manager.broadcast_silence(silent_seconds),
                            self._loop,
                        )
                self._silence_monitor = SilenceMonitor(
                    threshold_seconds=config.silence_threshold_seconds,
                    interval_seconds=15.0,
                    on_silence=_silence_cb,
                )
                self._session.add_audio_callback(
                    lambda chunk: self._silence_monitor.feed_chunk(chunk.data)
                    if self._silence_monitor else None
                )
            else:
                self._silence_monitor = None

            # Set up WAV recording if enabled
            if config.record_wav and config.output_dir:
                wav_file = config.output_dir / f"recording_{int(time.time())}.wav"
                self._wav_writer = WavWriter(wav_file)
                self._wav_writer.open()
                self._wav_path = str(wav_file)
                writer = self._wav_writer
                self._session.add_audio_callback(
                    lambda chunk, w=writer: w.write_chunk(chunk.data)
                )
                logger.info("WAV recording enabled: %s", wav_file)
            else:
                self._wav_writer = None
                self._wav_path = None

            try:
                output_path = await self._session.start()
            except Exception:
                if self._wav_writer:
                    self._wav_writer.close()
                    self._wav_writer = None
                _remove_lock()
                self._session = None
                raise

            self._output_path = str(output_path) if output_path else ""
            self._start_time = time.monotonic()

            # Start periodic status broadcasts
            self._status_task = asyncio.create_task(self._status_loop())

            # Broadcast initial status
            await self._ws_manager.broadcast_status("recording", 0.0)

            engine_name = self._session._engine.name if self._session._engine else "unknown"
            logger.info("Server session started: engine=%s, output=%s", engine_name, output_path)
            return engine_name

    async def stop(self) -> float:
        """Stop the recording session. Returns elapsed seconds."""
        async with self._session_lock:
            if not self._session:
                return 0.0

            elapsed = self.elapsed_seconds

            # Cancel status loop
            if self._status_task:
                self._status_task.cancel()
                try:
                    await self._status_task
                except asyncio.CancelledError:
                    pass

            self._silence_monitor = None

            await self._session.stop()

            # Close WAV writer if active
            if self._wav_writer:
                self._wav_writer.close()
                self._wav_writer = None

            self._session = None

            _remove_lock()

            await self._ws_manager.broadcast_status("stopped", elapsed)
            logger.info("Server session stopped after %.1fs", elapsed)
            return elapsed

    def reset_silence(self) -> None:
        """Reset the silence timer (called when client clicks Extend)."""
        if self._silence_monitor:
            self._silence_monitor.reset_silence()
            logger.info("Silence monitor reset by client request")

    async def pause(self) -> float:
        """Pause the active recording. Returns elapsed seconds at pause point."""
        async with self._session_lock:
            if not self._session or not self.is_recording:
                raise RuntimeError("No active recording to pause")
            if self.is_paused:
                raise RuntimeError("Recording is already paused")
            self._paused_at = time.monotonic()
            elapsed = self.elapsed_seconds
            await self._session.pause()
            await self._ws_manager.broadcast_status("paused", elapsed)
            logger.info("Session paused at %.1fs", elapsed)
            return elapsed

    async def resume(self) -> float:
        """Resume a paused recording. Returns elapsed seconds."""
        async with self._session_lock:
            if not self._session or not self.is_paused:
                raise RuntimeError("Recording is not paused")
            if self._paused_at > 0:
                self._total_paused_seconds += time.monotonic() - self._paused_at
                self._paused_at = 0.0
            await self._session.resume()
            elapsed = self.elapsed_seconds
            await self._ws_manager.broadcast_status("recording", elapsed)
            logger.info("Session resumed at %.1fs elapsed", elapsed)
            return elapsed

    async def _status_loop(self) -> None:
        """Broadcast status updates every 2 seconds."""
        try:
            while self.is_recording:
                await asyncio.sleep(2.0)
                if self.is_recording:
                    state = "paused" if self.is_paused else "recording"
                    await self._ws_manager.broadcast_status(state, self.elapsed_seconds)
        except asyncio.CancelledError:
            pass


def _remove_lock() -> None:
    try:
        _LOCK_FILE.unlink(missing_ok=True)
    except OSError:
        logger.warning("Could not remove lock file: %s", _LOCK_FILE)
