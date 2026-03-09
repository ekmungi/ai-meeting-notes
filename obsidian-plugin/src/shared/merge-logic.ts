/** Pure merge logic for combining transcript into notes file. */

/** Strip YAML frontmatter from markdown content. Returns body only. */
export function stripYamlFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const endIdx = content.indexOf("\n---", 3);
  if (endIdx < 0) return content;
  return content.slice(endIdx + 4).trimStart();
}

/** Strip the ## Transcript heading from transcript body. */
export function stripTranscriptHeading(content: string): string {
  return content.replace(/^## Transcript\s*\n/, "");
}

/**
 * Extract transcript body: strips YAML frontmatter and ## Transcript heading.
 * This is what gets inserted into the notes file during merge.
 */
export function extractTranscriptBody(rawTranscript: string): string {
  const noYaml = stripYamlFrontmatter(rawTranscript);
  return stripTranscriptHeading(noYaml);
}

/**
 * Merge transcript body into notes content by replacing the embed link.
 * Also removes the transcript_file field from notes YAML frontmatter.
 */
export function mergeTranscriptIntoNotes(
  notesContent: string,
  transcriptBody: string,
  transcriptBaseName: string,
): string {
  const embedLink = `![[${transcriptBaseName}]]`;
  let result = notesContent.replace(embedLink, transcriptBody.trimEnd());
  // Remove transcript_file from notes frontmatter (file is being trashed)
  result = result.replace(/^transcript_file:\s*".*"\n/m, "");
  return result;
}

/**
 * Merge transcript body into notes by replacing content after ## Transcript heading.
 * Used by the desktop app where notes have a plain ## Transcript section (no embed).
 * Also removes transcript_file from notes YAML frontmatter if present.
 */
export function mergeTranscriptIntoSection(
  notesContent: string,
  transcriptBody: string,
): string {
  const marker = "## Transcript";
  const idx = notesContent.indexOf(marker);
  if (idx < 0) {
    // Fallback: append section at end if not found
    return notesContent.trimEnd() + "\n\n" + marker + "\n\n" + transcriptBody.trimEnd() + "\n";
  }
  const before = notesContent.slice(0, idx + marker.length);
  let result = before + "\n\n" + transcriptBody.trimEnd() + "\n";
  // Remove transcript_file from YAML frontmatter if present
  result = result.replace(/^transcript_file:\s*".*"\n/m, "");
  return result;
}
