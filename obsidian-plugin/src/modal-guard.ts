// src/modal-guard.ts
// Stops an accidental backdrop click from abandoning the meeting-setup chain.

import type { Modal } from "obsidian";
import { isBackdropClick } from "./shared/modal-dismiss";

/**
 * Make a modal ignore clicks on its dimmed backdrop.
 *
 * Escape is deliberately left alone: it stays the way out when someone means to
 * abandon setup. Only accidental dismissal is prevented.
 *
 * The listener is registered in the CAPTURE phase on the modal container, which
 * runs before the bubble-phase handler Obsidian attaches to the backdrop, so the
 * close never fires.
 *
 * @param modal The modal to protect. Call from onOpen(), after super.onOpen().
 */
export function blockBackdropDismiss(modal: Modal): void {
  modal.containerEl.addEventListener(
    "click",
    (evt: MouseEvent) => {
      if (!isBackdropClick(evt.target, modal.modalEl)) return;
      evt.preventDefault();
      evt.stopPropagation();
    },
    true,
  );
}
