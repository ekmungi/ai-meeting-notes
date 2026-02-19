"""Audio capture — dual stream WASAPI loopback + microphone."""

from __future__ import annotations

import logging
import queue
import threading
import time
from dataclasses import dataclass

import numpy as np
import pyaudiowpatch as pyaudio

from meeting_notes.audio.devices import AudioDevice, find_default_mic, find_loopback_device

logger = logging.getLogger(__name__)

TARGET_SAMPLE_RATE = 16000
CHUNK_DURATION_MS = 100  # 100ms chunks
AUDIO_FORMAT = pyaudio.paInt16

# Number of samples in one 100ms chunk at 16kHz mono
_CHUNK_SAMPLES = TARGET_SAMPLE_RATE * CHUNK_DURATION_MS // 1000  # 1600 samples
_CHUNK_BYTES = _CHUNK_SAMPLES * 2  # 2 bytes per int16 sample


@dataclass
class AudioChunk:
    """A chunk of audio data with metadata."""

    data: bytes  # Raw PCM 16-bit mono 16kHz
    source: str  # "mic", "system", or "mixed"
    timestamp_ms: float  # Time since capture started


def _resample(audio: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    """Simple linear interpolation resampling."""
    if src_rate == dst_rate:
        return audio
    ratio = dst_rate / src_rate
    new_length = int(len(audio) * ratio)
    indices = np.linspace(0, len(audio) - 1, new_length)
    return np.interp(indices, np.arange(len(audio)), audio).astype(np.int16)


def _stereo_to_mono(audio: np.ndarray, channels: int) -> np.ndarray:
    """Convert multi-channel audio to mono by averaging channels."""
    if channels <= 1:
        return audio
    # Reshape to (samples, channels) and average
    reshaped = audio.reshape(-1, channels)
    return reshaped.mean(axis=1).astype(np.int16)


def _put_dropping_oldest(
    q: queue.Queue[AudioChunk], chunk: AudioChunk
) -> None:
    """Put chunk into queue, evicting the oldest item if the queue is full."""
    try:
        q.put_nowait(chunk)
    except queue.Full:
        try:
            q.get_nowait()  # evict oldest
        except queue.Empty:
            pass
        try:
            q.put_nowait(chunk)
        except queue.Full:
            pass


class AudioCapture:
    """Captures audio from both system output (WASAPI loopback) and microphone.

    Audio is resampled to 16kHz mono 16-bit PCM and placed into thread-safe queues.
    The mixed_queue receives properly summed audio from both sources at the real-time
    rate (one chunk per CHUNK_DURATION_MS interval).
    """

    def __init__(
        self,
        mic_device: AudioDevice | None = None,
        system_device: AudioDevice | None = None,
        target_sample_rate: int = TARGET_SAMPLE_RATE,
    ):
        self._pa: pyaudio.PyAudio | None = None
        self._mic_stream: pyaudio.Stream | None = None
        self._system_stream: pyaudio.Stream | None = None
        self._mic_device = mic_device
        self._system_device = system_device
        self._target_rate = target_sample_rate
        self._running = False
        self._start_time: float = 0.0

        # Output queues — consumers read from these
        self.mic_queue: queue.Queue[AudioChunk] = queue.Queue(maxsize=500)
        self.system_queue: queue.Queue[AudioChunk] = queue.Queue(maxsize=500)
        self.mixed_queue: queue.Queue[AudioChunk] = queue.Queue(maxsize=500)

        self._mic_chunks = 0
        self._sys_chunks = 0

        # Mixing buffers — accumulate resampled 16kHz mono bytes from each source
        self._mic_buffer: bytes = b""
        self._sys_buffer: bytes = b""

        # Mix thread state
        self._mix_lock = threading.Lock()
        self._mix_thread: threading.Thread | None = None
        self._start_mono: float = 0.0  # monotonic start time for mix timestamps

    def start(self) -> None:
        """Start capturing audio from both streams."""
        self._pa = pyaudio.PyAudio()
        self._start_time = time.monotonic()
        self._start_mono = self._start_time
        self._running = True

        # Reset buffers on each start
        with self._mix_lock:
            self._mic_buffer = b""
            self._sys_buffer = b""

        # Auto-detect devices if not specified
        if self._mic_device is None:
            self._mic_device = find_default_mic()
        if self._system_device is None:
            self._system_device = find_loopback_device()

        if self._mic_device:
            self._start_mic_stream()
            logger.info("Microphone capture started: %s", self._mic_device.name)
        else:
            logger.warning("No microphone device found — mic capture disabled")

        if self._system_device:
            self._start_system_stream()
            logger.info("System audio capture started: %s", self._system_device.name)
        else:
            logger.warning("No loopback device found — system audio capture disabled")

        # Start the dedicated mix thread
        self._mix_thread = threading.Thread(
            target=self._mix_loop,
            name="audio-mix-thread",
            daemon=True,
        )
        self._mix_thread.start()

    def _start_mic_stream(self) -> None:
        """Open the microphone capture stream."""
        device = self._mic_device
        assert device is not None
        assert self._pa is not None

        # Mic usually supports 16kHz directly
        rate = int(device.default_sample_rate)
        channels = min(device.max_input_channels, 2)  # Use at most stereo
        frames_per_chunk = int(rate * CHUNK_DURATION_MS / 1000)

        def callback(in_data, _frame_count, _time_info, _status):
            if not self._running:
                return (None, pyaudio.paComplete)
            self._process_audio(in_data, "mic", rate, channels)
            return (None, pyaudio.paContinue)

        self._mic_stream = self._pa.open(
            format=AUDIO_FORMAT,
            channels=channels,
            rate=rate,
            input=True,
            input_device_index=device.index,
            frames_per_buffer=frames_per_chunk,
            stream_callback=callback,
        )

    def _start_system_stream(self) -> None:
        """Open the WASAPI loopback capture stream."""
        device = self._system_device
        assert device is not None
        assert self._pa is not None

        # Loopback must use the device's native format
        rate = int(device.default_sample_rate)
        channels = device.max_input_channels
        frames_per_chunk = int(rate * CHUNK_DURATION_MS / 1000)

        def callback(in_data, _frame_count, _time_info, _status):
            if not self._running:
                return (None, pyaudio.paComplete)
            self._process_audio(in_data, "system", rate, channels)
            return (None, pyaudio.paContinue)

        self._system_stream = self._pa.open(
            format=AUDIO_FORMAT,
            channels=channels,
            rate=rate,
            input=True,
            input_device_index=device.index,
            frames_per_buffer=frames_per_chunk,
            stream_callback=callback,
        )

    def _process_audio(
        self, raw_data: bytes, source: str, src_rate: int, src_channels: int
    ) -> None:
        """Convert raw audio to 16kHz mono, enqueue in source queue, and buffer for mixing."""
        audio = np.frombuffer(raw_data, dtype=np.int16)

        # Convert to mono
        audio = _stereo_to_mono(audio, src_channels)

        # Resample to target rate
        audio = _resample(audio, src_rate, self._target_rate)

        timestamp_ms = (time.monotonic() - self._start_time) * 1000
        chunk = AudioChunk(
            data=audio.tobytes(),
            source=source,
            timestamp_ms=timestamp_ms,
        )

        # Track production rate
        if source == "mic":
            self._mic_chunks += 1
        else:
            self._sys_chunks += 1
        total = self._mic_chunks + self._sys_chunks
        if total % 100 == 1:
            logger.debug(
                "Audio capture: mic=%d sys=%d total=%d, mixed_queue=%d/%d",
                self._mic_chunks,
                self._sys_chunks,
                total,
                self.mixed_queue.qsize(),
                self.mixed_queue.maxsize,
            )

        # Put in source-specific queue, evicting oldest on full
        target_q = self.mic_queue if source == "mic" else self.system_queue
        _put_dropping_oldest(target_q, chunk)

        # Accumulate resampled bytes into the appropriate mixing buffer
        with self._mix_lock:
            if source == "mic":
                self._mic_buffer += audio.tobytes()
            else:
                self._sys_buffer += audio.tobytes()

    def _mix_loop(self) -> None:
        """Dedicated thread: fires every CHUNK_DURATION_MS, mixes buffered audio.

        On each tick it drains exactly one chunk worth of bytes from each buffer,
        sums them as int32, clips to int16 range, and enqueues a single mixed
        AudioChunk.  If only one source has data the other is treated as silence.
        If neither source has data the tick is skipped (no empty chunk produced).
        """
        interval = CHUNK_DURATION_MS / 1000.0  # seconds
        next_tick = time.monotonic() + interval

        while self._running:
            # Sleep until the next scheduled tick
            sleep_for = next_tick - time.monotonic()
            if sleep_for > 0:
                time.sleep(sleep_for)
            next_tick += interval

            with self._mix_lock:
                mic_bytes = self._mic_buffer[:_CHUNK_BYTES]
                sys_bytes = self._sys_buffer[:_CHUNK_BYTES]
                self._mic_buffer = self._mic_buffer[_CHUNK_BYTES:]
                self._sys_buffer = self._sys_buffer[_CHUNK_BYTES:]

            # Skip tick if both buffers were empty (no audio active yet)
            if not mic_bytes and not sys_bytes:
                continue

            # Determine the actual sample count for this tick
            # (may be less than _CHUNK_SAMPLES at start/end)
            n_samples = max(
                len(mic_bytes) // 2,
                len(sys_bytes) // 2,
            )

            # Pad shorter buffer with silence (zeros)
            if len(mic_bytes) < n_samples * 2:
                mic_bytes = mic_bytes + b"\x00" * (n_samples * 2 - len(mic_bytes))
            if len(sys_bytes) < n_samples * 2:
                sys_bytes = sys_bytes + b"\x00" * (n_samples * 2 - len(sys_bytes))

            mic_pcm = np.frombuffer(mic_bytes, dtype=np.int16).astype(np.int32)
            sys_pcm = np.frombuffer(sys_bytes, dtype=np.int16).astype(np.int32)

            # Sum and clip to int16 range
            mixed = np.clip(mic_pcm + sys_pcm, -32768, 32767).astype(np.int16)

            timestamp_ms = (time.monotonic() - self._start_mono) * 1000
            mixed_chunk = AudioChunk(
                data=mixed.tobytes(),
                source="mixed",
                timestamp_ms=timestamp_ms,
            )

            _put_dropping_oldest(self.mixed_queue, mixed_chunk)

    def stop(self) -> None:
        """Stop all audio capture streams."""
        self._running = False

        for stream in [self._mic_stream, self._system_stream]:
            if stream is not None:
                try:
                    stream.stop_stream()
                    stream.close()
                except Exception:
                    pass

        # Wait for mix thread to exit
        if self._mix_thread is not None:
            self._mix_thread.join(timeout=2.0)
            self._mix_thread = None

        if self._pa is not None:
            self._pa.terminate()
            self._pa = None

        logger.info("Audio capture stopped")

    @property
    def is_running(self) -> bool:
        return self._running
