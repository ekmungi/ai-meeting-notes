"""Local transcription engine using faster-whisper on CPU."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import TYPE_CHECKING, Callable

import numpy as np

from meeting_notes.engines.base import TranscriptionEngine, TranscriptSegment

if TYPE_CHECKING:
    from faster_whisper import WhisperModel

logger = logging.getLogger(__name__)

# Accumulate audio in fixed-length windows before transcribing.
# 10 s halves the number of inference calls vs 5 s, because Whisper's encoder
# always processes a fixed 30-second mel window internally — the marginal cost
# of 10 s vs 5 s is much less than 2x, while producing half the call overhead.
DEFAULT_CHUNK_SECONDS = 10

# Bound the async transcription queue to 2 slots.
# One slot for the chunk currently being consumed, one for the next ready chunk.
# With 10-second windows this caps audio lag at ~20 seconds.
# Oldest chunks are dropped (not newest) when the queue is full.
_TRANSCRIPTION_QUEUE_MAXSIZE = 2

# Module-level model cache: keeps the loaded WhisperModel alive between
# recordings so the model is only read from disk once per process lifetime.
# Key: "{model_size}:{compute_type}:{cpu_threads}"
_model_cache: dict[str, "WhisperModel"] = {}


class LocalEngine(TranscriptionEngine):
    """Transcription engine using faster-whisper (CTranslate2) on CPU.

    Accumulates incoming audio in fixed-length windows (default 10 s),
    then dispatches them to a dedicated transcription loop via a bounded
    async queue.  The audio ingestion (send_audio) never blocks the
    caller — Whisper inference runs on a single-worker thread pool
    consumed by a background asyncio task.

    The transcription queue uses a drop-oldest policy: if inference cannot
    keep up with real-time audio, the oldest waiting chunk is discarded so
    the transcript always tracks near-current audio rather than lagging
    further behind.

    Models are cached at the module level so that the second+ recording
    with the same model starts without any disk I/O.
    """

    def __init__(
        self,
        sample_rate: int = 16000,
        model_size: str = "small.en",
        compute_type: str = "int8",
        cpu_threads: int = 0,
        beam_size: int = 1,
        chunk_seconds: int = DEFAULT_CHUNK_SECONDS,
        on_status: Callable[[str], None] | None = None,
    ):
        super().__init__()
        self._sample_rate = sample_rate
        self._model_size = model_size
        self._compute_type = compute_type
        # 0 = auto-detect: use half the available logical cores, leaving
        # headroom for audio capture threads, the event loop, and the OS.
        self._cpu_threads = cpu_threads if cpu_threads > 0 else max(1, (os.cpu_count() or 4) // 2)
        self._beam_size = beam_size
        self._chunk_seconds = chunk_seconds
        self._model = None
        self._audio_buffer: bytearray = bytearray()
        self._bytes_per_chunk = sample_rate * 2 * chunk_seconds  # 16-bit mono
        self._session_start: float = 0.0
        self._running = False
        self._segments_emitted = 0
        self._chunks_dropped = 0
        self._on_status = on_status
        self._transcription_queue: asyncio.Queue[bytes] = asyncio.Queue(
            maxsize=_TRANSCRIPTION_QUEUE_MAXSIZE
        )
        self._transcription_task: asyncio.Task | None = None
        self._executor = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="whisper",
        )

    @property
    def name(self) -> str:
        return f"Local (faster-whisper {self._model_size})"

    def _report_status(self, message: str) -> None:
        """Push a status message to the UI via the registered callback.

        Safe to call from any thread. Errors are swallowed so status
        reporting never disrupts the transcription pipeline.
        """
        logger.info("Engine status: %s", message)
        if self._on_status:
            try:
                self._on_status(message)
            except Exception:
                pass

    def _model_needs_download(self) -> bool:
        """Return True if the model files are not yet in the local HuggingFace cache.

        Uses a directory-existence check on the standard HF hub cache path.
        Returns False (assume present) if the cache location cannot be determined,
        so users never see a false "downloading" status.
        """
        try:
            hf_home = (
                os.environ.get("HF_HOME")
                or os.environ.get("HUGGINGFACE_HUB_CACHE")
                or str(Path.home() / ".cache" / "huggingface")
            )
            hub_cache = Path(hf_home) / "hub"
            # faster-whisper stores models as Systran/faster-whisper-{model_size}
            model_dir = f"models--Systran--faster-whisper-{self._model_size}"
            return not (hub_cache / model_dir).exists()
        except Exception:
            return False

    async def start(self) -> None:
        """Load the Whisper model and start the transcription loop."""
        self._session_start = time.monotonic()
        self._running = True
        self._segments_emitted = 0
        self._chunks_dropped = 0

        # Load model in executor to avoid blocking event loop
        loop = asyncio.get_running_loop()
        logger.info(
            "Loading faster-whisper model: %s (%s, %d threads)...",
            self._model_size,
            self._compute_type,
            self._cpu_threads,
        )
        self._model = await loop.run_in_executor(None, self._load_model)
        logger.info("Model loaded successfully")

        # Start the background transcription consumer
        self._transcription_task = asyncio.create_task(self._transcription_loop())

    def _load_model(self):
        """Return a WhisperModel, loading from disk only on first use.

        Subsequent calls with the same parameters return the cached instance,
        so recordings 2+ start almost instantly.
        """
        from faster_whisper import WhisperModel

        key = f"{self._model_size}:{self._compute_type}:{self._cpu_threads}"
        if key in _model_cache:
            self._report_status(f"Model '{self._model_size}' ready (cached in memory)")
            return _model_cache[key]

        # Determine if we need to download or just load from disk
        if self._model_needs_download():
            self._report_status(
                f"Downloading model '{self._model_size}'... "
                f"(first-time setup, may take several minutes)"
            )
        else:
            self._report_status(f"Loading model '{self._model_size}' from disk...")

        logger.info(
            "Loading faster-whisper model into cache: %s (%s, %d threads)",
            self._model_size,
            self._compute_type,
            self._cpu_threads,
        )
        # local_files_only=True when the model is already on disk prevents
        # huggingface_hub from making a network round-trip to validate the
        # model revision — this can add minutes to load time on slow connections.
        on_disk = not self._model_needs_download()
        _model_cache[key] = WhisperModel(
            self._model_size,
            device="cpu",
            compute_type=self._compute_type,
            cpu_threads=self._cpu_threads,
            local_files_only=on_disk,
        )
        self._report_status("Model loaded — recording started")
        return _model_cache[key]

    async def send_audio(self, chunk: bytes) -> None:
        """Buffer audio and enqueue full windows for transcription.

        This method never blocks the caller.  When enough audio has
        accumulated it snapshots the buffer and puts it on the bounded
        transcription queue.

        Drop-oldest policy: if the queue is full (CPU inference is behind
        real-time), the oldest waiting chunk is discarded so transcription
        always tracks near-current audio.
        """
        if not self._running or self._model is None:
            return

        self._audio_buffer.extend(chunk)

        if len(self._audio_buffer) >= self._bytes_per_chunk:
            audio_bytes = bytes(self._audio_buffer)
            self._audio_buffer.clear()

            try:
                self._transcription_queue.put_nowait(audio_bytes)
            except asyncio.QueueFull:
                # Drop the oldest waiting chunk to make room for fresher audio
                try:
                    dropped = self._transcription_queue.get_nowait()
                    dropped_duration = len(dropped) / (self._sample_rate * 2)
                    self._chunks_dropped += 1
                    logger.info(
                        "Transcription queue full — dropped %.1fs stale chunk "
                        "(CPU behind real-time, drop #%d)",
                        dropped_duration,
                        self._chunks_dropped,
                    )
                except asyncio.QueueEmpty:
                    pass
                try:
                    self._transcription_queue.put_nowait(audio_bytes)
                except asyncio.QueueFull:
                    pass  # Defensive: should not happen after the get above

    async def flush(self) -> None:
        """Flush the current audio buffer for immediate transcription.

        Called on pause so the last spoken words are captured before
        audio capture stops.
        """
        if not self._audio_buffer or not self._running:
            return
        audio_bytes = bytes(self._audio_buffer)
        self._audio_buffer.clear()
        # Require at least 0.5 s of audio to be worth transcribing
        if len(audio_bytes) < self._sample_rate:
            return
        try:
            self._transcription_queue.put_nowait(audio_bytes)
        except asyncio.QueueFull:
            try:
                self._transcription_queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                self._transcription_queue.put_nowait(audio_bytes)
            except asyncio.QueueFull:
                pass

    async def stop(self) -> None:
        """Stop the engine immediately.

        Any in-progress Whisper inference running in the thread executor CANNOT
        be interrupted (the OS thread cannot be killed mid-inference). We cancel
        the asyncio task, abandon the thread, and return immediately.

        Design rationale: waiting for inference on stop caused indefinite UI
        hangs on Python 3.12 because asyncio.wait_for + run_in_executor
        interactions meant the cancellation timeout was not reliably honoured.
        The user pressed Stop — responsiveness takes priority over capturing
        the final partial audio fragment.
        """
        self._running = False

        # Drain all queued chunks — nothing more will be processed.
        while not self._transcription_queue.empty():
            try:
                self._transcription_queue.get_nowait()
            except asyncio.QueueEmpty:
                break

        # Discard the in-progress audio buffer — the final partial window is
        # intentionally dropped on stop to avoid waiting for inference.
        self._audio_buffer.clear()

        # Cancel the transcription task. If the executor thread (Whisper) is
        # mid-inference, the asyncio task is cancelled immediately but the OS
        # thread continues until inference completes naturally in background.
        if self._transcription_task and not self._transcription_task.done():
            self._transcription_task.cancel()

        # Shut down the executor without waiting for running threads.
        self._executor.shutdown(wait=False)

        if self._chunks_dropped:
            logger.info(
                "Session: %d audio chunks dropped (CPU was slower than real-time)",
                self._chunks_dropped,
            )
        logger.info(
            "Local engine stopped (%d segments transcribed)",
            self._segments_emitted,
        )

    async def _transcription_loop(self) -> None:
        """Background consumer: pulls audio windows and transcribes serially."""
        while self._running or not self._transcription_queue.empty():
            try:
                audio_bytes = await asyncio.wait_for(
                    self._transcription_queue.get(), timeout=1.0,
                )
            except asyncio.TimeoutError:
                continue
            try:
                await self._transcribe_segment(audio_bytes)
            except Exception:
                logger.exception("Error transcribing audio segment; continuing")

    async def _transcribe_segment(self, audio_bytes: bytes) -> None:
        """Run Whisper transcription on an audio chunk."""
        if self._model is None:
            return

        duration_s = len(audio_bytes) / (self._sample_rate * 2)
        if duration_s < 0.5:
            logger.debug("Skipping very short segment (%.1fs)", duration_s)
            return

        elapsed = time.monotonic() - self._session_start
        logger.info("Transcribing %.1fs audio chunk (elapsed %.1fs)...", duration_s, elapsed)
        self._report_status(f"Transcribing {duration_s:.0f}s of audio...")

        # Emit a processing indicator so the UI never appears frozen during
        # long CPU inference. Partials are displayed but not written to markdown.
        self._emit(TranscriptSegment(
            text="[Transcribing...]",
            timestamp_start=max(0.0, elapsed - duration_s),
            timestamp_end=elapsed,
            is_partial=True,
        ))

        loop = asyncio.get_running_loop()
        t0 = time.monotonic()
        text = await loop.run_in_executor(
            self._executor,
            lambda: self._run_whisper(audio_bytes),
        )
        inference_ms = (time.monotonic() - t0) * 1000
        logger.info(
            "Inference took %.0fms for %.1fs audio (%.1fx real-time)",
            inference_ms,
            duration_s,
            inference_ms / 1000 / duration_s,
        )

        if not text.strip():
            logger.info("Whisper returned no text for %.1fs chunk (silence or artifact)", duration_s)
            return

        self._segments_emitted += 1
        logger.info("Segment #%d: %r", self._segments_emitted, text.strip()[:80])
        self._emit(TranscriptSegment(
            text=text.strip(),
            timestamp_start=max(0.0, elapsed - duration_s),
            timestamp_end=elapsed,
            is_partial=False,
        ))

    def _run_whisper(self, audio_bytes: bytes) -> str:
        """Run faster-whisper inference (blocking, run in executor)."""
        assert self._model is not None

        # Convert bytes to float32 numpy array.
        # In-place multiply avoids an intermediate array allocation.
        audio_float = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32, copy=False)
        audio_float *= 1.0 / 32768.0

        segments, _info = self._model.transcribe(
            audio_float,
            beam_size=self._beam_size,
            language="en",
            # VAD disabled: Silero threshold=0.3 rejects WASAPI mixed audio.
            # Whisper's own blank-audio suppression handles true silence.
            vad_filter=False,
            # Do not condition on previous chunk's text — faster per-chunk
            # inference and avoids hallucination from prior output.
            condition_on_previous_text=False,
        )

        # Concatenate segments, skipping Whisper silence/noise artifacts
        parts = []
        for seg in segments:
            text = seg.text.strip()
            # Filter artifacts like [BLANK_AUDIO], (Music), etc.
            if text and not (text.startswith("[") and text.endswith("]")):
                parts.append(text)

        result = " ".join(parts)
        if not result:
            audio_duration_s = len(audio_bytes) / (self._sample_rate * 2)
            logger.info(
                "Whisper returned no usable text for %.1fs window (all silence or filtered artifacts)",
                audio_duration_s,
            )
        return result
