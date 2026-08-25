/**
 * AI Meeting Notes -- Obsidian Plugin
 *
 * Self-contained real-time meeting transcription. Captures microphone and
 * system audio in-process (Web Audio), streams PCM frames directly to
 * AssemblyAI's v3 streaming API over WebSocket, and writes the live
 * transcript to vault notes. No external server process is required.
 */

import {
  Menu,
  Notice,
  Plugin,
  TFile,
  TFolder,
  addIcon,
  normalizePath,
  requestUrl,
} from "obsidian";

import { MeetingNotesSettingTab } from "./settings";
import { MeetingTypeModal } from "./meeting-type-modal";
import { ParticipantsModal } from "./participants-modal";
import { TemplatePickerModal } from "./template-picker-modal";
import { MeetingDescriptionModal } from "./meeting-description-modal";
import { TranscriptView } from "./transcript-view";
import type { MeetingNotesSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { decryptValue, encryptValue } from "./crypto";
import { getDeviceApiKey, setDeviceApiKey, hasDeviceApiKey } from "./device-secret";
import { resolveApiKey } from "./shared/api-key-migration";
import { FloatingIndicator } from "./floating-indicator";
import { RecordingSession } from "./transcription/recording-session";
import { acquireLoopback, acquireMic } from "./audio/capture";
import { AudioPipeline, SAMPLE_RATE } from "./audio/pipeline";
import { AssemblyAIClient } from "./transcription/assemblyai-client";
import { chooseDevice, listInputDevices, watchDevices } from "./audio/devices";
import { migrateSettings } from "./settings-migration";
import { buildKeyTerms } from "./shared/keyterms";
import { listMarkdownBasenames } from "./vault-files";

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

  private session: RecordingSession | null = null;
  private unwatchDevices: (() => void) | null = null;
  private transcriptView: TranscriptView | null = null;
  private ribbonEl: HTMLElement | null = null;
  private statusBarEl: HTMLElement | null = null;
  private state: PluginState = "idle";
  private elapsedSeconds = 0;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;

  // Silence tracking
  private silentSeconds = 0;
  private silenceNotice: Notice | null = null;
  private silenceDismissed = false;
  private silenceAutoStopTimer: ReturnType<typeof setTimeout> | null = null;

  // Floating recording indicator
  private floatingIndicator: FloatingIndicator | null = null;

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

    this.floatingIndicator = new FloatingIndicator(this.app, {
      onStop: () => this.stopRecording(),
      onNavigate: () => {
        if (this.transcriptView) {
          this.transcriptView.navigateToNote();
        }
      },
    });

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
    this.floatingIndicator?.destroy();
    this.flyoutEl?.remove();
    this.flyoutEl = null;
    this.session?.stop().catch(() => undefined);
    this.session = null;
    this.unwatchDevices?.();
    this.unwatchDevices = null;
    this.stopElapsedTimer();
  }

  async loadSettings(): Promise<void> {
    const merged = migrateSettings(await this.loadData());
    // The API key now lives in per-device storage (localStorage), which is not
    // synced by OneDrive/Obsidian Sync. Migrate a legacy synced key once, if it
    // decrypts on this device.
    const legacyDecrypted = merged.assemblyaiApiKey ? decryptValue(merged.assemblyaiApiKey) : "";
    const { key, migrate } = resolveApiKey(getDeviceApiKey(), legacyDecrypted);
    if (migrate) setDeviceApiKey(migrate);
    this.settings = { ...merged, assemblyaiApiKey: key };
  }

  async saveSettings(): Promise<void> {
    const dataToSave = { ...this.settings };
    // Once the key is stored per-device, stop writing it to the synced data.json
    // (blank it). Until then, preserve the legacy encrypted-in-data.json behavior
    // so an existing key is never lost.
    dataToSave.assemblyaiApiKey = hasDeviceApiKey() ? "" : encryptValue(this.settings.assemblyaiApiKey);
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

  /**
   * Collect contact-folder basenames (recursively, including subfolders) for
   * keyterm boosting, matching how the participants picker gathers contacts.
   */
  private _contactNames(): string[] {
    return listMarkdownBasenames(this.app, this.settings.stakeholdersFolder);
  }

  /** Build a RecordingSession wired to real audio + AssemblyAI for current settings. */
  private createSession(): RecordingSession {
    // Exchange the long-lived API key for a short-lived streaming token.
    const tokenProvider = async (): Promise<string> => {
      const resp = await requestUrl({
        url: "https://streaming.assemblyai.com/v3/token?expires_in_seconds=600",
        headers: { authorization: this.settings.assemblyaiApiKey },
        throw: false,
      });
      if (resp.status !== 200) {
        throw new Error(resp.status === 401
          ? "AssemblyAI rejected the API key - check it in settings."
          : `AssemblyAI token request failed (${resp.status}) - are you online?`);
      }
      return resp.json.token;
    };

    return new RecordingSession(
      {
        micDeviceId: this.settings.micDeviceId,
        captureSystemAudio: this.settings.captureSystemAudio,
        recordWav: this.settings.recordWav,
        silenceThresholdSeconds: this.settings.silenceTimerSeconds,
        sampleRate: SAMPLE_RATE,
        onSegment: (seg) => {
          this.silentSeconds = 0;
          this.session?.resetSilence();          // transcript activity proves speech (S8)
          this.transcriptView?.onTranscript({ type: "transcript", ...seg });
        },
        // AssemblyAI refines speaker labels at session end; rewrite the
        // transcript with the corrected ones (ISS-011). Fire-and-forget so a
        // slow vault write cannot wedge the stop path.
        onSpeakerRevision: (revisions) => {
          void this.transcriptView?.applySpeakerRevisions(revisions);
        },
        onSilence: (silentSeconds) => {
          this.silentSeconds = silentSeconds;
          this.updateStatusBar();
          this._handleSilenceAlert(silentSeconds);
        },
        onWarning: (m) => new Notice(m, 8000),
        onError: (m) => new Notice(`Meeting Notes: ${m}`, 8000),
      },
      {
        acquireMic,
        acquireLoopback,
        createPipeline: () => new AudioPipeline(),
        createClient: (onSegment, onError, onSpeakerRevision) => new AssemblyAIClient({
          tokenProvider,
          wsFactory: (url) => new WebSocket(url),
          sampleRate: SAMPLE_RATE,
          endpointing: this.settings.endpointing,
          speechModel: this.settings.speechModel,
          speakerLabels: this.settings.enableDiarization,
          keyTerms: buildKeyTerms(this._contactNames(), this.settings.keyTerms),
          onSegment, onSpeakerRevision, onError,
        }),
      },
    );
  }

  private async startRecording(): Promise<void> {
    if (!this.settings.disclaimerAccepted) {
      new Notice(
        "You must accept the recording disclaimer in AI Meeting Notes settings before recording.",
        8000,
      );
      return;
    }

    if (!this.settings.assemblyaiApiKey) {
      new Notice("Set your AssemblyAI API key in AI Meeting Notes settings.");
      return;
    }

    new Notice(
      "Recording consent: Ensure all participants have been informed this meeting will be recorded. You are responsible for complying with local recording laws.",
      8000,
    );

    this.setState("starting");
    try {
      this.session = this.createSession();
      await this.session.start();

      this.elapsedSeconds = 0;
      this.transcriptView = new TranscriptView(this.app, this.settings);
      await this.transcriptView.createNote("cloud");

      this.setState("recording");
      this.startElapsedTimer();
      this.watchDeviceChanges();
      new Notice("Recording started");

      // Show meeting type modal non-blocking (recording is already running)
      this._showMeetingTypeModal();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to start recording: ${message}`, 8000);
      this.session = null;
      this.setState("idle");
    }
  }

  private async stopRecording(): Promise<void> {
    if (!this.session) return;
    this.hideFlyout();
    this.setState("stopping");
    try {
      const result = await this.session.stop();
      // Add WAV reference BEFORE finalize (finalize nulls the file references)
      if (result.wavBuffer && this.transcriptView) {
        const wavPath = await this.transcriptView.saveWav(result.wavBuffer);
        await this.transcriptView.addWavReference(wavPath);
      }
      await this.transcriptView?.finalize(result.durationSeconds);
      this.stopElapsedTimer();
      new Notice(`Recording stopped (${Math.floor(result.durationSeconds / 60)}m)`);
    } catch (err) {
      new Notice(`Failed to stop recording: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.session = null;
    this.unwatchDevices?.();
    this.unwatchDevices = null;
    this.clearSilenceUi();
    this.setState("idle");
  }

  private pauseRecording(): void {
    this.session?.pause();
    this.stopElapsedTimer();
    this.setState("paused");
    new Notice("Recording paused");
  }

  private resumeRecording(): void {
    this.session?.resume();
    this.setState("recording");
    this.startElapsedTimer();
    new Notice("Recording resumed");
  }

  /** Reset all silence-alert UI state: counter, dismissal flag, notice, auto-stop timer. */
  private clearSilenceUi(): void {
    this.silentSeconds = 0;
    this.silenceDismissed = false;
    this.silenceNotice?.hide();
    this.silenceNotice = null;
    if (this.silenceAutoStopTimer) {
      clearTimeout(this.silenceAutoStopTimer);
      this.silenceAutoStopTimer = null;
    }
  }

  /** React to OS device changes: re-acquire the preferred mic when it returns. */
  private watchDeviceChanges(): void {
    this.unwatchDevices = watchDevices(async () => {
      if (!this.session || this.state === "idle" || this.state === "stopping") return;
      try {
        const devices = await listInputDevices();
        const preferred = this.settings.micDeviceId === "default"
          ? null
          : { id: this.settings.micDeviceId, label: this.settings.micDeviceLabel };
        const target = chooseDevice(preferred, devices);
        await this.session.swapMic(target);
        new Notice(target === this.settings.micDeviceId || target === "default"
          ? "Audio devices changed - microphone re-acquired."
          : "Preferred microphone unavailable - using system default.", 5000);
      } catch (err) {
        console.error("Device recovery failed:", err);
      }
    });
  }

  /** Show the meeting type selector, then chain into template + participants. */
  private _showMeetingTypeModal(): void {
    const modal = new MeetingTypeModal(
      this.app,
      this.settings.meetingTypes,
      this.settings.meetingPresets,
      async (result) => {
        if (!result || !this.transcriptView) return;

        if (result.kind === "preset") {
          // Preset: skip template picker and participants modal entirely
          const { preset } = result;
          this.transcriptView.setTemplateOverride(preset.templatePath || null);
          this.transcriptView.setParticipants(preset.participants);
          this._showDescriptionModal(async (desc) => {
            this.transcriptView?.setDescription(desc);
            await this.transcriptView?.rebuildNotesContent(preset.name);
            await this.transcriptView?.renameForType(preset.name);
          });
          return;
        }

        // Base type: existing chain
        const selectedType = result.value;

        // Persist new types added inline
        if (!this.settings.meetingTypes.includes(selectedType)) {
          this.settings = {
            ...this.settings,
            meetingTypes: [...this.settings.meetingTypes, selectedType],
          };
          await this.saveSettings();
        }

        // Chain: template picker (maybe) -> participants -> description -> rebuild + rename
        this._resolveTemplate(selectedType, (templatePath) => {
          this.transcriptView?.setTemplateOverride(templatePath);
          this._showParticipantsModal((participants) => {
            this.transcriptView?.setParticipants(participants);
            this._showDescriptionModal(async (desc) => {
              this.transcriptView?.setDescription(desc);
              await this.transcriptView?.rebuildNotesContent(selectedType);
              await this.transcriptView?.renameForType(selectedType);
            });
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

  /** Open the description modal; calls done("") on skip/close. */
  private _showDescriptionModal(done: (description: string) => void): void {
    new MeetingDescriptionModal(this.app, done).open();
  }

  // --- Silence alerts ---

  /** Evaluate whether to show or clear a silence alert based on duration. */
  private _handleSilenceAlert(silentSeconds: number): void {
    if (silentSeconds <= 0) {
      this.silentSeconds = 0;
      this.silenceDismissed = false;
      if (this.silenceAutoStopTimer) {
        clearTimeout(this.silenceAutoStopTimer);
        this.silenceAutoStopTimer = null;
      }
      return;
    }
    if (silentSeconds >= 100 && !this.silenceNotice && !this.silenceDismissed) {
      this._showSilenceNotice(silentSeconds);
    }
  }

  /** Display an actionable silence warning notice with Extend/Dismiss/Stop buttons. */
  private _showSilenceNotice(silentSeconds: number): void {
    const frag = document.createDocumentFragment();

    const textEl = document.createElement("div");
    textEl.textContent = `No speech detected for ${Math.floor(silentSeconds)}s. Recording will auto-stop at 120s.`;
    frag.appendChild(textEl);

    const btnRow = document.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.gap = "8px";
    btnRow.style.marginTop = "8px";

    const extendBtn = document.createElement("button");
    extendBtn.textContent = "Extend";
    extendBtn.addEventListener("click", () => {
      this.silentSeconds = 0;
      this.silenceDismissed = false;
      this.silenceNotice?.hide();
      this.silenceNotice = null;
      if (this.silenceAutoStopTimer) {
        clearTimeout(this.silenceAutoStopTimer);
        this.silenceAutoStopTimer = null;
      }
      // Reset the in-session silence monitor so it stops alerting
      this.session?.resetSilence();
    });

    const dismissBtn = document.createElement("button");
    dismissBtn.textContent = "Dismiss";
    dismissBtn.addEventListener("click", () => {
      this.silenceDismissed = true;
      this.silenceNotice?.hide();
      this.silenceNotice = null;
      if (this.silenceAutoStopTimer) {
        clearTimeout(this.silenceAutoStopTimer);
        this.silenceAutoStopTimer = null;
      }
    });

    const stopBtn = document.createElement("button");
    stopBtn.textContent = "Stop Recording";
    stopBtn.addEventListener("click", () => {
      this.silenceNotice?.hide();
      this.silenceNotice = null;
      this.stopRecording();
    });

    btnRow.appendChild(extendBtn);
    btnRow.appendChild(dismissBtn);
    btnRow.appendChild(stopBtn);
    frag.appendChild(btnRow);

    this.silenceNotice = new Notice(frag, 0);

    // Auto-stop after 20s if the user does not interact
    this.silenceAutoStopTimer = setTimeout(() => {
      this.silenceNotice?.hide();
      this.silenceNotice = null;
      this.silenceAutoStopTimer = null;
      new Notice("Auto-stopping: 120s of silence detected.", 5000);
      this.stopRecording();
    }, 20_000);
  }

  // --- UI updates ---

  private setState(state: PluginState): void {
    this.state = state;
    this.updateRibbonIcon();
    this.updateStatusBar();

    // Activate floating indicator when recording, deactivate otherwise
    if (state === "recording" || state === "paused") {
      this.floatingIndicator?.activate(this.settings.floatingIndicatorPosition);
    } else {
      this.floatingIndicator?.deactivate();
    }
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
      const silenceInfo = this.silentSeconds > 0
        ? ` | Silent ${Math.floor(this.silentSeconds)}s`
        : "";
      const dot = this.silentSeconds > 0 ? "\u{1F7E0}" : "\u{1F534}";
      this.statusBarEl.setText(`${dot} ${timeStr}${silenceInfo}`);
      this.statusBarEl.style.cursor = "pointer";
      this.statusBarEl.title = "Click to stop recording. Right-click to switch microphone.";
      this.statusBarEl.oncontextmenu = this.buildMicMenuHandler();
    } else if (this.state === "paused") {
      this.statusBarEl.setText(`\u{23F8}\u{FE0F} ${timeStr} (paused)`);
      this.statusBarEl.style.cursor = "pointer";
      this.statusBarEl.title = "Click to stop recording. Right-click to switch microphone.";
      this.statusBarEl.oncontextmenu = this.buildMicMenuHandler();
    } else if (this.state === "starting") {
      this.statusBarEl.setText("Meeting Notes: Starting...");
      this.statusBarEl.style.cursor = "";
      this.statusBarEl.title = "";
      this.statusBarEl.oncontextmenu = null;
    } else if (this.state === "stopping") {
      this.statusBarEl.setText("Meeting Notes: Stopping...");
      this.statusBarEl.style.cursor = "";
      this.statusBarEl.title = "";
      this.statusBarEl.oncontextmenu = null;
    } else {
      this.statusBarEl.setText("");
      this.statusBarEl.style.cursor = "";
      this.statusBarEl.title = "";
      this.statusBarEl.oncontextmenu = null;
    }
  }

  /**
   * Build the right-click handler for the status bar: shows a microphone
   * picker menu so the user can switch input devices mid-recording.
   */
  private buildMicMenuHandler(): (e: MouseEvent) => void {
    return (e: MouseEvent) => {
      e.preventDefault();
      const menu = new Menu();
      void listInputDevices().then((devices) => {
        for (const d of devices) {
          menu.addItem((i) => i
            .setTitle(d.label || "Unnamed device")
            .setChecked(d.deviceId === this.settings.micDeviceId)
            .onClick(async () => {
              this.settings = { ...this.settings, micDeviceId: d.deviceId, micDeviceLabel: d.label };
              await this.saveSettings();
              await this.session?.swapMic(d.deviceId);
              new Notice(`Microphone: ${d.label || d.deviceId}`);
            }));
        }
        menu.showAtMouseEvent(e);
      });
    };
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
