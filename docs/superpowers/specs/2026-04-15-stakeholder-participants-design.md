# Stakeholder Participants + Template Folder + YAML Type Field

**Date:** 2026-04-15
**Status:** Design approved, pending implementation plan
**Scope:** Obsidian plugin only (no backend changes)

## Problem

Meeting notes currently capture a meeting *type* (e.g. "Standup") but offer no
way to tag *who attended*. Users manually add participant wiki-links after the
fact. In addition, templates are one-shot — a single file path — so users who
want a different template per meeting type have to juggle the setting.

This design adds:

1. A configurable **stakeholders folder** (one `.md` file per person), surfaced
   through a multi-select modal at record start, injected into the notes file
   as a `participants:` YAML list of `[[wikilinks]]`.
2. A **template picker** flow: the existing template-path setting now accepts
   either a file OR a folder. If a folder, and no per-type template mapping
   exists, a picker modal fires at record start. Users can also pre-assign a
   specific template to each meeting type.
3. A structural YAML change: a new `type:` list field distinguishing notes
   files (`[meeting]`) from transcript files (`[meeting-transcript]`). The
   existing `type: "<meeting type>"` string field is removed — meeting type
   only influences the filename now.

## Non-Goals

- No changes to the backend, WebSocket protocol, or transcription pipeline.
- No changes to the desktop Electron app's settings UI or modals in this
  iteration (can be back-ported later if wanted).
- No automatic stakeholder creation: the stakeholder folder is read-only from
  the plugin's perspective — users populate it themselves.
- No fuzzy matching of speaker labels (A/B/C) to stakeholder names.

## User Flow

At record start:

1. User clicks the record button → recording begins immediately.
2. `MeetingTypeModal` opens (existing behavior): user picks a meeting type.
3. **Template step** (new, conditional):
   - If `meetingTemplatePath` resolves to a **folder** AND no mapping exists
     for the chosen meeting type → `TemplatePickerModal` opens, listing all
     `.md` files in the folder.
   - If `meetingTemplatePath` is a **file**, or a per-type mapping exists, the
     step is skipped silently.
4. **Participants step** (new):
   - `ParticipantsModal` opens, showing a checkbox list of all `.md` files in
     `stakeholdersFolder`. Enter confirms, Esc skips (empty selection).
   - If `stakeholdersFolder` is empty/unset, the modal does not open.
5. The notes file and transcript file are created with substituted template
   variables.

Skipping any step (Esc) is always safe — the flow falls back to defaults.

## Settings

New and modified settings on the plugin settings object:

| Setting | Type | Semantics |
|---|---|---|
| `stakeholdersFolder` | `string` | Vault path to folder of stakeholder `.md` files. Empty = feature disabled. |
| `meetingTemplatePath` | `string` | Existing. Now accepts file OR folder. Auto-detected via `TFile` vs `TFolder`. |
| `meetingTypeTemplates` | `Record<string, string>` | Optional per-meeting-type template mapping: `{ "Standup": "Templates/Standup.md" }`. Missing keys fall back to the template picker or the default template file. |

Settings-tab UI changes:

- New **"Stakeholders folder"** text input with `FolderSuggest` autocomplete,
  in the "Meeting Types" section.
- The existing "Meeting template" input keeps `FileSuggest`, but the
  description is updated to clarify it accepts a file or folder.
- Each row in the Meeting Types list gains a small template picker dropdown
  (populated from the templates folder, if `meetingTemplatePath` is a folder)
  labelled "Template: (default)" by default. Selecting a file writes to
  `meetingTypeTemplates[type]`; selecting "(default)" removes the entry.

## Template Variable

A new `{{participants}}` variable is added. It expands to zero or more
indented YAML list items, each line `  - "[[Name]]"`. The stakeholder file's
basename (sans `.md`) is the wiki-link target.

Expected usage in a user template:

```yaml
---
participants:
{{participants}}
---
```

Rendering with Alice + Bob:

```yaml
---
participants:
  - "[[Alice]]"
  - "[[Bob]]"
---
```

Rendering with no participants selected: the `{{participants}}` line is
replaced with an empty string, leaving `participants:` with no items
(valid YAML, interpreted as `null`). Users who prefer to omit the key
entirely can put the whole block inside a conditional — out of scope here.

## YAML Frontmatter Structure

### Notes file (before → after)

```yaml
# BEFORE
---
type: "Standup"
date: 2026-04-15
start_time: "14:30:00"
transcript_file: "[[20260415_14-30 - Standup-transcript]]"
tags: [meeting-notes]
---

# AFTER
---
type: [meeting]
date: 2026-04-15
start_time: "14:30:00"
transcript_file: "[[20260415_14-30 - Standup-transcript]]"
participants:
  - "[[Alice]]"
  - "[[Bob]]"
---
```

Changes:
- **Removed:** `type: "Standup"` string — meeting type only drives the filename now.
- **Removed:** `tags: [meeting-notes]` — the new `type:` list covers the
  same discovery use case.
- **Added:** `type: [meeting]` list.
- **Added:** `participants:` YAML list of wiki-links (from `{{participants}}`).

### Transcript file (before → after)

```yaml
# BEFORE
---
date: 2026-04-15
start_time: "14:30:00"
notes_file: "[[20260415_14-30 - Standup]]"
tags: [meeting-transcript]
---

# AFTER
---
type: [meeting-transcript]
date: 2026-04-15
start_time: "14:30:00"
notes_file: "[[20260415_14-30 - Standup]]"
---
```

Changes:
- **Removed:** `tags: [meeting-transcript]`.
- **Added:** `type: [meeting-transcript]` list.
- Participants are intentionally **not** written to the transcript file.

### Plugin-owned keys

`PLUGIN_YAML_KEYS` is updated to:

```ts
new Set(["type", "date", "start_time", "transcript_file", "notes_file", "participants"])
```

(`tags` is removed from the reserved set since the plugin no longer writes it.
Custom user templates may still define `tags:` freely.)

## Architecture

### New modules

| File | Purpose | Est. size |
|---|---|---|
| `obsidian-plugin/src/template-picker-modal.ts` | `SuggestModal<TFile>` over `.md` files in the configured templates folder. | <100 lines |
| `obsidian-plugin/src/participants-modal.ts` | Custom `Modal` with a checkbox list of stakeholder `.md` files. Enter confirms, Esc skips. | ~150 lines |

### Modified modules

| File | Change |
|---|---|
| `obsidian-plugin/src/shared/yaml-builder.ts` | Remove `type: "${meetingType}"`; add `type: [meeting]` / `type: [meeting-transcript]`; remove `tags:` lines; update `PLUGIN_YAML_KEYS`. |
| `obsidian-plugin/src/shared/types.ts` | Add `stakeholdersFolder` and `meetingTypeTemplates` to the settings interface, default to `""` and `{}`. |
| `obsidian-plugin/src/settings.ts` | Add stakeholders-folder input; update template description; add per-type template dropdown in Meeting Types list. |
| `obsidian-plugin/src/main.ts` | Extend `_showMeetingTypeModal` → chain into `TemplatePickerModal` (conditional) → `ParticipantsModal`; pass selected template path and participants list to note-creation logic. |
| `obsidian-plugin/src/transcript-view.ts` | Extend template-substitution to handle `{{participants}}`; accept participants array as a new parameter. |

### Data flow

```
record-click
   │
   ▼
MeetingTypeModal  ── chosen type ──┐
                                    │
       (if templatePath is folder &&│
        no mapping for type)        │
   ┌───────────────────────────────┐│
   ▼                               ││
TemplatePickerModal ── template ──►│
                                   ▼
                           ParticipantsModal
                                   │
                         selected stakeholders
                                   │
                                   ▼
                           createNotesFile(
                             type, templatePath,
                             participants)
```

### Skip / fallback rules

| Condition | Behavior |
|---|---|
| `stakeholdersFolder` empty or not a folder | `ParticipantsModal` does not open; `{{participants}}` → empty. |
| `meetingTemplatePath` is a file | `TemplatePickerModal` skipped; template is the file. |
| `meetingTemplatePath` is a folder AND `meetingTypeTemplates[type]` set | `TemplatePickerModal` skipped; template is the mapped file. |
| `meetingTemplatePath` is a folder AND no mapping | `TemplatePickerModal` opens. Esc → built-in default body. |
| User Escs `ParticipantsModal` | No participants; `{{participants}}` → empty. |

## Testing

Unit tests (vitest or jest, per plugin setup):

- `yaml-builder` tests:
  - Notes YAML includes `type: [meeting]` and no `tags:` or string-`type:` fields.
  - Transcript YAML includes `type: [meeting-transcript]` and no `tags:`.
  - `participants` key renders wiki-links correctly (0, 1, many).
  - `PLUGIN_YAML_KEYS` excludes `tags`.
- Template substitution:
  - `{{participants}}` expands to indented YAML list items.
  - Empty participants → empty string (line removed).
- Modal flow (integration-lite, mocked vault):
  - Template-picker skipped when path is a file.
  - Template-picker skipped when per-type mapping exists.
  - Participants modal skipped when folder unset.

Manual verification checklist:

- [ ] Start recording → pick "Standup" → pick template → multi-select
      Alice & Bob → stop → notes file has `type: [meeting]` +
      `participants:\n  - "[[Alice]]"\n  - "[[Bob]]"`.
- [ ] Transcript file has `type: [meeting-transcript]`, no `participants:`.
- [ ] Assign "Standup → Templates/Standup.md" in settings; start Standup
      recording; verify template picker does NOT appear.
- [ ] Clear stakeholders folder setting; start recording; verify
      participants modal does NOT appear.
- [ ] Esc out of each modal → safe fallbacks fire.
- [ ] Existing `{{meeting_type}}`, `{{date}}`, `{{transcript_embed}}` still
      substitute correctly.

## Risks

- **Backwards compatibility.** Existing notes files have `type: "Standup"` and
  `tags: [meeting-notes]`. Removing these fields means Dataview queries or
  Obsidian searches relying on them will break. Users who want to migrate
  can do a vault-wide regex replace (out of scope here, but documented in
  release notes).
- **YAML indentation in templates.** If the user writes `{{participants}}`
  directly under `participants:` with incorrect indentation, the output is
  malformed YAML. The generated list items use two-space indent, which is
  standard — but we should document this.
- **Stakeholder name collisions.** Two files with the same basename in
  different subfolders both show as `[[Alice]]` and resolve ambiguously in
  Obsidian. Acceptable for v1; user can rename.

## Decisions Log Entry (for decisions.md)

**DEC-066:** Remove `type: "<meeting type>"` and `tags:` from notes/transcript
YAML; replace with `type: [meeting]` / `type: [meeting-transcript]` lists.
Meeting type drives filename only. Rationale: the existing `type:` field
conflicted with the new list-typed `type:` convention; `tags:` duplicated
the new `type:` discovery semantics.

**DEC-067:** Template path setting accepts file OR folder; per-meeting-type
template mappings are supported via a new `meetingTypeTemplates` setting
dictionary. Rationale: supports both simple (single-template) and advanced
(per-type) users from one setting.

**DEC-068:** Stakeholder folder feature is plugin-only for this iteration;
desktop Electron app is not updated. Rationale: YAGNI until plugin UX is
validated.
