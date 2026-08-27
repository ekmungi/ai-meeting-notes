// src/shared/modal-dismiss.test.ts
// The meeting setup is a chain of modals; an accidental click on the dimmed
// backdrop used to dismiss one and abandon the rest of the sequence.
import { describe, expect, it } from "vitest";
import { isBackdropClick } from "./modal-dismiss";

/** Minimal stand-in for the dialog element's containment check. */
const dialog = (owned: readonly unknown[]) => ({
  contains: (node: unknown) => owned.includes(node),
});

describe("isBackdropClick", () => {
  it("is true when the click lands outside the dialog", () => {
    const backdrop = { id: "backdrop" };
    expect(isBackdropClick(backdrop, dialog([{ id: "button" }]))).toBe(true);
  });

  it("is false when the click lands inside the dialog", () => {
    const button = { id: "button" };
    expect(isBackdropClick(button, dialog([button]))).toBe(false);
  });

  // Never swallow a click we cannot attribute - blocking a real interaction is
  // worse than letting an unattributable one through.
  it("is false when there is no target", () => {
    expect(isBackdropClick(null, dialog([]))).toBe(false);
  });

  it("is false when the dialog reference is missing", () => {
    expect(isBackdropClick({ id: "x" }, null)).toBe(false);
  });
});
