/**
 * Multi-select modal over `.md` files in the configured stakeholders folder.
 * Features a search input (select-all on focus) and Obsidian toggle switches
 * per-row. OK button confirms the selection; Skip/Esc returns an empty list.
 */

import { App, Modal, TFile, TFolder, ToggleComponent, normalizePath } from "obsidian";

export class ParticipantsModal extends Modal {
  private readonly folderPath: string;
  private readonly onChoose: (selected: string[]) => void;
  private readonly selected = new Set<string>();
  private resolved = false;
  private allFiles: TFile[] = [];
  private listEl: HTMLElement | null = null;
  private searchQuery = "";

  /**
   * @param app         Obsidian app reference.
   * @param folderPath  Vault path to the contacts/stakeholders folder.
   * @param onChoose    Callback with selected basenames.
   * @param preSelected Optional basenames to pre-check on open.
   */
  constructor(app: App, folderPath: string, onChoose: (selected: string[]) => void, preSelected?: string[]) {
    super(app);
    this.folderPath = folderPath;
    this.onChoose = onChoose;
    if (preSelected) {
      for (const name of preSelected) this.selected.add(name);
    }
  }

  onOpen(): void {
    this._buildContent();
  }

  private _buildContent(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Select participants" });

    this.allFiles = this._listStakeholderFiles();

    if (this.allFiles.length === 0) {
      contentEl.createEl("p", {
        text: `No markdown files found in "${this.folderPath}". Check the stakeholders folder setting.`,
      });
      this._renderActionRow(contentEl);
      return;
    }

    const searchInput = contentEl.createEl("input");
    searchInput.type = "text";
    searchInput.placeholder = "Search stakeholders...";
    searchInput.style.width = "100%";
    searchInput.style.margin = "0.5em 0";
    searchInput.addEventListener("focus", () => searchInput.select());
    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value.toLowerCase();
      this._renderList();
    });
    setTimeout(() => {
      searchInput.focus();
      searchInput.select();
    }, 50);

    this.listEl = contentEl.createDiv({ cls: "mn-participants-list" });
    this.listEl.style.maxHeight = "300px";
    this.listEl.style.overflowY = "auto";
    this.listEl.style.margin = "0.5em 0";
    this.listEl.style.padding = "0.25em 0";
    this.listEl.style.border = "1px solid var(--background-modifier-border)";
    this.listEl.style.borderRadius = "4px";

    this._renderList();
    this._renderActionRow(contentEl);
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.onChoose([]);
    }
  }

  /** Render the filtered list of toggle rows into this.listEl. */
  private _renderList(): void {
    if (!this.listEl) return;
    this.listEl.empty();

    const q = this.searchQuery;
    const filtered = q
      ? this.allFiles.filter((f) => f.basename.toLowerCase().includes(q))
      : this.allFiles;

    if (filtered.length === 0) {
      this.listEl.createEl("div", {
        text: "No matches.",
        cls: "mn-participants-empty",
      }).style.padding = "0.5em";
      return;
    }

    for (const file of filtered) {
      const row = this.listEl.createDiv({ cls: "mn-participant-row" });
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.justifyContent = "space-between";
      row.style.padding = "0.35em 0.6em";
      row.style.gap = "0.75em";

      const nameEl = row.createSpan({ text: file.basename });
      nameEl.style.flex = "1";

      const toggleHost = row.createDiv();
      const toggle = new ToggleComponent(toggleHost);
      toggle.setValue(this.selected.has(file.basename));
      toggle.onChange((value) => {
        if (value) this.selected.add(file.basename);
        else this.selected.delete(file.basename);
      });
    }
  }

  /** Render the Skip / OK buttons using plain DOM for reliable click handling. */
  private _renderActionRow(parent: HTMLElement): void {
    const row = parent.createDiv({ cls: "mn-action-row" });
    row.style.display = "flex";
    row.style.gap = "0.5em";
    row.style.justifyContent = "flex-end";
    row.style.marginTop = "1em";

    const skipBtn = row.createEl("button", { text: "Skip" });
    skipBtn.type = "button";
    skipBtn.addEventListener("click", () => this._finish([]));

    const okBtn = row.createEl("button", { text: "OK", cls: "mod-cta" });
    okBtn.type = "button";
    okBtn.addEventListener("click", () => this._finish(Array.from(this.selected)));
  }

  /**
   * Close the modal first, then invoke onChoose on the next tick.
   * Separating the calls avoids click-handler reentrancy issues where the
   * callback's synchronous work (e.g. opening a new modal) interferes with
   * Obsidian's close animation.
   */
  private _finish(result: string[]): void {
    if (this.resolved) return;
    this.resolved = true;
    const cb = this.onChoose;
    this.close();
    setTimeout(() => cb(result), 0);
  }

  /** Recursively collect `.md` files under the stakeholders folder. */
  private _listStakeholderFiles(): TFile[] {
    const normalized = normalizePath(this.folderPath);
    const folder = this.app.vault.getAbstractFileByPath(normalized);
    if (!(folder instanceof TFolder)) return [];
    const out: TFile[] = [];
    const walk = (node: TFolder): void => {
      for (const child of node.children) {
        if (child instanceof TFolder) walk(child);
        else if (child instanceof TFile && child.extension === "md") out.push(child);
      }
    };
    walk(folder);
    out.sort((a, b) => a.basename.localeCompare(b.basename));
    return out;
  }
}
