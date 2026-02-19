/**
 * Manages note creation and live transcript updates in the vault.
 *
 * Creates a new note per recording (D025). Output format matches the desktop
 * MarkdownWriter (file-1.md format):
 *   - YAML frontmatter: date, start_time, engine, timestamp_mode, tags
 *   - Title:            # Meeting Notes — YYYY-MM-DD HH:MM  (em dash)
 *   - Section header:   ## Transcript
 *   - Timestamp markers **[HH:MM:SS]** every 5 minutes
 *   - Sentences grouped into paragraphs (new paragraph every 2 minutes)
 *   - Live partials in italic, replaced by final text when utterance ends
 *   - Footer: *Recording ended at ...* / *Duration: ...* / *Segments: ...*
 *
 * Concurrency: handleServerMessage() does not await onTranscript(), so
 * multiple calls can be in-flight. All in-memory state mutations happen
 * BEFORE any await. vault.process() is serialized by Obsidian — each
 * callback fully reconstructs file content from captured state, avoiding
 * any string-search or length-based truncation races.
 */

import { type App, TFile, TFolder, normalizePath } from "obsidian";
import type { MeetingNotesSettings, TranscriptMessage } from "./types";

const PARA_INTERVAL_S = 120; // New paragraph every 2 minutes
const TS_INTERVAL_S = 300;   // Timestamp marker every 5 minutes

/** Format a Date as YYYY-MM-DD_HHmm for use in file names. */
function formatFileTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

/**
 * Build YAML frontmatter + title matching the desktop MarkdownWriter format.
 * Returns the complete header string (everything before the transcript body).
 */
function buildHeader(engine: string, timestampMode: string, startTime: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date =
    `${startTime.getFullYear()}-` +
    `${pad(startTime.getMonth() + 1)}-` +
    `${pad(startTime.getDate())}`;
  const time =
    `${pad(startTime.getHours())}:` +
    `${pad(startTime.getMinutes())}:` +
    `${pad(startTime.getSeconds())}`;
  const displayTime = `${pad(startTime.getHours())}:${pad(startTime.getMinutes())}`;

  return [
    "---",
    `date: ${date}`,
    `start_time: "${time}"`,
    `engine: ${engine}`,
    `timestamp_mode: ${timestampMode}`,
    "tags: [meeting-notes]",
    "---",
    "",
    `# Meeting Notes \u2014 ${date} ${displayTime}`,
    "",
    "## Transcript",
    "",
  ].join("\n");
}

export class TranscriptView {
  private app: App;
  private settings: MeetingNotesSettings;
  private file: TFile | null = null;
  private startTime: Date | null = null;

  /**
   * Paragraph / timestamp state (mirrors MarkdownWriter).
   *
   * The file content at any point is:
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

  constructor(app: App, settings: MeetingNotesSettings) {
    this.app = app;
    this.settings = settings;
  }

  /** Create a new note for the recording and open it in the editor. */
  async createNote(engine: string): Promise<TFile> {
    const now = new Date();
    this.startTime = now;
    this.headerLength = 0;
    this.completedContent = "";
    this.currentParaTexts = [];
    this.currentParaBucket = -1;
    this.lastTsBucket = -1;
    this.partial = "";
    this.segmentCount = 0;

    const folder = this.settings.outputFolder || "Meetings";
    const folderPath = normalizePath(folder);

    const existing = this.app.vault.getAbstractFileByPath(folderPath);
    if (!existing) {
      await this.app.vault.createFolder(folderPath);
    } else if (!(existing instanceof TFolder)) {
      throw new Error(`${folderPath} exists but is not a folder`);
    }

    const fileName = `${formatFileTimestamp(now)} Meeting Notes.md`;
    const filePath = normalizePath(`${folderPath}/${fileName}`);

    const header = buildHeader(engine, this.settings.timestampMode, now);
    this.file = await this.app.vault.create(filePath, header);
    this.headerLength = header.length;

    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(this.file);

    return this.file;
  }

  /** Dispatch an incoming WebSocket transcript message. */
  async onTranscript(msg: TranscriptMessage): Promise<void> {
    if (!this.file) return;
    if (!msg.text.trim()) return;

    if (msg.is_partial) {
      await this._writePartial(msg.text);
    } else {
      await this._writeFinal(msg.text, msg.timestamp_start);
    }
  }

  /** Finalize the note: flush remaining content and write the footer. */
  async finalize(durationSeconds: number): Promise<void> {
    if (!this.file) return;

    // Flush any in-progress paragraph (discard trailing partial)
    this.partial = "";
    if (this.currentParaTexts.length > 0) {
      this.completedContent += this.currentParaTexts.join(" ") + "\n\n";
      this.currentParaTexts = [];
    }

    const endTime = new Date();
    const h = Math.floor(durationSeconds / 3600);
    const m = Math.floor((durationSeconds % 3600) / 60);
    const s = Math.floor(durationSeconds % 60);
    const durationStr = `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    const endTimeStr = endTime.toTimeString().slice(0, 8);
    const count = this.segmentCount;

    const footer =
      `\n---\n\n` +
      `*Recording ended at ${endTimeStr}*\n` +
      `*Duration: ${durationStr}*\n` +
      `*Segments: ${count}*\n`;

    const headerLen = this.headerLength;
    const finalBody = this.completedContent;

    await this.app.vault.process(this.file, (content) => {
      return content.slice(0, headerLen) + finalBody + footer;
    });

    this.file = null;
    this.startTime = null;
  }

  /**
   * Write a live italic partial (replaces the previous partial).
   * State is updated before any await so concurrent calls see the new
   * value immediately and do not double-write.
   */
  private async _writePartial(text: string): Promise<void> {
    if (!this.file || !this.settings.showPartials) return;

    // Update state before yielding
    this.partial = `\n*${text}*`;

    // Snapshot all state for the vault.process closure
    const headerLen = this.headerLength;
    const completed = this.completedContent;
    const paraTexts = [...this.currentParaTexts];
    const capturedPartial = this.partial;

    await this.app.vault.process(this.file, (content) => {
      const header = content.slice(0, headerLen);
      const para = paraTexts.length > 0 ? paraTexts.join(" ") + "\n\n" : "";
      return header + completed + para + capturedPartial;
    });
  }

  /**
   * Write a final (non-partial) segment. Updates paragraph / timestamp state,
   * then rewrites the current section via vault.process.
   */
  private async _writeFinal(text: string, timestampStart: number): Promise<void> {
    if (!this.file) return;

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

    this.currentParaTexts.push(text);
    this.partial = ""; // Clear any pending partial
    this.segmentCount++;

    // Snapshot for vault.process
    const headerLen = this.headerLength;
    const completed = this.completedContent;
    const paraTexts = [...this.currentParaTexts];

    await this.app.vault.process(this.file, (content) => {
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
