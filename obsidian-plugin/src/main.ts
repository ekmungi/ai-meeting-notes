/**
 * AI Meeting Notes -- Obsidian Plugin
 *
 * Real-time meeting transcription. Spawns the Python backend server exe,
 * connects via WebSocket for live transcript, writes to vault notes.
 *
 * The plugin is an independent client (D024): it stores its own API key
 * and preferences. The server is a stateless transcription service.
 */

import {
  Notice,
  Plugin,
  addIcon,
  requestUrl,
} from "obsidian";

import { MeetingNotesSettingTab } from "./settings";
import { MeetingTypeModal } from "./meeting-type-modal";
import { ServerLauncher } from "./server-launcher";
import { TranscriptView } from "./transcript-view";
import type {
  MeetingNotesSettings,
  PauseResponse,
  ResumeResponse,
  ServerMessage,
  StartResponse,
  StopResponse,
} from "./types";
import { DEFAULT_SETTINGS, serverBaseUrl } from "./types";
import { WsClient } from "./ws-client";
import { decryptValue, encryptValue } from "./crypto";

/** Ribbon icon states. */
type PluginState = "idle" | "starting" | "recording" | "paused" | "stopping";

/** Microphone icon for the ribbon. */
const MIC_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="1" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;

/** Icons used inside the hover flyout. */
const FLYOUT_PAUSE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`;
const FLYOUT_PLAY  = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>`;
const FLYOUT_STOP  = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`;

export default class AIMeetingNotesPlugin extends Plugin {
  settings: MeetingNotesSettings = DEFAULT_SETTINGS;

  private serverLauncher = new ServerLauncher();
  private wsClient: WsClient | null = null;
  private transcriptView: TranscriptView | null = null;
  private ribbonEl: HTMLElement | null = null;
  private statusBarEl: HTMLElement | null = null;
  private state: PluginState = "idle";
  private elapsedSeconds = 0;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private currentEngine = "";

  // Hover flyout
  private flyoutEl: HTMLElement | null = null;
  private flyoutActionEl: HTMLElement | null = null;
  private flyoutHideTimer: ReturnType<typeof setTimeout> | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    addIcon("mic-meeting", MIC_ICON);

    // Single ribbon icon — clicking it starts/pauses/resumes.
    // Hovering it reveals the flyout with explicit action + stop buttons.
    this.ribbonEl = this.addRibbonIcon("mic-meeting", "AI Meeting Notes", () => {
      this.handleRibbonClick();
    });

    this.setupFlyout();

    // Status bar — click to stop when active
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addEventListener("click", () => {
      if (this.state === "recording" || this.state === "paused") {
        this.stopRecording();
      }
    });
    this.updateStatusBar();

    this.addSettingTab(new MeetingNotesSettingTab(this.app, this));

    this.addCommand({
      id: "toggle-recording",
      name: "Toggle recording",
      callback: () => this.handleRibbonClick(),
    });

    this.addCommand({
      id: "start-recording",
      name: "Start recording",
      callback: () => {
        if (this.state === "idle") this.startRecording();
      },
    });

    this.addCommand({
      id: "stop-recording",
      name: "Stop recording",
      callback: () => {
        if (this.state === "recording" || this.state === "paused") this.stopRecording();
      },
    });

    this.addCommand({
      id: "pause-recording",
      name: "Pause recording",
      callback: () => {
        if (this.state === "recording") this.pauseRecording();
      },
    });

    this.addCommand({
      id: "resume-recording",
      name: "Resume recording",
      callback: () => {
        if (this.state === "paused") this.resumeRecording();
      },
    });

    this.setState("idle");
  }

  async onunload(): Promise<void> {
    this.flyoutEl?.remove();
    this.flyoutEl = null;
    this.wsClient?.disconnect();
    this.stopElapsedTimer();
    await this.serverLauncher.stop();
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    const merged = { ...DEFAULT_SETTINGS, ...data };
    // Decrypt the API key from storage so in-memory settings always hold plaintext.
    this.settings = {
      ...merged,
      assemblyaiApiKey: decryptValue(merged.assemblyaiApiKey),
    };
  }

  async saveSettings(): Promise<void> {
    // Encrypt the API key before persisting to disk; in-memory key stays plaintext.
    const dataToSave = {
      ...this.settings,
      assemblyaiApiKey: encryptValue(this.settings.assemblyaiApiKey),
    };
    console.debug("AI Meeting Notes: saving settings", {
      serverExePath: dataToSave.serverExePath,
      serverPort: dataToSave.serverPort,
      engine: dataToSave.engine,
    });
    await this.saveData(dataToSave);
  }

  // --- Recording lifecycle ---

  private handleRibbonClick(): void {
    switch (this.state) {
      case "idle":
        this.startRecording();
        break;
      case "recording":
        this.pauseRecording();
        break;
      case "paused":
        this.resumeRecording();
        break;
      case "starting":
      case "stopping":
        break;
    }
  }

  private async startRecording(): Promise<void> {
    if (!this.settings.disclaimerAccepted) {
      new Notice(
        "You must accept the recording disclaimer in AI Meeting Notes settings before recording.",
        8000,
      );
      return;
    }

    if (!this.settings.serverExePath) {
      new Notice("Configure the server executable path in AI Meeting Notes settings.");
      return;
    }

    new Notice(
      "Recording consent: Ensure all participants have been informed this meeting will be recorded. You are responsible for complying with local recording laws.",
      8000,
    );

    this.setState("starting");

    try {
      console.log("AI Meeting Notes: [1] Launching server...");
      await this.serverLauncher.launch(
        this.settings.serverExePath,
        this.settings.serverPort
      );
      console.log("AI Meeting Notes: [1] Server launched successfully.");

      const baseUrl = serverBaseUrl(this.settings.serverPort);

      console.log("AI Meeting Notes: [2] Connecting WebSocket...");
      this.wsClient = new WsClient(baseUrl);
      this.wsClient.onMessage = (msg: ServerMessage) => {
        this.handleServerMessage(msg);
      };
      this.wsClient.connect();

      console.log("AI Meeting Notes: [3] Posting /session/start...");
      const startBody = {
        engine: this.settings.engine,
        assemblyai_api_key: this.settings.assemblyaiApiKey,
        timestamp_mode: this.settings.timestampMode,
        endpointing: this.settings.endpointing,
        local_model_size: this.settings.localModelSize,
        silence_threshold_seconds: this.settings.silenceTimerSeconds,
      };

      const resp = await requestUrl({
        url: `${baseUrl}/session/start`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(startBody),
        throw: false,
      });

      console.log(`AI Meeting Notes: [3] /session/start response status: ${resp.status}`);

      if (resp.status < 200 || resp.status >= 300) {
        const errorMsg = (() => {
          try { return resp.json.error || `Server returned ${resp.status}`; } catch { return `Server returned ${resp.status}`; }
        })();
        throw new Error(errorMsg);
      }

      const data: StartResponse = resp.json;
      this.currentEngine = data.engine;
      this.elapsedSeconds = 0;

      console.log("AI Meeting Notes: [4] Creating vault note...");
      this.transcriptView = new TranscriptView(this.app, this.settings);
      await this.transcriptView.createNote(data.engine);

      this.setState("recording");
      this.startElapsedTimer();

      new Notice(`Recording started (${data.engine} engine)`);

      // Show meeting type modal non-blocking (recording is already running)
      this._showMeetingTypeModal();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const serverStderr = this.serverLauncher.lastError;
      console.error("AI Meeting Notes: startRecording failed:", err);
      if (serverStderr) console.error("AI Meeting Notes: Server stderr:", serverStderr);
      const detail = serverStderr ? `\nServer: ${serverStderr.slice(0, 150)}` : "";
      new Notice(`Failed to start recording: ${message}${detail}`);

      this.wsClient?.disconnect();
      this.wsClient = null;
      await this.serverLauncher.stop();
      this.setState("idle");
    }
  }

  private async stopRecording(): Promise<void> {
    this.hideFlyout();
    this.setState("stopping");
    const baseUrl = serverBaseUrl(this.settings.serverPort);

    try {
      const resp = await requestUrl({
        url: `${baseUrl}/session/stop`,
        method: "POST",
        throw: false,
      });

      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(resp.json.error || `Server returned ${resp.status}`);
      }

      const data: StopResponse = resp.json;
      await this.transcriptView?.finalize(data.duration_seconds);
      this.stopElapsedTimer();

      const minutes = Math.floor(data.duration_seconds / 60);
      new Notice(`Recording stopped (${minutes}m)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to stop recording: ${message}`);
    }

    this.wsClient?.disconnect();
    this.wsClient = null;

    if (!this.settings.keepServerRunning) {
      await this.serverLauncher.stop();
    }

    this.setState("idle");
  }

  private async pauseRecording(): Promise<void> {
    const baseUrl = serverBaseUrl(this.settings.serverPort);

    try {
      const resp = await requestUrl({
        url: `${baseUrl}/session/pause`,
        method: "POST",
        throw: false,
      });

      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(resp.json.error || `Server returned ${resp.status}`);
      }

      const data: PauseResponse = resp.json;
      this.elapsedSeconds = data.elapsed_seconds;
      this.stopElapsedTimer();
      this.setState("paused");
      new Notice("Recording paused");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to pause: ${message}`);
    }
  }

  private async resumeRecording(): Promise<void> {
    const baseUrl = serverBaseUrl(this.settings.serverPort);

    try {
      const resp = await requestUrl({
        url: `${baseUrl}/session/resume`,
        method: "POST",
        throw: false,
      });

      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(resp.json.error || `Server returned ${resp.status}`);
      }

      const data: ResumeResponse = resp.json;
      this.elapsedSeconds = data.elapsed_seconds;
      this.setState("recording");
      this.startElapsedTimer();
      new Notice("Recording resumed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to resume: ${message}`);
    }
  }

  private handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "transcript":
        this.transcriptView?.onTranscript(msg);
        break;
      case "status":
        this.elapsedSeconds = msg.elapsed_seconds;
        this.updateStatusBar();
        if (msg.state === "stopped" && (this.state === "recording" || this.state === "paused")) {
          this.onRecordingStopped();
        }
        break;
      case "error":
        new Notice(`Meeting Notes: ${msg.message}`);
        if (this.state === "recording" || this.state === "paused") {
          this.onRecordingStopped();
        }
        break;
      case "pong":
        break;
    }
  }

  private async onRecordingStopped(): Promise<void> {
    await this.transcriptView?.finalize(this.elapsedSeconds);
    this.stopElapsedTimer();
    this.wsClient?.disconnect();
    this.wsClient = null;

    if (!this.settings.keepServerRunning) {
      await this.serverLauncher.stop();
    }

    this.setState("idle");
  }

  /** Show the meeting type selector. Recording is already active. */
  private _showMeetingTypeModal(): void {
    const modal = new MeetingTypeModal(
      this.app,
      this.settings.meetingTypes,
      async (selectedType) => {
        if (!selectedType || !this.transcriptView) return;
        await this.transcriptView.renameForType(selectedType);
        // Persist new types added inline
        if (!this.settings.meetingTypes.includes(selectedType)) {
          this.settings = {
            ...this.settings,
            meetingTypes: [...this.settings.meetingTypes, selectedType],
          };
          await this.saveSettings();
        }
      },
    );
    modal.open();
  }

  // --- UI updates ---

  private setState(state: PluginState): void {
    this.state = state;
    this.updateRibbonIcon();
    this.updateStatusBar();
  }

  private updateRibbonIcon(): void {
    if (!this.ribbonEl) return;

    this.ribbonEl.removeClass("mn-idle", "mn-starting", "mn-recording", "mn-paused", "mn-stopping");

    const tooltips: Record<PluginState, string> = {
      idle:      "AI Meeting Notes: Click to start recording",
      starting:  "AI Meeting Notes: Starting...",
      recording: "AI Meeting Notes: Recording — hover for controls",
      paused:    "AI Meeting Notes: Paused — hover for controls",
      stopping:  "AI Meeting Notes: Stopping...",
    };

    this.ribbonEl.addClass(`mn-${this.state}`);
    this.ribbonEl.setAttribute("aria-label", tooltips[this.state]);

    // Update flyout content to match current state
    this.updateFlyout();

    // Hide flyout if we left an active state
    if (this.state !== "recording" && this.state !== "paused") {
      this.hideFlyout();
    }
  }

  private updateStatusBar(): void {
    if (!this.statusBarEl) return;

    const mins = Math.floor(this.elapsedSeconds / 60);
    const secs = Math.floor(this.elapsedSeconds % 60);
    const timeStr = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;

    if (this.state === "recording") {
      this.statusBarEl.setText(`${this.currentEngine} | ${timeStr}`);
      this.statusBarEl.style.cursor = "pointer";
      this.statusBarEl.title = "Click to stop recording";
    } else if (this.state === "paused") {
      this.statusBarEl.setText(`${this.currentEngine} | ${timeStr} (paused)`);
      this.statusBarEl.style.cursor = "pointer";
      this.statusBarEl.title = "Click to stop recording";
    } else if (this.state === "starting") {
      this.statusBarEl.setText("Meeting Notes: Starting...");
      this.statusBarEl.style.cursor = "";
      this.statusBarEl.title = "";
    } else if (this.state === "stopping") {
      this.statusBarEl.setText("Meeting Notes: Stopping...");
      this.statusBarEl.style.cursor = "";
      this.statusBarEl.title = "";
    } else {
      this.statusBarEl.setText("");
      this.statusBarEl.style.cursor = "";
      this.statusBarEl.title = "";
    }
  }

  // --- Hover flyout ---

  /**
   * Build the flyout DOM once and attach hover listeners to the ribbon icon.
   * The flyout is appended to document.body using position:fixed so it is
   * never clipped by the ribbon's overflow context.
   */
  private setupFlyout(): void {
    if (!this.ribbonEl) return;

    const flyout = document.createElement("div");
    flyout.className = "mn-flyout";

    // Action button (pause / resume — mirrors clicking the ribbon icon)
    const actionBtn = document.createElement("button");
    actionBtn.className = "mn-flyout-btn mn-flyout-action";
    actionBtn.innerHTML = FLYOUT_PAUSE;
    actionBtn.setAttribute("aria-label", "Pause recording");
    actionBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.hideFlyout();
      this.handleRibbonClick();
    });

    // Divider
    const sep = document.createElement("div");
    sep.className = "mn-flyout-sep";

    // Stop button
    const stopBtn = document.createElement("button");
    stopBtn.className = "mn-flyout-btn mn-flyout-stop";
    stopBtn.innerHTML = FLYOUT_STOP;
    stopBtn.setAttribute("aria-label", "Stop recording");
    stopBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.hideFlyout();
      if (this.state === "recording" || this.state === "paused") this.stopRecording();
    });

    flyout.appendChild(actionBtn);
    flyout.appendChild(sep);
    flyout.appendChild(stopBtn);
    document.body.appendChild(flyout);

    this.flyoutEl = flyout;
    this.flyoutActionEl = actionBtn;

    // Show on hover over ribbon icon
    this.ribbonEl.addEventListener("mouseenter", () => {
      if (this.state === "recording" || this.state === "paused") {
        this.showFlyout();
      }
    });
    this.ribbonEl.addEventListener("mouseleave", () => this.scheduleFlyoutHide());

    // Keep visible when cursor moves into the flyout
    flyout.addEventListener("mouseenter", () => this.cancelFlyoutHide());
    flyout.addEventListener("mouseleave", () => this.scheduleFlyoutHide());
  }

  /** Sync action button content to the current state. */
  private updateFlyout(): void {
    if (!this.flyoutActionEl) return;
    if (this.state === "recording") {
      this.flyoutActionEl.innerHTML = FLYOUT_PAUSE;
      this.flyoutActionEl.setAttribute("aria-label", "Pause recording");
    } else if (this.state === "paused") {
      this.flyoutActionEl.innerHTML = FLYOUT_PLAY;
      this.flyoutActionEl.setAttribute("aria-label", "Resume recording");
    }
  }

  private showFlyout(): void {
    if (!this.flyoutEl || !this.ribbonEl) return;
    this.cancelFlyoutHide();
    this.updateFlyout();

    const rect = this.ribbonEl.getBoundingClientRect();
    this.flyoutEl.style.top  = `${rect.top + rect.height / 2}px`;
    this.flyoutEl.style.left = `${rect.right + 8}px`;
    this.flyoutEl.classList.add("mn-flyout--visible");
  }

  private hideFlyout(): void {
    this.cancelFlyoutHide();
    this.flyoutEl?.classList.remove("mn-flyout--visible");
  }

  private scheduleFlyoutHide(): void {
    this.cancelFlyoutHide();
    this.flyoutHideTimer = setTimeout(() => this.hideFlyout(), 180);
  }

  private cancelFlyoutHide(): void {
    if (this.flyoutHideTimer !== null) {
      clearTimeout(this.flyoutHideTimer);
      this.flyoutHideTimer = null;
    }
  }

  // --- Elapsed timer ---

  private startElapsedTimer(): void {
    this.stopElapsedTimer();
    this.elapsedTimer = setInterval(() => {
      this.elapsedSeconds += 1;
      this.updateStatusBar();
    }, 1000);
  }

  private stopElapsedTimer(): void {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
  }
}
