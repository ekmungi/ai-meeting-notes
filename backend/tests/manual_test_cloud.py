"""Manual test: Stream a known audio file to AssemblyAI and compare transcript output.

This test downloads the famous JFK speech sample (public domain, ~11 seconds),
streams it to AssemblyAI cloud engine, and writes the transcript to a markdown file.

EXPECTED TRANSCRIPT (from JFK's 1961 Inaugural Address):
    "And so my fellow Americans, ask not what your country can do for you,
     ask what you can do for your country."

USAGE:
    cd backend
    python tests/manual_test_cloud.py

    Then open the output file and compare against the expected transcript above.

WHAT TO CHECK:
    1. Only final sentences appear (no word-by-word partials)
    2. Proper capitalization and punctuation
    3. Reasonable accuracy (should be very close to the expected text)
    4. Timestamps are present
    5. Frontmatter and footer metadata are correct
"""

from __future__ import annotations

import asyncio
import logging
import sys
import urllib.request
import wave
from pathlib import Path

# Add src to path so we can import meeting_notes
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from meeting_notes.config import Config
from meeting_notes.engines.base import TranscriptSegment
from meeting_notes.engines.cloud import CloudEngine
from meeting_notes.output.markdown import MarkdownWriter

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("manual_test")

# --- Configuration ---
JFK_WAV_URL = "https://github.com/ggerganov/whisper.cpp/raw/master/samples/jfk.wav"
EXPECTED_TRANSCRIPT = (
    "And so my fellow Americans, ask not what your country can do for you, "
    "ask what you can do for your country."
)
OUTPUT_DIR = Path(__file__).parent.parent / "test_output"
CACHE_DIR = Path(__file__).parent / "fixtures"


def download_jfk_sample() -> Path:
    """Download the JFK WAV sample if not already cached."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached_path = CACHE_DIR / "jfk.wav"

    if cached_path.exists():
        logger.info("Using cached JFK sample: %s", cached_path)
        return cached_path

    logger.info("Downloading JFK sample from %s ...", JFK_WAV_URL)
    urllib.request.urlretrieve(JFK_WAV_URL, cached_path)
    logger.info("Downloaded to %s", cached_path)
    return cached_path


def read_wav_chunks(wav_path: Path, chunk_duration_ms: int = 100) -> list[bytes]:
    """Read a WAV file and split into PCM chunks.

    Returns a list of raw PCM byte chunks (16-bit, mono, at the file's sample rate).
    Also returns the sample rate.
    """
    with wave.open(str(wav_path), "rb") as wf:
        sample_rate = wf.getframerate()
        channels = wf.getnchannels()
        sample_width = wf.getsampwidth()
        n_frames = wf.getnframes()

        logger.info(
            "WAV file: %d Hz, %d channels, %d-bit, %.1f seconds",
            sample_rate,
            channels,
            sample_width * 8,
            n_frames / sample_rate,
        )

        # Read all audio data
        raw_data = wf.readframes(n_frames)

    # Convert to mono if stereo
    if channels == 2:
        import numpy as np

        audio = np.frombuffer(raw_data, dtype=np.int16)
        audio = audio.reshape(-1, 2).mean(axis=1).astype(np.int16)
        raw_data = audio.tobytes()

    # Resample to 16kHz if needed
    if sample_rate != 16000:
        import numpy as np

        audio = np.frombuffer(raw_data, dtype=np.int16)
        ratio = 16000 / sample_rate
        new_length = int(len(audio) * ratio)
        indices = np.linspace(0, len(audio) - 1, new_length)
        audio = np.interp(indices, np.arange(len(audio)), audio).astype(np.int16)
        raw_data = audio.tobytes()
        sample_rate = 16000

    # Split into chunks
    frames_per_chunk = int(sample_rate * chunk_duration_ms / 1000)
    bytes_per_chunk = frames_per_chunk * 2  # 16-bit = 2 bytes per sample

    chunks = []
    for i in range(0, len(raw_data), bytes_per_chunk):
        chunk = raw_data[i : i + bytes_per_chunk]
        if len(chunk) == bytes_per_chunk:  # Only full chunks
            chunks.append(chunk)

    logger.info("Split into %d chunks of %d ms each", len(chunks), chunk_duration_ms)
    return chunks


async def run_test():
    """Run the full test: download sample → stream to cloud → compare output."""
    # Load config (needs .env with ASSEMBLYAI_API_KEY)
    config = Config.load()
    if not config.assemblyai_api_key:
        print("ERROR: ASSEMBLYAI_API_KEY not set in .env file")
        print("Create a .env file in the project root with:")
        print("  ASSEMBLYAI_API_KEY=your_key_here")
        sys.exit(1)

    # Download test audio
    wav_path = download_jfk_sample()
    chunks = read_wav_chunks(wav_path, chunk_duration_ms=100)

    # Set up markdown writer
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    writer = MarkdownWriter(output_dir=OUTPUT_DIR, engine_name="AssemblyAI Cloud (test)")
    output_path = writer.start()

    # Set up cloud engine with conservative endpointing to reduce sentence fragmentation
    engine = CloudEngine(
        api_key=config.assemblyai_api_key,
        sample_rate=16000,
        endpointing="conservative",
    )

    final_segments: list[TranscriptSegment] = []
    partial_count = 0

    def on_transcript(segment: TranscriptSegment):
        nonlocal partial_count
        if segment.is_partial:
            partial_count += 1
            print(f"  [partial] {segment.text}", end="\r", flush=True)
        else:
            print(f"  [FINAL]   {segment.text}                              ")
            final_segments.append(segment)
            writer.write_segment(segment)

    engine.on_transcript(on_transcript)

    # Start engine and stream audio
    print("\n" + "=" * 70)
    print("MANUAL TEST: Cloud Engine with JFK Speech Sample")
    print("=" * 70)
    print("\nExpected transcript:")
    print(f'  "{EXPECTED_TRANSCRIPT}"')
    print(f"\nStreaming {len(chunks)} audio chunks to AssemblyAI...")
    print("-" * 70)

    await engine.start()

    # Stream chunks at real-time pace (100ms per chunk)
    for chunk in chunks:
        await engine.send_audio(chunk)
        await asyncio.sleep(0.1)  # Simulate real-time pace

    # Wait a few seconds for final transcripts to arrive
    print("\nWaiting for final transcripts...")
    await asyncio.sleep(5)

    await engine.stop()
    writer.stop()

    # Print results
    print("\n" + "=" * 70)
    print("RESULTS")
    print("=" * 70)

    full_transcript = " ".join(seg.text for seg in final_segments)
    print(f"\nPartial updates received: {partial_count}")
    print(f"Final segments received:  {len(final_segments)}")
    print("\nFull transcript:")
    print(f'  "{full_transcript}"')
    print("\nExpected:")
    print(f'  "{EXPECTED_TRANSCRIPT}"')
    print(f"\nOutput file: {output_path}")

    # Basic accuracy check
    transcript_lower = full_transcript.lower()

    key_phrases = ["fellow americans", "ask not", "your country", "do for you"]
    matched = sum(1 for phrase in key_phrases if phrase in transcript_lower)
    print(f"\nKey phrase match: {matched}/{len(key_phrases)}")

    if matched >= 3:
        print("PASS: Transcript captures the core content")
    else:
        print("WARN: Transcript may have accuracy issues")

    print("\nVerification checklist:")
    has_finals = len(final_segments) > 0
    has_partials = partial_count > 0
    partials_gt_finals = partial_count > len(final_segments)
    print(f"  [{'x' if has_finals else ' '}] Final segments received (not just partials)")
    print(f"  [{'x' if has_partials else ' '}] Partial updates were generated")
    print(f"  [{'x' if partials_gt_finals else ' '}] More partials than finals (filtering works)")
    print(f"  [{'x' if output_path.exists() else ' '}] Output markdown file exists")
    print(f"  [{'x' if matched >= 3 else ' '}] Key phrases detected in transcript")

    # Check the markdown file content
    md_content = output_path.read_text(encoding="utf-8")
    has_frontmatter = md_content.startswith("---")
    has_timestamps = any(line.strip().startswith("[") for line in md_content.split("\n"))
    has_duration = "*Duration:" in md_content

    print(f"  [{'x' if has_frontmatter else ' '}] Markdown has YAML frontmatter")
    print(f"  [{'x' if has_timestamps else ' '}] Transcript lines have timestamps")
    print(f"  [{'x' if has_duration else ' '}] Footer has duration metadata")

    print(f"\n{'=' * 70}")
    print(f"Open {output_path} to inspect the full markdown output.")
    print(f"{'=' * 70}\n")


if __name__ == "__main__":
    asyncio.run(run_test())
