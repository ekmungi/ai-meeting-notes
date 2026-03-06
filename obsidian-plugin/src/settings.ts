/**
 * Settings tab for the AI Meeting Notes plugin.
 * Plugin stores its own API key and preferences (D024: independent client).
 */

import { AbstractInputSuggest, App, PluginSettingTab, Setting, TextComponent, TFolder } from "obsidian";
import type AIMeetingNotesPlugin from "./main";
import { isEncryptionAvailable } from "./crypto";

/**
 * Autocomplete suggest for vault folders.
 * Filters the vault folder tree as the user types.
 */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
  private onSelectCallback: (path: string) => void;

  constructor(app: App, inputEl: HTMLInputElement, onSelect: (path: string) => void) {
    super(app, inputEl);
    this.onSelectCallback = onSelect;
  }

  getSuggestions(query: string): TFolder[] {
    const lower = query.toLowerCase();
    return this.app.vault.getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder && f.path !== "/")
      .filter((f) => f.path.toLowerCase().includes(lower))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  selectSuggestion(folder: TFolder, _evt: MouseEvent | KeyboardEvent): void {
    this.setValue(folder.path);
    this.onSelectCallback(folder.path);
    this.close();
  }
}

export class MeetingNotesSettingTab extends PluginSettingTab {
  plugin: AIMeetingNotesPlugin;

  constructor(app: App, plugin: AIMeetingNotesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "AI Meeting Notes" });

    // --- Recording Disclaimer ---
    const disclaimerEl = containerEl.createDiv({ cls: "mn-disclaimer" });
    disclaimerEl.createEl("p", {
      text: "This plugin records audio from your microphone and system speakers, which may capture the voices of other meeting participants. Recording meetings may require explicit consent from all participants under applicable laws. You are solely responsible for complying with local recording consent laws.",
    });

    new Setting(disclaimerEl)
      .setName("I understand and accept responsibility")
      .setDesc("You must accept this disclaimer before recording. This setting is saved and only needs to be checked once.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.disclaimerAccepted)
          .onChange(async (value) => {
            this.plugin.settings = { ...this.plugin.settings, disclaimerAccepted: value };
            await this.plugin.saveSettings();
          })
      );

    // --- Server ---
    containerEl.createEl("h3", { text: "Server" });

    let exePathText: TextComponent;

    new Setting(containerEl)
      .setName("Server executable path")
      .setDesc("Path to ai-meeting-notes-server.exe (from the desktop app install)")
      .addText((text) => {
        exePathText = text;
        text
          .setPlaceholder("C:\\Program Files\\AI Meeting Notes\\ai-meeting-notes-server.exe")
          .setValue(this.plugin.settings.serverExePath)
          .onChange(async (value) => {
            this.plugin.settings = { ...this.plugin.settings, serverExePath: value };
            await this.plugin.saveSettings();
          });
      })
      .addButton((btn) => {
        btn.setButtonText("Browse...").onClick(() => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = ".exe";
          input.addEventListener("change", async () => {
            const file = input.files?.[0];
            if (!file) return;
            // Electron attaches the real filesystem path to File objects.
            // The property is non-standard; use optional chaining and nullish
            // coalescing so we get a string even on Electron builds where it
            // is undefined.
            const path = (file as unknown as { path?: string }).path ?? "";
            if (!path) {
              console.warn(
                "AI Meeting Notes: Browse did not return a file path. " +
                "This may happen if Obsidian's Electron version does not expose File.path. " +
                "Please type the path manually."
              );
              return;
            }
            exePathText.setValue(path);
            this.plugin.settings = { ...this.plugin.settings, serverExePath: path };
            await this.plugin.saveSettings();
          }, { once: true });
          input.click();
        });
      });

    new Setting(containerEl)
      .setName("Server port")
      .setDesc("Port for the backend server (default: 9876)")
      .addText((text) =>
        text
          .setPlaceholder("9876")
          .setValue(String(this.plugin.settings.serverPort))
          .onChange(async (value) => {
            const port = parseInt(value, 10);
            if (port >= 1 && port <= 65535) {
              this.plugin.settings = { ...this.plugin.settings, serverPort: port };
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Keep server running after stop")
      .setDesc("If enabled, the server process stays alive after stopping a recording")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.keepServerRunning)
          .onChange(async (value) => {
            this.plugin.settings = { ...this.plugin.settings, keepServerRunning: value };
            await this.plugin.saveSettings();
          })
      );

    // --- Transcription ---
    containerEl.createEl("h3", { text: "Transcription" });

    new Setting(containerEl)
      .setName("AssemblyAI API Key")
      .setDesc("Your API key for cloud transcription (stored locally in Obsidian)")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter your API key")
          .setValue(this.plugin.settings.assemblyaiApiKey)
          .onChange(async (value) => {
            this.plugin.settings = { ...this.plugin.settings, assemblyaiApiKey: value };
            await this.plugin.saveSettings();
          });
      });

    // Warn the user if DPAPI / safeStorage is unavailable so the plaintext risk is visible.
    if (!isEncryptionAvailable()) {
      const warningEl = containerEl.createEl("p", {
        text: "Note: API key encryption is not available on this platform. " +
          "The key is stored as plaintext in plugin data.",
        cls: "mn-settings-warning",
      });
      warningEl.style.color = "var(--text-warning)";
      warningEl.style.fontSize = "0.85em";
      warningEl.style.marginTop = "-0.5em";
    }

    new Setting(containerEl)
      .setName("Engine")
      .setDesc("Transcription engine to use")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("cloud", "Cloud (AssemblyAI)")
          .addOption("local", "Local (Whisper)")
          .addOption("auto", "Auto (cloud with local fallback)")
          .setValue(this.plugin.settings.engine)
          .onChange(async (value) => {
            this.plugin.settings = {
              ...this.plugin.settings,
              engine: value as "cloud" | "local" | "auto",
            };
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Local model")
      .setDesc("Whisper model used when the local engine is selected. Distil models load faster with similar accuracy. Changes take effect on next recording.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("tiny.en", "Tiny (~75 MB) — fastest, basic quality")
          .addOption("base.en", "Base (~145 MB) — fast, decent quality")
          .addOption("distil-small.en", "Distil Small (~166 MB) — fast, good quality")
          .addOption("small.en", "Small (~244 MB) — recommended")
          .addOption("distil-large-v3", "Distil Large v3 (~756 MB) — best quality + speed")
          .addOption("medium.en", "Medium (~769 MB) — high accuracy, slow")
          .setValue(this.plugin.settings.localModelSize)
          .onChange(async (value) => {
            this.plugin.settings = { ...this.plugin.settings, localModelSize: value };
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Endpointing")
      .setDesc("How aggressively to split sentences at pauses")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("conservative", "Conservative (recommended)")
          .addOption("very_conservative", "Very Conservative")
          .addOption("balanced", "Balanced")
          .addOption("aggressive", "Aggressive")
          .setValue(this.plugin.settings.endpointing)
          .onChange(async (value) => {
            this.plugin.settings = {
              ...this.plugin.settings,
              endpointing: value as "conservative" | "very_conservative" | "balanced" | "aggressive",
            };
            await this.plugin.saveSettings();
          })
      );

    // --- Output ---
    containerEl.createEl("h3", { text: "Output" });

    new Setting(containerEl)
      .setName("Output folder")
      .setDesc("Vault folder for meeting notes (created if it doesn't exist). Type to search existing folders.")
      .addText((text) => {
        text
          .setPlaceholder("Meetings")
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings = { ...this.plugin.settings, outputFolder: value };
            await this.plugin.saveSettings();
          });
        new FolderSuggest(this.app, text.inputEl, async (path) => {
          this.plugin.settings = { ...this.plugin.settings, outputFolder: path };
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Timestamp mode")
      .setDesc("How timestamps appear in the transcript")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("elapsed", "Elapsed (00:05:00)")
          .addOption("local_time", "Wall clock (14:30:00)")
          .addOption("none", "No timestamps")
          .setValue(this.plugin.settings.timestampMode)
          .onChange(async (value) => {
            this.plugin.settings = {
              ...this.plugin.settings,
              timestampMode: value as "none" | "local_time" | "elapsed",
            };
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Show live partials")
      .setDesc("Display interim transcript results while recording (cloud engine only)")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showPartials)
          .onChange(async (value) => {
            this.plugin.settings = { ...this.plugin.settings, showPartials: value };
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Record WAV")
      .setDesc("Save a WAV audio file alongside the transcript. ~1.9 MB per minute of recording.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.recordWav)
          .onChange(async (value) => {
            this.plugin.settings = { ...this.plugin.settings, recordWav: value };
            await this.plugin.saveSettings();
          })
      );

    // --- Silence ---
    containerEl.createEl("h3", { text: "Silence Detection" });

    new Setting(containerEl)
      .setName("Silence timer (seconds)")
      .setDesc("Seconds of silence before status bar shows a warning. Set to 0 to disable.")
      .addText((text) =>
        text
          .setPlaceholder("15")
          .setValue(String(this.plugin.settings.silenceTimerSeconds))
          .onChange(async (value) => {
            const seconds = parseInt(value, 10);
            if (!isNaN(seconds) && seconds >= 0 && seconds <= 120) {
              this.plugin.settings = { ...this.plugin.settings, silenceTimerSeconds: seconds };
              await this.plugin.saveSettings();
            }
          })
      );

    // --- Meeting Types ---
    containerEl.createEl("h3", { text: "Meeting Types" });

    new Setting(containerEl)
      .setName("Meeting template")
      .setDesc("Path to an Obsidian note to use as template for new meetings. Leave empty for built-in default. Supports {{meeting_type}}, {{date}}, {{transcript_embed}} variables.")
      .addText((text) => {
        text
          .setPlaceholder("Templates/Meeting Template")
          .setValue(this.plugin.settings.meetingTemplatePath)
          .onChange(async (value) => {
            this.plugin.settings = { ...this.plugin.settings, meetingTemplatePath: value };
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Merge transcript on stop")
      .setDesc("When recording stops, merge the transcript into the notes file and delete the separate transcript file (moved to trash).")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.mergeTranscriptOnStop)
          .onChange(async (value) => {
            this.plugin.settings = { ...this.plugin.settings, mergeTranscriptOnStop: value };
            await this.plugin.saveSettings();
          })
      );

    // Meeting types list
    const typesContainer = containerEl.createDiv({ cls: "mn-meeting-types" });
    this._renderMeetingTypesList(typesContainer);
  }

  /** Render the editable list of meeting types inside the given container. */
  private _renderMeetingTypesList(container: HTMLElement): void {
    container.empty();

    new Setting(container)
      .setName("Meeting types")
      .setDesc("Types available in the quick-switcher when starting a recording.");

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

    for (const meetingType of this.plugin.settings.meetingTypes) {
      new Setting(container)
        .setName(meetingType)
        .addButton((btn) =>
          btn.setButtonText("Remove").onClick(async () => {
            this.plugin.settings = {
              ...this.plugin.settings,
              meetingTypes: this.plugin.settings.meetingTypes.filter((t) => t !== meetingType),
            };
            await this.plugin.saveSettings();
            this._renderMeetingTypesList(container);
          })
        );
    }
  }
}
