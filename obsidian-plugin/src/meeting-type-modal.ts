/**
 * Quick-switcher modal for selecting a meeting type or preset on record start.
 * Appears non-blocking -- recording is already in progress when this opens.
 */

import { App, Modal, Setting, SuggestModal } from "obsidian";
import type { MeetingPreset } from "./shared/types";
import { blockBackdropDismiss } from "./modal-guard";

/** Discriminated union for items rendered in the suggestion list. */
type ModalItem =
  | { kind: "type"; value: string }
  | { kind: "separator" }
  | { kind: "preset"; preset: MeetingPreset }
  | { kind: "add-new" };

/** Result passed to the onChoose callback. */
export type ModalResult =
  | { kind: "type"; value: string }
  | { kind: "preset"; preset: MeetingPreset }
  | null;

/**
 * Fuzzy-filter popup that lets the user pick from configured meeting types
 * or named presets. Selecting "+ Add new type..." opens NewTypeModal inline.
 */
export class MeetingTypeModal extends SuggestModal<ModalItem> {
  private readonly types: string[];
  private readonly presets: MeetingPreset[];
  private readonly onChoose: (result: ModalResult) => void;
  private resolved = false;

  /**
   * @param app      Obsidian app reference.
   * @param types    Pre-configured meeting type strings.
   * @param presets  Named presets combining type + template + participants.
   * @param onChoose Callback with the chosen result, or null on dismiss.
   */
  constructor(
    app: App,
    types: string[],
    presets: MeetingPreset[],
    onChoose: (result: ModalResult) => void,
  ) {
    super(app);
    this.types = types;
    this.presets = presets;
    this.onChoose = onChoose;

    this.setPlaceholder("Select meeting type...");
    this.setInstructions([{ command: "Esc", purpose: "keep default name" }]);
  }

  /** Guard the setup chain against an accidental backdrop click. */
  onOpen(): void {
    super.onOpen();
    blockBackdropDismiss(this);
  }

  /**
   * Return types and presets matching the query (case-insensitive substring).
   * Presets are separated by a visual separator item and always follow types.
   * The add-new sentinel is always appended last.
   */
  getSuggestions(query: string): ModalItem[] {
    const lower = query.toLowerCase();
    const filteredTypes = this.types
      .filter((t) => t.toLowerCase().includes(lower))
      .map((t): ModalItem => ({ kind: "type", value: t }));
    const filteredPresets = this.presets
      .filter((p) => p.name.toLowerCase().includes(lower))
      .map((p): ModalItem => ({ kind: "preset", preset: p }));
    const items: ModalItem[] = [...filteredTypes];
    if (filteredPresets.length > 0) {
      items.push({ kind: "separator" });
      items.push(...filteredPresets);
    }
    items.push({ kind: "add-new" });
    return items;
  }

  /** Render a single suggestion row based on its kind. */
  renderSuggestion(item: ModalItem, el: HTMLElement): void {
    switch (item.kind) {
      case "type":
        el.setText(item.value);
        break;
      case "separator":
        el.setText("--- Presets ---");
        el.addClass("mn-separator");
        el.style.opacity = "0.5";
        el.style.pointerEvents = "none";
        el.style.fontStyle = "italic";
        el.style.textAlign = "center";
        break;
      case "preset":
        el.setText(item.preset.name);
        el.addClass("mn-preset-item");
        break;
      case "add-new":
        el.setText("+ Add new type...");
        el.addClass("mn-add-new-type");
        break;
    }
  }

  /**
   * Handle the user selecting a suggestion.
   * Separator items are no-ops. Add-new opens NewTypeModal.
   */
  onChooseSuggestion(item: ModalItem): void {
    // Separator rows are non-interactive; skip them
    if (item.kind === "separator") return;
    this.resolved = true;
    switch (item.kind) {
      case "type":
        this.onChoose({ kind: "type", value: item.value });
        break;
      case "preset":
        this.onChoose({ kind: "preset", preset: item.preset });
        break;
      case "add-new":
        new NewTypeModal(this.app, (value) => {
          if (value) {
            this.onChoose({ kind: "type", value });
          } else {
            this.onChoose(null);
          }
        }).open();
        break;
    }
  }

  /**
   * If dismissed without selection, pass null to the callback.
   * Defer via setTimeout: Obsidian fires onClose BEFORE onChooseSuggestion
   * when the user picks an item, so we let onChooseSuggestion win the race.
   */
  onClose(): void {
    super.onClose();
    if (this.resolved) return;
    setTimeout(() => {
      if (this.resolved) return;
      this.resolved = true;
      this.onChoose(null);
    }, 0);
  }
}

/**
 * Simple modal with a text input for creating a new meeting type inline.
 * Submits on Enter or button click; passes null if dismissed.
 */
class NewTypeModal extends Modal {
  private readonly onSubmit: (value: string | null) => void;
  private submitted = false;

  /**
   * @param app      Obsidian app reference.
   * @param onSubmit Callback with the new type name, or null on dismiss.
   */
  constructor(app: App, onSubmit: (value: string | null) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  /** Build the modal content: heading, text input, and submit button. */
  onOpen(): void {
    blockBackdropDismiss(this);
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "New meeting type" });

    let inputValue = "";

    const setting = new Setting(contentEl).setName("Type name").addText(
      (text) => {
        text.setPlaceholder("e.g. Sprint Planning");
        text.onChange((value) => {
          inputValue = value;
        });

        // Submit on Enter key
        text.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter" && inputValue.trim().length > 0) {
            ev.preventDefault();
            this.submit(inputValue.trim());
          }
        });

        // Auto-focus the text input after the modal renders
        setTimeout(() => text.inputEl.focus(), 50);
      },
    );

    setting.addButton((btn) => {
      btn.setButtonText("Add").setCta().onClick(() => {
        if (inputValue.trim().length > 0) {
          this.submit(inputValue.trim());
        }
      });
    });
  }

  /**
   * Mark as submitted, close the modal, and invoke the callback.
   * @param value The trimmed type name.
   */
  private submit(value: string): void {
    this.submitted = true;
    this.close();
    this.onSubmit(value);
  }

  /** If dismissed without submitting, pass null to the callback. */
  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
    if (!this.submitted) {
      this.submitted = true;
      this.onSubmit(null);
    }
  }
}
