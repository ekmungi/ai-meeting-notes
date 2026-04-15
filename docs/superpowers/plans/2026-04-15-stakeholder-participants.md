# Stakeholder Participants + Template Folder + YAML Type Field — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a stakeholders-folder multi-select participants step, a template picker for folder-typed template paths with per-meeting-type mappings, and restructure notes/transcript YAML with a `type:` list field.

**Architecture:** Extend the existing `MeetingTypeModal` callback chain in `main.ts` with two new modals (`TemplatePickerModal`, `ParticipantsModal`). Update `yaml-builder.ts` to emit the new `type: [meeting]` / `type: [meeting-transcript]` lists and a `participants:` list, removing the string `type:` and `tags:` fields. Add `{{participants}}` to the template substitution pipeline in `transcript-view.ts`.

**Tech Stack:** TypeScript, Obsidian Plugin API (SuggestModal, Modal, AbstractInputSuggest, TFile, TFolder), esbuild. Unit tests via vitest on the pure-TS `shared/yaml-builder.ts` module.

**Spec:** [docs/superpowers/specs/2026-04-15-stakeholder-participants-design.md](../specs/2026-04-15-stakeholder-participants-design.md)

---

## File Structure

### Create
- `obsidian-plugin/src/template-picker-modal.ts` — `SuggestModal<TFile>` over `.md` files in the configured templates folder
- `obsidian-plugin/src/participants-modal.ts` — custom `Modal` with checkbox list of stakeholder `.md` files
- `obsidian-plugin/src/shared/yaml-builder.test.ts` — vitest unit tests for YAML output
- `obsidian-plugin/vitest.config.ts` — vitest configuration

### Modify
- `obsidian-plugin/src/shared/types.ts` — add `stakeholdersFolder`, `meetingTypeTemplates` to settings
- `obsidian-plugin/src/shared/yaml-builder.ts` — new `type:` list, remove string `type:` and `tags:`, add `participants`, update `PLUGIN_YAML_KEYS`
- `obsidian-plugin/src/transcript-view.ts` — accept `participants` + `templateOverride`, substitute `{{participants}}`, drop string-type rewrite in `renameForType`
- `obsidian-plugin/src/main.ts` — chain `MeetingTypeModal` → `TemplatePickerModal` → `ParticipantsModal` → `renameForType` with overrides
- `obsidian-plugin/src/settings.ts` — add "Stakeholders folder" input; per-type template dropdown in meeting types list
- `obsidian-plugin/package.json` — add `vitest` devDependency + `test` script

---

## Task 0: Bootstrap Vitest

**Files:**
- Modify: `obsidian-plugin/package.json`
- Create: `obsidian-plugin/vitest.config.ts`

- [ ] **Step 1: Add vitest to devDependencies and a test script**

Edit `obsidian-plugin/package.json`, add to `scripts`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

Add to `devDependencies`:

```json
"vitest": "^1.6.0"
```

- [ ] **Step 2: Install**

Run: `cd obsidian-plugin && npm install`
Expected: `vitest` installed; `node_modules/.bin/vitest` exists.

- [ ] **Step 3: Create vitest config**

Create `obsidian-plugin/vitest.config.ts`:

```ts
/** Vitest config for the Obsidian plugin. Only pure TS modules are tested. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/shared/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Commit**

```bash
git add obsidian-plugin/package.json obsidian-plugin/package-lock.json obsidian-plugin/vitest.config.ts
git commit -m "chore: add vitest for obsidian plugin shared modules"
```

---

## Task 1: Extend Settings Types and Defaults

**Files:**
- Modify: `obsidian-plugin/src/shared/types.ts:1-44`

- [ ] **Step 1: Add fields to `MeetingNotesSettings` interface**

In `obsidian-plugin/src/shared/types.ts`, inside `MeetingNotesSettings` interface (around line 22, before the closing brace):

```ts
  stakeholdersFolder: string;
  meetingTypeTemplates: Record<string, string>;
```

- [ ] **Step 2: Add defaults**

In the same file, inside `DEFAULT_SETTINGS` (around line 43, before closing brace):

```ts
  stakeholdersFolder: "",
  meetingTypeTemplates: {},
```

- [ ] **Step 3: Commit**

```bash
git add obsidian-plugin/src/shared/types.ts
git commit -m "feat: add stakeholdersFolder and meetingTypeTemplates settings"
```

---

## Task 2: Update yaml-builder — Tests First

**Files:**
- Create: `obsidian-plugin/src/shared/yaml-builder.test.ts`

- [ ] **Step 1: Write failing tests for new YAML shape**

Create `obsidian-plugin/src/shared/yaml-builder.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd obsidian-plugin && npm test`
Expected: Multiple FAIL — `buildNotesYaml` currently takes `meetingType: string` not `participants: string[]`, emits `type: "${meetingType}"` and `tags: [meeting-notes]`.

- [ ] **Step 3: Rewrite `yaml-builder.ts` to match new contract**

Replace `obsidian-plugin/src/shared/yaml-builder.ts` entirely:

```ts
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
    `start_time: "${formatIsoTime(startTime)}"`,
    `notes_file: "[[${notesBaseName}]]"`,
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
    `start_time: "${formatIsoTime(startTime)}"`,
    ...(transcriptBaseName ? [`transcript_file: "[[${transcriptBaseName}]]"`] : []),
  ];
  if (participants.length > 0) {
    lines.push("participants:");
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
  "type", "date", "start_time", "transcript_file", "notes_file", "participants",
]);
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd obsidian-plugin && npm test`
Expected: All tests in `yaml-builder.test.ts` PASS.

- [ ] **Step 5: Commit**

```bash
git add obsidian-plugin/src/shared/yaml-builder.ts obsidian-plugin/src/shared/yaml-builder.test.ts
git commit -m "refactor(yaml): type list + participants, remove tags and string type"
```

---

## Task 3: Thread Participants + Template Override Through transcript-view

**Files:**
- Modify: `obsidian-plugin/src/transcript-view.ts:130-205` (notes creation + `_buildNotesContent`)
- Modify: `obsidian-plugin/src/transcript-view.ts:308-347` (`renameForType` — drop string-`type:` rewrite)

- [ ] **Step 1: Add participants state and a setter**

Near the top of the `TranscriptView` class (next to other session state fields in the class), add:

```ts
  private participants: string[] = [];
  private templateOverride: string | null = null;
```

Add a public setter near `renameForType`:

```ts
  /** Called from main.ts after the participants modal resolves. */
  setParticipants(participants: string[]): void {
    this.participants = participants;
  }

  /** Called from main.ts after the template picker modal resolves. */
  setTemplateOverride(path: string | null): void {
    this.templateOverride = path;
  }
```

- [ ] **Step 2: Update `_buildNotesContent` signature and substitution**

Replace the existing `_buildNotesContent` method body. The signature now takes no participants argument (uses `this.participants`) but resolves the template from override or settings. Replace the body with:

```ts
  private async _buildNotesContent(
    typeName: string,
    startTime: Date,
    transcriptBaseName: string,
  ): Promise<string> {
    const dateStr = formatIsoDate(startTime);
    const embedLink = `![[${transcriptBaseName}]]`;

    // Resolve template path: override > settings > none
    const templatePath = this.templateOverride || this.settings.meetingTemplatePath;

    // Extract body and custom YAML from user template (if any)
    let templateBody = "";
    let customYaml: Record<string, string> = {};

    if (templatePath) {
      const normalizedPath = normalizePath(templatePath);
      const templateFile = this.app.vault.getAbstractFileByPath(normalizedPath);
      if (templateFile instanceof TFile) {
        const raw = await this.app.vault.read(templateFile);
        const parsed = parseTemplateContent(raw, PLUGIN_YAML_KEYS);
        customYaml = parsed.customFields;

        // Variable substitution on template body
        templateBody = parsed.body
          .replace(/\{\{meeting_type\}\}/g, typeName)
          .replace(/\{\{date\}\}/g, dateStr)
          .replace(/\{\{transcript_embed\}\}/g, embedLink)
          .replace(/\{\{participants\}\}/g, this._renderParticipantsBlock());
      }
    }

    if (!templateBody) {
      templateBody = defaultNotesBody(embedLink);
    } else {
      if (!templateBody.includes(embedLink)) {
        if (templateBody.includes("## Transcript")) {
          templateBody = templateBody.replace(
            /## Transcript\s*\n/,
            `## Transcript\n${embedLink}\n`,
          );
        } else {
          templateBody += `\n${embedLink}\n`;
        }
      }
    }

    const yaml = buildNotesYaml(startTime, transcriptBaseName, this.participants, customYaml);
    return yaml + "\n" + templateBody;
  }

  /**
   * Render the participants array as indented YAML list items for
   * `{{participants}}` substitution inside user templates. Empty array
   * yields empty string (the template line collapses).
   */
  private _renderParticipantsBlock(): string {
    if (this.participants.length === 0) return "";
    return this.participants.map((n) => `  - "[[${n}]]"`).join("\n");
  }
```

- [ ] **Step 3: Update the `_buildNotesContent` caller**

Find the call site (currently around line 134): `const notesContent = await this._buildNotesContent(meetingType, now, transcriptBaseName);`. The signature did not change, so no caller update is needed. Confirm by reading the file.

- [ ] **Step 4: Drop the string-`type:` rewrite from `renameForType`**

In `renameForType` (around line 338-343), change:

```ts
    await this.app.vault.process(this.file, (content) => {
      return content
        .replace(`![[${oldTranscriptBaseName}]]`, `![[${newTranscriptBaseName}]]`)
        .replace(/^transcript_file:\s*".*"$/m, `transcript_file: "[[${newTranscriptBaseName}]]"`)
        .replace(/^type:\s*".*"$/m, `type: "${meetingType}"`);
    });
```

to:

```ts
    await this.app.vault.process(this.file, (content) => {
      return content
        .replace(`![[${oldTranscriptBaseName}]]`, `![[${newTranscriptBaseName}]]`)
        .replace(/^transcript_file:\s*".*"$/m, `transcript_file: "[[${newTranscriptBaseName}]]"`);
    });
```

(The `type:` field is now a list literal `[meeting]`, unrelated to meeting type. No rewrite needed.)

- [ ] **Step 5: Verify no callers pass the now-removed `meetingType` arg to `buildNotesYaml`**

Run: `cd obsidian-plugin && npx tsc -p tsconfig.desktop.json --noEmit || true`
Also run: `cd obsidian-plugin && npx esbuild src/main.ts --bundle --outfile=/dev/null --external:obsidian --format=cjs --platform=node --target=es2020`
Expected: No type errors referencing the old `buildNotesYaml(..., meetingType, ...)` signature. If present, fix them.

- [ ] **Step 6: Commit**

```bash
git add obsidian-plugin/src/transcript-view.ts
git commit -m "feat(transcript-view): thread participants and template override"
```

---

## Task 4: Create ParticipantsModal

**Files:**
- Create: `obsidian-plugin/src/participants-modal.ts`

- [ ] **Step 1: Write the modal**

Create `obsidian-plugin/src/participants-modal.ts`:

```ts
/**
 * Multi-select modal over `.md` files in the configured stakeholders folder.
 * Enter or the OK button confirms the selection; Esc skips (empty result).
 */

import { App, Modal, Setting, TFile, TFolder, normalizePath } from "obsidian";

export class ParticipantsModal extends Modal {
  private readonly folderPath: string;
  private readonly onChoose: (selected: string[]) => void;
  private readonly selected = new Set<string>();
  private resolved = false;

  /**
   * @param app         Obsidian app reference.
   * @param folderPath  Vault path to the stakeholders folder.
   * @param onChoose    Callback with selected basenames (no .md, no brackets).
   */
  constructor(app: App, folderPath: string, onChoose: (selected: string[]) => void) {
    super(app);
    this.folderPath = folderPath;
    this.onChoose = onChoose;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Select participants" });

    const files = this._listStakeholderFiles();

    if (files.length === 0) {
      contentEl.createEl("p", {
        text: `No markdown files found in "${this.folderPath}". ` +
          `Check the stakeholders folder setting.`,
      });
      this._renderActionRow(contentEl);
      return;
    }

    const listEl = contentEl.createDiv({ cls: "mn-participants-list" });
    listEl.style.maxHeight = "300px";
    listEl.style.overflowY = "auto";
    listEl.style.margin = "0.5em 0";

    for (const file of files) {
      const row = new Setting(listEl).setName(file.basename);
      row.addToggle((toggle) => {
        toggle.setValue(false).onChange((value) => {
          if (value) this.selected.add(file.basename);
          else this.selected.delete(file.basename);
        });
      });
    }

    this._renderActionRow(contentEl);

    // Submit on Enter anywhere inside the modal
    contentEl.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this._submit();
      }
    });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.onChoose([]);
    }
  }

  /** Render OK / Skip row. */
  private _renderActionRow(parent: HTMLElement): void {
    new Setting(parent)
      .addButton((btn) =>
        btn.setButtonText("Skip").onClick(() => {
          this.resolved = true;
          this.close();
          this.onChoose([]);
        }),
      )
      .addButton((btn) =>
        btn.setButtonText("OK").setCta().onClick(() => this._submit()),
      );
  }

  private _submit(): void {
    this.resolved = true;
    const result = Array.from(this.selected);
    this.close();
    this.onChoose(result);
  }

  /** List `.md` files directly under the configured folder (non-recursive). */
  private _listStakeholderFiles(): TFile[] {
    const normalized = normalizePath(this.folderPath);
    const folder = this.app.vault.getAbstractFileByPath(normalized);
    if (!(folder instanceof TFolder)) return [];
    const out: TFile[] = [];
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === "md") {
        out.push(child);
      }
    }
    out.sort((a, b) => a.basename.localeCompare(b.basename));
    return out;
  }
}
```

- [ ] **Step 2: Type-check**

Run: `cd obsidian-plugin && npx esbuild src/participants-modal.ts --bundle --outfile=/dev/null --external:obsidian --format=cjs --platform=node --target=es2020`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add obsidian-plugin/src/participants-modal.ts
git commit -m "feat: add participants multi-select modal"
```

---

## Task 5: Create TemplatePickerModal

**Files:**
- Create: `obsidian-plugin/src/template-picker-modal.ts`

- [ ] **Step 1: Write the modal**

Create `obsidian-plugin/src/template-picker-modal.ts`:

```ts
/**
 * Template picker SuggestModal over `.md` files in the configured templates
 * folder. Used when `meetingTemplatePath` is a folder and no per-type mapping
 * exists for the selected meeting type.
 */

import { App, SuggestModal, TFile, TFolder, normalizePath } from "obsidian";

/** Sentinel value selected to indicate "use built-in default (no template)". */
const USE_DEFAULT = "(use built-in default)";
type Item = TFile | typeof USE_DEFAULT;

export class TemplatePickerModal extends SuggestModal<Item> {
  private readonly folderPath: string;
  private readonly onChoose: (path: string | null) => void;
  private resolved = false;

  /**
   * @param app         Obsidian app reference.
   * @param folderPath  Vault path to the templates folder.
   * @param onChoose    Callback with the chosen template path, or null for
   *                    the built-in default (and on dismiss).
   */
  constructor(app: App, folderPath: string, onChoose: (path: string | null) => void) {
    super(app);
    this.folderPath = folderPath;
    this.onChoose = onChoose;
    this.setPlaceholder("Select template...");
    this.setInstructions([{ command: "Esc", purpose: "use built-in default" }]);
  }

  getSuggestions(query: string): Item[] {
    const lower = query.toLowerCase();
    const files = this._listTemplateFiles().filter((f) =>
      f.basename.toLowerCase().includes(lower),
    );
    return [USE_DEFAULT as Item, ...files];
  }

  renderSuggestion(item: Item, el: HTMLElement): void {
    if (item === USE_DEFAULT) {
      el.setText(USE_DEFAULT);
      el.addClass("mn-template-default");
    } else {
      el.setText(item.basename);
    }
  }

  onChooseSuggestion(item: Item): void {
    this.resolved = true;
    if (item === USE_DEFAULT) {
      this.onChoose(null);
    } else {
      this.onChoose(item.path);
    }
  }

  onClose(): void {
    super.onClose();
    if (!this.resolved) {
      this.resolved = true;
      this.onChoose(null);
    }
  }

  private _listTemplateFiles(): TFile[] {
    const normalized = normalizePath(this.folderPath);
    const folder = this.app.vault.getAbstractFileByPath(normalized);
    if (!(folder instanceof TFolder)) return [];
    const out: TFile[] = [];
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === "md") {
        out.push(child);
      }
    }
    out.sort((a, b) => a.basename.localeCompare(b.basename));
    return out;
  }
}
```

- [ ] **Step 2: Type-check**

Run: `cd obsidian-plugin && npx esbuild src/template-picker-modal.ts --bundle --outfile=/dev/null --external:obsidian --format=cjs --platform=node --target=es2020`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add obsidian-plugin/src/template-picker-modal.ts
git commit -m "feat: add template picker modal for folder-typed template path"
```

---

## Task 6: Wire the Modal Chain in main.ts

**Files:**
- Modify: `obsidian-plugin/src/main.ts:19` (imports)
- Modify: `obsidian-plugin/src/main.ts:450-468` (`_showMeetingTypeModal`)

- [ ] **Step 1: Add imports**

At the top of `obsidian-plugin/src/main.ts`, beside the existing `MeetingTypeModal` import (line 19), add:

```ts
import { ParticipantsModal } from "./participants-modal";
import { TemplatePickerModal } from "./template-picker-modal";
```

Also add to the `obsidian` import (which already imports other symbols) — ensure `TFile, TFolder, normalizePath` are imported. If not already, add them to the existing obsidian import.

- [ ] **Step 2: Replace `_showMeetingTypeModal` with the chained flow**

Replace the existing method (lines 450-468) with:

```ts
  /** Show the meeting type selector, then chain into template + participants. */
  private _showMeetingTypeModal(): void {
    const modal = new MeetingTypeModal(
      this.app,
      this.settings.meetingTypes,
      async (selectedType) => {
        if (!selectedType || !this.transcriptView) return;

        // Persist new types added inline
        if (!this.settings.meetingTypes.includes(selectedType)) {
          this.settings = {
            ...this.settings,
            meetingTypes: [...this.settings.meetingTypes, selectedType],
          };
          await this.saveSettings();
        }

        // Chain: template picker (maybe) -> participants -> renameForType
        this._resolveTemplate(selectedType, (templatePath) => {
          this.transcriptView?.setTemplateOverride(templatePath);
          this._showParticipantsModal((participants) => {
            this.transcriptView?.setParticipants(participants);
            void this.transcriptView?.renameForType(selectedType);
          });
        });
      },
    );
    modal.open();
  }

  /**
   * Resolve which template file to use for `meetingType`, optionally prompting
   * the user with a TemplatePickerModal.
   *
   * Order of resolution:
   *   1. Per-type mapping in `meetingTypeTemplates[meetingType]` -> use directly
   *   2. `meetingTemplatePath` is a file -> use directly (no picker)
   *   3. `meetingTemplatePath` is a folder -> open TemplatePickerModal
   *   4. Otherwise -> null (built-in default)
   */
  private _resolveTemplate(
    meetingType: string,
    done: (templatePath: string | null) => void,
  ): void {
    const mapped = this.settings.meetingTypeTemplates?.[meetingType];
    if (mapped) {
      done(mapped);
      return;
    }
    const tplPath = this.settings.meetingTemplatePath;
    if (!tplPath) {
      done(null);
      return;
    }
    const abs = this.app.vault.getAbstractFileByPath(normalizePath(tplPath));
    if (abs instanceof TFile) {
      done(tplPath);
      return;
    }
    if (abs instanceof TFolder) {
      new TemplatePickerModal(this.app, tplPath, (chosen) => done(chosen)).open();
      return;
    }
    done(null);
  }

  /**
   * Open the participants multi-select modal if a stakeholders folder is
   * configured; otherwise call `done([])` immediately.
   */
  private _showParticipantsModal(done: (participants: string[]) => void): void {
    const folderPath = this.settings.stakeholdersFolder;
    if (!folderPath) {
      done([]);
      return;
    }
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(folderPath));
    if (!(folder instanceof TFolder)) {
      done([]);
      return;
    }
    new ParticipantsModal(this.app, folderPath, done).open();
  }
```

- [ ] **Step 3: Build to verify wiring compiles**

Run: `cd obsidian-plugin && npm run build`
Expected: `main.js` emitted with no TS errors.

- [ ] **Step 4: Commit**

```bash
git add obsidian-plugin/src/main.ts
git commit -m "feat(plugin): chain meeting-type -> template-picker -> participants modals"
```

---

## Task 7: Settings UI — Stakeholders Folder + Per-Type Template Dropdown

**Files:**
- Modify: `obsidian-plugin/src/settings.ts:399-491` (Meeting Types section)

- [ ] **Step 1: Add "Stakeholders folder" input**

Insert the following new `Setting` block inside the `display()` method, immediately after the "Meeting Types" `containerEl.createEl("h3", ...)` line (around line 400):

```ts
    new Setting(containerEl)
      .setName("Stakeholders folder")
      .setDesc("Vault folder containing one .md file per stakeholder. Used for the participants picker. Leave empty to disable.")
      .addText((text) => {
        text
          .setPlaceholder("People")
          .setValue(this.plugin.settings.stakeholdersFolder)
          .onChange(async (value) => {
            this.plugin.settings = { ...this.plugin.settings, stakeholdersFolder: value };
            await this.plugin.saveSettings();
          });
        new FolderSuggest(this.app, text.inputEl, async (path) => {
          this.plugin.settings = { ...this.plugin.settings, stakeholdersFolder: path };
          await this.plugin.saveSettings();
        });
      });
```

- [ ] **Step 2: Update the "Meeting template" description**

Find the `.setName("Meeting template")` Setting (around line 403). Change its `.setDesc(...)` to:

```ts
      .setDesc("Path to a template file OR a folder of templates. If a folder, you'll be prompted to pick a template when starting a recording (unless a per-type mapping is set below). Supports {{meeting_type}}, {{date}}, {{transcript_embed}}, {{participants}} variables.")
```

- [ ] **Step 3: Add per-type template dropdown to the meeting types list**

Replace the `_renderMeetingTypesList` method with a version that adds a template dropdown per row:

```ts
  /** Render the editable list of meeting types inside the given container. */
  private _renderMeetingTypesList(container: HTMLElement): void {
    container.empty();

    new Setting(container)
      .setName("Meeting types")
      .setDesc("Types available in the quick-switcher when starting a recording. Assign a template per type when a templates folder is configured.");

    let newTypeValue = "";
    new Setting(container)
      .addText((text) => {
        text.setPlaceholder("New type name...");
        text.onChange((value) => { newTypeValue = value; });
        text.inputEl.addEventListener("keydown", async (e) => {
          if (e.key === "Enter" && newTypeValue.trim()) {
            const trimmed = newTypeValue.trim();
            if (!this.plugin.settings.meetingTypes.includes(trimmed)) {
              this.plugin.settings = {
                ...this.plugin.settings,
                meetingTypes: [...this.plugin.settings.meetingTypes, trimmed],
              };
              await this.plugin.saveSettings();
              this._renderMeetingTypesList(container);
            }
          }
        });
      })
      .addButton((btn) =>
        btn.setButtonText("Add").onClick(async () => {
          const trimmed = newTypeValue.trim();
          if (trimmed && !this.plugin.settings.meetingTypes.includes(trimmed)) {
            this.plugin.settings = {
              ...this.plugin.settings,
              meetingTypes: [...this.plugin.settings.meetingTypes, trimmed],
            };
            await this.plugin.saveSettings();
            this._renderMeetingTypesList(container);
          }
        })
      );

    // List available template files (only if meetingTemplatePath is a folder)
    const templateFiles = this._listTemplateFilesForSettings();

    for (const meetingType of this.plugin.settings.meetingTypes) {
      const row = new Setting(container).setName(meetingType);

      if (templateFiles.length > 0) {
        row.addDropdown((dd) => {
          dd.addOption("", "(default)");
          for (const f of templateFiles) {
            dd.addOption(f.path, f.basename);
          }
          const current = this.plugin.settings.meetingTypeTemplates?.[meetingType] ?? "";
          dd.setValue(current);
          dd.onChange(async (value) => {
            const next = { ...(this.plugin.settings.meetingTypeTemplates ?? {}) };
            if (value === "") {
              delete next[meetingType];
            } else {
              next[meetingType] = value;
            }
            this.plugin.settings = { ...this.plugin.settings, meetingTypeTemplates: next };
            await this.plugin.saveSettings();
          });
        });
      }

      row.addButton((btn) =>
        btn.setButtonText("Remove").onClick(async () => {
          const nextTemplates = { ...(this.plugin.settings.meetingTypeTemplates ?? {}) };
          delete nextTemplates[meetingType];
          this.plugin.settings = {
            ...this.plugin.settings,
            meetingTypes: this.plugin.settings.meetingTypes.filter((t) => t !== meetingType),
            meetingTypeTemplates: nextTemplates,
          };
          await this.plugin.saveSettings();
          this._renderMeetingTypesList(container);
        })
      );
    }
  }

  /**
   * List `.md` files in the configured meetingTemplatePath if (and only if)
   * that path resolves to a TFolder. Used to populate the per-type dropdown.
   * Returns [] when the path is empty, a file, or not found.
   */
  private _listTemplateFilesForSettings(): TFile[] {
    const path = this.plugin.settings.meetingTemplatePath;
    if (!path) return [];
    const abs = this.app.vault.getAbstractFileByPath(path);
    if (!(abs instanceof TFolder)) return [];
    const out: TFile[] = [];
    for (const child of abs.children) {
      if (child instanceof TFile && child.extension === "md") {
        out.push(child);
      }
    }
    out.sort((a, b) => a.basename.localeCompare(b.basename));
    return out;
  }
```

Note: `TFolder` is already imported at line 6 of `settings.ts`. Verify that the import still includes both `TFile` and `TFolder`.

- [ ] **Step 4: Build to verify**

Run: `cd obsidian-plugin && npm run build`
Expected: `main.js` emitted with no TS errors.

- [ ] **Step 5: Commit**

```bash
git add obsidian-plugin/src/settings.ts
git commit -m "feat(settings): stakeholders folder + per-type template dropdown"
```

---

## Task 8: Manual Verification in Obsidian

**Files:** None. Manual testing in a live Obsidian vault.

- [ ] **Step 1: Install the built plugin**

Run: `cd obsidian-plugin && npm run build`
Copy `main.js`, `manifest.json`, and `styles.css` (if present) into `<vault>/.obsidian/plugins/ai-meeting-notes/`. Reload Obsidian (Ctrl+R or disable/enable plugin).

- [ ] **Step 2: Happy-path verification**

In the plugin settings:
- Set "Stakeholders folder" = `People` (create it; add `Alice.md` and `Bob.md`).
- Set "Meeting template" = `Templates` (create it; add `Standup.md` and `OneOnOne.md`).
- For "Standup" meeting type, assign `Standup.md` via the dropdown.

Then:
- Start recording, pick "Standup". Confirm the template picker does NOT appear (mapped).
- Participants modal appears. Select Alice + Bob. Click OK.
- Stop recording. Open the notes file. Confirm:
  - `type: [meeting]` is present
  - `participants:` list has `- "[[Alice]]"` and `- "[[Bob]]"`
  - No `tags:` line, no string `type: "Standup"`
  - Transcript file has `type: [meeting-transcript]` and no participants

- [ ] **Step 3: Folder-typed template without mapping**

Start recording, pick "Weekly Sync" (no mapping). Confirm the template picker DOES appear, listing `Standup.md` and `OneOnOne.md`. Pick `OneOnOne.md`. Participants modal appears next. Skip.
- Confirm the notes file uses `OneOnOne.md` content, has `type: [meeting]`, and has no `participants:` key.

- [ ] **Step 4: Feature-disabled path**

Clear "Stakeholders folder" setting. Start recording, pick any type. Confirm the participants modal does NOT appear.

- [ ] **Step 5: Backwards-compat: template with `{{participants}}`**

Edit `Standup.md` to include:
```
---
project: "Nano"
---
## Notes
Attendees:
{{participants}}
```
Start a Standup recording, select Alice. Confirm the notes file's body has:
```
Attendees:
  - "[[Alice]]"
```

- [ ] **Step 6: Commit (if any fixups were required above)**

```bash
git add -A
git commit -m "fix: manual verification fixups" --allow-empty
```

---

## Task 9: Decisions Log

**Files:**
- Modify: `C:/Users/ekmun/.claude/projects/c--Users-ekmun-Dev-ai-meeting-notes/memory/decisions.md` (outside repo, per project memory convention)

- [ ] **Step 1: Append DEC-066, DEC-067, DEC-068**

Append the three decisions documented in the spec's "Decisions Log Entry" section to `decisions.md` in the project memory directory. (No in-repo commit required — memory is outside the repo.)

- [ ] **Step 2: Update MEMORY.md**

In the same memory directory, add a bullet under a new or existing "## Sprint 9" section:
```
- Sprint 9: Stakeholders folder + template picker + YAML type list. See [plans/](plans/) and [../plans/2026-04-15-stakeholder-participants.md](plans/2026-04-15-stakeholder-participants.md).
```

---

## Self-Review

Spec coverage:
- Stakeholders folder setting: Task 1, Task 7
- Template path accepts file OR folder: Task 6 (`_resolveTemplate`), Task 7 (description update)
- Per-type template mapping: Task 1 (settings field), Task 6 (resolution), Task 7 (UI)
- `TemplatePickerModal`: Task 5, wired in Task 6
- `ParticipantsModal`: Task 4, wired in Task 6
- `{{participants}}` template variable: Task 3
- YAML `type: [meeting]` / `type: [meeting-transcript]`: Task 2
- Remove string `type:` and `tags:`: Task 2 + Task 3 (renameForType cleanup)
- `PLUGIN_YAML_KEYS` update: Task 2
- Participants not in transcript: Task 2 (transcript YAML builder takes no participants arg)
- Skip rules (Esc safe-fallbacks): Task 4, Task 5, Task 6

Placeholder scan: No "TBD" / "TODO" / unspecified code blocks. Every step shows concrete code or exact commands.

Type consistency: `setParticipants`, `setTemplateOverride`, `_resolveTemplate`, `_showParticipantsModal`, `_listStakeholderFiles`, `_listTemplateFilesForSettings` names are used consistently across tasks.

All requirements from spec map to at least one task. Plan is self-contained.
