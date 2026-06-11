// Tests for key-term assembly (merge contacts + user terms, dedupe, cap).
import { describe, expect, it } from "vitest";
import { buildKeyTerms } from "./keyterms";

describe("buildKeyTerms", () => {
  it("merges contact names and parses comma/newline user terms", () => {
    expect(buildKeyTerms(["Alice Smith"], "Acme Corp, KPI\nOKR"))
      .toEqual(["Alice Smith", "Acme Corp", "KPI", "OKR"]);
  });
  it("dedupes case-insensitively, preserving first spelling", () => {
    expect(buildKeyTerms(["Alice"], "alice, ALICE, Bob")).toEqual(["Alice", "Bob"]);
  });
  it("drops terms longer than 50 chars and blanks", () => {
    const long = "x".repeat(51);
    expect(buildKeyTerms([], `${long}, , ok`)).toEqual(["ok"]);
  });
  it("caps at 100 terms", () => {
    const many = Array.from({ length: 120 }, (_, i) => `t${i}`).join(",");
    expect(buildKeyTerms([], many)).toHaveLength(100);
  });
});
