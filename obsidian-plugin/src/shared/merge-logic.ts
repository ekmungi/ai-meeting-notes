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
