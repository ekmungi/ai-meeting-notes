/**
 * Multi-select modal over `.md` files in the configured stakeholders folder.
 * Enter or the OK button confirms the selection; Esc skips (empty result).
 */

import { App, Modal, Setting, TFile, TFolder, normalizePath } from "obsidian";

export class ParticipantsModal extends Modal {
  private readonly folderPath: string;
  private readonly onChoose: (selected: string[]) => void;
  private readonly selected = new Set<string>();
  private resolved = false;

  /**
   * @param app         Obsidian app reference.
   * @param folderPath  Vault path to the stakeholders folder.
   * @param onChoose    Callback with selected basenames (no .md, no brackets).
   */
  constructor(app: App, folderPath: string, onChoose: (selected: string[]) => void) {
    super(app);
    this.folderPath = folderPath;
    this.onChoose = onChoose;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Select participants" });

    const files = this._listStakeholderFiles();

    if (files.length === 0) {
      contentEl.createEl("p", {
        text: `No markdown files found in "${this.folderPath}". ` +
          `Check the stakeholders folder setting.`,
      });
      this._renderActionRow(contentEl);
      return;
    }

    const listEl = contentEl.createDiv({ cls: "mn-participants-list" });
    listEl.style.maxHeight = "300px";
    listEl.style.overflowY = "auto";
    listEl.style.margin = "0.5em 0";

    for (const file of files) {
      const row = new Setting(listEl).setName(file.basename);
      row.addToggle((toggle) => {
        toggle.setValue(false).onChange((value) => {
          if (value) this.selected.add(file.basename);
          else this.selected.delete(file.basename);
        });
      });
    }

    this._renderActionRow(contentEl);

    // Submit on Enter anywhere inside the modal
    contentEl.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this._submit();
      }
    });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.onChoose([]);
    }
  }

  /** Render OK / Skip row. */
  private _renderActionRow(parent: HTMLElement): void {
    new Setting(parent)
      .addButton((btn) =>
        btn.setButtonText("Skip").onClick(() => {
          this.resolved = true;
          this.close();
          this.onChoose([]);
        }),
      )
      .addButton((btn) =>
        btn.setButtonText("OK").setCta().onClick(() => this._submit()),
      );
  }

  private _submit(): void {
    this.resolved = true;
    const result = Array.from(this.selected);
    this.close();
    this.onChoose(result);
  }

  /** List `.md` files directly under the configured folder (non-recursive). */
  private _listStakeholderFiles(): TFile[] {
    const normalized = normalizePath(this.folderPath);
    const folder = this.app.vault.getAbstractFileByPath(normalized);
    if (!(folder instanceof TFolder)) return [];
    const out: TFile[] = [];
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === "md") {
        out.push(child);
      }
    }
    out.sort((a, b) => a.basename.localeCompare(b.basename));
    return out;
  }
}
