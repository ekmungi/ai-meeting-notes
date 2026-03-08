"""Background session runner — bridges pywebview thread pool to asyncio MeetingSession."""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from meeting_notes.audio.silence import SilenceMonitor
from meeting_notes.audio.wav_writer import WavWriter
from meeting_notes.config import Config
from meeting_notes.engines.base import TranscriptSegment
from meeting_notes.session import MeetingSession
from meeting_notes.ui.merge import create_notes_file, merge_notes_with_transcript

logger = logging.getLogger(__name__)

# How often to push status updates to the JS frontend (seconds)
_UPDATE_INTERVAL_S = 2.0


class SessionRunner:
    """Manages a MeetingSession on a background asyncio thread.

    pywebview calls js_api methods on its thread pool. This class bridges
    those calls to a dedicated asyncio event loop running on a daemon thread.
    Status updates are pushed to the JS frontend via window.evaluate_js().
    """

    def __init__(self, config: Config, window: Any, open_editor: bool = False) -> None:
        self._config = config
        self._window = window
        self._session: MeetingSession | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._running = False
        self._output_path: str | None = None
        self._segment_count = 0
        self._silence_monitor: SilenceMonitor | None = None
        self._silence_auto_stop: bool = False
        self._wav_writer: WavWriter | None = None
        self._wav_path: str | None = None
        self._last_speaker: str | None = None
        self._open_editor: bool = open_editor
        self._notes_path: Path | None = None

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def is_paused(self) -> bool:
        """Whether the session is currently paused."""
        return self._session.is_paused if self._session else False

    def pause(self) -> None:
        """Pause audio capture. Session stays active but no audio is forwarded."""
        if not self._running or not self._loop or not self._session:
            return
        asyncio.run_coroutine_threadsafe(self._session.pause(), self._loop)

    def resume(self) -> None:
        """Resume audio capture after a pause."""
        if not self._running or not self._loop or not self._session:
            return
        asyncio.run_coroutine_threadsafe(self._session.resume(), self._loop)

    def start(self) -> str:
        """Start recording. Returns engine name. Called from pywebview thread pool.

        Raises RuntimeError if the session cannot be started (no devices,
        engine import failure, API key invalid, etc.).
        """
        self._segment_count = 0
        self._output_path = None
        self._loop = asyncio.new_event_loop()
        self._running = True

        self._session = MeetingSession(
            config=self._config,
            status_callback=self._push_engine_status,
        )

        # Start the asyncio loop on a daemon thread
        self._thread = threading.Thread(
            target=self._run_loop,
            name="session-runner",
            daemon=True,
        )
        self._thread.start()

        # Block until session is actually started (or fails).
        # Timeout is generous: first-time model downloads can take several
        # minutes on slow connections, and loading large models from disk
        # (with HuggingFace hub validation) can also exceed 30 seconds.
        # The status bar shows live progress via updateEngineStatus() callbacks.
        future = asyncio.run_coroutine_threadsafe(self._start_session(), self._loop)
        try:
            engine_name = future.result(timeout=300)
        except Exception as exc:
            # Start failed — tear down the loop
            self._running = False
            self._loop.call_soon_threadsafe(self._loop.stop)
            if self._thread:
                self._thread.join(timeout=5)
            raise RuntimeError(str(exc)) from exc

        # Start periodic status updates and watchdog
        asyncio.run_coroutine_threadsafe(self._status_loop(), self._loop)
        asyncio.run_coroutine_threadsafe(self._watchdog(), self._loop)

        return engine_name

    def stop(self) -> None:
        """Stop recording. Returns immediately — notifies JS when truly done.

        The actual session teardown (including Whisper draining) runs on the
        background loop. The JS frontend receives onRecordingStopped() via
        evaluate_js once the session has fully stopped.
        """
        if not self._running or not self._loop or not self._session:
            return

        self._running = False
        asyncio.run_coroutine_threadsafe(self._stop_and_notify(), self._loop)

    def merge_notes(self) -> str | None:
        """Merge notes file with transcript. Returns final path or None."""
        if not self._notes_path or not self._output_path:
            return self._output_path
        result = merge_notes_with_transcript(
            self._notes_path,
            Path(self._output_path),
        )
        return str(result)

    def _run_loop(self) -> None:
        """Run the asyncio event loop on the background thread."""
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_forever()
        finally:
            # Clean up pending tasks
            pending = asyncio.all_tasks(self._loop)
            for task in pending:
                task.cancel()
            if pending:
                self._loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            self._loop.close()

    async def _start_session(self) -> str:
        """Start the meeting session (runs on bg loop)."""
        assert self._session is not None

        # Register transcript callback for segment counting and live preview
        self._last_speaker = None
        self._session.add_transcript_callback(self._on_transcript_segment)

        output_path = await self._session.start()
        self._output_path = str(output_path) if output_path else None

        # Set up silence monitor
        if self._config.silence_threshold_seconds > 0:
            self._silence_monitor = SilenceMonitor(
                threshold_seconds=self._config.silence_threshold_seconds,
                on_silence=self._on_silence,
            )
            self._session.add_audio_callback(
                lambda chunk: self._silence_monitor.feed_chunk(chunk.data)
            )

        # Set up WAV recording
        if self._config.record_wav and self._output_path:
            wav_file = Path(self._output_path).with_suffix(".wav")
            self._wav_writer = WavWriter(wav_file)
            self._wav_writer.open()
            self._wav_path = str(wav_file)
            writer = self._wav_writer
            self._session.add_audio_callback(
                lambda chunk, w=writer: w.write_chunk(chunk.data)
            )

        # Notify JS of the output file path immediately so the user knows
        # where transcription is being written while recording is in progress.
        if output_path and self._window:
            path_js = str(output_path).replace("\\", "\\\\")
            try:
                self._window.evaluate_js(f'onRecordingFileReady("{path_js}")')
            except Exception:
                pass

        # Launch editor for notes if enabled
        if self._open_editor and output_path:
            now = datetime.now()
            notes_path = create_notes_file(
                output_dir=output_path.parent,
                meeting_type=self._config.meeting_type,
                date_str=now.strftime("%Y-%m-%d"),
                time_str=now.strftime("%H-%M"),
            )
            self._notes_path = notes_path
            try:
                await asyncio.get_running_loop().run_in_executor(
                    None, os.startfile, str(notes_path)  # noqa: S606
                )
            except Exception:
                logger.warning("Failed to open editor for notes file", exc_info=True)

        return self._session._engine.name if self._session._engine else "Unknown"

    async def _stop_session(self) -> None:
        """Stop the meeting session (runs on bg loop)."""
        if self._session:
            await self._session.stop()

    async def _stop_and_notify(self) -> None:
        """Stop the session, notify JS, then shut down the event loop.

        A hard 8-second outer timeout guarantees onRecordingStopped() is always
        called and the UI never stays on "Stopping..." indefinitely.
        """
        try:
            await asyncio.wait_for(self._stop_session(), timeout=8.0)
        except asyncio.TimeoutError:
            logger.warning("Session stop timed out after 8s — forcing shutdown")
        except Exception:
            logger.exception("Error stopping session")

        # Close WAV writer
        if self._wav_writer:
            self._wav_writer.close()
            self._wav_writer = None

        # If notes file exists, prompt user to merge
        if self._notes_path and self._notes_path.exists() and self._window:
            notes_js = str(self._notes_path).replace("\\", "\\\\")
            try:
                self._window.evaluate_js(f'onMergePrompt("{notes_js}")')
            except Exception:
                logger.warning("Failed to show merge dialog", exc_info=True)

        self._notify_stopped()
        if self._loop and self._loop.is_running():
            self._loop.call_soon_threadsafe(self._loop.stop)

    async def _status_loop(self) -> None:
        """Periodically push segment count and silence status to JS."""
        was_silent = False
        while self._running:
            await asyncio.sleep(_UPDATE_INTERVAL_S)
            if self._window and self._running:
                try:
                    self._window.evaluate_js(
                        f"updateSessionStatus({self._segment_count})"
                    )
                except Exception:
                    pass
                if self._silence_monitor:
                    if was_silent and not self._silence_monitor.is_silent:
                        try:
                            self._window.evaluate_js("updateSilenceStatus(0)")
                        except Exception:
                            pass
                    was_silent = self._silence_monitor.is_silent

    async def _watchdog(self) -> None:
        """Monitor the session's audio loop — notify JS if it crashes."""
        if not self._session or not self._session._task:
            return

        try:
            await self._session._task
        except Exception as exc:
            if self._running:
                logger.error("Audio loop crashed: %s", exc)
                self._running = False
                # Attempt graceful stop
                try:
                    await self._stop_session()
                except Exception:
                    logger.exception("Error during crash cleanup")
                self._notify_error(f"Recording stopped unexpectedly: {exc}")
                self._loop.call_soon_threadsafe(self._loop.stop)

    def _on_silence(self, elapsed_seconds: float) -> None:
        """Handle silence detection — push to JS, auto-stop if enabled."""
        if not self._window or not self._running:
            return
        secs = int(elapsed_seconds)
        try:
            self._window.evaluate_js(f"updateSilenceStatus({secs})")
        except Exception:
            pass
        # Warning toast at ~100s
        if 100 <= secs < 102:
            try:
                self._window.evaluate_js("onSilenceWarning()")
            except Exception:
                pass
        # Auto-stop at 120s
        if secs >= 120 and self._silence_auto_stop:
            logger.info("Auto-stopping after %ds silence", secs)
            self._running = False
            asyncio.run_coroutine_threadsafe(self._stop_and_notify(), self._loop)

    def _on_transcript_segment(self, segment: TranscriptSegment) -> None:
        """Handle transcript segments — count and push to JS live preview."""
        if segment.is_partial or not segment.text.strip():
            return
        self._segment_count += 1
        text = segment.text.strip()
        speaker_prefix = ""
        if segment.speaker and segment.speaker != self._last_speaker:
            speaker_prefix = f"[Speaker {segment.speaker}] "
            self._last_speaker = segment.speaker
        if self._window:
            safe = (speaker_prefix + text).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")
            try:
                self._window.evaluate_js(f'appendTranscript("{safe}")')
            except Exception:
                pass

    def _notify_stopped(self) -> None:
        """Tell the JS frontend that recording has stopped."""
        if self._window:
            path_js = self._output_path.replace("\\", "\\\\") if self._output_path else ""
            try:
                self._window.evaluate_js(
                    f'onRecordingStopped("{path_js}")'
                )
            except Exception:
                pass

    def _notify_error(self, message: str) -> None:
        """Tell the JS frontend about an error."""
        if self._window:
            safe = message.replace("\\", "\\\\").replace('"', '\\"')
            try:
                self._window.evaluate_js(f'onRecordingError("{safe}")')
            except Exception:
                pass

    def _push_engine_status(self, message: str) -> None:
        """Push an engine status message to the JS status bar.

        Called from the engine (potentially from a thread pool thread) at key
        transitions: model downloading, model loading, transcribing, etc.
        evaluate_js is thread-safe in pywebview.
        """
        if self._window:
            safe = message.replace("\\", "\\\\").replace('"', '\\"')
            try:
                self._window.evaluate_js(f'updateEngineStatus("{safe}")')
            except Exception:
                pass
