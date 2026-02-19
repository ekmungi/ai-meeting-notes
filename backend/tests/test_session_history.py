"""Tests for session history parsing from markdown files."""

from __future__ import annotations

from pathlib import Path

from meeting_notes.ui.api import _parse_session_file


def _write_session_file(path: Path, engine: str = "Cloud", duration: str = "0:05:42",
                        segments: int = 47) -> Path:
    content = f"""---
date: 2026-02-17
start_time: "14:30:00"
engine: {engine}
timestamp_mode: elapsed
tags: [meeting-notes]
---

# Meeting Notes — 2026-02-17 14:30

## Transcript

Some transcript text here.

---

*Recording ended at 14:35:42*
*Duration: {duration}*
*Segments: {segments}*
"""
    path.write_text(content, encoding="utf-8")
    return path


def test_parse_complete_session(tmp_path: Path):
    fp = _write_session_file(tmp_path / "2026-02-17_1430 Meeting Notes.md")
    info = _parse_session_file(fp)
    assert info is not None
    assert info["engine"] == "Cloud"
    assert info["duration"] == "0:05:42"
    assert info["segments"] == "47"


def test_parse_extracts_engine_name(tmp_path: Path):
    fp = _write_session_file(
        tmp_path / "2026-02-17_1500 Meeting Notes.md",
        engine="Local (faster-whisper small.en)",
    )
    info = _parse_session_file(fp)
    assert info["engine"] == "Local (faster-whisper small.en)"


def test_parse_missing_footer(tmp_path: Path):
    fp = tmp_path / "2026-02-17_1600 Meeting Notes.md"
    fp.write_text("---\nengine: Cloud\n---\n\n# Meeting Notes\n\nSome text.\n",
                  encoding="utf-8")
    info = _parse_session_file(fp)
    assert info is not None
    assert info["duration"] == "in progress"
    assert info["segments"] == "0"


def test_parse_nonexistent_file(tmp_path: Path):
    fp = tmp_path / "does_not_exist.md"
    info = _parse_session_file(fp)
    assert info is None


def test_parse_uses_filename_as_title(tmp_path: Path):
    fp = _write_session_file(tmp_path / "2026-02-17_1430 Meeting Notes.md")
    info = _parse_session_file(fp)
    assert info["title"] == "2026-02-17_1430 Meeting Notes"
