/**
 * Template picker SuggestModal over `.md` files in the configured templates
 * folder. Used when `meetingTemplatePath` is a folder and no per-type mapping
 * exists for the selected meeting type.
 */

import { App, SuggestModal, TFile, TFolder, normalizePath } from "obsidian";

/** Sentinel value selected to indicate "use built-in default (no template)". */
const USE_DEFAULT = "(use built-in default)";
type Item = TFile | typeof USE_DEFAULT;

export class TemplatePickerModal extends SuggestModal<Item> {
  private readonly folderPath: string;
  private readonly onChoose: (path: string | null) => void;
  private resolved = false;

  /**
   * @param app         Obsidian app reference.
   * @param folderPath  Vault path to the templates folder.
   * @param onChoose    Callback with the chosen template path, or null for
   *                    the built-in default (and on dismiss).
   */
  constructor(app: App, folderPath: string, onChoose: (path: string | null) => void) {
    super(app);
    this.folderPath = folderPath;
    this.onChoose = onChoose;
    this.setPlaceholder("Select template...");
    this.setInstructions([{ command: "Esc", purpose: "use built-in default" }]);
  }

  getSuggestions(query: string): Item[] {
    const lower = query.toLowerCase();
    const files = this._listTemplateFiles().filter((f) =>
      f.basename.toLowerCase().includes(lower),
    );
    return [USE_DEFAULT as Item, ...files];
  }

  renderSuggestion(item: Item, el: HTMLElement): void {
    if (item === USE_DEFAULT) {
      el.setText(USE_DEFAULT);
      el.addClass("mn-template-default");
    } else {
      el.setText(item.basename);
    }
  }

  onChooseSuggestion(item: Item): void {
    this.resolved = true;
    if (item === USE_DEFAULT) {
      this.onChoose(null);
    } else {
      this.onChoose(item.path);
    }
  }

  onClose(): void {
    super.onClose();
    if (!this.resolved) {
      this.resolved = true;
      this.onChoose(null);
    }
  }

  private _listTemplateFiles(): TFile[] {
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
