// src/shared/modal-dismiss.ts
// Decides whether a click should be treated as a backdrop dismissal.
//
// Meeting setup runs as a chain of modals (type -> template -> participants ->
// description). Obsidian closes a modal when its dimmed backdrop is clicked, so
// one stray click abandoned the rest of the chain and the note was left without
// its type, template or attendees. Pure so the decision is testable; the DOM
// wiring lives in modal-guard.ts.

/** The part of an element this decision needs: can it contain a node. */
export interface ContainsNode {
  contains(node: unknown): boolean;
}

/**
 * True when a click landed on the backdrop rather than inside the dialog.
 *
 * @param target Event target the click was dispatched to.
 * @param dialog The dialog element, or null if unavailable.
 * @returns Whether the click should be swallowed. Unattributable clicks return
 *   false: letting one through is far less harmful than blocking a real
 *   interaction and trapping the user in a modal.
 */
export function isBackdropClick(target: unknown, dialog: ContainsNode | null): boolean {
  if (target === null || target === undefined || dialog === null) return false;
  return !dialog.contains(target);
}
