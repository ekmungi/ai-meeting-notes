/** Electron main process -- creates windows, manages server, handles IPC. */

import { app, BrowserWindow, ipcMain, dialog, shell, screen } from "electron";
import * as path from "path";
import * as fs from "fs";
import { ServerLauncherBase, type HealthCheckFn } from "../shared/server-launcher";
import { serverBaseUrl } from "../shared/types";
import {
  extractTranscriptBody,
  mergeTranscriptIntoSection,
} from "../shared/merge-logic";
import {
  formatFileTimestamp,
  formatIsoTime,
  sanitizeFilename,
  formatDuration,
} from "../shared/format-utils";
import {
  buildNotesYaml,
  buildTranscriptYaml,
  defaultNotesBody,
} from "../shared/yaml-builder";

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const SETTINGS_DIR = path.join(
  process.env.APPDATA || path.join(app.getPath("home"), ".config"),
  "ai-meeting-notes"
);
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");

const DEFAULT_SETTINGS: Record<string, unknown> = {
  server_exe_path: "",
  server_port: 9876,
  assemblyai_api_key: "",
  engine: "cloud",
  timestamp_mode: "elapsed",
  endpointing: "conservative",
  local_model_size: "small.en",
  output_dir: "",
  meeting_types: [
    "One to One", "Standup", "Weekly Sync",
    "Design Review", "Interview", "All Hands",
  ],
  record_wav: false,
  speaker_labels: false,
  open_editor_on_start: true,
  silence_threshold_seconds: 15,
  silence_auto_stop: false,
  floating_indicator_position: "center-right",
};

/* ------------------------------------------------------------------ */
/*  State                                                             */
/* ------------------------------------------------------------------ */

let settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
let mainWindow: BrowserWindow | null = null;
let floatWindow: BrowserWindow | null = null;
let floatReady = false;
let serverLauncher: ServerLauncherBase | null = null;
let isPaused = false;
let isRecording = false;
let currentNotesPath = "";
let currentTranscriptPath = "";
let recordingStartTime: Date | null = null;
let lastTimestampBucket = -1;
let lastSpeaker: string | null = null;

/* ------------------------------------------------------------------ */
/*  Health check (Node fetch)                                         */
/* ------------------------------------------------------------------ */

const nodeHealthCheck: HealthCheckFn = async (baseUrl) => {
  try {
    const resp = await fetch(`${baseUrl}/health`);
    return resp.status === 200;
  } catch {
    return false;
  }
};

/* ------------------------------------------------------------------ */
/*  Settings persistence                                              */
/* ------------------------------------------------------------------ */

/** Load settings from disk, merging with defaults. */
function loadSettings(): Record<string, unknown> {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
      return { ...DEFAULT_SETTINGS, ...data };
    }
  } catch (err) {
    console.error("Failed to load settings:", err);
  }
  return { ...DEFAULT_SETTINGS };
}

/** Merge updates into settings and persist to disk. */
function saveSettings(
  updates: Record<string, unknown>
): Record<string, unknown> {
  settings = { ...settings, ...updates };
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return settings;
}

/* ------------------------------------------------------------------ */
/*  Session history                                                   */
/* ------------------------------------------------------------------ */

interface SessionEntry {
  title: string;
  duration: string;
  path: string;
}

/** Read the output directory and return recent session files. */
function getSessionHistory(): SessionEntry[] {
  const outputDir = resolveOutputDir();
  if (!outputDir || !fs.existsSync(outputDir)) return [];

  const entries: SessionEntry[] = [];
  const files = fs.readdirSync(outputDir)
    .filter((f) => f.endsWith(".md") && !f.includes("_transcript"))
    .sort()
    .reverse()
    .slice(0, 50);

  for (const file of files) {
    const fullPath = path.join(outputDir, file);
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      const yamlMatch = content.match(/^---\n([\s\S]*?)\n---/);
      const yaml = yamlMatch ? yamlMatch[1] : "";
      const typeMatch = yaml.match(/^type:\s*"?([^"\n]+)"?$/m);
      const durMatch = yaml.match(/^duration:\s*"?([^"\n]+)"?$/m);
      entries.push({
        title: typeMatch?.[1]?.trim() || path.basename(file, ".md"),
        duration: durMatch?.[1]?.trim() || "",
        path: fullPath,
      });
    } catch {
      /* skip unreadable files */
    }
  }
  return entries;
}

/** Resolve the output directory, falling back to Documents. */
function resolveOutputDir(): string {
  const dir = settings.output_dir as string;
  if (dir) return dir;
  return path.join(app.getPath("documents"), "AI Meeting Notes");
}

/** Get the bundled or configured server exe path. */
function resolveServerExe(): string {
  const configured = settings.server_exe_path as string;
  if (configured && fs.existsSync(configured)) return configured;

  /* Packaged app: server bundled as extraResource */
  const bundled = path.join(
    process.resourcesPath,
    "server",
    "ai-meeting-notes-server",
    "ai-meeting-notes-server.exe"
  );
  if (fs.existsSync(bundled)) return bundled;

  /* Dev mode: server exe in releases/ relative to project root.
     __dirname is dist-desktop/desktop/ -> 3 levels up = project root */
  const devPath = path.join(
    __dirname, "..", "..", "..",
    "releases",
    "ai-meeting-notes-server",
    "ai-meeting-notes-server.exe"
  );
  if (fs.existsSync(devPath)) return devPath;

  return "";
}

/* ------------------------------------------------------------------ */
/*  Transcript file writer                                            */
/* ------------------------------------------------------------------ */

/** Timestamp interval in seconds (matches Python MarkdownWriter). */
const TIMESTAMP_INTERVAL_S = 300;

/** Format elapsed seconds as HH:MM:SS. */
function formatElapsedTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Create the transcript file with YAML header. */
function initTranscriptFile(filePath: string, startTime: Date): void {
  const yaml = buildTranscriptYaml(startTime, path.basename(currentNotesPath, ".md"));
  fs.writeFileSync(filePath, yaml);
  lastTimestampBucket = -1;
  lastSpeaker = null;
}

/** Append a final transcript segment to the transcript file. */
function appendTranscriptSegment(
  text: string,
  timestampStart: number,
  speaker: string | null,
): void {
  if (!currentTranscriptPath || !fs.existsSync(currentTranscriptPath)) return;

  let output = "";

  /* Timestamp marker every 5 minutes */
  const totalSeconds = Math.max(0, Math.floor(timestampStart));
  const bucket =
    Math.floor(totalSeconds / TIMESTAMP_INTERVAL_S) * TIMESTAMP_INTERVAL_S;
  if (bucket > lastTimestampBucket) {
    lastTimestampBucket = bucket;
    output += `**[${formatElapsedTimestamp(bucket)}]**\n\n`;
  }

  /* Speaker label on change */
  let line = text.trim();
  if (speaker && speaker !== lastSpeaker) {
    line = `**[Speaker ${speaker}]** ${line}`;
    lastSpeaker = speaker;
  }

  output += line + "\n\n";
  fs.appendFileSync(currentTranscriptPath, output);
}

/** Update notes file YAML frontmatter with end_time and duration. */
function finalizeNotesFile(
  notesPath: string,
  durationSeconds: number,
): void {
  if (!notesPath || !fs.existsSync(notesPath)) return;
  const endTime = new Date();
  const endTimeStr = formatIsoTime(endTime);
  const durationStr = formatDuration(durationSeconds);
  let content = fs.readFileSync(notesPath, "utf-8");
  content = content.replace(
    "tags: [meeting-notes]\n---",
    `end_time: "${endTimeStr}"\n` +
    `duration: "${durationStr}"\n` +
    "tags: [meeting-notes]\n---",
  );
  fs.writeFileSync(notesPath, content);
}

/* ------------------------------------------------------------------ */
/*  Windows                                                           */
/* ------------------------------------------------------------------ */

/** Calculate float window position based on settings. */
function getFloatPosition(): { x: number; y: number } {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  const winWidth = 58;
  const winHeight = 116;
  const margin = 4;
  const x = width - winWidth - margin;
  const position = (settings.floating_indicator_position as string) || "center-right";
  let y: number;
  switch (position) {
    case "top-right":
      y = margin;
      break;
    case "bottom-left":
      y = height - winHeight - margin;
      break;
    case "center-right":
    default:
      y = Math.floor((height - winHeight) / 2);
      break;
  }
  return { x, y };
}

/** Create the main application window (560x610, frameless). */
function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 560,
    height: 610,
    frame: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.on("blur", () => {
    if (isRecording && floatReady && floatWindow && !floatWindow.isDestroyed()) floatWindow.show();
  });
  mainWindow.on("focus", () => {
    if (floatWindow && !floatWindow.isDestroyed()) floatWindow.hide();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    if (floatWindow && !floatWindow.isDestroyed()) floatWindow.close();
  });
}

/** Create the floating indicator window (hidden until recording). */
function createFloatWindow(): void {
  const pos = getFloatPosition();
  floatWindow = new BrowserWindow({
    width: 58,
    height: 116,
    x: pos.x,
    y: pos.y,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    focusable: true,
    minimizable: false,
    maximizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  floatReady = false;
  floatWindow.once("ready-to-show", () => { floatReady = true; });
  floatWindow.webContents.once("did-finish-load", () => { floatReady = true; });

  /* Snap to nearest horizontal edge after drag ends. */
  floatWindow.on("moved", () => {
    if (!floatWindow || floatWindow.isDestroyed()) return;
    const [x, y] = floatWindow.getPosition();
    const [w] = floatWindow.getSize();
    const display = screen.getDisplayNearestPoint({ x, y });
    const { x: areaX, width: areaW } = display.workArea;
    const midpoint = areaX + areaW / 2;
    const margin = 4;
    const snappedX = (x + w / 2) < midpoint
      ? areaX + margin                   /* snap left */
      : areaX + areaW - w - margin;      /* snap right */
    floatWindow.setPosition(snappedX, y);
  });

  floatWindow.loadFile(path.join(__dirname, "renderer", "float.html"));
}

/* ------------------------------------------------------------------ */
/*  IPC Handlers                                                      */
/* ------------------------------------------------------------------ */

function registerIpcHandlers(): void {
  /* Settings */
  ipcMain.handle("get-settings", () => settings);
  ipcMain.handle("save-settings", (_e, updates) => saveSettings(updates));

  /* Session history */
  ipcMain.handle("get-session-history", () => getSessionHistory());

  /* Recording */
  ipcMain.handle(
    "start-recording",
    async (_e, engine: string, meetingType: string) => {
      const port = (settings.server_port as number) || 9876;
      const baseUrl = serverBaseUrl(port);

      /* Launch server if needed */
      const exePath = resolveServerExe();
      if (exePath) {
        if (!serverLauncher) {
          serverLauncher = new ServerLauncherBase(nodeHealthCheck);
        }
        try {
          await serverLauncher.launch(exePath, port);
        } catch (err) {
          return { error: String(err) };
        }
      }

      /* Determine output dir */
      const outputDir = resolveOutputDir();
      fs.mkdirSync(outputDir, { recursive: true });

      /* Start recording via server API */
      try {
        const resp = await fetch(`${baseUrl}/session/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            engine,
            assemblyai_api_key: settings.assemblyai_api_key,
            output_dir: outputDir,
            timestamp_mode: settings.timestamp_mode,
            endpointing: settings.endpointing,
            local_model_size: settings.local_model_size,
            record_wav: settings.record_wav,
            speaker_labels: settings.speaker_labels,
            silence_threshold_seconds: settings.silence_threshold_seconds,
            silence_auto_stop: settings.silence_auto_stop,
            meeting_type: meetingType,
          }),
        });
        const result = await resp.json();
        if (!resp.ok) return { error: result.detail || "Server error" };

        /* Create notes file and transcript file */
        const now = new Date();
        recordingStartTime = now;
        const stamp = formatFileTimestamp(now);
        const safeName = sanitizeFilename(meetingType);
        const baseName = `${stamp} - ${safeName}`;
        currentNotesPath = path.join(outputDir, `${baseName}.md`);
        currentTranscriptPath = path.join(outputDir, `${baseName}_transcript.md`);

        const transcriptBaseName = `${baseName}_transcript`;
        const yaml = buildNotesYaml(now, transcriptBaseName, meetingType);
        const body = defaultNotesBody();
        fs.writeFileSync(currentNotesPath, yaml + body);
        initTranscriptFile(currentTranscriptPath, now);

        /* Open in editor if configured */
        if (settings.open_editor_on_start) {
          shell.openPath(currentNotesPath);
        }

        /* Return WS URL for renderer to connect (browser WebSocket API) */
        const wsUrl = baseUrl.replace(/^http/, "ws") + "/ws";

        isPaused = false;
        isRecording = true;
        if (floatReady && floatWindow && !floatWindow.isDestroyed()) floatWindow.show();
        return { engine_name: result.engine || engine, notes_path: currentNotesPath, ws_url: wsUrl };
      } catch (err) {
        return { error: `Failed to start: ${err}` };
      }
    }
  );

  ipcMain.handle("stop-recording", async () => {
    const port = (settings.server_port as number) || 9876;
    const baseUrl = serverBaseUrl(port);

    try {
      const resp = await fetch(`${baseUrl}/session/stop`, { method: "POST" });
      const result = await resp.json();

      /* WebSocket cleanup is handled by renderer */
      isPaused = false;
      isRecording = false;
      recordingStartTime = null;
      if (floatWindow && !floatWindow.isDestroyed()) floatWindow.hide();

      /* Update notes file with end_time and duration */
      const duration = result.duration_seconds || 0;
      finalizeNotesFile(currentNotesPath, duration);

      return {
        output_path: currentTranscriptPath,
        duration_seconds: duration,
      };
    } catch (err) {
      return { error: `Failed to stop: ${err}` };
    }
  });

  ipcMain.handle("pause-recording", async () => {
    const port = (settings.server_port as number) || 9876;
    const baseUrl = serverBaseUrl(port);
    const endpoint = isPaused ? "resume" : "pause";

    try {
      await fetch(`${baseUrl}/session/${endpoint}`, { method: "POST" });
      isPaused = !isPaused;
      return { paused: isPaused };
    } catch (err) {
      return { error: `Pause/resume failed: ${err}` };
    }
  });

  /* Session management */
  ipcMain.handle("delete-session", async (_e, filePath: string) => {
    try {
      await shell.trashItem(filePath);
      /* Also trash matching transcript and wav files */
      const dir = path.dirname(filePath);
      const base = path.basename(filePath, ".md");
      const transcriptPath = path.join(dir, `${base}_transcript.md`);
      const wavPath = path.join(dir, `${base}.wav`);
      if (fs.existsSync(transcriptPath)) await shell.trashItem(transcriptPath);
      if (fs.existsSync(wavPath)) await shell.trashItem(wavPath);
      return { ok: true };
    } catch (err) {
      return { error: `Delete failed: ${err}` };
    }
  });

  ipcMain.handle("merge-notes", () => {
    try {
      if (!currentNotesPath || !currentTranscriptPath) {
        return { error: "No active recording to merge" };
      }
      if (!fs.existsSync(currentNotesPath) || !fs.existsSync(currentTranscriptPath)) {
        return { error: "Notes or transcript file not found" };
      }
      const notesContent = fs.readFileSync(currentNotesPath, "utf-8");
      const rawTranscript = fs.readFileSync(currentTranscriptPath, "utf-8");
      const transcriptBody = extractTranscriptBody(rawTranscript);
      const merged = mergeTranscriptIntoSection(notesContent, transcriptBody);
      fs.writeFileSync(currentNotesPath, merged);
      fs.unlinkSync(currentTranscriptPath);
      return { ok: true };
    } catch (err) {
      return { error: `Merge failed: ${err}` };
    }
  });

  ipcMain.handle("discard-transcript", () => {
    try {
      if (currentTranscriptPath && fs.existsSync(currentTranscriptPath)) {
        fs.unlinkSync(currentTranscriptPath);
      }
      if (currentNotesPath && fs.existsSync(currentNotesPath)) {
        let notes = fs.readFileSync(currentNotesPath, "utf-8");
        notes = notes.replace(/^transcript_file:\s*".*"\n/m, "");
        fs.writeFileSync(currentNotesPath, notes);
      }
      return { ok: true };
    } catch (err) {
      return { error: `Discard failed: ${err}` };
    }
  });

  /* Transcript file writing (renderer -> main for file I/O) */
  ipcMain.handle(
    "write-transcript-segment",
    (_e, text: string, timestampStart: number, speaker: string | null) => {
      appendTranscriptSegment(text, timestampStart, speaker);
    }
  );

  /* File operations */
  ipcMain.handle("browse-directory", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("open-file", (_e, filePath: string) => {
    shell.openPath(filePath);
  });

  /* Window controls */
  ipcMain.handle("minimize-window", () => mainWindow?.minimize());
  ipcMain.handle("close-window", () => mainWindow?.close());

  /* Float window actions */
  ipcMain.on("float-stop", () => {
    mainWindow?.show();
    mainWindow?.focus();
    if (floatWindow && !floatWindow.isDestroyed()) floatWindow.hide();
    mainWindow?.webContents.send("float-stop-clicked");
  });
  ipcMain.on("float-navigate", () => {
    mainWindow?.show();
    mainWindow?.focus();
    if (floatWindow && !floatWindow.isDestroyed()) floatWindow.hide();
  });
}

/* ------------------------------------------------------------------ */
/*  App lifecycle                                                     */
/* ------------------------------------------------------------------ */

app.whenReady().then(() => {
  settings = loadSettings();
  createMainWindow();
  createFloatWindow();
  registerIpcHandlers();
});

app.on("window-all-closed", async () => {
  if (serverLauncher) await serverLauncher.stop();
  app.quit();
});
