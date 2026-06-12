/**
 * Settings tab for the AI Meeting Notes plugin.
 * Plugin stores its own API key and preferences (D024: independent client).
 */

import { App, Notice, PluginSettingTab, Setting, TFile, TFolder } from "obsidian";
import type AIMeetingNotesPlugin from "./main";
import { isEncryptionAvailable } from "./crypto";
import { setDeviceApiKey } from "./device-secret";
import { FolderSuggest } from "./suggest-utils";
import { ParticipantsModal } from "./participants-modal";
import { TemplatePickerModal } from "./template-picker-modal";
import { listInputDevices } from "./audio/devices";

export class MeetingNotesSettingTab extends PluginSettingTab {
  plugin: AIMeetingNotesPlugin;
  private expandedPresetIndex: number | null = null;

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
            setDeviceApiKey(value);            // persist per-device (not synced)
            await this.plugin.saveSettings();  // saveSettings blanks the key in data.json
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
      .setName("Endpointing")
      .setDesc("Trade-off between how fast text appears live and how often a sentence splits at a pause. Faster = more splits.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("aggressive", "Aggressive (snappiest, more splits)")
          .addOption("balanced", "Balanced (recommended)")
          .addOption("conservative", "Conservative (fewer splits, more lag)")
          .addOption("very_conservative", "Very Conservative (least splits, most lag)")
          .setValue(this.plugin.settings.endpointing)
          .onChange(async (value) => {
            this.plugin.settings = {
              ...this.plugin.settings,
              endpointing: value as "conservative" | "very_conservative" | "balanced" | "aggressive",
            };
            await this.plugin.saveSettings();
          })
      );

    // --- Audio ---
    new Setting(containerEl).setName("Audio").setHeading();

    // Microphone picker - enumerating devices needs one mic permission grant,
    // so the dropdown is populated lazily on settings open.
    const micSetting = new Setting(containerEl)
      .setName("Microphone")
      .setDesc("Input device used for recording. Default follows the system setting.");
    micSetting.addDropdown((dd) => {
      dd.addOption("default", "System default");
      void listInputDevices()
        .then((devices) => {
          for (const d of devices.filter((dev) => dev.deviceId !== "default")) {
            dd.addOption(d.deviceId, d.label || d.deviceId.slice(0, 8));
          }
          dd.setValue(this.plugin.settings.micDeviceId);
        })
        .catch((err) => console.error("Device enumeration failed:", err));
      dd.setValue(this.plugin.settings.micDeviceId);
      dd.onChange(async (value) => {
        const devices = await listInputDevices().catch(() => []);
        const label = devices.find((d) => d.deviceId === value)?.label ?? "";
        this.plugin.settings = { ...this.plugin.settings, micDeviceId: value, micDeviceLabel: label };
        await this.plugin.saveSettings();
      });
    });

    new Setting(containerEl)
      .setName("Capture system audio")
      .setDesc("Also record other meeting participants (system loopback). Falls back to microphone-only with a warning if unavailable.")
      .addToggle((t) => t
        .setValue(this.plugin.settings.captureSystemAudio)
        .onChange(async (value) => {
          this.plugin.settings = { ...this.plugin.settings, captureSystemAudio: value };
          await this.plugin.saveSettings();
        }));

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

    new Setting(containerEl)
      .setName("Key terms")
      .setDesc("Names, jargon, or acronyms to boost recognition (comma or newline separated). Contact names are added automatically.")
      .addTextArea((ta) => {
        ta.setValue(this.plugin.settings.keyTerms);
        ta.inputEl.rows = 3;
        ta.inputEl.style.width = "100%";
        ta.onChange(async (value) => {
          this.plugin.settings = { ...this.plugin.settings, keyTerms: value };
          await this.plugin.saveSettings();
        });
      });

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
      .setName("Contacts folder")
      .setDesc("Vault folder containing one .md file per contact/stakeholder. Used for the participants picker. Leave empty to disable.")
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
      .setName("Templates folder")
      .setDesc("Vault folder containing meeting templates. Templates support {{meeting_type}}, {{date}}, {{transcript_embed}}, {{participants}} variables.")
      .addText((text) => {
        text
          .setPlaceholder("Templates/Meetings")
          .setValue(this.plugin.settings.meetingTemplatePath)
          .onChange(async (value) => {
            this.plugin.settings = { ...this.plugin.settings, meetingTemplatePath: value };
            await this.plugin.saveSettings();
          });
        new FolderSuggest(this.app, text.inputEl, async (path) => {
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
          // Auto-expand the newly added preset
          this.expandedPresetIndex = this.plugin.settings.meetingPresets.length - 1;
          this._renderPresetsList(container);
        })
      );

    // Shared data for all presets
    const templateFiles = this._listTemplateFilesForSettings();
    const tplPath = this.plugin.settings.meetingTemplatePath;

    // Render each preset as a collapsible card
    for (let i = 0; i < this.plugin.settings.meetingPresets.length; i++) {
      const preset = this.plugin.settings.meetingPresets[i];
      const presetEl = container.createDiv({ cls: "mn-preset-item" });
      presetEl.style.border = "1px solid var(--background-modifier-border)";
      presetEl.style.borderRadius = "8px";
      presetEl.style.marginBottom = "0.5em";
      presetEl.style.overflow = "hidden";

      // Collapsible header — shows preset name, click to expand/collapse
      const headerEl = presetEl.createDiv({ cls: "mn-preset-header" });
      headerEl.style.display = "flex";
      headerEl.style.alignItems = "center";
      headerEl.style.justifyContent = "space-between";
      headerEl.style.padding = "0.5em 0.75em";
      headerEl.style.cursor = "pointer";
      headerEl.style.userSelect = "none";

      const arrowEl = headerEl.createSpan({ cls: "mn-preset-arrow" });
      arrowEl.style.marginRight = "0.5em";
      arrowEl.style.transition = "transform 0.15s";
      arrowEl.textContent = "\u25B6"; // right-pointing triangle

      const titleEl = headerEl.createSpan({ text: preset.name || "Unnamed Preset" });
      titleEl.style.flex = "1";
      titleEl.style.fontWeight = "500";

      // Summary: show participants count + template name
      const summaryParts: string[] = [];
      if (preset.participants.length > 0) {
        summaryParts.push(`${preset.participants.length} participant${preset.participants.length > 1 ? "s" : ""}`);
      }
      if (preset.templatePath) {
        const tName = preset.templatePath.split("/").pop()?.replace(".md", "") || "";
        if (tName) summaryParts.push(tName);
      }
      if (summaryParts.length > 0) {
        const summaryEl = headerEl.createSpan({ text: summaryParts.join(" | ") });
        summaryEl.style.fontSize = "0.8em";
        summaryEl.style.opacity = "0.6";
        summaryEl.style.marginLeft = "0.5em";
      }

      // Collapsible body
      const bodyEl = presetEl.createDiv({ cls: "mn-preset-body" });
      bodyEl.style.padding = "0 0.75em 0.75em";
      // Restore expanded state if this preset was open before re-render
      const isExpanded = this.expandedPresetIndex === i;
      bodyEl.style.display = isExpanded ? "block" : "none";
      arrowEl.style.transform = isExpanded ? "rotate(90deg)" : "";

      headerEl.addEventListener("click", () => {
        const isOpen = bodyEl.style.display !== "none";
        bodyEl.style.display = isOpen ? "none" : "block";
        arrowEl.style.transform = isOpen ? "" : "rotate(90deg)";
        this.expandedPresetIndex = isOpen ? null : i;
      });

      // --- Body contents ---

      // Preset name
      new Setting(bodyEl)
        .setName("Name")
        .addText((text) => {
          text.setValue(preset.name)
            .setPlaceholder("e.g. 1:1 with Peter")
            .onChange(async (value) => {
              const updated = [...this.plugin.settings.meetingPresets];
              updated[i] = { ...updated[i], name: value };
              this.plugin.settings = { ...this.plugin.settings, meetingPresets: updated };
              await this.plugin.saveSettings();
              // Update header title live
              titleEl.textContent = value || "Unnamed Preset";
            });
        });

      // Meeting type dropdown
      new Setting(bodyEl)
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

      // Template — button opens TemplatePickerModal (files from templates folder)
      {
        const tplLabel = preset.templatePath
          ? (preset.templatePath.split("/").pop()?.replace(".md", "") || preset.templatePath)
          : "(none)";
        new Setting(bodyEl)
          .setName("Template")
          .setDesc(tplLabel)
          .addButton((btn) => {
            btn.setButtonText("Select...").onClick(() => {
              if (!tplPath) {
                // No templates folder configured
                new Notice("Configure a templates folder in Meeting Types first.");
                return;
              }
              new TemplatePickerModal(this.app, tplPath, async (chosen) => {
                const updated = [...this.plugin.settings.meetingPresets];
                updated[i] = { ...updated[i], templatePath: chosen || "" };
                this.plugin.settings = { ...this.plugin.settings, meetingPresets: updated };
                await this.plugin.saveSettings();
                this._renderPresetsList(container);
              }).open();
            });
          });
        // Auto-select if only one template in folder
        if (templateFiles.length === 1 && !preset.templatePath) {
          const updated = [...this.plugin.settings.meetingPresets];
          updated[i] = { ...updated[i], templatePath: templateFiles[0].path };
          this.plugin.settings = { ...this.plugin.settings, meetingPresets: updated };
          void this.plugin.saveSettings();
        }
      }

      // Participants — tags with remove + button opens ParticipantsModal with search
      {
        const tagsEl = bodyEl.createDiv({ cls: "mn-participant-tags" });
        tagsEl.style.display = "flex";
        tagsEl.style.flexWrap = "wrap";
        tagsEl.style.gap = "4px";
        tagsEl.style.marginBottom = "0.5em";

        for (const name of preset.participants) {
          const tag = tagsEl.createEl("span", { text: name, cls: "mn-participant-tag" });
          tag.style.background = "var(--background-modifier-hover)";
          tag.style.padding = "2px 8px";
          tag.style.borderRadius = "12px";
          tag.style.fontSize = "0.85em";
          tag.style.display = "inline-flex";
          tag.style.alignItems = "center";
          tag.style.gap = "4px";
          const removeBtn = tag.createEl("span", { text: "\u00d7" });
          removeBtn.style.cursor = "pointer";
          removeBtn.style.fontWeight = "bold";
          removeBtn.addEventListener("click", async () => {
            const updated = [...this.plugin.settings.meetingPresets];
            updated[i] = { ...updated[i], participants: preset.participants.filter((p) => p !== name) };
            this.plugin.settings = { ...this.plugin.settings, meetingPresets: updated };
            await this.plugin.saveSettings();
            this._renderPresetsList(container);
          });
        }

        const stakeholderFolder = this.plugin.settings.stakeholdersFolder;
        new Setting(bodyEl)
          .setName("Participants")
          .setDesc(preset.participants.length > 0 ? `${preset.participants.length} selected` : "None selected")
          .addButton((btn) => {
            btn.setButtonText("Select...").onClick(() => {
              if (!stakeholderFolder) {
                new Notice("Configure a contacts folder in Meeting Types first.");
                return;
              }
              new ParticipantsModal(
                this.app,
                stakeholderFolder,
                async (selected) => {
                  const updated = [...this.plugin.settings.meetingPresets];
                  updated[i] = { ...updated[i], participants: selected };
                  this.plugin.settings = { ...this.plugin.settings, meetingPresets: updated };
                  await this.plugin.saveSettings();
                  this._renderPresetsList(container);
                },
                preset.participants,
              ).open();
            });
          });
      }

      // Remove button
      new Setting(bodyEl)
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

  /**
   * List `.md` files in the configured stakeholdersFolder (contacts folder).
   * Recursively walks subfolders. Returns [] when the folder is empty or not set.
   */
  private _listContactFiles(): TFile[] {
    const path = this.plugin.settings.stakeholdersFolder;
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
    out.sort((a, b) => a.basename.localeCompare(b.basename));
    return out;
  }
}
