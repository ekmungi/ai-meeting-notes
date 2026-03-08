"""Notes file creation and merge logic for desktop UI editor integration."""

from __future__ import annotations

import logging
import re
from pathlib import Path

logger = logging.getLogger(__name__)

_NOTES_TEMPLATE = """---
meeting_type: {meeting_type}
date: {date}
time: {time}
---

# {meeting_type} — {date} {time}

## Notes


## Summary

### Action Items
-

"""

_MERGE_SEPARATOR = "\n\n---\n\n"


def create_notes_file(
    output_dir: Path,
    meeting_type: str,
    date_str: str,
    time_str: str,
) -> Path:
    """Create a notes template file for user editing.

    Args:
        output_dir: Directory to create the file in.
        meeting_type: Meeting type for the header.
        date_str: Date string (YYYY-MM-DD).
        time_str: Time string (HH:MM or HH-MM).

    Returns:
        Path to the created notes file.
    """
    time_safe = time_str.replace(":", "-")
    date_compact = date_str.replace("-", "")
    safe_type = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', meeting_type)
    filename = f"{date_compact}_{time_safe} - {safe_type} Notes.md"
    path = output_dir / filename
    if not path.resolve().is_relative_to(output_dir.resolve()):
        raise ValueError(f"Invalid meeting type produces path outside output directory: {meeting_type}")

    content = _NOTES_TEMPLATE.format(
        meeting_type=meeting_type,
        date=date_str,
        time=time_str,
    )
    path.write_text(content, encoding="utf-8")
    logger.info("Notes file created: %s", path)
    return path


def merge_notes_with_transcript(
    notes_path: Path,
    transcript_path: Path,
) -> Path:
    """Merge user notes with transcript into the transcript file.

    If notes file is missing or empty (only template), returns transcript
    path unchanged. Otherwise, inserts notes content above the transcript.

    Args:
        notes_path: Path to the user's notes file.
        transcript_path: Path to the transcript markdown file.

    Returns:
        Path to the final merged file (always transcript_path).
    """
    if not notes_path.exists():
        logger.debug("Notes file not found, skipping merge: %s", notes_path)
        return transcript_path

    notes_content = notes_path.read_text(encoding="utf-8")

    # Check if notes are empty (just template with no user content)
    if not _has_user_content(notes_content):
        logger.debug("Notes file is empty (template only), skipping merge")
        return transcript_path

    # Read transcript
    transcript_content = transcript_path.read_text(encoding="utf-8")

    # Find the ## Transcript heading and insert notes before it
    transcript_marker = "## Transcript"
    if transcript_marker in transcript_content:
        parts = transcript_content.split(transcript_marker, 1)
        notes_body = _extract_notes_body(notes_content)
        merged = parts[0] + notes_body + _MERGE_SEPARATOR + transcript_marker + parts[1]
    else:
        notes_body = _extract_notes_body(notes_content)
        merged = notes_body + _MERGE_SEPARATOR + transcript_content

    transcript_path.write_text(merged, encoding="utf-8")
    logger.info("Merged notes into transcript: %s", transcript_path)

    # Delete the notes file after successful merge
    try:
        notes_path.unlink()
        logger.debug("Deleted notes file after merge: %s", notes_path)
    except OSError:
        logger.warning("Failed to delete notes file: %s", notes_path)

    return transcript_path


def _has_user_content(content: str) -> bool:
    """Check whether a notes file has user-written content beyond template."""
    lines = content.split("\n")
    i = 0
    # Skip frontmatter if present (must start at line 0)
    if lines and lines[0].strip() == "---":
        i = 1
        while i < len(lines) and lines[i].strip() != "---":
            i += 1
        i += 1  # skip closing ---
    # Check remaining lines for non-heading, non-empty content
    while i < len(lines):
        stripped = lines[i].strip()
        if stripped and not stripped.startswith("#"):
            return True
        i += 1
    return False


def _extract_notes_body(content: str) -> str:
    """Extract the body of a notes file (after frontmatter and heading).

    Handles files with or without YAML frontmatter. If no frontmatter is
    present, skips the first heading and returns everything after it.

    Args:
        content: Full notes file content.

    Returns:
        Body text with leading/trailing whitespace trimmed, ending with newline.
    """
    lines = content.split("\n")
    body_lines: list[str] = []
    has_frontmatter = lines[0].strip() == "---" if lines else False
    past_frontmatter = not has_frontmatter
    frontmatter_count = 0
    past_heading = False

    for line in lines:
        if has_frontmatter and line.strip() == "---":
            frontmatter_count += 1
            if frontmatter_count >= 2:
                past_frontmatter = True
            continue
        if not past_frontmatter:
            continue
        if not past_heading and line.strip().startswith("#"):
            past_heading = True
            continue
        if past_heading:
            body_lines.append(line)

    return "\n".join(body_lines).strip() + "\n"
