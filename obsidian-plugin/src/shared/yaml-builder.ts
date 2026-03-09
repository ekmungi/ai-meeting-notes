/** YAML frontmatter builders for notes and transcript files. */

import { formatIsoDate, formatIsoTime } from "./format-utils";

/**
 * Build YAML frontmatter for a transcript file.
 * Mirrors the notes YAML structure with complementary fields.
 */
export function buildTranscriptYaml(startTime: Date, notesBaseName: string): string {
  return [
    "---",
    `date: ${formatIsoDate(startTime)}`,
    `start_time: "${formatIsoTime(startTime)}"`,
    `notes_file: "[[${notesBaseName}]]"`,
    "tags: [meeting-transcript]",
    "---",
    "",
    "## Transcript",
    "",
  ].join("\n");
}

/**
 * Build YAML frontmatter for a notes file.
 * Plugin-owned fields are always present; custom fields from user
 * templates are merged after the plugin fields.
 */
export function buildNotesYaml(
  startTime: Date,
  transcriptBaseName: string,
  meetingType: string,
  customYaml?: Record<string, string>,
): string {
  const lines = [
    "---",
    `type: "${meetingType}"`,
    `date: ${formatIsoDate(startTime)}`,
    `start_time: "${formatIsoTime(startTime)}"`,
    `transcript_file: "[[${transcriptBaseName}]]"`,
  ];
  if (customYaml) {
    for (const [k, v] of Object.entries(customYaml)) {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("tags: [meeting-notes]");
  lines.push("---");
  return lines.join("\n") + "\n";
}

/** Default notes body used when no user template is set. */
export function defaultNotesBody(embedLink: string): string {
  return [
    "## Notes",
    "",
    "",
    "## Summary",
    "",
    "### Action Items",
    "- ",
    "",
    "## Transcript",
    embedLink,
    "",
  ].join("\n");
}

/**
 * Strip YAML frontmatter from a user template and return
 * { body, customFields }. Custom fields that conflict with
 * plugin-owned keys are silently dropped.
 */
export function parseTemplateContent(
  raw: string,
  pluginKeys: Set<string>,
): { body: string; customFields: Record<string, string> } {
  const customFields: Record<string, string> = {};
  let body = raw;

  if (raw.startsWith("---")) {
    const endIdx = raw.indexOf("\n---", 3);
    if (endIdx > 0) {
      const yamlBlock = raw.slice(4, endIdx);
      for (const line of yamlBlock.split("\n")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim();
          const val = line.slice(colonIdx + 1).trim();
          if (!pluginKeys.has(key)) {
            customFields[key] = val;
          }
        }
      }
      body = raw.slice(endIdx + 4).trimStart();
    }
  }

  return { body, customFields };
}

/** Plugin-owned YAML keys that cannot be overridden by user templates. */
export const PLUGIN_YAML_KEYS = new Set([
  "type", "date", "start_time", "transcript_file", "tags",
]);
