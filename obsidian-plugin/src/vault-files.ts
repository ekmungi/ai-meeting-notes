// Small Obsidian-vault helpers shared across the plugin's modal/setting code.

import { App, TFile, TFolder, normalizePath } from "obsidian";

/**
 * Recursively collect the basenames of all `.md` files under a vault folder.
 * Returns [] when the path is empty or not a folder. Sorted alphabetically.
 * Used so keyterm boosting sees the same contacts the participants picker does,
 * including those organized in subfolders.
 */
export function listMarkdownBasenames(app: App, folderPath: string): string[] {
  if (!folderPath) return [];
  const folder = app.vault.getAbstractFileByPath(normalizePath(folderPath));
  if (!(folder instanceof TFolder)) return [];
  const out: string[] = [];
  const walk = (node: TFolder): void => {
    for (const child of node.children) {
      if (child instanceof TFolder) walk(child);
      else if (child instanceof TFile && child.extension === "md") out.push(child.basename);
    }
  };
  walk(folder);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}
