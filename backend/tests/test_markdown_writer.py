"""Tests for the markdown writer."""

from __future__ import annotations

from pathlib import Path

import pytest

from meeting_notes.engines.base import TranscriptSegment
from meeting_notes.output.markdown import MarkdownWriter


# ---------------------------------------------------------------------------
# File creation and metadata
# ---------------------------------------------------------------------------


def test_writer_creates_file(tmp_output_dir: Path):
    """Writer should create a markdown file with frontmatter."""
    writer = MarkdownWriter(output_dir=tmp_output_dir, engine_name="test")
    path = writer.start()

    assert path.exists()
    assert path.suffix == ".md"

    content = path.read_text(encoding="utf-8")
    assert "---" in content
    assert "start_time:" in content
    assert "tags: [meeting-notes]" in content
    assert "## Transcript" in content
    # engine and timestamp_mode should NOT be in frontmatter
    assert "engine:" not in content
    assert "timestamp_mode:" not in content

    writer.stop()


def test_writer_stop_writes_metadata(tmp_output_dir: Path):
    """Writer should add end_time and duration to YAML frontmatter on stop."""
    writer = MarkdownWriter(output_dir=tmp_output_dir, engine_name="test")
    writer.start()

    writer.write_segment(
        TranscriptSegment(text="Test", timestamp_start=0.0, timestamp_end=1.0)
    )
    writer.stop()

    content = writer.file_path.read_text(encoding="utf-8")
    assert "end_time:" in content
    assert "duration:" in content
    # Footer text should NOT be present
    assert "*Duration:" not in content
    assert "*Segments:" not in content
    assert "*Recording ended" not in content


def test_writer_invalid_timestamp_mode():
    """Should raise ValueError for invalid timestamp mode."""
    with pytest.raises(ValueError, match="timestamp_mode"):
        MarkdownWriter(output_dir=Path("."), timestamp_mode="bad")


# ---------------------------------------------------------------------------
# Paragraph grouping
# ---------------------------------------------------------------------------


def test_writer_groups_segments_into_paragraphs(tmp_output_dir: Path):
    """Segments within the same 2-minute window should be joined."""
    writer = MarkdownWriter(output_dir=tmp_output_dir, engine_name="test")
    writer.start()

    writer.write_segment(
        TranscriptSegment(text="Hello world.", timestamp_start=10.0, timestamp_end=12.0)
    )
    writer.write_segment(
        TranscriptSegment(text="How are you?", timestamp_start=15.0, timestamp_end=17.0)
    )
    writer.write_segment(
        TranscriptSegment(text="I am fine.", timestamp_start=20.0, timestamp_end=22.0)
    )
    writer.stop()

    content = writer.file_path.read_text(encoding="utf-8")
    assert "Hello world. How are you? I am fine." in content


def test_writer_new_paragraph_after_interval(tmp_output_dir: Path):
    """Segments in different 2-minute buckets should be separate paragraphs."""
    writer = MarkdownWriter(output_dir=tmp_output_dir, engine_name="test")
    writer.start()

    writer.write_segment(
        TranscriptSegment(text="First paragraph.", timestamp_start=10.0, timestamp_end=12.0)
    )
    writer.write_segment(
        TranscriptSegment(text="Second paragraph.", timestamp_start=130.0, timestamp_end=132.0)
    )
    writer.stop()

    content = writer.file_path.read_text(encoding="utf-8")
    assert "First paragraph." in content
    assert "Second paragraph." in content
    assert "First paragraph. Second paragraph." not in content


# ---------------------------------------------------------------------------
# Duplicate handling
# ---------------------------------------------------------------------------


def test_writer_skips_empty_text(tmp_output_dir: Path):
    """Writer should skip segments with empty text."""
    writer = MarkdownWriter(output_dir=tmp_output_dir, engine_name="test")
    writer.start()

    writer.write_segment(TranscriptSegment(text="", timestamp_start=0.0, timestamp_end=1.0))
    writer.write_segment(TranscriptSegment(text="  ", timestamp_start=1.0, timestamp_end=2.0))
    writer.stop()

    content = writer.file_path.read_text(encoding="utf-8")
    # No segments written — transcript body should be empty (just header)
    assert "## Transcript" in content
    assert "end_time:" in content


def test_writer_skips_duplicates(tmp_output_dir: Path):
    """Writer should skip consecutive duplicate text."""
    writer = MarkdownWriter(output_dir=tmp_output_dir, engine_name="test")
    writer.start()

    writer.write_segment(TranscriptSegment(text="Hello", timestamp_start=0.0, timestamp_end=1.0))
    writer.write_segment(TranscriptSegment(text="Hello", timestamp_start=1.0, timestamp_end=2.0))
    writer.stop()

    content = writer.file_path.read_text(encoding="utf-8")
    assert content.count("Hello") == 1


def test_writer_replaces_reformatted_duplicate(tmp_output_dir: Path):
    """Writer should replace raw text with formatted version (same words)."""
    writer = MarkdownWriter(output_dir=tmp_output_dir, engine_name="test")
    writer.start()

    writer.write_segment(
        TranscriptSegment(text="and so my fellow americans", timestamp_start=5.0, timestamp_end=6.0)
    )
    writer.write_segment(
        TranscriptSegment(
            text="And so, my fellow Americans,", timestamp_start=5.0, timestamp_end=6.0
        )
    )
    writer.stop()

    content = writer.file_path.read_text(encoding="utf-8")
    assert "And so, my fellow Americans," in content
    assert "and so my fellow americans" not in content


# ---------------------------------------------------------------------------
# Speaker labels
# ---------------------------------------------------------------------------


def test_writer_includes_speaker(tmp_output_dir: Path):
    """Writer should include speaker label when provided."""
    writer = MarkdownWriter(output_dir=tmp_output_dir, engine_name="test")
    writer.start()

    writer.write_segment(
        TranscriptSegment(
            text="Good morning", timestamp_start=0.0, timestamp_end=2.0, speaker="Speaker A"
        )
    )
    writer.stop()

    content = writer.file_path.read_text(encoding="utf-8")
    assert "**[Speaker Speaker A]**" in content
    assert "Good morning" in content


def test_writer_meeting_type_filename(tmp_output_dir: Path):
    """Filename should use YYYYMMDD_HH-MM - Type format."""
    writer = MarkdownWriter(
        output_dir=tmp_output_dir, engine_name="test", meeting_type="Standup"
    )
    path = writer.start()
    assert "Standup" in path.name
    assert path.name.endswith(".md")
    import re

    assert re.match(r"\d{8}_\d{2}-\d{2} - Standup\.md", path.name)
    writer.stop()


def test_writer_default_meeting_type_filename(tmp_output_dir: Path):
    """Default meeting type should produce 'Meeting Notes' filename."""
    writer = MarkdownWriter(output_dir=tmp_output_dir, engine_name="test")
    path = writer.start()
    assert "Meeting Notes" in path.name
    import re

    assert re.match(r"\d{8}_\d{2}-\d{2} - Meeting Notes\.md", path.name)
    writer.stop()


def test_writer_speaker_label_format(tmp_output_dir: Path):
    """Speaker labels should use **[Speaker X]** prefix format."""
    writer = MarkdownWriter(output_dir=tmp_output_dir, engine_name="test")
    writer.start()
    writer.write_segment(
        TranscriptSegment(
            text="Hello everyone",
            timestamp_start=0.0,
            timestamp_end=1.0,
            speaker="A",
        )
    )
    writer.stop()
    content = writer.file_path.read_text(encoding="utf-8")
    assert "**[Speaker A]** Hello everyone" in content


def test_writer_speaker_label_none_omitted(tmp_output_dir: Path):
    """Segments without speaker should have no prefix."""
    writer = MarkdownWriter(output_dir=tmp_output_dir, engine_name="test")
    writer.start()
    writer.write_segment(
        TranscriptSegment(
            text="Hello everyone",
            timestamp_start=0.0,
            timestamp_end=1.0,
            speaker=None,
        )
    )
    writer.stop()
    content = writer.file_path.read_text(encoding="utf-8")
    assert "**[Speaker" not in content
    assert "Hello everyone" in content


def test_only_final_segments_should_be_written(tmp_output_dir: Path):
    """Only non-partial segments should be written (session filters partials)."""
    writer = MarkdownWriter(output_dir=tmp_output_dir, engine_name="test")
    writer.start()

    final = TranscriptSegment(
        text="Hey, this is a test.", timestamp_start=5.0, timestamp_end=6.0, is_partial=False
    )
    writer.write_segment(final)
    writer.stop()

    content = writer.file_path.read_text(encoding="utf-8")
    assert content.count("Hey, this is a test.") == 1


# ---------------------------------------------------------------------------
# Timestamp mode: elapsed (default)
# ---------------------------------------------------------------------------


def test_elapsed_timestamp_at_start(tmp_output_dir: Path):
    """Elapsed mode should show 00:00:00 at the start."""
    writer = MarkdownWriter(output_dir=tmp_output_dir, timestamp_mode="elapsed")
    writer.start()

    writer.write_segment(
        TranscriptSegment(text="First words.", timestamp_start=5.0, timestamp_end=7.0)
    )
    writer.stop()

    content = writer.file_path.read_text(encoding="utf-8")
    assert "**[00:00:00]**" in content
    assert "First words." in content


def test_elapsed_timestamp_at_five_minutes(tmp_output_dir: Path):
    """Elapsed mode should show 00:05:00 at the 5-minute mark."""
    writer = MarkdownWriter(output_dir=tmp_output_dir, timestamp_mode="elapsed")
    writer.start()

    writer.write_segment(
        TranscriptSegment(text="Early.", timestamp_start=10.0, timestamp_end=12.0)
    )
    writer.write_segment(
        TranscriptSegment(text="Later.", timestamp_start=310.0, timestamp_end=312.0)
    )
    writer.stop()

    content = writer.file_path.read_text(encoding="utf-8")
    assert "**[00:00:00]**" in content
    assert "**[00:05:00]**" in content
    assert content.count("**[00:05:00]**") == 1


def test_elapsed_hour_timestamp(tmp_output_dir: Path):
    """Elapsed mode should handle hour-long meetings."""
    writer = MarkdownWriter(output_dir=tmp_output_dir, timestamp_mode="elapsed")
    writer.start()

    writer.write_segment(
        TranscriptSegment(text="Still going.", timestamp_start=3665.0, timestamp_end=3670.0)
    )
    writer.stop()

    content = writer.file_path.read_text(encoding="utf-8")
    assert "**[01:00:00]**" in content
    assert "Still going." in content


# ---------------------------------------------------------------------------
# Timestamp mode: local_time
# ---------------------------------------------------------------------------


def test_local_time_timestamp(tmp_output_dir: Path):
    """Local time mode should show wall-clock time."""
    writer = MarkdownWriter(output_dir=tmp_output_dir, timestamp_mode="local_time")
    writer.start()
    start = writer._start_time

    writer.write_segment(
        TranscriptSegment(text="Hello.", timestamp_start=5.0, timestamp_end=7.0)
    )
    writer.stop()

    content = writer.file_path.read_text(encoding="utf-8")
    expected_label = start.strftime("%H:%M:%S")
    assert f"**[{expected_label}]**" in content


def test_local_time_five_minute_mark(tmp_output_dir: Path):
    """Local time mode at 5-minute mark should show start_time + 5 min."""
    writer = MarkdownWriter(output_dir=tmp_output_dir, timestamp_mode="local_time")
    writer.start()
    start = writer._start_time

    writer.write_segment(
        TranscriptSegment(text="Early.", timestamp_start=10.0, timestamp_end=12.0)
    )
    writer.write_segment(
        TranscriptSegment(text="Five min.", timestamp_start=310.0, timestamp_end=312.0)
    )
    writer.stop()

    content = writer.file_path.read_text(encoding="utf-8")
    from datetime import timedelta

    five_min = start + timedelta(seconds=300)
    assert f"**[{five_min.strftime('%H:%M:%S')}]**" in content


# ---------------------------------------------------------------------------
# Timestamp mode: none
# ---------------------------------------------------------------------------


def test_no_timestamp_mode(tmp_output_dir: Path):
    """None mode should not include any timestamp markers."""
    writer = MarkdownWriter(output_dir=tmp_output_dir, timestamp_mode="none")
    writer.start()

    writer.write_segment(
        TranscriptSegment(text="No timestamps.", timestamp_start=5.0, timestamp_end=7.0)
    )
    writer.write_segment(
        TranscriptSegment(text="At five minutes.", timestamp_start=310.0, timestamp_end=312.0)
    )
    writer.stop()

    content = writer.file_path.read_text(encoding="utf-8")
    assert "No timestamps." in content
    assert "At five minutes." in content
    assert "**[" not in content


# ---------------------------------------------------------------------------
# Header preservation (regression: local engine negative timestamps)
# ---------------------------------------------------------------------------


def test_header_preserved_with_negative_timestamp(tmp_output_dir: Path):
    """Header must not be destroyed even with negative timestamp_start.

    The local engine can emit segments with slightly negative timestamps
    when model load time exceeds audio buffer duration.
    """
    writer = MarkdownWriter(output_dir=tmp_output_dir, timestamp_mode="none")
    writer.start()

    writer.write_segment(
        TranscriptSegment(text="First segment.", timestamp_start=-1.5, timestamp_end=0.5)
    )
    writer.stop()

    content = writer.file_path.read_text(encoding="utf-8")
    assert content.startswith("---\n")
    assert "## Transcript" in content
    assert "First segment." in content


def test_header_preserved_all_modes(tmp_output_dir: Path):
    """Header must be intact for every timestamp mode, including edge cases."""
    for mode in ("none", "elapsed", "local_time"):
        d = tmp_output_dir / mode
        writer = MarkdownWriter(output_dir=d, timestamp_mode=mode)
        writer.start()

        # Mix of edge-case timestamps: negative, zero, normal, 5+ minutes
        writer.write_segment(
            TranscriptSegment(text="Negative.", timestamp_start=-2.0, timestamp_end=0.0)
        )
        writer.write_segment(
            TranscriptSegment(text="Zero.", timestamp_start=0.0, timestamp_end=1.0)
        )
        writer.write_segment(
            TranscriptSegment(text="Normal.", timestamp_start=30.0, timestamp_end=32.0)
        )
        writer.write_segment(
            TranscriptSegment(text="Five min.", timestamp_start=310.0, timestamp_end=312.0)
        )
        writer.stop()

        content = writer.file_path.read_text(encoding="utf-8")
        assert content.startswith("---\n"), f"Header missing in {mode} mode"
        assert "## Transcript" in content, f"Heading missing in {mode} mode"
        assert "Negative." in content
        assert "Normal." in content
        assert "Five min." in content
        assert "end_time:" in content
        assert "duration:" in content
