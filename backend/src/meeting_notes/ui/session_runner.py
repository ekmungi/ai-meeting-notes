"""Background session runner — bridges pywebview thread pool to asyncio MeetingSession."""

from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any

from meeting_notes.config import Config
from meeting_notes.session import MeetingSession

logger = logging.getLogger(__name__)

# How often to push status updates to the JS frontend (seconds)
_UPDATE_INTERVAL_S = 2.0


class SessionRunner:
    """Manages a MeetingSession on a background asyncio thread.

    pywebview calls js_api methods on its thread pool. This class bridges
    those calls to a dedicated asyncio event loop running on a daemon thread.
    Status updates are pushed to the JS frontend via window.evaluate_js().
    """

    def __init__(self, config: Config, window: Any) -> None:
        self._config = config
        self._window = window
        self._session: MeetingSession | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._running = False
        self._output_path: str | None = None
        self._segment_count = 0

    @property
    def is_running(self) -> bool:
        return self._running

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

        # Monkey-patch the session's transcript callback to track segment count
        original_cb = self._session._on_transcript

        def counting_cb(segment):
            original_cb(segment)
            if not segment.is_partial and segment.text.strip():
                self._segment_count += 1

        self._session._on_transcript = counting_cb

        output_path = await self._session.start()
        self._output_path = str(output_path) if output_path else None

        # Notify JS of the output file path immediately so the user knows
        # where transcription is being written while recording is in progress.
        if output_path and self._window:
            path_js = str(output_path).replace("\\", "\\\\")
            try:
                self._window.evaluate_js(f'onRecordingFileReady("{path_js}")')
            except Exception:
                pass

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
        self._notify_stopped()
        if self._loop and self._loop.is_running():
            self._loop.call_soon_threadsafe(self._loop.stop)

    async def _status_loop(self) -> None:
        """Periodically push segment count to JS."""
        while self._running:
            await asyncio.sleep(_UPDATE_INTERVAL_S)
            if self._window and self._running:
                try:
                    self._window.evaluate_js(
                        f"updateSessionStatus({self._segment_count})"
                    )
                except Exception:
                    pass  # Window may be closed

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
