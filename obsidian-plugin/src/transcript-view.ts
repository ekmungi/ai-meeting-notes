/**
 * Manages note creation and live transcript updates in the vault.
 *
 * Two-file system: each recording creates a notes file (user-editable) and a
 * transcript file (plugin-streamed). The notes file embeds the transcript via
 * an Obsidian transclusion link. On stop, the transcript can optionally be
 * merged inline and the separate file trashed.
 *
 * Output format matches the desktop MarkdownWriter (file-1.md format):
 *   - Transcript file:   YAML frontmatter + ## Transcript heading
 *   - Timestamp markers   **[HH:MM:SS]** every 5 minutes
 *   - Sentences grouped into paragraphs (new paragraph every 2 minutes)
 *   - Live partials in italic, replaced by final text when utterance ends
 *   - Footer: *Recording ended at ...* / *Duration: ...* / *Segments: ...*
 *
 * Concurrency: handleServerMessage() does not await onTranscript(), so
 * multiple calls can be in-flight. All in-memory state mutations happen
 * BEFORE any await. vault.process() is serialized by Obsidian -- each
 * callback fully reconstructs file content from captured state, avoiding
 * any string-search or length-based truncation races.
 */

import { type App, TFile, TFolder, normalizePath } from "obsidian";
import type { MeetingNotesSettings, TranscriptMessage } from "./types";
import { formatFileTimestamp, formatIsoDate, formatIsoTime, buildMeetingBaseName } from "./shared/format-utils";
import { applyAttendees, buildTranscriptYaml, buildNotesYaml, defaultNotesBody, parseTemplateContent, PLUGIN_YAML_KEYS } from "./shared/yaml-builder";
import { extractTranscriptBody, mergeTranscriptIntoNotes } from "./shared/merge-logic";
import { applySpeakerRevisions as reviseSegments, renderTranscriptBody } from "./shared/transcript-render";
import type { RenderSegment, SpeakerRevisionEntry } from "./shared/transcript-render";

const PARA_INTERVAL_S = 120; // New paragraph every 2 minutes
const TS_INTERVAL_S = 300;   // Timestamp marker every 5 minutes

export class TranscriptView {
  private app: App;
  private settings: MeetingNotesSettings;
  private file: TFile | null = null;
  private transcriptFile: TFile | null = null;
  private startTime: Date | null = null;

  /**
   * Paragraph / timestamp state (mirrors MarkdownWriter).
   *
   * The transcript file content at any point is:
   *   header (fixed) + renderTranscriptBody(finals) + partial
   *
   * currentParaBucket: 2-min bucket index of the current paragraph
   * lastTsBucket:      last timestamp bucket (seconds) written to the file
   * partial:           italic partial text appended at the end, or ""
   * segmentCount:      total final segments written
   */
  /**
   * Log of finalized segments. The body is rendered from this rather than
   * accumulated as a string, so a SpeakerRevision can be replayed by
   * re-rendering instead of patching text already on disk (ISS-011).
   */
  private finals: RenderSegment[] = [];
  private currentParaBucket = -1;
  private lastTsBucket = -1;
  private partial = "";
  private segmentCount = 0;
  private participants: string[] = [];
  private templateOverride: string | null = null;
  private description = "";

  constructor(app: App, settings: MeetingNotesSettings) {
    this.app = app;
    this.settings = settings;
  }

  /**
   * Find the end of the transcript file header (YAML + ## Transcript heading).
   * Returns the character index where transcript body content starts.
   * Uses dynamic search instead of a fixed offset so Obsidian's metadata
   * cache changes don't corrupt the transcript.
   */
  private _findBodyStart(content: string): number {
    const marker = "## Transcript\n";
    const idx = content.indexOf(marker);
    if (idx >= 0) {
      // Body starts after the heading + one blank line
      const afterHeading = idx + marker.length;
      // Skip one newline if present (the blank line after ## Transcript)
      if (content[afterHeading] === "\n") return afterHeading + 1;
      return afterHeading;
    }
    // Fallback: after YAML frontmatter
    if (content.startsWith("---")) {
      const endIdx = content.indexOf("---", 3);
      if (endIdx > 0) return endIdx + 4; // "---\n"
    }
    return 0;
  }

  /**
   * Create two files for the recording and open them side-by-side.
   * Returns the notes file (this.file). The transcript file is stored
   * in this.transcriptFile and receives all streaming updates.
   */
  async createNote(engine: string, meetingType = "Meeting Notes"): Promise<TFile> {
    const now = new Date();
    this.startTime = now;
    this.finals = [];
    this.currentParaBucket = -1;
    this.lastTsBucket = -1;
    this.partial = "";
    this.segmentCount = 0;
    // Reset per-session state so a previous recording's choices don't leak
    this.participants = [];
    this.templateOverride = null;
    this.description = "";

    const notesFolder = this.settings.outputFolder || "Meetings";
    // Transcript folder falls back to notes folder if empty
    const transcriptFolder = this.settings.transcriptFolder || notesFolder;

    const notesFolderPath = normalizePath(notesFolder);
    const transcriptFolderPath = normalizePath(transcriptFolder);

    // Ensure both folders exist
    for (const fp of [notesFolderPath, transcriptFolderPath]) {
      const existing = this.app.vault.getAbstractFileByPath(fp);
      if (!existing) {
        await this.app.vault.createFolder(fp);
      } else if (!(existing instanceof TFolder)) {
        throw new Error(`${fp} exists but is not a folder`);
      }
    }

    const ts = formatFileTimestamp(now);
    const baseName = buildMeetingBaseName(ts, this.description, meetingType);
    const transcriptBaseName = `${baseName}_transcript`;

    // Create transcript file (in transcript folder)
    const transcriptPath = normalizePath(`${transcriptFolderPath}/${transcriptBaseName}.md`);
    const transcriptHeader = buildTranscriptYaml(now, baseName);
    this.transcriptFile = await this.app.vault.create(transcriptPath, transcriptHeader);

    // Create notes file (in notes folder)
    const notesPath = normalizePath(`${notesFolderPath}/${baseName}.md`);
    const notesContent = await this._buildNotesContent(meetingType, now, transcriptBaseName);
    this.file = await this.app.vault.create(notesPath, notesContent);

    // Open notes file only — the embedded transcript link shows a live preview.
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(this.file);

    return this.file;
  }

  /**
   * Build the notes file content.
   *
   * Plugin always generates the YAML frontmatter (type, date, start_time,
   * transcript_file, participants). If a user template is set, any YAML it
   * contains is stripped and its custom fields are merged into the plugin's
   * block. The template body (everything after YAML) provides the markdown
   * sections. If no template is set, a built-in default body is used.
   */
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

  /** Write the recorded WAV next to the transcript file; returns its vault path. */
  async saveWav(buffer: ArrayBuffer): Promise<string> {
    const base = this.transcriptFile?.path.replace(/\.md$/, "")
      ?? `${this.settings.outputFolder}/recording`;
    const wavPath = normalizePath(`${base}.wav`);
    await this.app.vault.adapter.writeBinary(wavPath, buffer);
    return wavPath;
  }

  /**
   * Add audio file reference to the notes file frontmatter.
   * Expects a vault-relative path (from saveWav) and stores it verbatim so
   * the reference resolves unambiguously inside Obsidian.
   */
  async addWavReference(wavPath: string): Promise<void> {
    if (!this.file) return;
    await this.app.vault.process(this.file, (content) => {
      // Insert audio field into frontmatter
      if (content.startsWith("---")) {
        const endIdx = content.indexOf("---", 3);
        if (endIdx > 0) {
          const frontmatter = content.slice(0, endIdx);
          return frontmatter + `audio: "${wavPath}"\n` + content.slice(endIdx);
        }
      }
      return content;
    });
  }

  /** Dispatch an incoming WebSocket transcript message. */
  async onTranscript(msg: TranscriptMessage): Promise<void> {
    if (!this.file || !this.transcriptFile) return;
    if (!msg.text.trim()) return;

    if (msg.is_partial) {
      await this._writePartial(msg.text);
    } else {
      await this._writeFinal(msg.text, msg.timestamp_start, msg.speaker, msg.turn_order ?? null);
    }
  }

  /** Finalize the note: flush remaining content and write the footer. */
  async finalize(durationSeconds: number): Promise<void> {
    if (!this.transcriptFile) return;

    // Discard any trailing partial; the log already holds every final.
    this.partial = "";

    const endTime = new Date();
    const endTimeStr = formatIsoTime(endTime);

    const finalBody = renderTranscriptBody(this.finals);
    const findBody = this._findBodyStart.bind(this);

    await this.app.vault.process(this.transcriptFile, (content) => {
      // Insert end_time and duration into YAML frontmatter.
      // Use closing --- anchor (resilient to Obsidian YAML reformatting).
      let updated = content;
      if (content.startsWith("---") && !content.includes("end-time:")) {
        const closeIdx = content.indexOf("\n---", 3);
        if (closeIdx >= 0) {
          updated = content.slice(0, closeIdx) +
            `\nend-time: "${endTimeStr}"\nduration-mins: ${Math.round(durationSeconds / 60)}` +
            content.slice(closeIdx);
        }
      }
      const bodyStart = findBody(updated);
      return updated.slice(0, bodyStart) + finalBody;
    });

    // Add end_time and duration to notes file frontmatter too.
    // Obsidian's Properties editor may reformat YAML (e.g. inline tags
    // become multi-line), so we find the closing --- directly rather
    // than matching a specific string.
    if (this.file) {
      await this.app.vault.process(this.file, (content) => {
        if (!content.startsWith("---")) return content;
        const closeIdx = content.indexOf("\n---", 3);
        if (closeIdx < 0) return content;
        // Skip if already finalized (idempotent)
        if (content.includes("end-time:")) return content;
        const before = content.slice(0, closeIdx);
        const after = content.slice(closeIdx);
        return before + `\nend-time: "${endTimeStr}"\nduration-mins: ${Math.round(durationSeconds / 60)}` + after;
      });
    }

    // Optionally merge transcript into notes and trash the separate file
    if (this.settings.mergeTranscriptOnStop) {
      await this._mergeTranscript();
    }

    // Re-assert the plugin-owned attendees LAST. Templater (especially a
    // template that prompts, so it resolves after our modals) and the open
    // editor can both write the whole notes file after rebuildNotesContent,
    // clobbering the frontmatter we wrote mid-session. processFrontMatter is
    // editor-aware and merges keys instead of replacing the block, and by
    // running at stop it is the last writer. Guarded so a frontmatter problem
    // can never prevent a recording from stopping.
    if (this.file && this.participants.length > 0) {
      try {
        await this.app.fileManager.processFrontMatter(this.file, (fm) => {
          applyAttendees(fm as Record<string, unknown>, this.participants);
        });
      } catch (err) {
        console.error("Could not write attendees to the notes file:", err);
      }
    }

    this.file = null;
    this.transcriptFile = null;
    this.startTime = null;
  }

  /** Open and focus the notes file in the Obsidian workspace. */
  navigateToNote(): void {
    if (this.file) {
      const leaf = this.app.workspace.getLeaf();
      leaf.openFile(this.file);
    }
  }

  /** Called from main.ts after the participants modal resolves. */
  setParticipants(participants: string[]): void {
    // Presets come from data.json, which is untyped at runtime - one written by
    // an older build can carry no participants field at all.
    this.participants = Array.isArray(participants)
      ? participants.map((p) => String(p).trim()).filter(Boolean)
      : [];
  }

  /** Called from main.ts after the template picker modal resolves. */
  setTemplateOverride(path: string | null): void {
    this.templateOverride = path;
  }

  /** Called from main.ts after the description modal resolves. */
  setDescription(description: string): void {
    this.description = description;
  }

  /**
   * Update only the YAML frontmatter of the notes file to reflect the current
   * participants and template's custom YAML fields. The body is preserved as-is
   * so any Templater (`<% ... %>`) processing that ran after the initial
   * createNote() is not undone.
   */
  async rebuildNotesContent(_meetingType: string): Promise<void> {
    if (!this.file || !this.transcriptFile || !this.startTime) return;
    const transcriptBaseName = this.transcriptFile.basename;

    // Re-resolve custom YAML fields from the (possibly overridden) template.
    const templatePath = this.templateOverride || this.settings.meetingTemplatePath;
    let customYaml: Record<string, string> = {};
    if (templatePath) {
      const templateFile = this.app.vault.getAbstractFileByPath(normalizePath(templatePath));
      if (templateFile instanceof TFile) {
        const raw = await this.app.vault.read(templateFile);
        customYaml = parseTemplateContent(raw, PLUGIN_YAML_KEYS).customFields;
      }
    }

    const newYaml = buildNotesYaml(this.startTime, transcriptBaseName, this.participants, customYaml);

    // Splice the new YAML block into the existing file, preserving the body.
    // Match the first frontmatter block (opening --- on line 1 through the
    // next --- on its own line). Anything after belongs to the body.
    await this.app.vault.process(this.file, (content) => {
      const fmMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
      if (fmMatch) {
        const body = content.slice(fmMatch[0].length);
        return body.startsWith("\n") ? newYaml + body : newYaml + "\n" + body;
      }
      // No existing frontmatter detected — prepend a fresh one.
      return newYaml + "\n" + content;
    });
  }

  /**
   * Rename both files to reflect a new meeting type. Updates the embed link
   * and frontmatter in the notes file to match.
   */
  async renameForType(meetingType: string): Promise<void> {
    if (!this.file || !this.transcriptFile || !this.startTime) return;

    const notesFolder = this.settings.outputFolder || "Meetings";
    const transcriptFolder = this.settings.transcriptFolder || notesFolder;
    const notesFolderPath = normalizePath(notesFolder);
    const transcriptFolderPath = normalizePath(transcriptFolder);
    const ts = formatFileTimestamp(this.startTime);

    const newBaseName = buildMeetingBaseName(ts, this.description, meetingType);
    const newTranscriptBaseName = `${newBaseName}_transcript`;
    const newTranscriptPath = normalizePath(`${transcriptFolderPath}/${newTranscriptBaseName}.md`);
    const newNotesPath = normalizePath(`${notesFolderPath}/${newBaseName}.md`);

    // Capture old transcript base name for embed replacement
    const oldTranscriptBaseName = this.transcriptFile.basename;

    // Rename transcript file first
    await this.app.fileManager.renameFile(this.transcriptFile, newTranscriptPath);

    // Update transcript backlink to new notes file
    await this.app.vault.process(this.transcriptFile, (content) => {
      return content.replace(
        /^notes-file:\s*".*"$/m,
        `notes-file: "[[${newBaseName}]]"`,
      );
    });

    // Update embed link and transcript_file in notes file
    await this.app.vault.process(this.file, (content) => {
      return content
        .replace(`![[${oldTranscriptBaseName}]]`, `![[${newTranscriptBaseName}]]`)
        .replace(/^transcript-file:\s*".*"$/m, `transcript-file: "[[${newTranscriptBaseName}]]"`);
    });

    // Rename notes file
    await this.app.fileManager.renameFile(this.file, newNotesPath);
  }

  /**
   * Merge transcript content into the notes file, replacing the embed link,
   * then trash the transcript file.
   */
  private async _mergeTranscript(): Promise<void> {
    if (!this.file || !this.transcriptFile) return;

    const rawTranscript = await this.app.vault.read(this.transcriptFile);
    const transcriptBaseName = this.transcriptFile.basename;
    const transcriptBody = extractTranscriptBody(rawTranscript);

    await this.app.vault.process(this.file, (content) => {
      return mergeTranscriptIntoNotes(content, transcriptBody, transcriptBaseName);
    });

    await this.app.vault.trash(this.transcriptFile, false);
  }

  /**
   * Write a live italic partial (replaces the previous partial).
   * State is updated before any await so concurrent calls see the new
   * value immediately and do not double-write.
   */
  private async _writePartial(text: string): Promise<void> {
    if (!this.transcriptFile || !this.settings.showPartials) return;

    // Update state before yielding
    this.partial = `\n*${text}*`;

    // Snapshot all state for the vault.process closure
    const body = renderTranscriptBody(this.finals);
    const capturedPartial = this.partial;
    const findBody = this._findBodyStart.bind(this);

    await this.app.vault.process(this.transcriptFile, (content) => {
      const bodyStart = findBody(content);
      return content.slice(0, bodyStart) + body + capturedPartial;
    });
  }

  /**
   * Write a final (non-partial) segment. Updates paragraph / timestamp state,
   * then rewrites the current section via vault.process.
   */
  private async _writeFinal(text: string, timestampStart: number, speaker: string | null = null, turnOrder: number | null = null): Promise<void> {
    if (!this.transcriptFile) return;

    // --- Synchronous state update (before any await) ---
    const elapsed = Math.max(0, timestampStart);
    const paraBucket = Math.floor(elapsed / PARA_INTERVAL_S);
    const tsBucket = Math.floor(elapsed / TS_INTERVAL_S) * TS_INTERVAL_S;

    const needNewPara = paraBucket !== this.currentParaBucket;
    const needTimestamp =
      this.settings.timestampMode !== "none" && tsBucket > this.lastTsBucket;

    let tsMarker: string | null = null;
    if (needTimestamp) {
      tsMarker = this._formatTimestamp(tsBucket) || null;
      this.lastTsBucket = tsBucket;
    }
    if (needNewPara || needTimestamp) this.currentParaBucket = paraBucket;

    // The speaker label is NOT baked in here - render decides where labels go,
    // so a later revision can move or remove one (ISS-011).
    this.finals = [...this.finals, {
      turnOrder, text, speaker,
      startsParagraph: needNewPara || needTimestamp,
      tsMarker,
    }];
    this.partial = ""; // Clear any pending partial
    this.segmentCount++;

    // Snapshot for vault.process
    const body = renderTranscriptBody(this.finals);
    const findBody = this._findBodyStart.bind(this);

    await this.app.vault.process(this.transcriptFile, (content) => {
      const bodyStart = findBody(content);
      return content.slice(0, bodyStart) + body;   // No partial
    });
  }

  /**
   * Apply AssemblyAI's corrected speaker labels and re-render the transcript.
   * Must run before finalize() releases the file handles.
   * @param revisions - Corrections keyed by turn_order.
   */
  async applySpeakerRevisions(revisions: SpeakerRevisionEntry[]): Promise<void> {
    if (!this.transcriptFile || revisions.length === 0) return;
    this.finals = reviseSegments(this.finals, revisions);
    const body = renderTranscriptBody(this.finals);
    const findBody = this._findBodyStart.bind(this);
    await this.app.vault.process(this.transcriptFile, (content) => {
      const bodyStart = findBody(content);
      return content.slice(0, bodyStart) + body;
    });
  }

  /** Format a timestamp bucket (seconds) as a bold markdown marker. */
  private _formatTimestamp(tsBucket: number): string {
    const mode = this.settings.timestampMode;
    if (mode === "none" || !this.startTime) return "";

    if (mode === "local_time") {
      const wallTime = new Date(this.startTime.getTime() + tsBucket * 1000);
      const h = String(wallTime.getHours()).padStart(2, "0");
      const m = String(wallTime.getMinutes()).padStart(2, "0");
      const s = String(wallTime.getSeconds()).padStart(2, "0");
      return `**[${h}:${m}:${s}]**`;
    }

    // elapsed mode
    const h = Math.floor(tsBucket / 3600);
    const m = Math.floor((tsBucket % 3600) / 60);
    const s = tsBucket % 60;
    return `**[${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}]**`;
  }
}
