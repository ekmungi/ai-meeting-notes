// src/shared/transcript-render.test.ts
// Rendering must be a pure function of the segment log, so a SpeakerRevision
// can be replayed by re-rendering rather than patching already-written text.
import { describe, expect, it } from "vitest";
import { applySpeakerRevisions, renderTranscriptBody } from "./transcript-render";
import type { RenderSegment } from "./transcript-render";

function seg(over: Partial<RenderSegment> = {}): RenderSegment {
  return { turnOrder: 0, text: "Some words here.", speaker: null, startsParagraph: false, tsMarker: null, ...over };
}

describe("renderTranscriptBody", () => {
  it("joins a paragraph with spaces and terminates the block with a blank line", () => {
    const body = renderTranscriptBody([
      seg({ turnOrder: 0, text: "Good morning.", startsParagraph: true }),
      seg({ turnOrder: 1, text: "Thanks for joining." }),
    ]);
    expect(body).toBe("Good morning. Thanks for joining.\n\n");
  });

  it("labels a speaker only when it changes", () => {
    const body = renderTranscriptBody([
      seg({ turnOrder: 0, text: "Good morning.", speaker: "A", startsParagraph: true }),
      seg({ turnOrder: 1, text: "Thanks for joining.", speaker: "A" }),
      seg({ turnOrder: 2, text: "Happy to be here.", speaker: "B" }),
    ]);
    expect(body).toBe("**[Speaker A]** Good morning. Thanks for joining. **[Speaker B]** Happy to be here.\n\n");
  });

  it("emits a timestamp marker as its own block before its paragraph", () => {
    const body = renderTranscriptBody([
      seg({ turnOrder: 0, text: "Opening remarks.", startsParagraph: true, tsMarker: "**[00:00:00]**" }),
      seg({ turnOrder: 1, text: "Later on.", startsParagraph: true, tsMarker: "**[00:05:00]**" }),
    ]);
    expect(body).toBe("**[00:00:00]**\n\nOpening remarks.\n\n**[00:05:00]**\n\nLater on.\n\n");
  });

  it("carries speaker continuity across paragraph breaks", () => {
    const body = renderTranscriptBody([
      seg({ turnOrder: 0, text: "First para.", speaker: "A", startsParagraph: true }),
      seg({ turnOrder: 1, text: "Second para.", speaker: "A", startsParagraph: true }),
    ]);
    expect(body).toBe("First para.\n\n".replace("First para.", "**[Speaker A]** First para.") + "Second para.\n\n");
  });

  it("renders nothing for an empty log", () => {
    expect(renderTranscriptBody([])).toBe("");
  });
});

describe("applySpeakerRevisions", () => {
  const log = [
    seg({ turnOrder: 0, text: "Good morning.", speaker: "A", startsParagraph: true }),
    seg({ turnOrder: 1, text: "Thanks for joining." , speaker: "A" }),
    seg({ turnOrder: 2, text: "Happy to be here.", speaker: "B" }),
  ];

  it("rewrites the speaker of the revised turn and leaves the others alone", () => {
    const out = applySpeakerRevisions(log, [{ turn_order: 2, speaker_label: "C" }]);
    expect(out.map((s) => s.speaker)).toEqual(["A", "A", "C"]);
  });

  // The whole point of rendering from data: when a revision merges a turn into
  // the preceding speaker, the now-redundant label must disappear from the text.
  it("drops a label that a revision made redundant", () => {
    const out = applySpeakerRevisions(log, [{ turn_order: 2, speaker_label: "A" }]);
    expect(renderTranscriptBody(out)).toBe("**[Speaker A]** Good morning. Thanks for joining. Happy to be here.\n\n");
  });

  it("ignores revisions for turns it does not hold", () => {
    const out = applySpeakerRevisions(log, [{ turn_order: 99, speaker_label: "Z" }]);
    expect(out.map((s) => s.speaker)).toEqual(["A", "A", "B"]);
  });

  it("never revises a segment with no turn order", () => {
    const merged = [seg({ turnOrder: null, text: "Flushed fragment.", speaker: null, startsParagraph: true })];
    const out = applySpeakerRevisions(merged, [{ turn_order: 0, speaker_label: "A" }]);
    expect(out[0].speaker).toBeNull();
  });

  it("leaves the input untouched", () => {
    applySpeakerRevisions(log, [{ turn_order: 2, speaker_label: "C" }]);
    expect(log[2].speaker).toBe("B");
  });
});
