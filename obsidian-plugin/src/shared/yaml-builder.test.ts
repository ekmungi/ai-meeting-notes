/** Unit tests for YAML frontmatter builders. */
import { describe, it, expect } from "vitest";
import {
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

  it("emits participants list with wiki-link items when provided", () => {
    const yaml = buildNotesYaml(fixedDate, "TR", ["Alice", "Bob"]);
    expect(yaml).toContain("participants:");
    expect(yaml).toContain('  - "[[Alice]]"');
    expect(yaml).toContain('  - "[[Bob]]"');
  });

  it("omits participants key entirely when empty", () => {
    const yaml = buildNotesYaml(fixedDate, "TR", []);
    expect(yaml).not.toContain("participants:");
  });

  it("includes transcript_file wikilink", () => {
    const yaml = buildNotesYaml(fixedDate, "TR", []);
    expect(yaml).toContain('transcript_file: "[[TR]]"');
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
    expect(yaml).toContain('notes_file: "[[NT]]"');
  });
});

describe("PLUGIN_YAML_KEYS", () => {
  it("reserves type, participants; does not reserve tags", () => {
    expect(PLUGIN_YAML_KEYS.has("type")).toBe(true);
    expect(PLUGIN_YAML_KEYS.has("participants")).toBe(true);
    expect(PLUGIN_YAML_KEYS.has("tags")).toBe(false);
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
