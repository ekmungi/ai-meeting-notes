/**
 * Settings tab for the AI Meeting Notes plugin.
 * Plugin stores its own API key and preferences (D024: independent client).
 */

import { App, PluginSettingTab, Setting, TextComponent, TFile, TFolder } from "obsidian";
import type AIMeetingNotesPlugin from "./main";
import { isEncryptionAvailable } from "./crypto";
import { FolderSuggest, FileSuggest } from "./suggest-utils";

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
        btn.setButtonText("Browse...").onClick(async () => {
          // Use Electron's native dialog for reliable file path access.
          // File.path is unavailable in newer Electron versions.
          try {
            const remote = (window as any).require("@electron/remote");
            const result = await remote.dialog.showOpenDialog({
              title: "Select server executable",
              filters: [{ name: "Executables", extensions: ["exe"] }],
              properties: ["openFile"],
            });
            if (result.canceled || !result.filePaths?.length) return;
            const selectedPath = result.filePaths[0];
            exePathText.setValue(selectedPath);
            this.plugin.settings = { ...this.plugin.settings, serverExePath: selectedPath };
            await this.plugin.saveSettings();
          } catch {
            // Fallback: HTML file input (File.path may work on some builds)
            const input = document.createElement("input");
            input.type = "file";
            input.accept = ".exe";
            input.addEventListener("change", async () => {
              const file = input.files?.[0];
              if (!file) return;
              const filePath = (file as unknown as { path?: string }).path ?? "";
              if (!filePath) return;
              exePathText.setValue(filePath);
              this.plugin.settings = { ...this.plugin.settings, serverExePath: filePath };
              await this.plugin.saveSettings();
            }, { once: true });
            input.click();
          }
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
      .setName("Notes folder")
      .setDesc("Vault folder for meeting notes. If transcript folder is empty, transcripts go here too.")
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
      .setName("Transcript folder")
      .setDesc("Separate folder for transcript files. Leave empty to use the notes folder.")
      .addText((text) => {
        text
          .setPlaceholder("(same as notes folder)")
          .setValue(this.plugin.settings.transcriptFolder)
          .onChange(async (value) => {
            this.plugin.settings = { ...this.plugin.settings, transcriptFolder: value };
            await this.plugin.saveSettings();
          });
        new FolderSuggest(this.app, text.inputEl, async (path) => {
          this.plugin.settings = { ...this.plugin.settings, transcriptFolder: path };
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

    new Setting(containerEl)
      .setName("Speaker labels")
      .setDesc("Show speaker labels in the transcript (cloud engine only). Labels may occasionally be inconsistent in real-time mode.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableDiarization)
          .onChange(async (value) => {
            this.plugin.settings = { ...this.plugin.settings, enableDiarization: value };
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

    // --- Floating Indicator ---
    containerEl.createEl("h3", { text: "Floating Recording Indicator" });

    new Setting(containerEl)
      .setName("Indicator position")
      .setDesc("Where the floating recording indicator appears when Obsidian loses focus during recording.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("top-right", "Top Right")
          .addOption("center-right", "Center Right")
          .addOption("bottom-left", "Bottom Left")
          .setValue(this.plugin.settings.floatingIndicatorPosition)
          .onChange(async (value) => {
            this.plugin.settings = {
              ...this.plugin.settings,
              floatingIndicatorPosition: value as "top-right" | "center-right" | "bottom-left",
            };
            await this.plugin.saveSettings();
          })
      );

    // --- Meeting Types ---
    containerEl.createEl("h3", { text: "Meeting Types" });

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

    new Setting(containerEl)
      .setName("Meeting template")
      .setDesc("Path to a template file OR a folder of templates. If a folder, you'll be prompted to pick a template when starting a recording (unless a per-type mapping is set below). Supports {{meeting_type}}, {{date}}, {{transcript_embed}}, {{participants}} variables.")
      .addText((text) => {
        text
          .setPlaceholder("Templates/Meeting Template")
          .setValue(this.plugin.settings.meetingTemplatePath)
          .onChange(async (value) => {
            this.plugin.settings = { ...this.plugin.settings, meetingTemplatePath: value };
            await this.plugin.saveSettings();
          });
        new FileSuggest(this.app, text.inputEl, async (path) => {
          this.plugin.settings = { ...this.plugin.settings, meetingTemplatePath: path };
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

    // --- Meeting Presets ---
    containerEl.createEl("h3", { text: "Meeting Presets" });
    const presetsContainer = containerEl.createDiv({ cls: "mn-meeting-presets" });
    this._renderPresetsList(presetsContainer);
  }

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
        const folderPrefix = this.plugin.settings.meetingTemplatePath
          ? this.plugin.settings.meetingTemplatePath.replace(/\/+$/, "") + "/"
          : "";
        row.addDropdown((dd) => {
          dd.addOption("", "(default)");
          for (const f of templateFiles) {
            const rel = folderPrefix && f.path.startsWith(folderPrefix)
              ? f.path.slice(folderPrefix.length)
              : f.path;
            const label = rel.endsWith(".md") ? rel.slice(0, -3) : rel;
            dd.addOption(f.path, label);
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

  /** Render the editable list of meeting presets. */
  private _renderPresetsList(container: HTMLElement): void {
    container.empty();

    new Setting(container)
      .setName("Presets")
      .setDesc("Presets combine a meeting type, template, and participants for one-click setup.");

    // Button to add a new blank preset
    new Setting(container)
      .addButton((btn) =>
        btn.setButtonText("Add preset").onClick(async () => {
          const newPreset = {
            name: "New Preset",
            meetingType: this.plugin.settings.meetingTypes[0] || "Meeting Notes",
            templatePath: "",
            participants: [],
          };
          this.plugin.settings = {
            ...this.plugin.settings,
            meetingPresets: [...this.plugin.settings.meetingPresets, newPreset],
          };
          await this.plugin.saveSettings();
          this._renderPresetsList(container);
        })
      );

    // Render each preset as a bordered card
    for (let i = 0; i < this.plugin.settings.meetingPresets.length; i++) {
      const preset = this.plugin.settings.meetingPresets[i];
      const presetEl = container.createDiv({ cls: "mn-preset-item" });
      presetEl.style.border = "1px solid var(--background-modifier-border)";
      presetEl.style.borderRadius = "8px";
      presetEl.style.padding = "0.75em";
      presetEl.style.marginBottom = "0.5em";

      // Preset name
      new Setting(presetEl)
        .setName("Name")
        .addText((text) => {
          text.setValue(preset.name)
            .setPlaceholder("e.g. 1:1 with Peter")
            .onChange(async (value) => {
              const updated = [...this.plugin.settings.meetingPresets];
              updated[i] = { ...updated[i], name: value };
              this.plugin.settings = { ...this.plugin.settings, meetingPresets: updated };
              await this.plugin.saveSettings();
            });
        });

      // Meeting type dropdown sourced from configured types
      new Setting(presetEl)
        .setName("Meeting type")
        .addDropdown((dd) => {
          for (const t of this.plugin.settings.meetingTypes) {
            dd.addOption(t, t);
          }
          dd.setValue(preset.meetingType);
          dd.onChange(async (value) => {
            const updated = [...this.plugin.settings.meetingPresets];
            updated[i] = { ...updated[i], meetingType: value };
            this.plugin.settings = { ...this.plugin.settings, meetingPresets: updated };
            await this.plugin.saveSettings();
          });
        });

      // Template path with FileSuggest autocomplete
      new Setting(presetEl)
        .setName("Template")
        .addText((text) => {
          text.setValue(preset.templatePath)
            .setPlaceholder("Templates/Meeting.md")
            .onChange(async (value) => {
              const updated = [...this.plugin.settings.meetingPresets];
              updated[i] = { ...updated[i], templatePath: value };
              this.plugin.settings = { ...this.plugin.settings, meetingPresets: updated };
              await this.plugin.saveSettings();
            });
          new FileSuggest(this.app, text.inputEl, async (path) => {
            const updated = [...this.plugin.settings.meetingPresets];
            updated[i] = { ...updated[i], templatePath: path };
            this.plugin.settings = { ...this.plugin.settings, meetingPresets: updated };
            await this.plugin.saveSettings();
            text.setValue(path);
          });
        });

      // Participants as comma-separated names
      new Setting(presetEl)
        .setName("Participants")
        .setDesc("Comma-separated stakeholder names (basenames from your stakeholders folder)")
        .addText((text) => {
          text.setValue(preset.participants.join(", "))
            .setPlaceholder("Alice, Bob, Charlie")
            .onChange(async (value) => {
              const names = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
              const updated = [...this.plugin.settings.meetingPresets];
              updated[i] = { ...updated[i], participants: names };
              this.plugin.settings = { ...this.plugin.settings, meetingPresets: updated };
              await this.plugin.saveSettings();
            });
        });

      // Remove button — filters out this preset by index
      new Setting(presetEl)
        .addButton((btn) =>
          btn.setButtonText("Remove preset").setWarning().onClick(async () => {
            const updated = this.plugin.settings.meetingPresets.filter((_, idx) => idx !== i);
            this.plugin.settings = { ...this.plugin.settings, meetingPresets: updated };
            await this.plugin.saveSettings();
            this._renderPresetsList(container);
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
    const walk = (node: TFolder): void => {
      for (const child of node.children) {
        if (child instanceof TFolder) walk(child);
        else if (child instanceof TFile && child.extension === "md") out.push(child);
      }
    };
    walk(abs);
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }
}
