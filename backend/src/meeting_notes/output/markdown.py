"""Real-time markdown file writer for meeting transcripts."""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta
from pathlib import Path

from meeting_notes.engines.base import TranscriptSegment

logger = logging.getLogger(__name__)

# How often to start a new paragraph (seconds)
DEFAULT_PARAGRAPH_INTERVAL_S = 120  # 2 minutes
# How often to insert a timestamp marker (seconds)
DEFAULT_TIMESTAMP_INTERVAL_S = 300  # 5 minutes

# Valid timestamp modes
TIMESTAMP_MODES = ("none", "local_time", "elapsed")


class MarkdownWriter:
    """Incrementally writes meeting transcript to a markdown file.

    Groups sentences into paragraphs (new paragraph every 2 minutes).
    Supports three timestamp modes:
      - "none":       No timestamps in the transcript.
      - "local_time": Wall-clock time markers, e.g. **[14:30:00]**
      - "elapsed":    Time since recording start, e.g. **[00:05:00]**
    """

    def __init__(
        self,
        output_dir: Path,
        engine_name: str = "",
        timestamp_mode: str = "elapsed",
        meeting_type: str = "Meeting Notes",
        paragraph_interval_s: int = DEFAULT_PARAGRAPH_INTERVAL_S,
        timestamp_interval_s: int = DEFAULT_TIMESTAMP_INTERVAL_S,
    ):
        if timestamp_mode not in TIMESTAMP_MODES:
            raise ValueError(
                f"timestamp_mode must be one of {TIMESTAMP_MODES}, got '{timestamp_mode}'"
            )
        self._output_dir = output_dir
        self._engine_name = engine_name
        self._timestamp_mode = timestamp_mode
        self._meeting_type = meeting_type
        self._paragraph_interval_s = paragraph_interval_s
        self._timestamp_interval_s = timestamp_interval_s
        self._file_path: Path | None = None
        self._file = None
        self._start_time: datetime | None = None
        self._segment_count = 0
        self._last_text = ""
        self._last_normalized = ""
        self._last_timestamp_bucket: int = -1
        self._current_paragraph_bucket: int = -1
        self._header_end_pos: int = 0  # Position after the header — never seek before this
        self._paragraph_pos: int = 0
        self._paragraph_texts: list[str] = []

    @property
    def file_path(self) -> Path | None:
        return self._file_path

    def start(self) -> Path:
        """Create the markdown file and write the header."""
        self._start_time = datetime.now()
        filename = self._start_time.strftime("%Y%m%d_%H-%M") + f" - {self._meeting_type}.md"
        self._file_path = self._output_dir / filename

        self._output_dir.mkdir(parents=True, exist_ok=True)
        self._file = open(self._file_path, "w", encoding="utf-8")

        # YAML frontmatter
        self._file.write("---\n")
        self._file.write(f"date: {self._start_time.strftime('%Y-%m-%d')}\n")
        self._file.write(f"start_time: \"{self._start_time.strftime('%H:%M:%S')}\"\n")
        self._file.write("tags: [meeting-notes]\n")
        self._file.write("---\n\n")

        heading = self._start_time.strftime(f"# {self._meeting_type} — %Y-%m-%d %H:%M")
        self._file.write(f"{heading}\n\n")
        self._file.write("## Transcript\n\n")
        self._file.flush()

        # Record position after header — paragraph writes must never seek before this
        self._header_end_pos = self._file.tell()
        self._paragraph_pos = self._header_end_pos

        logger.info("Markdown file created: %s", self._file_path)
        return self._file_path

    @staticmethod
    def _normalize(text: str) -> str:
        """Normalize text for duplicate detection."""
        return re.sub(r"[^a-z0-9\s]", "", text.lower()).strip()

    def _format_timestamp(self, elapsed_s: int) -> str:
        """Format a timestamp marker based on the configured mode.

        Returns a bold markdown line like **[HH:MM:SS]** or empty string.
        """
        if self._timestamp_mode == "none":
            return ""

        if self._timestamp_mode == "local_time":
            assert self._start_time is not None
            wall_time = self._start_time + timedelta(seconds=elapsed_s)
            label = wall_time.strftime("%H:%M:%S")
            return f"**[{label}]**\n\n"

        # elapsed mode
        hours = elapsed_s // 3600
        minutes = (elapsed_s % 3600) // 60
        seconds = elapsed_s % 60
        return f"**[{hours:02d}:{minutes:02d}:{seconds:02d}]**\n\n"

    def _flush_paragraph(self) -> None:
        """Write the current paragraph to file."""
        if not self._paragraph_texts or self._file is None:
            return

        # Safety: never seek before the header
        pos = max(self._paragraph_pos, self._header_end_pos)
        self._file.seek(pos)
        self._file.truncate()
        joined = " ".join(self._paragraph_texts)
        self._file.write(f"{joined}\n\n")
        self._file.flush()

    def write_segment(self, segment: TranscriptSegment) -> None:
        """Append a transcript segment, grouping into paragraphs by time."""
        if self._file is None or self._file.closed:
            return

        text = segment.text.strip()
        if not text:
            return

        # Exact duplicate — skip
        if text == self._last_text:
            return

        # Reformatted duplicate — replace last sentence in paragraph
        normalized = self._normalize(text)
        if normalized and normalized == self._last_normalized:
            if self._paragraph_texts:
                self._paragraph_texts[-1] = text
                self._flush_paragraph()
                self._last_text = text
                self._last_normalized = normalized
                return

        # Prepend speaker label if present
        if segment.speaker:
            text = f"**[Speaker {segment.speaker}]** {text}"

        # Clamp to non-negative (local engine can produce slightly negative
        # timestamps when model load time > audio buffer duration)
        total_seconds = max(0, int(segment.timestamp_start))
        para_bucket = total_seconds // self._paragraph_interval_s

        # Timestamp logic
        ts_bucket = 0
        need_timestamp = False
        if self._timestamp_mode != "none":
            ts_bucket = (
                (total_seconds // self._timestamp_interval_s)
                * self._timestamp_interval_s
            )
            need_timestamp = ts_bucket > self._last_timestamp_bucket

        need_new_paragraph = para_bucket != self._current_paragraph_bucket

        if need_new_paragraph:
            self._flush_paragraph()

            if need_timestamp:
                self._last_timestamp_bucket = ts_bucket
                self._file.write(self._format_timestamp(ts_bucket))

            self._current_paragraph_bucket = para_bucket
            self._paragraph_pos = self._file.tell()
            self._paragraph_texts = [text]
        else:
            if need_timestamp:
                self._flush_paragraph()
                self._last_timestamp_bucket = ts_bucket
                self._file.write(self._format_timestamp(ts_bucket))
                self._paragraph_pos = self._file.tell()
                self._paragraph_texts = [text]
            else:
                self._paragraph_texts.append(text)

        self._flush_paragraph()
        self._segment_count += 1
        self._last_text = text
        self._last_normalized = normalized

    def stop(self) -> None:
        """Finalize: update frontmatter with end_time/duration, close file."""
        if self._file is None or self._file.closed:
            return

        end_time = datetime.now()
        if self._start_time:
            duration = end_time - self._start_time
            duration_str = str(duration).split(".")[0]
        else:
            duration_str = "unknown"

        self._file.flush()
        self._file.close()

        # Update frontmatter with end_time and duration
        if self._file_path and self._file_path.exists():
            content = self._file_path.read_text(encoding="utf-8")
            content = content.replace(
                "tags: [meeting-notes]\n---",
                f"end_time: \"{end_time.strftime('%H:%M:%S')}\"\n"
                f"duration: \"{duration_str}\"\n"
                "tags: [meeting-notes]\n---",
            )
            self._file_path.write_text(content, encoding="utf-8")

        logger.info(
            "Markdown file closed: %s (%d segments, %s)",
            self._file_path,
            self._segment_count,
            duration_str,
        )
