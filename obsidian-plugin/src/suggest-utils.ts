/**
 * Reusable AbstractInputSuggest subclasses for vault folders and markdown files.
 * Used in settings and any other modal that needs autocomplete on vault paths.
 */

import { AbstractInputSuggest, App, TFile, TFolder } from "obsidian";

/**
 * Autocomplete suggest for vault folders.
 * Filters the vault folder tree as the user types.
 */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  private onSelectCallback: (path: string) => void;

  /**
   * @param app - Obsidian App instance
   * @param inputEl - The text input element to attach to
   * @param onSelect - Called with the chosen folder path
   */
  constructor(app: App, inputEl: HTMLInputElement, onSelect: (path: string) => void) {
    super(app, inputEl);
    this.onSelectCallback = onSelect;
  }

  /** Return folders whose path contains the query string (case-insensitive). */
  getSuggestions(query: string): TFolder[] {
    const lower = query.toLowerCase();
    return this.app.vault.getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder && f.path !== "/")
      .filter((f) => f.path.toLowerCase().includes(lower))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Render a single folder suggestion row. */
  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  /** Accept the selection, update the input, and invoke the callback. */
  selectSuggestion(folder: TFolder, _evt: MouseEvent | KeyboardEvent): void {
    this.setValue(folder.path);
    this.onSelectCallback(folder.path);
    this.close();
  }
}

/**
 * Autocomplete suggest for vault files AND folders.
 * Shows both .md files and folders so users can pick either.
 */
export class FileOrFolderSuggest extends AbstractInputSuggest<TFile | TFolder> {
  private onSelectCallback: (path: string) => void;

  constructor(app: App, inputEl: HTMLInputElement, onSelect: (path: string) => void) {
    super(app, inputEl);
    this.onSelectCallback = onSelect;
  }

  getSuggestions(query: string): (TFile | TFolder)[] {
    const lower = query.toLowerCase();
    const all = this.app.vault.getAllLoadedFiles();
    const folders = all
      .filter((f): f is TFolder => f instanceof TFolder && f.path !== "/" && f.path.toLowerCase().includes(lower));
    const files = all
      .filter((f): f is TFile => f instanceof TFile && f.extension === "md" && f.path.toLowerCase().includes(lower));
    return [...folders, ...files].sort((a, b) => a.path.localeCompare(b.path));
  }

  renderSuggestion(item: TFile | TFolder, el: HTMLElement): void {
    if (item instanceof TFolder) {
      el.setText(`${item.path}/`);
      el.style.fontWeight = "bold";
    } else {
      el.setText(item.path);
    }
  }

  selectSuggestion(item: TFile | TFolder, _evt: MouseEvent | KeyboardEvent): void {
    this.setValue(item.path);
    this.onSelectCallback(item.path);
    this.close();
  }
}

/**
 * Autocomplete suggest for vault markdown files.
 * Filters .md files as the user types.
 */
export class FileSuggest extends AbstractInputSuggest<TFile> {
  private onSelectCallback: (path: string) => void;

  /**
   * @param app - Obsidian App instance
   * @param inputEl - The text input element to attach to
   * @param onSelect - Called with the chosen file path
   */
  constructor(app: App, inputEl: HTMLInputElement, onSelect: (path: string) => void) {
    super(app, inputEl);
    this.onSelectCallback = onSelect;
  }

  /** Return markdown files whose path contains the query string (case-insensitive). */
  getSuggestions(query: string): TFile[] {
    const lower = query.toLowerCase();
    return this.app.vault.getMarkdownFiles()
      .filter((f) => f.path.toLowerCase().includes(lower))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Render a single file suggestion row. */
  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.setText(file.path);
  }

  /** Accept the selection, update the input, and invoke the callback. */
  selectSuggestion(file: TFile, _evt: MouseEvent | KeyboardEvent): void {
    this.setValue(file.path);
    this.onSelectCallback(file.path);
    this.close();
  }
}
