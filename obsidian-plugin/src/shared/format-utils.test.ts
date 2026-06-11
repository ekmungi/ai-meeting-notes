// Tests for filename-segment helpers.
import { describe, expect, it } from "vitest";
import { sanitizeSegment, buildMeetingBaseName } from "./format-utils";

describe("sanitizeSegment", () => {
  it("strips illegal chars and trims, no fallback", () => {
    expect(sanitizeSegment("Q3: Planning")).toBe("Q3- Planning");
    expect(sanitizeSegment("  hi  ")).toBe("hi");
    expect(sanitizeSegment("")).toBe("");
    expect(sanitizeSegment("///")).toBe("");
  });
});

describe("buildMeetingBaseName", () => {
  const ts = "20260611_14-30";
  it("joins timestamp, description, and type with dashes", () => {
    expect(buildMeetingBaseName(ts, "Q3 Planning", "One to One"))
      .toBe("20260611_14-30 - Q3 Planning - One to One");
  });
  it("omits the description when empty or whitespace", () => {
    expect(buildMeetingBaseName(ts, "", "Standup")).toBe("20260611_14-30 - Standup");
    expect(buildMeetingBaseName(ts, "   ", "Standup")).toBe("20260611_14-30 - Standup");
  });
  it("omits the description when it sanitizes to nothing", () => {
    expect(buildMeetingBaseName(ts, "///", "Standup")).toBe("20260611_14-30 - Standup");
  });
  it("sanitizes illegal chars in description and type", () => {
    expect(buildMeetingBaseName(ts, "Plan: A/B", "1:1"))
      .toBe("20260611_14-30 - Plan- A-B - 1-1");
  });
});
