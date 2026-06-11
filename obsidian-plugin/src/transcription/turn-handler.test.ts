// src/transcription/turn-handler.test.ts
// Port-fidelity tests for fragment buffering, speaker mapping, force-endpoint timing.
import { describe, expect, it } from "vitest";
import { ENDPOINTING_PRESETS, TurnHandler, isFragment } from "./turn-handler";
import type { Segment } from "./turn-handler";

function make(opts: { speakerLabels?: boolean } = {}) {
  const segments: Segment[] = [];
  const forced: number[] = [];
  let now = 0;
  const h = new TurnHandler({
    speakerLabels: opts.speakerLabels ?? false,
    forceEndpointIntervalSeconds: 20,
    onSegment: (s) => segments.push(s),
    onForceEndpoint: () => forced.push(now),
    now: () => now,
  });
  return { h, segments, forced, advance: (s: number) => { now += s; } };
}

describe("isFragment", () => {
  it("single words and generic two-word phrases are fragments", () => {
    expect(isFragment("Okay.")).toBe(true);
    expect(isFragment("the meeting")).toBe(true);
  });
  it("whitelisted two-word phrases are complete", () => {
    expect(isFragment("Thank you.")).toBe(false);
    expect(isFragment("Sounds good")).toBe(false);
  });
  it("three words starting with a conjunction are fragments", () => {
    expect(isFragment("and the rest")).toBe(true);
    expect(isFragment("we shipped it")).toBe(false);
  });
});

describe("TurnHandler", () => {
  it("emits formatted finals; partials flagged is_partial", () => {
    const { h, segments } = make();
    h.handleTurn({ transcript: "Hello there everyone.", turn_is_formatted: false, end_of_turn: false, turn_order: 0 });
    expect(segments[0].is_partial).toBe(true);
    h.handleTurn({ transcript: "Hello there everyone.", turn_is_formatted: true, end_of_turn: true, turn_order: 0 });
    expect(segments[1]).toMatchObject({ text: "Hello there everyone.", is_partial: false, speaker: null });
  });

  it("buffers fragments and merges them into the next substantive final", () => {
    const { h, segments } = make();
    h.handleTurn({ transcript: "Okay.", turn_is_formatted: true, end_of_turn: true, turn_order: 0 });
    expect(segments.filter((s) => !s.is_partial)).toHaveLength(0);   // buffered
    h.handleTurn({ transcript: "Let us start the review.", turn_is_formatted: true, end_of_turn: true, turn_order: 0 });
    const finals = segments.filter((s) => !s.is_partial);
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe("Okay let us start the review.");   // lowercased continuation
  });

  it("flush() emits buffered fragments", () => {
    const { h, segments } = make();
    h.handleTurn({ transcript: "Right.", turn_is_formatted: true, end_of_turn: true, turn_order: 0 });
    h.flush();
    expect(segments.filter((s) => !s.is_partial)[0].text).toBe("Right");
  });

  it("uses the native speaker_label when enabled", () => {
    const { h, segments } = make({ speakerLabels: true });
    h.handleTurn({ transcript: "First speaker talking now.", turn_is_formatted: true, end_of_turn: true, turn_order: 0, speaker_label: "A" });
    h.handleTurn({ transcript: "Second speaker talking now.", turn_is_formatted: true, end_of_turn: true, turn_order: 1, speaker_label: "B" });
    const finals = segments.filter((s) => !s.is_partial);
    expect(finals[0].speaker).toBe("A");
    expect(finals[1].speaker).toBe("B");
  });

  it("leaves speaker null when diarization is off", () => {
    const { h, segments } = make({ speakerLabels: false });
    h.handleTurn({ transcript: "Anyone speaking here.", turn_is_formatted: true, end_of_turn: true, turn_order: 0, speaker_label: "A" });
    expect(segments.filter((s) => !s.is_partial)[0].speaker).toBeNull();
  });

  it("requests force endpoint after 20s of partial-only speech", () => {
    const { h, forced, advance } = make();
    h.handleTurn({ transcript: "going on and on", turn_is_formatted: false, end_of_turn: false, turn_order: 0 });
    expect(forced).toHaveLength(0);
    advance(21);
    h.handleTurn({ transcript: "going on and on still", turn_is_formatted: false, end_of_turn: false, turn_order: 0 });
    expect(forced).toHaveLength(1);
  });
});

describe("ENDPOINTING_PRESETS", () => {
  it("has the four presets with u3-rt-pro turn-silence params", () => {
    expect(ENDPOINTING_PRESETS.conservative.min_turn_silence).toBe(300);
    expect(ENDPOINTING_PRESETS.conservative.max_turn_silence).toBe(2000);
    expect(Object.keys(ENDPOINTING_PRESETS)).toEqual(
      ["aggressive", "balanced", "conservative", "very_conservative"]);
  });
});
