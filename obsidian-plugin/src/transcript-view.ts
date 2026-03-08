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

const PARA_INTERVAL_S = 120; // New paragraph every 2 minutes
const TS_INTERVAL_S = 300;   // Timestamp marker every 5 minutes

/** Format a Date as YYYYMMDD_HH-MM for use in file names. */
function formatFileTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}`
  );
}

/**
 * Build the transcript file header: YAML frontmatter + ## Transcript.
 * Returns the complete header string (everything before the transcript body).
 */
function buildTranscriptHeader(startTime: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date =
    `${startTime.getFullYear()}-` +
    `${pad(startTime.getMonth() + 1)}-` +
    `${pad(startTime.getDate())}`;
  const time =
    `${pad(startTime.getHours())}:` +
    `${pad(startTime.getMinutes())}:` +
    `${pad(startTime.getSeconds())}`;

  return [
    "---",
    `date: ${date}`,
    `start_time: "${time}"`,
    "tags: [meeting-transcript]",
    "---",
    "",
    "## Transcript",
    "",
  ].join("\n");
}

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
   *   header (fixed) + completedContent + currentPara + partial
   *
   * completedContent: all finalized paragraphs and timestamp markers
   * currentParaTexts: sentences being accumulated in the current paragraph
   * currentParaBucket: 2-min bucket index of the current paragraph
   * lastTsBucket:      last timestamp bucket (seconds) written to the file
   * partial:           italic partial text appended at the end, or ""
   * segmentCount:      total final segments written
   */
  private headerLength = 0;
  private completedContent = "";
  private currentParaTexts: string[] = [];
  private currentParaBucket = -1;
  private lastTsBucket = -1;
  private partial = "";
  private segmentCount = 0;
  private lastSpeaker: string | null = null;

  constructor(app: App, settings: MeetingNotesSettings) {
    this.app = app;
    this.settings = settings;
  }

  /**
   * Create two files for the recording and open them side-by-side.
   * Returns the notes file (this.file). The transcript file is stored
   * in this.transcriptFile and receives all streaming updates.
   */
  async createNote(engine: string, meetingType = "Meeting Notes"): Promise<TFile> {
    const now = new Date();
    this.startTime = now;
    this.headerLength = 0;
    this.completedContent = "";
    this.currentParaTexts = [];
    this.currentParaBucket = -1;
    this.lastTsBucket = -1;
    this.partial = "";
    this.segmentCount = 0;
    this.lastSpeaker = null;

    const folder = this.settings.outputFolder || "Meetings";
    const folderPath = normalizePath(folder);

    const existing = this.app.vault.getAbstractFileByPath(folderPath);
    if (!existing) {
      await this.app.vault.createFolder(folderPath);
    } else if (!(existing instanceof TFolder)) {
      throw new Error(`${folderPath} exists but is not a folder`);
    }

    const ts = formatFileTimestamp(now);
    const baseName = `${ts} ${meetingType}`;
    const transcriptBaseName = `${baseName}_transcript`;

    // Create transcript file
    const transcriptPath = normalizePath(`${folderPath}/${transcriptBaseName}.md`);
    const transcriptHeader = buildTranscriptHeader(now);
    this.transcriptFile = await this.app.vault.create(transcriptPath, transcriptHeader);
    this.headerLength = transcriptHeader.length;

    // Create notes file
    const notesPath = normalizePath(`${folderPath}/${baseName}.md`);
    const notesContent = await this._buildNotesContent(meetingType, now, transcriptBaseName);
    this.file = await this.app.vault.create(notesPath, notesContent);

    // Open side-by-side: notes left, transcript right
    const leftLeaf = this.app.workspace.getLeaf("tab");
    await leftLeaf.openFile(this.file);

    const rightLeaf = this.app.workspace.getLeaf("split", "vertical");
    await rightLeaf.openFile(this.transcriptFile);

    return this.file;
  }

  /**
   * Build the notes file content from a user template or built-in default.
   * Replaces {{meeting_type}}, {{date}}, {{transcript_embed}} variables.
   */
  private async _buildNotesContent(
    typeName: string,
    startTime: Date,
    transcriptBaseName: string,
  ): Promise<string> {
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateStr =
      `${startTime.getFullYear()}-` +
      `${pad(startTime.getMonth() + 1)}-` +
      `${pad(startTime.getDate())}`;
    const embedLink = `![[${transcriptBaseName}]]`;

    // Try loading user template
    const templatePath = this.settings.meetingTemplatePath;
    if (templatePath) {
      const normalizedPath = normalizePath(templatePath);
      const templateFile = this.app.vault.getAbstractFileByPath(normalizedPath);
      if (templateFile instanceof TFile) {
        const raw = await this.app.vault.read(templateFile);
        let result = raw
          .replace(/\{\{meeting_type\}\}/g, typeName)
          .replace(/\{\{date\}\}/g, dateStr)
          .replace(/\{\{transcript_embed\}\}/g, embedLink);

        // If template has a ## Transcript section but no embed, insert it
        if (result.includes("## Transcript") && !result.includes(embedLink)) {
          result = result.replace(
            /## Transcript\s*\n/,
            `## Transcript\n${embedLink}\n`,
          );
        }

        return result;
      }
    }

    // Built-in default template
    return [
      "---",
      `type: "${typeName}"`,
      `date: ${dateStr}`,
      "tags: [meeting-notes]",
      "---",
      "",
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

  /** Add audio file reference to the notes file frontmatter. */
  async addWavReference(wavPath: string): Promise<void> {
    if (!this.file) return;
    const wavFilename = wavPath.split(/[/\\]/).pop() || wavPath;
    await this.app.vault.process(this.file, (content) => {
      // Insert audio field into frontmatter
      if (content.startsWith("---")) {
        const endIdx = content.indexOf("---", 3);
        if (endIdx > 0) {
          const frontmatter = content.slice(0, endIdx);
          return frontmatter + `audio: "${wavFilename}"\n` + content.slice(endIdx);
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
      await this._writeFinal(msg.text, msg.timestamp_start, msg.speaker);
    }
  }

  /** Finalize the note: flush remaining content and write the footer. */
  async finalize(durationSeconds: number): Promise<void> {
    if (!this.transcriptFile) return;

    // Flush any in-progress paragraph (discard trailing partial)
    this.partial = "";
    if (this.currentParaTexts.length > 0) {
      this.completedContent += this.currentParaTexts.join(" ") + "\n\n";
      this.currentParaTexts = [];
    }

    const endTime = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const h = Math.floor(durationSeconds / 3600);
    const m = Math.floor((durationSeconds % 3600) / 60);
    const s = Math.floor(durationSeconds % 60);
    const durationStr = `${h}:${pad(m)}:${pad(s)}`;
    const endTimeStr = `${pad(endTime.getHours())}:${pad(endTime.getMinutes())}:${pad(endTime.getSeconds())}`;

    const headerLen = this.headerLength;
    const finalBody = this.completedContent;

    await this.app.vault.process(this.transcriptFile, (content) => {
      // Insert end_time and duration into YAML frontmatter
      const updated = content.replace(
        "tags: [meeting-transcript]\n---",
        `end_time: "${endTimeStr}"\nduration: "${durationStr}"\ntags: [meeting-transcript]\n---`,
      );
      // Find the end of the header (after ## Transcript\n\n)
      const headerEnd = updated.indexOf("## Transcript\n");
      const bodyStart = headerEnd >= 0 ? updated.indexOf("\n", headerEnd) + 2 : headerLen;
      return updated.slice(0, bodyStart) + finalBody;
    });

    // Optionally merge transcript into notes and trash the separate file
    if (this.settings.mergeTranscriptOnStop) {
      await this._mergeTranscript();
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

  /**
   * Rename both files to reflect a new meeting type. Updates the embed link
   * and frontmatter in the notes file to match.
   */
  async renameForType(meetingType: string): Promise<void> {
    if (!this.file || !this.transcriptFile || !this.startTime) return;

    const folder = this.settings.outputFolder || "Meetings";
    const folderPath = normalizePath(folder);
    const ts = formatFileTimestamp(this.startTime);

    const newBaseName = `${ts} ${meetingType}`;
    const newTranscriptBaseName = `${newBaseName}_transcript`;
    const newTranscriptPath = normalizePath(`${folderPath}/${newTranscriptBaseName}.md`);
    const newNotesPath = normalizePath(`${folderPath}/${newBaseName}.md`);

    // Capture old transcript base name for embed replacement
    const oldTranscriptBaseName = this.transcriptFile.basename;

    // Rename transcript file first
    await this.app.fileManager.renameFile(this.transcriptFile, newTranscriptPath);

    // Update embed link and frontmatter type in notes file
    await this.app.vault.process(this.file, (content) => {
      return content
        .replace(`![[${oldTranscriptBaseName}]]`, `![[${newTranscriptBaseName}]]`)
        .replace(/^type:\s*".*"$/m, `type: "${meetingType}"`);
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

    const transcriptContent = await this.app.vault.read(this.transcriptFile);
    const transcriptBaseName = this.transcriptFile.basename;
    const embedLink = `![[${transcriptBaseName}]]`;

    await this.app.vault.process(this.file, (content) => {
      return content.replace(embedLink, transcriptContent);
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
    const headerLen = this.headerLength;
    const completed = this.completedContent;
    const paraTexts = [...this.currentParaTexts];
    const capturedPartial = this.partial;

    await this.app.vault.process(this.transcriptFile, (content) => {
      const header = content.slice(0, headerLen);
      const para = paraTexts.length > 0 ? paraTexts.join(" ") + "\n\n" : "";
      return header + completed + para + capturedPartial;
    });
  }

  /**
   * Write a final (non-partial) segment. Updates paragraph / timestamp state,
   * then rewrites the current section via vault.process.
   */
  private async _writeFinal(text: string, timestampStart: number, speaker: string | null = null): Promise<void> {
    if (!this.transcriptFile) return;

    // --- Synchronous state update (before any await) ---
    const elapsed = Math.max(0, timestampStart);
    const paraBucket = Math.floor(elapsed / PARA_INTERVAL_S);
    const tsBucket = Math.floor(elapsed / TS_INTERVAL_S) * TS_INTERVAL_S;

    const needNewPara = paraBucket !== this.currentParaBucket;
    const needTimestamp =
      this.settings.timestampMode !== "none" && tsBucket > this.lastTsBucket;

    if (needNewPara || needTimestamp) {
      // Flush the current paragraph into completedContent
      if (this.currentParaTexts.length > 0) {
        this.completedContent += this.currentParaTexts.join(" ") + "\n\n";
        this.currentParaTexts = [];
      }
      if (needTimestamp) {
        this.completedContent += this._formatTimestamp(tsBucket) + "\n\n";
        this.lastTsBucket = tsBucket;
      }
      this.currentParaBucket = paraBucket;
    }

    // Prepend speaker label if speaker changed (show on change only, D043)
    let displayText = text;
    if (speaker && speaker !== this.lastSpeaker) {
      displayText = `**[Speaker ${speaker}]** ${text}`;
      this.lastSpeaker = speaker;
    }

    this.currentParaTexts.push(displayText);
    this.partial = ""; // Clear any pending partial
    this.segmentCount++;

    // Snapshot for vault.process
    const headerLen = this.headerLength;
    const completed = this.completedContent;
    const paraTexts = [...this.currentParaTexts];

    await this.app.vault.process(this.transcriptFile, (content) => {
      const header = content.slice(0, headerLen);
      const para = paraTexts.length > 0 ? paraTexts.join(" ") + "\n\n" : "";
      return header + completed + para; // No partial
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
