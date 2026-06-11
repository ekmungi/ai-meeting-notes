// Tests for filename-segment helpers.
import { describe, expect, it } from "vitest";
import { sanitizeSegment, sanitizeFilename, buildMeetingBaseName, formatFileTimestamp, formatIsoTime } from "./format-utils";

describe("formatFileTimestamp / formatIsoTime", () => {
  it("formats a date for filenames and an ISO time", () => {
    const d = new Date(2026, 5, 11, 14, 30, 5); // local time: 2026-06-11 14:30:05
    expect(formatFileTimestamp(d)).toBe("20260611_14-30");
    expect(formatIsoTime(d)).toBe("14:30:05");
  });
});

describe("sanitizeSegment", () => {
  it("strips illegal chars and trims, no fallback", () => {
    expect(sanitizeSegment("Q3: Planning")).toBe("Q3- Planning");
    expect(sanitizeSegment("  hi  ")).toBe("hi");
    expect(sanitizeSegment("")).toBe("");
    expect(sanitizeSegment("///")).toBe("");
  });
  it("trims whitespace including tabs and newlines", () => {
    expect(sanitizeSegment("\t")).toBe("");
    expect(sanitizeSegment("\n hi \t")).toBe("hi");
  });
});

describe("sanitizeFilename", () => {
  it("falls back to 'Meeting Notes' when nothing usable remains", () => {
    expect(sanitizeFilename("///")).toBe("Meeting Notes");
    expect(sanitizeFilename("")).toBe("Meeting Notes");
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
