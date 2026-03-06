/**
 * Quick-switcher modal for selecting a meeting type on record start.
 * Appears non-blocking -- recording is already in progress when this opens.
 */

import { App, Modal, Setting, SuggestModal } from "obsidian";

/** Sentinel item appended to every suggestion list. */
const ADD_NEW_ITEM = "+ Add new type...";

/**
 * Fuzzy-filter popup that lets the user pick from configured meeting types.
 * Selecting the sentinel item opens NewTypeModal for inline creation.
 */
export class MeetingTypeModal extends SuggestModal<string> {
  private readonly types: string[];
  private readonly onChoose: (type: string | null) => void;
  private resolved = false;

  /**
   * @param app      Obsidian app reference.
   * @param types    Pre-configured meeting type strings.
   * @param onChoose Callback with the chosen type, or null on dismiss.
   */
  constructor(
    app: App,
    types: string[],
    onChoose: (type: string | null) => void,
  ) {
    super(app);
    this.types = types;
    this.onChoose = onChoose;

    this.setPlaceholder("Select meeting type...");
    this.setInstructions([{ command: "Esc", purpose: "keep default name" }]);
  }

  /**
   * Return types matching the query (case-insensitive substring),
   * always with the add-new sentinel at the end.
   */
  getSuggestions(query: string): string[] {
    const lower = query.toLowerCase();
    const filtered = this.types.filter((t) =>
      t.toLowerCase().includes(lower),
    );
    return [...filtered, ADD_NEW_ITEM];
  }

  /** Render a single suggestion row. */
  renderSuggestion(item: string, el: HTMLElement): void {
    el.setText(item);
    if (item === ADD_NEW_ITEM) {
      el.addClass("mn-add-new-type");
    }
  }

  /**
   * Handle the user selecting a suggestion.
   * If the sentinel was picked, open NewTypeModal instead.
   */
  onChooseSuggestion(item: string): void {
    this.resolved = true;
    if (item === ADD_NEW_ITEM) {
      new NewTypeModal(this.app, (value) => {
        this.onChoose(value);
      }).open();
      return;
    }
    this.onChoose(item);
  }

  /** If dismissed without selection, pass null to the callback. */
  onClose(): void {
    super.onClose();
    if (!this.resolved) {
      this.resolved = true;
      this.onChoose(null);
    }
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
