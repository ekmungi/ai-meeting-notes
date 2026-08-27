/**
 * Single-field modal capturing an optional free-text meeting description.
 * Enter or OK confirms the typed value; Skip / Esc / close returns "".
 * Mirrors participants-modal: defers the callback past close() to avoid
 * close-reentrancy when the callback kicks off file work.
 */
import { App, Modal } from "obsidian";
import { blockBackdropDismiss } from "./modal-guard";

export class MeetingDescriptionModal extends Modal {
  private readonly onSubmit: (description: string) => void;
  private resolved = false;
  private value = "";

  /**
   * @param app       Obsidian app reference.
   * @param onSubmit  Callback with the trimmed description ("" if skipped).
   */
  constructor(app: App, onSubmit: (description: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    blockBackdropDismiss(this);
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Meeting description" });
    contentEl.createEl("p", {
      text: "Optional. Added to the file name. Leave blank to skip.",
    });

    const input = contentEl.createEl("input");
    input.type = "text";
    input.placeholder = "e.g. Q3 Planning";
    input.style.width = "100%";
    input.style.margin = "0.5em 0";
    input.addEventListener("input", () => { this.value = input.value; });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this._finish(this.value); }
    });
    setTimeout(() => input.focus(), 50);

    const row = contentEl.createDiv();
    row.style.display = "flex";
    row.style.gap = "0.5em";
    row.style.justifyContent = "flex-end";
    row.style.marginTop = "1em";

    const skipBtn = row.createEl("button", { text: "Skip" });
    skipBtn.type = "button";
    skipBtn.addEventListener("click", () => this._finish(""));

    const okBtn = row.createEl("button", { text: "OK", cls: "mod-cta" });
    okBtn.type = "button";
    okBtn.addEventListener("click", () => this._finish(this.value));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.onSubmit("");
    }
  }

  /** Close first, then fire the callback on the next tick. */
  private _finish(result: string): void {
    if (this.resolved) return;
    this.resolved = true;
    const cb = this.onSubmit;
    this.close();
    setTimeout(() => cb(result.trim()), 0);
  }
}
