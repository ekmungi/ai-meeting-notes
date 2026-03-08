"""Tests for session history parsing from markdown files."""

from __future__ import annotations

from pathlib import Path

from meeting_notes.ui.api import _parse_session_file


def _write_session_file(path: Path, duration: str = "0:05:42") -> Path:
    content = f"""---
date: 2026-02-17
start_time: "14:30:00"
end_time: "14:35:42"
duration: "{duration}"
tags: [meeting-notes]
---

# Meeting Notes — 2026-02-17 14:30

## Transcript

Some transcript text here.
"""
    path.write_text(content, encoding="utf-8")
    return path


def test_parse_complete_session(tmp_path: Path):
    fp = _write_session_file(tmp_path / "20260217_14-30 - Meeting Notes.md")
    info = _parse_session_file(fp)
    assert info is not None
    assert info["duration"] == "0:05:42"


def test_parse_duration_from_yaml(tmp_path: Path):
    fp = _write_session_file(
        tmp_path / "20260217_15-00 - Meeting Notes.md",
        duration="1:23:45",
    )
    info = _parse_session_file(fp)
    assert info["duration"] == "1:23:45"


def test_parse_missing_duration(tmp_path: Path):
    fp = tmp_path / "20260217_16-00 - Meeting Notes.md"
    fp.write_text("---\ndate: 2026-02-17\n---\n\n# Meeting Notes\n\nSome text.\n",
                  encoding="utf-8")
    info = _parse_session_file(fp)
    assert info is not None
    assert info["duration"] == "in progress"


def test_parse_nonexistent_file(tmp_path: Path):
    fp = tmp_path / "does_not_exist.md"
    info = _parse_session_file(fp)
    assert info is None


def test_parse_uses_filename_as_title(tmp_path: Path):
    fp = _write_session_file(tmp_path / "20260217_14-30 - Meeting Notes.md")
    info = _parse_session_file(fp)
    assert info["title"] == "20260217_14-30 - Meeting Notes"
