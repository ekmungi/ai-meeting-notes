"""AssemblyAI streaming transcription engine."""

from __future__ import annotations

import logging
import queue
import re
import threading
import time

from meeting_notes.engines.base import TranscriptionEngine, TranscriptSegment

logger = logging.getLogger(__name__)

# AssemblyAI endpointing presets.
# Conservative settings reduce sentence fragmentation at natural pauses.
ENDPOINTING_PRESETS = {
    "aggressive": {
        "end_of_turn_confidence_threshold": 0.3,
        "min_end_of_turn_silence_when_confident": 160,
        "max_turn_silence": 800,
    },
    "balanced": {
        "end_of_turn_confidence_threshold": 0.4,
        "min_end_of_turn_silence_when_confident": 400,
        "max_turn_silence": 1280,
    },
    "conservative": {
        "end_of_turn_confidence_threshold": 0.5,
        "min_end_of_turn_silence_when_confident": 560,
        "max_turn_silence": 2000,
    },
    "very_conservative": {
        "end_of_turn_confidence_threshold": 0.7,
        "min_end_of_turn_silence_when_confident": 700,
        "max_turn_silence": 3000,
    },
}

# How long (seconds) of continuous speech with no end_of_turn before we call
# force_endpoint() to request a clean finalization from AssemblyAI.
# 20s is short enough to keep the file up to date during long monologues,
# but long enough that normal sentence-by-sentence speech never triggers it.
DEFAULT_FORCE_ENDPOINT_INTERVAL = 20.0


class CloudEngine(TranscriptionEngine):
    """Transcription engine using AssemblyAI's Universal-Streaming v3 API.

    Streams audio over WebSocket and receives immutable transcript turns.

    Turn handling:
    - Partial events (end_of_turn=False): emitted as is_partial=True for live
      preview only. Never written to the transcript file.
    - Final events (end_of_turn=True): emitted as is_partial=False. Written
      to the transcript file via the session callback.

    If speech is continuous for longer than force_endpoint_interval (default
    20s) with no natural end_of_turn, the engine calls client.force_endpoint()
    to ask AssemblyAI to finalize the current turn immediately. AssemblyAI
    responds with a proper end_of_turn=True containing clean, formatted text.
    This is also called on stop() and flush() (pause) for a graceful finish.
    """

    def __init__(
        self,
        api_key: str,
        sample_rate: int = 16000,
        endpointing: str = "conservative",
        force_endpoint_interval: float = DEFAULT_FORCE_ENDPOINT_INTERVAL,
        speaker_labels: bool = False,
    ):
        super().__init__()
        self._api_key = api_key
        self._sample_rate = sample_rate
        self._endpointing = endpointing
        self._force_endpoint_interval = force_endpoint_interval
        self._audio_queue: queue.Queue[bytes | None] = queue.Queue()
        self._thread: threading.Thread | None = None
        self._client = None  # Set in _run_streaming; used by stop() / flush()
        self._session_start: float = 0.0
        self._running = False
        self._chunks_queued = 0
        self._chunks_sent = 0
        # Tracks when the last end_of_turn (natural or forced) was received,
        # to decide when to call force_endpoint().
        self._last_turn_end_time: float = 0.0
        # Fragment buffer: accumulates short incomplete segments so they are
        # merged with the next substantive segment rather than written alone.
        self._fragment_buffer: list[str] = []
        self._fragment_timestamp: float = 0.0
        self._speaker_labels = speaker_labels

    @property
    def name(self) -> str:
        return "AssemblyAI Cloud"

    async def start(self) -> None:
        """Start the streaming connection in a background thread."""
        self._session_start = time.monotonic()
        self._last_turn_end_time = self._session_start
        self._running = True

        self._thread = threading.Thread(target=self._run_streaming, daemon=True)
        self._thread.start()
        logger.info(
            "Cloud engine started (AssemblyAI streaming, endpointing=%s)",
            self._endpointing,
        )

    async def send_audio(self, chunk: bytes) -> None:
        """Queue audio chunk for sending to AssemblyAI."""
        if self._running:
            self._audio_queue.put(chunk)
            self._chunks_queued += 1
            if self._chunks_queued % 50 == 1:
                logger.debug(
                    "Audio queued: chunk #%d (%d bytes, queue_size=%d)",
                    self._chunks_queued,
                    len(chunk),
                    self._audio_queue.qsize(),
                )

    async def stop(self) -> None:
        """Stop the streaming session gracefully.

        Calls force_endpoint() before disconnecting so AssemblyAI finalizes
        any in-progress turn with clean formatted text before shutdown.
        """
        # Request a clean final from AssemblyAI before tearing down.
        # force_endpoint() puts a ForceEndpoint message in the write queue;
        # AssemblyAI processes it and sends end_of_turn=True before the
        # subsequent disconnect(terminate=True) terminates the session.
        if self._client is not None:
            try:
                self._client.force_endpoint()
            except Exception:
                logger.debug("force_endpoint() on stop failed (session may already be closing)")

        self._running = False
        self._audio_queue.put(None)  # sentinel to stop the audio generator

        if self._thread is not None:
            self._thread.join(timeout=10)
            self._thread = None

        self._client = None

        # Flush any short fragments that accumulated since the last end_of_turn.
        self._flush_fragment_buffer()

        logger.info("Cloud engine stopped")

    async def flush(self) -> None:
        """Request a clean end_of_turn from AssemblyAI immediately.

        Called on pause so the last spoken words are committed with proper
        AssemblyAI formatting rather than waiting for the silence timeout.
        Also flushes any buffered sentence fragments.
        """
        if self._client is not None and self._running:
            try:
                self._client.force_endpoint()
            except Exception:
                logger.debug("force_endpoint() on flush failed")

        self._flush_fragment_buffer()

    def _is_fragment(self, text: str) -> bool:
        """Return True if text is a short fragment that should be merged.

        Buffers single words and two-word phrases so they are joined with
        the next substantive segment instead of appearing alone.
        """
        words = re.sub(r"[^\w\s]", "", text).split()
        word_count = len(words)

        if word_count <= 1:
            return True

        if word_count == 2:
            complete_two_word = {
                "thank you", "thanks everyone", "sounds good", "i agree",
                "me too", "okay thanks", "not yet", "got it", "of course",
            }
            if text.lower().strip().rstrip(".!?,") in complete_two_word:
                return False
            return True

        if word_count == 3:
            fragment_starters = {"and", "but", "or", "where", "that", "which", "who"}
            if words[0].lower() in fragment_starters:
                return True

        return False

    def _flush_fragment_buffer(self) -> None:
        """Emit any buffered fragments as a single final segment."""
        if not self._fragment_buffer:
            return

        merged = " ".join(self._fragment_buffer)
        self._fragment_buffer.clear()

        self._emit(TranscriptSegment(
            text=merged,
            timestamp_start=self._fragment_timestamp,
            timestamp_end=time.monotonic() - self._session_start,
            is_partial=False,
        ))

    def _handle_final_segment(self, text: str, elapsed: float, speaker: str | None = None) -> None:
        """Process a final (non-partial) segment, merging short fragments."""
        if self._is_fragment(text):
            if not self._fragment_buffer:
                self._fragment_timestamp = elapsed
            self._fragment_buffer.append(text.rstrip(".!?,"))
            logger.debug("Buffered fragment: %r (buffer: %d)", text, len(self._fragment_buffer))
            return

        if self._fragment_buffer:
            prefix = " ".join(self._fragment_buffer)
            if text and text[0].isupper() and not text[0:2].isupper():
                text = text[0].lower() + text[1:]
            merged = f"{prefix} {text}"
            self._fragment_buffer.clear()
            self._emit(TranscriptSegment(
                text=merged,
                timestamp_start=self._fragment_timestamp,
                timestamp_end=elapsed,
                is_partial=False,
                speaker=speaker,
            ))
        else:
            self._emit(TranscriptSegment(
                text=text,
                timestamp_start=elapsed,
                timestamp_end=elapsed,
                is_partial=False,
                speaker=speaker,
            ))

    def _audio_generator(self):
        """Yield audio chunks from the queue until the sentinel (None) arrives."""
        while self._running:
            try:
                chunk = self._audio_queue.get(timeout=0.5)
                if chunk is None:
                    logger.debug(
                        "Audio generator: sentinel received after %d chunks",
                        self._chunks_sent,
                    )
                    break
                self._chunks_sent += 1
                yield chunk
            except queue.Empty:
                continue
        logger.info(
            "Audio generator finished: %d queued, %d sent to AssemblyAI",
            self._chunks_queued,
            self._chunks_sent,
        )

    def _run_streaming(self) -> None:
        """Run the AssemblyAI streaming client (blocking, runs in background thread)."""
        try:
            from assemblyai.streaming.v3 import (
                BeginEvent,
                StreamingClient,
                StreamingClientOptions,
                StreamingError,
                StreamingEvents,
                StreamingParameters,
                TerminationEvent,
                TurnEvent,
            )

            client = StreamingClient(
                StreamingClientOptions(
                    api_key=self._api_key,
                    api_host="streaming.assemblyai.com",
                )
            )
            # Expose to stop() / flush() so they can call force_endpoint().
            self._client = client

            def on_begin(_client, event: BeginEvent):
                logger.info("AssemblyAI session started: %s", event.id)

            def on_turn(_client, event: TurnEvent):
                try:
                    elapsed = time.monotonic() - self._session_start
                    text = event.transcript.strip()

                    logger.debug(
                        "Turn event: end_of_turn=%s words=%d text=%r",
                        event.end_of_turn,
                        len(event.words),
                        text[:80] if text else "(empty)",
                    )

                    if not text:
                        return

                    if event.turn_is_formatted and event.end_of_turn:
                        # --- Clean formatted final (the ONLY event written to file) ---
                        # AssemblyAI sends two end_of_turn=True events per turn when
                        # format_turns=True:
                        #   1. turn_is_formatted=False  — raw text, immediate
                        #   2. turn_is_formatted=True   — formatted text, after NLP
                        # We only act on (2). Everything else is live preview only.
                        self._last_turn_end_time = time.monotonic()
                        # Extract speaker label if diarization is enabled
                        speaker = getattr(event, "speaker", None)
                        self._handle_final_segment(text, elapsed, speaker=speaker)

                    else:
                        # --- Live preview (partial OR unformatted end-of-turn) ---
                        # Emitted as is_partial=True so it is NEVER written to file.
                        self._emit(TranscriptSegment(
                            text=text,
                            timestamp_start=elapsed,
                            timestamp_end=elapsed,
                            is_partial=True,
                        ))

                        # Only check the force_endpoint timer on genuine partials
                        # (not on the unformatted end-of-turn event, which already
                        # signals that AssemblyAI has closed the turn).
                        if not event.end_of_turn:
                            time_since = time.monotonic() - self._last_turn_end_time
                            if time_since >= self._force_endpoint_interval:
                                self._last_turn_end_time = time.monotonic()
                                logger.info(
                                    "Calling force_endpoint() after %.0fs of continuous speech",
                                    time_since,
                                )
                                client.force_endpoint()

                except Exception:
                    logger.exception("Error in on_turn callback")

            def on_terminated(_client, event: TerminationEvent):
                logger.info(
                    "AssemblyAI session ended: audio=%.1fs, session=%.1fs",
                    event.audio_duration_seconds or 0,
                    event.session_duration_seconds or 0,
                )

            def on_error(_client, error: StreamingError):
                logger.error(
                    "AssemblyAI error: %s (code=%s)",
                    error,
                    getattr(error, "code", None),
                )

            client.on(StreamingEvents.Begin, on_begin)
            client.on(StreamingEvents.Turn, on_turn)
            client.on(StreamingEvents.Termination, on_terminated)
            client.on(StreamingEvents.Error, on_error)

            preset = ENDPOINTING_PRESETS.get(self._endpointing, ENDPOINTING_PRESETS["conservative"])
            logger.info("Using endpointing preset: %s → %s", self._endpointing, preset)

            # Build streaming params, optionally enabling speaker diarization.
            # The SDK's StreamingParameters does not yet have a speaker_labels
            # field, so we subclass it to inject the query parameter.
            if self._speaker_labels:
                class _SpeakerParams(StreamingParameters):
                    """Extends StreamingParameters with speaker_labels support."""
                    speaker_labels: bool | None = None

                params = _SpeakerParams(
                    sample_rate=self._sample_rate,
                    format_turns=True,
                    speaker_labels=True,
                    **preset,
                )
            else:
                params = StreamingParameters(
                    sample_rate=self._sample_rate,
                    format_turns=True,
                    **preset,
                )

            client.connect(params)

            try:
                client.stream(self._audio_generator())
            finally:
                client.disconnect(terminate=True)

        except Exception:
            logger.exception("Cloud engine streaming failed")
            self._running = False
