/** Unit tests for YAML frontmatter builders. */
import { describe, it, expect } from "vitest";
import {
  applyAttendees,
  buildNotesYaml,
  buildTranscriptYaml,
  parseTemplateContent,
  PLUGIN_YAML_KEYS,
} from "./yaml-builder";

const fixedDate = new Date("2026-04-15T14:30:00");

describe("buildNotesYaml", () => {
  it("emits type: [meeting] list (not string)", () => {
    const yaml = buildNotesYaml(fixedDate, "TR", ["Alice"]);
    expect(yaml).toContain("type: [meeting]");
    expect(yaml).not.toMatch(/^type:\s*"/m);
  });

  it("omits legacy tags: line", () => {
    const yaml = buildNotesYaml(fixedDate, "TR", []);
    expect(yaml).not.toContain("tags:");
  });

  it("emits attendees list with wiki-link items when provided", () => {
    const yaml = buildNotesYaml(fixedDate, "TR", ["Alice", "Bob"]);
    expect(yaml).toContain("attendees:");
    expect(yaml).toContain('  - "[[Alice]]"');
    expect(yaml).toContain('  - "[[Bob]]"');
  });

  it("omits attendees key entirely when empty", () => {
    const yaml = buildNotesYaml(fixedDate, "TR", []);
    expect(yaml).not.toContain("attendees:");
  });

  it("includes transcript-file wikilink", () => {
    const yaml = buildNotesYaml(fixedDate, "TR", []);
    expect(yaml).toContain('transcript-file: "[[TR]]"');
  });

  it("merges customYaml after plugin fields", () => {
    const yaml = buildNotesYaml(fixedDate, "TR", [], { project: '"Nano"' });
    expect(yaml).toContain('project: "Nano"');
  });
});

describe("buildTranscriptYaml", () => {
  it("emits type: [meeting-transcript] list", () => {
    const yaml = buildTranscriptYaml(fixedDate, "NT");
    expect(yaml).toContain("type: [meeting-transcript]");
    expect(yaml).not.toContain("tags:");
  });

  it("links back to notes file", () => {
    const yaml = buildTranscriptYaml(fixedDate, "NT");
    expect(yaml).toContain('notes-file: "[[NT]]"');
  });
});

describe("PLUGIN_YAML_KEYS", () => {
  it("reserves type, attendees; does not reserve tags", () => {
    expect(PLUGIN_YAML_KEYS.has("type")).toBe(true);
    expect(PLUGIN_YAML_KEYS.has("attendees")).toBe(true);
    expect(PLUGIN_YAML_KEYS.has("tags")).toBe(false);
    expect(PLUGIN_YAML_KEYS.has("start-time")).toBe(true);
    expect(PLUGIN_YAML_KEYS.has("end-time")).toBe(true);
    expect(PLUGIN_YAML_KEYS.has("duration-mins")).toBe(true);
    expect(PLUGIN_YAML_KEYS.has("transcript-file")).toBe(true);
    expect(PLUGIN_YAML_KEYS.has("notes-file")).toBe(true);
  });
});

describe("parseTemplateContent", () => {
  it("filters out plugin-owned keys and returns body", () => {
    const raw = `---\ntype: [meeting]\nproject: "X"\n---\n## Notes\n`;
    const { body, customFields } = parseTemplateContent(raw, PLUGIN_YAML_KEYS);
    expect(body.startsWith("## Notes")).toBe(true);
    expect(customFields).not.toHaveProperty("type");
    expect(customFields.project).toBe('"X"');
  });
});

describe("applyAttendees", () => {
  it("writes bare participant names as wikilinks", () => {
    const fm: Record<string, unknown> = {};
    applyAttendees(fm, ["Alice Smith", "Bob Jones"]);
    expect(fm.attendees).toEqual(["[[Alice Smith]]", "[[Bob Jones]]"]);
  });

  // finalize() re-asserts on EVERY recording, including ones with no preset.
  // Wiping attendees a user added by hand would be worse than the bug.
  it("leaves existing attendees untouched when there are no participants", () => {
    const fm: Record<string, unknown> = { attendees: ["[[Added By Hand]]"] };
    applyAttendees(fm, []);
    expect(fm.attendees).toEqual(["[[Added By Hand]]"]);
  });

  it("replaces existing attendees when participants are known (plugin-owned key)", () => {
    const fm: Record<string, unknown> = { attendees: ["[[Stale]]"] };
    applyAttendees(fm, ["Alice Smith"]);
    expect(fm.attendees).toEqual(["[[Alice Smith]]"]);
  });

  it("is idempotent", () => {
    const fm: Record<string, unknown> = {};
    applyAttendees(fm, ["Alice Smith"]);
    applyAttendees(fm, ["Alice Smith"]);
    expect(fm.attendees).toEqual(["[[Alice Smith]]"]);
  });

  it("does not double-wrap a name that is already a wikilink", () => {
    const fm: Record<string, unknown> = {};
    applyAttendees(fm, ["[[Alice Smith]]"]);
    expect(fm.attendees).toEqual(["[[Alice Smith]]"]);
  });

  // data.json is untyped at runtime: a preset written by an older build can
  // carry no participants field at all, which used to throw on .length.
  it("tolerates a missing participants list", () => {
    const fm: Record<string, unknown> = { attendees: ["[[Keep Me]]"] };
    applyAttendees(fm, undefined as unknown as string[]);
    expect(fm.attendees).toEqual(["[[Keep Me]]"]);
  });

  it("drops blank and whitespace-only names", () => {
    const fm: Record<string, unknown> = {};
    applyAttendees(fm, ["Alice Smith", "  ", ""]);
    expect(fm.attendees).toEqual(["[[Alice Smith]]"]);
  });
});
