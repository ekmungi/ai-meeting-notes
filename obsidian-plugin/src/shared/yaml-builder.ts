/** YAML frontmatter builders for notes and transcript files. */

import { formatIsoDate, formatIsoTime } from "./format-utils";

/**
 * Build YAML frontmatter for a transcript file.
 * The `type: [meeting-transcript]` list distinguishes transcript files from
 * notes files for Dataview-style queries.
 */
export function buildTranscriptYaml(startTime: Date, notesBaseName: string): string {
  return [
    "---",
    "type: [meeting-transcript]",
    `date: ${formatIsoDate(startTime)}`,
    `start-time: "${formatIsoTime(startTime)}"`,
    `notes-file: "[[${notesBaseName}]]"`,
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
 *
 * @param participants Basenames of selected stakeholder files (no .md, no brackets).
 *                     Each becomes a `- "[[Name]]"` list item. Empty array
 *                     omits the `participants:` key entirely.
 */
export function buildNotesYaml(
  startTime: Date,
  transcriptBaseName: string,
  participants: string[],
  customYaml?: Record<string, string>,
): string {
  const lines = [
    "---",
    "type: [meeting]",
    `date: ${formatIsoDate(startTime)}`,
    `start-time: "${formatIsoTime(startTime)}"`,
    ...(transcriptBaseName ? [`transcript-file: "[[${transcriptBaseName}]]"`] : []),
  ];
  if (participants.length > 0) {
    lines.push("attendees:");
    for (const name of participants) {
      lines.push(`  - "[[${name}]]"`);
    }
  }
  if (customYaml) {
    for (const [k, v] of Object.entries(customYaml)) {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

/** Default notes body used when no user template is set. */
export function defaultNotesBody(embedLink = ""): string {
  return [
    "## Notes",
    "",
    "",
    "## Summary",
    "",
    "### Action Items",
    "- ",
    "",
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
  "type", "date", "start-time", "end-time", "duration-mins",
  "transcript-file", "notes-file", "attendees",
]);
