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
      f.path.toLowerCase().includes(lower),
    );
    return [USE_DEFAULT as Item, ...files];
  }

  renderSuggestion(item: Item, el: HTMLElement): void {
    if (item === USE_DEFAULT) {
      el.setText(USE_DEFAULT);
      el.addClass("mn-template-default");
      return;
    }
    // Show path relative to the configured folder so subfolder templates are distinguishable
    const folderPrefix = normalizePath(this.folderPath) + "/";
    const rel = item.path.startsWith(folderPrefix) ? item.path.slice(folderPrefix.length) : item.path;
    el.setText(rel.endsWith(".md") ? rel.slice(0, -3) : rel);
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
    if (this.resolved) return;
    // Defer null fire so a racing onChooseSuggestion can set resolved=true first.
    setTimeout(() => {
      if (this.resolved) return;
      this.resolved = true;
      this.onChoose(null);
    }, 0);
  }

  /** Recursively collect `.md` files under the configured folder. */
  private _listTemplateFiles(): TFile[] {
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
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }
}
