"""Tests for session file deletion (recycle bin)."""

from pathlib import Path
from unittest.mock import patch

from meeting_notes.ui.api import MeetingNotesAPI


class TestDeleteSession:
    """Test delete_session moves files to recycle bin."""

    def test_delete_existing_file(self, tmp_path: Path):
        """delete_session moves an existing .md file to trash."""
        md_file = tmp_path / "test.md"
        md_file.write_text("test content")

        api = MeetingNotesAPI()
        with patch("send2trash.send2trash") as mock_trash:
            result = api.delete_session(str(md_file))

        assert result["ok"] is True
        mock_trash.assert_called_once_with(str(md_file.resolve()))

    def test_delete_nonexistent_file(self):
        """delete_session returns error for missing file."""
        api = MeetingNotesAPI()
        result = api.delete_session("/nonexistent/file.md")
        assert "error" in result

    def test_delete_non_md_file(self, tmp_path: Path):
        """delete_session refuses to delete non-markdown files."""
        txt_file = tmp_path / "test.txt"
        txt_file.write_text("test")

        api = MeetingNotesAPI()
        result = api.delete_session(str(txt_file))
        assert "error" in result

    def test_delete_also_removes_wav(self, tmp_path: Path):
        """delete_session also trashes matching WAV file if it exists."""
        md_file = tmp_path / "20260308_14-30 - Standup.md"
        wav_file = tmp_path / "20260308_14-30 - Standup.wav"
        md_file.write_text("test")
        wav_file.write_bytes(b"RIFF")

        api = MeetingNotesAPI()
        with patch("send2trash.send2trash") as mock_trash:
            result = api.delete_session(str(md_file))

        assert result["ok"] is True
        assert mock_trash.call_count == 2

    def test_delete_also_removes_transcript(self, tmp_path: Path):
        """delete_session also trashes matching transcript file."""
        md_file = tmp_path / "20260308_14-30 - Standup.md"
        transcript_file = tmp_path / "20260308_14-30 - Standup_transcript.md"
        md_file.write_text("test")
        transcript_file.write_text("transcript")

        api = MeetingNotesAPI()
        with patch("send2trash.send2trash") as mock_trash:
            result = api.delete_session(str(md_file))

        assert result["ok"] is True
        assert mock_trash.call_count == 2
