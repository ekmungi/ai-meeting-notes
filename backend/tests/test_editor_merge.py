"""Tests for notes file creation and merge logic."""

from __future__ import annotations

from pathlib import Path


def _create_notes_file(path: Path, content: str) -> None:
    """Helper: write a notes file."""
    path.write_text(content, encoding="utf-8")


def _create_transcript_file(path: Path, content: str) -> None:
    """Helper: write a transcript file."""
    path.write_text(content, encoding="utf-8")


class TestNotesMerge:
    """Tests for the merge_notes_with_transcript function."""

    def test_merge_combines_notes_and_transcript(self, tmp_path: Path):
        """Verify that notes content is inserted above transcript content."""
        from meeting_notes.ui.merge import merge_notes_with_transcript

        notes_path = tmp_path / "notes.md"
        transcript_path = tmp_path / "transcript.md"
        _create_notes_file(notes_path, "## Notes\n\n- Action item 1\n- Action item 2\n")
        _create_transcript_file(
            transcript_path,
            "---\ndate: 2026-03-06\n---\n\n# Meeting\n\n## Transcript\n\nHello world\n",
        )

        result = merge_notes_with_transcript(notes_path, transcript_path)
        content = result.read_text(encoding="utf-8")
        assert "Action item 1" in content
        assert "Hello world" in content
        assert "## Transcript" in content

    def test_merge_empty_notes_skips(self, tmp_path: Path):
        """Verify that empty notes (template only) skip merge."""
        from meeting_notes.ui.merge import merge_notes_with_transcript

        notes_path = tmp_path / "notes.md"
        transcript_path = tmp_path / "transcript.md"
        _create_notes_file(notes_path, "## Notes\n\n")
        _create_transcript_file(transcript_path, "## Transcript\n\nHello world\n")

        result = merge_notes_with_transcript(notes_path, transcript_path)
        assert result == transcript_path

    def test_merge_missing_notes_returns_transcript(self, tmp_path: Path):
        """Verify that missing notes file returns transcript path unchanged."""
        from meeting_notes.ui.merge import merge_notes_with_transcript

        notes_path = tmp_path / "nonexistent.md"
        transcript_path = tmp_path / "transcript.md"
        _create_transcript_file(transcript_path, "## Transcript\n\nHello\n")

        result = merge_notes_with_transcript(notes_path, transcript_path)
        assert result == transcript_path

    def test_merge_deletes_notes_file(self, tmp_path: Path):
        """Verify that notes file is deleted after successful merge."""
        from meeting_notes.ui.merge import merge_notes_with_transcript

        notes_path = tmp_path / "notes.md"
        transcript_path = tmp_path / "transcript.md"
        _create_notes_file(notes_path, "## Notes\n\n- Important note\n")
        _create_transcript_file(
            transcript_path,
            "## Transcript\n\nSome transcript text\n",
        )

        merge_notes_with_transcript(notes_path, transcript_path)
        assert not notes_path.exists()

    def test_merge_with_frontmatter_notes(self, tmp_path: Path):
        """Verify merge works with notes that have YAML frontmatter."""
        from meeting_notes.ui.merge import merge_notes_with_transcript

        notes_path = tmp_path / "notes.md"
        transcript_path = tmp_path / "transcript.md"
        _create_notes_file(
            notes_path,
            "---\nmeeting_type: Standup\ndate: 2026-03-06\n---\n\n"
            "# Standup\n\n## Notes\n\n- Completed feature X\n",
        )
        _create_transcript_file(
            transcript_path,
            "---\ndate: 2026-03-06\n---\n\n# Meeting\n\n## Transcript\n\nHello\n",
        )

        result = merge_notes_with_transcript(notes_path, transcript_path)
        content = result.read_text(encoding="utf-8")
        assert "Completed feature X" in content
        assert "## Transcript" in content


class TestNotesTemplate:
    """Tests for notes file template creation."""

    def test_creates_notes_file(self, tmp_path: Path):
        """Verify that a notes template file is created with expected content."""
        from meeting_notes.ui.merge import create_notes_file

        path = create_notes_file(tmp_path, "Standup", "2026-03-06", "14:30")
        assert path.exists()
        content = path.read_text(encoding="utf-8")
        assert "## Notes" in content
        assert "Standup" in content

    def test_notes_filename_format(self, tmp_path: Path):
        """Verify that the notes filename contains date and meeting type."""
        from meeting_notes.ui.merge import create_notes_file

        path = create_notes_file(tmp_path, "Standup", "2026-03-06", "14:30")
        assert "Notes" in path.name
        assert "Standup" in path.name

    def test_notes_file_has_frontmatter(self, tmp_path: Path):
        """Verify that the notes template includes YAML frontmatter."""
        from meeting_notes.ui.merge import create_notes_file

        path = create_notes_file(tmp_path, "Weekly Sync", "2026-03-06", "09:00")
        content = path.read_text(encoding="utf-8")
        assert "---" in content
        assert "meeting_type: Weekly Sync" in content
        assert "date: 2026-03-06" in content

    def test_notes_time_colons_replaced(self, tmp_path: Path):
        """Verify that colons in time are replaced with dashes in filename."""
        from meeting_notes.ui.merge import create_notes_file

        path = create_notes_file(tmp_path, "Meeting", "2026-03-06", "14:30")
        assert ":" not in path.name
