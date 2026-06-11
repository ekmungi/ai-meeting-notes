// Tests for float32->int16 conversion and frame accumulation.
import { describe, expect, it } from "vitest";
import { FrameAccumulator, floatTo16 } from "./pcm-utils";

describe("floatTo16", () => {
  it("scales and clamps", () => {
    expect(floatTo16(0)).toBe(0);
    expect(floatTo16(1)).toBe(32767);
    expect(floatTo16(-1)).toBe(-32768);
    expect(floatTo16(2)).toBe(32767);     // clamp over
    expect(floatTo16(-2)).toBe(-32768);   // clamp under
    expect(floatTo16(0.5)).toBe(16383);
  });
});

describe("FrameAccumulator", () => {
  it("emits a frame exactly when frameSamples are accumulated", () => {
    const acc = new FrameAccumulator(4);
    expect(acc.push(new Float32Array([0.5, 0.5]))).toEqual([]);
    const frames = acc.push(new Float32Array([0.5, 0.5, 1]));
    expect(frames.length).toBe(1);
    expect(Array.from(frames[0])).toEqual([16383, 16383, 16383, 16383]);
  });

  it("carries the remainder into the next frame", () => {
    const acc = new FrameAccumulator(2);
    const frames = acc.push(new Float32Array([0, 0, 0, 0, 1]));
    expect(frames.length).toBe(2);
    expect(acc.push(new Float32Array([1]))[0]).toEqual(new Int16Array([32767, 32767]));
  });
});
